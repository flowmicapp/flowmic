<script setup lang="ts">
// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §6.1 (stats — the inventory
//     layer's second verb, with two 2026-08-02 revisions: grouping merged by
//     machine · duration returns to desktop via the delivery frame)
//   docs/strategy/2026-08-02-ui-batch1-rework-design.md §1.3/§1.4 (reworked
//     mockup: the machine-merge rule table + the prose-demotion list — this
//     file implements it as drawn; any deviation goes through the mockup first)
//   docs/strategy/2026-08-01-data-asset-lifecycle-design.md §4 (the definition
//     owner already ruled on), §5-1 (each end's definition is independent),
//     §5-3 (every cell has a real data source)
//
// Timeline → Data: this PC's statistics.
//
// 🔴 IT COMPUTES NOTHING. Every number comes from the asset walker
// (lib/portable/inventory.ts) — the SAME walk the export serialises and the clear
// deletes — so "stats says N rows" and "export produces N rows" cannot structurally
// disagree (master design §5-2).
// Word count = Σ rowWordCount, duration = Σ rowDurationMs — the very functions that
// render the per-row chips in TimelinePage.vue (§4b-8: "one algorithm, two display
// granularities").
//
// 🔴 Transcription duration (0.2.43, owner "speech duration needs to come back"):
// the delivery frame carries the phone's engine-reported `duration_ms` now, so the
// tile is REAL. Two §6.1 rules hold: rows without one stay OUT of the sum and are
// surfaced as "N more row(s) have no duration"; a store where NO row has one gets
// the explanation line, never a tile — a standing "0 minutes" would read as
// "I never spoke."
//
// 🔴 PROSE POLICY (reworked mockup §1.4): standing grey lines are ONLY the
// number-qualifiers users must not miss (the duration-gap note + `st_approx`).
// Everything else is a dotted-underline tooltip on the thing it qualifies.
//
// ⚠️ NO time-range tile any more — the range renders once, on the data panel's
// summary line right above this card (owner 2026-08-02 layout rework: the odd-sized
// range tile left a ragged second grid row, and the same dates stood ten pixels
// above it). This card is mounted nowhere else, so nothing lost the answer.

import { computed, onMounted, ref } from 'vue';
import { S } from '../../lib/strings';
import { mobileMachines, mobileNames, timeline } from '../store';
// Split forced by the 800-line cap, see bridge-portable.ts's file header.
import { portablePictureSizes } from '../../lib/bridge-portable';
import { formatRowDuration } from '../../lib/entry-metrics';
import {
  EMPTY_INVENTORY,
  formatBytes,
  formatCount,
  groupByMachine,
  pictureCandidates,
  summarize,
  walkAssets,
  type Inventory,
  type MachineGroup,
  type MachineRegistryEntry,
  type PictureFact,
} from '../../lib/portable/inventory';

/** Seeded SYNCHRONOUSLY from the store (text numbers need no bridge round-trip),
 *  so the first frame already answers — no flash of "0 rows" while refresh() is in
 *  flight. refresh() then re-walks with the measured picture bytes on top. */
const assets = ref(walkAssets(timeline.allRows(), new Map()));

/** Re-walk. Cheap: the sizes call is `metadata().len()` per kept picture, never a
 *  hash, and `pictureCandidates` only asks about rows that CLAIM one. */
async function refresh(): Promise<void> {
  const rows = timeline.allRows();
  const ids = pictureCandidates(rows);
  const sizes = ids.length > 0 ? await portablePictureSizes(ids) : [];
  const pictures = new Map<string, PictureFact>(sizes.map((p) => [p.id, { bytes: p.bytes, ext: p.ext }]));
  assets.value = walkAssets(rows, pictures);
}

defineExpose({ refresh });

const inv = computed<Inventory>(() => (assets.value.length === 0 ? EMPTY_INVENTORY : summarize(assets.value)));

/** The paired registry, in groupByMachine's shape. Names AND handset ids come from
 *  the same store refresh (pc:list-mobiles), so the breakdown can never pair a name
 *  with another row's machine. Resolved at render time — a renamed phone reads
 *  correctly on old rows, same rule senderLabel() follows. */
const registry = computed<Map<string, MachineRegistryEntry>>(() => {
  const m = new Map<string, MachineRegistryEntry>();
  for (const [pid, name] of Object.entries(mobileNames)) {
    m.set(pid, { name, deviceUid: mobileMachines[pid] ?? null });
  }
  return m;
});

/** Per source MACHINE (book 16 §6.1, 2026-08-02 revision) — one line per phone
 *  the user can name, plus at most one "other devices" and one "earlier
 *  records" line. Never a raw id. */
const groups = computed<MachineGroup[]>(() =>
  assets.value.length === 0 ? [] : groupByMachine(assets.value, registry.value),
);

function groupLabel(g: MachineGroup): string {
  if (g.kind === 'named') return g.name ?? '';
  if (g.kind === 'other') return S.st_other.replace('{n}', String(g.devices));
  return S.st_early;
}

function groupTip(g: MachineGroup): string | undefined {
  if (g.kind === 'other') return S.st_other_tip;
  if (g.kind === 'early') return S.st_early_tip;
  return undefined;
}

const missingPictures = computed(() => inv.value.images - inv.value.withPicture);

/** Picture-storage tile tooltip (§9b-6 — imageCount ≠ imageFileCount is a real
 *  historical fact). Standing paragraph demoted to a tooltip ON THE NUMBER it
 *  qualifies; the dotted marker on the tile says an explanation is there. */
const pictureTip = computed<string | undefined>(() =>
  missingPictures.value > 0 ? S.st_missing_pictures.replace('{n}', String(missingPictures.value)) : undefined,
);

/** Rows the duration sum does NOT cover — book 16 §6.1's "N more row(s)" obligation. */
const missingDuration = computed(() => inv.value.count - inv.value.withDuration);
</script>

<template>
  <div class="card pad">
    <!-- st_hint (each end's definition is independent) is the header's tooltip.
         ⚠️ NO dotted underline on headings — 0.2.44 put the affordance on every
         section title and the page read as a wall of hyperlinks (owner:
         "still hasn't changed"). Headings are headings; the dotted cue belongs
         to INLINE VALUES only (pm-seen / picture storage). -->
    <div class="sub-h" :title="S.st_hint">{{ S.st_title }}</div>

    <p v-if="inv.count === 0" class="muted small">{{ S.st_empty }}</p>
    <template v-else>
      <div class="grid">
        <div class="cell">
          <div class="n">{{ formatCount(inv.count) }}</div>
          <div class="k">{{ S.st_rows }}</div>
        </div>
        <div class="cell">
          <div class="n">{{ formatCount(inv.transcripts) }} / {{ formatCount(inv.images) }}</div>
          <div class="k">{{ S.st_transcripts }} / {{ S.st_images }}</div>
        </div>
        <div class="cell">
          <div class="n">{{ formatCount(inv.words) }}</div>
          <div class="k">{{ S.st_words }}</div>
        </div>
        <!-- 0.2.43 — real data source only (§5-3): no stamped row, no tile. -->
        <div v-if="inv.withDuration > 0" class="cell">
          <div class="n mono">{{ formatRowDuration(inv.durationMs) }}</div>
          <div class="k">{{ S.st_duration }}</div>
        </div>
        <div class="cell">
          <div class="n mono">{{ formatBytes(inv.textBytes) }}</div>
          <div class="k">{{ S.st_text_size }}</div>
        </div>
        <div v-if="inv.withPicture > 0" class="cell" :title="pictureTip">
          <div class="n mono" :class="{ 'has-tip': pictureTip }">{{ formatBytes(inv.pictureBytes) }}</div>
          <div class="k">{{ S.st_picture_size }}</div>
        </div>
      </div>

      <!-- Standing qualifiers (and ONLY these — prose policy above):
           the duration gap must be spoken (the user-visible face of "null is
           never treated as 0"), plus owner 2026-08-02's cross-language
           accuracy note, one sentence, both ends. -->
      <p v-if="inv.withDuration > 0 && missingDuration > 0" class="note small">
        {{ S.st_duration_missing.replace('{n}', formatCount(missingDuration)) }}
      </p>
      <p v-else-if="inv.withDuration === 0" class="note small">{{ S.st_duration_none }}</p>
      <p class="note small">{{ S.st_approx }}</p>

      <template v-if="groups.length > 1">
        <!-- 0.2.45 design version: an ACTUAL TABLE — header row + row dividers
             + numbers right-aligned in their column. The previous two versions
             either shoved the numbers to the card's far right (no structure,
             looked broken) or crammed the numbers next to the name (looked
             like floating loose characters). The header row and dividers are
             exactly the structure that makes right-alignment read as "a
             table" instead of "drifting." -->
        <div class="k by">{{ S.st_by_mobile }}</div>
        <div class="gtable">
          <div class="trow thead">
            <span></span>
            <span class="num">{{ S.st_rows }}</span>
            <span class="num">{{ S.st_words }}</span>
          </div>
          <div v-for="g in groups" :key="g.key" class="trow">
            <span class="who" :class="{ anon: g.kind !== 'named' }" :title="groupTip(g)">
              {{ groupLabel(g) }}
            </span>
            <span class="num">{{ formatCount(g.inventory.count) }} {{ S.st_unit_rows }}</span>
            <span class="num">{{ formatCount(g.inventory.words) }} {{ S.st_unit_words }}</span>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
/* History of the background-colour family (the four --s2-style undefined variables, fixed in 0.2.40) — see verify/lint/css-var-defined.mjs. */
/* Flex rather than grid (0.2.46, root cause caught by CDP real-device
   verification): at owner's actual window width, a grid would wrap the 5th
   cell into an orphan cell (with empty space beside it) — exactly the
   "stray wide cell" he originally circled. flex + grow makes **the wrapped
   cell automatically fill its own row**, so there is never an orphan or a
   gap at any width. */
.grid { display: flex; flex-wrap: wrap; gap: 10px; margin: 10px 0 4px; }
.cell { flex: 1 1 150px; min-width: 150px; background: var(--surface-inset); border-radius: 8px; padding: 10px 12px; }
.n { font-size: 20px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }
.k { font-size: 12px; color: var(--t3); margin-top: 2px; }
.k.by { margin: 12px 0 4px; }
/* Group table (0.2.45 design version): the whole card is monospaced-width,
   header row + thin row dividers, both number columns right-aligned. */
.gtable { border-top: 1px solid var(--line-soft); }
/* Column tracks in px, not em: each `.trow` is its own grid, and em would
   resolve to a different track width per row's font size (header 11.5px vs
   row 13px) ⇒ the same column's right edge would misalign row to row — a real
   defect a geometry assertion caught on the spot. */
.trow { display: grid; grid-template-columns: 1fr 96px 120px; gap: 0 16px; align-items: baseline;
  font-size: 13px; padding: 7px 2px; border-bottom: 1px solid var(--line-soft); }
.trow.thead { font-size: 11.5px; color: var(--t3); padding: 5px 2px; border-bottom: 1px solid var(--line); }
.trow:last-child { border-bottom: 0; }
.who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.who.anon { color: var(--t3); cursor: help; }
.num { color: var(--t2); text-align: right; font-variant-numeric: tabular-nums; }
.thead .num { color: var(--t3); }
.mono { font-variant-numeric: tabular-nums; }
.note { color: var(--t3); line-height: 1.6; margin-top: 8px; }
.note + .note { margin-top: 2px; }
.small { font-size: 12px; }
/* The "there's an explanation here" mark is reserved for **inline values**
   (the picture-storage number) — headings never carry it (0.2.45). */
.has-tip { text-decoration: underline dotted; text-underline-offset: 2px; cursor: help; }
.k.by { margin: 14px 0 2px; }
</style>
