// scripts/publish-notice-gate.mjs
// GATE 0b of scripts/publish.mjs, extracted VERBATIM so that file stays under
// the 800-line cap — the same precedent as publish-apk-gates.mjs (APK content)
// and publish-portable-archive.mjs (UP-9), and the same one this repository
// used the last two times a file reached the cap: move the block, never delete
// the reasoning. The paragraph below is the original, word for word; only its
// address changed.
//
// The extraction was paid for by GATE 0e (the copy-scent receipt check, card
// 2026-09-01). Recorded here because "why did this move?" is otherwise a
// question with no answer anywhere in the tree.
//
// ── GATE 0b: aggregate NOTICE current (card L4) ─────────────────────────────
//
// Same "cannot depend on memory" reasoning as Gate 0 above, applied to the
// third-party license NOTICE (scripts/generate-notice.mjs): Apache-2.0 §4(d)
// and the bundled MIT dependencies' own license terms require this file to
// accompany what's published, and a NOTICE that quietly drifted out of date
// (a dependency bumped, a new one added) is worse than an obviously-missing
// one — nobody notices "the license text is for last month's dependency
// set." `--check` regenerates the expected content in memory and diffs it
// against the committed ./NOTICE and apps/desktop/public/NOTICE without
// writing anything, so it is safe to run on every publish.
//
// Deliberately no bypass flag, matching Gate 0's stated reasoning verbatim:
// if this ever needs skipping, delete these lines in a visible commit.

import { spawnSync } from 'node:child_process';

/**
 * Exits the process on failure, exactly as it did inline: a gate that returns a
 * boolean the caller might ignore is a different gate from one that stops.
 *
 * @param {string} root repo root (the caller's ROOT)
 * @param {(m: string) => void} ok the caller's success printer
 */
export function verifyNoticeCurrent(root, ok) {
  console.log('── generate-notice --check (third-party license NOTICE) ─────────');
  const gate = spawnSync('node', ['scripts/generate-notice.mjs', '--check'], { cwd: root, stdio: 'inherit', shell: true });
  if (gate.error) {
    console.error(`✗ could not run \`node scripts/generate-notice.mjs --check\`: ${gate.error.message}`);
    console.error('  A gate that cannot run is a FAILED gate, not a skipped one.');
    process.exit(1);
  }
  if (gate.status !== 0) {
    console.error(`✗ NOTICE is missing or stale (exit ${gate.status}) — refusing to publish.`);
    console.error('  Run `node scripts/generate-notice.mjs` at the repo root, review the diff,');
    console.error('  commit ./NOTICE, then re-run publish.');
    process.exit(1);
  }
  ok('NOTICE current');
}
