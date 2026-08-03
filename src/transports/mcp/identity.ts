/**
 * Identidad y scopes del Messaging MCP (F5/H5.2).
 *
 * Hasta F4 el MCP tenía una sola credencial read-only y una identidad de
 * servicio fija. F5 suma writes, y writes sin identidad no se auditan ni se
 * limitan: quién mandó el mensaje es parte de la guarda, no un detalle de log.
 *
 * Modelo v1 — **bearer → identidad → scopes**:
 *
 *   `MESSAGING_MCP_BEARER`       → `messaging-mcp`       scopes: read
 *   `MESSAGING_MCP_WRITE_BEARER` → `messaging-mcp-staff` scopes: read, manage, send
 *
 * Dos bearers distintos y no uno con más permisos: chat-site (el staff agent)
 * porta hoy el read-only, y un consumidor que sólo necesita leer nunca debería
 * tener en memoria la credencial que autoriza gastar plata (least privilege,
 * el mismo criterio con el que F4 separó `MESSAGING_MCP_BEARER` de
 * `DISPATCHER_SEND_BEARER`).
 *
 * Las tools se registran **por scope**: una conexión read-only no ve las Tier
 * 2/3 en su `tools/list`. Es mejor que devolver 403 — el agente no puede
 * intentar lo que no existe en su catálogo, así que no hay error que
 * malinterpretar ni tool que alucinar.
 *
 * H5.4 (exposición externa) reemplaza esta función por un resolver de JWT
 * per-usuario del cockpit IdP: mismo tipo `McpIdentity` de salida, mismos
 * call sites: cambia sólo cómo se resuelve, no qué se hace con el resultado.
 */

export type McpScope = 'read' | 'manage' | 'send';

export interface McpIdentity {
  /** Va a `bot.staff_audit.session_key` — quién ejecutó la tool. */
  id: string;
  /** Va a `bot.staff_audit.staff_role`. */
  role: string;
  scopes: ReadonlySet<McpScope>;
}

export interface McpBearers {
  /** `env.MESSAGING_MCP_BEARER` — read-only. */
  read: string | undefined;
  /** `env.MESSAGING_MCP_WRITE_BEARER` — read + management + send. */
  write: string | undefined;
}

export type IdentityResolution =
  | { kind: 'ok'; identity: McpIdentity }
  /** Ninguna credencial configurada → el MCP entero está apagado (fail-closed). */
  | { kind: 'disabled' }
  | { kind: 'unauthorized' };

const READ_ONLY_SCOPES: ReadonlySet<McpScope> = new Set<McpScope>(['read']);
const STAFF_SCOPES: ReadonlySet<McpScope> = new Set<McpScope>(['read', 'manage', 'send']);

/**
 * Resuelve el header `Authorization` a una identidad con scopes.
 *
 * Fail-closed en los dos sentidos: sin ningún bearer configurado el MCP
 * responde `disabled`; con bearer configurado, cualquier valor que no matchee
 * exacto es `unauthorized`. Nunca hay un camino que caiga en "identidad por
 * defecto con permisos".
 */
export function resolveIdentity(
  authHeader: string | undefined,
  bearers: McpBearers,
): IdentityResolution {
  if (!bearers.read && !bearers.write) return { kind: 'disabled' };
  if (!authHeader) return { kind: 'unauthorized' };

  // El bearer de writes se chequea primero: si alguien configuró el mismo
  // valor en las dos envs (mala idea, pero posible), la identidad resultante
  // es la de mayor privilegio de forma explícita y no por orden accidental.
  if (bearers.write && authHeader === `Bearer ${bearers.write}`) {
    return {
      kind: 'ok',
      identity: { id: 'messaging-mcp-staff', role: 'staff', scopes: STAFF_SCOPES },
    };
  }
  if (bearers.read && authHeader === `Bearer ${bearers.read}`) {
    return {
      kind: 'ok',
      identity: { id: 'messaging-mcp', role: 'service', scopes: READ_ONLY_SCOPES },
    };
  }
  return { kind: 'unauthorized' };
}
