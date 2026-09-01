// V2-05 (requirement ⑥) — the latency ruler's honesty properties.
//
// What is worth testing here is NOT "is the subtraction correct" (t1-t0 is arithmetic). It is the
// two ways this module could quietly produce a WRONG number:
//   ① merging two utterances' halves into one plausible-looking measurement;
//   ② reporting a missing segment as 0 instead of "unknown".
// Both would read as data and neither would ever look broken.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  markAudioStop,
  markFlushSent,
  markSttFinal,
  markInjectRequest,
  markInjectResult,
  emitLatencySummary,
  startLatencyReader,
  __resetLatencyState,
  __droppedCount,
  LATENCY_SUMMARY_INTERVAL_MS,
} from '../src/obs/latency';
import { log } from '../src/log';

/** A controllable clock so no case depends on wall time. */
function clockFrom(start: number): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

let lines: Array<{ msg: string; fields?: Record<string, unknown> }>;

beforeEach(() => {
  __resetLatencyState();
  lines = [];
  vi.spyOn(log, 'info').mockImplementation((msg, fields) => {
    lines.push({ msg, fields });
  });
});
afterEach(() => vi.restoreAllMocks());

const ROOM = 'room-1';

describe('latency segmentation (server clock only)', () => {
  it('reports the three segments and the total for a complete utterance', () => {
    const c = clockFrom(1_000);
    markAudioStop(ROOM, c.now);
    c.advance(400); markSttFinal(ROOM, c.now);
    c.advance(120); markInjectRequest(ROOM, 'e1', c.now);
    c.advance(80); markInjectResult(ROOM, 'e1', c.now);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).toBe('latency.segment');
    expect(lines[0]?.fields).toMatchObject({
      entry_id: 'e1',
      stt_ms: 400,
      phone_turnaround_ms: 120,
      inject_ms: 80,
      server_total_ms: 600,
    });
    // WP2-6a: no flush stamp ⇒ old shape. A reader that only knows stt_ms
    // must not see the split keys at all (absence, not null).
    expect(lines[0]?.fields).not.toHaveProperty('stt_to_flush_ms');
    expect(lines[0]?.fields).not.toHaveProperty('stt_from_flush_ms');
  });

  it('WP2-6a: the two sub-spans sum to stt_ms on the same record', () => {
    // REVERSE-CONTROL 6a: break the split (stamp flush at t0, or skip
    // markFlushSent) and this assertion goes red — the two numbers would
    // no longer add to the field every old reader already trusts.
    const c = clockFrom(1_000);
    markAudioStop(ROOM, c.now);
    c.advance(900); markFlushSent(ROOM, c.now);
    c.advance(100); markSttFinal(ROOM, c.now);
    c.advance(50); markInjectRequest(ROOM, 'eSplit', c.now);
    c.advance(50); markInjectResult(ROOM, 'eSplit', c.now);

    const f = lines[0]?.fields ?? {};
    expect(f.stt_ms).toBe(1000);
    expect(f.stt_to_flush_ms).toBe(900);
    expect(f.stt_from_flush_ms).toBe(100);
    expect((f.stt_to_flush_ms as number) + (f.stt_from_flush_ms as number)).toBe(f.stt_ms);
  });

  it('WP2-6a: a flush stamp after stt:final is ignored (wrong side of the wire)', () => {
    const c = clockFrom(0);
    markAudioStop(ROOM, c.now);
    c.advance(400); markSttFinal(ROOM, c.now);
    c.advance(10); markFlushSent(ROOM, c.now); // too late
    c.advance(10); markInjectRequest(ROOM, 'eLate', c.now);
    c.advance(10); markInjectResult(ROOM, 'eLate', c.now);
    expect(lines[0]?.fields).not.toHaveProperty('stt_to_flush_ms');
    expect(lines[0]?.fields?.stt_ms).toBe(400);
  });

  it('reports an unmeasured segment as null, never as 0', () => {
    // No stt:final at all (engine failed / record-only). A 0 here would read as
    // "STT costs no time" — the exact kind of confident-looking lie this repo bans.
    const c = clockFrom(0);
    markAudioStop(ROOM, c.now);
    c.advance(50); markInjectRequest(ROOM, 'e2', c.now);
    c.advance(50); markInjectResult(ROOM, 'e2', c.now);

    expect(lines[0]?.fields).toMatchObject({ stt_ms: null, phone_turnaround_ms: null, inject_ms: 50 });
  });

  it('DROPS an unfinished leg rather than merging it into the next utterance', () => {
    const c = clockFrom(0);
    markAudioStop(ROOM, c.now);            // utterance A starts…
    c.advance(300); markSttFinal(ROOM, c.now);
    c.advance(10_000);                      // …and never reaches inject.
    markAudioStop(ROOM, c.now);            // utterance B starts on the same room
    c.advance(200); markSttFinal(ROOM, c.now);
    c.advance(100); markInjectRequest(ROOM, 'eB', c.now);
    c.advance(50); markInjectResult(ROOM, 'eB', c.now);

    expect(__droppedCount()).toBe(1);
    // B's numbers must be B's. If A's t0 had been reused the total would be
    // ~10 650 ms — a plausible number that is simply not true.
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toMatchObject({ entry_id: 'eB', stt_ms: 200, server_total_ms: 350 });
  });

  it('only the FIRST stt:final of a leg is timed (soft segments do not restamp)', () => {
    const c = clockFrom(0);
    markAudioStop(ROOM, c.now);
    c.advance(100); markSttFinal(ROOM, c.now);
    c.advance(500); markSttFinal(ROOM, c.now); // a later segment final
    c.advance(10); markInjectRequest(ROOM, 'e3', c.now);
    c.advance(10); markInjectResult(ROOM, 'e3', c.now);

    expect(lines[0]?.fields).toMatchObject({ stt_ms: 100 });
  });

  it('stays silent when a result arrives with no leg at all', () => {
    // Re-inject from history: there was no audio:stop. Timing it against nothing
    // would invent a measurement for an utterance that was never spoken.
    markInjectResult(ROOM, 'orphan', clockFrom(0).now);
    expect(lines).toHaveLength(0);
  });

  it('abandons a leg older than the TTL instead of holding it forever', () => {
    const c = clockFrom(0);
    markAudioStop(ROOM, c.now);
    c.advance(200_000);
    markAudioStop('room-2', c.now); // any later mark sweeps
    expect(__droppedCount()).toBe(1);
  });
});

describe('WP2-6b latency.summary production-leg reader', () => {
  function complete(room: string, sttMs: number, turnMs: number, injMs: number, toFlush: number | null): void {
    const c = clockFrom(0);
    markAudioStop(room, c.now);
    if (toFlush !== null) { c.advance(toFlush); markFlushSent(room, c.now); c.advance(sttMs - toFlush); }
    else { c.advance(sttMs); }
    markSttFinal(room, c.now);
    c.advance(turnMs); markInjectRequest(room, `${room}-e`, c.now);
    c.advance(injMs); markInjectResult(room, `${room}-e`, c.now);
  }

  it('emits p50/p95 of the window and drains so a second tick is silent', () => {
    // REVERSE-CONTROL 6b: skip rememberClosed (or skip emitLatencySummary)
    // and summaries.length is 0 — the metric has no production-leg reader.
    complete('r-a', 1000, 200, 50, 900);
    complete('r-b', 1100, 300, 50, 1000);
    complete('r-c', 1200, 400, 50, 1100);
    emitLatencySummary();
    const summaries = lines.filter((l) => l.msg === 'latency.summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.fields).toMatchObject({
      n: 3,
      dropped_so_far: 0,
      window_ms: LATENCY_SUMMARY_INTERVAL_MS,
      stt_ms_p50: 1100,
      stt_to_flush_ms_p50: 1000,
      phone_turnaround_ms_p50: 300,
    });
    const before = summaries.length;
    emitLatencySummary();
    expect(lines.filter((l) => l.msg === 'latency.summary')).toHaveLength(before);
  });

  it('stays silent when the window is empty and dropped has not moved', () => {
    emitLatencySummary();
    expect(lines.filter((l) => l.msg === 'latency.summary')).toHaveLength(0);
  });

  it('prints dropped_so_far even when n=0 (the ①-c hole on the success path)', () => {
    const c = clockFrom(0);
    markAudioStop(ROOM, c.now);
    c.advance(200_000);
    markAudioStop('room-2', c.now);
    expect(__droppedCount()).toBe(1);
    emitLatencySummary();
    const summaries = lines.filter((l) => l.msg === 'latency.summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.fields).toMatchObject({ n: 0, dropped_so_far: 1 });
  });

  it('startLatencyReader ticks on its interval and stop() disarms it', () => {
    const ticks: Array<() => void> = [];
    let cleared = false;
    const reader = startLatencyReader({
      intervalMs: 60_000,
      setIntervalFn: (fn): unknown => { ticks.push(fn); return fn; },
      clearIntervalFn: (): void => { cleared = true; },
    });
    complete('r-tick', 800, 100, 20, null);
    expect(lines.filter((l) => l.msg === 'latency.summary')).toHaveLength(0);
    ticks[0]?.();
    expect(lines.filter((l) => l.msg === 'latency.summary')).toHaveLength(1);
    reader.stop();
    expect(cleared).toBe(true);
  });
});
