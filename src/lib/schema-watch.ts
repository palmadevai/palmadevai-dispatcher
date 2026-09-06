/**
 * F9.6.b (plan WABA) — `/health` deja de mentir después de que la causa se
 * arregló.
 *
 * QUÉ PASÓ, que es lo que justifica el archivo. F9.6 sondea el esquema UNA VEZ
 * al boot, y esa decisión era buena por una razón que sigue valiendo: el dato es
 * de provisioning, no de runtime — no cambia entre un mensaje y el siguiente, y
 * sondearlo por request sería una query por request para algo que casi nunca se
 * mueve. Lo que faltaba es que ese «casi nunca» tiene un momento exacto: **cuando
 * corre una migración**. Medido en palmawebs el 2026-09-05: el container arrancó
 * a las 19:00 sin sustrato, la mig 230 llegó a las 19:25 por el GitOps, y
 * `/health` siguió diciendo `degraded` con `messaging: false` hasta que alguien
 * reinició el container a mano. El operador —y el ops-status— vieron rojo sobre
 * algo ya arreglado, que es como se entrena a ignorar los rojos.
 *
 * LA FORMA DEL ARREGLO, y por qué no es «sondear siempre». El watch existe SÓLO
 * mientras el proceso está degradado, que es el único estado desde el cual el
 * sondeo puede aprender algo. Apenas el sustrato aparece, el watch **se apaga
 * solo** y el proceso vuelve al sondeo único de F9.6. Un cliente sano no paga
 * ni una query.
 *
 * EL CASO QUE NO SE PUEDE ARREGLAR EN CALIENTE, dicho en vez de tapado. Si lo
 * que aparece después del arranque es el esquema de CAMPAÑAS, sus cuatro
 * workers ya no arrancan —eso sí necesita reinicio— así que el watch lo declara
 * con su propia razón. Cambiar un `degraded` que miente por un `healthy` que
 * miente sería el mismo error con mejor color. El reinicio automático de ese
 * caso es la otra mitad de F9.6.b y vive en el deploy (infra), no acá.
 */
import { probeSchemaState, decideBoot, type SchemaState } from './schema-probe.js';
import type { SqlClient } from './postgres.js';
import type { Logger } from 'pino';

/** Lo que `/health` necesita saber, siempre al día. */
export interface SchemaStatus {
  schema: SchemaState | null;
  degradedReasons: string[];
}

export const RESTART_PENDING =
  'el esquema de campañas apareció después del arranque: sus workers (stream, recovery, wakeup, ' +
  'webhooks CRM) arrancan en el próximo reinicio del dispatcher';

export interface SchemaWatchDeps {
  sql: SqlClient;
  logger: Logger;
  /** Lo sondeado al boot (F9.6). */
  initial: SchemaState;
  /** Si los workers de campañas arrancaron en este proceso. */
  campaignsWorkersStarted: boolean;
  /** Cada cuánto re-sondear mientras esté degradado. 0 = no re-sondear. */
  intervalMs: number;
}

export interface SchemaWatch {
  /** El estado de HOY — lo que `/health` tiene que responder. */
  current(): SchemaStatus;
  /** Corta el timer (shutdown, o cuando ya no hay nada que aprender). */
  stop(): void;
  /** Un ciclo, expuesto para poder testear sin timers. */
  probeOnce(): Promise<void>;
}

export function startSchemaWatch(deps: SchemaWatchDeps): SchemaWatch {
  let schema: SchemaState = deps.initial;
  let degradedReasons: string[] = decideBoot(deps.initial).degradedReasons;
  let timer: NodeJS.Timeout | null = null;

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const probeOnce = async (): Promise<void> => {
    let next: SchemaState;
    try {
      next = await probeSchemaState(deps.sql);
    } catch (err) {
      // La base no responde: no es una novedad sobre el ESQUEMA, y `/health` ya
      // lo va a decir por su propio ping. Se reintenta en el ciclo siguiente.
      deps.logger.debug({ err }, 'schema-watch: no se pudo re-sondear el esquema');
      return;
    }

    const decided = decideBoot(next);
    const reasons = [...decided.degradedReasons];
    if (next.campaigns && !deps.campaignsWorkersStarted) reasons.push(RESTART_PENDING);

    const recovered = degradedReasons.length > 0 && decided.degradedReasons.length === 0;
    schema = next;
    degradedReasons = reasons;

    if (recovered) {
      deps.logger.info(
        { schema: next, restart_pending: reasons.includes(RESTART_PENDING) },
        'schema-watch: el sustrato del servicio ya está — /health deja de estar degradado sin reiniciar',
      );
      // Nada más que aprender: lo que falte a partir de acá (los workers de
      // campañas) no lo arregla un sondeo, lo arregla un reinicio.
      stop();
    }
  };

  if (deps.intervalMs > 0 && degradedReasons.length > 0) {
    timer = setInterval(() => {
      void probeOnce();
    }, deps.intervalMs);
    // No sostiene el proceso vivo: es vigilancia, no trabajo.
    timer.unref?.();
  }

  return {
    current: () => ({ schema, degradedReasons }),
    stop,
    probeOnce,
  };
}
