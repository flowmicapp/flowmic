// SPEC-REF:
//   CLAUDE.md red line: no silent failure (both directions)
//   timeline-store.ts header: THIS PC OWNS THESE ROWS, AND NOTHING ELSE HAS A COPY
//
// Card D8 (0.3.0) — the timeline store's persistence boundary: the guarded reads the
// constructor hydrates from, and the quarantine that keeps a corrupt payload's bytes
// recoverable. Extracted from timeline-store.ts for the same reason as
// timeline-address / timeline-legacy-queue (the 800-line cap), and because the D8 fix
// lives exactly at this boundary.
//
// ── THE DEFECT THIS EXISTS TO PREVENT (D8) ──────────────────────────────────────
// hydrate() wrapped all four of its reads in ONE try with an EMPTY catch, and the
// constructor calls persist() immediately after. So a corrupt-but-possibly-
// recoverable payload — a truncated write, a foreign tool's edit, a shape no build
// ever wrote — threw at JSON.parse, was swallowed, and was then OVERWRITTEN with an
// empty array. Zero log lines, in the store this repo declares the SOLE OWNER of the
// user's records (its rows have no other copy since 0.2.26): silent destruction.
// The shared try also meant a corrupt FIRST key skipped the reads of perfectly good
// later keys, which the boot persist then also clobbered.
//
// ── THE RULE, per read site ─────────────────────────────────────────────────────
//   1. QUARANTINE FIRST. A payload that has bytes but no meaning is copied to a
//      sibling `<key>.corrupt-<timestamp>` BEFORE anything can overwrite the
//      original. The copy is byte-for-byte; nothing re-serializes it.
//   2. LOG LOUDLY. One fault line per incident: console.error at fault time, and
//      the same line is exposed via TimelineStore.hydrateFaults for
//      main-window/store.ts to mirror into window-forensics.log — the identical
//      seam that logs the queue wind-down count (no silent failure needs a reader).
//   3. NEVER CLOBBER UNSECURED BYTES. If the quarantine copy could not be written
//      (quota — the same failure family ReportingKvStore exists to report), every
//      later [[HydrationGuard.write]] to that key is WITHHELD and answers `false`,
//      so the page states storage failure — which is then literally true: the rows
//      on screen are memory-only. Each write retries the quarantine first, so a
//      recovered store resumes persisting the moment the bytes are safe.
//   4. A MISSING KEY IS A CLEAN FIRST RUN, NOT CORRUPTION. `null` boots empty and
//      stays silent, exactly as it always has — a fresh install must not open with
//      a corruption alarm.
//
// ⚠️ Quarantine copies are never cleaned up automatically: deleting what may be the
// only copy of a user's records is an owner decision, not housekeeping (book 16: one
// deletion path, user-triggered). They are small, rare, and inert — no reader.
//
// ⚠️ KNOWN LIMIT: the production store (lib/storage.ts localKv) swallows READ
// exceptions into `null`, so through IT a genuinely unreadable localStorage is
// indistinguishable from a clean first run — the read-error arm below can only fire
// for a store that throws. Stated here rather than "fixed": making localKv.get
// report would change every consumer's contract, which is not this card.

import { QUEUE_KEY, windDownRetiredQueue } from './timeline-legacy-queue';
import { normalizeCachedRow } from './timeline-normalize';
import { NO_CUTOFFS, readCutoffs, type Cutoffs } from './timeline-purge';
import { rowKey } from './timeline-address';
import type { ReportingKvStore, TimelineRow } from './types';

/** The rows. The literal is NOT renamed to match "owner" — see the timeline-store
 *  header: it is the address of data already sitting on users' machines, and
 *  renaming it would empty every existing timeline. */
export const ROWS_KEY = 'flowmic.history.cache';
/** The cutoffs (owner 2026-07-31 ② + C2). Persisted because "earlier records were
 *  cleared" is a durable fact about this machine — a restart must not turn it back
 *  into "there were never any earlier records", which is the sentence it exists to
 *  keep apart. */
export const RETENTION_KEY = 'flowmic.history.retention';
/** R6 T-4: ids this PC delivered as an IMAGE (see TimelineStore.imageIds). */
export const IMAGES_KEY = 'flowmic.history.images';

/** `<key>.corrupt-<timestamp>` — the sibling a condemned payload's bytes move to. */
const QUARANTINE_INFIX = '.corrupt-';

/** One-line, log-safe rendering of a caught throw (same shape as
 *  error-boundary.ts's, local because importing it would be a lie about scope). */
function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** The D8 guard. One instance per TimelineStore, living for the store's lifetime:
 *  it remembers which keys still hold UNSECURED corrupt bytes and stands between
 *  persist() and them. */
export class HydrationGuard {
  /** Keys whose corrupt payload is still sitting under the ORIGINAL key because
   *  the quarantine copy could not be written (or the key could not be read at
   *  all). Writes to these are withheld — overwriting would destroy the only copy. */
  private readonly held = new Set<string>();
  private readonly lines: string[] = [];

  constructor(
    private readonly store: ReportingKvStore,
    private readonly now: () => number,
  ) {}

  /** Hydrate-fault lines, one per incident, already console.error'd. Exposed via
   *  TimelineStore.hydrateFaults for the forensic mirror. */
  get faults(): readonly string[] {
    return this.lines;
  }

  isBlocked(key: string): boolean {
    return this.held.has(key);
  }

  private fault(line: string): void {
    this.lines.push(line);
    // Loud at the moment it happens, even if no caller ever reads [[faults]] —
    // the forensic mirror is the second copy, not the only one.
    console.error(`[flowmic] ${line}`);
  }

  /** Copy `raw` to a free `<key>.corrupt-<timestamp>` sibling. Returns the sibling
   *  key, or null when the store refused the write. An EXISTING sibling is never
   *  overwritten (it is an earlier incident's only copy); the suffix walks instead. */
  private stash(key: string, raw: string): string | null {
    const base = `${key}${QUARANTINE_INFIX}${this.now()}`;
    let candidate = base;
    for (let n = 2; this.store.get(candidate) !== null; n += 1) {
      if (n > 8) return null;
      candidate = `${base}.${n}`;
    }
    return this.store.set(candidate, raw) ? candidate : null;
  }

  /** A corrupt payload was found under `key`: secure the bytes, then say so. */
  condemn(key: string, raw: string, why: string): void {
    const to = this.stash(key, raw);
    if (to === null) {
      this.held.add(key);
      this.fault(
        `hydrate: corrupt payload under "${key}" (${why}) and the quarantine copy did NOT land — ` +
          'writes to this key are withheld so the original bytes survive',
      );
    } else {
      this.fault(
        `hydrate: corrupt payload under "${key}" (${why}) — original bytes quarantined to "${to}"; ` +
          'booting this key empty',
      );
    }
  }

  /** The key could not even be READ. No bytes in hand to quarantine, so the only
   *  protection left is refusing to overwrite whatever is there. A read error is
   *  NOT a first run: absent is `null`, and `null` never lands here. */
  hold(key: string, why: string): void {
    this.held.add(key);
    this.fault(
      `hydrate: reading "${key}" failed (${why}) — writes to this key are withheld so whatever it holds survives`,
    );
  }

  /** Guarded read. `null` = nothing usable — either a silent clean first run
   *  (missing key) or an incident that has already been quarantined/held + logged;
   *  [[isBlocked]] tells the two apart where a caller must not overwrite. */
  read(key: string): { raw: string; parsed: unknown } | null {
    let raw: string | null;
    try {
      raw = this.store.get(key);
    } catch (e) {
      this.hold(key, describe(e));
      return null;
    }
    if (raw === null) return null; // clean first run — stays silent
    try {
      return { raw, parsed: JSON.parse(raw) as unknown };
    } catch (e) {
      this.condemn(key, raw, describe(e));
      return null;
    }
  }

  /** The store's ONE write door (persist goes through here). On a held key it
   *  retries the quarantine first — the corrupt bytes are still under the key —
   *  and only a SECURED key may be overwritten. `false` = the value is NOT in the
   *  store, exactly as ReportingKvStore.set means it. */
  write(key: string, value: string): boolean {
    if (this.held.has(key)) {
      let raw: string | null;
      try {
        raw = this.store.get(key);
      } catch {
        return false; // still unreadable ⇒ still untouchable
      }
      if (raw !== null) {
        const to = this.stash(key, raw);
        if (to === null) return false; // bytes still unsecured ⇒ withhold
        this.fault(`hydrate: the withheld payload under "${key}" is now quarantined to "${to}" — writes resume`);
      }
      // raw === null: the bytes vanished out from under us (storage cleared
      // externally); there is nothing left to protect.
      this.held.delete(key);
    }
    return this.store.set(key, value);
  }
}

export interface HydratedTimeline {
  imageIds: Set<string>;
  cutoffs: Cutoffs;
  /** See TimelineStore.windedDownQueueOps: 0 = none, -1 = there but unreadable. */
  retiredQueueOps: number;
}

/** The four hydrate read sites, each with the D8 treatment. `rows` is the store's
 *  own map, filled in place. Never throws: every arm degrades to empty AFTER the
 *  bytes are secured (or the key held), never before. */
export function hydrateTimeline(
  store: ReportingKvStore,
  guard: HydrationGuard,
  rows: Map<string, TimelineRow>,
): HydratedTimeline {
  // ── site 1: the rows — D8's blast radius: the ONLY copy of the user's records ──
  const cache = guard.read(ROWS_KEY);
  if (cache !== null) {
    if (!Array.isArray(cache.parsed)) {
      // Valid JSON of a shape no build ever wrote is as corrupt as unparseable text.
      guard.condemn(ROWS_KEY, cache.raw, 'top level is not an array');
    } else {
      try {
        for (const raw of cache.parsed) {
          // Every cached row passes the normalizer — see normalizeCachedRow for why
          // the old `as TimelineRow[]` cast was the blank-page defect, and why an
          // untagged (pre-RV-01) row is dropped instead of being assumed to be LAN's.
          // owner 2026-07-30 ①: rows of BOTH channels are kept.
          const row = normalizeCachedRow(raw);
          if (row) rows.set(rowKey(row.channel, row.id), row);
        }
        // TOTAL loss from a NON-empty payload is indistinguishable from whole-file
        // corruption on the outcome that matters (every record gone), so it gets the
        // same protection. A PARTIAL drop stays the normalizer's documented per-row
        // verdict and raises no alarm — see the pinning test.
        if (cache.parsed.length > 0 && rows.size === 0) {
          guard.condemn(ROWS_KEY, cache.raw, `none of ${cache.parsed.length} row(s) was usable`);
        }
      } catch (e) {
        // Depth only — the normalizer is a total function. If it ever throws, the
        // half-hydrated set must not masquerade as the timeline (nor overwrite it).
        rows.clear();
        guard.condemn(ROWS_KEY, cache.raw, describe(e));
      }
    }
  }

  // ── site 2: the retired 0.2.26 change queue ──
  // windDownRetiredQueue overwrites the key with '[]' (so no later build can
  // resurrect the ops), which before D8 destroyed an unreadable payload's bytes.
  // The guarded read quarantines them FIRST; the wind-down's own answer (count /
  // -1 / '[]') is unchanged. Blocked = corrupt AND unsecured: the wind-down may
  // not run at all, because its overwrite is exactly the clobber being prevented.
  let retiredQueueOps: number;
  const queue = guard.read(QUEUE_KEY);
  if (queue === null && guard.isBlocked(QUEUE_KEY)) {
    retiredQueueOps = -1; // there but unreadable — and this boot may not touch it
  } else {
    try {
      retiredQueueOps = windDownRetiredQueue(store);
    } catch (e) {
      guard.hold(QUEUE_KEY, describe(e));
      retiredQueueOps = -1;
    }
  }

  // ── site 3: the image-id set ──
  let imageIds = new Set<string>();
  const img = guard.read(IMAGES_KEY);
  if (img !== null) {
    if (Array.isArray(img.parsed)) {
      imageIds = new Set(img.parsed.filter((v): v is string => typeof v === 'string'));
    } else {
      guard.condemn(IMAGES_KEY, img.raw, 'top level is not an array');
    }
  }

  // ── site 4: the retention cutoffs ──
  // Narrowed like every other value read back from disk, and the pre-C2 single
  // `{cutoff}` shape is translated rather than dropped — see readCutoffs (a total
  // function; the catch is depth, same as site 1's).
  let cutoffs: Cutoffs = NO_CUTOFFS;
  const ret = guard.read(RETENTION_KEY);
  if (ret !== null) {
    try {
      cutoffs = readCutoffs(ret.parsed);
    } catch (e) {
      guard.condemn(RETENTION_KEY, ret.raw, describe(e));
    }
  }

  return { imageIds, cutoffs, retiredQueueOps };
}
