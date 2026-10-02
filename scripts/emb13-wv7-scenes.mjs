import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { placement } from './emb13-wv7-lib.mjs';
import { correlation, decomposition, requestPolicy, judgeDecomposition, firstReaction, judgeFirstClick, recordBrowserFlow } from './emb13-wv7-acceptance.mjs';
import { extendedScenarios } from './emb13-wv7-new-scenes.mjs';
import { keyboard, capsulePlacement } from './emb13-wv7-extra.mjs';

const mic = (n) => `[data-flowmic-mic="${n}"]`;
const controls = { home: '.hti-press', try: '.db-mic', sdk: mic('icon') };
const fields = { home: '.hti-box', try: '.db-box', sdk: '#f-input' };
const read = (page) => page.evaluate(() => window.__wv7.read());
const delay = (page, ms) => page.waitForTimeout(ms);
const verdict = (ok) => ok ? 'PASS' : 'FAIL';
async function shot(page, state, surface, name) {
  const path = join(state.runDir, `${surface}-${name}.png`);
  await page.screenshot({ path }); return path;
}
async function waitVoice(page, name, timeout = 25000) {
  await page.waitForFunction((s) => window.__wv7.read().voice === s, name, { timeout });
}
export async function openPage(browser, surface, state, extra = {}) {
  state.roomBuilds ??= [];
  while (state.roomBuilds.filter((t) => Date.now() - t < 61000).length >= 4) await new Promise((r) => setTimeout(r, 1000));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US',
    ...(browser.browserType().name() === 'chromium' ? { permissions: ['microphone'] } : {}), ...extra });
  try {
  await state.instrument(ctx);
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN'] }));
  const page = await ctx.newPage(); page.setDefaultTimeout(12000);
  // Delay actual relay finals at the browser transport boundary; no fabricated words.
  if (state.scenario === 'finishing' || state.scenario === 'screenshots') await page.routeWebSocket('**/socket.io/**', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      if (typeof message === 'string' && message.includes('"stt:final"')) setTimeout(() => ws.send(message), 4400);
      else ws.send(message);
    });
  });
  const wire = state.wireProbe(page), requests = [], errors = [], requestRows = new Map();
  page.on('request', (r) => {
    const row = { at: Date.now(), host: new URL(r.url()).hostname, path: new URL(r.url()).pathname };
    requests.push(row); requestRows.set(r, row);
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/web/rooms') state.roomBuilds.push(Date.now());
  });
  page.on('response', (r) => {
    const row = requestRows.get(r.request());
    if (row && row.path === '/api/web/anon' && r.ok()) row.mintedIdentity = true;
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(surface === 'sdk' ? state.site.origin : state.website.origin + (surface === 'try' ? '/try' : '/'));
  const decline = page.getByRole('button', { name: 'Decline', exact: true });
  if (await decline.isVisible()) await decline.click();
  await page.locator(controls[surface]).first().waitFor({ state: 'visible' });
  await page.locator(controls[surface]).first().scrollIntoViewIfNeeded();
  await delay(page, 900);
  const beforeIntent = requests.filter((r) => r.path.startsWith('/api/web/') || r.host === 'challenges.cloudflare.com');
  if (surface === 'sdk') await page.locator(fields.sdk).focus();
  return { ctx, page, wire, requests, errors, beforeIntent };
  } catch (error) { await ctx.close(); throw error; }
}
export async function align(page, quiet = false) {
  await page.evaluate((quiet) => new Promise((resolve) => {
    const gum = [...window.__wv7.marks].reverse().find((m) => m.name === 'gum');
    if (!gum) return resolve();
    const phase = quiet ? 6500 : 10500;
    const target = gum.at + Math.ceil((performance.now() + 100 - gum.at - phase) / 12000) * 12000 + phase;
    const tick = () => performance.now() >= target ? resolve() : setTimeout(tick, 4); tick();
  }), quiet);
}
async function rawCycle(s, surface, state, { cold = false, gesture = 'toggle', capture = false, name = gesture } = {}) {
  const { page, wire } = s;
  if (!cold) await align(page, gesture === 'quiet');
  const initial = await read(page), w0 = wire.length;
  const m0 = await page.evaluate(() => window.__wv7.marks.length);
  const startControl = controls[surface];
  const button = page.locator(startControl).first();
  if (gesture === 'hold') {
    const b = await button.boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
  } else await button.click();
  if (gesture === 'hold') {
    const began = await waitVoice(page, 'listening', 1200).then(() => true, () => false);
    if (!began) {
      const held = await read(page), heldShot = await shot(page, state, surface, 'hold-before-release');
      await page.mouse.up();
      await delay(page, 1000);
      const released = await read(page);
      if (released.voice === 'listening') {
        await page.locator(mic('capsule-stop')).focus(); await page.keyboard.press('Escape'); await delay(page, 1600);
      }
      return { gesture, cold, holdBeganBeforeRelease: false, initial: initial.value, final: (await read(page)).value,
        evidence: { held, heldShot, released }, finalState: await read(page), wire: wire.slice(w0) };
    }
  } else await waitVoice(page, 'listening');
  const listening = await read(page);
  let evidence = {};
  if (capture) evidence.listening = await shot(page, state, surface, `${name}-listening`);
  if (gesture === 'quiet') {
    await delay(page, 3300);
    evidence.quiet = await read(page);
    evidence.quietShot = await shot(page, state, surface, `${name}-quiet`);
    await delay(page, 3200);
    evidence.returned = await read(page);
  } else await delay(page, cold ? 7000 : 7300);
  if (capture) evidence.liveWord = await shot(page, state, surface, `${name}-live-word`);
  if (gesture === 'escape' || gesture === 'escape-field') {
    await page.locator(gesture === 'escape-field' ? fields[surface] : mic('capsule-stop')).focus();
    await page.keyboard.press('Escape');
  } else if (gesture === 'hold') await page.mouse.up();
  else await page.locator(controls[surface]).first().click();
  const stop = await page.evaluate(() => performance.now());
  if (gesture === 'finishing') {
    await delay(page, 3300);
    evidence.stillFinishing = await read(page);
    evidence.stillFinishingShot = await shot(page, state, surface, `${name}-still-finishing`);
  }
  if (gesture === 'escape' || gesture === 'escape-field') {
    await delay(page, 100);
    evidence.cancelled = await read(page);
    evidence.cancelledShot = await shot(page, state, surface, `${name}-cancelled`);
    await delay(page, 5000);
  } else {
    if (capture) evidence.finishing = await shot(page, state, surface, `${name}-finishing`);
    await page.waitForFunction((value) => window.__wv7.read().value !== value, initial.value, { timeout: 15000 }).catch(() => {});
    if (capture) evidence.added = await shot(page, state, surface, `${name}-added`);
  }
  const final = await read(page);
  if (gesture === 'escape-field' && final.voice === 'listening') {
    await page.locator(mic('capsule-stop')).focus(); await page.keyboard.press('Escape');
  }
  const observed = await page.evaluate((m0) => ({ marks: window.__wv7.marks.slice(m0), shifts: window.__wv7.shifts, supported: window.__wv7.clsSupported, origin: performance.timeOrigin }), m0);
  const press = observed.marks.find((m) => m.name === 'pointerdown')?.at;
  const rendered = observed.marks.filter((m) => m.name === 'render');
  const reaction = firstReaction(observed.marks, initial, press);
  const listeningMark = rendered.find((m) => m.voice === 'listening');
  const interim = rendered.find((m) => m.interim && m.at >= press);
  const input = observed.marks.find((m) => m.name === 'input' && m.value !== initial.value);
  const part = wire.slice(w0);
  const onset = part.find((m) => m.event === 'stt:level' && m.db > -40);
  const directOnset = observed.marks.find((m) => m.name === 'audio-onset' && m.at >= press);
  const stopMark = [...observed.marks].reverse().find((m) => m.name === (gesture === 'hold' ? 'pointerup' : 'pointerdown'))?.at ?? stop;
  const sample = { cold, gesture, reaction, startPresses: observed.marks.filter((m) => m.name === 'pointerdown' && m.at < (listeningMark?.at ?? Infinity)).length,
    listening: listeningMark && press !== undefined ? listeningMark.at - press : null,
    liveWord: interim && directOnset ? interim.at - directOnset.at : null,
    relayLevelToLiveWord: interim && onset ? observed.origin + interim.at - onset.at : null,
    stopToField: input ? input.at - stopMark : null,
    cls: observed.supported ? observed.shifts.filter((x) => x.at >= press && !x.recent).reduce((n, x) => n + x.value, 0) : null,
    initial: initial.value, final: final.value, stop, press, placement: placement(listening), evidence,
    timeOrigin: observed.origin, marks: observed.marks, wire: part, shifts: observed.shifts.filter((x) => x.at >= press), finalState: final };
  await delay(page, 1600);
  return sample;
}

export async function cycle(s, surface, state, options = {}) {
  const startEpoch = Date.now(), m0 = await s.page.evaluate(() => window.__wv7.marks.length), w0 = s.wire.length;
  let row;
  try { row = await rawCycle(s, surface, state, options); }
  catch (e) {
    row = { cold: !!options.cold, gesture: options.gesture ?? 'toggle', failed: true, timeout: /timeout/i.test(String(e)), error: String(e.message), liveWord: null,
      ...(await s.page.evaluate((m0) => ({ marks: window.__wv7.marks.slice(m0), timeOrigin: performance.timeOrigin }), m0).catch(() => ({}))), wire: s.wire.slice(w0) };
    // Leave the failed row intact; cancel only to make the next attempt possible.
    await s.page.mouse.up().catch(() => {});
    await s.page.locator(mic('capsule-stop')).focus({ timeout: 500 }).then(() => s.page.keyboard.press('Escape')).catch(() => {});
  }
  row.key = correlation(`${state.report.stamp}/${surface}/${startEpoch}/${state.sequence = (state.sequence ?? 0) + 1}`);
  row.firstUse = !!options.cold;
  row.startEpoch = startEpoch; row.endEpoch = Date.now();
  if (!row.marks) Object.assign(row, await s.page.evaluate((m0) => ({ marks: window.__wv7.marks.slice(m0), timeOrigin: performance.timeOrigin }), m0).catch(() => ({ marks: [] })));
  row.wire ??= [];
  row.failed ||= !row.final || row.final === row.initial;
  row.timeout ||= row.liveWord === null || (!['escape', 'escape-field'].includes(row.gesture) && row.final === row.initial);
  const captureReused = !options.cold && !row.marks.some((m) => m.name === 'capture-begin' || m.name === 'gum-call')
    && await s.page.evaluate((m0) => window.__wv7.marks.slice(0, m0).some((m) => m.name === 'capture-begin'), m0);
  row.decomposition = decomposition({ captureReused, key: row.key, timeOrigin: row.timeOrigin, marks: row.marks.filter((m) => m.at >= (row.press ?? 0)), wire: row.wire });
  row.roomHash = row.wire.find((f) => f.roomHash)?.roomHash ?? s.wire.find((f) => f.roomHash)?.roomHash ?? null;
  row.pcHash = s.wire.find((f) => f.pcHash)?.pcHash ?? null;
  return row;
}

export async function driveSurface(browser, surface, state) {
  const result = { surface, checks: {}, samples: [], behaviours: [], screenshots: [], audioMs: 0 };
  let s;
  try {
    const scenario = state.scenario;
    if (scenario === 'quiet') {
      for (const width of [1280, 360]) for (const theme of ['light', 'dark']) {
        s = await openPage(browser, surface, state, { viewport: { width, height: 900 }, colorScheme: theme });
        await s.page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        const row = await cycle(s, surface, state, { cold: true, gesture: 'quiet', capture: true, name: `${width}-${theme}-quiet` });
        result.behaviours.push(row);
        result.checks[`${width}-${theme}`] = verdict(row.evidence?.quiet?.voice === 'listening' && /CantHear|hear/i.test(row.evidence?.quiet.word) && row.evidence?.returned?.word === 'Listening…' && row.wire.filter((f) => f.event === 'audio:start').length === 1 && !row.failed && row.final.length > row.initial.length);
        result.audioMs += s.wire.filter((f) => f.event === 'audio:chunk').reduce((n, f) => n + f.ms, 0);
        await s.ctx.close(); s = null;
      }
      return result;
    }
    if (scenario === 'screenshots') {
      for (const width of [1280, 360]) for (const theme of ['light', 'dark']) {
        s = await openPage(browser, surface, state, { viewport: { width, height: 900 }, colorScheme: theme });
        await s.page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        const name = `${width}-${theme}`;
        result.screenshots.push(await shot(s.page, state, surface, `${name}-idle`));
        for (const [i, gesture] of ['finishing', 'quiet', 'escape'].entries()) {
          const row = await cycle(s, surface, state, { cold: i === 0, gesture, capture: true, name: `${name}-${gesture}` });
          result.behaviours.push(row);
        }
        result.audioMs += s.wire.filter((f) => f.event === 'audio:chunk').reduce((n, f) => n + f.ms, 0);
        await s.ctx.close(); s = null;
      }
      return result;
    }
    if (scenario === 'all' || scenario === 'budget') {
      result.beforeIntent = [];
      for (let i = 0; i < state.sentences; i++) {
        const cold = i % 2 === 0 || !s;
        if (cold || !s) {
          if (s) { result.audioMs += s.wire.filter((f) => f.event === 'audio:chunk').reduce((n, f) => n + f.ms, 0); await s.ctx.close(); }
          s = null;
          try { s = await openPage(browser, surface, state); }
          catch (e) {
            result.samples.push({ key: correlation(`${state.report.stamp}/${surface}/open-${i}`), cold, firstUse: cold, failed: true, timeout: /timeout/i.test(String(e)), error: String(e.message), liveWord: null });
            continue;
          }
          result.beforeIntent.push(s.beforeIntent);
        }
        result.samples.push(await cycle(s, surface, state, { cold }));
        console.log(`WV7 budget ${surface} ${i + 1}/${state.sentences}`);
      }
      result.checks.requestPolicy = verdict(result.beforeIntent.length > 0 && result.beforeIntent.every((rs) => requestPolicy(surface, rs).verdict === 'PASS'));
      result.checks.decomposition = verdict(result.samples.every((s) => s.decomposition && judgeDecomposition(s.decomposition) === 'PASS'));
      result.checks.firstClick = verdict(result.samples.every((r) => judgeFirstClick({ ...r, listening: Number.isFinite(r.listening) }) === 'PASS'));
      result.checks.textLanded = verdict(result.samples.every((s) => !s.failed && s.final.length > s.initial.length));
      result.checks.layoutShift = verdict(result.samples.every((s) => s.cls === 0));
      result.checks.placement = verdict(result.samples.every((s) => s.placement?.verdict === 'PASS'));
    }
    if (scenario === 'all' || ['escape-scoped', 'cold-hold', 'request-policy', 'first-word', 'reused-silence', 'gestures', 'tap-hold', 'phone-link'].includes(scenario)) {
      if (s) { result.audioMs += s.wire.filter((f) => f.event === 'audio:chunk').reduce((n, f) => n + f.ms, 0); await s.ctx.close(); s = null; }
      await extendedScenarios(browser, surface, state, result, { openPage, cycle, align });
      return result;
    }
    if (scenario === 'budget') return result;
    if (!s) {
      s = await openPage(browser, surface, state);
      result.behaviours.push(await cycle(s, surface, state, { cold: true, capture: true, name: 'setup' }));
    }
    for (const gesture of ['toggle', 'hold', 'escape', 'escape-field', 'quiet', 'finishing']) {
      if (scenario !== 'all' && scenario !== 'behaviour' && scenario !== gesture) continue;
      if (gesture === 'finishing' && scenario !== 'finishing') continue;
      const row = await cycle(s, surface, state, { gesture, capture: true });
      result.behaviours.push(row);
      result.checks[gesture] = verdict(gesture === 'escape' || gesture === 'escape-field'
        ? row.final === row.initial && row.evidence?.cancelled?.voice === 'cancelled'
        : !row.failed && row.final.length > row.initial.length && (!row.finalState.error && row.finalState.voice !== 'heardNothing'));
      if (gesture === 'quiet') result.checks.quiet = verdict(row.evidence?.quiet?.voice === 'listening' && row.evidence?.quiet.word !== row.evidence?.returned?.word && row.evidence?.returned?.voice === 'listening' && row.wire.filter((f) => f.event === 'audio:start').length === 1);
      if (gesture === 'finishing') result.checks.finishing = verdict(row.evidence?.stillFinishing?.voice === 'finishing' && row.evidence?.stillFinishing.value === row.initial && /still|DEV.*voiceStillFinishing/i.test(row.evidence?.stillFinishing.word) && row.stopToField > 3000 && !row.failed && row.final.length > row.initial.length);
      if (gesture === 'escape') result.checks.cancelledCopy = verdict(!row.evidence?.cancelled?.word.startsWith('DEV:') && /cancel/i.test(row.evidence?.cancelled?.word ?? ''));
    }
    if (scenario === 'inspect') {
      result.inspect = await read(s.page);
      result.screenshots.push(await shot(s.page, state, surface, 'inspect'));
    }
    if (scenario === 'keyboard') {
      result.keyboard = await keyboard(s, surface, state);
      Object.assign(result.checks, result.keyboard.checks);
    }
    if (scenario === 'placement') {
      result.placement = await capsulePlacement(s, surface, state);
      Object.assign(result.checks, result.placement.checks);
    }
    result.pageErrors = s.errors;
  } catch (e) {
    result.error = String(e.stack);
    if (s) { result.atError = await read(s.page).catch(() => null); result.screenshots.push(await shot(s.page, state, surface, 'error').catch(() => null)); }
  } finally {
    if (s) { result.audioMs += s.wire.filter((f) => f.event === 'audio:chunk').reduce((n, f) => n + f.ms, 0); result.wire = s.wire; await s.ctx.close(); }
    writeFileSync(join(state.runDir, `${surface}.json`), JSON.stringify(result, null, 2));
  }
  return result;
}

export async function browserProbe(engine, kind, state) {
  const result = { surface: kind, checks: {}, audioMs: 0, flows: [] };
  let browser;
  const label = kind === 'webkit' ? 'WebKit' : 'Firefox';
  try { browser = await engine.launch(kind === 'firefox' ? { firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true } } : {}); }
  catch (error) { result.flows.push({ surface: kind, error: String(error.message) }); recordBrowserFlow(result, kind, label); return result; }
  try {
    const ctx = await browser.newContext(); await state.instrument(ctx);
    const page = await ctx.newPage(); await page.goto(state.site.origin);
    result.beforePermission = await page.evaluate(async () => {
      if (!navigator.mediaDevices) return { audioinput: null, labelsEmpty: null, unavailable: 'navigator.mediaDevices is undefined', secureContext: isSecureContext };
      const ds = await navigator.mediaDevices.enumerateDevices();
      return { audioinput: ds.filter((d) => d.kind === 'audioinput').length, labelsEmpty: ds.filter((d) => d.kind === 'audioinput').every((d) => d.label === ''), devices: ds.map((d) => ({ kind: d.kind, label: d.label })) };
    });
    await ctx.close();
    for (const surface of ['home', 'try', 'sdk']) {
      let s;
      try {
        s = await openPage(browser, surface, state);
        if (result.beforePermission.unavailable) {
          await s.page.locator(controls[surface]).first().click();
          await delay(s.page, 2500);
          result.flows.push({ surface, measured: false, visible: await read(s.page), screenshot: await shot(s.page, state, surface, kind) });
        } else {
          const row = await cycle(s, surface, state, { cold: true, capture: true, name: kind });
          result.flows.push({ surface, row, measured: !row.failed, failed: row.failed });
        }
      } catch (e) { result.flows.push({ surface, error: String(e.message), visible: s ? await read(s.page).catch(() => null) : null }); }
      finally {
        recordBrowserFlow(result, surface, label, s?.wire ?? []);
        if (s) { result.audioMs += s.wire.filter((f) => f.event === 'audio:chunk').reduce((n, f) => n + f.ms, 0); await s.ctx.close(); }
      }
    }
  } finally { await browser.close(); }
  return result;
}
