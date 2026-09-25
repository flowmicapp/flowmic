// NR-38 (second half) — the capsule's side of `stt:engine-status{loading}`.
//
// TWO SEPARATE CLAIMS LIVE HERE, and only one of them was new.
//
// ① THE DEGRADE WAS ALREADY THERE, and it is asserted rather than assumed. The
//    reason the protocol commit could call `loading` additive is that every
//    shipped consumer drops a status it does not know instead of throwing. On
//    this leg that is `onEngineStatus`'s explicit `===` gate: a value outside
//    the set leaves `engineStatus` and `engineKnown` exactly as they were. The
//    row below is written against a value NO version will ever know
//    ('vendor-hibernating'), so it keeps proving the degrade after `loading`
//    stops being unknown — a test that used `loading` as its unknown value
//    would have deleted itself the moment this card landed. Measured before the
//    mapping below was written: already green, so no mutation was staged for it.
//    The other two consumers degrade structurally rather than by a gate and so
//    have nothing to assert here: the desktop Rust leg (`socket/fanout.rs
//    on_forward`) forwards the payload as a `serde_json::Value` and never
//    parses the enum, and the phone's `local_engine_status.dart observeFrame`
//    has an `_ => null` arm that returns without recording.
//
// ② THE MAPPING IS NEW: `loading` must reach the diagnostic as its own state,
//    not be swallowed by the same default arm that protects ①. That is the
//    whole point of the card — the capsule was silent for the 1.9 s‥8 s a local
//    pack takes to load, and the fix is worthless if the frame arrives and
//    nothing moves.
//
// 🔴 ③ THE SENTENCE ARRIVED (card WP2-COPY-1). Until it did, the value cell for
//    `loading` was asserted to be EMPTY — the key `cap_stt_loading` did not
//    exist and this repo does not let an executor author user-visible strings.
//    That row is now the opposite assertion: the cell renders the authored
//    string. What it does NOT do is assert the string's text, because a test
//    that spells out copy goes red every time the copy is improved and tells
//    nobody anything about the wiring. What it pins instead is the pair of
//    confusions that were available here: the cell must not fall back to
//    `cap_stt_unknown` ("Not checked" — a false claim about an engine that is
//    demonstrably present), and it must not put the raw identifier on screen.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import CapsuleApp from './CapsuleApp.vue';
import { fireAudioStopForTest, fireRealAudioStartForTest, fireSttFinalForTest, fireSttInterimForTest, fireTickForTest, onEngineStatus, state } from './controller';
import { ENGINE_RECONNECT_WORST_CASE_MS } from '@flowmic/protocol';
import { S } from '../lib/strings';

beforeEach(() => {
  state.engineProvider = '';
  state.engineStatus = '';
  state.engineKnown = false;
  state.engineRetry = null;
  state.engineSilent = false;
  state.diagOpen = false;
});

afterEach(() => {
  vi.useRealTimers();
});

/** The engine row of the real diagnostic panel, rendered through the real SFC —
 *  the ternary in `engineLabel` is the half a state-only assertion cannot reach,
 *  and it is exactly the half that decides what a user sees. */
async function engineRow(): Promise<{ dot: string; value: string; html: string }> {
  state.diagOpen = true;
  const html = await renderToString(createSSRApp(CapsuleApp));
  const row = html.split('<div class="drow"').find((chunk) => chunk.includes(S.cap_stt_label));
  if (row === undefined) throw new Error(`engine diagnostic row not rendered; html was:
${html}`);
  const dot = /<span class="([^"]*)dot([^"]*)"/.exec(row);
  const value = /<span class="v"[^>]*>([\s\S]*?)<\/span>/.exec(row);
  if (!dot || !value) throw new Error(`engine row shape changed; row was:
${row}`);
  const strip = (t: string): string => t.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  return { dot: `${dot[1]!}${dot[2]!}`.trim(), value: strip(value[1]!), html };
}

describe('capsule engine-status — the loading value', () => {
  it('records loading as its own state (it is not "ready" and not "unknown")', () => {
    onEngineStatus({ provider: 'sherpa-local', status: 'loading' });
    expect(state.engineStatus).toBe('loading');
    expect(state.engineKnown).toBe(true);
    expect(state.engineProvider).toBe('sherpa-local');
  });

  it('loading -> ready is the whole cold open, and the last frame wins', () => {
    onEngineStatus({ provider: 'sherpa-local', status: 'loading' });
    onEngineStatus({ provider: 'sherpa-local', status: 'ready' });
    expect(state.engineStatus).toBe('ready');
  });

  it('loading -> failed leaves the failure showing, not a stuck spinner', () => {
    onEngineStatus({ provider: 'sherpa-local', status: 'loading' });
    onEngineStatus({ provider: 'sherpa-local', status: 'failed' });
    expect(state.engineStatus).toBe('failed');
  });

  it('a status no version knows is DROPPED, never written through (the degrade ① above)', () => {
    onEngineStatus({ provider: 'sherpa-local', status: 'ready' });
    onEngineStatus({ provider: 'sherpa-local', status: 'vendor-hibernating' });
    expect(state.engineStatus, 'an unknown value must not overwrite a known one').toBe('ready');
    onEngineStatus({ provider: 'x', status: 42 });
    onEngineStatus(null);
    onEngineStatus({ provider: 'x' });
    expect(state.engineStatus).toBe('ready');
  });

  it('renders the loading state with the amber dot and its own authored sentence', async () => {
    onEngineStatus({ provider: 'sherpa-local', status: 'loading' });
    const row = await engineRow();
    expect(row.dot, 'work in progress shares the amber dot with reconnecting').toBe('y');
    // ③ above: the cell carries the string, and the string is its OWN — not the
    // "not checked" one, which would be a false claim about an engine that is
    // right here and working, and not a raw identifier on screen (0.2.53).
    expect(row.value, 'the loading cell renders cap_stt_loading').toBe(S.cap_stt_loading);
    expect(row.value, 'a non-empty cell is the whole point of this row').not.toBe('');
    expect(row.html).not.toContain('cap_stt_loading');
    expect(row.value).not.toBe(S.cap_stt_unknown);
    expect(row.value).not.toBe(S.cap_stt_ready);
  });

  it('ready still renders its own sentence — the empty cell is scoped to loading alone', async () => {
    onEngineStatus({ provider: 'sherpa-local', status: 'ready' });
    const row = await engineRow();
    expect(row.dot).toBe('g');
    expect(row.value).toBe(S.cap_stt_ready);
  });

  it('an unknown status on a FRESH capsule leaves the engine unknown — no fabricated verdict', () => {
    onEngineStatus({ provider: 'sherpa-local', status: 'vendor-hibernating' });
    expect(state.engineKnown, 'a frame we cannot read is not a reading').toBe(false);
    expect(state.engineStatus).toBe('');
    // The provider IS taken: the name is a plain string, not part of the enum,
    // and the row's own label is allowed to name an engine it has no verdict on.
    expect(state.engineProvider).toBe('sherpa-local');
  });
});

// ── NR-96-C (2026-09-24) — the attempt number on the same cell ─────────────
// Contract: book 15 §2.7 (laws 1, 2, 3, 5) and §4 R3's executable form. What a
// user reads is the rendered cell of the real SFC, so every row below asserts
// THAT — the state field is how it gets there, not what is delivered. The
// expected text is built from the string getters (the copy is a DEV placeholder
// until the AGY lane writes it; asserting its wording would pin the placeholder).
//
// The capsule only receives these frames for an utterance bound for this PC
// (the relay's `makeSttEmitter` withholds engine-status for record-only
// sessions); each row therefore opens a real utterance first, as production
// would, rather than feeding a frame into a capsule that has no utterance.
const counted = (n: number, max?: number): string =>
  max === undefined
    ? S.cap_stt_reconnecting_n.replace('{n}', String(n))
    : S.cap_stt_reconnecting_n_of.replace('{n}', String(n)).replace('{max}', String(max));
const rung = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ provider: 'soniox', status: 'reconnecting', retry_count: n, ...extra });

describe('capsule engine-status — NR-96-C attempt number', () => {
  beforeEach(() => { fireRealAudioStartForTest({ mode: 'realtime' }); });

  it('a budgeted frame renders "attempt n of N" in the engine cell, amber', async () => {
    onEngineStatus(rung(2, { retry_max: 3, retry_in_ms: 2_000, attempt_timeout_ms: 5_000 }));
    const row = await engineRow();
    expect(row.dot).toBe('y');
    expect(row.value).toBe(counted(2, 3));
    expect(row.value).toContain('2');
    expect(row.value).toContain('3');
    expect(row.value, 'placeholders must be filled, never shown').not.toMatch(/\{n\}|\{max\}/);
    expect(row.value, 'the counted face is not the plain one').not.toBe(S.cap_stt_reconnecting);
  });

  it('a frame WITHOUT retry_max (unbounded, or an old relay) renders "attempt n" and no total', async () => {
    onEngineStatus(rung(1));
    const row = await engineRow();
    expect(row.value).toBe(counted(1));
    expect(row.value).not.toBe(counted(1, 3));
    expect(row.value).not.toMatch(/\{n\}|\{max\}/);
  });

  it('a frame with no usable count keeps the plain reconnecting face (no fabricated number)', async () => {
    onEngineStatus({ provider: 'soniox', status: 'reconnecting' });
    expect((await engineRow()).value).toBe(S.cap_stt_reconnecting);
    onEngineStatus({ provider: 'soniox', status: 'reconnecting', retry_count: 0 });
    expect((await engineRow()).value).toBe(S.cap_stt_reconnecting);
  });

  it('failed replaces the reconnect face for good — past the old deadline the cell still reads Failed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    onEngineStatus(rung(3, { retry_max: 3, retry_in_ms: 4_000, attempt_timeout_ms: 5_000 }));
    onEngineStatus({ provider: 'soniox', status: 'failed', retry_count: 3 });
    vi.setSystemTime(new Date(1_000_000 + 60_000));
    fireTickForTest();
    const row = await engineRow();
    expect(row.value, 'the give-up edge must have ended the reconnect claim, so no watchdog blanks it').toBe(S.cap_stt_failed);
    expect(row.dot).toBe('r');
  });

  it('ready replaces it the same way (the success edge)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    onEngineStatus(rung(2, { retry_max: 3, retry_in_ms: 2_000, attempt_timeout_ms: 5_000 }));
    onEngineStatus({ provider: 'soniox', status: 'ready' });
    vi.setSystemTime(new Date(1_000_000 + 60_000));
    fireTickForTest();
    expect((await engineRow()).value).toBe(S.cap_stt_ready);
  });

  it('an interim proves the engine is producing: the cell shows ready, green', async () => {
    onEngineStatus(rung(2, { retry_max: 3, retry_in_ms: 2_000, attempt_timeout_ms: 5_000 }));
    fireSttInterimForTest({ segment_idx: 0, text: 'hello' });
    const row = await engineRow();
    expect(row.value).toBe(S.cap_stt_ready);
    expect(row.dot).toBe('g');
  });

  it('a final is NOT taken as that proof (the relay folds one from its accumulators after the engine is gone)', async () => {
    onEngineStatus(rung(1, { retry_max: 3, retry_in_ms: 1_000, attempt_timeout_ms: 5_000 }));
    fireSttFinalForTest({ segment_idx: 0, text: 'hello', is_segment: false });
    expect((await engineRow()).value).not.toBe(S.cap_stt_ready);
  });

  it('the watchdog blanks the cell at receipt + retry_in_ms + attempt_timeout_ms, and not before', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    onEngineStatus(rung(2, { retry_max: 3, retry_in_ms: 2_000, attempt_timeout_ms: 5_000 }));
    vi.setSystemTime(new Date(1_006_999));
    fireTickForTest();
    expect((await engineRow()).value, 'one ms early is still inside the frame\'s own deadline').toBe(counted(2, 3));
    vi.setSystemTime(new Date(1_007_000));
    fireTickForTest();
    const row = await engineRow();
    // The truth is unknown: nothing at all — not the old "Reconnecting…", not
    // "Not checked" (NR-38), not ready, not failed (law 3).
    expect(row.value).toBe('');
    expect(row.dot, 'no verdict colour either').toBe('o');
    expect(row.html, 'the row itself is still there — only its value is empty').toContain(S.cap_stt_label);
  });

  it('a newer frame re-arms the deadline from ITS facts, and brings the cell back after a blank', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    onEngineStatus(rung(1, { retry_max: 3, retry_in_ms: 1_000, attempt_timeout_ms: 5_000 }));
    vi.setSystemTime(new Date(1_005_000));
    onEngineStatus(rung(2, { retry_max: 3, retry_in_ms: 2_000, attempt_timeout_ms: 5_000 }));
    vi.setSystemTime(new Date(1_006_500)); // past rung 1's deadline, inside rung 2's
    fireTickForTest();
    expect((await engineRow()).value).toBe(counted(2, 3));
    vi.setSystemTime(new Date(1_012_000));
    fireTickForTest();
    expect((await engineRow()).value).toBe('');
    onEngineStatus(rung(3, { retry_max: 3, retry_in_ms: 4_000, attempt_timeout_ms: 5_000 }));
    expect((await engineRow()).value).toBe(counted(3, 3));
  });

  it('old relay (no timing facts): the fallback deadline is the ladder\'s derived worst case, from the last frame', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    onEngineStatus(rung(1));
    vi.setSystemTime(new Date(1_000_000 + ENGINE_RECONNECT_WORST_CASE_MS - 1));
    fireTickForTest();
    expect((await engineRow()).value).toBe(counted(1));
    vi.setSystemTime(new Date(1_000_000 + ENGINE_RECONNECT_WORST_CASE_MS));
    fireTickForTest();
    expect((await engineRow()).value, 'an old relay\'s claim expires too').toBe('');
  });

  it('a new utterance does not blank a cell that holds a real verdict (only a stale reconnect goes blank)', async () => {
    onEngineStatus({ provider: 'soniox', status: 'failed', retry_count: 3 });
    fireRealAudioStartForTest({ mode: 'realtime' });
    expect((await engineRow()).value).toBe(S.cap_stt_failed);
    onEngineStatus({ provider: 'soniox', status: 'ready' });
    fireAudioStopForTest();
    expect((await engineRow()).value).toBe(S.cap_stt_ready);
  });
  it('the utterance stopping under a reconnect blanks the cell (its claim ended with the activity)', async () => {
    onEngineStatus(rung(2, { retry_max: 3, retry_in_ms: 2_000, attempt_timeout_ms: 5_000 }));
    fireAudioStopForTest();
    expect((await engineRow()).value).toBe('');
    onEngineStatus({ provider: 'soniox', status: 'failed', retry_count: 3 });
    expect((await engineRow()).value, 'a give-up after release still shows').toBe(S.cap_stt_failed);
  });
});