/**
 * `OutboundMessage` — zod schema, defined ONCE per
 * `apps/features/messaging/doc/analysis-messaging-service.md` §3.4 rule 2
 * ("schema único derivado"). `transports/http/send-route.ts` validates the
 * POST /send body against this; a future `transports/mcp/` (H4/F4) derives
 * its tool `inputSchema` from the same object via `zod-to-json-schema`. Do
 * NOT redefine this shape anywhere else — a field added here is a field
 * every transport gets automatically.
 *
 * v1 (H2.1) scope: whatsapp + email only (per doc §9 H2.1). facebook/instagram
 * land when their /send-equivalent payload shapes are defined.
 */
import { z } from 'zod';

export const OutboundChannelSchema = z.enum(['whatsapp', 'email']);
export type OutboundChannel = z.infer<typeof OutboundChannelSchema>;

/**
 * Adjunto de un mail (T9.1). **Vocabulario neutro, no de Resend** (R8): el
 * core dice `content_base64`; el adaptador del proveedor lo mapea a como se
 * llame allá. El precedente pagado es H1.2 — los nombres `meta_*` llegaron
 * hasta el clasificador de email y desenredarlo costó un rename cross-repo.
 */
export const ATTACHMENT_MAX_BYTES = 500 * 1024; // 👤 2026-08-09

/** `n` chars de base64 decodifican a ~`n * 3/4`, menos el padding `=`. */
export function base64Bytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export const OutboundAttachmentSchema = z
  .object({
    filename: z.string().min(1),
    content_base64: z.string().min(1),
    content_type: z.string().min(1).optional(),
  })
  // El límite se valida ACÁ y no se deja que lo corte el `bodyLimit` de
  // Fastify: ese camino devuelve un 413 genérico, y un comprobante fiscal
  // rechazado por tamaño se termina diagnosticando como «el mail no salió».
  // Medido: una factura de arca-svc pesa ~170 KB (~229 KB en base64), así que
  // 500 KB deja ~3× de margen y el payload sigue entrando en el bodyLimit de
  // 1 MB sin tocar el server.
  .refine((a) => base64Bytes(a.content_base64) <= ATTACHMENT_MAX_BYTES, (a) => ({
    message:
      `adjunto '${a.filename}' de ${Math.round(base64Bytes(a.content_base64) / 1024)} KB: ` +
      `el máximo es ${ATTACHMENT_MAX_BYTES / 1024} KB`,
  }));
export type OutboundAttachment = z.infer<typeof OutboundAttachmentSchema>;

export const OutboundContentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string().min(1),
  }),
  z.object({
    type: z.literal('template'),
    name: z.string().min(1),
    language: z.string().min(1),
    components: z.array(z.unknown()).optional(),
  }),
  /**
   * `mail` — el contenido rico de email (T9.1, `/send` v2).
   *
   * **`subject` es OBLIGATORIO, y ese es el punto.** v1 lo derivaba de los
   * primeros 60 caracteres del texto, o sea que el asunto de todo mail era el
   * arranque de su propio cuerpo. Como `/send` **todavía no tiene ningún
   * llamador de email** (verificado 2026-08-09), se puede exigir bien de
   * entrada en vez de arrastrar el default.
   */
  z.object({
    type: z.literal('mail'),
    subject: z.string().min(1),
    html: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    attachments: z.array(OutboundAttachmentSchema).max(10).optional(),
  }),
]);
export type OutboundContent = z.infer<typeof OutboundContentSchema>;

export const OutboundContextSchema = z.object({
  feature: z.string().min(1),
  client_ref: z.string().min(1),
  /**
   * Qué CLASE de mensaje es. No es una etiqueta: decide tres guardas distintas
   * (destino, opt-out, budget), y por eso cada valor existe por un motivo
   * propio y no por simetría.
   *
   *   `notification`  → destino restringido a staff · exento de opt-out
   *   `transactional` → sin restricción de destino · exento de opt-out ·
   *                     categoría propia: se cuenta, no bloquea (T9.2)
   *   `auth`          → invitación, primer acceso, reset de contraseña (T9.8).
   *                     Sin restricción de destino (va a quien se está dando
   *                     de alta), exento de opt-out y **exento de tope**.
   *
   * `auth` no es `transactional` con otro nombre. Comparten la forma —se cuenta,
   * no bloquea— pero no el motivo, y separarlas es lo que permite ver el gasto
   * de auth aparte: si un tope de US$5 dejara a alguien afuera de la plataforma,
   * el modo de falla no es "se gastó de más", es "nadie puede entrar".
   *
   * Ausente NO es exento: el default es chequear.
   */
  kind: z.enum(['notification', 'transactional', 'auth']).optional(),
  /**
   * `critical: true` is the ONLY budget bypass in the service, and only
   * takes effect when combined with `kind: 'notification'` — reserved for
   * `safety-trigger` (H2.3: "always-on por seguridad... exento de budget
   * pero nada más", doc §9 + §10 risks table). Any other combination is
   * ignored by the budget check (still enforced normally).
   */
  critical: z.boolean().optional(),
});
export type OutboundContext = z.infer<typeof OutboundContextSchema>;

export const OutboundMessageSchema = z.object({
  channel: OutboundChannelSchema,
  to: z.string().min(1),
  /**
   * Remitente (email). **Lo define la aplicación que llama, no este servicio**
   * (R9): el messaging service ejecuta el envío y aporta la credencial de la
   * cuenta; con qué dirección sale es decisión de negocio de quien llama —
   * `onboarding@` para acceso, `noreply@` para transaccional (T12).
   *
   * Opcional en el schema y exigido en el core sólo para `channel: 'email'`:
   * un `from` obligatorio a nivel schema rompería whatsapp, que no tiene.
   */
  from: z.string().min(1).optional(),
  content: OutboundContentSchema,
  context: OutboundContextSchema,
})
  // ⚠ Va acá y no adentro de la variante `mail` porque `discriminatedUnion`
  // de zod sólo acepta ZodObject: un `.refine()` en una rama la convierte en
  // ZodEffects y deja de compilar.
  //
  // Un mail sin cuerpo no es un mail. Se exige uno de los dos y no se inventa
  // el otro: derivar el HTML del texto es lo que producía
  // `<p>texto escapado</p>` como único cuerpo posible en v1.
  .refine(
    (m) => m.content.type !== 'mail' || Boolean(m.content.html || m.content.text),
    { message: 'el mail necesita `html` o `text` (o los dos)', path: ['content'] },
  );
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>;

/**
 * `POST /mark-read` — el tilde azul de un mensaje ENTRANTE de WhatsApp.
 *
 * No reusa `OutboundMessageSchema` a propósito: marcar leído no es un envío. No
 * tiene destinatario, ni contenido, ni presupuesto, ni ventana de 24 h, ni
 * idempotencia — pedirle un `to` y un `content` al llamador sería obligarlo a
 * inventar campos que nadie lee.
 *
 * `phone_number_id` es OPCIONAL: el default es el del cliente
 * (`META_WA_DEFAULT_PHONE_NUMBER_ID`), y sólo se manda explícito cuando el
 * mensaje entró por un número que no es el default (multi-WABA). Ésa es la
 * razón por la que este servicio es el dueño del número: el mark-as-read tiene
 * que usar el número por el que ENTRÓ el mensaje, y quien sabe eso es el
 * dispatcher, no una env copiada en n8n.
 */
export const MarkReadSchema = z.object({
  channel: z.literal('whatsapp'),
  message_id: z.string().min(1),
  phone_number_id: z.string().min(1).optional(),
});
export type MarkRead = z.infer<typeof MarkReadSchema>;

/**
 * `POST /notify` — un aviso declarado (F7.5).
 *
 * Lo que NO tiene es el punto: no hay `to`, no hay `from`, no hay `client_ref`
 * y no hay `channel`. Los cuatro los resuelve el servicio, y son exactamente
 * los cuatro campos donde cada copia de la mecánica se equivocó de una forma
 * distinta. Un emisor no puede elegir mal algo que no puede escribir.
 *
 * `feature` + `aviso` no son etiquetas: el par tiene que existir en la
 * declaración `notify_to:` del manifest de la feature (`config.features.bom`) o
 * el pedido se rechaza con 422. La declaración deja de ser documentación.
 */
export const NotifyRequestSchema = z
  .object({
    feature: z.string().min(1),
    aviso: z.string().min(1),
    subject: z.string().min(1),
    text: z.string().min(1).optional(),
    html: z.string().min(1).optional(),
    critical: z.boolean().optional(),
    /** Ref del EVENTO (mes, campaña, id del hecho). Sin destinatario. */
    origin_ref: z.string().min(1).optional(),
  })
  .refine((r) => Boolean(r.text || r.html), {
    message: 'el aviso necesita `text` o `html` (o los dos)',
    path: ['text'],
  });
export type NotifyRequestBody = z.infer<typeof NotifyRequestSchema>;
