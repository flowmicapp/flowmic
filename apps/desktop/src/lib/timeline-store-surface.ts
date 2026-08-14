// The exported SURFACE of the timeline-store module — everything that stood between
// the imports and `class TimelineStore`: the two interfaces the page reads off the
// store (RetentionFacts / TimelineOpFailure), the three re-export blocks that keep
// every importer on ONE path, the note saying where the persisted keys went, and the
// image-id bound that sat with them.
//
// Split out of timeline-store.ts for the 800-line src cap (verify/lint/file-size.mjs
// SRC_MAX) — the SAME reason `asChannelTag`, the row merge and the reports moved out
// before it — and re-exported from timeline-store.ts so no importer has to learn a
// second path (TimelinePage.vue, capsule/controller.ts and main-window/store.ts have
// imported these names from that module since RV-01).
//
// NOTHING ELSE CHANGED: the block below is byte-identical to the lines it was moved
// from (timeline-store.ts as of the split commit's parent, lines 130-191), except
// that IMAGE_IDS_MAX gained `export` so the store can still read it. A diff that shows
// anything else is a bug, not a cleanup.

import type { Cutoffs } from './timeline-purge';
import type { ChannelTag } from './types';

/** Re-exported, not re-implemented: the capsule and main-window/store have imported
 *  `asChannelTag` from this module since RV-01, and it moved to timeline-normalize
 *  only because this file hit the 800-line cap. One binding, two paths — never a
 *  second copy of "which channel this is". */
export { asChannelTag } from './timeline-normalize';

/** What the page needs to state "what exactly this computer has stored" (owner 2026-07-31 ②).
 *
 *  Both numbers are facts about the store as it stands, not about the policy: they
 *  stay true whichever of the two limits bound, and the user can check them against
 *  their own memory. `cutoff === null` means nothing has EVER been evicted, which is
 *  a different sentence from "there were never any earlier ones" and must not be
 *  collapsed into it. */
export interface RetentionFacts {
  /** Rows held right now — in memory AND on disk; the two are kept identical. */
  kept: number;
  /** The newest `created_at` before which EVERY kind of row is gone from this machine,
   *  permanently — dropped for capacity or cleared by the user. `null` when no such
   *  instant exists, which since C2 includes "only images have ever been cleared":
   *  see [[cutoffs]]. */
  cutoff: string | null;
  /** C2 — the same fact PER KIND, because a two-way-choice clear touches only one of them and
   *  claiming otherwise would be a lie the single scalar could not even express
   *  (lib/timeline-purge.ts). The page states these when [[cutoff]] is null. */
  cutoffs: Cutoffs;
}

/** Re-exported for the same reason `asChannelTag` above is: the page has imported them
 *  from here since RV-01; they moved to timeline-address only because of the cap. */
export { addressOf, rowKey } from './timeline-address';

/** What the page must SAY when an op did not happen. A machine reason, not a
 *  sentence: the wording lives in the strings catalogue (lib/strings/timeline.ts),
 *  which is per-locale, and this module stays pure.
 *
 *  0.2.27 — there is exactly ONE op left that can fail. `edit` / `delete` are writes
 *  to this machine's own store and `refresh` no longer exists (nothing to pull), so
 *  their three failure sentences were retired with them: a copy string that can never
 *  render is a façade in the text layer (W2 rule). A storage refusal is a DIFFERENT
 *  statement — it is about every row, not one op — and it has always been
 *  [[storageFailed]]. */
export interface TimelineOpFailure {
  /** Deferred delivery: the delivery did not happen. The only remaining op with a remote-ish
   *  failure mode — and what it can fail at is TYPING (no reachable target, no
   *  resident session), never syncing. */
  op: 'inject';
  /** The row the failure is about. */
  id: string;
  /** The channel the row lives on — part of its address, not a route. */
  channel: ChannelTag;
}

/** Re-exported for the same reason `asChannelTag` above is: these two describe what
 *  the store ANSWERED, callers have imported them from here since RV-72, and they moved
 *  to timeline-reports only because of the 800-line cap. */
export type { InjectResultMiss, RowMintReport } from './timeline-reports';

// The three persisted keys (ROWS_KEY / RETENTION_KEY / IMAGES_KEY) moved to
// lib/timeline-hydration.ts with the reads that own their on-disk contract (D8);
// their WHY-comments — including why ROWS_KEY keeps its wrong name — moved with them.

/** Bound on the remembered image-id set. Losing the oldest chip is a display
 *  nuance, never a loss of delivery truth (that lives in `status`). */
export const IMAGE_IDS_MAX = 500;
