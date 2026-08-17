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

import type { SttOrchestrator } from './orchestrator';
import { AudioSession } from '../stt/audio/session';
import { VadGate } from '../stt/vad-gate';
import { RetainedAudio, runRefine, shouldRefine } from '../stt/stt-refine';
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

interface OInterim { text: string; confidence: number; language: string; segment_idx: number }
interface OFinal extends OInterim { is_segment: boolean; duration_ms: number }
interface OError { code: string; message: string; retryable: boolean }
interface OStatus { provider: string; status: 'ready' | 'reconnecting' | 'failed'; retry_count?: number }

const BYTES_PER_MS = 32; // 16 kHz mono s16le

function clamp01(n: unknown): number { const x = Number(n); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0; }
function nonNegInt(n: unknown): number { const x = Number(n); return Number.isFinite(x) ? Math.max(0, Math.round(x)) : 0; }
function nonEmpty(s: unknown, fallback: string): string { return typeof s === 'string' && s.length > 0 ? s : fallback; }
function round2(n: number): number { return Math.round(n * 100) / 100; }

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
  // owner 2026-07-27: "the phone app shows a prompt saying no speech was heard — is this a mobile-side issue" — an
  // empty transcript has two very different causes and the banner cannot tell
  // them apart. The intake tally can: chunks==0 means the phone sent NOTHING
  // (capture/permission/upload), while chunks>0 with peak≈0 means the mic was
  // live and the room was silent. Logged once per utterance, at finish.
  private chunkCount = 0;
  private totalBytes = 0;
  private peakSample = 0;
  private disposed = false;
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

  /** GA-14: this utterance's audio, kept in memory ONLY while refine is armed
   *  for the session — a session with refine off retains nothing at all. */
  private readonly retained: RetainedAudio | null;

  constructor(private readonly deps: SttSessionDeps) {
    this.now = deps.now ?? Date.now;
    this.retained = deps.refine ? new RetainedAudio() : null;
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
    const input: StartInput = {
      language: deps.sourceLang,
      mode: deps.mode,
      ...(deps.targetLang !== undefined ? { target_lang: deps.targetLang } : {}),
    };
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
    this.deps.emitter.emit('stt:error', {
      code: 'STT_CONFIG_MISSING',
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
      // A2-5 — counted HERE, at the moment the text exists, and counted for EVERY
      // final including soft-segment ones: "how many characters did this utterance transcribe to in total" is a property of
      // the utterance, not of the last frame of it. Interims are deliberately NOT
      // counted — they are drafts of the same words and adding them would report a
      // number several times larger than anything the user said.
      this.transcriptChars += pure.length;
      const base = {
        confidence: clamp01(e.confidence),
        language,
        segment_idx: nonNegInt(e.segment_idx),
        is_segment: isSegment,
        duration_ms: nonNegInt(e.duration_ms),
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
      }
      if (!isSegment) {
        // GA-14: the utterance has SETTLED. Fire-and-forget the second pass — it
        // must never delay, gate or alter the final above (06 §5), which is
        // already delivered and already on the user's screen.
        this.kickRefine(pure, base.duration_ms);
        if (this.polishDelivery() === 'detached') this.kickPolish(pure);
      }
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
    base: { confidence: number; language: string; segment_idx: number; is_segment: boolean; duration_ms: number },
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
    this.deps.emitter.emit('stt:final', { text, ...rest });
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

  /**
   * GA-14 — the optional second pass, started AFTER the terminal final is out.
   *
   * Deliberately not awaited anywhere: refine is an improvement to text the user
   * already has, so it may never hold up the utterance, the billing settle, or
   * the teardown. Its own failures are logged and go no further — see
   * stt-refine.runRefine for why an OPTIONAL improvement failing is the one case
   * where the wire should stay quiet.
   */
  private kickRefine(firstPass: string, finalDurationMs: number): void {
    const refine = this.deps.refine;
    const retained = this.retained;
    if (!refine || !retained) return;
    // 🔴 Card N1-B1b — the gate is asked about THE AUDIO IT IS ABOUT.
    //
    // This used to pass the terminal final's `duration_ms`. That was the whole
    // session's length until card N1-B1, which made every final report the
    // segment it closes (book 15 §2.0-c: one segment = one row). After it, a user who releases
    // a few seconds past a soft-segment rollover produced a terminal final of
    // ~2 s — under the 15 s floor — while [[RetainedAudio]] held the entire
    // ten-minute recording. Refine then never ran on exactly the long utterances
    // GA-14 exists to improve, and NOTHING reported it: refine is
    // fire-and-forget, so its non-happening has no observer at all.
    //
    // `shouldRefine`'s question is "is this worth a second engine bill?" and the
    // thing being billed is `retained.take()`. So the deciding layer now reads
    // the fact its own decision is about, and the two can no longer drift apart
    // — that is R11 ("does the layer making this judgment have in hand the facts
    // it needs to make it") applied
    // to a gate rather than to a status word.
    //
    // Read BEFORE take(): take() consumes, and clear() zeroes the length.
    const retainedMs = retained.durationMs;
    if (!shouldRefine(refine.cfg, retainedMs)) {
      // Two ways to land here and they are NOT the same news. Below the floor is
      // the gate doing its job on a genuinely short utterance — the common case,
      // and silent as it always was. The cap having been hit is an anomaly: a
      // LONG utterance that will not be refined, which is the one an operator
      // would want to see. It cannot pass the gate either way — `byteLength`
      // reports an overflowed buffer as empty — so this is the same skip the
      // post-take() guard used to log, decided one step earlier.
      if (retained.overflowed) {
        log.warn('stt.refine skipped — retained audio hit the in-memory cap', {
          final_duration_ms: finalDurationMs,
          overflowed: true,
        });
      }
      retained.clear();
      return;
    }
    // No `pcm.length === 0` guard here any more, and its absence is the point:
    // the gate above now reads this very buffer, so an empty take() is
    // unreachable (empty ⇔ retainedMs === 0 ⇔ refused above). `runRefine` keeps
    // its own `pcm.length === 0` belt regardless.
    const pcm = retained.take();
    retained.clear();
    const pass = runRefine({
      pcm,
      firstPass,
      transcribe: refine.transcribe,
      onError: (err) => log.warn('stt.refine second pass failed — the first-pass text stands', {
        error: err instanceof Error ? err.message : String(err),
      }),
    });
    // 🔴 RT-1: this `void … .then(…)` had NO `.catch`. `runRefine` swallows the
    // TRANSCRIBER's failures, but the handler below emits on a socket and writes a
    // log — either can throw, and an escaped rejection here reaches
    // installProcessGuards → onFatal → graceful close → exit, i.e. it takes the
    // relay down for every online user. Dormant only because `stt.refine` defaults
    // OFF, which is not the same as impossible. THIS is the fix; the emit gate
    // below is deliberately left exactly as it was.
    void pass
      .then((text) => {
        // 🔴 `this.disposed` is LEFT IN PLACE, and it is not the harmless
        // liveness check it reads as. Measured this round: the audio handler runs
        // `finish().finally(() => s.dispose())`, so `disposed` is true
        // milliseconds after the terminal final, while a batch re-transcription
        // of a ≥15 s utterance takes seconds ⇒ on the normal audio:stop path this
        // frame is NEVER sent. GA-14 can only deliver on the auto-stop path.
        //
        // That is a defect. It is ALSO, right now, the only thing standing
        // between this event and the corruption path documented in
        // runDetachedPolish's delivery block: `_applyRefined` on the phone
        // overwrites the newest ROW with no entry-type or owner filter, so an
        // active GA-14 could replace an image label or the user's typed note.
        // Removing this line would ACTIVATE that. It stays until the phone can
        // pick the right row — the same unblocking condition, registered once.
        if (text === null || this.disposed) return;
        // The phone owns the timeline row (only the mobile emits history:create),
        // so this is a NOTIFICATION, not a write-back. It carries no FSM meaning:
        // the utterance is settled and stays settled.
        //
        // Payload = exactly SttRefinedSchema's declared fields. `language` used to
        // ride along undeclared; nothing read it (the phone takes `data['text']`
        // only, the desktop does not subscribe at all) and a key outside the
        // contract is a key no receiver may rely on.
        this.deps.emitter.emit('stt:refined', { text });
        // Both numbers, because they now answer different questions and the
        // difference between them is what card N1-B1b was about: `retained_ms` is
        // what was re-transcribed, `final_duration_ms` is only the segment that
        // closed the utterance.
        log.info('stt.refine produced a better transcript', {
          retained_ms: Math.round(retainedMs),
          final_duration_ms: finalDurationMs,
        });
      })
      .catch((err) => log.error('stt.refine delivery failed unexpectedly — the first-pass text stands', {
        error: err instanceof Error ? err.message : String(err),
      }));
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
    if (this.disposed) return;
    let payload: Buffer;
    try { payload = Buffer.from(dataB64, 'base64'); } catch { return; }
    if (payload.length === 0) return;
    this.chunkCount += 1;
    this.totalBytes += payload.length;
    const peak = peakSample16(payload);
    if (peak > this.peakSample) this.peakSample = peak;
    this.totalAudioMs += payload.length / BYTES_PER_MS;
    // GA-14: keep a copy for the optional second pass. Bounded and in-flight —
    // see RetainedAudio for why an overflowed buffer refines NOTHING rather than
    // refining a partial span.
    this.retained?.push(payload);
    // VAD gate (real caller): update gate state + amplitude + billing meter
    // BEFORE the orchestrator's engine feed reads vad.open (single-threaded).
    this.vad.process(payload);
    this.maybeEmitLevel(tsMs);
    this.orchestrator.pushChunk({ seq, ts_ms: tsMs, payload });
  }

  private maybeEmitLevel(tsMs: number): void {
    const interval = this.deps.levelIntervalMs ?? 200;
    if (tsMs - this.lastLevelMs < interval) return;
    this.lastLevelMs = tsMs;
    this.deps.emitter.emit('stt:level', { amplitude_db: round2(this.vad.lastAmplitudeDb) });
  }

  async finish(): Promise<void> {
    if (this.disposed) return;
    // The intake tally (owner 2026-07-27: "is this a mobile-side issue"). `peak` is the
    // loudest PCM16 sample of the whole utterance on a 0..32767 scale: a few
    // hundred is a quiet room's noise floor, an exact 0 across thousands of
    // bytes is a muted/dead capture, and chunks:0 means the phone never sent
    // audio at all. Emitted BEFORE the awaits so it lands even if the flush
    // throws — a diagnostic that only prints on the happy path is no diagnostic.
    log.info('audio intake', {
      chunks: this.chunkCount,
      bytes: this.totalBytes,
      peak: this.peakSample,
      audioMs: Math.round(this.totalAudioMs),
      voicedMs: Math.round(this.vad.sessionMs),
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
        chunks: this.chunkCount,
        bytes: this.totalBytes,
        peak: this.peakSample,
        audioMs: Math.round(this.totalAudioMs),
        voicedMs: Math.round(this.vad.sessionMs),
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
