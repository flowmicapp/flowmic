// New WV-7d browser scenarios. Only the live entry point calls this module.
import { correlation, decomposition, requestPolicy, judgeEsc, judgeHold, judgeReusedSilence, judgeGesture, judgePhoneLink, judgeFirstWord, normalizeSpeech as normalize } from './emb13-wv7-acceptance.mjs';
import { parseSocketIoEvent } from './emb13-live-rig-lib.mjs';
import { keyboard } from './emb13-wv7-extra.mjs';

const controls = { home: '.hti-press', try: '.db-mic', sdk: '[data-flowmic-mic="icon"]' };
const fields = { home: '.hti-box', try: '.db-box', sdk: '#f-input' };
const read = (page) => page.evaluate(() => window.__wv7.read());
const wait = (page, phase) => page.waitForFunction((p) => window.__wv7.read().voice === p, phase, { timeout: 12000 });

// Transport hold is shared with the local protocol drill. No invented live text.
export function finalEscrow(send, now = Date.now) {
  const pending = [], delivered = [];
  return { pending, delivered,
    receive(message) {
      if (typeof message === 'string' && message.includes('"stt:final"')) pending.push(message);
      else send(message);
    },
    release() { pending.splice(0).forEach((message) => { send(message); delivered.push(now()); }); },
  };
}
export async function escrowFinals(page) {
  const holds = [];
  await page.routeWebSocket('**/socket.io/**', (ws) => {
    const server = ws.connectToServer(), hold = finalEscrow((message) => ws.send(message));
    holds.push(hold); server.onMessage((message) => hold.receive(message));
  });
  return { get pending() { return holds.flatMap((h) => h.pending); }, get delivered() { return holds.flatMap((h) => h.delivered); },
    release() { holds.forEach((h) => h.release()); } };
}

async function escapeScene(s, surface, phase, dialog) {
  const { page, wire } = s;
  let releaseRoom;
  if (phase === 'connecting') {
    const blocked = new Promise((resolve) => { releaseRoom = resolve; });
    await page.route('**/api/web/rooms', async (route) => { await blocked; await route.continue().catch(() => {}); });
  }
  const finals = await escrowFinals(page);
  await page.evaluate(({ field, dialog }) => {
    const f = document.querySelector(field);
    const host = document.createElement(dialog ? 'dialog' : 'div');
    f.parentNode.insertBefore(host, f); host.append(f);
    if (dialog) host.show();
    window.__esc = { host, keys: [], inputEvents: 0 };
    // An ordinary host ancestor bubble closer. No claimed precedence over
    // earlier window/document capture handlers on arbitrary third-party sites.
    host.addEventListener('keydown', (e) => {
      window.__esc.keys.push({ key: e.key, reachedHost: true, prevented: e.defaultPrevented });
      if (dialog && e.key === 'Escape' && !e.defaultPrevented) host.close();
    });
    f.addEventListener('input', () => window.__esc.inputEvents++);
  }, { field: fields[surface], dialog });
  const button = page.locator(controls[surface]).first();
  try {
    if (phase !== 'inactive') {
      await button.click();
      await wait(page, phase === 'connecting' ? 'connecting' : 'listening');
      if (phase !== 'connecting') await page.waitForTimeout(6500);
      if (phase === 'finishing') {
        await button.click(); await wait(page, 'finishing');
        // Hold the actual final BEFORE Esc. Cancelling first can prevent the
        // relay from ever producing it. Fail if escrow never receives a final.
        const deadline = Date.now() + 12000;
        const hasTextFinal = () => finals.pending.some((m) => parseSocketIoEvent(m)?.payload?.text?.trim());
        while (!hasTextFinal() && Date.now() < deadline) await page.waitForTimeout(50);
        if (!hasTextFinal()) throw new Error('No nonempty final held before finishing cancellation');
        await wait(page, 'finishing');
      }
    }
    await page.locator(fields[surface]).click();
    const focused = await page.locator(fields[surface]).evaluate((f) => document.activeElement === f);
    if (!focused) throw new Error('Esc precondition failed: target field is not active');
    const edges = wire.filter((f) => ['audio:start', 'audio:stop'].includes(f.event)).length;
    await page.keyboard.press('Space'); await page.keyboard.press('Enter');
    const keyAudioEdges = wire.filter((f) => ['audio:start', 'audio:stop'].includes(f.event)).length - edges;
    const before = await read(page);
    await page.evaluate(() => { window.__esc.inputEvents = 0; });
    const escAt = Date.now();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const cancelled = (await read(page)).voice === 'cancelled';
    releaseRoom?.();
    // The held final is now delivered after the real Escape dispatch.
    finals.release();
    await page.waitForTimeout(5500);
    finals.release();
    await page.waitForTimeout(250);
    const after = await read(page);
    const host = await page.evaluate(() => ({ keys: window.__esc.keys, prevented: window.__wv7.marks.filter((m) => m.name === 'escape-dispatched').at(-1)?.prevented,
      inputEvents: window.__esc.inputEvents, dialogOpen: window.__esc.host.open }));
    const row = { phase, observedPhase: before.voice === 'listening' ? 'recording' : phase === 'inactive' && !['listening', 'connecting', 'finishing'].includes(before.voice) ? 'inactive' : before.voice,
      dialog, focused, ...host, keyAudioEdges, reachedHost: host.keys.some((e) => e.key === 'Escape'), cancelled,
      initial: before.value, final: after.value, observationMs: Date.now() - escAt,
      lateRestart: wire.some((f) => f.event === 'audio:start' && f.at > escAt), delayedFinalDelivered: finals.delivered.some((at) => at > escAt) && await page.evaluate((escAt) => window.__wv7.marks.some((m) => m.name === 'wire-final' && performance.timeOrigin + m.at > escAt), escAt) };
    return { ...row, verdict: judgeEsc(row) };
  } finally { releaseRoom?.(); finals.release(); }
}

async function holdScene(s, surface) {
  const { page, wire } = s;
  const initial = (await read(page)).value;
  const b = await page.locator(controls[surface]).first().boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  const down = Date.now(); await page.mouse.down();
  let beforeRelease;
  try { await page.waitForTimeout(7500); beforeRelease = (await read(page)).voice; }
  finally { await page.mouse.up(); }
  const heldMs = Date.now() - down;
  await page.waitForFunction((v) => window.__wv7.read().value !== v, initial, { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const after = await read(page);
  const row = { initial, final: after.value, heldMs, beforeRelease,
    starts: wire.filter((f) => f.event === 'audio:start').length, stops: wire.filter((f) => f.event === 'audio:stop').length,
    lateRestart: after.voice === 'listening' || wire.some((f) => f.event === 'audio:start' && f.at > down + heldMs) };
  return { ...row, verdict: judgeHold(row) };
}

async function firstWordScene(s, surface, reference) {
  const { page, wire } = s;
  let roomAnswered = null;
  await page.route('**/api/web/rooms', async (route) => { await page.waitForTimeout(1500); await route.continue(); });
  page.on('response', (r) => { if (new URL(r.url()).pathname === '/api/web/rooms') roomAnswered ??= Date.now(); });
  const initial = (await read(page)).value;
  const m0 = await page.evaluate(() => window.__wv7.marks.length);
  await page.locator(controls[surface]).first().click();
  await page.waitForTimeout(7500);
  const stopping = await page.evaluate(() => performance.now());
  await page.locator(controls[surface]).first().click();
  await page.waitForFunction((v) => window.__wv7.read().value !== v, initial, { timeout: 15000 }).catch(() => {});
  const { marks, origin } = await page.evaluate((m0) => ({ marks: window.__wv7.marks.slice(m0), origin: performance.timeOrigin }), m0);
  const press = marks.find((m) => m.name === 'pointerdown');
  const onset = marks.find((m) => m.name === 'audio-onset' && m.at >= press?.at);
  const first = wire.find((f) => f.event === 'audio:chunk');
  const start = wire.find((f) => f.event === 'audio:start');
  const heard = normalize((await read(page)).value.slice(initial.length));
  const receipts = wire.filter((f) => f.event === 'inject:result');
  const row = { pressToOnsetMs: onset && press ? onset.at - press.at : null,
    presses: marks.filter((m) => m.name === 'pointerdown' && m.at < stopping).length,
    roomAfterOnset: !!onset && roomAnswered > origin + onset.at,
    noAudioBeforeRoom: !!roomAnswered && !wire.some((f) => f.dir === 'out' && f.event.startsWith('audio:') && f.at < roomAnswered),
    firstSeq: first?.seq, buffered: Number.isFinite(first?.capturedEpoch) && !!start && first.capturedEpoch < start.at,
    reference: normalize(reference), prefix: 2, heard, inserted: !!heard, receiptsOk: receipts.length > 0 && receipts.every((f) => f.ok), roomAnswered };
  return { ...row, verdict: judgeFirstWord(row) };
}

export async function extendedScenarios(browser, surface, state, result, { openPage, cycle, align }) {
  const wanted = (name) => state.scenario === 'all' || state.scenario === name;
  const run = async (name, fn) => {
    let s;
    const startEpoch = Date.now();
    try {
      s = await openPage(browser, surface, state);
      const row = await fn(s);
      result.behaviours.push({ name, ...row }); result.checks[name] = row.verdict;
      for (const child of row.rows ?? []) result.checks[`${name}/${child.gesture}`] = child.verdict;
    } catch (e) {
      result.behaviours.push({ name, failed: true, timeout: /timeout/i.test(String(e)), error: String(e.message), verdict: 'FAIL' });
      result.checks[name] = 'FAIL';
    } finally {
      if (s) {
        const row = result.behaviours.at(-1);
        row.key = correlation(`${state.report.stamp}/${surface}/${name}/${startEpoch}`);
        row.startEpoch = startEpoch; row.endEpoch = Date.now(); row.wire = s.wire;
        row.roomHash = s.wire.find((f) => f.roomHash)?.roomHash;
        row.pcHash = s.wire.find((f) => f.pcHash)?.pcHash;
        const observations = await s.page.evaluate(() => ({ marks: window.__wv7.marks, timeOrigin: performance.timeOrigin })).catch(() => ({}));
        row.decomposition = decomposition({ key: row.key, ...observations, wire: s.wire });
        result.audioMs += s.wire.filter((f) => f.event === 'audio:chunk').reduce((n, f) => n + f.ms, 0);
        await s.ctx.close();
      }
    }
  };
  if (wanted('request-policy')) await run('request-policy', async (s) => requestPolicy(surface, s.beforeIntent));
  if (wanted('cold-hold')) await run('cold-hold', (s) => holdScene(s, surface));
  if (wanted('escape-scoped')) for (const [phase, dialog] of [['inactive', false], ['recording', false], ['connecting', false], ['finishing', false], ['inactive', true], ['recording', true]]) {
    await run(`escape-${phase}${dialog ? '-dialog' : ''}`, (s) => escapeScene(s, surface, phase, dialog));
  }
  if (wanted('escape-scoped')) for (const dialog of [false, true]) {
    await run(`escape-inactive-used${dialog ? '-dialog' : ''}`, async (s) => {
      const setup = await cycle(s, surface, state, { cold: true });
      // The listener has now been installed and a sentence has settled. A
      // cold idle check alone cannot catch a listener that stays armed forever.
      const row = await escapeScene(s, surface, 'inactive', dialog);
      return { ...row, setup, verdict: setup.failed ? 'FAIL' : row.verdict };
    });
  }
  if (wanted('reused-silence')) await run('reused-silence', async (s) => {
    const setup = await cycle(s, surface, state, { cold: true });
    const rows = [];
    for (const gesture of ['toggle', 'hold', 'escape', 'quiet']) {
      const row = await cycle(s, surface, state, { gesture });
      // Cancellation intentionally inserts nothing; it is not a speech failure.
      if (gesture === 'escape' && !row.error) row.failed = false;
      row.verdict = judgeGesture(row); rows.push(row);
    }
    return { setup, rows, verdict: setup.failed ? 'FAIL' : judgeReusedSilence(rows) };
  });
  if (wanted('gestures') || state.scenario === 'tap-hold') {
    await run('quick-double-tap', async (s) => {
      const setup = await cycle(s, surface, state, { cold: true });
      await align(s.page, true); // Known silent segment of the same capture.
      const { page, wire } = s, button = page.locator(controls[surface]).first();
      const initial = (await read(page)).value, m0 = await page.evaluate(() => window.__wv7.marks.length), w0 = wire.length;
      const down = Date.now();
      await button.click(); await page.waitForTimeout(80); await button.click();
      const elapsedMs = Date.now() - down;
      const observations = [];
      const observationStart = Date.now();
      while (Date.now() - observationStart < 5200) { observations.push(await read(page)); await page.waitForTimeout(40); }
      const marks = await page.evaluate((m0) => window.__wv7.marks.slice(m0), m0);
      const quiet = (v) => !v.error && !['heardNothing', 'blocked', 'error'].includes(v.voice);
      const row = { gesture: 'quick-double-tap', initial, final: (await read(page)).value, elapsedMs,
        inputEvents: marks.filter((m) => m.name === 'input').length,
        speechDetected: marks.some((m) => m.name === 'audio-onset' && m.at <= (marks.filter((m) => m.name === 'pointerup').at(-1)?.at ?? Infinity)),
        quietThroughout: observations.every(quiet) && marks.filter((m) => m.name === 'render').every(quiet),
        lateRestart: wire.slice(w0).filter((f) => f.event === 'audio:start').length > 1 || ['listening', 'connecting', 'finishing'].includes(observations.at(-1)?.voice),
        observationMs: Date.now() - observationStart, setup };
      return { ...row, verdict: setup.failed ? 'FAIL' : judgeGesture(row) };
    });
    for (const gesture of ['toggle', 'hold']) await run(gesture === 'toggle' ? 'tap-speak-tap' : 'hold-speak-release', async (s) => {
      const row = await cycle(s, surface, state, { cold: true, gesture });
      return { ...row, verdict: judgeGesture(row) };
    });
    await run('error-cleared', async (s) => {
      const { page } = s, button = page.locator(controls[surface]).first();
      const setup = await cycle(s, surface, state, { cold: true });
      await align(page, true);
      await button.click(); await wait(page, 'listening');
      await page.waitForTimeout(1300); // A genuine >=1 s empty sentence must show its notice.
      await button.click(); await wait(page, 'heardNothing');
      const before = await read(page);
      const box = await button.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      let after;
      try { await page.waitForTimeout(100); after = await read(page); } finally { await page.mouse.up(); }
      const row = { gesture: 'error-cleared', errorBefore: !!before.error || ['blocked', 'heardNothing', 'error'].includes(before.voice),
        errorAfterPress: !!after.error || ['blocked', 'heardNothing', 'error'].includes(after.voice),
        pressFeedback: ['starting', 'permission', 'verifying', 'connecting', 'listening'].includes(after.voice) || after.pressed === 'true' || after.busy === 'true' };
      await page.locator(fields[surface]).click(); await page.keyboard.press('Escape');
      return { ...row, setup, errorSource: 'empty sentence during fixture silence', verdict: setup.failed ? 'FAIL' : judgeGesture(row) };
    });
  }
  if (state.scenario === 'phone-link' && surface === 'sdk') await run('phone-link', async (s) => {
    const setup = await cycle(s, surface, state, { cold: true });
    const more = s.page.locator('[data-flowmic-mic="more"]');
    await more.waitFor({ state: 'visible' }); await more.click();
    const panelVisible = await s.page.locator('[data-flowmic-mic="root"]').isVisible();
    const linkVisible = await s.page.locator('[data-flowmic-mic="switch-phone"]').isVisible();
    return { optional: true, setup, panelVisible, linkVisible, verdict: setup.failed ? 'FAIL' : judgePhoneLink({ panelVisible, linkVisible }) };
  });
  if (wanted('first-word')) {
    let reference = '';
    await run('first-word-reference', async (s) => {
      const setup = await cycle(s, surface, state, { cold: true });
      const row = await cycle(s, surface, state); // Joined-room aligned full fixture.
      reference = row.final?.slice(row.initial?.length) ?? '';
      return { setup, row, verdict: reference ? 'PASS' : 'FAIL' };
    });
    for (let i = 0; i < state.t4Runs; i++) await run(`first-word-${i + 1}`, (s) => firstWordScene(s, surface, reference));
  }
  if (state.scenario === 'all') await run('keyboard', async (s) => {
    const setup = await cycle(s, surface, state, { cold: true });
    const row = await keyboard(s, surface, state);
    return { setup, ...row, verdict: Object.values(row.checks).every((v) => v === 'PASS') ? 'PASS' : 'FAIL' };
  });
}
