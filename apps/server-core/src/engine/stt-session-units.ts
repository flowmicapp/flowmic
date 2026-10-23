// Card POL-3 — unit polish with read-only context from earlier rows ("two-stage
// polish", stage 1 + stage 2). Design = docs/strategy/2026-10-14-two-stage-polish-
// design.md §2 (D1-D5), §2.6, §2.7, §5, §7, §12.1; contract = book 06 §5, the
// POL-0 block.
//
// THE RULE (D1). One press is a sequence of UNITS: each soft-segment final that
// carries words is one (one row on the phone, book 15 §2.0-c), the terminal final
// (the tail) is the last. Each unit is polished exactly once, as a whole, with the
// text of the units already sent before it as a read-only context block; the guard
// judges only the unit's own words; the wire `polish` mark speaks only for that row.
//
// 🔴 NOT A NEW POLISH PATH. Both stages call the SHIPPED `runPolishedFinal`
// (stt-session-polish.ts) with the session's own context: the same budget, cache,
// guard, Smooth -> Strict fallback, the ONE metering seam (`ctx.meter` =
// `SttSessionBridge.meterPolish`) and the ONE `stt:final` exit. This file only
// chooses the context, frames the request (`PolishDeps.context` / `contextRule` /
// `signal`) and caps the stage-1 hold; the stage-1 terminal strip is SEAM-2's keepOpenEnd.
//
// 🔴 ARMED ONLY BY [[unitPolishFor]]. Absent (FLOWMIC_POLISH_STAGES=legacy, the
// default) the bridge never constructs this class and every request is today's,
// byte for byte. Continuous recordings and recovery legs never arm it, in any mode
// (owner 2026-10-14, `segmentKeepsPreSeg1Contract`).
//
// ⚠️ NO NEW WIRE FIELD. The context, its size, the stage and the cap verdict live
// on the polish clock (`stt.polish.final` log, POL-1 fields) — never in `rest`,
// which is what the bridge spreads onto the frame (test pol3-unit-polish T14).

import { log } from '../log';
import { sentenceEnds } from '../stt/polish-spec-plan';
import { pieceRequest, type ContextRule } from '../stt/stt-polish-piece';
import type { SttSessionDeps } from './stt-session-deps';
import { joinerBetween } from './stt-seam-join';
import { runPolishedFinal, segmentKeepsPreSeg1Contract, type PolishedFinalContext } from './stt-session-polish';

/** Design §2.3 (D2): the most code points of earlier rows one request carries.
 *  A starting point, not a conclusion — §9 sweeps 400 / 800 / 1600. Changing it is a card. */
export const UNIT_CONTEXT_MAX = 800;

/** Design §2.6 (D5): a soft-segment unit waits at most this long, from the moment
 *  its final reaches the bridge, before its row is sent with the raw text and
 *  `polish:'skipped', polish_reason:'timeout'`. Owner ruling 2026-08-07 ②
 *  (docs/decisions/2026-08-07-owner-segment-polish-2s-budget-and-no-legacy-fleet.md).
 *  Changing it is a card (design §8). */
export const SEGMENT_HOLD_CAP_MS = 2_000;

/** The stage-1 request budget is the cap PLUS this, so the request's own abort timer always
 *  expires after the cap timer: two timers at the same millisecond fire in no guaranteed order,
 *  and a request that timed out on its own first would label a row the cap stopped as the first
 *  attempt's guard_reject (measured: pol3-hold-cap flaked under a loaded full run). The retry
 *  rule in polishFinalText reads this budget too, i.e. it is 50 ms more lenient than the cap. */
const HOLD_CAP_TIE_MS = 50;

type UnitBase = Parameters<typeof runPolishedFinal>[2];

/** The row joiner (the server copy of the four-way row-seam rule, book 08 §3) lives in
 *  ./stt-seam-join.ts; re-exported here because [[contextForUnit]] is its consumer. */
export { joinerBetween } from './stt-seam-join';

/** One row of the press, in arrival order. `frozen` is the text committed to the
 *  row's frame (null while its polish is still running). */
export interface LedgerRow {
  readonly raw: string;
  frozen: string | null;
}

export interface UnitContext {
  /** The read-only context to send (may be ''). */
  text: string;
  /** The window includes a row whose polish had not finished: its RAW text stood in. */
  pending: boolean;
}

/**
 * Design §2.3 (D2) — the context of the next unit, a PURE function of the rows
 * before it: each row's frozen text (what its frame carries: the polished text if
 * accepted, the raw text if skipped), or its raw text while its polish is still
 * running (never waited for); joined by [[joinerBetween]]; then the last
 * `max` code points, the start moved forward to the next sentence start when the
 * cut fell inside a sentence (polish-spec-plan.ts `sentenceEnds`), or left at the
 * code-point cut when no sentence starts inside the window.
 */
export function contextForUnit(earlier: readonly LedgerRow[], max: number = UNIT_CONTEXT_MAX): UnitContext {
  let joined = '';
  const ends: { end: number; pending: boolean }[] = [];
  for (const row of earlier) {
    const t = row.frozen ?? row.raw;
    if (t === '') continue;
    joined = joined === '' ? t : joined + joinerBetween(joined, t) + t;
    ends.push({ end: joined.length, pending: row.frozen === null });
  }
  const cps = [...joined];
  let start = 0;
  if (cps.length > max) {
    start = cps.slice(0, cps.length - max).join('').length;
    const atSentence = sentenceEnds(joined, 0, true).find((e) => e >= start && joined.slice(e).trim() !== '');
    if (atSentence !== undefined) start = atSentence;
    while (start < joined.length && /\s/u.test(joined[start]!)) start += 1;
  }
  return { text: joined.slice(start), pending: ends.some((r) => r.pending && r.end > start) };
}

// The stage-1 terminal strip is NOT here: since the SEAM-2 merge it is ONE implementation,
// stt/seam-artifact.ts `keepOpenEnd` (only one added "." or "。", never ?/!/…, never a dot
// that belongs to a word, never after a dictated end command), applied by
// `runPolishedFinal` when its `openEnd` argument is true. A context-mode stage-1 row
// always passes true (design §2.4 D3: every row cut while the speaker talks is open).

function cpLen(s: string): number { return [...s].length; }

/**
 * The bridge's unit polisher for ONE press. Holds the frozen ledger; every method
 * is reached from a one-line delegation in stt-session.ts.
 */
export class UnitPolish {
  private readonly rows: LedgerRow[] = [];

  /**
   * Stage 1 — a soft-segment unit. `fill` is the outbox slot the bridge reserved
   * for this row; it is filled EXACTLY ONCE, with the first of:
   *   · the polish answered within [[SEGMENT_HOLD_CAP_MS]] ⇒ its text (a terminal
   *     mark it added stripped) and its honest wire signal;
   *   · the cap fired ⇒ the request is cancelled and the row leaves with the RAW
   *     text + `polish:'skipped', polish_reason:'timeout'`. A later answer is never
   *     emitted (R11: that row's frame already said what it carries). It is still
   *     metered when it reports usage — `runPolishedFinal` calls the one meter
   *     before its emit, and an answered request is cost whatever we did with it
   *     (owner 2026-10-14 Q1, 「记成本不记判决」); a cancelled request that
   *     reported no usage is not metered (`meterPolish` returns on absent usage).
   *   · the session was torn down mid-polish ⇒ an empty frame (today's rule).
   * The row's text is frozen in the ledger at that same moment: what the slot was
   * filled with is what its frame carries (the outbox runs filled frames in order
   * and never edits them).
   */
  segment(ctx: PolishedFinalContext, pure: string, base: UnitBase, fill: (frame: () => void) => void): void {
    const row: LedgerRow = { raw: pure, frozen: null };
    const context = contextForUnit(this.rows);
    this.rows.push(row);
    const ctrl = new AbortController();
    const polish = this.request(ctx, pure, context, 'unit-open', ctrl.signal, SEGMENT_HOLD_CAP_MS);
    let decided = false;
    const commit = (text: string, rest: Record<string, unknown>, capHit: boolean): void => {
      decided = true;
      clearTimeout(cap);
      row.frozen = text;
      if (ctx.clock !== undefined) ctx.clock.holdCapHit = capHit;
      fill(() => ctx.emitFinal(text, rest));
    };
    const cap = setTimeout(() => {
      if (decided) return;
      ctrl.abort();
      commit(pure, { ...base, polish: 'skipped', polish_reason: 'timeout' }, true);
    }, SEGMENT_HOLD_CAP_MS);
    void runPolishedFinal(
      {
        ...ctx,
        polish,
        emitFinal: (text, rest): void => {
          if (decided) return; // after the cap: never emitted (logged once, as late_after_cap, by runPolishedFinal)
          // hold_cap_hit says the CAP fired, nothing else: a provider-side timeout that answered first is
          // skipped/timeout with hold_cap_hit false (the cap timer is armed before the request, so at
          // equal deadlines the cap fires first and takes the branch above).
          commit(text, rest, false); // runPolishedFinal already applied keepOpenEnd (openEnd = true below)
        },
        kickRefine: (): void => undefined, // the second pass smooths the terminal utterance only (SEG-1)
      },
      pure,
      base,
      true, // stage 1: the row is open — the one strip, stt/seam-artifact.ts keepOpenEnd
    ).catch((err: unknown) => {
      log.error('stt.polish unit segment failed unexpectedly', { error: err instanceof Error ? err.message : String(err) });
    }).finally(() => {
      if (!decided) { decided = true; clearTimeout(cap); fill(() => undefined); }
    });
  }

  /**
   * Stage 2 — the tail, after the release. Context = every earlier row; a row whose
   * polish has not finished is NOT waited for — its raw text stands in and the clock
   * records `ctx_pending:true` (design §2.3, F7). Budget unchanged (`polishBudgetMs`,
   * no hold cap): this is today's terminal call plus a context block. An arrow
   * property so the bridge can pick it in place of `runPolishedFinal` in one line.
   */
  readonly tail = (ctx: PolishedFinalContext, pure: string, base: UnitBase): Promise<void> =>
    runPolishedFinal({ ...ctx, polish: this.request(ctx, pure, contextForUnit(this.rows), 'unit') }, pure, base);

  /** The polish dep for one unit, and the clock's context fields (measured, so
   *  present — a unit with no earlier rows records 0, not absence). The context
   *  is only attached when non-empty: an empty one leaves the deps exactly as the
   *  session built them, so the request is today's. */
  private request(ctx: PolishedFinalContext, pure: string, context: UnitContext, rule: ContextRule, signal?: AbortSignal, capMs?: number): PolishedFinalContext['polish'] {
    const sent = pieceRequest(pure.trim(), context.text).withContext;
    if (ctx.clock !== undefined) ctx.clock.ctx = { chars: sent ? cpLen(context.text.trim()) : 0, pending: sent && context.pending };
    const deps = ctx.polish.deps ?? {};
    return {
      ...ctx.polish,
      deps: {
        ...deps,
        ...(sent ? { context: context.text, contextRule: rule } : {}),
        ...(signal !== undefined ? { signal } : {}),
        // Stage 1: the whole call, Smooth -> Strict retry included, lives inside the hold cap. With
        // `budgetMs` at the cap, polishFinalText skips the retry when less than POLISH_FALLBACK_MIN_MS
        // is left (the row is then skipped/guard_reject, not a timeout the cap would mint later).
        ...(capMs !== undefined ? { budgetMs: Math.min(deps.budgetMs ?? capMs + HOLD_CAP_TIE_MS, capMs + HOLD_CAP_TIE_MS) } : {}),
      },
    };
  }
}

/**
 * The ONE arming rule. A unit polisher exists for a session only when every
 * condition holds: FLOWMIC_POLISH_STAGES=context was snapshotted at audio:start
 * (`deps.polishStages`, written by engine/stt-factory.ts); polish is armed; the
 * delivery is `'sync'` (the shipped mode — `'detached'` has no segment path);
 * the INC-1 speculation is not armed (the boot refuses both switches together;
 * this is the session-level half of that rule); and the session is on the SEG-1
 * contract — continuous recordings and recovery legs keep today's behaviour.
 * All modes: translate and organize polish their finals too (design §7 F10).
 */
export function unitPolishFor(deps: Pick<SttSessionDeps, 'polishStages' | 'polish' | 'polishDelivery' | 'polishSpeculative' | 'continuous' | 'recoveryLeg'>): UnitPolish | null {
  const armed = deps.polishStages === 'context' && deps.polish !== undefined && (deps.polishDelivery ?? 'sync') === 'sync'
    && deps.polishSpeculative !== true && !segmentKeepsPreSeg1Contract(deps);
  return armed ? new UnitPolish() : null;
}
