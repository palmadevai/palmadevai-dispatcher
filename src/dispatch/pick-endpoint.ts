/**
 * Generic outbound endpoint picker for non-WA channels (Fase 5 Item 2).
 *
 * WhatsApp tiene multi-phone strategy con sticky assignment + tier + warming —
 * vive en pick-phone.ts. Para FB Messenger / IG DM / SMS no aplica:
 *   - Sin sticky: cualquier endpoint del canal puede enviar a cualquier contacto
 *     (no hay constraint Page-PSID; el PSID es contexto-libre).
 *   - Sin tier: Meta no expone messaging_limit_tier para FB/IG Pages igual que WA.
 *   - Sin warming: Page Access Token activo = puede enviar.
 *
 * Selección simple: WHERE channel = ? AND status='active', ORDER BY priority
 * DESC + sent_today ASC. Si daily_cap_override está set, exclude endpoints
 * que ya lo alcanzaron.
 *
 * Returns null si no hay endpoint available — caller pausea la campaña con
 * pause_reason='auto_no_available_endpoint'.
 */
import type { Sql, TransactionSql } from 'postgres';

type SqlOrTx = Sql | TransactionSql;

export interface PickedEndpoint {
  id: string;
  endpoint_id: string;
  access_token: string;
  daily_cap_remaining: number;
}

interface EndpointRow {
  id: string;
  endpoint_id: string;
  access_token: string | null;
  status: string;
  sent_today: number;
  daily_cap_override: number | null;
}

const NO_CAP_SENTINEL = 2_147_483_647;

function effectiveCap(row: EndpointRow): number {
  return row.daily_cap_override ?? NO_CAP_SENTINEL;
}

export async function pickEndpointForChannel(
  sql: SqlOrTx,
  channel: 'facebook' | 'instagram' | 'sms',
): Promise<PickedEndpoint | null> {
  const candidates = await sql<EndpointRow[]>`
    SELECT id, endpoint_id, access_token, status, sent_today, daily_cap_override
    FROM bot.outbound_endpoints
    WHERE channel = ${channel}
      AND status = 'active'
      AND sent_today < COALESCE(daily_cap_override, ${NO_CAP_SENTINEL})
    ORDER BY
      priority DESC,
      sent_today ASC
    LIMIT 1
  `;

  if (candidates.length === 0 || !candidates[0]) return null;
  const picked = candidates[0];
  if (!picked.access_token) {
    // Defensive — cockpit validation already enforces access_token for FB/IG,
    // but if a NULL slipped through (e.g. SMS without provider creds), skip.
    return null;
  }

  return {
    id: picked.id,
    endpoint_id: picked.endpoint_id,
    access_token: picked.access_token,
    daily_cap_remaining: effectiveCap(picked) - picked.sent_today,
  };
}
