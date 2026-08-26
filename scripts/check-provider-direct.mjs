#!/usr/bin/env node
/**
 * check-provider-direct.mjs — guard «nadie manda por el provider crudo» (F7.5).
 *
 * ── POR QUÉ EXISTE ────────────────────────────────────────────────────────
 * Los dos avisos de `campaigns` (`core/management.ts` auto-pause de templates y
 * `workers/dlq.ts` calidad degradada) mandaban con `providers/email.ts sendEmail`
 * **directo**, salteándose `core/messaging.ts sendMessage()`. La consecuencia no
 * era cosmética: esos mails no pasaban por la idempotencia `(client_ref, destino)`,
 * ni por la guarda de destino staff-only, ni por `recordSendUsage` — o sea que
 * eran **gasto invisible**, y un reintento del evento los duplicaba.
 *
 * Nadie lo eligió: los dos emisores nacieron antes de que `sendMessage` fuera el
 * único camino, y sobrevivieron porque el inventario del plan de email miraba
 * n8n y el cockpit. Es exactamente la clase de error que este servicio viene
 * convirtiendo en imposible en vez de en convención: si un archivo nuevo puede
 * importar `sendEmail` y mandar, alguien lo va a hacer — no por descuido, sino
 * porque es la forma más corta de mandar un mail y compila.
 *
 * ── QUÉ CHEQUEA ───────────────────────────────────────────────────────────
 * Que ningún `.ts` de `src/` IMPORTE una función de envío de `providers/*`
 * fuera del port (`ports/channel-provider.ts`) y de los propios adapters. La
 * regla es sobre el IMPORT y no sobre la llamada: un símbolo que no se puede
 * importar no se puede llamar, y el import es una línea sin ambigüedad —
 * adivinar llamadas exige parsear, y un lint que adivina grita en falso (R11).
 *
 * Los imports `type`-only NO cuentan: `import type { EmailSendInput }` es la
 * forma del payload, no la capacidad de mandar.
 *
 * ── LA ÚNICA EXCEPCIÓN, Y POR QUÉ ─────────────────────────────────────────
 * `core/provider-cutover.ts` manda el mail de verificación del cutover BYOK
 * (T9.8.3) con `api_key: loaded.credential` — la credencial CANDIDATA que se
 * está probando, no la que devuelve el resolver. Ese envío no puede pasar por
 * `sendMessage` justamente porque su punto es no usar la credencial vigente.
 * Es una excepción de una línea, nombrada, con motivo; no una allowlist abierta.
 *
 * Equivalente en otros repos: `campaign-site/scripts/check-no-graph.mjs` (no
 * Graph fuera del servicio) y las reglas R8/R14/R15 de
 * `palmadevai-apps/scripts/lint-workflows.mjs` para workflows n8n.
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(process.cwd(), 'src');

/** Funciones que MANDAN. `markReadWhatsApp` no está: marcar leído no es un envío. */
const SEND_SYMBOLS = [
  'sendEmail',
  'sendWhatsApp',
  'sendFacebook',
  'sendInstagram',
];

/**
 * Quién SÍ puede importarlas.
 *   - `providers/`  — son los adapters; ahí viven.
 *   - `ports/channel-provider.ts` — el port que usa `sendMessage`: el camino.
 *   - `core/provider-cutover.ts`  — la excepción documentada arriba.
 */
const ALLOWED = [
  'src/providers/',
  'src/ports/channel-provider.ts',
  'src/core/provider-cutover.ts',
];

/** @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const rel = (f) => path.relative(process.cwd(), f).split(path.sep).join('/');

// `import { a, b } from '…/providers/x.js'` — multilínea incluida.
const IMPORT_RE = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]*providers\/[^'"]+)['"]/gs;

const violations = [];
if (fs.existsSync(SRC)) {
  for (const file of walk(SRC)) {
    const relPath = rel(file);
    if (ALLOWED.some((a) => relPath.startsWith(a))) continue;

    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const [full, typeOnly, names, from] = m;
      if (typeOnly) continue; // `import type` no habilita a mandar
      for (const raw of names.split(',')) {
        // soporta `sendEmail as alias` y `type Foo` dentro de las llaves
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (name.startsWith('type ')) continue;
        if (!SEND_SYMBOLS.includes(name)) continue;
        violations.push({
          file: relPath,
          line: src.slice(0, m.index).split(/\r?\n/).length,
          symbol: name,
          from,
          text: full.replace(/\s+/g, ' ').slice(0, 110),
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    `\n✗ ${violations.length} envío(s) por el provider crudo, salteando el Messaging Service:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  →  ${v.symbol} (de ${v.from})`);
    console.error(`     ${v.text}`);
  }
  console.error(
    '\nTodo envío pasa por core/messaging.ts sendMessage(): ahí viven la\n' +
      'idempotencia (client_ref, destino), la guarda de destino, el opt-out, la\n' +
      'ventana de 24h y el presupuesto. Un envío directo por el provider no pasa\n' +
      'por ninguna de las cinco y NO SE CUENTA — es gasto invisible.\n' +
      '\n' +
      'Si es un AVISO (destinatario fijo, resuelto por la feature): usá\n' +
      'core/notify.ts notify() o POST /notify — resuelve destinatarios, remitente,\n' +
      'fan-out y client_ref por vos (F7.5).\n' +
      'Si es un mensaje de producto: sendMessage() / POST /send.\n' +
      '\n' +
      'Si de verdad necesitás el provider crudo (única razón conocida: probar una\n' +
      'credencial candidata, ver core/provider-cutover.ts), agregá el archivo a\n' +
      'ALLOWED en este script CON el motivo escrito.\n',
  );
  process.exit(1);
}
console.log('✓ Messaging Service: ningún envío por el provider crudo fuera del port.');
