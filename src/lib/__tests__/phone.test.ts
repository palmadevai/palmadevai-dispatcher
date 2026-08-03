import { describe, it, expect } from 'vitest';
import { toE164, normalizeAllowlist } from '../phone.js';

describe('toE164', () => {
  it('deja intacto un E.164 canónico', () => {
    expect(toE164('+5491145402018')).toBe('+5491145402018');
  });

  it('agrega el + que falta — el caso del incidente 2026-08-03', () => {
    // `bot.agents.phone_e164` guarda `+549…`; la allowlist se cargó como `549…`
    expect(toE164('5491145402018')).toBe('+5491145402018');
  });

  it('tolera separadores de presentación', () => {
    expect(toE164(' 549 11 4540-2018 ')).toBe('+5491145402018');
    expect(toE164('+54 (9) 11 4540.2018')).toBe('+5491145402018');
  });

  it('devuelve null para lo que no es un teléfono', () => {
    expect(toE164(null)).toBeNull();
    expect(toE164(undefined)).toBeNull();
    expect(toE164('')).toBeNull();
    expect(toE164('   ')).toBeNull();
    expect(toE164('no-soy-un-telefono')).toBeNull();
    expect(toE164('+54911454020189999')).toBeNull(); // > 15 dígitos
    expect(toE164('+1234567')).toBeNull(); // < 8 dígitos
  });

  it('no inventa país ni interpreta texto libre', () => {
    // Sin país no hay E.164 posible; adivinar sería peor que rechazar.
    expect(toE164('1145402018')).toBe('+1145402018'); // 10 dígitos: válido por forma
    expect(toE164('llamar al 11 4540 2018')).toBeNull();
  });
});

describe('normalizeAllowlist', () => {
  it('normaliza los válidos y separa los que no lo son', () => {
    const { allowed, invalid } = normalizeAllowlist([
      '5491145402018',
      '+5491122223333',
      'carlos@palmadev.ai',
    ]);
    expect(allowed).toEqual(['+5491145402018', '+5491122223333']);
    expect(invalid).toEqual(['carlos@palmadev.ai']);
  });

  it('un valor inválido no se cuela como autorizado', () => {
    const { allowed } = normalizeAllowlist(['no-es-un-numero']);
    expect(allowed).toEqual([]);
  });
});
