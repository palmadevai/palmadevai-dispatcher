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
 *   PUT    /management/providers/:id/credential    → core storeProviderCredential()
 *   GET    /management/providers/:id/credential    → core getProviderCredentialInfo()
 *   DELETE /management/providers/:id/credential    → core deleteProviderCredential()
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
import {
  storeProviderCredential,
  getProviderCredentialInfo,
  deleteProviderCredential,
  type CredentialDeps,
} from '../../core/provider-credentials.js';

export interface ManagementRouteDeps {
  core: ManagementDeps;
  /** `env.DISPATCHER_SEND_BEARER`. Undefined → routes always 503 (fail-closed). */
  sendBearer: string | undefined;
  /** Custodio del piso 1 (F2). Sin esto, las rutas de credencial responden 503. */
  credentials?: CredentialDeps;
}

/**
 * Credencial que el cliente trae (BYOK, piso 1).
 *
 * El máximo es generoso a propósito: `credential_kind` incluye `cert_key_pem`
 * (ARCA), y un par cert+clave no entra en los límites que alcanzan para un
 * token. 16 KB cubre eso y sigue muy por debajo del `bodyLimit` de 1 MB.
 *
 * `created_by` es el AUDIT: quién la cargó. Va del lado del llamador porque el
 * dispatcher no tiene identidad de usuario — el cockpit sí, y es quien sabe
 * qué persona apretó el botón.
 */
const CredentialBodySchema = z.object({
  credential: z.string().min(1, 'credential vacía').max(16_384, 'credential demasiado larga'),
  created_by: z.string().max(200).optional(),
});

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

  // ── Custodio de credenciales del cliente (piso 1, F2) ─────────────────────
  //
  // ⚠️ El `PUT` recibe el secreto EN CLARO por la red interna de Docker. Es el
  // mismo canal por el que ya viaja el cuerpo de los mails en `/send`, y es
  // aceptable mientras los stacks compartan host; el día que se repartan entre
  // máquinas, este canal necesita TLS (ADR-003).
  //
  // NO hay ruta que DEVUELVA el secreto, y no es un olvido: es un campo
  // write-only. Un endpoint que lo devuelve es un endpoint que alguien loguea.

  app.put<{ Params: { id: string } }>('/management/providers/:id/credential', async (request, reply) => {
    if (!deps.credentials) {
      return reply.code(503).send({ error: 'credential_store_disabled' });
    }
    const parsed = CredentialBodySchema.safeParse(request.body);
    if (!parsed.success) {
      // Las `issues` de zod incluyen el path, no el valor — pero se filtran de
      // todas formas: nada del cuerpo de esta ruta puede volver al llamador.
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues.map((i) => i.message) });
    }
    const result = await storeProviderCredential(
      deps.credentials,
      request.params.id,
      parsed.data.credential,
      parsed.data.created_by ?? null,
    );
    if (!result.ok) {
      const code = result.code === 'unknown_provider' ? 404 : result.code === 'no_master_key' ? 503 : 400;
      return reply.code(code).send({ error: result.code, message: result.message });
    }
    return reply.code(200).send({ stored: true, last4: result.last4, key_version: result.key_version });
  });

  app.get<{ Params: { id: string } }>('/management/providers/:id/credential', async (request, reply) => {
    if (!deps.credentials) {
      return reply.code(503).send({ error: 'credential_store_disabled' });
    }
    const info = await getProviderCredentialInfo(deps.credentials, request.params.id);
    return reply.code(200).send(info);
  });

  app.delete<{ Params: { id: string } }>(
    '/management/providers/:id/credential',
    async (request, reply) => {
      if (!deps.credentials) {
        return reply.code(503).send({ error: 'credential_store_disabled' });
      }
      const result = await deleteProviderCredential(deps.credentials, request.params.id);
      // 200 también cuando no había nada: borrar dos veces no es un error, y un
      // 404 acá obligaría al llamador a distinguir dos casos que le dan igual.
      return reply.code(200).send(result);
    },
  );
}
