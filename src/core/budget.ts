/**
 * Budget enforcement — H2.2 (messaging-service Fase 2, §5 of
 * `apps/features/messaging/doc/analysis-messaging-service.md`).
 *
 * Domain-pure: no Fastify, no MCP SDK, no undici. Consumed by both
 * `transports/http/send-route.ts` (POST /send) and `workers/dispatcher.ts`
 * (campaign path) — same enforcement on every encolado, per §5 decision 1
 * ("un tope sólo en /send sería bypasseable por el stream").
 *
 * Three pieces, each cached in-module (single dispatcher process — no
 * cross-replica cache invalidation needed, staleness window is the cache TTL):
 *   - Rate card (`bot.message_rate_card`, 5min cache): USD/message per
 *     channel × category × country. Falls back to hardcoded constants if the
 *     table doesn't exist yet (H2.2's migration lands in apps, in parallel —
 *     this file must not crash the dispatcher if it hasn't been applied).
 *   - Budget config (`bot.config[key='messaging_budget']`, 60s cache): USD/month
 *     caps per channel × category. Missing key/channel/category = no cap
 *     (`allowed` always true) — logs a warn once per process, not once per call.
 *   - Spend: campaign path (`bot.campaign_deliveries` JOINed to
 *     `bot.message_templates` for category, 60s cache) + `/send` path (Redis
 *     INCR counter `msgsvc:sent:{YYYY-MM}:{channel}:{category}`, no cache —
 *     GET is cheap and needs to be current).
 */
import type { Sql, TransactionSql } from 'postgres';
import type { Redis } from 'ioredis';
import type { Logger } from '../lib/logger.js';
import { isMissingRelation, announceOnce } from '../lib/pg-errors.js';

type SqlOrTx = Sql | TransactionSql;

export interface BudgetCheckResult {
  allowed: boolean;
  spent_usd: number;
  cap_usd: number | null;
  pct: number;
}

// ─── Fallback rate card (used until bot.message_rate_card exists / has rows) ─
// Source: apps#analysis-messaging-service.md §5.1 + Meta's 1-jul-2026 pricing
// announcement (service messages payable from 1-oct-2026, ~US$0.0068/msg).
// Regional rates land before 1-sep-2026 — the DB table supersedes this once
// seeded; this stays as the safety-net default forever (table row missing for
// a given channel/category/country falls back here too, not to zero).
const FALLBACK_RATE_CARD: Record<string, Record<string, number>> = {
  whatsapp: { marketing: 0.0618, utility: 0.0068, authentication: 0.0068, service: 0.0068 },
  email: { marketing: 0.0004, utility: 0.0004, authentication: 0.0004, service: 0.0004 },
};

const RATE_CARD_CACHE_MS = 5 * 60 * 1000;
const BUDGET_CONFIG_CACHE_MS = 60 * 1000;
const DB_SPEND_CACHE_MS = 60 * 1000;
const REDIS_TTL_SECONDS = 40 * 24 * 60 * 60; // 40 days — outlives the month key it's namespaced under

interface RateCardCache {
  at: number;
  data: Map<string, number>;
}
let rateCardCache: RateCardCache | null = null;

interface BudgetConfigCache {
  at: number;
  data: Record<string, Record<string, number>>;
}
let budgetConfigCache: BudgetConfigCache | null = null;
let warnedMissingBudgetConfig = false;

interface DbSpendCache {
  at: number;
  data: Map<string, number>; // category -> message count this month
}
const dbSpendCacheByChannel = new Map<string, DbSpendCache>();

/** Test-only: clear module-level caches + the "warned once" flag between test cases. */
export function __resetBudgetCachesForTests(): void {
  rateCardCache = null;
  budgetConfigCache = null;
  warnedMissingBudgetConfig = false;
  dbSpendCacheByChannel.clear();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function monthKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function sentCounterKey(channel: string, category: string, now = new Date()): string {
  return `msgsvc:sent:${monthKey(now)}:${channel}:${category}`;
}

function alertedKey(channel: string, category: string, now = new Date()): string {
  return `msgsvc:alerted:${monthKey(now)}:${channel}:${category}`;
}

function rateCardKey(channel: string, category: string, country: string): string {
  return `${channel}:${category}:${country}`;
}

async function loadRateCard(sql: SqlOrTx, logger: Logger): Promise<Map<string, number>> {
  const now = Date.now();
  if (rateCardCache && now - rateCardCache.at < RATE_CARD_CACHE_MS) return rateCardCache.data;

  const data = new Map<string, number>();
  try {
    const rows = await sql<Array<{ channel: string; category: string; country: string; usd_per_message: string }>>`
      SELECT channel, category, country, usd_per_message::text AS usd_per_message
      FROM bot.message_rate_card
    `;
    for (const r of rows) {
      data.set(rateCardKey(r.channel, r.category, r.country), Number(r.usd_per_message));
    }
  } catch (err) {
    // Table not applied yet (H2.2 migration lands in apps in parallel) or
    // any other query failure — fall back to hardcoded constants, don't crash.
    logger.warn(
      { err: (err as Error).message },
      'bot.message_rate_card query failed — using hardcoded fallback rate card',
    );
  }
  rateCardCache = { at: now, data };
  return data;
}

function resolveRate(rateCard: Map<string, number>, channel: string, category: string, country = 'AR'): number {
  const exact = rateCard.get(rateCardKey(channel, category, country));
  if (exact !== undefined) return exact;
  return FALLBACK_RATE_CARD[channel]?.[category] ?? 0;
}

async function loadBudgetConfig(
  sql: SqlOrTx,
  logger: Logger,
): Promise<Record<string, Record<string, number>>> {
  const now = Date.now();
  if (budgetConfigCache && now - budgetConfigCache.at < BUDGET_CONFIG_CACHE_MS) {
    return budgetConfigCache.data;
  }

  let data: Record<string, Record<string, number>> = {};
  try {
    const rows = await sql<Array<{ value: Record<string, Record<string, number>> | null }>>`
      SELECT value FROM bot.config WHERE key = 'messaging_budget'
    `;
    if (rows[0]?.value) {
      data = rows[0].value;
    } else if (!warnedMissingBudgetConfig) {
      logger.warn(
        'bot.config[messaging_budget] not set — no messaging budget caps enforced (all sends allowed)',
      );
      warnedMissingBudgetConfig = true;
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'bot.config query for messaging_budget failed — no caps enforced',
    );
  }
  budgetConfigCache = { at: now, data };
  return data;
}

/**
 * Campaign spend for the current month, grouped by category — one query per
 * channel (cached), not per category, since the JOIN naturally groups all
 * categories in a single pass.
 *
 * Simplification v1 (documented in the messaging-service analysis doc §H2.2):
 * category comes from the campaign's *current* template (`cm.template_id`),
 * not from whatever template was active per-delivery historically (A/B
 * variants and drip steps can differ from the base template's category —
 * acceptable drift for a budget guardrail, not a billing reconciliation).
 */
async function loadDbSpendCounts(sql: SqlOrTx, channel: string, logger: Logger): Promise<Map<string, number>> {
  const now = Date.now();
  const cached = dbSpendCacheByChannel.get(channel);
  if (cached && now - cached.at < DB_SPEND_CACHE_MS) return cached.data;

  const data = new Map<string, number>();
  try {
    const rows = await sql<Array<{ category: string; cnt: string }>>`
      SELECT mt.category AS category, count(*)::text AS cnt
      FROM bot.campaign_deliveries cd
      JOIN bot.campaigns cm ON cm.id = cd.campaign_id
      JOIN bot.message_templates mt ON mt.id = cm.template_id
      WHERE cd.channel = ${channel}
        AND cd.sent_at >= date_trunc('month', now())
        AND cd.status IN ('sent', 'delivered', 'read')
      GROUP BY mt.category
    `;
    for (const r of rows) data.set(r.category, Number(r.cnt));
  } catch (err) {
    if (isMissingRelation(err)) {
      // Cliente sin la feature `campaigns`: no hay campañas, así que el gasto
      // de campañas ES cero. El resultado no es una degradación, es el número
      // correcto — y el gasto de `/send` sigue contándose por Redis.
      announceOnce(
        logger,
        'missing:campaign_deliveries:budget',
        { channel },
        'sin bot.campaign_deliveries (cliente sin la feature campaigns): el gasto de campañas es 0 y el de /send se cuenta igual por Redis. Estado esperado, se dice una vez.',
      );
    } else {
      logger.warn(
        { err: (err as Error).message, channel },
        'campaign spend query (bot.campaign_deliveries) failed — treating campaign spend as 0 for this tick',
      );
    }
  }
  dbSpendCacheByChannel.set(channel, { at: now, data });
  return data;
}

/**
 * `POST /send` usage this month for channel × category. Incremented by
 * `recordSendUsage()` on accepted sends; NOT cached (GET is a single Redis
 * round-trip, and this needs to be current for the /send caller's own next
 * request in the same minute).
 */
async function loadSendCounterUsage(
  redis: Redis,
  channel: string,
  category: string,
  logger: Logger,
): Promise<number> {
  try {
    const raw = await redis.get(sentCounterKey(channel, category));
    return raw ? Number(raw) : 0;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, channel, category },
      'redis GET for /send usage counter failed — treating as 0',
    );
    return 0;
  }
}

/**
 * Check whether a send is within budget for channel × category. ALWAYS
 * returns `allowed: true` when no cap is configured (§5 decision: a missing
 * cap is not enforcement, it's "not configured yet" — never silently blocks).
 */
export async function checkBudget(
  sql: SqlOrTx,
  redis: Redis,
  logger: Logger,
  channel: string,
  category: string,
): Promise<BudgetCheckResult> {
  const [rateCard, budgetConfig, dbSpend, sendCounterUsage] = await Promise.all([
    loadRateCard(sql, logger),
    loadBudgetConfig(sql, logger),
    loadDbSpendCounts(sql, channel, logger),
    loadSendCounterUsage(redis, channel, category, logger),
  ]);

  const capUsd = budgetConfig[channel]?.[category] ?? null;
  const rate = resolveRate(rateCard, channel, category);
  const campaignCount = dbSpend.get(category) ?? 0;
  const totalMessages = campaignCount + sendCounterUsage;
  const spentUsd = round2(totalMessages * rate);

  if (capUsd === null) {
    return { allowed: true, spent_usd: spentUsd, cap_usd: null, pct: 0 };
  }

  const pct = capUsd > 0 ? round2(spentUsd / capUsd) : spentUsd > 0 ? Infinity : 0;
  const allowed = spentUsd < capUsd;
  return { allowed, spent_usd: spentUsd, cap_usd: capUsd, pct };
}

/** Called by `/send` on an accepted send. Campaign spend is read straight from `bot.campaign_deliveries`, no counter needed there. */
export async function recordSendUsage(redis: Redis, logger: Logger, channel: string, category: string): Promise<void> {
  const key = sentCounterKey(channel, category);
  try {
    await redis.incr(key);
    await redis.expire(key, REDIS_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err: (err as Error).message, channel, category }, 'redis INCR for /send usage counter failed');
  }
}

/**
 * Inyectado por el caller (H2.3, reescrito en F7.5): manda el aviso y NUNCA
 * tira. Sigue inyectado —y no importado— porque este archivo no puede importar
 * `core/notify.ts` sin cerrar el ciclo `budget → notify → messaging → budget`
 * (`messaging.ts` importa `maybeAlert` de acá). El caller lo cierra pasando
 * `(req) => notify(notifyDeps, req)`.
 *
 * ⚠ Lo que este tipo YA NO lleva: `to`, `from` y `clientRef`. Los tres los
 * resolvía `maybeAlert` con su propia query a `bot.notify_to`/`branding` — la
 * cuarta copia de la misma mecánica. Ahora este archivo sólo dice QUÉ PASÓ.
 */
export type BudgetAlertSender = (req: {
  feature: string;
  aviso: string;
  subject: string;
  text: string;
  html: string;
  critical: boolean;
  origin_ref: string;
}) => Promise<{ status: string; blocked_reason?: string | null }>;

function monthKeyCompact(now = new Date()): string {
  return monthKey(now).replace('-', '');
}

/**
 * 80%-of-cap alert, deduped once per month per channel × category via Redis
 * SETNX. No-op if there's no cap or pct < 0.8.
 *
 * H2.3 — ya no sólo loguea: manda una notificación real vía `sendMessage`
 * (`kind: 'notification'`, `critical: true`) a cada destinatario de
 * `bot.notify_to('messaging')`. `critical: true` es necesario porque, si no,
 * la propia alerta de presupuesto podría quedar bloqueada por el presupuesto
 * que está avisando — el bypass es puntual para este emisor, no general.
 *
 * Recursión esperada: este envío pasa de nuevo por `sendMessage` →
 * `checkBudget` → `maybeAlert`. El SETNX de esta misma celda (channel ×
 * category) ya está seteado cuando se llega acá, así que la re-entrada corta
 * en el `if (!firstTimeThisMonth) return` de arriba. Si el envío tocara OTRA
 * celda channel×category (no debería: la notificación es siempre
 * `email`/`service` en la práctica), el dedup mensual de ESA celda manda.
 *
 * `sql` tiene que ser el handle global/no-transaccional del caller — nunca
 * una `tx` de delivery en curso (el call-site de `workers/dispatcher.ts` la
 * tiene disponible y NO debe pasarla: la alerta no puede demorar ni fallar el
 * commit de un envío).
 */
export async function maybeAlert(
  sql: SqlOrTx,
  redis: Redis,
  logger: Logger,
  channel: string,
  category: string,
  result: BudgetCheckResult,
  sendAlert: BudgetAlertSender,
): Promise<void> {
  if (result.cap_usd === null || result.pct < 0.8) return;

  let firstTimeThisMonth = true;
  try {
    const set = await redis.set(alertedKey(channel, category), '1', 'EX', REDIS_TTL_SECONDS, 'NX');
    firstTimeThisMonth = set === 'OK';
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, channel, category },
      'redis SETNX for budget-alert dedup failed — alerting anyway (best-effort, may repeat)',
    );
  }
  if (!firstTimeThisMonth) return;

  logger.warn(
    {
      channel,
      category,
      spent_usd: result.spent_usd,
      cap_usd: result.cap_usd,
      pct: result.pct,
    },
    'messaging budget at/above 80% of monthly cap — notifying staff via send_internal_notification',
  );

  // Envío best-effort: un fallo acá NUNCA debe volver a los dos call-sites
  // (`/send` en curso, o una transacción de delivery). Se loguea fuerte y se
  // sigue — la alerta es una conveniencia operativa, no parte del envío que
  // la disparó.
  try {
    const month = monthKeyCompact();
    const pctLabel = Math.round(result.pct * 100);
    const outcome = await sendAlert({
      feature: 'messaging',
      aviso: 'budget-80',
      subject: `⚠️ Presupuesto de mensajería al ${pctLabel}% (${channel}/${category})`,
      text:
        `El gasto de mensajería de ${channel}/${category} llegó al ${pctLabel}% del tope mensual.\n\n` +
        `Gastado: USD ${result.spent_usd}\n` +
        `Tope: USD ${result.cap_usd}\n` +
        `Mes: ${month}\n`,
      html:
        `<p>El gasto de mensajería de <b>${channel}/${category}</b> llegó al <b>${pctLabel}%</b> del tope mensual.</p>` +
        `<ul>` +
        `<li>Gastado: USD ${result.spent_usd}</li>` +
        `<li>Tope: USD ${result.cap_usd}</li>` +
        `<li>Mes: ${month}</li>` +
        `</ul>`,
      // La alerta del presupuesto no puede quedar bloqueada por el presupuesto
      // que está avisando. El bypass es puntual para este emisor, no general.
      critical: true,
      // Mes + celda: dos meses o dos canales son dos avisos distintos. El
      // destinatario NO va acá — la idempotencia es (client_ref, destino) y la
      // compone el servicio.
      origin_ref: `${month}-${channel}-${category}`,
    });
    if (outcome.blocked_reason) {
      logger.info(
        { channel, category, reason: outcome.blocked_reason },
        'budget alert: no se envía (el cliente no cargó destinatarios, o falta branding.email_from)',
      );
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message, channel, category },
      'budget alert: unexpected failure composing/sending the notification — not propagating to the caller',
    );
  }
}
