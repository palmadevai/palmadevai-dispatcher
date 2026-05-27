/**
 * Multi-phone selection per ADR-013.
 *
 * Flow:
 *   1. Check sticky: bot.audience_contact_phone_assignments.
 *      - If sticky phone is 'active'/'warming' AND under daily_cap → return it.
 *      - If sticky phone 'suspended'/'disabled' OR daily cap reached → fall
 *        through to fresh pick. Sticky row stays (history).
 *   2. Pick from active+warming: ORDER BY priority DESC, sent_today/cap ASC.
 *   3. UPSERT sticky (ON CONFLICT DO NOTHING — first-pick wins).
 *   4. Return null if no eligible phone — caller pauses the campaign with
 *      pause_reason='auto_no_available_phones'.
 *
 * Quality-rating tier (green > yellow > red) is intentionally NOT enforced as
 * a hard filter here — operator sees the rating in cockpit and either suspends
 * the phone or lets the dispatcher use it. Hard filter would silently shrink
 * available pool below operator's intent.
 */
import type { Sql, TransactionSql } from 'postgres';

type SqlOrTx = Sql | TransactionSql;

export interface PickedPhone {
  id: string;
  phone_number_id: string;
  daily_cap_remaining: number;
}

interface PhoneRow {
  id: string;
  phone_number_id: string;
  status: string;
  sent_today: number;
  daily_cap_override: number | null;
}

// Default cap if daily_cap_override is NULL. ADR-013 says warming default 50/day;
// active without override = no cap (Meta tier governs). We model "no cap" with
// a sentinel so the filter is uniform.
const NO_CAP_SENTINEL = Number.MAX_SAFE_INTEGER;

function effectiveCap(row: PhoneRow): number {
  return row.daily_cap_override ?? NO_CAP_SENTINEL;
}

function isEligible(row: PhoneRow): boolean {
  if (row.status !== 'active' && row.status !== 'warming') return false;
  return row.sent_today < effectiveCap(row);
}

export async function pickPhoneForContact(
  sql: SqlOrTx,
  audienceContactId: string,
): Promise<PickedPhone | null> {
  // 1. Sticky lookup
  const sticky = await sql<PhoneRow[]>`
    SELECT p.id, p.phone_number_id, p.status, p.sent_today, p.daily_cap_override
    FROM bot.audience_contact_phone_assignments a
    JOIN bot.wa_phone_numbers p ON p.id = a.wa_phone_number_id
    WHERE a.audience_contact_id = ${audienceContactId}
    LIMIT 1
  `;

  if (sticky.length > 0 && sticky[0] && isEligible(sticky[0])) {
    const phone = sticky[0];
    return {
      id: phone.id,
      phone_number_id: phone.phone_number_id,
      daily_cap_remaining: effectiveCap(phone) - phone.sent_today,
    };
  }

  // 2. Fresh pick (highest priority, least-loaded first).
  // ORDER BY priority DESC, then by load fraction ASC. NULLIF(daily_cap_override, 0)
  // is unnecessary since the column has no zero semantics, but we guard NULL so
  // phones with no cap rank by raw sent_today (still want least-loaded).
  const candidates = await sql<PhoneRow[]>`
    SELECT id, phone_number_id, status, sent_today, daily_cap_override
    FROM bot.wa_phone_numbers
    WHERE status IN ('active', 'warming')
      AND sent_today < COALESCE(daily_cap_override, ${NO_CAP_SENTINEL})
    ORDER BY
      priority DESC,
      (sent_today::numeric / NULLIF(COALESCE(daily_cap_override, ${NO_CAP_SENTINEL}), 0)) ASC NULLS LAST,
      sent_today ASC
    LIMIT 1
  `;

  if (candidates.length === 0 || !candidates[0]) return null;
  const picked = candidates[0];

  // 3. Persist sticky (idempotent: first-pick wins).
  await sql`
    INSERT INTO bot.audience_contact_phone_assignments
      (audience_contact_id, wa_phone_number_id)
    VALUES (${audienceContactId}, ${picked.id})
    ON CONFLICT (audience_contact_id) DO NOTHING
  `;

  return {
    id: picked.id,
    phone_number_id: picked.phone_number_id,
    daily_cap_remaining: effectiveCap(picked) - picked.sent_today,
  };
}
