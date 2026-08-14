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
  markSttFinal,
  markInjectRequest,
  markInjectResult,
  __resetLatencyState,
  __droppedCount,
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
