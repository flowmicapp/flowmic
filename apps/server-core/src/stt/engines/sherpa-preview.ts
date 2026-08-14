// SPEC-REF:
//   docs/strategy/spikes/sherpa-onnx-spike.md §6.2 (interim strategy: recommendation
//     A = batch final-only; the "optional enhancement" paragraph = VAD
//     sub-segmentation, linear cost, "segmented quasi-streaming" — this file is
//     that enhancement)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (interim = offlineAccum + onlineDraft)
//   docs/strategy/2026-08-12-owner-nine-requirements-backlog.md REQ-12-05
//
// Incremental preview decoding for the built-in offline engine.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// SenseVoice is a whole-utterance offline encoder, so `sherpa-local` emits ONE
// `final` at flush and no `interim` at all. Measured consequence (device-line,
// 2026-08-12, frozen 0.2.61): while the user holds the button the phone shows
// "Transcribing Ns…" with an EMPTY body for the entire hold, then the whole sentence
// lands at once. That is owner requirement REQ-12-05.
//
// ── WHY NOT THE TWO OBVIOUS ALTERNATIVES ─────────────────────────────────────
// The spike weighed "rolling window pseudo-streaming" (re-decode the WHOLE
// growing buffer every 300-500 ms) and rejected it on four grounds, of which one
// is fatal and still true: it is O(n²) — a 30 s utterance re-decoded every 400 ms
// is ~75 stacked full decodes. This module keeps the growing-preview UX but pays
// LINEAR cost, because it re-decodes only the CURRENT UNCOMMITTED TAIL and
// freezes each tail into text at a silence boundary, where the split is safe.
//
// Swapping the model for a streaming one (OnlineRecognizer + streaming zipformer)
// is the other real option. It is a product decision — different model, different
// download, different Chinese quality — and it belongs with REQ-12-06, not here.
//
// ── WHAT THIS DOES NOT TOUCH ─────────────────────────────────────────────────
// 🔴 The terminal transcript. `flush()` still decodes the entire utterance buffer
// from scratch, exactly as before, and that decode is what becomes the user's
// text. Everything here feeds `interim` only. A preview that is wrong, late, or
// absent must never be able to change the sentence the user actually gets — this
// is an ENHANCEMENT, and the repo's standing rule for enhancements is that every
// failing link degrades to the status quo (today's behaviour: no interim), never to a new
// worse state.
//
// ── THE SELF-DISABLE BUDGET IS LOAD-BEARING, NOT DEFENSIVE DECORATION ────────
// `rec.decode()` is a SYNCHRONOUS native call: it blocks the sidecar's event
// loop, which is the same loop carrying the socket, the heartbeat and the
// injection path. Today that block happens once per utterance (at flush). This
// module adds blocks DURING the hold, so a machine slow enough to make them
// expensive must stop paying: repeated decodes over `budgetMs` disable previews
// for the rest of the utterance and say so. The spike measured RTF≈0.035 on a
// high-end desktop and ESTIMATED ≤0.4 on a weak CPU — a 12 s tail at 0.4 is
// ~4.8 s of blocked event loop, which is why the ceiling is enforced by
// measurement here rather than by trusting the estimate.
//
// 🔴 2026-08-12 — TWO DEFECTS THIS FILE SHIPPED WITH, BOTH FIXED BELOW, BOTH OF
// WHICH PRODUCED THE SAME OBSERVED SHAPE: exactly one interim of ~1 character
// and then silence for the rest of the hold (device-line, LAN leg, with the
// preview present). Kept here because the shape is generic, not sherpa's:
//
//   ① THE FIRST DECODE FIRED ON THE FIRST CHUNK. `lastDecodeAt` started at
//      -Infinity, so the cadence check was vacuous for tick #1 and the tail
//      handed to the recognizer was ONE 200 ms chunk. SenseVoice given 200 ms
//      returns a character or two of noise — which is literally the `chars:1`
//      the wire instrument recorded. A cadence says HOW OFTEN we may block the
//      loop; it never said HOW MUCH AUDIO is worth blocking it for, and those
//      are two different questions. `minTailMs` now answers the second.
//
//   ② ONE SLOW DECODE WAS TREATED AS A PERMANENT VERDICT ON THE MACHINE. The
//      first `rec.decode()` after a recognizer is loaded pays that model's
//      one-time initialisation (ONNX arena, thread pool, first graph run) —
//      a cost that BY CONSTRUCTION cannot repeat. Judging the steady state on
//      a measurement of a one-off is not a conservative reading, it is a
//      measurement of the wrong thing; the same is true of a GC pause or an OS
//      hiccup. The budget now needs `budgetStrikes` CONSECUTIVE overruns, so
//      the verdict rests on something that has actually shown it repeats.
//      ⚠️ The ceiling itself is unchanged: a genuinely slow machine still
//      stands down, it just pays one more decode to prove it.
//
// 🔴 2026-08-12 (INT-1) — ③ THE WALL WAS FLAT, AND COST IS NOT. The budget above
// shipped as a single 300 ms number applied to every decode regardless of how
// much audio that decode covered. Round 2 came back with the first real readings
// this file has ever had (scratch/r7-req1205-round2-2026-08-12.md §2-1,
// dev-pc-a — the owner's own development machine, not a weak CPU):
//
//     maxDecodeMs  132 @  5.04 s audio
//     maxDecodeMs  301 @ 11.04 s audio
//     maxDecodeMs  320 @ 17.04 s audio   ⇒ 「live preview disabled {strikes:2}」
//
// Those three numbers say ONE thing very clearly: 132/5.04 ≈ 301/11.04 ≈
// 320/12.0 ≈ RTF 0.027 — cost is LINEAR IN THE DECODED TAIL, exactly as the
// design assumed, and this machine is performing exactly as specified. What
// tripped was not slowness. It was LENGTH. A flat wall makes one number answer
// two questions — 「is this machine too slow?」 (what the budget exists for) and
// 「is this utterance long?」 (ordinary use) — which is this repo's #1 defect
// shape, and the second question is the one it was actually answering: on this
// machine any tail past ~11 s trips it, and the tail ceiling is 12 s.
// See {@link DEFAULT_PREVIEW_BUDGET_RTF} for the policy that replaced it, the
// options weighed, and what it deliberately does NOT change.

import { VadGate } from '../vad-gate';

const SAMPLE_RATE = 16_000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000; // s16le mono

/** Minimum wall time between preview decodes. Not a promise of cadence: a decode
 *  that overruns simply pushes the next one out (see `lastDecodeAt`). */
export const DEFAULT_PREVIEW_INTERVAL_MS = 700;
/** Minimum AUDIO in the uncommitted tail before it is worth decoding at all.
 *
 *  🔴 A separate knob from {@link DEFAULT_PREVIEW_INTERVAL_MS} because it answers
 *  a separate question — 「how much speech is in there」 vs 「how often may I block
 *  the loop」 — and conflating them is what let tick #1 decode a single 200 ms
 *  chunk (header ①). Equal by default only because one cadence's worth of audio
 *  is the natural floor. */
export const DEFAULT_PREVIEW_MIN_TAIL_MS = 700;
/** FLOOR of the per-decode budget: a decode is never judged slow for costing
 *  less than this, however little audio it covered.
 *
 *  ⚠️ It used to be the WHOLE budget (header ③). The name is kept because the
 *  option is public and every existing caller means the same thing by it — 「the
 *  smallest wall you may hit」 — and because a rename would have been the only
 *  breaking part of this change. */
export const DEFAULT_PREVIEW_BUDGET_MS = 300;
/**
 * 🔴 INT-1 — THE WALL SCALES WITH THE AUDIO THE DECODE ACTUALLY COVERED.
 *
 *   budget(tail) = max(DEFAULT_PREVIEW_BUDGET_MS, tailMs × this)
 *
 * ── WHY A RATIO AND NOT A BIGGER FLAT NUMBER ─────────────────────────────────
 * Because the thing being judged is a MACHINE, and the honest measure of a
 * machine's transcription speed is RTF (decode ms per audio ms). A flat wall
 * measures RTF × length and calls the product 「slow」. Three real readings on
 * one machine (header ③) gave RTF 0.027 three times over while the flat wall
 * called that machine slow on one of them and fine on another — the readings
 * agreed with each other and disagreed with the wall.
 *
 * ── WHY 0.06 ─────────────────────────────────────────────────────────────────
 * ≈ 2.2× the 0.027 measured on dev-pc-a. Not a round number chosen for
 * looking safe: the budget's job is to catch 「this machine cannot do this」, and
 * a machine less than about twice as slow as a mid-range desktop plainly can.
 * The headroom also absorbs a GC pause or an OS hiccup landing inside one
 * decode — which `budgetStrikes` already covers once, so the two guards overlap
 * on purpose rather than each being tuned to the edge.
 * ⚠️ It is NOT the spike's 「weak CPU ≤ 0.4」 estimate: at 0.4 a 12 s tail is
 * ~4.8 s of blocked event loop, which is the outcome this budget exists to
 * prevent. 0.4 is what we think a slow machine DOES, not what we will tolerate.
 *
 * ── WHAT THIS CHANGES, EXACTLY ───────────────────────────────────────────────
 * The floor and the ramp cross at a 5 s tail (5000 × 0.06 = 300), so for EVERY
 * tail shorter than 5 s the budget is byte-for-byte the old one. This change
 * cannot make a short-tail decision more permissive; it only stops charging an
 * utterance for its length. Worked through on a genuinely slow machine
 * (RTF 0.4), which is the case that must still stand down: first decode at the
 * 700 ms floor costs 280 ms and passes under BOTH policies; at a 1.4 s tail it
 * costs 560 ms and strikes; at 2.1 s it costs 840 ms and strikes again ⇒
 * disabled — the same two decodes, at the same tails, as before.
 *
 * ── THE CEILING IS DERIVED, NOT DECLARED ─────────────────────────────────────
 * The worst single block this policy can authorise is
 * `DEFAULT_PREVIEW_MAX_TAIL_MS × this` = 720 ms, because the tail cannot exceed
 * that ceiling. Deliberately NOT a fourth constant: a hard cap that never binds
 * in production would be a branch with no caller. It is pinned by a test
 * instead (`test/sherpa-preview.test.ts` 「the worst block this policy can
 * authorise」), so raising `DEFAULT_PREVIEW_MAX_TAIL_MS` or this ratio goes red
 * and has to be argued rather than noticed later.
 *
 * ── OPTIONS WEIGHED, AND WHY THEY LOST ───────────────────────────────────────
 *  (a) Raise the flat wall to ~700 ms (one preview interval). Passes all three
 *      readings and still trips 900 ms @ 5 s, and it is one line. Rejected: it
 *      moves the conflation instead of removing it — a machine at RTF 0.055
 *      would be judged fine at a 12 s tail and fine at a 1 s tail, while a
 *      machine at RTF 0.35 would be judged fine at any tail under 2 s. The wall
 *      would still be answering 「how long did they speak」.
 *  (b) Decode only a bounded tail WINDOW (e.g. the last 4 s) so cost never grows.
 *      Genuinely attractive — it bounds the block by construction — and
 *      rejected as OUT OF SCOPE and not obviously right: it changes what the
 *      user SEES, because a window that slides past the start of an unfrozen
 *      span drops words from the preview until the next silence freezes them.
 *      That is a product decision about preview content, next to the streaming-
 *      model question the spike already parked with REQ-12-06.
 *  (c) Do nothing and accept that long utterances lose their preview. Rejected:
 *      it is the CURRENT state and owner's requirement is "while holding to
 *      speak, you must be able to see the text growing" — an utterance long
 *      enough to need a preview is exactly the one
 *      that loses it.
 */
export const DEFAULT_PREVIEW_BUDGET_RTF = 0.06;
/** The per-decode wall for a decode covering `tailMs` of audio. Exported so the
 *  policy can be asserted directly instead of inferred from a decoder's
 *  behaviour — the readings in header ③ are pairs (cost, audio) and this is the
 *  function they are pairs of. */
export function previewBudgetMs(tailMs: number, floorMs: number, rtf: number): number {
  return Math.max(floorMs, tailMs * rtf);
}
/** How many CONSECUTIVE over-budget decodes stand the previews down. 2, not 1:
 *  see header ② — the first decode after a model load measures initialisation,
 *  which cannot repeat, and a verdict about the steady state has to rest on a
 *  measurement that could. An in-budget decode resets the count. */
export const DEFAULT_PREVIEW_BUDGET_STRIKES = 2;
/** Hard ceiling on the uncommitted tail. Reached without a silence boundary ⇒
 *  commit anyway, accepting a possibly mid-word split in the PREVIEW ONLY. This
 *  is what bounds the re-decode cost for someone who speaks without pausing. */
export const DEFAULT_PREVIEW_MAX_TAIL_MS = 12_000;

/** Why previews stopped. Carried out to the caller so the reason reaches the log
 *  instead of the feature just going quiet (no-silent-failure applies to a degraded
 *  enhancement too — the user is not told, but the operator must be). */
export type PreviewDisableReason = 'slow_decode' | 'decode_failed';

export interface SherpaPreviewOptions {
  /** Decode one PCM span (s16le @16 kHz) to text. Injected so the whole policy
   *  below is unit-testable without the native addon. */
  decode(pcm: Buffer): string;
  /** Monotonic-ish clock in ms. Injected for the same reason. */
  now?(): number;
  intervalMs?: number;
  minTailMs?: number;
  /** FLOOR of the per-decode budget — see {@link DEFAULT_PREVIEW_BUDGET_MS}. */
  budgetMs?: number;
  /** Slope of the per-decode budget — see {@link DEFAULT_PREVIEW_BUDGET_RTF}. */
  budgetRtf?: number;
  budgetStrikes?: number;
  maxTailMs?: number;
  /** Voiced-frame detector FACTORY. Defaults to the same energy gate the billing
   *  path uses. Shared MECHANISM, not a shared answer: both consumers ask the one
   *  question that class answers (「is this frame voiced」); neither reads the
   *  other's verdict.
   *
   *  A factory and not an instance so [reset] can be TOTAL. `VadGate` has no
   *  reset of its own (it carries `_open`, the silence run and a residual sample
   *  tail), so a decoder handed a bare instance would silently keep the previous
   *  utterance's gate phase — which is precisely the boundary this class splits
   *  spans on. Production builds one engine per utterance so it never happens
   *  today; leaving the hole open anyway is how it stops being true later. */
  vad?: () => VadGate;
  /** Called once, when previews turn themselves off. */
  onDisabled?(reason: PreviewDisableReason, detail: Record<string, unknown>): void;
}

/**
 * Join two INDEPENDENTLY DECODED, DISJOINT spans.
 *
 * Not `mergeOverlap` / `mergeOnlineDraft`: those compare two hypotheses that may
 * describe the same audio. These two never do — the left side is frozen audio the
 * right side does not contain — so nothing may be dropped here. The only decision
 * is whether a separator is needed, and it is needed exactly when both sides of
 * the seam are Latin word characters (SenseVoice writes CJK without spaces and
 * English with them; "hello"+"world" must not become "helloworld").
 */
export function joinPreviewSpans(left: string, right: string): string {
  if (left === '') return right;
  if (right === '') return left;
  const endsWord = /[A-Za-z0-9]$/.test(left);
  const startsWord = /^[A-Za-z0-9]/.test(right);
  return endsWord && startsWord ? `${left} ${right}` : left + right;
}

/**
 * Turns a stream of PCM chunks into a growing preview string.
 *
 * Lifecycle mirrors the engine's: [reset] at open, [push] per chunk, and nothing
 * at flush — the terminal decode is the engine's own and does not consult this.
 */
/** What the previews actually cost on THIS machine, for one utterance.
 *
 *  🔴 Exists because "weak CPU ≤0.4 RTF" was an ESTIMATE and the device line had no
 *  way to turn it into a reading: previews either appeared or did not, and a
 *  decode's real duration was knowable nowhere. `maxDecodeMs` is the number the
 *  budget is arguing about, so it has to leave the process. */
export interface PreviewStats {
  /** Decodes actually performed (≠ chunks pushed). */
  decodes: number;
  /** Previews handed back to the engine (a decode whose text did not change
   *  returns null and is counted here as not emitted). */
  emitted: number;
  /** Decodes that ran over `budgetMs`, whether or not they disabled anything. */
  overBudget: number;
  /** Longest single decode, in ms. THE number behind the budget verdict. */
  maxDecodeMs: number;
  /** 🔴 INT-1 — how much audio THAT decode covered, in ms.
   *
   *  Additive, and it is the missing half of the pair. Round 1 could only put
   *  `maxDecodeMs` next to the utterance's `audio_ms`, which is NOT what the
   *  decode was handed (the tail freezes at silence and is capped at
   *  {@link DEFAULT_PREVIEW_MAX_TAIL_MS}), so turning 320 ms into an RTF took an
   *  argument about which spans could have been in flight. With this field the
   *  device line reads `maxDecodeMs / maxDecodeTailMs` straight off the log line
   *  — and RTF is the number the budget is now expressed in. */
  maxDecodeTailMs: number;
  disabled: PreviewDisableReason | null;
}

export class SherpaPreviewDecoder {
  private readonly decode: (pcm: Buffer) => string;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly minTailBytes: number;
  private readonly budgetMs: number;
  private readonly budgetRtf: number;
  private readonly budgetStrikes: number;
  private readonly maxTailBytes: number;
  private readonly makeVad: () => VadGate;
  private readonly onDisabled: ((reason: PreviewDisableReason, detail: Record<string, unknown>) => void) | undefined;
  private vad: VadGate;

  /** Text of spans already frozen at a safe boundary. */
  private committed = '';
  /** PCM since the last freeze — the only span ever re-decoded. */
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private lastDecodeAt = Number.NEGATIVE_INFINITY;
  private lastEmitted = '';
  private _disabled = false;
  /** CONSECUTIVE over-budget decodes; any in-budget decode zeroes it. */
  private overrunRun = 0;
  private _stats: PreviewStats = emptyStats();

  constructor(opts: SherpaPreviewOptions) {
    this.decode = opts.decode;
    this.now = opts.now ?? (() => Date.now());
    this.intervalMs = opts.intervalMs ?? DEFAULT_PREVIEW_INTERVAL_MS;
    this.budgetMs = opts.budgetMs ?? DEFAULT_PREVIEW_BUDGET_MS;
    // Clamped at 0: a negative slope would make the budget SHRINK as the tail
    // grows — the defect this card fixes, inverted and worse. 0 degrades to the
    // flat floor, i.e. exactly the pre-INT-1 policy, which is the right thing
    // for a misconfiguration to fall back to.
    this.budgetRtf = Math.max(0, opts.budgetRtf ?? DEFAULT_PREVIEW_BUDGET_RTF);
    this.budgetStrikes = Math.max(1, opts.budgetStrikes ?? DEFAULT_PREVIEW_BUDGET_STRIKES);
    this.maxTailBytes = Math.max(1, Math.round((opts.maxTailMs ?? DEFAULT_PREVIEW_MAX_TAIL_MS) * BYTES_PER_MS));
    // Clamped to the ceiling: a floor above the ceiling would mean 「never decode,
    // and freeze on a tail that was never read」 — the enhancement silently gone
    // with nothing to grep. Misconfiguration degrades to 「decode at the ceiling」.
    this.minTailBytes = Math.min(
      this.maxTailBytes,
      Math.max(1, Math.round((opts.minTailMs ?? DEFAULT_PREVIEW_MIN_TAIL_MS) * BYTES_PER_MS)),
    );
    this.makeVad = opts.vad ?? ((): VadGate => new VadGate());
    this.vad = this.makeVad();
    this.onDisabled = opts.onDisabled;
  }

  get disabled(): boolean { return this._disabled; }

  /** Visible for the engine's own bookkeeping and for tests. */
  get committedText(): string { return this.committed; }

  /** This utterance's cost readings. See {@link PreviewStats}. */
  get stats(): Readonly<PreviewStats> { return this._stats; }

  /**
   * Feed one inbound audio chunk.
   *
   * @returns the CUMULATIVE preview text to publish as an `interim`, or `null`
   *   when this chunk produced nothing new (not yet due, previews disabled, or
   *   the text did not change). Null is 「nothing to say」, never an error.
   */
  push(chunk: Buffer): string | null {
    if (this._disabled || chunk.length === 0) return null;
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    // The gate runs on EVERY chunk, not only on decode ticks: its hangover
    // bookkeeping is per-frame, and sampling it would misplace the boundary the
    // whole design rests on.
    this.vad.process(chunk);

    // TWO independent conditions, in the order that costs least to evaluate.
    // 🔴 Neither implies the other, and the missing one was defect ① (header):
    //   - `minTailBytes` — is there enough speech in the tail to be worth a
    //     blocking decode? On tick #1 there is not: `lastDecodeAt` is -Infinity
    //     so the cadence check passes vacuously, and without this line the
    //     recognizer is handed a single 200 ms chunk.
    //   - `intervalMs`  — has enough WALL time passed since the last block?
    // `lastDecodeAt` is written only when a decode really happens, so a tick
    // skipped for want of audio does not consume the cadence.
    if (this.tailBytes < this.minTailBytes) return null;
    const startedAt = this.now();
    if (startedAt - this.lastDecodeAt < this.intervalMs) return null;
    this.lastDecodeAt = startedAt;
    this._stats.decodes += 1;

    // 🔴 INT-1 — captured BEFORE the decode, because the freeze below zeroes
    // `tailBytes` and both the budget and the WARN need to describe the span
    // that was actually handed to the recognizer. (The old WARN read
    // `tailBytes: this.tailBytes` after the freeze, i.e. it reported `0` for the
    // very decode it was complaining about — a number that answered nothing.)
    const decodedBytes = this.tailBytes;
    const decodedMs = decodedBytes / BYTES_PER_MS;

    let text: string;
    try {
      text = this.decode(Buffer.concat(this.tail, this.tailBytes));
    } catch (err) {
      // A preview decode that throws must not surface as an engine error: the
      // utterance is fine and its final has not been attempted yet. Stand down
      // and record why.
      this.disable('decode_failed', { detail: err instanceof Error ? err.message : String(err) });
      return null;
    }
    const tookMs = this.now() - startedAt;
    // The pair moves together — `maxDecodeTailMs` is 「the tail of the decode
    // that produced maxDecodeMs」, never 「the largest tail seen」. Two maxima
    // tracked apart would divide into an RTF that no single decode ever had.
    if (tookMs > this._stats.maxDecodeMs) {
      this._stats.maxDecodeMs = tookMs;
      this._stats.maxDecodeTailMs = Math.round(decodedMs);
    }

    const preview = joinPreviewSpans(this.committed, text);
    // Freeze at a silence boundary, or at the hard ceiling. Both are decided
    // AFTER the decode so the text being frozen is the text just measured.
    if (!this.vad.open || this.tailBytes >= this.maxTailBytes) {
      this.committed = preview;
      this.tail = [];
      this.tailBytes = 0;
    }

    // Budget is checked last so this decode's result is still delivered — it was
    // paid for either way, and one preview is strictly better than none.
    // 🔴 INT-1: the wall is a function of the audio this decode covered, not a
    // constant — see DEFAULT_PREVIEW_BUDGET_RTF.
    const budget = previewBudgetMs(decodedMs, this.budgetMs, this.budgetRtf);
    if (tookMs > budget) {
      this._stats.overBudget += 1;
      this.overrunRun += 1;
      if (this.overrunRun >= this.budgetStrikes) {
        // `budgetMs` keeps its name and now carries the EFFECTIVE wall — the
        // number `tookMs` was actually compared against, which is the only one
        // the sentence 「it went over budget」 can honestly mean. `budgetFloorMs`
        // and `tailMs` are additive so the operator can reconstruct the verdict
        // (and read this machine's RTF straight off `tookMs / tailMs`).
        this.disable('slow_decode', {
          tookMs,
          budgetMs: budget,
          budgetFloorMs: this.budgetMs,
          budgetRtf: this.budgetRtf,
          tailMs: Math.round(decodedMs),
          strikes: this.overrunRun,
          tailBytes: decodedBytes,
        });
      }
    } else {
      // 🔴 The reset is the whole point of counting CONSECUTIVE runs: a model
      // warm-up (or a GC pause) is followed by a normal decode, and a machine
      // that can keep up must be allowed to say so.
      this.overrunRun = 0;
    }

    if (preview === '' || preview === this.lastEmitted) return null;
    this.lastEmitted = preview;
    this._stats.emitted += 1;
    return preview;
  }

  /** Drop all per-utterance state. Called at `open()`, so a hot recognizer never
   *  carries one utterance's preview into the next. */
  reset(): void {
    this.committed = '';
    this.tail = [];
    this.tailBytes = 0;
    this.lastDecodeAt = Number.NEGATIVE_INFINITY;
    this.lastEmitted = '';
    this._disabled = false;
    this.overrunRun = 0;
    this._stats = emptyStats();
    this.vad = this.makeVad();
  }

  private disable(reason: PreviewDisableReason, detail: Record<string, unknown>): void {
    if (this._disabled) return;
    this._disabled = true;
    this._stats.disabled = reason;
    this.onDisabled?.(reason, detail);
  }
}

function emptyStats(): PreviewStats {
  return { decodes: 0, emitted: 0, overBudget: 0, maxDecodeMs: 0, maxDecodeTailMs: 0, disabled: null };
}
