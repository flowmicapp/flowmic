// Card CR-Q (owner 2026-08-29) — the monthly budget is RE-READ during a
// recording instead of being snapshotted once at audio:start.
//
// ── WHY THE CARD EXISTS (measured before the change) ─────────────────────────
// `engine/stt-factory.ts` reads `quota.remainingSttMs(userId)` once and hands it
// to `AudioSession.setQuotaBudgetMs`; usage is only written at settle. For a
// two-second utterance that snapshot cannot go stale. Owner's continuous
// transcription runs up to 30 minutes per session, which turns the same code
// into a half-hour window where the same account on a second device reads and
// spends the same remaining minutes, each believing it has all of them.
//
// ── WHAT IS PINNED HERE, AND WHAT IS NOT ────────────────────────────────────
// This file drives `AudioSession` directly with a fake clock, because the unit
// under test is the refresh RULE: when it reads, when it refuses to, and what it
// does with the answer. Whether the orchestrator calls it at the right moment is
// a different claim with a different home — `stt-engine-session-rollover.test.ts`
// owns leg birth — and the call site carries its own reasoning.
//
// 🔴 NOT PINNED, and stated so nobody reads a green file as more than it is:
// two recordings running AT THE SAME TIME still both read a remainder neither
// has spent yet, so they can still overspend together. The refresh narrows the
// exposure from "a whole session" to "until the other session settles"; closing
// it needs in-flight reservation accounting. See setQuotaRefresher's doc.

import { describe, expect, it } from 'vitest';
import { AUDIO_DEFAULTS } from '@flowmic/protocol';
import { AudioSession, DEFAULT_QUOTA_REFRESH_FLOOR_MS } from '../src/stt/audio/session';
import { FakeClock, T0 } from './fixtures/stt-outage-harness';

/** An AudioSession on a fake clock, with a counting budget reader.
 *
 *  🔴 The array is what the REFRESH reads answer, in order — NOT the opening
 *  declaration. Each test calls `setQuotaBudgetMs` itself, because 「what we were
 *  told at the start」 and 「what we are told later」 are the two facts every
 *  assertion here is about and folding them into one list hid that once already.
 *
 *  `hardLimitMs` is left at its default (5 min) on purpose: the engine ceiling
 *  is the OTHER deadline, and a refresh that accidentally armed that one instead
 *  would still look like "a timer fired" without this. */
function makeSession(refreshAnswers: number[], opts: { floorMs?: number } = {}) {
  const clock = new FakeClock(T0);
  const reads: number[] = [];
  let i = 0;
  const session = new AudioSession({
    now: clock.nowFn,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  });
  const read = (): number => {
    const v = refreshAnswers[Math.min(i, refreshAnswers.length - 1)]!;
    reads.push(v);
    i += 1;
    return v;
  };
  return { clock, session, reads, read };
}

const MIN = 60_000;

describe('CR-Q — the budget is re-read, on a floor, at leg birth', () => {
  it('reads at most once per floor window, however often legs are born', async () => {
    const { clock, session, reads, read } = makeSession([20 * MIN]);
    session.setQuotaBudgetMs(20 * MIN);
    session.setQuotaRefresher(read);
    session.start();

    // 🔴 THE SHAPE THE FLOOR EXISTS FOR. Legs are born on SPEECH boundaries —
    // sentence ends and real pauses — so a talkative recording can birth one
    // every few seconds. Ten seconds of "every second, a new leg":
    for (let s = 0; s < 10; s += 1) {
      await clock.advance(1_000);
      session.refreshQuotaBudget();
    }
    expect(reads).toEqual([]); // …and not one database read has happened.

    // One floor in, exactly one read — not ten queued up.
    await clock.advance(DEFAULT_QUOTA_REFRESH_FLOOR_MS);
    session.refreshQuotaBudget();
    session.refreshQuotaBudget();
    session.refreshQuotaBudget();
    expect(reads).toHaveLength(1);
  });

  it('the declaration counts as the first read (a cold-open leg does not re-ask)', () => {
    const { session, reads, read } = makeSession([20 * MIN]);
    session.setQuotaBudgetMs(20 * MIN);
    session.setQuotaRefresher(read);
    session.start();
    // The cold open is a leg birth too, and it happens the instant after the
    // declaration. Re-reading there would spend a query to re-confirm a number
    // nothing could have changed yet.
    session.refreshQuotaBudget();
    expect(reads).toEqual([]);
  });

  it('a budget that shrank moves the deadline in, and auto-stops on quota', async () => {
    // Opens with 20 minutes; by the time we look again another device has
    // settled 18 of them. The remaining 2 are measured from the session's OWN
    // start (never re-anchored), so the deadline is already behind us.
    const { clock, session, read } = makeSession([2 * MIN]);
    session.setQuotaBudgetMs(20 * MIN);
    session.setQuotaRefresher(read);
    const stopped: string[] = [];
    session.on('auto_stopped', (r: string) => stopped.push(r));
    session.start();

    await clock.advance(3 * MIN);
    expect(stopped).toEqual([]); // 3 min in, 20 min of budget: nothing is due.

    session.refreshQuotaBudget();
    await clock.advance(1);
    expect(stopped).toEqual(['hard_limit']);
    // 🔴 AND IT MUST BE THE BILLING CEILING THAT FIRED, not the engine one. The
    // two want opposite things (「录满了，再按一次」 vs 「这个月没额度了」) and
    // the phone picks its sentence from this value — borrowing the wrong one is
    // the W8-4 defect, which this card must not re-create.
    expect(session.limitOrigin).toBe('quota_budget');
  });

  it('a budget that did NOT move leaves the armed deadline exactly where it was', async () => {
    // The ordinary case: nothing else settled, so the read returns the same
    // number. Re-arming here would be harmless but pointless work on every
    // floor tick of every session; asserting it keeps that honest.
    const { clock, session, read } = makeSession([20 * MIN]);
    session.setQuotaBudgetMs(20 * MIN);
    session.setQuotaRefresher(read);
    const stopped: string[] = [];
    session.on('auto_stopped', (r: string) => stopped.push(r));
    session.start();

    await clock.advance(DEFAULT_QUOTA_REFRESH_FLOOR_MS + 1);
    session.refreshQuotaBudget();
    await clock.advance(18 * MIN);
    expect(stopped).toEqual([]); // ~19 min in, against a 20-minute budget
    await clock.advance(2 * MIN);
    expect(stopped).toEqual(['hard_limit']);
    expect(session.limitOrigin).toBe('quota_budget');
  });

  it('no ceiling ⇒ not one read (standalone / unmetered pays nothing)', async () => {
    const { clock, session, reads, read } = makeSession([20 * MIN]);
    // No setQuotaBudgetMs: this session never had a billing ceiling.
    session.setQuotaRefresher(read);
    session.start();
    await clock.advance(10 * DEFAULT_QUOTA_REFRESH_FLOOR_MS);
    session.refreshQuotaBudget();
    expect(reads).toEqual([]);
  });

  it('an infinite answer leaves the existing ceiling alone (it does not lift it)', async () => {
    const { clock, session, read } = makeSession([Number.POSITIVE_INFINITY]);
    session.setQuotaBudgetMs(20 * MIN);
    session.setQuotaRefresher(read);
    const stopped: string[] = [];
    session.on('auto_stopped', (r: string) => stopped.push(r));
    session.start();
    await clock.advance(DEFAULT_QUOTA_REFRESH_FLOOR_MS + 1);
    session.refreshQuotaBudget();
    // Mid-recording is not the moment to invent an unbounded session out of a
    // reading we cannot explain — the declared ceiling stands and still fires.
    await clock.advance(21 * MIN);
    expect(stopped).toEqual(['hard_limit']);
  });

  it('NaN throws rather than reading as "no ceiling"', async () => {
    const { clock, session, read } = makeSession([Number.NaN]);
    session.setQuotaBudgetMs(20 * MIN);
    session.setQuotaRefresher(read);
    session.start();
    await clock.advance(DEFAULT_QUOTA_REFRESH_FLOOR_MS + 1);
    // A broken meter must be loud. The call site catches it, keeps the previous
    // budget and logs — what must never happen is a NaN quietly becoming
    // `!Number.isFinite` and therefore "unmetered".
    expect(() => session.refreshQuotaBudget()).toThrow(TypeError);
  });

  it('a throwing reader does not stop the recording (the caller owns that)', async () => {
    const clock = new FakeClock(T0);
    const session = new AudioSession({
      now: clock.nowFn,
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
    });
    session.setQuotaBudgetMs(20 * MIN);
    session.setQuotaRefresher(() => { throw new Error('db is having a moment'); });
    const stopped: string[] = [];
    session.on('auto_stopped', (r: string) => stopped.push(r));
    session.start();

    await clock.advance(DEFAULT_QUOTA_REFRESH_FLOOR_MS + 1);
    // It propagates — this class has no honest place to log — and the previous
    // budget is untouched, so a database hiccup costs a query, not a meeting.
    expect(() => session.refreshQuotaBudget()).toThrow();
    await clock.advance(10 * MIN);
    expect(stopped).toEqual([]);
    await clock.advance(11 * MIN);
    expect(stopped).toEqual(['hard_limit']);
  });

  it('refuses installation after start, like the declaration it accompanies', () => {
    const { session, read } = makeSession([20 * MIN]);
    session.setQuotaBudgetMs(20 * MIN);
    session.start();
    expect(() => session.setQuotaRefresher(read)).toThrow(/illegal call from recording/);
  });

  it('does nothing once the recording is over', async () => {
    const { clock, session, reads, read } = makeSession([1 * MIN]);
    session.setQuotaBudgetMs(20 * MIN);
    session.setQuotaRefresher(read);
    session.start();
    await clock.advance(DEFAULT_QUOTA_REFRESH_FLOOR_MS + 1);
    session.stop();
    session.refreshQuotaBudget();
    expect(reads).toEqual([]);
  });

  it('the engine ceiling is untouched by any of this', () => {
    // Sanity, and it is not decoration: the refresh re-arms through the same
    // act that picks the origin, so a bug there would show up as the ENGINE
    // deadline moving. This pins the constant it must keep resolving to.
    expect(AUDIO_DEFAULTS.hard_limit_ms).toBe(300_000);
  });
});
