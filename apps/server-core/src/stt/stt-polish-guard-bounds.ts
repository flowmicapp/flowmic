// NR118: the unchanged v1 cardinality checks, on ORIGINAL strings even when the
// shadow pre-pass explains a closed-class difference. Kept verbatim and pinned by test.
import { DEFAULT_POLISH_STRENGTH } from '@flowmic/protocol';
import { boundsFor, diffChars, declaredTermAllowance, openClassTokenDelta, stripClosedClassAndPunct, countHan, RATIO_MIN_LEN, type GuardOpts, type GuardResult, type GuardMetrics } from './stt-polish-guard';

export function checkOriginalBounds(rawText: string, polishedText: string, opts: GuardOpts = {}): GuardResult {
  const bounds = boundsFor(opts.strength ?? DEFAULT_POLISH_STRENGTH);
  // §3.1 — cardinality bound (necessary, not sufficient).
  const rawLen = [...rawText].length;
  const polLen = [...polishedText].length;
  const { distance, hunks } = diffChars(rawText, polishedText);
  // The user's own vocabulary, discounted from the budget rather than added to
  // the bound — see GuardOpts.declaredTerms. `allowance` is 0 for every caller
  // that passes no terms, so the legacy calibration is bit-for-bit unchanged
  // wherever this feature is not in play.
  const allowance = opts.declaredTerms && opts.declaredTerms.length > 0
    ? declaredTermAllowance(rawText, polishedText, opts.declaredTerms)
    : 0;
  const editBound = Math.max(bounds.editFloor, bounds.editRatio * rawLen) + allowance;

  // Computed BEFORE the first early return so that every verdict carries the
  // full picture. A rejection that only reports the axis it tripped on cannot
  // answer "was it close on the others too", which is the question calibration
  // actually needs.
  let openClassDelta = 0;
  for (const h of hunks) {
    openClassDelta += openClassTokenDelta(
      stripClosedClassAndPunct(h.rawText),
      stripClosedClassAndPunct(h.polText),
    );
  }
  const metrics: GuardMetrics = {
    distance,
    editBound,
    lengthRatio: polLen / Math.max(1, rawLen),
    openClassDelta,
    openClassK: bounds.openClassK,
  };

  if (distance > editBound) return { ok: false, reason: 'edit-distance-exceeded', metrics };

  if (rawLen >= RATIO_MIN_LEN) {
    // The same allowance applies here, and for the same reason: 「打开飞麦克…」
    // -> 「打开FlowMic…」 grows the string because the declared term is longer
    // than what was misheard. Measured on the production line 2026-08-24 — that
    // exact pair was refused as `length-ratio-exceeded` while being correct.
    // The ratio is judged against a length that already accounts for the term
    // the user asked for; `lengthRatio` in `metrics` stays the RAW measurement,
    // because a metric that quietly reports an adjusted number would make every
    // future calibration read from a value that is not the thing it names.
    const adjustedPolLen = Math.max(1, polLen - allowance);
    const adjustedRatio = adjustedPolLen / Math.max(1, rawLen);
    if (adjustedRatio > bounds.lengthRatioMax || adjustedRatio < bounds.lengthRatioMin) {
      return { ok: false, reason: 'length-ratio-exceeded', metrics };
    }
  }

  const hanRaw = countHan(rawText);
  const hanPol = countHan(polishedText);
  if (Math.abs(hanRaw - hanPol) > editBound) return { ok: false, reason: 'han-count-exceeded', metrics };

  if (openClassDelta > bounds.openClassK) return { ok: false, reason: 'open-class-delta-exceeded', metrics };

  return { ok: true, metrics };
}
