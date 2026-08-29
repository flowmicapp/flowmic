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
import { computed, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { S } from '../../lib/strings';
import { getLocale } from '../../lib/strings/locale';
import { SETTINGS_MSG } from '../../lib/strings/settings';
import { ENDONYM_LOCALE, modelCardLangOptions } from '../../lib/spoken-langs';
import { LOCAL_MODEL_CARD_ID, requestedModelLang } from '../../lib/model-card-focus';
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
  readyPackForLang,
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
//
// The endonym derivation moved to lib/spoken-langs.ts VERBATIM on 2026-08-27
// when the routing table needed the same names: a second copy of it here would
// have been the second language registry CLAUDE.md forbids by name.

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

const langOptions = computed(() => modelCardLangOptions(status.value?.spoken_langs));

// 🔴 The routing table's 「go and download one」 lands here (§2-3). It is
// COPIED into `lang`, not rendered from — a card that rendered straight off the
// request would refuse to let the reader navigate away from the language they
// were sent to, and they arrived here precisely to look around.
watch(requestedModelLang, (req) => {
  if (req === null) return;
  const wanted = req.lang;
  // An empty request (the fallback row, which is about no one language) scrolls
  // the card into view and leaves the picker alone rather than guessing.
  if (wanted === '') return;
  if (langOptions.value.some((o) => o.value === wanted)) lang.value = wanted;
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

/** The 「currently in use」 strip (owner 2026-08-27 §2-4): which pack would
 *  actually open if this language were spoken right now.
 *
 *  🔴 NOT `selected_by_lang` on its own. A selection is a preference; it can
 *  name a pack that was never downloaded, was cancelled halfway, or failed
 *  verification. Rendering the preference under the words 「currently in use」
 *  would put a model name on screen for a language that cannot be transcribed —
 *  R11 in one line. `readyPackForLang` mirrors the server's resolution ladder,
 *  so this strip answers the question it asks. */
const inUse = computed(() => readyPackForLang(status.value, langKey.value));

/** Per-pack errors of the visible language, for the technical fold. */
const rowErrors = computed(() =>
  rows.value
    .filter((r) => r.snap?.error)
    .map((r) => `${r.entry.model_id} — ${r.snap!.error!.code}: ${r.snap!.error!.message}`),
);
</script>

<!--
  ── THE LAYERS, AND WHY THEY ARE IN THIS ORDER (owner 2026-08-27 §2-4) ───────
  The owner's words about the previous version were 「全是文字、很乱、不知道点
  哪」— all prose, no structure, nowhere obvious to click. Every string and every
  state below is the same one it was; what changed is that the screen now
  answers questions in the order a person asks them:

    ① which language am I setting up      → the picker, first and prominent
    ② what is in use for it RIGHT NOW     → one strip, green or red, no prose
    ③ what else could I use               → pack rows, one primary button each
    ④ what is happening right now         → progress, in a bounded sub-block
    ⑤ where do the files live             → collapsed; it is a rare answer
    ⑥ what exactly went wrong             → the technical fold, unchanged

  🔴 ② IS NEW AND IT IS THE OWNER'S EMPTY-STATE RULING. A fresh machine used to
  present a list of packs with no statement anywhere about whether the language
  could be transcribed at all; the answer had to be assembled by the reader from
  five chips. It is now one sentence, and when the answer is 「nothing」 it is red
  and says what to do — the same wording family the routing table uses upstairs,
  so a user who saw it there recognises it here.
-->
<template>
  <div class="sub-h">{{ S.model_title }}</div>
  <div class="card model-card" :id="LOCAL_MODEL_CARD_ID">
    <!-- WHY there is a download at all (shard note ④) + what the picker is. -->
    <p class="sub why">{{ S.model_why }}</p>
    <p class="sub why">{{ S.model_pick_note }}</p>

    <!-- The reading's health, one line, three different sentences. -->
    <p v-if="knowledge === 'connecting'" class="sub">{{ S.model_connecting_note }}</p>
    <p v-else-if="stale" class="sub warn">{{ S.model_unreachable }}</p>
    <p v-else-if="answeredBadly" class="sub warn">{{ S.model_answered_badly }}</p>
    <p v-else-if="knowledge === 'unknown'" class="sub warn">{{ S.model_state_unknown }}</p>

    <template v-if="status !== null">
      <!-- ① which speaking language. Given its own bordered band rather than a
           line of body text: it is the control everything below depends on, and
           a reader who misses it reads the whole card for the wrong language. -->
      <div class="langband">
        <label class="langlabel" for="fm-model-lang">{{ S.model_lang_label }}</label>
        <select id="fm-model-lang" v-model="lang" class="langsel">
          <option v-for="o in langOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>
      <p v-if="lang === 'zh-TW'" class="sub zhtw">{{ S.model_lang_zhtw_note }}</p>

      <!-- ② what is in use for this language RIGHT NOW -->
      <div class="inuse-strip" :class="inUse === null ? 'none' : 'have'">
        <div class="sub strip-h">{{ S.model_in_use_title }}</div>
        <div v-if="inUse !== null" class="strip-body">
          <span class="chip ready">{{ S.model_state_ready }}</span>
          <span class="mono strip-id">{{ inUse.model_id }}</span>
        </div>
        <div v-else class="strip-body">
          <span class="strip-none">{{ S.model_in_use_none }}</span>
        </div>
      </div>

      <!-- ③ the packs. One card row each; one primary action, right-aligned. -->
      <p v-if="rows.length === 0" class="sub empty-packs">{{ S.model_no_packs }}</p>
      <div v-for="row in rows" :key="row.entry.model_id" class="pack" :class="{ current: row.selected }">
        <div class="row phead">
          <span class="chip tier">{{ TIER_LABEL[row.entry.tier] }}</span>
          <!-- No state chip on a streaming row: "Not downloaded" would imply
               a download exists to be had, and this phase refuses it — the
               stream label below carries the truthful sentence. -->
          <span v-if="row.face !== 'streaming'" class="chip state" :class="row.face">{{ STATE_LABEL[row.face] }}</span>
          <span v-if="row.selected" class="chip inuse">{{ S.model_in_use }}</span>
          <span class="spacer"></span>
          <!-- ONE primary action per row, at the right edge where a scanning
               eye looks for the verb. The five arms are mutually exclusive by
               `face`, so this is a single button, not a toolbar. -->
          <template v-if="row.entry.streaming !== 'streaming'">
            <button v-if="row.face === 'absent'" class="btn pri sm" type="button"
                    :disabled="rowLocked(row.entry.model_id)"
                    :title="busyId !== null && busyId !== row.entry.model_id ? S.model_busy_other : ''"
                    @click="startModelDownload(row.entry.model_id, langKey)">
              {{ modelStore.busy === 'download' && modelStore.busyActionModelId === row.entry.model_id ? S.model_starting : sizedDownloadLabel(row.entry) }}
            </button>
            <button v-else-if="row.face === 'partial'" class="btn pri sm" type="button"
                    :disabled="rowLocked(row.entry.model_id)"
                    @click="startModelDownload(row.entry.model_id, langKey)">
              {{ resumeLabel(row) }}
            </button>
            <button v-else-if="row.face === 'failed'" class="btn pri sm" type="button"
                    :disabled="rowLocked(row.entry.model_id)"
                    @click="startModelDownload(row.entry.model_id, langKey)">
              {{ S.model_retry }}
            </button>
            <button v-else-if="row.face === 'downloading'" class="btn ghost sm" type="button"
                    :disabled="actionBusy"
                    @click="cancelModelDownload(row.entry.model_id)">
              {{ S.model_cancel }}
            </button>
            <button v-else-if="row.face === 'ready' && !row.selected" class="btn ghost sm" type="button"
                    :disabled="actionBusy"
                    @click="startModelDownload(row.entry.model_id, langKey)">
              {{ S.model_use }}
            </button>
          </template>
        </div>
        <!-- The facts, as chips. Licence stays keyed off `license_class` DATA —
             the funasr row must never wear the OSI words (task §3-6). -->
        <div class="row pmeta">
          <span class="chip meta" :class="{ funasr: row.entry.license_class === 'funasr-model' }">
            {{ LIC_LABEL[row.entry.license_class] }}</span>
          <span class="chip meta">{{ STREAM_LABEL[row.entry.streaming] }}</span>
          <span class="chip meta" v-if="row.entry.bytes_total !== null">{{ formatMbCoarse(row.entry.bytes_total) }}</span>
        </div>
        <p class="sub attr">{{ row.entry.attribution }}</p>
        <!-- De-emphasised: the id is what a support conversation needs, not what
             a choice is made on. It was in the heading and competing with it. -->
        <p class="mono mid pid">{{ row.entry.model_id }}</p>

        <!-- ④ the in-flight quantity, as its own bounded block on the row that
             is downloading — it used to run on as more loose lines under the
             buttons — most of what 「很乱」 named. -->
        <div class="dlblock" v-if="row.face === 'downloading' && dl && dl.model_id === row.entry.model_id">
          <div class="sub strip-h">{{ S.model_state_downloading }}</div>
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
        </div>
        <p v-if="row.face === 'failed'" class="sub">{{ S.model_failed_next }}</p>
      </div>

      <!-- What `ready` certifies (and does not — §3's closing warning),
           whenever this language has a verified pack. -->
      <p v-if="rows.some((r) => r.face === 'ready')" class="sub">{{ S.model_verified }}</p>

      <!-- the second exit, always stated -->
      <p class="sub">{{ S.model_manual }}</p>

      <p v-if="modelStore.actionError" class="sub warn">{{ S.model_action_failed }}</p>

      <!-- ⑤ the movable download folder, demoted into a fold. Every control and
           every sentence is unchanged; what changed is that a question asked
           once a year no longer occupies the same rank as the ones asked every
           time. It is NOT hidden — the fold is closed, not absent, because
           `model_manual` promises the folder is 「below」 and a promise the
           screen does not keep is the failure this repo names most often.
           ⚠️ `open` while the editor is up: a refused folder must leave the
           editor visible with the reason beside it, and a collapsed fold would
           swallow the refusal. -->
      <details class="fold storage" v-if="root" :open="editingRoot">
        <summary class="sub">{{ S.model_storage_title }}</summary>
        <div class="row dir">
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
        <p class="sub">{{ S.model_root_note }}</p>
      </details>
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

    <!-- ⑥ The machine truth, kept and folded rather than dropped. -->
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
/* ① The picker is a band, not a line of text: everything below is about
   whatever it says, so it has to read as a heading for the rest. */
.langband { display: flex; align-items: center; gap: 10px; margin: 10px 0 8px;
  padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-inset); }
.langlabel { font-size: 12px; font-weight: 600; color: var(--t2); }
.langsel { font-size: 13px; padding: 5px 10px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--surface); color: var(--t1); flex: 0 1 220px; }
.zhtw { margin: 0 0 8px; }
/* ② One strip, one answer. Green when something would open, red when nothing
   would — the same two colours the routing table uses for the same fact. */
.inuse-strip { border: 1px solid var(--line); border-left-width: 3px; border-radius: 10px;
  padding: 8px 10px; margin-bottom: 10px; }
.inuse-strip.have { border-left-color: var(--green); background: var(--green-soft); }
.inuse-strip.none { border-left-color: var(--red); background: var(--red-soft); }
.strip-h { font-weight: 600; margin-bottom: 4px; }
.strip-body { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.strip-id { font-size: 11.5px; color: var(--t2); word-break: break-all; }
.strip-none { font-size: 12px; color: var(--red-ink); line-height: 1.6; }
.empty-packs { margin: 8px 0; line-height: 1.6; }
.pack { border: 1px solid var(--line); border-radius: 10px; padding: 10px; margin-top: 8px;
  background: var(--surface); }
.pack.current { border-color: var(--green); }
.phead { margin-bottom: 6px; }
/* Pushes the row's single primary action to the right edge. */
.spacer { flex: 1 1 auto; }
.pmeta { margin-top: 2px; }
.acts { margin-top: 10px; }
.dir { margin-top: 10px; }
.attr { margin: 6px 0 0; font-size: 11px; color: var(--t3); }
.mid { font-size: 11.5px; color: var(--t3); }
.pid { margin: 2px 0 0; word-break: break-all; }
/* ④ The progress readout is a block with edges, not more loose lines. */
.dlblock { margin-top: 10px; padding: 8px 10px; border: 1px solid var(--brand-line);
  border-radius: 8px; background: var(--brand-soft); }
.storage summary { font-weight: 600; }
/* Same colour vocabulary as the rest of the product: green = done, amber =
   not done but nothing broke, red = failed, slate = we do not know. */
.chip { font-size: 11.5px; border-radius: 999px; padding: 2px 10px; border: 1px solid var(--line); color: var(--t2); }
.chip.ready { background: var(--green-soft); border-color: var(--green); color: var(--green-ink); }
.chip.absent, .chip.partial { background: var(--amber-soft); border-color: var(--amber-line); color: var(--amber-ink); }
.chip.downloading { background: var(--brand-soft); border-color: var(--brand-line); color: var(--brand-ink); }
.chip.failed { background: var(--red-soft); border-color: var(--red); color: var(--red-ink); }
.chip.unknown, .chip.streaming { background: var(--off-chip-bg); color: var(--t3); }
.chip.tier { background: var(--surface-inset); }
/* Licence / latency / size, promoted from run-on prose to chips so the row can
   be compared with its neighbours at a glance. Same neutral colour for all
   three: they are facts, not verdicts. */
.chip.meta { background: var(--surface-inset); font-size: 11px; }
/* 🔴 `.funasr` carried NO rule before this redesign — a class binding with no
   stylesheet consumer, which is the anti-façade rule's smallest form. It now
   has one: the not-open-source row is amber, so the licence distinction the
   `license_class` field exists to preserve is visible and not only readable.
   The WORDS still come from LIC_LABEL data; this only stops the one row that
   carries a restriction from looking identical to the two that do not. */
.chip.meta.funasr { background: var(--amber-soft); border-color: var(--amber-line); color: var(--amber-ink); }
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
