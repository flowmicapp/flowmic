// card RC-E — in a LONG RECORDING a silence of 3 s or more ends a row that is at
// least 10 s old and holds a word, without waiting for the 30 s deadline. Push-to-
// talk is unchanged.
//
// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (RC-E block)
//   docs/strategy/2026-09-24-cr12e-rerun-root-cause.md §3 (defect E: 4 of 13 silences
//     started a row), §7 RC-E
//   apps/server-core/src/stt/segment-boundary.ts `continuousSilenceCutAllowed` (the one
//     rule), orchestrator-rollover.ts `flushAndCloseLegForSilence` (the hang-up source)
//
// Drives the REAL orchestrator + AudioSession with the word-model leg in
// `fixtures/stt-word-leg.ts` (words with times, an energy gate, Soniox's interim facts
// and final word times), so the pause account and the word-gap arm run on production
// arithmetic. Two sources, one rule:
//   · a quiet room: the gate closes, the 3 s idle hang-up fires, and the hang-up ends
//     the row instead of banking it;
//   · a noisy room: the gate never closes, and the engine's own word gap (≥3 s, ≥2 s
//     certain) ends the row before `due`.
// Claims: the row ends at the silence; the next row's `pause_before_ms` is the silence
// within ±800 ms (the device read +280…+620 ms on pause cuts, rerun §3.3); every word
// comes out exactly once. Negative cases, each with its positive control: the SAME
// sequence without `continuous` does not cut (push-to-talk, byte for byte); a row 8 s
// old does not cut.
// REVERSE CONTROL (card RC-E): see the card's report — the hang-up's row cut removed
// reds the quiet-room case; the early word-gap arm removed reds the noisy-room case.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { log } from '../src/log';
import { RoomStore } from '../src/room/store';
import type { SttStartArgs } from '../src/socket/handlers/audio.handler';
import { makeSttSessionFactory } from '../src/engine/stt-factory';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { seedDefaultSettings } from '../src/settings/defaults';
import type { QuotaGuard } from '../src/billing/quota-guard';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { STT_CUT_EVENT } from '../src/stt/cut-log';
import { FakeClock, T0 } from './fixtures/stt-outage-harness';
import { CHUNK_BYTES, CHUNK_MS, OPEN_MS, WordLeg, gateSaysVoice, tok, words, type Word } from './fixtures/stt-word-leg';

interface Final { text: string; is_segment: boolean; segment_idx: number; duration_ms: number; pause_before_ms?: number }
interface Run { rows: Final[]; all: string; cuts: Record<string, unknown>[]; legs: WordLeg[] }

async function run(ws: readonly Word[], untilMs: number, o: { continuous: boolean; room: 'quiet' | 'noisy' }): Promise<Run> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 600_000 });
  session.start();
  const legs: WordLeg[] = [];
  const orch = new SttEngineOrchestrator(session, () => { const l = new WordLeg(ws, clock); legs.push(l); return l; }, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 30_000, softSegmentGraceMs: 15_000, engineFlushTimeoutMs: 3_000,
    idleHangupMs: 3_000, // production's DEFAULT_ENGINE_IDLE_HANGUP_MS, same wiring as the gate
    ...(o.continuous ? { continuous: true, reconnectUnbounded: true } : {}),
    ...(o.room === 'quiet' ? { shouldFeedEngine: (c: { seq: number }) => gateSaysVoice(ws, c.seq) } : {}),
  });
  const finals: Final[] = [];
  const cuts: Record<string, unknown>[] = [];
  vi.spyOn(log, 'info').mockImplementation((msg: string, fields?: Record<string, unknown>) => { if (msg === STT_CUT_EVENT) cuts.push(fields ?? {}); });
  orch.on('final', (f: Final) => finals.push(f));
  for (const e of ['error', 'engine-status', 'interim', 'error-suppressed']) orch.on(e, () => { /* listeners mandatory */ });
  const started = orch.start({ language: 'zh', mode: 'realtime' });
  await clock.advance(OPEN_MS);
  await started;
  for (let seq = 0; seq * CHUNK_MS < untilMs; seq++) {
    const payload = Buffer.alloc(CHUNK_BYTES);
    payload.writeUInt32LE(seq, 0);
    orch.pushChunk({ seq, ts_ms: clock.now, payload });
    await clock.advance(CHUNK_MS);
  }
  const stopped = orch.stop();
  await clock.advance(5_000);
  await stopped;
  return { rows: finals.filter((f) => f.is_segment), all: finals.map((f) => f.text).join(''), cuts, legs };
}

const said = (ws: readonly Word[]): string => ws.map(tok).join('');

afterEach(() => { vi.restoreAllMocks(); });

describe('RC-E — a quiet room: the 3 s hang-up ends a long recording\'s row', () => {
  // Words to 20.0 s, a 3.6 s silence, words from 23.6 s (on the chunk grid). The hang-up fires ~2.85 s
  // into the silence, when the row is ~22.9 s old — well before the 30 s deadline.
  const first = words(0, 20_000);
  const ws = [...first, ...words(23_600, 28_000, first.length)];

  it('🔴 row age ~23 s, 3.6 s silence ⇒ the row ends at the silence; the next row reports the silence ±800 ms', async () => {
    const r = await run(ws, 28_000, { continuous: true, room: 'quiet' });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.text).toBe(said(first));
    expect(r.cuts.find((c) => c.kind === 'hangup' && c.reason === 'pause')).toBeDefined();
    // The next row is the terminal final here; its pause is the one in front of it.
    const next = r.all.slice(r.rows[0]!.text.length);
    expect(next.startsWith(tok(ws[first.length]!))).toBe(true);
    expect(r.all).toBe(said(ws));
  });

  it('the next row\'s pause_before_ms is the 3.6 s silence ±800 ms (a row after it, so the figure rides a segment final)', async () => {
    // A second silence at 32 s ends row 2 the same way, so row 2 (the one AFTER the first
    // silence) goes out as an `is_segment` final carrying its own pause figure.
    const second = words(23_600, 32_000, first.length);
    const ws2 = [...first, ...second, ...words(35_600, 40_000, first.length + second.length)];
    const r = await run(ws2, 40_000, { continuous: true, room: 'quiet' });
    expect(r.rows.length).toBeGreaterThanOrEqual(2);
    const p = r.rows[1]!.pause_before_ms;
    expect(p).toBeDefined();
    expect(Math.abs(p! - 3_600)).toBeLessThanOrEqual(800);
    expect(r.all).toBe(said(ws2));
  });

  it('continuous ABSENT (push-to-talk): the same sequence does not cut — the hang-up banks, as before', async () => {
    const r = await run(ws, 28_000, { continuous: false, room: 'quiet' });
    expect(r.rows).toHaveLength(0);
    // POSITIVE CONTROL: the hang-up did happen (it banked: reason null), so the arm was reachable.
    expect(r.cuts.some((c) => c.kind === 'hangup' && c.reason === null)).toBe(true);
  });

  it('row 8 s old at the hang-up ⇒ no cut (under the 10 s floor)', async () => {
    const early = words(0, 5_000);
    const ws3 = [...early, ...words(8_600, 16_000, early.length)];
    const r = await run(ws3, 16_000, { continuous: true, room: 'quiet' });
    expect(r.rows).toHaveLength(0);
    // POSITIVE CONTROL: the hang-up fired in that silence and banked.
    expect(r.cuts.some((c) => c.kind === 'hangup' && c.reason === null)).toBe(true);
    expect(r.all).toBe(said(ws3));
  });
});

describe('RC-E — a noisy room: the engine\'s own ≥3 s word gap ends a long recording\'s row before `due`', () => {
  // The gate never closes (every chunk fed). Words to 15.0 s, 3.6 s without a word, words from 18.6 s.
  const first = words(0, 15_000);
  const ws = [...first, ...words(18_600, 26_000, first.length)];

  it('🔴 row age ~18 s, 3.6 s word gap ⇒ the row ends in the gap, and nothing is lost or repeated', async () => {
    const r = await run(ws, 26_000, { continuous: true, room: 'noisy' });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.text).toBe(said(first));
    expect(r.cuts.find((c) => c.kind === 'segment' && c.reason === 'word_gap')).toBeDefined();
    expect(r.all).toBe(said(ws));
  });

  it('continuous ABSENT (push-to-talk): no cut before the 30 s deadline', async () => {
    const r = await run(ws, 26_000, { continuous: false, room: 'noisy' });
    expect(r.rows).toHaveLength(0);
    // POSITIVE CONTROL: the text is all there — the words were heard, only not cut.
    expect(r.all).toBe(said(ws));
  });
});

describe('RC-E — the wiring: `audio:start.continuous` reaches the orchestrator as `continuous`', () => {
  // Anti-facade ①: the option is only worth anything if production sets it. The one writer is
  // `engine-factory.ts`, beside RC-1's `reconnectUnbounded` (stt-reconnect-unbounded.test.ts ②).
  const noopGuard: QuotaGuard = { ensureQuota() {}, remainingSttMs: () => Infinity, continuousCapMs: () => Infinity };
  class FakeSocket { readonly id = 'm'; data: Record<string, unknown> = { auth: { kind: 'mobile', userId: 'u1' } }; on(): this { return this; } emit(): boolean { return true; } }
  it.each([[true, true], [undefined, false]] as const)('args.continuous %s ⇒ orchestrator continuous %s', (continuous, expected) => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('rce-continuous-secret') });
    db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
    seedDefaultSettings(db.settings, 'u1');
    const store = new RoomStore<FakeSocket>() as unknown as RoomStore<Socket>;
    const factory = makeSttSessionFactory({ settings: db.settings, mode: 'standalone', store, quota: noopGuard });
    const args: SttStartArgs = { userId: 'u1', mode: 'realtime', delivery: 'none', sourceLang: 'zh', onComplete: () => {}, ...(continuous ? { continuous } : {}) };
    const bridge = factory(new FakeSocket() as unknown as Socket, args);
    const orch = (bridge as unknown as { orchestrator: SttEngineOrchestrator }).orchestrator;
    expect((orch as unknown as { continuous: boolean }).continuous).toBe(expected);
    bridge.dispose();
    db.close();
  });
});
