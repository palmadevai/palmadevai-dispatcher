/**
 * El cutover del BYOK: mover `ownership` con evidencia (T7 / F3 del piso 1).
 *
 * Diseño: `infra/doc/analysis-secretos-en-reposo.md` §8 (F3) y
 * `infra/doc/plan-servicios-email.md` T7.
 *
 * F2 dejó la credencial del cliente guardada y **deliberadamente sin usar**: el
 * resolver sólo mira el ciphertext con `ownership='owned'`. Este módulo es lo
 * que mueve ese estado, y la regla que lo gobierna es una sola:
 *
 *   > **El flip no se marca hecho hasta que un mail real salió con la
 *   > credencial nueva.**
 *
 * POR QUÉ EL GATE ES UN ENVÍO Y NO UN CHEQUEO DE API
 *
 * Un `GET` que devuelve 200 prueba que la key autentica. No prueba que el
 * dominio del remitente esté verificado **en la cuenta del cliente**, que es
 * donde este cutover falla en la vida real: el selector DKIM de Resend es fijo,
 * así que un dominio no puede estar verificado en dos cuentas a la vez (T0.4).
 * El primer mail que se entera de eso no puede ser el reset de contraseña de
 * alguien que no puede entrar. Por eso el test de conexión (T7.3) es el filtro
 * barato y el envío real (T9.8.3) es el gate.
 *
 * POR QUÉ EL MAIL DE VERIFICACIÓN VA POR EL ADAPTER Y NO POR `/send`
 *
 * Porque el core no puede entregarle una credencial que el resolver todavía se
 * niega a dar —el estado es `pending_verification` justamente para eso— y
 * porque lo que el core agrega sobre este envío es tope y opt-out, de los que
 * la clase `auth` está exenta por diseño (T9.8.1). Lo que el core sí aporta y
 * acá se pierde es la fila en el ledger de deliveries; la evidencia queda en el
 * `message_id` del proveedor, guardado en `notes`.
 *
 * ORDEN DE LOS ESTADOS, Y POR QUÉ ESTE
 *
 *   managed ──(hay credencial + test OK)──▶ pending_verification
 *           ◀─────────(cualquier fallo)─── failed
 *   pending_verification ──(mail real OK)──▶ owned/ok          (resend)
 *   pending_verification ──(Evidencia B, confirm G2)──▶ owned/ok  (openai — ver confirmOpenAiCutover)
 *   owned ─────────────(T7.5, sin código)──▶ managed
 *
 * `pending_verification` se escribe **antes** de salir a la red, no después: si
 * el proceso se muere en el medio, el estado que queda dice «alguien empezó un
 * cutover y no terminó», que es diagnosticable. El orden inverso deja silencio.
 *
 * OPENAI (G1, byok §7.12): su evidencia es una completion real —no un mail— y
 * el flip NO se completa en este proceso: el consumidor runtime es el gateway
 * LiteLLM (env de su container), así que `pending_verification` es un estado
 * legítimo de DÍAS hasta que el gateway facture a la organización del cliente
 * (Evidencia B, G2). Ver `cutoverOpenAiG1`.
 */
import { loadProviderCredential, type CredentialDeps } from './provider-credentials.js';
import { sendEmail, verifyEmailCredential } from '../providers/email.js';
import { verifyMetaCredential } from '../providers/whatsapp-management.js';
import {
  realOpenAiCompletion,
  verifyOpenAiByokKey,
  gatewayOpenAiCompletion,
} from '../providers/openai-byok.js';
import type { CredentialCheck } from '../providers/types.js';
import { invalidateProviderCache, resolveDefaultFrom, type ProviderId } from '../lib/providers.js';

/**
 * Dónde va el cliente a arreglar lo suyo (T7.7).
 *
 * El error tiene que apuntar al panel de SU proveedor, no a un ticket nuestro:
 * la cuenta es del cliente y nosotros no podemos verificarle un dominio ni
 * emitirle un token. Cuando el catálogo crezca, esto se muda a
 * `config.providers`, que es donde vive el resto de lo que la card sabe de un
 * proveedor.
 */
const PROVIDER_PANEL: Record<string, string> = {
  resend: 'https://resend.com/domains',
  meta: 'https://business.facebook.com/settings/system-users',
  openai: 'https://platform.openai.com/api-keys',
};

/**
 * Verificador por proveedor (el TD que gateaba S1.1-por-UI): cada credencial se
 * prueba contra SU proveedor, con el vocabulario de su adapter.
 *
 * Antes había uno solo —el de Resend— para cualquier id: desde que S5.1 metió
 * `meta` y `openai` al piso 1, el botón «probar» respondía el 401 de Resend
 * sobre un token de Meta perfectamente bueno, y una rotación por la card no se
 * podía dar por validada.
 */
const CREDENTIAL_VERIFIERS: Record<string, (credential: string) => Promise<CredentialCheck>> = {
  resend: verifyEmailCredential,
  meta: verifyMetaCredential,
  // DIRECTO contra api.openai.com, NO el verificador del personalize: aquél
  // ejercita la base URL del cascade (con gateway, `http://litellm:4000/v1`,
  // donde la key del CLIENTE daría «inválida» siendo buena). Era el hallazgo
  // que G1 esquivó y G2 cierra — dos credenciales, dos verificadores.
  openai: verifyOpenAiByokKey,
};

export type CutoverFailureCode =
  | 'unknown_provider'
  | 'not_flippable'
  | 'check_unsupported'
  | 'cutover_unsupported'
  | 'no_credential'
  | 'no_master_key'
  | 'undecryptable'
  | 'credential_rejected'
  | 'no_sender'
  | 'no_verify_to'
  | 'send_failed';

export type CutoverResult =
  | { ok: true; ownership: 'owned'; message_id: string; verified_to: string }
  /**
   * El resultado del cutover de OpenAI en G1 (byok §7.12): la key del cliente
   * quedó VERIFICADA con un uso real, pero el flip a `owned` no se marca —
   * el gateway sigue con nuestra cuenta hasta la Evidencia B (G2). No es un
   * fallo: es el estado honesto, y dura días.
   */
  | {
      ok: true;
      ownership: 'pending_verification';
      evidence: { response_id: string; model: string; organization: string | null };
    }
  | { ok: false; code: Exclude<CutoverFailureCode, 'check_unsupported'>; message: string };

export type CheckResult =
  | { ok: true; detail: string }
  | {
      ok: false;
      code: Exclude<
        CutoverFailureCode,
        'no_sender' | 'no_verify_to' | 'send_failed' | 'cutover_unsupported'
      >;
      message: string;
    };

export type RevertResult =
  | { ok: true; ownership: 'managed'; was: string }
  | { ok: false; code: 'unknown_provider' | 'not_owned' | 'not_flippable'; message: string };

/**
 * Causas del `confirm` (G2). Separadas de `CutoverFailureCode` a propósito: el
 * confirm tiene fallos que el cutover no conoce (el gateway no cableado, el
 * smoke ruteado a otro proveedor, la organización que no coincide) y mezclarlos
 * degradaría los dos vocabularios.
 */
export type ConfirmFailureCode =
  | 'unknown_provider'
  | 'not_flippable'
  | 'confirm_unsupported'
  | 'already_owned'
  | 'no_credential'
  | 'no_master_key'
  | 'undecryptable'
  | 'credential_rejected'
  | 'no_gateway'
  | 'gateway_smoke_failed'
  | 'smoke_not_openai_upstream'
  | 'org_evidence_missing'
  | 'gateway_not_swapped';

export type ConfirmResult =
  | {
      ok: true;
      ownership: 'owned';
      organization: string;
      evidence: { direct_id: string; gateway_id: string; model: string };
    }
  | { ok: false; code: ConfirmFailureCode; message: string };

interface ProviderRow {
  id: string;
  name: string;
  ownership: string;
  ownership_flippable: boolean;
  status: string;
}

async function readProvider(deps: CredentialDeps, providerId: string): Promise<ProviderRow | null> {
  const rows = await deps.sql<ProviderRow[]>`
    SELECT id, name, ownership, ownership_flippable, status
      FROM config.v_client_providers
     WHERE id = ${providerId}
  `;
  return rows[0] ?? null;
}

interface StatePatch {
  ownership: string;
  status: 'pending' | 'pending_verification' | 'ok' | 'failed';
  statusDetail: string | null;
  changedFrom: string;
  changedBy: string | null;
  notes: string | null;
}

/**
 * Escribe el estado del cliente con su audit trail (T7.1, patrón
 * `bot.ai_node_config`: quién, cuándo, de qué a qué, sobre la propia fila).
 *
 * `INSERT … ON CONFLICT` y no `UPDATE`: sin fila, el proveedor se lee con el
 * default del catálogo, así que el primer cutover de un cliente **crea** la
 * fila. Un `UPDATE` afectaría 0 filas y devolvería éxito.
 */
async function writeState(
  deps: CredentialDeps,
  providerId: string,
  patch: StatePatch,
): Promise<void> {
  await deps.sql`
    INSERT INTO config.client_providers
      (provider_id, ownership, status, status_detail, last_checked_at,
       changed_by, changed_at, changed_from, notes)
    VALUES (${providerId}, ${patch.ownership}, ${patch.status}, ${patch.statusDetail}, now(),
            ${patch.changedBy}, now(), ${patch.changedFrom}, ${patch.notes})
    ON CONFLICT (provider_id) DO UPDATE
      SET ownership       = EXCLUDED.ownership,
          status          = EXCLUDED.status,
          status_detail   = EXCLUDED.status_detail,
          last_checked_at = EXCLUDED.last_checked_at,
          changed_by      = EXCLUDED.changed_by,
          changed_at      = EXCLUDED.changed_at,
          changed_from    = EXCLUDED.changed_from,
          notes           = EXCLUDED.notes
  `;
}

/**
 * Resultado de un chequeo, **sin tocar el audit**.
 *
 * Probar una credencial no es un cambio de titularidad, así que no puede pisar
 * `changed_by`/`changed_from`/`notes` — esos son del último cambio REAL, y son
 * lo único que después contesta «¿quién puso a este cliente en `owned`?».
 * Encontrado en el smoke de F3: un chequeo fallido dejaba `changed_by` en NULL.
 *
 * `INSERT … ON CONFLICT` porque la fila puede no existir (sin fila, el proveedor
 * se lee con el default del catálogo). En el `INSERT` el audit nace vacío, que
 * es correcto: no hubo ningún cambio de titularidad todavía.
 */
async function writeCheckOutcome(
  deps: CredentialDeps,
  providerId: string,
  ownership: string,
  statusDetail: string,
): Promise<void> {
  await deps.sql`
    INSERT INTO config.client_providers
      (provider_id, ownership, status, status_detail, last_checked_at)
    VALUES (${providerId}, ${ownership}, 'failed', ${statusDetail}, now())
    ON CONFLICT (provider_id) DO UPDATE
      SET status          = 'failed',
          status_detail   = ${statusDetail},
          last_checked_at = now()
  `;
}

/** El texto que ve el operador cuando el proveedor rechaza la credencial (T7.7). */
function rejectedDetail(row: ProviderRow, code: string, message: string): string {
  const panel = PROVIDER_PANEL[row.id];
  const where = panel ? `en tu panel de ${row.name} (${panel})` : `en tu panel de ${row.name}`;
  // Neutro entre proveedores: lo lee la card de Resend, la de Meta y la de
  // OpenAI. «El correo…» era verdad sólo para el primero.
  const stillOurs =
    row.ownership === 'owned'
      ? ''
      : ' Todo sigue saliendo con nuestra cuenta: esto no interrumpió ningún envío.';
  return `${row.name} rechazó la credencial (${code}: ${message}). Se arregla ${where}.${stillOurs}`;
}

/**
 * T7.3 — test de conexión, sin mandar nada y sin tocar el `ownership`.
 *
 * Lo usa la UI (F4) para el botón «probar» y lo usa el cutover como primer
 * filtro. Sí escribe `status`/`status_detail`: una credencial cargada que no
 * autentica es exactamente lo que la card tiene que mostrar, y el texto aclara
 * que el correo no se cortó.
 */
export async function checkProviderCredential(
  deps: CredentialDeps,
  providerId: string,
): Promise<CheckResult> {
  const row = await readProvider(deps, providerId);
  if (!row) {
    return { ok: false, code: 'unknown_provider', message: `proveedor '${providerId}' desconocido` };
  }

  const verify = CREDENTIAL_VERIFIERS[providerId];
  if (!verify) {
    // Fallar con la causa antes que «validar» contra el proveedor equivocado:
    // un ok de mentira acá es exactamente el TD que este dispatch cierra.
    return {
      ok: false,
      code: 'check_unsupported',
      message: `${row.name} todavía no tiene test de conexión propio`,
    };
  }

  const loaded = await loadProviderCredential(deps, providerId);
  if (!loaded.ok) {
    const code = loaded.code === 'absent' ? 'no_credential' : loaded.code;
    return { ok: false, code, message: loaded.message };
  }

  const check = await verify(loaded.credential);
  if (!check.ok) {
    const detail = rejectedDetail(row, check.error_code, check.error_message);
    await writeCheckOutcome(deps, providerId, row.ownership, detail);
    deps.logger.warn(
      { provider_id: providerId, error_code: check.error_code, http_status: check.http_status },
      'test de conexión: el proveedor rechazó la credencial del cliente',
    );
    return { ok: false, code: 'credential_rejected', message: detail };
  }

  // Un chequeo que sale bien tiene que LIMPIAR el fallo anterior. Sin esto, el
  // operador arregla la key, prueba, ve «ok» en la respuesta — y la card sigue
  // en rojo con el error viejo, que es peor que no haber mostrado nada.
  //
  // Update acotado y no el `writeState` de arriba: acá no hay transición de
  // titularidad que auditar, así que pisar `changed_by`/`changed_from` con los
  // de un botón de prueba borraría quién hizo el último cambio real.
  await deps.sql`
    UPDATE config.client_providers
       SET last_checked_at = now(),
           status_detail   = NULL,
           status          = CASE WHEN status = 'failed' THEN 'ok' ELSE status END
     WHERE provider_id = ${providerId}
  `;

  return { ok: true, detail: check.detail };
}

/**
 * T7.1 + T9.8.3 — el flip `managed → owned`, con el envío real como gate.
 *
 * `verifyTo` es una dirección real del cliente (la del admin): el mail que
 * prueba el cutover **es** un mail de verdad, no un ping. Si no llega, no hubo
 * cutover.
 */
export async function cutoverProviderToOwned(
  deps: CredentialDeps,
  providerId: string,
  opts: { verifyTo?: string; changedBy: string | null },
): Promise<CutoverResult> {
  const row = await readProvider(deps, providerId);
  if (!row) {
    return { ok: false, code: 'unknown_provider', message: `proveedor '${providerId}' desconocido` };
  }
  if (!row.ownership_flippable) {
    // El catálogo ya lo dice y el constraint `providers_owned_no_flip` lo fija:
    // un proveedor que nace del cliente no tiene a qué flipear.
    return {
      ok: false,
      code: 'not_flippable',
      message: `${row.name} no admite cambio de titularidad (ownership_flippable=false)`,
    };
  }

  // Cada proveedor con flip tiene SU evidencia (un «cutover» de OpenAI
  // verificado con un mail de Resend no prueba nada): Resend = un mail real
  // (T9.8.3); OpenAI = una completion real, y en G1 el flip queda a mitad de
  // camino A PROPÓSITO (byok §7.12 — la Evidencia B llega con G2).
  if (providerId === 'openai') {
    return cutoverOpenAiG1(deps, row, opts.changedBy);
  }
  if (providerId !== 'resend') {
    return {
      ok: false,
      code: 'cutover_unsupported',
      message:
        `el cambio de titularidad de ${row.name} todavía no tiene su prueba real cableada: ` +
        'hoy Resend completa el flip (mail de verificación) y OpenAI verifica la key (G1)',
    };
  }

  // `verify_to` es del gate de Resend: el mail que ALGUIEN tiene que leer. Se
  // valida acá y no en el schema del transporte porque OpenAI no lo usa — un
  // required global obligaría a inventar una casilla para una prueba que no
  // manda mails.
  if (!opts.verifyTo) {
    return {
      ok: false,
      code: 'no_verify_to',
      message:
        'el cutover de Resend necesita `verify_to`: su gate es un mail real que alguien lee',
    };
  }
  const verifyTo = opts.verifyTo;

  const loaded = await loadProviderCredential(deps, providerId);
  if (!loaded.ok) {
    const code = loaded.code === 'absent' ? 'no_credential' : loaded.code;
    return { ok: false, code, message: loaded.message };
  }

  // El remitente sale del branding del cliente. Sin remitente NO se manda —
  // el default es lo que dejó entrar el sandbox de Resend como remitente de
  // clientes reales (ver `resolveDefaultFrom`).
  const from = await resolveDefaultFrom();
  if (!from) {
    return {
      ok: false,
      code: 'no_sender',
      message:
        'no hay remitente cargado (`branding.email_from`): el cutover no puede probar un envío ' +
        'sin una dirección desde la cual mandarlo',
    };
  }

  // ── Estado intermedio, ANTES de salir a la red ───────────────────────────
  await writeState(deps, providerId, {
    ownership: row.ownership,
    status: 'pending_verification',
    statusDetail: 'credencial cargada, esperando la prueba de envío',
    changedFrom: row.ownership,
    changedBy: opts.changedBy,
    notes: 'cutover iniciado (T7.1)',
  });

  // ── Filtro barato (T7.3) ─────────────────────────────────────────────────
  const check = await verifyEmailCredential(loaded.credential);
  if (!check.ok) {
    const detail = rejectedDetail(row, check.error_code, check.error_message);
    await writeState(deps, providerId, {
      ownership: row.ownership,
      status: 'failed',
      statusDetail: detail,
      changedFrom: row.ownership,
      changedBy: opts.changedBy,
      notes: 'cutover abortado en el test de conexión',
    });
    return { ok: false, code: 'credential_rejected', message: detail };
  }

  // ── El gate: un mail real, con la credencial nueva (T9.8.3) ──────────────
  const sent = await sendEmail({
    from,
    to: verifyTo,
    subject: `Verificación de tu cuenta de ${row.name}`,
    html: verificationHtml(row.name, verifyTo),
    text: verificationText(row.name, verifyTo),
    biz_opaque_callback_data: `cutover-${providerId}`,
    // La credencial que se está probando, no la que entrega el resolver.
    api_key: loaded.credential,
  });

  if (!sent.ok || !sent.message_id) {
    const code = sent.error_code ?? 'send_failed';
    const detail = rejectedDetail(row, code, sent.error_message ?? 'el envío de prueba no salió');
    await writeState(deps, providerId, {
      ownership: row.ownership,
      status: 'failed',
      statusDetail: detail,
      changedFrom: row.ownership,
      changedBy: opts.changedBy,
      notes: 'cutover abortado en el envío de prueba',
    });
    deps.logger.warn(
      { provider_id: providerId, error_code: code, http_status: sent.http_status },
      'cutover: el envío de prueba con la credencial del cliente falló — sigue en managed',
    );
    return { ok: false, code: 'send_failed', message: detail };
  }

  // ── El flip, ya con evidencia ────────────────────────────────────────────
  await writeState(deps, providerId, {
    ownership: 'owned',
    status: 'ok',
    statusDetail: null,
    changedFrom: row.ownership,
    changedBy: opts.changedBy,
    notes: `verificado con un envío real a ${verifyTo} (message_id ${sent.message_id})`,
  });
  invalidateProviderCache('resend');

  deps.logger.info(
    { provider_id: providerId, message_id: sent.message_id, by: opts.changedBy },
    'cutover completado: el proveedor pasa a la cuenta del cliente (owned)',
  );

  return { ok: true, ownership: 'owned', message_id: sent.message_id, verified_to: verifyTo };
}

/**
 * G1 del cutover BYOK de OpenAI (byok §7.12) — la Evidencia A.
 *
 * A diferencia de Resend, acá el flip NO puede completarse en este proceso: el
 * consumidor runtime de la key es el gateway LiteLLM (env de su container,
 * GitOps), no el resolver del dispatcher. Marcar `owned` con la Evidencia A
 * sola dejaría la card diciendo «tu cuenta» mientras el tráfico factura a la
 * nuestra. Lo que G1 sí hace: probar la key con un USO real (una completion,
 * no un `GET /models` — eso no prueba permiso de completions, ni cuota, ni
 * acceso al modelo en SU proyecto), guardar la evidencia (id + organización
 * que facturó) y dejar el estado honesto en `pending_verification` — que para
 * OpenAI es un estado de DÍAS, no de segundos, hasta la Evidencia B (G2: una
 * completion por el gateway facturada por la organización del cliente).
 */
async function cutoverOpenAiG1(
  deps: CredentialDeps,
  row: ProviderRow,
  changedBy: string | null,
): Promise<CutoverResult> {
  const loaded = await loadProviderCredential(deps, row.id);
  if (!loaded.ok) {
    const code = loaded.code === 'absent' ? 'no_credential' : loaded.code;
    return { ok: false, code, message: loaded.message };
  }

  // ── Estado intermedio, ANTES de salir a la red (mismo criterio que Resend) ─
  await writeState(deps, row.id, {
    ownership: row.ownership,
    status: 'pending_verification',
    statusDetail: 'credencial cargada, esperando la prueba de uso real',
    changedFrom: row.ownership,
    changedBy,
    notes: 'cutover BYOK OpenAI iniciado (G1)',
  });

  // ── El gate de G1: una completion real contra la cuenta del cliente ───────
  // Filtro y evidencia en una sola llamada — el chequeo barato aparte no
  // agrega nada cuando la prueba real cuesta un token.
  const used = await realOpenAiCompletion(loaded.credential);
  if (!used.ok) {
    const detail = rejectedDetail(row, used.error_code, used.error_message);
    await writeState(deps, row.id, {
      ownership: row.ownership,
      status: 'failed',
      statusDetail: detail,
      changedFrom: row.ownership,
      changedBy,
      notes: 'cutover abortado en la prueba de uso real (G1)',
    });
    deps.logger.warn(
      { provider_id: row.id, error_code: used.error_code, http_status: used.http_status },
      'cutover OpenAI: la prueba de uso real con la credencial del cliente falló — sigue en managed',
    );
    return { ok: false, code: 'credential_rejected', message: detail };
  }

  // ── La key quedó verificada; el flip NO se marca ──────────────────────────
  await writeState(deps, row.id, {
    ownership: row.ownership,
    status: 'pending_verification',
    statusDetail:
      'Tu key quedó verificada con un uso real. El cambio de cuenta lo completa el equipo: ' +
      'el gateway de IA pasa a tu organización y esta card se marca «Tu cuenta» recién ' +
      'entonces. Mientras tanto todo sigue funcionando con nuestra cuenta.',
    changedFrom: row.ownership,
    changedBy,
    notes:
      `verificación BYOK OpenAI (G1): completion ${used.response_id} · modelo ${used.model}` +
      ` · organización ${used.organization ?? 'no informada'} — el flip a owned llega con la` +
      ' Evidencia B (G2, byok §7.12)',
  });

  deps.logger.info(
    {
      provider_id: row.id,
      response_id: used.response_id,
      model: used.model,
      organization: used.organization,
      by: changedBy,
    },
    'cutover OpenAI G1: key del cliente verificada con uso real — pending_verification hasta G2',
  );

  return {
    ok: true,
    ownership: 'pending_verification',
    evidence: {
      response_id: used.response_id,
      model: used.model,
      organization: used.organization,
    },
  };
}

/**
 * G2 del cutover BYOK de OpenAI (byok §7.12) — la Evidencia B, y con ella el
 * flip. Lo corre el OPERADOR después de aplicar el loop de siempre (BW →
 * `LITELLM_OPENAI_API_KEY` del `.env` → recreate del stack 45-litellm): esto
 * NO recablea el gateway — lo AUDITA. G2b es el estado final deliberado: el
 * spike de 2026-08-18 midió que el hot-swap por API de LiteLLM sólo existe
 * para modelos DB-managed (`STORE_MODEL_IN_DB`), y los nuestros son config
 * GitOps — operador-en-el-loop no es half-measure cuando el mecanismo de
 * config del gateway ES el `.env`.
 *
 * Dos evidencias, las dos frescas y en el mismo run:
 *
 *   A. una completion DIRECTA con la key del cliente → la organización que
 *      factura esa cuenta (no se confía en la evidencia guardada por G1: entre
 *      aquel click y este confirm pudieron pasar días y otra key);
 *   B. una completion POR EL GATEWAY (virtual key del personalize) → la
 *      organización que factura el upstream del gateway.
 *
 * B == A ⇒ el gateway factura al cliente ⇒ `owned`. Cualquier otra cosa deja
 * el estado donde estaba, con la causa en `status_detail` — nunca a mitad de
 * camino.
 *
 * 🪤 Cooldown: si el operador recreó con una key mala, la Evidencia B da 401 y
 * LiteLLM pone ese deployment en cooldown (~60 s, medido en el spike) — los
 * consumidores del alias lo sufren también. Por eso la Evidencia A corre ANTES:
 * una key que no completó A jamás llega a golpear el gateway.
 */
export async function confirmOpenAiCutover(
  deps: CredentialDeps,
  opts: { changedBy: string | null },
  providerId = 'openai',
): Promise<ConfirmResult> {
  if (providerId !== 'openai') {
    return {
      ok: false,
      code: 'confirm_unsupported',
      message:
        `'${providerId}' no tiene confirm: este paso existe para proveedores cuyo consumidor ` +
        'runtime es otro proceso (hoy: el gateway de IA, OpenAI)',
    };
  }
  const row = await readProvider(deps, providerId);
  if (!row) {
    return { ok: false, code: 'unknown_provider', message: `proveedor '${providerId}' desconocido` };
  }
  if (!row.ownership_flippable) {
    return {
      ok: false,
      code: 'not_flippable',
      message: `${row.name} no admite cambio de titularidad (ownership_flippable=false)`,
    };
  }
  if (row.ownership === 'owned') {
    return {
      ok: false,
      code: 'already_owned',
      message: `${row.name} ya está en 'owned': no hay cambio que completar`,
    };
  }

  const loaded = await loadProviderCredential(deps, providerId);
  if (!loaded.ok) {
    const code = loaded.code === 'absent' ? 'no_credential' : loaded.code;
    return { ok: false, code, message: loaded.message };
  }

  // ── Evidencia A, fresca ───────────────────────────────────────────────────
  const direct = await realOpenAiCompletion(loaded.credential);
  if (!direct.ok) {
    const detail = rejectedDetail(row, direct.error_code, direct.error_message);
    await writeState(deps, providerId, {
      ownership: row.ownership,
      status: 'failed',
      statusDetail: detail,
      changedFrom: row.ownership,
      changedBy: opts.changedBy,
      notes: 'confirm abortado: la key del cliente falló la prueba de uso directa (G2)',
    });
    deps.logger.warn(
      { provider_id: providerId, error_code: direct.error_code, http_status: direct.http_status },
      'confirm OpenAI: la key del cliente falló la completion directa — sin tocar el gateway',
    );
    return { ok: false, code: 'credential_rejected', message: detail };
  }
  if (!direct.organization) {
    // Sin la identidad de la cuenta no hay comparación posible, y flipear sin
    // comparar es exactamente lo que este gate existe para impedir.
    return {
      ok: false,
      code: 'org_evidence_missing',
      message:
        'la completion directa no trajo el header `openai-organization`: sin la identidad de la ' +
        'cuenta del cliente no hay contra qué comparar el gateway',
    };
  }

  // ── Evidencia B: el gateway, por la puerta de siempre ─────────────────────
  const viaGateway = await gatewayOpenAiCompletion();
  if (!viaGateway.ok) {
    if (viaGateway.error_code === 'no_gateway') {
      return { ok: false, code: 'no_gateway', message: viaGateway.error_message };
    }
    // Error transitorio o de infra: NO se escribe estado — el cliente no hizo
    // nada mal y su card no tiene por qué enterarse de un smoke fallido nuestro.
    deps.logger.warn(
      {
        provider_id: providerId,
        error_code: viaGateway.error_code,
        http_status: viaGateway.http_status,
      },
      'confirm OpenAI: la completion por el gateway falló — el estado queda como estaba',
    );
    return {
      ok: false,
      code: 'gateway_smoke_failed',
      message:
        `la prueba por el gateway falló (${viaGateway.error_code}: ${viaGateway.error_message}). ` +
        'Si el recreate fue reciente, puede ser el cooldown del deployment (~60 s) — reintentá',
    };
  }
  if (!viaGateway.api_base || !viaGateway.api_base.includes('api.openai.com')) {
    // Hallazgo G0: un alias puede rutear a OTRO proveedor (gpt-chico → DeepSeek
    // en el lab). Comparar organizaciones de dos proveedores distintos no
    // prueba nada — se corta con la causa y el fix nombrado.
    return {
      ok: false,
      code: 'smoke_not_openai_upstream',
      message:
        `el alias de prueba '${viaGateway.model}' rutea a ${viaGateway.api_base ?? 'un upstream desconocido'}, ` +
        'no a api.openai.com: apuntá OPENAI_CUTOVER_TEST_MODEL a un alias cuyo upstream sea OpenAI',
    };
  }
  if (!viaGateway.organization) {
    return {
      ok: false,
      code: 'org_evidence_missing',
      message:
        'el gateway no reenvió `llm_provider-openai-organization`: sin la identidad de la cuenta ' +
        'que facturó no hay evidencia B — verificá la versión de LiteLLM (G0.a la midió en 1.90.2)',
    };
  }

  // ── El veredicto ──────────────────────────────────────────────────────────
  if (viaGateway.organization !== direct.organization) {
    const detail =
      'Tu key está verificada, pero el gateway de IA todavía factura a otra organización ' +
      `('${viaGateway.organization}', no '${direct.organization}'): el equipo aún no aplicó ` +
      'el cambio de cuenta. Todo sigue funcionando con la cuenta administrada.';
    await writeState(deps, providerId, {
      ownership: row.ownership,
      status: 'pending_verification',
      statusDetail: detail,
      changedFrom: row.ownership,
      changedBy: opts.changedBy,
      notes:
        `confirm G2 sin flip: gateway factura a '${viaGateway.organization}' ≠ cliente ` +
        `'${direct.organization}' (directa ${direct.response_id} · gateway ${viaGateway.response_id})`,
    });
    deps.logger.warn(
      {
        provider_id: providerId,
        gateway_org: viaGateway.organization,
        client_org: direct.organization,
      },
      'confirm OpenAI: el gateway sigue facturando a otra organización — sin flip',
    );
    return {
      ok: false,
      code: 'gateway_not_swapped',
      message: detail,
    };
  }

  // ── El flip, con las dos evidencias ───────────────────────────────────────
  await writeState(deps, providerId, {
    ownership: 'owned',
    status: 'ok',
    statusDetail: null,
    changedFrom: row.ownership,
    changedBy: opts.changedBy,
    notes:
      `flip BYOK OpenAI (G2): el gateway factura a la organización del cliente ` +
      `'${direct.organization}' (directa ${direct.response_id} · gateway ${viaGateway.response_id} · ` +
      `modelo ${viaGateway.model})`,
  });
  invalidateProviderCache('openai');

  deps.logger.info(
    {
      provider_id: providerId,
      organization: direct.organization,
      direct_id: direct.response_id,
      gateway_id: viaGateway.response_id,
      by: opts.changedBy,
    },
    'confirm OpenAI completado: el gateway factura al cliente — owned',
  );

  return {
    ok: true,
    ownership: 'owned',
    organization: direct.organization,
    evidence: {
      direct_id: direct.response_id,
      gateway_id: viaGateway.response_id,
      model: viaGateway.model,
    },
  };
}

/**
 * T7.5 — el camino de vuelta, sin tocar código ni SQL a mano.
 *
 * **No borra el ciphertext.** Volver a `managed` es una decisión de ruteo: la
 * credencial del cliente queda guardada y sin usar (el resolver ya no la mira),
 * así que volver a `owned` es otro cutover y no una recarga. Borrarla es el
 * `DELETE` de F2, explícito y aparte — un rollback que además destruye el dato
 * convierte «probemos volver» en una operación irreversible.
 */
export async function revertProviderToManaged(
  deps: CredentialDeps,
  providerId: string,
  opts: { changedBy: string | null; reason?: string },
): Promise<RevertResult> {
  const row = await readProvider(deps, providerId);
  if (!row) {
    return { ok: false, code: 'unknown_provider', message: `proveedor '${providerId}' desconocido` };
  }
  if (!row.ownership_flippable) {
    // Meta y ARCA NACEN del cliente: no existe una «cuenta administrada» a la
    // cual volver. La UI ofrece el botón sobre cualquier card owned; la
    // autoridad es ésta — sin este guard, un click escribía `managed` sobre un
    // proveedor cuyo lado managed no existe.
    return {
      ok: false,
      code: 'not_flippable',
      message: `${row.name} nace del cliente: no hay cuenta administrada a la que volver`,
    };
  }
  if (row.ownership !== 'owned') {
    return {
      ok: false,
      code: 'not_owned',
      message: `${row.name} no está en 'owned' (está en '${row.ownership}'): no hay nada que revertir`,
    };
  }

  await writeState(deps, providerId, {
    ownership: 'managed',
    status: 'ok',
    statusDetail: null,
    changedFrom: 'owned',
    changedBy: opts.changedBy,
    notes: opts.reason?.trim() || 'vuelta a la cuenta administrada (T7.5)',
  });
  invalidateProviderCache(providerId as ProviderId);

  deps.logger.info(
    { provider_id: providerId, by: opts.changedBy, reason: opts.reason },
    'cutover revertido: el proveedor vuelve a la cuenta administrada (managed)',
  );

  return { ok: true, ownership: 'managed', was: 'owned' };
}

function verificationText(providerName: string, to: string): string {
  return [
    `Este mensaje salió con la cuenta de ${providerName} que cargaste.`,
    '',
    `Si lo estás leyendo en ${to}, la credencial funciona y el dominio del remitente está`,
    `verificado en tu cuenta. Con esto el cambio de titularidad queda confirmado y, desde ahora,`,
    `los mails de tu plataforma salen por tu cuenta de ${providerName}.`,
    '',
    'Si no esperabas este mensaje, avisale a tu administrador: alguien inició el cambio desde el panel.',
  ].join('\n');
}

function verificationHtml(providerName: string, to: string): string {
  return (
    `<p>Este mensaje salió con la cuenta de <strong>${providerName}</strong> que cargaste.</p>` +
    `<p>Si lo estás leyendo en ${to}, la credencial funciona y el dominio del remitente está ` +
    `verificado en tu cuenta. Con esto el cambio de titularidad queda confirmado y, desde ahora, ` +
    `los mails de tu plataforma salen por tu cuenta de ${providerName}.</p>` +
    `<p>Si no esperabas este mensaje, avisale a tu administrador: alguien inició el cambio desde ` +
    `el panel.</p>`
  );
}
