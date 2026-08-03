/**
 * Read-only use cases behind the Tier 1 MCP tools (F4/H4.1 — doc §4 Tier 1).
 *
 * Domain-pure (§3.4): no Fastify, no MCP SDK, no undici. The MCP transport
 * (`transports/mcp/`) is a thin facade over these functions — zero business
 * logic in the transport, so a future HTTP or A2A surface reuses them as-is.
 *
 * Every function returns plain JSON-serializable data. No writes anywhere —
 * Tier 2/3 (writes) are F5, gated by their own guardas (doc §9 H5.x).
 */
import type { Redis } from 'ioredis';
import type { SqlClient } from '../lib/postgres.js';
import type { Logger } from '../lib/logger.js';
import { isChannelImplemented } from '../providers/index.js';
import { checkBudget } from './budget.js';

export interface ReadDeps {
  sql: SqlClient;
  redis: Redis;
  logger: Logger;
}

// ─── list_channels ──────────────────────────────────────────────────────────

export interface ChannelSummary {
  channel: string;
  provider_implemented: boolean;
  endpoints_total: number;
  endpoints_active: number;
  endpoints_warming: number;
  endpoints_suspended: number;
}

/** Canales con provider implementado + estado de sus endpoints registrados. */
export async function listChannels(deps: ReadDeps): Promise<{ channels: ChannelSummary[] }> {
  const known = ['whatsapp', 'email', 'facebook', 'instagram'];
  const byChannel = new Map<string, { total: number; active: number; warming: number; suspended: number }>();
  try {
    const rows = await deps.sql<Array<{ channel: string; status: string; cnt: string }>>`
      SELECT channel, status, count(*)::text AS cnt
      FROM bot.outbound_endpoints
      GROUP BY channel, status
    `;
    for (const r of rows) {
      const agg = byChannel.get(r.channel) ?? { total: 0, active: 0, warming: 0, suspended: 0 };
      const n = Number(r.cnt);
      agg.total += n;
      if (r.status === 'active') agg.active += n;
      else if (r.status === 'warming') agg.warming += n;
      else if (r.status === 'suspended') agg.suspended += n;
      byChannel.set(r.channel, agg);
    }
  } catch (err) {
    // Cliente sin multiphone puede no tener la tabla — canales igual se listan.
    deps.logger.warn(
      { err: (err as Error).message },
      'list_channels: bot.outbound_endpoints query failed — reporting providers only',
    );
  }

  const channels: ChannelSummary[] = [...new Set([...known, ...byChannel.keys()])].map((ch) => {
    const agg = byChannel.get(ch) ?? { total: 0, active: 0, warming: 0, suspended: 0 };
    return {
      channel: ch,
      provider_implemented: isChannelImplemented(ch),
      endpoints_total: agg.total,
      endpoints_active: agg.active,
      endpoints_warming: agg.warming,
      endpoints_suspended: agg.suspended,
    };
  });
  return { channels };
}

// ─── get_channel_health ─────────────────────────────────────────────────────

export interface PhoneHealth {
  display_phone: string | null;
  quality_rating: string | null;
  messaging_limit_tier: number | null;
  status: string;
  last_quality_check_at: string | null;
  history_7d: Array<{ snapshot_at: string; quality_rating: string | null; messaging_limit_tier: number | null }>;
}

/**
 * Salud del canal WhatsApp por número: quality rating, messaging limit tier y
 * los últimos snapshots del warming (`bot.wa_phone_quality_history`).
 */
export async function getChannelHealth(deps: ReadDeps): Promise<{ phones: PhoneHealth[] }> {
  const phones = await deps.sql<
    Array<{
      id: string;
      display_phone: string | null;
      quality_rating: string | null;
      tier_current: number | null;
      status: string;
      last_quality_check_at: Date | null;
    }>
  >`
    SELECT id, display_phone, quality_rating, tier_current, status, last_quality_check_at
    FROM bot.wa_phone_numbers
    ORDER BY created_at
  `;

  const result: PhoneHealth[] = [];
  for (const p of phones) {
    let history: PhoneHealth['history_7d'] = [];
    try {
      const rows = await deps.sql<
        Array<{ snapshot_at: string; quality_rating: string | null; messaging_limit_tier: number | null }>
      >`
        SELECT snapshot_at::text AS snapshot_at, quality_rating, messaging_limit_tier
        FROM bot.wa_phone_quality_history
        WHERE wa_phone_number_id = ${p.id}
        ORDER BY snapshot_at DESC
        LIMIT 7
      `;
      history = rows;
    } catch (err) {
      deps.logger.warn(
        { err: (err as Error).message },
        'get_channel_health: quality history query failed — returning current state only',
      );
    }
    result.push({
      display_phone: p.display_phone,
      quality_rating: p.quality_rating,
      messaging_limit_tier: p.tier_current,
      status: p.status,
      last_quality_check_at: p.last_quality_check_at ? p.last_quality_check_at.toISOString() : null,
      history_7d: history,
    });
  }
  return { phones: result };
}

// ─── list_templates / get_template ──────────────────────────────────────────

export interface TemplateListItem {
  name: string;
  channel: string;
  language: string;
  category: string;
  status: string;
  waba_id: string | null;
  rejection_reason: string | null;
  last_synced_at: string | null;
}

export async function listTemplates(
  deps: ReadDeps,
  filter: { channel?: string; status?: string; language?: string },
): Promise<{ templates: TemplateListItem[] }> {
  const rows = await deps.sql<
    Array<TemplateListItem & { last_synced_at: Date | null }>
  >`
    SELECT name, channel, language, category, status, waba_id, rejection_reason, last_synced_at
    FROM bot.message_templates
    WHERE (${filter.channel ?? null}::text IS NULL OR channel = ${filter.channel ?? null})
      AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
      AND (${filter.language ?? null}::text IS NULL OR language = ${filter.language ?? null})
    ORDER BY name, language
  `;
  return {
    templates: rows.map((r) => ({
      ...r,
      last_synced_at: r.last_synced_at ? new Date(r.last_synced_at).toISOString() : null,
    })),
  };
}

export interface TemplateDetail extends TemplateListItem {
  external_id: string | null;
  variables: string[] | null;
  body: unknown;
}

/** Detalle de un template: componentes, variables esperadas y estado Meta. */
export async function getTemplate(
  deps: ReadDeps,
  args: { name: string; language?: string; channel?: string },
): Promise<{ found: boolean; template?: TemplateDetail }> {
  const rows = await deps.sql<Array<TemplateDetail & { last_synced_at: Date | null }>>`
    SELECT name, channel, language, category, status, waba_id, rejection_reason,
           last_synced_at, external_id, variables, body
    FROM bot.message_templates
    WHERE name = ${args.name}
      AND (${args.language ?? null}::text IS NULL OR language = ${args.language ?? null})
      AND (${args.channel ?? null}::text IS NULL OR channel = ${args.channel ?? null})
    ORDER BY last_synced_at DESC NULLS LAST
    LIMIT 1
  `;
  if (rows.length === 0) return { found: false };
  const r = rows[0];
  return {
    found: true,
    template: { ...r, last_synced_at: r.last_synced_at ? new Date(r.last_synced_at).toISOString() : null },
  };
}

// ─── get_delivery_status ────────────────────────────────────────────────────

export interface DeliveryStatus {
  id: string;
  client_ref: string;
  campaign_id: string | null;
  campaign_name: string | null;
  channel: string;
  status: string;
  queued_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  failure_reason: string | null;
  retry_count: number | null;
}

/**
 * Estado de un envío por `client_ref` o id de delivery. Responde "¿por qué no
 * le llegó el mensaje a X?" con la categoría de error neutral (`provider_*`).
 *
 * Ambas columnas son uuid — se comparan con `::text` sobre la COLUMNA para
 * que un input no-uuid del agente devuelva `found:false` en vez de reventar
 * con "invalid input syntax for type uuid" (incidente del primer smoke F4).
 */
export async function getDeliveryStatus(
  deps: ReadDeps,
  args: { client_ref?: string; delivery_id?: string },
): Promise<{ found: boolean; delivery?: DeliveryStatus }> {
  if (!args.client_ref && !args.delivery_id) return { found: false };
  const rows = await deps.sql<Array<Record<string, unknown>>>`
    SELECT d.id::text AS id, d.client_ref, d.campaign_id::text AS campaign_id,
           c.name AS campaign_name, d.channel, d.status,
           d.queued_at, d.sent_at, d.delivered_at, d.read_at, d.failed_at,
           d.error_code, d.error_message, d.failure_reason, d.retry_count
    FROM bot.campaign_deliveries d
    LEFT JOIN bot.campaigns c ON c.id = d.campaign_id
    WHERE (${args.client_ref ?? null}::text IS NOT NULL AND d.client_ref::text = ${args.client_ref ?? null})
       OR (${args.delivery_id ?? null}::text IS NOT NULL AND d.id::text = ${args.delivery_id ?? null})
    ORDER BY d.queued_at DESC
    LIMIT 1
  `;
  if (rows.length === 0) return { found: false };
  const r = rows[0];
  const ts = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
  return {
    found: true,
    delivery: {
      id: String(r.id),
      client_ref: String(r.client_ref),
      campaign_id: r.campaign_id ? String(r.campaign_id) : null,
      campaign_name: r.campaign_name ? String(r.campaign_name) : null,
      channel: String(r.channel),
      status: String(r.status),
      queued_at: ts(r.queued_at),
      sent_at: ts(r.sent_at),
      delivered_at: ts(r.delivered_at),
      read_at: ts(r.read_at),
      failed_at: ts(r.failed_at),
      error_code: r.error_code ? String(r.error_code) : null,
      error_message: r.error_message ? String(r.error_message) : null,
      failure_reason: r.failure_reason ? String(r.failure_reason) : null,
      retry_count: r.retry_count === null || r.retry_count === undefined ? null : Number(r.retry_count),
    },
  };
}

// ─── get_messaging_costs ────────────────────────────────────────────────────

export interface CostRow {
  channel: string;
  category: string;
  spent_usd: number;
  cap_usd: number | null;
  pct: number;
}

/**
 * Consumido/tope del mes por canal × categoría — fachada sobre el MISMO
 * `checkBudget` que usa el enforcement (§3.4: una sola implementación).
 * Pares a reportar = los configurados en `bot.config[messaging_budget]`;
 * fallback a los pares estándar de WhatsApp/email si la config no existe.
 */
export async function getMessagingCosts(deps: ReadDeps): Promise<{ month: string; costs: CostRow[] }> {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  let pairs: Array<{ channel: string; category: string }> = [];
  try {
    const rows = await deps.sql<Array<{ value: Record<string, Record<string, number>> | null }>>`
      SELECT value FROM bot.config WHERE key = 'messaging_budget'
    `;
    const cfg = rows[0]?.value ?? {};
    for (const [channel, cats] of Object.entries(cfg)) {
      for (const category of Object.keys(cats)) pairs.push({ channel, category });
    }
  } catch (err) {
    deps.logger.warn(
      { err: (err as Error).message },
      'get_messaging_costs: budget config query failed — falling back to standard pairs',
    );
  }
  if (pairs.length === 0) {
    pairs = [
      { channel: 'whatsapp', category: 'marketing' },
      { channel: 'whatsapp', category: 'utility' },
      { channel: 'whatsapp', category: 'service' },
      { channel: 'whatsapp', category: 'authentication' },
      { channel: 'email', category: 'service' },
    ];
  }

  const costs: CostRow[] = [];
  for (const { channel, category } of pairs) {
    const r = await checkBudget(deps.sql, deps.redis, deps.logger, channel, category);
    costs.push({ channel, category, spent_usd: r.spent_usd, cap_usd: r.cap_usd, pct: r.pct });
  }
  return { month, costs };
}
