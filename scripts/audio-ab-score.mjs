// RT-6-a — the scoring half of the recognition-layer audio A/B bed.
//
// WHAT THIS MEASURES, AND AT WHICH LAYER. Everything here compares a
// RECOGNITION-LAYER hypothesis (what an STT engine returned for a .wav) against
// the reference script that was actually read aloud. That is a different layer
// from `verify/eval/`, whose cases are *already-transcribed text* — as
// docs/strategy/2026-08-07-rt6-soniox-tradeoff-cards.md says three separate
// times, the existing corpus "can confirm endpoint-detection didn't make the
// downstream pipeline worse, but proving the ASR layer itself didn't lose a word
// needs an audio-based A/B". This file is that missing layer, not a replacement
// for the other one.
//
// ─────────────────────────────────────────────────────────────────────────────
// 1. WHY THE J2 STICK IS PORTED HERE RATHER THAN IMPORTED
// ─────────────────────────────────────────────────────────────────────────────
// The recall metric below (normalise → CJK unigrams + bigrams + ASCII runs →
// set recall) is the J2 measuring stick built in window P2 and independently
// re-calibrated by the P3 controller. Its original lives at
// `.local/n1-eval/segment-score.mjs`.
//
// `.local/` is gitignored. A harness that lives in the repo and imports from
// `.local/` is red in every fresh clone and in CI — i.e. it would be a bed that
// only works on the one machine that happened to run P2. So the mechanism is
// ported. That creates the thing this repo hates most (one question, two
// answers), so the duplication is pinned by a MEASUREMENT rather than by a
// comment asking people to keep them in sync:
//
//   scripts/rt6-audio-ab-eval.test.mjs §2 imports `.local/n1-eval/segment-score.mjs`
//   WHEN IT IS PRESENT and asserts this port returns bit-identical recall on the
//   real corpus scripts. When it is absent the drill still runs the original's
//   own five self-test cases (they use literal inline text, so they need neither
//   the corpus nor the network) and reports the differential as unmeasured.
//
// The P3 calibration this port must keep reproducing (P3 ledger §3-2, 【measured】):
//   identical text            → 1.0000
//   whole segment dropped     → 0.5474   (ref = seg1+seg2, hyp = seg1)
//   wrong segment entirely    → ~0.15    (the "is the stick blind?" control)
//   a comma every 6 chars     → 1.0000   (legitimate re-punctuation, no false red)
//
// ─────────────────────────────────────────────────────────────────────────────
// 2. 🔴 THERE IS NO PASS THRESHOLD ON RECALL, AND ADDING ONE WOULD BE A DEFECT
// ─────────────────────────────────────────────────────────────────────────────
// P2 measured "a legitimate polish" at 0.9513 and "genuinely lost 10% of the
// content" at 0.9218 — about three points apart. Any constant drawn between
// those two either rejects correct output or licenses real content loss. The
// unified ledger's N1-B row therefore records the rule as: per-segment numbers + a human reading of the
// `missing` column. This module honours that literally — `scoreSegment` returns a
// number and the missing points, and NOTHING here converts a recall into a
// verdict. The bed prints, the human reads.
//
// The one mechanical discriminator P3 did establish is about the SHAPE of the
// loss, not its size: a dropped segment shows up as one long contiguous run of
// missing points, while acoustic degradation scatters them. `missingShape()`
// computes that, and it is an AID for the human read — still not a verdict.
//
// ─────────────────────────────────────────────────────────────────────────────
// 3. WHAT RECALL STRUCTURALLY CANNOT SEE (two blind spots, both covered here)
// ─────────────────────────────────────────────────────────────────────────────
// (a) EXTRA TEXT. Recall is deliberately blind to it — that is the whole reason
//     it was chosen over equality, so that punctuation and legitimate rewording
//     do not read as loss. But `no_duplication` is a named acceptance criterion
//     on RT-6 card D1b, and the 0.2.48 Soniox preview defect (the sentence piled
//     up three times) is invisible to recall: duplicated text scores 1.0000.
//     `lenRatio` exists for exactly that direction, and the drill's §5 proves
//     the blindness is real rather than assumed.
// (b) WHICH points were lost. An aggregate recall of 0.97 across 15 segments can
//     be one segment that dropped its only English word — and RT-6's
//     `language_hints_strict` card names that exact hazard: "an aggregate score
//     could pass while silently failing every mixed-language case, so the judge
//     needs a per-case code-switch check, not just a corpus-average number."
//     `spanSurvival()` is that per-case check. It is the ONLY hard verdict in
//     this file, and the bed refuses to let an aggregate average over it.
//
// Deterministic: no clock, no randomness, no network, no I/O.
// Node 22 ESM, builtins only.

// ---------------------------------------------------------------------------
// Normalisation & point extraction — ported from .local/n1-eval/segment-score.mjs
// ---------------------------------------------------------------------------

/** CJK Unified Ideographs + Extension A (enough for spoken Mandarin scripts). */
const CJK_RE = /[㐀-䶿一-鿿]/u;

/**
 * Punctuation / marks stripped on BOTH sides before comparison, plus whitespace.
 * Latin is lower-cased. Kept character-for-character identical to the J2
 * original: the drill's differential assertion is only meaningful if the
 * normalisation is the same, and a "harmless tidy-up" here would silently move
 * every calibrated number.
 */
const STRIP_RE =
  /[\s 　`~!@#$%^&*()_\-+=[\]{}|\\;:'",.<>/?，。！？；：、“”‘’（）【】『』「」《》〈〉…—～·、￥]/gu;

/**
 * @param {string} text
 * @returns {string}
 */
export function normalize(text) {
  if (typeof text !== 'string') return '';
  return text.toLowerCase().replace(STRIP_RE, '');
}

/**
 * The SAME punctuation set as STRIP_RE with the three whitespace characters
 * (`\s`, U+0020, U+3000) removed, and nothing else changed.
 *
 * 🔴 WHY THIS IS A SECOND LITERAL RATHER THAN STRIP_RE MINUS A FEW CHARACTERS.
 * STRIP_RE is pinned character-for-character by the drill's §2 differential
 * against the J2 original; rebuilding it from a shared character-class string
 * would put every calibrated recall number one typo away from moving. So the
 * original literal is not touched, and the relationship between the two is
 * pinned by a MEASURED PROPERTY instead (drill §9):
 *
 *     normalize(s) === normalizeKeepSpace(s).replace(/ /g, '')   for all s
 *
 * Edit one class and not the other and that equality breaks and the drill goes
 * red — which is the check a "keep these in sync" comment cannot be.
 */
const STRIP_KEEP_SPACE_RE =
  /[`~!@#$%^&*()_\-+=[\]{}|\\;:'",.<>/?，。！？；：、“”‘’（）【】『』「」《》〈〉…—～·、￥]/gu;

/**
 * Like normalize(), but WORD BOUNDARIES SURVIVE: punctuation goes, case goes,
 * runs of whitespace collapse to one U+0020, and the result is trimmed.
 *
 * 🔴 WHAT THIS EXISTS FOR — a MEASURED blindness in the metric above, not a
 * tidy-up. `normalize()` deletes whitespace, so `getUserProfile` and
 * `get user profile` are THE SAME STRING to both recall and `spanSurvival()`.
 * That is deliberate and correct for the survival question the hard verdict
 * asks ("did the engine hear the term at all?") and it must not change: an
 * engine that returns "A.P.I." has not lost the span.
 *
 * But RT-6's `context` card turns on a difference that lives exactly there.
 * Measured on the REC-2 corpus (wave-4 lane L, 【measured·dev-pc-b】
 * 2026-08-10, .local/rt6-audio-ab/wave4-L-context-FINDINGS.md §5b): on seg-11
 * the baseline leg wrote the fused `getUserProfile` in 8 of 8 runs and the
 * context leg wrote the spaced `get user profile` in 8 of 8 runs — a perfectly
 * reproducible, zero-variance difference that BOTH primary metrics scored as
 * identical (span 7/7, recall 1.0000 on both legs). For a product whose output
 * is injected verbatim into someone's editor, the word boundary is the thing
 * that lands.
 *
 * ⚠️ This is therefore an ADDITIONAL signal, never a replacement. Nothing here
 * touches `recall`, `kept`, `lost` or `ok` — see `spanSurvival()` on why
 * mutating those would move numbers other conclusions already rest on.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeKeepSpace(text) {
  if (typeof text !== 'string') return '';
  return text.toLowerCase().replace(STRIP_KEEP_SPACE_RE, '').replace(/[\s　]+/gu, ' ').trim();
}

/**
 * The unordered bag of information points used for scoring: every CJK character
 * (coarse coverage), every contiguous CJK bigram (local order / phrase
 * fragments), and every ASCII alphanumeric run as one token (times like "430"
 * from "4:30", latin names, product jargon).
 *
 * First-occurrence order is preserved so `missing` reads in script order for a
 * human. Duplicates collapse — repeated filler must not inflate recall.
 *
 * @param {string} normalized already passed through normalize()
 * @returns {string[]}
 */
export function extractPoints(normalized) {
  const points = [];
  const seen = new Set();
  const push = (p) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    points.push(p);
  };

  let i = 0;
  const s = normalized;
  while (i < s.length) {
    const ch = s[i];
    if (CJK_RE.test(ch)) {
      let j = i + 1;
      while (j < s.length && CJK_RE.test(s[j])) j += 1;
      const run = s.slice(i, j);
      for (let k = 0; k < run.length; k += 1) push(run[k]);
      for (let k = 0; k + 1 < run.length; k += 1) push(run.slice(k, k + 2));
      i = j;
      continue;
    }
    if (/[a-z0-9]/i.test(ch)) {
      let j = i + 1;
      while (j < s.length && /[a-z0-9]/i.test(s[j])) j += 1;
      push(s.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return points;
}

// ---------------------------------------------------------------------------
// Recall (the J2 number itself)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SegmentScore
 * @property {number} recall        hits / reference points. NOT a verdict.
 * @property {string[]} missing     reference points absent from the hypothesis, in script order.
 * @property {number} refPoints
 * @property {number} hitPoints
 */

/**
 * @param {string} reference
 * @param {string} hypothesis
 * @returns {SegmentScore}
 */
export function scoreSegment(reference, hypothesis) {
  const refPts = extractPoints(normalize(reference ?? ''));
  const hypSet = new Set(extractPoints(normalize(hypothesis ?? '')));

  const missing = refPts.filter((p) => !hypSet.has(p));
  const hitPoints = refPts.length - missing.length;
  const refPoints = refPts.length;

  // Vacuous truth: nothing in the reference to lose.
  const recall = refPoints === 0 ? 1 : hitPoints / refPoints;

  return { recall, missing, refPoints, hitPoints };
}

// ---------------------------------------------------------------------------
// Blind spot (a): extra text. Recall cannot see it, by construction.
// ---------------------------------------------------------------------------

/**
 * Normalised-character length of the hypothesis over the reference.
 *
 * 🔴 This is a FLAG, not a judgement, and the number matters more than the
 * boolean. Legitimate recognition output drifts from the read script (inverse
 * text normalisation turns 「四点半」 into 「4:30」, an engine adds or omits
 * filler) so an exact `hyp > ref` rule — which is what verify/eval's
 * `duplicationJudge` uses — would fire constantly here. That rule is correct
 * where it lives, because the merge layer runs before any normalisation and a
 * correct fold has exactly the spoken characters; a raw ASR hypothesis has no
 * such guarantee.
 *
 * DUP_SUSPECT_RATIO is set from the real defect rather than from taste: the
 * 0.2.48 Soniox preview piled one sentence up THREE times (ratio ≈ 3.0), and the
 * worst legitimate drift observed on this corpus is a few percent. 1.5 sits an
 * order of magnitude away from both edges, so it can neither miss the failure
 * shape it exists for nor cry wolf on correct output.
 */
export const DUP_SUSPECT_RATIO = 1.5;

/**
 * @param {string} reference
 * @param {string} hypothesis
 * @returns {{ lenRatio: number, refChars: number, hypChars: number, duplicationSuspect: boolean }}
 */
export function lengthSignal(reference, hypothesis) {
  const refChars = normalize(reference ?? '').length;
  const hypChars = normalize(hypothesis ?? '').length;
  const lenRatio = refChars === 0 ? (hypChars === 0 ? 1 : Infinity) : hypChars / refChars;
  return { lenRatio, refChars, hypChars, duplicationSuspect: lenRatio > DUP_SUSPECT_RATIO };
}

// ---------------------------------------------------------------------------
// Blind spot (b): WHICH points were lost — the per-segment span check
// ---------------------------------------------------------------------------

/** Latin runs of two or more letters. One-letter tokens are noise (a, I). */
const LATIN_RUN_RE = /[A-Za-z]{2,}/gu;

/**
 * Derive the spans a segment must not lose, when the manifest does not state
 * them explicitly: every Latin word in the reference script.
 *
 * WHY THIS DEFAULT IS THE RIGHT ONE FOR RT-6. Two of the four RT-6 cards turn
 * entirely on non-primary-language survival — `language_hints_strict` ("strict
 * may drop the English portion of a mixed utterance entirely — a silent
 * content-loss failure mode") and `context` ("the term is right in Soniox's own
 * final tokens, not just fixed post-hoc by polish"). Both cards state that the
 * required corpus "does not yet exist in the repo". It does now: 5 of the 15
 * segments in `.local/audio-corpus` carry embedded English (API / schema /
 * sprint / FlowMic / Soniox / GitHub / TestFlight / Windows Update …), which is
 * both the code-switch set and the product-jargon set those two cards ask for.
 * Deriving spans from the script means that stays true without anyone
 * hand-authoring a second list that can drift from the audio.
 *
 * A manifest may still override per segment via `required_spans`, and the bed
 * reports which source was used — a derived list is a convenience, and pretending
 * it was authored would overstate the evidence.
 *
 * @param {string} reference
 * @returns {string[]}
 */
export function deriveSpans(reference) {
  const found = String(reference ?? '').match(LATIN_RUN_RE) ?? [];
  const seen = new Set();
  const out = [];
  for (const w of found) {
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/**
 * Did every required span survive into the hypothesis?
 *
 * 🔴 THE ONLY HARD VERDICT IN THIS FILE. Matched on the normalised forms of both
 * sides, so an engine that returns "A.P.I." or "get user profile" with different
 * spacing still counts as having heard it — the question is whether the SPAN
 * SURVIVED, not whether it was punctuated our way. A span that vanished is a
 * fact no amount of corpus averaging may dilute, which is why the bed reports
 * this per segment and refuses to fold it into the aggregate recall.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 THE ADDITIVE `exact` / `respaced` SPLIT, AND WHY IT IS ADDITIVE
 * ─────────────────────────────────────────────────────────────────────────────
 * `kept`, `lost` and `ok` are computed EXACTLY as before and are not touched.
 * Alongside them, `kept` is partitioned by whether the span survived with its
 * word boundaries intact:
 *
 *   exact    — the span is present in the hypothesis with the same internal
 *              spacing as the script (after punctuation/case normalisation).
 *   respaced — the span is only present once whitespace is deleted, i.e. the
 *              engine split or fused it: `getUserProfile` ↔ `get user profile`.
 *
 * WHY NOT JUST FIX `normalize()` SO RECALL SEES IT. Three reasons, in order of
 * weight. (1) Whitespace stripping is LOAD-BEARING for the CJK stick this file
 * ports: the drill's §2 differential against the J2 original and §8's P3
 * calibration (C2 = 0.5474 to four places) are both bit-for-bit assertions
 * against a normalisation that deletes whitespace. Changing it moves every
 * calibrated number and every recall already quoted into the unified ledger.
 * (2) It would make the hard verdict WRONG in the other direction: an engine
 * that returns `get user profile` HAS heard the term, and calling that a lost
 * span would report content loss where there is none — the false-red half of
 * the same defect. (3) A boundary change and a content loss are two different
 * findings with two different next actions, so they get two different columns.
 * The bed reports both; nothing here converts either into a threshold.
 *
 * @param {string} reference
 * @param {string} hypothesis
 * @param {string[]|null} declared spans from the manifest, or null to derive
 * @returns {{ spans: string[], source: 'manifest'|'derived', kept: string[], lost: string[], ok: boolean, exact: string[], respaced: string[] }}
 */
export function spanSurvival(reference, hypothesis, declared = null) {
  const source = Array.isArray(declared) && declared.length > 0 ? 'manifest' : 'derived';
  const spans = source === 'manifest' ? declared.slice() : deriveSpans(reference);
  const hay = normalize(hypothesis ?? '');
  const haySpaced = normalizeKeepSpace(hypothesis ?? '');
  const kept = [];
  const lost = [];
  const exact = [];
  const respaced = [];
  for (const s of spans) {
    const needle = normalize(s);
    if (needle.length > 0 && hay.includes(needle)) {
      kept.push(s);
      // Same substring test, on the boundary-preserving forms of both sides.
      const spacedNeedle = normalizeKeepSpace(s);
      if (spacedNeedle.length > 0 && haySpaced.includes(spacedNeedle)) exact.push(s);
      else respaced.push(s);
    } else lost.push(s);
  }
  return { spans, source, kept, lost, ok: lost.length === 0, exact, respaced };
}

// ---------------------------------------------------------------------------
// Shape of the loss — P3's "one block or a scatter?" discriminator
// ---------------------------------------------------------------------------

/**
 * Classify a `missing` list by shape, using the reference's own point order.
 *
 * P3 ledger §3-2 (【measured】): a low recall has two causes that produce the SAME
 * number and DIFFERENT shapes — a whole segment dropped leaves one long
 * contiguous run of missing points, while acoustic degradation (or an engine
 * mishearing here and there) scatters them evenly. The first question of the
 * human read is therefore "is what is missing a block or a scatter", and this makes that answerable
 * without eyeballing 400 characters.
 *
 * Still an AID, not a verdict — it reports `block` / `scatter` / `mixed` and the
 * numbers behind the call, so a reader can disagree with it.
 *
 * @param {string} reference
 * @param {string[]} missing
 * @returns {{ shape: 'none'|'block'|'scatter'|'mixed', longestRun: number, runs: number, missingCount: number }}
 */
export function missingShape(reference, missing) {
  const refPts = extractPoints(normalize(reference ?? ''));
  const missingSet = new Set(missing);
  let longestRun = 0;
  let cur = 0;
  let runs = 0;
  for (const p of refPts) {
    if (missingSet.has(p)) {
      if (cur === 0) runs += 1;
      cur += 1;
      if (cur > longestRun) longestRun = cur;
    } else {
      cur = 0;
    }
  }
  const missingCount = missing.length;
  if (missingCount === 0) return { shape: 'none', longestRun: 0, runs: 0, missingCount: 0 };
  // Two thirds of the loss sitting in one run reads as a dropped block; loss
  // spread over many short runs reads as degradation. Anything between is
  // reported as `mixed` rather than forced into one of the two.
  const concentration = longestRun / missingCount;
  const shape = concentration >= 0.66 ? 'block' : concentration <= 0.25 ? 'scatter' : 'mixed';
  return { shape, longestRun, runs, missingCount };
}

// ---------------------------------------------------------------------------
// One segment, one leg
// ---------------------------------------------------------------------------

/**
 * Everything this bed knows about one (segment, engine) pair, in one object.
 *
 * @param {string} reference
 * @param {string} hypothesis
 * @param {string[]|null} declaredSpans
 */
export function scoreOne(reference, hypothesis, declaredSpans = null) {
  const base = scoreSegment(reference, hypothesis);
  return {
    ...base,
    length: lengthSignal(reference, hypothesis),
    span: spanSurvival(reference, hypothesis, declaredSpans),
    shape: missingShape(reference, base.missing),
  };
}

/**
 * Micro-average over segments (sum hits / sum reference points), which is the
 * aggregation the J2 original used — a macro-average would let a short segment
 * outvote a long one.
 *
 * 🔴 `spanLossSegments` is carried out of the aggregate as a COUNT of segments,
 * never averaged into a rate. RT-6's `language_hints_strict` card asks for
 * exactly this: the aggregate must not be able to report health while a
 * code-switch case has silently lost its English.
 *
 * 🔴 ZERO SEGMENTS SCORES `null`, NOT 1.0000. Measured on the code as shipped:
 * `refPoints === 0 ? 1 : …` is a vacuous truth that is right for ONE segment
 * whose reference is empty (nothing to lose ⇒ nothing lost) and catastrophically
 * wrong for an EMPTY LIST — a leg where every single segment failed aggregated
 * to a perfect `1.0000`, printed under the heading "micro-avg recall". The
 * drill's own §7 asserted `segments === 0` on that leg and never looked at the
 * recall it was printing beside it. The two cases are separated here because
 * they are different questions: "the reference was empty" has an answer, and
 * "we scored nothing" does not. `null` renders as `n/a`; 1.0000 renders as a
 * result.
 *
 * @param {Array<ReturnType<typeof scoreOne>>} scored
 */
export function aggregate(scored) {
  let hitPoints = 0;
  let refPoints = 0;
  const spanLossSegments = [];
  for (let i = 0; i < scored.length; i += 1) {
    hitPoints += scored[i].hitPoints;
    refPoints += scored[i].refPoints;
    if (!scored[i].span.ok) spanLossSegments.push(i);
  }
  return {
    recall: scored.length === 0 ? null : (refPoints === 0 ? 1 : hitPoints / refPoints),
    refPoints,
    hitPoints,
    segments: scored.length,
    spanLossSegments,
  };
}
