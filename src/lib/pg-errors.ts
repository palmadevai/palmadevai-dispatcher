/**
 * Errores de Postgres que NO son fallas: el cliente no tiene esa feature.
 *
 * POR QUE EXISTE. Las tablas de la BUC y de campañas —`bot.personas`,
 * `bot.audience_contact_channels`, `bot.campaign_deliveries`— no existen en
 * todo cliente: las de campañas las crea esa feature, y la BUC —canónica de
 * `chat-bot` desde el refactor persona (F1, mig 169/175)— llega a cada
 * cliente recién con su nivelación. Un cliente que todavía no las tiene NO
 * las tiene, y eso es lo correcto. Pero el dispatcher las consultaba igual y
 * trataba su ausencia como una falla: un `logger.error` por CADA envío, y uno
 * cada 5 minutos desde el recovery worker, para decir algo que ya sabíamos y
 * que no se arregla desde el runtime.
 *
 * El ruido no es cosmético. Una alerta por nivel de log queda gritando para
 * siempre en esos clientes, y lo que grita todo el tiempo deja de leerse: el
 * día que la query falle DE VERDAD —permisos revocados, conexión caída, tabla
 * renombrada por una migración— ese error llega mezclado con el ruido conocido
 * y no se distingue. Bajar el nivel sin distinguir la causa sería peor todavía:
 * escondería también el fallo real.
 *
 * Por eso se discrimina por SQLSTATE y no por el texto del mensaje: `42P01` es
 * `undefined_table` y lo pone el motor, no nosotros. Cualquier otro error sigue
 * siendo un error y se loguea como siempre.
 *
 * Lo que NO cambia: el comportamiento de envío. Las tres guardas siguen
 * fallando ABIERTAS ante la tabla ausente, que es lo correcto —un cliente sin
 * BUC no tiene dónde registrar una baja, así que no hay opt-out que respetar—
 * y sigue siendo la misma decisión de siempre. Acá sólo cambia cómo se cuenta.
 */
import type { Logger } from './logger.js';

/** `42P01 undefined_table`: la relación no existe en esta base. */
export function isMissingRelation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '42P01'
  );
}

/**
 * Estado esperado, dicho UNA vez por proceso y por `key`.
 *
 * Una vez y no cada envío porque el dato es de configuración, no de runtime: no
 * cambia entre un mensaje y el siguiente. Si el cliente contrata `campaigns`,
 * la migración crea la tabla y el próximo boot deja de anunciarlo — no hace
 * falta invalidar nada.
 *
 * El Set es de proceso: en multi-réplica cada una lo dice una vez, que es
 * exactamente lo que se quiere (cada réplica reporta su propia realidad).
 */
const announced = new Set<string>();

export function announceOnce(logger: Logger, key: string, detail: Record<string, unknown>, msg: string): void {
  if (announced.has(key)) return;
  announced.add(key);
  logger.info(detail, msg);
}

/** Sólo para tests: el Set vive en el módulo y persiste entre casos. */
export function resetAnnouncedForTests(): void {
  announced.clear();
}
