// SPEC-REF:
//   docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md
//     ("phone↔PC does not do cloud storage sync, the cloud does not store
//       transcripts"; "the PC timeline becomes entirely local-owned — it used to
//       be a cache of server rows, now it has to become the owner. Search
//       follows it and becomes local search")
//   docs/decisions/2026-07-30-injected-means-delivered-to-keyboard-focus.md
//   docs/rebuild/07-DESKTOP-SPEC.md §9 (four operations: copy / reInject / edit / delete)
//   docs/rebuild/07-DESKTOP-SPEC.md §6 (dual-channel resident — two channels are two servers)
//   CLAUDE.md red line: status records delivery truth only; source_text is immutable; no silent failure
//
// The PC timeline store.
//
// ── THIS PC OWNS THESE ROWS, AND NOTHING ELSE HAS A COPY ────────────────────────
//
// 0.2.26 made this store the OWNER of its rows instead of a cache of the server's
// `transcript_history`. 0.2.27 finishes the job by removing the other half — the four
// wire verbs that still talked to that table:
//
//   `history:list`   — a pull. The server holds no transcripts, so it would answer
//                      with nothing forever; the ONLY reason it survived 0.2.26 was
//                      the required landing order (stopping the server first would
//                      have emptied the page).
//   `history:update` — a mirror write. There is no mirror.
//   `history:delete` — the same, and it was the worse of the two: the server answers
//                      `HISTORY_SYNC_RETIRED` now, so every edit and every delete
//                      would have produced a red "the server hasn't confirmed" line
//                      and an op that
//                      re-queued itself on every reconnect, forever.
//   `history:inject` — deferred delivery. The PC sent an id, the server read the text
//                      out of its
//                      table, and sent it back to THIS SAME PC as an
//                      `inject:request`. The PC has held the text since 0.2.26 and is
//                      the machine that types it, so the trip answered a question
//                      nobody had. It now runs the local pipeline directly
//                      (`transport.reInjectLocally` → the same `run_inject` an inbound
//                      `inject:request` runs, so `injected` keeps exactly ONE meaning
//                      — the RV-45 ruling's hard constraint).
//
// WHAT THAT MAKES EACH OP. `copy`, `edit`, `delete` and `search` are now writes and
// reads against this machine's own store, full stop. There is no ack to wait for, no
// durable queue, and no "saved locally" chip — that chip meant "this machine
// changed it and it hasn't been uplinked yet", and
// with no uplink the question does not exist, so rendering it would be a sentence
// about a state that cannot occur. `reInject` is the only op that can still fail, and
// what it can fail at is TYPING, not syncing.
//
// AN OWNER'S THREE OBLIGATIONS, none of which a cache has:
//
//   ① NOBODY ELSE MAY OVERWRITE A ROW. The local row is the truth — including its
//      `status`, which THIS machine established by actually injecting (red line:
//      status records delivery truth only). The bulk re-read that used to rewrite
//      rows wholesale is gone with the pull.
//   ② A STATED BOUND. Rows are trimmed oldest-first (lib/timeline-retention.ts) and
//      the two facts needed to SAY so — how many are kept, and the instant everything
//      older than which is gone — are kept and exposed ([[retention]]).
//      An unbounded owner blows the storage quota; a bounded one that stays quiet is
//      "the user thinks their whole history is there, when it's actually already
//      been trimmed".
//   ③ A CHECKED WRITE. `persist` reads the store's own verdict; a refused write sets
//      [[storageFailed]] so the page can say the rows on screen are memory-only.
//      Swallowing it silently is the same lie as ②, one layer down.
//
// The rows are still persisted under the key `flowmic.history.cache` — the NAME is
// now wrong and the key is deliberately not renamed: it is the address of data that
// is already on users' machines, and renaming it would empty every existing
// timeline, which is exactly the loss this card exists to prevent.
//
// ✅ HOW A NEW ROW ARRIVES — ANSWERED (owner's architecture ruling
// transit-not-storage, card P + card D).
// It used to be `history:updated`, broadcast by the server when a phone created a row.
// The server stores and broadcasts nothing now; between 0.2.27 and this card
// [[onHistoryUpdated]] had NO PRODUCER at all, and the timeline could not gain a new
// row. It was kept rather than deleted precisely because it is this repo's only
// implementation of "one inbound row → one timeline row", and it is now wired to its replacement:
//
//   the DELIVERY FRAME mints the row. `inject:request` gained six additive optional
//   fields (card P: created_at / source_text / entry_type / thumb_b64 / device_label /
//   target_pc_id, plus `mode` freed of its manual-only clause), so ONE frame carries
//   everything a row is made of; `socket::row_transit` (Rust) builds the row AFTER
//   `run_inject` resolves and forwards it on the SAME bridge channel the server's
//   broadcast used. The channel stamp, the envelope and this method are unchanged.
//
// TWO RULES THE PRODUCER GUARANTEES, restated here because this is where they are
// visible: the row is born WITH its true verdict (there is no moment where a row exists
// saying "not injected · buffered" while nothing was cached and nothing was decided), and one
// `inject:result` makes exactly one row (a deduped frame answers nobody and makes no
// row; a REFUSED frame answers and therefore does make one).
//
// BOTH SERVERS, AND EVERY ROW SAYS WHICH (owner 2026-07-30 ① + RV-01).
// "the timeline = every message delivered to this PC, independent of which phone
// is currently connected". Two resident channels are
// two servers, so this store holds BOTH sides' rows, each stamped with the channel
// that carried it. `(channel, id)` is a row's only ADDRESS (the Map key) and it stays
// load-bearing after the verbs are gone: it is how `inject:result` finds the row whose
// delivery it is reporting, and how the page keys its own list and selection. It used
// to hold only the channel carrying the runtime, which answered a different question:
// "what's on the server of whichever phone is current" — rows this PC really
// received vanished when a phone
// joined on the other channel.
//
// SEARCH IS A FILTER OVER THE ROWS THIS PC OWNS (N6 → owner 2026-07-31).
// It was `history:list{query}` and the SERVER ran the LIKE, which is what made
// "no match" a statement about the timeline instead of about the page in hand. The
// server no longer holds transcripts, so that same call would now answer "no match" to
// every query ever typed — the same sentence, become a lie without one character of it
// changing. The predicate is lib/timeline-query.ts.

// The untrusted-input boundary lives in its own module (see there); this file is
// about WHAT THE STORE DOES with rows, never about parsing them. The PERSISTENCE
// boundary (guarded hydrate reads + the D8 quarantine) lives in timeline-hydration.
import { CHANNELS, rowKey } from './timeline-address';
import { asChannelTag, focusProvenanceOf, mapItem } from './timeline-normalize';
import { HydrationGuard, IMAGES_KEY, ROWS_KEY, RETENTION_KEY, hydrateTimeline } from './timeline-hydration';
import { makeQueryMatcher } from './timeline-query';
import {
  NO_CUTOFFS,
  combinedCutoff,
  horizonOf,
  planClear,
  purge,
  type ClearKind,
  type ClearWindow,
  type Cutoffs,
  type PurgeResult,
} from './timeline-purge';
import { planEviction } from './timeline-retention';
import { mergeIntoOwnedRow, refusedBy } from './timeline-row-merge';
import { IMAGE_IDS_MAX } from './timeline-store-surface';
import type { RetentionFacts, TimelineOpFailure } from './timeline-store-surface';
import type { InjectResultMiss, RowMintReport } from './timeline-reports';
import type {
  ChannelTag,
  InjectResult,
  ReportingKvStore,
  TimelineRow,
  TimelineTransport,
  WireHistoryItem,
} from './types';

/** The module's EXPORTED SURFACE — the two interfaces that stood above the class, the
 *  three re-export blocks, the persisted-keys note and the image-id bound — moved to
 *  timeline-store-surface.ts for the 800-line src cap, the same reason `asChannelTag`,
 *  the row merge and the reports moved out before it. Re-exported here so every
 *  importer still sees ONE path: TimelinePage.vue, capsule/controller.ts and
 *  main-window/store.ts have imported these names from this module since RV-01, and a
 *  split that made them learn a second path would be this file's convenience charged
 *  to its callers. */
export * from './timeline-store-surface';

export class TimelineStore {
  /** Rows of BOTH channels, keyed by [[rowKey]] — `(channel, id)`. */
  private readonly rows = new Map<string, TimelineRow>();
  private readonly listeners = new Set<() => void>();

  /** The current search term (`''` = not searching). The HITS are not stored: they
   *  are recomputed in [[entries]] from the rows, so a row that arrives, is edited
   *  into (or out of) a match, or is deleted cannot leave a stale hit behind. */
  private searchQuery = '';

  /** owner 2026-07-31 ② + C2: the newest instant this PC has dropped, PER KIND (null =
   *  never dropped one of that kind). Persisted; see RETENTION_KEY. */
  private cutoffs: Cutoffs = NO_CUTOFFS;
  /** owner 2026-07-31 ③: the LAST persist did not land (quota / private mode). The
   *  rows on screen are then memory-only and the page has to say so. */
  private persistFailed = false;

  /** R6 T-4: entry ids this PC delivered as an IMAGE, learned from the bridge's
   *  `inject:result.entry_kind`. It is kept SEPARATELY from `rows` because the two
   *  can arrive in either order: the row and the delivery verdict for it are two
   *  different frames. Without this set the chip would blink out — a row silently
   *  changing what it claims to be is exactly the kind of quiet lie the timeline
   *  must not tell. */
  private imageIds = new Set<string>();

  /** The last op that did NOT happen, for the page to state. Cleared by the view
   *  once shown / on the next successful op — never silently. */
  private failure: TimelineOpFailure | null = null;

  /** D8 — stands between [[persist]] and any key still holding corrupt bytes that
   *  could not be quarantined. Created before [[hydrate]] runs, lives as long as
   *  the store. */
  private readonly guard: HydrationGuard;

  constructor(
    private readonly transport: TimelineTransport,
    /** REPORTING (owner 2026-07-31 ③): an owner has to know whether its write
     *  landed. See ReportingKvStore for the failure a swallowing seam produces. */
    private readonly store: ReportingKvStore,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.guard = new HydrationGuard(store, this.now);
    this.hydrate();
    // Apply the bound AT BOOT, not at the first user action. A store that hydrated
    // 40 000 rows from an older build would otherwise render all of them and then
    // silently shed most on the next write — which is the "thought it was all
    // there" failure arriving
    // by a different door. This also makes [[retention]] true on the first paint.
    // D8: safe even against a corrupt payload — [[guard]] has either quarantined
    // its bytes by now or will withhold the overwrite.
    this.persist();
  }

  // ── persistence (07 §9 rows + the retention cutoff) ──
  /** Load what this machine holds. The four read sites and their D8 treatment live
   *  in lib/timeline-hydration.ts: a corrupt payload is copied to
   *  `<key>.corrupt-<timestamp>` BEFORE the boot persist above can overwrite it and
   *  the incident is logged ([[hydrateFaults]]); a missing key stays a silent clean
   *  first run; a payload that could not be secured blocks [[persist]] from ever
   *  writing over it. It used to be four reads in one try with an EMPTY catch —
   *  which turned any parse error into a silent wipe of the only copy. */
  private hydrate(): void {
    const h = hydrateTimeline(this.store, this.guard, this.rows);
    this.imageIds = h.imageIds;
    this.cutoffs = h.cutoffs;
    this.retiredQueueOps = h.retiredQueueOps;
  }

  /** How many ops the retired 0.2.26 change queue was holding when this store
   *  hydrated (`0` = none, `-1` = the key was there but unreadable). Kept so the
   *  wind-down leaves a trace the caller can log — a discard nobody can observe is
   *  the silent-failure shape, even when the discard is correct. */
  private retiredQueueOps = 0;
  get windedDownQueueOps(): number {
    return this.retiredQueueOps;
  }

  /** D8 — hydrate-time corruption incidents, one line each, for the caller to
   *  mirror into the forensic log (main-window/store.ts, the same seam that logs
   *  [[windedDownQueueOps]]). Already console.error'd at fault time, so the lines
   *  exist even without the mirror. Empty on a clean boot AND on a clean first
   *  run — a missing key is not an incident. */
  get hydrateFaults(): readonly string[] {
    return this.guard.faults;
  }

  /** Trim to the stated bound, then write. The two halves are ONE operation on
   *  purpose: what is held in memory and what is on disk must be the same set, or
   *  the page would show rows that will not survive a restart — the very lie the
   *  bound exists to avoid.
   *
   *  Every write's verdict is read. A `false` from either key means this store's rows
   *  are memory-only right now, and [[storageFailed]] says so; it is cleared only by
   *  a write that really lands.
   *
   *  D8: the writes go through [[guard]], which WITHHOLDS one while its key still
   *  holds a corrupt payload that could not be quarantined — destroying the only
   *  copy of the user's records is worse than not persisting this session. A
   *  withheld write answers `false`, so the page states memory-only exactly as it
   *  does for a refused write, which is then literally true. */
  private persist(): void {
    this.evict();
    const okRows = this.guard.write(ROWS_KEY, JSON.stringify([...this.rows.values()]));
    const okImages = this.guard.write(IMAGES_KEY, JSON.stringify([...this.imageIds]));
    const okCutoff = this.guard.write(RETENTION_KEY, JSON.stringify(this.cutoffs));
    this.persistFailed = !(okRows && okImages && okCutoff);
  }

  /** 🔴 C2 — the ONE call into the ONE deleter (lib/timeline-purge.ts). All three
   *  triggers (capacity eviction, single-row delete, user clear) come through here, so
   *  "are this row's bytes gone" has one answer. G-21 was the second answer. */
  private drop(doomed: readonly TimelineRow[], advance: ClearKind | null): PurgeResult {
    const out = purge(
      {
        rows: this.rows,
        imageIds: this.imageIds,
        dropPictures: (ids) => this.transport.dropRowImages(ids),
        keyOf: (r) => rowKey(r.channel, r.id),
      },
      doomed,
      advance,
      this.cutoffs,
    );
    this.cutoffs = out.cutoffs;
    return out;
  }

  /** Trigger ①: drop the rows past the bound, oldest-first. Capacity, not kind —
   *  hence `'both'`. RV-93 "when a row gets trimmed, its bytes go with it" is now
   *  the deleter's job, not this
   *  method's, and it applies to the other two triggers too. */
  private evict(): void {
    this.drop(planEviction([...this.rows.values()]), 'both');
  }

  /** Trigger ③ — owner 2026-08-01 §4-4: clear transcript text / clear images, the
   *  two-way choice can be exercised independently, by age.
   *
   *  Returns what it did (never what it intended): the page reports these numbers, and
   *  book 16 §6.2-5 forbids showing a freed-bytes figure that was not measured. The rows
   *  are chosen by [[planClear]] — the SAME function the confirmation dialog counted,
   *  so "will delete N rows" and "deleted N rows" cannot disagree. */
  clear(kind: ClearKind, window: ClearWindow): PurgeResult {
    const doomed = planClear([...this.rows.values()], kind, horizonOf(window, this.now()));
    const out = this.drop(doomed, kind);
    if (out.removed > 0) {
      this.persist();
      this.notify();
    }
    return out;
  }

  /** What a clear WOULD remove, without removing it. Same selector, same rows. */
  previewClear(kind: ClearKind, window: ClearWindow): TimelineRow[] {
    return planClear([...this.rows.values()], kind, horizonOf(window, this.now()));
  }

  // RV-76 — THE CUTOFF NO LONGER REFUSES AN ARRIVING ROW, and the guard that did is
  // deleted rather than left unreferenced.
  //
  // `private evicted(item)` returned true for any inbound row at or older than
  // [[cutoff]], and [[onHistoryUpdated]] dropped it — silently. That was right while
  // this store was a CACHE: the only producer was a server re-broadcasting its table,
  // so an old row arriving really was a row this PC had already given up, coming back.
  // There is no such producer any more. The one producer is a DELIVERY FRAME
  // (socket::row_transit), and its `created_at` is the moment the phone SPOKE — which
  // for a queued re-delivery is days ago by design (owner: "no matter how much
  // time has passed, everything must be delivered").
  // So the guard was refusing rows whose text had just been typed into the user's
  // window, at any store size, with no log line: the text got typed in, the row
  // got refused, zero log lines.
  //
  // Lead controller's 2026-07-31 ruling: "a row that just succeeded in delivery"
  // beats "older than the cutoff" — trimming means "old things
  // may go", not "a newly arrived thing that calls itself old may go".
  //
  // ⚠️ THE BOUND ITSELF IS UNTOUCHED (owner ②). [[persist]] still trims, and a row that
  // does not survive that trim is reported as [[RowMintReport.evictedOnArrival]] — the
  // residual case is loud instead of gone.

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  /** What the page shows, newest-first (created_at desc): every row this PC received
   *  over EITHER channel (owner ①) — or, while a search is active, the matching ones.
   *  Each row carries its own channel, which is how the page can label them.
   *
   *  The hits are DERIVED here, every read. That is the difference between this and
   *  a stored hit set: a row that arrives mid-search, an edit that makes a row stop
   *  matching, and a delete all take effect with no bookkeeping to forget — and there
   *  is no second answer to "which rows are hits" that could disagree with the rows. */
  entries(): TimelineRow[] {
    const matches = makeQueryMatcher(this.searchQuery);
    const rows = [...this.rows.values()].filter((r) => matches(r));
    return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  /** EVERY row this PC holds, unfiltered — the ASSET WALKER's input (book 16 §6).
   *
   *  🔴 NOT [[entries]], and the difference is the point: `entries` is filtered by
   *  the live search term, so an export driven by it would quietly write out only
   *  what matched a box the user typed in five minutes ago. A COPY, unsorted (the
   *  caller owns the order). READ-ONLY — no write, no persist, no notify. */
  allRows(): TimelineRow[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }

  /** Whether this PC already holds `(channel, id)` — the import's idempotency
   *  criterion (book 16 §5.1: "is this row already in the store", not "have I
   *  imported this file before"). READ-ONLY. */
  hasRow(channel: ChannelTag, id: string): boolean {
    return this.rows.has(rowKey(channel, id));
  }

  /** The term being searched (`''` = not searching). */
  get query(): string {
    return this.searchQuery;
  }

  /** owner 2026-07-31 ②③ — what this PC actually holds, for the page to state. */
  get retention(): RetentionFacts {
    return { kept: this.rows.size, cutoff: combinedCutoff(this.cutoffs), cutoffs: this.cutoffs };
  }
  /** owner 2026-07-31 ③ — the last write did NOT land: the rows on screen exist only
   *  in this window's memory. Never true just because storage is empty. */
  get storageFailed(): boolean {
    return this.persistFailed;
  }
  /** The last op that did not happen (null = nothing to say). */
  get lastFailure(): TimelineOpFailure | null {
    return this.failure;
  }
  /** Dismiss the failure line (the view's × / the next user gesture). */
  clearFailure(): void {
    if (this.failure === null) return;
    this.failure = null;
    this.notify();
  }

  private fail(id: string, channel: ChannelTag): void {
    this.failure = { op: 'inject', id, channel };
    this.notify();
  }

  /** Run a search (`''` clears it, see [[clearSearch]]).
   *
   *  SYNCHRONOUS, and that is a behaviour change with a visible consequence: there is
   *  no longer a "searching…" state, because there is no longer a moment where the
   *  question has been asked and the answer is unknown. That sentence existed to stop
   *  the page saying "no match" about a round trip still in flight; with the rows in
   *  hand, an empty result IS the answer, and its copy was retired with the round
   *  trip (lib/strings/search.ts). What DOES still need saying is the fourth state
   *  the bound introduced — "this machine has only kept the most recent N rows" —
   *  see [[retention]]. */
  search(query: string): void {
    const next = query.trim();
    if (next === this.searchQuery) return;
    this.searchQuery = next;
    this.notify();
  }

  /** Leave search mode and show the full timeline again. */
  clearSearch(): void {
    if (this.searchQuery === '') return;
    this.searchQuery = '';
    this.notify();
  }

  /** Record an id as image-delivered, and mark any row already held under that id.
   *
   *  The MARK is applied here rather than left for a later frame to carry in: a row
   *  that arrived BEFORE its inject:result would otherwise keep saying "text" forever —
   *  a row quietly claiming to be something it is not, which is the lie the timeline
   *  exists to prevent.
   *
   *  Applied to every row sharing the bare id, on both channels, deliberately: unlike
   *  `status` (a delivery verdict that must be addressed, RV-01), the KIND is a display
   *  fact this PC knows about the bytes it pasted, and it is kept keyed by bare id
   *  precisely so it survives a frame that carries no channel stamp.
   *
   *  The set is bounded; losing the oldest chip is a display nuance, never a loss of
   *  delivery truth (that lives in `status`). Insertion order is Set iteration order. */
  private rememberImage(id: string): void {
    for (const c of CHANNELS) {
      const r = this.rows.get(rowKey(c, id));
      if (r) r.entry_type = 'image';
    }
    if (this.imageIds.has(id)) return;
    this.imageIds.add(id);
    while (this.imageIds.size > IMAGE_IDS_MAX) {
      const oldest = this.imageIds.values().next();
      if (oldest.done === true) break;
      this.imageIds.delete(oldest.value);
    }
  }

  // ── four ops (07 §9) — three of them purely local since 0.2.27 ──
  /** copy: returns the text to place on the clipboard (the DOM write is the view's
   *  job); no server round-trip and never was one. Addressed by `(channel, id)` like
   *  every other op — with both servers' rows in one list, an id alone could name two
   *  rows. */
  textOf(id: string, channel: ChannelTag): string | null {
    return this.rows.get(rowKey(channel, id))?.output_text ?? null;
  }

  /** The row this store holds at `(channel, id)`, or null.
   *
   *  RV-01: the caller passes the channel it read off the row it clicked, and the
   *  lookup is by the full address — so an op can never land on the other server's
   *  row that happens to share an id. */
  private addressed(id: string, channel: ChannelTag): TimelineRow | null {
    return this.rows.get(rowKey(channel, id)) ?? null;
  }

  /** edit: a LOCAL write, and the only write there is (0.2.27).
   *
   *  Synchronous on purpose. It used to be optimistic-plus-queue-plus-`history:update`,
   *  a shape that only made sense while a server held the authoritative copy; the
   *  three-way reconciliation it needed (and the "saved locally" promise it made) all existed
   *  to describe the gap between here and there. There is no there. `source_text` is
   *  still untouched (red line: immutable) and `edited` still records that the user changed the
   *  output — that bit is about the ROW, not about syncing.
   *
   *  A missing row is a no-op rather than a failure line: the page can only offer
   *  edit on a row it is rendering from this very store, so an id that is not here
   *  means the row was evicted or deleted between paint and click — nothing happened,
   *  and there is nothing the user could do about it. Returns whether it applied. */
  edit(id: string, text: string, channel: ChannelTag): boolean {
    const r = this.addressed(id, channel);
    if (!r) return false;
    r.output_text = text;
    r.edited = true;
    r.updated_at = new Date(this.now()).toISOString();
    this.persist();
    this.notify();
    return true;
  }

  /** Trigger ② — delete: a LOCAL removal; this machine held the only copy, so it is gone.
   *
   *  ⚠️ That is a stronger statement than it used to be, and the CONFIRMATION the page
   *  takes before calling this is what makes it honest: before 0.2.27 a delete removed
   *  one of two copies. Returns whether a row was removed, so the caller can tell the
   *  OTHER WINDOW (the capsule's incoming-records strip holds its own copies — see
   *  main-window/store.ts).
   *
   *  🔴 G-21 — this used to be the SECOND deletion path: it dropped the row and left the
   *  picture file on disk forever, while capacity eviction dropped both. It now goes
   *  through the one deleter. `advance = null`: "I deleted this one" says nothing about
   *  everything older than it, and moving the cutoff here would claim it did. */
  remove(id: string, channel: ChannelTag): boolean {
    const row = this.addressed(id, channel);
    if (!row) return false;
    this.drop([row], null);
    this.persist();
    this.notify();
    return true;
  }

  /** reInject / deferred delivery: run the LOCAL injection pipeline with this row's own text.
   *
   *  *** HUMAN-AUDIT SENSITIVE (injection path) ***
   *
   *  0.2.27 — no round trip. It was `history:inject{id}`: the server looked the text
   *  up in `transcript_history` and sent it back to this same PC as an
   *  `inject:request`. The server stores nothing now, and this store has been the
   *  owner of the text since 0.2.26, so the text goes straight to the pipeline
   *  (`transport.reInjectLocally` → the Rust `timeline_reinject` command → the very
   *  same `run_inject` an inbound `inject:request` runs, on the same focus FSM and
   *  dedup table). ONE decision path ⇒ `injected` keeps exactly one meaning — the hard
   *  constraint in docs/decisions/2026-07-30-rv45-is-an-optional-enhancement-…md.
   *
   *  The verdict comes back as the RESULT VALUE rather than over the bridge, and it is
   *  fed to the same [[onInjectResult]] the socket path feeds, stamped with the row's
   *  own channel (this store is the authority on that, and it already holds the row).
   *  Nothing is emitted on the wire: an `inject:result` answers an `inject:request`,
   *  and nobody asked for this delivery — see the Rust command's doc.
   *
   *  Deliberately NOT retried or queued: a re-inject types into whatever window is
   *  focused AT THE MOMENT it runs, so replaying one minutes later would paste into a
   *  window the user never chose. `null` (nothing was typed) is stated instead, and
   *  the button stays. */
  async reInject(id: string, channel: ChannelTag): Promise<void> {
    const row = this.addressed(id, channel);
    if (!row) {
      this.fail(id, channel);
      return;
    }
    // *** DEPTH GUARD, NOT A FIX FOR A REACHABLE BUG (B3-7 card report) ***
    //
    // RV-68 (src-tauri/socket/row_transit.rs `row_face`) made an image row's
    // `output_text` a real CAPTION (e.g. `🖼 PNG · 214 KB`) instead of the always-
    // empty string it used to be. That flips what this line below would do if it
    // ever ran on an image row: it used to type nothing, now it would type real
    // words the user never spoke into whatever window is focused, and report
    // `injected` — "claiming that picture was re-sent, while what actually got
    // typed was a line of descriptor text", exactly the second
    // shape of no silent failure (claiming a thing happened that did not).
    //
    // TODAY this line cannot run on an image row: the ONLY production caller of
    // `reInject` is TimelinePage.vue's button, and it is withheld by
    // `rowCanReinject` (`entry_type !== 'image'`) BEFORE this method is ever
    // called — that guard predates this card and this card does not touch it.
    // So this is depth, not a patch for something reachable today: the UI v-if
    // is a guard that holds against the ONE caller that exists, not against a
    // caller that does not exist yet. The guard belongs HERE, at the store, for
    // the same reason it belongs at the store on the phone
    // (apps/mobile/lib/src/session/manual_delivery.dart `reInject`:
    // `if (entry.isImage) return null;`, commented "the menu already withholds
    // the action; this is the guard that holds even if some future caller
    // forgets") — a menu/v-if is UI, and this store is not the view: any window,
    // any future button, any keyboard shortcut that ends up calling
    // `TimelineStore.reInject` must get the same answer without having to
    // remember to re-derive TimelinePage.vue's check.
    // 🔴 REQ-12-13 widened this from `=== 'image'` to 「not a transcript」: an
    // inequality on ONE known kind fails OPEN, so the day `entry_type` gained
    // `'control'` this guard let a remote-key row through — and re-injecting one
    // types its own face into the user's document.
    if (row.entry_type !== 'transcript') {
      this.fail(id, channel);
      return;
    }
    const result = await this.transport.reInjectLocally(row.output_text, id);
    if (result === null) {
      this.fail(id, channel);
      return;
    }
    // The store stamps the FULL address it already knows. The Rust side does not echo
    // either half back: `timeline_reinject` never routed anywhere (so it has nothing to
    // say about which server the row belongs to) and it mints no row (so it has no
    // `row_id` to hand over — unlike the socket path, where the producer of the row is
    // the producer of the address). A value pretending to answer a question it was only
    // handed is the shape this repo keeps paying for; here the store IS the authority.
    this.onInjectResult({ ...result, channel, row_id: id });
  }

  // ── inbound reconciliation ──
  /** One inbound row → one timeline row. THE ONLY WAY A NEW ROW ENTERS THIS STORE.
   *
   *  Its producer is `socket::row_transit::mint_row` (Rust), which builds the row from
   *  the `inject:request` that delivered the message and the truthful verdict of typing
   *  it, then forwards `{item, channel}` on `flowmic://history-updated` — the channel
   *  the server's retired broadcast used. See this file's header for why that handler
   *  was kept through the producer-less window rather than deleted and re-invented.
   *
   *  ── AN ARRIVING FRAME MAY CREATE A ROW; IT MAY NOT REWRITE ONE ──────────────
   *
   *  A NEW `(channel, id)` becomes a row exactly as the frame describes it. An
   *  EXISTING one is built from the row THIS PC HOLDS, and the frame may change only:
   *
   *    · `status` — and only FORWARD. `injected` records a physical act this machine
   *      really performed, and no later frame can un-type text that was typed. A queued
   *      re-delivery after a reconnect can honestly resolve to `cached` (the window
   *      moved on), and applying that would turn a true "injected" into a false
   *      "not injected · buffered" (card L7: the original text said "not
   *      delivered", which is a segment-① word — this side speaks segment ②
   *      exclusively, see docs/rebuild/15 §2.0) —
   *      "saying something that got done didn't get done". An UPGRADE (cached/failed → injected) does apply: that
   *      is a later delivery really succeeding.
   *    · DISPLAY BACKFILLS, and only from ABSENT to PRESENT — `thumb_b64`,
   *      `device_label`, `mobile_id`, and `entry_type` transcript→image. These add an
   *      answer where the row had none; none of them can contradict the user.
   *
   *  EVERYTHING ELSE IS FROZEN, `output_text` / `source_text` / `edited` above all.
   *  This is obligation ① at the top of this file read literally: a local edit is a fact
   *  THIS MACHINE established, exactly like `status`, and an inbound frame has no
   *  standing to revoke it. owner ⑦ ("changes or deletes on the PC are not synced
   *  to the phone") says the PC does not
   *  PUSH its edits out; it does not say the PC's row may be pushed back over. owner ⑧
   *  ("a phone-side edit has exactly one path: re-deliver") says how the phone
   *  gets NEW TEXT TYPED; it does not
   *  say the phone may rewrite this machine's record. Neither ruling licensed
   *  inbound-overwrites-local — our implementation simply did it on the way past, and it
   *  became reachable the moment this handler got a producer back, so it is fixed in the
   *  same round that introduced it. `mode` and `created_at` are frozen for the same
   *  reason (⚠️ consequence worth knowing: a row minted from a 0.2.28 frame carries the
   *  stated `mode` GUESS forever, even if a later frame from an upgraded phone would
   *  have said so — changing an existing row's mode is an overwrite, not a backfill).
   *
   *  🔴 UNRESOLVED, AND DELIBERATELY NOT DECIDED HERE (owner: open question): when the refused
   *  frame carried DIFFERENT text — a phone-side edit re-delivered per owner ⑧ — those
   *  new words were typed into the user's window and have NO VISIBLE RECORD on this PC.
   *  The obvious fix ("make it a NEW row") is a product question, not an implementation
   *  one: one `entry_id` ⇔ one row is the addressing premise `inject:result`
   *  reconciliation rests on (A-58), so changing it changes the correlation contract.
   *  This is a KNOWN gap, not an oversight — and it is not silent: the refusal is
   *  reported through the return value (see [[RowMintReport]]).
   *
   *  ⚠️ RV-72 CHANGED WHAT THE `id` ON THIS FRAME MEANS, and it changes how often the
   *  paragraph above applies: a row is addressed by the DELIVERY (`req:{request_id}`)
   *  rather than by the phone's `entry_id`, so a re-delivery of edited words is a NEW
   *  row instead of a refused overwrite. The freeze rule is unchanged and still load-
   *  bearing — an INJ-3 replay of ONE delivery still upserts one row.
   *
   *  `null` = no row exists for this frame, and that now has exactly ONE cause (a frame
   *  with no usable id, which a minted row cannot have). The caller records it. */
  onHistoryUpdated(item: WireHistoryItem, channel: ChannelTag): RowMintReport | null {
    const key = rowKey(channel, item.id);
    const prev = this.rows.get(key);
    const incoming = mapItem(item, channel, prev, this.imageIds.has(item.id));
    if (incoming === null) return null;
    const row = prev === undefined ? incoming : mergeIntoOwnedRow(prev, incoming);
    this.rows.set(key, row);
    this.persist();
    this.notify();
    return {
      id: row.id,
      channel,
      refusedFields: prev === undefined ? [] : refusedBy(prev, incoming),
      locallyEdited: prev?.edited === true,
      // Read AFTER the write: `persist` trims to the bound in the same call, so this
      // is the store's own verdict on whether the row it just took in survived — not a
      // prediction of the policy (RV-76).
      evictedOnArrival: !this.rows.has(key),
    };
  }

  /** ⚠️ NO PRODUCER SINCE 0.2.27 — and unlike its sibling [[onHistoryUpdated]], which
   *  got one back in the row-transit round, this one is NOT coming back: a delete has
   *  no delivery frame to ride, and owner ⑦ is explicit that a PC-side delete does not
   *  travel and a phone cannot delete a PC row.
   *
   *  `history:deleted` was a PEER delete: another socket in the room removed a row, so
   *  drop it here too. It never fired for this PC's own deletes (the server excludes
   *  the emitter from that broadcast), and a phone can no longer delete a PC row at
   *  all — the two timelines are independent now. Kept beside its sibling so the pair
   *  is retired or replaced together, never half. The user-visible problem it closed
   *  (a screen showing a record that no longer exists) is now handled LOCALLY: see
   *  [[remove]]'s return value and main-window/store.ts's cross-window notice.
   *
   *  🔴 C2 — it goes through the ONE deleter too. It is producer-less TODAY, and that
   *  is precisely why: a dormant fourth removal path is how G-21 gets re-introduced by
   *  a future card that gives it a producer back, and the fix costs one line now. */
  onHistoryDeleted(id: string, channel: ChannelTag): void {
    const row = this.addressed(id, channel);
    if (row) this.drop([row], null);
    this.persist();
    this.notify();
  }

  /** inject:result reconciliation. A verdict stamps its row's true delivery status +
   *  TARGET; status records DELIVERY TRUTH ONLY (red line), and with the rows owned locally
   *  THIS is the only writer of that truth — and the ONLY writer of `target` anywhere.
   *
   *  TWO CALLERS, ONE MEANING. The bridge forwards the results of injections the
   *  PHONE asked for; [[reInject]] hands over the result of one the user asked for
   *  HERE. Both are the output of the same `run_inject`, so `ok`/`mode`/`error` mean
   *  the same thing in both — which is the whole reason the local deferred delivery was built as a
   *  second CALLER and not a second pipeline.
   *
   *  ⚠️ ADDRESSED BY `(channel, row_id)`, NOT BY `entry_id` — RV-72. `entry_id` stopped
   *  being an address the moment a re-delivery started making a new row with the SAME
   *  entry_id (owner ②) — and it was never one for a frame that carries none:
   *  `build_inject_result` echoes `entry_id` only when the request had it, so every row
   *  minted under a `req:`/`local:` address ALREADY silently never got a window title,
   *  and that hole predates this card. The address is HANDED OVER by the producer (see
   *  InjectResult) rather than re-derived here — one rule, one implementation.
   *  A verdict that cannot be addressed updates nothing rather than guessing a row
   *  (guessing is exactly RV-01) and says which of the two ways it missed. */
  onInjectResult(result: InjectResult): InjectResultMiss | null {
    const id = result.row_id;
    if (id === undefined || id === '') return 'unaddressable';
    // R6 T-4: remember the KIND before the row lookup — the row and this verdict are
    // two different frames and can arrive in either order, and a fact dropped because
    // the row was not here yet is a fact lost forever. Kept keyed by the bare row id:
    // it is a display hint, and it must survive a frame that carries no channel stamp.
    if (result.entry_kind === 'image') this.rememberImage(id);
    const channel = asChannelTag(result.channel);
    if (channel === null) return 'unaddressable';
    const r = this.rows.get(rowKey(channel, id));
    if (!r) return 'no-such-row';
    if (result.entry_kind === 'image') r.entry_type = 'image';
    // 🔴 IJ-01 — "which window this attempt was aimed at / what it read" IS
    // WRITTEN FOR EVERY OUTCOME, and
    // the PLACEMENT is the fix: above the ok/!ok split, not inside either arm. Until
    // 2026-08-07 provenance was written only inside `if (result.ok)`, so the row that
    // most needed to explain itself — the one that did NOT land — was the one that
    // recorded nothing (design doc §3-B: "which window it injected into" was
    // deliberately discarded exactly when it was most needed).
    //
    // 🔴 `focusProvenanceOf` IS WHERE THE WINDOW TITLE IS DROPPED (owner ruling (c)).
    // This method calls `persist()`, so whatever it copies onto `r` is on disk; the
    // title stays on the wire for the capsule's this-time flash and reaches no row.
    // The projection is a pure function in timeline-normalize.ts so that rule has one
    // implementation and its own test — read its doc before changing this line.
    // `Object.assign` of a partial: an absent key does not erase what a previous
    // verdict on this row observed.
    Object.assign(r, focusProvenanceOf(result));
    if (result.ok) {
      r.status = 'injected';
      // book 15 §2.5e-4: the row landed, so there is no cause left to explain. Cleared
      // rather than left behind — a row that says "injected" while its tooltip still says
      // why it was not is the two-answers-one-question shape in miniature.
      r.cached_cause = null;
      if (result.inject_target) {
        r.target = {
          window_title: result.inject_target.window_title,
          process_name: result.inject_target.process_name,
          injected_at: result.inject_target.injected_at,
        };
      }
    } else {
      r.status = result.mode === 'cached' ? 'cached' : 'failed';
      // 🔴 owner 2026-08-02 (F1a) — WHY this row was not injected, kept on the row so
      // the answer survives the 1.5s capsule flash. The CODE is stored (not the
      // sentence) so the rendering follows a language switch — see TimelineRow.cached_cause.
      //
      // 🔴 CORRECTED 2026-08-19 — this used to keep the code for `cached` only, on the
      // justification "the ✗ face already names its own failure". That sentence was
      // true of the CAPSULE's ✗ flash (capsule.ts INJECT_FAIL_REASON, on screen 1.5s)
      // and never of the timeline row, whose ✗ face renders a bare 「未注入」 with no
      // reason anywhere (status.ts statusLine; types.ts §C-4-2 recorded the same
      // parenthetical dying on 2026-08-07 when owner deleted the word 「注入失败」).
      // So the one durable PC surface was the one place the answer could not reach —
      // while the phone has named this exact code since 0.2.53. Book 15 §2.5's row
      // for `failed` (「✗ 未注入 · <具名原因>」, sentence from INJECT_FAIL_REASON) and
      // the wording spec §C-2 already required the row to carry it; this line is the
      // implementation catching up to the contract, not a new claim.
      r.cached_cause = result.error ?? null;
    }
    this.persist();
    this.notify();
    return null;
  }
}
