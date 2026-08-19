// verify/lint/changelog-release-sections.mjs
//
// 🔴 TWO QUESTIONS ABOUT SHIPPED RELEASE NOTES, ASKED BY ONE GATE:
//   (1) does every released version still have a section?    — presence
//   (2) does every released section still say what it said?  — the pin
//
// ── WHY BOTH LIVE IN ONE LINT ─────────────────────────────────────────────
// They share the thing that is hard to get right: deciding which sections are
// HISTORY and which one is still being written. That decision has to have
// exactly ONE implementation. Two lints deciding it separately can disagree
// about which section is history, and then one of them is wrong while both are
// green. This repo already pays for the same function existing three times —
// `changelogSection()` is copied into scripts/publish-github-release.mjs,
// scripts/publish-download-center.mjs and scripts/release-status.mjs, each with
// a comment explaining why its own copy is fine — and a second copy of the
// RELEASED LIST, the one record the changelog's author cannot edit, would be
// the worst place to start a fourth.
// The cost of merging is that one PASS line answers two questions, which is
// this repo's number-one bug shape. It is paid down by printing both answers as
// separate clauses and never sharing a failure message between them.
//
// ── THE INCIDENT (2026-08-17, 0.3.8) ──────────────────────────────────────
// The 0.3.8 notes were written on a 0.3.7 tree. Two release drills went red,
// because they want a section for the version being released. The repair that
// makes them green in one keystroke is to RETITLE the heading already at the
// top — and that is what shipped: `-## 0.3.7` / `+## 0.3.8` in commit daf2ce48,
// folding SIX already-released 0.3.7 entries into 0.3.8's notes. The public
// release page went out carrying them. Restored in 3195d5dd.
//
// ⚠️ MEASURED CORRECTION to what this header used to claim. It said "both
// publish scripts refuse when the FIRST `## x.y.z` heading is not the version
// being released". No script in this repo has that rule. All three consumers —
// grep `log.split(/^## /m)` in scripts/publish-github-release.mjs,
// scripts/publish-download-center.mjs and scripts/release-status.mjs — scan
// EVERY section and take the first whose title MENTIONS the version. Position
// is not part of it.
//
// ⚠️ AND A CORRECTION TO THIS CORRECTION, caught before it shipped. A first
// draft of these lines also said the HTML comment above the restored
// `## 0.3.7` heading in CHANGELOG.md still blames `bump-version.mjs` for
// renaming headings. At HEAD it does not: that comment has already been
// corrected in place and now says the rename was done by hand — which matches
// `grep -i changelog scripts/bump-version.mjs`, 0 hits, at HEAD and at both
// commits above (CHANGELOG.md is not in that script's FACES table). The draft
// had read the claim out of commit 3195d5dd and never re-read the file.
// ⇒ Reading a claim at the commit that introduced it is not reading it. The
// only thing left wrong in that comment is the "first heading" clause above,
// which is the same sentence this header was repeating; fixing it is a
// CHANGELOG.md edit, not this file's to make, and is reported instead.
//
// ── WHAT THE PRESENCE CHECK ALONE COULD SEE (measured on this tree) ───────
// Four reverse controls against the pre-pin lint. CHANGELOG.md was put back by
// LINE INDEX after each; sha256 back to d227af5637eb… and
// `git diff -- CHANGELOG.md` 0 bytes every time.
//
//   A. rename the newest released heading, `## 0.3.9` -> `## 0.4.0`
//      FAIL "1 released version(s) have no CHANGELOG section: 0.3.9…"
//      ⇒ the plain incident shape WAS already caught. Said plainly because the
//        brief for this work assumed it was not: the released list comes from
//        git, not from the changelog, so a heading that vanishes is visible.
//
//   B. rename it to the combined-round spelling, `## 0.4.0（含 0.3.9）`
//      PASS "35 released version(s), every one still has its own section"
//      ⇒ INVISIBLE. Every number on a `## ` line counts as documented, so
//        folding a shipped section under the next version's heading passes for
//        as long as the old number is still printed somewhere on that line. The
//        spelling is not exotic — `## 0.2.52（含 0.2.51）` is already in the
//        file, so the diff reads as a legitimate combined round.
//
//   C. delete a shipped section's six bullets, heading untouched
//      PASS "35 released version(s), every one still has its own section"
//      ⇒ INVISIBLE. Presence is presence; the body was never looked at.
//
//   D. rename `## 0.3.2` -> `## 0.3.3` — the exact incident shape one version
//      further back, leaving two `## 0.3.3` headings and no `## 0.3.2`
//      PASS "35 released version(s), every one still has its own section"
//      ⇒ INVISIBLE, for a third reason: the released list was built by
//        `^chore\(release\):\s*v?(\d+\.\d+\.\d+)`, which does not match the
//        seven subjects spelled `chore(release): bump to x.y.z …`. EIGHT
//        released versions sat outside this gate — 0.3.2, 0.3.1, 0.3.0 (the
//        open-source milestone), 0.2.65, 0.2.64, 0.2.63, 0.2.62, and a 0.1.0
//        that a subject only mentions in passing. 45 release commits produced
//        35 versions, and the PASS line printed 35 as though that were the
//        answer. The subject pattern now accepts `bump to`; measured after
//        widening, 42 released versions and 0 missing sections.
//
// ── THE PIN ───────────────────────────────────────────────────────────────
// verify/lint/changelog-release-sections-baseline.mjs holds one entry per
// released version: `version|sha256-12 of the section|line count`. A section is
// its `## ` heading line through the line before the next `## `, with trailing
// whitespace stripped per line and trailing blank lines dropped — nothing else
// is normalised, because a shipped section is history and re-wrapping history
// is still editing it.
//
// The line count is a second copy of a fact, so it is CHECKED, not merely
// printed: a hand-edited count fails on its own. It earns its place by making
// the message diagnostic — "pinned 22 lines, now 24" says entries were folded
// in; the same count on both sides says words changed in place.
//
// RE-PINNING IS A DELIBERATE ACT. There is no --fix and there will not be one.
// `CHANGELOG_PIN_DUMP=1 pnpm verify:lint` prints paste-ready entries to stderr;
// a human pastes them into the baseline, where they land in a diff someone
// reads. A flag that re-pins silently restores the exact property this gate
// exists to remove — an edit to shipped history that nobody has to see.
//
// ── RELEASED vs IN PROGRESS, AND WHAT THAT COSTS ─────────────────────────
// Released = a `chore(release): x.y.z` commit names it. In progress = a `## `
// heading whose version has no such commit. Only released versions are pinned,
// so writing the next section is normal work and this gate stays silent about
// it. The discriminator is git because that is the one record not editable by
// the same hand that edits the changelog.
//
// Three costs, stated rather than hidden:
//   · A version becomes released the instant its `chore(release)` commit lands,
//     and has no pin until someone adds one. That run is RED, by design, and it
//     lands squarely in the release runbook: pre-commit is green (the commit
//     does not exist yet), the next run is not. Pinning in the same round is
//     the fix. Letting unpinned pass quietly is how the hole comes back.
//   · Squashed history (the open-source export) has no release commits, so
//     neither question can be asked. Reported as SKIP with a reason, never as
//     PASS — a gate that says PASS after comparing an empty list to anything is
//     the shape this repo keeps getting caught by.
//   · The pin says THAT a section changed, not what changed. `git diff` says
//     what. This gate's only job is to make sure somebody is asked.
//
// ── REVERSE CONTROL, VERBATIM (this tree, with the pin in place) ──────────
// `NO_COLOR=1 node verify/lint/run-all.mjs`, the 2026-08-17 shape applied to the
// newest released heading. Both readings are the gate's own line, unedited.
//
// (1) `## 0.3.9` -> `## 0.4.0` — the plain rename, shape A above:
//
//   FAIL changelog-release-sections (265ms) 1 released version(s) have no
//   CHANGELOG section: 0.3.9. A section that vanished did not vanish quietly —
//   its entries are now under some other version's heading. Restore the heading
//   rather than deleting the release commit. | 1 released version(s) no longer
//   have a section to fingerprint: 0.3.9.
//
// (2) `## 0.3.9` -> `## 0.4.0（含 0.3.9）` — shape B, the spelling that PASSED
//     before the pin existed:
//
//   FAIL changelog-release-sections (197ms) 1 shipped section(s) no longer match
//   what was pinned: 0.3.9 (pinned 26 lines/0a6d6f8fb40d, now 26
//   lines/3a786e7a25af). A released section is history: it is where "what did
//   that version say" gets answered, and folding it into the next version's
//   notes is what shipped on 2026-08-17. If the edit is deliberate and correct —
//   a typo fix in already-published copy — re-pin on purpose: run
//   `CHANGELOG_PIN_DUMP=1 pnpm verify:lint` and paste the printed entries into
//   verify/lint/changelog-release-sections-baseline.mjs. There is no --fix.
//
// 26 lines on BOTH sides in (2) is the line count doing the job it is there for:
// same length, different words, so the reader knows to look for a retitle rather
// than for folded-in entries.
//
// Restored by line index after each run; sha256 of CHANGELOG.md back to
// d227af5637eb… and `git diff -- CHANGELOG.md` 0 bytes.
//
// ⚠️ A restore by string replace corrupted CHANGELOG.md once during this work:
// the rename in D produced a SECOND `## 0.3.3`, and replacing the first match
// put the heading back in the wrong place, swapping two sections. A reverse
// control is only reverse if the restore is exact — index the line, do not
// match the text.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './_util.mjs';
import { SHIPPED_SECTIONS } from './changelog-release-sections-baseline.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/changelog-release-sections.mjs` evaluates this module and exits 0 without
// checking anything -- a silence indistinguishable from a pass (it was written
// down as one twice; see the guard's header). platform-cfg-count carried this
// alone since 2026-08-10; every registered lint carries it since 2026-08-19.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

// `bump to` is accepted because seven release commits are spelled that way and
// were silently outside this gate until 2026-08-19 (measurement D above).
// Still anchored at the start on purpose: `chore(release): Cargo.lock back-fill
// 0.2.48` and `chore(release): withdraw the 0.2.60 built from …` are not
// releases of the version they mention, and a loose "first number anywhere"
// pattern adopts both.
const RELEASE_SUBJECT = /^chore\(release\):\s*(?:bump to\s+)?v?(\d+\.\d+\.\d+)/;

const VERSION_RE = /\d+\.\d+\.\d+/g;

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

/** Every `## …` heading in file order. A combined round is written
 *  `## 0.2.52（含 0.2.51）` and covers both, so every number on the line counts. */
function headings(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('## ')) continue;
    const title = lines[i].slice(3).trim();
    out.push({ line: i, title, versions: new Set(title.match(VERSION_RE) ?? []) });
  }
  return out;
}

/** Versions named by any `## …` heading. */
function documentedVersions(hs) {
  const found = new Set();
  for (const h of hs) for (const v of h.versions) found.add(v);
  return found;
}

/** Index into `hs` of the section that OWNS this version: an exact `## <v>`
 *  heading when there is one, otherwise the first heading that names it.
 *  Without the exact-heading preference, `## 0.2.52（含 0.2.51）` would own
 *  0.2.51 as well, and the standalone `## 0.2.51` section below it would be
 *  pinned by nobody. */
function ownerHeading(hs, version) {
  let fallback = -1;
  for (let k = 0; k < hs.length; k++) {
    if (!hs[k].versions.has(version)) continue;
    if (hs[k].title === version) return k;
    if (fallback === -1) fallback = k;
  }
  return fallback;
}

function sectionText(lines, hs, k) {
  const start = hs[k].line;
  const end = k + 1 < hs.length ? hs[k + 1].line : lines.length;
  return lines.slice(start, end).join('\n');
}

/** The heading line is included on purpose: it makes `## 0.3.9` ->
 *  `## 0.3.9（含 …）` an edit too. Normalisation is deliberately thin —
 *  trailing whitespace and trailing blank lines only. */
function fingerprint(text) {
  const norm = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
  return {
    digest: createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 12),
    lines: norm === '' ? 0 : norm.split('\n').length,
  };
}

const entryFor = (version, fp) => `${version}|${fp.digest}|${fp.lines}`;

/** Parse the baseline, REFUSING anything malformed or duplicated rather than
 *  skipping it. A pin that quietly fails to parse is a slot, and a slot absorbs
 *  the very edit it was meant to catch. */
function parsePins() {
  const pins = new Map();
  const bad = [];
  for (const raw of SHIPPED_SECTIONS) {
    const parts = String(raw).split('|');
    const [version, digest, lines] = parts;
    if (
      parts.length !== 3
      || !/^\d+\.\d+\.\d+$/.test(version ?? '')
      || !/^[0-9a-f]{12}$/.test(digest ?? '')
      || !/^\d+$/.test(lines ?? '')
    ) {
      bad.push(String(raw));
      continue;
    }
    if (pins.has(version)) {
      bad.push(`${raw} (duplicate entry for ${version})`);
      continue;
    }
    pins.set(version, { digest, lines: Number(lines) });
  }
  return { pins, bad };
}

const REPIN =
  'If the edit is deliberate and correct — a typo fix in already-published copy — re-pin on '
  + 'purpose: run `CHANGELOG_PIN_DUMP=1 pnpm verify:lint` and paste the printed entries into '
  + 'verify/lint/changelog-release-sections-baseline.mjs. There is no --fix.';

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

  const lines = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').split('\n');
  const hs = headings(lines);
  const documented = documentedVersions(hs);
  const { pins, bad } = parsePins();
  const releasedSet = new Set(released);

  const missing = [];
  const unpinned = [];
  const changed = [];
  const dump = [];
  for (const v of released) {
    const k = ownerHeading(hs, v);
    if (k === -1) {
      missing.push(v);
      continue;
    }
    const fp = fingerprint(sectionText(lines, hs, k));
    dump.push(entryFor(v, fp));
    const pin = pins.get(v);
    if (!pin) unpinned.push(v);
    else if (pin.digest !== fp.digest || pin.lines !== fp.lines) {
      changed.push(`${v} (pinned ${pin.lines} lines/${pin.digest}, now ${fp.lines} lines/${fp.digest})`);
    }
  }
  const stale = [...pins.keys()].filter((v) => !releasedSet.has(v));

  // Regenerating the baseline. Paste-ready lines go to stderr so `2>` captures
  // them without the suite's own PASS/FAIL lines mixed in — the same shape as
  // COORDINATE_ANCHORS_DUMP in verify/lint/coordinate-anchors.mjs.
  // ⚠️ A dump taken from a tree whose sections are already wrong pins the wrong
  // text. Regeneration is honest only when you have read the diff it blesses.
  if (process.env.CHANGELOG_PIN_DUMP) {
    for (const e of dump) process.stderr.write(`  '${e}',\n`);
  }

  const problems = [];
  if (bad.length > 0) {
    problems.push(
      `${bad.length} baseline entry(ies) malformed or duplicated: ${bad.slice(0, 4).join('; ')}. `
      + 'Entries are `version|sha256-12|lines` and come from the dump, not from typing.'
    );
  }
  // Presence first: when a heading is gone, its message is the actionable one.
  if (missing.length > 0) {
    problems.push(
      `${missing.length} released version(s) have no CHANGELOG section: ${missing.join(', ')}. `
      + 'A section that vanished did not vanish quietly — its entries are now under some other '
      + "version's heading. Restore the heading rather than deleting the release commit."
    );
    problems.push(
      `${missing.length} released version(s) no longer have a section to fingerprint: ${missing.join(', ')}.`
    );
  }
  if (changed.length > 0) {
    problems.push(
      `${changed.length} shipped section(s) no longer match what was pinned: ${changed.join('; ')}. `
      + 'A released section is history: it is where "what did that version say" gets answered, and '
      + "folding it into the next version's notes is what shipped on 2026-08-17. " + REPIN
    );
  }
  if (unpinned.length > 0) {
    problems.push(
      `${unpinned.length} released version(s) have no pin: ${unpinned.join(', ')}. `
      + 'This is what a release looks like the moment its `chore(release)` commit lands — pin it in '
      + 'the same round, with `CHANGELOG_PIN_DUMP=1 pnpm verify:lint`, or the next edit to it is '
      + 'invisible again.'
    );
  }
  if (stale.length > 0) {
    problems.push(
      `${stale.length} pinned version(s) are not in the release list: ${stale.join(', ')}. `
      + 'Either a release commit was rewritten or the baseline was hand-edited; a pin for a version '
      + 'nobody released certifies nothing.'
    );
  }

  if (problems.length > 0) return { status: 'FAIL', detail: problems.join(' | ') };

  return {
    status: 'PASS',
    detail:
      `${released.length} released version(s): every one still has its own section `
      + `(${documented.size} documented), and every one still matches its pin `
      + `(${pins.size} pinned in changelog-release-sections-baseline.mjs)`,
  };
}
