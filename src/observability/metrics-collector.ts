/**
 * In-memory metrics collector. Sliding-window histograms for latency p50/p95/p99,
 * counters for dequeue & send rate, error breakdown by category.
 *
 * Windows:
 *   - dequeue / send rate          → 60s (count divided by 60 = events/sec)
 *   - send latency percentiles     → 5min sample (rolling)
 *   - error_ratio_5m + breakdown   → 5min
 *
 * Memory bound:
 *   - sendLatencies trimmed on every record() and on snapshot().
 *   - errors trimmed same way.
 *   - dequeueTimestamps trimmed too.
 *   - resetWindows() after each flush keeps the steady-state size near zero
 *     for low-traffic clients.
 */
import { quantile } from 'simple-statistics';

const FIVE_MIN_MS = 5 * 60 * 1000;
const SIXTY_S_MS = 60 * 1000;

interface LatencySample {
  ts: number;
  ms: number;
}

interface ErrorSample {
  ts: number;
  category: string;
}

export interface MetricsSnapshot {
  queue_depth: number;
  dequeue_count_total: number;
  dequeue_rate_60s: number; // events in last 60s
  send_count_5m: number;
  send_latency_p50_ms: number | null;
  send_latency_p95_ms: number | null;
  send_latency_p99_ms: number | null;
  error_count_5m: number;
  error_ratio_5m: number;
  collected_at: string;
}

export class MetricsCollector {
  private dequeueCountTotal = 0;
  private dequeueTimestamps: number[] = [];
  private sendTimestamps: number[] = []; // for send rate
  private sendLatencies: LatencySample[] = [];
  private errors: ErrorSample[] = [];
  private queueDepth = 0;

  setQueueDepth(depth: number): void {
    this.queueDepth = depth;
  }

  recordDequeue(): void {
    const now = Date.now();
    this.dequeueCountTotal += 1;
    this.dequeueTimestamps.push(now);
    this.pruneNumberWindow(this.dequeueTimestamps, now - SIXTY_S_MS);
  }

  recordSend(latencyMs: number): void {
    const now = Date.now();
    this.sendTimestamps.push(now);
    this.pruneNumberWindow(this.sendTimestamps, now - SIXTY_S_MS);
    this.sendLatencies.push({ ts: now, ms: latencyMs });
    this.pruneSamples(this.sendLatencies, now - FIVE_MIN_MS);
  }

  recordError(category: string): void {
    const now = Date.now();
    this.errors.push({ ts: now, category });
    this.pruneSamples(this.errors, now - FIVE_MIN_MS);
  }

  errorBreakdown(): Record<string, number> {
    const now = Date.now();
    this.pruneSamples(this.errors, now - FIVE_MIN_MS);
    const out: Record<string, number> = {};
    for (const e of this.errors) {
      out[e.category] = (out[e.category] ?? 0) + 1;
    }
    return out;
  }

  snapshot(): MetricsSnapshot {
    const now = Date.now();
    this.pruneNumberWindow(this.dequeueTimestamps, now - SIXTY_S_MS);
    this.pruneNumberWindow(this.sendTimestamps, now - SIXTY_S_MS);
    this.pruneSamples(this.sendLatencies, now - FIVE_MIN_MS);
    this.pruneSamples(this.errors, now - FIVE_MIN_MS);

    const latencies = this.sendLatencies.map((s) => s.ms);
    const sendCount5m = latencies.length;
    const errorCount5m = this.errors.length;
    const denom = sendCount5m + errorCount5m;
    const errorRatio = denom > 0 ? errorCount5m / denom : 0;

    return {
      queue_depth: this.queueDepth,
      dequeue_count_total: this.dequeueCountTotal,
      dequeue_rate_60s: this.dequeueTimestamps.length,
      send_count_5m: sendCount5m,
      send_latency_p50_ms: latencies.length > 0 ? quantile(latencies, 0.5) : null,
      send_latency_p95_ms: latencies.length > 0 ? quantile(latencies, 0.95) : null,
      send_latency_p99_ms: latencies.length > 0 ? quantile(latencies, 0.99) : null,
      error_count_5m: errorCount5m,
      error_ratio_5m: errorRatio,
      collected_at: new Date(now).toISOString(),
    };
  }

  /**
   * Reset only the sliding-window data after a flush. Cumulative
   * dequeueCountTotal stays so /health or operator queries still see the
   * lifetime counter.
   */
  resetWindows(): void {
    this.dequeueTimestamps = [];
    this.sendTimestamps = [];
    this.sendLatencies = [];
    this.errors = [];
  }

  /** Full reset — only used in tests. */
  reset(): void {
    this.dequeueCountTotal = 0;
    this.resetWindows();
    this.queueDepth = 0;
  }

  private pruneNumberWindow(arr: number[], threshold: number): void {
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
