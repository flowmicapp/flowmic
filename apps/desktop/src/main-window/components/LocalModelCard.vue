<!-- Settings ▸ Speech recognition ▸ the built-in speech model (design book
     2026-08-19-local-model-onboarding-design.md §5-A).

     ── WHAT THIS CARD IS FOR ────────────────────────────────────────────────
     Until today the model's absence was discoverable in exactly one way: hold
     the button, speak, and read a developer sentence with a filesystem path and
     an environment-variable name in it. The card moves that fact to the earliest
     moment it can be known (§2-1) and gives it the two exits it always had but
     never offered — download it, or place it yourself / use another engine.

     ── FIVE STATES, PLUS ONE THAT IS NOT A STATE OF THE MODEL ───────────────
     absent / partial / downloading / ready / failed are §3's five. The sixth
     face — 「Unknown」 — is the state of our KNOWLEDGE: the local service did not
     answer. It is separate because only one of 「不知道」 and 「没有」 may have a
     Download button under it, and putting one under the other would have this
     card offering to fetch 228 MB on the evidence of a failed HTTP GET.

     ── IT IS RESIDENT, NOT AN ERROR BANNER ──────────────────────────────────
     §5-A: 「常驻显示状态」. It renders in `ready` too, because the question 「why
     did this thing pull 228 MB down once」 outlives the download, and the only
     place that answer can live is beside the thing it explains. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import Icon from './Icon.vue';
import { S } from '../../lib/strings';
import { SETTINGS_MSG } from '../../lib/strings/settings';
import {
  cancelModelDownload,
  modelStore,
  recheckModel,
  startModelDownload,
} from '../../lib/model-client';
import {
  ETA_MINUTES_MAX,
  ETA_SECONDS_MIN,
  etaFrom,
  formatMb,
  formatMbCoarse,
  formatRate,
  percentDone,
  sourceLabel,
} from '../../lib/model-status';

const snap = computed(() => modelStore.snapshot);

/** The six faces. `null` snapshot ⇒ we have never had an answer ⇒ Unknown.
 *
 *  🔴 A snapshot we DID get is kept on screen even when the latest poll failed,
 *  with `stale` saying so beside it. Blanking a download that is 60 % through
 *  because one loopback GET missed would be the worse lie of the two: the
 *  download is almost certainly still running, and the reader would watch the
 *  product forget. */
const face = computed(() => snap.value?.state ?? 'unknown');
const stale = computed(() => modelStore.reach === 'unreachable');

const STATE_LABEL = computed<Record<string, string>>(() => ({
  ready: S.model_state_ready,
  absent: S.model_state_absent,
  partial: S.model_state_partial,
  downloading: S.model_state_downloading,
  failed: S.model_state_failed,
  unknown: S.model_state_unknown,
}));

// ── the quantity (§2-4) ─────────────────────────────────────────────────────

const pct = computed(() => percentDone(snap.value?.bytes_done ?? 0, snap.value?.bytes_total ?? null));
/** `null` ⇒ the bar draws indeterminate and the readouts say so IN WORDS. Never
 *  0 % and never 100 %: §4 sends `null` for an unknown total precisely because
 *  both of those numbers are lies with a confident face. */
const pctText = computed(() => (pct.value === null ? null : `${pct.value}%`));
const doneText = computed(() => formatMb(snap.value?.bytes_done ?? 0));
const totalText = computed(() =>
  snap.value?.bytes_total == null ? S.model_total_unknown : formatMb(snap.value.bytes_total),
);
/** The figure the Download button previews — from the snapshot, never a literal
 *  (§5-D). `null` ⇒ the button says nothing about size rather than guessing. */
const coarseSize = computed(() =>
  snap.value?.bytes_total == null ? null : formatMbCoarse(snap.value.bytes_total),
);
const rateText = computed(() =>
  snap.value?.rate_bytes_per_sec == null ? null : formatRate(snap.value.rate_bytes_per_sec),
);
const sourceText = computed(() => sourceLabel(snap.value?.source ?? null));
const resumedText = computed(() =>
  (snap.value?.resumed_from_bytes ?? 0) > 0
    ? SETTINGS_MSG.modelResumedFrom(formatMb(snap.value!.resumed_from_bytes))
    : null,
);
/** Which file, as an ordinal beside its name. `files_done` counts FINISHED
 *  files, so the one in flight is the next one — and 「File 3 of 4」 next to
 *  `model.int8.onnx` is what a reader can match against what they see. */
const filesText = computed(() => {
  const s = snap.value;
  if (!s || s.files_total <= 0) return null;
  return SETTINGS_MSG.modelFiles(Math.min(s.files_done + 1, s.files_total), s.files_total);
});

/** §2-6 in one expression: a time is named ONLY when it came out of a measured,
 *  settled rate. Everything else says which kind of 「no」 it is. */
const etaText = computed(() => {
  const s = snap.value;
  if (!s) return null;
  const v = etaFrom(s.bytes_done, s.bytes_total, modelStore.rateSamples);
  if (v.kind === 'no-total') return S.model_eta_no_total;
  if (v.kind === 'estimating') return S.model_eta_estimating;
  if (v.seconds < ETA_SECONDS_MIN) return S.model_eta_lt_min;
  const minutes = Math.max(1, Math.round(v.seconds / 60));
  return minutes > ETA_MINUTES_MAX ? S.model_eta_over_hour : SETTINGS_MSG.modelEtaMinutes(minutes);
});

// ── the labels that carry a number ──────────────────────────────────────────

const downloadLabel = computed(() =>
  coarseSize.value === null ? S.model_dl : SETTINGS_MSG.modelDownloadSize(coarseSize.value),
);
const resumeLabel = computed(() =>
  pctText.value === null ? S.model_resume : SETTINGS_MSG.modelResume(pctText.value),
);

// ── the folder, which is the manual route ───────────────────────────────────
//
// 🔴 SHOWN AS TEXT WITH A COPY BUTTON, NOT AS AN 「open folder」 BUTTON. §5-A
// asks for openable, and opening it would mean handing a path THIS PAGE NAMES to
// a Rust shell-open — the exact shape `reportSelfFocus` refuses two files over
// ("a page that could NAME a handle could name one it does not own"). The
// existing `open_log_directory` command takes no argument for that reason. So
// the path stays selectable and copyable here, and a real opener is a Rust
// command that resolves the model directory ITSELF — reported, not smuggled in.
const copied = ref(false);
const copyFailed = ref(false);
async function copyDir(): Promise<void> {
  copyFailed.value = false;
  try {
    await navigator.clipboard.writeText(snap.value?.dir ?? '');
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1200);
  } catch {
    // A button that did nothing and said nothing is indistinguishable from one
    // that worked — TimelinePage's copy() learned that the same way.
    copyFailed.value = true;
  }
}

const busy = computed(() => modelStore.busy);
</script>

<template>
  <div class="sub-h">{{ S.model_title }}</div>
  <div class="card model-card">
    <!-- ④ of the shard's copy discipline: WHY there is a download at all. First
         line of the card, present in every state including `ready`. -->
    <p class="sub why">{{ S.model_why }}</p>

    <div class="row head">
      <span class="chip" :class="face">{{ STATE_LABEL[face] }}</span>
      <span v-if="snap && snap.model_id" class="mono mid">{{ snap.model_id }}</span>
    </div>

    <p v-if="stale" class="sub warn">{{ S.model_unreachable }}</p>

    <!-- ready — what the verdict does and does not certify (§3). -->
    <p v-if="face === 'ready'" class="sub">{{ S.model_verified }}</p>

    <!-- downloading — the quantity, the file, the source, the time (§2-4/§2-6). -->
    <template v-if="face === 'downloading'">
      <div class="bar" :class="{ indeterminate: pct === null }">
        <div v-if="pct !== null" class="fill" :style="{ width: pct + '%' }"></div>
      </div>
      <div class="row nums">
        <span class="pctv" v-if="pctText">{{ pctText }}</span>
        <span class="sub">{{ S.model_downloaded }} {{ doneText }} / {{ totalText }}</span>
        <span class="sub" v-if="rateText">· {{ rateText }}</span>
        <span class="sub">· {{ etaText }}</span>
      </div>
      <div class="row nums" v-if="filesText || snap?.current_file">
        <span class="sub" v-if="filesText">{{ filesText }}</span>
        <span class="mono mid" v-if="snap?.current_file">{{ snap.current_file }}</span>
      </div>
      <div class="row nums" v-if="sourceText">
        <span class="sub">{{ S.model_source }}: {{ sourceText }}</span>
      </div>
      <p class="sub" v-if="sourceText">{{ S.model_source_note }}</p>
      <p class="sub" v-if="resumedText">{{ resumedText }}</p>
      <p class="sub">{{ S.model_cancel_note }}</p>
    </template>

    <!-- failed — the reason lives in the fold; what is up here is what to DO. -->
    <p v-if="face === 'failed'" class="sub">{{ S.model_failed_next }}</p>

    <!-- absent / partial / failed — the second exit, always stated. -->
    <p v-if="face === 'absent' || face === 'partial' || face === 'failed'" class="sub">
      {{ S.model_manual }}
    </p>

    <div class="row acts">
      <button v-if="face === 'absent'" class="btn pri" type="button" :disabled="busy !== ''"
              @click="startModelDownload()">
        {{ busy === 'download' ? S.model_starting : downloadLabel }}
      </button>
      <button v-if="face === 'partial'" class="btn pri" type="button" :disabled="busy !== ''"
              @click="startModelDownload()">
        {{ busy === 'download' ? S.model_starting : resumeLabel }}
      </button>
      <button v-if="face === 'failed'" class="btn pri" type="button" :disabled="busy !== ''"
              @click="startModelDownload()">
        {{ busy === 'download' ? S.model_starting : S.model_retry }}
      </button>
      <button v-if="face === 'downloading'" class="btn ghost sm" type="button" :disabled="busy !== ''"
              @click="cancelModelDownload()">
        {{ S.model_cancel }}
      </button>
      <button v-if="face !== 'downloading'" class="btn ghost sm" type="button" :disabled="busy !== ''"
              @click="recheckModel()">
        <Icon name="refresh" />{{ busy === 'recheck' ? S.model_checking : S.model_recheck }}
      </button>
    </div>

    <p v-if="modelStore.actionError" class="sub warn">{{ S.model_action_failed }}</p>

    <div class="row dir" v-if="snap && snap.dir">
      <span class="sub">{{ S.model_dir }}</span>
      <code class="mono path">{{ snap.dir }}</code>
      <button class="btn ghost sm" type="button" @click="copyDir()">
        <Icon name="copy" />{{ copied ? S.model_copied : S.model_copy }}
      </button>
    </div>
    <p v-if="copyFailed" class="sub warn">{{ S.model_copy_failed }}</p>

    <!-- The machine truth, kept and folded rather than dropped: the whole point
         of replacing the developer sentence was to move it, not delete it. -->
    <details class="fold" v-if="snap?.error || modelStore.actionError">
      <summary class="sub">{{ S.model_detail }}</summary>
      <p class="mono detail" v-if="snap?.error">{{ snap.error.code }}: {{ snap.error.message }}</p>
      <p class="mono detail" v-if="modelStore.actionError">{{ modelStore.actionError }}</p>
    </details>

    <!-- ① of the copy discipline: the environment variable lives HERE and
         nowhere else on this surface. -->
    <details class="fold">
      <summary class="sub">{{ S.model_adv }}</summary>
      <p class="sub">{{ S.model_adv_body }}</p>
    </details>
  </div>
</template>

<style scoped>
.model-card { padding: 12px 14px; }
.why { line-height: 1.6; margin: 0 0 8px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.head { margin-bottom: 6px; }
.nums { margin-top: 4px; }
.acts { margin-top: 10px; }
.dir { margin-top: 10px; }
.mid { font-size: 11.5px; color: var(--t3); }
/* The state word carries the same colour vocabulary the rest of the product
   uses: green = the thing is done, amber = nothing broke but it is not done
   either, red = it failed, slate = we do not know. */
.chip { font-size: 11.5px; border-radius: 999px; padding: 2px 10px; border: 1px solid var(--line); color: var(--t2); }
.chip.ready { background: var(--green-soft); border-color: var(--green); color: var(--green-ink); }
.chip.absent, .chip.partial { background: var(--amber-soft); border-color: var(--amber-line); color: var(--amber-ink); }
.chip.downloading { background: var(--brand-soft); border-color: var(--brand-line); color: var(--brand-ink); }
.chip.failed { background: var(--red-soft); border-color: var(--red); color: var(--red-ink); }
.chip.unknown { background: var(--off-chip-bg); color: var(--t3); }
.bar { height: 6px; border-radius: 999px; background: var(--surface-inset); overflow: hidden; margin-top: 8px; }
.fill { height: 100%; background: var(--brand); border-radius: 999px; }
/* No width to animate, because there is no percentage to show: the stripes say
   「moving, amount unknown」 rather than drawing a bar at some invented length. */
.bar.indeterminate {
  background: repeating-linear-gradient(115deg, var(--brand-soft) 0 10px, var(--surface-inset) 10px 20px);
}
.pctv { font-size: 12px; font-weight: 700; color: var(--t1); }
.warn { color: var(--amber-ink); }
.path { font-size: 11.5px; color: var(--t2); background: var(--surface-inset); border-radius: 6px;
  padding: 2px 8px; user-select: text; word-break: break-all; }
.fold { margin-top: 10px; }
.fold summary { cursor: pointer; }
.detail { font-size: 11.5px; color: var(--t3); margin-top: 6px; user-select: text; word-break: break-all; }
</style>
