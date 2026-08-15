/**
 * Template sync worker — the ONE recurring template mirror (F3/H3.1).
 *
 * Replaces the retired n8n `campaigns-template-sync` daily cron (06:00). The
 * service now owns the schedule: first run `INITIAL_DELAY_MS` after boot
 * (lets Redis/PG settle and gives fresh deploys immediate template state),
 * then every `DISPATCHER_TEMPLATE_SYNC_INTERVAL_MINUTES` (default 360 = 6h,
 * better rejected-template detection latency than the old daily cron; 0
 * disables the worker — on-demand `POST /management/templates/sync` remains).
 *
 * Auto-pause + operator email on rejected/disabled templates run inside
 * `core/management.ts syncTemplates()` — same behavior on cron and on-demand.
 *
 * STUB_MODE: skipped entirely (no Meta GETs, no DB writes) — same policy as
 * the other workers.
 */
import type { ManagementDeps } from '../core/management.js';
import { syncTemplates } from '../core/management.js';

const INITIAL_DELAY_MS = 90_000;

export interface TemplateSyncHandle {
  stop: () => void;
}

export function startTemplateSync(
  core: ManagementDeps,
  opts: { intervalMinutes: number; stubMode: boolean },
): TemplateSyncHandle {
  const { logger } = core;

  if (opts.stubMode) {
    logger.info('template-sync worker: STUB_MODE — not started');
    return { stop: () => undefined };
  }
  if (opts.intervalMinutes <= 0) {
    logger.info('template-sync worker: interval 0 — disabled (on-demand sync only)');
    return { stop: () => undefined };
  }
  // Guarda EN EL CANAL de `META_WA_WABA_ID` (ver el bloque en env.ts): sin WABA
  // id no hay contra qué sincronizar plantillas. Se sale con el motivo dicho, en
  // vez de tirar un error cada intervalo contra la Graph API con un id vacío.
  if (!core.wabaId) {
    logger.info(
      'template-sync worker: sin META_WA_WABA_ID — deshabilitado (canal WhatsApp sin configurar). ' +
        'El resto del dispatcher (campañas, email, management) sigue operativo.',
    );
    return { stop: () => undefined };
  }

  let running = false;
  const run = async (): Promise<void> => {
    if (running) {
      logger.warn('template-sync tick skipped — previous run still in progress');
      return;
    }
    running = true;
    try {
      await syncTemplates(core);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'template-sync run failed — next interval retries',
      );
    } finally {
      running = false;
    }
  };

  const initialTimer = setTimeout(() => {
    void run();
  }, INITIAL_DELAY_MS);
  const interval = setInterval(() => {
    void run();
  }, opts.intervalMinutes * 60_000);

  logger.info(
    { interval_minutes: opts.intervalMinutes, initial_delay_ms: INITIAL_DELAY_MS },
    'template-sync worker started',
  );

  return {
    stop: () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    },
  };
}
