// Drill for scripts/scan-artifact-lan-ip.mjs (card OSS-DEFAULTS, face 5).
//
// WHAT THE SUBJECT IS FOR. `verify/lint/no-lan-ip.mjs` asks "is it in the source".
// This one asks "is it in the bytes we are about to ship", and those two can disagree in
// both directions: a bundler inlines a clean-looking dependency that is not
// clean (the sidecar bundle is server-core + protocol + zod + socket.io in ONE
// file), and esbuild drops the comments that make up most of the source-level
// hits. When they disagree, the artifact is the one that reaches a stranger.
//
// SAFETY:
//   - The subject is PURE at import: it has an `isMainModule` guard, so importing
//     it neither scans nor exits. That is why it is a separate file from any
//     publisher — the same reason apk-self-update-marker.mjs is.
//   - Nothing here writes into the repo. §4 uses node:os tmpdir() and removes it
//     in a `finally`.
//   - This test NEVER imports scripts/publish.mjs (no isMainModule guard there —
//     importing it would run Gate 0 and then upload).
//
// WHAT A GREEN RUN HERE DOES **NOT** MEAN, stated so nobody reads more into it:
// it does not mean the built artifacts are clean. It means the SCANNER answers
// correctly about buffers whose contents are known. The real artifact is measured
// by running the subject against a real build — §5 does exactly that when one
// exists on this machine, and REPORTS the number rather than asserting it is
// zero, because today it is not zero and the reason is an open account (the LAN
// preset catalogue, which card OSS-DEFAULTS deliberately did not remove).
//
// EXIT CODES (card IT-38, scripts/run-script-tests.mjs): 0 = PASS, 1 = FAIL,
// 2 = SKIP with exactly one `SKIP: ` line. §1–§4 never skip.
//
// Run: `node scripts/ossdef-artifact-lan-ip.test.mjs`

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  RANGES,
  CONTROL,
  scanBuffer,
  scanTargets,
  ROOT,
} from './scan-artifact-lan-ip.mjs';

let failures = 0;

/**
 * 🔴 THE §5 MEASUREMENT HAD NO READER (W5O, 2026-08-09).
 *
 * §5 prints the occurrence count it measured in the built sidecar bundle — and
 * `scripts/run-script-tests.mjs` SUPPRESSES a passing child's stdout entirely
 * (printing everything trains people to stop reading the gate). The one thing it
 * re-surfaces is a single line prefixed `ACCOUNTING:` (card IT-58). So the
 * "report rather than assert" design above was sound and the report reached
 * nobody: the number existed only when a human ran this file by hand.
 *
 * An open account that is invisible in the gate is an open account nobody is
 * keeping. It now rides out on the one line that survives.
 */
const TOTAL_SECTIONS = 6;
let sectionsRun = 0;
let artifactNote = 'not measured';
function section(title) {
  sectionsRun++;
  process.stdout.write(`${title}\n`);
}

function check(label, cond, detail = '') {
  if (cond) {
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    failures++;
    process.stdout.write(`  FAIL ${label}${detail ? ` — ${detail}` : ''}\n`);
  }
}

// ── §1 the ranges are the two that matter, and only those ───────────────────
section('§1 range selection');
check('scans exactly the two owner ranges', RANGES.length === 2, JSON.stringify(RANGES));
check("office LAN prefix present", RANGES.includes('100.64.7.'));
check('VPS VPN prefix present', RANGES.includes('10.0.0.'));
{
  // 🔴 The negative half, and it is the reason this is not a generic
  // "private IP" scanner. These three are legitimately in the artifacts:
  // 127.0.0.1 is the sidecar host, 192.168.1.5 is UI placeholder text in the
  // manual-address field, and 10.1.2.3 is an ordinary RFC1918 address that is
  // not one of the owner's ranges. A rule that fired on them would be switched
  // off inside a week, and then it would be protecting nothing at all.
  //
  // ⚠️ 10.1.2.3 IS CHOSEN, NOT ARBITRARY (card OSSDEF-C1). This file itself ships
  // to the public tree, where the manifest REDACTIONS rewrite each owner range
  // to a 10.x REPLACEMENT segment (VPN → 10.0.0., office LAN → 10.7.7.), so in
  // the exported tree RANGES here reads ['10.7.7.', '10.0.0.']. An "innocent"
  // sample sitting in EITHER replacement segment (10.0.0.x / 10.7.7.x) would then
  // be a real hit on a public checkout and turn THIS assertion red — that was the
  // OSSDEF-C1 defect. 10.1.2.3 is in neither segment, so it stays innocent in
  // both the private and the exported tree.
  const innocent = 'http://127.0.0.1:41879 ws://192.168.1.5:41879 http://10.1.2.3:8200 flowmic';
  const { hits } = scanBuffer(innocent);
  check('legitimate private addresses are NOT flagged', hits.length === 0, JSON.stringify(hits));
}

// ── §2 counting, in both directions ─────────────────────────────────────────
section('§2 counting');
{
  const dirty = 'flowmic ws://100.64.7.68:10095 and http://100.64.7.68:8200/v1 and 10.0.0.179';
  const { hits, control } = scanBuffer(dirty);
  const office = hits.find((h) => h.range === '100.64.7.');
  const vpn = hits.find((h) => h.range === '10.0.0.');
  check('counts every occurrence, not just the first', office?.count === 2, JSON.stringify(office));
  check('counts the second range independently', vpn?.count === 1, JSON.stringify(vpn));
  check('control string detected in a normal blob', control === true);
}
{
  const clean = 'flowmic sidecar listening on 127.0.0.1:41879';
  const { hits, control } = scanBuffer(clean);
  check('a clean blob yields zero hits', hits.length === 0);
  check('…and still reports the control as present', control === true);
}

// ── §3 the blind-scan distinction (the UP-7 lesson) ─────────────────────────
section('§3 blind vs clean');
{
  // 🔴 THE POINT OF THE CONTROL. A scan that read the wrong file, or read bytes
  // it could not decode, returns zero hits — indistinguishable from success
  // unless something proves the scan could see. "clean" and "blind" demand
  // opposite actions: ship, versus go find out why the scanner is not reading
  // the artifact. CLAUDE.md records the same guard on the APK marker scan.
  const { hits, control } = scanBuffer('\x00\x01 unrelated bytes with no product name');
  check('zero hits AND control absent ⇒ the scan is reported blind', hits.length === 0 && control === false);
  check('CONTROL is a real product token, not a lucky substring', CONTROL === 'flowmic');
}

// ── §4 end-to-end over a real directory, red and green ──────────────────────
section('§4 directory scan (red, then green)');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'ossdef-artifact-'));
  try {
    writeFileSync(path.join(dir, 'clean.js'), 'export const app = "flowmic"; const h = "127.0.0.1";');
    writeFileSync(path.join(dir, 'dirty.js'), 'export const app = "flowmic"; const e = "ws://100.64.7.68:10095";');
    const red = scanTargets([dir], dir);
    check('a directory containing one dirty file reports exactly one finding', red.findings.length === 1, JSON.stringify(red.findings));
    check('…naming the file', red.findings[0]?.file?.endsWith('dirty.js') === true, red.findings[0]?.file);
    check('…and the range', red.findings[0]?.range === '100.64.7.');
    check('both files were actually read (control seen twice)', red.controlSeen === 2, `scanned=${red.scanned} control=${red.controlSeen}`);

    rmSync(path.join(dir, 'dirty.js'));
    const green = scanTargets([dir], dir);
    check('removing the dirty file turns the same scan green', green.findings.length === 0);
    check('…while still proving it could see', green.controlSeen === 1 && green.scanned === 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const missing = scanTargets([path.join(tmpdir(), 'ossdef-does-not-exist-' + Date.now())], ROOT);
  check('a target that does not exist scans nothing (caller must not read that as clean)', missing.scanned === 0);
}

// ── §5 the real artifact — MEASURED and REPORTED, not asserted ──────────────
section('§5 the real build on this machine');
{
  const sidecar = path.join(ROOT, 'apps/desktop/src-tauri/resources/server.js');
  if (!existsSync(sidecar)) {
    artifactNote = 'server.js NOT BUILT on this machine (nothing measured)';
    process.stdout.write(
      '  note the sidecar bundle is not built on this machine — nothing measured here.\n',
    );
  } else {
    const r = scanTargets(['apps/desktop/src-tauri/resources/server.js'], ROOT);
    const total = r.findings.reduce((n, f) => n + f.count, 0);
    artifactNote = `server.js ${total} LAN occurrence(s)`;
    process.stdout.write(`  measured server.js: ${total} occurrence(s) ${JSON.stringify(r.findings)}\n`);
    // 🔴 DELIBERATELY NOT `check(total === 0)`. It is not zero today, and a test
    // that asserted it were would be red from the hour it was written — the
    // 「一开始就红的门第二天就会被所有人无视」 shape CLAUDE.md warns about. What IS
    // asserted is that the scanner could see the file at all; the number itself
    // is an OPEN ACCOUNT, argued in the OSS-DEFAULTS report and in the WAIVERS
    // note in verify/lint/no-lan-ip.mjs.
    check('the scanner could actually read the bundle (control present)', r.controlSeen === 1, `scanned=${r.scanned}`);
  }
}

// ── §6 the wiring, now present ──────────────────────────────────────────────
section('§6 wiring status');
{
  // 🔴 THIS SECTION WENT RED ON PURPOSE, AND THAT IS WHY IT EXISTED.
  //
  // Until 2026-08-12 it asserted the OPPOSITE — `isWired === false` — with this
  // reason: 「Card OSS-DEFAULTS was explicitly instructed NOT to touch
  // scripts/publish.mjs (a release round owns that file). This section pins the
  // fact so that the day somebody wires it, this test tells them the note above
  // is now stale rather than letting the comment rot into a false statement —
  // reverse of the usual direction, and on purpose: an 「已知未接线」 that quietly
  // becomes 「已接线」 is how a caveat outlives its truth.」
  //
  // That day came. The wiring landed as scripts/publish-lan-ip-gate.mjs (GATE 0d
  // in publish.mjs), this section fired, and the stale headers it was pointing at
  // were rewritten in the same change. Flipping the assertion is the completion
  // of the mechanism, not a defeat of it — what must NOT happen is deleting the
  // section, because then 「已接线」 could quietly become 「又没接线」 with nothing
  // to say so. It now guards the wire from the other side.
  //
  // publish.mjs is read as TEXT ONLY and never imported: it has no isMainModule
  // guard, so importing it would run Gate 0 (~35s, binds golden's real ports) and
  // then upload to the owner's LAN download centre. Same rule as the UP-7 drill.
  const publishSrc = path.join(ROOT, 'scripts/publish.mjs');
  const text = existsSync(publishSrc) ? readFileSync(publishSrc, 'utf8') : '';
  const gateSrc = path.join(ROOT, 'scripts/publish-lan-ip-gate.mjs');
  const gateText = existsSync(gateSrc) ? readFileSync(gateSrc, 'utf8') : '';
  const isWired = text.includes('verifyArtifactsCarryNoLanIp');
  process.stdout.write(
    `  note publish.mjs ${isWired ? 'DOES' : 'does NOT'} call the LAN-IP gate\n`,
  );
  check(
    'publish.mjs calls the LAN-IP gate (if this goes red, the scanner is unrun again)',
    isWired === true,
    isWired ? '' : 'publish.mjs no longer calls verifyArtifactsCarryNoLanIp — the scanner is back to being a part nobody installed',
  );
  check(
    'and the gate is what imports THIS scanner (one mechanism, not a re-implementation)',
    gateText.includes("from './scan-artifact-lan-ip.mjs'"),
    'scripts/publish-lan-ip-gate.mjs does not import this module',
  );
}

// The ONE line run-script-tests.mjs re-surfaces beside a PASS verdict. It
// carries the §5 measurement out with it — see the note on `artifactNote`.
// ⚠️ The occurrence count is an OPEN ACCOUNT being REPORTED, not an assertion:
// a green run here does not mean the artifact is clean, and the number moves
// with the BUILD (which can be older than the source it was built from).
console.log(
  `\nACCOUNTING: sections run ${sectionsRun}/${TOTAL_SECTIONS}, ` +
    `${failures} assertion failure(s), open account — ${artifactNote}`,
);

process.stdout.write(
  failures === 0
    ? '\nOK — scan-artifact-lan-ip drill: all sections passed\n'
    : `\nFAILED — ${failures} check(s) red\n`,
);
process.exit(failures === 0 ? 0 : 1);
