// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.9 (the Codex item 5 correction:
//     the managed-streaming billing base is min(gate-open ms, UNIQUE audio handed to an engine))
//
// Codex review item 5 (2026-09-24) — which chunks of this recording have been handed
// to ANY engine leg at least once. The orchestrator's `sessionFedBytes` counts every
// byte it hands over, replays included, so a ladder reconnect that re-feeds audio the
// dropped leg had already heard is counted twice; billing on it overcharged a recovered
// drop followed by an unrecovered outage (43.8 s billed for 40 s of unique audio,
// test/stt-billing-fed-audio.test.ts). This set answers the other question: has this
// chunk been heard before?
//
// Kept as sorted disjoint seq ranges, not a set of seqs: a recording feeds seqs almost
// always in order, with holes only where the gate withheld silence, so the ranges grow
// by pauses, not by chunks (an hour at 5 chunks/s would otherwise be 18,000 entries).

export class FedSeqRanges {
  /** Sorted, disjoint, non-adjacent inclusive ranges [lo, hi]. */
  private readonly ranges: [number, number][] = [];

  /** A fresh recording. */
  reset(): void { this.ranges.length = 0; }

  /** Record that [seq] was handed to an engine. Returns true the FIRST time, false ever after. */
  firstFeed(seq: number): boolean {
    const r = this.ranges;
    // The common case, O(1): the next seq after the newest range.
    const last = r[r.length - 1];
    if (last !== undefined && seq === last[1] + 1) { last[1] = seq; return true; }
    if (last !== undefined && seq >= last[0] && seq <= last[1]) return false;
    // Otherwise: the first range whose hi >= seq - 1.
    let lo = 0; let hi = r.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (r[mid]![1] < seq - 1) lo = mid + 1; else hi = mid; }
    const at = r[lo];
    if (at !== undefined && seq >= at[0] && seq <= at[1]) return false;
    if (at !== undefined && seq === at[1] + 1) {
      at[1] = seq;
      const next = r[lo + 1];
      if (next !== undefined && next[0] === seq + 1) { at[1] = next[1]; r.splice(lo + 1, 1); }
      return true;
    }
    if (at !== undefined && seq === at[0] - 1) { at[0] = seq; return true; }
    r.splice(lo, 0, [seq, seq]);
    return true;
  }

  /** card RC-Q — has [seq] been recorded? Read-only; the common case (the newest range) is O(1). */
  has(seq: number): boolean {
    const r = this.ranges;
    const last = r[r.length - 1];
    if (last !== undefined && seq >= last[0] && seq <= last[1]) return true;
    let lo = 0; let hi = r.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (r[mid]![1] < seq) lo = mid + 1; else hi = mid; }
    const at = r[lo];
    return at !== undefined && seq >= at[0] && seq <= at[1];
  }
}
