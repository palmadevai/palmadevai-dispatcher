/**
 * Dispatcher worker — ioredis XREADGROUP loop (see workers/README.md for the
 * architectural rationale).
 *
 * Concurrency: DISPATCHER_CONCURRENCY async tasks share a single XREADGROUP
 * reader. The reader fans out stream entries to a bounded queue; tasks pull
 * from the queue. This keeps Redis traffic bounded (one BLOCK call at a time)
 * while parallelizing processing.
 *
 * Per-second send rate is enforced by a token bucket (BullMQ limiter would
 * not help here because we are not using BullMQ Worker). Token bucket refills
 * every 1000ms by CAMPAIGNS_DEFAULT_RATE_BURST_MPS — matches ADR-004.
 *
 * Retry: BullMQ-style exponential backoff via Redis ZSET `campaigns:retry-zset`.
 * Score = eta_ms. A scheduler tick (5s) pops entries with score <= now and
 * re-XADDs them.
 *
 * Per spec §5.3 the per-job transaction:
 *   1. BEGIN
 *   2. SELECT FOR UPDATE SKIP LOCKED → bail if locked/non-pending
 *   3. pickPhoneForContact → pause campaign if null
 *   4. resolveTemplateComponents
 *   5. sendWhatsApp(biz_opaque_callback_data = client_ref)
 *   6. classify result → UPDATE status / throw retry / DLQ terminal
 *   7. UPDATE wa_phone_numbers.sent_today++
 *   8. PUBLISH campaign:<id> for SSE (ADR-005)
 *   9. COMMIT, XACK stream_id
 */
import type { Redis } from 'ioredis';
import type { Sql, TransactionSql } from 'postgres';
import type { Logger } from '../lib/logger.js';
import type { MetricsCollector } from '../observability/metrics-collector.js';
import { env } from '../env.js';
import { resolveDeliveryContext, resolveTemplateComponents } from '../dispatch/audience-resolver.js';
import { pickPhoneForContact } from '../dispatch/pick-phone.js';
import {
  assertProviderAvailable,
  ChannelNotImplementedError,
  sendWhatsApp,
  type ProviderSendResult,
} from '../providers/index.js';
import { classifyMetaError, type ErrorCategory } from '../classify/error-classifier.js';
import { moveToDLQ } from './dlq.js';
import { resolveAiBindings } from '../lib/ai-personalize.js';
import { parseQueuedAt } from '../lib/parse-queued-at.js';
import { sql as pgPool } from '../lib/postgres.js';

export interface DispatcherDeps {
  rawRedis: Redis;
  sql: Sql;
  logger: Logger;
  metricsCollector: MetricsCollector;
}

export interface DispatcherHandle {
  stop(): Promise<void>;
}

interface StreamJob {
  streamId: string;
  deliveryId: number;
  queuedAt: Date;
}

// Redis ZSET key for delayed retries (BullMQ-style exponential backoff).
const RETRY_ZSET_KEY = 'campaigns:retry-zset';

// Block timeout for XREADGROUP (ms). Short enough for fast graceful shutdown.
const XREAD_BLOCK_MS = 2000;
// Scheduler tick that promotes retry-ZSET entries back into the stream.
const RETRY_SCHEDULER_INTERVAL_MS = 5000;

function backoffDelayMs(attemptIndex: number): number {
  // Exponential: base × 4^attemptIndex. With base 60_000, attempts 1..3 give:
  //   attempt 1 → 60_000  (1 min)
  //   attempt 2 → 240_000 (4 min)
  //   attempt 3 → 960_000 (16 min)
  return env.DISPATCHER_BULLMQ_BACKOFF_MS * Math.pow(4, attemptIndex);
}

export function startDispatcher(deps: DispatcherDeps): DispatcherHandle {
  const { rawRedis, sql, logger, metricsCollector } = deps;

  logger.info(
    {
      concurrency: env.DISPATCHER_CONCURRENCY,
      batch_size: env.DISPATCHER_BATCH_SIZE,
      rate_burst_mps: env.CAMPAIGNS_DEFAULT_RATE_BURST_MPS,
      attempts: env.DISPATCHER_BULLMQ_ATTEMPTS,
      backoff_base_ms: env.DISPATCHER_BULLMQ_BACKOFF_MS,
    },
    'starting dispatcher worker (XREADGROUP loop)',
  );

  // ─── Token bucket rate limiter (ADR-004) ───────────────────────────────────
  let tokens = env.CAMPAIGNS_DEFAULT_RATE_BURST_MPS;
  const refillHandle = setInterval(() => {
    tokens = env.CAMPAIGNS_DEFAULT_RATE_BURST_MPS;
  }, 1000);

  async function acquireToken(): Promise<void> {
    // Busy-spin with 25ms sleep when out of tokens. Acceptable for low MPS.
    while (tokens <= 0 && !stopping) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    tokens -= 1;
  }

  // ─── Stop flag + task accounting ───────────────────────────────────────────
  let stopping = false;
  const inflight = new Set<Promise<void>>();

  // Bounded in-memory queue between reader and workers.
  const pendingJobs: StreamJob[] = [];
  let readerWake: (() => void) | null = null;

  function pushJob(job: StreamJob): void {
    pendingJobs.push(job);
    if (readerWake) {
      readerWake();
      readerWake = null;
    }
  }

  async function waitForJob(): Promise<StreamJob | null> {
    while (!stopping) {
      const j = pendingJobs.shift();
      if (j) return j;
      await new Promise<void>((resolve) => {
        readerWake = resolve;
        // Safety net wake every 500ms so workers re-check stopping flag.
        setTimeout(() => {
          if (readerWake === resolve) {
            readerWake = null;
            resolve();
          }
        }, 500);
      });
    }
    return null;
  }

  // ─── XREADGROUP reader loop ────────────────────────────────────────────────
  async function readerLoop(): Promise<void> {
    while (!stopping) {
      try {
        // Wait if local queue saturated.
        if (pendingJobs.length >= env.DISPATCHER_BATCH_SIZE) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
        const reply = (await rawRedis.call(
          'XREADGROUP',
          'GROUP',
          env.CAMPAIGNS_GROUP,
          env.HOSTNAME,
          'COUNT',
          String(env.DISPATCHER_BATCH_SIZE),
          'BLOCK',
          String(XREAD_BLOCK_MS),
          'STREAMS',
          env.CAMPAIGNS_STREAM,
          '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;
        if (!reply) continue;
        for (const streamReply of reply) {
          const entries = streamReply[1];
          for (const entry of entries) {
            const streamId = entry[0];
            const fieldArr = entry[1];
            const fields: Record<string, string> = {};
            for (let i = 0; i + 1 < fieldArr.length; i += 2) {
              const k = fieldArr[i];
              const v = fieldArr[i + 1];
              if (k !== undefined && v !== undefined) fields[k] = v;
            }
            const deliveryIdRaw = fields['delivery_id'];
            const queuedAtRaw = fields['queued_at'];
            if (!deliveryIdRaw) {
              logger.warn({ streamId, fields }, 'stream entry missing delivery_id — XACK + skip');
              await rawRedis.xack(env.CAMPAIGNS_STREAM, env.CAMPAIGNS_GROUP, streamId);
              continue;
            }
            const deliveryId = Number(deliveryIdRaw);
            const parsed = parseQueuedAt(queuedAtRaw);
            if (parsed.fallback) {
              logger.warn(
                { streamId, deliveryId, queuedAtRaw, normalized: parsed.normalized },
                'queued_at raw inválido — usando now() como fallback (SELECT no matcheará)',
              );
            }
            pushJob({ streamId, deliveryId, queuedAt: parsed.date });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (stopping) return;
        logger.error({ err: message }, 'XREADGROUP loop error — backing off 1s');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  // ─── Per-job processing ────────────────────────────────────────────────────
  type TerminalCarry = {
    kind: 'terminal';
    campaignId: string;
    category: ErrorCategory;
    errorCode?: string;
    errorMessage?: string;
    fullPayload?: unknown;
    fullResponse?: unknown;
    attemptsMade: number;
  };
  type RetryCarry = {
    kind: 'retry';
    attemptIndex: number; // 0-based — same value just persisted via retry_count++
    errorMessage: string;
  };
  type Carry = TerminalCarry | RetryCarry;

  async function processJob(job: StreamJob): Promise<void> {
    metricsCollector.recordDequeue();
    const { streamId, deliveryId, queuedAt } = job;
    // queuedAt llega con precisión de ms (JS Date roundtrip). Todos los
    // WHERE id+queued_at usan BETWEEN ±1ms para tolerar el drift contra rows
    // con µs reales (postgres `now()` default). Ver
    // techdebt-dispatcher-smoke-bugs-2026-05-27.

    let retryError: Error | null = null;
    // Per-task carry (NOT closure-level — each processJob has its own). Set
    // inside the TX when classification is terminal; consumed post-COMMIT.
    // Wrapped in a single-prop object so TS doesn't narrow away the assignment
    // that happens inside the async TX closure.
    const carryBox: { value: Carry | null } = { value: null };

    try {
      await sql.begin(async (tx: TransactionSql) => {
        // 1. SELECT FOR UPDATE SKIP LOCKED (ADR-015).
        // queued_at se usa para partition pruning (timestamptz partition key).
        // Range ±1ms cubre microsecond-precision rows: postgres.js serializa JS
        // Date a milliseconds y pierde los µs, lo que rompía exact match si el
        // enqueuer usó `now()` (default Postgres → 6 digits) — bug reportado en
        // smoke A2 2026-05-27, ver techdebt-dispatcher-smoke-bugs-2026-05-27.
        const locked = await tx<
          Array<{ id: number; status: string; retry_count: number; campaign_id: string }>
        >`
          SELECT id::bigint AS id, status, retry_count, campaign_id::text AS campaign_id
          FROM bot.campaign_deliveries
          WHERE id = ${deliveryId}
            AND queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond'
                              AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
          FOR UPDATE SKIP LOCKED
        `;
        if (locked.length === 0) {
          logger.debug({ deliveryId, queuedAt }, 'delivery locked/gone — skip');
          return;
        }
        const row = locked[0];
        if (!row) return;
        if (row.status !== 'pending') {
          logger.debug(
            { deliveryId, status: row.status },
            'delivery non-pending — skip (idempotent)',
          );
          return;
        }

        // 2. Resolve full context
        const ctx = await resolveDeliveryContext(tx, deliveryId, queuedAt);
        if (!ctx) {
          throw new Error(`Delivery ${deliveryId} context not resolvable`);
        }

        // 2b. Channel guard (Fase 5 PR0 — canal-agnostic provider abstraction).
        // The campaign's channel must have a registered provider. If a campaign
        // was launched with channel='email|facebook|instagram|sms' before the
        // adapter ships, fail terminally instead of crashing in the WA send path.
        try {
          assertProviderAvailable(ctx.delivery.channel);
        } catch (err) {
          if (err instanceof ChannelNotImplementedError) {
            await tx`
              UPDATE bot.campaign_deliveries SET
                status = 'failed', failed_at = now(),
                error_code = 'channel_not_implemented',
                error_message = ${err.message},
                failure_reason = 'channel_not_implemented'
              WHERE id = ${deliveryId} AND queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond' AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
            `;
            return;
          }
          throw err;
        }

        if (!ctx.contact.phone) {
          // Phone missing for WA channel = terminal payload-invalid.
          await tx`
            UPDATE bot.campaign_deliveries SET
              status = 'failed', failed_at = now(),
              error_code = 'no_phone',
              error_message = 'audience contact has no phone for whatsapp channel',
              failure_reason = 'phone_invalid'
            WHERE id = ${deliveryId} AND queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond' AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
          `;
          // ack-only path (handled at end);
          return;
        }
        if (ctx.campaign.status === 'paused' || ctx.campaign.status === 'canceled') {
          // Campaign was paused/canceled between enqueue and dispatch; suppress.
          await tx`
            UPDATE bot.campaign_deliveries SET
              status = 'suppressed', suppressed_at = now(),
              failure_reason = ${'campaign_' + ctx.campaign.status}
            WHERE id = ${deliveryId} AND queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond' AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
          `;
          // ack-only path (handled at end);
          return;
        }
        if (ctx.contact.unsubscribed_at) {
          await tx`
            UPDATE bot.campaign_deliveries SET
              status = 'suppressed', suppressed_at = now(),
              failure_reason = 'opt_out'
            WHERE id = ${deliveryId} AND queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond' AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
          `;
          // ack-only path (handled at end);
          return;
        }

        // 3. Pick phone (sticky / multi-phone).
        const phone = await pickPhoneForContact(tx, ctx.delivery.audience_contact_id);
        if (!phone) {
          // Pause the campaign so we stop dequeueing jobs that all hit this.
          await tx`
            UPDATE bot.campaigns
            SET status = 'paused', paused_at = now(),
                pause_reason = 'auto_no_available_phones',
                paused_by = 'dispatcher_auto'
            WHERE id = ${ctx.delivery.campaign_id} AND status = 'sending'
          `;
          // Throw so the job retries — by next retry the operator may have
          // re-activated a phone or the campaign is paused (then we'll suppress).
          throw new Error('NoAvailablePhonesError');
        }

        // 3b. Resolve AI bindings (Fase 4 item 3). Sustituye {{ai_generated}}
        // por LLM-generated body cached per (campaign, contact, var_key,
        // prompt_hash). Si AI disabled o key falta → no-op.
        const aiResolvedBindings = await resolveAiBindings(
          pgPool,
          ctx.campaign.template_variable_bindings,
          ctx.campaign,
          ctx.contact,
          ctx.template,
        );

        // 4. Resolve template components.
        const components = resolveTemplateComponents(
          ctx.template,
          ctx.contact,
          ctx.delivery.template_variables,
          aiResolvedBindings,
        );

        // 5. POST Meta. Apply rate-limit token before the network call.
        await acquireToken();
        const startMs = Date.now();
        let result: ProviderSendResult;
        try {
          result = await sendWhatsApp({
            phone_number_id: phone.phone_number_id,
            to: ctx.contact.phone,
            template_name: ctx.template.name,
            template_lang: ctx.template.language,
            components,
            biz_opaque_callback_data: ctx.delivery.client_ref,
          });
        } catch (sendErr) {
          // Network or 5xx. Re-throw to trigger retry logic.
          // Log el error completo ANTES de tirar para que el retry loop tenga
          // el context — el outer catch solo guarda en retryError y el "retry
          // scheduled" log no incluye el detalle. Sin esto, fallas 5xx/network
          // se ven como retry loop silencioso. Side bug F4i3 smoke 2026-05-28.
          const e = sendErr as Error & { http_status?: number; error_code?: string };
          metricsCollector.recordError('network_or_5xx');
          logger.error(
            {
              deliveryId,
              campaign_id: ctx.delivery.campaign_id,
              http_status: e.http_status,
              error_code: e.error_code,
              err: e.message,
              to_last4: ctx.contact.phone?.slice(-4),
              phone_number_id: phone.phone_number_id,
            },
            'sendWhatsApp threw — propagating to retry path',
          );
          throw sendErr;
        }
        metricsCollector.recordSend(Date.now() - startMs);

        // 6. Branch on result.
        if (result.ok && result.message_id) {
          await tx`
            UPDATE bot.campaign_deliveries SET
              status = 'accepted',
              accepted_at = now(),
              meta_message_id = ${result.message_id},
              wa_phone_number_id = ${phone.id}
            WHERE id = ${deliveryId} AND queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond' AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
          `;
          // 7. Bump sent_today.
          await tx`
            UPDATE bot.wa_phone_numbers
            SET sent_today = sent_today + 1
            WHERE id = ${phone.id}
          `;
          // 8. SSE publish (outside the TX would be safer for atomicity but
          // postgres.js doesn't expose a post-commit hook; the cost of an
          // occasional missed publish on rollback is acceptable — the cockpit
          // also polls).
          try {
            await rawRedis.publish(
              `campaign:${ctx.delivery.campaign_id}`,
              JSON.stringify({
                deliveryId,
                status: 'accepted',
                contactId: ctx.delivery.audience_contact_id,
                timestamp: new Date().toISOString(),
              }),
            );
          } catch (pubErr) {
            logger.warn(
              { err: (pubErr as Error).message },
              'redis PUBLISH failed — non-fatal',
            );
          }
          return;
        }

        // 6.b Send returned non-ok (4xx with error body).
        const errCode = result.error_code ?? '';

        // 131049 frequency cap — terminal undelivered. Distinct branch (not DLQ).
        if (errCode === '131049') {
          await tx`
            UPDATE bot.campaign_deliveries SET
              status = 'undelivered',
              undelivered_at = now(),
              failed_at = now(),
              error_code = '131049',
              error_message = 'Meta frequency cap (cross-brand 2/24h)',
              failure_reason = 'meta_freq_cap_131049'
            WHERE id = ${deliveryId} AND queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond' AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
          `;
          metricsCollector.recordError('freq_cap_131049');
          // ack-only path (handled at end);
          return;
        }

        const attemptIndex = row.retry_count;
        const attemptsMade = attemptIndex + 1;
        const classification = classifyMetaError(
          result,
          attemptsMade,
          env.DISPATCHER_BULLMQ_ATTEMPTS,
        );
        metricsCollector.recordError(classification.category);

        if (classification.terminal) {
          // Terminal failure — write delivery row + queue DLQ insert outside TX.
          await tx`
            UPDATE bot.campaign_deliveries SET
              status = 'failed',
              failed_at = now(),
              error_code = ${result.error_code ?? null},
              error_message = ${result.error_message ?? null},
              failure_reason = ${classification.category}
            WHERE id = ${deliveryId} AND queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond' AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
          `;
          if (classification.shouldPauseCampaign && classification.pauseReason) {
            await tx`
              UPDATE bot.campaigns
              SET status = 'paused', paused_at = now(),
                  pause_reason = ${classification.pauseReason},
                  paused_by = 'dispatcher_auto'
              WHERE id = ${ctx.delivery.campaign_id} AND status = 'sending'
            `;
          }
          // DLQ insert happens after commit (see below) to avoid nested TX hazards.
          // ack_dlq path — terminalCarry set above;
          // Stash classification on the closure so post-TX code can use it.
          carryBox.value = {
            kind: 'terminal',
            campaignId: ctx.delivery.campaign_id,
            category: classification.category,
            errorCode: result.error_code,
            errorMessage: result.error_message,
            fullPayload: result.raw_request,
            fullResponse: result.raw_response,
            attemptsMade,
          };
          return;
        }

        // Retriable — bump retry_count and stash carry. NO throw aquí: si
        // tirábamos error rolleaba la TX y retry_count nunca incrementaba
        // (bug 2026-05-28: infinite loop con attemptIndex=0 forever).
        // Ahora COMMIT-eamos el bump, post-TX decide retry vs DLQ.
        await tx`
          UPDATE bot.campaign_deliveries SET retry_count = retry_count + 1
          WHERE id = ${deliveryId} AND queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond' AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
        `;
        carryBox.value = {
          kind: 'retry',
          attemptIndex,
          errorMessage: `Meta send failed: ${result.error_code ?? '?'} ${result.error_message ?? ''}`,
        };
        return;
      });
    } catch (err) {
      retryError = err as Error;
      // Log al setear retryError. El "retry scheduled" downstream solo loguea
      // deliveryId + attemptIndex + delay_ms — el operador no podía ver QUÉ
      // error disparó el retry. Side bug F4i3 smoke 2026-05-28.
      logger.warn(
        { deliveryId, err: retryError.message },
        'processJob TX rolled back with thrown error — going to retry path',
      );
    }

    // Post-TX side-effects.
    const carry = carryBox.value;
    if (carry?.kind === 'terminal') {
      try {
        await moveToDLQ(sql, logger, {
          deliveryId,
          queuedAt,
          campaignId: carry.campaignId,
          errorCategory: carry.category,
          errorCode: carry.errorCode,
          errorMessage: carry.errorMessage,
          fullPayload: carry.fullPayload,
          fullResponse: carry.fullResponse,
          attemptsMade: carry.attemptsMade,
          firstFailedAt: new Date(),
        });
      } catch (dlqErr) {
        logger.error(
          { err: (dlqErr as Error).message, deliveryId },
          'DLQ insert failed (non-fatal — recovery worker will retry)',
        );
      }
      carryBox.value = null;
    } else if (carry?.kind === 'retry') {
      // Schedule retry OR DLQ if exhausted. retry_count ya commitó +1.
      const attemptIndex = carry.attemptIndex;
      const nextAttempt = attemptIndex + 1;
      if (nextAttempt >= env.DISPATCHER_BULLMQ_ATTEMPTS) {
        await failTerminallyAndDLQ(deliveryId, queuedAt, new Error(carry.errorMessage), 'meta_5xx_exhausted');
      } else {
        const delay = backoffDelayMs(attemptIndex);
        const eta = Date.now() + delay;
        try {
          await rawRedis.zadd(RETRY_ZSET_KEY, String(eta), JSON.stringify({ deliveryId, queuedAt: queuedAt.toISOString() }));
          logger.info(
            { deliveryId, attemptIndex, delay_ms: delay, reason: carry.errorMessage },
            'retry scheduled',
          );
        } catch (zErr) {
          logger.error({ err: (zErr as Error).message, deliveryId }, 'retry ZADD failed — DLQ-ing instead');
          await failTerminallyAndDLQ(deliveryId, queuedAt, new Error(carry.errorMessage), 'meta_5xx_exhausted');
        }
      }
      carryBox.value = null;
    }

    if (retryError) {
      // Decide retry vs DLQ vs ack.
      const r = retryError as Error & { __retriable?: boolean; __attemptIndex?: number };
      if (r.__retriable) {
        const attemptIndex = r.__attemptIndex ?? 0;
        const nextAttempt = attemptIndex + 1; // 0-based attempt index already bumped
        if (nextAttempt >= env.DISPATCHER_BULLMQ_ATTEMPTS) {
          // Exhausted — DLQ.
          await failTerminallyAndDLQ(deliveryId, queuedAt, retryError, 'meta_5xx_exhausted');
        } else {
          const delay = backoffDelayMs(attemptIndex);
          const eta = Date.now() + delay;
          try {
            await rawRedis.zadd(
              RETRY_ZSET_KEY,
              String(eta),
              JSON.stringify({ deliveryId, queuedAt: queuedAt.toISOString() }),
            );
            logger.info(
              { deliveryId, attemptIndex, delay_ms: delay, reason: retryError.message },
              'retry scheduled',
            );
          } catch (zErr) {
            logger.error(
              { err: (zErr as Error).message, deliveryId },
              'retry ZADD failed — DLQ-ing instead',
            );
            await failTerminallyAndDLQ(
              deliveryId,
              queuedAt,
              retryError,
              'meta_5xx_exhausted',
            );
          }
        }
      } else {
        // Non-retriable thrown from inside TX (NoAvailablePhonesError, or
        // context-not-resolvable). Schedule a retry — the next attempt may
        // find the campaign suppressed (then it'll be ACKed).
        logger.warn(
          { deliveryId, err: retryError.message },
          'non-retriable throw inside TX — scheduling retry once',
        );
        const delay = backoffDelayMs(0);
        const eta = Date.now() + delay;
        try {
          await rawRedis.zadd(
            RETRY_ZSET_KEY,
            String(eta),
            JSON.stringify({ deliveryId, queuedAt: queuedAt.toISOString() }),
          );
        } catch (zErr) {
          logger.error(
            { err: (zErr as Error).message, deliveryId },
            'retry ZADD failed',
          );
        }
      }
    }

    // Always ACK — retry stays scheduled in the ZSET, not in the stream PEL.
    try {
      await rawRedis.xack(env.CAMPAIGNS_STREAM, env.CAMPAIGNS_GROUP, streamId);
    } catch (ackErr) {
      logger.error(
        { err: (ackErr as Error).message, streamId },
        'XACK failed — entry will be reclaimed by recovery worker',
      );
    }
  }

  async function failTerminallyAndDLQ(
    deliveryId: number,
    queuedAt: Date,
    err: Error,
    category: ErrorCategory,
  ): Promise<void> {
    try {
      const updated = await sql<Array<{ campaign_id: string }>>`
        UPDATE bot.campaign_deliveries SET
          status = 'failed',
          failed_at = COALESCE(failed_at, now()),
          error_message = COALESCE(error_message, ${err.message}),
          failure_reason = COALESCE(failure_reason, ${category})
        WHERE id = ${deliveryId} AND queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond' AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
          AND status NOT IN ('delivered', 'read', 'replied')
        RETURNING campaign_id::text AS campaign_id
      `;
      const updatedRow = updated[0];
      if (updatedRow) {
        await moveToDLQ(sql, logger, {
          deliveryId,
          queuedAt,
          campaignId: updatedRow.campaign_id,
          errorCategory: category,
          errorMessage: err.message,
          attemptsMade: env.DISPATCHER_BULLMQ_ATTEMPTS,
          firstFailedAt: new Date(),
        });
      }
    } catch (e) {
      logger.error(
        { err: (e as Error).message, deliveryId },
        'failTerminallyAndDLQ failed',
      );
    }
  }

  // ─── Worker pool ───────────────────────────────────────────────────────────
  async function workerLoop(): Promise<void> {
    while (!stopping) {
      const job = await waitForJob();
      if (!job) break;
      const task = processJob(job).catch((err) => {
        logger.error(
          { err: (err as Error).message, stack: (err as Error).stack },
          'processJob unexpected throw — swallowed',
        );
      });
      inflight.add(task);
      // Block this worker until the job finishes so concurrency is bounded
      // by pool size, not by background tasks.
      await task;
      inflight.delete(task);
    }
  }

  // ─── Retry scheduler ───────────────────────────────────────────────────────
  const retryHandle = setInterval(() => {
    void promoteRetries();
  }, RETRY_SCHEDULER_INTERVAL_MS);

  async function promoteRetries(): Promise<void> {
    try {
      const now = Date.now();
      const popped = (await rawRedis.zrangebyscore(
        RETRY_ZSET_KEY,
        '-inf',
        String(now),
        'LIMIT',
        0,
        100,
      )) as string[];
      for (const member of popped) {
        try {
          const parsed = JSON.parse(member) as { deliveryId: number; queuedAt: string };
          await rawRedis.xadd(
            env.CAMPAIGNS_STREAM,
            '*',
            'delivery_id',
            String(parsed.deliveryId),
            'queued_at',
            parsed.queuedAt,
          );
          await rawRedis.zrem(RETRY_ZSET_KEY, member);
        } catch (memberErr) {
          logger.error(
            { err: (memberErr as Error).message, member },
            'retry promotion failed for member',
          );
          // Remove anyway — bad JSON would loop forever.
          try {
            await rawRedis.zrem(RETRY_ZSET_KEY, member);
          } catch {
            /* ignore */
          }
        }
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'retry scheduler tick failed');
    }
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────
  const readerPromise = readerLoop();
  const workerPromises: Array<Promise<void>> = [];
  for (let i = 0; i < env.DISPATCHER_CONCURRENCY; i += 1) {
    workerPromises.push(workerLoop());
  }

  async function stop(): Promise<void> {
    stopping = true;
    clearInterval(refillHandle);
    clearInterval(retryHandle);
    // Wake any sleeping workers.
    if (readerWake) {
      readerWake();
      readerWake = null;
    }
    await Promise.allSettled([readerPromise, ...workerPromises, ...inflight]);
  }

  return { stop };
}
