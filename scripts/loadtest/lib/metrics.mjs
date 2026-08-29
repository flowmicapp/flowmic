// scripts/loadtest/lib/metrics.mjs — small, dependency-free latency/percentile math.

/** Nearest-rank percentile over an UNSORTED array (sorts a copy). p in [0,100]. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

export function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** One summary object for a bag of latency samples (milliseconds). Every field
 *  is null on an empty bag rather than NaN/0 — a 0ms p50 on zero samples would
 *  read as "fast" when the true statement is "never observed". */
export function summarizeLatencies(values) {
  const n = values.length;
  if (n === 0) {
    return { count: 0, min_ms: null, p50_ms: null, p95_ms: null, p99_ms: null, max_ms: null, mean_ms: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: n,
    min_ms: sorted[0],
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    p99_ms: percentile(sorted, 99),
    max_ms: sorted[n - 1],
    mean_ms: Math.round(mean(sorted) * 100) / 100,
  };
}

export function rate(successCount, totalCount) {
  if (totalCount === 0) return null;
  return Math.round((successCount / totalCount) * 10000) / 100; // % to 2dp
}
