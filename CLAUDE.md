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

## Estado actual: F1.2.b (real logic, v0.2.0+)

Worker implementation completa. Los 3 workers ejecutan side effects reales:

- **dispatcher**: XREADGROUP loop → SELECT FOR UPDATE SKIP LOCKED →
  resolveDeliveryContext → pickPhone (ADR-013) → sendMessage con
  biz_opaque_callback_data (ADR-011) → classifyError + retry ZSET o DLQ
  (ADR-009) → UPDATE deliveries → XACK.
- **recovery**: cron 5min — XPENDING + XCLAIM idle>5min + safety net
  Postgres (zombies status=pending queued_at<now-5min) + dead letter 1h.
- **metrics-flush**: cron 30s — INSERT `bot.dispatcher_metrics` con
  histograms p50/p95/p99 via simple-statistics.

Plus: Fastify `/health` (pinga Redis + Postgres timeout 2s + reporta
STUB_MODE real), Bull Board `/admin/queues` (auth opcional X-Cockpit-Auth),
HTTP listener :8080 (Docker healthcheck consume), graceful shutdown
SIGTERM/SIGINT con flush in-flight, retry ZSET promoter tick 5s.

### STUB_MODE env (development only)

Setear `STUB_MODE=true` en `.env` para que workers loguean intención sin
ejecutar side effects (no Meta POST, no DLQ insert, no metrics flush).
Default `false`. El health endpoint reporta `stub_mode: env.STUB_MODE`.

### Smoke A2 verificado 2026-05-27 (lab palmadevai)

8 etapas end-to-end: XREADGROUP consume → SELECT FOR UPDATE SKIP LOCKED
con range ±1ms en queued_at → resolveDeliveryContext (campaign+contact+
template) → pickPhoneForContact sticky → POST Meta Graph API → classifyError
→ retry schedule ZSET con backoff exponencial → XACK. WA real bloqueado
externamente por aprobación Meta de template; arquitectura validada.

4 bugs encontrados durante smoke A2 + fixeados en v0.2.1:
- `server.ts` stub_mode ahora derive de `env.STUB_MODE` (no hardcoded).
- `env.ts` HOSTNAME refuerza default vs empty string (compose drift).
- `dispatcher.ts` + `recovery.ts` queued_at usan BETWEEN ±1ms en SELECTs +
  re-pinean al valor exacto del DB para UPDATEs subsiguientes.
- Compose `93-dispatcher` HOSTNAME default ahora `dispatcher-0` (no empty).

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
