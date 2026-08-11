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
 *   pending_verification ──(mail real OK)──▶ owned/ok
 *   owned ─────────────(T7.5, sin código)──▶ managed
 *
 * `pending_verification` se escribe **antes** de salir a la red, no después: si
 * el proceso se muere en el medio, el estado que queda dice «alguien empezó un
 * cutover y no terminó», que es diagnosticable. El orden inverso deja silencio.
 */
import { loadProviderCredential, type CredentialDeps } from './provider-credentials.js';
import { sendEmail, verifyEmailCredential } from '../providers/email.js';
import { invalidateProviderCache, resolveDefaultFrom } from '../lib/providers.js';

/**
 * Dónde va el cliente a arreglar lo suyo (T7.7).
 *
 * El error tiene que apuntar al panel de SU proveedor, no a un ticket nuestro:
 * la cuenta es del cliente y nosotros no podemos verificarle un dominio. Es un
 * mapa chico a propósito — hoy el piso 1 estrena un solo proveedor. Cuando F6
 * traiga OpenAI, Meta y LiteLLM, esto se muda al catálogo (`config.providers`),
 * que es donde vive el resto de lo que la card sabe de un proveedor.
 */
const PROVIDER_PANEL: Record<string, string> = {
  resend: 'https://resend.com/domains',
};

export type CutoverFailureCode =
  | 'unknown_provider'
  | 'not_flippable'
  | 'no_credential'
  | 'no_master_key'
  | 'undecryptable'
  | 'credential_rejected'
  | 'no_sender'
  | 'send_failed';

export type CutoverResult =
  | { ok: true; ownership: 'owned'; message_id: string; verified_to: string }
  | { ok: false; code: CutoverFailureCode; message: string };

export type CheckResult =
  | { ok: true; detail: string }
  | { ok: false; code: Exclude<CutoverFailureCode, 'no_sender' | 'send_failed'>; message: string };

export type RevertResult =
  | { ok: true; ownership: 'managed'; was: string }
  | { ok: false; code: 'unknown_provider' | 'not_owned'; message: string };

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
  const stillOurs =
    row.ownership === 'owned'
      ? ''
      : ' El correo sigue saliendo con nuestra cuenta: esto no interrumpió ningún envío.';
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

  const loaded = await loadProviderCredential(deps, providerId);
  if (!loaded.ok) {
    const code = loaded.code === 'absent' ? 'no_credential' : loaded.code;
    return { ok: false, code, message: loaded.message };
  }

  const check = await verifyEmailCredential(loaded.credential);
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
  opts: { verifyTo: string; changedBy: string | null },
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
    to: opts.verifyTo,
    subject: `Verificación de tu cuenta de ${row.name}`,
    html: verificationHtml(row.name, opts.verifyTo),
    text: verificationText(row.name, opts.verifyTo),
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
    notes: `verificado con un envío real a ${opts.verifyTo} (message_id ${sent.message_id})`,
  });
  invalidateProviderCache('resend');

  deps.logger.info(
    { provider_id: providerId, message_id: sent.message_id, by: opts.changedBy },
    'cutover completado: el proveedor pasa a la cuenta del cliente (owned)',
  );

  return { ok: true, ownership: 'owned', message_id: sent.message_id, verified_to: opts.verifyTo };
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
  invalidateProviderCache('resend');

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
