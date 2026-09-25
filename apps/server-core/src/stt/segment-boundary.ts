// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (soft_segment_ms — the server-side
//     segmentation cadence)
//   CLAUDE.md red line: no silent truncation
//
// card SEG-1 (2026-08-15) — WHERE a long recording is allowed to be cut.
//
// ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
// `soft_segment_ms` was a bare 30 s stopwatch: at the tick the orchestrator
// flushed the engine, closed it, opened a new one, and the row ended wherever
// the clock happened to land. owner, 2026-08-15, from one 102-second dictation
// (relay: `audio intake {"audioMs":102400,"voicedMs":102280}`), which came out as
// four rows of 173 / 172 / 163 / 62 characters:
//
//   row 2 ends 「…所以呢，本质上安倍。」   row 3 starts 「经济学是通过出卖金融主权…」
//
// 「安倍经济学」 (Abenomics) was cut in half. Both halves then decode without the
// other's context, so the join also drops or garbles a word or two — which is
// what the owner reported as 「中间会丢失几个字」. The clock knew when 30 s had
// passed and NOTHING knew whether a sentence was in flight.
//
// ── WHY NOT "JUST USE THE VAD" ──────────────────────────────────────────────
// 🔴 Because it would not have fired on that recording. The billing VAD gate is
// an absolute-energy gate (-45 dBFS, `vad-gate.ts`) and the measurement above is
// its own counter-example: 102,280 ms voiced out of 102,400 ms — **120 ms of
// silence in 102 seconds**. In a room with any background level the gate simply
// never closes, so a pause-only rule degrades to the ceiling and changes nothing
// for exactly the recording that motivated the card. It is kept as ONE of the
// two signals because when it does fire it is unambiguous, never as the only one.
//
// The second signal is the engine's own punctuation: a terminator at the end of
// the CONFIRMED text means the vendor has committed a sentence. That is a
// semantic boundary rather than an energy one, and it is the signal that fires
// on continuous speech.
//
// ⚠️ CONFIRMED text only — never the draft. A draft's trailing 「。」 can be
// revised away by the next token, and cutting on it would put the boundary
// inside a sentence the engine had not finished deciding.
//
// ⚠️ 更正（RC-4，2026-09-24）：the paragraph above is true of FunASR/SenseVoice,
// which emit finals mid-session. For Soniox it has been false since SEG-1: its
// adapter emits `final` only at our end-of-stream, so `offlineAccum` changed only
// on a flush and the leg flush stripped the stop — the sentence signal never
// fired, and neither did the gate in any room above −45 dBFS (CR-12-E: one row
// of 369 s). Two repairs, argued at {@link segmentCutDecision}: the confirmed
// text now includes the leg's vendor-finalised prefix, and a third arm reads the
// engine's own word timestamps.
//
// ⚠️ 更正（RC-D，2026-09-24）：the first of those two repairs is withdrawn for any
// engine that declares `finalsOnlyAtFlush` (Soniox). Its finalised prefix trails
// the audio by 4.1–5.3 s, so the arm fired while the speaker was already 1–5 s into
// the next sentence and the cut landed inside a word (CR-12-E rerun: 5 of 7 sentence
// seams damaged, 0 of 4 pause seams). For such an engine the orchestrator hands this
// file an empty confirmed text — neither the prefix nor the hang-up bank — and the
// sentence arm never fires; FunASR / SenseVoice are unchanged. Book 06 §2 RC-D block.
//
// ⚠️ The ceiling is not optional. Two of the three inputs can stay false
// forever (a speaker who never pauses and an engine configured without
// punctuation), and a segment that never closes is a row that grows without
// bound — the failure this whole cadence exists to prevent.

/** Sentence-final punctuation, as produced by the STT engines' own punctuation
 *  models across the product's spoken languages.
 *
 *  ⚠️ The ASCII period is deliberately ABSENT. English STT emits it mid-sentence
 *  inside abbreviations and numbers ("U.S.", "3.5"), so accepting it would move
 *  the cut INTO a sentence — the very defect being fixed — while the ideographic
 *  「。」 has no such second job. English recordings therefore lean on the VAD
 *  signal and the ceiling, which is the honest trade and not an oversight: a
 *  boundary rule is only worth having where it is right, and half a rule that
 *  fires in the wrong place is worse than none (this repo has paid for that
 *  twice — 0.2.53, ENG-4). */
const SENTENCE_TERMINATORS = '。！？…‼⁇⁈⁉！？!?';

/** True when [confirmed] ends on a sentence the engine has already committed.
 *  Trailing whitespace is ignored (engines pad); an empty string is never a
 *  boundary — "nothing has been said yet" is not "a sentence just ended". */
export function endsAtSentenceBoundary(confirmed: string): boolean {
  const t = confirmed.trimEnd();
  if (t.length === 0) return false;
  return SENTENCE_TERMINATORS.includes(t[t.length - 1]!);
}

/**
 * card SEG-3 (2026-08-15) — WHY a span of audio was closed, kept because the
 * text has to be repaired differently for each. See {@link seamText}.
 *
 * card SEG-4 (same day, owner: 「从处理逻辑上彻底优化，不要打补丁」) renamed the
 * third member: 'ceiling' became **'leg'**, because the thing the timer closes
 * is no longer a segment. A segment — the user-visible row — now ends ONLY at
 * 'sentence' or 'pause' (or at the terminal stop, which never comes through
 * here). What the clock bounds is the ENGINE LEG, an engineering constraint the
 * user never sees: its flush text is seam-repaired and banked, and the same row
 * keeps growing across the new leg.
 */
export type SegmentCutReason = 'sentence' | 'pause' | 'word_gap' | 'overdue' | 'leg';

/**
 * card SEG-3 — how long the VAD gate must have been CONTINUOUSLY closed before
 * a silence counts as a boundary.
 *
 * 🔴 SEG-1 accepted a bare `!gateOpen`, and owner's 2026-08-15 recording is the
 * counter-example: 「…看看要怎么样实现」 / 「这个方案，…」 is ONE clause, and the
 * only thing between its halves is the breath before 「这个」. Mandarin runs at
 * roughly 4–6 syllables/s with sub-300 ms inter-phrase breaths, so an instant
 * gate reading answers 「is there sound RIGHT NOW」 — not 「did the speaker stop」.
 * 600 ms is longer than a breath and shorter than a thought; it is the first
 * measured number here, so it is a named constant to be re-measured, not tuned
 * in place.
 */
export const MIN_PAUSE_MS = 600;

/**
 * card RC-4 (D-bis) — the third delivery arm: the engine's own words stopped for
 * this long. owner's rule for a paragraph is 「3 秒以上」, and the gate cannot see
 * a 3 s pause in a room whose floor sits above −45 dBFS (CR-12-E, three rooms,
 * gate open 91–100 %), so the vendor's word timestamps are the only signal left.
 * Same number as the phone's `kStrongPauseMs` on purpose (`apps/mobile/lib/src/timeline/
 * article_paragraphs.dart`): a row cut here carries a
 * `pause_before_ms` that the paragraph rule then accepts.
 */
export const WORD_GAP_MIN_MS = 3_000;

/**
 * card RC-4 — how much of {@link WORD_GAP_MIN_MS} must be CERTAIN: audio the
 * vendor has already processed without producing a word, or audio the gate
 * withheld. The rest of the gap is audio we have handed over and the vendor has
 * not answered for yet — the next word may be in it. Reading only our own fed
 * count cuts mid-sentence whenever feeding outruns the vendor (a recovery burst,
 * an uplink stall that flushes). MEASURED 2026-09-24 (`stt-rt-v5`, material A
 * with −40 dBFS noise, book 06 §2 RC-4 block): during continuous speech
 * 「processed − last word end」 peaked at 1,320 ms; in pauses the vendor kept
 * sending frames at most 1.2 s apart. 2,000 sits above the first and lets the
 * arm fire within one frame of a 3 s pause.
 */
export const WORD_GAP_CERTAIN_MIN_MS = 2_000;

/**
 * 🔴 card NR-60 — THE SECOND BOUND ON AN ENGINE LEG, and the first one that is
 * not a clock.
 *
 * SEG-4 made the leg a purely temporal thing: `cadenceMs + graceMs`
 * (30 s + 15 s) bounds the vendor session and nothing else. That was true of
 * every engine the product had when it was written, because every one of them
 * could be handed a span of any length. The local **whisper** packs cannot, and
 * the shipped decoder says so in as many words:
 *
 *   Only waves less than 30 seconds are supported. We process only the first
 *   30 seconds and discard the remaining data
 *
 * (a literal in `sherpa-onnx-c-api.dll` 1.13.4 — measured 2026-09-16 on
 * dev-pc-a; it is the ONLY audio-length limit string in that binary, so
 * SenseVoice / transducer / nemo-ctc / canary / moonshine are unaffected.) It
 * is not configurable: `OfflineWhisperModelConfig` is
 * `{encoder, decoder, language, task, tailPaddings}` and `tailPaddings` PADS a
 * short wave, it does not extend the window. The 30 s is Whisper's encoder — a
 * fixed-length mel input, not a tunable.
 *
 * ⇒ On a whisper pack the last ~15 s of a 45 s leg was decoded by nobody and
 * reported by nothing. That is the 「no silent failure」 red line in its worse
 * direction: not a failure swallowed, but a PARTIAL transcript delivered as a
 * whole one — and the tail is what goes, so the row reads finished.
 *
 * 🔴 THE BOUND IS ON AUDIO FED, NOT ON WALL TIME, and that is the whole design.
 * Wall time only bounds audio from above (the VAD gate feeds less than elapses),
 * so shortening the cadence would buy the same guarantee by making EVERY
 * engine's rows shorter — a product change, to work around one pack's decoder.
 * The quantity that has to stay under the wall is the span the flush hands over,
 * and `engineFedBytes` is already exactly that number (NR-50 races its flush cap
 * against it). One fact, two readers — not one value answering two questions.
 *
 * ⚠️ THE COST, stated: a whisper session rotates its leg every ~28 s instead of
 * every ~45 s, and every rotation is a seam that costs the next leg its left
 * acoustic context (SEG-3's whole account). That is a worse join at one seam,
 * against a transcript missing a third of itself. The ROW is not cut: a leg
 * rotation mints nothing (SEG-4), so nothing about this is visible to the user.
 *
 * ⚠️ THE MARGIN exists because the budget is checked once per fed chunk, i.e.
 * the crossing is noticed only on the chunk that crosses it. The phone's chunks
 * are ~200 ms and no part of the protocol pins that size, so 2 s is ten of
 * today's and still leaves 28 s of usable leg. (A replayed tail is bounded by
 * `replayWindowMs` = 5 s and only ever lands on a leg whose count was just
 * reset, so it cannot jump the budget on its own.)
 *
 * ⚠️ 0 = 「this engine declared nothing」 = unbounded, which is byte-for-byte
 * today's behaviour. Every network engine, and every local pack that is not
 * whisper, stays there — a bound nobody measured is not a bound worth inventing.
 */
export const LEG_AUDIO_BUDGET_MARGIN_MS = 2_000;

/** How much audio one leg of [engineMaxDecodeAudioMs] may be handed; 0 when the
 *  engine declared no limit. See {@link LEG_AUDIO_BUDGET_MARGIN_MS}. */
export function legAudioBudgetMs(engineMaxDecodeAudioMs: number | undefined): number {
  if (engineMaxDecodeAudioMs === undefined || engineMaxDecodeAudioMs <= 0) return 0;
  return Math.max(0, engineMaxDecodeAudioMs - LEG_AUDIO_BUDGET_MARGIN_MS);
}

/** The inputs a DELIVERY decision is allowed to read, and nothing else.
 *  card SEG-4 removed `ceilingReached`: no timer can deliver a row any more —
 *  the timer's whole authority is now the engine leg. card RC-4 added `wordGap`. */
export interface SegmentCutInput {
  /** Has the `soft_segment_ms` cadence deadline already passed? Before it, the
   *  answer is always 'wait' — a pause at second 3 must not mint a 3-second row. */
  due: boolean;
  /** The engine's CONFIRMED text for the segment now open (never the draft). */
  confirmed: string;
  /** How long the VAD gate has been CONTINUOUSLY closed, in ms; 0 while open.
   *  🔴 Required, not optional-with-a-default: a caller that cannot answer
   *  「how long has it been quiet」 must not get 「long enough」 for free. */
  gateClosedMs: number;
  /** card RC-4 — silence since the engine's last word (`segment-pause.ts`
   *  `liveWordGap`), or null when it is not knowable. Required for the same reason
   *  `gateClosedMs` is: a caller that cannot answer must say so, not get 「long
   *  enough」 for free. */
  wordGap: { readonly ms: number; readonly certainMs: number } | null;
  /** card RC-4 follow-up — the overdue arm's PROVEN cut point, if the row is old enough
   *  and one exists (`overdue-cut.ts`), or null. Required, like the other two readings. */
  overdue: 'gap' | 'word_end' | null;
  /** card RC-E — a LONG RECORDING's open row (age on the `duration_ms` clock, and the
   *  text it holds so far); absent/null ⇒ push-to-talk, where nothing here changes.
   *  Optional, unlike the three readings above, because absence IS an answer here —
   *  the one every push-to-talk session gives. */
  continuousRow?: { rowAgeMs: number; rowText: string } | null;
}

/**
 * card RC-E — the youngest row a long recording's silence may end
 * (`docs/strategy/2026-09-24-cr12e-rerun-root-cause.md` §2.3 / §3.2). Floors of
 * 0 / 8 / 10 s gave the same rows on material A; 15 s swallowed one of its 13
 * silences. 10 s is the largest floor that kept all of them.
 */
export const CONTINUOUS_SILENCE_ROW_MIN_MS = 10_000;

/** card RC-E — the row holds at least one content word: a letter or a digit in any script. */
export function hasContentWord(text: string): boolean { return /[\p{L}\p{N}]/u.test(text); }

/**
 * 🔴 card RC-E — may a ≥3 s silence end this row of a LONG RECORDING before the
 * 30 s deadline? The ONE rule both of its sources read: the silence hang-up
 * (`orchestrator-rollover.ts` `flushAndCloseLegForSilence`) and the word-gap arm
 * below (via {@link SegmentCutInput.continuousRow}).
 *
 * WHY. In a long recording the 30 s floor and the 3 s hang-up were phase-locked:
 * every silence that fell inside a row's first 30 s was hung up on and banked, the
 * sentence arm then cut 31–39 s into the row at the live edge, and the next row's
 * first 30 s swallowed the next silence — 4 of 13 silences started a row (CR-12-E
 * rerun, material A). The 30 s floor answers a PUSH-TO-TALK question (how often a
 * realtime long sentence delivers text to the PC; CR-12 design book §2), and a long
 * recording delivers nothing (constraint A: light records only), so the floor is
 * lifted for it alone. Push-to-talk never reaches here: `continuousRow` is absent.
 */
export function continuousSilenceCutAllowed(rowAgeMs: number, rowText: string): boolean {
  return rowAgeMs >= CONTINUOUS_SILENCE_ROW_MIN_MS && hasContentWord(rowText);
}

/** 'cut' + why, or 'wait'. The reason travels because {@link seamText} needs it. */
export type SegmentCutDecision = { cut: false } | { cut: true; reason: SegmentCutReason };

/**
 * The DELIVERY policy, top-down: nothing before the deadline, and past it only
 * the boundaries we can defend. There is deliberately no TIME arm — card
 * SEG-4's whole content is that time alone never again ends a row.
 * ⚠️ 更正（RC-4，2026-09-24）：the sentence above originally read 「past it only
 * the two boundaries we can defend. There is deliberately no third arm」. There is
 * a third arm now, and it is still not time: it is the speaker's own silence as
 * the engine's word timestamps measure it ({@link WORD_GAP_MIN_MS}).
 *
 * 🔴 SENTENCE IS TESTED BEFORE PAUSE and the order is load-bearing, not tidiness:
 * a speaker who ends a sentence and then breathes satisfies both. The reason
 * names the boundary (they finished a sentence, then paused). F-2 Fix B also
 * waits for a covering FunASR offline on 'pause' only — misreading that seam
 * as 'pause' would add up to 800 ms to a row that already had its terminator.
 */
export function segmentCutDecision(input: SegmentCutInput): SegmentCutDecision {
  const g = input.wordGap;
  const gapHolds = g !== null && g.ms >= WORD_GAP_MIN_MS && g.certainMs >= WORD_GAP_CERTAIN_MIN_MS;
  // card RC-E — before the deadline, only a long recording's ≥3 s word gap, and only
  // on a row {@link continuousSilenceCutAllowed} admits. Push-to-talk: 'wait', as ever.
  if (!input.due) {
    const row = input.continuousRow;
    return row && gapHolds && continuousSilenceCutAllowed(row.rowAgeMs, row.rowText) ? { cut: true, reason: 'word_gap' } : { cut: false };
  }
  if (endsAtSentenceBoundary(input.confirmed)) return { cut: true, reason: 'sentence' };
  if (input.gateClosedMs >= MIN_PAUSE_MS) return { cut: true, reason: 'pause' };
  // card RC-4 — the third arm, after the two above: when the gate did close, its
  // reading is the direct one and F-2 keys on 'pause'. Both numbers must clear.
  if (gapHolds) return { cut: true, reason: 'word_gap' };
  // card RC-4 follow-up — last: the row is past 90 s and the speech's own boundaries
  // have not ended it. It cuts in the PAST, at a point `overdue-cut.ts` has proven.
  if (input.overdue !== null) return { cut: true, reason: 'overdue' };
  return { cut: false };
}

/**
 * 🔴 card SEG-3 — THE ROOT CAUSE THIS ROUND FOUND, and it is not "where we cut".
 *
 * owner, 2026-08-15, holding up one of his own dictations: 「这句被切成了 2 段，
 * 中间用句号连起来，很明显不对」. The two halves were
 *   「…所以呢要不断的去搜查记录与看看要怎么样实现。」  ← full stop nobody spoke
 *   「这个方案，所以说不一定要怎么搞。」
 * and the clause is 「看看要怎么样实现这个方案」.
 *
 * WHERE THE FULL STOP COMES FROM. Not from the flush, and not from us — from the
 * recognizer, and our own engine layer already had it written down:
 * `engines/sherpa-local.ts:266` — 「SenseVoice punctuates AS A FUNCTION OF THE
 * SPAN, so a 「。」 turns into a 「，」 the moment more speech follows it」.
 * ⇒ A segment boundary does not merely SPLIT the text. It changes what the
 * engine DECIDES the text is: hand it half a clause as a closed span and it
 * punctuates that half as a finished sentence, because to the engine it is one.
 * The same mechanism explains owner's other symptom 「中间会丢失几个字」 — span 2
 * decodes with NONE of span 1's acoustic context, so its opening syllables
 * decode worst.
 *
 * ⇒ SEG-1 (cut in a better place) was necessary and CANNOT be sufficient: the
 * ceiling must exist, so forced cuts must exist, so fabricated sentence
 * terminators must exist — unless they are removed on the way out. That is this
 * function, and it is the whole of it.
 *
 * WHAT IT DOES. On a span we closed for TIME (a 'leg' rotation) the confirmed
 * text provably did NOT end at a sentence (`segmentCutDecision` tests that first
 * and would have said 'sentence'), so a terminator on the end of the flush is a
 * property of where the SPAN closed, not of what was said: drop it. SenseVoice
 * punctuates as a function of the span; that is SEG-3's owner defect.
 *
 * 🔴 F-2 (2026-08-31) — 'pause' NO LONGER STRIPS. FunASR's 2pass-offline pass
 * punctuates (measured: online never does; offline does). A pause-cut row that
 * waited for that covering offline (Fix B) would then have seamText eat the
 * mark the engine just produced — the unreadable run-together text the owner
 * reported. Keeping an ENGINE-produced terminator is not force-closing; we
 * still do not run `ensureTerminalPunctuation` on `is_segment` rows (06 §5).
 * 'sentence' keeps the mark, as before. 'leg' still drops it.
 *
 * Under card SEG-4 the 'leg' arm matters MORE than it did as 'ceiling': the
 * repaired text is banked and the NEXT LEG'S text is appended after it inside
 * the same row, so a surviving fabricated 「。」 would now sever a clause in the
 * middle of one row instead of across two.
 *
 * ⚠️ FAILURE DIRECTION, chosen deliberately, and it now applies to 'leg' only.
 * The lossy case is a sentence that completes DURING the flush round-trip: we
 * then drop a full stop that had just become real, and two sentences run
 * together at the seam. That is a missing mark between two intact sentences.
 * The alternative is owner's defect: one sentence severed by a mark that was
 * never spoken. A reader can punctuate the first; nobody can un-split the
 * second. 'pause' no longer takes that trade — the FunASR offline mark is real.
 *
 * ⚠️ Exactly ONE terminator, and never the whole run: 「…吗？！」 is emphasis the
 * speaker produced, and eating the lot would edit them rather than un-edit us.
 *
 * 🔴 WHITESPACE IS NOT OURS TO TOUCH, and this cost a real defect on the way in.
 * The first version of this function did `trimEnd()` and returned the trimmed
 * string — which silently ate the trailing SPACE that joins two English
 * segments, turning 「…test reports 」+「before friday…」 into
 * 「…test reportsbefore friday…」. `stt-seam-duplication.test.ts` caught it, which
 * is the whole reason that suite exists. So: trimming is used only to FIND the
 * last visible character; every byte that is not the one terminator being
 * removed comes back out untouched. A seam repair that damages the seam is worse
 * than no repair.
 */
export function seamText(finalText: string, reason: SegmentCutReason): string {
  // card RC-4: 'word_gap' is a speaker's pause measured by the engine instead of
  // the gate, so an engine-produced terminator on it is kept exactly as on 'pause'.
  // 'overdue' cuts between words the vendor had already finalised WITH their right
  // context, so no terminator on it was made up by the span: kept, too.
  if (reason === 'sentence' || reason === 'pause' || reason === 'word_gap' || reason === 'overdue') return finalText;
  const end = finalText.trimEnd().length; // index just past the last visible char
  if (end === 0) return finalText;
  if (!SENTENCE_TERMINATORS.includes(finalText[end - 1]!)) return finalText;
  return finalText.slice(0, end - 1) + finalText.slice(end);
}

/** What {@link SoftSegmentCadence} needs from the orchestrator, and nothing
 *  else. Same composition shape as `EngineIdleHangup` and
 *  `EngineSessionReconnectLadder`: the helper owns the countdown and its own
 *  state, the orchestrator owns the engine field and the accumulators. */
export interface SoftSegmentCadenceHooks {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** RT-2: a boundary is a FLUSH, so it needs a leg. With none attached phase 1
   *  RE-ARMS rather than raising `due` — returning instead would kill soft
   *  segmentation for the rest of the session with nothing saying it stopped. */
  hasEngine(): boolean;
  /** terminated || terminalizing — this recording is wrapping up, no segment work. */
  isFinished(): boolean;
  /** card SEG-4 — the leg span expired: rotate the ENGINE LEG (flush → seam-repair
   *  → bank → fresh leg), and mint NOTHING. The row keeps growing. This used to
   *  be `cutNow()` and used to deliver; the rename is the card.
   *
   *  card NR-60 — returns whether a rotation ACTUALLY STARTED. `startRollover`
   *  has always refused when one is already in flight; it just never said so,
   *  and the clock did not need to know (it re-arms either way). The audio
   *  budget does need to know: it fires from the chunk path, where a refusal is
   *  routine (the chunk that spends the budget can arrive during the rollover a
   *  delivery cut started one chunk earlier). */
  rotateLeg(): boolean;
  /** card RC-U — true while the TIMED rotation is on hold (the vendor's backlog is over
   *  `BACKLOG_HOLDS_CUT_ARMS_MS`, `engine-backlog.ts`). Read by phase 2 only: the NR-60 audio budget
   *  ({@link SoftSegmentCadence.rotateLegForAudioBudget}) is a decoder limit and never waits on it.
   *  Absent ⇒ never on hold. */
  holdLegRotation?(): boolean;
}

/**
 * card SEG-1 — the cadence, as its own object.
 * card SEG-4 — what its timer is allowed to do, narrowed by owner's ruling
 * (「彻底优化，不要打补丁」): time can BOUND AN ENGINE LEG, it can never again
 * END A ROW.
 *
 * TWO PHASES ON ONE TIMER. Phase 1 fires at `cadenceMs` and raises {@link due}:
 * the segment starts LOOKING for a decent place to end. Delivery is decided per
 * audio chunk by {@link segmentCutDecision} — a sentence the engine confirmed,
 * or a pause that lasted. Phase 2 fires every `graceMs` after that and rotates
 * the engine leg (an internal act, invisible on the wire); the search for a
 * delivery boundary simply continues into the new leg.
 *
 * ⚠️ A row therefore has a MINIMUM length (`cadenceMs`) and no maximum. That is
 * deliberate and stated: the bounded resource was always the vendor session,
 * and the leg rotation bounds it. A speaker who never pauses and never finishes
 * a sentence accumulates one long row, which is the truth — cutting that
 * speaker off mid-clause to make the row shorter is the defect this card
 * removes, not a property worth keeping. The recording itself is still bounded
 * (quota / hard limit / the user's own thumb), and the terminal final settles
 * whatever the row had accumulated.
 */
export class SoftSegmentCadence {
  private timer: unknown = null;
  private _due = false;
  /** card SEG-3 — when the gate last went closed, or 0 while it is open. Lives
   *  here rather than in the orchestrator so the three facts a cut is decided
   *  from (deadline, silence run, confirmed text) are read in one place. */
  private gateClosedAtMs = 0;
  private _lastCutReason: SegmentCutReason = 'leg';

  /** Why the span now closing was closed. Read by the orchestrator when it emits
   *  a segment final (or banks a rotated leg), so {@link seamText} can undo a
   *  full stop the span produced. Defaults to the strictest reading ('leg' ⇒
   *  repair), so a path that forgets to ask errs toward removing a mark rather
   *  than keeping a fabricated one — {@link seamText}'s failure direction. */
  get lastCutReason(): SegmentCutReason { return this._lastCutReason; }

  /** How long the VAD gate has been CONTINUOUSLY closed, as of [nowMs]; 0 while open.
   *  Same number {@link shouldCut} hands to {@link segmentCutDecision} — one
   *  silence-run, not a second tracker (repo #1 shape). */
  gateClosedMs(nowMs: number): number {
    return this.gateClosedAtMs === 0 ? 0 : nowMs - this.gateClosedAtMs;
  }

  /**
   * Called once per audio chunk. Returns true when this chunk is the DELIVERY
   * boundary — the row ends here, by the speech's own shape, never by the clock.
   *
   * ⚠️ `gateOpen` is the SAME predicate that decides whether the chunk is fed to
   * the engine, passed in rather than re-derived: two answers to 「is this voice」
   * inside one decision is this repo's #1 bug shape.
   */
  shouldCut(gateOpen: boolean, nowMs: number, confirmed: string, wordGap: SegmentCutInput['wordGap'], overdue: SegmentCutInput['overdue'] = null, continuousRow: SegmentCutInput['continuousRow'] = null): boolean {
    if (gateOpen) this.gateClosedAtMs = 0;
    else if (this.gateClosedAtMs === 0) this.gateClosedAtMs = nowMs;
    const d = segmentCutDecision({
      due: this._due,
      confirmed,
      gateClosedMs: this.gateClosedAtMs === 0 ? 0 : nowMs - this.gateClosedAtMs,
      wordGap,
      overdue,
      continuousRow, // card RC-E
    });
    if (!d.cut) return false;
    this._lastCutReason = d.reason;
    return true;
  }

  constructor(
    private readonly cadenceMs: number,
    private readonly graceMs: number,
    private readonly hooks: SoftSegmentCadenceHooks,
  ) {}

  /** Has the cadence deadline passed, i.e. is this segment looking for
   *  somewhere decent to end? */
  get due(): boolean { return this._due; }

  arm(delayMs: number = this.cadenceMs): void {
    this.clear();
    this.timer = this.hooks.setTimeout(() => {
      if (!this.hooks.hasEngine()) { if (!this.hooks.isFinished()) this.arm(); return; }
      if (!this._due) { // phase 1 — the deadline, deliberately NOT a cut
        this._due = true;
        this.arm(this.graceMs);
        return;
      }
      // phase 2 — card SEG-4: the leg span expired. Rotate the ENGINE LEG and
      // mint nothing; the row keeps waiting for a boundary it can defend. The
      // reason is recorded BEFORE the hook so the orchestrator's bank read
      // (`lastCutReason`) cannot see a stale 'sentence' from a previous
      // delivery and skip the seam repair.
      // card RC-U — while the vendor is behind, a rotation would re-feed the next leg the backlog it is
      // draining; skip this one, and try again one leg span later (the re-arm below is unchanged).
      if (this.hooks.holdLegRotation?.() === true) { this.arm(this.cadenceMs + this.graceMs); return; }
      this._lastCutReason = 'leg';
      this.hooks.rotateLeg();
      // Re-arm for the NEXT leg span: legs keep rotating for as long as the
      // boundary refuses to arrive. `cadence + grace` (the same span the FIRST
      // leg got), not bare `graceMs`: every rotation is a seam and every seam
      // costs acoustic context, so legs are kept as long as the vendor bound
      // allows rather than as short as the grace. Also load-bearing for the
      // suites that pin `graceMs: 0` — a bare-grace re-arm would be `arm(0)`,
      // a timer that fires at the clock's every step.
      this.arm(this.cadenceMs + this.graceMs);
    }, delayMs);
  }

  /**
   * card NR-60 — the leg's AUDIO budget is spent ({@link legAudioBudgetMs}):
   * rotate now, through the same hook and the same re-arm phase 2 uses, so there
   * is ONE way a leg ends rather than two that can drift apart. Returns whether a
   * rotation started.
   *
   * 🔴 `_lastCutReason` is written only AFTER the rotation is known to have
   * started, and that order is the mechanism. A refused rotation means one is
   * already in flight — and on the delivery path that in-flight one is a ROW
   * ending at a 'sentence' or a 'pause', whose reason `rolloverSegment` and the
   * terminal `seamText` are about to read. Stamping 'leg' over it would make us
   * strip a terminator the engine really produced, which is SEG-3's defect
   * pointed the other way.
   *
   * ⚠️ Nothing between the hook call and the assignment reads the reason: the
   * leg branch of `rolloverSegment` passes `'leg'` to `seamText` as a literal,
   * and it reaches its first `await` (the flush) before this line runs.
   */
  rotateLegForAudioBudget(): boolean {
    if (this.hooks.isFinished() || !this.hooks.hasEngine()) return false;
    if (!this.hooks.rotateLeg()) return false;
    this._lastCutReason = 'leg';
    this.arm(this.cadenceMs + this.graceMs);
    return true;
  }

  clear(): void {
    if (this.timer !== null) { this.hooks.clearTimeout(this.timer); this.timer = null; }
  }

  /** The boundary HAPPENED. Called from the orchestrator's `beginNextSegment`
   *  alongside the index and the clock anchor, so the three facts that together
   *  mean "a new segment is open" cannot drift apart (that drift WAS N1-B1). */
  reset(): void { this._due = false; this.gateClosedAtMs = 0; }
}
