// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (flush race: engine.flush() vs
//     timeout so stt:final always fires; offlineAccum authoritative), §2 (no
//     silent failure — flush-phase error settles as one-shot stt:error, never hangs)
//   Ported from legacy stt/flush-final.ts (mechanism unchanged from the legacy line, F-2050/F-2069).
//
// raceFlushFinal: settle a FinalResult from a flushing engine on whichever
// arrives first — a captured 'final', the flush() promise resolving, a
// flush-time 'error', or the flush-timeout cap. ALWAYS resolves (never
// rejects). `text` is the LATE-BOUND offline-accumulated finals so a final
// arriving DURING the flush still folds in.

import type { EventEmitter } from 'node:events';
import type { FinalResult, SttEngine } from './engines/base';
import { vadClosureSilenceBytes, PCM_BYTES_PER_MS } from './tuning-env';
import { log } from '../log';
import { AUDIO_DEFAULTS } from '@flowmic/protocol';

export interface FlushFinalDeps {
  /** The engine being flushed, or null (→ resolve immediately with offline text). */
  engine: (SttEngine & EventEmitter) | null;
  /** Late-bound accumulated offline finals; read at settle time. */
  getOfflineText: () => string;
  /** Language echoed into the FinalResult when nothing is captured. */
  language: string;
  /** Cap on engine.flush() before falling back to accumulated text. */
  timeoutMs: number;
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn: (handle: unknown) => void;
  /**
   * WP2-6a — fired the instant `engine.flush()` is invoked, not when this
   * function is entered and not when the flush settles. That instant is the
   * only honest "we sent the flush" timestamp; a parallel clock on the
   * caller would measure a different moment. Absent (harnesses) ⇒ no stamp.
   * Production author: `SttEngineOrchestrator.flushSentHook` ← `stt-factory.ts`.
   */
  onFlushSent?: () => void;
  /**
   * Card RC-2 — when the hard cap fires and the engine produced no final of its
   * own, WITHHOLD the accumulated text (`FlushOutcome.refused`) instead of
   * delivering it as the transcript. The orchestrator sets it only for a
   * TERMINAL flush of an engine that reports a processed position
   * ({@link networkFlushCapMs} sized the cap from it): a cap that still fires
   * there means the vendor had more to say and we stopped listening.
   * Absent/false ⇒ unchanged behaviour.
   */
  withholdOnTimeout?: boolean;
}

/**
 * Same family the old 5s flush floor targeted (`startsWith('funasr')` /
 * `startsWith('funspeech')`). Soniox and the other engines are not in it.
 */
export function isFunasrFlushFamily(engineId: string): boolean {
  return engineId.startsWith('funasr') || engineId.startsWith('funspeech');
}

/**
 * Probe T2_linger (p1-packet-E, 2026-08-31, office FunASR runtime): post-flush
 * inter-frame gaps were 104 / 105 / 105 / 104 / 429 ms — all ≤ ~450 ms. 2000 ms
 * is ~4.4× the largest measured gap, so a live drain keeps extending.
 *
 * Armed on the FIRST post-flush frame, not at flush send: T2's first offline
 * is at +7264 ms of silence, so a 2s-from-start quiescence would reproduce the
 * tail loss. A completely silent engine therefore falls to the hard cap.
 *
 * F-1b — quiescence settle is allowed ONLY after ≥1 FINAL since attach.
 * Interim-only activity still (re)sets this timer, because a live online drain
 * must not look idle. But a fire with zero post-attach finals MUST NOT settle:
 * disarm and leave the hard cap (or a later real drain) in charge.
 *
 * Failure shape: a STRAGGLER 2pass-online — one in-flight online response
 * landing shortly after flush()/listener attach, before the 5–7 s pre-drain
 * silence — is also a "first post-flush frame". Arming 2s on that interim,
 * then going quiet, fires BEFORE the offline drain begins and settles the
 * accumulated draft: the exact F-1 tail-loss shape, just earlier. The F-1
 * probe could not show this (audio ended ~2.5 s before flush). Production
 * flushes almost immediately after the last audio chunk, so one straggler
 * online is plausible. After the first post-attach final, 2s quiet settles.
 */
export const FUNASR_FLUSH_QUIESCENCE_MS = 2_000;

/**
 * Probe T2_linger: last 2pass-offline arrived at +8110 ms on a 62.6 s span.
 * 15000 ms is ~1.85× that measured drain, and matches the linger that found
 * the runtime still open (server did not FIN within 15 s). Replaces the flat
 * 5s floor that fired before either offline.
 */
export const FUNASR_FLUSH_HARD_CAP_MS: number = AUDIO_DEFAULTS.engine_flush_hard_cap_ms; // RC4-S5 follow-up: declared once in the protocol

/** The engine whose flush is a LOCAL DECODE — a bounded computation whose cost
 *  is a function of the audio it holds, not a network round trip that may never
 *  answer. Its cap is sized differently ({@link localFlushCapMs}). */
export function isLocalDecodeEngine(engineId: string): boolean {
  return engineId === 'sherpa-local';
}

/**
 * NR-50 — the flush cap for the local engine scales with the audio it decodes.
 *
 * WHY NOT THE FLAT 3 000 ms. Until NR-50 the local terminal decode ran inside
 * `flush()`'s synchronous body, so the flat cap structurally could not fire
 * against it (no timer is serviced while a native call holds the loop). Moving
 * the decode to `decodeAsync` frees the loop — and makes that cap fire for the
 * first time. Measured on dev-pc-a (2026-09-16, quiet box: idle 20 ms
 * timer lag 12 ms, node v22.22.3, sherpa-onnx-node@1.13.4, numThreads=2,
 * real packs, `scripts/drills/local-engine-lifecycle-probe.mjs --decode-cost`
 * + a one-off of the same shape for whisper):
 *
 *   senseVoice   45 s audio  →  2 001 / 1 981 ms wall  (RTF ≈ 0.046)
 *   whisper-turbo 1 s audio  →  1 822 ms                (fixed cost alone)
 *   whisper-turbo 30 s audio → 16 887 ms                (RTF ≈ 0.57)
 *
 * Wall time is the same sync or async (async only keeps the loop alive), so
 * the quantity a cap races is the decode's WALL TIME, and that is linear in
 * audio length with a per-row slope that differs 12× between the shipped rows.
 * A flat 3 s would fail every whisper utterance over ~2 s on THIS machine; a
 * flat number big enough for whisper would let a 1 s SenseVoice hang sit for
 * as long. So: `max(floor, audioMs × RTF cap)`.
 *
 * WHAT THE CAP IS FOR, now. The user-facing wait is bounded by the PHONE's own
 * 15 s processing watchdog (`state_machine.dart` `processingTimeout`), which it
 * always was — a decode slower than that stalls the phone whether or not a
 * server cap exists. This cap is the HANG detector: a native decode that does
 * not return in 2× real time is not "a slow machine", it is a decode that is
 * not coming back (2.0 is 3.5× the slowest measured row's RTF; a box that slow
 * had lost the 15 s race long before). The floor covers whisper's fixed cost on
 * short utterances with the same headroom.
 *
 * 🔴 WHEN IT FIRES, THE FALLBACK IS A REFUSAL, NOT THE PREVIEW — see
 * {@link FlushOutcome.refused}. That is the other half of this card and the two
 * were ruled inseparable (ledger §33/§38): a bigger cap alone would only make
 * the silent preview-as-final rarer, not honest.
 */
export const LOCAL_FLUSH_RTF_CAP = 2.0;
export const LOCAL_FLUSH_FLOOR_MS = 5_000;

export function localFlushCapMs(legAudioMs: number): number {
  return Math.max(LOCAL_FLUSH_FLOOR_MS, Math.round(legAudioMs * LOCAL_FLUSH_RTF_CAP));
}

/**
 * Card RC-2 — the flush cap for a NETWORK streaming engine that reports how far
 * the vendor has processed the audio this leg was handed
 * (`SttEngine.ackedAudioMs`), scaled by what is still unprocessed.
 *
 * WHY NOT THE FLAT 3 000 ms. A streaming vendor finishes a flush only after it
 * has processed everything it was sent, and it processes at roughly real time
 * whatever rate the audio arrived at. Measured against Soniox directly
 * (root-cause doc §1.6, plus `.local/rc-backfill/soniox-ack-probe.log` in the
 * lane-d slot: 30 s of speech sent in 2 s, then 10 s of silence in real time,
 * then end-of-stream): `total_audio_proc_ms` rose at ~1.2x real time, reached
 * the fed total 24 s after end-of-stream, in the same frame as `finished`.
 * A 60 s burst took 52.6 s. On CR-12-E the recovery feed pushed 428 s in 4.3 s;
 * the flat cap fired 3 s after `audio:stop`, the 8 characters accumulated by
 * then were delivered as the whole transcript, and we closed the vendor socket
 * while it was still working.
 *
 * So the cap is `max(floor, backlog / NETWORK_FLUSH_VENDOR_RTF + tail)`, the
 * same shape as {@link localFlushCapMs}. `backlog` is fed minus acknowledged for
 * THIS leg, both in the leg's own fed-audio clock. The divisor is 1.0 against a
 * measured ~1.13-1.2x from one machine; root-cause doc §8 asks for it to be
 * re-measured per node.
 */
export const NETWORK_FLUSH_VENDOR_RTF = 1.0;
export const NETWORK_FLUSH_TAIL_MS = 3_000;

export function networkFlushCapMs(floorMs: number, backlogMs: number): number {
  return Math.max(floorMs, Math.round(Math.max(0, backlogMs) / NETWORK_FLUSH_VENDOR_RTF) + NETWORK_FLUSH_TAIL_MS);
}

/** Funasr/funspeech family default is the 15s hard cap (activity-extended
 *  quiescence lives in {@link raceFlushFinal}); the local engine's default is
 *  {@link localFlushCapMs} of the audio this leg was fed; a network engine that
 *  reports a processed position gets {@link networkFlushCapMs} of its unprocessed
 *  backlog (card RC-2; `backlogMs` null = the engine reports nothing, and its cap
 *  stays the configured one). An EXPLICITLY configured cap still wins the number;
 *  other engines are unchanged. */
export function resolveFlushTimeoutMs(engineId: string, configuredMs: number, explicit: boolean, legAudioMs = 0, backlogMs: number | null = null): number {
  if (explicit) return configuredMs;
  if (isFunasrFlushFamily(engineId)) return FUNASR_FLUSH_HARD_CAP_MS;
  if (isLocalDecodeEngine(engineId)) return localFlushCapMs(legAudioMs);
  if (backlogMs !== null) return networkFlushCapMs(configuredMs, backlogMs);
  return configuredMs;
}

/**
 * Card RC-2 — the frame a TERMINAL flush of a network engine emits INSTEAD of a
 * final when {@link networkFlushCapMs} still fired (`withholdOnTimeout`). Same
 * code and the same `retryable: false` as {@link localFlushRefusalError}, for the
 * reason that function gives: the phone turns a terminal `stt:error` into an
 * immediate stall that names the code, and a recovery attempt that gets it keeps
 * its bytes and backs off instead of settling on a few words (root-cause doc
 * §1.8). No new code; the wording is the existing `STT_ENGINE_TIMEOUT` sentence.
 */
export function networkFlushRefusalError(
  legFedMs: number,
  ackedMs: number | null,
  capMs: number,
): { code: string; message: string; retryable: false } {
  const acked = ackedMs === null ? 'an unknown amount' : `${Math.round(ackedMs)} ms`;
  return {
    code: 'STT_ENGINE_TIMEOUT',
    message: `the engine had processed ${acked} of the ${Math.round(legFedMs)} ms it was sent when its ${capMs} ms flush cap ran out; nothing was delivered (a partial transcript is not the transcript)`,
    retryable: false,
  };
}

/**
 * NR-50 — the frame the orchestrator emits INSTEAD of a final when a local
 * flush was withheld ({@link FlushOutcome.refused}) and the engine's own error
 * did not already go out. `retryable: false` is the honest value and the
 * load-bearing one: the phone turns a terminal `stt:error` into an immediate
 * PROCESSING stall that names the code, whereas a retryable one is only
 * diagnosed — and an empty final after it would be read by the phone as the
 * flush-cap placeholder that KEEPS the interim on screen as the transcript
 * (`segment_buffer.dart` `put`, the `!emptyIsVerdict` branch). The only way the
 * preview does not become the row is: this frame, and no final at all.
 * Wording is the existing `STT_ENGINE_TIMEOUT` sentence (no new code — adding
 * one is the owner's gate; the proposal is in the NR-50 report).
 */
export function localFlushRefusalError(
  engineFedBytes: number,
  capMs: number,
  timedOut: boolean,
): { code: string; message: string; retryable: false } {
  const audioMs = Math.round(engineFedBytes / PCM_BYTES_PER_MS);
  return {
    code: 'STT_ENGINE_TIMEOUT',
    message: timedOut
      ? `local decode of ${audioMs} ms of audio did not finish within its ${capMs} ms cap; nothing was delivered (a preview is not a transcript)`
      : `local decode of ${audioMs} ms of audio failed; nothing was delivered (a preview is not a transcript)`,
    retryable: false,
  };
}

/** FunASR/FunSpeech 2pass VAD needs trailing silence to close the final word —
 *  feed 400ms of s16le zeros into the engine ONLY (never the session
 *  buffer/seq, so replay is unaffected). Server-side by design: mobile MUST NOT
 *  emit spurious audio:chunk.
 *
 *  ⚠️ CLOCK PROVENANCE (card M3-4b same-family scan, 2026-08-02): `nowMs` is the SERVER's
 *  clock, while every other `engine.push(payload, ts_ms)` in this codebase hands
 *  over the PHONE's capture timestamp (`orchestrator-core.ts` pushChunk /
 *  replayBufferTail). So this one parameter is fed by two different machines'
 *  clocks depending on the call site. That is INERT TODAY ONLY BECAUSE NO ENGINE
 *  READS IT — checked 2026-08-02: deepgram / funasr / funspeech-http /
 *  openai-realtime / openai-whisper / sherpa-local / custom-openai-compatible
 *  all declare `push(chunk: Buffer)` and ignore the second argument, and
 *  `packages/stt-cloud/src/engines/soniox.ts`'s `SonioxEngine.push` says so in
 *  as many words (symbol-only citation on purpose, no `:NNN` — that package is
 *  EXCLUDEd from the public tree by `scripts/opensource-manifest.mjs`, so a
 *  line-number coordinate into it can never resolve there; see the EXCLUDE-tree
 *  paragraph in `verify/lint/coordinate-anchors.mjs`'s header).
 *  🔴 The day an engine starts using `ts_ms` for anything (timeline alignment,
 *  segment offsets, its own retention), this line becomes a real defect and the
 *  right fix is to give it the phone-clock timestamp of the last real chunk —
 *  not to leave it answering a question with the wrong watch. */
export function feedVadClosureSilence(
  engine: (SttEngine & { state?: string }) | null,
  nowMs: number,
): void {
  const eid = engine?.id ?? '';
  if (!eid.startsWith('funasr') && !eid.startsWith('funspeech')) return;
  if (!engine || engine.state !== 'open') return;
  try { engine.push(Buffer.alloc(vadClosureSilenceBytes()), nowMs); } catch (err) { console.error('[feedVadClosureSilence] engine.push error (flush proceeds):', err); }
}

/**
 * Probe T2_gaps1000 (p1-packet-E, 2026-08-31, office FunASR runtime): 1000 ms of
 * silence closes a runtime VAD span (offline mid-stream); 300 ms does not;
 * 600 ms (product MIN_PAUSE_MS) was unprobed. Hence we feed the measured full
 * second rather than trusting the ungated pause length.
 *
 * Same invariant as {@link feedVadClosureSilence}: ENGINE ONLY — never the
 * session buffer/seq, so replay and billing (`vad.sessionMs` in stt-session
 * settle) are untouched. Called once per gate-closure episode by
 * `FunasrSpanClosureFeeder` (funasr-span-closure.ts), not on every silent chunk.
 */
export const FUNASR_RUNTIME_SPAN_CLOSURE_MS = 1_000;

export function feedRuntimeSpanClosureSilence(
  engine: (SttEngine & { state?: string }) | null,
  nowMs: number,
): void {
  if (!isFunasrFlushFamily(engine?.id ?? '')) return;
  if (!engine || engine.state !== 'open') return;
  try {
    engine.push(Buffer.alloc(FUNASR_RUNTIME_SPAN_CLOSURE_MS * PCM_BYTES_PER_MS), nowMs);
  } catch (err) {
    console.error('[feedRuntimeSpanClosureSilence] engine.push error (pause proceeds):', err);
  }
}

/**
 * What {@link raceFlushFinal} settled on.
 *
 * 🔴 `timedOut` is here because the caller has to be able to tell "the engine
 * answered, and its answer was empty" from "the engine returned not a single
 * character within the timeout window, and this text is something we cobbled
 * together ourselves". Those are two different facts and the FinalResult alone answers neither —
 * both look like `text: ''`. The distinction is not academic: L9 (2026-08-02)
 * found a live Soniox adapter whose `flush()` NEVER resolved, so every single
 * utterance settled on the cap, and the wire showed a perfectly ordinary
 * `stt:final` with no error attached. One value answers only one question.
 */
export interface FlushOutcome {
  readonly result: FinalResult;
  /** true ⇒ the cap fired; the engine never finished flushing. */
  readonly timedOut: boolean;
  /**
   * NR-50 — true ⇒ the engine declares its interims are previews
   * (`SttEngine.interimIsPreviewOnly`), produced NO final of its own, and the
   * settle came from the cap or an error ⇒ `result.text` is `''` BY REFUSAL:
   * the accumulated preview was deliberately withheld. The caller must not emit
   * a final and must say why (`localFlushRefusalError`). A clean flush that
   * simply had nothing to decode is NOT refused — that is the honest empty
   * final with its `empty_reason`, unchanged.
   */
  readonly refused: boolean;
  /**
   * card RC-L — true ⇒ the engine emitted a final of its own during this flush. For an engine that
   * reports a processed position (Soniox, whose `final` comes only with its end-of-stream answer) false
   * means the flush ended WITHOUT the vendor having answered everything it was handed — the leg died
   * (a close during a flush resolves it silently, `intentionalClose`) or the cap fired — so the audio
   * past its answered point is owed to the next leg (`orchestrator-core.ts` `noteLegUnanswered`).
   */
  readonly engineFinal: boolean;
}

export function raceFlushFinal(d: FlushFinalDeps): Promise<FlushOutcome> {
  const empty: FinalResult = { kind: 'final', text: '', confidence: 0, language: d.language, duration_ms: 0 };
  const engine = d.engine;
  if (!engine) return Promise.resolve({ result: { ...empty, text: d.getOfflineText() }, timedOut: false, refused: false, engineFinal: false });
  const activityExtended = isFunasrFlushFamily(engine.id);
  return new Promise<FlushOutcome>((resolve) => {
    let captured: FinalResult | null = null;
    let settled = false;
    let timedOut = false;
    let errored = false;
    let quiescenceTimer: unknown = null;
    let postAttachFinals = 0;
    const onActivity = (): void => {
      if (!activityExtended || settled) return;
      if (quiescenceTimer !== null) d.clearTimeoutFn(quiescenceTimer);
      quiescenceTimer = d.setTimeoutFn(() => {
        // F-1b: a straggler 2pass-online arms this timer. Settling here with
        // zero post-attach finals loses the tail — see FUNASR_FLUSH_QUIESCENCE_MS.
        if (postAttachFinals === 0) {
          quiescenceTimer = null;
          return;
        }
        timedOut = true;
        log.warn('stt.flush quiescence settle — using accumulated offline finals', { engine: engine.id, quiescence_ms: FUNASR_FLUSH_QUIESCENCE_MS, chars: d.getOfflineText().length });
        finish(captured ?? empty);
      }, FUNASR_FLUSH_QUIESCENCE_MS);
    };
    const onFinal = (e: FinalResult): void => { captured = e; postAttachFinals += 1; onActivity(); }; // last final wins
    const onInterim = (): void => { onActivity(); };
    const finish = (r: FinalResult): void => {
      if (settled) return;
      settled = true;
      engine.off('final', onFinal);
      engine.off('error', onError);
      if (activityExtended) engine.off('interim', onInterim);
      d.clearTimeoutFn(hardCapTimer);
      if (quiescenceTimer !== null) d.clearTimeoutFn(quiescenceTimer);
      // offlineAccum is authoritative. On timeout fallback only, if captured.text
      // is longer and contains offlineText as a prefix, use captured — the
      // engine's final may have the tail word offlineAccum lacks.
      // NR-50 — a preview-only engine that did not answer gets NOTHING delivered
      // on its behalf: `offline` here would be its last preview, decoded without
      // left context, and handing that out as the terminal final was the R11
      // breach this card closes. Keyed on the ENGINE's declaration, so the
      // streaming engines' cap fallback (their interims ARE the decoder's
      // hypothesis) is byte-for-byte what it was.
      if (engine.interimIsPreviewOnly === true && captured === null && (timedOut || errored)) {
        resolve({ result: { ...r, text: '' }, timedOut, refused: true, engineFinal: captured !== null });
        return;
      }
      // Card RC-2 — a network engine's backlog-scaled cap still fired on a
      // terminal flush: the vendor was still working, so what we accumulated is
      // a prefix, not the transcript. Withheld the way NR-50 withholds a
      // preview; the caller says STT_ENGINE_TIMEOUT.
      if (d.withholdOnTimeout === true && captured === null && timedOut) {
        resolve({ result: { ...r, text: '' }, timedOut, refused: true, engineFinal: captured !== null });
        return;
      }
      const offline = d.getOfflineText();
      if (timedOut && captured && captured.text.length > offline.length && captured.text.startsWith(offline)) {
        resolve({ result: { ...r, text: captured.text }, timedOut, refused: false, engineFinal: true });
      } else {
        resolve({ result: { ...r, text: offline }, timedOut, refused: false, engineFinal: captured !== null });
      }
    };
    const onError = (): void => { errored = true; finish(captured ?? empty); }; // settle, don't hang
    engine.on('final', onFinal);
    engine.on('error', onError);
    if (activityExtended) engine.on('interim', onInterim);
    const hardCapTimer = d.setTimeoutFn(() => {
      timedOut = true;
      // NR-50: say which of the two things is about to happen — the line used
      // to claim "using accumulated" on a path that now withholds them.
      // Card RC-2 (the line RC-6 left here): through the logger, so it lands in
      // server.log with fields rather than on a bare stderr.
      const withheld = captured === null && (engine.interimIsPreviewOnly === true || d.withholdOnTimeout === true);
      log.warn(withheld ? 'stt.flush timeout — WITHHOLDING the accumulated text: it is not the transcript' : 'stt.flush timeout — using accumulated offline finals', {
        engine: engine.id, cap_ms: d.timeoutMs, chars: d.getOfflineText().length, withheld,
      });
      finish(captured ?? empty);
    }, d.timeoutMs);
    // WP2-6a: stamp BEFORE the call, not in its `.then` — `.then` is "flush
    // settled", which is the other side of the split. Absence of engine (early
    // return above) is not a send, so it never reaches here.
    d.onFlushSent?.();
    engine.flush().then(() => finish(captured ?? empty)).catch(() => finish(captured ?? empty));
  });
}
