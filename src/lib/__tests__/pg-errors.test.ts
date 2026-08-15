/**
 * La distinción que sostiene todo el arreglo: "la tabla no existe porque este
 * cliente no tiene la feature" NO es lo mismo que "la query falló".
 *
 * Si estos tests se caen, el síntoma en producción es uno de dos, y los dos son
 * malos: vuelve el `error` por cada envío en los clientes sin `campaigns`, o —
 * peor— un fallo real de base queda escondido detrás del mensaje tranquilizador.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Logger } from '../logger.js';
import { isMissingRelation, announceOnce, resetAnnouncedForTests } from '../pg-errors.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger & { info: ReturnType<typeof vi.fn> };
}

describe('isMissingRelation', () => {
  it('reconoce 42P01 (undefined_table)', () => {
    const err = Object.assign(new Error('relation "bot.audience_contacts" does not exist'), {
      code: '42P01',
    });
    expect(isMissingRelation(err)).toBe(true);
  });

  it('NO se traga otros errores de Postgres — un permiso revocado sigue siendo un error', () => {
    const permiso = Object.assign(new Error('permission denied for table audience_contacts'), {
      code: '42501',
    });
    const conexion = Object.assign(new Error('connection terminated'), { code: '08006' });
    expect(isMissingRelation(permiso)).toBe(false);
    expect(isMissingRelation(conexion)).toBe(false);
  });

  it('discrimina por SQLSTATE y no por el texto: mismo mensaje sin code no cuenta', () => {
    const sinCode = new Error('relation "bot.campaign_deliveries" does not exist');
    expect(isMissingRelation(sinCode)).toBe(false);
  });

  it('no explota con null, undefined ni con un string', () => {
    expect(isMissingRelation(null)).toBe(false);
    expect(isMissingRelation(undefined)).toBe(false);
    expect(isMissingRelation('42P01')).toBe(false);
  });
});

describe('announceOnce', () => {
  beforeEach(() => resetAnnouncedForTests());

  it('dice el estado UNA sola vez por key, aunque se lo llame en cada envío', () => {
    const logger = makeLogger();
    for (let i = 0; i < 50; i += 1) {
      announceOnce(logger, 'missing:audience_contacts:optout', { feature: 'reports' }, 'sin BUC');
    }
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('cada key se anuncia por separado: el opt-out y el safety-net son dos hechos distintos', () => {
    const logger = makeLogger();
    announceOnce(logger, 'missing:audience_contacts:optout', {}, 'a');
    announceOnce(logger, 'missing:campaign_deliveries:safety-net', {}, 'b');
    announceOnce(logger, 'missing:audience_contacts:optout', {}, 'a');
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it('anuncia en info, no en warn ni en error — es estado esperado, no degradación', () => {
    const logger = makeLogger();
    announceOnce(logger, 'k', {}, 'estado esperado');
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).not.toHaveBeenCalled();
    expect((logger as unknown as { error: ReturnType<typeof vi.fn> }).error).not.toHaveBeenCalled();
  });
});
