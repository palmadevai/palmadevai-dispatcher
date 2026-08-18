# palmadevai-dispatcher

Outbound dispatch worker en Node.js + TypeScript para el feature `campaigns`
de `palmadevai-apps` v0.4.0. Empaqueta:

- **dispatcher worker** (BullMQ) — consume `campaigns:stream` (Redis Streams
  Consumer Group `dispatchers`), POST a Meta WhatsApp Cloud API con
  `biz_opaque_callback_data` (ADR-011), UPDATE `bot.campaign_deliveries`,
  XACK. Rate limit via BullMQ limiter nativo (ADR-004).
- **recovery worker** — cron 5min, `XPENDING` + `XCLAIM` de mensajes idle,
  safety net Postgres para zombies (ADR-009 / ADR-015).
- **metrics-flush** — cron 30s, INSERT a `bot.dispatcher_metrics` con
  queue depth + latencies p50/p95/p99 + error ratio (ADR-012).
- **HTTP server** (Fastify) — `GET /health` (Docker healthcheck) + Bull Board
  UI en `/admin/queues` reverse-proxied desde el cockpit + Messaging Service:
  `POST /send` (H2.1, bearer `DISPATCHER_SEND_BEARER`) y `/management/*`
  (F3 H3.1/H3.2 — templates sync/create/delete, endpoints sync, quality
  refresh; mismo bearer, red docker interna, sin ruta Traefik).
- **template-sync worker** — mirror recurrente de templates Meta →
  `bot.message_templates` (default cada 6h, `DISPATCHER_TEMPLATE_SYNC_INTERVAL_MINUTES`),
  con auto-pause de campañas si un template pasa a rejected/disabled + email
  al operador (`bot.config['branding'].admin_email`). Reemplaza el cron n8n
  `campaigns-template-sync` (retirado en F3/H3.4 de
  `palmadevai-apps:features/messaging/doc/analysis-messaging-service.md`).

> **Estado actual: implementación real completa (F1.2.b+, v0.2.0 en adelante).**
>
> Los workers ejecutan side effects reales — XREADGROUP loop, SELECT FOR UPDATE
> SKIP LOCKED, pick-phone/pick-endpoint, send multi-provider (WA/email/FB/IG),
> classify + retry ZSET o DLQ con auto-pausa, métricas a `bot.dispatcher_metrics`.
> El boot lo confirma: `src/index.ts` loguea `dispatcher fully booted (real logic
> — XREADGROUP loop + DLQ + metrics)`. Detalle por worker en `CLAUDE.md`.
>
> `STUB_MODE=true` (env, default `false`) mantiene el modo dry-run para
> development: loguea intención sin POST a Meta, sin insert en DLQ, sin flush.
>
> *(Este header decía "SKELETON / workers en modo STUB" hasta 2026-08-17 —
> quedó congelado en F1.2.a mientras el código avanzaba; reconciliado en F0
> del plan `palmadevai-apps:features/campaigns/doc/plan-accion-campanas-2026-08.md`.)*

## Source of truth

Este repo es **build artifact only**. NO se toman decisiones de producto
acá — se portan del spec en `palmadevai-apps`.

- **Spec funcional**: `palmadevai-apps:features/campaigns/docs/spec.md`
  §5.2 (worker structure) + §5.3 (workers detallados con pseudocode).
- **ADRs**: `palmadevai-apps:features/campaigns/docs/decisions.md`
  (ADR-003 engine dispatch, ADR-004 rate limiting, ADR-009 DLQ, ADR-011
  idempotency, ADR-013 multi-phone, ADR-015 race conditions).
- **Manifest**: `palmadevai-apps:features/campaigns/manifest.yaml`
  (env vars, credentials_required, depends_on).
- **Stack ops**: `palmadevai-infra:stacks/93-dispatcher/README.md`
  (gating, scale, troubleshooting).
- **Gating**: `NewClientSetup:docs/campaigns-gating.md` —
  `MODULES_OUTBOUND_WORKER=true` + `93-dispatcher` en `STACKS_ENABLED`.

## Dev local

```bash
# 1. Instalar deps (requiere Node >=22)
npm install

# 2. Copiar env example + setear secrets
cp .env.example .env
# Editar .env con REDIS_PASSWORD, APPDB_PASSWORD, META_WA_*

# 3. Levantar (necesita Redis + Postgres reachable)
npm run dev     # watch mode con tsx
# o
npm run build && npm start
```

### Healthcheck

```bash
curl http://localhost:8080/health
# {
#   "status": "healthy",
#   "redis_ok": true,
#   "postgres_ok": true,
#   "bullmq_workers_count": 3,
#   "uptime_ms": 12345,
#   "stub_mode": true
# }
```

503 si Redis o Postgres no responden en <2s.

### Bull Board

`http://localhost:8080/admin/queues` — UI para inspeccionar jobs active,
completed, failed, delayed. En producción se accede vía reverse-proxy desde
el cockpit:

```
https://cockpit.<DOMAIN>/admin/queues
  → cockpit middleware proxea internamente a
    http://dispatcher:8080/admin/queues (red Docker `net`)
  → header X-Cockpit-Auth = COCKPIT_INTERNAL_TOKEN
```

Si `COCKPIT_INTERNAL_TOKEN` no está seteado, el endpoint queda abierto con
warning en logs (DEV ONLY — nunca en prod).

## Deploy a VPS

GH Actions (`.github/workflows/deploy.yml`) replica el patrón canónico
cockpit/chat-site/web:

1. Push a `main` dispara workflow.
2. SSH al VPS (`VPS_HOST` + `SSH_PRIVATE_KEY` secrets).
3. `git fetch origin main && git reset --hard` en `/opt/palmadevai-dispatcher`.
4. `docker build -t dispatcher:latest .` LOCAL en el VPS (sin GHCR).
5. Si `93-dispatcher` está en `STACKS_ENABLED` del cliente:
   `docker compose -f /opt/<slug>-infra/stacks/93-dispatcher/compose.yaml
   --env-file /srv/palmadev/<slug>/.env up -d --force-recreate dispatcher`.
6. Si NO está habilitado: solo buildea la imagen, no toca containers.

**Secrets GitHub**: `VPS_HOST`, `SSH_PRIVATE_KEY` (mismo SSH key que
cockpit/chat-site/web del cliente).

## Variables `.env`

Ver `.env.example` — los defaults matchean `palmadevai-apps:features/campaigns/manifest.yaml`.
Los secretos (`REDIS_PASSWORD`, `APPDB_PASSWORD`, `META_WA_BEARER_TOKEN`,
`META_WA_APP_SECRET`, `COCKPIT_INTERNAL_TOKEN`) viven en BW `runtime-env` +
`/srv/palmadev/<slug>/.env`. Nunca commitearlos.

## Estructura

```
src/
├── env.ts                          # zod schema validating process.env
├── index.ts                        # boot order + graceful shutdown
├── server.ts                       # Fastify /health + Bull Board
├── lib/
│   ├── logger.ts                   # pino with secret redaction
│   ├── redis.ts                    # bullmqRedis + rawRedis
│   ├── postgres.ts                 # postgres.js pool
│   └── meta-api.ts                 # Meta Graph API client (STUB en F1.2.a)
├── workers/
│   ├── dispatcher.ts               # BullMQ Worker queue='campaigns' (STUB)
│   ├── recovery.ts                 # cron 5min XPENDING (STUB, no XCLAIM yet)
│   └── metrics-flush.ts            # cron 30s log snapshot (STUB, no INSERT)
└── observability/
    └── metrics-collector.ts        # in-memory histograms p50/p95/p99
```

## Próximos pasos (F1.2.b — no en este PR)

- `dispatcher.ts`: implementar pseudocode de spec §5.3 (SELECT FOR UPDATE,
  pickPhone, sendMessage real, classifyError, UPDATE, Redis PUBLISH para SSE).
- `recovery.ts`: XCLAIM real + re-enqueue + Postgres safety net.
- `metrics-flush.ts`: INSERT a `bot.dispatcher_metrics` + queue depth.
- `meta-api.ts`: undici pool + retries + biz_opaque_callback_data.
- DLQ flow: `bot.campaign_dlq` insert tras N attempts (ADR-009).
- Audience filter / multi-phone helpers según ADR-010 / ADR-013.

## Troubleshooting

| Síntoma | Causa probable | Fix |
|---|---|---|
| Container restart loop, `Cannot connect to Redis` | `15-redis` down o pwd mismatch | Verificar `REDIS_PASSWORD` matches el del stack 15-redis |
| `XGROUP CREATE` BUSYGROUP en logs | Stream + group ya existen — esperado | Es idempotente; log info, no error |
| `/health` retorna 503 con `postgres_ok: false` | Pool no conecta o credenciales mal | Verificar `APPDB_PASSWORD` + `appdb_user` existe |
| `OOM command not allowed` | Redis lleno con `noeviction` (config canónica) | Subir `REDIS_MAXMEMORY` o inspect bigkeys; NO bajar a `allkeys-lru` (ADR-001) |
| Jobs stuck en PEL >5min | Recovery worker no está corriendo | Ver logs del container; en F1.2.a recovery es STUB y solo loguea |

## Tag-bump

Este repo es **cliente cero** del template. Al cambiar:

- **Patch** (v0.1.X) — fixes internos, sin cambio de contrato.
- **Minor** (v0.X.0) — nuevas features (e.g., F1.2.b cuando implementemos el
  worker real será v0.2.0).
- **Major** (vX.0.0) — breaking changes a env vars o queue shape.

Cherry-pick a clientes via tag — mismo patrón que `palmadevai-chat-site`.

## Doc relacionada

- Spec del feature: `palmadevai-apps:features/campaigns/docs/spec.md`
- ADRs: `palmadevai-apps:features/campaigns/docs/decisions.md`
- Stack ops: `palmadevai-infra:stacks/93-dispatcher/README.md`
- Onboarding cliente: `NewClientSetup:docs/campaigns-gating.md`
