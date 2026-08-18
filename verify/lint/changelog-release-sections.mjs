// verify/lint/changelog-release-sections.mjs
//
// 🔴 EVERY VERSION THIS REPO HAS RELEASED MUST STILL HAVE ITS OWN SECTION.
//
// Measured 2026-08-17, on the 0.3.8 release, and the failure is worth stating
// exactly because the repair looked like housekeeping:
//
//   Both publish scripts refuse when the FIRST `## x.y.z` heading in CHANGELOG.md
//   is not the version being released. Notes for 0.3.8 were written first, on a
//   0.3.7 tree, so two release drills went red. The obvious repair — retitle the
//   heading that is already at the top — makes them green again, and silently
//   folds SIX shipped 0.3.7 entries into 0.3.8's notes. The public release page
//   went out carrying them.
//
// Nothing could see it: the drills only ask about the first heading, and it was
// correct. What disappeared was a heading NOBODY was asking about any more.
//
// So the question this gate asks is the one no other check asks: not "is the
// top of the file right", but "is every release still in the file". The list of
// releases comes from git — `chore(release): x.y.z` commits — because that is
// the only record that cannot be edited by the same hand that edits the
// changelog.
//
// ⚠️ In the exported open-source tree the history is a single squashed commit,
// so there are no release commits to find. That is reported as "nothing to
// check" rather than as a pass: a gate that says PASS after comparing an empty
// list to anything is the shape this repo keeps getting caught by.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './_util.mjs';

const RELEASE_SUBJECT = /^chore\(release\):\s*v?(\d+\.\d+\.\d+)/;

function releasedVersions() {
  let log;
  try {
    log = execFileSync('git', ['log', '--format=%s'], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    return null; // not a git checkout at all
  }
  const seen = new Set();
  for (const subject of log.split('\n')) {
    const m = RELEASE_SUBJECT.exec(subject.trim());
    if (m) seen.add(m[1]);
  }
  return [...seen].sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
  });
}

/** Versions named by any `## …` heading. A combined round is written
 *  `## 0.2.52（含 0.2.51）` and covers both, so every number on the line counts. */
function documentedVersions() {
  const md = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const found = new Set();
  for (const line of md.split('\n')) {
    if (!line.startsWith('## ')) continue;
    for (const v of line.match(/\d+\.\d+\.\d+/g) ?? []) found.add(v);
  }
  return found;
}

export default function run() {
  const released = releasedVersions();
  if (released === null) {
    return { status: 'SKIP', detail: 'not a git checkout — the release list is unreadable here' };
  }
  if (released.length === 0) {
    return {
      status: 'SKIP',
      detail: 'no `chore(release): x.y.z` commits in this history (squashed export) — nothing to check',
    };
  }
  const documented = documentedVersions();
  const missing = released.filter((v) => !documented.has(v));
  if (missing.length > 0) {
    return {
      status: 'FAIL',
      detail:
        `${missing.length} released version(s) have no CHANGELOG section: ${missing.join(', ')}. `
        + 'A section that vanished did not vanish quietly — its entries are now under some other '
        + "version's heading. Restore the heading rather than deleting the release commit.",
    };
  }
  return {
    status: 'PASS',
    detail: `${released.length} released version(s), every one still has its own section (${documented.size} documented)`,
  };
}
