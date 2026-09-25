// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (SttEngine interface: id/state/push/
//     flush/close/open?; EventEmitter interim|final|error|state; SttEngineError)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (four-layer robustness — reconnect
//     owned by the orchestrator, not the engine)
//   docs/archive/strategy/R1-TASK-CARDS.md WP-R1-3
//
// Common abstraction for the seven bundled STT engines. Each implementation is
// its own file. Ported ("the mechanism follows the old line" — 机理照旧线) from
// legacy stt/engines/base.ts; the wire
// contract (event names, error codes) is re-based on @flowmic/protocol per the
// legacy-source-reference-policy ("the new contract wins" — 新契约赢).

import type { SttEngineId } from '@flowmic/protocol';

// WP-R23-0: `sherpa-local` (the 7th built-in, in-process offline engine) was
// folded into the protocol `SttEngineId` union, so the former server-internal
// superset `InternalSttEngineId` is gone — every engine id below is the protocol
// type directly (deviation from the WP-R1-3 handoff now closed).

export interface SttEngineConfig {
  id: SttEngineId;
  endpoint?: string;
  api_key?: string;
  model?: string;
  language: string;
  /** Sample rate of upstream PCM. 0.1.0 always 16 kHz mono s16le (06 §1). */
  sample_rate: 16_000;
  /**
   * FunASR FST hotwords (06 §5, F-2117): a JSON-STRING of `{term:weight}` pairs
   * (NOT an object) built from `stt.dictionary`, e.g. `'{"FlowMic":20}'`.
   * Consumed only by FunasrEngine.open(). `undefined` (default) → the open
   * frame is byte-identical to baseline (field omitted).
   */
  hotwords?: string;
  /**
   * Soniox `context` (RT-6 card): free text naming the terms likely to be
   * spoken, built from the SAME three terminology sources as [hotwords] by
   * `stt/terminology-context.ts`. A DIFFERENT wire shape for the same data —
   * Soniox does not parse FunASR's `{term:weight}` string — which is why the
   * two fields coexist instead of one being reused. Consumed only by the
   * Soniox adapter; `undefined` (default) → the config frame is byte-identical
   * to baseline (field omitted).
   */
  context?: string;
}

export interface InterimResult {
  kind: 'interim';
  text: string;
  confidence: number;
  language: string;
  /**
   * card RC-4 — ADAPTER-INTERNAL facts for the orchestrator's segment-cut policy
   * (`stt/segment-boundary.ts`). Never on the wire: the relay builds its own
   * `stt:interim` frame from `text` alone. Each field ABSENT = the engine did not
   * say (absent is a third answer, not 0 / ''). Today only Soniox sets them.
   *  · `finalized_text` — the leg's never-changing prefix (vendor `is_final`),
   *    so the sentence arm can read CONFIRMED text between flushes.
   *  · `hypothesis_last_word_ms` — end of the last content word in the current
   *    hypothesis (final or provisional), in this leg's fed-audio clock.
   *  · `audio_proc_ms` — how much of this leg's audio the vendor has processed.
   * Consumer and account: `apps/server-core/src/stt/segment-pause.ts` `liveWordGap`.
   */
  finalized_text?: string;
  hypothesis_last_word_ms?: number;
  audio_proc_ms?: number;
  /** card RC-4 overdue — content words THIS event's frame finalised (vendor
   *  `is_final`), as spans in this leg's fed-audio clock. Deltas: a final token
   *  arrives once. Read by `apps/server-core/src/stt/overdue-cut.ts`. */
  finalized_word_spans?: ReadonlyArray<{ readonly start_ms: number; readonly end_ms: number }>;
}

export interface FinalResult {
  kind: 'final';
  text: string;
  confidence: number;
  language: string;
  duration_ms: number;
  /**
   * card CR-12-D — where this leg's speech sat inside the audio THIS LEG was
   * handed, in ms of that audio: start of the first content word, end of the
   * last one. Both ABSENT when the engine reports no word timestamps (today
   * only Soniox does); absent is a third answer, not 0.
   *
   * ⚠️ NOT wall-clock and NOT session time. The clock is `engineFedBytes / 32`
   * for this leg, so anything a VAD gate withheld is not in it. The consumer,
   * and the whole account of what that costs, is
   * `apps/server-core/src/stt/segment-pause.ts`.
   */
  first_word_ms?: number;
  last_word_ms?: number;
  /**
   * card RC-5c — ADAPTER-INTERNAL, never on the wire (the relay rebuilds its own
   * frames). Set only on the final that answers END-OF-STREAM (Soniox: the
   * `finished` frame): a LOWER BOUND on how much of this leg's audio, in this
   * leg's fed-audio clock, the vendor had processed — i.e. how far this final can
   * cover. ABSENT = unknown ⇒ the seam merge keeps RC-5b's rule. Consumer:
   * `apps/server-core/src/stt/leg-facts.ts` `closeLeg`.
   */
  audio_proc_floor_ms?: number;
  /** card RC-5c — every token of `text`, in order, with the vendor's start time in
   *  this leg's clock (null = none given); the `text` fields concatenate to `text`.
   *  ABSENT when the engine has no token timestamps. Consumer: `leg-facts.ts` `foldFinal`. */
  token_spans?: ReadonlyArray<{ readonly text: string; readonly start_ms: number | null }>;
}

export type EngineEvent = InterimResult | FinalResult;

/**
 * 🔴 INT-2 (2026-08-12) — HOW TWO CONSECUTIVE `interim` FRAMES OF ONE SPAN RELATE.
 *
 * `'cumulative'` means: every frame is the WHOLE hypothesis for everything the
 * engine has heard in this span so far, and a later frame may REVISE an earlier
 * one anywhere inside it. Concatenating two such frames doubles the utterance.
 *
 * Absent means UNDECLARED — nobody has measured this engine — and the consumer
 * keeps guessing from the strings (`mergeOnlineDraft`). That is deliberately the
 * default: a declaration is a MEASUREMENT, and inventing one for six engines
 * nobody re-measured today would be exactly the kind of confident-and-wrong fact
 * this field exists to replace.
 *
 * ⚠️ There is no `'delta'` member, and its absence is a decision. FunASR 2pass-
 * online really does send per-VAD-span rolling deltas, but no consumer would do
 * anything different with that declaration than it already does when told
 * nothing — and a value with no reader is a capability with no caller
 * (CLAUDE.md anti-façade). The day one appears, this union grows.
 *
 * 📌 This closes, for one engine, the open account text-merge.ts registered in
 * as many words: 「The structural answer is for an engine to DECLARE whether its
 * interim is cumulative or a delta, instead of every consumer guessing from the
 * strings.」 It stayed open because it was scoped as 「a change to the
 * InterimResult contract shared by seven engines」 — but an OPTIONAL declaration
 * on the engine changes nothing for the six that stay silent.
 */
export type InterimShape = 'cumulative';

export type EngineState = 'open' | 'reconnecting' | 'failed' | 'closed';

/**
 * STT engine contract (06 §3). Implementations subclass node:events
 * EventEmitter and emit:
 *   - 'interim' (InterimResult)
 *   - 'final'   (FinalResult)
 *   - 'error'   (SttEngineError)
 *   - 'state'   (EngineState)
 * Reconnect / replay / soft-segmentation are OWNED BY THE ORCHESTRATOR, never
 * the engine — so each engine stays testable in isolation.
 */
export interface SttEngine {
  readonly id: SttEngineId;
  readonly state: EngineState;

  /** This engine's declared {@link InterimShape}, or absent for 「not measured」.
   *  Read by the orchestrator to pick how consecutive interims are folded — see
   *  `text-merge.ts` `mergeCumulativeDraft` vs `mergeOnlineDraft`. */
  readonly interimShape?: InterimShape;

  /**
   * NR-50 — are this engine's interims PREVIEWS rather than a running hypothesis
   * of the transcript? `true` ⇒ they were decoded without their left context and
   * split at an energy boundary (sherpa-local's tail re-decodes), so when a
   * flush settles WITHOUT an engine final — the cap fired, or the decode errored —
   * the text the orchestrator accumulated from them is NOT a transcript and
   * `raceFlushFinal` WITHHOLDS it (`FlushOutcome.refused`) instead of delivering
   * it as one. Absent/false ⇒ the streaming engines' behaviour, unchanged: their
   * interims come from the same decoder that would have produced the final.
   * Declared by the engine, never inferred from the strings (INT-2's rule).
   */
  readonly interimIsPreviewOnly?: boolean;

  /**
   * card RC-D — does this engine emit `final` ONLY in answer to our `flush()`
   * (end-of-stream), never mid-session? `true` ⇒ between flushes the only
   * 「confirmed」 text is the vendor's finalised prefix, which trails the audio by
   * 4.1–5.3 s (measured, `docs/strategy/2026-09-24-cr12e-rerun-root-cause.md`
   * §2), so a sentence end read from it is seconds behind the live edge and a row
   * cut on it lands inside the next word. The orchestrator therefore closes the
   * sentence arm for such an engine (`orchestrator-core.ts` `pushChunk`,
   * book 06 §2 RC-D block). Absent/false ⇒ finals may arrive mid-session
   * (FunASR 2pass, SenseVoice) and the sentence arm reads them as before.
   * Declared by the engine, never inferred from its events (INT-2's rule).
   */
  readonly finalsOnlyAtFlush?: boolean;

  /**
   * card NR-60 — the LONGEST span of audio this engine can decode in ONE
   * `flush()`. Audio beyond it is not transcribed, and the engine does not
   * necessarily say so: the local whisper packs keep the first 30 s and discard
   * the rest with nothing but a line on the decoder's own stderr
   * (`segment-boundary.ts` `LEG_AUDIO_BUDGET_MARGIN_MS` carries the measurement
   * and the binary the sentence came out of).
   *
   * Read by the orchestrator, which rotates the engine leg before the span it
   * is holding can cross this — see `enforceLegAudioBudget`. Absent = 「this
   * engine declared nothing」 and the leg keeps its clock-only bound, which is
   * every network engine and every local pack that is not whisper. Absent is
   * NOT 「unlimited」: it is 「unmeasured」, the same distinction
   * {@link InterimShape} is written around, and inventing a number for an engine
   * nobody measured would be a bound with no evidence behind it.
   */
  readonly maxDecodeAudioMs?: number;

  /**
   * Card RC-2 — how much of the audio THIS leg was handed the vendor says it has
   * processed, in ms of that audio (the same fed-audio clock as
   * `FinalResult.first_word_ms`). Starts at 0 on a leg the vendor has not
   * answered yet. ABSENT = the engine reports nothing of the kind, which is every
   * engine but Soniox today (it reads the vendor's own `total_audio_proc_ms`).
   *
   * Two readers, both in server-core: the flush cap for network engines
   * (`flush-final.ts` `networkFlushCapMs`) and the `stt:interim.acked_audio_ms`
   * wire field the phone paces a recovery feed by (`stt/engine-backlog.ts`).
   * Absent is 「unknown」, never 「nothing processed」: reading it as 0 would make
   * every other engine's flush wait out its whole leg.
   */
  readonly ackedAudioMs?: number;

  /** Push a PCM chunk to the engine. */
  push(chunk: Buffer, ts_ms: number): void;

  /**
   * Force the engine to flush its buffer and emit a `final`. Used for
   * server-side soft segmentation (every 30s, 06 §2) and for graceful stop.
   */
  flush(): Promise<void>;

  /** Close the engine session and dispose all resources. */
  close(): Promise<void>;

  /** Optional connect step for network engines (ws handshake). */
  open?(): Promise<void>;

  /** card RC-4 overdue — the next final carries only tokens that started before
   *  [legMs] of this leg's audio (null lifts it). Declared by engines whose
   *  finals carry word times; today Soniox. See `stt/overdue-cut.ts`. */
  limitFinalTo?(legMs: number | null): void;
}

/** Error carried on the 'error' channel and mapped onto stt:error (06 §3). */
export class SttEngineError extends Error {
  constructor(public code: string, message: string, public retryable: boolean) {
    super(message);
    this.name = 'SttEngineError';
  }
}

/**
 * F-2136 (06 §2/§3): the retryable drop error every ws engine emits when its
 * socket closes UNEXPECTEDLY — a server FIN / idle-timeout while still OPEN that
 * OUR OWN teardown (flush/close) never initiated. Engines track that with an
 * `intentionalClose` flag; a still-false close in onClose() is the drop.
 * Emitting 'error' (not merely transitioning to 'failed') is what lets the
 * orchestrator's reconnect ladder fire — without it a clean close left STT
 * silently stalled until the 30s soft-segment timer.
 */
export function unexpectedCloseError(label: string): SttEngineError {
  return new SttEngineError('STT_NETWORK_DROP', `${label} ws closed unexpectedly`, true);
}

/**
 * OSS-DEFAULTS (0.3.0): the endpoint an unconfigured network engine must NOT
 * invent.
 *
 * Four engines (funasr / openai-whisper / custom-openai-compatible /
 * funspeech-http) each carried a `const DEFAULT_ENDPOINT = '…100.64.7.68…'`
 * and dialled it via `this.cfg.endpoint ?? DEFAULT_ENDPOINT`. That is two
 * defects at once:
 *
 *   1. it hard-codes the owner's office LAN in shipped code, which CLAUDE.md
 *      "code must not hardcode 100.64.7.x (use the presets package instead)"
 *      (代码禁写死 100.64.7.x（预设走 presets 包）) already forbade — the
 *      catalogue in @flowmic/protocol engine-presets is the sanctioned home for
 *      those addresses, and these four were not it; and
 *   2. it is a SILENT FALLBACK. A routing that reached an engine with no
 *      endpoint got a connection attempt to somebody else's machine instead of
 *      an answer to "this routing has no configured address" (这条路由没配地址).
 *      On a stranger's install that dial can
 *      only fail, and it fails as a network error — which sends the operator to
 *      look at their network rather than at their configuration.
 *
 * So a missing endpoint is now a NAMED refusal, and the message names BOTH
 * halves the operator needs: WHICH engine, and WHICH config key is empty.
 *
 * ⚠️ `STT_CONFIG_MISSING` is an EXISTING registered code (protocol
 * `error-codes.ts` — 「该语言尚未配置识别引擎。」 / 「No STT engine configured for
 * this language.」). Deliberately not a new code: this card is not authorised to
 * touch the registry, and the sentence that code already carries is true of this
 * failure. `retryable: false` — retrying cannot make a config key appear.
 */
export function requireEndpoint(engineId: SttEngineId, endpoint: string | undefined): string {
  if (endpoint !== undefined && endpoint.length > 0) return endpoint;
  throw new SttEngineError(
    'STT_CONFIG_MISSING',
    `STT engine '${engineId}' has no endpoint configured — set stt.routings[].endpoint for this language ` +
      `(engine '${engineId}' cannot run without one, and it will not guess an address)`,
    false,
  );
}
