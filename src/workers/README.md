# Workers — architecture notes (F1.2.b)

## Why ioredis XREADGROUP, not BullMQ Worker class

The producer (n8n workflow `campaigns-enqueue`) writes to a **Redis Stream**
(`XADD campaigns:stream * delivery_id <id> queued_at <iso>`). BullMQ's `Worker`
class consumes its own internal data structure (sorted-sets + lists keyed
`bull:<queue>:*`), not Redis Streams. We have three options:

1. **Switch producer to BullMQ `Queue.add()`** — would require n8n to import the
   BullMQ JS client. n8n doesn't ship that and we don't want a custom community
   node. ✗
2. **Bridge stream → BullMQ queue** — a small node that XREADGROUPs and calls
   `queue.add(delivery_id)`. Adds a moving part with no operational benefit. ✗
3. **ioredis XREADGROUP loop directly + a mirror Queue for Bull Board** ✓

We chose option 3. The actual work happens in `dispatcher.ts` via a custom
worker pool (concurrency = `DISPATCHER_CONCURRENCY` async tasks) reading from
the stream via `XREADGROUP > <stream> >`. A tiny BullMQ `Queue` named
`campaigns` is created in `server.ts` only to satisfy Bull Board (the UI needs
a Queue handle to introspect). That mirror queue is **read-only from Bull
Board's perspective** — we never `queue.add()` to it; failed/DLQ items go to
`bot.campaign_dlq` (Postgres source of truth).

## Job lifecycle

```
n8n campaigns-enqueue
    │ XADD campaigns:stream * delivery_id <id> queued_at <iso>
    ▼
[dispatcher XREADGROUP loop]
    │ delivery_id, queued_at, stream_id
    ▼
process(deliveryId, queuedAt):
    BEGIN TX
      SELECT FOR UPDATE SKIP LOCKED → bail if locked / non-pending
      resolveDeliveryContext()
      pickPhoneForContact()  → pause campaign if null
      sendWhatsApp()         → 5xx throws → retry
                                4xx returns → classify
      on ok: UPDATE status='accepted', sent_today++, PUBLISH SSE
      on terminal error: UPDATE status='failed'/'undelivered'
      on retriable: throw
    COMMIT
    XACK stream_id

on throw (retriable):
    if retry_count + 1 < attempts:
        UPDATE retry_count = retry_count + 1
        XADD back with exponential backoff (scheduler key, ZADD)
        XACK stream_id (release PEL slot)
    else:
        moveToDLQ()
        UPDATE status='failed'
        XACK stream_id
```

## Retry & backoff

BullMQ-style exponential backoff: 1m, 4m, 16m (delay × 4 per attempt).
Implementation: a Redis ZSET `campaigns:retry-zset` ordered by `score=eta_ms`.
A scheduler tick (every 5s in `dispatcher.ts`) pops `<= now` entries and
re-XADDs them to the main stream. Simple, no extra container.

`retry_count` is persisted in `bot.campaign_deliveries.retry_count` so the
dispatcher knows the attempt number across process restarts (the BullMQ
in-memory counter does not survive).

## DLQ

`moveToDLQ()` (workers/dlq.ts) inserts into `bot.campaign_dlq` with full
request/response payloads + classified `error_category`. Then it computes a
sliding 1-min DLQ-rate per campaign: if `>= 20% of recent attempts in same
campaign`, auto-pause the campaign with `pause_reason='auto_quality_degraded'`.
Operator triages from `/campaigns/dlq` (cockpit).

## Bull Board impact

Because actual jobs flow through Redis Streams (not the BullMQ queue),
`/admin/queues` will show the mirror queue as **empty** during normal
operation. This is **expected and intentional** — Bull Board is reserved for
manual operator re-runs ("re-enqueue this DLQ delivery as a one-off job"),
which a future PR (F1.3) wires from cockpit.

The Bull Board UI still shows the worker connection / process count, which is
the main reason we kept it mounted (operator visibility into the dispatcher
process itself).

## Recovery & safety net

`recovery.ts` runs every 5min and:

1. **XCLAIM stale PEL entries** (IDLE > 5min) — moves ownership to this
   consumer so a dead worker doesn't block forever.
2. **Postgres safety net** — re-XADDs deliveries that are status=pending
   but queued_at < now - 5min (covers AOF gap / Redis evict scenarios).
3. **PEL timeout 1h** — anything still in PEL after 1h gets terminal-failed
   + inserted into DLQ with category `worker_crash_loop` (or pel_timeout_1h
   in failure_reason), XACK'd so it stops blocking.

## Metrics

`metrics-flush.ts` snapshots `MetricsCollector` every
`DISPATCHER_METRICS_FLUSH_INTERVAL_SECONDS` (default 30s) and inserts a row
into `bot.dispatcher_metrics`. `MetricsCollector` keeps histograms /
counters in memory; flush calls `reset()` to bound RAM.

`/admin/observability` (cockpit, future PR) reads `bot.dispatcher_metrics`
time-series.
