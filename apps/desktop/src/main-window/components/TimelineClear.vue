<script setup lang="ts">
// SPEC-REF:
//   🔴 docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §6.2 (clearing — five hard constraints)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md G-17 / RV-96
//   docs/decisions/2026-08-02-b5-stats-list-and-clear-all-options.md (the "all" tier is an assumption)
//
// Settings → Data: clear records. owner's RV-96 — the clear function he can
// see and operate.
//
// 🔴 IT DECIDES NOTHING ABOUT WHAT GETS DELETED. `previewClear` chooses the rows and
// `clear` deletes those same rows, both through TimelineStore → lib/timeline-purge.ts,
// the ONE deleter that capacity eviction also goes through (§6.2-1). This file picks a
// kind and a bucket and renders the answer.
//
// 🔴 §6.2-5 — "will free X" must be MEASURED bytes. The number below is Σ pictureBytes
// over the rows the preview selected, measured by `metadata().len()` through the
// walker — NOT count × average. A fake freed-bytes figure and a fake progress bar are
// the same thing.
//
// 🔴 §6.2-3 (2026-08-02 presentation revision, mockup 2026-08-02-ui-batch1-rework-design.md §1.5) —
// after clearing, this surface must still be able to say WHAT RANGE went: the compact
// cutoff line below, backed by the store's persisted per-kind cutoffs, so a restart
// cannot turn "cleared" into "was never there." It lives INSIDE the clear surface (the
// person asking "what got cleared" is the person who opened it), never as loose
// page-tail prose — that was the owner-rejected screen this replaces.
//
// 🔴 "N item(s) deleted" is an EVENT (flowmic-transient-notice-lifecycle): it describes
// the press that just happened, so it auto-hides after DONE_MS and can be dismissed — a
// standing "deleted" outlives its fact and reads as a claim about the next press.

import { computed, onUnmounted, ref, watch } from 'vue';
import { S } from '../../lib/strings';
import { timeline, timelineRetention } from '../store';
import { appendForensic } from '../../lib/bridge';
// Split forced by the 800-line cap, see bridge-portable.ts's file header.
import { portablePictureSizes } from '../../lib/bridge-portable';
import { CLEAR_WINDOWS, type ClearKind, type ClearWindow } from '../../lib/timeline-purge';
import { formatBytes, pictureCandidates, summarize, walkAssets, type PictureFact } from '../../lib/portable/inventory';

const emit = defineEmits<{ cleared: [] }>();

const KINDS: ClearKind[] = ['text', 'images', 'both'];

const kind = ref<ClearKind>('text');
const window = ref<ClearWindow>('month');
const confirming = ref(false);
const busy = ref(false);

// ── the transient "N item(s) deleted" banner (event-type — see header) ──────────────────
/** 4 s: long enough to read one short sentence, short enough that it is gone before
 *  the next glance — the same order of magnitude the mobile banner queue uses. */
const DONE_MS = 4000;
const done = ref<number | null>(null);
let doneTimer: ReturnType<typeof setTimeout> | null = null;
function showDone(removed: number): void {
  done.value = removed;
  if (doneTimer !== null) clearTimeout(doneTimer);
  // A re-trigger gets its FULL window, never the tail of the previous one.
  doneTimer = setTimeout(() => {
    done.value = null;
    doneTimer = null;
  }, DONE_MS);
}
function dismissDone(): void {
  if (doneTimer !== null) clearTimeout(doneTimer);
  doneTimer = null;
  done.value = null;
}
onUnmounted(() => {
  if (doneTimer !== null) clearTimeout(doneTimer);
});

/** The rows a clear would take, and the bytes they hold. Recomputed whenever the two
 *  selectors move — the dialog must never quote a count from a previous selection. */
const doomed = ref<{ rows: number; bytes: number }>({ rows: 0, bytes: 0 });

async function recount(): Promise<void> {
  done.value = null;
  const rows = timeline.previewClear(kind.value, window.value);
  const ids = pictureCandidates(rows);
  const sizes = ids.length > 0 ? await portablePictureSizes(ids) : [];
  const pictures = new Map<string, PictureFact>(sizes.map((p) => [p.id, { bytes: p.bytes, ext: p.ext }]));
  const inv = summarize(walkAssets(rows, pictures));
  // Text bytes count too: clearing transcripts frees bytes as surely as clearing
  // pictures does, and quoting only the picture half would understate a text clear
  // to zero — which reads as "this won't free anything at all."
  doomed.value = { rows: inv.count, bytes: inv.textBytes + inv.pictureBytes };
}

watch([kind, window], () => void recount(), { immediate: true });

function open(): void {
  if (doomed.value.rows === 0) return;
  confirming.value = true;
}

async function run(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const out = timeline.clear(kind.value, window.value);
    appendForensic(
      'timeline',
      `clear: kind=${kind.value} window=${window.value} removed=${out.removed} pictures=${out.picturesDropped}`,
    );
    confirming.value = false;
    emit('cleared');
    // Re-count against what is LEFT, so the panel does not keep offering to delete
    // rows that are already gone (button ⇔ bytes, §6.2-4 in its smallest form) — then
    // show the banner, since recount() clears any previous message by design.
    await recount();
    showDone(out.removed);
  } finally {
    busy.value = false;
  }
}

const previewText = computed(() => {
  if (doomed.value.rows === 0) return S.cl_nothing;
  const head = S.cl_preview.replace('{n}', String(doomed.value.rows));
  return doomed.value.bytes > 0 ? head + S.cl_frees.replace('{b}', formatBytes(doomed.value.bytes)) : head;
});

function winLabel(w: ClearWindow): string {
  switch (w) {
    case 'week': return S.cl_win_week;
    case 'month': return S.cl_win_month;
    case 'quarter': return S.cl_win_quarter;
    case 'halfYear': return S.cl_win_halfYear;
    case 'year': return S.cl_win_year;
    default: return S.cl_win_all;
  }
}

function kindLabel(k: ClearKind): string {
  return k === 'text' ? S.cl_kind_text : k === 'images' ? S.cl_kind_images : S.cl_kind_both;
}

/** `2026-01-05` — the day the cleared range ends. Date only, like the stats range. */
function day(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, 10);
}

/** §6.2-3 as ONE compact fact line (both kinds joined with ·) instead of two loose
 *  grey sentences — the sentences themselves are unchanged, and both still survive a
 *  restart because they read the store's persisted cutoffs and nothing else. */
const cutLine = computed<string>(() => {
  const cuts = timelineRetention.value.cutoffs;
  // The two cutoffs land on the same day (the most common case: cleared "both"
  // once) ⇒ merge into one sentence, don't state the date twice; only on
  // different days does each get its own sentence. No trailing "·" after the
  // period — "。·" is a connector for machines to read, not for a human
  // (owner's red-boxed note ②).
  if (cuts.text !== null && cuts.images !== null && day(cuts.text) === day(cuts.images)) {
    return S.cl_cleared_both.replace('{t}', day(cuts.text));
  }
  const parts: string[] = [];
  if (cuts.text !== null) parts.push(S.cl_cleared_text.replace('{t}', day(cuts.text)));
  if (cuts.images !== null) parts.push(S.cl_cleared_images.replace('{t}', day(cuts.images)));
  return parts.join(' ');
});
</script>

<template>
  <!-- 0.2.45: pure card body — the card shell (including the title/header row)
       belongs to TimelineDataPanel's clear-card; this starts from the warning.
       🔴 The warning is the first element, still above the button (book 16 §7-1). -->
  <div class="clear-body">
    <div class="warn" role="note">{{ S.cl_irreversible }}</div>

    <div class="picks">
      <div class="seg">
        <button
          v-for="k in KINDS"
          :key="k"
          class="pick"
          :class="{ on: kind === k }"
          type="button"
          @click="kind = k"
        >{{ kindLabel(k) }}</button>
      </div>
      <div class="seg">
        <button
          v-for="w in CLEAR_WINDOWS"
          :key="w"
          class="pick"
          :class="{ on: window === w }"
          type="button"
          @click="window = w"
        >{{ winLabel(w) }}</button>
      </div>
    </div>

    <p class="preview" :class="{ muted: doomed.rows === 0 }">{{ previewText }}</p>

    <button class="btn danger" type="button" :disabled="doomed.rows === 0 || busy" @click="open">
      {{ S.cl_btn }}
    </button>

    <!-- Event-type banner (auto-hides after ~4s + can be dismissed manually) — lifecycle in the file header. -->
    <div v-if="done !== null" class="cl-done" role="status">
      <span>{{ S.cl_done.replace('{n}', String(done)) }}</span>
      <button type="button" class="cl-done-x" :title="S.tl_fail_dismiss" @click="dismissDone">✕</button>
    </div>

    <!-- §6.2-3 cleared ≠ never existed: one compact line of fact, still true
         after a restart (reads the persisted cutoff). -->
    <p v-if="cutLine !== ''" class="muted small cuts">{{ cutLine }}</p>

    <div v-if="confirming" class="confirm">
      <div class="sub-h">{{ S.cl_confirm_title }}</div>
      <!-- The confirmation quotes the SAME preview the button was enabled by. -->
      <p class="small">{{ kindLabel(kind) }} · {{ winLabel(window) }} — {{ previewText }}</p>
      <p class="warn-line small">{{ S.cl_irreversible }}</p>
      <div class="acts">
        <button class="btn" type="button" @click="confirming = false">{{ S.cl_confirm_cancel }}</button>
        <button class="btn danger" type="button" :disabled="busy" @click="run">{{ S.cl_confirm_ok }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 🔴 owner 2026-08-02 UI batch 1 ③ "there are two blank strips above and below
   that group" — half of the root cause is here. This file referenced **four
   variables that do not exist in tokens.css**: `--s2` / `--b1` / `--danger` /
   `--ok`. An undefined var() does not error, it just voids the whole
   declaration:
     · `.warn`  —— the standing "irreversible" warning, both `background` and
                   `border-left` voided ⇒ a box with padding, with margin, and
                   nothing visible. **That is exactly the blank strip**, and it
                   happens to be the one sentence on this card that says "once
                   deleted by this action, it cannot come back."
     · `.pick`  —— an unselected tier pill has no border, looking like a row of
                   bare text.
     · `.confirm` / `.warn-line` / `.ok` —— the confirmation area has no
                   background colour, the danger sentence is not red, the
                   success sentence is not green.
   The corresponding real names (same meaning, not just something that looked similar):
     --s2 → --surface-inset (recessed info wells, exactly how tokens.css's own comment defines it)
     --b1 → --line          --danger → --red / --danger-line   --ok → --green
   `.warn` now reuses the `.tl-operr` set (--red-soft / --danger-line / --red-ink) —
   the whole repo already has this one look for "stating something irreversible,"
   no need to invent a second one.
   ⚠️ Regression guard: see `verify/lint/css-var-defined.mjs` (the 11th lint rule added this round). */
.warn { background: var(--red-soft); border: 1px solid var(--danger-line); border-left-width: 3px;
  border-radius: 6px; padding: 8px 10px; color: var(--red-ink); font-size: 12px; line-height: 1.6; margin: 8px 0; }
.picks { display: flex; flex-direction: column; gap: 8px; margin: 10px 0 6px; }
.seg { display: flex; flex-wrap: wrap; gap: 6px; }
.pick { border: 1px solid var(--line); background: transparent; color: var(--t2); border-radius: 999px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
.pick.on { background: var(--brand); border-color: var(--brand); color: var(--on-brand); }
.preview { font-size: 13px; margin: 6px 2px 10px; }
.acts { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
.confirm { margin-top: 12px; padding: 12px; background: var(--surface-inset); border-radius: 8px; }
.warn-line { color: var(--red); }
/* Event-type "N item(s) deleted" banner — green banner language (same token family as chip.key-chip), with a ✕. */
.cl-done { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding: 8px 10px;
  border-radius: 8px; background: var(--green-soft); color: var(--green-ink);
  font-size: 12.5px; font-weight: 600; line-height: 1.5; }
.cl-done-x { margin-left: auto; flex: none; border: 0; background: none; color: var(--green-ink);
  cursor: pointer; font-size: 12px; padding: 0 2px; }
.cuts { margin-top: 8px; }
.small { font-size: 12px; }
/* A disabled state must look disabled: when there is nothing to clear, that
   danger button used to render as a pink pill that looked clickable (owner's
   red-boxed note ②). */
.btn.danger:disabled { opacity: .4; cursor: default; }
.clear-body { margin-top: 10px; border-top: 1px solid var(--line-soft); padding-top: 4px; }
.confirm > .sub-h { margin-top: 0; }
</style>
