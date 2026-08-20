// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (authentication / pairing),
//     §3.2 (heartbeat / liveness)
//   docs/decisions/2026-07-23-wp-r0-1-protocol-rename-window.md
//   F-701 (no unknown events), F-702 (zod schemas for every event payload)
//
// One module per protocol domain to stay under the file-size cap (F-801) —
// same pattern as protocol-schemas-timeline.ts. The AUTH_EVENT_SCHEMAS
// sub-map below is spread into EVENT_SCHEMAS by protocol-schemas.ts, which
// also re-exports every symbol here, so the public @flowmic/protocol surface
// is unchanged.
//
// WP-R0-1 rename window: the §3.2 liveness probe was renamed to
// `sys:ping`/`sys:pong` (payloads unchanged; old→new in the decision log).

import { z } from 'zod';
import { ClientInstanceId, DeviceUid, NonEmpty, Token } from './protocol-primitives';

export const PC_DEVICE_NAME_MAX_LENGTH = 80;
export const PcDeviceNameSchema = z.string().trim().min(1).max(PC_DEVICE_NAME_MAX_LENGTH);
export const PcNameValueSchema = z.object({ pc_name: PcDeviceNameSchema });
// ─── §3.1 authentication / pairing ─────────────────────────────────────
// v0.2.4 — `machine_uid` rides beside `client_instance_id` on BOTH, additively.
// Both are needed and they answer different questions: the instance id says
// 「which connection slot is this」 (per channel, and the phone keys its stored
// pairings on it), the machine uid says 「which physical machine is this」 (the
// same value on every channel). See protocol-primitives.ts DeviceUid for why
// collapsing them would break token_storage.
export const PcRegisterSchema       = z.object({
  device_name: PcDeviceNameSchema,
  setup_key: NonEmpty.optional(),
  client_instance_id: ClientInstanceId.optional(),
  machine_uid: DeviceUid,
});
export const PcReconnectSchema      = z.object({
  token: Token,
  client_instance_id: ClientInstanceId.optional(),
  machine_uid: DeviceUid,
});
export const PcRefreshCodeSchema    = z.object({});
// GA-08: the PC-initiated end of a phone's access, in TWO distinct meanings that
// share ONE wire name (additive optional field — EVENT_NAMES / the count guard
// are untouched, and an old client that never sends `revoke` keeps the exact
// pre-GA-08 behaviour):
//   · `revoke` absent/false → 「断开」("disconnect"): end THIS session (server
//     disconnects the socket and holds a short reconnect-suppression window on
//     the pairing);
//   · `revoke: true`        → 「撤销」("revoke"): PERMANENT — the
//     mobile_pairings row is deleted (05 §7「删行即吊销」("deleting the row is
//     what revokes it")), which is what makes the mobile_token dead.
// A revoke MUST name its `mobile_id`: 「撤销全部」("revoke all") is not a thing
// this wire offers, so a missing id can never be read as「revoke everything」.
// GA-29 adds a THIRD meaning on the same wire name, again additively:
//   · `reason:'busy'` → 「胶囊已被另一台手机占用」("the capsule is already
//     occupied by another phone"). The PC keeps both channels resident (07 §6)
//     and is the ONLY place that can see both at once, so it is the only place
//     that can refuse a second phone. This is NOT an operator action: nothing is
//     wrong with the pairing, the machine is merely occupied, so the server
//     holds a SECONDS-long window (BUSY_SUPPRESS_MS) instead of the minute a
//     deliberate disconnect earns — otherwise the moment the first phone
//     leaves, the second would still be locked out.
// Absent `reason` = 'manual', i.e. exactly the pre-GA-29 behaviour, so an older
// desktop keeps its semantics with no version negotiation.
export const PcReleaseMobileSchema  = z.object({
  mobile_id: NonEmpty.optional(),
  revoke: z.boolean().optional(),
  reason: z.enum(['manual', 'busy']).optional(),
});
// R6 T-8: PC → server query for THIS PC's paired mobiles (the device page's
// 「已配对手机」("paired phones") table). Empty payload — the PC's identity IS
// the scope; the
// server resolves the pairing rows from the socket's own pc_devices row and
// never from a client-supplied id, so there is nothing to address and nothing
// to spoof (the mirror image of MobileListPcsSchema).
export const PcListMobilesSchema    = z.object({});
// The PUBLIC projection of one mobile_pairings row (the `pc:list-mobiles` ack).
// ZERO-SECRET BY CONSTRUCTION: `mobile_token` has no field here and must never
// gain one — same discipline as the REST /api/cloud/devices projection. A zod
// object strips unknown keys on parse, so even a caller that hands a whole
// MobileRecord to this schema gets a token-free object back.
// `online` is REAL room presence (the server's live RoomStore), never a stored
// flag replayed as if it were live.
// v0.2.4 `device_uid`: the handset behind this row, so the desktop's
// paired-phones table can say 「这两条是同一台手机的两条通道」("these two rows
// are two channels of the same phone") instead of showing two identical-looking
// rows the user has to guess about. NULLABLE and OPTIONAL — a row paired by a
// pre-0.2.4 phone has no uid, and rendering those as 「同一台」("the same
// device") because they both read `null` would be a fabrication, so the
// desktop groups only on a PRESENT value.
export const PcPairedMobileSchema   = z.object({
  pairing_id: NonEmpty,
  mobile_name: NonEmpty,
  paired_at: z.string(),
  last_seen_at: z.string().nullable(),
  online: z.boolean(),
  device_uid: z.string().nullable().optional(),
});
export const PcListMobilesAckSchema = z.object({ mobiles: z.array(PcPairedMobileSchema) });
export type PcPairedMobile = z.infer<typeof PcPairedMobileSchema>;
export const PcMobileJoinedSchema   = z.object({ mobile_id: NonEmpty, mobile_name: NonEmpty, room_uuid: NonEmpty.optional() });
export const PcMobileLeftSchema     = z.object({ mobile_id: NonEmpty });
// F-3140 (design §5.2): a third admission variant for the fixed 「云端实例」
// ("cloud instance") solo session — no pair code, no PC peer. The server
// resolves the account identity (saas JWT / standalone 'default'),
// find-or-creates the per-user virtual cloud-instance PC device + a mobile
// pairing, and admits a solo session over the SAME whitelisted `mobile:pair`
// event (additive union member — EVENT_NAMES is unchanged, no new socket
// event).
// owner 2026-07-27:「获取手机型号再结合唯一码来作为名称，这样从名称就可以区分手机
// 是哪一台」("take the phone model and combine it with a unique code to form
// the name, so the name alone tells you which phone it is"). `mobile_name` is
// ADDITIVE and OPTIONAL on every admission variant — no new event, EVENT_NAMES
// and the count guard are untouched, and a client that sends nothing still
// gets the server's `Phone-<4>` fallback exactly as before.
//
// It closes a real façade: registry.pairMobile has always preferred a
// caller-supplied name ("A name the phone sends itself still wins"), but the
// handler only ever passed short_code/qr_payload, so that branch was dead code
// and every phone came out as an interchangeable `Phone-xxxx`.
//
// Capped and non-empty at the boundary: this string lands in a DB column and is
// rendered in three device lists, so an unbounded one is a display hazard, not
// just a big row. The phone builds it as 「型号-<4 位设备指纹>」("model-<4-digit
// device fingerprint>") — see mobile/lib/src/session/device_label.dart for why
// the suffix is a HASH.
//
// v0.2.4 `device_uid` rides in the SAME additive slot, on all three variants.
// The name was doing double duty as an identity — v0.2.3 keyed the
// reuse-this-row lookup on it, because 「型号-<4 位 ANDROID_ID 哈希>」
// ("model-<4-digit ANDROID_ID hash>") was the only stable thing a phone sent.
// That works but is fragile: a name is for
// people to read and may legitimately change, while a match key must not. The
// uid separates the two jobs, and the name match stays as the fallback for
// phones that predate this field.
const MobileNameField = {
  mobile_name: NonEmpty.max(48).optional(),
  device_uid: DeviceUid,
};
// ── 0.2.66 · `pcid`, the addressing half of a cloud pairing ──────────────────
// (owner 2026-08-14; docs/decisions/2026-08-14-owner-cloud-pairing-requires-pcid.md,
//  design docs/strategy/2026-08-14-0266-cloud-pcid-pairing-design.md)
//
// 9 decimal digits, minted server-side per pc_devices row, PUBLIC (it is printed
// on the PC's pairing dialog). It answers 「WHICH PC」; the 4-digit short code
// still answers 「what is the secret」. Before this field the code answered both,
// and on the multi-tenant relay `listByShortCode` is a flat 10^4 namespace, so a
// guessed code landed the guesser on whichever tenant was pairing right then.
//
// WHY IT IS OPTIONAL HERE AND MANDATORY IN THE SERVER. Making it required in the
// schema would push the refusal to the zod boundary, and a boundary rejection is
// ANONYMOUS and SILENT — the phone would get a shapeless parse failure instead of
// `PAIR_PCID_REQUIRED`, which is the one refusal on this path a user can act on.
// Same reasoning, verbatim, as `target_pc_id` in 0.2.33 (INJECT_PC_UNSPECIFIED):
// enforce in the handler where you can still say WHY. The saas gate lives in
// apps/server-core/src/room/registry.ts `resolvePcForPair`; standalone ignores
// the field entirely (there is no PCID on the LAN).
//
// ONLY ON THE SHORT-CODE ARM. The qr arm carries its pcid INSIDE `qr_payload`
// (`&pcid=` appended after `code=`, 04 §3.1) — the server parses one string there
// and both arms then take the identical path, which is what owner's 「扫码与手输
// 是同一逻辑」("scanning the code and typing it by hand are the same logic")
// means in code. The cloud_instance arm addresses no PC at all.
const PcidField = { pcid: z.string().regex(/^\d{9}$/).optional() };
export const MobilePairSchema       = z.union([
  z.object({ short_code: z.string().regex(/^\d{4}$/), ...PcidField, ...MobileNameField }),
  z.object({ qr_payload: NonEmpty, ...MobileNameField }),
  z.object({ cloud_instance: z.literal(true), ...MobileNameField }),
]);
// The uid on RECONNECT is how a pairing made by an older build gets stamped:
// the row already exists and is found by token, so this only ever fills a NULL.
export const MobileReconnectSchema  = z.object({ token: Token, device_uid: DeviceUid });
// ── SEG-1 · the audio half of the `mobile:reconnect` ACK ─────────────────────
// (docs/strategy/2026-08-11-unified-transcription-session-design.md §2-R5)
//
// `audio_last_contiguous_seq` — the last audio-chunk seq this server has
// CONTIGUOUSLY observed for the pairing's live recording session (active, or
// still inside its mobile-drop grace window). The value is
// SeqTracker.lastContiguousSeq (apps/server-core/src/stt/audio/seq-tracker.ts),
// read through AudioSessionRegistry.peekLastContiguousSeq — a read-only peek
// that never resumes, rebinds or touches grace timers.
//
//   · PRODUCER — the mobile:reconnect accept path in
//     apps/server-core/src/socket/handlers/mobile.handler.ts, right after
//     adoptAudioSession.
//   · CONSUMER — the phone's reconnect ring-replay trim (card SEG-2,
//     apps/mobile/lib/src/signaling/reconnect.dart: the ack watermark becomes
//     bufferedChunkPayloads' cutoff, 「seq ≤ 水位的不再发」("anything at or
//     below the watermark is not sent again")). Until SEG-2 lands the phone
//     reads the ack as plain JSON and ignores unknown keys, which is
//     byte-for-byte the field-absent behaviour below.
//
// ABSENCE IS THE NO-SESSION SIGNAL. When the device has no live/grace-held
// audio session the field is OMITTED — never null, never a -1 sentinel. `-1`
// is a legal VALUE and means exactly one thing: 「the session exists and has
// observed zero chunks yet」 (SeqTracker starts at -1), hence `.min(-1)`.
//
// FAILURE DIRECTION (same construction as inject_origin's 「无标记判 live」
// ("no marker ⇒ judge it live"), protocol-schemas-inject.ts): a
// missing/stripped/malformed field degrades the
// phone to today's full 30 s ring replay, deduped server-side by
// SeqTracker.hasObserved — worst case is DUPLICATION, never loss. That is why
// this is an additive OPTIONAL field: an old relay that strips it, or an old
// server that never sends it, produces exactly the current product.
//
// The event whitelist (54) and the count guard are untouched — this is a
// payload field on an ack, not an event name (precedent: polish/polish_reason
// on stt:final, protocol-schemas-audio.ts).
//
// WHY a partial fields-schema and not a full MobileReconnectAck schema: the
// base ack (pairing_id … pc_online) is emitted as a literal in
// mobile.handler.ts, and a parallel full-ack declaration nothing verifies is
// the RV-36 drift trap (see types.ts). THIS declaration is verified on both
// sides: the emitter types its spread as `MobileReconnectAckAudioFields`, so
// the compiler holds the handler to it, and the protocol round-trip test
// exercises the schema itself (test/mobile-reconnect-ack-audio.test.ts).
export const MobileReconnectAckAudioFieldsSchema = z.object({
  audio_last_contiguous_seq: z.number().int().min(-1).optional(),
});
export type MobileReconnectAckAudioFields = z.infer<typeof MobileReconnectAckAudioFieldsSchema>;
/** v0.2.3 — the phone RETIRES its own pairing (owner 2026-07-29).
 *
 *  Deleting an entry on the phone used to drop the local token and nothing else,
 *  so the server's `mobile_pairings` row lived forever: the PC's device page kept
 *  listing phones the user believed they had removed, and there was no verb in
 *  the whole protocol that could remove one. 「删了没删掉」("deleted but not
 *  actually deleted") was literally true.
 *
 *  Carries NO id. The socket is already authenticated by this pairing's token, so
 *  the row to delete is the caller's OWN — a payload id would be an authorization
 *  question ("may I delete THAT one?") that this event deliberately does not open. */
export const MobileUnpairSchema     = z.object({});
export const MobileRoleSchema       = z.enum(['active', 'observer']);
export const MobileSessionAckFieldsSchema = z.object({
  role: MobileRoleSchema,
  pc_busy: z.boolean(),
  on_transcription_screen: z.boolean(),
});
export const MobileListPcsSchema    = z.object({});
// MobileSwitchPcSchema was deleted with the `mobile:switch-pc` event on
// 2026-07-31 (stage-5 cleanup). Switching PCs really is a disconnect/reconnect
// through the connection page — there was never an emitter or a handler.
// GA-31 QR-code login — a SECOND way to present the same thing (an account
// identity), modelled the way `mobile:pair` already models its three entries: a
// union on one event name, so EVENT_NAMES and the count guard are untouched.
//   · {email, password} → the typed credential (unchanged, byte-for-byte);
//   · {qr_nonce}        → a one-time grant the ALREADY-SIGNED-IN web console drew
//     as a QR (auth/qr-grant.ts: 60 s, single use, 128-bit CSPRNG).
// A union, not an optional field: an object carrying BOTH must not parse, or the
// server would have to decide which credential wins — and「哪个赢」("which one
// wins") is exactly the kind of question an auth path must never have to
// answer.
export const MobileLoginSchema      = z.union([
  z.object({ email: z.string().email(), password: z.string().min(1) }).strict(),
  z.object({ qr_nonce: NonEmpty }).strict(),
]);
export const MobileLogoutSchema     = z.object({});
/// owner 2026-08-20 — server → THIS mobile, emitted immediately before the
/// socket is closed by a person pressing 断开/取消配对 on the PC.
///
/// `retry_after_ms` is the SAME budget the server already puts on a
/// `PAIR_RELEASED` refusal (`ReleaseSuppression`), carried here so the phone can
/// show the countdown without having to dial in and be refused first — which is
/// precisely the dial the ruling forbids.
///
/// 🔴 `revoked` is NOT `retry_after_ms === 0`, and that is why it is its own
/// field. 「取消配对」deletes the row, so there is no window and no coming back
/// without a fresh pairing; 「断开」has a window that expires. Both would arrive
/// here as a zero-ish budget and mean opposite things to the person holding the
/// phone — one waits a minute, the other has to scan a code again. A single
/// number answering both is this repo's headline bug shape, so it does not.
export const MobileReleasedSchema   = z.object({
  retry_after_ms: z.number().int().nonnegative().optional(),
  revoked: z.boolean().optional(),
});
export const AuthExpiredSchema      = z.object({});

// ─── §3.2 heartbeat / liveness ────────────────────────────────────────
export const HeartbeatSchema        = z.object({ ts: z.number().int() });
// WP-R0-1: renamed from HealthPingSchema/HealthPongSchema — payload shape is
// unchanged.
export const SysPingSchema          = z.object({ nonce: NonEmpty });
export const SysPongSchema          = z.object({ nonce: NonEmpty, ok: z.boolean() });

// Sub-map spread into protocol-schemas.ts's EVENT_SCHEMAS registry so that
// file only needs one spread line per split-out module.
export const AUTH_EVENT_SCHEMAS = {
  // §3.1
  'pc:register':           PcRegisterSchema,
  'pc:reconnect':          PcReconnectSchema,
  'pc:refresh-code':       PcRefreshCodeSchema,
  'pc:release-mobile':     PcReleaseMobileSchema,
  'pc:list-mobiles':       PcListMobilesSchema,
  'pc:mobile-joined':      PcMobileJoinedSchema,
  'pc:mobile-left':        PcMobileLeftSchema,
  'mobile:pair':           MobilePairSchema,
  'mobile:reconnect':      MobileReconnectSchema,
  'mobile:unpair':         MobileUnpairSchema,
  'mobile:list-pcs':       MobileListPcsSchema,
  'mobile:login':          MobileLoginSchema,
  'mobile:logout':         MobileLogoutSchema,
  'mobile:released':       MobileReleasedSchema,
  'auth:expired':          AuthExpiredSchema,
  // §3.2
  'heartbeat':             HeartbeatSchema,
  'sys:ping':              SysPingSchema,
  'sys:pong':              SysPongSchema,
} as const;
