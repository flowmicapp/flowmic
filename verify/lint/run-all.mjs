// verify/lint/run-all.mjs
// FlowMic lint suite — concurrent aggregator.
//
// Runs every lint module in the LINTS table below in parallel, times each, and
// prints one line per lint: `PASS|SKIP|FAIL name (ms) detail`. Any FAIL ->
// exit 1. Target total wall-clock < 5s.
//
// ⚠️ No count is written here. This header said 「12-lint suite … all twelve
// modules」 while the table held fifteen — the table is the only thing that
// answers 「how many」, and a number copied beside it is a truth with a
// shelf life. Read the command's own output instead.
//
// Every lint module MUST be imported here — run-all.mjs is the sole production
// caller of the suite (reachability proof for WP-R0-4).

import { existsSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import protocolWhitelist from './protocol-whitelist.mjs';
import noCloudKeys from './no-cloud-keys.mjs';
import settingsKeyDrift from './settings-key-drift.mjs';
import moduleReachability from './module-reachability.mjs';
import i18nErrorKeys from './i18n-error-keys.mjs';
import i18nAddLocaleCost from './i18n-add-locale-cost.mjs';
import i18nGeneratedFresh from './i18n-generated-fresh.mjs';
import circular from './circular.mjs';
import versionSync from './version-sync.mjs';
import nodeVersionPin from './node-version-pin.mjs';
import gateCoversWorkspaces from './gate-covers-workspaces.mjs';
import fileSize from './file-size.mjs';
import timelineE2ePrefix from './timeline-e2e-prefix.mjs';
import designTokenLiterals from './design-token-literals.mjs';
import cssVarDefined from './css-var-defined.mjs';
import coordinateAnchors from './coordinate-anchors.mjs';
import noLanIp from './no-lan-ip.mjs';
import androidProviderClasses from './android-provider-classes.mjs';
import androidInstallPermission from './android-install-permission.mjs';
import applinkDeclarations from './applink-declarations.mjs';
import flutterTemplateIcons from './flutter-template-icons.mjs';
import platformCfgCount from './platform-cfg-count.mjs';
import adminLimitMirror from './admin-limit-mirror.mjs';
import passwordPolicyMirror from './password-policy-mirror.mjs';
import packageIdFamily from './package-id-family.mjs';
import iosSeedNotPersistent from './ios-seed-not-persistent.mjs';
import noCjk from './no-cjk.mjs';
import sceneDemoEnglish from './scene-demo-english.mjs';
import changelogReleaseSections from './changelog-release-sections.mjs';
import worktreeLocation from './worktree-location.mjs';
import planLimitCopy from './plan-limit-copy.mjs';
import externalLinkDoor from './external-link-door.mjs';
import disclosureCopyMirror from './disclosure-copy-mirror.mjs';
import outwardVoice from './outward-voice.mjs';
import pairLinkSingleSource from './pair-link-single-source.mjs';
import spokenLangsMirror from './spoken-langs-mirror.mjs';
import mobileWebTokensMirror from './mobile-web-tokens-mirror.mjs';

const LINTS = [
  { name: 'protocol-whitelist', run: protocolWhitelist },
  { name: 'no-cloud-keys', run: noCloudKeys },
  { name: 'settings-key-drift', run: settingsKeyDrift },
  { name: 'module-reachability', run: moduleReachability },
  { name: 'i18n-error-keys', run: i18nErrorKeys },
  { name: 'i18n-add-locale-cost', run: i18nAddLocaleCost },
  { name: 'i18n-generated-fresh', run: i18nGeneratedFresh },
  { name: 'circular', run: circular },
  { name: 'version-sync', run: versionSync },
  { name: 'file-size', run: fileSize },
  { name: 'timeline-e2e-prefix', run: timelineE2ePrefix },
  { name: 'design-token-literals', run: designTokenLiterals },
  { name: 'css-var-defined', run: cssVarDefined },
  { name: 'coordinate-anchors', run: coordinateAnchors },
  { name: 'node-version-pin', run: nodeVersionPin },
  { name: 'gate-covers-workspaces', run: gateCoversWorkspaces },
  { name: 'no-lan-ip', run: noLanIp },
  { name: 'android-provider-classes', run: androidProviderClasses },
  { name: 'android-install-permission', run: androidInstallPermission },
  { name: 'applink-declarations', run: applinkDeclarations },
  { name: 'flutter-template-icons', run: flutterTemplateIcons },
  { name: 'platform-cfg-count', run: platformCfgCount },
  { name: 'admin-limit-mirror', run: adminLimitMirror },
  { name: 'password-policy-mirror', run: passwordPolicyMirror },
  { name: 'package-id-family', run: packageIdFamily },
  { name: 'ios-seed-not-persistent', run: iosSeedNotPersistent },
  { name: 'no-cjk', run: noCjk },
  { name: 'scene-demo-english', run: sceneDemoEnglish },
  { name: 'changelog-release-sections', run: changelogReleaseSections },
  { name: 'worktree-location', run: worktreeLocation },
  { name: 'plan-limit-copy', run: planLimitCopy },
  { name: 'external-link-door', run: externalLinkDoor },
  { name: 'disclosure-copy-mirror', run: disclosureCopyMirror },
  { name: 'outward-voice', run: outwardVoice },
  { name: 'pair-link-single-source', run: pairLinkSingleSource },
  { name: 'spoken-langs-mirror', run: spokenLangsMirror },
  { name: 'mobile-web-tokens-mirror', run: mobileWebTokensMirror },
];

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const tag = (status) =>
  status === 'PASS' ? paint(32, 'PASS') : status === 'SKIP' ? paint(90, 'SKIP') : paint(31, 'FAIL');

// ── HOW THESE 40 CHECKS ARE EXECUTED ────────────────────────────────────────
//
// On `worker_threads`, one check per worker, pool = half the logical cores.
//
// It used to be `Promise.all` on this thread, which the header above still
// called concurrent. Measured 2026-09-12: it was not. These checks are
// synchronous regex sweeps, so they never really yield; three that cost
// 1.9/2.6/3.1 s alone reported 19.9/19.9/21.3 s inside the 40-way Promise.all,
// and every check's self-time converged on the total — the signature of one
// thread time-slicing 40 sweeps. `UV_THREADPOOL_SIZE=32` moved nothing, which
// rules out fs-queue starvation. The full measurement, both directions, is in
// verify/lint/lint-worker.mjs's header and in
// docs/strategy/2026-09-12-verify-delivery-speedup-plan.md §3.1.
//
// THE STATIC IMPORTS ABOVE STAY, and not out of habit:
//   · they are the reachability proof for the suite — several drills
//     (scripts/outward-voice.test.mjs,
//     scripts/changelog-release-sections-lint.test.mjs) assert that run-all.mjs
//     BOTH imports a module AND has a row for it, because an import with no row
//     runs nothing and a row with no import cannot run;
//   · `FLOWMIC_LINT_WORKERS=0` runs every check through those very bindings, on
//     this thread, which is how you reproduce a worker-only symptom;
//   · startup asserts each row's `run` is a function AND that `<name>.mjs`
//     exists, so a row whose name stopped matching its file goes red instead of
//     quietly becoming a check nobody runs.
const WORKER_URL = new URL('./lint-worker.mjs', import.meta.url);
const LOGICAL_CORES =
  (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) || 4;
const POOL_SIZE = Math.max(2, Math.floor(LOGICAL_CORES / 2));
const USE_WORKERS = process.env.FLOWMIC_LINT_WORKERS !== '0';

/** Registration guard — see the block above. Loud, never a silent skip. */
function assertRegistrations() {
  const problems = [];
  for (const lint of LINTS) {
    if (typeof lint.run !== 'function') problems.push(`${lint.name}: no run() imported`);
    if (!existsSync(fileURLToPath(new URL(`./${lint.name}.mjs`, import.meta.url)))) {
      problems.push(`${lint.name}: verify/lint/${lint.name}.mjs does not exist`);
    }
  }
  if (problems.length > 0) {
    process.stdout.write(`${paint(31, 'FAILED')} lint registration is broken:\n`);
    for (const p of problems) process.stdout.write(`  · ${p}\n`);
    process.exit(1);
  }
}

async function runOneInThread(lint) {
  const t0 = performance.now();
  let result;
  try {
    result = await lint.run();
  } catch (err) {
    result = { status: 'FAIL', detail: `threw: ${err && err.message ? err.message : String(err)}` };
  }
  const ms = Math.round(performance.now() - t0);
  return { name: lint.name, ms, ...result };
}

async function runInWorkers(lints) {
  const queue = lints.map((l) => l.name);
  const results = [];
  const workers = [];
  const inFlight = new Map(); // Worker -> lint name
  const size = Math.min(POOL_SIZE, queue.length);

  await new Promise((resolve) => {
    const settle = (r) => {
      results.push(r);
      if (results.length === lints.length) resolve();
    };
    const feed = (w) => {
      const name = queue.shift();
      if (name === undefined) {
        inFlight.delete(w);
        return;
      }
      inFlight.set(w, name);
      w.postMessage({ name });
    };
    for (let i = 0; i < size; i += 1) {
      const w = new Worker(WORKER_URL);
      workers.push(w);
      w.on('message', (r) => {
        settle(r);
        feed(w);
      });
      // A worker that dies takes its in-flight check with it. Report THAT
      // check red by name and keep the pool moving — a pool that hangs here
      // would turn a crash into a timeout nobody can read.
      const died = (why) => {
        const name = inFlight.get(w);
        if (name !== undefined) {
          settle({ name, status: 'FAIL', ms: 0, detail: `lint worker died: ${why}` });
          inFlight.delete(w);
        }
        const replacement = queue.shift();
        if (replacement !== undefined) {
          // Re-queue onto a fresh worker rather than dropping the remainder.
          const nw = new Worker(WORKER_URL);
          workers.push(nw);
          nw.on('message', (r) => {
            settle(r);
            feed(nw);
          });
          nw.on('error', (e) => died(e && e.message ? e.message : String(e)));
          nw.on('exit', (code) => {
            if (code !== 0) died(`exit ${code}`);
          });
          inFlight.set(nw, replacement);
          nw.postMessage({ name: replacement });
        }
      };
      w.on('error', (e) => died(e && e.message ? e.message : String(e)));
      w.on('exit', (code) => {
        if (code !== 0) died(`exit ${code}`);
      });
      feed(w);
    }
  });

  await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
  return results;
}

async function main() {
  assertRegistrations();
  const wall0 = performance.now();
  const results = USE_WORKERS
    ? await runInWorkers(LINTS)
    : await Promise.all(LINTS.map(runOneInThread));
  const wall = Math.round(performance.now() - wall0);

  // Preserve declaration order for stable output.
  const byName = new Map(results.map((r) => [r.name, r]));
  let fails = 0;
  let skips = 0;
  for (const lint of LINTS) {
    const r = byName.get(lint.name) ?? {
      // Cannot happen while the pool accounts for every task, and is still
      // written down: a missing result must not be counted as a pass.
      status: 'FAIL',
      ms: 0,
      detail: 'no result came back from the lint pool',
    };
    if (r.status === 'FAIL') fails++;
    if (r.status === 'SKIP') skips++;
    const detail = r.detail ? ` ${r.detail}` : '';
    process.stdout.write(`${tag(r.status)} ${lint.name} (${r.ms}ms)${detail}\n`);
  }

  const passes = LINTS.length - fails - skips;
  process.stdout.write(
    `\n${fails === 0 ? paint(32, 'OK') : paint(31, 'FAILED')} ` +
      `${passes} pass / ${skips} skip / ${fails} fail — total ${wall}ms\n`
  );
  process.exit(fails === 0 ? 0 : 1);
}

main();
