/**
 * In-memory metrics collector. Sliding-window histograms para latency p50/p95/p99,
 * counters para dequeue rate + errors.
 *
 * F1.2.a (skeleton): API completa + snapshot() funciona, pero los métodos
 * record* son no-ops salvo recordDequeue() (que sí incrementa contador, para
 * que el smoke test del stub pueda observarlo).
 *
 * F1.2.b: wirear recordSend(latencyMs) desde el dispatcher post-send,
 * recordError(category) desde el catch + classifier. metrics-flush worker
 * llama snapshot() cada 30s y hace INSERT a bot.dispatcher_metrics.
 *
 * Ver spec.md §5.3 (metrics-flush) + ADR-012 (SRE metrics).
 */
import { quantile } from 'simple-statistics';

const SLIDING_WINDOW_MS = 5 * 60 * 1000; // 5 min para error_ratio_5m

interface LatencySample {
  ts: number;
  ms: number;
}

interface ErrorSample {
  ts: number;
  category: string;
}

export interface MetricsSnapshot {
  queue_depth: number; // F1.2.b: rellenar via XLEN call al raw redis
  dequeue_count_total: number;
  dequeue_rate_60s: number;
  send_latency_p50_ms: number | null;
  send_latency_p95_ms: number | null;
  send_latency_p99_ms: number | null;
  error_count_5m: number;
  error_ratio_5m: number; // errors / (errors + successful sends) en últimos 5min
  send_count_5m: number;
  collected_at: string;
}

export class MetricsCollector {
  private dequeueCountTotal = 0;
  private dequeueTimestamps: number[] = []; // últimos 60s
  private sendLatencies: LatencySample[] = []; // últimos 5min
  private errors: ErrorSample[] = []; // últimos 5min

  // F1.2.b: queue_depth se popula desde un caller externo (el flush worker
  // que tiene rawRedis disponible y hace XLEN). Setter expuesto.
  private queueDepth = 0;

  setQueueDepth(depth: number): void {
    this.queueDepth = depth;
  }

  recordDequeue(): void {
    const now = Date.now();
    this.dequeueCountTotal += 1;
    this.dequeueTimestamps.push(now);
    this.pruneWindow(this.dequeueTimestamps, now - 60_000);
  }

  recordSend(latencyMs: number): void {
    const now = Date.now();
    this.sendLatencies.push({ ts: now, ms: latencyMs });
    this.pruneSamples(this.sendLatencies, now - SLIDING_WINDOW_MS);
  }

  recordError(category: string): void {
    const now = Date.now();
    this.errors.push({ ts: now, category });
    this.pruneSamples(this.errors, now - SLIDING_WINDOW_MS);
  }

  snapshot(): MetricsSnapshot {
    const now = Date.now();
    this.pruneWindow(this.dequeueTimestamps, now - 60_000);
    this.pruneSamples(this.sendLatencies, now - SLIDING_WINDOW_MS);
    this.pruneSamples(this.errors, now - SLIDING_WINDOW_MS);

    const latencies = this.sendLatencies.map((s) => s.ms);
    const sendCount5m = latencies.length;
    const errorCount5m = this.errors.length;
    const denom = sendCount5m + errorCount5m;
    const errorRatio = denom > 0 ? errorCount5m / denom : 0;

    return {
      queue_depth: this.queueDepth,
      dequeue_count_total: this.dequeueCountTotal,
      dequeue_rate_60s: this.dequeueTimestamps.length,
      send_latency_p50_ms: latencies.length > 0 ? quantile(latencies, 0.5) : null,
      send_latency_p95_ms: latencies.length > 0 ? quantile(latencies, 0.95) : null,
      send_latency_p99_ms: latencies.length > 0 ? quantile(latencies, 0.99) : null,
      error_count_5m: errorCount5m,
      error_ratio_5m: errorRatio,
      send_count_5m: sendCount5m,
      collected_at: new Date(now).toISOString(),
    };
  }

  /** Reset usado en tests; en producción no se invoca. */
  reset(): void {
    this.dequeueCountTotal = 0;
    this.dequeueTimestamps = [];
    this.sendLatencies = [];
    this.errors = [];
    this.queueDepth = 0;
  }

  private pruneWindow(arr: number[], threshold: number): void {
    while (arr.length > 0 && arr[0]! < threshold) {
      arr.shift();
    }
  }

  private pruneSamples<T extends { ts: number }>(arr: T[], threshold: number): void {
    while (arr.length > 0 && arr[0]!.ts < threshold) {
      arr.shift();
    }
  }
}
