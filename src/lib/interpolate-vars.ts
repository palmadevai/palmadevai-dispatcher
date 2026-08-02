/**
 * Shared `{{var}}` plain-text interpolation for channels whose template body
 * is `{ text: "Hola {{name}}", ... }` (FB Messenger / IG DM — `body_format=
 * 'plain_text'`). Extracted from the duplicated block that used to live in
 * both the facebook and instagram branches of `workers/dispatcher.ts`
 * (H1.1 ports & adapters refactor).
 *
 * Variable priority (highest → lowest, later entries override earlier ones):
 *   1. delivery.template_variables   (per-row overrides)
 *   2. aiResolvedBindings            (Fase 4 AI body)
 *   3. campaign.template_variable_bindings (campaign-wide defaults)
 *   4. contact.display_name → `name`
 *
 * Unknown placeholders are left literal (same policy as WA components / email body).
 */

export interface InterpolatePlainTextContext {
  contact: { display_name: string | null };
  campaign: { template_variable_bindings: Record<string, unknown> };
  delivery: { template_variables: Record<string, unknown> | null };
}

export function interpolatePlainText(
  rawText: string,
  ctx: InterpolatePlainTextContext,
  aiResolvedBindings: Record<string, unknown> | null,
): string {
  const vars: Record<string, string> = {};
  if (ctx.contact.display_name) vars.name = ctx.contact.display_name;
  for (const [k, v] of Object.entries(ctx.campaign.template_variable_bindings ?? {})) {
    if (v != null) vars[k] = String(v);
  }
  for (const [k, v] of Object.entries(aiResolvedBindings ?? {})) {
    if (v != null) vars[k] = String(v);
  }
  for (const [k, v] of Object.entries(ctx.delivery.template_variables ?? {})) {
    if (v != null) vars[k] = String(v);
  }
  return rawText.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, k: string) => vars[k] ?? m);
}
