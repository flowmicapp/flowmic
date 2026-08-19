<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { formatTimelineLabel } from '@flowmic/protocol';
import Icon from './components/Icon.vue';
// owner 2026-08-02 UI batch 1 ③ + rework ruling: "Data becomes its own page,
// switchable with the timeline list": the data panel as a whole lives in
// <TimelineDataPanel> (the hierarchy and wiring of stats/export-import/clear are
// all inside it), and this page is only responsible for switching between the
// two views.
import TimelineDataPanel from './components/TimelineDataPanel.vue';
import {
  entries,
  mobileNames,
  rowImage,
  timeline,
  timelineFailure,
  timelineQuery,
  timelineRetention,
  timelineStorageFailed,
} from './store';
import { INJECT_FAIL_REASON, MODE_BADGE, S } from '../lib/strings';
import { TL_BATCH_MSG, TL_METRICS_MSG, TL_RETENTION_MSG } from '../lib/strings/timeline';
import { planBatchCopy, preCopyHint, resultMessage, selectedInOrder } from './batch-copy';
import { canReinject, reinjectLabel, statusBadge, statusLine } from '../lib/status';
import { cachedCauseTooltip, failedCauseInline, injectProvenanceTooltip } from '../lib/inject-provenance';
import { hasSourceLine } from '../lib/source-line';
import { matchesFilter, type TimelineFilter } from '../lib/timeline-filter';
import { CHANNEL_LABEL, CHANNEL_VISUAL } from '../lib/channel';
import { formatRowDuration, rowDurationMs, rowWordCount } from '../lib/entry-metrics';
// 0.2.27: a local delete is the only kind of delete, and the capsule strip holds its
// own copies — so the delete has to TELL the other window. See notifyRowRemoved.
import { notifyRowRemoved } from '../lib/bridge';
// owner 2026-07-30 ①: the page shows BOTH servers' rows, so a row's identity on screen
// is `(channel, id)` — the same address every op travels, imported from the store
// rather than re-derived here. Using the bare id as a `:key` (or as a selection /
// expand key) would let two rows from two servers share one piece of UI state.
import { addressOf as rowKey } from '../lib/timeline-store';
import type { TimelineRow } from '../lib/types';
/** The channel chip on each row (owner ① "each carries its own channel label") —
 *  the SAME two labels the device page and the capsule use, never a second wording. */
function channelLabel(e: TimelineRow): string {
  return CHANNEL_LABEL[e.channel];
}

/** owner 2026-08-01 §4-2 ⑧: per-row word count (measured against each mode's
 *  final result). The row is the whole
 *  input — entry-metrics.ts owns entry_type gating (image rows → 0) — so this is a
 *  bare pass-through, kept named for the same reason channelLabel() is: the template
 *  reads as "what this row IS", not "which function computed it". */
function wordCountOf(e: TimelineRow): number {
  return rowWordCount(e);
}

/** 0.2.43 (owner "voice duration needs to come back" + the per-row duration
 *  requirement): the row's speaking duration,
 *  through THE row-level function — the same one the statistics sum consumes
 *  (one algorithm, two display granularities). Null (typed/manual/image/pre-0.2.43
 *  rows) draws nothing: a "0s" chip would claim a measurement that was never taken. */
function durationOf(e: TimelineRow): number | null {
  return rowDurationMs(e);
}

// GA-20: five chips, per REDESIGN §5.2. The predicate lives in lib/timeline-filter
// (image selects on entry_type, not on mode — see there).
const filter = ref<TimelineFilter>('all');
// V2-07.8a: COMPUTED — a setup-time `label: S.filter_all` snapshot would keep
// the chips in the launch language after a locale switch.
const FILTERS = computed<Array<{ id: TimelineFilter; label: string }>>(() => [
  { id: 'all', label: S.filter_all },
  { id: 'realtime', label: S.filter_realtime },
  { id: 'translate', label: S.filter_translate },
  { id: 'organize', label: S.filter_organize },
  { id: 'image', label: S.filter_image },
]);

const filtered = computed<TimelineRow[]>(() =>
  entries.value.filter((e) => matchesFilter(e, filter.value)),
);

// ── Timeline search (N6 → owner 2026-07-31: local) ──────────────────────────────────
// The search is a filter over the rows THIS PC owns (lib/timeline-query.ts mirrors
// the LIKE clause it replaced). No debounce: there is no round trip left to coalesce,
// and `timeline.search()` returns with the answer already in hand.
const searchInput = ref('');
function onSearchInput(): void {
  timeline.search(searchInput.value);
}
function clearSearch(): void {
  searchInput.value = '';
  timeline.clearSearch();
}
/** True while a search is the current view (the box has a committed term). */
const searchActive = computed(() => timelineQuery.value !== '');

// ── owner 2026-07-31 ②: "where did the trimmed-away rows go" ──────────────────────────────────
// This PC owns the rows, so it has a bound, so it OWES the user a sentence. The two
// facts come from the store as facts (how many are kept, and the instant everything
// older than which is gone); the copy states those, never the policy.
/** The cutoff instant, formatted — null when nothing has EVER been evicted, which is
 *  a different thing from "there were never any earlier ones" and must not be
 *  rendered as it. */
const retentionWhen = computed<string | null>(() => {
  const c = timelineRetention.value.cutoff;
  return c === null ? null : formatTimelineLabel(c);
});
const retentionNote = computed<string | null>(() =>
  retentionWhen.value === null
    ? null
    : TL_RETENTION_MSG.keptNote(timelineRetention.value.kept, retentionWhen.value),
);
/** FOUR distinct states, deliberately not three (see strings/search.ts + timeline.ts):
 *  searched, no match / no match but this machine has only kept N rows / never
 *  searched at all (the timeline was empty to begin with) — and the retired fourth,
 *  "searching…", which stopped existing when the round trip did.
 *
 *  The middle one is the whole point: "no matching entries" on a trimmed store is
 *  half a truth, because the evicted rows were never in the search at all. */
const emptyLine = computed<string | null>(() => {
  if (filtered.value.length > 0) return null;
  if (searchActive.value) {
    return retentionWhen.value === null
      ? S.tl_search_none
      : TL_RETENTION_MSG.searchNoneTrimmed(timelineRetention.value.kept, retentionWhen.value);
  }
  return S.empty_timeline;
});
/** The standing retention line under the list. Hidden ONLY where the empty line above
 *  already says the same thing — never because it is inconvenient. */
const showRetention = computed(
  () => retentionNote.value !== null && !(searchActive.value && filtered.value.length === 0),
);

/** WHICH WINDOW to name on this row's status line.
 *
 *  TWO SOURCES, IN THIS ORDER, and the order carries a meaning:
 *   ① `target` — "where the text actually landed", present on `ok:true` only. The
 *      better answer when it exists, because it is where the text ACTUALLY went;
 *   ② `focus_process` — 🔴 IJ-01 / owner 2026-08-07: "which process the attempt was
 *      aimed at", present whatever the outcome. This is the one a NOT-injected row
 *      has, and it is the whole point of owner's addendum ①: before this, exactly
 *      the rows that needed to name
 *      a window were the rows that could not.
 *  A process name, never a window title, on branch ② — see TimelineRow.focus_process
 *  for why that asymmetry with ① is the ruling and not an omission.
 *  Both absent → null and no arrow is drawn, never a placeholder. */
function targetLabel(e: TimelineRow): string | null {
  return e.target?.window_title || e.target?.process_name || e.focus_process || null;
}

/// owner 2026-07-27: "the PC side needs the phone-instance-name → target mapping".
/// The PC knows which PC it is, so the row shows the OTHER leg.
///
/// TWO SOURCES, IN THIS ORDER, and the order is the point:
///  ① `mobile_id` resolved live from the paired-mobile map — a renamed phone then
///     reads correctly on old rows, and there is one source of truth for the name.
///  ② `device_label`, the label the sending phone stamped on the delivery frame
///     (card P/D). A row minted from a delivery frame has ONLY this: the relay
///     forwards the inject frame verbatim and it carries no pairing id.
/// They are never both present today, so ① first is not a tie-break so much as a
/// statement of which answer is better when one day they are. An unresolvable
/// `mobile_id` falls THROUGH to ② rather than to null — "this pairing can't be
/// found" is not "don't know which phone it was". Both absent → null and the chip
/// is simply not drawn, never a placeholder name.
function senderLabel(e: TimelineRow): string | null {
  return (e.mobile_id ? (mobileNames[e.mobile_id] ?? null) : null) ?? e.device_label;
}

/** The status chip's hover text. TWO questions, and a row can only ever answer one:
 *  "where did it get injected" (injected) or 🔴 "why didn't it get injected" (cached, owner 2026-08-02 F1a —
 *  book 15 §2.5e-4 requires cached's three causes to be distinguishable, and the badge
 *  alone shows one word for all three). `INJECT_FAIL_REASON` is the SAME table the
 *  capsule reads, so the two PC surfaces cannot drift (§2.5c). */
function provenanceTip(e: TimelineRow): string | null {
  return injectProvenanceTooltip(e.status, e.target)
    ?? cachedCauseTooltip(e.status, e.cached_cause, INJECT_FAIL_REASON);
}

/** 🔴 T-7: a row with a non-empty source_text that differs from its face can
 *  expand to show it. It used to also require `mode` to be translate/organize —
 *  a proxy that stopped being true the day a manual send could carry the
 *  pre-AI-transform text in any mode. See ../lib/source-line.ts for the whole
 *  argument and for the copy in CapsuleApp.vue this now shares. */
function canExpandSource(e: TimelineRow): boolean {
  return hasSourceLine({ source: e.source_text, face: e.output_text });
}

/** R6 T-4: an IMAGE row offers neither Re-inject nor Edit — the honest closing of the
 *  gap `canReinject`'s doc has always described ("except image rows, handled by
 *  the caller") and nobody had implemented.
 *
 *  history:inject re-sends the STORED ROW'S TEXT, and for a picture that text is
 *  its descriptor (`🖼 PNG · 214 KB`). Offering Re-inject would therefore type those
 *  characters into the focused window and report `injected` — a fabricated
 *  delivery of something that was never delivered.
 *
 *  ⚠️ Correction (RV-93): this used to add "the image bytes are not retained anywhere
 *  (they are pasted into the target app and dropped), so there is genuinely
 *  nothing to re-send". Since 2026-08-01 the delivered picture IS kept
 *  (socket::row_image) — so "nothing to re-send" is false, and what remains true
 *  is the sentence above it: this button's mechanism re-types TEXT, and for a
 *  picture row that text is its descriptor. A picture Re-inject would be a new
 *  capability (read the file → clipboard → paste), NOT a matter of relaxing this
 *  gate. Logged as a gap, not implied by silence.
 *  Editing is withheld for the same reason: the
 *  descriptor IS the row's content, and a row that says one thing while claiming
 *  to be another is the quiet lie the timeline exists to prevent. */
/*  🔴 REQ-12-13 — BOTH PREDICATES NOW NAME `transcript` POSITIVELY, and the flip is
 *  the point rather than a tidy-up. `!== 'image'` FAILS OPEN: the day `entry_type`
 *  gained a third value (`'control'` — a remote key press this PC executed) both
 *  buttons appeared on it for free, and Re-inject re-types the row's face, i.e. it
 *  would have typed "Clear" into whatever the user had focused. A whitelist cannot
 *  do that: a kind nobody has taught these two about gets no verbs at all, which is
 *  the safe direction for a control that acts on someone else's document.
 *  (The store keeps its own guard — timeline-store.ts `reInject` — because a v-if
 *  only covers the callers it renders.) */
function rowCanReinject(e: TimelineRow): boolean {
  return e.entry_type === 'transcript' && canReinject(e.status);
}
function rowCanEdit(e: TimelineRow): boolean {
  return e.entry_type === 'transcript';
}

/** REQ-12-13 — the remote-key row's FACE, composed here from the two structured
 *  fields the desktop stamped (`control_kind` / `control_outcome`).
 *
 *  Composed at RENDER time, never stored: a sentence written onto the row when it
 *  was minted would stay in the language that build ran in, and rows outlive a UI
 *  language switch (the getter-vs-snapshot lesson from lib/status.ts). It also keeps
 *  `output_text` empty, which is what structurally denies the re-injection path any
 *  text to type. */
const CONTROL_KEY_LABEL: Record<string, () => string> = {
  enter: () => S.ck_enter,
  backspace: () => S.ck_backspace,
  undo: () => S.ck_undo,
  clear: () => S.ck_clear,
  tab: () => S.ck_tab,
  space: () => S.ck_space,
};
const CONTROL_OUTCOME_NOTE: Record<string, () => string> = {
  no_target: () => S.co_no_target,
  foreground_refused: () => S.co_foreground_refused,
  os_refused: () => S.co_os_refused,
  send_failed: () => S.co_send_failed,
  not_primary: () => S.co_not_primary,
};
function controlFace(e: TimelineRow): string {
  // An unknown kind falls back to the raw token rather than to a blank row: a row
  // that cannot name its key is still evidence that a key was pressed, and printing
  // the identifier is how the next person finds out which one. (Same posture the
  // phone takes with an unregistered error code — never invent a sentence for it.)
  const label = CONTROL_KEY_LABEL[e.control_kind ?? '']?.() ?? e.control_kind ?? '';
  return `${S.tl_control_chip} · ${label}`;
}
/** The extra sentence a FAILED key press needs, or null. `sent` gets none on
 *  purpose: the status badge already says "input sent", and repeating it would be
 *  one fact said twice in two places that can drift. */
function controlNote(e: TimelineRow): string | null {
  return CONTROL_OUTCOME_NOTE[e.control_outcome ?? '']?.() ?? null;
}

// ── RV-01: an op that did not happen has to SAY so ──
// The three verbs return the owning server's ack now; the store keeps the last
// refusal and this maps it to a sentence. A getter map (not a snapshot) so the line
// follows a language switch, same reason MODE_BADGE.label is a getter.
const FAIL_TEXT: Record<NonNullable<typeof timelineFailure.value>['op'], string> = {
  get inject() { return S.tl_fail_inject; },
};
const failText = computed<string | null>(() =>
  timelineFailure.value === null ? null : FAIL_TEXT[timelineFailure.value.op],
);
function dismissFailure(): void {
  timeline.clearFailure();
}

// ── inline edit ──
// RV-01: the ROW is held, not just its id — the op has to travel the channel the
// user actually saw on it. Reading "which channel is current" at click time would be the same
// class of mistake all over again: primary can flip between the paint and the click.
const editing = ref<TimelineRow | null>(null);
const editText = ref('');
function startEdit(e: TimelineRow): void {
  editing.value = e;
  editText.value = e.output_text;
  // leave confirm-delete / expand alone — edit replaces the body
  confirming.value = null;
}
function saveEdit(): void {
  const row = editing.value;
  // 0.2.27: synchronous, and the boolean is "is this row still here" — false only when the row was
  // evicted or deleted between paint and click, which is nothing to report (see the
  // store's `edit`). Deliberately NOT paired with a notifyRowRemoved-style announcement:
  // the capsule strip can hold a stale TEXT for a row edited here, and it always could
  // (the server excluded the emitter from its `history:updated` broadcast, so our own
  // edit never came back to us either). Registered as a residual rather than patched
  // blind — the honest fix belongs with the decision about how a row ARRIVES.
  if (row !== null) timeline.edit(row.id, editText.value, row.channel);
  editing.value = null;
}
function cancelEdit(): void {
  editing.value = null;
}

// ── copy (owner 2026-07-27: the row button copies the PICTURE on a picture row) ──
const copiedId = ref<string | null>(null);
const copyError = ref('');

/** base64 → Blob without a fetch() round-trip through a data: URL. */
function pngBlob(b64: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

async function copy(e: TimelineRow): Promise<void> {
  copyError.value = '';
  try {
    if (e.thumb_b64 && typeof ClipboardItem !== 'undefined') {
      // The picture, not its "🖼 PNG · 78 KB" descriptor. Same honest ceiling as
      // the phone and the console: this is the bounded 256 px PREVIEW, because
      // the original bytes are pasted and dropped and live nowhere.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(e.thumb_b64) })]);
    } else {
      const text = timeline.textOf(e.id, e.channel);
      if (text === null) return;
      await navigator.clipboard.writeText(text);
    }
    copiedId.value = rowKey(e);
    setTimeout(() => {
      if (copiedId.value === rowKey(e)) copiedId.value = null;
    }, 1200);
  } catch (err) {
    // Was `/* clipboard unavailable — ignore */`: the button did nothing and
    // said nothing, which is indistinguishable from a successful copy.
    copyError.value = (err as Error).message || 'clipboard refused';
  }
}

// ── double-click a picture → fullscreen preview (owner 2026-07-27) ──
const zoomed = ref<TimelineRow | null>(null);
/** RV-93 — the DELIVERED picture (size B) for the row currently zoomed, as a data URL.
 *
 *  Null while it is being read, and for a row that has none — in BOTH cases the view
 *  falls back to the row's 256 px thumbnail, which is why this is one ref and not a
 *  loading flag plus an error: "only has the small picture" is a smaller picture,
 *  not a broken one, and nothing about it needs to be reported. */
const zoomedFull = ref<string | null>(null);
function toggleZoom(e: TimelineRow): void {
  if (!e.thumb_b64 && !e.full_image) return;
  const same = zoomed.value !== null && rowKey(zoomed.value) === rowKey(e);
  zoomed.value = same ? null : e;
  // Cleared FIRST, always: leaving the previous row's picture up while the next one
  // loads would show the wrong screenshot under the right caption.
  zoomedFull.value = null;
  if (same || !e.full_image) return;
  const opened = rowKey(e);
  void rowImage(e.id).then((url) => {
    // The user may have closed it (or opened another) while the disk read was in
    // flight — an answer that arrives for a row nobody is looking at is dropped.
    if (url !== null && zoomed.value !== null && rowKey(zoomed.value) === opened) {
      zoomedFull.value = url;
    }
  });
}
function onZoomKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape' && zoomed.value) zoomed.value = null;
}
onMounted(() => window.addEventListener('keydown', onZoomKey));
onUnmounted(() => window.removeEventListener('keydown', onZoomKey));

// ── source expand (organize / translate) ──
const expandedKeys = ref<Set<string>>(new Set());
function toggleSource(e: TimelineRow): void {
  const next = new Set(expandedKeys.value);
  const k = rowKey(e);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  expandedKeys.value = next;
}

// ── inline delete confirm (no modal) ──
const confirming = ref<TimelineRow | null>(null);
function askDelete(e: TimelineRow): void {
  confirming.value = e;
}
function cancelDelete(): void {
  confirming.value = null;
}
function confirmDelete(e: TimelineRow): void {
  // `(e.id, e.channel)` is the row's ADDRESS — both channels' rows are in one list.
  // 0.2.27: this PC held the only copy, so the removal is final the moment it returns
  // true; that is what the confirm step above is now buying. The OTHER window keeps
  // its own copies of recent rows, so it is told (main-window/store.ts).
  if (timeline.remove(e.id, e.channel)) notifyRowRemoved(e.id, e.channel);
  confirming.value = null;
}

function reInject(e: TimelineRow): void {
  void timeline.reInject(e.id, e.channel);
}
// 0.2.27: the "Refresh" button is GONE, and so is its string. It ran `history:list`
// against a server that stores no transcripts (owner's architecture ruling), so from the moment that
// landed it could only ever have re-fetched nothing — a button whose whole job has been
// deleted is the most literal façade there is. Nothing replaces it: the rows are this
// machine's own, so there is no elsewhere to re-read them from.

// ── V2-18 multi-select + batch copy (owner 2026-07-28 ①②③) ──
const selecting = ref(false);
const selectedKeys = ref<ReadonlySet<string>>(new Set());
const batchMsg = ref('');
const batchMsgKind = ref<'ok' | 'warn'>('ok');

/** Selected rows in DISPLAY order (see selectedInOrder). The count and the
 *  copy only ever cover rows that still exist — a row deleted by a refresh
 *  simply leaves the tally instead of being silently promised. */
const selectedRows = computed<TimelineRow[]>(() =>
  selectedInOrder(entries.value, selectedKeys.value, rowKey),
);
/** ③before: non-null while the selection holds a picture — shown on the bar. */
const selHint = computed(() => preCopyHint(selectedRows.value));

function toggleSelecting(): void {
  selecting.value = !selecting.value;
  // Entering: cancel any in-flight single-row op — .ops is hidden while
  // selecting, so the modes never coexist or fight over the same row.
  editing.value = null;
  confirming.value = null;
  selectedKeys.value = new Set();
  batchMsg.value = '';
}
function toggleOne(e: TimelineRow): void {
  const next = new Set(selectedKeys.value);
  const k = rowKey(e);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  selectedKeys.value = next;
  // A stale "Copied 3 items" beside a CHANGED selection would read as about that
  // selection — the message dies with any selection change.
  batchMsg.value = '';
}
function selectAll(): void {
  // Everything in the CURRENT filtered view — what the user is looking at.
  selectedKeys.value = new Set(filtered.value.map(rowKey));
  batchMsg.value = '';
}
function clearSelection(): void {
  selectedKeys.value = new Set();
  batchMsg.value = '';
}

/** ①batch copy. The payload is plan.text — one line per text row, display order,
 *  pictures skipped whole (②). The result message is set ONLY after the
 *  clipboard write resolves; a refused write goes to the red copyError line,
 *  never a green "Copied" (the existing single-row copy does the same). */
async function copySelected(): Promise<void> {
  batchMsg.value = '';
  copyError.value = '';
  const plan = planBatchCopy(selectedRows.value);
  if (plan.copied === 0) {
    // All pictures: the clipboard is left UNTOUCHED (clobbering it with an
    // empty string would be its own small lie) and the message says exactly
    // what happened — never "Copied 0 items" (③).
    batchMsgKind.value = 'warn';
    batchMsg.value = resultMessage(plan);
    return;
  }
  try {
    await navigator.clipboard.writeText(plan.text);
  } catch (err) {
    copyError.value = (err as Error).message || 'clipboard refused';
    return;
  }
  batchMsgKind.value = 'ok';
  batchMsg.value = resultMessage(plan);
}

// ── owner 2026-08-02 rework ruling: "Data becomes its own page, switchable with
// the timeline data list" ─────────────
//
// Shape = design doc 2026-08-02-ui-batch1-rework-design.md §1.1 (implemented as
// drawn; deviations get the design doc changed first): the same page has two
// views — "Timeline" (the row list) and "Data" (TimelineDataPanel) — switched via
// a two-segment control in the page header. The data panel **no longer hangs off
// the tail of the list** (owner's own words), and there is no fold bar either.
// In-session state, not persisted to settings: it answers "which side am I looking
// at right now", not a preference.
// The multi-select button only appears on the "Timeline" view — it acts on rows.
const view = ref<'rows' | 'data'>('rows');
</script>

<template>
  <div>
    <div class="page-head">
      <h2>{{ view === 'rows' ? S.timeline_title : S.tl_data_title }}</h2>
      <!-- owner 2026-08-02 ruling "becomes its own page, switchable with the
           timeline data list": a two-segment switch, the current segment
           highlighted. -->
      <span class="tl-views">
        <button class="vseg" :class="{ on: view === 'rows' }" type="button" @click="view = 'rows'">{{ S.timeline_title }}</button>
        <button class="vseg" :class="{ on: view === 'data' }" type="button" @click="view = 'data'">{{ S.tl_data_title }}</button>
      </span>
      <span v-if="view === 'rows'" style="margin-left:auto; display:flex; gap:8px">
        <button class="btn ghost sm" @click="toggleSelecting"><Icon name="check" />{{ selecting ? S.tl_select_done : S.tl_select }}</button>
      </span>
    </div>

    <template v-if="view === 'rows'">

    <div class="filters">
      <span v-for="f in FILTERS" :key="f.id" class="fchip" :class="{ on: filter === f.id }" @click="filter = f.id">
        {{ f.label }}
      </span>
    </div>

    <!-- Search (owner 2026-07-31: local). It filters the rows THIS PC owns, so "no
         match" is about the timeline — and when the store has trimmed, the empty
         line below says so, because the evicted rows were never in the search. -->
    <div class="tl-search">
      <Icon name="search" />
      <input
        v-model="searchInput"
        class="input tl-search-in"
        type="search"
        spellcheck="false"
        :placeholder="S.tl_search_ph"
        :title="S.tl_search_hint"
        @input="onSearchInput"
        @keyup.esc="clearSearch"
      />
      <button v-if="searchInput !== ''" class="btn ghost sm" @click="clearSearch">{{ S.tl_search_clear }}</button>
    </div>

    <!-- owner 2026-07-31 ③: the rows below did NOT reach local storage. Loud, and
         never auto-hidden: this PC owns the timeline now, so an unwritten row is a
         row that ceases to exist at the next restart — and "the UI looks like
         everything's fine" is the worst possible way for that to happen. -->
    <div v-if="timelineStorageFailed" class="tl-operr">{{ S.tl_store_write_failed }}</div>

    <!-- V2-18 selection bar (exists only while selecting). The picture hint is
         ON THE BAR before any click (③before) — the skip is known before the button
         is pressed, not discovered after. -->
    <div v-if="selecting" class="sel-bar">
      <span class="sel-count">{{ TL_BATCH_MSG.selCount(selectedRows.length) }}</span>
      <button class="btn ghost sm" @click="selectAll">{{ S.tl_sel_all }}</button>
      <button class="btn ghost sm" :disabled="selectedRows.length === 0" @click="clearSelection">{{ S.tl_sel_none }}</button>
      <span v-if="selHint" class="sel-hint">{{ selHint }}</span>
      <button class="btn pri sm sel-copy" :disabled="selectedRows.length === 0" @click="copySelected">
        <Icon name="copy" />{{ S.tl_sel_copy }}
      </button>
    </div>
    <!-- ③after: the result truth. ok = green, warn (all pictures) = amber; a
         refused write never reaches here — it goes to the red tl-copyerr. -->
    <div v-if="batchMsg" class="tl-batchmsg" :class="batchMsgKind">{{ batchMsg }}</div>

    <!-- A deferred delivery that did not happen says so (0.2.27: the only op left
         that can fail — edit and delete are writes to this machine's own store, and
         there is nothing to refresh). ABOVE the list, because it is about something
         the user just did to a row — and dismissible but never auto-hidden, since
         it is the only record they get that it did not happen. NOTE this is
         "nothing was ever typed", not "it was typed but didn't land": the latter is
         a real inject:result and shows up as the ROW's own "not injected" status. -->
    <div v-if="failText" class="tl-operr">
      <span>{{ failText }}</span>
      <button type="button" class="tl-operr-x" :title="S.tl_fail_dismiss" @click="dismissFailure">✕</button>
    </div>

    <div v-if="emptyLine" class="empty">{{ emptyLine }}</div>

    <div
      v-for="e in filtered"
      :key="rowKey(e)"
      class="card hrow"
      :class="{ confirming: confirming !== null && rowKey(confirming) === rowKey(e), selecting, selected: selecting && selectedKeys.has(rowKey(e)) }"
      @click="selecting && toggleOne(e)"
    >
      <!-- V2-18: the row-start checkbox exists only in selection mode; the whole
           row is the click target, the checkbox is its visible affordance.
           @click.stop so ticking it does not ALSO fire the row's toggle. -->
      <span v-if="selecting" class="selbox" @click.stop>
        <input type="checkbox" :checked="selectedKeys.has(rowKey(e))" :title="S.tl_select" @change="toggleOne(e)" />
      </span>
      <!-- 🔴 REQ-12-13: no mode badge on a remote-key row. Its `mode` is a
           structural filler (a keypress has no mode; book 15 §2.0-e) and the badge is
           otherwise UNCONDITIONAL, so without this v-if every key press would wear
           the Realtime waveform and read as something that was said — the exact defect
           the capsule strip already fixed once for pictures (capsule/recent-line.ts). -->
      <span
        v-if="e.entry_type !== 'control'"
        class="mbadge"
        :class="MODE_BADGE[e.mode]?.cls"
        :title="MODE_BADGE[e.mode]?.label"
      ><Icon :name="MODE_BADGE[e.mode]?.icon ?? ''" /></span>
      <div class="body">
        <div class="meta">
          <span>{{ formatTimelineLabel(e.created_at) }}</span>
          <span>·</span>
          <span class="dot" :class="statusBadge(e.status, e.focus_evidence).dot"></span>
          <!-- owner 2026-07-27: WHICH PHONE sent this. Before the status chip so
               the row reads left-to-right as phone → status → target, i.e. the actual
               path the utterance took. -->
          <span v-if="senderLabel(e)" class="sender-chip" :title="S.tl_sender_tip">{{ senderLabel(e) }} →</span>
          <span
            class="st-tag"
            :class="statusBadge(e.status, e.focus_evidence).cls"
            :title="provenanceTip(e) ?? undefined"
          >{{ statusLine(e.status, targetLabel(e), e.focus_evidence, failedCauseInline(e.status, e.cached_cause, INJECT_FAIL_REASON)) }}</span>
          <!-- owner 2026-07-30 ①: WHICH CHANNEL delivered this row. The page lists
               both servers now, and a row whose channel is invisible cannot be told
               apart from the other server's — the same address every op travels.
               owner 2026-08-01: colour + icon combination, must not rely on colour
               alone — CHANNEL_VISUAL (lib/channel.ts)
               is the ONE definition; the icon is a real different silhouette per
               channel, not the same glyph recoloured (readable in grayscale). -->
          <span class="chan-badge" :class="CHANNEL_VISUAL[e.channel].css" :title="channelLabel(e)">
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" v-html="CHANNEL_VISUAL[e.channel].iconPath"></svg>
            {{ channelLabel(e) }}
          </span>
          <!-- owner 2026-08-01 §4-2 ⑧: per-row word count (measured against each
               mode's final result, lib/entry-metrics.ts).
               Rows with 0 words / missing text draw nothing — must not draw "0
               words", that would be inventing a number for something that never happened. -->
          <span v-if="wordCountOf(e) > 0" class="wc-chip">{{ TL_METRICS_MSG.wordCount(wordCountOf(e)) }}</span>
          <!-- 0.2.43 per-row duration — same quiet weight as the word count, same
               grammar as the phone row (formatRowDuration mirrors formatEntryDuration). -->
          <span v-if="durationOf(e) !== null" class="wc-chip">{{ formatRowDuration(durationOf(e)!) }}</span>
          <!-- R6 T-4: the row was delivered as a picture, not typed text. -->
          <span v-if="e.entry_type === 'image'" class="img-chip">{{ S.tl_image_chip }}</span>
          <!-- REQ-12-13: the row records a REMOTE KEY PRESS, not something said.
               Same slot and same weight as the picture chip — it answers the same
               question ("what kind of row this is") and must not look like a status. -->
          <span v-if="e.entry_type === 'control'" class="img-chip">{{ S.tl_control_chip }}</span>
          <span v-if="e.edited" class="edited-mark"><Icon name="edit" />{{ S.edited }}</span>
          <!-- 0.2.27: the "saved locally" chip is gone with `pending`. It meant "this
               machine changed it and it hasn't been uplinked yet" and there is no
               uplink; every row would have worn it forever. -->
        </div>

        <template v-if="editing !== null && rowKey(editing) === rowKey(e)">
          <textarea class="edit-box" v-model="editText"></textarea>
          <div class="edit-actions">
            <button class="btn pri sm" @click="saveEdit">{{ S.op_save }}</button>
            <button class="btn ghost sm" @click="cancelEdit">{{ S.op_cancel }}</button>
          </div>
        </template>
        <template v-else-if="confirming !== null && rowKey(confirming) === rowKey(e)">
          <div class="txt">{{ e.output_text }}</div>
          <div class="del-confirm">
            <span>{{ S.tl_confirm_delete }}</span>
            <button class="btn danger sm" @click="confirmDelete(e)">{{ S.tl_confirm_yes }}</button>
            <button class="btn ghost sm" @click="cancelDelete">{{ S.op_cancel }}</button>
          </div>
        </template>
        <template v-else>
          <!-- owner 2026-07-27: a picture row shows the picture. Before this it
               showed its own descriptor as prose ("🖼 PNG · 78 KB"), which told
               you nothing about WHICH screenshot it was. The descriptor stays
               underneath as the caption — and as the whole row when a preview is
               missing, so a row without one degrades to what it always was
               rather than to a broken frame. -->
          <img
            v-if="e.entry_type === 'image' && e.thumb_b64"
            class="tl-thumb"
            :src="`data:image/png;base64,${e.thumb_b64}`"
            :alt="e.output_text"
            :title="S.tl_zoom_hint"
            @dblclick="toggleZoom(e)"
          />
          <!-- REQ-12-13 — a remote-key row's face is COMPOSED (controlFace), because
               nothing renderable is stored on it: `output_text` is `''` so the
               re-injection path has no text to find. The note appears only when the
               keys did NOT reach the window; a successful press is already answered
               by the status badge ("input sent"). -->
          <template v-if="e.entry_type === 'control'">
            <div class="txt">{{ controlFace(e) }}</div>
            <div v-if="controlNote(e)" class="src">{{ controlNote(e) }}</div>
          </template>
          <div v-else class="txt">{{ e.output_text }}</div>
          <button
            v-if="canExpandSource(e)"
            type="button"
            class="src-toggle"
            @click.stop="toggleSource(e)"
          >
            {{ expandedKeys.has(rowKey(e)) ? S.tl_hide_source : S.tl_show_source }}
          </button>
          <div v-if="canExpandSource(e) && expandedKeys.has(rowKey(e))" class="src">{{ S.tl_source_label }}{{ e.source_text }}</div>
        </template>
      </div>

      <!-- V2-18: single-row ops are withdrawn while selecting — the row's click
           toggles selection there, and the two must never fight over one row. -->
      <div
        v-if="!selecting
          && !(editing !== null && rowKey(editing) === rowKey(e))
          && !(confirming !== null && rowKey(confirming) === rowKey(e))"
        class="ops"
      >
        <button :title="e.thumb_b64 ? S.op_copy_image : S.op_copy" @click="copy(e)">
          <Icon :name="copiedId === rowKey(e) ? 'check' : 'copy'" />
        </button>
        <button v-if="rowCanReinject(e)" :title="reinjectLabel(e.status)" @click="reInject(e)"><Icon name="reinject" /></button>
        <button v-if="rowCanEdit(e)" :title="S.op_edit" @click="startEdit(e)"><Icon name="edit" /></button>
        <button class="del" :title="S.op_delete" @click="askDelete(e)"><Icon name="trash" /></button>
      </div>
    </div>

    <!-- owner 2026-07-31 ②: the standing answer to "where did the trimmed-away rows
         go". Under the list,
         where the oldest row is, and only once something really HAS been evicted —
         claiming a cutoff that never happened would be its own small lie. -->
    <div v-if="showRetention" class="tl-retention">{{ retentionNote }}</div>

    <!-- A refused clipboard used to do nothing and say nothing. -->
    <div v-if="copyError" class="tl-copyerr">{{ S.op_copy_failed }} · {{ copyError }}</div>
    </template>

    <!-- owner 2026-08-02 ruling: "Data" is its own independent view, not hanging
         off the tail of the list. The panel's own hierarchy (live summary / stats /
         export-import / clear's second-tier disclosure) lives inside TimelineDataPanel. -->
    <TimelineDataPanel v-else />


    <!-- Fullscreen preview: double-click the picture to open, double-click it
         (or Esc, or the backdrop) to close.
         RV-93 — the source is the DELIVERED picture (the same bytes that were typed
         into the focused window) once the disk read returns; until then, and for a
         row that kept none, it is the row's own 256 px thumbnail. ⚠️ Correction: this used
         to read "The source is the same bounded 256 px preview", which was the whole
         truth while the bytes were dropped after pasting — owner 2026-08-01 changed
         that. `.small` keeps the FALLBACK pixelated (an enlarged thumbnail should
         read as one); the real picture is smoothed like any other image. -->
    <div v-if="zoomed" class="tl-zoom" @click="zoomed = null">
      <img
        :class="{ small: zoomedFull === null }"
        :src="zoomedFull ?? `data:image/png;base64,${zoomed.thumb_b64}`"
        :alt="zoomed.output_text"
        @dblclick.stop="zoomed = null"
      />
      <div class="tl-zoomcap">{{ zoomed.output_text }} · {{ S.tl_zoom_close }}</div>
    </div>
  </div>
</template>

<style scoped>
/* V2-18 selection mode. Only the token palette + the existing .btn/.card
   geometry — no new control system (styles/main.css is outside this card's
   scope, so these rules live scoped to the page). */
.sel-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; padding: 9px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r12); box-shadow: var(--sh-sm); }
.sel-count { font-size: 12.5px; font-weight: 600; color: var(--t1); }
.sel-hint { font-size: 12px; font-weight: 600; color: var(--amber-ink); background: var(--amber-soft); border-radius: 8px; padding: 3px 9px; }
.sel-copy { margin-left: auto; }
.sel-bar .btn:disabled { opacity: .45; cursor: default; }
.hrow.selecting { cursor: pointer; }
.hrow.selected { border-color: var(--brand); background: var(--brand-soft); }
.selbox { flex: none; display: flex; align-items: center; height: 24px; }
.selbox input { width: 15px; height: 15px; accent-color: var(--brand); cursor: pointer; }
.tl-batchmsg { font-size: 12px; font-weight: 600; margin: 6px 2px; }
.tl-batchmsg.ok { color: var(--green); }
.tl-batchmsg.warn { color: var(--amber-ink); }

/* N6 search row. Only existing tokens (styles/main.css is outside this card). */
.tl-search { display: flex; align-items: center; gap: 8px; margin: 0 2px 12px; color: var(--t3); }
.tl-search-in { flex: 1 1 auto; min-width: 0; font-size: 13px; }
/* owner 2026-07-31 ② retention line: quiet but always present once it applies — it
   states a fact about the list above it, not an error. */
.tl-retention { margin: 10px 2px 0; font-size: 12px; line-height: 1.6; color: var(--t3); }
/* owner ① channel chip → 2026-08-01: now `.chan-badge` (icon + colour, ONE
   definition in styles/tokens.css — this page no longer draws its own). */
/* owner 2026-08-01 §4-2 ⑧ word-count chip: same quiet weight the old inline
   `.chan-chip` had (this page's other "context, not subject" pill). */
.wc-chip { font-size: 11px; color: var(--t3); background: var(--surface-inset); border-radius: 6px; padding: 1px 6px; }

/* RV-01 op-refused line. Loud on purpose (a --red-soft block, not the one-line
   grey the copy error gets): it says an action the user took did not happen. Only
   existing tokens — styles/main.css is outside this card's scope. */
.tl-operr { display: flex; align-items: flex-start; gap: 8px; margin: 8px 2px; padding: 9px 12px; border: 1px solid var(--danger-line); background: var(--red-soft); border-radius: var(--r12); color: var(--red-ink); font-size: 12.5px; font-weight: 600; line-height: 1.5; }
.tl-operr-x { flex: none; border: 0; background: none; color: var(--red-ink); cursor: pointer; font-size: 12px; padding: 0 2px; }

/* owner 2026-08-02 rework: the two-segment view switch (Timeline ⇄ Data). A pill
   segmented control — same family as the filter fchip but a separate class name:
   fchip means "filter this list", this means "switch to a different view" —
   different meanings don't share a class. */
.tl-views { display: inline-flex; gap: 2px; margin-left: 14px; padding: 2px;
  background: var(--surface-inset); border-radius: 999px; }
.vseg { border: 0; background: transparent; color: var(--t3); font-size: 12px; font-weight: 600;
  border-radius: 999px; padding: 3px 12px; cursor: pointer; }
.vseg.on { background: var(--surface); color: var(--t1); box-shadow: var(--sh-sm); }
</style>
