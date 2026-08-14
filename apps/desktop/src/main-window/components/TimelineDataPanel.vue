<script setup lang="ts">
// SPEC-REF:
//   docs/strategy/2026-08-02-ui-batch1-rework-design.md §1.1 (owner ruling: data
//     gets its own page, toggled with the timeline list —— this component IS
//     that "data" view), §1.2 (summary shares its source), §1.4 (prose
//     demotion), §1.5 (clear's second-layer disclosure)
//
// The timeline page's "data" view: live summary → stats → export/import →
// clear entry point (second-layer disclosure). TimelinePage only owns
// switching between the two views; this file owns the data panel's own
// hierarchy.
//
// 🔴 The order is C2's ruling (master design §3 "4 before 5"): stats →
// export/import → clear. **Export is the safety net for clearing, and must
// sit above it** — a redesign must not casually reorder this.

import { computed, ref } from 'vue';
import TimelineStats from './TimelineStats.vue';
import DataPortability from './DataPortability.vue';
import TimelineClear from './TimelineClear.vue';
import { S } from '../../lib/strings';
import { entries, timeline } from '../store';
import { formatRowDuration } from '../../lib/entry-metrics';
import { formatCount, summarize, walkAssets } from '../../lib/portable/inventory';

/** Clear's second-layer disclosure (rare and irreversible ⇒ one more step of
 *  deliberate friction; the red warning and the tier pills should not compete
 *  for presence on every visit by an "occasional" user). Session-only, never
 *  persisted to settings. The TimelineClear component itself is unaware of the
 *  fold — its SSR first frame is still "the warning above the button" (the
 *  frame §6.2's test guards). */
const clearOpen = ref(false);

/** Stats must change along with a clear — a stats view that does not refresh
 *  would keep reporting the pre-clear numbers after a clear. */
const stats = ref<{ refresh: () => Promise<void> } | null>(null);

/** The view header's live summary: row count · word count · time range.
 *
 *  🔴 The SAME pair of inventory functions (walkAssets + summarize), not a
 *  second algorithm — the summary and the stats card must give only ONE answer
 *  to "how many rows" (this repo's #1 bug shape). Picture bytes are
 *  deliberately excluded from the summary: that requires an async bridge call,
 *  and this line must be computable synchronously.
 *  🔴 Reads allRows() rather than entries: entries is filtered by search
 *  (timeline-store.ts's own comment says so), and the summary answers for the
 *  WHOLE store. `void entries.value` does exactly one thing — it wires row
 *  changes into the reactive dependency graph; without it allRows() (an
 *  ordinary method call) would not trigger a recompute. */
const dataSummary = computed<string | null>(() => {
  void entries.value;
  const inv = summarize(walkAssets(timeline.allRows(), new Map()));
  if (inv.count === 0) return null;
  // 0.2.43 — the duration joins the headline once any row carries one; rows
  // without one are already excluded by the aggregator (null is never treated as 0).
  const dur = inv.withDuration > 0 ? ` · ${formatRowDuration(inv.durationMs)}` : '';
  const range = inv.earliest === null ? '' : ` · ${dayOf(inv.earliest)}${S.st_range_to}${dayOf(inv.latest ?? inv.earliest)}`;
  return `${formatCount(inv.count)} ${S.st_unit_rows} · ${formatCount(inv.words)} ${S.st_unit_words}${dur}${range}`;
});

/** `2026-06-02` — date only, same rendering rule as the stats range tile. */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}
</script>

<template>
  <div id="tl-data" class="tl-data">
    <!-- Live summary line (mockup §1.1): an empty store falls back to the invite-to-import hint. -->
    <div class="tl-data-sum" :class="{ live: dataSummary !== null }">{{ dataSummary ?? S.tl_data_hint }}</div>

    <TimelineStats ref="stats" />
    <DataPortability />

    <!-- Second layer: clear (rare and irreversible ⇒ one more step of
         deliberate friction, see clearOpen).
         0.2.45: the same card language as stats/export — the entry row is
         **the card's head** rather than a bare line sitting on the page
         (owner: "the layout still isn't right — a bare element makes this
         section look unfinished").
         cl_entry_hint is the safety-net notice — it appears BEFORE the danger
         zone is opened, not after. -->
    <div class="card pad clear-card">
      <button class="clr-head" type="button" :aria-expanded="clearOpen" @click="clearOpen = !clearOpen">
        <span class="clr-t">{{ S.cl_title }}</span>
        <span class="clr-hint">{{ S.cl_entry_hint }}</span>
        <span class="clr-chev" :class="{ open: clearOpen }">▾</span>
      </button>
      <TimelineClear v-if="clearOpen" @cleared="() => stats?.refresh()" />
    </div>
  </div>
</template>

<style scoped>
.tl-data { display: flex; flex-direction: column; gap: 10px; }
.tl-data-sum { font-size: 12px; color: var(--t3); line-height: 1.5; padding: 0 2px; }
/* A live summary reads more "data" than the empty-store hint: tabular-nums +
   one shade darker, so it reads as a value rather than as explanatory prose. */
.tl-data-sum.live { color: var(--t2); font-variant-numeric: tabular-nums; }

/* Clear card (0.2.45): the whole head row is clickable, the title is one
   shade of dark red (a "preview" of danger — the real red is said by
   TimelineClear's warning box once opened); the chevron sits on the right.
   Collapsed, it is just a narrow card speaking the same language as its
   neighbours. */
.clr-head { display: flex; align-items: baseline; gap: 10px; width: 100%; text-align: left;
  background: none; border: 0; padding: 0; cursor: pointer; }
.clr-t { font-size: 13px; font-weight: 600; color: var(--red-ink); flex: none; }
.clr-hint { font-size: 11.5px; color: var(--t3); min-width: 0; }
.clr-chev { margin-left: auto; flex: none; color: var(--t3); font-size: 11px; transition: transform .15s ease; }
.clr-chev.open { transform: rotate(180deg); }
</style>
