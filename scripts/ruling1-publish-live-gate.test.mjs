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
const okFetched = (platforms) => ({ verdict: 'ok', status: 200, manifest: { platforms }, detail: null, error: null });

// ── §1 the pure judgment: each verdict names ITS action, and only its own ────
section('§1 gateShippedPlatformsLive — five states, five distinguishable messages');
{
  const green = gateShippedPlatformsLive({
    shipped: ['windows-x64', 'android'],
    version: '0.0.2',
    fetched: okFetched({ 'windows-x64': liveEntry('0.0.2'), android: liveEntry('0.0.2') }),
    url: URL_UNDER_TEST,
  });
  assertTrue(green.failures.length === 0 && green.okLines.length === 2, 'both platforms live at this round → zero failures, two ok lines');

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
  assertTrue(missing.okLines.length === 1, '(that other platform is reported ok — one run tells the operator everything)');

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
  assertTrue(green.failures.length === 0 && green.okLines.length === 2, 'live serves this round → green, through the REAL fetch');

  const red = await runAgainst('0.0.1');
  assertTrue(
    red.failures.length === 2 && red.failures.every((f) => /still advertises 0\.0\.1/.test(f)),
    'live serves the previous round → red per platform — exactly the state 0.2.61 shipped in',
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
    /docs\/FLEET\.md/.test(tail),
    'while naming where the deploy half lives (device line) instead of implying this script should have done it',
  );
}

// ── summary ─────────────────────────────────────────────────────────────────
// exitCode, NOT process.exit(): undici's just-released keep-alive sockets make
// a hard exit trip libuv's UV_HANDLE_CLOSING assert on Windows (measured here,
// node 24: exit 0xC0000409 AFTER every assertion had already printed). The
// servers are closed and idle sockets are unref'd, so falling off the end
// exits promptly with the same code.
console.log(failures === 0 ? '\nOK — the live face can no longer silently disagree with a finished publish' : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
