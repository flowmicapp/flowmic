// Ruling ① drill (owner 2026-08-10 — docs/decisions/2026-08-10-owner-seven-
// rulings-after-0261.md ①): the update manifest means "latest DOWNLOADABLE per
// platform", not "what this round built".
//
// WHAT IT COST WHEN THIS WAS WRONG. 0.2.61 shipped windows+android only, and
// `macos-arm64` — live at 0.2.59 — vanished from the manifest wholesale.
// Clients ask "is there an update for MY platform", not "how many platforms
// did this round build". §1 below is the ruling's own named reverse control:
// a simulated windows+android-only round must NOT lose the mac entry.
//
// SAFETY — same rules as the UP-10 drill beside this file:
//   - NEVER imports and NEVER spawns scripts/build-update-manifest.mjs (all
//     top-level statements; importing it runs it against the real ./publish
//     and the real network). It is read as TEXT only, for wiring pins.
//   - DOES import scripts/update-manifest-lib.mjs, which is pure at import —
//     that purity is the whole reason the lib exists as a separate file: the
//     REAL merge/fetch functions get driven here instead of re-derived. A test
//     that re-implements its subject proves only that it agrees with itself.
//   - Every HTTP request goes to a loopback server started on 127.0.0.1:0 and
//     shut down in a finally. The 'unreachable' case uses a REAL closed port.
//
// EXIT CODES (card IT-38): 0 = PASS, 1 = FAIL. Never skips: every section
// depends only on loopback sockets, in-memory objects, and repo source text.
//
// Run: `node scripts/ruling1-update-manifest-merge.test.mjs`
// Also discovered by `pnpm verify:scripts` (inside verify:delivery) by glob.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  classify,
  compareVersions,
  fetchLiveManifest,
  isRoundArtifactName,
  mergeLivePlatforms,
  resolveLiveManifestUrl,
  LIVE_MANIFEST_URL_ENV,
} from './update-manifest-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILDER_SRC = readFileSync(join(ROOT, 'scripts', 'build-update-manifest.mjs'), 'utf8'); // text only

let failures = 0;
const section = (title) => console.log(`\n=== ${title} ===`);
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label}`);
    failures++;
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────
// Entries carry every field the real manifest carries, because "retained
// VERBATIM" is a claim about all of them, not just `version`.
const HEX = 'a'.repeat(64);
function entry(platform, version, kind) {
  return {
    version,
    notes_url: `http://198.51.100.1/files/flowmic/release/${version}/FlowMic-${version}-RELEASE_NOTES.md`,
    artifacts: [
      {
        kind,
        locale: null,
        filename: `FlowMic-${version}-${platform}.bin`,
        url: `http://198.51.100.1/files/flowmic/release/${version}/FlowMic-${version}-${platform}.bin`,
        sha256: HEX,
        size: 1234,
      },
    ],
  };
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/api/updates/latest`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

// ── §1 the ruling's reverse control: a windows+android round keeps the mac entry ──
section('§1 reverse control — simulated windows+android-only round must NOT drop macos-arm64');
{
  const macLive = entry('macos-arm64', '0.0.1', 'portable-zip');
  const platforms = {
    'windows-x64': entry('windows-x64', '0.0.2', 'msi'),
    android: entry('android', '0.0.2', 'apk'),
  };
  const before = platforms;
  const live = {
    manifest_version: 1,
    generated_at: '2026-08-10T00:00:00.000Z',
    platforms: {
      'windows-x64': entry('windows-x64', '0.0.1', 'msi'),
      android: entry('android', '0.0.1', 'apk'),
      'macos-arm64': macLive,
    },
  };
  const merged = mergeLivePlatforms({ platforms, liveManifest: live });

  assertTrue('macos-arm64' in platforms, 'macos-arm64 is present after the merge — it did not vanish with the round');
  assertTrue(
    JSON.stringify(platforms['macos-arm64']) === JSON.stringify(macLive),
    'the retained entry is VERBATIM — version, notes_url, url, sha256, size all untouched',
  );
  assertTrue(
    platforms['macos-arm64']?.notes_url?.includes('0.0.1'),
    'its notes_url still points at ITS version — a retained entry describes the version it ships, not this round',
  );
  assertTrue(platforms['windows-x64'].version === '0.0.2', 'windows-x64 stays at this round (higher version wins)');
  assertTrue(platforms.android.version === '0.0.2', 'android stays at this round');
  assertTrue(
    merged.retained.length === 1 && merged.retained[0].platform === 'macos-arm64' && merged.retained[0].version === '0.0.1',
    'the merge REPORTS the retention, so the builder can say it out loud',
  );
  assertTrue(
    platforms === before,
    '🔴 the merge mutates the SAME platforms object — the UP-10 drill pins the remote gate as the literal ' +
      '`gateRemoteArtifacts({ platforms, fail, ok })`, and retained entries must flow through that same call',
  );
}

// ── §2 the higher-version rule, both directions ─────────────────────────────
section('§2 same platform, take the higher version — live-newer is kept and flagged; built-newer supersedes');
{
  const liveNewer = entry('windows-x64', '0.0.9', 'msi');
  const platforms = { 'windows-x64': entry('windows-x64', '0.0.2', 'msi') };
  const merged = mergeLivePlatforms({
    platforms,
    liveManifest: { platforms: { 'windows-x64': liveNewer } },
  });
  assertTrue(platforms['windows-x64'].version === '0.0.9', 'live NEWER than built → live entry wins');
  assertTrue(
    merged.keptLiveNewer.length === 1 && merged.keptLiveNewer[0].live === '0.0.9' && merged.keptLiveNewer[0].built === '0.0.2',
    'and it is reported as the strange state it is, not absorbed as routine',
  );

  const platforms2 = { android: entry('android', '0.0.3', 'apk') };
  const merged2 = mergeLivePlatforms({
    platforms: platforms2,
    liveManifest: { platforms: { android: entry('android', '0.0.2', 'apk') } },
  });
  assertTrue(platforms2.android.version === '0.0.3', 'built newer than live → built entry stays');
  assertTrue(
    merged2.superseded.length === 1 && merged2.superseded[0].from === '0.0.2' && merged2.superseded[0].to === '0.0.3',
    'the supersession is reported with both versions',
  );
}

// ── §3 version comparison is numeric, not lexicographic ─────────────────────
section('§3 compareVersions — 0.2.9 < 0.2.10 (the string compare that would get this wrong)');
{
  assertTrue(compareVersions('0.2.9', '0.2.10') === -1, '0.2.9 < 0.2.10 numerically (string compare says the opposite)');
  assertTrue(compareVersions('0.2.10', '0.2.9') === 1, 'and symmetric');
  assertTrue(compareVersions('0.2.61', '0.2.61') === 0, 'equal is equal');
  assertTrue(compareVersions('1.0.0', '0.99.99') === 1, 'major beats any minor/patch');
}

// ── §4 fetchLiveManifest: the four verdicts, against a real loopback server ──
section('§4 fetchLiveManifest — ok / absent / invalid / unreachable, each from a real response');
{
  const good = {
    manifest_version: 1,
    generated_at: '2026-08-10T00:00:00.000Z',
    platforms: { android: entry('android', '0.0.2', 'apk') },
  };

  const okRes = await withServer(
    (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(good)); },
    (url) => fetchLiveManifest({ url }),
  );
  assertTrue(okRes.verdict === 'ok' && okRes.manifest.platforms.android.version === '0.0.2', '200 + valid manifest → ok, parsed');

  const notFound = await withServer(
    (req, res) => { res.writeHead(404); res.end('not here'); },
    (url) => fetchLiveManifest({ url }),
  );
  assertTrue(notFound.verdict === 'absent' && notFound.status === 404, '404 (route not mounted) → absent — a DEFINITE "nothing is live"');

  const unavailable = await withServer(
    (req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'UPDATE_MANIFEST_UNAVAILABLE', detail: 'manifest_unreadable' }));
    },
    (url) => fetchLiveManifest({ url }),
  );
  assertTrue(
    unavailable.verdict === 'absent' && unavailable.detail === 'manifest_unreadable',
    "503 UPDATE_MANIFEST_UNAVAILABLE → absent, with the relay's own detail carried through",
  );

  const garbage = await withServer(
    (req, res) => { res.writeHead(200); res.end('<html>definitely not json</html>'); },
    (url) => fetchLiveManifest({ url }),
  );
  assertTrue(garbage.verdict === 'invalid' && garbage.detail === 'unparsable_json', '200 + non-JSON → invalid (not absent: an answer arrived and we cannot read it)');

  const badShape = structuredClone(good);
  badShape.platforms.android.artifacts[0].sha256 = HEX.toUpperCase();
  const shapeRes = await withServer(
    (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(badShape)); },
    (url) => fetchLiveManifest({ url }),
  );
  assertTrue(
    shapeRes.verdict === 'invalid' && String(shapeRes.detail).startsWith('bad_sha256'),
    'uppercase sha256 → invalid — a retained entry with a sha the byte gate cannot use must never be merged',
  );

  // A REAL refused connection, not a thrown fake: listen, learn the port, close.
  const dead = createServer(() => {});
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
  const deadPort = dead.address().port;
  await new Promise((resolve) => dead.close(resolve));
  const unreachable = await fetchLiveManifest({ url: `http://127.0.0.1:${deadPort}/api/updates/latest`, timeoutMs: 5_000 });
  assertTrue(unreachable.verdict === 'unreachable' && Boolean(unreachable.error), 'a closed port → unreachable, with the transport code dug out');
  assertTrue(unreachable.manifest === null, 'and no manifest is fabricated for it');
}

// ── §5 the builder is actually wired to all of this (text pins) ─────────────
section('§5 build-update-manifest.mjs wiring — merge before the byte gate, refusal on blind');
{
  assertTrue(/from '\.\/update-manifest-lib\.mjs'/.test(BUILDER_SRC), 'the builder imports the lib');
  assertTrue(!/^function classify\(/m.test(BUILDER_SRC), 'classify() is no longer defined in the builder — one owner, in the lib');

  const mergeIdx = BUILDER_SRC.indexOf('mergeLivePlatforms({ platforms');
  const gateIdx = BUILDER_SRC.indexOf('await gateRemoteArtifacts({ platforms, fail, ok })');
  const emptyRefusalIdx = BUILDER_SRC.indexOf('拒绝产出一份空清单');
  assertTrue(mergeIdx !== -1, 'the builder calls mergeLivePlatforms on the same `platforms` object');
  assertTrue(
    gateIdx !== -1 && mergeIdx < gateIdx,
    '🔴 merge happens BEFORE the remote byte gate — retained entries get their bytes re-verified every round',
  );
  assertTrue(
    emptyRefusalIdx !== -1 && emptyRefusalIdx < mergeIdx,
    'and AFTER the empty-platforms refusal — an empty round still refuses instead of shipping a live-only echo',
  );

  assertTrue(
    /live\.verdict === 'unreachable'\)\s*\{\s*fail\(/.test(BUILDER_SRC),
    "🔴 'could not ask' is a hard refusal — a manifest built blind may silently drop a platform",
  );
  assertTrue(
    /live\.verdict === 'invalid'\)\s*\{\s*fail\(/.test(BUILDER_SRC),
    'an unconsumable live answer is a hard refusal too',
  );
  assertTrue(
    /live\.verdict === 'absent'\)\s*\{\s*const detail/.test(BUILDER_SRC),
    "'absent' (404/503) does NOT refuse — it is a definite answer that nothing is live, said out loud",
  );
  assertTrue(
    BUILDER_SRC.includes('DROPPED'),
    'the --skip-remote-verify branch says platforms would be DROPPED — the offline drill names its own cost',
  );
}

// ── §6 shared predicates + the lib refuses a direct run ─────────────────────
section('§6 isRoundArtifactName / classify are shared, and the lib is guarded');
{
  assertTrue(isRoundArtifactName('FlowMic_0.0.2_x64_zh-CN.msi', '0.0.2'), 'msi of this round is collected');
  assertTrue(!isRoundArtifactName('FlowMic_0.0.1_x64_zh-CN.msi', '0.0.2'), 'msi of another round is not');
  assertTrue(!isRoundArtifactName('random-archive-0.0.2.zip', '0.0.2'), 'a non-portable zip is not (narrow match, not `\\.zip$`)');
  assertTrue(classify('FlowMic-0.0.2-release.apk')?.platform === 'android', 'classify still answers android for an APK');
  assertTrue(classify('FlowMic-0.0.2-portable-macos-arm64.zip')?.platform === 'macos-arm64', 'and macos-arm64 for the mac portable zip');

  assertTrue(resolveLiveManifestUrl({}) === 'https://flowmic.app/api/updates/latest', 'the default live URL is the official site');
  assertTrue(
    resolveLiveManifestUrl({ [LIVE_MANIFEST_URL_ENV]: 'http://127.0.0.1:1/x' }) === 'http://127.0.0.1:1/x',
    'and the env override works — which is what makes loopback drills of the full mechanism possible',
  );

  const direct = spawnSync(process.execPath, [join(ROOT, 'scripts', 'update-manifest-lib.mjs')], { encoding: 'utf8' });
  assertTrue(direct.status === 2, 'running the lib directly exits 2 (module-entrypoint-guard) — a silent 0 reads as a passing check');
  assertTrue(/library module/.test(direct.stderr), 'and says why, naming the entry points to use instead');
}

// ── summary ─────────────────────────────────────────────────────────────────
// exitCode, NOT process.exit() — same libuv-on-Windows reasoning as the
// companion gate drill's summary (a hard exit races undici's socket teardown).
console.log(failures === 0 ? '\nOK — ruling ① merge semantics hold' : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
