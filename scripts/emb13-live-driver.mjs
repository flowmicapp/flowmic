// EMB-13 page driving: everything the rig does to, and reads from, a browser page.
// Imported by emb13-live-scenes.mjs; it starts nothing on its own and spends nothing.
//
// EVERY READ IS A SNAPSHOT OF THE PAGE ITSELF (field values, the focused element,
// the caret, the host's own events through scripts/emb13-page/probe.js). What the
// widget claims about itself is never the evidence for a scenario's verdict.
import { cpus } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { chunkMs, parseSocketIoEvent } from './emb13-live-rig-lib.mjs';

export const RUNS_PER_FIELD = Number(process.env.FLOWMIC_EMB13_RUNS ?? 5); // the card asks for 5; fewer is for debugging the rig only
// The SDK holds the microphone open while a session is usable, so the fake capture
// device (a looping file) keeps running between presses and a press would land at an
// arbitrary point of the loop. The rig therefore aligns each press to the loop: the
// WAV is the 6.0 s speech plus SILENCE_PAD_MS of silence (loop = LOOP_MS), and a press
// starts LEAD_MS before the next loop start, so the sentence begins a moment after
// the press and every run hears all of it, once.
export const SILENCE_PAD_MS = 3000; // loop = 9.0 s, measured stable against wall time (drift < 50 ms over 22 s)
export const LOOP_MS = 6000 + SILENCE_PAD_MS;
// LEAD_MS of silence before the sentence and a press that ends 0.3 s after the fixture's last sound: a
// press may start up to 1.5 s early or 0.3 s late in the loop without hearing the previous or the next sentence.
const LEAD_MS = 1500;
const HOLD_AFTER_PRESS_MS = LEAD_MS + 6300;
const GUM_TO_FILE_START_MS = Number(process.env.FLOWMIC_EMB13_GUM_OFFSET_MS ?? 0); // gum-resolve vs the file's t=0
const QUIET_MS = 2000; // no further `text` for this long after the press ends: the utterance is over
const NO_TEXT_TIMEOUT_MS = 25_000;
const ROOM_BUILDS_PER_MINUTE = 5; // EMB-1: per key x visitor bucket; the rig paces itself under it

export const FIELDS = { input: '#f-input', textarea: '#f-textarea', ce: '#f-ce', react: '#f-react' };
export const ALL_IDS = ['f-input', 'f-textarea', 'f-ce', 'f-react', 'f-password', 'f-off'];
export const SHADOW = (name) => `[data-flowmic-mic="${name}"]`;
export const INITIAL = 'abc def';

function attachWire(page, sink) {
  page.on('websocket', (ws) => {
    const record = (dir) => (f) => {
      if (typeof f.payload !== 'string') return;
      const ev = parseSocketIoEvent(f.payload);
      if (!ev) return;
      let detail = ev.payload ?? null;
      // `ts` is the chunk's own capture clock (card WV-T4: a chunk held before the
      // room carries a `ts_ms` from before its `audio:start`).
      if (ev.event === 'audio:chunk') detail = { ms: chunkMs(ev.payload?.data_b64), seq: ev.payload?.seq, ts: ev.payload?.ts_ms ?? null };
      else if (detail && typeof detail === 'object') {
        detail = Object.fromEntries(Object.entries(detail).filter(([k]) => !/token|authorization/i.test(k))
          .map(([k, v]) => [k, typeof v === 'string' && v.length > 160 ? `${v.slice(0, 160)}...` : v]));
      }
      sink.push({ at: Date.now(), dir, event: ev.event, detail });
    };
    ws.on('framesent', record('out'));
    ws.on('framereceived', record('in'));
  });
}
export async function newPage(ctx, state, name) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const s = { name, page, wire: [], pageErrors: [], roomResponses: [] };
  attachWire(page, s.wire);
  page.on('pageerror', (e) => s.pageErrors.push(String(e.message).slice(0, 300)));
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/web/rooms')) state.roomBuilds.push(Date.now()); });
  page.on('response', (r) => { if (r.url().endsWith('/api/web/rooms')) s.roomResponses.push({ status: r.status() }); });
  return s;
}
/** Stay under the relay's per-bucket room limit instead of tripping it. */
export async function paceRoomBuilds(state) {
  for (;;) {
    if (state.roomBuilds.filter((t) => Date.now() - t < 61_000).length < ROOM_BUILDS_PER_MINUTE - 1) return;
    await sleep(2000);
  }
}
export async function snapshot(page) {
  return page.evaluate((ids) => {
    const val = (el) => (el.isContentEditable ? el.textContent : el.value);
    const values = Object.fromEntries(ids.map((id) => [id, val(document.getElementById(id))]));
    const a = document.activeElement;
    let sel = null;
    if (a && (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement)) sel = { start: a.selectionStart, end: a.selectionEnd };
    else if (a && a.isContentEditable) {
      const g = getSelection();
      if (g.rangeCount) {
        const r = g.getRangeAt(0);
        const pre = document.createRange(); pre.selectNodeContents(a); pre.setEnd(r.startContainer, r.startOffset);
        sel = { start: pre.toString().length, end: pre.toString().length + r.toString().length };
      }
    }
    return { values, reactValue: window.__reactValue, activeId: a && a.id ? a.id : null, sel, cls: window.__cls, shifts: window.__shifts, rects: window.__hostRects(), baseRects: window.__baseRects };
  }, ALL_IDS);
}
export async function marksSince(page, from) {
  const { marks, origin } = await page.evaluate((i) => ({ marks: window.__marks.slice(i), origin: performance.timeOrigin }), from);
  return marks.map((m) => ({ ...m, epoch: origin + m.at }));
}
export const markCount = (page) => page.evaluate(() => window.__marks.length);
const click = (page, sel) => page.locator(sel).click({ position: { x: 24, y: 14 } });
/** Give a field a value and put the caret at `caret`, as a person would: click in, type, move. */
export async function setupField(page, sel, initial, caret) {
  await click(page, sel);
  await page.locator(sel).fill(initial);
  await page.evaluate(([s, c]) => {
    const el = document.querySelector(s);
    if (el.isContentEditable) {
      const r = document.createRange(); r.setStart(el.firstChild, c); r.collapse(true);
      const g = getSelection(); g.removeAllRanges(); g.addRange(r);
    } else el.setSelectionRange(c, c);
  }, [sel, caret]);
  await sleep(200); // the tracker saves the caret on selectionchange / keyup
}
/** Record where every host element sits once the page has settled (React mounted, if it is on the page). */
export async function markBaseline(page) {
  await page.waitForFunction(() => !window.React || !!document.getElementById('f-react'));
  await sleep(300);
  await page.evaluate(() => { window.__baseRects = window.__hostRects(); });
}
/** Set values WITHOUT focusing anything (the no-target page must start with nothing focused). */
export async function presetValuesUnfocused(page, value) {
  await page.evaluate((v) => {
    for (const id of ['f-input', 'f-textarea', 'f-password', 'f-off']) document.getElementById(id).value = v;
    document.getElementById('f-ce').textContent = v;
  }, value);
}
async function holdEnabled(page) {
  await page.waitForFunction(() => {
    const b = document.querySelector('flowmic-voice')?.shadowRoot?.querySelector('[data-flowmic-mic="hold"]');
    return !!b && !b.disabled && b.getClientRects().length > 0;
  });
}
/** Click the icon that sits on the field `sel` (a selector target draws one per field). */
export async function clickIconOn(page, sel) {
  const index = await page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    const icons = [...document.querySelector('flowmic-voice').shadowRoot.querySelectorAll('[data-flowmic-mic="icon"]')];
    return icons.findIndex((i) => { const b = i.getBoundingClientRect(); return b.left >= r.left && b.right <= r.right + 8 && b.top >= r.top - 8 && b.bottom <= r.bottom + 8; });
  }, sel);
  if (index < 0) throw new Error(`no icon on ${sel}`);
  await page.locator(SHADOW('icon')).nth(index).click();
}
/**
 * icon -> (local, first visit only) -> (language, until remembered) -> ready, recording which
 * element holds focus after each step. The choice and the language are remembered per origin,
 * so a later page on the same site skips them: the driver follows what the widget offers.
 */
export async function openLocalDictation(page, { iconOn = null, waitForHold = true } = {}) {
  const steps = [];
  const after = async (step) => steps.push({ step, activeId: (await snapshot(page)).activeId });
  const offered = (name) => page.evaluate((n) => {
    const el = document.querySelector('flowmic-voice')?.shadowRoot?.querySelector(`[data-flowmic-mic="${n}"]`);
    return !!el && !el.hidden && el.getClientRects().length > 0;
  }, name);
  const untilOffered = (...names) => page.waitForFunction((list) => {
    const sr = document.querySelector('flowmic-voice')?.shadowRoot;
    return list.some((n) => { const el = sr?.querySelector(`[data-flowmic-mic="${n}"]`); return !!el && !el.hidden && el.getClientRects().length > 0; });
  }, names);
  if (iconOn) await clickIconOn(page, iconOn); else await page.locator(SHADOW('icon')).first().click();
  await untilOffered('local', 'language-chip', 'hold');
  await after('icon');
  if (await offered('local')) {
    await page.locator(SHADOW('local')).click();
    await untilOffered('language-chip', 'hold');
    await after('local');
  }
  let language = null;
  if (await offered('language-chip')) {
    await page.locator(SHADOW('language-chip')).click();
    language = await page.evaluate(() => {
      const opts = [...document.querySelector('flowmic-voice').shadowRoot.querySelectorAll('.language-list button')];
      return (opts.find((o) => /^zh/.test(o.dataset.value)) ?? opts[0])?.dataset.value;
    });
    await page.locator(`.language-list button[data-value="${language}"]`).click();
    await after('language');
  }
  if (waitForHold) await holdEnabled(page);
  return { steps, language };
}
/** Wait (in the page's clock) until the next loop start is LEAD_MS away. */
async function alignToLoop(page) {
  const plan = await page.evaluate(([period, lead, cal]) => {
    const gum = [...window.__marks].reverse().find((m) => m.name === 'gum');
    if (!gum) return null;
    const t0 = gum.at + cal;
    return { at: t0 + Math.ceil((performance.now() + 150 - t0 + lead) / period) * period - lead };
  }, [LOOP_MS, LEAD_MS, GUM_TO_FILE_START_MS]);
  if (!plan) throw new Error('no microphone acquisition mark: cannot align the press to the audio loop');
  await page.evaluate((at) => new Promise((r) => { const w = () => (performance.now() >= at ? r() : setTimeout(w, 2)); w(); }), plan.at);
}
/**
 * One press-to-talk cycle: aligned start press, stop press HOLD_AFTER_PRESS_MS later.
 * `expectNoText` ends the wait a few seconds after the stop press instead of at the
 * long timeout: a scenario that expects nothing to land must not wait for it.
 */
export async function speakOnce(page, s, { midAction = null, expectNoText = false } = {}) {
  const m0 = await markCount(page);
  const w0 = s.wire.length;
  await holdEnabled(page);
  await alignToLoop(page);
  const cpu0 = cpuTimes();
  await page.locator(SHADOW('hold')).click();
  await page.waitForFunction((i) => window.__marks.slice(i).some((m) => m.name === 'flowmic:listening'), m0);
  const at = await marksSince(page, m0);
  const listening = at.find((m) => m.name === 'flowmic:listening');
  const press = at.find((m) => m.name === 'pointerdown' && m.detail?.k === 'hold');
  const preSpeak = await snapshot(page);
  const wait = (ms) => page.evaluate((t) => new Promise((r) => { const w = () => (performance.now() >= t ? r() : setTimeout(w, 4)); w(); }), press.at + ms);
  if (midAction) { await wait(midAction.afterMs); await midAction.run(); }
  await wait(HOLD_AFTER_PRESS_MS);
  await page.locator(SHADOW('hold')).click();
  const stoppedAt = Date.now();
  const deadline = stoppedAt + (expectNoText ? 7000 : NO_TEXT_TIMEOUT_MS + QUIET_MS);
  let marks;
  for (;;) {
    await sleep(150);
    marks = await marksSince(page, m0);
    const texts = marks.filter((m) => m.name === 'flowmic:text');
    const last = texts.length ? texts[texts.length - 1].epoch : 0;
    const state = [...marks].reverse().find((m) => m.name === 'state')?.detail.state ?? null;
    const resting = marks.some((m) => m.name === 'flowmic:stopped') && state !== 'listening' && state !== 'finishing';
    if (texts.length && resting && Date.now() - last > QUIET_MS) break;
    if (Date.now() > deadline) break;
  }
  return { marks, wire: s.wire.slice(w0), preSpeak, listeningEpoch: listening.epoch, cpuBusyPct: cpuBusy(cpu0), pressMs: HOLD_AFTER_PRESS_MS };
}
const cpuTimes = () => cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 });
/** Whole-machine CPU busy percentage since `from`: other agents share this box, and a starved audio thread drops samples. */
const cpuBusy = (from) => { const now = cpuTimes(); return Math.round((1 - (now.idle - from.idle) / Math.max(1, now.total - from.total)) * 100); };
/** Timings, all from one clock unless a name says `wire` (then it is the relay leg only). */
export function timings(r) {
  const presses = r.marks.filter((m) => m.name === 'pointerdown' && m.detail?.k === 'hold');
  const start = presses[0]?.epoch;
  const stop = presses[1]?.epoch;
  const texts = r.marks.filter((m) => m.name === 'flowmic:text');
  const firstInterim = r.marks.find((m) => m.name === 'interim' && m.epoch >= r.listeningEpoch);
  const w = (event, dir) => r.wire.filter((f) => f.event === event && f.dir === dir);
  const audioStart = w('audio:start', 'out')[0]?.at;
  const audioStop = w('audio:stop', 'out')[0]?.at;
  const wireInterim = w('stt:interim', 'in')[0]?.at;
  const wireFinal = w('stt:final', 'in').filter((f) => audioStop === undefined || f.at >= audioStop);
  const onset = r.wire.find((f) => f.event === 'stt:level' && f.dir === 'in' && audioStart !== undefined && f.at >= audioStart && f.detail?.amplitude_db > -40);
  return {
    speechOnsetMs: onset ? onset.at - audioStart : null,
    reacquiredMic: r.marks.some((m) => m.name === 'gum'),
    clickToListeningMs: start === undefined ? null : Math.round(r.listeningEpoch - start),
    firstInterimMs: firstInterim ? Math.round(firstInterim.epoch - r.listeningEpoch) : null,
    firstTextFromStartMs: texts.length && start !== undefined ? Math.round(texts[0].epoch - start) : null,
    stopToFieldMs: texts.length && stop !== undefined ? Math.round(texts[texts.length - 1].epoch - stop) : null,
    wireStopToFinalMs: wireFinal.length && audioStop !== undefined ? wireFinal[wireFinal.length - 1].at - audioStop : null,
    wireFirstInterimMs: wireInterim !== undefined && audioStart !== undefined ? wireInterim - audioStart : null,
    // From the first loud 300 ms level window to the first interim frame, both read off the relay leg.
    // The level frame closes its window, so the onset is up to 300 ms late and this figure up to 300 ms short.
    onsetToInterimMs: wireInterim !== undefined && onset ? wireInterim - onset.at : null,
    sentences: texts.map((m) => String(m.detail?.text ?? '')),
    audioMs: Math.round(r.wire.filter((f) => f.event === 'audio:chunk' && f.dir === 'out').reduce((n, f) => n + f.detail.ms, 0)),
    pressMs: r.pressMs,
    cpuBusyPct: r.cpuBusyPct,
    receipts: r.wire.filter((f) => f.event === 'inject:result').map((f) => ({ dir: f.dir, ok: f.detail?.ok, code: f.detail?.error ?? null, mode: f.detail?.mode ?? null })),
  };
}
export const others = (before, after, ...except) => ALL_IDS.filter((id) => !except.includes(id)).every((id) => before.values[id] === after.values[id]);
