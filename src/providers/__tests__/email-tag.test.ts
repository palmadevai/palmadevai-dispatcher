import { describe, it, expect } from 'vitest';
import { toResendTagValue } from '../email.js';

// ── El `client_ref` como tag de Resend ──────────────────────────────────────
//
// Resend acepta sólo `[A-Za-z0-9_-]` en el valor de un tag y, si algo no encaja,
// rechaza **el mail entero** con `422 validation_error`. Estos casos existen
// por un incidente medido, no imaginado (2026-08-10, smoke de T9.8): los cuatro
// emisores del cockpit usan `:` como separador de namespace y por eso **ninguno
// de sus mails salía** — incluidos los comprobantes, ya en producción.
//
// Lo que se fija acá es que la restricción del proveedor se resuelva EN EL
// ADAPTADOR. Si esto viviera del lado del llamador, cada app que manda un mail
// tendría que conocer el charset de tags de un proveedor que —por diseño— no
// debería ni saber que existe.

describe('toResendTagValue', () => {
  it('el ref real que rompió en producción pasa a ser un tag válido', () => {
    const out = toResendTagValue('cockpit:invoice:00001-00000042:9f1c-4d2b');
    expect(out).toBe('cockpit-invoice-00001-00000042-9f1c-4d2b');
    expect(out).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('deja intacto lo que ya era válido', () => {
    // Los seis workflows de n8n usan esta forma, y por eso NO fallaban: el bug
    // se leía como "el cockpit no manda" en vez de "el tag es inválido".
    expect(toResendTagValue('cost-basis-592674')).toBe('cost-basis-592674');
  });

  it('cualquier cosa rara queda dentro del charset', () => {
    for (const raw of ['a b', 'ñandú', 'a@b.com', 'x/y\\z', '💥', 'a+b=c']) {
      expect(toResendTagValue(raw)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('nunca devuelve vacío: un ref exótico no puede llevarse puesto el mail', () => {
    // El schema ya exige `client_ref` no vacío, pero un ref hecho sólo de
    // caracteres inválidos colapsaría a "" y Resend también rechaza eso.
    expect(toResendTagValue('💥💥')).not.toBe('');
    expect(toResendTagValue('::::')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('un tag es metadato: sanea, no rechaza', () => {
    // La alternativa era tirar error ante un ref inválido. Costaría el envío
    // por un dato de tracking — exactamente el trade-off que este fix invierte.
    expect(() => toResendTagValue('cockpit:invite:abc')).not.toThrow();
  });
});
