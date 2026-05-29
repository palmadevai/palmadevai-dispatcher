/**
 * Resolve all the context the dispatcher needs to send: delivery row,
 * audience_contact channel info (phone E.164), template (Meta body shape),
 * and campaign (rate limits + pause status).
 *
 * Composite PK (id, queued_at) — partitioning-aware. Without the partition key
 * Postgres has to scan every monthly partition; with it, planner prunes.
 *
 * Returns null if delivery is gone (race with manual delete / partition prune).
 */
import type { Sql, TransactionSql } from 'postgres';

type SqlOrTx = Sql | TransactionSql;

export interface DeliveryContext {
  delivery: {
    id: number;
    queued_at: Date;
    campaign_id: string;
    audience_contact_id: string;
    channel: string;
    client_ref: string;
    template_variables: Record<string, unknown> | null;
    status: string;
    retry_count: number;
    variant_label: string | null;
    drip_step: number | null;
    drip_template_id: string | null;
  };
  contact: {
    id: string;
    phone: string | null;
    email: string | null;
    display_name: string | null;
    unsubscribed_at: Date | null;
    consent_status: string;
    meta: Record<string, unknown>;
  };
  template: {
    id: string;
    name: string;
    language: string;
    category: string;
    body_format: string;
    body: Record<string, unknown>;
    variables: string[];
  };
  campaign: {
    id: string;
    name: string;
    status: string;
    rate_limit_mps: number;
    template_variable_bindings: Record<string, unknown>;
    paused_at: Date | null;
    pause_reason: string | null;
    // Fase 4 item 3 — AI body personalization
    ai_personalization_enabled: boolean;
    ai_personalization_config: AiPersonalizationConfig | null;
  };
}

export interface AiPersonalizationConfig {
  prompt_template: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  context_fields?: string[];
}

interface JoinedRow {
  d_id: string;
  d_queued_at: Date;
  d_campaign_id: string;
  d_audience_contact_id: string;
  d_channel: string;
  d_client_ref: string;
  d_template_variables: Record<string, unknown> | null;
  d_status: string;
  d_retry_count: number;
  d_variant_label: string | null;
  d_drip_step: number | null;
  d_drip_template_id: string | null;
  c_id: string;
  c_phone: string | null;
  c_email: string | null;
  c_display_name: string | null;
  c_unsubscribed_at: Date | null;
  c_consent_status: string;
  c_meta: Record<string, unknown>;
  t_id: string;
  t_name: string;
  t_language: string;
  t_category: string;
  t_body_format: string;
  t_body: Record<string, unknown>;
  t_variables: string[];
  cm_id: string;
  cm_name: string;
  cm_status: string;
  cm_rate_limit_mps: number;
  cm_template_variable_bindings: Record<string, unknown>;
  cm_paused_at: Date | null;
  cm_pause_reason: string | null;
  cm_variant_a_template_id: string | null;
  cm_variant_b_template_id: string | null;
  cm_ai_enabled: boolean;
  cm_ai_config: AiPersonalizationConfig | null;
}

export async function resolveDeliveryContext(
  sql: SqlOrTx,
  deliveryId: number,
  queuedAt: Date,
): Promise<DeliveryContext | null> {
  // Note: template_id is resolved at the campaign level. For A/B variants the
  // delivery row carries variant_label and the campaign carries variant_*_template_id.
  // For F1.2.b we resolve the base template (campaign.template_id) and apply A/B
  // override below only if variant_label is set AND the campaign has a B template.
  const rows = await sql<JoinedRow[]>`
    SELECT
      d.id::bigint                       AS d_id,
      d.queued_at                        AS d_queued_at,
      d.campaign_id::text                AS d_campaign_id,
      d.audience_contact_id::text        AS d_audience_contact_id,
      d.channel                          AS d_channel,
      d.client_ref::text                 AS d_client_ref,
      d.template_variables               AS d_template_variables,
      d.status                           AS d_status,
      d.retry_count                      AS d_retry_count,
      d.variant_label                    AS d_variant_label,
      d.drip_step                        AS d_drip_step,
      d.drip_template_id::text           AS d_drip_template_id,
      ac.id::text                        AS c_id,
      ac.phone                           AS c_phone,
      ac.email::text                     AS c_email,
      ac.display_name                    AS c_display_name,
      ac.unsubscribed_at                 AS c_unsubscribed_at,
      ac.consent_status                  AS c_consent_status,
      COALESCE(ac.meta, '{}'::jsonb)     AS c_meta,
      t.id::text                         AS t_id,
      t.name                             AS t_name,
      t.language                         AS t_language,
      t.category                         AS t_category,
      t.body_format                      AS t_body_format,
      t.body                             AS t_body,
      COALESCE(t.variables, '{}')        AS t_variables,
      cm.id::text                        AS cm_id,
      cm.name                            AS cm_name,
      cm.status                          AS cm_status,
      cm.rate_limit_mps                  AS cm_rate_limit_mps,
      COALESCE(cm.template_variable_bindings, '{}'::jsonb)
                                         AS cm_template_variable_bindings,
      cm.paused_at                       AS cm_paused_at,
      cm.pause_reason                    AS cm_pause_reason,
      cm.variant_a_template_id::text     AS cm_variant_a_template_id,
      cm.variant_b_template_id::text     AS cm_variant_b_template_id,
      COALESCE(cm.ai_personalization_enabled, false)
                                         AS cm_ai_enabled,
      cm.ai_personalization_config       AS cm_ai_config
    FROM bot.campaign_deliveries d
    JOIN bot.audience_contacts ac ON ac.id = d.audience_contact_id
    JOIN bot.campaigns cm ON cm.id = d.campaign_id
    JOIN bot.message_templates t ON t.id = cm.template_id
    WHERE d.id = ${deliveryId}
      AND d.queued_at BETWEEN ${queuedAt}::timestamptz - INTERVAL '1 millisecond'
                          AND ${queuedAt}::timestamptz + INTERVAL '1 millisecond'
    LIMIT 1
  `;

  if (rows.length === 0 || !rows[0]) return null;
  const r = rows[0];

  // Template precedence (highest → lowest):
  //   1. drip_template_id      — Fase 4 item 5 PR5b-PR3. kind='drip' deliveries
  //                              carry the per-step template explicitly on the
  //                              row. Takes priority over A/B (A/B doesn't apply
  //                              to drip steps; each step picks its own template).
  //   2. variant_b_template_id — A/B override when delivery.variant_label='B'.
  //   3. variant_a_template_id — A/B override when delivery.variant_label='A'.
  //   4. campaign.template_id  — base template (already in t_id via JOIN).
  let templateIdToUse: string | null = null;
  if (r.d_drip_step !== null && r.d_drip_template_id) {
    templateIdToUse = r.d_drip_template_id;
  } else if (r.d_variant_label === 'B' && r.cm_variant_b_template_id) {
    templateIdToUse = r.cm_variant_b_template_id;
  } else if (r.d_variant_label === 'A' && r.cm_variant_a_template_id) {
    templateIdToUse = r.cm_variant_a_template_id;
  }

  let template = {
    id: r.t_id,
    name: r.t_name,
    language: r.t_language,
    category: r.t_category,
    body_format: r.t_body_format,
    body: r.t_body,
    variables: r.t_variables,
  };

  if (templateIdToUse && templateIdToUse !== r.t_id) {
    const variantRows = await sql<
      Array<{
        id: string;
        name: string;
        language: string;
        category: string;
        body_format: string;
        body: Record<string, unknown>;
        variables: string[];
      }>
    >`
      SELECT
        id::text       AS id,
        name           AS name,
        language       AS language,
        category       AS category,
        body_format    AS body_format,
        body           AS body,
        COALESCE(variables, '{}') AS variables
      FROM bot.message_templates
      WHERE id = ${templateIdToUse}
      LIMIT 1
    `;
    if (variantRows.length > 0 && variantRows[0]) {
      template = variantRows[0];
    }
  }

  return {
    delivery: {
      id: Number(r.d_id),
      queued_at: r.d_queued_at,
      campaign_id: r.d_campaign_id,
      audience_contact_id: r.d_audience_contact_id,
      channel: r.d_channel,
      client_ref: r.d_client_ref,
      template_variables: r.d_template_variables,
      status: r.d_status,
      retry_count: r.d_retry_count,
      variant_label: r.d_variant_label,
      drip_step: r.d_drip_step,
      drip_template_id: r.d_drip_template_id,
    },
    contact: {
      id: r.c_id,
      phone: r.c_phone,
      email: r.c_email,
      display_name: r.c_display_name,
      unsubscribed_at: r.c_unsubscribed_at,
      consent_status: r.c_consent_status,
      meta: r.c_meta,
    },
    template,
    campaign: {
      id: r.cm_id,
      name: r.cm_name,
      status: r.cm_status,
      rate_limit_mps: r.cm_rate_limit_mps,
      template_variable_bindings: r.cm_template_variable_bindings,
      paused_at: r.cm_paused_at,
      pause_reason: r.cm_pause_reason,
      ai_personalization_enabled: r.cm_ai_enabled,
      ai_personalization_config: r.cm_ai_config,
    },
  };
}

/**
 * Resolve template components for the Meta API given the template, contact,
 * and per-delivery variable overrides (template_variables jsonb column).
 *
 * If template.body has a `components` array already shaped for Meta, we use
 * that as base and substitute variable placeholders. Otherwise we return an
 * empty components array (Meta accepts that for templates with zero variables).
 *
 * Variable substitution precedence (highest → lowest):
 *   1. delivery.template_variables  (per-row overrides)
 *   2. campaign.template_variable_bindings  (campaign-level defaults, ADR-016)
 *   3. contact.meta  (audience attrs)
 *   4. derived fields (display_name, phone)
 *
 * Substitution syntax: ${var_name} or {{var_name}} in any string field of any
 * component. Both are common in n8n template configs.
 */
export function resolveTemplateComponents(
  template: DeliveryContext['template'],
  contact: DeliveryContext['contact'],
  deliveryVariables: Record<string, unknown> | null,
  campaignBindings: Record<string, unknown>,
): unknown[] {
  const componentsRaw = (template.body as { components?: unknown }).components;
  if (!Array.isArray(componentsRaw)) return [];

  const vars: Record<string, unknown> = {
    display_name: contact.display_name ?? '',
    phone: contact.phone ?? '',
    email: contact.email ?? '',
    ...(typeof contact.meta === 'object' && contact.meta ? contact.meta : {}),
    ...(typeof campaignBindings === 'object' && campaignBindings ? campaignBindings : {}),
    ...(typeof deliveryVariables === 'object' && deliveryVariables ? deliveryVariables : {}),
  };

  const interpolateString = (s: string): string =>
    s
      .replace(/\$\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ''))
      .replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => String(vars[k] ?? ''));

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return interpolateString(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };

  return componentsRaw.map(walk);
}
