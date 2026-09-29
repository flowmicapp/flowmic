// EMB-13 scenarios. Each takes a browser context and the rig's state and returns
// {name, pass, failed, rows?, checks?, wire}. A scenario never throws past its own
// boundary: an abort becomes a red row with the stack, so one broken step cannot
// hide the scenarios after it (and cannot be mistaken for a pass).
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { expectedInsert, looksLikeChineseSpeech, summarize, verdict } from './emb13-live-rig-lib.mjs';
import {
  FIELDS, INITIAL, RUNS_PER_FIELD, SHADOW, clickIconOn, markBaseline, newPage, openLocalDictation, others, paceRoomBuilds,
  presetValuesUnfocused, setupField, snapshot, speakOnce, timings,
} from './emb13-live-driver.mjs';

const TARGET_URL = (state, target) => `${state.site.origin}/?target=${encodeURIComponent(target)}`;
const finish = async (s, name, rows, extra = {}) => {
  const snap = await snapshot(s.page).catch(() => ({ cls: null, shifts: [], rects: null, baseRects: null }));
  // Two different claims. The HOST page must not move (its element rects at load equal those at the end,
  // and no layout-shift entry names a host node). The raw layout-shift SCORE must be zero too, as design
  // 4.3 words it; the API cannot name nodes in a shadow tree, so a nonzero score with an unchanged host is
  // the widget's own panel moving, reported separately so the two are not confused.
  const hostMoved = !!snap.rects && !!snap.baseRects && JSON.stringify(snap.rects) !== JSON.stringify(snap.baseRects);
  const hostShift = (snap.shifts ?? []).filter((x) => x.sources.some((n) => n.node !== 'gone')).reduce((n, x) => n + x.value, 0);
  const failed = [
    ...(s.pageErrors.length === 0 ? [] : ['pageErrors']),
    ...(hostMoved || hostShift > 0 ? ['hostPageMoved'] : []),
    ...(snap.cls === 0 ? [] : [`layoutShiftScore=${Number(snap.cls).toFixed(4)}`]),
  ];
  const rectDiff = hostMoved ? Object.keys(snap.rects).filter((k) => JSON.stringify(snap.rects[k]) !== JSON.stringify(snap.baseRects[k])).map((k) => ({ element: k, from: snap.baseRects[k], to: snap.rects[k] })) : [];
  const scene = { name, rows, pageErrors: s.pageErrors, cls: snap.cls, hostMoved, hostRectDiff: rectDiff, hostShift, shifts: snap.shifts, wire: s.wire, roomResponses: s.roomResponses, ...extra };
  scene.pass = rows.every((r) => r.pass) && failed.length === 0;
  scene.failed = failed;
  await s.page.close().catch(() => {});
  return scene;
};
const abort = async (s, state, rows, e, tag) => {
  rows.push({ label: 'scenario aborted', pass: false, failed: ['aborted'], error: String(e.stack ?? e).slice(0, 900) });
  await s.page.screenshot({ path: join(state.runDir, `${tag}-abort.png`) }).catch(() => {});
};
/** One row for a dictation into a page field, judged from the page's own values. */
function fieldRow(label, kind, run, before, after, { id, initial = INITIAL, caret = 3, extra = {} }) {
  const t = timings(run);
  const exp = expectedInsert(initial, caret, t.sentences);
  const checks = {
    textArrived: t.sentences.length > 0,
    recognisedChinese: looksLikeChineseSpeech(t.sentences.join('')),
    landedAtCaretInTheFieldTheVisitorWasIn: after.values[id] === exp.value,
    caretLeftAfterInsertedText: after.sel?.start === exp.caret && after.sel?.end === exp.caret && after.activeId === id,
    pressDidNotTakeTheCaret: run.preSpeak.activeId === id && run.preSpeak.sel?.start === caret && run.preSpeak.sel?.end === caret,
    eachOtherFieldUntouched: others(before, after, id),
    hostSawAnInputEventOnTheField: run.marks.some((m) => m.name === 'input' && m.detail?.id === id),
    ...(kind === 'react' ? { reactStateHoldsTheWords: after.reactValue === after.values['f-react'] && after.reactValue === exp.value } : {}),
    receiptsAllOk: t.receipts.length > 0 && t.receipts.every((r) => r.ok === true),
    ...extra,
  };
  return { label, kind, ...verdict(checks), checks, timings: t, valueAfter: after.values[id] };
}

// A. what the page pays before anybody asks for a microphone
export async function sceneLoadCost(ctx, state) {
  const s = await newPage(ctx, state, 'A page load cost');
  const rows = [];
  try {
    const before = state.sdkHost.requests.length;
    const buildsBefore = state.roomBuilds.length;
    await s.page.goto(TARGET_URL(state, 'focus'));
    await s.page.locator(SHADOW('icon')).first().waitFor({ state: 'visible' });
    await markBaseline(s.page);
    await sleep(900);
    const seen = state.sdkHost.requests.slice(before).map((r) => r.path);
    const snap = await snapshot(s.page);
    const checks = {
      loaderUnder15KiBGzip: state.sdkHost.loaderGzip <= 15 * 1024,
      onlyTheLoaderWasRequestedAtFirstPaint: seen.length === 1 && seen[0] === '/go/integrator/v1.js',
      noRoomRequestBeforeIntent: state.roomBuilds.length === buildsBefore,
      iconVisibleAtFirstPaint: true,
      noLayoutShiftFromUs: snap.cls === 0,
    };
    rows.push({ label: 'first paint', ...verdict(checks), checks, data: { loaderBytes: state.sdkHost.loaderBytes, loaderGzip: state.sdkHost.loaderGzip, requests: seen, cls: snap.cls } });
  } catch (e) { await abort(s, state, rows, e, 'A'); }
  return finish(s, 'A page load cost', rows);
}

// B. follow-focus: real speech, four field types x RUNS_PER_FIELD, plus the not-a-target cases
export async function sceneFollowFocus(ctx, state, cfg) {
  const s = await newPage(ctx, state, 'B follow-focus dictation');
  const rows = [];
  const kinds = ['input', 'textarea', 'ce', ...(cfg.react ? ['react'] : [])]
    .filter((k) => !process.env.FLOWMIC_EMB13_KINDS || process.env.FLOWMIC_EMB13_KINDS.split(',').includes(k));
  try {
    await paceRoomBuilds(state);
    await s.page.goto(TARGET_URL(state, 'focus'));
    await markBaseline(s.page);
    await setupField(s.page, FIELDS.input, INITIAL, 3);
    const opened = await openLocalDictation(s.page);
    // One check per step, so a red row names the control that took the caret. A step the widget skipped
    // (a remembered choice or language) is not asserted. The icon and local presses are the loader's press
    // guard; the language pick moves focus on purpose in the widget's own listbox code (a defect against 3.4).
    const kept = (step) => opened.steps.find((x) => x.step === step)?.activeId === 'f-input' || !opened.steps.some((x) => x.step === step);
    const openChecks = { iconPressKeptTheCaret: kept('icon'), localChoiceKeptTheCaret: kept('local'), languageChoiceKeptTheCaret: kept('language') };
    rows.push({ label: 'opening: icon, local, language keep the caret in the field', kind: null, ...verdict(openChecks), checks: openChecks, data: opened.steps });
    for (const kind of kinds) {
      for (let i = 1; i <= RUNS_PER_FIELD; i += 1) {
        await setupField(s.page, FIELDS[kind], INITIAL, 3);
        const before = await snapshot(s.page);
        const run = await speakOnce(s.page, s);
        rows.push(fieldRow(`${kind} #${i}`, kind, run, before, await snapshot(s.page), { id: FIELDS[kind].slice(1) }));
      }
    }
    // A password field and an opted-out field are not targets: the words stay in the last real field.
    for (const [sel, label] of [['#f-password', 'password'], ['#f-off', 'data-flowmic=off']]) {
      await setupField(s.page, FIELDS.input, INITIAL, 3);
      await setupField(s.page, sel, 'keep-me', 7);
      const before = await snapshot(s.page);
      const run = await speakOnce(s.page, s);
      const after = await snapshot(s.page);
      const t = timings(run);
      const checks = {
        textArrived: t.sentences.length > 0,
        wentToTheLastEligibleField: after.values['f-input'] === expectedInsert(INITIAL, 3, t.sentences).value,
        theExcludedFieldKeptItsValue: after.values[sel.slice(1)] === before.values[sel.slice(1)],
      };
      rows.push({ label: `focus on ${label}, then speak`, kind: null, ...verdict(checks), checks, timings: t });
    }
    // Moving to another field while speaking: the sentence goes where the visitor is when it lands.
    await setupField(s.page, FIELDS.textarea, INITIAL, 3);
    const before = await snapshot(s.page);
    const move = async () => { await setupField(s.page, FIELDS.input, INITIAL, 3); };
    const run = await speakOnce(s.page, s, { midAction: { afterMs: 2500, run: move } });
    const after = await snapshot(s.page);
    const t = timings(run);
    const checks = {
      textArrived: t.sentences.length > 0,
      landedInTheFieldTheVisitorMovedTo: after.values['f-input'] === expectedInsert(INITIAL, 3, t.sentences).value,
      theFieldTheyLeftWasNotWritten: after.values['f-textarea'] === before.values['f-textarea'],
    };
    rows.push({ label: 'move to another field while speaking', kind: null, ...verdict(checks), checks, timings: t });
  } catch (e) { await abort(s, state, rows, e, 'B'); }
  return finish(s, 'B follow-focus dictation', rows);
}

// C. fixed selector(s): only the listed fields ever receive words
export async function sceneFixedSelector(ctx, state) {
  const scenes = [];
  {
    const s = await newPage(ctx, state, 'C1 fixed selector: #f-textarea');
    const rows = [];
    try {
      await paceRoomBuilds(state);
      await s.page.goto(TARGET_URL(state, '#f-textarea'));
      await markBaseline(s.page);
      await presetValuesUnfocused(s.page, 'xyz');
      await s.page.locator(SHADOW('icon')).first().waitFor({ state: 'visible' });
      const iconCount = await s.page.locator(SHADOW('icon')).count();
      await openLocalDictation(s.page, { iconOn: '#f-textarea' });
      await setupField(s.page, FIELDS.input, INITIAL, 3); // the visitor is in a field that is NOT listed
      const before = await snapshot(s.page);
      const run = await speakOnce(s.page, s);
      const after = await snapshot(s.page);
      const t = timings(run);
      const checks = {
        textArrived: t.sentences.length > 0,
        onlyOneIconIsDrawn: iconCount === 1,
        listedFieldReceivedTheWords: after.values['f-textarea'] === expectedInsert('xyz', 3, t.sentences).value,
        everyOtherFieldUntouched: others(before, after, 'f-textarea'),
        theVisitorsFieldKeptItsFocusAndCaret: after.activeId === 'f-input' && after.sel?.start === 3 && after.sel?.end === 3,
      };
      rows.push({ label: 'C1 visitor in an unlisted field, one listed field', ...verdict(checks), checks, timings: t });
    } catch (e) { await abort(s, state, rows, e, 'C1'); }
    scenes.push(await finish(s, 'C1', rows));
  }
  {
    const s = await newPage(ctx, state, 'C2 fixed selectors: #f-input, #f-textarea');
    const rows2 = [];
    try {
      await paceRoomBuilds(state);
      await s.page.goto(TARGET_URL(state, '#f-input, #f-textarea'));
      await markBaseline(s.page);
      await s.page.locator(SHADOW('icon')).first().waitFor({ state: 'visible' });
      const iconCount = await s.page.locator(SHADOW('icon')).count();
      await openLocalDictation(s.page, { iconOn: '#f-textarea' });
      await setupField(s.page, FIELDS.textarea, INITIAL, 3);
      let before = await snapshot(s.page);
      let run = await speakOnce(s.page, s);
      let after = await snapshot(s.page);
      const first = fieldRow('C2 #1 in the listed textarea', 'textarea', run, before, after, { id: 'f-textarea', extra: { twoIconsForTwoListedFields: iconCount === 2 } });
      rows2.push(first);
      // Now the visitor is in the contenteditable, which is not listed: words go to the last listed field, at its remembered caret.
      const caretAfterFirst = expectedInsert(INITIAL, 3, first.timings.sentences).caret;
      await setupField(s.page, FIELDS.ce, INITIAL, 3);
      before = await snapshot(s.page);
      run = await speakOnce(s.page, s);
      after = await snapshot(s.page);
      const t = timings(run);
      const checks = {
        textArrived: t.sentences.length > 0,
        wentToTheLastListedField: after.values['f-textarea'] === expectedInsert(first.valueAfter, caretAfterFirst, t.sentences).value,
        theUnlistedFieldWasNotWritten: after.values['f-ce'] === before.values['f-ce'],
      };
      rows2.push({ label: 'C2 #2 visitor in an unlisted field', ...verdict(checks), checks, timings: t });
    } catch (e) { await abort(s, state, rows2, e, 'C2'); }
    scenes.push(await finish(s, 'C2', rows2));
  }
  return {
    name: 'C fixed selector', rows: scenes.flatMap((x) => x.rows), pass: scenes.every((x) => x.pass), failed: scenes.flatMap((x) => x.failed),
    shifts: scenes.flatMap((x) => x.shifts ?? []), wire: scenes.flatMap((x) => x.wire), roomResponses: scenes.flatMap((x) => x.roomResponses), pageErrors: scenes.flatMap((x) => x.pageErrors),
  };
}

// D. no target at all: nothing is written, and what the visitor sees says so
export async function sceneNoTarget(ctx, state) {
  const s = await newPage(ctx, state, 'D no target');
  const rows = [];
  try {
    await paceRoomBuilds(state);
    await s.page.goto(TARGET_URL(state, 'focus'));
    await markBaseline(s.page);
    await presetValuesUnfocused(s.page, INITIAL);
    await openLocalDictation(s.page);
    const before = await snapshot(s.page);
    const run = await speakOnce(s.page, s, { expectNoText: true });
    const after = await snapshot(s.page);
    const t = timings(run);
    const seen = await s.page.evaluate(() => {
      const sr = document.querySelector('flowmic-voice').shadowRoot;
      const q = (n) => sr.querySelector(`[data-flowmic-mic="${n}"]`);
      return { recovery: q('target-recovery')?.hidden === false ? q('target-recovery').value : null, hint: q('target-hint')?.hidden === false ? q('target-hint').textContent : null, state: q('root')?.dataset.state ?? null };
    });
    const errors = run.marks.filter((m) => m.name === 'flowmic:error').map((m) => m.detail?.code);
    const checks = {
      nothingWasWrittenToAnyField: JSON.stringify(before.values) === JSON.stringify(after.values) && before.reactValue === after.reactValue,
      noTextEventReachedTheHost: t.sentences.length === 0,
      noInputEventOnAnyField: !run.marks.some((m) => m.name === 'input'),
      theWordsAreKeptForTheVisitor: !!seen.recovery && looksLikeChineseSpeech(seen.recovery),
      theVisitorIsToldWhy: !!seen.hint,
      neverShowsAddedState: seen.state !== 'added' && !run.marks.some((m) => m.name === 'state' && m.detail?.state === 'added'),
      hostGotAnErrorCode: errors.length > 0,
      noReceiptClaimsSuccess: t.receipts.every((r) => r.ok !== true),
      // Design 3.4: the sender is told delivered-but-not-injected, as cached, with the not-ready code.
      receiptSaysCachedWithTheNotReadyCode: t.receipts.length > 0 && t.receipts.every((r) => r.ok === false && r.mode === 'cached' && r.code === 'INJECT_TARGET_NOT_READY'),
    };
    rows.push({ label: 'D no field was ever focused', ...verdict(checks), checks, timings: t, data: { seen, errors, receipts: t.receipts } });
    // The recovery path: focus a field, then the visitor chooses to put the words there.
    await setupField(s.page, FIELDS.textarea, INITIAL, 3);
    const insert = s.page.locator(SHADOW('insert'));
    await insert.waitFor({ state: 'visible' });
    const kept = await s.page.evaluate(() => document.querySelector('flowmic-voice').shadowRoot.querySelector('[data-flowmic-mic="target-recovery"]').value);
    const preClick = await snapshot(s.page);
    await insert.click();
    await sleep(300);
    const done = await snapshot(s.page);
    const gone = await s.page.evaluate(() => document.querySelector('flowmic-voice').shadowRoot.querySelector('[data-flowmic-mic="target-recovery"]').hidden);
    const c2 = {
      nothingWasWrittenBeforeTheClick: preClick.values['f-textarea'] === INITIAL,
      theClickWroteTheKeptWordsAtTheCaret: done.values['f-textarea'] === expectedInsert(INITIAL, 3, [kept]).value,
      theRecoveryBoxClosed: gone === true,
    };
    rows.push({ label: 'D2 focus a field, then choose to put the words there', ...verdict(c2), checks: c2 });
  } catch (e) { await abort(s, state, rows, e, 'D'); }
  return finish(s, 'D no target', rows);
}

// E. the same key from a page that is not on its list
export async function sceneForeignOrigin(ctx, state) {
  const s = await newPage(ctx, state, 'E key from an unlisted origin');
  const rows = [];
  try {
    const api = async (headers) => fetch(`${state.relay.url}/api/web/rooms`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${state.minted.key}`, ...headers }, body: JSON.stringify({ auth: { kind: 'publishable_key' } }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    const wrong = await api({ origin: state.foreign.origin });
    const none = await api({});
    await paceRoomBuilds(state);
    await s.page.goto(`${state.foreign.origin}/?target=focus`);
    await s.page.locator(SHADOW('icon')).first().waitFor({ state: 'visible' });
    await markBaseline(s.page);
    await openLocalDictation(s.page, { waitForHold: false });
    await sleep(3000);
    const seen = await s.page.evaluate(() => {
      const sr = document.querySelector('flowmic-voice').shadowRoot;
      const hold = sr.querySelector('[data-flowmic-mic="hold"]');
      return { holdOffered: !!hold && !hold.disabled && hold.getClientRects().length > 0, notice: sr.querySelector('[data-flowmic-mic="notice"]')?.textContent ?? null, state: sr.querySelector('[data-flowmic-mic="root"]')?.dataset.state ?? null };
    });
    const errors = (await s.page.evaluate(() => window.__marks.filter((m) => m.name === 'flowmic:error').map((m) => m.detail?.code)));
    const checks = {
      apiRefusesAnUnlistedOrigin: wrong.status === 403 && wrong.body?.error === 'WEB_ROOM_ORIGIN_NOT_ALLOWED',
      apiRefusesARequestWithNoOrigin: none.status === 403,
      theBrowserRoomRequestWasRefused: s.roomResponses.some((r) => r.status === 403),
      noAudioWasSent: !s.wire.some((f) => f.event === 'audio:chunk'),
      noSpeakControlIsOffered: seen.holdOffered === false,
      theVisitorSeesAFailureNotSilence: !!seen.notice || seen.state === 'error' || errors.length > 0,
    };
    rows.push({ label: 'E unlisted origin is refused', ...verdict(checks), checks, data: { api: { wrong: wrong.body?.error ?? wrong.status, none: none.status }, seen, errors } });
  } catch (e) { await abort(s, state, rows, e, 'E'); }
  return finish(s, 'E key from an unlisted origin', rows);
}

// F. the meter: what was streamed, what the relay recorded, who paid
export function reconcileBilling(state, scenes) {
  const db = new DatabaseSync(state.dbPath, { readOnly: true });
  try {
    const key = db.prepare('SELECT used_ms, quota_minutes FROM integrator_keys WHERE publishable_key=?').get(state.minted.key);
    const events = db.prepare("SELECT stt_ms, outcome, payer_reason, integrator_key_id FROM usage_events WHERE kind='stt' ORDER BY id").all();
    const records = db.prepare('SELECT user_id, stt_minutes FROM usage_records').all();
    const streamedMs = Math.round(scenes.flatMap((x) => x.wire ?? []).filter((f) => f.event === 'audio:chunk' && f.dir === 'out').reduce((n, f) => n + f.detail.ms, 0));
    const sttMs = events.reduce((n, e) => n + (e.stt_ms ?? 0), 0);
    // Measured, not designed: over five full runs the meter read 70 to 88 percent of the audio the
    // browser streamed (the relay's own error text names a feed gate; that this is why was not checked).
    // So the meter may sit below the stream and must never sit above it, and it must cover most of it,
    // so a meter that stopped counting cannot pass.
    const checks = {
      everyRecordingIsOnTheHostAccount: events.length > 0 && events.every((e) => e.payer_reason === 'host' && e.integrator_key_id === state.minted.keyId && e.outcome === 'ok'),
      keyCounterEqualsTheRecordedSpeech: key?.used_ms === sttMs,
      usageRecordMinutesEqualTheKeyCounter: records.length === 1 && Math.abs(records[0].stt_minutes - sttMs / 60000) < 1e-6,
      billedNeverExceedsAudioStreamed: sttMs <= streamedMs,
      billedCoversMostOfTheStream: sttMs >= 0.6 * streamedMs,
      oneAccountWasBilled: records.length === 1,
      keyStayedUnderItsCap: (key?.used_ms ?? 0) <= (key?.quota_minutes ?? 0) * 60_000,
    };
    return { label: 'F billing reconciliation', ...verdict(checks), checks, data: { streamedMs, sttMsRecorded: sttMs, keyUsedMs: key?.used_ms, keyCapMinutes: key?.quota_minutes, usageRecordMinutes: records.map((r) => r.stt_minutes), recordings: events.length, minutesUsed: +(key?.used_ms / 60000).toFixed(2) } };
  } finally { db.close(); }
}

/** p50/max per field type and overall: the numbers the card asks for. */
export function summarizeByField(bScene) {
  const rows = (bScene?.rows ?? []).filter((r) => r.kind);
  const pick = (rs, f) => summarize(rs.map((r) => r.timings?.[f]));
  const line = (label, rs) => ({
    label, pass: rs.filter((r) => r.pass).length, n: rs.length,
    clickToListening: pick(rs, 'clickToListeningMs'), onsetToInterim: pick(rs, 'onsetToInterimMs'),
    firstTextFromStart: pick(rs, 'firstTextFromStartMs'), stopToField: pick(rs, 'stopToFieldMs'), wireStopToFinal: pick(rs, 'wireStopToFinalMs'),
    cpuBusyPct: pick(rs, 'cpuBusyPct'),
  });
  return [...new Set(rows.map((r) => r.kind))].map((k) => line(k, rows.filter((r) => r.kind === k))).concat(rows.length ? [line('all', rows)] : []);
}
