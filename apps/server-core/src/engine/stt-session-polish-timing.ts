// Card INC-1c (design docs/strategy/2026-10-13-realtime-polish-while-speaking-design.md
// §5.4, §9 item 5) — how long a polished final waited, measured on the bridge's
// own clock and reported once per polished final. Observation only: nothing here
// can change a text, a wire field or the order of frames.
//
// Two numbers, split at the moment the final reaches the bridge:
//   · engine_final_ms — audio:stop (or the auto-stop) → the TERMINAL final
//     reaches the bridge, i.e. the engine's share of the release wait;
//   · wait_ms — that final reaches the bridge → its `stt:final` leaves the
//     ordered outbox. For a soft-segment final this is the HOLD that SEG-1
//     introduced (everything behind it waits too); for the terminal final it is
//     `polish_wait_ms` on `latency.segment`.
// Both are ABSENT, never 0, when unknown (no stop seen, polish not run).
//
// Card POL-1 (design docs/strategy/2026-10-14-two-stage-polish-design.md §4.1,
// §10) adds four fields to `stt.polish.final`, again observation only:
//   · stage — 'segment' (a soft-segment final), 'tail' (the terminal final of a
//     press in which at least one soft segment carrying words reached the bridge
//     first), 'whole' (the terminal final of a press that was never cut). Always
//     present: it is decided from facts this tally holds, not measured.
//   · ctx_chars / ctx_pending — preceding-text characters sent with this unit's
//     polish request, and whether that text was a row still being polished.
//     Today no request carries preceding text (card POL-3 adds it), so both are
//     ABSENT. A measured 0 ("context was empty") and "not measured" are two
//     different answers; writing 0 for the second would make them one.
//   · hold_cap_hit — whether a segment hold was cut short by a hold cap. No cap
//     exists today, so ABSENT.

import { log } from '../log';
import { tcorr } from '../obs/utterance-timing';

/** What the speculative path adds to one emitted final (INC-1f). Absent on the
 *  whole-text path. */
export interface SpecStats {
  /** Characters of the final served from a result requested while speaking. */
  hitChars: number;
  /** Characters polished after the final arrived (gaps + tail). */
  releaseChars: number;
  /** Background requests this segment made / finished unused / refused by the guard. */
  calls: number;
  unusedCalls: number;
  rejectedCalls: number;
}

/** The terminal final's numbers, for `latency.segment` (obs/latency.ts `markPolishTiming`). */
export interface TerminalPolishTiming {
  engine_final_ms?: number;
  polish_wait_ms: number;
  polish_path: 'whole' | 'spec';
  /** Delivered characters: the report buckets the wait by length (design §5.4). */
  polish_chars: number;
  spec_hit_chars?: number;
  release_chars?: number;
  spec_calls?: number;
  spec_unused_calls?: number;
  spec_rejected_calls?: number;
}

/** Card POL-1 — which unit of the press this polished final is (header above). */
export type PolishStage = 'segment' | 'tail' | 'whole';

/** Card POL-1 — the preceding text one unit's request carried. Set only by a path
 *  that actually sent preceding text; absent ⇒ the record omits both fields. */
export interface PolishContextStats {
  chars: number;
  /** The preceding text included a row whose own polish had not finished. */
  pending: boolean;
}

/** One polished final in flight: created when it reaches the bridge. */
export interface PolishClock {
  readonly isSegment: boolean;
  readonly stage: PolishStage;
  readonly arrivedAt: number;
  /** Set by the polish path when the speculative assembly answered (INC-1f). */
  spec?: SpecStats;
  /** Card POL-1 — absent until a request carries preceding text (card POL-3). */
  ctx?: PolishContextStats;
  /** Card POL-1 — absent until a segment hold has a cap that can fire. */
  holdCapHit?: boolean;
}

export class PolishTimingTally {
  private stopAt: number | null = null;
  /** Card POL-1 — soft segments carrying words seen on this press, polished or not. */
  private segments = 0;

  constructor(
    private readonly now: () => number,
    private readonly report?: (t: TerminalPolishTiming) => void,
  ) {}

  /** audio:stop / auto-stop. First one wins: both endings may be seen. */
  noteStop(): void { this.stopAt ??= this.now(); }

  /** Card POL-1 — a soft-segment final carrying words reached the bridge. Counted
   *  whether or not it is polished (continuous recordings keep segments bare), so
   *  a cut press's terminal final is `tail` on every path. */
  noteSegment(): void { this.segments += 1; }

  begin(isSegment: boolean): PolishClock {
    const stage: PolishStage = isSegment ? 'segment' : this.segments > 0 ? 'tail' : 'whole';
    return { isSegment, stage, arrivedAt: this.now() };
  }

  /** Called right after the final's frame left the bridge. */
  emitted(clock: PolishClock, utteranceId: string | undefined, chars: number): void {
    try {
      const waitMs = Math.max(0, this.now() - clock.arrivedAt);
      const engineMs = !clock.isSegment && this.stopAt !== null ? Math.max(0, clock.arrivedAt - this.stopAt) : undefined;
      const s = clock.spec;
      log.info('stt.polish.final', {
        tcorr: tcorr(utteranceId), is_segment: clock.isSegment, path: s ? 'spec' : 'whole', wait_ms: waitMs,
        engine_final_ms: engineMs ?? null, chars,
        spec_hit_chars: s?.hitChars ?? null, release_chars: s?.releaseChars ?? null,
        spec_calls: s?.calls ?? null, spec_unused_calls: s?.unusedCalls ?? null, spec_rejected_calls: s?.rejectedCalls ?? null,
        ...polishUnitFields(clock),
      });
      if (clock.isSegment || this.report === undefined) return;
      this.report({
        ...(engineMs !== undefined ? { engine_final_ms: engineMs } : {}),
        polish_wait_ms: waitMs,
        polish_path: s ? 'spec' : 'whole',
        polish_chars: chars,
        ...(s ? { spec_hit_chars: s.hitChars, release_chars: s.releaseChars, spec_calls: s.calls, spec_unused_calls: s.unusedCalls, spec_rejected_calls: s.rejectedCalls } : {}),
      });
    } catch { /* Observation cannot change the final. */ }
  }
}

/** Card POL-1 — the unit fields of `stt.polish.final`. An unmeasured field is
 *  OMITTED (not null, not 0): the record answers "not measured" by not having it. */
export function polishUnitFields(clock: PolishClock): Record<string, string | number | boolean> {
  return {
    stage: clock.stage,
    ...(clock.ctx !== undefined ? { ctx_chars: clock.ctx.chars, ctx_pending: clock.ctx.pending } : {}),
    ...(clock.holdCapHit !== undefined ? { hold_cap_hit: clock.holdCapHit } : {}),
  };
}
