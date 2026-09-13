// Shared fixtures for the TimelineStore test files. Moved VERBATIM out of
// timeline-store.test.ts on 2026-08-19 when that file hit its pinned file-size
// debt (verify/lint/file-size.mjs: 1201 lines, may shrink and never grow) and a
// second suite (timeline-store-cause.test.ts) needed the same fixtures — a copy
// would have been two definitions of "how the bridge shapes a verdict", which is
// this repo's #1 bug shape pointed at its own harness (same reasoning as
// verify/golden/harness.mjs). Nothing here is production code: only the two
// TimelineStore test files import it.

import { TimelineStore } from './timeline-store';
import type { ChannelTag, InjectResult, ReportingKvStore, TimelineTransport, WireHistoryItem } from './types';

/** The ONE call the timeline still makes into native code (0.2.27): a LOCAL deferred delivery.
 *
 *  It records the arguments because the whole point of the change is WHICH argument
 *  travels — it used to be the row's ID (the server looked the text up); it is now the
 *  row's TEXT, because the server holds no transcripts and this PC owns the row. A
 *  transport that still only saw an id could not tell those two worlds apart.
 *
 *  `result` is what the pipeline answers. `null` means NOTHING WAS TYPED, which is a
 *  different statement from an `ok:false` result ("tried, but it didn't land") and the
 *  store must keep them apart. */
export class RecordingTransport implements TimelineTransport {
  calls: Array<{ text: string; entryId: string }> = [];
  /** Default: the injection happened and landed. */
  result: InjectResult | null = { ok: true, mode: 'sendinput' };

  /** RV-93 — every row id whose DELIVERED picture this store asked to delete. The
   *  point of recording it (rather than a no-op double) is that "when a row gets
   *  trimmed, its bytes go with it" has to be provable: a silent drop of the call
   *  would look exactly like a
   *  correct eviction from the rows' side. */
  droppedImages: string[] = [];
  /** What the picture read answers. `null` = this row kept none. */
  image: string | null = null;

  async reInjectLocally(text: string, entryId: string): Promise<InjectResult | null> {
    this.calls.push({ text, entryId });
    // Echo the correlation key the way `build_inject_result` does (A-58), unless the
    // test pinned a result of its own that already carries one.
    if (this.result === null) return null;
    return { entry_id: entryId, ...this.result };
  }

  /** 0.3.36 — the image arm's calls, recorded SEPARATELY from `calls`: the two
   *  doors carrying different payloads is the whole point of the split (the
   *  caption must never travel through either), so a shared recorder would hide
   *  exactly the mix-up the tests exist to catch. */
  imageCalls: string[] = [];
  /** What the image arm answers; `null` = nothing was pasted. */
  imageResult: InjectResult | null = { ok: true, mode: 'clipboard' };

  async reInjectImageLocally(entryId: string): Promise<InjectResult | null> {
    this.imageCalls.push(entryId);
    if (this.imageResult === null) return null;
    return { entry_id: entryId, ...this.imageResult };
  }

  async rowImage(): Promise<string | null> {
    return this.image;
  }

  dropRowImages(ids: readonly string[]): void {
    this.droppedImages.push(...ids);
  }
}

/** owner 2026-07-31 ③: the seam REPORTS whether the write landed, so "quota is
 *  full" can be
 *  driven in a test instead of only happening on a user's machine. */
export class MemStore implements ReportingKvStore {
  m = new Map<string, string>();
  /** Flip to simulate a full / refusing localStorage. */
  refuse = false;
  get(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  set(k: string, v: string): boolean {
    if (this.refuse) return false;
    this.m.set(k, v);
    return true;
  }
}

export function item(id: string, over: Partial<WireHistoryItem> = {}): WireHistoryItem {
  return {
    id,
    mode: 'realtime',
    status: 'injected',
    source_text: null,
    output_text: `text-${id}`,
    created_at: `2026-07-23T10:0${id}:00.000Z`,
    updated_at: `2026-07-23T10:0${id}:00.000Z`,
    ...over,
  };
}

export function fresh(): { store: TimelineStore; t: RecordingTransport } {
  const t = new RecordingTransport();
  return { store: new TimelineStore(t, new MemStore(), () => 1_000), t };
}

/** A verdict shaped exactly as the bridge forwards one (RV-72).
 *
 *  `row_id` + `channel` are the two CLIENT-LOCAL stamps `row_transit::forward_verdict`
 *  puts on the copy that reaches this window — the row's full address, handed over by
 *  the same code that minted the row. `entry_id` rides along as the A-58 correlation
 *  echo and is deliberately DIFFERENT from the row id here: it is no longer an address,
 *  and a test that let the two coincide could not tell which one the store reads. */
export function verdict(rowId: string, over: Partial<InjectResult> = {}): InjectResult {
  return { ok: true, mode: 'sendinput', row_id: rowId, channel: 'lan', entry_id: `en-${rowId}`, ...over };
}

/** Put rows into a store the only way anything can: the inbound row handler.
 *
 *  ✅ Since the row-transit round `onHistoryUpdated` HAS a production producer again —
 *  `socket::row_transit::mint_row` (Rust) builds one of these per delivery frame and
 *  forwards it on `flowmic://history-updated`. So this helper now exercises the real
 *  entry point rather than standing in for an undecided one. What it still does NOT
 *  prove is the WIRING between the two (a Vitest suite cannot start a socket) — that
 *  half is asserted on the Rust side (socket/row_transit.rs) and needs one real-machine
 *  run; see the card report. */
export function seed(store: TimelineStore, rows: WireHistoryItem[], channel: ChannelTag = 'lan'): void {
  for (const r of rows) store.onHistoryUpdated(r, channel);
}

/** A store that is ALREADY at its retention bound, built once and handed out fresh.
 *
 *  🔴 WHY THIS EXISTS (measured 2026-09-13, dev-pc-a). Seeding MAX_ROWS+50
 *  rows costs ~2.3 s, and the cost is honest: every arrival re-persists the WHOLE
 *  row set (timeline-store.ts symbol `persist` → one `JSON.stringify` of up to
 *  MAX_ROWS=2000 rows, plus `planEviction`'s sort), so 2050 arrivals is quadratic
 *  in a product constant. A real utterance really does pay one whole-set persist;
 *  what is not real is paying 2050 of them once per test. Seven cases in
 *  timeline-store.test.ts were 16.8 s of that file's 16.9 s, and 71 of its 78
 *  tests together came to 43 ms — so it was never "test-count cost".
 *
 *  ⚠️ WHAT IS AND IS NOT SHARED. The corpus is fed through the REAL arrival door
 *  exactly once, and what is replayed into each caller is the BYTES that pass
 *  wrote — so each store here BOOTS on the payload the arrival path produced, via
 *  the product's own hydrate (`hydrateTimeline`); `retention` is rebuilt from the
 *  same two facts it always is (`rows.size` + the persisted cutoffs). Use it only
 *  where a full store is the PRECONDITION. A test whose ASSERTION is about the
 *  seeding itself — the bound being applied as rows arrive, or a picture being
 *  dropped at the moment its row is evicted — must still seed row by row, or the
 *  boot-time trim would stand in for the arrival-time trim and cover for its
 *  absence.
 *
 *  🔴 REVERSE CONTROLS, MEASURED RED 2026-09-13 on the three cases moved onto this
 *  corpus — a cheaper precondition is worth nothing if the cases stopped biting:
 *    · marker REVERSE-CONTROL-A — the pre-0.2.26 "an edited row is un-evictable"
 *      guard put back into `planEviction` ⇒ 'an EDITED row is evictable like any
 *      other' FAILED;
 *    · marker REVERSE-CONTROL-B — the pre-RV-76 door put back into
 *      `onHistoryUpdated` (refuse an arriving row at or older than the cutoff) ⇒
 *      'a row older than the cutoff is TAKEN IN' FAILED;
 *    · marker REVERSE-CONTROL-C — `evictedOnArrival` hard-coded to `false` ⇒
 *      '…reported as dropped-on-arrival, never silently swallowed' FAILED.
 *  All three restored; `grep -rn "REVERSE-CONTROL-[ABC]" apps/desktop/src` = 0 and
 *  all 78 cases green again. */
export function boundedCorpus(rows: () => WireHistoryItem[]): () => { store: TimelineStore; t: RecordingTransport } {
  let snapshot: Map<string, string> | null = null;
  return () => {
    if (snapshot === null) {
      const seedKv = new MemStore();
      seed(new TimelineStore(new RecordingTransport(), seedKv, () => 1_000), rows());
      snapshot = new Map(seedKv.m);
    }
    const t = new RecordingTransport();
    const kv = new MemStore();
    kv.m = new Map(snapshot);
    return { store: new TimelineStore(t, kv, () => 1_000), t };
  };
}
