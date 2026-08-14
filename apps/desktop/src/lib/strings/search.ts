// S string catalogue shard: timeline search (N6 / owner requirement ③, 2026-07-30).
// Merged and exported by ../strings.ts — that remains the only external entry point.
//
// Why this gets its own shard instead of being folded into timeline.ts:
// this round timeline.ts belongs to a different card (status badges and the
// four-state copy) that's being edited in parallel, and two cards editing
// the same file at once would just trip over each other. The keys still
// carry the `tl_` prefix, because to the people using them, they're
// timeline-page copy either way.
//
// The empty states must not substitute for one another (the display-face
// version of the "no silent failure" red line):
//   · tl_search_none      = there genuinely are no matches;
//   · empty_timeline      = nothing was searched at all — the timeline was
//                           empty to begin with;
//   · the third sentence lives in timeline.ts's
//     TL_RETENTION_MSG.searchNoneTrimmed — "no matches, and this machine
//     only keeps the last N entries; anything older has been cleared."
//     Without it, "no matches found" is only half true once trimming has happened.
//
// ⛔ tl_search_searching (「正在搜索…」, "searching…") was retired by owner on
//    2026-07-31, not merged into anything. The reason it existed was the
//    moment when "the question has been sent to the server and the answer
//    is still in transit" — that moment stopped existing once search moved
//    local: `TimelineStore.search()` is synchronous, so the answer is
//    already in hand by the time it returns. Keeping a piece of copy that
//    can never render is the copy-facing shape of a façade (decision: this
//    round leaves nothing behind that "looks like it's still working").
import { shardCatalogue } from './shard';

export const SEARCH_KEYS = [
  'tl_search_ph',
  // owner 2026-07-31: the search scope is exactly the rows this computer
  // has stored — no longer "ask the server for the whole database." The
  // wording was changed to match the fact: saying "all messages" would
  // fold the trimmed-away ones into the promise too.
  'tl_search_hint',
  'tl_search_clear',
  'tl_search_none',
] as const;

export const SEARCH_STRINGS = shardCatalogue(SEARCH_KEYS);
