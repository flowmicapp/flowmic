// verify/lint/i18n-generated-fresh.mjs
//
// 🔴 A GENERATOR'S OWN `--check` PROVES NOTHING UNTIL SOMETHING RUNS IT.
//
// The locale work commits its generated output (the Rust table has to be
// committed: cargo has no codegen step, so a gitignored table does not compile
// on a clean checkout). That makes drift possible in the one direction nobody
// notices: edit the JSON, forget to regenerate, and the build stays green while
// the app ships the OLD strings. The generators each grew a `--check` mode for
// exactly this, and every one of them was reachable only by a human who
// remembered.
//
// That is this repo's #1 historical defect class wearing a build-tool costume —
// the same shape as G12, which was red for a day because "a test that was written but nobody called". So
// the freshness check gets a caller, and the caller is a gate.
//
// Adding a generator means adding a row to GENERATORS. A generator that is not
// listed here is not checked, so the list itself is the thing to keep honest —
// there is no discovery magic, on purpose: a scan that guessed which scripts are
// generators would quietly stop finding one after a rename.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './_util.mjs';

/** Each entry: a generator that can verify its own output without writing.
 *  `label` is what the failure names, so it must say which artefact is stale. */
const GENERATORS = [
  {
    label: 'desktop Rust ui_i18n table',
    script: 'scripts/i18n/gen-desktop-rust.mjs',
    args: ['--check'],
  },
  {
    // The web and admin repos cannot import the registry, so they carry a
    // generated snapshot of it. Measured the day this gate landed: changing the
    // registry (English moved to the top) drifted BOTH snapshots inside the hour
    // — which is precisely the failure this row exists to catch, and it would
    // have been invisible until someone wondered why the site's language menu
    // was in a different order from the app's.
    label: 'web + admin locale snapshot',
    script: 'scripts/i18n/gen-web-locale-snapshot.mjs',
    args: ['--check', '--skip-missing'],
    // The open-source export EXCLUDEs this generator (it functionally depends
    // on the private sister repos), so in an exported tree "script not on
    // disk" is the designed shape, not a broken checkout. Without this flag a
    // missing script exits 1 via Node's module-resolution error and lands in
    // the "stale" bucket — failing verify:delivery on the first command
    // CONTRIBUTING tells a contributor to run (measured 2026-08-14).
    absentOk: true,
  },
  {
    // The desktop webview catalogue (0.2.67 P2). Its output IS committed —
    // `apps/desktop/src/lib/strings/generated/*.g.ts` is imported by the shards
    // and by strings.ts, and vite has no codegen step — so there is no
    // `--skip-missing` here: a missing generated file is a broken checkout, not
    // a normal one. What this row catches is the drift that stays green: someone
    // edits i18n/desktop/<code>.json (or adds a language) and forgets to
    // regenerate, and the app keeps shipping the OLD sentence.
    label: 'desktop webview string catalogue (strings/generated/*.g.ts)',
    script: 'scripts/i18n/gen-desktop-ts.mjs',
    args: ['--check'],
  },
  {
    // The mobile string catalogue (0.2.67 P1). Unlike the Rust table this one's
    // output is `*.g.dart` and therefore GITIGNORED — `make -C apps/mobile gen`
    // rebuilds it, the way flowmic_events.g.dart has always worked. Hence
    // `--skip-missing`: on a clean checkout "not generated yet" is the normal
    // state and not a defect. What it still catches, and what it is here for, is
    // the case that matters — someone edits i18n/mobile/<code>.json, forgets to
    // regenerate, and the app keeps shipping the OLD sentence while every gate
    // stays green.
    label: 'mobile string catalogue (l10n/*.g.dart)',
    script: 'scripts/i18n/gen-mobile-dart.mjs',
    args: ['--check', '--skip-missing'],
  },
  {
    // The mobile migration golden's HARNESS (apps/mobile/test/
    // i18n_migration_golden_test.dart). Committed, and generated — which is the
    // combination that bit us.
    //
    // 🔴 WHY THIS ROW EXISTS, measured 2026-08-17: the harness was corrected by
    // hand on 2026-08-14 (a missing baseline became a skip instead of a
    // failure, because .local/ is gitignored and CI therefore starts without
    // one). The generator was not touched, so the next `--emit-test` — during
    // the 0.3.8 release — put the failure straight back, and the open-source
    // repo's flutter job went red ON THE RELEASE COMMIT. Every gate in this repo
    // was green while that shipped, because this was the one i18n generator with
    // no row here.
    //
    // The lesson is the row: a hand-edit to a generated file is invisible
    // until something re-emits it, and "DO NOT EDIT BY HAND" at the top of the
    // file is a request, not a mechanism.
    label: 'mobile migration golden harness (test/i18n_migration_golden_test.dart)',
    script: 'scripts/i18n/snapshot-rendered.mjs',
    args: ['--check'],
  },
];

function runNode(scriptRel, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, scriptRel), ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => resolve({ code: -1, out: String(err && err.message) }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

export default async function run() {
  const stale = [];
  const missing = [];
  let checked = 0;
  for (const g of GENERATORS) {
    const abs = path.join(ROOT, g.script);
    if (g.absentOk && !existsSync(abs)) continue; // designed-absent in the exported tree
    const res = await runNode(g.script, g.args);
    if (res.code === -1) {
      // The generator itself could not be started. Reported as its own kind of
      // failure rather than folded into "stale": a missing generator and a stale
      // artefact need different repairs, and collapsing them would send someone
      // to regenerate a file with a script that is not there.
      missing.push(`${g.label} (${g.script}: ${res.out.trim().split('\n')[0]})`);
      continue;
    }
    checked += 1;
    if (res.code !== 0) {
      const first = res.out.trim().split('\n').filter(Boolean).slice(-1)[0] ?? `exit ${res.code}`;
      stale.push(`${g.label} — ${first}`);
    }
    void abs;
  }
  if (missing.length > 0) {
    return { status: 'FAIL', detail: `generator not runnable: ${missing.join('; ')}` };
  }
  if (stale.length > 0) {
    return {
      status: 'FAIL',
      detail:
        `${stale.length} generated artefact(s) do not match their source data — ` +
        `regenerate with \`pnpm i18n:gen\`: ${stale.join('; ')}`,
    };
  }
  return {
    status: 'PASS',
    detail: `${checked} generated i18n artefact(s) match their source data`,
  };
}
