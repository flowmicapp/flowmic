// The construction contract of `SttSessionBridge` (engine/stt-session.ts): the
// event sink it fans out through, and every dependency it may be given —
// together with WHY each one exists, which is the bulk of this file. Types only;
// there is no runtime behaviour here.
//
// ⚠️ THE SPLIT FROM `stt-session.ts` WAS FORCED BY THE 800-LINE CAP
// (verify/lint/file-size.mjs). The block moved VERBATIM, every doc comment with
// the field it documents, and `stt-session.ts` re-exports both names so no
// importer changed. Read it as a file-size split, not as a claim that the
// bridge's contract became a separate layer.

import type { ProcessingMode, SttRefine } from '@flowmic/protocol';
import type { AudioSession } from '../stt/audio/session';
import type { VadGate } from '../stt/vad-gate';
import type { BuiltOrchestrator } from '../stt/engine-factory';
import type { FinalTextTransform } from '../stt/final-text-pipeline';
import type { PolishDeps, PolishSkipReason } from '../stt/stt-polish';
import type { SelectedLlmConfig } from '../compose/llm-config';

/** Sink for whitelisted STT events (audio handler fans out to mobile + PC). */
export interface SttEmitter {
  emit(event: string, payload: unknown): void;
}

/**
 * A2-5 / REQ-12-08 — the two character counts an utterance produced, carried
 * ACROSS the metering seam.
 *
 * 🔴 WHY THE SEAM CHANGED SHAPE INSTEAD OF THE TABLE GROWING TWO ZERO COLUMNS.
 * `usage_events` was asked for "how many characters were spoken this time / how many characters were sent out" and the meter is a
 * layer that has never seen text: `onComplete(durationMs, isByok)` carried
 * milliseconds and a billing flag and nothing else. The cheap move — add two
 * columns and default them — would have produced a pair of numbers that are 0
 * on every row forever, i.e. a measurement-shaped field that measures nothing.
 * R11's rule is the other way round: "does the layer making this judgment actually
 * have in hand all the facts it needs to make it". It did not, so the seam now carries them.
 *
 * ⚠️ UTF-16 code units (`String.length`), the same quantity `stt.polish`'s
 * "chars" log lines and `stt-factory`'s interim instrument already report. One
 * imperfect definition of "character count" beats two exact ones that disagree.
 */
export interface SttCharCounts {
  /**
   * What the ENGINE produced for this utterance: summed over every final —
   * soft-segment finals included — AFTER the pure two-stage pipeline
   * (dictionary → normalizer) and BEFORE polish.
   *
   * Counted at the point the text is COMPUTED, so a session torn down before
   * delivery still reports what was transcribed. That asymmetry with the field
   * below is the whole point of having two.
   */
  transcript: number;
  /**
   * What actually LEFT the server on `stt:final` frames — post-polish, and
   * counted at the emit itself rather than beside it, so a final that was
   * computed and then dropped (`dispose()` mid-polish) cannot be counted as
   * delivered. 🔴 This is the number a user disputing "I clearly said way more than that" is
   * actually asking about.
   */
  delivered: number;
}

export interface SttSessionDeps {
  /** From makeSttOrchestratorFactory — builds the driver + BYOK/gated flags.
   *  Throws SttConfigMissingError synchronously when no routing matches (#16). */
  build: (session: AudioSession, language: string, userId: string, vad?: VadGate) => BuiltOrchestrator;
  emitter: SttEmitter;
  userId: string;
  mode: ProcessingMode;
  sourceLang: string;
  targetLang?: string;
  /** The ONE recordSttUsage seam — called exactly once at settle.
   *
   *  🔴 A2-5 widened it with a THIRD argument, `chars`, and the widening is the
   *  card (see {@link SttCharCounts}). It is REQUIRED on the producing side so
   *  the bridge cannot settle without saying what it transcribed; consumers that
   *  do not care may still declare `(durationMs, isByok)` or `()` and TypeScript
   *  accepts them — which is why the reverse control for this wiring has to be
   *  behavioural (a row with real counts), not a compile error. */
  onComplete: (durationMs: number, isByok: boolean, chars: SttCharCounts) => void;
  /** v0.2.3 — the polish LLM's metering seam, the sibling of [onComplete].
   *
   *  Called once per polished terminal-final, and ONLY when the model actually
   *  reported its usage. 0.1.0 scoped polish out of billing, so the console's
   *  LLM meter could only ever read 0 while polish ran on every utterance —
   *  a dial that cannot move. Absent (the adapter-only harnesses) ⇒ no metering,
   *  same shape as the other optional deps here. */
  onPolishUsage?: (tokensIn: number, tokensOut: number, isByok: boolean) => void;
  /** Pure FINAL-text pipeline (06 §5: dictionary replace → normalizer),
   *  snapshotted per audio session at build time. Applied to FINAL text ONLY —
   *  interim payloads are never touched (06 §5 contract). Absent → identity
   *  (adapter-only unit harnesses); the ONE production injector is stt-factory. */
  finalText?: FinalTextTransform;
  /** WP-R4-6 opt-in LLM polish, snapshotted per audio session at build time.
   *  PRESENT ⇔ this session snapshotted stt.polish ON at audio:start AND the
   *  llm_tokens valve had headroom (M6) AND an `llm.config` resolved (RT-1a) —
   *  see stt-factory resolvePolishDep, which owns all three conditions;
   *  ABSENT ⇔ polish did not run. ✅ RT-1 closed the account RT-1a opened here:
   *  "absent" no longer answers two questions, because "ON but no usable LLM" now
   *  arrives as [polishUnavailable] and is stamped onto the wire. Absent-and-
   *  silent means "the user never asked", and only that.
   *  Applied ONLY to the utterance-closing final (is_segment=false)
   *  AFTER the pure two-stage pipeline — never to interim or soft-segment
   *  finals. In production the factory fills deps.protectedTerms (dict-canonical
   *  protection, lead-controller ruling 2026-07-24); fetch/budgetMs/streamerFor remain seams.
   *
   *  M4: `llm` is the provenance-carrying SelectedLlmConfig, not a bare
   *  LlmConfig — the bridge cannot hold the polish config without holding the
   *  answer to "who provided it", so the metering flag below is physically derived from
   *  the SAME selection that produced the config. */
  polish?: { llm: SelectedLlmConfig; deps?: PolishDeps };
  /** RT-1 — polish was REQUESTED for this session and could NOT be armed.
   *
   *  Present ⇔ [polish] is absent AND `stt.polish.enabled` was true: the LLM
   *  config was unusable (RT-1a) or the llm_tokens valve was exhausted (M6).
   *  The bridge stamps `polish:'skipped'` + this reason onto the terminal final,
   *  which is the ONE polish-skip the phone can still be told about — see
   *  [[polishWireForFinal]] for why the LATE skips deliberately cannot be.
   *
   *  Closes the account resolvePolishDep's doc block registered against RT-1:
   *  "the degrade is silent TO THE USER". It costs no mobile work — the
   *  `polish:'skipped'` mark is already painted (chat_utterance.dart records the
   *  entry id → chat_flow_page.dart → PolishSkippedMark). */
  polishUnavailable?: PolishSkipReason;
  /** 🔴 RT-1 — how a polished terminal final is delivered. PRODUCTION IS ALWAYS
   *  `'sync'`, and there is a census that FAILS if any file under `src/` ever
   *  says otherwise (test/polish-delivery-census.test.ts, "ACTIVATION TRIPWIRE").
   *
   *  ⚠️ "ALWAYS" has one exception in the record, and it is why the census exists:
   *  from 0.2.59 to 2026-08-11 stt-factory selected `'detached'`, and because the
   *  detached pass has no carrier, every polished correction in that window was
   *  computed, billed and dropped. Reverted by POLISH-1 on owner's ruling. The
   *  census alone did not catch it — it was inverted in the same commit — so the
   *  delivery is now ALSO asserted behaviourally ("THE DELIVERY JOIN",
   *  test/stt-session-bridge.test.ts).
   *
   *  `'sync'`   — the final waits for the polish and carries the honest
   *               `polish:'applied'|'skipped'` signal. Today's shipped path.
   *  `'detached'` — owner's async shape: the final leaves immediately and the
   *               polish runs on its own lifecycle. COMPLETE AND TESTED, and
   *               deliberately not reachable from production.
   *
   *  ACTIVATION TRIPLE, all three required — this is not one merge:
   *    (i)   mobile `_applyRefined` selects its target row by entry type + owner
   *          (today it takes the newest row unfiltered, so a late frame can
   *          overwrite an image caption or a typed note — see
   *          [[runDetachedPolish]]);
   *    (ii)  an APK carrying that fix is released;
   *    (iii) the FIELD risk has retired — phones already installed still run the
   *          old consumer, and wiring the server up exposes EVERY utterance to
   *          them, not just the ≥15 s ones GA-14 touches. 🔴 The adoption
   *          threshold for (iii) is OWNER's call; this file does not invent a
   *          number and neither should the card that flips this. */
  polishDelivery?: 'sync' | 'detached';
  /** GA-14 two-pass refine. PRESENT ⇔ this session snapshotted `stt.refine` ON at
   *  audio:start AND a BATCH engine could be resolved for the second pass —
   *  absent means refine simply does not run for this session, which is why the
   *  factory logs the reason when the setting was on but no batch engine exists
   *  (a switch that is on and does nothing must at least be explainable).
   *  `transcribe` takes the retained PCM and returns one whole-utterance text. */
  refine?: { cfg: SttRefine; transcribe: (pcm: Buffer) => Promise<string> };
  /** stt:level throttle window (default 200 ms). */
  levelIntervalMs?: number;
  now?: () => number;
}
