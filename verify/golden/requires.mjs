// verify/golden/requires.mjs — what a golden path's `requires` list MEANS.
//
// Split out of run-golden.mjs rather than inlined there, for the same boring
// reason harness.mjs was split out of it in card G: that file stands at 734 of the
// 800-line cap (verify/lint/file-size.mjs SRC_MAX), and the only alternative to a
// split is a second copy of a rule. A second copy of a rule is this repo's #1 bug
// shape pointed at its own gate.
//
// ── THE ORIGINAL RULE, UNCHANGED ────────────────────────────────────────────
// A `requires` entry is a hard existence check run BEFORE the path's body: a
// missing file is a FAIL, never a silent skip. It exists so the evidence a golden
// CITES instead of re-enacting (a Dart test, a Rust test, a decision record)
// cannot quietly disappear while the PASS line keeps claiming it is covered.
// Nothing below weakens that for the tree you develop in.
//
// ── WHAT THIS FILE ADDS, AND THE DEFECT THAT FORCED IT ──────────────────────
// MEASURED 2026-08-06 (card IT-22 acceptance): export a public tree with
// scripts/opensource-export.mjs, then run `pnpm verify:delivery` inside it —
//
//     G20  FAIL  missing required file(s): docs/strategy/2026-08-02-a2-real-device-sheet.md,
//                                          docs/strategy/2026-08-01-real-device-session-sheet.md
//
// Both files exist, and the reason G20 names them is a good one. But
// `docs/strategy/` is EXCLUDEd wholesale from the public export (internal working
// records), so in an exported tree those two paths CANNOT exist — which made
// `pnpm verify:delivery` permanently red in the public repo, on the very command
// CONTRIBUTING.md tells every contributor to run first.
//
// So an entry needs a second, EXPLICIT meaning: "this file must exist in the
// internal tree; in an exported tree it is legitimately absent, and that is not a
// failure." That marker is `internalOnly(<abs path>, '<why>')` below.
//
// ── THE THREE PROPERTIES THIS HAS TO HAVE, IN ORDER OF IMPORTANCE ───────────
//
// ① IT MUST NOT BECOME A SILENT PASS. A waived entry is reported by name, with
//    its reason, in the golden summary. The vocabulary is not new: verify/lint's
//    version-sync.mjs already expresses a legal absence as `optional: '<why>'`
//    (a marker that IS its reason), and scripts/run-script-tests.mjs already
//    prints `SKIP <file> — <reason>` and escalates "exit 2 with no SKIP: line" to
//    FAIL because a skip nobody can read the reason for is the shape the
//    convention exists to prevent. Same words here, same mandatory reason:
//    `internalOnly()` THROWS on an empty one rather than producing a waiver
//    nobody has to justify.
//
// ② IN THE INTERNAL TREE IT IS STILL A HARD FAILURE. The point of `requires` is
//    that deleting the cited evidence gets caught, so the waiver is conditioned
//    on WHICH TREE THIS IS — and that question is answered by an explicit,
//    declared property, never by "the file is missing, so this must be the public
//    tree" (that inference is the failure mode itself: it would waive exactly the
//    deletions the guard exists to catch). The property is the presence of
//    scripts/opensource-manifest.mjs. That file EXCLUDEs ITSELF from the export
//    (see the EXCLUDE.push at its foot), so its absence is precisely equivalent
//    to "this tree came out of the exporter", and its presence hands us the
//    exclusion list to check the claim against.
//
// ③ THE CLAIM IS VERIFIED, NOT TRUSTED. `internalOnly` asserts "the public export
//    excludes this path". Whenever the manifest is readable that sentence is
//    checked against EXCLUDE itself, in BOTH directions:
//      · marked internal-only but NOT excluded ⇒ FAIL. The marker would be a
//        façade-④ comment in executable form: it says the export drops the file
//        while the manifest ships it, and nothing would ever contradict it.
//      · EXCLUDEd but NOT marked ⇒ FAIL. This is the G20 defect itself, and
//        catching it HERE means it is caught by `pnpm golden`, i.e. by every
//        `pnpm verify:delivery` — not only when somebody remembers to run the
//        exporter by hand. IT-35 wrote down, in opensource-manifest.mjs's own
//        header, that nothing in this repo invokes the exporter on its own and
//        that its rules had already gone stale for exactly that reason.
//    version-sync.mjs's `optional:` is the shape this follows; this is the one
//    place it goes further, because there nothing cross-checks the note.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ROOT computed locally (IT-41, 2026-08-07) — kept right above MANIFEST_REL so a
// `requires.mjs:<N>` citation of the manifest-path literal keeps landing near
// where it always did. Long note below MANIFEST explains what this replaced.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const MANIFEST_REL = 'scripts/opensource-manifest.mjs';
const MANIFEST = path.join(ROOT, ...MANIFEST_REL.split('/'));

// 🔴 IT-41 (2026-08-07): ROOT USED to come from harness.mjs "so there's one
// definition of where the repo is, not a second path.resolve(HERE, '..', '..')
// that agrees today." MEASURED that this was a real hazard, not a hypothetical
// one: harness.mjs's very first lines EAGERLY `require('socket.io-client')`
// (resolved against apps/server-core/package.json) purely to hand `ioClient` to
// golden paths that dial a live server — nothing this file does needs that, but
// importing `{ ROOT }` from harness.mjs pulls the whole module in anyway. The
// day scripts/bump-version.mjs (a version-bump utility with otherwise zero
// dependencies) started importing this file's pure `excludedBy`/
// `publicExportExclusions` for the SAME IT-41 cross-check, it died with
// `Cannot find module 'socket.io-client'` in any checkout where
// apps/server-core's node_modules had not been populated — a failure with
// nothing to do with version faces, thrown by a file this one only needed for a
// path constant. This file sits at verify/golden/requires.mjs, two directories
// below the repo root, exactly where harness.mjs sits — same ROOT answer, zero
// live-service coupling.

/**
 * Declare a `requires` entry that is allowed to be absent in an EXPORTED public
 * tree because the export deliberately excludes it.
 *
 * `why` is mandatory prose, and it is printed verbatim to whoever runs the gate
 * in that tree — they have no way to look up an exclusion list that, by
 * definition, is not in their checkout.
 */
export function internalOnly(abs, why) {
  if (typeof why !== 'string' || why.trim() === '') {
    throw new Error(
      `internalOnly(${abs}) needs a non-empty reason — an unexplained waiver is exactly the ` +
      'silent pass this marker exists to prevent (cf. run-script-tests.mjs treating exit 2 ' +
      'without a "SKIP: <reason>" line as malformed and escalating it to FAIL).',
    );
  }
  return { path: abs, internalOnly: why.trim() };
}

/** The absolute path an entry points at, whichever form it was written in. */
export const requirePath = (entry) => (typeof entry === 'string' ? entry : entry.path);

/**
 * The public export's exclusion list, or `null` when THIS TREE IS AN EXPORT.
 * See property ② above for why absence of the manifest is the honest signal and
 * absence of a required file is not.
 */
export async function publicExportExclusions() {
  if (!existsSync(MANIFEST)) return null;
  return (await import(pathToFileURL(MANIFEST).href)).EXCLUDE;
}

/**
 * The public export's REPLACE list (`[]` when THIS TREE IS AN EXPORT), additive
 * beside publicExportExclusions() above (IT-41, 2026-08-07).
 *
 * A REPLACE destination is EXCLUDEd from the raw copy AND named as the target
 * that another file's content lands under — so it is not actually ABSENT from
 * the exported tree, only its content differs (opensource-manifest.mjs: CLAUDE.md
 * is dropped verbatim but then reappears carrying CLAUDE.public.md's content).
 * `excludedBy()` cannot see that on its own — it only knows EXCLUDE — so a
 * consumer that checks "is this path really gone from the export" (verify/lint/
 * version-sync.mjs's IT-41 cross-check is the one that hits this) must also ask
 * this before treating an EXCLUDE hit as "the file is absent there".
 */
export async function publicExportReplacements() {
  if (!existsSync(MANIFEST)) return [];
  return (await import(pathToFileURL(MANIFEST).href)).REPLACE ?? [];
}

const toRel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

/** The EXCLUDE entry covering `rel`, or undefined. Prefix rule matches the exporter's. */
export const excludedBy = (rel, exclude) =>
  (exclude ?? []).find((e) => rel === e.path || rel.startsWith(e.path.endsWith('/') ? e.path : `${e.path}/`));

/**
 * Resolve one golden's `requires` list against this tree.
 *
 * @param {Array<string|{path:string,internalOnly:string}>} requires
 * @param {Array<{path:string,why:string}>|null} exclude  null ⇒ this tree is an export
 * @returns {{missing:string[], waived:{rel:string,why:string}[], drift:string[]}}
 *          missing ⇒ FAIL (unchanged behaviour)
 *          drift   ⇒ FAIL (the declaration and the manifest disagree)
 *          waived  ⇒ the path still RUNS; the caller must print each one by name
 */
export function resolveRequires(requires, exclude) {
  const internalTree = exclude !== null;
  const missing = [];
  const waived = [];
  const drift = [];

  for (const entry of requires ?? []) {
    const abs = requirePath(entry);
    const why = typeof entry === 'string' ? null : (entry.internalOnly ?? null);
    const rel = toRel(abs);

    if (internalTree) {
      const hit = excludedBy(rel, exclude);
      if (why && !hit) {
        drift.push(
          `${rel} is wrapped in internalOnly() but ${MANIFEST_REL} does NOT exclude it. ` +
          'The marker claims the public export drops this file while the manifest ships it — ' +
          'one of the two is wrong. Fix that, do not leave a waiver that waives nothing.',
        );
      }
      if (!why && hit) {
        drift.push(
          `${rel} is EXCLUDEd from the public export (${MANIFEST_REL}: "${hit.path}" — ${hit.why}) ` +
          'but this entry is a plain hard requirement. In an exported tree the file cannot exist, ' +
          'so this path would FAIL there forever — on the first command CONTRIBUTING.md asks a ' +
          'contributor to run. Either stop requiring it, or wrap it: ' +
          "internalOnly(path.join(ROOT, '<path>'), '<why>')  from verify/golden/requires.mjs.",
        );
      }
    }

    if (existsSync(abs)) continue;
    if (!why) { missing.push(rel); continue; }
    if (internalTree) {
      // The reverse control's expected verdict: a marked entry is STILL hard here.
      missing.push(
        `${rel} (declared internalOnly, but ${MANIFEST_REL} is present ⇒ this IS the internal ` +
        'tree, where the file must exist; internalOnly waives absence only in an exported tree)',
      );
      continue;
    }
    waived.push({ rel, why });
  }

  return { missing, waived, drift };
}
