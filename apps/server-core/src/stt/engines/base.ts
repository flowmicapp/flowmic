// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (SttEngine interface: id/state/push/
//     flush/close/open?; EventEmitter interim|final|error|state; SttEngineError)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (four-layer robustness — reconnect
//     owned by the orchestrator, not the engine)
//   docs/strategy/R1-TASK-CARDS.md WP-R1-3
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
}

export interface InterimResult {
  kind: 'interim';
  text: string;
  confidence: number;
  language: string;
}

export interface FinalResult {
  kind: 'final';
  text: string;
  confidence: number;
  language: string;
  duration_ms: number;
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
