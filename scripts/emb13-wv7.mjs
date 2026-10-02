import { coldScenes } from './emb13-cold-lib.mjs';
// WV-7: real built website + SDK, local account/key; managed or explicit local fixture recognition.
// FLOWMIC_EMB13_LIVE=1 FLOWMIC_EMB13_WV7=1 FLOWMIC_EMB13_WEB_ROOT=... 
// FLOWMIC_EMB13_WEBSITE_ROOT=... node scripts/emb13-live-rig.mjs
// Narrow runs with FLOWMIC_EMB13_WV7_SURFACES=home,try,sdk and
// FLOWMIC_EMB13_WV7_SCENARIO=budget|toggle|hold|tap-hold|escape|quiet|finishing|placement|keyboard|browsers.
// Admission is an explicit bench boundary: local Turnstile fixture, demo anon
// envelope exchanged for the throwaway publishable key. UI, audio, sockets,
// recognition and insertion are the unmodified builds; production is blocked.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { padWavWithSilence, parseSocketIoEvent, chunkMs, redact } from './emb13-live-rig-lib.mjs';
import { budget, fixtureOnsetMs, leadingSilence, onsetAlignedWav } from './emb13-wv7-lib.mjs';
import { driveSurface, browserProbe } from './emb13-wv7-scenes.mjs';
import { correlation, resolveWv7Config, assertBudget, stratifiedStatistics, relayInterim } from './emb13-wv7-acceptance.mjs';
import { deliveryKind } from './emb13-cold-lib.mjs';
import { coldFirstWord } from './emb13-cold-scene.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
async function websiteServer(cfg, ctl, infra) {
  const root = resolve(process.env.FLOWMIC_EMB13_WEBSITE_ROOT, 'dist');
  const demo = join(cfg.webRoot, 'apps/demo-card/dist');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      if (url.pathname === '/api/web/anon') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ anon_token: 'wv7-local-admission', expires_in: 3600, granted_ms: 120000 }));
      }
      if (url.pathname === '/api/web/rooms') {
        const chunks = []; for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        body.auth = { kind: 'publishable_key' };
        const r = await fetch(`${ctl.endpoint}/api/web/rooms`, { method: 'POST', headers: {
          'content-type': 'application/json', authorization: `Bearer ${ctl.key}`, origin: ctl.websiteOrigin,
        }, body: JSON.stringify(body) });
        res.writeHead(r.status, { 'content-type': 'application/json' }); return res.end(await r.text());
      }
      if (url.pathname.startsWith('/api/')) return res.writeHead(404).end('{}');
      let file;
      if (url.pathname.startsWith('/go/demo-card/')) file = join(demo, url.pathname.endsWith('/v1.js') ? 'demo-card.v1.js' : url.pathname.split('/').at(-1));
      else {
        file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
        if (!file.startsWith(root + sep) && file !== root) return res.writeHead(403).end();
        if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
        if (!existsSync(file)) file = join(root, 'index.html');
      }
      res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(readFileSync(file));
    } catch { res.writeHead(500).end('local rig server failed'); }
  });
  const port = await infra.listen(server);
  return { server, origin: `http://127.0.0.1:${port}` };
}

export async function instrument(ctx, latency) {
  const deliveries = [];
  await ctx.addInitScript({ path: join(HERE, 'emb13-wv7-probe.js') });
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
      const kind = deliveryKind(u.pathname), ms = latency?.[`${kind}Ms`] ?? 0;
      if (!kind || !latency) return route.continue();
      if (route.request().method() === 'HEAD') return route.continue(); // Entry body delay applies once, to GET.
      const row = { kind, path: u.pathname, method: route.request().method(), requested: Date.now(), delayMs: ms };
      deliveries.push(row);
      // Hold completion of the downloaded body. This models delivery latency,
      // not packet-level bandwidth; no runtime bytes are usable during the hold.
      const response = await route.fetch();
      await new Promise((r) => setTimeout(r, ms));
      row.delivered = Date.now();
      return route.fulfill({ response });
    }
    if (u.hostname === 'challenges.cloudflare.com' && u.pathname.endsWith('/api.js')) return route.fulfill({ contentType: 'text/javascript', body:
      `window.turnstile={render(el,o){window.__wv7?.marks.push({name:'challenge-start',at:performance.now()});setTimeout(()=>{window.__wv7?.marks.push({name:'challenge-end',at:performance.now()});o.callback('wv7-local-test-token')},${latency?.challengeMs ?? 25});return 'wv7';},reset(){},remove(){},execute(){}};` });
    return route.abort('blockedbyclient');
  });
  if (latency?.joinMs) await ctx.routeWebSocket('**/socket.io/**', (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (!['mobile:pair', 'mobile:reconnect'].includes(parseSocketIoEvent(message)?.event)) return server.send(message);
      const row = { kind: 'join', requested: Date.now(), delayMs: latency.joinMs }; deliveries.push(row);
      setTimeout(() => { row.delivered = Date.now(); server.send(message); }, latency.joinMs);
    });
  });
  return deliveries;
}
export function wireProbe(page) {
  const wire = [];
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname !== '/api/web/rooms' || !response.ok()) return;
    try {
      const body = await response.json();
      if (body.pcid) wire.push({ at: Date.now(), event: 'rig:room', pcHash: correlation(body.pcid) });
    } catch { /* The missing room join remains null in the report. */ }
  });
  page.on('websocket', (ws) => {
    for (const [event, dir] of [['framesent', 'out'], ['framereceived', 'in']]) ws.on(event, (f) => {
      if (typeof f.payload !== 'string') return;
      const e = parseSocketIoEvent(f.payload); if (!e) return;
      // Store only acceptance facts, never room tokens or auth envelopes.
      const p = e.payload ?? {};
      wire.push({ at: Date.now(), dir, event: e.event,
        ...((p.room_uuid ?? p.room_id ?? p.room) ? { roomHash: correlation(p.room_uuid ?? p.room_id ?? p.room) } : {}),
        ...(e.event === 'audio:chunk' ? { ms: chunkMs(p.data_b64), seq: p.seq, capturedEpoch: p.ts_ms } : {}),
        ...(e.event === 'stt:level' ? { db: p.amplitude_db } : {}),
        ...(['stt:interim', 'stt:final'].includes(e.event) ? { text: p.text } : {}),
        ...(e.event === 'inject:result' ? { ok: p.ok, error: p.error } : {}) });
    });
  });
  return wire;
}

export async function runWv7(cfg, infra) {
  const config = assertBudget(cfg.wv7 ?? resolveWv7Config());
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // OUT is a parent: a rerun cannot overwrite an earlier failed report.
  const runDir = resolve(process.env.FLOWMIC_EMB13_WV7_OUT ?? join(infra.repo, '.local/wv7'), `${stamp}-${process.pid}`);
  mkdirSync(runDir, { recursive: true });
  const { scenario, surfaces, sentences, t4Runs } = config;
  const selectedCheck = process.argv.find((a) => a.startsWith('--wv7-check='))?.split('=')[1];
  const speech = join(runDir, 'speech.wav');
  // 6 seconds speech + 6 seconds silence permits a real >3 s quiet interval.
  // Card WV-T4 round 2: a run that includes the first-word scenario hears the
  // fixture onset-aligned (its lead-in moved to the end, `onsetAlignedWav`), so
  // "within 200 ms of the press" tests the product and not the fixture's own
  // 180 ms of lead-in. The length is unchanged, and so is every other scenario's
  // speech: it only starts 180 ms earlier in the file.
  const firstWordFixture = scenario === 'first-word' || scenario === 'all';
  const source = firstWordFixture ? onsetAlignedWav(readFileSync(cfg.wav)) : readFileSync(cfg.wav);
  writeFileSync(speech, scenario === 'quiet' ? leadingSilence(source, 5000) : padWavWithSilence(source, 6000));
  let relay, sdk, site, website, browser;
  const roomHashes = new Map();
  const report = { stamp, config, scenario, surfaces, results: [], admission: 'local challenge fixture; demo room auth exchanged for throwaway publishable key', productionTurnstile: 'needs a real device run',
    statisticsNote: 'Small-sample observed p95/max; production latency unmeasured. Consecutive cold/warm pairs, not randomized; nominal independent order-statistic intervals do not correct session clustering. Every attempt retained.',
    ...(cfg.fakeStt ? { managedMinutes: 0, billingNote: 'Local simulated usage counter only; the adapter performs no network I/O and no vendor credentials are read.' } : {}),
    missingRelayTimestamps: ['audio arrival', 'vendor leg opened', 'first audio fed', 'first vendor interim'],
    fixture: cfg.wav, fixtureOnsetMs: fixtureOnsetMs(readFileSync(firstWordFixture ? speech : cfg.wav)), language: cfg.fakeStt ? 'English fixture labels over marked Mandarin PCM' : 'zh-CN', permission: 'pre-granted proxy', relay: cfg.fakeStt ? 'local PCM segment fixture; no remote vendor' : 'local; remote managed vendor', managedRecognition: !cfg.fakeStt };
  try {
    relay = await infra.startRelay(cfg, runDir);
    sdk = await infra.startSdkHost(cfg);
    const ctl = { endpoint: relay.url, sdkOrigin: sdk.origin, key: '' };
    site = await infra.startSite(cfg, ctl);
    website = await websiteServer(cfg, ctl, infra); ctl.websiteOrigin = website.origin;
    const minted = await infra.mintKey(relay, [site.origin, website.origin]); ctl.key = minted.key;
    const pw = await import(process.env.FLOWMIC_PLAYWRIGHT_MODULE || 'playwright');
    const state = { cfg, runDir, site, website, scenario, sentences, t4Runs, instrument, wireProbe, report };
    console.log(`WV7 scenario=${scenario}; surfaces=${surfaces.join(',')}; evidence=${runDir}`);
    if (scenario === 'browsers') {
      for (const kind of ['firefox', 'webkit']) report.results.push(await browserProbe(pw[kind], kind, state));
    } else {
      browser = await pw.chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${speech}`, '--autoplay-policy=no-user-gesture-required'] });
      for (const surface of surfaces) report.results.push(coldScenes.includes(scenario)
        ? await coldFirstWord(browser, surface, state, config.cold) : await driveSurface(browser, surface, state));
    }
    const db = new DatabaseSync(relay.dbPath, { readOnly: true });
    try {
      report.billing = db.prepare('SELECT used_ms FROM integrator_keys WHERE id = ?').get(minted.keyId);
      for (const row of db.prepare('SELECT pcid, room_uuid FROM pc_devices').all()) {
        if (row.pcid && row.room_uuid) roomHashes.set(correlation(row.pcid), correlation(row.room_uuid));
      }
    } catch { report.billing = { used_ms: null }; }
    db.close();
    report.audioStreamedMs = report.results.reduce((n, r) => n + (r.audioMs ?? 0), 0);
    report.statistics = Object.fromEntries(report.results.filter((r) => r.samples?.length).map((r) => [r.surface, stratifiedStatistics(r.samples)]));
    report.metricStatistics = Object.fromEntries(report.results.filter((r) => r.samples?.length).map((r) => [r.surface,
      Object.fromEntries(['reaction', 'listening', 'stopToField'].map((metric) => [metric, stratifiedStatistics(r.samples, metric)]))]));
    report.budgets = Object.fromEntries(report.results.filter((r) => r.samples).map((r) => [r.surface, {
      reaction: budget(r.samples.map((x) => x.reaction), 100, 150),
      coldListening: budget(r.samples.filter((x) => x.cold).map((x) => x.listening), 1000, 3000),
      warmListening: budget(r.samples.filter((x) => !x.cold).map((x) => x.listening), 400, 800),
      liveWord: budget(r.samples.map((x) => x.liveWord), 1000, 2000),
      stopToField: budget(r.samples.map((x) => x.stopToField), 600, 1500),
      cls: budget(r.samples.map((x) => x.cls), 0, 0),
    }]));
  } catch (e) { report.error = String(e.stack); }
  finally {
    await browser?.close().catch(() => {});
    for (const s of [site, website, sdk]) s?.server.close();
    relay?.child.kill(); // ChildProcess.kill addresses only the relay PID we started.
    report.end = new Date().toISOString();
    const logPath = join(runDir, 'relay.log');
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    const enrich = (row) => {
      if (row.decomposition) row.decomposition.relay.relayInterimSent = relayInterim(log, row.roomHash ?? roomHashes.get(row.pcHash), row.startEpoch, row.endEpoch);
      for (const child of [row.setup, row.row, ...(row.rows ?? [])].filter(Boolean)) enrich(child);
    };
    for (const result of report.results) {
      for (const row of [...(result.samples ?? []), ...(result.behaviours ?? [])]) enrich(row);
      writeFileSync(join(runDir, `${result.surface}.json`), JSON.stringify(result, null, 2));
    }
    writeFileSync(join(runDir, 'report.json'), redact(JSON.stringify(report, null, 2), [cfg.soniox.FLOWMIC_MANAGED_STT_API_KEY]));
  }
  console.log(JSON.stringify({ error: report.error, budgets: report.budgets, billing: report.billing, results: report.results.map((r) => ({ surface: r.surface, checks: r.checks, error: r.error })), report: join(runDir, 'report.json') }, null, 2));
  const selected = selectedCheck ? report.results.map((r) => r.checks?.[selectedCheck] ?? report.budgets?.[r.surface]?.[selectedCheck]?.verdict ?? 'not measured') : null;
  process.exitCode = report.error || report.results.some((r) => r.error) || (selected
    ? selected.some((v) => v !== 'PASS')
    : report.results.some((r) => Object.values(r.checks ?? {}).some((v) => v === 'FAIL')) || Object.values(report.budgets ?? {}).some((b) => Object.values(b).some((v) => v.verdict === 'FAIL'))) ? 1 : 0;
}
