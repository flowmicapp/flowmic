<!-- Settings ▸ Speech recognition ▸ local speech model packs, per speaking
     language (LM-CAT, docs/strategy/2026-08-22-per-language-stt-model-catalog-task.md;
     design book 2026-08-19-local-model-onboarding-design.md §5-A).

     ── WHAT CHANGED FROM THE SINGLE-MODEL CARD ──────────────────────────────
     Until LM-CAT there was exactly one downloadable model (SenseVoice) and
     this card was its five-state face. There is now a CATALOG: per speaking
     language, up to three packs (recommended / multilingual / compact), each
     with a licence CLASS rendered from data — the FunASR row must never wear
     the words "open source" (task §3-6) — and a latency column of its own.
     The user picks which pack to download; nothing fetches on its own
     (DISC-2 still holds: the button is the consent).

     ── FIVE STATES PER PACK, PLUS THE KNOWLEDGE FACES ───────────────────────
     absent / partial / downloading / ready / failed are §3's five, now one
     per pack. 「connecting」/「unknown」 stay states of our KNOWLEDGE — only
     one of 「不知道」 and 「没有」 may have a Download button under it.

     ── THE DOWNLOAD FOLDER IS THE USER'S (owner 2026-08-22) ─────────────────
     The root row edits where packs are stored. Changing it does NOT move
     already-downloaded files, and the note under the control says so — a
     folder control that silently strands gigabytes would be worse than none. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import Icon from './Icon.vue';
import { S } from '../../lib/strings';
import { getLocale } from '../../lib/strings/locale';
import { LOCALE_ENDONYM, UI_LOCALES } from '../../lib/strings/generated/locales.g';
import { SETTINGS_MSG } from '../../lib/strings/settings';
import {
  applyModelsRoot,
  cancelModelDownload,
  downloadingSnapshot,
  modelStore,
  recheckModel,
  resetModelsRoot,
  startModelDownload,
} from '../../lib/model-client';
import {
  catalogRowsFor,
  ETA_MINUTES_MAX,
  ETA_SECONDS_MIN,
  etaFrom,
  formatMb,
  formatMbCoarse,
  formatRate,
  percentDone,
  snapshotForModel,
  sourceLabel,
  type CatalogEntry,
  type ModelSnapshot,
} from '../../lib/model-status';

const status = computed(() => modelStore.status);

/** The knowledge faces (unchanged rules from the single-model card): never
 *  been able to ask ⇒ `connecting` (quiet); asked and failed ⇒ `unknown`
 *  (orange line underneath says which failure). A status we DID get stays on
 *  screen when one poll misses, with `stale` beside it. */
const knowledge = computed(() =>
  status.value !== null ? 'ok' : modelStore.reach === 'unknown' ? 'connecting' : 'unknown',
);
const stale = computed(() => modelStore.reach === 'unreachable');
const answeredBadly = computed(() => modelStore.reach === 'answered_unusable');

// ── which speaking language the picker shows ────────────────────────────────

/** base spoken code → the UI-locale code whose endonym names it — DERIVED
 *  from the generated registry (first registry locale with that base wins,
 *  so zh → zh-CN), never a hand-rolled list: adding a tenth language must
 *  not mean editing this file (locale-expansion architecture §2). Endonyms
 *  are registry DATA, deliberately untranslated. */
const ENDONYM_LOCALE: Record<string, string> = (() => {
  const byBase: Record<string, string> = {};
  for (const code of UI_LOCALES) {
    const base = code.split('-')[0] ?? code;
    if (!(base in byBase)) byBase[base] = code;
  }
  return byBase;
})();

/** Default to the reader's own UI language where it maps onto a spoken key —
 *  zh-TW keeps its OWN entry (a script, not a ninth acoustic key: it shows
 *  the zh packs plus the shared-model note, task §3-1). */
function defaultLang(): string {
  const ui = getLocale();
  if (ui === 'zh-TW') return 'zh-TW';
  const base = ui.split('-')[0] ?? 'en';
  return base in ENDONYM_LOCALE ? base : 'en';
}
const lang = ref<string>(defaultLang());
/** The catalog key the visible selection maps to (zh-TW → zh). */
const langKey = computed(() => (lang.value === 'zh-TW' ? 'zh' : lang.value));

const langOptions = computed(() => {
  const spoken = status.value?.spoken_langs ?? Object.keys(ENDONYM_LOCALE);
  const opts = spoken.map((l) => ({
    value: l,
    label: (LOCALE_ENDONYM as Record<string, string>)[ENDONYM_LOCALE[l] ?? ''] ?? l,
  }));
  // zh-TW rides directly after zh, wearing its own endonym.
  const zhAt = opts.findIndex((o) => o.value === 'zh');
  const zhTw = { value: 'zh-TW', label: (LOCALE_ENDONYM as Record<string, string>)['zh-TW'] ?? 'zh-TW' };
  if (zhAt >= 0) opts.splice(zhAt + 1, 0, zhTw); else opts.push(zhTw);
  return opts;
});

// ── the packs of the chosen language ────────────────────────────────────────

interface PackRow {
  entry: CatalogEntry;
  snap: ModelSnapshot | null;
  face: string;
  selected: boolean;
}

const rows = computed<PackRow[]>(() =>
  catalogRowsFor(status.value, langKey.value).map((entry) => {
    const snap = snapshotForModel(status.value, entry.model_id);
    return {
      entry,
      snap,
      // A pack the server listed no snapshot for renders 「unknown」, never an
      // invented 「absent」 with a Download button under it.
      face: entry.streaming === 'streaming' ? 'streaming' : (snap?.state ?? 'unknown'),
      selected: status.value?.selected_by_lang[langKey.value] === entry.model_id,
    };
  }),
);

const STATE_LABEL = computed<Record<string, string>>(() => ({
  ready: S.model_state_ready,
  absent: S.model_state_absent,
  partial: S.model_state_partial,
  downloading: S.model_state_downloading,
  failed: S.model_state_failed,
  unknown: S.model_state_unknown,
  streaming: S.model_state_absent, // the chip; the refusal sentence is the stream label
}));
const TIER_LABEL = computed<Record<string, string>>(() => ({
  lite: S.model_tier_lite,
  recommended: S.model_tier_recommended,
  multilingual: S.model_tier_multilingual,
}));
/** 🔴 Keyed by license_class DATA (task §3-6): the funasr label carries "not
 *  open source" and no code path can hand that row the OSI words. */
const LIC_LABEL = computed<Record<string, string>>(() => ({
  osi: S.model_lic_osi,
  'cc-by': S.model_lic_ccby,
  'funasr-model': S.model_lic_funasr,
}));
const STREAM_LABEL = computed<Record<string, string>>(() => ({
  offline: S.model_stream_offline,
  quasi: S.model_stream_quasi,
  streaming: S.model_stream_streaming,
}));

/** One download machine-wide: every other pack's download control stands down
 *  while one runs, with the reason on the row (`model_busy_other`). */
const busyId = computed(() => status.value?.busy_model_id ?? null);
const actionBusy = computed(() => modelStore.busy !== '');
function rowLocked(id: string): boolean {
  return actionBusy.value || (busyId.value !== null && busyId.value !== id);
}

function sizedDownloadLabel(entry: CatalogEntry): string {
  return entry.bytes_total === null
    ? S.model_dl
    : SETTINGS_MSG.modelDownloadSize(formatMbCoarse(entry.bytes_total));
}
function resumeLabel(row: PackRow): string {
  const pct = percentDone(row.snap?.bytes_done ?? 0, row.snap?.bytes_total ?? null);
  return pct === null ? S.model_resume : SETTINGS_MSG.modelResume(`${pct}%`);
}

// ── the one in-flight download's quantity (§2-4 / §2-6) ─────────────────────

const dl = computed(() => downloadingSnapshot(status.value));
const pct = computed(() => percentDone(dl.value?.bytes_done ?? 0, dl.value?.bytes_total ?? null));
const pctText = computed(() => (pct.value === null ? null : `${pct.value}%`));
const doneText = computed(() => formatMb(dl.value?.bytes_done ?? 0));
const totalText = computed(() =>
  dl.value?.bytes_total == null ? S.model_total_unknown : formatMb(dl.value.bytes_total),
);
const rateText = computed(() =>
  dl.value?.rate_bytes_per_sec == null ? null : formatRate(dl.value.rate_bytes_per_sec),
);
const sourceText = computed(() => sourceLabel(dl.value?.source ?? null));
const resumedText = computed(() =>
  (dl.value?.resumed_from_bytes ?? 0) > 0
    ? SETTINGS_MSG.modelResumedFrom(formatMb(dl.value!.resumed_from_bytes))
    : null,
);
const filesText = computed(() => {
  const s = dl.value;
  if (!s || s.files_total <= 0) return null;
  return SETTINGS_MSG.modelFiles(Math.min(s.files_done + 1, s.files_total), s.files_total);
});
const etaText = computed(() => {
  const s = dl.value;
  if (!s) return null;
  const v = etaFrom(s.bytes_done, s.bytes_total, modelStore.rateSamples);
  if (v.kind === 'no-total') return S.model_eta_no_total;
  if (v.kind === 'estimating') return S.model_eta_estimating;
  if (v.seconds < ETA_SECONDS_MIN) return S.model_eta_lt_min;
  const minutes = Math.max(1, Math.round(v.seconds / 60));
  return minutes > ETA_MINUTES_MAX ? S.model_eta_over_hour : SETTINGS_MSG.modelEtaMinutes(minutes);
});

// ── the folder, which the user may move (owner 2026-08-22) ──────────────────
//
// 🔴 Text + copy button, not an 「open folder」 button — same refusal as the
// old card ("a page that could NAME a handle could name one it does not own").
const root = computed(() => status.value?.models_root ?? null);
const editingRoot = ref(false);
const rootInput = ref('');
function startRootEdit(): void {
  rootInput.value = root.value?.dir ?? '';
  editingRoot.value = true;
}
async function saveRoot(): Promise<void> {
  await applyModelsRoot(rootInput.value);
  // Close only on success: a refused folder keeps the editor open with the
  // server's reason in the fold, so the press visibly did not "work".
  if (modelStore.actionError === null) editingRoot.value = false;
}
async function resetRoot(): Promise<void> {
  await resetModelsRoot();
  if (modelStore.actionError === null) editingRoot.value = false;
}

const copied = ref(false);
const copyFailed = ref(false);
async function copyDir(): Promise<void> {
  copyFailed.value = false;
  try {
    await navigator.clipboard.writeText(root.value?.dir ?? '');
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1200);
  } catch {
    copyFailed.value = true;
  }
}

/** Per-pack errors of the visible language, for the technical fold. */
const rowErrors = computed(() =>
  rows.value
    .filter((r) => r.snap?.error)
    .map((r) => `${r.entry.model_id} — ${r.snap!.error!.code}: ${r.snap!.error!.message}`),
);
</script>

<template>
  <div class="sub-h">{{ S.model_title }}</div>
  <div class="card model-card">
    <!-- WHY there is a download at all (shard note ④) + what the picker is. -->
    <p class="sub why">{{ S.model_why }}</p>
    <p class="sub why">{{ S.model_pick_note }}</p>

    <!-- The reading's health, one line, three different sentences. -->
    <p v-if="knowledge === 'connecting'" class="sub">{{ S.model_connecting_note }}</p>
    <p v-else-if="stale" class="sub warn">{{ S.model_unreachable }}</p>
    <p v-else-if="answeredBadly" class="sub warn">{{ S.model_answered_badly }}</p>
    <p v-else-if="knowledge === 'unknown'" class="sub warn">{{ S.model_state_unknown }}</p>

    <template v-if="status !== null">
      <!-- which speaking language -->
      <div class="row langrow">
        <span class="sub">{{ S.model_lang_label }}</span>
        <select v-model="lang" class="langsel">
          <option v-for="o in langOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>
      <p v-if="lang === 'zh-TW'" class="sub">{{ S.model_lang_zhtw_note }}</p>

      <!-- the packs -->
      <div v-for="row in rows" :key="row.entry.model_id" class="pack">
        <div class="row phead">
          <span class="chip tier">{{ TIER_LABEL[row.entry.tier] }}</span>
          <!-- No state chip on a streaming row: "Not downloaded" would imply
               a download exists to be had, and this phase refuses it — the
               stream label below carries the truthful sentence. -->
          <span v-if="row.face !== 'streaming'" class="chip state" :class="row.face">{{ STATE_LABEL[row.face] }}</span>
          <span v-if="row.selected" class="chip inuse">{{ S.model_in_use }}</span>
          <span class="mono mid">{{ row.entry.model_id }}</span>
        </div>
        <div class="row pmeta">
          <span class="sub" :class="{ funasr: row.entry.license_class === 'funasr-model' }">
            {{ LIC_LABEL[row.entry.license_class] }}</span>
          <span class="sub">· {{ STREAM_LABEL[row.entry.streaming] }}</span>
          <span class="sub" v-if="row.entry.bytes_total !== null">· {{ formatMbCoarse(row.entry.bytes_total) }}</span>
        </div>
        <p class="sub attr">{{ row.entry.attribution }}</p>

        <div class="row pacts" v-if="row.entry.streaming !== 'streaming'">
          <button v-if="row.face === 'absent'" class="btn pri sm" type="button"
                  :disabled="rowLocked(row.entry.model_id)"
                  :title="busyId !== null && busyId !== row.entry.model_id ? S.model_busy_other : ''"
                  @click="startModelDownload(row.entry.model_id, langKey)">
            {{ modelStore.busy === 'download' && modelStore.busyActionModelId === row.entry.model_id ? S.model_starting : sizedDownloadLabel(row.entry) }}
          </button>
          <button v-if="row.face === 'partial'" class="btn pri sm" type="button"
                  :disabled="rowLocked(row.entry.model_id)"
                  @click="startModelDownload(row.entry.model_id, langKey)">
            {{ resumeLabel(row) }}
          </button>
          <button v-if="row.face === 'failed'" class="btn pri sm" type="button"
                  :disabled="rowLocked(row.entry.model_id)"
                  @click="startModelDownload(row.entry.model_id, langKey)">
            {{ S.model_retry }}
          </button>
          <button v-if="row.face === 'downloading'" class="btn ghost sm" type="button"
                  :disabled="actionBusy"
                  @click="cancelModelDownload(row.entry.model_id)">
            {{ S.model_cancel }}
          </button>
          <button v-if="row.face === 'ready' && !row.selected" class="btn ghost sm" type="button"
                  :disabled="actionBusy"
                  @click="startModelDownload(row.entry.model_id, langKey)">
            {{ S.model_use }}
          </button>
        </div>

        <!-- the in-flight quantity, on the row that is downloading -->
        <template v-if="row.face === 'downloading' && dl && dl.model_id === row.entry.model_id">
          <div class="bar" :class="{ indeterminate: pct === null }">
            <div v-if="pct !== null" class="fill" :style="{ width: pct + '%' }"></div>
          </div>
          <div class="row nums">
            <span class="pctv" v-if="pctText">{{ pctText }}</span>
            <span class="sub">{{ S.model_downloaded }} {{ doneText }} / {{ totalText }}</span>
            <span class="sub" v-if="rateText">· {{ rateText }}</span>
            <span class="sub">· {{ etaText }}</span>
          </div>
          <div class="row nums" v-if="filesText || dl.current_file">
            <span class="sub" v-if="filesText">{{ filesText }}</span>
            <span class="mono mid" v-if="dl.current_file">{{ dl.current_file }}</span>
          </div>
          <div class="row nums" v-if="sourceText">
            <span class="sub">{{ S.model_source }}: {{ sourceText }}</span>
          </div>
          <p class="sub" v-if="sourceText">{{ S.model_source_note }}</p>
          <p class="sub" v-if="resumedText">{{ resumedText }}</p>
          <p class="sub">{{ S.model_cancel_note }}</p>
        </template>
        <p v-if="row.face === 'failed'" class="sub">{{ S.model_failed_next }}</p>
      </div>

      <!-- What `ready` certifies (and does not — §3's closing warning),
           whenever this language has a verified pack. -->
      <p v-if="rows.some((r) => r.face === 'ready')" class="sub">{{ S.model_verified }}</p>

      <!-- the second exit, always stated -->
      <p class="sub">{{ S.model_manual }}</p>

      <p v-if="modelStore.actionError" class="sub warn">{{ S.model_action_failed }}</p>

      <!-- the movable download folder -->
      <div class="row dir" v-if="root">
        <span class="sub">{{ S.model_root_title }}</span>
        <code class="mono path">{{ root.dir }}</code>
        <button class="btn ghost sm" type="button" @click="copyDir()">
          <Icon name="copy" />{{ copied ? S.model_copied : S.model_copy }}
        </button>
        <button v-if="!editingRoot" class="btn ghost sm" type="button"
                :disabled="actionBusy || busyId !== null"
                :title="busyId !== null ? S.model_busy_other : ''"
                @click="startRootEdit()">
          {{ S.model_root_change }}
        </button>
      </div>
      <div class="row dir" v-if="editingRoot">
        <input class="rootin" v-model="rootInput" type="text" spellcheck="false" />
        <button class="btn pri sm" type="button" :disabled="actionBusy" @click="saveRoot()">
          {{ S.model_root_apply }}
        </button>
        <button class="btn ghost sm" type="button" :disabled="actionBusy" @click="editingRoot = false">
          {{ S.model_root_cancel }}
        </button>
        <button class="btn ghost sm" type="button" :disabled="actionBusy || !root?.configured" @click="resetRoot()">
          {{ S.model_root_reset }}
        </button>
      </div>
      <p class="sub" v-if="root">{{ S.model_root_note }}</p>
      <p v-if="copyFailed" class="sub warn">{{ S.model_copy_failed }}</p>
    </template>

    <!-- OUTSIDE the status guard, deliberately: the unreachable sentence tells
         the reader to press this button, so it must exist in exactly the state
         that shows that sentence (a failed FIRST read included). It is also
         the re-ask for a stale reading. Only the quiet launch seconds go
         without it — nothing has failed there yet. -->
    <div class="row acts" v-if="knowledge !== 'connecting'">
      <button class="btn ghost sm" type="button" :disabled="actionBusy"
              @click="recheckModel()">
        <Icon name="refresh" />{{ modelStore.busy === 'recheck' ? S.model_checking : S.model_recheck }}
      </button>
    </div>

    <!-- The machine truth, kept and folded rather than dropped. -->
    <details class="fold" v-if="rowErrors.length > 0 || modelStore.actionError || modelStore.reachReason">
      <summary class="sub">{{ S.model_detail }}</summary>
      <p class="mono detail" v-for="e in rowErrors" :key="e">{{ e }}</p>
      <p class="mono detail" v-if="modelStore.actionError">{{ modelStore.actionError }}</p>
      <p class="mono detail" v-if="modelStore.reachReason">{{ modelStore.reachReason }}</p>
    </details>
  </div>
</template>

<style scoped>
.model-card { padding: 12px 14px; }
.why { line-height: 1.6; margin: 0 0 8px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.langrow { margin: 8px 0 6px; }
.langsel { font-size: 12.5px; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--surface-inset); color: var(--t1); }
.pack { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; margin-top: 8px; }
.phead { margin-bottom: 2px; }
.pmeta { margin-top: 2px; }
.pacts { margin-top: 8px; }
.acts { margin-top: 10px; }
.dir { margin-top: 10px; }
.attr { margin: 4px 0 0; font-size: 11px; color: var(--t3); }
.mid { font-size: 11.5px; color: var(--t3); }
/* Same colour vocabulary as the rest of the product: green = done, amber =
   not done but nothing broke, red = failed, slate = we do not know. */
.chip { font-size: 11.5px; border-radius: 999px; padding: 2px 10px; border: 1px solid var(--line); color: var(--t2); }
.chip.ready { background: var(--green-soft); border-color: var(--green); color: var(--green-ink); }
.chip.absent, .chip.partial { background: var(--amber-soft); border-color: var(--amber-line); color: var(--amber-ink); }
.chip.downloading { background: var(--brand-soft); border-color: var(--brand-line); color: var(--brand-ink); }
.chip.failed { background: var(--red-soft); border-color: var(--red); color: var(--red-ink); }
.chip.unknown, .chip.streaming { background: var(--off-chip-bg); color: var(--t3); }
.chip.tier { background: var(--surface-inset); }
.chip.inuse { background: var(--green-soft); border-color: var(--green); color: var(--green-ink); }
.bar { height: 6px; border-radius: 999px; background: var(--surface-inset); overflow: hidden; margin-top: 8px; }
.fill { height: 100%; background: var(--brand); border-radius: 999px; }
.bar.indeterminate {
  background: repeating-linear-gradient(115deg, var(--brand-soft) 0 10px, var(--surface-inset) 10px 20px);
}
.pctv { font-size: 12px; font-weight: 700; color: var(--t1); }
.warn { color: var(--amber-ink); }
.path { font-size: 11.5px; color: var(--t2); background: var(--surface-inset); border-radius: 6px;
  padding: 2px 8px; user-select: text; word-break: break-all; }
.rootin { flex: 1 1 260px; font-size: 12px; font-family: ui-monospace, Consolas, monospace; padding: 5px 8px;
  border-radius: 8px; border: 1px solid var(--line); background: var(--surface-inset); color: var(--t1); }
.fold { margin-top: 10px; }
.fold summary { cursor: pointer; }
.detail { font-size: 11.5px; color: var(--t3); margin-top: 6px; user-select: text; word-break: break-all; }
</style>
