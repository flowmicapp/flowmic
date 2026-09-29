#!/usr/bin/env node
// EMB-13 (local variant): a real-world acceptance rig for website voice input.
//
//   FLOWMIC_EMB13_LIVE=1 node scripts/emb13-live-rig.mjs
//
// OPT-IN, AND IT SPENDS MANAGED MINUTES. Without FLOWMIC_EMB13_LIVE=1 it prints
// one `SKIP:` line and exits 2 (the repo's skip code, scripts/run-script-tests.mjs)
// before touching a socket, so no gate can start it by accident.
//
// COST PER RUN. A full run makes 27 recordings of the 6 s fixture: 20 field-type runs (4 types x 5),
// 3 follow-focus edge cases (password, opted-out field, switching field mid-sentence), 3 fixed-selector
// and 1 no-target. Read back from the relay's own key counter over five full runs: 1.99 to 2.46 minutes of
// managed transcription (166 to 199 s of audio streamed; the meter read 70 to 88 percent of that in
// those runs, mechanism not checked). Budget 3 minutes per full run, about 72 minutes a
// month if run nightly. FLOWMIC_EMB13_ONLY narrows it: scenario D or E alone is one recording or none.
// Wall time is about 8.5 minutes, most of it the aligned waits between recordings. The test key carries
// a 15 minute cap, so a runaway loop cannot spend more than that.
//
// WHAT IT IS. A third-party origin (a static site on 127.0.0.1:<port>), a real
// Chromium whose microphone is a recorded WAV (--use-file-for-fake-audio-capture),
// this tree's server-core running in saas mode with managed Soniox recognition
// (credentials read from .local/soniox.env, never printed), a real account, and a
// publishable key minted through the real console API and bound to that origin.
// The SDK is the built loader + widget from the web repo, served from a second
// origin in the production layout (/go/integrator/v1.js plus the hashed bundle).
// What lands in the host page's fields is read back from the page itself.
//
// WHAT IT PROVES: the words a real recogniser returned for real speech land in the
// field the visitor was in (follow-focus), only in the listed field (fixed
// selector), at the caret, without the press taking the caret; an unreachable
// target writes nothing and says so; how long each step took.
// WHAT IT DOES NOT: recognition accuracy (one 6 s fixture), phones, other browsers,
// a public origin (127.0.0.1 shares a site with the relay's host name; the real
// third-party run is the follow-up), or the production node (this machine's
// network path to the recogniser is not the production origin's).
//
// INPUTS (env): FLOWMIC_EMB13_LIVE=1 (required); FLOWMIC_EMB13_WEB_ROOT = a web
// client checkout whose packages/sdk/dist and packages/core are built (default:
// ../flowmic-web or ../../flowmic-web); FLOWMIC_EMB13_SONIOX_ENV = env file
// (default: .local/soniox.env, then the main checkout's); FLOWMIC_EMB13_WAV =
// speech WAV (default: apps/mobile/integration_test/fixtures/zh-6s.wav, a real
// 6 s human clip); FLOWMIC_PLAYWRIGHT_MODULE (as scripts/linux-copy-render.mjs).
// FLOWMIC_EMB13_DRY=1 resolves and prints the configuration and stops (no relay, no browser, no
// minutes). FLOWMIC_EMB13_ONLY=A,B,C,D,E,F picks scenarios; FLOWMIC_EMB13_RUNS / _KINDS shrink scenario B
// (debugging the rig only: the card asks for 5 runs of every field type). FLOWMIC_EMB13_KEEP_CHUNKS=1 keeps
// every audio:chunk frame in report.json (thousands of rows) to inspect how much audio each press streamed.
// Output: .local/emb13-live/<stamp>/report.json (+ screenshots on failure).
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { liveEnabled, padWavWithSilence, parseEnvFile, redact, RIG_FLAG } from './emb13-live-rig-lib.mjs';

if (!liveEnabled(process.env)) {
  console.log(`SKIP: ${RIG_FLAG} is not 1; this rig spends managed transcription minutes and only runs on request.`);
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const KEY_QUOTA_MINUTES = 15; // a spend guard on the test key; the account's own allowance is 20

// ---------------------------------------------------------------------------
// configuration (fail early, name the missing thing, print no secrets)
// ---------------------------------------------------------------------------
function firstExisting(list) { return list.find((p) => p && existsSync(p)) ?? null; }
function gitCommonRoot() {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: REPO, encoding: 'utf8' });
  return r.status === 0 ? resolve(REPO, r.stdout.trim(), '..') : null;
}
function resolveConfig() {
  const webRoot = firstExisting([
    process.env.FLOWMIC_EMB13_WEB_ROOT && resolve(process.env.FLOWMIC_EMB13_WEB_ROOT),
    resolve(REPO, '..', 'flowmic-web'), resolve(REPO, '..', '..', 'flowmic-web'),
  ].map((p) => (p && existsSync(join(p, 'packages', 'sdk', 'dist', 'flowmic-sdk.heavy.json')) ? p : null)));
  if (!webRoot) {
    throw new Error('no built web client: set FLOWMIC_EMB13_WEB_ROOT to a checkout where `pnpm --filter @flowmic/web-core build && pnpm --filter @flowmic/web-sdk build` has run (packages/sdk/dist/flowmic-sdk.heavy.json is missing)');
  }
  const common = gitCommonRoot();
  const sonioxPath = firstExisting([
    process.env.FLOWMIC_EMB13_SONIOX_ENV, join(REPO, '.local', 'soniox.env'), common && join(common, '.local', 'soniox.env'),
  ]);
  if (!sonioxPath) throw new Error('no Soniox credentials file: set FLOWMIC_EMB13_SONIOX_ENV or provide .local/soniox.env');
  const soniox = parseEnvFile(readFileSync(sonioxPath, 'utf8'));
  for (const k of ['FLOWMIC_MANAGED_STT_ENGINE', 'FLOWMIC_MANAGED_STT_API_KEY']) {
    if (!soniox[k]) throw new Error(`${sonioxPath} has no ${k}`);
  }
  const wav = resolve(process.env.FLOWMIC_EMB13_WAV ?? join(REPO, 'apps', 'mobile', 'integration_test', 'fixtures', 'zh-6s.wav'));
  if (!existsSync(wav)) throw new Error(`speech fixture not found: ${wav}`);
  const dist = join(webRoot, 'packages', 'sdk', 'dist');
  const heavy = JSON.parse(readFileSync(join(dist, 'flowmic-sdk.heavy.json'), 'utf8'));
  const reactDir = join(webRoot, 'node_modules', 'react', 'umd');
  const reactDomDir = join(webRoot, 'node_modules', 'react-dom', 'umd');
  const react = existsSync(join(reactDir, 'react.production.min.js')) && existsSync(join(reactDomDir, 'react-dom.production.min.js'))
    ? { react: join(reactDir, 'react.production.min.js'), dom: join(reactDomDir, 'react-dom.production.min.js') } : null;
  const cloudModule = join(REPO, 'packages', 'stt-cloud', 'dist', 'index.cjs');
  if (!existsSync(cloudModule)) throw new Error('packages/stt-cloud/dist/index.cjs is missing: run `pnpm --filter @flowmic/stt-cloud build`');
  return { webRoot, dist, heavyFile: heavy.file, soniox, sonioxPath, wav, react, cloudModule };
}

// ---------------------------------------------------------------------------
// the two static origins: the visitor's site, and the SDK host (production layout)
// ---------------------------------------------------------------------------
function listen(server, port = 0) {
  return new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => ok(server.address().port)); });
}
async function startSdkHost(cfg) {
  const requests = [];
  const loader = readFileSync(join(cfg.dist, 'flowmic-sdk.v1.js'));
  const heavy = readFileSync(join(cfg.dist, cfg.heavyFile));
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    requests.push({ at: Date.now(), path });
    const send = (body, cache) => {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': cache, 'access-control-allow-origin': '*' });
      res.end(body);
    };
    if (path === '/go/integrator/v1.js') return send(loader, 'public, max-age=300, must-revalidate');
    if (path === `/go/integrator/${cfg.heavyFile}`) return send(heavy, 'public, max-age=31536000, immutable');
    res.writeHead(404).end();
  });
  const port = await listen(server);
  return { server, port, origin: `http://127.0.0.1:${port}`, requests, loaderBytes: loader.length, loaderGzip: gzipSync(loader, { level: 9 }).length };
}
async function startSite(cfg, ctl) {
  const template = readFileSync(join(HERE, 'emb13-page', 'index.html'), 'utf8');
  const files = { '/probe.js': join(HERE, 'emb13-page', 'probe.js'), '/react.js': cfg.react?.react, '/react-dom.js': cfg.react?.dom };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (files[url.pathname]) {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      return res.end(readFileSync(files[url.pathname]));
    }
    if (url.pathname !== '/') return void res.writeHead(404).end();
    const target = url.searchParams.get('target');
    const html = template
      .replace('%%REACT_TAGS%%', cfg.react ? '<script src="/react.js"></script><script src="/react-dom.js"></script>' : '')
      .replace('%%SDK_SRC%%', `${ctl.sdkOrigin}/go/integrator/v1.js`).replace('%%KEY%%', ctl.key).replace('%%ENDPOINT%%', ctl.endpoint)
      .replace('%%TARGET_ATTR%%', target === null ? '' : ` data-target="${target.replace(/"/g, '&quot;')}"`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  const port = await listen(server);
  return { server, port, origin: `http://127.0.0.1:${port}` };
}

// ---------------------------------------------------------------------------
// relay + account + key (the real routes; nothing is written to the database)
// ---------------------------------------------------------------------------
async function startRelay(cfg, runDir) {
  const { startSaasServer, mailFileDir, mailFileEnv, saasJwt, verifyRegisteredEmail } = await import(
    pathToFileURL(join(REPO, 'verify', 'golden', 'harness.mjs')).href);
  // The golden harness spreads process.env into the child. A stray FLOWMIC_* from
  // the operator's shell (an engine pool, a switch) must not reach a bench.
  const keep = (name) => name.startsWith('FLOWMIC_EMB13_') || name === 'FLOWMIC_PLAYWRIGHT_MODULE' || name === 'FLOWMIC_CHROMIUM';
  for (const name of Object.keys(process.env)) if (name.startsWith('FLOWMIC_') && !keep(name)) delete process.env[name];
  const mailDir = mailFileDir();
  const dbPath = join(runDir, 'relay.sqlite');
  const saas = await startSaasServer({
    FLOWMIC_DB_PATH: dbPath,
    // A LOCAL process env, this bench only. The production switch is not touched.
    FLOWMIC_MANAGED_STT_ENABLED: '1',
    FLOWMIC_MANAGED_STT_ENGINE: cfg.soniox.FLOWMIC_MANAGED_STT_ENGINE,
    FLOWMIC_MANAGED_STT_MODEL: cfg.soniox.FLOWMIC_MANAGED_STT_MODEL ?? 'stt-rt-v5',
    FLOWMIC_MANAGED_STT_API_KEY: cfg.soniox.FLOWMIC_MANAGED_STT_API_KEY,
    FLOWMIC_USAGE_EVENTS_ENABLED: '1',
    // The vendor adapter lives in a private package this tree builds but does not link
    // into server-core's node_modules; the live drill points at it the same way.
    FLOWMIC_STT_CLOUD_MODULE: cfg.cloudModule,
    ...mailFileEnv(mailDir),
  });
  // Keep the relay's own output next to the report (redacted): a failed run is diagnosed from it.
  const log = join(runDir, 'relay.log');
  const tee = (d) => appendFileSync(log, redact(d, [cfg.soniox.FLOWMIC_MANAGED_STT_API_KEY]));
  saas.child.stdout.on('data', tee);
  saas.child.stderr.on('data', tee);
  return { ...saas, url: `http://127.0.0.1:${saas.port}`, dbPath, mailDir, saasJwt, verifyRegisteredEmail };
}
async function mintKey(relay, origins) {
  const email = `emb13-${Date.now()}@flowmic.test`;
  const jwt = await relay.saasJwt(relay.url, email);
  await relay.verifyRegisteredEmail(relay.url, jwt, relay.mailDir, email);
  const r = await fetch(`${relay.url}/api/cloud/integrator/keys`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ origins, quota_minutes: KEY_QUOTA_MINUTES, label: 'EMB-13 rig site' }),
  });
  const body = await r.json();
  if (r.status !== 200 || !body.key?.publishable_key) throw new Error(`key creation answered ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return { key: body.key.publishable_key, keyId: body.key.id, email };
}


// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const NOISE = new Set(['sys:ping', 'sys:pong', 'heartbeat', 'stt:level', 'audio:chunk']);
const fmt = (s) => (s && s.n ? `${s.p50} / ${s.max}` : 'n/a');

async function main() {
  const cfg = resolveConfig();
  if (process.env.FLOWMIC_EMB13_DRY === '1') {
    // FLOWMIC_EMB13_DRY=1: resolve and print the configuration, start nothing, spend nothing.
    console.log(`DRY: web client ${cfg.webRoot} (loader ${cfg.heavyFile}); soniox env ${cfg.sonioxPath}; speech ${cfg.wav}; react ${cfg.react ? 'yes' : 'no'}; nothing was started.`);
    return;
  }
  // Loaded only now: the skip path above must not import node:sqlite (its warning) or open anything.
  const { SILENCE_PAD_MS } = await import('./emb13-live-driver.mjs');
  const S = await import('./emb13-live-scenes.mjs');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(REPO, '.local', 'emb13-live', stamp);
  mkdirSync(runDir, { recursive: true });
  const secrets = [cfg.soniox.FLOWMIC_MANAGED_STT_API_KEY];
  const padded = join(runDir, 'speech-padded.wav');
  writeFileSync(padded, padWavWithSilence(readFileSync(cfg.wav), SILENCE_PAD_MS));
  const only = (process.env.FLOWMIC_EMB13_ONLY ?? '').split(',').filter(Boolean);
  const wanted = (letter) => only.length === 0 || only.includes(letter);
  const state = { runDir, roomBuilds: [] };
  let relay; let sdkHost; let site; let foreign; let browser;
  const results = [];
  const stop = async () => {
    await browser?.close().catch(() => {});
    for (const srv of [site, foreign, sdkHost]) srv?.server.close();
    relay?.child.kill();
  };
  try {
    console.log(`web client: ${cfg.webRoot}\nsoniox env: ${cfg.sonioxPath} (key not printed)\nspeech: ${cfg.wav}\nreact: ${cfg.react ? 'yes' : 'NO (react field type is skipped)'}`);
    relay = await startRelay(cfg, runDir);
    setTimeout(() => { console.error('rig watchdog: 30 minutes'); void stop().then(() => process.exit(3)); }, 30 * 60_000).unref();
    sdkHost = await startSdkHost(cfg);
    const ctl = { sdkOrigin: sdkHost.origin, endpoint: relay.url, key: '' }; // key is read per request, set once minted
    site = await startSite(cfg, ctl);
    foreign = await startSite(cfg, ctl);
    // The key is bound to the site's origin only; `foreign` is a second origin the key does not list.
    Object.assign(state, { relay, dbPath: relay.dbPath, sdkHost, site, foreign, minted: await mintKey(relay, [site.origin]) });
    ctl.key = state.minted.key;
    console.log(`relay ${relay.url}; site ${site.origin}; sdk host ${sdkHost.origin}; unlisted origin ${foreign.origin}`);
    const { chromium } = await import(process.env.FLOWMIC_PLAYWRIGHT_MODULE || 'playwright');
    browser = await chromium.launch({
      executablePath: process.env.FLOWMIC_CHROMIUM || undefined,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${padded}`, '--autoplay-policy=no-user-gesture-required'],
    });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
    const plan = [['A', S.sceneLoadCost], ['B', S.sceneFollowFocus], ['C', S.sceneFixedSelector], ['D', S.sceneNoTarget], ['E', S.sceneForeignOrigin]];
    for (const [letter, scene] of plan) {
      if (!wanted(letter)) continue;
      console.log(`scenario ${letter} ...`);
      const r = await scene(ctx, state, cfg);
      results.push(r);
      console.log(`scenario ${letter}: ${r.pass ? 'PASS' : 'FAIL'}`);
    }
    if (wanted('F')) {
      const row = S.reconcileBilling(state, results);
      results.push({ name: 'F billing reconciliation', rows: [row], pass: row.pass, failed: [], wire: [] });
    }
    const byField = S.summarizeByField(results.find((r) => r.name.startsWith('B')));
    // Facts about the local microphone path that no scenario asserts but a reader needs.
    const allWire = results.flatMap((r) => r.wire ?? []);
    const observations = {
      sttInterimFramesOnTheMicSocket: allWire.filter((f) => f.event === 'stt:interim').length,
      audioStreamedMs: Math.round(allWire.filter((f) => f.event === 'audio:chunk' && f.dir === 'out').reduce((n, f) => n + f.detail.ms, 0)),
    };
    // Per-chunk frames are dropped from the saved report (thousands of rows); FLOWMIC_EMB13_KEEP_CHUNKS=1 keeps them.
    const noise = process.env.FLOWMIC_EMB13_KEEP_CHUNKS === '1' ? new Set([...NOISE].filter((e) => e !== 'audio:chunk')) : NOISE;
    const clean = results.map((r) => ({ ...r, wire: (r.wire ?? []).filter((f) => !noise.has(f.event)) }));
    writeFileSync(join(runDir, 'report.json'), redact(JSON.stringify({ stamp, keyQuotaMinutes: KEY_QUOTA_MINUTES, observations, byField, results: clean }, null, 1), secrets));
    console.log('\nRESULTS');
    for (const r of results) {
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.failed?.length ? `  [${r.failed.join(', ')}]` : ''}`);
      for (const x of r.rows ?? []) if (!x.pass) console.log(`        red: ${x.label}: ${(x.failed ?? []).join(', ')}${x.error ? `\n${x.error}` : ''}`);
    }
    console.log('\nPER FIELD TYPE (ms, p50 / max)\n| field | pass | click to listening | speech onset to first interim | stop to text in field | start to text in field | relay stop to final | machine CPU busy % |\n|---|---|---|---|---|---|---|---|');
    for (const b of byField) console.log(`| ${b.label} | ${b.pass}/${b.n} | ${fmt(b.clickToListening)} | ${fmt(b.onsetToInterim)} | ${fmt(b.stopToField)} | ${fmt(b.firstTextFromStart)} | ${fmt(b.wireStopToFinal)} | ${fmt(b.cpuBusyPct)} |`);
    const bill = results.find((r) => r.name.startsWith('F'))?.rows[0]?.data;
    console.log(`\nOBSERVED ${JSON.stringify(observations)}`);
    if (bill) console.log(`BILLING ${JSON.stringify(bill)}`);
    console.log(`\nreport: ${join(runDir, 'report.json')}`);
    process.exitCode = results.every((r) => r.pass) ? 0 : 1;
  } finally {
    await stop();
  }
}
await main().catch((e) => { console.error(String(e?.stack ?? e)); process.exitCode = 1; });
