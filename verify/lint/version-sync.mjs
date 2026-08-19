// verify/lint/version-sync.mjs
// Lint 7/12 — version sync across the monorepo faces.
// (🔴 CORRECTED 2026-08-07: was "7/9" — the suite is 12 lints now, see
// verify/lint/run-all.mjs; full account at verify/lint/i18n-error-keys.mjs:2.)
//
// root package.json is the reference version. Every other face must match:
//   - each workspace package.json (packages/*, apps/*)
//   - tauri.conf.json (desktop)
//   - pubspec.yaml (mobile)
//   - Cargo.toml (desktop src-tauri)
//   - Cargo.lock (desktop src-tauri) — the flowmic-desktop crate's own
//     `name = "…"` + `version = "…"` line pair (see the note further down)
//   - bootstrap.ts SERVER_VERSION (server-core)
//   - CLAUDE.md's <!--version:current--> anchor
//   - CLAUDE.public.md's OWN <!--version:current--> anchor (IT-32, 2026-08-06:
//     registered under its own filename, independent of the rename that
//     scripts/opensource-manifest.mjs applies on public export — before this
//     it only became a face AFTER that rename, so a public export tree could
//     fail its own version-sync on arrival with nobody here to see it fail)
// EXCEPTION: @flowmic/protocol carries an independent version and is excluded.
//
// This header undercounted its own coverage for a while — a guard that
// under-reports what it checks makes the next reader assume the missing
// faces are unguarded and hand-edit them (that is exactly how CLAUDE.public.md
// and Cargo.lock drifted before IT-28/IT-32 added them here). Keep this list
// in step with the body AND with scripts/bump-version.mjs's FACES table —
// the two answer the same question by different means (one discovers by
// walking directories, the other is hand-maintained), so trust
// `pnpm verify:lint`'s reported face count over any number written in either
// file's comments.
//
// SCOPE IS THIS REPO ONLY. The web console repo runs an independent version
// line since 0.2.0 (owner 2026-07-27) — do not reach outside the worktree.
//
// 🔴 WHAT THIS LINT DOES NOT CHECK (IT-C1, 2026-08-06): it asks whether the
// faces AGREE with root. It never asks whether root MOVED FORWARD, and it
// structurally cannot — it sees one tree, not a history. A downgraded tree is
// perfectly self-consistent, so this reports PASS on it: measured, a tree
// walked from 0.2.54 back to 0.2.45 returns `PASS 11 face(s) @ 0.2.45`. That
// is why the monotonicity refusal lives in scripts/bump-version.mjs, at the
// only moment where the previous value is still known. Do not read a green
// version-sync as "the version number has never gone backwards" — it does not answer that question.
//
// Faces that do not exist are handled by kind, NOT uniformly (IT-C1):
//   - discovery-based faces (workspace packages, tauri.conf.json, pubspec.yaml)
//     absent -> SKIP, because absence there means "this tree is shaped
//     differently", which is not this lint's business;
//   - fixed-list faces below: absent -> FAIL, UNLESS the entry carries an
//     `optional` note saying which tree legitimately lacks it and why.
//     A blanket "absent ⇒ skip" is how a face stops being maintained without
//     anyone noticing: delete CLAUDE.md and the gate used to go green. The
//     `optional` marker is the difference between a human having decided that
//     in advance and nobody having noticed at all — you cannot get a silent
//     skip without editing this file, and editing it is a code review.
//     (Kept in step with scripts/bump-version.mjs's FACES table, which now
//     makes the same distinction by the same means.)
// A face that disagrees with root -> FAIL.
//
// 🔴 IT-41 (2026-08-07): an `optional` note used to be trusted on its word — a
// human wrote it once, correctly, and nothing ever checked it again. Every
// `optional` entry is now cross-checked against scripts/opensource-manifest.mjs's
// EXCLUDE list (via verify/golden/requires.mjs's publicExportExclusions() /
// excludedBy() — the same functions IT-40 built for golden's `requires`, not a
// second copy of "is this path excluded"): marked-but-not-excluded, or
// excluded-but-not-marked, both FAIL. This is the third-iteration ledger's own
// prescription (§7-3c): "this round, to fix 'one relation, two declaration sites', created a third declaration site
// — and it is the correct one. The next step is not to invent a fourth; it is to make the other two ask it." This file is
// one of the two askers now; scripts/bump-version.mjs's FACES table is the other.

import path from 'node:path';
import { ROOT, walk, readText, readJson, rel, DEFAULT_SKIP_DIRS } from './_util.mjs';
// IT-41: the `optional:` notes below used to be self-attesting — nothing checked
// them against scripts/opensource-manifest.mjs's EXCLUDE list, the actual truth
// about what a public export drops. verify/golden/requires.mjs's internalOnly()
// already does this correctly for golden's `requires` lists (built for IT-40); this
// asks THAT mechanism rather than re-deriving a second copy of "is this path
// excluded" (see its own header, property ③, for why the check must be against
// EXCLUDE and not inferred from absence).
import { publicExportExclusions, publicExportReplacements, excludedBy } from '../golden/requires.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/version-sync.mjs` evaluates this module and exits 0 without
// checking anything -- a silence indistinguishable from a pass (it was written
// down as one twice; see the guard's header). platform-cfg-count carried this
// alone since 2026-08-10; every registered lint carries it since 2026-08-19.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'version-sync';

const EXCLUDED_PKG_NAMES = new Set(['@flowmic/protocol']);

function skipDir(basename) {
  return DEFAULT_SKIP_DIRS.has(basename);
}

function yamlVersion(text) {
  // pubspec.yaml: a top-level `version: x.y.z` line.
  const m = /^version:\s*['"]?([^\s'"]+)['"]?/m.exec(text);
  return m ? m[1] : null;
}

export default async function run() {
  const rootPkg = await readJson(path.join(ROOT, 'package.json'));
  if (!rootPkg || !rootPkg.version) {
    return { status: 'FAIL', detail: 'root package.json has no version' };
  }
  const ref = rootPkg.version;

  const faces = []; // { face, version } present
  const skipped = []; // face labels absent

  // Workspace package.json files under packages/* and apps/*
  let pkgCount = 0;
  for (const g of ['packages', 'apps']) {
    for (const abs of await walk(path.join(ROOT, g), { skipDir })) {
      if (path.basename(abs) !== 'package.json') continue;
      // only immediate <g>/<name>/package.json
      const r = rel(abs);
      if (r.split('/').length !== 3) continue;
      const pkg = await readJson(abs);
      if (!pkg) continue;
      if (pkg.name && EXCLUDED_PKG_NAMES.has(pkg.name)) continue; // protocol excluded
      pkgCount++;
      faces.push({ face: r, version: pkg.version ?? '(none)' });
    }
  }
  if (pkgCount === 0) skipped.push('workspace-packages');

  // tauri.conf.json (search under apps/*/src-tauri or anywhere non-pruned)
  let tauriFound = false;
  for (const abs of await walk(path.join(ROOT, 'apps'), { skipDir })) {
    if (path.basename(abs) === 'tauri.conf.json') {
      const conf = await readJson(abs);
      const v = conf?.version ?? conf?.package?.version ?? '(none)';
      faces.push({ face: rel(abs), version: v });
      tauriFound = true;
    }
  }
  if (!tauriFound) skipped.push('tauri.conf.json');

  // pubspec.yaml (mobile)
  let pubspecFound = false;
  for (const abs of await walk(path.join(ROOT, 'apps'), { skipDir })) {
    if (path.basename(abs) === 'pubspec.yaml') {
      const text = await readText(abs);
      const v = text ? yamlVersion(text) : null;
      faces.push({ face: rel(abs), version: v ?? '(none)' });
      pubspecFound = true;
    }
  }
  if (!pubspecFound) skipped.push('pubspec.yaml');

  // owner 2026-07-27: with a patch bump per round, the version IS the "which release"
  // answer, so a face that drifts turns it into a second lie on top of the first
  // (book 13 D5). These two carry the version too and were NOT checked before —
  // Cargo.toml stamps the exe metadata, SERVER_VERSION is what /api/health
  // reports (and what the desktop's adopt probe reads back).
  // owner 2026-07-28 (requirement ⑧): the DOC face joins the machine faces. CLAUDE.md
  // asserted "currently 0.1.1" while root was 0.1.11 — the version discipline drifted
  // inside the file that declares it. Only the `<!--version:current-->` anchored
  // span is read (and only it is written by bump-version.mjs): the historical
  // "defer to 0.2" / "into 0.1.0" in decision logs and task cards must NEVER be rewritten.
  // IT-32 / IT-28 (2026-08-06): two faces that were in neither this list nor
  // bump-version.mjs's FACES table. CLAUDE.public.md carries the same anchor
  // syntax as CLAUDE.md but is matched under ITS OWN filename here (not by
  // reusing the CLAUDE.md entry) — see the file-header note on why "only
  // becomes a face after the export rename" was the bug.
  // 🔴 IT-C1: the Cargo.lock pattern anchors on the crate's own
  // `name = "flowmic-desktop"` line IMMEDIATELY followed by its `version = "…"`
  // line. It does NOT contain `[[package]]`, though the comment here used to
  // say it did (anti-façade ④ — a comment asserting a property the code does
  // not have). The uniqueness comes from the adjacent PAIR: measured, the file
  // has 507 `version = "…"` lines and 507 `[[package]]` blocks, and Cargo emits
  // `name` directly above `version` in each, so this pair hits exactly once
  // while a bare `version = "…"` pattern would hit all 507.
  // IT-41: cross-check every fixed-list entry's `optional` note against the
  // manifest BEFORE trusting it. `exclude` is null when this tree IS the export
  // (opensource-manifest.mjs does not exist there — see requires.mjs property ②),
  // in which case there is nothing to cross-check against and the loop below
  // falls back to trusting the note, same as before this card.
  const exclude = await publicExportExclusions();
  const replacements = await publicExportReplacements();
  // CLAUDE.md is EXCLUDEd (raw copy dropped) AND a REPLACE destination
  // (CLAUDE.public.md's content lands there) — so it is NOT actually absent
  // from the exported tree, only its content differs. An EXCLUDE hit on a
  // REPLACE destination must not read as "gone", or this face would demand an
  // `optional` note that would itself be false (measured: without this line,
  // the very first run of this cross-check FAILED on CLAUDE.md for exactly
  // this reason).
  const isReplaceDest = (label) => replacements.some((r) => r.dest === label);

  for (const { label, re, optional } of [
    { label: 'apps/desktop/src-tauri/Cargo.toml', re: /^version = "([^"]+)"/m },
    { label: 'apps/desktop/src-tauri/Cargo.lock', re: /name = "flowmic-desktop"\nversion = "([^"]+)"/ },
    { label: 'apps/server-core/src/bootstrap.ts', re: /SERVER_VERSION = '([^']+)'/ },
    { label: 'CLAUDE.md', re: /<!--version:current-->([^<]+)<!--\/version:current-->/ },
    {
      label: 'CLAUDE.public.md',
      re: /<!--version:current-->([^<]+)<!--\/version:current-->/,
      optional: 'absent in the public export tree: it ships AS CLAUDE.md via opensource-manifest.mjs REPLACE',
    },
  ]) {
    if (exclude !== null) {
      // NOT `excludedBy(...) && !isReplaceDest(...)` — that `&&` returns the
      // boolean `!isReplaceDest(...)` (true) whenever excludedBy() matches,
      // discarding the matched entry itself; the message below then read
      // `"undefined" — undefined` for hit.path/hit.why (measured — a real bug
      // this file's own reverse control caught before this correction).
      const excludedHit = excludedBy(label, exclude);
      const hit = excludedHit && !isReplaceDest(label) ? excludedHit : null;
      if (optional && !hit) {
        return {
          status: 'FAIL',
          detail:
            `${label} carries an \`optional\` note here (${optional}) but ` +
            'scripts/opensource-manifest.mjs does NOT exclude it — one of the two is ' +
            'wrong (IT-41). The note claims the public export drops this face while ' +
            'the manifest ships it; fix the drift instead of trusting an unverified note.',
        };
      }
      if (!optional && hit) {
        return {
          status: 'FAIL',
          detail:
            `${label} is EXCLUDEd from the public export (scripts/opensource-manifest.mjs: ` +
            `"${hit.path}" — ${hit.why}) but this fixed-list entry has no \`optional\` note ` +
            '(IT-41). An exported tree would FAIL here forever — add an `optional` note ' +
            'matching the exclusion, or stop requiring this face.',
        };
      }
    }
    const text = await readText(path.join(ROOT, label));
    if (text === null) {
      if (!optional) {
        return {
          status: 'FAIL',
          detail:
            `${label} is missing — it is a required version face. Either it was ` +
            'deleted/moved (fix that), or it legitimately does not exist in this ' +
            'tree and needs an `optional` note here saying which tree and why.',
        };
      }
      skipped.push(`${label} (${optional})`);
      continue;
    }
    const m = re.exec(text);
    faces.push({ face: label, version: m ? m[1] : '(none)' });
  }

  const mismatches = faces.filter((f) => f.version !== ref);
  if (mismatches.length > 0) {
    const parts = mismatches.map((f) => `${f.face}=${f.version}`);
    return { status: 'FAIL', detail: `ref(root)=${ref}; mismatch: ${parts.join(', ')}` };
  }

  const skipNote = skipped.length ? `; skipped: ${skipped.join(', ')}` : '';
  if (faces.length === 0) {
    return { status: 'PASS', detail: `root=${ref}; no other faces present (protocol excluded)${skipNote}` };
  }
  return { status: 'PASS', detail: `${faces.length + 1} face(s) @ ${ref}${skipNote}` };
}
