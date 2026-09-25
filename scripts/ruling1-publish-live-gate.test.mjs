// Ruling ①'s companion gate drill (owner 2026-08-10 — docs/decisions/
// 2026-08-10-owner-seven-rulings-after-0261.md, the ⚠️ paragraph under ①):
// a publish run may not end green while the PUBLIC /api/updates/latest is
// still advertising the previous version for a platform that shipped.
//
// WHAT IT COST WHEN THIS GATE DID NOT EXIST (device-line handoff §8-1,
// measured on 0.2.61's release evening): relay health, three APK byte gates,
// download-center /latest and artifact sha256 were ALL green while the public
// endpoint kept advertising 0.2.59 — and the one warning that would have said
// so was a print statement nobody read. The gate's shape is "you may not
// believe you are done", not "we generate it for you".
//
// SAFETY — same rules as the UP-10 drill:
//   - NEVER spawns scripts/verify-live-update-manifest.mjs (it reads the real
//     ./publish and asks the real public endpoint) and NEVER imports
//     publish.mjs. Both are read as TEXT only, for wiring pins.
//   - DOES import scripts/update-manifest-lib.mjs (pure at import) and drives
//     the REAL judgment — gateShippedPlatformsLive — including end-to-end
//     against a loopback server via the real fetchLiveManifest.
//
// EXIT CODES (card IT-38): 0 = PASS, 1 = FAIL. Never skips.
//
// Run: `node scripts/ruling1-publish-live-gate.test.mjs`
// Also discovered by `pnpm verify:scripts` (inside verify:delivery) by glob.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchLiveManifest, gateShippedPlatformsLive } from './update-manifest-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_SRC = readFileSync(join(ROOT, 'scripts', 'verify-live-update-manifest.mjs'), 'utf8'); // text only
const PUBLISH_SRC = readFileSync(join(ROOT, 'scripts', 'publish.mjs'), 'utf8'); // text only

let failures = 0;
const section = (title) => console.log(`\n=== ${title} ===`);
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label}`);
    failures++;
  }
}

const HEX = 'b'.repeat(64);
const URL_UNDER_TEST = 'http://203.0.113.9/api/updates/latest';
function liveEntry(version) {
  return {
    version,
    notes_url: null,
    artifacts: [
      { kind: 'apk', locale: null, filename: `FlowMic-${version}-release.apk`, url: `http://203.0.113.9/f/${version}.apk`, sha256: HEX, size: 99 },
    ],
  };
}
/// 0.3.28 — every fetched manifest now also has to answer for iOS.
///
/// 🔴 `iosVersion` defaults to whatever the round is, so the cases below keep
/// asking the question they were written to ask. That default is a TEST
/// convenience and nothing else: in production this block was ABSENT for the
/// whole life of the feature, which is the defect §1-ios exists for.
const okFetched = (platforms, iosVersion = '0.0.2') => ({
  verdict: 'ok',
  status: 200,
  manifest: {
    platforms,
    ...(iosVersion === null ? {} : { store_platforms: { ios: { version: iosVersion, notes_url: null, store_url: null } } }),
  },
  detail: null,
  error: null,
});

// ── §1 the pure judgment: each verdict names ITS action, and only its own ────
section('§1 gateShippedPlatformsLive — five states, five distinguishable messages');
{
  const green = gateShippedPlatformsLive({
    shipped: ['windows-x64', 'android'],
    version: '0.0.2',
    fetched: okFetched({ 'windows-x64': liveEntry('0.0.2'), android: liveEntry('0.0.2') }),
    url: URL_UNDER_TEST,
  });
  assertTrue(green.failures.length === 0 && green.okLines.length === 3, 'both platforms live at this round → zero failures; three ok lines, the third being the iOS store channel');

  const stale = gateShippedPlatformsLive({
    shipped: ['android'],
    version: '0.0.2',
    fetched: okFetched({ android: liveEntry('0.0.1') }),
    url: URL_UNDER_TEST,
  });
  assertTrue(stale.failures.length === 1, 'live older than shipped → one failure');
  assertTrue(
    /still advertises 0\.0\.1/.test(stale.failures[0]) && /updates\.json/.test(stale.failures[0]),
    'the stale message names both versions and the deploy action (updates.json) — the 0.2.61 P0 shape, named',
  );

  const missing = gateShippedPlatformsLive({
    shipped: ['windows-x64', 'android'],
    version: '0.0.2',
    fetched: okFetched({ android: liveEntry('0.0.2') }),
    url: URL_UNDER_TEST,
  });
  assertTrue(
    missing.failures.length === 1 && /windows-x64.*NO entry/.test(missing.failures[0]),
    'a shipped platform absent from the live manifest is its own failure, and the other platform still passes',
  );
  assertTrue(missing.okLines.length === 2, '(the other platform and iOS are still reported ok — one run tells the operator everything)');

  const newer = gateShippedPlatformsLive({
    shipped: ['android'],
    version: '0.0.2',
    fetched: okFetched({ android: liveEntry('0.0.9') }),
    url: URL_UNDER_TEST,
  });
  assertTrue(
    newer.failures.length === 1 && /NEWER/.test(newer.failures[0]) && !/updates\.json/.test(newer.failures[0]),
    'live NEWER than shipped → failure that says stop-and-investigate, NOT deploy — the wrong action would overwrite a later round',
  );

  const absent = gateShippedPlatformsLive({
    shipped: ['android'],
    version: '0.0.2',
    fetched: { verdict: 'absent', status: 503, manifest: null, detail: 'manifest_unreadable', error: null },
    url: URL_UNDER_TEST,
  });
  assertTrue(
    absent.failures.length === 1 && /NO usable manifest/.test(absent.failures[0]),
    'no usable live manifest at all → failure naming generate + deploy',
  );

  const unreachable = gateShippedPlatformsLive({
    shipped: ['android'],
    version: '0.0.2',
    fetched: { verdict: 'unreachable', status: null, manifest: null, detail: null, error: 'ECONNREFUSED — refused' },
    url: URL_UNDER_TEST,
  });
  assertTrue(unreachable.failures.length === 1, 'unreachable → still a failure (a gate that cannot run is a FAILED gate)');
  assertTrue(
    /COULD NOT ASK/.test(unreachable.failures[0]) && /NOTHING/.test(unreachable.failures[0]),
    "🔴 but its message says the check DID NOT RUN — 「问不到」 must never be dressed as 「没有」",
  );
  assertTrue(
    !/still advertises/.test(unreachable.failures[0]),
    'and it never claims the manifest is stale — that is an answer to a question this check failed to ask',
  );
}

// ── §2 end-to-end against a loopback: real fetch, real judgment ─────────────
section('§2 loopback end-to-end — green when live == round, red when live is the previous round');
{
  const manifestAt = (v) => ({
    manifest_version: 1,
    generated_at: '2026-08-10T00:00:00.000Z',
    platforms: { 'windows-x64': liveEntry(v), android: liveEntry(v) },
    store_platforms: { ios: { version: v, notes_url: null, store_url: null } },
  });

  async function runAgainst(liveVersion) {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(manifestAt(liveVersion)));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/updates/latest`;
    try {
      const fetched = await fetchLiveManifest({ url });
      return gateShippedPlatformsLive({ shipped: ['windows-x64', 'android'], version: '0.0.2', fetched, url });
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  const green = await runAgainst('0.0.2');
  assertTrue(green.failures.length === 0 && green.okLines.length === 3, 'live serves this round → green, through the REAL fetch');

  const red = await runAgainst('0.0.1');
  assertTrue(
    red.failures.length === 3 && red.failures.every((f) => /still advertises 0\.0\.1/.test(f)),
    'live serves the previous round → red per platform AND on the iOS store channel — the 0.2.61 state, now including the platform that never had a gate',
  );
  assertTrue(
    red.failures.some((f) => /^ios:/.test(f)),
    'and the iOS failure is its own line, not folded into a platform one — the two are fixed by different halves of the release',
  );
}

// ── §1-ios the platform ./publish can never be evidence for ─────────────────
section('§1-ios store_platforms.ios — the block whose absence was silent for the whole life of the feature');
{
  // 🔴 THE CASE THAT MATTERS, and the one a "is there an ios block" criterion
  // would have been green on. Measured in production 2026-08-23: the live
  // manifest carried NO store_platforms at all while 0.3.27 had genuinely
  // shipped to TestFlight, and every gate in the release chain was green.
  const noBlock = gateShippedPlatformsLive({
    shipped: ['windows-x64', 'android'],
    version: '0.0.2',
    fetched: okFetched({ 'windows-x64': liveEntry('0.0.2'), android: liveEntry('0.0.2') }, null),
    url: URL_UNDER_TEST,
  });
  assertTrue(
    noBlock.failures.length === 1 && /^ios: the live manifest carries NO store_platforms\.ios/.test(noBlock.failures[0]),
    '🔴 no store_platforms at all → red, even though every downloadable platform is perfectly live',
  );
  assertTrue(
    /incompleteInfo\/platform_absent/.test(noBlock.failures[0]),
    'and it names what the iPhone actually experiences, not just what the file lacks',
  );
  assertTrue(
    /--ios 0\.0\.2/.test(noBlock.failures[0]),
    'and it names the exact remedy with this round\'s version already substituted in',
  );

  const stale = gateShippedPlatformsLive({
    shipped: ['android'],
    version: '0.0.2',
    fetched: okFetched({ android: liveEntry('0.0.2') }, '0.0.1'),
    url: URL_UNDER_TEST,
  });
  assertTrue(
    stale.failures.length === 1 && /^ios: shipped 0\.0\.2 .*still advertises 0\.0\.1/.test(stale.failures[0]),
    'an iOS block one round behind is the same defect as a stale platform, and says so',
  );

  const newer = gateShippedPlatformsLive({
    shipped: ['android'],
    version: '0.0.2',
    fetched: okFetched({ android: liveEntry('0.0.2') }, '0.0.9'),
    url: URL_UNDER_TEST,
  });
  assertTrue(
    newer.failures.length === 1 && /NEWER/.test(newer.failures[0]) && !/--ios/.test(newer.failures[0]),
    'an iOS block AHEAD of this round says stop-and-investigate and does NOT offer the regenerate command — the wrong action would walk a later round backwards',
  );

  // A store entry with no link is legal and must stay green: the phone's card
  // keys "update in the store" on the CHANNEL, not on the link
  // (settings_update_card.dart), so the news is deliverable before the
  // TestFlight page exists — which matters because minting that page is an
  // owner-only action.
  const linkless = gateShippedPlatformsLive({
    shipped: ['android'],
    version: '0.0.2',
    fetched: okFetched({ android: liveEntry('0.0.2') }, '0.0.2'),
    url: URL_UNDER_TEST,
  });
  assertTrue(
    linkless.failures.length === 0 && linkless.okLines.some((l) => /^ios: live manifest advertises 0\.0\.2/.test(l)),
    'a store entry carrying a version but no store_url is green — an unminted link must not block telling users a version exists',
  );
}

// ── §3 the standalone gate script is wired to the same mechanism ────────────
section('§3 verify-live-update-manifest.mjs wiring (text pins)');
{
  assertTrue(/from '\.\/update-manifest-lib\.mjs'/.test(GATE_SRC), 'it imports the lib — one judgment, not a re-derivation');
  for (const symbol of ['gateShippedPlatformsLive', 'fetchLiveManifest', 'isRoundArtifactName', 'classify']) {
    assertTrue(new RegExp(`\\b${symbol}\\b`).test(GATE_SRC), `it uses ${symbol}`);
  }
  assertTrue(
    /JSON\.parse\(readFileSync\(join\(ROOT, 'package\.json'\)/.test(GATE_SRC),
    'this round\'s version comes from the root package.json — the same reference face as every other gate',
  );
  assertTrue(
    /readdirSync\(OUT\)\.filter\(\(f\) => isRoundArtifactName\(f, VERSION\)\)/.test(GATE_SRC),
    '"what shipped" is read from ./publish with the SAME predicate the manifest builder uses',
  );
  assertTrue(
    /failures\.length > 0[\s\S]{0,400}process\.exit\(1\)/.test(GATE_SRC),
    'a non-empty failure list exits 1 — the refusal actually stops the run',
  );
  assertTrue(
    /no \.\/publish/.test(GATE_SRC) && new RegExp('has no \\$\\{VERSION\\} artifacts').test(GATE_SRC),
    'an empty ./publish refuses loudly instead of vacuously passing (nothing shipped ⇒ nothing to be green about)',
  );
  assertTrue(!/deploy-vps|scp |ssh /.test(GATE_SRC), 'and it deploys NOTHING — it reads and judges (deploys are the device line\'s)');
}

// ── §4 publish.mjs runs the gate at the end of every LAN-publishing run ─────
section('§4 publish.mjs wiring — after the upload, before "done", exit 1 on red');
{
  const gateIdx = PUBLISH_SRC.indexOf("'verify-live-update-manifest.mjs'");
  assertTrue(gateIdx !== -1, 'publish.mjs invokes the gate script');

  const uploadIdx = PUBLISH_SRC.indexOf('execFileSync(process.execPath, [downloadCenterScript]');
  assertTrue(
    uploadIdx !== -1 && uploadIdx < gateIdx,
    'the gate runs AFTER the download-center upload — the only moment "does the live face agree" can be asked honestly',
  );
  const withManifestIdx = PUBLISH_SRC.indexOf("'build-update-manifest.mjs')]", uploadIdx);
  assertTrue(
    withManifestIdx !== -1 && withManifestIdx < gateIdx,
    'and after the optional --with-manifest step, so a just-generated manifest is what gets judged',
  );
  const nextStepsIdx = PUBLISH_SRC.indexOf('下一步（发布不会替你做');
  assertTrue(
    nextStepsIdx !== -1 && gateIdx < nextStepsIdx,
    'and BEFORE the closing "next steps" — a red gate ends the run before anything reads like completion',
  );
  const tail = PUBLISH_SRC.slice(gateIdx, gateIdx + 1600);
  assertTrue(
    /process\.exit\(1\)/.test(tail),
    '🔴 a red gate exits 1 — mismatch fails hard, per the ruling',
  );
  assertTrue(
    /发布还没有做完/.test(tail),
    'and the refusal says the release is NOT done — the gate\'s whole shape is «do not let you think you are done»',
  );
  assertTrue(
    // NOTE (2026-09-21 archive round): FLEET.md moved into docs/archive/ with the
    // rest of the closed records. This assertion follows the pointer instead of
    // pinning the old spelling - what it checks is that the refusal NAMES where the
    // deploy half lives, not that the name sits at a particular path.
    /docs\/archive\/FLEET\.md/.test(tail),
    'while naming where the deploy half lives (device line) instead of implying this script should have done it',
  );
}

// ── §5 the freeze round: the same stop, a different exit code ──────────────
//
// 🔴 THE HAZARD THIS SECTION EXISTS FOR. Everything above says the gate must
// not be escapable. `--freeze-round` is the one thing in the file that changes
// what happens at that gate, so it is exactly the shape that could quietly
// become an escape hatch — and the difference between "an exit the owner
// sanctioned" and "a skip somebody added" is not in the code, it is in whether
// the run still SAYS the live manifest was not updated. So the cases below pin
// the words, not just the exit code.
//
// Background (CLAUDE.md: owner 2026-09-09 froze releases; measured 2026-09-18
// on the first real orchestrated run): publish did everything correctly and
// then died here, because under the freeze nobody may make the live manifest
// advertise this round — which also made every DEPLOY_* step behind PUBLISH
// unreachable through scripts/ship.mjs.
section('§5 --freeze-round — publish stops at the same place, says so, and exits 0');
{
  const { FREEZE_COMPATIBLE_FLAGS, FREEZE_FLAG, describeLive, freezeBlock, freezeRefusal } = await import('./publish-freeze-round.mjs');

  // 5.1 the refusal is an ALLOWLIST, so a flag invented tomorrow cannot inherit
  // the freeze exit by not being on a denylist.
  assertTrue(freezeRefusal([]) === null, 'no --freeze-round ⇒ nothing to say (publish behaves exactly as before)');
  assertTrue(freezeRefusal([FREEZE_FLAG]) === null, 'the flag alone is accepted');
  assertTrue(freezeRefusal([FREEZE_FLAG, '--skip-lan']) === null, '--skip-lan is compatible: it publishes nowhere at all');
  const withManifest = freezeRefusal([FREEZE_FLAG, '--with-manifest']);
  assertTrue(withManifest !== null && /--with-manifest/.test(withManifest), '🔴 --with-manifest is REFUSED beside it: it writes the very file the freeze forbids touching');
  const invented = freezeRefusal([FREEZE_FLAG, '--publish-github-release']);
  assertTrue(invented !== null && /--publish-github-release/.test(invented), 'and so is a flag this file has never heard of — allowlist, not denylist, so tomorrow is covered too');
  assertTrue(/allowlist on purpose/.test(invented), '  ...and the refusal says WHY it is an allowlist, so the next person extends it deliberately');
  assertTrue(
    FREEZE_COMPATIBLE_FLAGS.includes('--freeze-round') && !FREEZE_COMPATIBLE_FLAGS.includes('--with-manifest'),
    `the compatible list is exactly what it claims (${FREEZE_COMPATIBLE_FLAGS.join(' ')})`,
  );

  // 5.2 the block says the sentence a reader needs, and never invents a version.
  const live = describeLive(okFetched({ 'windows-x64': liveEntry('0.3.85'), android: liveEntry('0.3.85') }, '0.3.55'));
  assertTrue(/windows-x64=0\.3\.85/.test(live) && /ios=0\.3\.55/.test(live), `it reads what the live manifest actually points at, per platform (${live})`);
  const block = freezeBlock({ version: '0.3.91', live, url: URL_UNDER_TEST });
  assertTrue(/MANIFEST NOT UPDATED — release freeze round \(owner 2026-09-09\)/.test(block), 'the block leads with MANIFEST NOT UPDATED and names the ruling');
  assertTrue(/the live\s*\n?\s*manifest still points at/.test(block), '  ...and says what the live manifest still points at');
  assertTrue(/0\.3\.85/.test(block) && /0\.3\.91/.test(block), '  ...carrying both numbers: what shipped, and what clients are still being offered');
  assertTrue(/build-update-manifest\.mjs/.test(block) && /verify-live-update-manifest\.mjs/.test(block), '  ...and the same three remaining steps the red gate names, so the freeze does not erase the todo');

  // 🔴 REVERSE CONTROL on the honesty of the block: an endpoint we could not
  // reach must NOT be reported as a version. "I could not ask" and "it says X"
  // are different answers (§1-21) — and this block exists to tell a reader what
  // installed clients are being offered, so a made-up answer is the worst
  // possible content for it.
  const blind = describeLive({ verdict: 'unreachable', status: null, manifest: null, detail: null, error: 'ECONNREFUSED' });
  assertTrue(/COULD NOT ASK/.test(blind) && /ECONNREFUSED/.test(blind), 'an unreachable endpoint reads as COULD NOT ASK, with the reason');
  assertTrue(!/=\d/.test(blind), '  ...and carries no version at all — it never dresses a failed question as an answer');

  // 5.3 the WIRING in publish.mjs: same place, both branches present, exit 0.
  const freezeIdx = PUBLISH_SRC.indexOf('freezeNotice(');
  const gateIdx2 = PUBLISH_SRC.indexOf("'verify-live-update-manifest.mjs'");
  assertTrue(freezeIdx !== -1, 'publish.mjs calls freezeNotice');
  assertTrue(freezeIdx < gateIdx2, 'and it does so INSTEAD of the gate, at the same point in the run — not before the upload, not after "next steps"');
  const uploadIdx2 = PUBLISH_SRC.indexOf('execFileSync(process.execPath, [downloadCenterScript]');
  assertTrue(uploadIdx2 !== -1 && uploadIdx2 < freezeIdx, '🔴 and AFTER the download-centre upload — a freeze round still ships the bytes internally; what it skips is telling the world');
  assertTrue(
    /if \(FREEZE_ROUND\) \{[\s\S]{0,200}freezeNotice[\s\S]{0,200}\} else \{/.test(PUBLISH_SRC),
    'the freeze branch and the gate branch are an if/else over the same spot — there is no path where BOTH are skipped',
  );
  assertTrue(
    PUBLISH_SRC.slice(freezeIdx, gateIdx2).indexOf('process.exit(') === -1,
    'the freeze branch does not exit mid-run: it falls through to the same closing lines, so the round ends green in the ordinary way',
  );
  assertTrue(
    /freezeRefusal\(process\.argv/.test(PUBLISH_SRC),
    'and the flag-combination refusal is wired at the top, where it is reachable before a byte is written',
  );
}

// ── §6 --manifest-deferred — the same gate, asked one node later ────────────
//
// The freeze exit above says «this round tells installed clients NOTHING». This
// one says «a later step of this same run will, and it asserts exactly what this
// gate would have». The difference matters because only one of them leaves
// somebody holding the other end — so the cases below pin BOTH halves: the words
// publish prints, and the refusal that stops the flag being typed by hand, where
// there is no later step and it would simply be ruling ① switched off.
//
// Why it was needed (measured 2026-09-18): in scripts/ship.mjs the manifest is
// built and carried to the relay nodes by steps downstream of PUBLISH, so this
// gate's only honest answer at PUBLISH is "not yet" — it failed every non-freeze
// round on a fact about the graph. Since the 2026-09-09 freeze every round passed
// --freeze-round, so the first full round would have been the first to meet it.
section('§6 --manifest-deferred — publish stops at the same place, names the step that will assert it, and exits 0');
{
  const { DEFERRED_FLAG, SHIP_PID_ENV, deferralRefusal, deferredBlock } = await import('./publish-manifest-deferred.mjs');
  const { describeLive } = await import('./publish-freeze-round.mjs');
  // Recomputed rather than reached for: §5's copy is block-scoped, and a drill
  // that reads another section's local is one edit away from a ReferenceError.
  const gateIdx = PUBLISH_SRC.indexOf("'verify-live-update-manifest.mjs'");

  assertTrue(deferralRefusal([]) === null, 'no flag ⇒ nothing to say (publish behaves exactly as before)');
  const byHand = deferralRefusal([DEFERRED_FLAG], {});
  assertTrue(byHand !== null && /only meaningful inside/.test(byHand), '🔴 typed by hand it is REFUSED — outside a ship run there is no later step, so this would be ruling ① turned off');
  assertTrue(/verify-live-update-manifest\.mjs/.test(byHand), '  ...and the refusal names the assertion it is supposed to be deferring TO, so the reader can check it exists');
  assertTrue(deferralRefusal([DEFERRED_FLAG], { [SHIP_PID_ENV]: '4242' }) === null, 'inside a ship run it is accepted, identified by the pid the orchestrator hands every child');

  const live = describeLive(okFetched({ 'windows-x64': liveEntry('0.3.85'), android: liveEntry('0.3.85') }, '0.3.55'));
  const block = deferredBlock({ version: '0.3.92', live, url: URL_UNDER_TEST });
  assertTrue(/DEFERRED TO THE MANIFEST STEP/.test(block), 'the block says the gate was deferred, not passed');
  assertTrue(/0\.3\.85/.test(block) && /0\.3\.92/.test(block), '  ...carrying both numbers: what shipped, and what clients are still being offered right now');
  assertTrue(/verify-live-update-manifest\.mjs/.test(block), '  ...and names the step that makes the assertion, so a deferral cannot read as a dismissal');
  assertTrue(/fails the ship/.test(block), '  ...and says what a red answer there costs');
  const blind = deferredBlock({ version: '0.3.92', live: describeLive({ verdict: 'unreachable', status: null, manifest: null, detail: null, error: 'ECONNREFUSED' }), url: URL_UNDER_TEST });
  assertTrue(/COULD NOT ASK/.test(blind), 'REVERSE CONTROL: an unreachable endpoint is still reported as COULD NOT ASK — a deferral never invents a version either');

  // The wiring: same spot, three branches over one decision, no early exit.
  const deferIdx = PUBLISH_SRC.indexOf('deferredNotice(');
  assertTrue(deferIdx !== -1 && deferIdx < gateIdx, 'publish.mjs calls deferredNotice INSTEAD of the gate, at the same point in the run');
  assertTrue(
    /\} else if \(MANIFEST_DEFERRED\) \{[\s\S]{0,120}deferredNotice/.test(PUBLISH_SRC),
    'and it is an else-if on the freeze branch — one decision, three outcomes, no path where the gate and both notices are all skipped',
  );
  assertTrue(/deferralRefusal\(process\.argv/.test(PUBLISH_SRC), 'and the flag refusal is wired at the top, reachable before a byte is written');
}

// ── summary ─────────────────────────────────────────────────────────────────
// exitCode, NOT process.exit(): undici's just-released keep-alive sockets make
// a hard exit trip libuv's UV_HANDLE_CLOSING assert on Windows (measured here,
// node 24: exit 0xC0000409 AFTER every assertion had already printed). The
// servers are closed and idle sockets are unref'd, so falling off the end
// exits promptly with the same code.
console.log(failures === 0 ? '\nOK — the live face can no longer silently disagree with a finished publish' : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
