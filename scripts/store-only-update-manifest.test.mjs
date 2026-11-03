// Drill for `build-update-manifest.mjs --store-only` (2026-11-02).
//
// WHY. iOS 0.3.118 reached the App Store while the live manifest still said
// ios 0.3.107. The normal run could not move that one row: it took the round
// version from package.json (0.3.119, unreleased), picked up 0.3.119 portable
// zips another round had left in ./publish, and superseded the live 0.3.118
// linux/mac rows with them. Store-only must carry every artifact row forward
// unchanged and move only the store rows — and refuse every way it could
// quietly turn back into a normal build.
//
// SAFETY. Unlike the ruling-① drill beside this file (which never spawns the
// builder), this one has to run the real script end to end: "ignores ./publish
// and package.json" is a claim about the script, not about a lib function. It
// is made safe by the builder's three overrides, all pointed away from anything
// real:
//   - FLOWMIC_UPDATE_MANIFEST_OUT_DIR → a throwaway temp dir (never ./publish);
//   - FLOWMIC_LIVE_MANIFEST_URL and FLOWMIC_UPDATE_DOWNLOAD_BASE → a loopback
//     server on 127.0.0.1:0, shut down in a finally.
// The child is spawned asynchronously: the loopback server lives in this
// process, and spawnSync would block the event loop that has to answer it.
//
// EXIT CODES (card IT-38): 0 = PASS, 1 = FAIL. Never skips.
// Run: `node scripts/store-only-update-manifest.test.mjs`
// Discovered by `pnpm verify:scripts` (scripts/run-script-tests.mjs globs *.test.mjs).

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { mergeLivePlatforms } from './update-manifest-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILDER = join(ROOT, 'scripts', 'build-update-manifest.mjs');
// The version a normal run would stamp on this round — read the same way the
// builder reads it, so the fixture below is "newer than live" on any branch.
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const LIVE_VERSION = '0.0.1';
const IOS_NEW = '0.0.2';
const STORE_URL = 'https://apps.apple.com/app/flowmic-voice-typing/id0000000000';

let failures = 0;
const section = (title) => console.log(`\n=== ${title} ===`);
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label}`);
    failures++;
  }
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// ── a loopback "relay + release host" ───────────────────────────────────────
// `state.live` is what GET /api/updates/latest answers (null ⇒ 404);
// `state.files` maps a /rel/download/... path to the bytes served there.
const state = { live: null, files: new Map() };
const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/api/updates/latest') {
    if (state.live === null) { res.writeHead(404); res.end('not here'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state.live));
    return;
  }
  const body = state.files.get(path);
  if (body) { res.writeHead(200, { 'content-length': body.length }); res.end(body); return; }
  res.writeHead(404); res.end('no such file');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const BASE = `${ORIGIN}/rel`;
const LIVE_URL = `${ORIGIN}/api/updates/latest`;

function liveRow(platform, kind, filename) {
  const bytes = Buffer.from(`live ${platform} ${LIVE_VERSION} bytes`);
  const path = `/rel/download/v${LIVE_VERSION}/${filename}`;
  state.files.set(path, bytes);
  return {
    version: LIVE_VERSION,
    notes_url: `${BASE}/tag/v${LIVE_VERSION}`,
    artifacts: [{ kind, locale: null, filename, url: `${ORIGIN}${path}`, sha256: sha(bytes), size: bytes.length }],
  };
}

function freshLive() {
  state.files.clear();
  return {
    manifest_version: 1,
    generated_at: '2026-10-23T00:00:00.000Z',
    platforms: {
      android: liveRow('android', 'apk', `FlowMic-${LIVE_VERSION}-release.apk`),
      'linux-x64': liveRow('linux-x64', 'portable-zip', `FlowMic-${LIVE_VERSION}-portable-linux-x64.zip`),
      'macos-arm64': liveRow('macos-arm64', 'portable-zip', `FlowMic-${LIVE_VERSION}-portable-macos-arm64.zip`),
      'windows-x64': liveRow('windows-x64', 'msi', `FlowMic_${LIVE_VERSION}_x64_en-US.msi`),
    },
    store_platforms: {
      ios: { version: LIVE_VERSION, notes_url: `${BASE}/tag/v${LIVE_VERSION}`, store_url: 'https://testflight.apple.com/join/abc' },
    },
  };
}

// The 0.3.119 accident, reproduced: newer portable zips (with valid sidecars)
// left in the publish dir, at the version package.json says. Their bytes are
// ALSO served at their would-be release URLs — the worse variant, where that
// release exists — so gate ② cannot be what saves store-only: only the mode
// itself can.
function outDirWithNewerLeftovers() {
  const dir = mkdtempSync(join(tmpdir(), 'flowmic-store-only-'));
  for (const p of ['linux-x64', 'macos-arm64']) {
    const name = `FlowMic-${PKG_VERSION}-portable-${p}.zip`;
    const bytes = Buffer.from(`leftover ${p} ${PKG_VERSION}`);
    writeFileSync(join(dir, name), bytes);
    writeFileSync(join(dir, `${name}.sha256`), `${sha(bytes)}  ${name}\n`);
    state.files.set(`/rel/download/v${PKG_VERSION}/${name}`, bytes);
  }
  return dir;
}

function runBuilder(args, outDir, liveUrl = LIVE_URL) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BUILDER, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        FLOWMIC_LIVE_MANIFEST_URL: liveUrl,
        FLOWMIC_UPDATE_DOWNLOAD_BASE: BASE,
        FLOWMIC_UPDATE_MANIFEST_OUT_DIR: outDir,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const STORE_ARGS = ['--store-only', '--ios', IOS_NEW, '--ios-store-url', STORE_URL];
const dirs = [];
const newOut = () => { const d = outDirWithNewerLeftovers(); dirs.push(d); return d; };
const manifestIn = (dir) => join(dir, 'update-manifest.json');

try {
  // The base URLs in the fixture must be under BASE for gate ③, except the
  // artifact URLs, which sit under ORIGIN/rel — the same prefix.
  assertTrue(BASE.startsWith(ORIGIN), 'fixture sanity: artifact and notes URLs share the download base');

  // ── §1 positive control: this fixture DOES trip a normal run ──────────────
  section('§1 positive control — a normal run over the same fixture supersedes the live rows');
  {
    state.live = freshLive();
    const out = newOut();
    const r = await runBuilder(['--check'], out);
    assertTrue(
      r.stdout.includes(`linux-x64: ${LIVE_VERSION} (live) superseded by ${PKG_VERSION} (this round)`),
      `the normal run picks up the ${PKG_VERSION} leftover and supersedes linux-x64 — so §2 passing means store-only ignored it, not that the fixture was invisible`,
    );
    assertTrue(
      r.status === 0 && r.stdout.includes(`"filename": "FlowMic-${PKG_VERSION}-portable-linux-x64.zip"`),
      `and, with that release reachable, it calls a manifest announcing ${PKG_VERSION} to Linux clients generable`,
    );
    assertTrue(!existsSync(manifestIn(out)), 'nothing was written (--check)');
  }

  // ── §2 store-only keeps every artifact row and moves only ios ─────────────
  section('§2 store-only — every artifact row identical to live, only store_platforms.ios moves');
  {
    const live = freshLive();
    state.live = live;
    const out = newOut();
    const r = await runBuilder(STORE_ARGS, out);
    assertTrue(r.status === 0, `store-only exits 0 (status ${r.status}${r.status ? `; stderr: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''})`);
    const written = existsSync(manifestIn(out)) ? JSON.parse(readFileSync(manifestIn(out), 'utf8')) : null;
    assertTrue(written !== null, 'update-manifest.json is written into the out dir');
    assertTrue(
      written !== null && JSON.stringify(written.platforms) === JSON.stringify(live.platforms),
      '🔴 platforms is byte-identical (same keys, same order, same fields) to the live fixture, despite newer leftovers and package.json',
    );
    assertTrue(
      written !== null && !JSON.stringify(written.platforms).includes(PKG_VERSION),
      `no artifact row mentions the package.json version ${PKG_VERSION}`,
    );
    const ios = written?.store_platforms?.ios;
    assertTrue(ios?.version === IOS_NEW, `store_platforms.ios.version → ${IOS_NEW}`);
    assertTrue(ios?.store_url === STORE_URL, 'store_platforms.ios.store_url → the given store page');
    assertTrue(ios?.notes_url === `${BASE}/tag/v${IOS_NEW}`, 'store_platforms.ios.notes_url → the release page of the new iOS version');
    assertTrue(
      written !== null && Object.keys(written.store_platforms).join() === 'ios',
      'no other store row appears',
    );
    assertTrue(written?.manifest_version === 1 && written?.generated_at !== live.generated_at, 'manifest_version stays 1, generated_at is new');
    assertTrue(/remote verify passed: 4 artifacts/.test(r.stdout), 'gate ② re-verified all 4 carried artifacts at their published URLs');
  }

  // ── §3 refusals: every way store-only could degrade into something else ───
  section('§3 refusals — no store flag / no live manifest / skip flag / nothing moved / bad carried bytes');
  {
    state.live = freshLive();
    let out = newOut();
    let r = await runBuilder(['--store-only'], out);
    assertTrue(r.status === 1 && /none was given/.test(r.stderr), 'no --ios / --ios-store-url → refused');
    assertTrue(!existsSync(manifestIn(out)), 'and nothing written');

    state.live = null; // 404
    out = newOut();
    r = await runBuilder(STORE_ARGS, out);
    assertTrue(r.status === 1 && /no rows to carry forward/.test(r.stderr), "live answers 404 ('absent') → refused, not built from ./publish");
    assertTrue(!existsSync(manifestIn(out)), 'and nothing written');

    const dead = createServer(() => {});
    await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const deadPort = dead.address().port;
    await new Promise((resolve) => dead.close(resolve));
    out = newOut();
    r = await runBuilder(STORE_ARGS, out, `http://127.0.0.1:${deadPort}/api/updates/latest`);
    assertTrue(r.status === 1 && /could not ask the live endpoint/.test(r.stderr), 'live unreachable → refused');
    assertTrue(!existsSync(manifestIn(out)), 'and nothing written');

    state.live = freshLive();
    out = newOut();
    r = await runBuilder([...STORE_ARGS, '--skip-remote-verify'], out);
    assertTrue(r.status === 1 && /cannot run with --skip-remote-verify/.test(r.stderr), '--skip-remote-verify (which skips the live fetch) → refused');

    out = newOut();
    r = await runBuilder(['--store-only', '--ios', LIVE_VERSION, '--ios-store-url', 'https://testflight.apple.com/join/abc'], out);
    assertTrue(r.status === 1 && /nothing to publish/.test(r.stderr), 'a store block identical to live → refused');

    const tampered = freshLive();
    state.live = tampered;
    const winPath = new URL(tampered.platforms['windows-x64'].artifacts[0].url).pathname;
    state.files.set(winPath, Buffer.from('not the bytes the manifest names'));
    out = newOut();
    r = await runBuilder(STORE_ARGS, out);
    assertTrue(r.status === 1 && !existsSync(manifestIn(out)), 'a carried row whose bytes no longer match at its URL → gate ② refuses the whole manifest');
  }

  // ── §4 the lib behaviour the builder's comment relies on ──────────────────
  section('§4 mergeLivePlatforms over an empty map retains every live key, by reference');
  {
    const live = freshLive();
    const platforms = {};
    const merged = mergeLivePlatforms({ platforms, liveManifest: live });
    assertTrue(
      Object.keys(platforms).join() === Object.keys(live.platforms).join() &&
        Object.keys(platforms).every((k) => platforms[k] === live.platforms[k]),
      'every key retained, in live order, as the very same object',
    );
    assertTrue(merged.superseded.length === 0 && merged.keptLiveNewer.length === 0, 'nothing superseded, nothing flagged');
  }
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nOK — store-only moves only the store rows' : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
