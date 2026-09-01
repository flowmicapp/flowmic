// F-2 — FunASR span closure (Fix A) and pause-cut covering-offline wait (Fix B).
//
// WHY Fix A: the billing VadGate (`shouldFeedEngine: () => vad.open`) starves
// the engine of post-hangover silence (pinned in stt-funasr-gate-starvation.test.ts).
// Probe T2_linger: 300 ms gaps ⇒ one ~62 s span, offlines only after flush.
// Probe T2_gaps1000: 1000 ms gaps ⇒ one offline per sentence, mid-stream.
// 600 ms (MIN_PAUSE_MS) was unprobed, so we feed the measured full second.
//
// ENGINE ONLY, never the session buffer/seq — same invariant as
// feedVadClosureSilence. Billing is vad.sessionMs (stt-session.ts settle),
// which this path never touches.

import type { SttEngine } from './engines/base';
import { MIN_PAUSE_MS } from './segment-boundary';
import { feedRuntimeSpanClosureSilence, isFunasrFlushFamily } from './flush-final';

export type SpanClosureEngine = (SttEngine & { state?: string }) | null;

/** Pause-cut rows wait this long for a covering FunASR 2pass-offline. Probe
 *  T2_gaps1000 last offline was +823 ms after flush; 800 ms is the product
 *  bound, not a claim that every runtime meets it. */
export const PAUSE_OFFLINE_WAIT_MS = 800;

export class FunasrSpanClosureFeeder {
  private sawOpen = false;
  private fedThisEpisode = false;
  private foldWaiters: Array<() => void> = [];

  reset(): void {
    this.sawOpen = false;
    this.fedThisEpisode = false;
    const pending = this.foldWaiters.splice(0);
    for (const fn of pending) fn();
  }

  /** Gate is open this chunk — the next closure is a new episode. */
  noteOpen(): void {
    this.sawOpen = true;
    this.fedThisEpisode = false;
  }

  /**
   * Once per close-after-voice episode, when the gate has been continuously
   * closed for {@link MIN_PAUSE_MS}, push ~1 s of s16le zeros to a FunASR-family
   * engine. A never-opened gate (silence from the start) does not feed — there
   * is no span to close. Deepgram/Soniox are not in the family.
   */
  noteClosed(engine: SpanClosureEngine, nowMs: number, gateClosedMs: number): void {
    if (!this.sawOpen || this.fedThisEpisode) return;
    if (gateClosedMs < MIN_PAUSE_MS) return;
    if (!isFunasrFlushFamily(engine?.id ?? '')) return;
    feedRuntimeSpanClosureSilence(engine, nowMs);
    this.fedThisEpisode = true;
  }

  /** An engine `final` just folded into offlineAccum. Unblocks a pause-cut wait. */
  notifyFold(): void {
    const w = this.foldWaiters.splice(0);
    for (const fn of w) fn();
  }

  /**
   * F-2 Fix B. No-op when disabled (not FunASR) or the covering offline is
   * already in the accumulators. Otherwise wait until {@link notifyFold} or
   * `timeoutMs` (default {@link PAUSE_OFFLINE_WAIT_MS}).
   */
  waitForCoveringOffline(opts: {
    enabled: boolean;
    alreadyCovered: boolean;
    timeoutMs?: number;
    setTimeoutFn: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn: (handle: unknown) => void;
  }): Promise<void> {
    if (!opts.enabled || opts.alreadyCovered) return Promise.resolve();
    const timeoutMs = opts.timeoutMs ?? PAUSE_OFFLINE_WAIT_MS;
    return new Promise((resolve) => {
      let settled = false;
      let timer: unknown;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        opts.clearTimeoutFn(timer);
        resolve();
      };
      timer = opts.setTimeoutFn(finish, timeoutMs);
      this.foldWaiters.push(finish);
    });
  }
}
