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

// ── card S2-01 · WHICH KIND OF CLIENT IS AT THE OTHER END ────────────────
// (design docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §1.1/§1.2;
//  owner ruling docs/decisions/2026-09-06-owner-web-client-rulings-repo-protocol-domains.md 2)
//
// FLOWMIC-WEB is a THIRD end — a browser page that pairs over the same
// `mobile:pair` and can hold a room over the same `pc:register`. Nothing on the
// wire could tell it apart from the app, and 「it is a web page」 is not cosmetic:
// it decides what the desktop's paired-devices table may honestly show, and (via
// `target_caps` below) whether an image may be sent at all.
//
// 🔴 ABSENCE MEANS `'app'`, AND THAT DEFAULT HAS EXACTLY ONE AUTHOR — the
// {@link clientOriginOf} function below. Every build that has ever sent one of
// these frames was the app, so 「no field」 is not 「unknown」 here: it is a fact
// about a world in which the web client did not exist. That is the ONE place
// this repo lets a missing value be read as a value, and it is why the reading
// is a function rather than a `?? 'app'` sprinkled over four call sites (a
// default with several authors is a value that answers two questions).
//
// ⚠️ THE PROJECTION DOES NOT FABRICATE IT. `PcPairedMobileSchema.client` stays
// nullable so a legacy row travels as `null` — the READER applies the default,
// the writer never invents one. Same rule the `device_uid` projection follows.
export const ClientOriginSchema = z.enum(['app', 'web']);
export type ClientOrigin = z.infer<typeof ClientOriginSchema>;
/** The value an ABSENT `client` field carries (design §5 「`client` 字段缺省 'app'」). */
export const CLIENT_ORIGIN_DEFAULT: ClientOrigin = 'app';
/**
 * Read a wire `client` value, including the absent case. The ONE author of the
 * default — see the red note above for why it is not spelled at the call sites.
 *
 * Anything that is not a known member reads as the default too: an old reader
 * must never crash on a kind a newer end names, and the honest fallback for
 * 「a client I have not heard of」 is the same one as for 「a client that predates
 * the field」 — neither is a claim, and both render nothing special.
 *
 * PRODUCTION CALLER (card ID-2, and it is the one this function was written
 * for): `apps/desktop/src/lib/paired-mobiles.ts`'s `asPairedMobiles`, which
 * resolves the wire value once, at the narrowing, so the paired-phones table can
 * draw a 「Web」 mark. The mark's own user-visible string lives with that
 * renderer, not here. `grep -rn clientOriginOf apps` lists the callers; the rule
 * is that they all go through this function rather than spelling the default.
 *
 * The default had to have a single author BEFORE two renderers existed, not
 * after — the alternative shape, two surfaces each writing `?? 'app'`, is this
 * repo's headline defect, and it is cheaper to prevent than to find. The relay
 * still stores and projects the RAW value (null included) and never fabricates
 * one; only readers apply the default.
 */
export function clientOriginOf(value: unknown): ClientOrigin {
  return value === 'web' ? 'web' : CLIENT_ORIGIN_DEFAULT;
}
/**
 * `client_version` — the sending build's own version string, free-form and
 * capped. It is DIAGNOSTIC, never a gate: nothing may branch on it, because a
 * version string is a claim the sender makes about itself, and a permission
 * decision taken on one is a permission decision taken on user-supplied text.
 * Capped because it lands in a DB column and in a device list.
 */
export const CLIENT_VERSION_MAX_LENGTH = 32;
const ClientOriginFields = {
  client: ClientOriginSchema.optional(),
  client_version: NonEmpty.max(CLIENT_VERSION_MAX_LENGTH).optional(),
};

// ── card S2-01 · CAN THE TARGET RECEIVE AN IMAGE? ───────────────────────
// (design docs/strategy/2026-09-06-web-client-parity-privacy-image-and-ux-addendum.md §3)
//
// The microphone end has never had to ask: the only target was FLOWMIC-PC and it
// has a clipboard-paste path. A WEB-SDK target is a third party's input box and
// 「缺省只收文字」("text only by default"), so sending it an image would be a
// delivery that succeeds on the wire and lands nowhere — the exact shape of
// F-4, where a picture ended up in neither the target nor the clipboard while
// both ends wrote 「success」.
//
// 🔴 THREE STATES, NOT TWO, AND THE THIRD IS THE COMMON ONE.
//   · field ABSENT       → 「undeclared」: the target has not said. Every PC built
//                          before this card is here, and the reader must ALLOW —
//                          refusing would break image delivery for every install
//                          on the day this ships.
//   · `{ image: true }`  → declared yes.
//   · `{ image: false }` → declared no. The mic tells the user BEFORE sending and
//                          does not queue it (design §3: 「不入队、不计配额」).
// Collapsing absent into false is the tempting simplification and it is a
// regression; collapsing absent into true loses the ability to ever say no.
//
// `image_note` is the target's own words for WHY not (a third-party site's
// setting), rendered beside our sentence. Optional: a target that says nothing
// gets our generic sentence, never an invented reason.
export const TargetCapsSchema = z.object({
  image: z.boolean(),
  image_note: NonEmpty.max(200).optional(),
});
export type TargetCaps = z.infer<typeof TargetCapsSchema>;

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
//
// card S2-01 — `client` / `client_version` / `target_caps` ride BOTH admission
// legs, and the second one is not symmetry for its own sake.
//
// 🔴 REGISTER-ONLY STAMPING IS UNREACHABLE FOR AN INSTALLED DESKTOP, and this
// repo has already paid for learning that once: `pcid` was backfilled on
// `pc:register` alone and the branch 「proved unreachable for established
// desktops」, so 0.3.1 had to add the reconnect leg (see ADDITIVE_TEXT_COLUMNS
// in apps/server-core/src/db/schema.ts). A desktop registers when it FIRST pairs
// and reconnects by token forever after; a capability declared only at register
// would therefore be declared by almost nobody, and the field would look alive
// while being dead in production.
//
// The design addendum §1.2 names `pc:register` only. This adds the reconnect
// leg and the addendum was amended in the same commit (「任何接口变化先改本文档」).
export const PcRegisterSchema       = z.object({
  device_name: PcDeviceNameSchema,
  setup_key: NonEmpty.optional(),
  client_instance_id: ClientInstanceId,
  machine_uid: DeviceUid,
  ...ClientOriginFields,
  target_caps: TargetCapsSchema.optional(),
});
export const PcReconnectSchema      = z.object({
  token: Token,
  client_instance_id: ClientInstanceId,
  machine_uid: DeviceUid,
  ...ClientOriginFields,
  target_caps: TargetCapsSchema.optional(),
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
// card S2-01 `client` / `client_version`: WHICH KIND OF END this row was paired
// from, so the desktop's table can mark a browser 「Web」 instead of showing it as
// an indistinguishable phone. NULLABLE and OPTIONAL for the same reason
// `device_uid` above is: a row paired before the field existed has no value, and
// the projection states that rather than inventing one. The 「absent means app」
// reading belongs to the RENDERER and has one author ({@link clientOriginOf}).
//
// ⚠️ `platform` (android / ios / …) is deliberately NOT here even though the
// design addendum §1.2 wrote 「platform/client」: no end sends it, and a field
// with no producer is a column that renders 「unknown」 forever while looking like
// a feature. It can be added the day something declares it.
export const PcPairedMobileSchema   = z.object({
  pairing_id: NonEmpty,
  mobile_name: NonEmpty,
  paired_at: z.string(),
  last_seen_at: z.string().nullable(),
  online: z.boolean(),
  device_uid: z.string().nullable().optional(),
  client: ClientOriginSchema.nullable().optional(),
  client_version: z.string().nullable().optional(),
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
// card S2-01 — `client` / `client_version` on ALL THREE arms, because the union
// members are three ways to present the same thing and a field that exists on
// only some of them makes the reader ask which arm it came in on.
//
// ⚠️ NOT ON `mobile:reconnect`, and that asymmetry with the PC legs above is
// deliberate rather than an omission: a reconnect resumes a row that was WRITTEN
// by one of these pairs, so the value is already stored. The PC legs need both
// because an installed desktop reaches the relay through `pc:reconnect` and
// would otherwise never declare anything; a browser that pairs has no such
// history — the field lands on the row the first time it is used.
export const MobilePairSchema       = z.union([
  z.object({ short_code: z.string().regex(/^\d{4}$/), ...PcidField, ...MobileNameField, ...ClientOriginFields }),
  z.object({ qr_payload: NonEmpty, ...MobileNameField, ...ClientOriginFields }),
  z.object({ cloud_instance: z.literal(true), ...MobileNameField, ...ClientOriginFields }),
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

// ── 2026-08-29 · the multi-node half of the `mobile:reconnect` ACK ───────────
// (docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §4-2)
//
// The phone follows its PC. Rooms are per-process (server-core room/store.ts:
// 「Live socket presence ONLY」), so a phone connected to a different node from
// its PC is not in a slow room — it is in a DIFFERENT room, and would sit there
// reporting the PC offline while the PC reports itself perfectly connected.
//
//   · `home_node` — the node the paired PC is registered on right now
//     (`pc_devices.home_node`, stamped on every PC admission).
//   · `node`      — the node that ANSWERED this ack.
//
// 🔴 BOTH, NOT JUST THE FIRST, AND THAT IS THE POINT. The phone's question is
// 「am I in the same place as my PC」, which is a COMPARISON. It could learn its
// own side from GET /api/node/ping instead — and then it would be comparing two
// answers taken at two different instants, with a reconnect possible in between.
// One ack, one instant, one comparison.
//
// ABSENCE MEANS 「single-node deployment」 and must keep meaning that: a phone
// that sees neither field behaves exactly as it does today, which is what every
// installation does until the day it does not. Never emit an empty string or a
// placeholder here — 「I do not know which node」 and 「there are no nodes」 are
// different facts and only one of them is worth acting on.
//
// FAILURE DIRECTION, same construction as the audio field above and as
// `inject_origin`: an old relay that strips these, or an old phone that ignores
// them, produces exactly the current product — the phone dials the endpoint and
// finds its PC there, because until multi-node is offered the PC is there. The
// event whitelist is untouched: these are payload fields on an ack, not events.
export const MobileReconnectAckNodeFieldsSchema = z.object({
  home_node: z.string().min(1).optional(),
  node: z.string().min(1).optional(),
});
export type MobileReconnectAckNodeFields = z.infer<typeof MobileReconnectAckNodeFieldsSchema>;

// ── card S2-01 · the TARGET-CAPABILITY half of the pair / reconnect ACK ──
// (design docs/strategy/2026-09-06-…-ux-addendum.md §3)
//
// A PARTIAL fields-schema, the same construction and for the same reason as
// `MobileReconnectAckAudioFieldsSchema` and `ServerCapabilityAckFieldsSchema`
// above: the acks are emitted as literals in mobile.handler.ts, and a parallel
// full-ack declaration nothing verifies is the RV-36 drift trap. The emitter
// types its spread as {@link TargetCapsAckFields}, so the compiler holds the
// handler to THIS declaration.
//
// 🔴 WHOSE CAPABILITY IT IS. The `capabilities[]` array beside it says what the
// SERVER can do; this says what the TARGET at the other end of the room can
// receive. Two questions, two fields — one array carrying both would be this
// repo's headline bug shape, and the two even fail in opposite directions (an
// unknown server capability is ignored; an unknown target capability must be
// treated as「undeclared, allowed」).
//
// OMITTED, NEVER `{image:false}`, when the target has not declared: see
// TargetCapsSchema for why the third state is the common one.
export const TargetCapsAckFieldsSchema = z.object({
  target_caps: TargetCapsSchema.optional(),
});
export type TargetCapsAckFields = z.infer<typeof TargetCapsAckFieldsSchema>;
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
