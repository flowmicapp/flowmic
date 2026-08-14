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

import { performance } from 'node:perf_hooks';

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
import platformCfgCount from './platform-cfg-count.mjs';
import adminLimitMirror from './admin-limit-mirror.mjs';
import passwordPolicyMirror from './password-policy-mirror.mjs';
import packageIdFamily from './package-id-family.mjs';
import noCjk from './no-cjk.mjs';

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
  { name: 'platform-cfg-count', run: platformCfgCount },
  { name: 'admin-limit-mirror', run: adminLimitMirror },
  { name: 'password-policy-mirror', run: passwordPolicyMirror },
  { name: 'package-id-family', run: packageIdFamily },
  { name: 'no-cjk', run: noCjk },
];

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const tag = (status) =>
  status === 'PASS' ? paint(32, 'PASS') : status === 'SKIP' ? paint(90, 'SKIP') : paint(31, 'FAIL');

async function runOne(lint) {
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

async function main() {
  const wall0 = performance.now();
  const results = await Promise.all(LINTS.map(runOne));
  const wall = Math.round(performance.now() - wall0);

  // Preserve declaration order for stable output.
  const byName = new Map(results.map((r) => [r.name, r]));
  let fails = 0;
  let skips = 0;
  for (const lint of LINTS) {
    const r = byName.get(lint.name);
    if (r.status === 'FAIL') fails++;
    if (r.status === 'SKIP') skips++;
    const detail = r.detail ? ` ${r.detail}` : '';
    process.stdout.write(`${tag(r.status)} ${r.name} (${r.ms}ms)${detail}\n`);
  }

  const passes = LINTS.length - fails - skips;
  process.stdout.write(
    `\n${fails === 0 ? paint(32, 'OK') : paint(31, 'FAILED')} ` +
      `${passes} pass / ${skips} skip / ${fails} fail — total ${wall}ms\n`
  );
  process.exit(fails === 0 ? 0 : 1);
}

main();
