<script setup lang="ts">
// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §5 / §7 / §8
//
// Settings → Data: the export / import UI.
//
// 🔴 EVERY DECISION IS SOMEWHERE ELSE. This file picks a destination, calls the
// pure planner (lib/portable/export.ts), calls the pure applier
// (lib/portable/import.ts), and renders what they answered. It computes nothing
// about the format and nothing about the numbers — a component is the one place
// in this repo where a second implementation would never be unit-tested.
//
// 🔴 §7-1's warning is standing text, not a post-export toast: the user has to
//    read it before pressing the button.
// 🔴 §5.2 partial success says partial success — [[isPartial]] decides whether
//    the heading reads "import complete" or "partially imported"; the UI has no
//    third path to make refused lines disappear.

import { computed, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import { S } from '../../lib/strings';
import { timeline } from '../store';
import { localKv } from '../../lib/storage';
import { appendForensic, fetchPairingInfo } from '../../lib/bridge';
// Split forced by the 800-line cap: the FPR v1 IPC gate moved to
// bridge-portable.ts (moved verbatim — see that file's header for "why this
// cut"). Deliberately not re-exported from bridge.ts — that would create a
// bridge → bridge-portable → bridge cycle, which `verify:lint circular` would
// flag red.
import {
  portableExport,
  portablePickOpen,
  portablePickSave,
  portablePictureDigests,
  portablePictureSizes,
  portableReadArchive,
  portableRestorePictures,
} from '../../lib/bridge-portable';
import { planExport, suggestedFileName, type ExportPlan } from '../../lib/portable/export';
import { applyImport, isPartial, type ImportReport } from '../../lib/portable/import';
import { PreservedFields } from '../../lib/portable/preserved';
import { buildReadme } from '../../lib/portable/readme';
import {
  formatBytes,
  pictureCandidates,
  type PictureFact,
} from '../../lib/portable/inventory';
import type { RefusalReason } from '../../lib/portable/fpr';
import { APP_VERSION } from '../../lib/version';
import type { TimelineRow } from '../../lib/types';

/** The dialog's file-type label. `.zip` is the container (owner ruling 4). */
const FILTER = 'FlowMic (*.zip)';

const preserved = new PreservedFields(localKv);

const rows = ref<TimelineRow[]>([]);
const pictures = ref<Map<string, PictureFact>>(new Map());
const device = ref<string | null>(null);
const includePictures = ref(true); // owner ruling 5: include by default
const plan = ref<ExportPlan | null>(null);

const busy = ref<'idle' | 'export' | 'import'>('idle');
const exportedTo = ref<string | null>(null);
const exportError = ref<string | null>(null);
const report = ref<ImportReport | null>(null);
const importError = ref<string | null>(null);
const refusedNames = ref<string[]>([]);
const picturesRestored = ref(0);
const picturesFailed = ref(0);

/** Sentences for the nine per-line refusal tags.
 *
 *  🔴 An EXHAUSTIVE `Record<RefusalReason, string>` rather than `S['pd_ref_' + r]`:
 *  the concatenated lookup compiles for a tag that has no sentence and renders
 *  `undefined`, which would put §5.2's "the reason must be named" back to "format
 *  error" without a single test going red. Built inside the function so it re-reads the reactive
 *  catalogue after a language switch. */
function refusalText(r: RefusalReason): string {
  const table: Record<RefusalReason, string> = {
    not_json: S.pd_ref_not_json,
    unsupported_version: S.pd_ref_unsupported_version,
    unknown_kind: S.pd_ref_unknown_kind,
    no_id: S.pd_ref_no_id,
    bad_created_at: S.pd_ref_bad_created_at,
    bad_mode: S.pd_ref_bad_mode,
    bad_status: S.pd_ref_bad_status,
    bad_entry_type: S.pd_ref_bad_entry_type,
    no_channel: S.pd_ref_no_channel,
  };
  return table[r];
}

/** Sentences for the file-layer tags portable::zip::ZipError::tag emits, plus
 *  the two this side can produce. An unknown tag still gets a sentence — but a
 *  DIFFERENT one, so an unmapped tag is visible instead of looking handled. */
function zipText(tag: string): string {
  switch (tag) {
    case 'io': return S.pd_zip_io;
    case 'not_a_zip': return S.pd_zip_not_a_zip;
    case 'corrupt': return S.pd_zip_corrupt;
    case 'compressed': return S.pd_zip_compressed;
    case 'unsafe_name': return S.pd_zip_unsafe_name;
    case 'no_such_entry': return S.pd_zip_no_such_entry;
    case 'bridge': return S.pd_zip_bridge;
    case 'shape': return S.pd_zip_shape;
    default: return S.pd_zip_unknown;
  }
}

function readmeText() {
  return {
    title: S.pd_readme_title,
    plain: S.pd_readme_plain,
    howto: S.pd_readme_howto,
    files: S.pd_readme_files,
    exportedLabel: S.pd_readme_exported,
    countLabel: S.pd_readme_count,
    deviceLabel: S.pd_readme_device,
    rowsUnit: S.pd_unit_rows,
  };
}

function buildPlan(digests?: ReadonlyMap<string, string>, now = new Date()): ExportPlan {
  return planExport({
    rows: rows.value,
    pictures: pictures.value,
    digests,
    includePictures: includePictures.value,
    version: APP_VERSION,
    device: device.value,
    now,
    // 🔴 §4.1 scope: this machine has already truncated anything earlier — the
    // store's own persisted cutoff, never a guess. `null` ⇒ the field is
    // omitted entirely.
    truncatedBefore: timeline.retention.cutoff,
    preserved,
    readme: (h) => buildReadme(readmeText(), h),
  });
}

/** Re-read the rows and re-measure the pictures. Cheap: the sizes call is
 *  `metadata().len()` per file, never a hash. */
async function refresh(): Promise<void> {
  rows.value = timeline.allRows();
  const ids = pictureCandidates(rows.value);
  const sizes = ids.length > 0 ? await portablePictureSizes(ids) : [];
  pictures.value = new Map(sizes.map((p) => [p.id, { bytes: p.bytes, ext: p.ext }]));
  plan.value = buildPlan();
}

function onToggle(): void {
  includePictures.value = !includePictures.value;
  plan.value = buildPlan();
}

async function doExport(): Promise<void> {
  if (busy.value !== 'idle' || plan.value === null) return;
  exportedTo.value = null;
  exportError.value = null;
  const now = new Date();
  // §7-2 — the destination is the USER's, always. A cancel is a normal answer
  // and says nothing on screen.
  const path = await portablePickSave(S.pd_export_title, FILTER, suggestedFileName(now));
  if (path === null) return;
  busy.value = 'export';
  try {
    const ids = includePictures.value ? [...pictures.value.keys()] : [];
    const digests = ids.length > 0 ? await portablePictureDigests(ids) : [];
    // The digest call re-measures, so its numbers supersede the estimate's: a
    // picture that changed between the two reads must not make the archive's
    // member name disagree with its bytes.
    const measured = new Map(pictures.value);
    for (const d of digests) measured.set(d.id, { bytes: d.bytes, ext: d.ext });
    pictures.value = measured;
    const p = buildPlan(new Map(digests.map((d) => [d.id, d.sha16])), now);
    const out = await portableExport({
      path,
      lines: p.lines,
      readme: p.readme,
      attachments: p.attachments,
    });
    if (out.ok) {
      // §7-3 — the message carries WHERE it landed, or the user does not know
      // which machine the unprotected copy is sitting on.
      exportedTo.value = out.value.path;
      appendForensic('portable', `export ok: ${out.value.records} records, ${out.value.attachments} pictures, ${out.value.bytes} bytes`);
    } else {
      exportError.value = `${zipText(out.error)}${out.detail === '' ? '' : ` (${out.detail})`}`;
    }
    plan.value = p;
  } finally {
    busy.value = 'idle';
  }
}

async function doImport(): Promise<void> {
  if (busy.value !== 'idle') return;
  report.value = null;
  importError.value = null;
  refusedNames.value = [];
  picturesRestored.value = 0;
  picturesFailed.value = 0;
  const path = await portablePickOpen(S.pd_import_title, FILTER);
  if (path === null) return;
  busy.value = 'import';
  try {
    const read = await portableReadArchive(path);
    if (!read.ok) {
      importError.value = `${zipText(read.error)}${read.detail === '' ? '' : ` (${read.detail})`}`;
      return;
    }
    refusedNames.value = read.value.refused_names;
    const r = applyImport({
      lines: read.value.lines,
      archiveAttachments: new Set(read.value.attachments),
      // The store IS the target — one row-minting entry point, see ImportTarget.
      target: timeline,
      preserved,
    });
    if (r.restore.length > 0) {
      const pics = await portableRestorePictures(path, r.restore);
      picturesRestored.value = pics.landed;
      picturesFailed.value = pics.failed;
    }
    report.value = r;
    appendForensic('portable', `import: +${r.added} =${r.skipped} refused=${r.refused.length} evicted=${r.evicted}`);
    await refresh();
  } finally {
    busy.value = 'idle';
  }
}

const inv = computed(() => plan.value?.inventory ?? null);
const partial = computed(() => (report.value === null ? false : isPartial(report.value)));

/** The file-level refusal, as one sentence naming what is wrong (§5.3). */
const fileRefusalText = computed<string | null>(() => {
  const f = report.value?.fileRefusal ?? null;
  if (f === null) return null;
  switch (f.kind) {
    case 'no_header': return S.pd_err_no_header;
    case 'unsupported_version': return `${S.pd_err_version}${f.found}`;
    case 'wrong_end':
      return f.end === 'mobile' ? S.pd_err_wrong_end_mobile : `${S.pd_err_wrong_end}${f.end}`;
    case 'count_mismatch':
      return `${S.pd_err_count} (${f.declared} / ${f.found})`;
    default: return S.pd_zip_unknown;
  }
});

function atLine(n: number): string {
  return S.pd_at_line.replace('{n}', String(n));
}

onMounted(() => {
  void (async () => {
    // The PC's own name for the header's `source.device`. A read that fails
    // leaves it null and the field is OMITTED — never a placeholder name.
    const info = await fetchPairingInfo();
    device.value = info.pc_name !== '' ? info.pc_name : null;
    await refresh();
  })();
});
</script>

<template>
  <div class="card pad">
    <!-- Reworked mockup §1.4: the one standing sentence this card keeps is
         §7-1's plain-language warning (must be read before pressing, must not
         be downgraded); the other two lines of messaging (export scope /
         where-to-save advice) hang off the things they each qualify — the
         heading and the button's tooltip, with a dotted underline marking
         "there's an explanation here." -->
    <div class="sub-h" :title="S.pd_export_hint">{{ S.pd_export_title }}</div>
    <div class="plain-warn" role="note">{{ S.pd_plain_warning }}</div>

    <template v-if="inv !== null && inv.count > 0">
      <div class="inv-line">
        <b>{{ inv.count }}</b><span class="muted">{{ S.pd_unit_rows }}</span>
        <span class="muted">·</span>
        <span class="mono">{{ formatBytes(inv.textBytes) }}</span>
        <template v-if="inv.withPicture > 0">
          <span class="muted">·</span>
          <span class="mono">{{ inv.withPicture }} / {{ formatBytes(inv.pictureBytes) }}</span>
        </template>
      </div>
      <!-- owner ruling 5: show the size live next to the checkbox; this number
           comes from bytes actually measured by the inventory layer. -->
      <div class="card pad prefs-row as-toggle" @click="onToggle">
        <span class="chk" :class="{ on: includePictures }"><Icon name="check" /></span>
        <div>
          <div class="prefs-label">{{ S.pd_include_pictures }}</div>
          <div class="muted" style="font-size:12px;margin-top:2px">{{ S.pd_include_pictures_hint }}</div>
        </div>
        <span class="est mono">{{ S.pd_estimate }} {{ formatBytes(plan?.bytes ?? 0) }}</span>
      </div>
      <button class="btn ghost sm" type="button" :disabled="busy !== 'idle'" :title="S.pd_pick_hint" @click="doExport">
        <Icon name="seg" />{{ busy === 'export' ? S.pd_exporting : S.pd_export_btn }}
      </button>
    </template>
    <div v-else class="muted small">{{ S.pd_export_empty }}</div>

    <div v-if="exportedTo !== null" class="ok-line">
      {{ S.pd_export_done }} <span class="mono path">{{ exportedTo }}</span>
    </div>
    <div v-if="exportError !== null" class="err-line" role="alert">
      {{ S.pd_export_failed }} {{ exportError }}
    </div>

    <hr class="sep" />

    <div class="sub-h" :title="S.pd_import_hint">{{ S.pd_import_title }}</div>
    <button class="btn ghost sm" type="button" :disabled="busy !== 'idle'" :title="S.pd_import_hint" @click="doImport">
      <Icon name="inbox" />{{ busy === 'import' ? S.pd_importing : S.pd_import_btn }}
    </button>

    <div v-if="importError !== null" class="err-line" role="alert">
      {{ S.pd_import_failed }} {{ importError }}
    </div>
    <div v-if="fileRefusalText !== null" class="err-line" role="alert">
      {{ S.pd_import_failed }} {{ fileRefusalText }}
    </div>

    <template v-if="report !== null && report.fileRefusal === null">
      <div class="ok-line" :class="{ partial }">
        {{ partial ? S.pd_import_partial : S.pd_import_done }}
      </div>
      <ul class="report">
        <li>{{ report.added }} {{ S.pd_unit_rows }} {{ S.pd_r_added }}</li>
        <li v-if="report.skipped > 0">{{ report.skipped }} {{ S.pd_unit_rows }} {{ S.pd_r_skipped }}</li>
        <li v-if="report.evicted > 0" class="warn">{{ report.evicted }} {{ S.pd_unit_rows }} {{ S.pd_r_evicted }}</li>
        <li v-if="report.attachmentMissing > 0" class="warn">
          {{ report.attachmentMissing }} {{ S.pd_unit_rows }}{{ S.pd_r_att_missing }}
        </li>
        <li v-if="report.picturesNotInFile > 0">
          {{ report.picturesNotInFile }} {{ S.pd_unit_rows }} {{ S.pd_r_no_pictures }}
        </li>
        <li v-if="picturesRestored > 0">{{ picturesRestored }} {{ S.pd_r_pictures }}</li>
        <li v-if="picturesFailed > 0" class="warn">{{ picturesFailed }} {{ S.pd_r_pictures_failed }}</li>
        <li v-if="report.preserveFailed" class="warn">{{ S.pd_r_preserve_failed }}</li>
      </ul>
      <div v-if="report.refused.length > 0" class="err-line" role="alert">
        {{ report.refused.length }} {{ S.pd_unit_rows }} {{ S.pd_r_refused }}
        <ul class="report">
          <li v-for="r in report.refused.slice(0, 10)" :key="r.line">
            {{ atLine(r.line) }}: {{ refusalText(r.reason) }}
          </li>
        </ul>
      </div>
    </template>

    <div v-if="refusedNames.length > 0" class="err-line" role="alert">
      {{ S.pd_r_refused_names }}
      <span class="mono path">{{ refusedNames.slice(0, 5).join(', ') }}</span>
    </div>
  </div>
</template>

<style scoped>
/* `.card.pad`'s padding and the first-heading rule have lived in tokens.css
   (the sole definition site) since 0.2.47. */
.sub-h { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.small { font-size: 12.5px; line-height: 1.55; }
/* 0.2.45: headings no longer carry a dotted underline (four underlined
   headings on one page read like a wall of hyperlinks — one of the layout
   ailments owner circled); the tooltip is still on `title`. The dotted-
   underline mark is now reserved for inline values. */
.plain-warn {
  display: flex; align-items: flex-start; gap: 8px;
  margin: 8px 0; padding: 8px 12px; border-radius: 8px;
  background: var(--amber-soft); color: var(--amber-ink);
  font-size: 12.5px; line-height: 1.55;
}
.inv-line { display: flex; align-items: baseline; gap: 6px; font-size: 13px; margin: 10px 0 8px; flex-wrap: wrap; }
.prefs-row { display: flex; align-items: center; gap: 14px; }
.prefs-row.as-toggle { cursor: pointer; margin-bottom: 12px; }
.prefs-label { font-size: 13.5px; font-weight: 600; }
.est { margin-left: auto; font-size: 12.5px; color: var(--t3); white-space: nowrap; }
.ok-line { margin-top: 10px; font-size: 12.5px; line-height: 1.55; }
.ok-line.partial { color: var(--amber-ink); }
.err-line { margin-top: 8px; color: var(--red); font-size: 12px; line-height: 1.5; }
.path { word-break: break-all; }
.sep { border: 0; border-top: 1px solid var(--line); margin: 16px 0 14px; }
.report { margin: 6px 0 0; padding-left: 18px; font-size: 12.5px; line-height: 1.6; }
.report .warn { color: var(--amber-ink); }
</style>
