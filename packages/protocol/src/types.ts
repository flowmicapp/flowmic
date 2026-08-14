// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md (TranscriptHistoryItem, TimelineEntry)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3, §3.8, §5
//   docs/decisions/2026-07-23-wp-r0-1-protocol-rename-window.md
//
// WP-R0-1 rename window:
//   - Mode is LOCKED to the three canonical processing modes; the legacy
//     history-only values `draft`/`typing` (old `LegacyHistoryMode`) are gone.
//   - TimelineEntry.origin formally admits `cloud` (paired|standalone|cloud).

/** The only user-selectable processing modes — and, since WP-R0-1, the only
 *  values any history/timeline row's `mode` may hold. There is no fourth mode. */
export type ProcessingMode = 'realtime' | 'translate' | 'organize';
export type Mode = ProcessingMode;
export type SendPolicy = 'manual' | 'direct';
/** Per-utterance delivery intent, fixed at `audio:start` and immutable for the
 *  life of the utterance (WP-R1-1, master-plan §4.0 B/C). Omission = 'inject'.
 *  'none' = record-only (server never initiates injection, PC capsule never
 *  surfaces, and by default the entry does not join room sync). */
export type Delivery = 'inject' | 'none';
/** Delivery-truth states ONLY (WP-R1-1, master-plan §4.0 D). `noted` = the
 *  record-only fifth state; the legacy 'edited' VALUE moved to the separate
 *  `TranscriptHistoryItem.edited` boolean overlay. */
export type HistoryStatus = 'injected' | 'cached' | 'failed' | 'noted';
/** Billing tiers. THREE values since 0.2.38 (owner 2026-08-01,
 *  docs/decisions/2026-08-01-owner-three-tier-pricing-usd-monthly.md):
 *  free $0 / pro $6 / max $20 per month.
 *
 *  🔴 「云端卖便利，永不卖能力」— the tiers may differ ONLY in managed STT
 *  minutes, managed LLM tokens and PC INSTANCE COUNT. Phone count and cloud
 *  retention are IDENTICAL on pro and max; no product capability may exist on
 *  one tier and not another. (Enforced at boot: billing/plans.ts
 *  resolvePlanLimits.)
 *
 *  ⚠️ 2026-08-02 NARROWING — this paragraph used to say 「Device counts and cloud
 *  retention are IDENTICAL on pro and max」. `pcs` left that list when owner ruled
 *  FREE/PRO/MAX = 2/3/10 instances
 *  (docs/decisions/2026-08-02-pc-instance-limit-2-3-10.md): instance count is
 *  SCALE, not capability, and past 10 the answer is more subscriptions rather
 *  than a bigger tier. `mobiles`/`history_days` were NOT touched. The machine
 *  check that replaced it is `assertPcScaleLadder` (finite + free ≤ pro ≤ max).
 *
 *  `PLANS` is the ONE list. `Plan` is derived from it and `isPlan` tests
 *  against it, so a fourth tier is a one-line edit that cannot leave a stale
 *  copy behind — 13 册 §7 F1 ⑤ (a hand-written type predicate is an assertion
 *  the compiler does not check; the fix is to make it non-hand-written by
 *  deriving both the union and the test from the same array). `isPlan` has
 *  direct unit tests including non-string and wrong-case negatives. */
export const PLANS = ['free', 'pro', 'max'] as const;
export type Plan = (typeof PLANS)[number];

/** Runtime membership test for `Plan`. Exact, case-sensitive: `'Pro'` is NOT a
 *  plan — the wire and the DB both store lowercase, and quietly accepting a
 *  different casing would let two spellings of one tier exist. */
export function isPlan(v: unknown): v is Plan {
  return typeof v === 'string' && (PLANS as readonly string[]).includes(v);
}

export type ServerMode = 'standalone' | 'saas';

/** STT engine ids. The first six are wire/preset network engines;
 *  `sherpa-local` (WP-R23-0) is the 7th built-in — an in-process offline engine
 *  with no network endpoint. This union is a DATA-plane type only (routing
 *  `engine_id`, preset `engine`): NO zod wire schema references it, so admitting
 *  `sherpa-local` changes no wire schema, keeps the 54-event whitelist intact,
 *  and needs no PROTOCOL_SCHEMA_VERSION bump.
 *  (Evidence 2026-08-02, card §2: `grep 'engine_id\|SttEngineId\|engine:'
 *  packages/protocol/src/*schema*.ts` → zero hits. This is [measured], not [secondhand].)
 *
 *  🔴 `soniox` (H6/B15, owner 2026-08-02「soniox 可进开源仓，包括其它的主流服务
 *  商，但要明确会根据实际情况选择或智能路由，无法强指定」) is the first id whose
 *  IMPLEMENTATION is NOT in this repo's open half: it lives in the private
 *  `packages/stt-cloud` and is loaded by an optional dynamic require. The name
 *  being here is the whole point of ruling (a) — it keeps
 *  `defaultEngineFactory`'s `_exhaustive: never` check intact and makes a
 *  misconfigured self-host fail with a NAMED error instead of an anonymous
 *  unknown-id. **A self-hosted build will never construct it; that is intended
 *  (H3: self-hosted deployments only support local engines in the generic-API
 *  style), not a gap to fill.**
 *
 *  ⚠️ 「无法强指定」 is a PRODUCT constraint riding on this string: a managed user
 *  cannot demand a vendor — the pool picks. Do NOT surface `soniox` in the
 *  desktop/web engine dropdowns for managed sessions (card §-0, second half;
 *  「一个改变不了任何东西的控件比没有控件更坏」("a control that changes nothing is
 *  worse than no control")). */
export type SttEngineId =
  | 'funasr'
  | 'deepgram'
  | 'openai-realtime'
  | 'openai-whisper'
  | 'custom-openai-compatible'
  | 'funspeech-http'
  | 'sherpa-local'
  | 'soniox';

export type LlmProtocol = 'openai-compatible' | 'anthropic';

export type Locale = 'zh-CN' | 'en';

export interface TranscriptHistoryItem {
  id: string;
  pairing_id: string | null;
  pc_device_id: string;
  user_id: string;
  mobile_id: string | null;
  mode: Mode;
  source_text: string | null;
  source_lang: string | null;
  output_text: string;
  output_lang: string | null;
  duration_ms: number | null;
  segments_count: number;
  status: HistoryStatus;
  /** WP-R1-1: edit overlay, orthogonal to `status`. Absent/undefined = false
   *  (never edited). Set true once the user edits the text; `status` keeps
   *  recording the delivery outcome independently. */
  edited?: boolean;
  created_at: string;
  updated_at: string;
}

// V2.0 (A-49 / WP-1B F-3000): TimelineEntry extends TranscriptHistoryItem with
// nullable/defaulted fields only — old transcript_history rows keep their
// semantics unchanged (P-v2-4).
//
// `sync_state` ('local_only' | 'synced') is a CLIENT-LOCAL field ONLY and is
// intentionally NOT part of this interface's wire-adjacent shape — it MUST
// NEVER appear in a zod schema (ruling R-3, F-3016). Client code that needs it
// tracks it as a separate local-only property, never merged into this shared
// type.
// v2r2 batch1 (SPEC_AUDIT_LOG A-56 / F-3110): free-form, mode-specific
// reprocess parameters — e.g. { from: 'zh', to: 'en' } for translate,
// { style: 'bullets' } for organize. Serialized as JSON text at rest;
// structured on the wire and in memory.
export type ProcessParams = Record<string, string>;

/** v2r2 batch1 (F-3110 shape / F-3112 producer): injection provenance —
 *  the only durable copy of a foreground window title. Written at the moment
 *  an injection was acknowledged, onto the entry it applied to. */
export interface InjectTarget {
  /** full foreground window title at injection time */
  window_title: string;
  /** executable basename, platform extension stripped */
  process_name: string;
  /** ISO8601 UTC instant the injection was acknowledged */
  injected_at: string;
}

export interface TimelineEntry extends TranscriptHistoryItem {
  /** default 'transcript' */
  entry_type: 'transcript' | 'image';
  /** default 'paired'. WP-R0-1: `cloud` formally admitted (cloud-instance
   *  solo session, F-3140). */
  origin: 'paired' | 'standalone' | 'cloud';
  // `attachment_ref` ("image entry: local attachment id / cloud blob id") was
  // REMOVED on 2026-07-31 (0.2.27) together with the `transcript_history` column
  // of the same name. It was a field that answered NO question anywhere: zero
  // writers, zero readers, on either end, for the whole life of this line — the
  // image path that did ship carries a bounded inline `thumb_b64` instead
  // (HistoryItemSchema), and owner's 0.2.26 ruling keeps light-record pictures LOCAL,
  // so there is no cloud blob id to point at either. Re-add it only against a
  // real writer.
  /** producing-end label ("Pixel 8" / "DESKTOP-X") */
  device_label: string | null;
  /** default null; two-pass-refine status marker (ruling R-1, F-3017) */
  refined_at: number | null;
  // v2r2 batch1 (A-56 / F-3110): processing product + injection provenance.
  // All four default to null on every pre-v2r2 row, and `source_text`
  // (inherited from TranscriptHistoryItem) is WRITE-ONCE IMMUTABLE: no
  // reprocess, edit, refine or sync merge may rewrite it. Display resolves
  // `processed_text ?? source_text` — see resolveTimelineDisplayText in
  // timeline-payload.ts.
  /** translate/organize product; null = unprocessed (realtime) */
  processed_text: string | null;
  /** how `processed_text` was produced; null = realtime. Intentionally
   *  independent of `mode`, which records how the entry was produced. */
  process_mode: 'translate' | 'organize' | null;
  /** parameters of the last reprocess; null when never processed */
  process_params: ProcessParams | null;
  /** null until this entry has actually been injected (F-3112 writes it) */
  inject_target: InjectTarget | null;
}

// V2.0 (A-49 / WP-1B F-3001): the opaque E2EE envelope carried by
// timeline:push / timeline:pull-result. `ciphertext` MUST start with the
// 'e2e:v1:' prefix (F-3005/F-3008 redline) — the server never decrypts it.
export interface EncryptedBlob {
  id: string;
  /** per-user monotonic cursor */
  seq: number;
  /** opaque; MUST start 'e2e:v1:' */
  ciphertext: string;
  created_at: number;
  schema_ver: number;
  /** F-3034 (SPEC_AUDIT_LOG A-52): pull-direction only — true iff this row
   *  was tombstoned server-side; absent/undefined on ordinary rows and on
   *  every push-direction payload. `ciphertext` is left untouched either way. */
  deleted?: boolean;
}

export interface User {
  id: string;
  email: string | null;
  display_name: string;
  plan: Plan;
  locale: Locale;
  created_at: string;
}

export interface PcDevice {
  id: string;
  user_id: string;
  device_name: string;
  client_instance_id: string | null;
  device_token: string;
  room_uuid: string;
  short_code: string;
  is_online: boolean;
  last_seen_at: string | null;
  created_at: string;
}

// RV-36 (2026-07-31, 0.2.27): `PcRegisterAck` and `PcReconnectAck` were REMOVED.
//
// Both were bare interfaces with ZERO imports anywhere (server-core, desktop TS,
// web, this package) — the only mention was a comment in
// server-core/socket/handlers/pc.handler.ts claiming the acks "= PcRegisterAck /
// PcReconnectAck / PcListMobilesAck", which grep could not back (rule ④: for a
// comment saying 「之所以这么写，是因为某处要用」("it's written this way because
// somewhere needs it"), that 「某处」("somewhere") must be something grep can
// find). Because nothing imported
// them, the compiler never compared them to the frames pc.handler actually acks,
// and they had already drifted THREE times: `expires_in_ms` (GA-18),
// `connectedMobiles` (RV-08) and `schema_ver` were all added to the wire and to
// neither declaration.
//
// Deliberately NOT "fixed additively": a declaration whose truthfulness nothing
// verifies is a doc wearing a type's clothes — it would drift again on the next
// ack field, exactly as it did three times already. If a typed ack is ever
// wanted, the honest form is a zod schema that the emitter itself parses (so the
// compiler and a contract test both hold it to the wire), not a parallel
// interface. Today's live guard on these acks is pc.handler's own tests
// (machine-identity / pc-list-mobiles / pairing-reuse), which assert the REAL
// fields.

export interface MobilePairAck {
  pairing_id: string;
  mobile_token?: string;
  pc_id: string;
  pc_instance_id: string | null;
  pc_name: string;
  room_uuid: string;
  pc_online?: boolean;
}

export interface MobilePairing {
  id: string;
  user_id: string | null;
  pc_device_id: string;
  mobile_token: string;
  mobile_name: string;
  paired_at: string;
  last_seen_at: string | null;
}

export interface SttRouting {
  language: string;
  engine_id: SttEngineId;
  endpoint?: string;
  api_key?: string;
  model?: string;
}

export interface LlmConfig {
  protocol: LlmProtocol;
  endpoint: string;
  api_key: string;
  model: string;
}

export interface ProbeResult {
  ok: boolean;
  latency_ms: number;
  sample_output?: string;
  model_echoed?: string;
  error?: string;
}

export interface UsageRecord {
  user_id: string;
  month: string;
  stt_minutes: number;
  llm_tokens_in: number;
  llm_tokens_out: number;
  updated_at: string;
}
