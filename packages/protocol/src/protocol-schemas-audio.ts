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
import { PhonePrefsSchema } from './phone-prefs';
import { AudioStartRecoveryFieldsSchema, CoverageReceiptFieldsSchema } from './recovery-protocol';

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
  // Card RC-1 (2026-09-24, primary-owner ruling (A)): `true` = this is a LONG
  // RECORDING (continuous light-record transcription), not a held button.
  // Additive + optional. The relay honours it ONLY when it is exactly `true`
  // (`audio.handler.ts` → `SttStartArgs.continuous` → `engine-factory.ts`
  // `reconnectUnbounded`): the engine reconnect ladder then never gives up on
  // count (book 06 §2.3, 2026-08-29 addendum). Absent / false = push-to-talk,
  // i.e. an old phone keeps today's 3-rung ladder, which is the safe direction.
  // Deploy order: relay before APK (D-27); an old relay strips it silently.
  continuous: z.boolean().optional(),
  source_lang: NonEmpty,
  target_lang: NonEmpty.optional(),
  // 2026-09-03 (owner ruling, phone-owned preferences): the phone's card /
  // polish / refine / consent for THIS recording, carried in the request that
  // starts it. Additive + optional; absent = the phone carries no preferences
  // for this session (an old phone, or a phone that has none). Never stored.
  prefs: PhonePrefsSchema.optional(),
  // ── Cards CV-1 / PR-1 (04 SPEC 3.3-a (a)) — the eight recovery identifiers ──
  //
  // SPREAD, not re-declared: the one declaration lives in recovery-protocol.ts
  // beside the coverage receipt that echoes half of it, so the start frame and
  // the receipt cannot come to disagree about a field's type or its name.
  //
  // Every one is OPTIONAL and this schema stays NON-`.strict()` on purpose (see
  // that module's header, and E38 in the audit draft): an older relay strips
  // them SILENTLY rather than refusing the frame, so a phone cannot tell "the
  // server honoured my identifiers" from "the server never saw them" by the
  // outcome alone. The capability bits on the pair/reconnect acks are what makes
  // that difference observable; sending these fields is not a protocol
  // negotiation and must never be read as one.
  //
  // 🔴 `delivery` ABOVE IS UNTOUCHED. The recovery leg still has to say
  // `delivery:'none'` for itself; nothing here changes the `?? 'inject'` default
  // on either end.
  ...AudioStartRecoveryFieldsSchema.shape,
});
export const AudioChunkSchema       = z.object({ seq: z.number().int().nonnegative(), data_b64: NonEmpty, ts_ms: z.number().int() });
export const AudioPauseSchema       = z.object({ reason: NonEmpty });
export const AudioResumeSchema      = z.object({});
/**
 * 🔴 `discard` — "this recording was ABANDONED, do not finalise it"
 * (owner report 2026-08-28: swipe up to cancel, and the words arrived on the PC
 * anyway).
 *
 * Until this field, `audio:stop` was `z.object({})` and therefore answered TWO
 * questions with one frame — "I am done, transcribe it" and "throw it away" were
 * byte-identical on the wire. The server did the only thing it could: `finish()`
 * on both, which flushes a terminal `stt:final` and bills the utterance. That is
 * this repo's headline defect shape (one value, two questions) sitting on the
 * cancel path.
 *
 * OPTIONAL, and the default is the safe half: absent ⇒ `false` ⇒ finalise, which
 * is exactly what every already-shipped phone means when it sends this frame.
 * A required field would make every older client's release a schema violation.
 *
 * ⚠️ THE PHONE DOES NOT DEPEND ON THIS. zod strips unknown keys, so a phone that
 * sends `discard` to a relay predating it is silently read as a normal release —
 * which is why the phone ALSO drops the late transcript frames locally
 * (apps/mobile/lib/src/ptt/ptt_inbound.dart). This field saves the wasted STT
 * minutes and the pointless final; the client-side latch is what makes cancel
 * actually cancel. Failure direction, stated so it is not rediscovered: an out
 * of date relay costs minutes, it never leaks the cancelled words.
 */
export const AudioStopSchema        = z.object({ discard: z.boolean().optional() });
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
  // Card RC-2 (2026-09-24) — how far the relay has taken the sender's audio off
  // its hands, in the SENDER's clock (the same clock as this recording's
  // `audio:chunk.ts_ms`): the end of the latest audio received, minus what the
  // current engine leg was handed and the vendor has not yet reported processed.
  // The sender subtracts it from its own sent end to get the audio still in
  // transit or queued at the vendor, which is what a paced recovery feed bounds
  // (apps/mobile/lib/src/session/recovery_leg_wire.dart `_streamRange`).
  // ADDITIVE and OPTIONAL: absent whenever the engine reports no processed
  // position (every engine but Soniox today) and on every relay older than the
  // card, and the sender then falls back to a fixed block rate. Not a claim
  // about individual chunks: VAD-withheld silence counts as settled.
  // Producer: apps/server-core/src/stt/engine-backlog.ts.
  acked_audio_ms: z.number().int().nonnegative().optional(),
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
  // 2026-09-03 (owner ruling Q2 b, two-pass refine delivered for real): the
  // server-minted id of the utterance this terminal final closes. It is the
  // ONLY key a later `stt:refined` frame carries, so the phone can put the
  // second draft on the right row instead of "the newest row". Additive and
  // optional: an old relay strips it, the phone then has no id and DROPS the
  // refine rather than guessing (protocol-schemas-compose.ts, SttRefinedSchema).
  // Deliberately not `request_id`/`entry_id` — those are delivery ids the
  // phone mints for inject:request; this one names a recording.
  utterance_id: NonEmpty.optional(),
  // 2026-09-04 (card EMPTY-1) — WHY this final carries no text. ADDITIVE and
  // OPTIONAL: absent on every frame that has text, absent on every server that
  // predates the card, so an old relay stripping it leaves the phone exactly
  // where it was (its own local "no speech was heard" sentence).
  //
  // 🔴 IT IS NOT A SECOND ERROR CHANNEL. It is only ever set when NOTHING else
  // on this recording answered the question: an engine/network/auth/quota fault
  // already travels as `stt:error` with a registered code, and the server
  // deliberately leaves this field OFF in that case — two authors for one
  // question is the repo's #1 defect shape. It exists for the one cause no
  // registered code answers honestly: the gate accepted speech, the engine
  // finished cleanly, and it returned no words.
  //
  // 🔴 A PERMISSIVE STRING, not an enum, for the same reason `polish_reason`
  // is: additive-field forward-compat means a receiver must never reject a
  // future value. The canonical domain (`'no_voice' | 'heard_no_words'`) is
  // enforced by the SERVER's wire mapping (`stt/empty-final-cause.ts`), and the
  // phone renders an unrecognised value as its generic sentence plus the bare
  // token rather than inventing a sentence for it (0.2.53 rule).
  empty_reason: z.string().optional(),
  // ── Card CR-12-D (04 SPEC §3.3-a (d)) — the silence before this segment ────
  //
  // ADDITIVE and OPTIONAL: no new event, no new error code, the whitelist and
  // both count guards untouched. Semantics: ms between the last word of the
  // PREVIOUS segment and the first word of this one.
  //
  // 🔴 ABSENCE IS A THIRD ANSWER, NOT 0. It is absent on segment 0 (nothing came
  // before), on every engine that reports no word timestamps (today everything
  // but Soniox), on a segment that crossed an engine reconnect, and on any
  // server predating the card. A consumer that reads absence as 「no pause」 has
  // turned 「我不知道」 into a claim; the phone degrades to its punctuation rule
  // instead (`apps/mobile/lib/src/timeline/…`, card CR-12-A).
  //
  // 🔴 IT IS THE WALL-CLOCK PAUSE (primary-owner ruling 2026-09-23, replacing
  // this comment's first version, which said "measured in the audio the engine
  // was given" — that was the defect). Two disjoint parts: the silence the
  // engine heard between the two words, plus the silence the VAD gate withheld
  // from it. Each chunk is classified once, so no chunk is in both. The
  // arithmetic, and the two corners it still cannot measure, are on the server
  // at `apps/server-core/src/stt/segment-pause.ts`.
  pause_before_ms: z.number().int().nonnegative().optional(),
  // ── Card CV-1 (04 SPEC 3.3-a (b)) — the versioned coverage receipt ──────────
  //
  // Additive + optional, spread from recovery-protocol.ts, and populated ONLY on
  // the terminal final (`is_segment:false`) — engine/stt-session.ts owns that
  // condition, because a soft-segment final is a boundary inside a recording and
  // not a statement about one.
  //
  // 🔴 NOT A NEW EVENT, deliberately. `stt:final` is already the frame that says
  // "this recording is over"; a sibling event would mean the two could arrive in
  // either order, or one without the other, and every consumer would then need a
  // rule for that. The whitelist and count guard are untouched.
  //
  // 🔴 WHAT IT LICENSES IS NARROW. These counters do not prove the audio was
  // understood, and no counter can (audit A5-4). The 2026-09-06 ruling lets them
  // gate exactly one action — automatic deletion of the local copy — and only
  // together with `ended_normally` and a persisted, read-back result row.
  ...CoverageReceiptFieldsSchema.shape,
});
// WP-9 (2026-09-02, findings-crossend-quota.md #3) — `judged_account` is
// ADDITIVE and OPTIONAL. Card QTA-2 (audio.handler.ts refuseStart) checks two
// account ledgers for a `QUOTA_EXCEEDED` refusal — the acting phone's own, and
// (for a delivery that targets a PC) that PC's owner's — and until this field
// existed the server judged both but told the phone which one only in a log
// line nobody on the phone can read. A phone signed into account A, paired to
// a PC signed into account B whose month is spent, was told the generic
// 「the monthly transcription quota is used up」 sentence, which reads as
// THIS PHONE'S OWN quota — a false claim whenever the two accounts differ.
// `'self'` | `'pc_owner'` names which ledger was actually hit; absent (old
// server, or any code other than QUOTA_EXCEEDED) is read by the phone as
// `'self'`, i.e. byte-identical to pre-existing behaviour.
export const SttErrorSchema         = z.object({
  code: NonEmpty,
  message: NonEmpty,
  retryable: z.boolean(),
  judged_account: z.enum(['self', 'pc_owner']).optional(),
  // Card RC4-S5 (2026-09-25, book 04 `stt:error` row) — ADDITIVE and OPTIONAL, sent only with
  // STT_SEGMENT_NOT_TRANSCRIBED: where the stretch no engine leg heard BEGINS, on the sender's audio
  // clock (`audio:chunk.ts_ms`, the clock `stt:interim.acked_audio_ms` answers in). A start, never a
  // length. Producer: apps/server-core/src/stt/owed-voice-verdict.ts; the one reader: the phone's long
  // recording (apps/mobile/lib/src/ptt/ptt_unheard_tail.dart), which owes the recording's tail from there.
  // Absent ⇔ an older relay, or the relay's ring no longer holds that chunk.
  unheard_from_ms: z.number().int().nonnegative().optional(),
});
// NR-38 — `loading` is the FOURTH value (2026-09-14), and the only one that is
// emitted BEFORE the engine exists. A local model engine (`sherpa-local`) spends
// 1.9 s (SenseVoice, 229 MB) to 8 s (whisper-turbo, 1.03 GB) reading and building
// its recogniser on the very first press, and until this value existed the wire
// had no way to say so: the first frame a user could ever see was `ready`, after
// the wait. The producer is the orchestrator's COLD OPEN only
// (`stt/orchestrator-core.ts spawnEngine(coldOpen)`, gated on
// `isLocalModelEngine`), so every `loading` is followed by exactly one `ready`
// or one `failed` — a rollover / silence redial / ladder rung does NOT emit it,
// because those have no `ready` to close them and would strand the state.
//
// 🔴 ADDITIVE, and the argument is the FAILURE DIRECTION, not a promise:
// every shipped consumer already reads this field as a closed match with a
// default arm that DROPS the frame rather than throwing — desktop capsule
// `controller.ts onEngineStatus` (explicit `===` triple before it writes),
// desktop Rust `socket/fanout.rs on_forward` (forwards the payload verbatim as
// `serde_json::Value`, never parses the enum), phone
// `lib/src/session/local_engine_status.dart observeFrame` (`_ => null` then
// `return`). An un-updated end therefore behaves EXACTLY as it does today:
// silent during the cold seconds. Nothing can refuse the frame ⇒ no deployment
// order. No event name is added, so the 57-name whitelist and its count guard
// do not move (asserted in `test/engine-status-loading.test.ts`).
//
// NR-96 (2026-09-24) — three ADDITIVE optional fields, the retry budget of the
// relay's engine reconnect ladder, so a client can say "attempt n of N" and run
// a local watchdog computed from facts on the frame (book 15 §2.7 law 3; book
// 04 §3 row). One value, one question each:
//   · `retry_max`          — how many attempts this outage gets IN TOTAL;
//                            ABSENT = unbounded (never "unknown old relay":
//                            the client's action is the same either way).
//   · `retry_in_ms`        — the wait after this frame before the next attempt
//                            STARTS.
//   · `attempt_timeout_ms` — how long that attempt may take before it counts as
//                            failed (true only because the rung's spawn is now
//                            raced against the spawn cap, engine-session.ts).
// Only the producer's `reconnecting` frames carry them (pinned by
// apps/server-core/test/engine-reconnect-progress.test.ts, not by this schema).
// No absolute deadline on purpose: two clocks never compare (book 06 §2.3 M3-4b).
// Failure direction is the one argued above: z.object strips unknown keys and
// every consumer ignores keys it does not read, so an old relay drops the three
// fields (client shows n only, no watchdog) and an old client ignores them.
// Card RC-3b (2026-09-24) — one more additive field, on a DIFFERENT frame:
//   · `replayed_ms` — on the `ready` that ENDS a reconnect only: the audio
//                     milliseconds the relay re-fed from its retention ring to
//                     the new leg (`engine-session.ts attemptReconnect`, read
//                     from what `replayBufferTail` actually handed over). The
//                     phone subtracts it from what it captured during the
//                     outage; the rest no engine heard. Absent (old relay, cold
//                     open, any other `ready`) ⇒ the phone accounts nothing.
//                     Pinned by apps/server-core/test/engine-ready-replayed-ms.test.ts.
export const SttEngineStatusSchema  = z.object({
  provider: NonEmpty,
  status: z.enum(['loading', 'ready', 'reconnecting', 'failed']),
  retry_count: z.number().int().nonnegative().optional(),
  retry_max: z.number().int().min(1).optional(),
  retry_in_ms: z.number().int().nonnegative().optional(),
  attempt_timeout_ms: z.number().int().min(1).optional(),
  replayed_ms: z.number().int().nonnegative().optional(),
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
