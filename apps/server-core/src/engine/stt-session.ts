// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (four-layer robustness — events stt:interim/final/
//     error/engine-status; audio:auto-stopped), §3 (interim=offlineAccum+
//     onlineDraft; stt:level amplitude), §4 (BYOK billing determination)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §2.3 (VAD gating)
//   CLAUDE.md red line: no silent failure
//
// The bridge that implements the SttOrchestrator SEAM (engine/orchestrator.ts)
// on top of the stt/ engine driver. Owns one AudioSession + one VadGate + one
// SttEngineOrchestrator per audio:start..audio:stop run; adapts driver events
// onto whitelisted socket emits; drives stt:level from the VAD amplitude; and
// calls the single recordSttUsage seam (onComplete) exactly once at settle.

import { randomUUID } from 'node:crypto';
import type { SttOrchestrator } from './orchestrator';
import { AudioSession } from '../stt/audio/session';
import { VadGate } from '../stt/vad-gate';
import type { SttEngineOrchestrator } from '../stt/orchestrator-core';
import { SttConfigMissingError } from '../stt/engine-router';
import type { StartInput } from '../stt/orchestrator-types';

/** Loudest |sample| in a PCM16-LE buffer (0..32767). The one number that tells
 *  "the microphone is recording but the room is quiet" apart from "it was never recording at all". */
function peakSample16(buf: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const v = Math.abs(buf.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak;
}
import { polishFinalText, polishWireSignal, type PolishSkipReason, type PolishWireSignal } from '../stt/stt-polish';
import { resolveByokLlm, type SelectedLlmConfig } from '../compose/llm-config';
import { log } from '../log';
import { trace, traceEnabled, tracedText } from '../trace/pipeline-trace';
// 🔴 W8-4 — the origin → reason table lives beside this file, not in it; the
// 800-line cap forced the split and the module header says so. `onAutoStopped`
// is its one caller.
import { autoStopReasonFor, NAMEABLE_AUTO_STOP_ORIGINS } from './stt-session-autostop';
// Split out for the same reason (file-size cap), and re-exported UNCHANGED so
// every existing importer of these two names — `engine/stt-factory.ts` takes
// `SttEmitter` from here — keeps working without being touched.
import type { SttSessionDeps } from './stt-session-deps';
export type { SttEmitter, SttSessionDeps } from './stt-session-deps';
import { kickDetachedPolish } from './stt-session-detached-polish';
import { kickRefine } from './stt-session-refine';
import { FrameTally } from './stt-session-intake';
import { CoverageReceiptTally } from './stt-session-receipt';

interface OInterim { text: string; confidence: number; language: string; segment_idx: number }
// `empty_reason` (card EMPTY-1): present ONLY on a terminal final that carries no
// text and whose emptiness nothing else explained. Produced by
// `stt/empty-final-cause.ts`; forwarded verbatim, never re-derived here.
interface OFinal extends OInterim { is_segment: boolean; duration_ms: number; empty_reason?: string }
interface OError { code: string; message: string; retryable: boolean }
interface OStatus { provider: string; status: 'ready' | 'reconnecting' | 'failed'; retry_count?: number }

const BYTES_PER_MS = 32; // 16 kHz mono s16le

function clamp01(n: unknown): number { const x = Number(n); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0; }
function nonNegInt(n: unknown): number { const x = Number(n); return Number.isFinite(x) ? Math.max(0, Math.round(x)) : 0; }
function nonEmpty(s: unknown, fallback: string): string { return typeof s === 'string' && s.length > 0 ? s : fallback; }
function round2(n: number): number { return Math.round(n * 100) / 100; }

/** 2026-09-03 (owner Q2 b, design D7 ①) — the id ONE recording is known by on
 *  the wire: minted once per session, stamped on the terminal `stt:final` and
 *  on the `stt:refined` that follows it, so the phone can put the second
 *  draft on the row the first draft made. Same construction as the trace id
 *  (trace/pipeline-trace.ts newTraceId) with a longer tail: a trace id only
 *  has to be unique within one log, this one has to be unique within a
 *  phone's whole timeline. NOT `request_id`/`entry_id` — those are delivery
 *  ids the phone mints; this one names a recording. */
export function newUtteranceId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

export class SttSessionBridge implements SttOrchestrator {
  private readonly session: AudioSession;
  private readonly vad: VadGate;
  private readonly orchestrator: SttEngineOrchestrator;
  private readonly isByok: boolean;
  private readonly gated: boolean;
  private readonly startPromise: Promise<void>;
  private readonly now: () => number;
  private totalAudioMs = 0;
  private lastLevelMs = Number.NEGATIVE_INFINITY;
  private billed = false;
  private readonly intake = new FrameTally(); // audit F3 — fed vs dropped frames; the counting rule is argued in stt-session-intake.ts
  private readonly receipt = new CoverageReceiptTally(); // card CV-1 — the terminal final's coverage receipt; every rule is in stt-session-receipt.ts

  private totalBytes = 0;
  private peakSample = 0;
  private disposed = false;
  /** D7 ① — see [[newUtteranceId]]. Fixed for the session's lifetime. */
  private readonly utteranceId = newUtteranceId();
  /**
   * 🔴 D7 ② — "the emitter is closed": the latch the refine emit is gated on,
   * REPLACING the old `this.disposed` check there (the account of why that
   * check ate every normal-path refine is on [[kickRefine]]).
   *
   * It is set by [[dispose]] ONLY when [[finish]] has NOT taken ownership of
   * the teardown — i.e. on the six non-finish dispose paths [[dispose]]'s own
   * header enumerates (grace expiry, a deliberate leave, a same-key
   * supersede, `stopAll`, and the two unpaired-local branches). Every one of
   * those is either "the phone's socket is gone" or "a new utterance began
   * before this one ever produced a terminal final" — and a refine only
   * exists after a terminal final. The normal `finish().finally(dispose)`
   * chain leaves it OPEN: the socket is alive, the phone is waiting, and the
   * frame goes out through the emitter's per-frame `resolveSocket`.
   */
  private emitterClosed = false;
  /** True from the moment [[finish]] is entered. The one bit that tells a
   *  finish-chain `dispose()` apart from a socket-gone `dispose()`. */
  private finishing = false;
  /** D7 ② — the in-flight second pass, held as a field so it is a THING (a
   *  test can await it, a reader can find it) rather than a dangling `void`.
   *  🔴 Deliberately NOT awaited by [[finish]]: audio.handler races finish()
   *  against AUDIO_STOP_FINISH_WATCHDOG_MS (20 s) and a batch re-transcription
   *  of a long utterance can take longer than that, so awaiting it here would
   *  turn every refined utterance into a watchdog-forced dispose. */
  private pendingRefine: Promise<void> | null = null;
  // A2-5 — the two character counts the metering seam now carries
  // ([[SttCharCounts]]). Two counters and not one: they are incremented at two
  // different MOMENTS on purpose — `transcriptChars` when the text is computed,
  // `deliveredChars` inside the emit — so "transcribed but not yet delivered" is a state the pair
  // can express instead of one they average away.
  private transcriptChars = 0;
  private deliveredChars = 0;
  // WP-R4-6: the in-flight polished TERMINAL-final emit (null when polish is off,
  // delivery is detached, or no terminal final has arrived). The terminal final is
  // the LAST event of the run, so awaiting it before settle()/teardown reorders
  // nothing — every interim and soft-segment final was already emitted ahead of it.
  private pendingFinal: Promise<void> | null = null;

  constructor(private readonly deps: SttSessionDeps) {
    this.now = deps.now ?? Date.now;
    this.vad = new VadGate();
    // 🔴 fix-025 retired the per-account ceiling mechanism and fix-027 removed
    // its dep (`SttSessionDeps.hardLimitMs`) — there is no per-account
    // engine-session ceiling any more, so `AudioSession` is always built with
    // its own default (AUDIO_DEFAULTS.hard_limit_ms). The remaining-budget
    // ceiling arrives through `setQuotaBudgetMs`, called from
    // `stt-factory.ts`'s `withQuotaBudget` wrapper around `deps.build`.
    this.session = new AudioSession({ now: this.now });

    // May throw SttConfigMissingError synchronously → propagates out of the sync
    // sttFactory call so the audio handler emits stt:error + fails the ack (#16).
    const built = deps.build(this.session, deps.sourceLang, deps.userId, this.vad);
    this.orchestrator = built.orchestrator;
    this.isByok = built.isByok;
    this.gated = built.gated;

    this.wireEvents();
    this.session.start();
    // card P2-5/WP-1: `target_lang` used to be spread in here conditionally.
    // Deleted along with the `StartInput.target_lang` field it fed — nothing
    // in orchestrator-core.ts ever read it back (see that type's own header).
    const input: StartInput = { language: deps.sourceLang, mode: deps.mode };
    // Engine connect is async; spawn failures already surface via the 'error'
    // handler (→ stt:error). Catch the rejection so a connect failure is never
    // an unhandled promise rejection (fail-loud already happened via emit).
    //
    // 🔴 card K-7 — "already surface via the 'error' handler" is true of EVERY
    // cold-open failure EXCEPT ONE, and the exception used to land here as a
    // bare `.catch(() => undefined)`. See [[onColdOpenRejection]].
    this.startPromise = this.orchestrator.start(input).catch((err: unknown) => this.onColdOpenRejection(err));
  }

  /**
   * 🔴 card K-7 — THE ONE COLD-OPEN FAILURE NOBODY WAS TOLD ABOUT.
   *
   * `SttEngineOrchestrator.start()` narrates every spawn failure on its own
   * 'error' event (→ `stt:error` through [[wireEvents]]) and then rethrows —
   * every failure but one. The ROUTER's `SttConfigMissingError` is rethrown
   * BEFORE those two emits (orchestrator-core.ts, `if (err instanceof
   * SttConfigMissingError) throw err`), on the documented premise that it
   * "propagates raw (audio.handler maps it)".
   *
   * That premise has been false since this constructor started firing `start()`
   * and forgetting it. Nothing above this line awaits `startPromise`, so the
   * rejection reaches no handler; `audio.handler` has already called
   * `safeAck(ack, {ok:true})` by the time it arrives. So the honest description
   * of the old `.catch(() => undefined)` is: a silent swallow AND a false
   * success — the two halves of the red line, at once, on the failure whose
   * whole job is to say "this account has no engine for this language".
   *
   * ⚠️ NOT a second copy of the other arms' reporting: this branch is the exact
   * complement of the `throw err` above (`instanceof` on one side, everything
   * else on the other), so a code that already spoke never speaks twice. A
   * non-config rejection returns silently here for that reason and no other.
   *
   * ⚠️ There is a SYNCHRONOUS `SttConfigMissingError` path too — `deps.build`
   * throwing out of this constructor, which reaches `audio.handler`'s engine
   * catch and is answered there. This is the ASYNC one, at spawn time, and it
   * had no answer at all.
   */
  private onColdOpenRejection(err: unknown): void {
    if (!(err instanceof SttConfigMissingError)) return;
    log.error('stt cold open: no engine configured for this session — the phone was never told', {
      user_id: this.deps.userId,
      language: this.deps.sourceLang,
      error: err.message,
    });
    // 🔴 card C1 (2026-08-17): the THROWER's code, not a literal. The async arm
    // has to agree with the synchronous one in audio.handler.ts — the same
    // failure reaching the phone by a different route must not get a different
    // sentence, and a pool refusal answered with 「该语言尚未配置识别引擎」 is
    // false on every relay that has a pool.
    this.deps.emitter.emit('stt:error', {
      code: err.code,
      message: err.message,
      retryable: false,
    });
  }

  private wireEvents(): void {
    const o = this.orchestrator;
    o.on('interim', (e: OInterim) => this.deps.emitter.emit('stt:interim', {
      text: String(e.text ?? ''),
      confidence: clamp01(e.confidence),
      language: nonEmpty(e.language, this.deps.sourceLang),
      segment_idx: nonNegInt(e.segment_idx),
    }));
    // FINAL path (06 §5): dictionary replace → normalizer → (opt-in) polish, THEN
    // fan-out. The processed text is what mobile + PC + the mobile-driven
    // history:create all see — one text, no raw-vs-processed split brain.
    // `is_segment` gates the normalizer's terminal punctuation (soft-segment
    // finals stay open) AND whether polish runs (WP-R4-6 ③: polish ONLY the
    // utterance-closing final, is_segment=false).
    o.on('final', (e: OFinal) => {
      const isSegment = Boolean(e.is_segment);
      const raw = String(e.text ?? '');
      const language = nonEmpty(e.language, this.deps.sourceLang);
      const pure = this.deps.finalText
        ? this.deps.finalText(raw, { isSegment, language })
        : raw;
      // Trace the ONE comparison that settles "did my dictionary do anything":
      // raw is what the engine said, pure is what the two pure stages made of
      // it. Equal digests ⇒ neither the replacer nor the normalizer touched this
      // sentence, and that is a fact about this utterance rather than an
      // inference from the rule count.
      if (traceEnabled()) {
        const id = this.deps.traceId ?? 'no-session';
        trace('stt.final.raw', id, { is_segment: isSegment, language, ...tracedText(raw) });
        trace('stt.final.pure', id, { is_segment: isSegment, changed: pure !== raw, ...tracedText(pure) });
      }
      // Card EMPTY-1 — the ONE line that answers 「the row vanished, why」 after the
      // fact. It is traced whether or not a reason exists: a terminal final with no
      // text and NO reason is itself the finding (an `stt:error` spoke instead, or a
      // relay stripped the field), and a stage that only prints on the happy path
      // cannot tell those apart from 「the classifier never ran」.
      if (traceEnabled() && !isSegment && pure === '') {
        trace('stt.empty.cause', this.deps.traceId ?? 'no-session',
          { empty_reason: e.empty_reason ?? null, language });
      }
      // A2-5 — counted HERE, at the moment the text exists, and counted for EVERY
      // final including soft-segment ones: "how many characters did this utterance transcribe to in total" is a property of
      // the utterance, not of the last frame of it. Interims are deliberately NOT
      // counted — they are drafts of the same words and adding them would report a
      // number several times larger than anything the user said.
      this.transcriptChars += pure.length;
      const emptyReason = !isSegment && pure === '' && typeof e.empty_reason === 'string' && e.empty_reason !== ''
        ? e.empty_reason
        : undefined;
      const base = {
        confidence: clamp01(e.confidence),
        language,
        segment_idx: nonNegInt(e.segment_idx),
        is_segment: isSegment,
        duration_ms: nonNegInt(e.duration_ms),
        // D7 ① — the TERMINAL final names the recording; soft-segment finals
        // (one row each, book 15 §2.0-c) deliberately do not, so a phone that
        // keys rows on this id cannot attach the second draft to a segment.
        // card CV-1 — the coverage receipt rides the TERMINAL final only, for the same reason `utterance_id` does (stt-session-receipt.ts).
        ...(isSegment ? {} : { utterance_id: this.utteranceId, ...this.receipt.fields({ session: this.session, acceptedFrames: this.intake.fed, droppedFrames: this.intake.dropped, finishing: this.finishing, disposed: this.disposed, echo: this.deps.recovery }) }),
        // Card EMPTY-1 — carried through, not judged here. The orchestrator is the
        // only layer holding the two facts the verdict needs (bytes the feed gate
        // accepted, and whether an `stt:error` already went out on this recording);
        // re-deriving either one from `pure.length` at this seam would be a second
        // opinion about the same question, which is how the two come to disagree.
        ...(emptyReason ? { empty_reason: emptyReason } : {}),
      };
      // 🔴 RT-1, as ruled by the primary owner 2026-08-07 (option (c)). owner's async
      // ruling "show it immediately after transcribing … directly replace the
      // already-displayed text" needs BOTH halves to be a
      // product: show early AND replace late. The replacing half has no safe
      // carrier yet ([[runDetachedPolish]]), and shipping the showing half alone
      // would bill a user for a correction they never receive — a NEW state,
      // worse than today, not a degrade to the status quo.
      //
      // So production stays SYNCHRONOUS and the detached mechanism sits beside
      // it, complete and test-driven, until its activation triple is met. The
      // choice is a dep, not a comment, so a census can enforce it — see
      // [[SttSessionDeps.polishDelivery]] and the tripwire in
      // test/polish-delivery-census.test.ts.
      if (this.deps.polish && !isSegment && this.polishDelivery() === 'sync') {
        // Terminal final + polish ON: run the bounded LLM polish on the PURE
        // two-stage text, THEN emit — so every consumer reads the SAME post-polish
        // text. Tracked so finish()/onAutoStopped await it before settle()/
        // teardown. The .catch is the last-resort guard so an in-flight polish
        // teardown can NEVER surface an uncaught rejection (seam ③).
        this.pendingFinal = this.runPolishedFinal(pure, base).catch((err) => {
          log.error('stt.polish terminal-final emit failed unexpectedly', { error: err instanceof Error ? err.message : String(err) });
        });
      } else {
        // Interim, soft-segment, polish-OFF, and the detached mode: emit now.
        this.emitFinal(pure, { ...base, ...this.polishWireForFinal(isSegment) });
        // The utterance has SETTLED. Fire-and-forget the second pass — it must
        // never delay, gate or alter the final above (06 §5), which is already
        // delivered and already on the user's screen.
        //
        // 🔴 IT IS KICKED FROM THE TWO PLACES A FINAL IS DELIVERED, not from one
        // place after the branch, and that is the 2026-09-04 change: the pass
        // smooths THE TEXT THE USER HAS. On the sync-polish path that text does
        // not exist yet here — it is the polished string, minted inside
        // [[runPolishedFinal]], which kicks the pass itself once it has emitted.
        // Kicking from a single site above the branch would smooth the PURE text
        // instead, i.e. hand the phone a second draft that silently undoes the
        // correction pass and that no stage of the pipeline ever produced.
        if (!isSegment) this.kickRefine(pure);
      }
      if (!isSegment && this.polishDelivery() === 'detached') this.kickPolish(pure);
    });
    o.on('error', (e: OError) => this.deps.emitter.emit('stt:error', {
      code: nonEmpty(e.code, 'STT_NETWORK_DROP'),
      message: nonEmpty(e.message, nonEmpty(e.code, 'STT engine error')),
      retryable: Boolean(e.retryable),
    }));
    // Card ENG-4 (2026-08-15) — a refusal we deliberately do NOT put on the wire
    // (the vendor said "no audio received" about a recording our own gate found
    // no speech in; the honest sentence is the one the empty final already
    // triggers). It is logged rather than dropped: 「不说给用户听」 and
    // 「当作没发生过」 are different things, and only the first one is the fix.
    // ⚠️ This is what a grep for the vendor's own words will hit now, so the
    // ops trail keeps working — the same reason `stt.error emitted` exists.
    o.on('error-suppressed', (e: OError) => log.info('stt.no-voice: vendor refused an empty session', {
      code: e.code,
      message: e.message,
      note: 'our feed gate accepted 0 bytes — the phone says 「没有听到语音」 off the empty final instead',
    }));
    o.on('engine-status', (e: OStatus) => this.deps.emitter.emit('stt:engine-status', {
      provider: nonEmpty(e.provider, 'unknown'),
      status: e.status,
      ...(e.retry_count !== undefined ? { retry_count: e.retry_count } : {}),
    }));
    // 🔴 W8-4: `limit_origin` is READ, and `reason` on this same payload is
    // deliberately NOT. The driver's `reason` is `AudioSession.autoStop`'s own
    // internal literal — hard-coded `'hard_limit'` at `stt/audio/session.ts`
    // `onHardLimit` — so consuming it would move the exact constant this card
    // deletes one layer down and call it 「carrying the value through」.
    // `orchestrator-core.ts` `handleAutoStop` is the ONE producer of this event
    // and stamps `limit_origin` from `session.limitOrigin` on every emit.
    o.on('auto-stopped', (e: { limit_origin?: unknown }) => { void this.onAutoStopped(e?.limit_origin); });
  }

  /** Default `'sync'` — see [[SttSessionDeps.polishDelivery]]. Read through one
   *  accessor so the census has a single literal to police. */
  private polishDelivery(): 'sync' | 'detached' {
    return this.deps.polishDelivery ?? 'sync';
  }

  /**
   * The polish LLM's metering seam — ONE copy, shared by both delivery modes.
   *
   * owner's plan: "meter it exactly as billed when polish completes". Metered on EVERY path the model answered
   * on, including a guard reject: the tokens were spent before we judged the
   * output, so billing records cost, not verdicts. `usage` absent = the provider
   * did not say, and an absent number must not be recorded as a zero (that would
   * read as "ran free").
   *
   * Deliberately not duplicated per mode. Two copies of a billing call is how the
   * numbers drift, and the census in billing-call-sites.test.ts counts FILES —
   * it would not have caught a second copy in here.
   *
   * 🔴 The try/catch is required in `'detached'` (the meter reaches a synchronous
   * node:sqlite write behind a FK with foreign_keys=ON and runs after settle(),
   * inside no caller's frame — an escaped throw reaches installProcessGuards →
   * onFatal → exit). In `'sync'` it is ALSO load-bearing, for a different reason,
   * and this is a defect it FIXES rather than preserves: the pre-RT-1 code set
   * `signal = polishWireSignal(result)` BEFORE calling the meter, so a throwing
   * meter fell into the outer catch, reverted `text` to the pure two-stage
   * string — and emitted it still carrying `polish:'applied'`. A frame that says
   * the polish applied while carrying un-polished text is exactly R11
   * ("every status word must be able to answer 'on what grounds do you say
   * that'"). Now the meter cannot corrupt the
   * signal, and the money loss is named, greppable and carries the user id.
   */
  private meterPolish(polish: { llm: SelectedLlmConfig }, result: { usage?: { tokensIn: number; tokensOut: number } }): void {
    if (!result.usage) return;
    try {
      // 🔴 T7-b: this used to pass `this.isByok` — the STT routing's flag — into
      // the LLM meter. Two different keys were answering one question: a user
      // with a BYOK **STT** key got their platform **LLM** polish tokens waived,
      // because their microphone key excused their token spend. This repo's #1 bug shape
      // (one value answering two questions) — both LLM meter sites derive the flag from the config
      // the call actually spent tokens on (compose: compose/index.ts byok →
      // compose.handler.ts commitLlmUsage; polish: here).
      // 🔴 M4 on top: the judgement is by PROVENANCE (resolveByokLlm over the
      // SelectedLlmConfig snapshotted at audio:start), never by key shape — a
      // platform managed key is metered however many characters it has.
      this.deps.onPolishUsage?.(result.usage.tokensIn, result.usage.tokensOut, resolveByokLlm(polish.llm));
    } catch (err) {
      // Same treatment, and the same reason, as dispose()'s settle() guard:
      // money lost must be greppable, never a thrown stack.
      log.error('llm usage NOT recorded — the polish meter threw', {
        user_id: this.deps.userId,
        delivery: this.polishDelivery(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * The SHIPPED path: run the bounded polish on the pure two-stage text, then
   * emit `stt:final` with the honest wire signal. `polishFinalText` never throws
   * and never blocks delivery — on any skip it returns the pure text + a reason;
   * the try/catch is defense-in-depth (seam ③). On a session torn down
   * mid-polish the emit is dropped (the session is gone; nothing consumes it).
   */
  private async runPolishedFinal(
    pureText: string,
    base: { confidence: number; language: string; segment_idx: number; is_segment: boolean; duration_ms: number; utterance_id?: string },
  ): Promise<void> {
    const polish = this.deps.polish!;
    let text = pureText;
    // Default to an honest skipped('llm_error') so an unexpected throw below still
    // surfaces as a real failure signal, never a silent 'applied' (red line).
    let signal: PolishWireSignal = { polish: 'skipped', polish_reason: 'llm_error' };
    try {
      const result = await polishFinalText(pureText, polish.llm.cfg, polish.deps ?? {});
      text = result.text;
      signal = polishWireSignal(result);
      this.meterPolish(polish, result);
      if (signal.polish === 'skipped') {
        // Forensic (WP-R4-6 ④): the internal fine-grained reason stays here; only
        // the normalized 4-value reason reaches the wire.
        log.warn('stt.polish skipped — delivering pure two-stage text', { reason: result.reason, wire: signal.polish_reason });
      }
    } catch (err) {
      text = pureText;
      log.error('stt.polish threw — delivering pure two-stage text', { error: err instanceof Error ? err.message : String(err) });
    }
    if (this.disposed) return;
    this.emitFinal(text, { ...base, ...signal });
    // Delivered — so this is the string the second pass smooths. Kicked AFTER
    // the emit, never before: the pass is an improvement to text the user
    // already has, and nothing about it may reorder itself in front of the
    // frame that gives them that text.
    this.kickRefine(text);
  }

  /**
   * A2-5 — the ONE place a `stt:final` leaves this bridge, and the ONE place
   * `deliveredChars` moves.
   *
   * 🔴 THE COUNTER IS INSIDE THE EMIT, not beside its two call sites, and that
   * placement is the whole assertion. Beside them, "how many characters did we send out" would be a
   * number maintained by remembering — and the `disposed` early-return one line
   * up in [[runPolishedFinal]] is exactly the branch a person maintaining it by
   * hand forgets, so a torn-down session would report characters it never sent.
   * Counted here, 「delivered」 cannot be true of anything that did not go out.
   *
   * ⚠️ It counts `text`, i.e. what is ON THE FRAME — post-polish, post-pipeline.
   * That is deliberately NOT the same string `transcriptChars` summed, and the
   * gap between them is a measurement rather than a discrepancy.
   */
  private emitFinal(text: string, rest: Record<string, unknown>): void {
    this.deliveredChars += text.length;
    // The last record of the chain, and deliberately here rather than at the two
    // call sites — for the same reason `deliveredChars` is: a `delivered` line
    // emitted beside a call site would be a claim maintained by remembering, and
    // the `disposed` early-return above is precisely the branch that gets
    // forgotten. Inside the emit, "delivered" cannot be traced for anything that
    // did not go out.
    if (traceEnabled()) {
      trace('delivered', this.deps.traceId ?? 'no-session', {
        polish: rest.polish ?? 'applied-or-off',
        polish_reason: rest.polish_reason,
        ...tracedText(text),
      });
    }
    // Card EMPTY-1 invariant, enforced at the ONE exit rather than trusted at the
    // two call sites: `empty_reason` explains an ABSENT transcript, so a frame that
    // carries text may not carry one. A GUARD, not a prediction — the only way here
    // is the polish layer turning an empty string into words, which we do not
    // believe happens; if it ever does, the honest outcome is a final with text and
    // no explanation, never one that says both.
    const wire = { ...rest };
    if (text !== '') delete wire.empty_reason;
    this.deps.emitter.emit('stt:final', { text, ...wire });
  }

  /**
   * The `polish` field for a final emitted WITHOUT waiting for a polish result —
   * i.e. every final except the `'sync'` armed terminal one, which
   * [[runPolishedFinal]] stamps with the full `applied|skipped` signal.
   *
   * There is exactly one thing this can honestly say. "Polish was ON and could
   * not run AT ALL" is known before the final leaves, is permanent for the
   * session (usually until the user fixes their config), and is the one skip the
   * user can act on. Everything else is either pending or unknowable here.
   *
   * D-5: the field is left working on purpose. `polish:'skipped'` is what paints
   * PolishSkippedMark; removing it would make that widget permanently invisible
   * with nothing going red.
   *
   * ⚠️ Under `'detached'` an armed session returns `{}` here and the LATE skips
   * (timeout / llm_error / empty_output / guard_reject) reach nobody: they are
   * decided after the final has shipped and `SttRefinedSchema` has no polish
   * field to carry them. That honesty gap is one more thing the activation
   * triple has to answer for, and it is why `'sync'` is not merely the
   * conservative default — it is the only mode that keeps WP-R4-6 ⑦'s promise.
   */
  private polishWireForFinal(isSegment: boolean): { polish?: 'skipped'; polish_reason?: PolishSkipReason } {
    // Soft-segment finals never carried a polish field and still do not — polish
    // is an utterance-closing concern (WP-R4-6 ③).
    if (isSegment) return {};
    // Armed ⇒ the answer is pending, and a pending answer is not a signal.
    if (this.deps.polish !== undefined) return {};
    const unavailable = this.deps.polishUnavailable;
    if (unavailable === undefined) return {};
    return { polish: 'skipped', polish_reason: unavailable };
  }

  /** Wiring only. The pass itself — and the whole account of why it computes a
   *  correction and delivers nothing — moved to `stt-session-detached-polish.ts`
   *  under the 800-line cap; that file's header enumerates every mechanical edit
   *  the move made. `this.now` and `this.meterPolish` are handed over so the pass
   *  keeps using THIS session's clock and the SINGLE metering seam. */
  private kickPolish(pureText: string): void {
    kickDetachedPolish(this.deps.polish, pureText, this.now, (p, r) => this.meterPolish(p, r));
  }

  /**
   * 🔴 W8-4 — the recording ended without the user releasing the button, and the
   * frame that says so now carries WHY (see [[AUTO_STOP_REASON_BY_ORIGIN]]).
   *
   * THE EMIT STAYS FIRST, ahead of `waitForTerminal()`. `handleAutoStop` flushes
   * a TERMINAL `stt:final` right behind this frame, and the phone's FSM only
   * accepts a terminal final from PROCESSING — `audio:auto-stopped` is what moves
   * it there (`apps/mobile/lib/src/ptt/ptt_inbound.dart`, the `fsm.onPttUp()`
   * beside the `_autoStoppedCtl.add`). Ordering these the other way round would
   * get the final refused and strand the session in RECORDING, which is the exact
   * bug that comment records having already been fixed once.
   *
   * ⚠️ AN UNNAMEABLE ORIGIN EMITS NOTHING, and the cost of that is written down
   * rather than hidden: the phone releases RECORDING off THIS frame, so a
   * withheld frame leaves the FSM stuck and PTT dead until the app restarts.
   * That is a bad outcome and it is still the better one — the alternative is
   * telling the user a specific thing that is not true, which is the defect this
   * method exists to remove, and the closed `z.enum` has no value meaning 「stopped,
   * cause unknown」 to fall back to (`stt:error` cannot stand in either: the phone
   * acts on it only from PROCESSING). The branch is unreachable by construction —
   * `limitOrigin` is typed, total, and stamped by the single producer — so it is a
   * tripwire for OUR wiring breaking, not a product state. It is loud where an
   * operator looks, and it never lies to the user. Registered as a fork for the
   * supervisor rather than decided quietly here.
   */
  private async onAutoStopped(limitOrigin: unknown): Promise<void> {
    this.receipt.noteAutoStop(); // card CV-1 — BEFORE the terminal flush below, or the flag would describe the next recording
    const reason = autoStopReasonFor(limitOrigin);
    if (reason === null) {
      log.error('audio:auto-stopped WITHHELD — the auto-stop carried no nameable limit_origin', {
        user_id: this.deps.userId,
        limit_origin: typeof limitOrigin === 'string' ? limitOrigin : typeof limitOrigin,
        known_origins: NAMEABLE_AUTO_STOP_ORIGINS,
        consequence: 'the phone was told nothing and its FSM stays in RECORDING',
      });
    } else {
      this.deps.emitter.emit('audio:auto-stopped', { reason });
    }
    await this.orchestrator.waitForTerminal();
    // WP-R4-6: let an in-flight polished terminal-final finish emitting before we
    // bill + settle (billing is idempotent via `billed`; awaiting cannot double
    // it). null under `'detached'` / polish-off — nothing to wait for there.
    await this.pendingFinal;
    this.vad.finish();
    this.settle();
  }

  /** Wiring only — the pass itself, and the account of why it now delivers on
   *  the normal stop path, moved to `stt-session-refine.ts` under the 800-line
   *  cap; that file's header enumerates every mechanical edit. The latch is
   *  handed over as a THUNK so the emit reads it when the batch engine answers,
   *  not when the pass was kicked. */
  private kickRefine(deliveredText: string): void {
    this.pendingRefine = kickRefine(
      {
        refine: this.deps.refine,
        emitter: this.deps.emitter,
        utteranceId: this.utteranceId,
        emitterClosed: (): boolean => this.emitterClosed,
        meter: (llm, result): void => this.meterPolish(llm, result),
        ...(this.deps.traceId !== undefined ? { traceId: this.deps.traceId } : {}),
      },
      deliveredText,
      // 🔴 THE WHOLE UTTERANCE'S AUDIO, not the closing final's `duration_ms`.
      // Card N1-B1b in one line: the floor decides whether THIS RECORDING is
      // long enough to be worth smoothing, and a user who releases two seconds
      // past a soft-segment rollover produced a terminal final of ~2 s while the
      // recording ran for ten minutes. `shouldRefine`'s own doc carries the full
      // account.
      this.totalAudioMs,
    );
  }

  /** SEG-1 (R5) — the live session's contiguous-seq watermark, for the
   *  mobile:reconnect ack (`audio_last_contiguous_seq`). A plain read of
   *  {@link AudioSession}'s own SeqTracker — the SAME tracker hasObserved()
   *  dedupes the ring replay with (orchestrator-core.ts), so the number the
   *  phone trims against and the number the server dedupes against cannot
   *  drift apart. One production reader:
   *  AudioSessionRegistry.peekLastContiguousSeq. */
  get lastContiguousSeq(): number {
    return this.session.seq.lastContiguousSeq;
  }

  pushChunk(seq: number, dataB64: string, tsMs: number): void {
    if (this.disposed) { this.intake.noteBridgeDrop(); return; } // card CV-1: taken off the wire, went nowhere
    let payload: Buffer;
    try { payload = Buffer.from(dataB64, 'base64'); } catch { this.intake.noteBridgeDrop(); return; }
    if (payload.length === 0) { this.intake.noteBridgeDrop(); return; }
    this.totalBytes += payload.length;
    const peak = peakSample16(payload);
    if (peak > this.peakSample) this.peakSample = peak;
    this.totalAudioMs += payload.length / BYTES_PER_MS;
    // VAD gate (real caller): update gate state + amplitude + billing meter
    // BEFORE the orchestrator's engine feed reads vad.open (single-threaded).
    this.vad.process(payload);
    this.maybeEmitLevel(tsMs);
    // 🔴 Audit F3 — COUNTED ON THE PIPELINE'S ANSWER, not before asking it. The
    // count used to happen above this line, so a frame that arrived past the
    // terminal fence (or past AudioSession's state guard) was reported to the
    // phone as fed while it went nowhere — and `fed_frames` is what the phone
    // checks before deleting its only copy of the audio.
    this.intake.note(this.orchestrator.pushChunk({ seq, ts_ms: tsMs, payload }));
  }

  private maybeEmitLevel(tsMs: number): void {
    const interval = this.deps.levelIntervalMs ?? 200;
    if (tsMs - this.lastLevelMs < interval) return;
    this.lastLevelMs = tsMs;
    this.deps.emitter.emit('stt:level', { amplitude_db: round2(this.vad.lastAmplitudeDb) });
  }

  async finish(): Promise<void> {
    if (this.disposed) return;
    // D7 ② — from here on a dispose() is the finish chain's own teardown, not
    // a socket-gone teardown; see [[emitterClosed]]. Set BEFORE any await so
    // the watchdog-forced dispose (audio.handler) is classified the same way.
    this.finishing = true;
    // The intake tally (owner 2026-07-27: "is this a mobile-side issue"). `peak` is the
    // loudest PCM16 sample of the whole utterance on a 0..32767 scale: a few
    // hundred is a quiet room's noise floor, an exact 0 across thousands of
    // bytes is a muted/dead capture, and chunks:0 means the phone never sent
    // audio at all. Emitted BEFORE the awaits so it lands even if the flush
    // throws — a diagnostic that only prints on the happy path is no diagnostic.
    // 🔴 2026-09-03 — `gatedMs` is what this line used to print AS `voicedMs`
    // (`vad.sessionMs`: wall time the gate held open, hangover included — the
    // BILLED figure). The real voiced counter was never on the line at all, so a
    // reader comparing 「voicedMs」 to the vendor's 「no audio」 was comparing the
    // wrong pair (trace report 2026-09-03 §4-1). Both are printed now, each under
    // its own name; logs older than this date carry gatedMs under the old key.
    log.info('audio intake', {
      chunks: this.intake.fed,
      bytes: this.totalBytes,
      peak: this.peakSample,
      audioMs: Math.round(this.totalAudioMs),
      gatedMs: Math.round(this.vad.sessionMs),
      voicedMs: Math.round(this.vad.voicedMs),
    });
    await this.startPromise;
    await this.orchestrator.stop();
    // WP-R4-6: orchestrator.stop() flushed the terminal final, which (polish ON,
    // delivery 'sync') set pendingFinal synchronously inside its 'final' handler.
    // Await it so the polished stt:final is emitted BEFORE billing/settle and
    // BEFORE the audio handler's .finally(dispose) tears the session down.
    // 🔴 Under `'detached'` this is null and the wait is gone — that IS the async
    // shape, and it is exactly why activating it needs the triple on
    // [[SttSessionDeps.polishDelivery]] rather than a flag flip.
    await this.pendingFinal;
    this.vad.finish();
    this.settle();
  }

  /** Call the single recordSttUsage seam exactly once. Managed-streaming
   *  sessions bill the GATED session ms (silence excluded); others bill the raw
   *  audio ms. Standalone / BYOK make onComplete a NOOP downstream.
   *
   *  🔴 A2-5 — it now also hands over the two character counts. They are read at
   *  SETTLE and not accumulated by the meter, because settle is the one moment
   *  "this utterance" is over on BOTH endings (`finish()` and `dispose()`), and the
   *  counters are plain fields of this object rather than something a caller has
   *  to remember to pass. A dispose-path settle therefore reports whatever was
   *  transcribed before the teardown — which is the honest number, and the one
   *  that explains a bill for audio the user never saw text for. */
  private settle(): void {
    if (this.billed) return;
    this.billed = true;
    const durationMs = this.gated ? this.vad.sessionMs : this.totalAudioMs;
    this.deps.onComplete(Math.max(0, Math.round(durationMs)), this.isByok, {
      transcript: this.transcriptChars,
      delivered: this.deliveredChars,
    });
  }

  /**
   * Tear down without emitting further events — and SETTLE.
   *
   * W1.5-P1a. `settle()` used to hang off `finish()` and `onAutoStopped()` only,
   * i.e. off the two CLEAN endings. Every unclean ending tore the engine down
   * having billed nothing, although the audio had already been streamed to the
   * vendor and the vendor had already been paid for it. SIX production paths
   * reach here without a `finish()` — enumerated from the callers, not recalled:
   *   · audio-registry.ts `beginGrace` expiry timer → `dispose(key)`
   *     — the phone dropped and never came back inside the grace window;
   *   · audio-registry.ts `expireGraceNow()` → `dispose(key)`
   *     — the user backed out of the instance list (bootstrap.ts, on a
   *       deliberate leave). The MOST FREQUENT non-stop ending, not an edge;
   *   · audio-registry.ts `put()` → `dispose(key)`
   *     — a new audio:start supersedes the previous utterance on the same key;
   *   · audio-registry.ts `stopAll()` → `dispose(key)`
   *     — SIGTERM / fatal shutdown, so every deploy flushes in-flight sessions;
   *   · audio.handler.ts `audio:start` local branch — supersede, unpaired;
   *   · audio.handler.ts `disconnect` local branch.
   * 🔴 An earlier version of this comment listed FOUR and called them verified.
   * Two were missing, and both are ones the seam catches anyway — which is the
   * argument for the seam, stated by its own counterexample: patching call
   * sites is how the fifth and sixth get missed. What is billable is the
   * consumption, not the tidiness of the goodbye.
   *
   * ORDER IS LOAD-BEARING, and it is the reverse of the obvious one. Teardown
   * runs FIRST and `settle()` LAST, inside a try/catch:
   * `deps.onComplete` reaches a SYNCHRONOUS node:sqlite write
   * (usage.repo increment; usage_records.user_id is a FK and foreign_keys=ON),
   * so it can throw on a deleted account, SQLITE_BUSY or disk I/O. Every
   * pre-existing `settle()` call sat inside a caught async chain
   * (audio.handler `finish().catch(...)`). This one does not: three of the six
   * paths above come from a bare `setTimeout` or a shutdown loop, where an
   * uncaught throw is FATAL — error-handling.ts `onFatal` closes the process
   * and exits non-zero. Unbillable audio must never be able to take the relay
   * down, strand a vendor websocket, or eat the owed `pc:mobile-left`.
   *
   * It cannot double-CALL the meter: `settle()` latches on `billed`, so the
   * ordinary `finish()` → `.finally(dispose)` chain settles once.
   * ⚠️ That latch guards CALLS, not MILLISECONDS — see the two accounts in
   * docs/strategy/2026-08-06-w15-copy-and-artifacts-ledger.md §6: a reconnect
   * replays the phone's ring buffer and those ms are counted again, and
   * `totalAudioMs`/`vad.sessionMs` measure what the phone OFFERED us, not what
   * the vendor received. Both predate this change and both are worse on this
   * path than on `finish()`, because this is the drop path. Do not read the
   * sentence above as 「the number is right」 — it only says the seam fires once.
   *
   * It does not invent a bill: `recordSttUsage` already drops standalone, BYOK
   * and `duration_ms <= 0` (all three pinned in managed-default-billing.test.ts).
   * That guard lives at the meter and this path deliberately does not grow a
   * second copy of it.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // D7 ② — close the refine emitter ONLY on the non-finish paths above (the
    // socket is gone, or the utterance was superseded before it ever had a
    // terminal final). After finish() the socket is alive and the pending
    // second pass is still owed to the phone — see [[emitterClosed]].
    if (!this.finishing) this.emitterClosed = true;
    // An unclean ending is the ONLY billing path with no `audio intake` line,
    // i.e. the only one that could produce a disputed charge with no evidence
    // of what it charged for. Decided before settle() moves the latch.
    const unclean = !this.billed;
    void this.orchestrator.close();
    if (this.session.state !== 'closed') {
      try { this.session.finalize(); } catch (err) { console.error('[SttSessionBridge] session.finalize error:', err); }
    }
    this.vad.finish();
    if (unclean) {
      log.info('audio intake (torn down without a stop — billed on the dispose path)', {
        chunks: this.intake.fed,
        bytes: this.totalBytes,
        peak: this.peakSample,
        audioMs: Math.round(this.totalAudioMs),
        gatedMs: Math.round(this.vad.sessionMs), // same pair, same names as the `finish()` line above
        voicedMs: Math.round(this.vad.voicedMs),
      });
    }
    try {
      this.settle();
    } catch (err) {
      // Fail loud in the log, never on the stack: see ORDER above. The audio is
      // consumed either way, so a swallowed meter error is money lost — it must
      // be greppable, which is why it is error-level and names the user.
      log.error('stt usage NOT recorded — the meter threw while tearing the session down', {
        user_id: this.deps.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
