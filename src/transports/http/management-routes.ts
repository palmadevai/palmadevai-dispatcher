/**
 * `/management/*` — F3 management plane transport (H3.1/H3.2).
 *
 * Routes (all internal docker network, same service bearer as POST /send —
 * fail-closed 503 when the bearer env is unset):
 *   POST   /management/templates/sync              → core syncTemplates()
 *   POST   /management/templates                   → core createWaTemplate()
 *   DELETE /management/templates/:id               → core deleteWaTemplate()
 *   POST   /management/endpoints/sync              → core syncEndpoints()
 *   POST   /management/endpoints/:id/quality-refresh → core refreshPhoneQuality()
 *
 * Transport rule (§3.4): zero business logic here — request shape → core
 * call → HTTP status mapping. Status codes mirror what the campaign-site
 * API routes historically returned for each operation, so the campaign-site
 * proxy (H3.3) keeps its UI contract byte-for-byte.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ManagementDeps } from '../../core/management.js';
import {
  syncTemplates,
  createWaTemplate,
  deleteWaTemplate,
  syncEndpoints,
  refreshPhoneQuality,
} from '../../core/management.js';

export interface ManagementRouteDeps {
  core: ManagementDeps;
  /** `env.DISPATCHER_SEND_BEARER`. Undefined → routes always 503 (fail-closed). */
  sendBearer: string | undefined;
}

const CreateTemplateBodySchema = z.object({
  name: z.string().min(1),
  language: z.string().min(1),
  category: z.string().min(1),
  body_text: z.string().min(1),
  body_example_values: z.array(z.string()).optional(),
  header_text: z.string().optional(),
  header_example_values: z.array(z.string()).optional(),
  footer_text: z.string().optional(),
});

export function registerManagementRoutes(app: FastifyInstance, deps: ManagementRouteDeps): void {
  // Shared auth pre-handler for the whole /management/* surface.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/management/')) return;
    if (!deps.sendBearer) {
      return reply.code(503).send({ error: 'management_disabled' });
    }
    if (req.headers['authorization'] !== `Bearer ${deps.sendBearer}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.post('/management/templates/sync', async (_req, reply) => {
    const result = await syncTemplates(deps.core);
    return reply.code(result.ok ? 200 : 500).send(result);
  });

  app.post('/management/templates', async (request, reply) => {
    const parsed = CreateTemplateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: 'body inválido', issues: parsed.error.issues });
    }
    const result = await createWaTemplate(deps.core, parsed.data);
    return reply.code(result.ok ? 200 : 400).send(result);
  });

  app.delete<{ Params: { id: string } }>('/management/templates/:id', async (request, reply) => {
    const result = await deleteWaTemplate(deps.core, request.params.id);
    if (!result.ok) {
      return reply.code(502).send({ error: result.error });
    }
    return reply.code(200).send({ deleted: result.deleted, meta_warning: result.meta_warning });
  });

  app.post('/management/endpoints/sync', async (_req, reply) => {
    const result = await syncEndpoints(deps.core);
    return reply.code(result.ok ? 200 : 500).send(result);
  });

  app.post<{ Params: { id: string } }>(
    '/management/endpoints/:id/quality-refresh',
    async (request, reply) => {
      const result = await refreshPhoneQuality(deps.core, request.params.id);
      return reply.code(result.ok ? 200 : 400).send(result);
    },
  );
}
