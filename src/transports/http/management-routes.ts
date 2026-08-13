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
 *   GET    /management/providers/resend/domains    → core listResendDomains()
 *   PUT    /management/providers/:id/credential    → core storeProviderCredential()
 *   GET    /management/providers/:id/credential    → core getProviderCredentialInfo()
 *   DELETE /management/providers/:id/credential    → core deleteProviderCredential()
 *   POST   /management/providers/:id/credential/check → core checkProviderCredential()
 *   POST   /management/providers/:id/cutover       → core cutoverProviderToOwned()
 *   POST   /management/providers/:id/revert        → core revertProviderToManaged()
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
import {
  checkProviderCredential,
  cutoverProviderToOwned,
  revertProviderToManaged,
} from '../../core/provider-cutover.js';
import { listResendDomains, type DomainsDeps } from '../../core/provider-domains.js';

export interface ManagementRouteDeps {
  core: ManagementDeps;
  /** `env.DISPATCHER_SEND_BEARER`. Undefined → routes always 503 (fail-closed). */
  sendBearer: string | undefined;
  /** Custodio del piso 1 (F2). Sin esto, las rutas de credencial responden 503. */
  credentials?: CredentialDeps;
  /** Sólo tests: stubs del listado de dominios (S4.4). */
  domains?: DomainsDeps;
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

/**
 * `verify_to` no tiene default, y es deliberado.
 *
 * El gate del cutover es que **alguien lea el mail** (T9.8.3). Un default —el
 * `admin_email` del branding, por ejemplo— haría que el cutover se "verifique"
 * contra una casilla que quizá nadie mira, que es la forma elegante de tener un
 * gate que no gatea. Quien aprieta el botón elige a dónde llega la prueba.
 */
const CutoverBodySchema = z.object({
  verify_to: z.string().email('verify_to tiene que ser una dirección de mail'),
  changed_by: z.string().max(200).optional(),
});

const RevertBodySchema = z.object({
  changed_by: z.string().max(200).optional(),
  reason: z.string().max(500).optional(),
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
  // S4.4 / T6.2 (decisión c, infra#308): los dominios de Resend los sirve el
  // custodio de la key. Siempre 200 con el `DomainsResult` en el body — el
  // contrato (error ≠ lista vacía) viaja en `ok`/`reason`, y el cockpit lo
  // dibuja sin traducción. El auth es el preHandler de todo /management/*.
  app.get('/management/providers/resend/domains', async (_req, reply) => {
    const result = await listResendDomains(deps.domains);
    return reply.code(200).send(result);
  });

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

  // ── Cutover del BYOK (piso 1, F3 / T7) ────────────────────────────────────
  //
  // El `ownership` NO se puede setear por PUT: no hay ruta que lo escriba a
  // pedido. Se mueve por estas tres, que son las que traen la evidencia — un
  // endpoint que aceptara `{ownership: 'owned'}` volvería opcional el gate y el
  // gate es todo lo que hace seguro al cutover.

  app.post<{ Params: { id: string } }>(
    '/management/providers/:id/credential/check',
    async (request, reply) => {
      if (!deps.credentials) {
        return reply.code(503).send({ error: 'credential_store_disabled' });
      }
      const result = await checkProviderCredential(deps.credentials, request.params.id);
      if (!result.ok) {
        return reply.code(cutoverStatus(result.code)).send({ error: result.code, message: result.message });
      }
      return reply.code(200).send({ ok: true, detail: result.detail });
    },
  );

  app.post<{ Params: { id: string } }>('/management/providers/:id/cutover', async (request, reply) => {
    if (!deps.credentials) {
      return reply.code(503).send({ error: 'credential_store_disabled' });
    }
    const parsed = CutoverBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues.map((i) => i.message) });
    }
    const result = await cutoverProviderToOwned(deps.credentials, request.params.id, {
      verifyTo: parsed.data.verify_to,
      changedBy: parsed.data.changed_by ?? null,
    });
    if (!result.ok) {
      return reply.code(cutoverStatus(result.code)).send({ error: result.code, message: result.message });
    }
    return reply.code(200).send(result);
  });

  app.post<{ Params: { id: string } }>('/management/providers/:id/revert', async (request, reply) => {
    if (!deps.credentials) {
      return reply.code(503).send({ error: 'credential_store_disabled' });
    }
    const parsed = RevertBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues.map((i) => i.message) });
    }
    const result = await revertProviderToManaged(deps.credentials, request.params.id, {
      changedBy: parsed.data.changed_by ?? null,
      reason: parsed.data.reason,
    });
    if (!result.ok) {
      return reply
        .code(result.code === 'unknown_provider' ? 404 : 409)
        .send({ error: result.code, message: result.message });
    }
    return reply.code(200).send(result);
  });
}

/**
 * Mapeo de causa → status. La distinción que importa es **de quién es el
 * problema**: `409` es «falta un paso tuyo» (no cargaste la credencial, el
 * proveedor no flipea), `422` es «el proveedor rechazó lo que trajiste» y
 * `503` es «este cliente no tiene el piso 1 cableado», que es nuestro.
 */
function cutoverStatus(code: string): number {
  if (code === 'unknown_provider') return 404;
  if (code === 'no_master_key') return 503;
  if (code === 'not_flippable' || code === 'no_credential') return 409;
  return 422;
}
