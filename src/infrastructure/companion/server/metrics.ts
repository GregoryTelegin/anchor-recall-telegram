const metrics = ["journal.validate", "journal.write", "telegram.api", "telegram.upload", "media.read", "media.hash", "transport.wait", "runtime.commit", "runtime.queue", "runtime.callback_queue", "media.cache.hit", "media.cache.miss", "media.cache.invalid", "miniapp.view", "miniapp.view-conflict"] as const;
export type PerformanceMetric = typeof metrics[number];
export type PerformanceObserver = (metric: PerformanceMetric, elapsedMs: number) => void;
const bounds = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 3000, 10000, 30000, 60000, Number.POSITIVE_INFINITY];
interface Measurement { count: number; totalMs: number; maxMs: number; buckets: number[]; }
export interface PerformanceSummary { count: number; totalMs: number; maxMs: number; p50Ms: number; p95Ms: number; }

/** Fixed names and buckets keep telemetry bounded and free of learner or account identifiers. */
export class CompanionPerformance {
  private readonly rows = new Map<PerformanceMetric, Measurement>();
  readonly observe: PerformanceObserver = (metric, elapsedMs) => {
    if (!metrics.includes(metric) || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    const row = this.rows.get(metric) ?? { count: 0, totalMs: 0, maxMs: 0, buckets: bounds.map(() => 0) };
    if (row.count >= Number.MAX_SAFE_INTEGER) return;
    row.count++; row.totalMs = Math.min(Number.MAX_SAFE_INTEGER, row.totalMs + elapsedMs); row.maxMs = Math.max(row.maxMs, elapsedMs);
    row.buckets[bounds.findIndex(bound => elapsedMs <= bound)]++;
    this.rows.set(metric, row);
  };
  snapshot(reset = false): Partial<Record<PerformanceMetric, PerformanceSummary>> {
    const result: Partial<Record<PerformanceMetric, PerformanceSummary>> = {};
    for (const [metric, row] of this.rows) {
      const percentile = (fraction: number): number => {
        let count = 0;
        for (let i = 0; i < row.buckets.length; i++) {
          count += row.buckets[i];
          if (count >= Math.ceil(row.count * fraction)) return Math.min(bounds[i], row.maxMs);
        }
        return row.maxMs;
      };
      result[metric] = { count: row.count, totalMs: Math.round(row.totalMs), maxMs: Math.ceil(row.maxMs), p50Ms: Math.ceil(percentile(0.5)), p95Ms: Math.ceil(percentile(0.95)) };
    }
    if (reset) this.rows.clear();
    return result;
  }
}

/** Diagnostics cannot turn a successful journal write or delivery into a failure. */
export function recordPerformance(observer: PerformanceObserver | undefined, metric: PerformanceMetric, elapsedMs: number): void {
  try { observer?.(metric, elapsedMs); } catch { /* Operator diagnostics are best effort. */ }
}
