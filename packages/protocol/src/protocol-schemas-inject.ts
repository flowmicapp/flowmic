// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (inject / control, incl. the
//     control:key kind whitelist) + F-3112 inject_target provenance + the
//     A-58 correlation-key addendum (inject:request.entry_id,
//     inject:result.entry_id/.request_id)
//   docs/decisions/2026-07-23-wp-r0-1-protocol-rename-window.md
//   F-701 (no unknown events), F-702 (zod schemas for every event payload),
//   F-2350 (inject:request image field-add — no new socket event),
//   F-3112 (inject:result gains optional inject_target — no new socket event),
//   A-58 (entry_id/request_id exact correlation echo — no new socket event,
//     both fields additive on already-whitelisted events)
//   docs/decisions/2026-07-31-owner-two-channels-transit-not-storage.md
//     (卡 P row-transit field-add: six additive optional fields so ONE delivery
//      frame carries everything a PC row is made of — no new socket event)
//   docs/decisions/2026-07-31-owner-b3-image-resend-and-protocol-round.md +
//     docs/strategy/2026-07-31-b3-protocol-round-plan.md (窗口B3, 0.2.33:
//     RV-68 `entry_caption` — the SEVENTH row field, an image row's words; and
//     `target_pc_id` goes from a known compatibility gap to a named refusal. Still no new
//     socket event: the whitelist stays at 54.)
//
// One module per protocol domain to stay under the file-size cap (F-801). The
// INJECT_EVENT_SCHEMAS sub-map below is spread into EVENT_SCHEMAS by
// protocol-schemas.ts, which also re-exports every symbol here, so the public
// @flowmic/protocol surface is unchanged.
//
// WP-R0-1 rename window: the discrete control event was renamed to
// `control:key` (schema `FlowMessageSchema` → `ControlKeySchema`). The kind
// whitelist is UNCHANGED: enter/backspace/undo/clear/tab/space.

import { z } from 'zod';
import { EntryTypeSchema, Iso8601, NonEmpty, ThumbB64 } from './protocol-primitives';
import { ProcessingModeSchema } from './protocol-schemas-audio';
// F-3112: InjectTarget's canonical zod shape already lives in
// protocol-schemas-timeline.ts (F-3110 — it is also read off the E2EE entry
// payload via normalizeTimelineEntryPayload). Reusing it here keeps §3.5 and
// the data model asserting the exact same shape instead of two schemas
// silently drifting apart.
import { InjectTargetSchema } from './protocol-schemas-timeline';

// ─── §3.5 inject / control ────────────────────────────────────────────
// F-2221 (INJ-3): `request_id` is an OPTIONAL per-utterance idempotency key the
// mobile stamps (minted at PTT-down, constant across any frame-level duplication
// of one utterance). The desktop dedups by it so a reconnect-flap replay of the
// SAME utterance is physically typed once — robust where the INJ-1 byte-window is
// not (paraphrase variance / >window spacing / per-install reset). Optional ⇒ a
// backward-compatible field-add to an already-whitelisted event (no new event).
// WP-R2-1 review (MAJOR #3): a hard ceiling on inject text. One injected input
// event is allocated per UTF-16 unit downstream (SendInput), so an unbounded
// `text` is a memory-DoS vector on the desktop typer. 100k chars is far above
// any real utterance/transcript yet bounds the pathological case; the desktop
// enforces the same limit on its own Rust parse path.
export const INJECT_TEXT_MAX_CHARS = 100_000;
/** Longest legal `entry_caption`, in the units zod's `.max()` counts (UTF-16).
 *  The real producer is the phone's `imageEntryLabel` — `🖼 PNG · 214 KB`, 15
 *  units — so this is a DoS ceiling, not a formatting constraint: it is far
 *  above anything the descriptor can grow into (a mime label plus a byte size)
 *  and far below anything worth rendering on one timeline line. Bounded because
 *  it is display text that the PC renders verbatim without ever asking again. */
export const ENTRY_CAPTION_MAX_CHARS = 64;
export const InjectImageMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp']);
const InjectImageBase64Schema = z.string().max(5_500_000).refine(
  (value) => value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value),
  'image_b64 must be canonical base64',
);
export const InjectRequestSchema    = z.object({
  text: z.string().max(INJECT_TEXT_MAX_CHARS),
  source: z.enum(['stt', 'llm', 'manual', 'history', 'image']),
  request_id: z.string().optional(),
  // F-3112 (A-58): the opaque write-back-target the server's `history:inject`
  // handler stamps with the entry's own `item.id` so the PC can echo it
  // verbatim on `inject:result` — the mobile's exact correlation key for a
  // Re-inject (mirrors `compose:start.entry_id`, F-3111/D-209). Never resolved
  // against any table by the server/PC, only echoed.
  entry_id: NonEmpty.optional(),
  // ── `mode` — the mode this entry was PRODUCED under ──────────────────
  //
  // F-2361 used to confine this field to `source === 'manual'` with a
  // superRefine ("mode is reserved for explicit manual ComposeBand delivery").
  // That clause is REMOVED in the row-transit round, and what it was defending
  // has to be written down or the next reader will assume it never existed:
  //
  //   WHAT IT DEFENDED — its own stated reason was 「so the SERVER can record
  //   the delivered row under the selected public mode」. The server owned the
  //   row; a manual ComposeBand send has no audio session, so the frame was the
  //   only place its mode could come from, while an STT utterance already had
  //   one fixed for its whole life at `audio:start` (AudioStartSchema.mode,
  //   required). Admitting `mode` on both would have put TWO answers to one
  //   question on the server's desk with no rule for which wins — this repo's
  //   #1 bug shape. Confining it to the case with no other answer was correct.
  //
  //   WHY IT NO LONGER NEEDS DEFENDING — the server records no row at all
  //   (`transcript_history` dropped 2026-07-31), so the competing answer the
  //   clause protected does not exist, and neither does the recorder it was
  //   protecting. The PC owns the timeline now and its new rows arrive ONLY on
  //   this frame (owner's architecture ruling, transit-not-storage), and most of the paths
  //   that produce one have no `audio:start` beside them at all: manual sends,
  //   a backfill (`source:'history'`), the HTTP image ingress, and every queued
  //   re-delivery after a reconnect.
  //
  //   THE ONE OVERLAP, NAMED RATHER THAN WAVED AWAY — the server does still fan
  //   `audio:start` out to the PC for delivery:'inject' utterances (F-2375,
  //   audio.handler). Its desktop consumer (capsule/controller.ts
  //   `onAudioStart`) reads one field off it and it is not this one.
  //
  //   ⚠️ CORRECTION (2026-07-31, 窗口B2 — this paragraph used to claim 「grep:
  //   zero readers in server-core AND in src-tauri」 and half of that was false
  //   ON THE DAY IT WAS WRITTEN). src-tauri READS this field: row_transit.rs
  //   `RowFacts::read` (`one_of(frame.get("mode"), &ROW_MODES)`) → `build_row`
  //   → the row's own `mode`, and its absence is what prints
  //   `gaps=[mode→realtime(guess)]`. That reader landed in the SAME round as
  //   this comment. server-core is still a true zero (every `"mode"` hit there
  //   is `inject:result.mode`, a different field with a different domain).
  //   Left as a correction rather than a quiet rewrite: anti-façade ④ says a
  //   comment arguing FOR a design is itself a greppable assertion, and this
  //   one is the literal repeat of that lesson — it was refuted by the very
  //   grep it invited, and the cost was real (a phone that never stamped `mode`
  //   put every PC row at 「实时」 and shut the original-text column, RV-74).
  //   The rule for the card that builds the row: the ROW's mode comes from THIS
  //   frame; the audio:start fan-out drives the SPEAKING lock and the capsule
  //   surface, never a row.
  //
  // Semantics are UNCHANGED and still deliberately independent of
  // `process_mode` (05-DATA-MODEL / TimelineEntry): `mode` says how the entry
  // was PRODUCED, `process_mode` says how `processed_text` was made.
  mode: ProcessingModeSchema.optional(),
  // ── `inject_origin` — 🔴 a deferred delivery must not auto-inject (owner 2026-08-02) ──────
  //
  // Full ruling text: docs/decisions/2026-08-02-deferred-delivery-must-not-autoinject.md.
  // owner, verbatim:「之前没发送成功、后面（连上网）补投到 PC 的消息，PC 端不能随便注入
  // ——这时用户对这个行为是不可预知、没有准备的，直接注进当前输入窗口可能引起事故。」
  //
  // WHAT IT ANSWERS, and the one thing it must never be asked: 「这一次投递是不是
  // 用户此刻的动作直接产生的」. It does NOT answer 「这些字节从哪来」 — that is
  // `source` (stt/llm/manual/history/image), and the two disagree constantly:
  // a `source:'stt'` frame is live when the sentence just left the user's mouth and
  // a backfill when the same queued item finally drains three hours later, while a
  // `source:'history'` backfill is a user pressing resend and IS expected. Deriving one
  // from the other is this repo's #1 bug shape (one value answering two questions) applied to the
  // one decision that types into a stranger's document.
  //
  // 🔴 DELIBERATELY NOT DERIVED FROM `created_at` EITHER. That field answers
  // 「什么时候说的」; this one answers 「该不该注」. They correlate and they are not
  // the same question — a backfill the user pressed one second ago has a `created_at`
  // from last week, and inferring from age would refuse the one delivery the user
  // is standing there waiting for. The PHONE decides, at the moment it puts the
  // frame on the wire, and it compares its OWN clock against its OWN
  // `created_at` — no cross-device clock comparison is involved anywhere.
  //
  //   live     — the direct result of a user's action right now: the sentence that just finished (including
  //              a short retry — see kLiveDeliveryWindow on the phone), a ➤ / quick-phrase
  //              tap, a picture just picked, a resend/backfill the user pressed.
  //   deferred — an automatic backfill: a reconnect drain of an item that has been waiting, a
  //              PC_BUSY-release drain, anything NOT produced by a user action now.
  //
  // WHAT THE RECEIVER DOES WITH IT (07-DESKTOP-SPEC §2 / inject/pipeline.rs):
  // `deferred` ⇒ the PC does NOT inject, even with a live focused window. The row
  // is still minted and the verdict is still truthful — `ok:false, mode:'cached',
  // error:'INJECT_DEFERRED_NOT_AUTOINJECTED'` — so the message is on the PC's
  // timeline and the user re-injects it there when they are ready.
  //
  // ⚠️⚠️ THE FAILURE DIRECTION, STATED HERE BECAUSE IT DECIDES A DEPLOY ORDER.
  // zod objects STRIP unknown keys, and the relay forwards `parsed.data`
  // (relay.handler.ts) — so a relay whose protocol dist predates this field
  // DELETES it in flight. Absence is therefore ambiguous by construction, and the
  // receiver reads it as `live` (i.e. today's behaviour) rather than `deferred`:
  //   · absent ⇒ live  — a stale relay / an old phone keeps injecting exactly as
  //     it does today. The bug is not yet fixed on that leg; nothing REGRESSES.
  //   · absent ⇒ deferred — a stale relay would turn EVERY live utterance on the
  //     cloud leg into 「未注入」, i.e. the product's headline feature stops working
  //     for anyone who has not redeployed. That is a regression, and this repo has
  //     already paid two days for a refusal that fired on everything (0.2.19).
  // ⇒ 🔴 THE COMPENSATION IS A DEPLOY ORDER, NOT A DEFAULT: **deploy the relay before shipping the APK**
  // (same rule `duration_ms` learned in 0.2.43). verify/golden/g19-* fails RED when
  // the relay in front of it strips this field, so 「有没有先部署中继」 is answered by
  // a test rather than by someone remembering.
  //
  // ⚠️ A 0.2.48+ phone stamps this on EVERY frame, both values written out — never
  // omitted. That is what makes absence mean exactly one thing (「这一端比 0.2.48
  // 老，或者路上有人把它剥掉了」) instead of two.
  inject_origin: z.enum(['live', 'deferred']).optional(),
  // ── 卡 P row transit — six additive optional fields ──────────────────
  //
  // owner's architecture ruling, 2026-07-31 (transit-not-storage): the two channels hand a
  // message over WITHOUT storing it, and a PC timeline row is created by the
  // delivery frame itself — there is no history-sync stream to make one any
  // more. So this frame has to carry everything the row is made of. Each field
  // below answers 「what can the PC NOT render without it」; nothing was added
  // because it happened to exist on `HistoryItemSchema`.
  //
  // All six are OPTIONAL and consumed by NOBODY as of this card — the senders
  // and the row builder are cards M / S / D. That is deliberate sequencing, not
  // a shipped capability: a 0.2.28 phone sends none of them and a 0.2.28 PC
  // reads none of them, and both keep working exactly as they do today.
  //
  /** The time the row happened — i.e. when it was SPOKEN. Without it the PC can
   *  only stamp the moment it received the frame, which is a different fact and
   *  is wrong by however long the phone spent queued or offline (owner: 「不管
   *  时间多久，全部都要投递」 — a three-day-old row must not claim to be new). */
  created_at: Iso8601.optional(),
  /** How long the utterance TOOK to say, in milliseconds (owner 2026-08-02:
   *  「语音时长要找回来……已支持每条转录消息能够记录时长和字数，自然也能统计」).
   *
   *  The engine has always reported this to the phone (`SttFinalSchema.duration_ms`)
   *  and the phone's own row stores it — this field is the missing LEG: the delivery
   *  frame is the PC's only way to build its row (transit-not-storage), so a row's
   *  duration must ride the frame or the PC can never answer 「说了多久」.
   *  Additive optional FIELD — no new event, no new error code, the 54-event
   *  whitelist and count guards are untouched (same shape as `polish` on
   *  SttFinalSchema). Absent = 「这一帧没说」: typed/manual rows, image rows and
   *  pre-0.2.43 phones simply do not speak it, and the PC row keeps `null` —
   *  rebuild doc 16 §6.1: null must never be counted as 0 when totalling.
   *  ⚠️ A relay older than 0.2.43 strips this field in flight (zod parse →
   *  forward parsed.data) — the frame still delivers, the row just stays
   *  duration-less. Deploying the relay is what turns the cloud leg on. */
  duration_ms: z.number().int().nonnegative().optional(),
  /** The ORIGINAL text, when `text` is a product rather than the words spoken.
   *  In translate/organize 「原文 vs 输出」 are two columns and `text` is only the
   *  output column; without this the PC renders one column and the other half of
   *  the row is unrecoverable (`source_text` is write-once immutable, rebuild doc 05).
   *  Nullable AND optional, mirroring `HistoryItemSchema.source_text`: null =
   *  「there is no original, this IS the words」 (realtime), absent = 「this
   *  sender does not speak the field」. */
  source_text: z.string().nullable().optional(),
  /** Whether this row is a transcript or a picture — they render completely
   *  differently. Absent ⇒ 'transcript', so a 0.2.28 frame is unchanged. Shared
   *  shape with `HistoryItemSchema.entry_type` (protocol-primitives.ts). */
  entry_type: EntryTypeSchema.optional(),
  /** Bounded inline thumbnail so an image row can be RECOGNISED in the timeline
   *  after the paste is done. Same schema object as
   *  `HistoryItemSchema.thumb_b64` — one cap, one boundary verdict, no drift.
   *  Distinct from `image_b64` below and never a substitute for it: that one is
   *  the full picture being injected right now, this one is what the row keeps. */
  thumb_b64: ThumbB64.optional(),
  // ── `entry_caption` — the WORDS an image row shows (RV-68) ────────────
  //
  // THE BUG IT CLOSES: the phone shows 「🖼 PNG · 214 KB」 on its own row and the
  // PC shows a thumbnail with NOT ONE CHARACTER under it. `inject:request.text`
  // for a picture is `''` and MUST stay `''` — sending the descriptor there would
  // make a PC TYPE 「🖼 PNG · 214 KB」 into the user's document and call it a
  // delivery (mobile session/image_send_controller.dart:667 builds that
  // `InjectRequestPayload` with an empty `text` and says exactly this at the send
  // site). So `text` cannot carry it, and the PC has nothing to
  // render. This field is the descriptor travelling as WHAT IT IS: display text.
  //
  // 🔴 RENDERED, NEVER INJECTED. The receiver puts it on the row's face and
  // nothing else; it is not eligible to be typed, on this delivery or on a later
  // backfill. The desktop's structural half of that promise is written at
  // src-tauri/src/socket/row_transit.rs `build_row` (a caption only ever lands on
  // a row that is ALSO stamped `entry_type:'image'`, and an image row has no
  // Re-inject button — `rowCanReinject` in main-window/TimelinePage.vue).
  // ⚠️ NAMED BY SYMBOL, NOT BY LINE (2026-08-07): the `:149-151/:514` this used to
  // carry made an ordinary edit in that Vue file into THIS file's gate failure.
  //
  // ── CONFINED TO IMAGE ROWS BY THE superRefine BELOW ──────────────────
  //
  //   WHAT IT DEFENDS — 「这一行显示什么」 is a question that already has an
  //   answer on every OTHER row: `text`, the thing that was delivered. Admitting
  //   a caption there too would put TWO answers to one question on the receiver's
  //   desk with no rule for which wins — this repo's #1 bug shape, the same one
  //   the F-2361 `mode` clause used to guard against on the line above. An image
  //   row is the ONE kind whose `text` is deliberately empty, so it is the one
  //   place where a second field is not a second answer but the only answer.
  //
  //   WHAT THE CLAUSE COSTS, stated rather than discovered later — a caption
  //   requires the frame to say `entry_type:'image'` OUT LOUD. Gating on
  //   `source === 'image'` was the alternative and is worse: `source` says where
  //   the bytes came from and `entry_type` says what the row IS, and a frame that
  //   claims to be a transcript row while carrying a picture's caption is exactly
  //   the state this clause exists to make unrepresentable. The receiver's own
  //   `source === 'image' ⇒ entry_type:'image'` fallback (row_transit.rs) does NOT
  //   extend to the caption for the same reason: the fallback is this PC's guess
  //   about a row, and a guess must not unlock display text.
  //
  //   WHEN IT COULD BE RELAXED — the day a non-image row exists whose `text` is
  //   legitimately empty AND which has something to say. There is no such row
  //   today; if one appears, widen this clause deliberately, and do not widen it
  //   by deleting it, because 「every row may carry a caption」 re-opens the two
  //   answers.
  //
  // Additive + optional, so a 0.2.32 frame is byte-for-byte unchanged.
  //
  // ⚠️ ZERO PRODUCERS AS OF THIS CARD, and the RECEIVER ships in the same round.
  // The sender is one card later (mobile image_send_controller.dart:437-468 — the
  // `InjectRequestPayload` for the image path, which already stamps the
  // `entry_type:'image'` this field requires; the wire class is
  // signaling/wire_payloads.dart, same 「omit when null」 shape as `target_pc_id`).
  // Same direction as INJECT_PC_MISMATCH in error-codes.ts and the same rule keeps
  // it honest: a protocol face may PRECEDE its producer, because three ends agree
  // on the shape before they implement it — but if the wave ships without the
  // phone stamping it, THIS FIELD GOES WITH IT rather than sitting here as a
  // capability nothing can ever exercise. Until then a PC row for a picture keeps
  // rendering exactly as it does today (empty), which is the bug, not a regression.
  entry_caption: NonEmpty.max(ENTRY_CAPTION_MAX_CHARS).optional(),
  /** WHICH PHONE said it. The PC is a shared destination — two phones deliver
   *  into one timeline — and a row that cannot say where it came from is exactly
   *  what makes crosstalk invisible. So this is both a display field and the
   *  VISIBILITY half of the no-crosstalk red line: `target_pc_id` makes a
   *  mis-addressed frame impossible, this makes a mis-addressed frame visible.
   *  Capped at 48 to match `MobilePairSchema.mobile_name`, which is the same
   *  string: the phone's own `buildDeviceLabel` (mobile session/device_label.dart
   *  `kDeviceLabelMax = 48`) already truncates to exactly this, so a real label
   *  can never be refused here. */
  device_label: NonEmpty.max(48).optional(),
  /** 🔴 THE NO-CROSSTALK RED LINE (owner 2026-07-31, verbatim: 「生死线，不能触犯」).
   *
   *  The PC this message is FOR, as the phone addressed it — `pc_id` from the
   *  pairing ack (`pc_devices.id`; the phone already persists it as
   *  `TokenStorage.pcId`). NOT `machine_uid`, NOT `room_uuid`,
   *  NOT `client_instance_id`: those answer 「同一台物理机器?」/「哪个房间」/
   *  「哪条连接槽」, and this answers 「这条要送到哪台」.
   *
   *  The rule it exists to enforce, stated here because the schema is where both
   *  ends read it — TWO refusals, because there are two different wrong answers
   *  and they send the user to two different places:
   *    · present and NOT equal to the PC on this connection ⇒ INJECT_PC_MISMATCH
   *      (「你要送的那台不是这台」);
   *    · ABSENT ⇒ INJECT_PC_UNSPECIFIED (「你没说要送给哪台」) — since 0.2.33.
   *  Never re-route, never deliver it 「anyway」. A queue item must carry its own
   *  destination; deriving it at drain time from 「whoever is connected now」 is
   *  precisely the crosstalk the red line forbids.
   *
   *  ⚠️ OPTIONAL ON THE WIRE, MANDATORY BY POLICY SINCE 0.2.33 — and the two are
   *  not in conflict, they are two different statements about two different
   *  layers. What this schema says is 「a frame without an address can be
   *  PARSED」; what the policy says is 「a receiver must REFUSE one」
   *  (INJECT_PC_UNSPECIFIED — relay.handler.ts / http/inject-routes.ts).
   *
   *  WHY IT IS NOT DECLARED `required`, which is the obvious move and is wrong:
   *  a required field turns an old phone's frame into a zod failure at the
   *  boundary, and this repo's boundary rejects are the thing that has to be
   *  answered out loud, not the thing that answers. The frame would die as
   *  「INJECT_FRAME_INVALID / (root): invalid_type」 — a sentence that names no
   *  field and lets 「你没说要送给哪台」 arrive at the user as 「发送的数据不符合
   *  协议」. Same lesson as HISTORY_SYNC_RETIRED: the way to retire a tolerance is
   *  to keep parsing the old shape and refuse it BY NAME, never to make it
   *  unparseable. Keeping it optional is also what lets the refusal echo
   *  `request_id`/`entry_id` off a PARSED frame instead of scraping them from an
   *  untrusted payload.
   *
   *  0.2.32 senders stamp it on all four emission paths. Named by SYMBOL, not by
   *  line: these used to be `manual_delivery.dart:313/:575` and had already drifted
   *  to `:274/:585` within one window — a citation that rots is worse than none,
   *  because it sends the next reader to a line that now says something else.
   *  The four: `chat_utterance.dart` `_deliverDirect`, `manual_delivery.dart`
   *  `deliverText` + `reInject`, `image_send_controller.dart` `_send`.
   *  The one remaining honest null is a pairing
   *  older than 0.2.4 that has not completed a reconnect round-trip since
   *  (PttSession.pcId's doc) — it heals on the next ack, and until it does those
   *  frames are refused rather than delivered unaddressed, which is the direction
   *  a red line has to fail in. */
  target_pc_id: NonEmpty.optional(),
  image_b64: InjectImageBase64Schema.optional(),
  image_mime: InjectImageMimeSchema.optional(),
}).superRefine((value, ctx) => {
  // WHAT THIS REFINEMENT GUARDS, now that the `mode` clause is gone: the F-2350
  // image pairing in both directions, and (RV-68) the caption's confinement to
  // image rows. Nothing else. There is NO
  // remaining cross-field rule between `mode` and `source` — every combination
  // of the three modes and the five sources is legal, including
  // source:'image' + mode (an image row carries a mode like any other row:
  // `HistoryItemSchema.mode` is required even for entry_type:'image'). The
  // per-field domains still apply of course (the three-mode enum has no fourth
  // member, `text` has its cap, the new optional fields have theirs) — those are
  // field schemas, not refinements, and they are asserted in the round-trip test.
  // RV-68: a caption belongs to a PICTURE row and to nothing else. See the long
  // note at the field for what this defends, what it costs, and when it may be
  // widened. Refused BY NAME on `entry_caption` (not on `entry_type`) so the
  // sender's log says which field it may not send, rather than which field it
  // forgot — the frame is otherwise legal and dropping the caption silently is
  // the outcome this refusal exists to prevent.
  if (value.entry_caption !== undefined && value.entry_type !== 'image') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['entry_caption'],
      message: "entry_caption is only carried by an image row (entry_type:'image')",
    });
  }
  const hasBytes = value.image_b64 !== undefined;
  const hasMime = value.image_mime !== undefined;
  if (value.source === 'image' && (!hasBytes || !hasMime)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['image_b64'], message: 'image source requires image_b64 and image_mime' });
  }
  if (value.source !== 'image' && (hasBytes || hasMime)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source'], message: 'image fields require source image' });
  }
});
// F-3112 (§3.5): `inject_target` is present only on a successful injection
// (ok:true); a failed or cached-fallback result omits it. When both are
// present, `target_window` equals `inject_target.window_title` —
// `target_window` is retained unchanged for clients that don't understand
// the richer object.
// F-3112 (A-58): `entry_id`/`request_id` are the exact correlation echo —
// verbatim copies of the triggering `inject:request`'s same-named fields,
// present whenever the PC received them (regardless of `ok`). A pre-A-58
// client omits both; a pre-A-58 server/PC never sends them, and a mobile that
// doesn't read them ignores the extra keys.
// ── IJ-01 · `focus_window` / `focus_evidence` — 「对着哪个窗口，读到了什么」 ──────
//
// owner's 2026-08-07 ruling ④ (docs/decisions/2026-08-07-owner-inject-status-wording-
// evidence-and-window-title.md), design §4-3. owner's addendum ①: an un-injected delivery
// still has to be able to say 「注到哪个窗口 / 什么状态 / 什么结果」, and until this
// round the desktop computed both facts on EVERY injection and discarded them on
// every non-success (design §3-B/§3-C).
//
// 🔴 WHY TWO NEW KEYS RATHER THAN WIDENING `inject_target`, which was the obvious
// move and is the dishonest one: `InjectTargetSchema` requires `injected_at`, so a
// result that never injected would have had to carry an INJECTION TIME. That is a
// lie with a timestamp on it. And `target_window` answers 「字落在了哪里」, which is
// a different question from 「这一次尝试对着哪里」 — merging them is this repo's #1
// bug shape (one value answering two questions). The old keys keep their ok:true-only contract
// (F-3112, the comment above) EXACTLY as it was.
//
// ⚠️ DEPLOY ORDER — NOT a hard one, and the reasoning is written here so nobody
// has to re-derive it. A relay older than this round zod-strips both keys in
// flight, and the receiver then shows what it shows today: the phone loses two
// incidental details and NO judgement changes, because no verdict is built on
// either field (`inject-verdict-authorship.ts` — the criterion is the CODE, and it
// stays a known key). That is the opposite of `inject_origin`, whose absence
// CHANGED BEHAVIOUR and therefore forced deploying the relay before shipping the APK.
export const FocusWindowSchema      = z.object({
  /** The foreground window's title at the moment of the attempt.
   *  🔴 `z.string()`, NOT NonEmpty: a real window may have no title, and refusing
   *  the frame over that would lose the process name too — which is the half that
   *  actually answers 「为什么没注进去」. */
  window_title: z.string(),
  /** The process behind that window (`chrome` / `cursor` / `Weixin`).
   *  NonEmpty because it is the ONE half owner ruled may be persisted onto a row
   *  (ruling ③ takes (c): the window title is not persisted to storage) — a durable field that can be empty is a durable
   *  field nobody can act on. */
  process_name: NonEmpty,
});
export const InjectResultSchema     = z.object({
  ok: z.boolean(),
  target_window: NonEmpty.optional(),
  mode: z.enum(['sendinput', 'clipboard', 'cached']),
  error: NonEmpty.optional(),
  inject_target: InjectTargetSchema.optional(),
  entry_id: NonEmpty.optional(),
  request_id: NonEmpty.optional(),
  /** 「这一次尝试时，我们观察到的前台窗口是哪一个」 — present on success AND on
   *  failure/cached, which is the whole point. ABSENT means NO WINDOW WAS EVER
   *  OBSERVED, and that is a real state with real producers: the channel-admission
   *  refusal (INJECT_NOT_PRIMARY) and the RV-83 disk-ledger replay both answer
   *  before anything looks at a window, and neither may invent one. */
  focus_window: FocusWindowSchema.optional(),
  /** What the desktop's Stage-1b probe read (src-tauri inject/target_probe.rs).
   *
   *  🔴 ABSENCE IS NOT `unknown`. `unknown` means 「我们问了，答不出来」; an absent key
   *  means 「我们没问」, and the paths that never ask are real (a backfill refused before
   *  the pipeline, an admission refusal, a Stage-1 focus loss). Collapsing the two
   *  would ship a measurement nobody made — the same discipline `gui_ok=false`
   *  follows in target_probe.rs and the MSAA spike restated for `d=0 CLIENT`
   *  (docs/strategy/2026-08-07-ij03-msaa-focus-editability-spike.md §2.2-3).
   *
   *  🔴 IT IS NEVER A JUDGEMENT, on either end. The desktop does not read it to
   *  decide anything (`refusal_for` is untouched — 「判不出就拒绝」 is the 0.2.19 P0),
   *  and the renderer may not either: 「evidence 是 unknown 所以把 status 改成
   *  failed」 is explicitly forbidden by design §C-2. It selects a WORD, nothing more.
   *
   *  ⚠️ CORRECTED 2026-08-09 (IJ-05 flip, bc9ca65). This used to say: 「TODAY
   *  `editable` can only come from FlowMic's own window (in-process DOM focus).
   *  Every third-party app reads `unknown`, because a cross-process `ImmGetContext`
   *  always answers null. Wiring MSAA is a separate card (IJ-05); until it lands
   *  this field is nearly a constant」. Kept verbatim as evidence, not because it is
   *  true — the fourth copy of that stale sentence (the sibling in src-tauri
   *  inject/focus_evidence_tests.rs is corrected the same way). IJ-05 has landed
   *  and now ships default ON (src-tauri inject/msaa_focus.rs `probe_enabled`;
   *  `FLOWMIC_MSAA_FOCUS_PROBE=0` is the operator opt-out), so a third-party window
   *  now reaches `editable` too via the MSAA focus probe: inject/pipeline.rs calls
   *  `msaa_focus::upgrade(state, msaa_focus::msaa_verdict())` on the REPORT binding,
   *  and that `upgrade` makes exactly one transition — `unknown → editable` — never
   *  a negative (`MsaaVerdict` has none), so no verdict moves and the field is no
   *  longer nearly a constant. The cross-process `ImmGetContext`-always-null limit
   *  is still true of the IMM path; it is simply no longer the whole story. Still
   *  nowhere near universal, and the record states this plainly: a third-party window reads `editable`
   *  only when its focused element is a real writable TEXT control
   *  (role=ROLE_SYSTEM_TEXT, not the window shell); a shell, a read-only DOCUMENT
   *  (default Chrome with renderer a11y off), or no answer still reads `unknown`. */
  focus_evidence: z.enum(['editable', 'not_editable', 'unknown']).optional(),
});
// WP-R0-1: renamed from FlowMessageSchema. An out-of-whitelist kind is rejected
// at the server boundary by zod.
//
// TWO FAMILIES, deliberately distinguished by their `punct_` prefix:
//
//   CHORD kinds     — a virtual-key sequence (Enter, Backspace, Ctrl+Z…).
//   PUNCTUATION kinds — a literal character typed into the focused control.
//
// v0.2.1, owner's 2026-07-28 ruling:「点了标点符号之后，它直接追加到最近的一条转录
// 文本的后面……现在它是把它放在了那个输入框里面，这个其实是没必要的。因为点这个
// 标点基本上是为了补全前面没有的」.
//
// Until now the punctuation row was LOCAL-only (08 §5:「标点行是 LOCAL，插入
// 光标处，不上线」) and this is a deliberate reversal of that clause: the user
// taps 。 to finish the sentence that is ALREADY on the PC, so inserting it into
// a compose box on the phone — a box they then have to send — is two extra steps
// to reach the place they meant in the first place.
//
// They ride control:key rather than inject:request because that is what they
// ARE: one keypress into whatever holds focus, no timeline entry of their own,
// no delivery status. The event count is untouched (still 54 — this line said 57
// until 2026-07-31; it was written before the 0.2.24 protocol SUBTRACTION took the
// whitelist 58→54, and a stale count in a comment about counts is exactly the kind
// of number people quote instead of checking) — this widens an
// existing schema's enum, which is the additive-field-first rule applied to an
// enum. `payload` is unused by both families and stays as it was.
export const CONTROL_KEY_CHORD_KINDS = [
  'enter', 'backspace', 'undo', 'clear', 'tab', 'space',
] as const;

/** The literal each punctuation kind types. The SSOT for all three ends — the
 *  desktop maps kind→glyph from this table's Rust mirror, and the phone renders
 *  the same glyphs, so a new mark can never mean two different characters. */
export const CONTROL_KEY_PUNCTUATION = {
  punct_comma:       '，',
  punct_question:    '？',
  punct_exclamation: '！',
  punct_enumeration: '、',
  punct_colon:       '：',
  punct_period:      '。',
} as const;

export type ControlKeyPunctuation = keyof typeof CONTROL_KEY_PUNCTUATION;

export const CONTROL_KEY_PUNCTUATION_KINDS = Object.keys(
  CONTROL_KEY_PUNCTUATION,
) as [ControlKeyPunctuation, ...ControlKeyPunctuation[]];

export const ControlKeySchema       = z.object({
  kind: z.enum([...CONTROL_KEY_CHORD_KINDS, ...CONTROL_KEY_PUNCTUATION_KINDS]),
  payload: z.unknown().optional(),
  // ── `device_label` — WHICH PHONE pressed it (REQ-12-13, 2026-08-12) ─────
  //
  // Additive optional. The whitelist is untouched (still 54) and so is the error
  // code registry: this widens an existing schema, which is the additive-field-first
  // rule applied exactly as `duration_ms` and `entry_caption` applied it.
  //
  // WHY IT EXISTS NOW AND NOT BEFORE: from REQ-12-13 the desktop MINTS A TIMELINE
  // ROW for every remote key press (contract: docs/rebuild/15 §2.0-e — owner P0
  // 「两端都要像消息一样记录按了什么键」). A PC is a SHARED destination — two phones
  // deliver into one timeline — so a row that cannot say where it came from is
  // exactly what makes crosstalk invisible. Same field, same 48 cap, same reason as
  // `InjectRequestSchema.device_label`: the phone's own `buildDeviceLabel`
  // (mobile session/device_label.dart `kDeviceLabelMax = 48`) already truncates to
  // exactly this, so a real label can never be refused here.
  //
  // 🔴 DELIBERATELY NOT JOINED BY `target_pc_id`, and the absence is a decision
  // rather than an oversight. On `inject:request` that field exists because a
  // QUEUE drains later and must not re-derive 「whoever is connected now」 (🔴 the
  // crosstalk iron law). `control:key` has no queue, no drain and no backfill — it is a live keypress
  // aimed at the room's PC. And this event has NO RESULT FRAME, so a mismatched
  // address could only be refused SILENTLY, which is the red line itself.
  // ⇒ adding an address without a receipt trades one red line for another.
  //
  // ⚠️ FAILURE DIRECTION (why this forces no deploy order): a relay older than this
  // round zod-strips the key in flight (it forwards `parsed.data`), so the PC row
  // simply cannot name the phone — i.e. it degrades to the state that existed
  // before this card, when there was no row at all. Nothing REGRESSES and no
  // judgement changes. That is the opposite of `inject_origin`, whose absence
  // CHANGED BEHAVIOUR and therefore forced deploying the relay before shipping the APK.
  device_label: NonEmpty.max(48).optional(),
});

// Sub-map spread into protocol-schemas.ts's EVENT_SCHEMAS registry so that
// file only needs one spread line per split-out module.
export const INJECT_EVENT_SCHEMAS = {
  // §3.5
  'inject:request':        InjectRequestSchema,
  'inject:result':         InjectResultSchema,
  'control:key':           ControlKeySchema,
} as const;
