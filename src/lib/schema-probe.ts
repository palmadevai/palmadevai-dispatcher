/**
 * F9.6 (plan WABA) — el dispatcher arranca según lo CONTRATADO, no según lo
 * que supone.
 *
 * POR QUÉ EXISTE. El servicio corre en todo cliente con `chat-bot` (§6.1 del
 * análisis de messaging), pero su esquema llega por dos features distintas:
 *
 *   - el SUSTRATO del servicio (`bot.outbound_endpoints`, `bot.message_templates`)
 *     es de `messaging` (mig 230) y tiene que existir donde el dispatcher corra;
 *   - las tablas de CAMPAÑAS (`bot.campaigns`, `bot.campaign_deliveries`,
 *     `bot.crm_webhook_deliveries`) llegan sólo con `campaigns`, y los workers
 *     que las consumen —stream, recovery, wakeup, emisor de webhooks— no tienen
 *     nada que hacer sin ellas.
 *
 * Medido en palmawebs (2026-09-04): `messaging` sin `campaigns`. El wakeup
 * logueaba `scan failed` a nivel error en cada ciclo por una tabla que ese
 * cliente no contrató, y cuando faltaba el propio sustrato nadie lo decía —
 * `/health` estaba verde con el servicio a medias.
 *
 * Se sondea UNA vez al boot con `to_regclass` (no lanza si la relación no
 * existe) y se decide: los workers de campañas arrancan sólo con su esquema; el
 * sustrato ausente NO impide bootear (el envío por `/send` y los avisos siguen)
 * pero deja el proceso en `degraded` con la causa, que es lo que `/health` y el
 * ops-status tienen que ver. Si una migración llega después, el próximo boot
 * lo ve — el dato es de provisioning, no cambia entre un mensaje y el siguiente.
 */
import type { SqlClient } from './postgres.js';

export const MESSAGING_SUBSTRATE = ['bot.outbound_endpoints', 'bot.message_templates'] as const;
export const CAMPAIGNS_SCHEMA = [
  'bot.campaigns',
  'bot.campaign_deliveries',
  'bot.crm_webhook_deliveries',
] as const;

export interface SchemaState {
  /** El sustrato de messaging está completo. */
  messaging: boolean;
  /** El esquema de campañas está completo. */
  campaigns: boolean;
  /** Relaciones ausentes, con nombre — para el log y para /health. */
  missing: string[];
}

/** `to_regclass` por cada nombre, en UNA query. */
export async function probeRelations(
  sql: SqlClient,
  names: readonly string[],
): Promise<Record<string, boolean>> {
  const rows = await sql<Array<{ n: string; present: boolean }>>`
    SELECT n, to_regclass(n) IS NOT NULL AS present
    FROM unnest(${[...names]}::text[]) AS t(n)
  `;
  const out: Record<string, boolean> = {};
  for (const name of names) out[name] = false;
  for (const r of rows) out[r.n] = r.present;
  return out;
}

export async function probeSchemaState(sql: SqlClient): Promise<SchemaState> {
  const present = await probeRelations(sql, [...MESSAGING_SUBSTRATE, ...CAMPAIGNS_SCHEMA]);
  const missing = Object.entries(present)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return {
    messaging: MESSAGING_SUBSTRATE.every((n) => present[n]),
    campaigns: CAMPAIGNS_SCHEMA.every((n) => present[n]),
    missing,
  };
}

/**
 * La decisión, separada del boot para que se pueda testear sin Redis ni
 * Postgres: qué arranca y qué queda degradado dada la forma de la base.
 */
export function decideBoot(state: SchemaState): {
  campaignsWorkers: boolean;
  degradedReasons: string[];
} {
  const degradedReasons: string[] = [];
  if (!state.messaging) {
    const missing = state.missing.filter((n) => (MESSAGING_SUBSTRATE as readonly string[]).includes(n));
    degradedReasons.push(
      `sustrato de messaging ausente: ${missing.join(', ')} — falta la migración 230 (feature messaging) en este cliente`,
    );
  }
  return { campaignsWorkers: state.campaigns, degradedReasons };
}
