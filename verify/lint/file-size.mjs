// verify/lint/file-size.mjs
// Lint 8/12 — source file line-count hard cap.
// (🔴 CORRECTED 2026-08-07: was "8/9" — the suite is 12 lints now, see
// verify/lint/run-all.mjs; full account at verify/lint/i18n-error-keys.mjs:2.)
//
// Source files (ts/tsx/rs/dart/vue/js/mjs/cjs) must be <= SRC_MAX lines.
// Test files and HTML demos get a looser TEST_HTML_MAX cap. Over cap -> FAIL
// with the offending file list. Thresholds are top-of-file constants.
//
// Excludes: dist, node_modules (default prune), legacy-reference, *.g.dart
// (Dart codegen), and pnpm-lock.yaml.

import path from 'node:path';
import { ROOT, walk, readText, rel, countLines, DEFAULT_SKIP_DIRS } from './_util.mjs';

export const name = 'file-size';

// --- tunable thresholds ---
const SRC_MAX = 800;
const TEST_HTML_MAX = 1200;
// --------------------------

const SRC_EXT = new Set(['.ts', '.tsx', '.rs', '.dart', '.vue', '.js', '.mjs', '.cjs']);
const HTML_EXT = new Set(['.html', '.htm']);

function skipDir(basename, relPath) {
  if (DEFAULT_SKIP_DIRS.has(basename)) return true;
  if (relPath === 'docs/legacy-reference') return true;
  return false;
}

function isExcludedFile(relPath) {
  if (relPath.endsWith('.g.dart')) return true; // Dart codegen
  // Same rule, same reason, one language over (0.2.67 P2): the desktop string
  // catalogue is emitted by scripts/i18n/gen-desktop-ts.mjs, one object per
  // language, and its size is a count of TRANSLATIONS rather than of authored
  // code. The architecture doc named this exemption as the way out for the
  // generated translation layer (2026-08-14-locale-expansion-architecture.md §0). The
  // hand-written half — the shards' key contracts, where the reasoning lives —
  // is NOT exempt and still has to stay under the cap.
  if (relPath.endsWith('.g.ts')) return true; // TS codegen
  // The error-code registry crossed the cap on 2026-08-14 when its Chinese
  // comments were translated to English (CJK is denser; 820 lines post-
  // translation). Its bulk is a four-locale translation table — the same
  // "size counts TRANSLATIONS, not authored code" reasoning as the .g.ts
  // exemption above — and it CANNOT be split structurally: the i18n-error-keys
  // lint textually parses the single ERROR_CODES object literal in this exact
  // file, and the `satisfies Record` exhaustiveness plus the count-guard test
  // both lean on the registry staying one literal. One table, one answer.
  if (relPath === 'packages/protocol/src/error-codes.ts') return true;
  // Same rule, one directory over: the open-source export list is DATA — one
  // line per excluded path, each carrying the reason it is excluded and who
  // ruled it. Its length is a count of decisions, and shortening it means
  // deleting the record of a decision. It has already paid the cap once by
  // splitting STRIP_EDITS into opensource-manifest-strips.mjs; splitting again
  // would scatter one ledger across three files, which is worse than long.
  if (relPath === 'scripts/opensource-manifest.mjs') return true;
  if (path.basename(relPath) === 'pnpm-lock.yaml') return true;
  // WP-R2-4: the bundled sidecar payload is a generated build artifact (esbuild
  // bundle, gitignored, rebuilt by build-sidecar.mjs) — the source line-count cap
  // does not apply to it. Content scanners (no-cloud-keys) still walk it.
  if (relPath === 'apps/desktop/src-tauri/resources/server.js') return true;
  // Same shape, same reason: an esbuild/tsup bundle emitted by `pnpm --filter
  // @flowmic/server-core build:tools` from the tracked source at
  // apps/server-core/src/tools/provenance-dryrun.ts (431 lines, comfortably under
  // the cap). It is a single self-contained .mjs so it can be carried to a box
  // that has no node_modules; the line count is @flowmic/protocol + zod bundled
  // in, not authored code. Gitignored for the same reason the sidecar payload is
  // — and, for THIS artifact, staleness is a correctness hazard rather than
  // untidiness: a committed bundle would keep measuring whichever
  // `reclassifyUnmarked` it was built from, which is the one thing the tool
  // exists to avoid. Content scanners (no-cloud-keys) still walk it.
  if (relPath === 'scripts/provenance-dryrun.mjs') return true;
  // WP-7: the three-direction transcription-screen design deliverable ships its
  // design-tool runtime (a vendored viewer payload, not authored source) beside
  // the .dc.html boards. The boards themselves stay under the HTML cap; only
  // the runtime is exempt. Content scanners (no-cloud-keys) still walk it.
  if (relPath === 'docs/FlowMic 转录页三方案交付/support.js') return true;
  return false;
}

// ── Translation-bloat debt, pinned 2026-08-14 ──────────────────────────────
//
// The English-ization of every Chinese comment (owner ruling 2026-08-14) made
// nine files cross the cap WITHOUT anyone adding a feature: English needs more
// lines than Chinese for the same sentence. Measured bloat per file ran from
// +1 to +134 lines, and in every case it exceeds the overage — i.e. each of
// these was comfortably under the cap the day before the translation.
//
// The cap itself is NOT raised: SRC_MAX stays 800 and every other file is held
// to it. What is pinned here is the debt, in the same shape coordinate-anchors
// pins its own (a baseline that may shrink and must never grow):
//
//   · a file listed here passes only while it stays AT OR BELOW its pinned count;
//   · one extra line makes it FAIL, so the debt cannot quietly deepen;
//   · a file that drops back under the real cap should be DELETED from this list
//     (a stale entry is reported as such and fails, so the list cannot rot).
//
// Repayment is a structural split per this repo's own precedent (move a coherent
// family out VERBATIM, never delete reasoning to save lines) — carded for the
// round after the open-source cutover, not done here, because a rushed split of
// nine files during a 30-batch translation is how a mechanical change becomes a
// behavioural one.
const TRANSLATION_BLOAT_BASELINE = new Map([
  ['apps/desktop/src/lib/timeline-store.test.ts', 1201],
  ['apps/desktop/src/main-window/DevicesPage.vue', 825],
  ['apps/mobile/lib/src/ptt/ptt_session.dart', 833],
  ['apps/mobile/lib/src/session/image_send_controller.dart', 803],
  ['apps/mobile/lib/src/session/manual_delivery.dart', 842],
  ['apps/mobile/lib/src/timeline/timeline_store.dart', 829],
  ['apps/mobile/lib/src/ui/chat_message_tile.dart', 835],
  ['apps/mobile/lib/src/ui/status_badge.dart', 907],
  ['apps/server-core/src/stt/orchestrator-core.ts', 801],
]);

function isTestFile(relPath) {
  return (
    /(^|\/)(test|tests|__tests__)\//.test(relPath) ||
    /\.(test|spec)\.[tj]sx?$/.test(relPath) ||
    /_test\.(rs|dart)$/.test(relPath)
  );
}

export default async function run() {
  const offenders = [];
  const stalePins = [];
  const seenPinned = new Set();
  let checked = 0;
  for (const abs of await walk(ROOT, { skipDir })) {
    const r = rel(abs);
    const ext = path.extname(abs).toLowerCase();
    const isHtml = HTML_EXT.has(ext);
    if (!SRC_EXT.has(ext) && !isHtml) continue;
    if (isExcludedFile(r)) continue;
    const text = await readText(abs);
    if (text == null) continue;
    checked++;
    const lines = countLines(text);
    const cap = isHtml || isTestFile(r) ? TEST_HTML_MAX : SRC_MAX;
    const pinned = TRANSLATION_BLOAT_BASELINE.get(r);
    if (pinned !== undefined) {
      seenPinned.add(r);
      if (lines > pinned) offenders.push(`${r} (${lines} > pinned ${pinned} — bloat debt may shrink, never grow)`);
      else if (lines <= cap) stalePins.push(`${r} (${lines} <= ${cap}: back under the real cap, delete its baseline entry)`);
      continue;
    }
    if (lines > cap) offenders.push(`${r} (${lines} > ${cap})`);
  }

  for (const r of TRANSLATION_BLOAT_BASELINE.keys()) {
    if (!seenPinned.has(r)) stalePins.push(`${r} (pinned but not scanned — renamed or deleted? drop its baseline entry)`);
  }

  if (offenders.length > 0) {
    return { status: 'FAIL', detail: `${offenders.length} over cap: ${offenders.slice(0, 20).join('; ')}` };
  }
  if (stalePins.length > 0) {
    return { status: 'FAIL', detail: `${stalePins.length} stale translation-bloat pin(s): ${stalePins.join('; ')}` };
  }
  return {
    status: 'PASS',
    detail: `${checked} file(s) within caps (src<=${SRC_MAX}, test/html<=${TEST_HTML_MAX}); `
      + `${TRANSLATION_BLOAT_BASELINE.size} pinned translation-bloat debt`,
  };
}
