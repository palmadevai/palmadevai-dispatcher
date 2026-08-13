/**
 * Fase 4 item 3 — AI body personalization.
 *
 * Sustituye `{{ai_generated}}` placeholders en `template_variable_bindings`
 * por texto generado por OpenAI. Cache agresiva por
 * (campaign_id, audience_contact_id, var_key, prompt_hash).
 *
 * Design canonical: palmadevai-apps:features/campaigns/doc/technical-fase4-ai-body.md
 *
 * Failure modes:
 *   - OpenAI key falta o LLM call falla → loguea warning, deja el binding
 *     como literal `{{ai_generated}}`. El send a Meta lo interpolaría con
 *     el string literal — operador ve "{{ai_generated}}" en el mensaje
 *     (señal visible de mal config, no silent failure de costo).
 *   - Cache write conflict (carrera entre 2 dispatchers para mismo
 *     prompt_hash) → ON CONFLICT DO NOTHING. El SELECT subsiguiente trae
 *     el body insertado por el otro proceso.
 */
import crypto from 'node:crypto';
import type { Sql } from 'postgres';
import { env } from '../env.js';
import { logger } from './logger.js';
import { resolveProviderKey } from './providers.js';
import type { AiPersonalizationConfig, DeliveryContext } from '../dispatch/audience-resolver.js';

const SENTINEL = '{{ai_generated}}';

interface OpenAiResponse {
  choices: Array<{ message: { content: string | null } }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// Pricing per 1M tokens (input, output) en centavos USD * 100 = 1/10000 USD.
// Fuente: openai.com/pricing as of 2026-05. Update when models change.
const MODEL_PRICING_CENTS_PER_MILLION: Record<string, { input: number; output: number }> = {
  'gpt-5.4-mini': { input: 1500, output: 6000 }, // $0.15/$0.60 per 1M
  'gpt-5.4': { input: 50000, output: 150000 }, // $5/$15 per 1M
  'gpt-4o-mini': { input: 1500, output: 6000 },
  'gpt-4o': { input: 50000, output: 150000 },
};

function computeCostCents(model: string, usage: OpenAiResponse['usage']): number {
  const p = MODEL_PRICING_CENTS_PER_MILLION[model];
  if (!p) return 0;
  return Math.ceil(((usage.prompt_tokens * p.input) + (usage.completion_tokens * p.output)) / 1_000_000);
}

function renderPrompt(
  template: string,
  contact: DeliveryContext['contact'],
  campaignTemplate: DeliveryContext['template'],
  varKey: string,
  contextFields: string[],
): string {
  const vars: Record<string, string> = {
    var_key: varKey,
    template_name: campaignTemplate.name,
    template_body: JSON.stringify(campaignTemplate.body),
  };
  for (const f of contextFields) {
    if (f === 'display_name') vars[f] = contact.display_name ?? '';
    else if (f === 'phone') vars[f] = contact.phone ?? '';
    else if (f === 'email') vars[f] = contact.email ?? '';
    else if (f === 'tags' && Array.isArray(contact.meta?.tags)) {
      vars[f] = (contact.meta.tags as string[]).join(', ');
    } else if (f === 'meta') {
      vars[f] = JSON.stringify(contact.meta ?? {});
    } else {
      const v = contact.meta?.[f];
      vars[f] = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
    }
  }
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => vars[k] ?? '');
}

async function callOpenAi(
  apiKey: string,
  baseUrl: string,
  prompt: string,
  model: string,
  temperature: number,
  maxTokens: number,
  timeoutMs: number,
): Promise<OpenAiResponse> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 300)}`);
    }
    return (await res.json()) as OpenAiResponse;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Resolve all `{{ai_generated}}` bindings against cache or via OpenAI call.
 * Returns a new bindings dict — does NOT mutate input.
 */
export async function resolveAiBindings(
  sql: Sql,
  bindings: Record<string, unknown>,
  campaign: DeliveryContext['campaign'],
  contact: DeliveryContext['contact'],
  template: DeliveryContext['template'],
): Promise<Record<string, unknown>> {
  if (!campaign.ai_personalization_enabled) return bindings;
  const config: AiPersonalizationConfig | null = campaign.ai_personalization_config;
  if (!config?.prompt_template) {
    logger.warn({ campaign_id: campaign.id }, 'ai_personalization_enabled=true but no prompt_template configured');
    return bindings;
  }

  // S5.1 (ADR-005): la key se resuelve por el piso 1 (vault→db→env) — el
  // fallback env es la misma var de siempre, cero cambio sin fila/vault.
  const keyRes = await resolveProviderKey('openai');
  if (!keyRes.ok) {
    logger.warn({ campaign_id: campaign.id, err: keyRes.error }, 'ai_personalization_enabled=true pero sin credencial — bindings sin personalizar');
    return bindings;
  }
  const apiKey = keyRes.apiKey;
  const baseUrl = env.OPENAI_BASE_URL__CAMPAIGNS__DISPATCHER__PERSONALIZE_OPENAI || 'https://api.openai.com/v1';

  const model = config.model ?? env.AI_PERSONALIZE_DEFAULT_MODEL;
  const temperature = config.temperature ?? env.AI_PERSONALIZE_DEFAULT_TEMPERATURE;
  const maxTokens = config.max_tokens ?? env.AI_PERSONALIZE_DEFAULT_MAX_TOKENS;
  const contextFields = config.context_fields ?? ['display_name', 'tags'];

  const out: Record<string, unknown> = { ...bindings };

  for (const [varKey, value] of Object.entries(bindings)) {
    if (value !== SENTINEL) continue;

    const prompt = renderPrompt(config.prompt_template, contact, template, varKey, contextFields);
    const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');

    // Cache check (current hash only — drift invalida)
    const cached = await sql<Array<{ body_text: string }>>`
      SELECT body_text
      FROM bot.ai_personalization_cache
      WHERE campaign_id = ${campaign.id}
        AND audience_contact_id = ${contact.id}
        AND var_key = ${varKey}
        AND prompt_hash = ${promptHash}
      LIMIT 1
    `;
    if (cached.length > 0 && cached[0]) {
      out[varKey] = cached[0].body_text;
      continue;
    }

    // LLM call
    try {
      const res = await callOpenAi(apiKey, baseUrl, prompt, model, temperature, maxTokens, env.AI_PERSONALIZE_TIMEOUT_MS);
      const bodyText = res.choices[0]?.message?.content?.trim();
      if (!bodyText) {
        logger.warn({ campaign_id: campaign.id, contact_id: contact.id, varKey }, 'OpenAI returned empty content');
        continue;
      }
      const costCents = computeCostCents(model, res.usage);

      // Cache insert (ON CONFLICT DO NOTHING — concurrent dispatchers OK)
      await sql`
        INSERT INTO bot.ai_personalization_cache
          (campaign_id, audience_contact_id, var_key, body_text,
           prompt_hash, model, tokens_used, cost_usd_cents)
        VALUES
          (${campaign.id}, ${contact.id}, ${varKey}, ${bodyText},
           ${promptHash}, ${model}, ${res.usage.total_tokens}, ${costCents})
        ON CONFLICT (campaign_id, audience_contact_id, var_key, prompt_hash) DO NOTHING
      `;

      out[varKey] = bodyText;
    } catch (err) {
      logger.warn(
        { campaign_id: campaign.id, contact_id: contact.id, varKey, err: err instanceof Error ? err.message : String(err) },
        'AI personalization LLM call failed — leaving sentinel as literal',
      );
      // Deja out[varKey] = SENTINEL → operador ve "{{ai_generated}}" en el msg
      // (signal visible, no silent fail).
    }
  }

  return out;
}
