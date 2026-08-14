// SPEC-REF:
//   docs/strategy/2026-08-06-w2-transcription-quality-ledger.md §7 W2-2
//     (compose output has zero validation — polish has three gates,
//     translate/organize had none)
//   docs/decisions/2026-08-06-owner-feedback-batch-fb1-12.md FB-5
//     (owner's life-or-death line: translation must not answer the prompt as if
//     it were a question, organize must not digress)
//   apps/server-core/src/stt/stt-polish-guard.ts (the house style for this kind
//     of gate — pure, deterministic, no clock/network, a named reason per reject)
//   CLAUDE.md red line: an LLM failure must not silently fall back to injecting
//     the raw STT text
//
// The compose output guard. Pure, deterministic, side-effect free: it is handed
// only what production actually holds at the moment the stream ends — the task,
// the text we sent, the text that came back, and the declared languages — and it
// answers ONE question: may this be delivered as the result?
//
// ─── DISPOSITION, AND WHY IT DIFFERS FROM THE POLISH GUARD ──────────────────
//
// stt-polish-guard rejects by DEGRADING: `polishFinalText` falls back to the
// pure two-stage text and names the skip on the wire. That is honest there,
// because the raw transcript IS the product of the realtime path — polish is an
// enhancement on top of a result that already exists.
//
// Translate/organize have no such fallback. Handing back the untranslated source
// is not a degraded result, it IS the failure owner reported, and injecting it
// silently is the named red line (`an LLM failure must not silently fall back to
// injecting the raw STT text`). So a rejection here is LOUD: the orchestrator
// throws, the handler emits compose:error, and the source text is never
// substituted for the output.
//
// ─── WHAT THIS GUARD RESTS ON (qualified deliberately — see below) ──────────
//
// The guard runs on the COMPLETE text, after the last delta has been streamed as
// `compose:chunk`. That is only honest if the complete text is the only thing
// that ever becomes deliverable. Measured on both consumers, 2026-08-06:
//
//   • Spoken-utterance path — `apps/mobile/lib/src/session/utterance_compose.dart`
//     accumulates chunks into `_live` (:159), which is preview only; the
//     delivered text is `_host.ucDone(entryId, outputText)` (:177), taken from
//     `compose:done` verbatim, and `_live` is cleared in `_end()` (:212). On
//     `compose:error` the row fails (:183) and no partial survives. This path is
//     structurally covered.
//
//   • Manual AI-compose path — `apps/mobile/lib/src/session/ai_compose_controller.dart`
//     writes chunks straight into the composer buffer (:136), and that buffer IS
//     the one ➤ delivers (`chat_controller.dart` `aiBuffer` get/set → `_buffer`).
//     `compose:done` replaces it with `output_text` verbatim (:152) and
//     `compose:error` restores the pre-run buffer (:159), so a COMPLETED run is
//     covered either way. What becomes of a PARTIAL mid-stream is the whole
//     question, and the enumeration below is the answer — not this bullet.
//
// ─── 🔴 THE ORIGINAL ARGUMENT — PRESERVED IN PLACE, AND WRONG (W2.5-E) ──────
//
// The bullet above used to end with the sentence quoted below. It is kept
// verbatim rather than deleted because it is EVIDENCE: the exact shape of safety
// argument this repo has to stop making.
//
//     "A ➤ pressed mid-stream would not be — and it cannot happen, because the
//      send gate itself excludes a live compose run: `ChatController.canSend`
//      in `apps/mobile/lib/src/session/chat_controller.dart` ends in
//      `&& !isAiComposing`, and `sendBuffer` has exactly one production call
//      site (`chat_flow_composer.dart` `onSend:`)."
//
// 🔴 EVERY FACT IN IT IS STILL TRUE TODAY. `canSend` really does end in
// `&& !isAiComposing`; `sendBuffer` really does have exactly one production call
// site. The CONCLUSION was false anyway, and no amount of re-checking those facts
// would ever have surfaced it — because the argument enumerated the CALLERS OF
// THE CRITERION (`canSend`) and then drew a conclusion about the DANGEROUS ACTION
// (`ManualDelivery.deliverText`). Those are two different sets, and `deliverText`
// had a second entry point that consults `canSend` nowhere at all:
// `ChatController.sendFavorite`. A phrase saved to Favorites (常用) mid-stream was
// partial model output, stored permanently and deliverable forever after.
//
// ⇒ THE LAW (W2.5): to argue that a dangerous action is guarded, enumerate the
//   paths that lead TO THAT ACTION. Enumerating the callers of a guard proves
//   only that the guard is called where the guard is called.
//
// ─── EVERY PATH THAT REACHES `ManualDelivery.deliverText` ───────────────────
//
// Method, so the next reader re-derives instead of trusting:
//   `grep -rn 'deliverText(' apps/mobile/lib`  → 4 hits, one of which is the
//   declaration itself (`manual_delivery.dart`). If that count is not 4, this
//   section is STALE and the enumeration must be redone, not patched.
//   (🔴 This tripwire has FIRED once, and worked: the count moved 3 → 4 when
//   REQ-12-09's multi-select send landed (2026-08-12), and the enumeration
//   below was redone from scratch against the live call sites on 2026-08-13 —
//   entry 3 is the result. Patching the number without the redo is worse than
//   no tripwire: the next reader would inherit a count that matches and an
//   enumeration that does not.)
// Anchors are symbol names rather than line numbers, for the reason at the end
// of this block.
//
//   1. ➤ — the composer's send button.
//      `chat_utterance.dart` `_sendBuffer` → `deliverText`
//        ← `ChatController.sendBuffer` (`chat_explicit_delivery.dart`)
//        ← `chat_flow_composer.dart`, `onSend: s.controller.sendBuffer`.
//      GUARDED on compose state. The same widget call passes
//      `canSend: s.controller.canSend`; `compose_band.dart` `_sendButton` is
//      `onTap: on ? widget.onSend : null` over `final bool on = widget.canSend`;
//      and `ChatController.canSend` ends in `&& !isAiComposing`. That term lives
//      in the controller rather than the widget (ledger row **W2.5-1**), so a
//      re-layout of the composer cannot drop it silently.
//
//   2. Tap-to-send — tapping a saved phrase in the 「+」 panel.
//      `ChatController.sendFavorite` (`chat_explicit_delivery.dart`)
//      → `deliverText`
//        ← `chat_flow_composer.dart`, `onSend: s.controller.sendFavorite`
//          handed to `showPlusPanel`; the tap target is `plus_panel.dart`'s
//          `plus.fav.send.$text` row.
//      NOT guarded on compose state — deliberately, and it must stay that way.
//      A favourite is a phrase the USER wrote; re-validating it against some
//      unrelated live compose run would answer a question this path never asked.
//      It also never touches the composer buffer: `sendFavorite`'s own doc says
//      it "deliberately does NOT route through the buffer".
//      What keeps partial model output out is therefore on the WRITE side, one
//      layer earlier: `plus_panel.dart` `_saveButton` disables "save to current
//      buffer" (存入当前缓冲) while `aiComposing` (ledger row **W2.5-E**), fed
//      from `chat_flow_composer.dart`
//      `_openPlusPanelRouted` as `aiComposing: s.controller.isAiComposing` — the
//      SAME getter `canSend` reads, not a second copy of the fact. Pinned by
//      `apps/mobile/test/plus_panel_ai_composing_wire_test.dart`, which goes red
//      if either the criterion or that one wiring line is removed.
//      ⚠️ RESIDUAL, written down rather than assumed away: a favourite saved
//      BEFORE W2.5-E landed may already hold a partial. Nothing on this side can
//      tell; the user's ✕ is the only remedy, and that is accepted.
//      Its other guards answer other questions: `noPcTarget` makes the row inert
//      on a cloud instance (`plus_panel.dart` `_row`), and `deliverText` applies
//      its own link/ack gates to both entry points alike.
//
//   3. The "+" panel's multi-select send — ticking rows and pressing send
//      (REQ-12-09, landed 2026-08-12; this is the call site that fired the
//      tripwire above).
//      `ChatController.sendPlusSelection` (`chat_explicit_delivery.dart`)
//      → `deliverText` — once, for the joined text; each ticked picture goes
//        through `ImageSendController.sendStoredImage` instead, never here
//        ← `chat_flow_composer.dart`, `onSendSelection:
//          s.controller.sendPlusSelection`.
//      NOT guarded on compose state — same stance as 2, for the same reason:
//      the text it delivers comes exclusively from STORED content.
//      `PlusPanelSelection.composedText` joins `PlusPick.text`s (Favorites
//      (常用) phrases and record-only (仅记录) note rows —
//      `plus_panel_selection.dart`, whose own header
//      says the panel never writes through that type), never the live
//      composer buffer. What keeps partial model output out is therefore the
//      same WRITE-side guard as entry 2 (W2.5-E), and W2.5-E's residual
//      gains a third read path: a favourite saved before that guard landed
//      is deliverable from here too — still the user's ✕ as the only remedy.
//      Its F4 pre-flight (`exceedsInjectTextCap` checked before the first
//      leg) exists to prevent SPLIT sends, not partials — named so nobody
//      mistakes it for a compose-state guard.
//
// Text also reaches the wire WITHOUT `deliverText`. Listed so the next reader
// can see this was an enumeration of the ACTION, not of one function:
//   • `chat_utterance.dart` `_deliverDirect` — ⚡ direct policy, and the compose
//     terminal. Enqueues and emits `entry.displayText` off an immutable
//     TimelineEntry; for a compose run that row's text is written by
//     `utterance_compose.dart`'s `ucDone` from `compose:done`'s `output_text`,
//     i.e. the same complete text this guard ran on — never the live buffer.
//   • `manual_delivery_reinject.dart` `runReInject` — deferred delivery /
//     resend-after-edit / banner resend. Re-sends a STORED row's text;
//     grepping `_buffer` / `aiBuffer` over that file returns nothing.
//   • `chat_control_keys.dart` `runControlKey` — puts a `ControlKeyKind` on the
//     wire, not text. It CLEARS `_buffer` on ✕ and never transmits it.
//   • `DeliveryOutbox.drain()` — not an entry point but a resumption: it
//     re-emits items the two paths above already enqueued. 🔴 Which is itself
//     worth knowing here — `deliverText` is a ONE-WAY DOOR. Once an item is
//     enqueued, nothing downstream re-asks whether it should have been.
//
// ⚠️ This block is itself an example of what it warns about, twice over. Its
// first version named `chat_flow_composer.dart:177` as the enforcement point —
// true when written, false hours later when W2.5-1 moved the term. Its second
// version had the line numbers right and the SHAPE OF THE ARGUMENT wrong, which
// is worse: a stale line number gets noticed, a wrong-shaped proof reads as
// rigour. A comment asserting behaviour in another file has a shelf life, and
// the safe form is a greppable symbol plus a test that fails when it moves.
//
// Do not restate any of the above as an unqualified "nothing partial can reach
// the user". That sentence's truth lives in someone else's files, which is
// precisely the anti-façade ④ shape (a comment asserting behaviour elsewhere, true
// when written and silently false later).
//
// ─── CALIBRATION ────────────────────────────────────────────────────────────
//
// 🔴 A guard that rejects correct output is worse than no guard. The way a
// false-rejecting rule gets resolved is that someone loosens it until it never
// fires, and what gets loosened is exactly the property owner demanded. Every
// threshold below is therefore set to catch the CATASTROPHIC shape with a wide
// margin, never to score borderline quality. Quality scoring is the corpus
// judges' job (`verify/eval/judges/index.mjs`) and it is a DIFFERENT QUESTION:
// they ask "how good was this", this file asks "may this be delivered at all".
// The two must not be merged, and neither imports the other.
//
// 🔴 No rule below is derived from any corpus sample. Every rule is a general
// property of the five inputs, authored before the corpus was measured against
// it; `verify/eval/run-eval.mjs --mode=guard` then measures this file, and a
// rule that only fires on remembered strings would be a gate that is true of the
// test and of nothing else.

import {
  HAN_RE,
  countMatching,
  cpLen,
  hasScript,
  letterCount,
  normalizeForEcho,
  properNounShape,
  scriptClassFor,
} from './output-guard-text';
import {
  COMPRESSION_FLOOR_CHARS,
  HAN_SOURCE_FRACTION,
  MIN_ORGANIZE_RETENTION,
  volumeBudget,
} from './output-guard-volume';
import { assistantFrame } from './output-guard-frames';

// Re-exported, not re-declared: the union now lives beside `MAX_EXPANSION`, the
// exhaustive table keyed by it. See that file for why the cycle forced the move.
// This keeps `ComposeGuardTask` importable from here, which is where
// `compose/index.ts` and every existing consumer expects it.
export type { ComposeGuardTask } from './output-guard-volume';
import type { ComposeGuardTask } from './output-guard-volume';

export interface ComposeGuardInput {
  task: ComposeGuardTask;
  /** The text we sent the model (the compose input, post dictionary-replace). */
  source: string;
  /** The complete text the model returned. */
  output: string;
  /** Declared source language; may be 'auto'. */
  source_lang?: string;
  /** Declared target language (translate only). */
  target_lang?: string;
}

/** Named reasons. Machine-readable: logged, and carried in the error detail. */
export type ComposeGuardRule =
  | 'assistant_frame'
  | 'target_script_absent'
  | 'source_script_dominant'
  | 'untranslated_echo'
  | 'invented_numerals'
  | 'invented_latin_tokens'
  | 'volume_runaway'
  | 'over_compressed';

/** A repair changed the text but did NOT reject it. Reported so a caller can
 *  log that the model needed cleaning up without failing the user's turn. */
export type ComposeGuardRepair = 'stripped_wrapping';

export type ComposeGuardVerdict =
  | { ok: true; text: string; repairs: ComposeGuardRepair[] }
  | { ok: false; rule: ComposeGuardRule; detail: string; repairs: ComposeGuardRepair[] };

// ─── text-measurement primitives: see `output-guard-text.ts` ────────────────
// 800-line cap: 「script classification」 and 「normalisation helpers」 moved there
// VERBATIM (that file's header lists the single mechanical edit and why the cut
// falls exactly here). They answer 「how do we measure a string?」; everything
// left in this file answers 「is THIS output deliverable?」. No public export of
// this module moved, so no caller, test or `verify/eval/run-eval.mjs` path did.

// ─── rule 2: wrapping repair ────────────────────────────────────────────────

const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ["'", "'"],
];

function isWrapped(s: string): boolean {
  const t = s.trim();
  if (t.length < 2) return false;
  return QUOTE_PAIRS.some(([o, c]) => t.startsWith(o) && t.endsWith(c));
}

/**
 * Strip a code fence or a matched quote pair the model added around its answer.
 *
 * REPAIRED, not rejected: the model did the task and then gift-wrapped it, and
 * throwing away correct work over packaging is the false-reject this guard must
 * not commit. Same mechanism as `stripWrapping` in stt-polish.ts — the house
 * already treats this as cosmetic.
 *
 * 🔴 The guard against eating real content: a pair is only stripped when the
 * SOURCE is not itself wrapped in a pair. Translating 「他说：“我不去。”」
 * (`He said: "I won't go."`) must
 * keep its quotation marks, and a rule that could not tell those apart would
 * silently edit the user's meaning.
 */
function repairWrapping(source: string, output: string): { text: string; repaired: boolean } {
  let out = output.trim();
  const beforeFence = out;
  out = out.replace(/^```[A-Za-z0-9_-]*\r?\n?/, '').replace(/\r?\n?```$/, '').trim();
  let repaired = out !== beforeFence;
  if (!isWrapped(source)) {
    for (const [o, c] of QUOTE_PAIRS) {
      if (out.length >= 2 && out.startsWith(o) && out.endsWith(c)) {
        const inner = out.slice(o.length, out.length - c.length).trim();
        // Only when the pair really is a wrapper: an inner copy of the closing
        // mark means these are two quoted spans, not one wrapping the whole.
        if (inner.length > 0 && !inner.includes(c)) {
          out = inner;
          repaired = true;
        }
        break;
      }
    }
  }
  return { text: out, repaired };
}

// ─── rule 3: assistant frames ───────────────────────────────────────────────
// 800-line cap: this section moved WHOLE to `output-guard-frames.ts` —
// `ASSISTANT_FRAMES`, `SELF_IDENTIFICATION_FRAMES`, `foldForFrame`,
// `sourceIsFramed` and `assistantFrame`, byte-for-byte with their comments (that
// file's header lists the single mechanical edit and why the cut falls exactly
// here). Read it before touching rule 3: the per-entry justification for every
// literal, and the 2026-08-08 correction that retired the cross-language false
// reject, both live there. Only `assistantFrame` is imported back — the other
// four never had a caller outside the family.

// ─── rule 7: numerals available from the source ─────────────────────────────

const CJK_DIGIT: Readonly<Record<string, number>> = {
  '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
  '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
};
const CJK_UNIT: Readonly<Record<string, number>> = { '十': 10, '百': 100, '千': 1000 };
const CJK_BIG: Readonly<Record<string, number>> = { '万': 10000, '亿': 100000000 };
const CJK_NUM_RE = /[零〇一二两三四五六七八九十百千万亿]+/gu;

/**
 * Value of one run of Chinese numerals, or null if the run is not a number
 * (「万一」 "just in case" and 「十分」 "extremely" and similar are ordinary
 * words that happen to be spelled with numeral characters — returning null for
 * anything malformed keeps them from minting phantom "available" numbers).
 */
function cjkNumeralValue(run: string): number | null {
  let total = 0;
  let section = 0;
  let digit = 0;
  let sawAny = false;
  for (const ch of run) {
    if (ch in CJK_DIGIT) {
      digit = CJK_DIGIT[ch] as number;
      sawAny = true;
    } else if (ch in CJK_UNIT) {
      const unit = CJK_UNIT[ch] as number;
      // 十五 (shí wǔ) = 15: a bare 十 (ten) leads with an implicit one.
      section += (digit === 0 ? 1 : digit) * unit;
      digit = 0;
      sawAny = true;
    } else if (ch in CJK_BIG) {
      const big = CJK_BIG[ch] as number;
      section += digit;
      total += section * big;
      section = 0;
      digit = 0;
      sawAny = true;
    } else {
      return null;
    }
  }
  if (!sawAny) return null;
  return total + section + digit;
}

/**
 * Every number the output is ALLOWED to contain, given the source.
 *
 * 🔴 The CJK-numeral trap, handled explicitly. 「三」 ("three") legitimately
 * becomes "3" when speech is tightened into writing, and a rule that fired on
 * that would be switched off within a week — which is strictly worse than not having the rule,
 * because it takes the invented-fact detector with it. So the source's Chinese
 * numerals are converted and counted as available, and only digits that are
 * neither in the source verbatim nor derivable from it are treated as invented.
 */
function availableNumbers(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(CJK_NUM_RE)) {
    const run = m[0];
    // The run as ONE number: 「二十五」 (twenty-five) → 25.
    const v = cjkNumeralValue(run);
    if (v !== null) out.add(String(v));
    // …and every numeral inside it on its own. A run is not necessarily a single
    // number: 「一二三」 is an enumeration ("one, two, three") that tightens to
    // "1 2 3", and reading it only as the integer 3 would flag "1" and "2" as
    // invented — the exact CJK-numeral false reject this rule must not commit.
    // Being generous here is the safe direction: a missed invented digit costs a
    // report line, a false reject costs the user their sentence.
    for (const ch of run) {
      if (ch in CJK_DIGIT) out.add(String(CJK_DIGIT[ch] as number));
      else if (ch in CJK_UNIT) out.add(String(CJK_UNIT[ch] as number));
      else if (ch in CJK_BIG) out.add(String(CJK_BIG[ch] as number));
    }
  }
  return out;
}

const DIGIT_RUN_RE = /\d+/gu;
const LATIN_WORD_RE = /[A-Za-z]{2,}/gu;

// ─── volume thresholds ──────────────────────────────────────────────────────
//
// 800-line cap: this section moved WHOLE to `output-guard-volume.ts` —
// `VOLUME_FLOOR_CHARS`, `MAX_EXPANSION`, `MIN_ORGANIZE_RETENTION`,
// `COMPRESSION_FLOOR_CHARS`, `HAN_SOURCE_FRACTION`, all byte-for-byte with their
// comments. The budget arithmetic went with them as `volumeBudget()`, which also
// carries the dense-short-source allowance added 2026-08-08. Read that file
// before touching rule 9; the calibration history and the impossibility proof
// for a length-only fix both live there.

// ─── the guard ──────────────────────────────────────────────────────────────

const reject = (
  rule: ComposeGuardRule,
  detail: string,
  repairs: ComposeGuardRepair[],
): ComposeGuardVerdict => ({ ok: false, rule, detail, repairs });

/**
 * Decide whether a completed translate/organize output may be delivered.
 *
 * `draft_polish` is deliberately out of scope: that path already carries three
 * gates (stripWrapping, protected-term drift, checkMeaningPreserved) and adding
 * a fourth opinion would give one question two answers.
 */
export function guardComposeOutput(input: ComposeGuardInput): ComposeGuardVerdict {
  const repairs: ComposeGuardRepair[] = [];
  const source = String(input.source ?? '');

  // ── nothing came back ──
  //
  // 🔴 Deliberately NOT rejected here, and this is a correction of my own first
  // draft. An empty compose result ALREADY has a loud, correct, four-language
  // answer that the user can read: the phone raises `COMPOSE_EMPTY_OUTPUT`
  // (「AI 返回了空结果」 "AI returned an empty result") and restores the pre-run buffer
  // (`ai_compose_controller.dart` / `utterance_compose.dart`, both on the
  // AiComposeDone branch). Rejecting it here would replace that sentence with
  // `COMPOSE_OUTPUT_REJECTED` — a DIFFERENT fact ("the model answered and we
  // held the answer back", not "nothing came back") — and would give one
  // question two answers, which is this repo's #1 bug shape. So the empty
  // case is passed through to the mechanism that already owns it.
  //
  // 🔴 CORRECTED (2026-08-07): the sentence above used to read "Rejecting it
  // here would replace a REGISTERED sentence with this guard's unregistered
  // bare token — a regression in exactly the dimension owner's R11 rule is
  // about". That is stale: `COMPOSE_OUTPUT_REJECTED` was registered as error
  // code 62 the same day (owner approved, `docs/decisions/2026-08-07-owner-
  // grants-error-code-62-compose-output-rejected.md`) — the registration note
  // lives 175 lines below at :696-727 in this same file, which already says
  // so. The design decision is unchanged: an empty result must still raise
  // COMPOSE_EMPTY_OUTPUT rather than this guard's code, because the two are
  // answers to different questions — only the "unregistered" reasoning for it
  // is retired.
  //
  // The other rules must not run on it either: an empty string trivially
  // "contains no Han characters", so target_script_absent would fire and
  // rename a well-handled failure.
  if (String(input.output ?? '').trim() === '') {
    return { ok: true, text: '', repairs };
  }

  // ── rule 1: wrapping (repair, never reject) ──
  const { text, repaired } = repairWrapping(source, String(input.output));
  if (repaired) repairs.push('stripped_wrapping');
  if (text.trim() === '') {
    // Wrapping and nothing else — same delegation as above.
    return { ok: true, text: '', repairs };
  }

  // ── rule 3: the model talked about the task instead of doing it ──
  const frame = assistantFrame(source, text);
  if (frame !== null) {
    return reject('assistant_frame', `output opens with an assistant frame: ${JSON.stringify(frame)}`, repairs);
  }

  const srcLetters = letterCount(source);

  const target = scriptClassFor(input.target_lang);

  if (input.task === 'translate') {
    const sourceCls = scriptClassFor(input.source_lang);
    // 🔴 "One token" cannot mean "contains no whitespace" — Chinese and Japanese
    // are written WITHOUT spaces, so that test is true of every CJK SENTENCE,
    // and the proper-noun exemption below then switched the script rules off for
    // the entire writing system this product is built around. Measured: a whole
    // echoed Chinese sentence was exempted, so zh→ja and ja→zh echoes were
    // accepted silently — the exact pair `untranslated_echo` exists for, and the
    // pair its own comment names.
    //
    // 🔴 …and then the repair over-corrected. Requiring "no whitespace" excluded
    // every proper noun made of more than one word — "New York Times",
    // "Windows Update" — and BOTH rules below read this one symbol, so the
    // en→zh case false-rejected as `target_script_absent` while the en→de case
    // false-rejected as `untranslated_echo`. Fixing either alone would have left
    // the other live. The shape test now lives in `properNounShape`
    // (output-guard-text.ts), which states clause by clause what still keeps an
    // echoed sentence out; the DECISION of what an affirmative answer licenses
    // stays here.
    const echoed = normalizeForEcho(text) === normalizeForEcho(source);
    // A proper-noun-shaped source returned unchanged is plausibly a name that
    // has no translation ("FlowMic" → "FlowMic"). A whole echoed SENTENCE never
    // is, and that is the failure being hunted, so the exemption is narrowed to
    // exactly the shape that can be innocent.
    const properNounPassthrough = properNounShape(source) && echoed;

    // ── rule 4: the model did not do the work at all ──
    //
    // 🔴 This is the failure the previous window measured and never named: on
    // en→zh the model echoed the English back untranslated. It is NOT the model
    // answering — nothing was said that a "did it reply instead of translate"
    // judge could see — it is the model no-op-ing, so length, banned tokens and
    // illocution are all silent on it. A script test against the declared target
    // is the sharpest angle available: a Chinese translation contains Han
    // characters, and an English one is not written in Han.
    if (target !== null && srcLetters > 0 && !properNounPassthrough && !hasScript(text, target)) {
      return reject(
        'target_script_absent',
        `target language '${String(input.target_lang)}' is written in ${target}, and the output contains no ${target} characters — the text was not translated`,
        repairs,
      );
    }

    // ── rule 5: the output is still in the source's script ──
    // Complements rule 4: an English target whose output is mostly Han passes
    // "contains a Latin character" on one stray token but is plainly untranslated.
    if (target !== null && target !== 'han' && target !== 'japanese') {
      const letters = letterCount(text);
      const han = countMatching(text, HAN_RE);
      if (letters > 0 && han / letters > 0.5) {
        return reject(
          'source_script_dominant',
          `${((han / letters) * 100).toFixed(0)}% of the output is Han characters but the target language is '${String(input.target_lang)}'`,
          repairs,
        );
      }
    }

    // ── rule 6: verbatim echo across a known language boundary ──
    // Catches the same no-op where the script rules above cannot see it (e.g.
    // zh→ja, whose scripts overlap). Requires both languages declared and
    // different, and enough text that an accidental identity is not plausible.
    //
    // 🔴 `hasScript(source, sourceCls)` is load-bearing: NEVER act on a declared
    // language the text itself contradicts. Measured — the corpus labels two
    // prompt-injection cases `zh-CN` whose input is plainly English, and whose
    // correct output is that English unchanged. Trusting the label rejected both.
    // The declaration is a hint from a caller; the characters are evidence.
    if (
      echoed
      && !properNounPassthrough
      && sourceCls !== null
      && hasScript(source, sourceCls)
      && target !== null
      && (input.source_lang ?? '').trim().toLowerCase() !== (input.target_lang ?? '').trim().toLowerCase()
      && normalizeForEcho(source).length >= 8
    ) {
      return reject(
        'untranslated_echo',
        `the output is the source text unchanged (${String(input.source_lang)} → ${String(input.target_lang)})`,
        repairs,
      );
    }
  }

  if (input.task === 'organize') {
    // ── rule 7: invented numbers ──
    const allowed = availableNumbers(source);
    const novelDigits = [...new Set(String(text).match(DIGIT_RUN_RE) ?? [])]
      .filter((d) => !source.includes(d) && !allowed.has(d));
    if (novelDigits.length > 0) {
      return reject(
        'invented_numerals',
        `numbers absent from the input and not derivable from its Chinese numerals: ${JSON.stringify(novelDigits)}`,
        repairs,
      );
    }

    // ── rule 8: invented latin tokens ──
    const hanSrc = countMatching(source, HAN_RE);
    if (srcLetters > 0 && hanSrc / srcLetters >= HAN_SOURCE_FRACTION) {
      const lowerSrc = source.toLowerCase();
      const novelLatin = [...new Set((String(text).match(LATIN_WORD_RE) ?? []).map((w) => w.toLowerCase()))]
        .filter((w) => !lowerSrc.includes(w));
      if (novelLatin.length > 0) {
        return reject(
          'invented_latin_tokens',
          `latin tokens absent from a predominantly-Han input: ${JSON.stringify(novelLatin)}`,
          repairs,
        );
      }
    }
  }

  // ── rule 9: volume runaway ──
  // The budget itself is `output-guard-volume.ts`; it carries the dense-short
  // CJK-source allowance, which is why `text` and `target` are handed over.
  const inLen = cpLen(source);
  const outLen = cpLen(text);
  const budget = volumeBudget(input.task, source, text, target, inLen);
  if (inLen > 0 && outLen > budget) {
    return reject(
      'volume_runaway',
      `output ${outLen} chars is ${(outLen / inLen).toFixed(1)}× the ${inLen}-char input (budget ${budget}) — the model expanded instead of ${input.task === 'translate' ? 'translating' : 'tightening'}`,
      repairs,
    );
  }

  // ── rule 10: organize summarised instead of editing ──
  if (input.task === 'organize' && inLen >= COMPRESSION_FLOOR_CHARS && outLen < inLen * MIN_ORGANIZE_RETENTION) {
    return reject(
      'over_compressed',
      `output ${outLen} chars retains ${((outLen / inLen) * 100).toFixed(0)}% of the ${inLen}-char input (floor ${(MIN_ORGANIZE_RETENTION * 100).toFixed(0)}%) — this is a summary, not an edit`,
      repairs,
    );
  }

  return { ok: true, text, repairs };
}

/** One-line, machine-greppable reason for the server log and the error detail. */
export function describeGuardRejection(v: Extract<ComposeGuardVerdict, { ok: false }>): string {
  return `${v.rule}: ${v.detail}`;
}

/**
 * The wire code for a guard rejection. ONE named constant so the final choice is
 * a one-line swap.
 *
 * ✅ REGISTERED — error code 62, owner approved 2026-08-07
 * (`docs/decisions/2026-08-07-owner-grants-error-code-62-compose-output-rejected.md`).
 * It is now present on BOTH user-facing faces, which have to move together:
 *   · `packages/protocol/src/error-codes.ts` (zh_CN + en; `i18n-error-keys` lint
 *     requires both, and `error-codes.test.ts` pins the catalog at 62);
 *   · the phone's own table `aiErrorCode` in
 *     `apps/mobile/lib/src/settings/strings/compose_strings.dart` (four
 *     languages) — the phone does NOT render the protocol strings.
 *
 * 🔴 HISTORY, KEPT ON PURPOSE. For the length of one window this identifier was
 * deliberately UNREGISTERED, and reached the user as a bare token through the
 * phone table's `default:` branch (「a code we cannot name is exactly the one
 * worth showing」). It carried a release precondition — no artifact may ship
 * carrying it — because 0.2.53 exists precisely because a bare code was clipped
 * to three letters on a user's screen, and G-16 (codes that reach users as bare
 * identifiers) is still an open account. The precondition was discharged by
 * registration, in the same window that incurred it. The reason to keep this
 * paragraph is that it is the only evidence the gate was walked through rather
 * than walked around.
 *
 * ⚠️ It stays a plain string rather than a `ServerError` because this class
 * carries the RULE that fired; the original typing argument (`ServerError.code`
 * is typed `ErrorCode`) no longer applies now that the code is registered.
 *
 * WHY NOT REUSE AN EXISTING CODE. All five LLM_* codes render a sentence that is
 * false here — the model DID respond, the credentials were fine, nothing timed
 * out, and the model is configured correctly; we are refusing what it produced.
 * `LLM_INVALID_MODEL` is the worst of them, not the best: it sends the user to
 * configure a model that is already working. owner's R11 iron rule is that every
 * status word must be able to answer "what grounds do you have for saying so"
 * (凭什么这么说), and none of them can.
 */
export const COMPOSE_OUTPUT_REJECTED_CODE = 'COMPOSE_OUTPUT_REJECTED';

/**
 * Thrown by the orchestrator when the guard rejects the completed output.
 *
 * A distinct class rather than a `ServerError` for the typing reason above; the
 * compose handler catches it explicitly and emits `compose:error`. It carries
 * the rule so the wire message and the server log name the same thing.
 */
export class ComposeOutputRejectedError extends Error {
  readonly code = COMPOSE_OUTPUT_REJECTED_CODE;
  readonly rule: ComposeGuardRule;
  readonly detail: string;
  constructor(rule: ComposeGuardRule, detail: string) {
    super(`compose output rejected (${rule}): ${detail}`);
    this.name = 'ComposeOutputRejectedError';
    this.rule = rule;
    this.detail = detail;
  }
}
