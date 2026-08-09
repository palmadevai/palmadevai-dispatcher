import { describe, it, expect } from 'vitest';
import {
  OutboundMessageSchema,
  ATTACHMENT_MAX_BYTES,
  base64Bytes,
} from '../schemas.js';

/** Un base64 válido que decodifica a exactamente `bytes` bytes. */
function b64OfSize(bytes: number): string {
  return Buffer.alloc(bytes, 0x41).toString('base64');
}

const mail = (over: Record<string, unknown> = {}) => ({
  channel: 'email',
  to: 'cliente@ejemplo.com',
  from: 'noreply@cliente.com',
  content: { type: 'mail', subject: 'Su comprobante', html: '<p>hola</p>', ...over },
  context: { feature: 'facturacion', client_ref: 'inv-1' },
});

describe('contrato de email v2 (T9.1)', () => {
  it('el subject es obligatorio — se acabó derivarlo de los primeros 60 caracteres', () => {
    const sinSubject = mail();
    delete (sinSubject.content as Record<string, unknown>).subject;
    expect(OutboundMessageSchema.safeParse(sinSubject).success).toBe(false);
  });

  it('un mail sin cuerpo no es un mail: exige html o text', () => {
    const r = OutboundMessageSchema.safeParse(mail({ html: undefined }));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toContain('html');
    }
    // Con sólo texto plano alcanza — no se exige HTML.
    expect(
      OutboundMessageSchema.safeParse(mail({ html: undefined, text: 'hola' })).success,
    ).toBe(true);
  });
});

describe('adjuntos — el límite de 500 KB (T9.1)', () => {
  it('la aritmética de base64 es la real, no una estimación', () => {
    // Es lo que decide si un comprobante entra o no: si esto se desfasa, el
    // límite deja de ser el que se decidió.
    for (const n of [1, 2, 3, 100, 170 * 1024]) {
      expect(base64Bytes(b64OfSize(n))).toBe(n);
    }
  });

  it('una factura real (~170 KB) entra cómoda', () => {
    const r = OutboundMessageSchema.safeParse(
      mail({
        attachments: [
          { filename: 'factura.pdf', content_base64: b64OfSize(170 * 1024), content_type: 'application/pdf' },
        ],
      }),
    );
    expect(r.success).toBe(true);
  });

  it('justo en el límite entra; un byte más, no', () => {
    const enElLimite = mail({
      attachments: [{ filename: 'a.pdf', content_base64: b64OfSize(ATTACHMENT_MAX_BYTES) }],
    });
    expect(OutboundMessageSchema.safeParse(enElLimite).success).toBe(true);

    const unByteMas = mail({
      attachments: [{ filename: 'a.pdf', content_base64: b64OfSize(ATTACHMENT_MAX_BYTES + 1) }],
    });
    expect(OutboundMessageSchema.safeParse(unByteMas).success).toBe(false);
  });

  it('el rechazo NOMBRA el archivo y el máximo — no es un 413 mudo', () => {
    // Todo el punto de validar acá en vez de dejar que lo corte el bodyLimit
    // de Fastify: un comprobante rechazado por tamaño tiene que decir qué pasó,
    // o se diagnostica como «el mail no salió».
    const r = OutboundMessageSchema.safeParse(
      mail({
        attachments: [
          { filename: 'comprobante.pdf', content_base64: b64OfSize(ATTACHMENT_MAX_BYTES + 5000) },
        ],
      }),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = JSON.stringify(r.error.issues);
      expect(msg).toContain('comprobante.pdf');
      expect(msg).toContain(String(ATTACHMENT_MAX_BYTES / 1024));
    }
  });
});

describe('categoría transaccional para el budget (T9.2)', () => {
  it('`kind: transactional` es parte del contrato, no un campo libre', () => {
    const r = OutboundMessageSchema.safeParse({
      ...mail(),
      context: { feature: 'facturacion', client_ref: 'inv-2', kind: 'transactional' },
    });
    expect(r.success).toBe(true);

    // Y un `kind` inventado no pasa: la categoría decide si algo esquiva el
    // tope, así que no puede depender de un string arbitrario del llamador.
    const inventado = OutboundMessageSchema.safeParse({
      ...mail(),
      context: { feature: 'facturacion', client_ref: 'inv-3', kind: 'fiscal' },
    });
    expect(inventado.success).toBe(false);
  });
});
