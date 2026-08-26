/**
 * Destinatarios y remitente de los avisos de destinatario FIJO que emite este
 * servicio (R1c / T4.5 del plan `infra/doc/plan-servicios-email.md`).
 *
 * El dispatcher tiene DOS emisores propios —el auto-pause de templates
 * (`core/management.ts`) y el de calidad degradada del DLQ (`workers/dlq.ts`)—
 * y los dos leían `bot.config['branding'].admin_email` directo, cada uno con su
 * propia query. Son dos de los ocho consumidores que §1.1 del análisis
 * inventarió: cambiar esa dirección cambiaba ocho cosas no relacionadas de una
 * sola vez, y no había forma de mandarle el aviso de calidad al que opera las
 * campañas y el de costos al que paga.
 *
 * La cadena está escrita UNA vez, en SQL (`bot.notify_to`, mig
 * `_platform/158`): `notify_to[feature] → branding.admin_email → {}`. Este
 * módulo no la reimplementa, la llama.
 *
 * **El remitente viaja junto y no tiene fallback.** Los dos emisores lo tenían
 * mal de formas distintas —uno con el sandbox de Resend hardcodeado, el otro
 * con una env— y el criterio del plan es el mismo desde T8.1: sin
 * `branding.email_from` no se manda. Un remitente equivocado entrega al lugar
 * equivocado con un `200` limpio, que es peor que no avisar.
 */
import type { SqlClient } from '../lib/postgres.js';
import type { Logger } from '../lib/logger.js';

export interface NotifyTarget {
  /** Destinatarios ya resueltos. Vacío = NO enviar (aviso apagado o sin cargar). */
  to: string[];
  /** `bot.config['branding'].email_from`. Vacío = NO enviar. */
  from: string;
  /**
   * `bot.config['branding'].name` — el nombre visible del remitente.
   *
   * Viaja con el remitente y no es cosmética: los dos emisores firmaban
   * «Alertas PalmaDev», un literal del LABORATORIO, así que en cada fork los
   * avisos de ops del cliente salían firmados con el nombre de otra empresa
   * desde su propio dominio. Es la misma clase de contaminación de template que
   * el `onboarding@resend.dev` hardcodeado, sólo que en el nombre en vez de en
   * la dirección. Vacío = se manda con la dirección pelada, que es correcto.
   */
  fromName: string;
}

/** Postgres: la función no existe todavía en esta base. */
const UNDEFINED_FUNCTION = '42883';

function isUndefinedFunction(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === UNDEFINED_FUNCTION
  );
}

/**
 * Resuelve a quién y desde dónde mandar el aviso de una feature.
 *
 * ⚠ El fallback cuando la función NO EXISTE no es defensa decorativa: las
 * migraciones de `apps` y la imagen de este servicio aterrizan por caminos
 * distintos y sin gate entre ellos, así que hay una ventana real en la que este
 * código corre contra una base sin la 158. Sin el catch, esa ventana apaga los
 * dos avisos — un problema de datos disfrazado de bug de código, que es
 * exactamente lo que T5.6 puso el fallback para evitar.
 *
 * Best-effort en el sentido correcto: si algo falla devuelve un target vacío y
 * el llamador **no manda**, pero nunca tira. Estos avisos cuelgan de un
 * auto-pause que ya ocurrió; que falle el mail no puede deshacerlo.
 */
export async function resolveNotifyTarget(
  sql: SqlClient,
  logger: Logger,
  feature: string,
): Promise<NotifyTarget> {
  const { from, fromName } = await resolveSender(sql, logger);
  try {
    const rows = await sql<Array<{ to: string[] | null }>>`
      SELECT bot.notify_to(${feature}) AS to
    `;
    return { to: rows[0]?.to ?? [], from, fromName };
  } catch (err) {
    if (isUndefinedFunction(err)) {
      logger.warn(
        { feature },
        'bot.notify_to() no existe todavía (mig _platform/158 sin aplicar) — cayendo a branding.admin_email',
      );
      return { to: await resolveAdminEmail(sql, logger), from, fromName };
    }
    logger.warn(
      { err: (err as Error).message, feature },
      'notify_to lookup failed — el aviso no se envía',
    );
    return { to: [], from, fromName };
  }
}

/** Dirección + nombre visible, en UNA vuelta: los dos salen de la misma fila. */
async function resolveSender(
  sql: SqlClient,
  logger: Logger,
): Promise<{ from: string; fromName: string }> {
  try {
    const rows = await sql<Array<{ email_from: string | null; name: string | null }>>`
      SELECT btrim(COALESCE(value->>'email_from', '')) AS email_from,
             btrim(COALESCE(value->>'name', ''))       AS name
      FROM bot.config WHERE key = 'branding'
    `;
    return { from: rows[0]?.email_from ?? '', fromName: rows[0]?.name ?? '' };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'branding.email_from lookup failed',
    );
    return { from: '', fromName: '' };
  }
}

async function resolveAdminEmail(
  sql: SqlClient,
  logger: Logger,
): Promise<string[]> {
  try {
    const rows = await sql<Array<{ admin_email: string | null }>>`
      SELECT btrim(COALESCE(value->>'admin_email', '')) AS admin_email
      FROM bot.config WHERE key = 'branding'
    `;
    const v = rows[0]?.admin_email ?? '';
    return v ? [v] : [];
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'branding.admin_email lookup failed',
    );
    return [];
  }
}

/**
 * ¿Hay con qué mandar? Deja el motivo exacto para el log del llamador — «no se
 * envió» sin causa es lo que obliga a abrir la base para entender por qué.
 */
export function notifyBlockedReason(target: NotifyTarget): string | null {
  if (!target.from) return 'bot.config[branding].email_from sin cargar';
  if (target.to.length === 0)
    return 'sin destinatarios (notify_to vacío y branding.admin_email sin cargar)';
  return null;
}
