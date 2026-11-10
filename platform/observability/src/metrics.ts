/**
 * Minimal in-memory metrics registry — counters and gauges. Used later for the mandated signals:
 * outbox event-lag, reconciliation drift, LLM degradation rate, auth failures (blueprint doc 13).
 * Kept dependency-free; a real exporter (Prometheus/OTel) can read `snapshot()` behind an adapter.
 */

export interface Metrics {
  inc(name: string, by?: number): void;
  gauge(name: string, value: number): void;
  get(name: string): number;
  snapshot(): Record<string, number>;
  reset(): void;
}

export function createMetrics(): Metrics {
  const store = new Map<string, number>();
  return {
    inc(name, by = 1) {
      store.set(name, (store.get(name) ?? 0) + by);
    },
    gauge(name, value) {
      store.set(name, value);
    },
    get(name) {
      return store.get(name) ?? 0;
    },
    snapshot() {
      return Object.fromEntries(store);
    },
    reset() {
      store.clear();
    },
  };
}

export const metrics: Metrics = createMetrics();
