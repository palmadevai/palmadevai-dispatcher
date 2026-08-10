/**
 * Registra el resultado REAL del proveedor en `config.client_providers`
 * (T6.5, y el insumo de T4.3).
 *
 * POR QUÉ ACÁ Y POR QUÉ RECIÉN AHORA
 *
 * El schema (`status` / `status_detail` / `last_checked_at`, mig 142) y el
 * lector (la card de `/servicios`) existen desde T6. Lo que nunca existió es el
 * **escritor**: la columna quedó en `pending` desde el día que se creó, así que
 * la card no podía decir la verdad sobre el proveedor.
 *
 * No se implementó antes a propósito. Hasta T9.5 había **dos** caminos de envío
 * —el del cockpit y el de los seis workflows de n8n, que eran la mayoría del
 * volumen— y escribir el estado desde uno solo habría dado un dato **parcial y
 * engañoso**: la card diciendo «último envío OK» por un invite mientras los
 * workflows fallaban sin dejar rastro. Un estado que miente es peor que un
 * estado ausente. Con la migración terminada hay **un solo punto de escritura**,
 * y recién ahí el dato puede ser verdadero.
 *
 * QUÉ CUENTA COMO RESULTADO DEL PROVEEDOR (y qué no)
 *
 * Sólo lo que **llegó al proveedor y volvió**. Los rechazos de nuestras propias
 * guardas —opt-out, tope, allowlist de destino, ventana de 24 h— no dicen NADA
 * sobre la salud de la cuenta: meterlos acá volvería a poner un estado que
 * miente, con la card en rojo por un mensaje que decidimos no mandar.
 *
 * Un `resend_api_key_missing` **sí** cuenta: es exactamente «el proveedor no se
 * puede usar», que es lo que la card existe para mostrar.
 *
 * BEST-EFFORT, SIEMPRE
 *
 * Si el registro falla, el mail ya salió (o ya falló) y eso no se toca. Se
 * loguea y se sigue: un error escribiendo metadata no puede convertirse en un
 * envío perdido.
 */
import type { SqlClient } from '../lib/postgres.js';
import type { Logger } from '../lib/logger.js';

export type ProviderOutcome =
  | { ok: true }
  | { ok: false; error_code: string; error_message: string };

/** Canal → proveedor que lo ejecuta. Hoy sólo el email tiene card de servicio. */
const PROVIDER_BY_CHANNEL: Record<string, string | undefined> = {
  email: 'resend',
};

export function providerForChannel(channel: string): string | null {
  return PROVIDER_BY_CHANNEL[channel] ?? null;
}

/**
 * Deja el estado del proveedor igual a lo que acaba de pasar de verdad.
 *
 * `ON CONFLICT` y no `UPDATE` pelado: **sin fila no hay que fallar**. El
 * criterio de la mig 142 es que la ausencia de fila significa «default del
 * catálogo», no «no existe» — así que el primer envío de un cliente nuevo tiene
 * que poder crear la fila en vez de perderse.
 *
 * ⚠ Escribe SÓLO las columnas de estado. `ownership` y `key_ref` son del
 * cutover (T7) y las decide el operador; pisarlas desde el camino de envío
 * desharía un flip a `owned` con cada mail.
 */
export async function recordProviderOutcome(
  sql: SqlClient,
  logger: Logger,
  providerId: string,
  outcome: ProviderOutcome,
): Promise<void> {
  const status = outcome.ok ? 'ok' : 'failed';
  const detail = outcome.ok ? null : `${outcome.error_code}: ${outcome.error_message}`.slice(0, 500);

  try {
    await sql`
      INSERT INTO config.client_providers (provider_id, status, status_detail, last_checked_at)
      VALUES (${providerId}, ${status}, ${detail}, now())
      ON CONFLICT (provider_id) DO UPDATE
        SET status = EXCLUDED.status,
            status_detail = EXCLUDED.status_detail,
            last_checked_at = EXCLUDED.last_checked_at
    `;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, provider_id: providerId, status },
      'no se pudo registrar el estado del proveedor — el envío no se toca',
    );
  }
}
