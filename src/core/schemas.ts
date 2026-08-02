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
]);
export type OutboundContent = z.infer<typeof OutboundContentSchema>;

export const OutboundContextSchema = z.object({
  feature: z.string().min(1),
  client_ref: z.string().min(1),
  kind: z.enum(['notification', 'transactional']).optional(),
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
  content: OutboundContentSchema,
  context: OutboundContextSchema,
});
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>;
