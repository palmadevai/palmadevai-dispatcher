/**
 * `POST /send` — H2.1 (messaging-service Fase 2). Low-volume synchronous
 * send path: staff notifications, feature alerts, any single-message
 * consumer that doesn't want to go through the campaign stream (see
 * `apps/features/messaging/doc/analysis-messaging-service.md` §3.1).
 *
 * Transport rule (§3.4): zero business logic lives here beyond request
 * shape → core calls → HTTP status mapping. Idempotency, opt-out, budget and
 * the actual provider send all live in `core/budget.ts` / existing
 * `providers/*` — this file just sequences them and translates results to
 * HTTP.
 *
 * v1 scope (H2.1): whatsapp + email, `content.type` text|template (whatsapp)
 * or text-only (email). facebook/instagram land later.
 *
 * Known limitation carried over from the doc: the WhatsApp 24h
 * customer-service window is NOT pre-validated for `content.type='text'` —
 * Meta rejects out-of-window sends on its own (4xx) and that error is
 * surfaced transparently via the 502 response, not swallowed.
 */
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Sql } from 'postgres';
import type { Logger } from '../../lib/logger.js';
import type { MetricsCollector } from '../../observability/metrics-collector.js';
import { OutboundMessageSchema, type OutboundMessage } from '../../core/schemas.js';
import { checkBudget, recordSendUsage, maybeAlert } from '../../core/budget.js';
import { getProviderForChannel } from '../../ports/channel-provider.js';
import type { WhatsAppSendInput } from '../../providers/whatsapp.js';
import type { EmailSendInput } from '../../providers/email.js';
import type { ProviderSendResult } from '../../providers/types.js';

export interface SendRouteDeps {
  sql: Sql;
  redis: Redis;
  logger: Logger;
  metricsCollector: MetricsCollector;
  /** `env.DISPATCHER_SEND_BEARER`. Undefined → route always 503s (fail-closed). */
  sendBearer: string | undefined;
  /** Parsed `env.STAFF_NOTIFY_ALLOWLIST` (CSV → trimmed array). */
  staffAllowlist: string[];
  /** `env.META_WA_DEFAULT_PHONE_NUMBER_ID`. Undefined → whatsapp sends 502. */
  defaultWaPhoneNumberId: string | undefined;
  /** `env.CAMPAIGNS_DEFAULT_FROM_EMAIL` — reused, no new email-from env for `/send`. */
  defaultFromEmail: string;
}

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const EMAIL_SUBJECT_MAX_CHARS = 60;

function maskDestination(to: string): string {
  const tail = to.slice(-4);
  return `***${tail}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function resolveCategory(
  sql: Sql,
  logger: Logger,
  msg: OutboundMessage,
): Promise<string> {
  if (msg.content.type === 'text') return 'service';
  // content.type === 'template'
  try {
    const rows = await sql<Array<{ category: string }>>`
      SELECT category FROM bot.message_templates
      WHERE channel = ${msg.channel} AND name = ${msg.content.name}
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    // No matching template row → conservative default (marketing is the most
    // expensive category — better to over-count spend than under-count it).
    return rows[0]?.category ?? 'marketing';
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, channel: msg.channel, template_name: msg.content.name },
      'message_templates category lookup failed — defaulting to marketing (conservative)',
    );
    return 'marketing';
  }
}

export function registerSendRoute(app: FastifyInstance, deps: SendRouteDeps): void {
  app.post('/send', async (request, reply) => {
    // ── Auth ────────────────────────────────────────────────────────────
    if (!deps.sendBearer) {
      return reply.code(503).send({ error: 'send_disabled' });
    }
    const authHeader = request.headers['authorization'];
    if (authHeader !== `Bearer ${deps.sendBearer}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    // ── Body validation (single source of truth: core/schemas.ts) ────────
    const parsed = OutboundMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const msg = parsed.data;
    const { feature, client_ref, kind } = msg.context;

    // ── Unsupported channel × content combos (v1) ─────────────────────────
    if (msg.channel === 'email' && msg.content.type !== 'text') {
      return reply.code(400).send({ error: 'unsupported_content_type', detail: 'email only supports content.type=text in v1' });
    }

    // ── 1. Idempotency (client_ref) ───────────────────────────────────────
    const idemKey = `msgsvc:ref:${client_ref}`;
    let isDuplicate = false;
    try {
      const set = await deps.redis.set(idemKey, '1', 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');
      isDuplicate = set !== 'OK';
    } catch (err) {
      // Redis down: fail open on idempotency (better a rare double-send than
      // blocking every /send call) but log loudly — this is not silent.
      deps.logger.error(
        { err: (err as Error).message, client_ref },
        'idempotency SET NX failed (Redis unreachable?) — proceeding without dedup guarantee',
      );
    }
    if (isDuplicate) {
      deps.logger.info({ feature, kind, channel: msg.channel, client_ref }, 'POST /send: duplicate client_ref — no-op');
      return reply.code(200).send({ status: 'duplicate' });
    }

    // ── 2. Staff-only destination for notifications ───────────────────────
    if (kind === 'notification' && !deps.staffAllowlist.includes(msg.to)) {
      deps.logger.warn(
        { feature, channel: msg.channel, to: maskDestination(msg.to) },
        'POST /send: notification destination not in STAFF_NOTIFY_ALLOWLIST',
      );
      return reply.code(403).send({ error: 'destination_not_allowed' });
    }

    // ── 3. Opt-out (whatsapp only, notifications skip — internal destination) ─
    if (msg.channel === 'whatsapp' && kind !== 'notification') {
      try {
        const rows = await deps.sql<Array<{ unsubscribed_at: Date | null }>>`
          SELECT unsubscribed_at FROM bot.audience_contacts WHERE phone = ${msg.to} LIMIT 1
        `;
        if (rows[0]?.unsubscribed_at) {
          return reply.code(422).send({ error: 'opted_out' });
        }
        // Contact not found in the BUC → proceed (e.g. staff/internal numbers
        // that were never enrolled as audience contacts).
      } catch (err) {
        deps.logger.error(
          { err: (err as Error).message, feature },
          'opt-out check query failed — proceeding (fail-open, logged loudly)',
        );
      }
    }

    // ── 4. Budget category + check ─────────────────────────────────────────
    const category = await resolveCategory(deps.sql, deps.logger, msg);
    const budgetResult = await checkBudget(deps.sql, deps.redis, deps.logger, msg.channel, category);
    await maybeAlert(deps.redis, deps.logger, msg.channel, category, budgetResult);

    const criticalBypass = kind === 'notification' && msg.context.critical === true;
    if (!budgetResult.allowed && !criticalBypass) {
      deps.logger.warn(
        { feature, channel: msg.channel, category, ...budgetResult },
        'POST /send: budget_exceeded',
      );
      return reply.code(429).send({
        status: 'failed',
        error_code: 'budget_exceeded',
        error_message: `monthly budget cap reached for ${msg.channel}/${category}`,
      });
    }

    // ── 5. Synchronous send via the existing ChannelProvider adapters ─────
    let sendInput: WhatsAppSendInput | EmailSendInput;
    if (msg.channel === 'whatsapp') {
      if (!deps.defaultWaPhoneNumberId) {
        return reply.code(502).send({
          status: 'failed',
          error_code: 'missing_phone_number_id',
          error_message: 'META_WA_DEFAULT_PHONE_NUMBER_ID is not configured',
        });
      }
      sendInput =
        msg.content.type === 'text'
          ? {
              phone_number_id: deps.defaultWaPhoneNumberId,
              to: msg.to,
              biz_opaque_callback_data: client_ref,
              type: 'text',
              body: msg.content.text,
            }
          : {
              phone_number_id: deps.defaultWaPhoneNumberId,
              to: msg.to,
              biz_opaque_callback_data: client_ref,
              type: 'template',
              template_name: msg.content.name,
              template_lang: msg.content.language,
              components: msg.content.components ?? [],
            };
    } else {
      // msg.channel === 'email', msg.content.type === 'text' (guarded above)
      const text = msg.content.type === 'text' ? msg.content.text : '';
      sendInput = {
        from: deps.defaultFromEmail,
        to: msg.to,
        subject: text.slice(0, EMAIL_SUBJECT_MAX_CHARS),
        html: `<p>${escapeHtml(text)}</p>`,
        biz_opaque_callback_data: client_ref,
      };
    }

    const provider = getProviderForChannel(msg.channel);
    const startMs = Date.now();
    let result: ProviderSendResult;
    try {
      result = await provider.send(sendInput);
    } catch (err) {
      const e = err as Error & { error_code?: string; http_status?: number };
      deps.logger.error(
        {
          feature,
          kind,
          channel: msg.channel,
          to: maskDestination(msg.to),
          err: e.message,
          http_status: e.http_status,
          error_code: e.error_code,
        },
        'POST /send: provider.send threw — no retry, caller decides',
      );
      return reply.code(502).send({
        status: 'failed',
        error_code: e.error_code ?? 'send_threw',
        error_message: e.message,
      });
    }

    if (!result.ok) {
      deps.logger.warn(
        { feature, kind, channel: msg.channel, to: maskDestination(msg.to), error_code: result.error_code, error_message: result.error_message },
        'POST /send: provider returned non-ok — no retry, caller decides',
      );
      return reply.code(502).send({
        status: 'failed',
        error_code: result.error_code ?? 'unknown',
        error_message: result.error_message ?? 'provider returned a non-ok result',
      });
    }

    await recordSendUsage(deps.redis, deps.logger, msg.channel, category);
    deps.metricsCollector.recordSend(Date.now() - startMs);
    deps.logger.info(
      { feature, kind, channel: msg.channel, to: maskDestination(msg.to), category, message_id: result.message_id },
      'POST /send: sent',
    );
    return reply.code(200).send({ status: 'sent', message_id: result.message_id });
  });
}
