/**
 * CRM webhook emitter — Fase 6 Item 1.
 *
 * Tick loop cada `CAMPAIGNS_WEBHOOK_EMITTER_INTERVAL_MS` (default 2000ms):
 *
 *   BEGIN
 *     SELECT FOR UPDATE OF d SKIP LOCKED
 *       d.* + e.url + e.hmac_secret + e.custom_headers + e.timeout_ms + e.max_attempts
 *     FROM bot.crm_webhook_deliveries d JOIN bot.crm_webhook_endpoints e ON e.id = d.endpoint_id
 *     WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND e.enabled
 *     ORDER BY d.next_attempt_at LIMIT batch_size
 *   COMMIT
 *
 *   For each row: POST con HMAC + custom headers. Classify response:
 *     - 2xx → status='sent', sent_at=now, last_response_status
 *     - 4xx terminal (400/401/403/404/410/422) → INSERT DLQ + status='failed'
 *     - 5xx / network / timeout → bump attempts. Si >= max_attempts → DLQ.
 *       Si no → next_attempt_at = now + backoff(attempts).
 *
 * SKIP LOCKED hace seguro correr múltiples replicas.
 *
 * Sin STUB_MODE: en stub-mode el emitter loguea intención pero no POSTea
 * ni updatea status (eventos quedan pending para inspect en local).
 */
import type { Sql } from 'postgres';
import { env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import { buildSignatureHeader } from '../lib/crm-hmac.js';

export interface CrmWebhookEmitterDeps {
  sql: Sql;
  logger: Logger;
}

interface PendingDelivery {
  id: string;
  endpoint_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: Date;
  url: string;
  hmac_secret: string;
  custom_headers: Record<string, string>;
  timeout_ms: number;
  max_attempts: number;
}

// 4xx que se consideran terminales (cliente debería arreglar config — no retry).
const TERMINAL_STATUS_CODES = new Set([400, 401, 403, 404, 410, 422]);

// Backoff schedule en segundos (index = attempt number 1..8). Cap final a 4h.
const BACKOFF_SCHEDULE_SECONDS = [30, 60, 300, 900, 1800, 3600, 7200, 14400];

function nextAttemptDelaySeconds(attempts: number): number {
  const idx = Math.min(attempts - 1, BACKOFF_SCHEDULE_SECONDS.length - 1);
  return BACKOFF_SCHEDULE_SECONDS[Math.max(idx, 0)]!;
}

function buildEnvelope(row: PendingDelivery): string {
  const envelope = {
    event: row.event_type,
    event_id: Number(row.id),
    occurred_at: row.created_at.toISOString(),
    client: env.CLIENT_SLUG,
    version: '1' as const,
    data: row.payload,
  };
  return JSON.stringify(envelope);
}

async function dispatchSingle(deps: CrmWebhookEmitterDeps, row: PendingDelivery): Promise<void> {
  const { logger, sql } = deps;

  const rawBody = buildEnvelope(row);
  const signature = buildSignatureHeader(row.hmac_secret, rawBody);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': env.CAMPAIGNS_WEBHOOK_USER_AGENT,
    'X-PalmaDev-Signature': signature,
    'X-PalmaDev-Event': row.event_type,
    'X-PalmaDev-Delivery-Id': String(row.id),
  };
  // Custom headers del endpoint mergeados al final — el cliente puede
  // inyectar Authorization proprietary. Nuestros headers reservados (Signature/
  // Event/Delivery-Id) los respetamos: no permitimos override.
  for (const [k, v] of Object.entries(row.custom_headers ?? {})) {
    if (headers[k] !== undefined) continue;
    headers[k] = String(v);
  }

  const startedAt = Date.now();
  let responseStatus: number | null = null;
  let lastError: string | null = null;

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), row.timeout_ms);
    let response: Response;
    try {
      response = await fetch(row.url, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    responseStatus = response.status;
  } catch (err) {
    lastError = (err as Error).message || String(err);
    if ((err as { name?: string }).name === 'AbortError') {
      lastError = `timeout after ${row.timeout_ms}ms`;
    }
  }

  const durationMs = Date.now() - startedAt;
  const outcome = classifyResponse(responseStatus, lastError);

  logger.debug(
    {
      delivery_id: row.id,
      endpoint_id: row.endpoint_id,
      event_type: row.event_type,
      response_status: responseStatus,
      duration_ms: durationMs,
      outcome,
      attempts: row.attempts + 1,
    },
    'crm webhook dispatch result',
  );

  if (outcome === 'success') {
    await sql`
      UPDATE bot.crm_webhook_deliveries SET
        status = 'sent',
        sent_at = now(),
        last_response_status = ${responseStatus},
        last_error = NULL,
        attempts = ${row.attempts + 1}
      WHERE id = ${row.id}::bigint
    `;
    return;
  }

  const newAttempts = row.attempts + 1;
  const errorMsg = lastError ?? `http_${responseStatus ?? 'unknown'}`;

  if (outcome === 'terminal' || newAttempts >= row.max_attempts) {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO bot.crm_webhook_dlq
          (delivery_id, endpoint_id, event_type, payload, attempts, last_error, last_response_status)
        VALUES (
          ${row.id}::bigint, ${row.endpoint_id}::bigint, ${row.event_type},
          ${tx.json(row.payload as Parameters<typeof tx.json>[0])}, ${newAttempts}, ${errorMsg}, ${responseStatus}
        )
      `;
      await tx`
        UPDATE bot.crm_webhook_deliveries SET
          status = 'failed',
          attempts = ${newAttempts},
          last_error = ${errorMsg},
          last_response_status = ${responseStatus}
        WHERE id = ${row.id}::bigint
      `;
    });
    logger.warn(
      {
        delivery_id: row.id,
        endpoint_id: row.endpoint_id,
        event_type: row.event_type,
        attempts: newAttempts,
        max_attempts: row.max_attempts,
        outcome,
        last_error: errorMsg,
      },
      'crm webhook moved to DLQ',
    );
    return;
  }

  // Retry path — bump attempts + reschedule
  const delaySec = nextAttemptDelaySeconds(newAttempts);
  await sql`
    UPDATE bot.crm_webhook_deliveries SET
      attempts = ${newAttempts},
      last_error = ${errorMsg},
      last_response_status = ${responseStatus},
      next_attempt_at = now() + (${delaySec} * INTERVAL '1 second')
    WHERE id = ${row.id}::bigint
  `;
}

type Outcome = 'success' | 'terminal' | 'transient';

function classifyResponse(status: number | null, error: string | null): Outcome {
  if (status !== null) {
    if (status >= 200 && status < 300) return 'success';
    if (TERMINAL_STATUS_CODES.has(status)) return 'terminal';
    // 5xx + 3xx redirect-loop / unhandled = transient
    return 'transient';
  }
  // Network/timeout/DNS — transient salvo error_explícito que no se va a recuperar.
  // Conservador: tratamos todo error de red como transient (retry).
  void error;
  return 'transient';
}

export function startCrmWebhookEmitter(deps: CrmWebhookEmitterDeps): NodeJS.Timeout {
  const { logger, sql } = deps;
  const intervalMs = env.CAMPAIGNS_WEBHOOK_EMITTER_INTERVAL_MS;
  const batchSize = env.CAMPAIGNS_WEBHOOK_BATCH_SIZE;

  logger.info(
    {
      interval_ms: intervalMs,
      batch_size: batchSize,
      stub_mode: env.STUB_MODE,
    },
    'starting crm-webhook-emitter worker',
  );

  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return; // skip overlap si un tick previo todavía está corriendo
    running = true;
    try {
      const rows = await sql.begin(async (tx) => {
        const result = await tx<PendingDelivery[]>`
          SELECT
            d.id::text                                AS id,
            d.endpoint_id::text                       AS endpoint_id,
            d.event_type,
            d.payload,
            d.attempts,
            d.created_at,
            e.url,
            e.hmac_secret,
            e.custom_headers,
            e.timeout_ms,
            e.max_attempts
          FROM bot.crm_webhook_deliveries d
          JOIN bot.crm_webhook_endpoints e ON e.id = d.endpoint_id
          WHERE d.status = 'pending'
            AND d.next_attempt_at <= now()
            AND e.enabled = true
          ORDER BY d.next_attempt_at
          LIMIT ${batchSize}
          FOR UPDATE OF d SKIP LOCKED
        `;
        return result;
      });

      if (rows.length === 0) return;

      if (env.STUB_MODE) {
        logger.info(
          { batch_count: rows.length, sample_event: rows[0]?.event_type },
          'crm-webhook-emitter STUB_MODE: skip POST + no UPDATE (rows stay pending)',
        );
        return;
      }

      logger.debug({ batch_count: rows.length }, 'crm-webhook-emitter dispatching batch');

      // Procesamos en paralelo dentro del batch — concurrency limitada por
      // batch_size + por que la TX SELECT FOR UPDATE ya hizo el lock claim.
      // Network bound: paralelismo está OK.
      await Promise.allSettled(rows.map((row) => dispatchSingle(deps, row)));
    } catch (err) {
      logger.error(
        { err: (err as Error).message },
        'crm-webhook-emitter tick failed',
      );
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);

  return handle;
}
