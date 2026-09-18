// verify/lint/server-core-bundle-stamp.mjs
// The @flowmic/server-core bundle that gets shipped to the production relay must
// be THIS round's build — proven from its own bytes, not from anyone's memory of
// having run `tsup`.
//
// ── WHY THIS GATE EXISTS (ledger NR-51, §39) ────────────────────────────────
//
// The relay is fed `apps/server-core/dist/index.js`, and the deploy script
// (deploy/deploy-vps-app.py, in the web repo) asserted only that the file
// EXISTS. "Exists" cannot answer "built from this HEAD": src/ keeps changing
// inside one version, dist stays old, and every gate stays green. The stt-cloud
// stamp (this repo, ledger P6) already closes the VERSION half of that hole for
// its own bundle; NR-51 closes the SOURCE half for BOTH bundles by stamping the
// commit, and this lint is the in-repo check that the server-core bundle is at
// least stamped and version-correct. (The commit — and .dirty/.nogit — is the
// deploy gate's question; see "WHAT A PASS DOES AND DOES NOT MEAN".)
//
// ── WHAT A PASS HERE DOES AND DOES NOT MEAN ─────────────────────────────────
//
// PASS means: a bundle exists and the version stamped into it equals the repo
// version. The stamp ALSO carries the source commit (NR-51, format
// `<version>+<sha40>[.dirty|.nogit]`), but THIS gate deliberately compares only
// the version segment — the commit and .dirty/.nogit are the deploy gate's
// question, not this lint's. A bundle built at x.y.z and left behind while src/
// keeps changing inside that same x.y.z is stale in a way this gate cannot see,
// and saying so here keeps a green line from being read as a claim it did not
// make (一个值答了两个问题).
//
// ── SKIP, NOT FAIL, WHEN THE BUNDLE WAS NEVER BUILT ─────────────────────────
//
// dist/ is gitignored, so a fresh clone has no bundle. A gate that is red on a
// fresh clone gets ignored, and an ignored gate is worse than no gate. So
// "never built" is a SKIP that says so in words. The deploy is not left
// uncovered by that choice: deploy-vps-app.py asserts the file's presence
// itself and then asserts this same stamp (plus the commit), so "missing" stays
// fatal at the one moment where missing is fatal.
//
// ── THE CONTROL MARKER, AND WHY THE ZERO NEEDS ONE ──────────────────────────
//
// "No stamp found" has two causes with OPPOSITE actions: the build lost its
// `define` (rebuild), or this scan cannot read this file at all (fix the scan).
// So the scan carries a control marker — a string present in every build of
// this bundle whatever the define does (CLAUDE.md G13 rule ②).
//
// The control was chosen by COUNTING CANDIDATES IN THE REAL ARTEFACT, not by
// reasoning about the source [measured 2026-09-16, `pnpm --filter
// @flowmic/server-core build`, apps/server-core/dist/index.js]:
//     FLOWMIC_LISTENING                1 hit    ← chosen as control
//     flowmic-server-core-build@       1 hit    (the stamp itself)
//     socket.io                        4 hits   ← rejected, see below
//     flowmic-server                   1 hit    ← REJECTED, see below
// `FLOWMIC_LISTENING` is the sidecar handshake line the desktop parses to find
// the bound port (docs/rebuild/07-DESKTOP-SPEC.md §5) — a runtime string, not a
// comment, so it cannot leave the bundle while the desktop can still connect.
// `flowmic-server` is WRONG despite being project-specific: it is a substring
// of the stamp prefix `flowmic-server-core-build@`, so it is not independent of
// the thing being scanned. `socket.io` appears partly in a comment, which a
// future minify could strip — rejected for the same reason the web repo's
// dist_build_stamp.py rejected a Vite tag that SRI rewrites.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { ROOT } from './_util.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

refuseDirectRun(import.meta.url, 'pnpm verify:lint');

/** Must equal `STAMP_PREFIX` in apps/server-core/tsup.config.ts. Pinned by
 *  scripts/server-core-bundle-stamp.test.mjs — the drill reads that config as
 *  text and compares, so the injector and the reader cannot drift apart while
 *  both stay green. */
export const STAMP_PREFIX = 'flowmic-server-core-build@';

/** Present in every build of this bundle regardless of the `define` — see the
 *  header for the counts it was chosen from. */
export const BUNDLE_CONTROL_MARKER = 'FLOWMIC_LISTENING';

/** The artefact the relay is actually fed. */
export const BUNDLE_REL = 'apps/server-core/dist/index.js';

/** The command that produces it. */
export const BUNDLE_BUILD_COMMAND = 'pnpm --filter @flowmic/server-core build';

const STAMP_RE = new RegExp(
  `${STAMP_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9A-Za-z][0-9A-Za-z.+-]*)`,
  'g',
);

/** The version segment of a stamp value. The full value is
 *  `<version>+<sha40>[.dirty|.nogit]`; this gate compares ONLY the version —
 *  the commit is the deploy gate's question (see the header). Duplicated from
 *  the private-package equivalent rather than imported, because that module is
 *  EXCLUDEd from the open-source export (it gates a private package) while this
 *  one is public — importing across that boundary would break the public tree. */
export function stampVersion(stamp) {
  const plus = stamp.indexOf('+');
  return plus === -1 ? stamp : stamp.slice(0, plus);
}

/**
 * The whole judgement, as a pure function so the drill can feed it bytes this
 * machine does not have.
 *
 * @param {{text: string, repoVersion: string}} input
 * @returns {{control: number, stamps: string[], verdict: 'ok'|'blind'|'unstamped'|'ambiguous'|'stale'}}
 *
 * Order matters: 'blind' is decided FIRST.
 */
export function classifyBundleStamp({ text, repoVersion }) {
  let control = 0;
  for (
    let at = text.indexOf(BUNDLE_CONTROL_MARKER);
    at !== -1;
    at = text.indexOf(BUNDLE_CONTROL_MARKER, at + 1)
  ) {
    control += 1;
  }
  const stamps = [...new Set([...text.matchAll(STAMP_RE)].map((m) => m[1]))];

  if (control === 0) return { control, stamps, verdict: 'blind' };
  if (stamps.length === 0) return { control, stamps, verdict: 'unstamped' };
  if (stamps.length > 1) return { control, stamps, verdict: 'ambiguous' };
  if (stampVersion(stamps[0]) !== repoVersion) return { control, stamps, verdict: 'stale' };
  return { control, stamps, verdict: 'ok' };
}

/** The words an operator reads. Each non-ok verdict names a DIFFERENT action. */
export function bundleStampDetail({ control, stamps, verdict }, repoVersion) {
  if (verdict === 'blind') {
    return (
      `${BUNDLE_REL} exists but the scan is BLIND — the control marker ` +
      `'${BUNDLE_CONTROL_MARKER}' is absent too (control=${control}, stamps=${stamps.length}). ` +
      `This says NOTHING about whether the bundle is current. Either that file is not a ` +
      `@flowmic/server-core bundle, or the build now emits the handshake line differently. Re-measure ` +
      `the control before touching the build: grep the bundle for '${BUNDLE_CONTROL_MARKER}'.`
    );
  }
  if (verdict === 'unstamped') {
    return (
      `${BUNDLE_REL} carries NO build stamp (control marker present: ${control} hits, so the scan ` +
      `can read this file). It was built without tsup's define — check that ` +
      `\`define: { __SERVER_CORE_BUILD_STAMP__ ... }\` is still in apps/server-core/tsup.config.ts ` +
      `and that build-stamp.ts is still referenced from src/index.ts, then rebuild: ` +
      `${BUNDLE_BUILD_COMMAND}`
    );
  }
  if (verdict === 'ambiguous') {
    return (
      `${BUNDLE_REL} carries ${stamps.length} DIFFERENT build stamps (${stamps.join(', ')}) — the ` +
      `scan cannot say which one describes these bytes, so it refuses to say any of them does. ` +
      `Rebuild from a clean dist/: ${BUNDLE_BUILD_COMMAND}`
    );
  }
  if (verdict === 'stale') {
    return (
      `${BUNDLE_REL} is STALE: built at version ${stampVersion(stamps[0])} while this repo is at ` +
      `${repoVersion}. Deploying it would put a relay in production whose version says ${repoVersion} ` +
      `while its server-core bytes are ${stampVersion(stamps[0])}. Rebuild: ${BUNDLE_BUILD_COMMAND}`
    );
  }
  return (
    `${BUNDLE_REL} stamped ${STAMP_PREFIX}${stamps[0]} (version ${stampVersion(stamps[0])} = repo ` +
    `version; control marker '${BUNDLE_CONTROL_MARKER}' seen ${control}x, so the scan was not blind). ` +
    `This gate checked the VERSION only — the commit in the stamp is the deploy gate's question, not this one.`
  );
}

/**
 * @param {string} [root] — the tree to judge. Defaults to this repo; the drill
 *   passes temp trees so the SKIP path (no bundle) is PROVEN rather than read
 *   off this file's source text.
 */
export default async function serverCoreBundleStamp(root = ROOT) {
  const bundle = path.join(root, ...BUNDLE_REL.split('/'));

  let repoVersion;
  try {
    repoVersion = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8')).version;
  } catch (err) {
    return { status: 'FAIL', detail: `cannot read the repo version from package.json: ${err.message}` };
  }
  if (typeof repoVersion !== 'string' || !/^\d+\.\d+\.\d+/.test(repoVersion)) {
    return {
      status: 'FAIL',
      detail: `root package.json version is ${JSON.stringify(repoVersion)} — not a version this gate can compare against`,
    };
  }

  let text;
  try {
    text = await fsp.readFile(bundle, 'utf8');
  } catch {
    return {
      status: 'SKIP',
      detail:
        `${BUNDLE_REL} has never been built in this checkout (dist/ is gitignored) — nothing to compare. ` +
        `Expected state on a fresh clone. Build it before deploying: ${BUNDLE_BUILD_COMMAND}`,
    };
  }

  const scan = classifyBundleStamp({ text, repoVersion });
  return {
    status: scan.verdict === 'ok' ? 'PASS' : 'FAIL',
    detail: bundleStampDetail(scan, repoVersion),
  };
}
