// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3 (audio / STT)
//   docs/decisions/2026-07-23-wp-r0-1-protocol-rename-window.md
//   F-701 (no unknown events), F-702 (zod schemas for every event payload)
//
// One module per protocol domain to stay under the file-size cap (F-801). The
// AUDIO_EVENT_SCHEMAS sub-map below is spread into EVENT_SCHEMAS by
// protocol-schemas.ts, which also re-exports every symbol here, so the public
// @flowmic/protocol surface is unchanged. ProcessingModeSchema / ModeSchema
// are declared here (their §3.3 home) and imported by the §3.5 inject and §3.6
// history modules.
//
// WP-R0-1 rename window: the three modes are LOCKED to realtime|translate|
// organize. The legacy history-only mode values `draft`/`typing` were deleted
// from ModeSchema — it is now identical to ProcessingModeSchema (both symbols
// are retained for call-site compatibility; there is no fourth mode, ever).
//
// WP-R3.5 cleanup: ModeSchema was a SEPARATE `z.enum([...])` literal with the
// exact same three members — a duplicated source of truth that could silently
// drift on a future edit. It is now a direct ALIAS of ProcessingModeSchema, so
// the enum is declared once. The wire shape is provably unchanged (same object
// identity → identical parse/serialize; proven by test/mode-schema-merge.test.ts)
// and the 55-event whitelist is untouched (these are payload-field schemas, not
// event names). §3.6 history/inject modules keep importing `ModeSchema`.

import { z } from 'zod';
import { NonEmpty } from './protocol-primitives';

// ─── §3.3 audio / STT ─────────────────────────────────────────────────
export const ProcessingModeSchema   = z.enum(['realtime', 'translate', 'organize']);
/** @deprecated alias of {@link ProcessingModeSchema} — retained only because the
 *  §3.6 history modules import it by this name. Single source of truth is above. */
export const ModeSchema             = ProcessingModeSchema;
export const SendPolicySchema       = z.enum(['manual', 'direct']);
export const AudioStartSchema       = z.object({
  sample_rate: z.literal(16_000),
  channels: z.literal(1),
  encoding: z.literal('pcm_s16le'),
  mode: ProcessingModeSchema,
  // Omission means direct for compatibility with pre-F-2361 clients.
  send_policy: SendPolicySchema.optional(),
  // WP-R1-1 (master-plan §4.0 B/C): destination intent, FIXED here at
  // audio:start and immutable for the whole utterance. Additive + optional;
  // omission = 'inject' (every v1 audio:start with no delivery still parses).
  // 'none' = record-only: the server does NOT initiate injection and the PC
  // capsule does NOT surface. Corrected 2026-07-31 (0.2.27): this used to read
  // "does not join room sync BY DEFAULT (opt-in via the device-local
  // `flowmic.timeline.sync.noted` setting)" — there is no room sync for
  // transcripts any more and no such setting, so both halves had stopped being
  // true. It NEVER joins any server-side store, unconditionally. The entry can
  // still be delivered later by an explicit re-send (补投 rides inject:request
  // with the owner's own text) — delivery is per-utterance fixed, but the
  // timeline entry is always injectable after the fact.
  delivery: z.enum(['inject', 'none']).optional(),
  source_lang: NonEmpty,
  target_lang: NonEmpty.optional(),
});
export const AudioChunkSchema       = z.object({ seq: z.number().int().nonnegative(), data_b64: NonEmpty, ts_ms: z.number().int() });
export const AudioPauseSchema       = z.object({ reason: NonEmpty });
export const AudioResumeSchema      = z.object({});
export const AudioStopSchema        = z.object({});
// ── 🔴 `quota_exhausted` — the fifth `reason` (owner 2026-08-10 批准) ──────────
//
// Ruling group #5-a, docs/decisions/2026-08-10-owner-ruling-requests-from-lan-
// window.md. `engine/stt-session.ts` `onAutoStopped` hard-codes
// `reason:'hard_limit'` and discards the `limit_origin` the orchestrator already
// computed (`stt/audio/session.ts` `HardLimitOrigin` = 'engine_session' |
// 'quota_budget'). Once N1-B4 is live the five-minute wall becomes an
// engine-session ROLLOVER the user never sees, so quota exhaustion is the ONLY
// remaining auto-stop trigger — while the phone still says 「录音已达 5 分钟上限」
// in four languages. Card fix-020 carries the real origin through; this card only
// makes a truthful value EXIST for it to carry.
//
// 🔴 WHY NOT KEEP BORROWING `hard_limit`: that borrow IS the defect (ledger W8-4).
// The two send the user to different places — a time ceiling means 「再按一次接着
// 说」, an exhausted budget means 「这个月的额度用完了」 — and no wording of one
// covers the other. `hard_limit` stays exactly what it is and remains correct for
// a real time ceiling; nothing is redefined here.
//
// ⚠️ IT IS A **REASON**, NOT AN ORIGIN, AND THE NAME IS DELIBERATELY NOT
// `quota_budget`. `HardLimitOrigin` answers 「这个上限是哪来的」 (which ceiling was
// being enforced); this field answers 「录音为什么停了」. Naming them the same word
// would make one value answer two questions in two files. fix-020 therefore MAPS
// origin → reason, and mapping an unknown or future origin onto ANY existing
// value is forbidden by that card in these same words.
//
// ⚠️ THIS IS THE ONE PART OF THE 2026-08-10 REGISTRATION THAT IS NOT PURELY
// ADDITIVE ON THE WIRE, and saying so is the point — the four error codes ride
// `NonEmpty` string fields, but `reason` is a CLOSED `z.enum`, so anything still
// validating a frame against the OLD schema would reject the new value. The seams
// were measured rather than assumed: this schema is reachable only through
// `AUDIO_EVENT_SCHEMAS` → `EVENT_SCHEMAS`; `audio:auto-stopped` travels SERVER →
// MOBILE; `apps/server-core/src` contains no reference to `EVENT_SCHEMAS` at all
// (it never re-validates its own outbound frames), and the phone reads the payload
// as plain JSON in `apps/mobile/lib/src/ptt/ptt_session.dart`, which does not read
// `reason` today. ⇒ no receiver can reject it and no relay redeploy is implied BY
// THE VALUE. What does need a deploy is the EMITTER, and that is fix-020's.
//
// ⚠️ The event whitelist is untouched (54) — this is a payload FIELD, not an event
// name, the same statement the `polish` field makes below.
export const AudioAutoStoppedSchema = z.object({ reason: z.enum(['hard_limit', 'mobile_disconnect', 'engine_failed', 'auth_expired', 'quota_exhausted']) });
// AudioHeartbeatSchema / AudioResendRequestSchema were deleted with their two
// events on 2026-07-31 (stage-5, the E2 single-leg ruling). Both halves of the
// gap-replay loop were façades pointing at each other: the mobile emitted
// audio:heartbeat every 5 s to nobody, and it held a full audio:resend-request
// handler the server has never triggered. Chunk recovery is genuinely covered by
// the shipped path — full 30 s ring replay on every reconnect (mobile
// signaling/reconnect.dart) + SeqTracker.hasObserved() dedupe on the server —
// so nothing that WORKS was removed. Liveness keeps riding plain `heartbeat`,
// which is on the same 5 s timer and does have a handler.

export const SttInterimSchema       = z.object({
  text: z.string(),
  confidence: z.number().min(0).max(1),
  language: NonEmpty,
  segment_idx: z.number().int().nonnegative(),
});
export const SttFinalSchema         = z.object({
  text: z.string(),
  confidence: z.number().min(0).max(1),
  language: NonEmpty,
  segment_idx: z.number().int().nonnegative(),
  is_segment: z.boolean(),
  duration_ms: z.number().int().nonnegative(),
  // WP-R4-6 ②: additive honest-signal for the opt-in stt.polish LLM layer.
  // ABSENCE ⇔ polish not enabled this session (legacy clients zero-impact). No new
  // event / no new error code — the 55-event whitelist + count guards are untouched
  // (these are payload FIELDS, not event names). `polish` is a closed applied|
  // skipped set. `polish_reason` is a PERMISSIVE string, not an enum, on purpose:
  // additive-field forward-compat (CLAUDE.md 协议演进 additive-field 优先) means a
  // receiver must never reject a future reason value — the canonical 4-value domain
  // ('timeout'|'llm_error'|'empty_output'|'guard_reject', carried only alongside
  // polish:'skipped') is enforced by the SERVER's wire mapping, not the schema.
  polish: z.enum(['applied', 'skipped']).optional(),
  polish_reason: z.string().optional(),
});
export const SttErrorSchema         = z.object({ code: NonEmpty, message: NonEmpty, retryable: z.boolean() });
export const SttEngineStatusSchema  = z.object({
  provider: NonEmpty,
  status: z.enum(['ready', 'reconnecting', 'failed']),
  retry_count: z.number().int().nonnegative().optional(),
});
// stt:level is RETAINED (WP-R0-1): the mobile amplitude meter still consumes
// it. The PC capsule dropped waveform rendering (A-30) but the event lives on.
export const SttLevelSchema         = z.object({ amplitude_db: z.number() });

// Sub-map spread into protocol-schemas.ts's EVENT_SCHEMAS registry so that
// file only needs one spread line per split-out module.
export const AUDIO_EVENT_SCHEMAS = {
  // §3.3
  'audio:start':           AudioStartSchema,
  'audio:chunk':           AudioChunkSchema,
  'audio:pause':           AudioPauseSchema,
  'audio:resume':          AudioResumeSchema,
  'audio:stop':            AudioStopSchema,
  'audio:auto-stopped':    AudioAutoStoppedSchema,
  'stt:interim':           SttInterimSchema,
  'stt:final':             SttFinalSchema,
  'stt:error':             SttErrorSchema,
  'stt:engine-status':     SttEngineStatusSchema,
  'stt:level':             SttLevelSchema,
} as const;
