/**
 * Management plane use cases — F3 (H3.1 templates, H3.2 endpoints/quality).
 *
 * Single owner of `bot.message_templates`, `bot.outbound_endpoints` and
 * `bot.wa_phone_numbers` *writes* from here on (doc §9 F3). The logic is a
 * faithful port of two now-retired call sites:
 *   - campaign-site `src/lib/campaigns.ts` (on-demand sync/create/delete/
 *     quality — the 5 Graph calls of H3.3), and
 *   - n8n `campaigns-template-sync` cron (daily mirror + AUTO-PAUSE of
 *     sending/queued campaigns when their template turns rejected/disabled +
 *     best-effort email alert to `bot.config['branding'].admin_email`).
 * Both behaviors now live once, behind every entry door (HTTP transport +
 * the `workers/template-sync.ts` cron call the same functions here).
 *
 * §3.4 rules honored: no Fastify/undici imports (Graph adapter and email
 * sender are injected via `ManagementDeps`), neutral results out.
 */
import type { SqlClient } from '../lib/postgres.js';
import type { Logger } from '../lib/logger.js';
import type { GraphManagement, GraphTemplate } from '../providers/whatsapp-management.js';
import { readChannelWhatsAppConfig } from '../lib/providers.js';
import { isMissingRelation } from '../lib/pg-errors.js';
import { notify, type NotifyDeps } from './notify.js';

export interface ManagementDeps {
  sql: SqlClient;
  logger: Logger;
  graph: GraphManagement;
  /** `env.COCKPIT_URL` — link target in the auto-pause alert email. */
  cockpitUrl?: string;
  /**
   * F7.5 tanda 0 — el aviso de auto-pause sale por `core/notify.ts`, no por el
   * provider crudo. Reemplaza a `sendEmail`: acá no se arma más ni el
   * destinatario, ni el remitente, ni el `client_ref`, ni el fan-out. El
   * emisor dice qué pasó.
   */
  notify: NotifyDeps;
}

/**
 * WABA global (multi-WABA adds endpoint WABAs on sync) — antes venía baked
 * como `deps.wabaId` desde `env.META_WA_WABA_ID` al boot; ahora se resuelve
 * en CADA llamada vía `readChannelWhatsAppConfig()` (DB `bot.config`
 * `channel_whatsapp.waba_id` → env `META_WA_WABA_ID`), porque el cockpit va
 * a poder cambiarlo desde la DB sin redeploy — un valor baked al boot nunca
 * lo vería.
 *
 * `null` cuando ninguna de las dos fuentes tiene el dato: el llamador decide
 * (no hay Graph call posible sin WABA).
 */
async function resolveWabaId(): Promise<string | null> {
  const cfg = await readChannelWhatsAppConfig();
  return cfg.wabaId;
}

/** Mensaje único de "no hay WABA configurada" — nombra LAS DOS fuentes. */
const WABA_NOT_CONFIGURED =
  "No hay WABA configurada: falta bot.config['channel_whatsapp'].waba_id y la env META_WA_WABA_ID. " +
  'El canal WhatsApp de este cliente todavía no está cableado.';

// ─── Pure helpers (exported for unit tests) ─────────────────────────────────

/** Placeholders `{{1}}, {{2}}, …` present in a template body text. */
export function extractBodyVariables(bodyText: string): string[] {
  const matches = bodyText.match(/\{\{\d+\}\}/g) ?? [];
  return Array.from(new Set(matches));
}

/** Numeric var indexes ({{n}}) present in a text, unique + sorted. */
function numberedVars(text: string): number[] {
  const nums = (text.match(/\{\{(\d+)\}\}/g) ?? []).map((m) =>
    parseInt(m.replace(/\{\{|\}\}/g, ''), 10),
  );
  return Array.from(new Set(nums)).sort((a, b) => a - b);
}

/** Initial endpoint status derived from Meta quality (same criteria as NCS step 14e). */
export function endpointStatusFromQuality(qualityRating: string | undefined): {
  quality: string;
  status: string;
} {
  const quality = (qualityRating || 'unknown').toLowerCase();
  const status =
    quality === 'red' ? 'suspended' : quality === 'green' || quality === 'yellow' ? 'active' : 'warming';
  return { quality, status };
}

/** `messaging_limit_tier` ("TIER_1K") → numeric tier, null when unparseable. */
export function parseMessagingTier(tier: string | undefined): number | null {
  if (!tier) return null;
  return parseInt(tier.replace(/[^0-9]/g, ''), 10) || null;
}

export interface CreateTemplateInput {
  name: string;
  language: string;
  category: string;
  body_text: string;
  body_example_values?: string[];
  header_text?: string;
  header_example_values?: string[];
  footer_text?: string;
}

export type CreateTemplateValidation =
  | { ok: true; category: string; components: Array<Record<string, unknown>> }
  | { ok: false; message: string };

/**
 * Client-side validations + Meta `components` assembly for template create.
 * Verbatim port of campaign-site `createWhatsAppTemplateInMeta` pre-flight
 * (Meta's own rules are stricter; these catch the common rejections early).
 */
export function validateCreateTemplateInput(input: CreateTemplateInput): CreateTemplateValidation {
  if (!/^[a-z0-9_]+$/.test(input.name)) {
    return { ok: false, message: 'name solo permite lowercase, números y underscores (regex /^[a-z0-9_]+$/)' };
  }
  if (input.body_text.length < 1) {
    return { ok: false, message: 'body_text vacío' };
  }
  const category = input.category.toUpperCase();
  if (!['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category)) {
    return {
      ok: false,
      message: `category debe ser MARKETING / UTILITY / AUTHENTICATION (recibido: ${input.category})`,
    };
  }
  // Meta exige example values por variable; sin esto rechaza el template.
  const bodyVars = numberedVars(input.body_text);
  if (bodyVars.length > 0) {
    const provided = input.body_example_values ?? [];
    if (provided.length !== bodyVars.length || provided.some((v) => !v?.trim())) {
      return {
        ok: false,
        message: `Body tiene ${bodyVars.length} variable(s) {{${bodyVars.join('}}, {{')}}} — necesitás un valor de ejemplo no-vacío para cada una.`,
      };
    }
  }
  const headerVars = input.header_text ? numberedVars(input.header_text) : [];
  if (headerVars.length > 0) {
    const provided = input.header_example_values ?? [];
    if (provided.length !== headerVars.length || provided.some((v) => !v?.trim())) {
      return {
        ok: false,
        message: `Header tiene ${headerVars.length} variable(s) — necesitás un valor de ejemplo para cada una.`,
      };
    }
  }

  const components: Array<Record<string, unknown>> = [];
  if (input.header_text) {
    const headerComp: Record<string, unknown> = { type: 'HEADER', format: 'TEXT', text: input.header_text };
    if (headerVars.length > 0 && input.header_example_values) {
      headerComp.example = { header_text: input.header_example_values.map((v) => v.trim()) };
    }
    components.push(headerComp);
  }
  const bodyComp: Record<string, unknown> = { type: 'BODY', text: input.body_text };
  if (bodyVars.length > 0 && input.body_example_values) {
    // Meta espera array de arrays: [[var1, var2, …]] (un array por ejemplo).
    bodyComp.example = { body_text: [input.body_example_values.map((v) => v.trim())] };
  }
  components.push(bodyComp);
  if (input.footer_text) {
    components.push({ type: 'FOOTER', text: input.footer_text });
  }
  return { ok: true, category, components };
}

// ─── H3.1 — Template sync (cron + on-demand) ────────────────────────────────

export interface SyncTemplatesResult {
  ok: boolean;
  message: string;
  inserted: number;
  updated: number;
  total_fetched: number;
  campaigns_paused: number;
  errors: string[];
}

interface TemplatePauseEvent {
  templateDbId: string;
  templateName: string;
  newStatus: string;
  prevStatus: string | null;
  campaignsPaused: number;
}

/**
 * Mirror Meta templates → `bot.message_templates` for the global WABA plus
 * every WABA present in active/warming WhatsApp `bot.outbound_endpoints`
 * (multi-WABA, Fase 9). UPSERT by (channel, name, language).
 *
 * Absorbed from the n8n cron: when a template lands as rejected/disabled,
 * auto-pause its sending/queued campaigns (`pause_reason='auto_template_rejected'`,
 * operator `system_template_sync` + audit row) and email the operator
 * (best-effort, `bot.config['branding'].admin_email`).
 */
export async function syncTemplates(deps: ManagementDeps): Promise<SyncTemplatesResult> {
  const { sql, logger, graph } = deps;

  const globalWabaId = await resolveWabaId();
  if (!globalWabaId) {
    return {
      ok: false,
      message: WABA_NOT_CONFIGURED,
      inserted: 0,
      updated: 0,
      total_fetched: 0,
      campaigns_paused: 0,
      errors: [WABA_NOT_CONFIGURED],
    };
  }

  const wabaIds = new Set<string>([globalWabaId]);
  try {
    const eps = await sql<Array<{ waba_id: string }>>`
      SELECT DISTINCT waba_id FROM bot.outbound_endpoints
       WHERE channel = 'whatsapp' AND status IN ('active','warming')
         AND waba_id IS NOT NULL AND waba_id <> '' AND waba_id NOT ILIKE '%PENDING%'
    `;
    for (const e of eps) wabaIds.add(e.waba_id);
  } catch {
    // Tabla puede no existir en cliente sin multiphone — seguimos con el global.
  }

  let inserted = 0;
  let updated = 0;
  let totalFetched = 0;
  const errors: string[] = [];
  const pauseEvents: TemplatePauseEvent[] = [];

  for (const wabaId of wabaIds) {
    const fetched = await graph.fetchTemplates(wabaId);
    if (!fetched.ok) {
      errors.push(`WABA ${wabaId}: ${fetched.error}`);
      continue;
    }
    totalFetched += fetched.templates.length;

    for (const t of fetched.templates) {
      try {
        const r = await upsertTemplate(deps, wabaId, t);
        if (r.inserted) inserted++;
        else updated++;
        if (r.pause) pauseEvents.push(r.pause);
      } catch (err) {
        errors.push(`${t.name}: ${err instanceof Error ? err.message : 'error'}`);
      }
    }
  }

  const campaignsPaused = pauseEvents.reduce((acc, p) => acc + p.campaignsPaused, 0);
  if (campaignsPaused > 0) {
    await alertAutoPause(deps, pauseEvents).catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'template-sync: alert email failed (best-effort, continuing)',
      );
    });
  }

  const wabaCount = wabaIds.size;
  const result: SyncTemplatesResult = {
    ok: true,
    message: `Sync OK: ${inserted} nuevos, ${updated} actualizados (${totalFetched} total fetched de ${wabaCount} WABA${wabaCount === 1 ? '' : 's'}).`,
    inserted,
    updated,
    total_fetched: totalFetched,
    campaigns_paused: campaignsPaused,
    errors,
  };
  logger.info(
    { inserted, updated, total_fetched: totalFetched, campaigns_paused: campaignsPaused, errors: errors.length },
    'template sync done',
  );
  return result;
}

async function upsertTemplate(
  deps: ManagementDeps,
  wabaId: string,
  t: GraphTemplate,
): Promise<{ inserted: boolean; pause: TemplatePauseEvent | null }> {
  const { sql } = deps;
  const name = String(t.name || '');
  // Language se persiste RAW como lo devuelve Meta (es_AR, en_US) — igual que
  // el sync histórico de campaign-site. Lowercasearlo (herencia del cron n8n)
  // duplica filas contra el UNIQUE (channel, name, language): incidente del
  // primer sync en el lab 2026-08-02 (es_ar/en_us nuevas junto a es_AR/en_US).
  const language = String(t.language || 'es');
  if (!name || !language) return { inserted: false, pause: null };

  const bodyComponent = (t.components ?? []).find((c) => c.type === 'BODY');
  const bodyText = typeof bodyComponent?.text === 'string' ? bodyComponent.text : '';
  // Union of both historical body shapes: campaign-site stored {text, components},
  // the n8n cron stored {components, quality_score}. Consumers read either key.
  const bodyJson = JSON.stringify({
    text: bodyText,
    components: t.components ?? [],
    quality_score: t.quality_score ?? null,
  });
  const variables = extractBodyVariables(bodyText);
  const status = (t.status || 'pending').toLowerCase();
  // Meta devuelve el centinela "NONE" cuando NO hay rechazo — no lo persistimos.
  const rejectionReason =
    status === 'rejected' && t.rejected_reason && t.rejected_reason.toUpperCase() !== 'NONE'
      ? t.rejected_reason
      : null;

  const prev = await sql<Array<{ id: string; status: string }>>`
    SELECT id, status FROM bot.message_templates
     WHERE channel = 'whatsapp' AND name = ${name} AND language = ${language}
     LIMIT 1
  `;
  const prevStatus = prev[0]?.status ?? null;

  const rows = await sql<Array<{ id: string; inserted: boolean }>>`
    INSERT INTO bot.message_templates
      (external_id, channel, name, category, language, status,
       body_format, body, variables, rejection_reason, waba_id, last_synced_at)
    VALUES (${t.id ?? null}, 'whatsapp', ${name}, ${(t.category || 'utility').toLowerCase()},
            ${language}, ${status}, 'meta_wa_template',
            ${bodyJson}::jsonb, ${variables}::text[], ${rejectionReason}, ${wabaId}, now())
    ON CONFLICT (channel, name, language) DO UPDATE
       SET external_id = EXCLUDED.external_id,
           category = EXCLUDED.category,
           status = EXCLUDED.status,
           body_format = EXCLUDED.body_format,
           body = EXCLUDED.body,
           variables = EXCLUDED.variables,
           rejection_reason = EXCLUDED.rejection_reason,
           waba_id = EXCLUDED.waba_id,
           last_synced_at = EXCLUDED.last_synced_at,
           updated_at = now()
    RETURNING id, (xmax = 0) AS inserted
  `;
  const row = rows[0];
  if (!row) return { inserted: false, pause: null };

  let pause: TemplatePauseEvent | null = null;
  if (status === 'rejected' || status === 'disabled') {
    const paused = await sql<Array<{ id: string }>>`
      UPDATE bot.campaigns c
         SET status = 'paused',
             paused_at = COALESCE(c.paused_at, now()),
             paused_by = 'system_template_sync',
             pause_reason = 'auto_template_rejected'
       WHERE c.template_id = ${row.id}
         AND c.status IN ('sending', 'queued')
       RETURNING c.id
    `;
    if (paused.length > 0) {
      for (const p of paused) {
        await sql`
          INSERT INTO bot.campaign_launches_audit
            (campaign_id, action, operator, recorded_at, delta, evidence)
          VALUES (${p.id}, 'paused', 'system_template_sync', now(),
                  ${JSON.stringify({ reason: 'auto_template_rejected' })}::jsonb,
                  ${JSON.stringify({
                    template_id: row.id,
                    new_template_status: status,
                    prev_template_status: prevStatus,
                  })}::jsonb)
        `;
      }
      pause = {
        templateDbId: row.id,
        templateName: name,
        newStatus: status,
        prevStatus,
        campaignsPaused: paused.length,
      };
    }
  }

  return { inserted: Boolean(row.inserted), pause };
}

/**
 * Aviso al operador del auto-pause. Un solo llamado: qué pasó.
 *
 * ⚠ Lo que ANTES vivía acá y ahora vive en `core/notify.ts`: la query de
 * destinatarios, el remitente (que era `onboarding@resend.dev` HARDCODEADO —
 * el sandbox de Resend, que entrega al DUEÑO DE LA CUENTA con un 200 limpio,
 * o sea que esta alerta nunca le llegó a ningún cliente), el fan-out por
 * destinatario, el `client_ref` con el destino pegado y la lectura del
 * resultado. Cinco decisiones que este archivo ya no puede tomar mal.
 *
 * Best-effort sigue igual: `notify()` nunca tira, y un aviso que no sale no
 * puede deshacer el auto-pause que lo disparó.
 */
async function alertAutoPause(deps: ManagementDeps, events: TemplatePauseEvent[]): Promise<void> {
  const { logger } = deps;

  const totalPaused = events.reduce((acc, e) => acc + e.campaignsPaused, 0);
  const cockpitLink = deps.cockpitUrl ? `${deps.cockpitUrl.replace(/\/$/, '')}/campaigns` : '';
  const htmlItems = events
    .map(
      (e) =>
        `<p>El template <b>${e.templateName}</b> pasó a <b>${e.newStatus}</b>` +
        ` (antes: ${e.prevStatus ?? 'n/a'}) — ${e.campaignsPaused} campaña(s) auto-pausada(s).</p>`,
    )
    .join('');
  const textItems = events
    .map(
      (e) =>
        `Template ${e.templateName} pasó a ${e.newStatus} (antes: ${e.prevStatus ?? 'n/a'}) — ` +
        `${e.campaignsPaused} campaña(s) auto-pausada(s).`,
    )
    .join(' ');

  const outcome = await notify(deps.notify, {
    feature: 'campaigns',
    aviso: 'template-auto-pause',
    subject: `Template Meta bloqueante: ${totalPaused} campaña(s) pausada(s)`,
    html:
      htmlItems +
      `<p>No se envían más mensajes de esas campañas hasta resolverlo.</p>` +
      (cockpitLink ? `<p>Ver: ${cockpitLink}</p>` : ''),
    text: `${textItems}${cockpitLink ? ` Ver: ${cockpitLink}` : ''}`,
    // El template que disparó el pause: separa dos eventos distintos del mismo
    // aviso. Sin esto, el segundo template bloqueante del día se deduplica
    // contra el primero y nadie se entera.
    origin_ref: events[0]?.templateDbId ?? 'unknown',
    // Un aviso de «se pausaron campañas» no puede quedar mudo porque el tope de
    // mensajería se llenó: hasta ahora salía por el provider crudo, sin pasar
    // por el presupuesto, y perder el aviso al migrarlo sería una regresión
    // silenciosa. Mismo criterio que `budget-80` (H2.3).
    critical: true,
  });

  if (outcome.status === 'undeclared') {
    logger.error(
      { paused_templates: events.length, detail: outcome.detail },
      'template-sync auto-paused campaigns but the alert is not declared by the feature',
    );
    return;
  }
  if (outcome.blocked_reason) {
    logger.warn(
      { paused_templates: events.length, reason: outcome.blocked_reason },
      'template-sync auto-paused campaigns but the alert could not be sent',
    );
  }
}

// ─── H3.1 — Template create / delete ────────────────────────────────────────

export interface CreateWaTemplateResult {
  ok: boolean;
  message: string;
  meta_id?: string;
  status?: string;
  local_id?: string;
}

/**
 * POST a Meta /{WABA}/message_templates + local mirror insert. Meta reviews
 * async (24-48h) — the sync (cron or on-demand) picks up the final status.
 */
export async function createWaTemplate(
  deps: ManagementDeps,
  input: CreateTemplateInput,
): Promise<CreateWaTemplateResult> {
  const validated = validateCreateTemplateInput(input);
  if (!validated.ok) return { ok: false, message: validated.message };

  const wabaId = await resolveWabaId();
  if (!wabaId) return { ok: false, message: WABA_NOT_CONFIGURED };

  const created = await deps.graph.createTemplate(wabaId, {
    name: input.name,
    language: input.language,
    category: validated.category,
    components: validated.components,
  });
  if (!created.ok) {
    return { ok: false, message: `Meta rechazó la creación: ${created.error}` };
  }

  const variables = extractBodyVariables(input.body_text);
  const bodyJson = JSON.stringify({ text: input.body_text, components: validated.components });
  const rows = await deps.sql<Array<{ id: string }>>`
    INSERT INTO bot.message_templates
      (external_id, channel, name, category, language, status,
       body_format, body, variables, last_synced_at)
    VALUES (${created.id ?? null}, 'whatsapp', ${input.name}, ${input.category.toLowerCase()},
            ${input.language}, ${(created.status || 'pending').toLowerCase()}, 'meta_wa_template',
            ${bodyJson}::jsonb, ${variables}::text[], now())
    ON CONFLICT (channel, name, language) DO UPDATE
       SET external_id = EXCLUDED.external_id,
           category = EXCLUDED.category,
           status = EXCLUDED.status,
           body = EXCLUDED.body,
           variables = EXCLUDED.variables,
           rejection_reason = NULL,
           last_synced_at = EXCLUDED.last_synced_at,
           updated_at = now()
    RETURNING id
  `;

  return {
    ok: true,
    message: `Template "${input.name}" creado en Meta (status=${(created.status || 'PENDING').toLowerCase()}). Meta tarda 24-48h en aprobar.`,
    meta_id: created.id,
    status: created.status,
    local_id: rows[0]?.id,
  };
}

export type DeleteWaTemplateResult =
  | { ok: true; deleted: boolean; meta_warning?: string }
  | { ok: false; error: string };

/**
 * WA-only delete: Meta Graph deletes by NAME (per WABA), then the local
 * mirror row goes. Referential guard (campañas activas usando el template)
 * stays with the caller (campaign-site) — same split as before F3.
 *
 * Meta error #100 ("need permission") = the template lives in a WABA this
 * token does not manage → local delete proceeds with a warning (the mirror
 * must not keep a row we can't see).
 */
export async function deleteWaTemplate(
  deps: ManagementDeps,
  templateDbId: string,
): Promise<DeleteWaTemplateResult> {
  const { sql } = deps;
  const rows = await sql<Array<{ name: string; waba_id: string | null }>>`
    SELECT name, waba_id FROM bot.message_templates
     WHERE id = ${templateDbId} AND channel = 'whatsapp'
  `;
  const name = rows[0]?.name;
  if (!name) return { ok: true, deleted: false };

  const wabaId = rows[0]?.waba_id || (await resolveWabaId());
  if (!wabaId) return { ok: false, error: WABA_NOT_CONFIGURED };
  let metaWarning: string | undefined;
  const del = await deps.graph.deleteTemplateByName(wabaId, name);
  if (!del.ok) {
    if (del.http_status === 400 && del.error.includes('100')) {
      metaWarning =
        `No se pudo borrar en Meta (sin permiso sobre ese WABA): se eliminó solo de la lista local. ` +
        `Para borrarlo en Meta usá el WhatsApp Manager del WABA correspondiente.`;
    } else {
      return { ok: false, error: `Meta DELETE ${del.error}` };
    }
  }

  const deleted = await sql<Array<{ id: string }>>`
    DELETE FROM bot.message_templates
     WHERE id = ${templateDbId} AND channel = 'whatsapp'
     RETURNING id
  `;
  return { ok: true, deleted: deleted.length > 0, ...(metaWarning ? { meta_warning: metaWarning } : {}) };
}

// ─── H3.2 — Endpoints / quality ─────────────────────────────────────────────

export interface SyncEndpointsResult {
  ok: boolean;
  message: string;
  inserted: number;
  updated: number;
  errors: string[];
}

/**
 * GET /{WABA}/phone_numbers → UPSERT `bot.outbound_endpoints`
 * (channel='whatsapp'). No pisa overrides manuales (priority/daily_cap).
 */
/**
 * F8.2.b — `bot.outbound_endpoints` no existe en esta base.
 *
 * 🧭 **F9.8.b: este texto nombraba la causa equivocada.** Decía «migraciones
 * gateadas por `MODULES_OUTBOUND_ENGINE`», que es la lectura que F8.2.b midió
 * y descartó: el runner de producción **no lee `MODULES_*`** — gatea por
 * features contratadas y toma el dueño del header `-- feature:`. El sustrato
 * llevaba header `campaigns`, palmawebs no contrata campañas, y por eso no lo
 * recibía. Desde la **mig 230** (F9.1) el sustrato es de `messaging` y llega a
 * todo cliente que la contrate —incluida la clausura por `runtime_uses`, o sea
 * cualquiera con `chat-bot`—, así que hoy la ausencia significa otra cosa: la
 * 230 todavía no corrió en esta base. Un mensaje que manda al operador a
 * buscar un flag inexistente cuesta más que no decir nada.
 */
export const OUTBOUND_NOT_INSTALLED =
  'bot.outbound_endpoints no existe en este cliente: el sustrato del Messaging Service ' +
  '(migración 230 de la feature `messaging`) todavía no se aplicó en esta base. No es un dato ' +
  'a cargar: se resuelve solo en el próximo ciclo del deploy, que aplica las migraciones ' +
  'pendientes — plan WABA F9.1.';

export async function syncEndpoints(deps: ManagementDeps): Promise<SyncEndpointsResult> {
  const wabaId = await resolveWabaId();
  if (!wabaId) {
    return { ok: false, message: WABA_NOT_CONFIGURED, inserted: 0, updated: 0, errors: [] };
  }

  const fetched = await deps.graph.fetchPhoneNumbers(wabaId);
  if (!fetched.ok) {
    return { ok: false, message: `Meta API ${fetched.error}`, inserted: 0, updated: 0, errors: [] };
  }

  let inserted = 0;
  let updated = 0;
  const errors: string[] = [];
  for (const p of fetched.phones) {
    const { quality, status } = endpointStatusFromQuality(p.quality_rating);
    try {
      const r = await deps.sql<Array<{ inserted: boolean }>>`
        INSERT INTO bot.outbound_endpoints
          (channel, endpoint_id, display_name, phone_number_id, display_phone,
           waba_id, quality_rating, status, priority, created_at, updated_at)
        VALUES ('whatsapp', ${p.id}, ${p.display_phone_number}, ${p.id}, ${p.display_phone_number},
                ${wabaId}, ${quality}, ${status}, 0, now(), now())
        ON CONFLICT (channel, endpoint_id) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               display_phone = EXCLUDED.display_phone,
               waba_id = EXCLUDED.waba_id,
               quality_rating = EXCLUDED.quality_rating,
               updated_at = now()
        RETURNING (xmax = 0) AS inserted
      `;
      if (r[0]?.inserted) inserted++;
      else updated++;
    } catch (err) {
      // F8.2.b (plan WABA) — tabla ausente ≠ error por número. El registro de
      // endpoints es sustrato DEL SERVICIO (n endpoints, canal-agnóstico; lo
      // usan campañas, staff, notify) y desde la mig 230 su dueña declarada es
      // `messaging` (F9.1). Que falte significa que esa migración todavía no
      // corrió en esta base — no un flag apagado (F9.8.b). Se dice con la causa
      // real y sin un «OK: 0 nuevos» al lado, que es el falso verde de siempre.
      if (isMissingRelation(err)) {
        return {
          ok: false,
          message: OUTBOUND_NOT_INSTALLED,
          inserted,
          updated,
          errors: [],
        };
      }
      errors.push(`${p.display_phone_number}: ${err instanceof Error ? err.message : 'error'}`);
    }
  }
  return {
    ok: true,
    message: `Sync WhatsApp OK: ${inserted} nuevos, ${updated} actualizados (${fetched.phones.length} números en WABA ${wabaId}).`,
    inserted,
    updated,
    errors,
  };
}

export interface RefreshPhoneQualityResult {
  ok: boolean;
  updated?: { quality_rating: string; tier_current: number | null };
  error?: string;
}

/**
 * Per-phone quality/tier refresh → `bot.wa_phone_numbers` (warming table).
 * `id` is the bot.wa_phone_numbers row id, not the Meta phone_number_id.
 */
export async function refreshPhoneQuality(
  deps: ManagementDeps,
  id: string,
): Promise<RefreshPhoneQualityResult> {
  const rows = await deps.sql<Array<{ phone_number_id: string }>>`
    SELECT phone_number_id FROM bot.wa_phone_numbers WHERE id = ${id}
  `;
  if (rows.length === 0) return { ok: false, error: 'phone no encontrado' };

  const fetched = await deps.graph.fetchPhoneQuality(rows[0].phone_number_id);
  if (!fetched.ok) {
    return { ok: false, error: `Meta Graph ${fetched.error}` };
  }

  const qualityRating = fetched.quality_rating?.toLowerCase();
  const allowedQuality =
    qualityRating === 'green' || qualityRating === 'yellow' || qualityRating === 'red'
      ? qualityRating
      : null;
  const tier = parseMessagingTier(fetched.messaging_limit_tier);

  await deps.sql`
    UPDATE bot.wa_phone_numbers
       SET quality_rating = ${allowedQuality},
           tier_current = COALESCE(${tier}, tier_current),
           last_quality_check_at = now()
     WHERE id = ${id}
  `;
  return {
    ok: true,
    updated: { quality_rating: allowedQuality ?? 'unknown', tier_current: tier },
  };
}
