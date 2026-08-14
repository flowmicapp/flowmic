// S string catalogue shard: the「测试连接」("test connection") four-dimension
// probe (GA-12, the test_conn button and all of its readout copy).
// Merged and exported by ../strings.ts.
// V2-07.8a: per-locale catalogue (zh-CN baseline + en).
import { shardCatalogue } from './shard';

export const PROBE_KEYS = [
  // GA-12 — 「测试连接」("test connection") four-dimension probe (S.test_conn above is the button).
  // A probe reading is ONE-SHOT: it is never promoted into a resident status
  // light (13 §3 D3), so the copy says so out loud.
  'test_conn',
  'probe_running',
  'probe_ok',
  'probe_latency',
  'probe_model',
  'probe_sample',
  /** Rendered instead of a blank / invented value when a dimension is genuinely
   *  unavailable — the ws engines echo no model at all. */
  'probe_none',
  'probe_detail',
  'probe_hint',
  /** A ws handshake is NOT a transcription and never claims to be. */
  'probe_note_handshake',
  'probe_note_local',
  'probe_note_silent',
  'probe_note_empty',
  'probe_byok',
  'probe_managed',
  'probe_no_server',
  'probe_no_routing',
  // REQ-12-12 — ConnDiag / settings: empty LLM endpoint is a CONFIG fact, not
  // 「the engine broke」 (POST would come back LLM_INVALID_MODEL and lie).
  'probe_no_llm',
] as const;

export const PROBE_STRINGS = shardCatalogue(PROBE_KEYS);
