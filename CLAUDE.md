# CLAUDE.md — palmadevai-dispatcher

Worker Node.js TypeScript dedicado para dispatch outgoing del feature
`campaigns` (palmadevai-apps v0.4.0+). Stack 93-dispatcher.

## Identificación
- Repo: `palmadevai/palmadevai-dispatcher`
- Imagen Docker: `dispatcher:latest` (built localmente en el VPS via GH
  Actions SSH, NO via GHCR — mismo patrón cockpit/chat-site/web).
- Stack consumidor: `palmadevai-infra:stacks/93-dispatcher/compose.yaml`
- Gating: `MODULES_OUTBOUND_WORKER=true` + `93-dispatcher` ∈ `STACKS_ENABLED`.

## Regla #1: Single source of truth

**Las decisiones de producto NO se toman acá. Se portan.**

- Spec funcional canónica: `palmadevai-apps:features/campaigns/docs/spec.md`
- ADRs (ADR-001 a ADR-019): `palmadevai-apps:features/campaigns/docs/decisions.md`
- Env vars + creds: `palmadevai-apps:features/campaigns/manifest.yaml`
- Ops/runbook stack: `palmadevai-infra:stacks/93-dispatcher/README.md`

Si vas a cambiar comportamiento, primero actualizá la spec en apps + ADR,
después portás el cambio acá. Drift entre repos = bug.

## Reglas heredadas de `palmadevai/CLAUDE.md`

- `git pull --ff-only origin main` antes de cualquier edit.
- Workflow obligatorio: branch + commit format `<tipo>(<scope>): <desc>` +
  PR + merge. NO push directo a main (excepto el initial commit del bootstrap).
- Tag-bump post-merge OBLIGATORIO. La sesión no se considera cerrada
  mientras `main` esté adelante del último tag.
- Convenciones de tipos: `feat`, `fix`, `hotfix`, `docs`, `chore`, `refactor`.

## Estado actual: F1.2.a (skeleton)

Boot scaffold. Los 3 workers (dispatcher, recovery, metrics-flush) están en
modo STUB:

- **dispatcher**: BullMQ Worker arranca, recibe jobs del queue 'campaigns',
  loguea + ACK + return `{ skipped: 'stub' }`. NO procesa delivery.
- **recovery**: setInterval 5min loguea output de `XPENDING`. NO hace XCLAIM.
- **metrics-flush**: setInterval 30s loguea snapshot del MetricsCollector.
  NO INSERT a `bot.dispatcher_metrics`.

Lo que SÍ funciona:
- Zod env validation (fail-fast en boot).
- Redis + Postgres conexión + healthcheck.
- BullMQ Worker registrado al queue (rate limiter activo).
- Redis Stream + Consumer Group MKSTREAM idempotente.
- Fastify `/health` (pinga Redis + Postgres con timeout 2s).
- Bull Board en `/admin/queues` (con auth opcional via header).
- Graceful shutdown SIGTERM/SIGINT.

## F1.2.b (próximo PR, NO acá)

Implementación real del worker:
1. dispatcher: SELECT FOR UPDATE SKIP LOCKED, pickPhone (ADR-013),
   sendMessage con biz_opaque_callback_data (ADR-011), classifyError + DLQ
   (ADR-009), UPDATE deliveries, Redis PUBLISH para SSE (ADR-005).
2. recovery: XCLAIM real + re-enqueue + Postgres safety net.
3. metrics-flush: INSERT `bot.dispatcher_metrics` (migration 051).
4. meta-api.ts: undici pool + retries clasificados.

## Convenciones específicas

- **TypeScript strict**. No `any` salvo cast inevitable (raw Redis returns,
  Fastify logger plumbing).
- **ESM only**. `"type": "module"` en package.json, imports terminan en `.js`
  (NodeNext module resolution requiere extensión explícita aunque el source
  sea `.ts`).
- **Pino logger** con redact paths configurados — verificar que ningún log
  call inline secrets en plain (preferir `{ password: '...' }` y dejar que
  el redactor haga su trabajo).
- **Postgres queries**: tagged templates con `postgres.js`. NUNCA string
  concat. Schema `bot` qualified explícito (`bot.campaign_deliveries`, no
  `campaign_deliveries`).
- **Errores**: clasificar antes de retry. Spec §5.3 + ADR-009 define
  categorías (rate_limited, invalid_template, opted_out, server_error, etc).

## Stack 93-dispatcher (cómo encaja)

- Compose define `replicas: ${DISPATCHER_REPLICAS:-1}`. Cada replica tiene
  `HOSTNAME` único del container → consumer_name único dentro del grupo
  `dispatchers`. BullMQ + Redis Streams hacen round-robin XREADGROUP.
- Healthcheck Docker: `wget -qO- http://localhost:8080/health`. Si 503 →
  Docker marca unhealthy → docker compose orquesta restart si el operador
  configura `restart: unless-stopped` (default del stack).
- No Traefik labels — el dispatcher NO se expone público. Bull Board se
  consume vía reverse-proxy desde el cockpit (red Docker `net` compartida).

## Memoria local vs CLAUDE.md

- Hechos durables (estructura, ADRs, gotchas) → este archivo o spec en apps.
- Memoria local (`~/.claude/projects/.../memory/`) = acelerador de sesión.
- Conflicto = gana este archivo (o spec.md si es decisión de producto).
