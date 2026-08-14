// Card ENG-2 (fix-029) — the cold-open error verdict: `STT_NETWORK_DROP` is the
// FALLBACK, never the rewrite.
//
// THE ACCOUNT (P0 「LAN empty transcript」, 2026-08-11 ENG cards §Load-bearing
// facts #6). A stock 0.2.61 install ships `resources/server.js` with no
// `node_modules`, so `sherpa-local`'s open() throws a deliberate, NAMED
// `SttEngineError('STT_CONFIG_MISSING', "sherpa-local open failed: Cannot find
// module 'sherpa-onnx-node'", false)` — engines/sherpa-local.ts fail-loud
// block. The orchestrator's cold-open catch then re-coded EVERYTHING that was
// not the ROUTER's `SttConfigMissingError` to `STT_NETWORK_DROP`, so the one
// sentence that named the packaging problem was rewritten into "network
// interruption" (网络中断) and
// the operator was sent to check a WiFi connection that works. Same shape the
// ladder already fixed for mid-session errors (engine-session.ts L2,
// 2026-08-02: `organization_balance_exhausted` told as a network story).
//
// THE RULE. Two producers of config-missing-shaped failures, and they are NOT
// the same case:
//   · the ROUTER's `SttConfigMissingError` (engine-router.ts / engine-factory)
//     — "there is no route for this language" (这个语言没有路由). It never reaches
//     this verdict: the cold-open catch
//     re-throws it RAW before consulting us, so audio.handler's own catch maps
//     it (that path already survived; deliberately untouched here);
//   · an ENGINE's `SttEngineError` from open() — the engine itself named what
//     is wrong (`STT_CONFIG_MISSING` for addon/model/endpoint missing,
//     `STT_ENGINE_AUTH_FAIL` for a key refusal, …). The name survives, with
//     the engine's own message.
// Everything WITHOUT an engine-named code — a bare `Error` from a ws connect
// (ECONNREFUSED / ECONNRESET / ETIMEDOUT to a remote engine host) or the spawn
// timeout — still falls back to `STT_NETWORK_DROP`, because "the engine is
// unreachable" (引擎够不着) is
// exactly what that sentence has always said. Real network drops keep their
// code AND their underlying message; nothing is reclassified toward config.
//
// ⚠️ `retryable` is pinned FALSE on every branch, exactly as the old literal
// was. This frame reports "this audio:start's cold start has terminated"
// (这次 audio:start 的冷启动终止了) — the RUN is dead
// (start() re-throws right after the emit; the ack fails). An engine error's
// own `retryable` speaks about the ERROR (sherpa's model DOWNLOAD failure is
// `STT_NETWORK_DROP, retryable:true`), not about a run that no longer exists;
// `retryable:false` is also what releases the phone's FSM out of PROCESSING.
// Preserving code + message while pinning retryable is therefore not a loss of
// information — it is two different questions kept apart (one value answers
// only one question — 一个值只回答一个问题).
//
// ⚠️ NO NEW CODES. `STT_CONFIG_MISSING` is an existing registered code (protocol
// error-codes.ts) and the registry is an owner gate — this module only decides
// which EXISTING sentence rides the frame.
//
// Extracted as a sibling module (repo's standing 800-line-cap move, same family
// as empty-final-verdicts.ts / terminal-final-text.ts): orchestrator-core.ts is
// the one caller; no-engine-heard.test.ts pins both directions.

import { SttEngineError } from './engines/base';

export interface ColdOpenErrorFrame {
  code: string;
  message: string;
  retryable: boolean;
}

/** The `stt:error` frame for a failed cold open. Named engine codes survive;
 *  anything else answers `STT_NETWORK_DROP`, message intact either way. */
export function coldOpenErrorVerdict(err: unknown): ColdOpenErrorFrame {
  if (err instanceof SttEngineError) {
    return { code: err.code, message: err.message, retryable: false };
  }
  return {
    code: 'STT_NETWORK_DROP',
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
  };
}
