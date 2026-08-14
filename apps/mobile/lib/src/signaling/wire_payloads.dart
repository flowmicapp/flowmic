// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §3 (audio:start payload), §4 (pairing entry
//     three-way: 4-digit code / QR flowmic://pair?endpoint&code[&channel] /
//     cloud instance)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 B (destination model:
//     delivery FIXED at audio:start, default 'inject'; 'none' = record-only)
//   packages/protocol/src/protocol-schemas-audio.ts (AudioStartSchema),
//   packages/protocol/src/protocol-schemas-auth.ts (MobilePairSchema)
//
// Outbound wire payload DTOs (mobile → server). Each exposes toJson() producing
// exactly the zod schema shape. Event NAMES are never here — they live at the
// emit site as generated FlowMicEvents constants.

// The ONE shape check for a fingerprint (D2LAN-B3). Imported rather than
// re-spelled: a second regex here would drift from FP_BYTES the day it moves.
import 'lan_tls_fingerprint.dart' show isWellFormedLanTlsFingerprint;

/// The three locked processing modes (04/08: realtime | translate | organize —
/// never a fourth). Wire value is the enum name.
enum FlowMode { realtime, translate, organize }

/// hold-then-send (manual) vs direct-send (default). AudioStartSchema.send_policy.
enum SendPolicy { manual, direct }

/// master-plan §4.0 B destination intent, FIXED at audio:start and immutable for
/// the whole utterance. `inject` (default) = deliver to the focused PC app;
/// `none` = record-only (server does not inject, PC capsule does not surface,
/// entry does not join room sync by default).
enum Delivery { inject, none }

/// audio:start — AudioStartSchema. delivery defaults to inject (§4.0 B); omitted
/// send_policy means direct on the server.
class AudioStartPayload {
  final FlowMode mode;
  final String sourceLang;
  final String? targetLang;
  final SendPolicy sendPolicy;
  final Delivery delivery;
  const AudioStartPayload({
    required this.mode,
    required this.sourceLang,
    this.targetLang,
    this.sendPolicy = SendPolicy.direct,
    this.delivery = Delivery.inject,
  });

  Map<String, Object?> toJson() => <String, Object?>{
    'sample_rate': 16000,
    'channels': 1,
    'encoding': 'pcm_s16le',
    'mode': mode.name,
    'send_policy': sendPolicy.name,
    'delivery': delivery.name,
    'source_lang': sourceLang,
    if (targetLang != null) 'target_lang': targetLang,
  };
}

/// InjectRequestSchema.source — the five delivery provenances
/// (packages/protocol/src/protocol-schemas-inject.ts). The 0.1.0 mobile emits
/// three of them: [stt] (direct-send — the whole utterance at PTT release),
/// [manual] (the explicit ComposeBand ➤ / Favorites) and [image] (R6 T-4, the 「+」
/// panel's album picture). `history` is minted server-side on the deferred-redelivery path; `llm`
/// belongs to a later card.
enum InjectSource { stt, llm, manual, history, image }

/// InjectRequestSchema.inject_origin — 🔴 WHY this delivery is on the wire.
///
/// owner's 2026-08-02 ruling (docs/decisions/2026-08-02-deferred-delivery-must-not-
/// autoinject.md):「a message that failed to send before and later (once back
/// online) gets backfilled to the PC — the PC side must not just inject it
/// casually — at that moment the user has no way to predict or prepare for
/// this behaviour, injecting it straight into the current input window could
/// cause an accident. Injection is a behaviour the user expects and anticipates.」
///
/// 🔴 IT IS NOT [InjectSource], AND THE TWO DISAGREE IN BOTH DIRECTIONS. `source`
/// says where the BYTES came from; this says whether a human is standing there
/// expecting them. A `source:'stt'` frame is [live] when the sentence just left the
/// user's mouth and [deferred] when the SAME queued item finally drains three hours
/// later; a `source:'history'` frame is a deferred redelivery the user PRESSED
/// and is [live].
/// Deriving one from the other is one value answering two questions, aimed at
/// the one decision that
/// types into a document.
///
/// The DECISION lives in session/outbox_inject_origin.dart — one function, and this
/// enum is only its vocabulary (same split as [FlowMode] / [InjectSource]).
enum InjectOrigin {
  /// The direct result of the user's action right now — injects exactly as it always has.
  live,

  /// Automatic backfill delivery — a reconnect drain, a PC_BUSY-release drain, anything not produced
  /// by a user action right now. 🔴 The PC does not type it, even with a live
  /// focused window; it answers `ok:false, mode:'cached',
  /// error:'INJECT_DEFERRED_NOT_AUTOINJECTED'` and the row waits on its timeline.
  deferred,
}

/// inject:request — InjectRequestSchema (M→S→PC). Protocol is FROZEN here; this
/// DTO only mirrors the existing shape.
///
/// [mode] used to be RESERVED for `source:'manual'` (F-2361 superRefine). Card P
/// (packages/protocol/src/protocol-schemas-inject.ts, row-transit round) REMOVED
/// that clause: the server no longer records a row keyed on it, so the "two
/// answers to one question" it was defending no longer has a second answer to
/// collide with (see the schema file's own long comment on why). There is now NO
/// cross-field rule between [mode] and [source] — every combination is legal —
/// so toJson writes [mode] whenever the caller supplies it, on ANY source, and
/// the constructor asserts nothing about the pairing any more. This card (M)
/// does not change WHICH call sites pass [mode] (still only the manual/
/// ComposeBand send does); it only stops the DTO from silently discarding a
/// value a future caller might legitimately send on another source.
///
/// [imageB64]/[imageMime] are the F-2350 image field-add and are STILL bound to
/// `source:'image'` by the schema's remaining superRefine, in BOTH directions:
/// an image source without them, or them without an image source, is rejected
/// at the server boundary. The constructor asserts the pairing in debug so the
/// mistake surfaces on the phone rather than as a frame that silently never
/// arrives.
class InjectRequestPayload {
  final String text;
  final InjectSource source;

  /// A-58 correlation echo. The utterance client id for a direct send; a minted
  /// `m{seq}-{micros}` for a ComposeBand send.
  final String? requestId;

  /// Exact correlation anchor when a timeline row already exists for this text.
  final String? entryId;

  /// The mode this row was PRODUCED under. No longer source-restricted (see the
  /// class doc) — still only ever supplied by the manual/ComposeBand send today.
  final FlowMode? mode;

  /// R6 T-4: canonical base64 of the picture. Image sends only.
  final String? imageB64;

  /// R6 T-4: `image/png` | `image/jpeg` | `image/webp`. Image sends only.
  final String? imageMime;

  // ── Card M — six additive optional row-transit fields ───────────────────────
  // packages/protocol/src/protocol-schemas-inject.ts, Card P round: the PC builds
  // its timeline row FROM this frame now (owner's architecture ruling,
  // transit-not-storage),
  // so every emitter has to carry what a row is made of. See ComposeGate's four
  // callers (chat_utterance.dart / manual_delivery.dart ×2 / image_send_
  // controller.dart) for how each field is actually populated.

  /// When this row was SPOKEN (or typed), never when the frame happens to be
  /// sent — a row that sat in a queue for days must not read as new on the PC
  /// (owner:「no matter how long it takes, everything must be delivered」).
  final DateTime? createdAt;

  /// The immutable ORIGINAL text, only when [text] is a PRODUCT of it
  /// (translate/organize's LLM output). `null` — sent explicitly, never
  /// omitted — means「there is no original, this IS the words」(realtime, and
  /// every plain typed/re-sent row today): the schema gives that exact meaning
  /// to an explicit null, distinct from omitting the key.
  final String? sourceText;

  /// `'image'` for a picture row; left null (⇒ omitted, server default
  /// `'transcript'`) for everything else, so a transcript frame is unchanged.
  final String? entryType;

  /// Bounded inline thumbnail (same cap as `HistoryItemSchema.thumb_b64`).
  /// Image rows only.
  final String? thumbB64;

  /// WHICH PHONE said it — `buildDeviceLabel`'s own output, so this is byte-
  /// identical to what the pairing ack already sent as `mobile_name`.
  final String? deviceLabel;

  /// owner 2026-08-02 「the speech duration needs to be recovered」 — how long
  /// the utterance took, in ms.
  /// The row's own `TimelineEntry.durationMs` (engine-reported, SttFinal), passed
  /// through verbatim. Null ⇒ omitted: typed/manual and image rows have no
  /// duration, and「absent」must reach the PC as absence, never as 0 (Book 16
  /// §6.1:
  /// null must never be treated as 0). Additive optional field, 0.2.43.
  final int? durationMs;

  /// 🔴 THE NO-CROSSTALK RED LINE (owner 2026-07-31, 「a life-or-death line,
  /// must not be crossed」). The
  /// `pc_id` this frame is addressed to — `PttSession.pcId`, the SAME value
  /// `TokenStorage`'s `MobileSession.pcId` persists. Omitted (never a guessed
  /// value) when this session has not yet learned one — see `PttSession.pcId`'s
  /// doc for when that is possible.
  final String? targetPcId;

  /// RV-68 (0.2.33 protocol round) — the WORDS an image row shows.
  ///
  /// WHY IT CANNOT RIDE IN [text]: for a picture `text` is `''` and MUST stay
  /// `''`, because a PC handed a non-empty `text` TYPES it into the user's
  /// document — 「🖼 PNG · 214 KB」 pasted into a paragraph and called a delivery
  /// (image_send_controller.dart says exactly this at its send site). So the
  /// descriptor needs its own field or the PC renders a thumbnail with not one
  /// character under it.
  ///
  /// 🔴 ONE STRING, ONE SOURCE. This is byte-identical to what the phone's own
  /// row displays (`imageEntryLabel`'s output, passed straight through) — the PC
  /// renders it verbatim and never re-derives it. A PC-side reconstruction was
  /// deliberately rejected in B1: that would be a second implementation of one
  /// display string, and the two would drift.
  ///
  /// Schema: optional, non-empty, ≤64 UTF-16 units, and a `superRefine` binds it
  /// to `entry_type:'image'` — so it is only ever set on the image send path,
  /// which already carries `entryType`.
  final String? entryCaption;

  /// 🔴 L8 (owner 2026-08-02): a live utterance vs. an automatic backfill
  /// delivery — see [InjectOrigin].
  ///
  /// ⚠️ REQUIRED HERE EVEN THOUGH IT IS OPTIONAL ON THE WIRE, and the asymmetry is
  /// the point. Every 0.2.48+ emission path has to make this judgement out loud:
  /// a defaulted `live` would let a new send site be added that quietly re-opens
  /// the accident owner's ruling exists to prevent, and the compiler is the only
  /// reviewer that never forgets. Absence on the WIRE therefore means exactly one
  /// thing — 「this end is older than 0.2.48, or someone along the way stripped
  /// it」 — instead of two.
  final InjectOrigin injectOrigin;

  const InjectRequestPayload({
    required this.text,
    required this.source,
    required this.injectOrigin,
    this.requestId,
    this.entryId,
    this.mode,
    this.imageB64,
    this.imageMime,
    this.createdAt,
    this.sourceText,
    this.entryType,
    this.thumbB64,
    this.deviceLabel,
    this.durationMs,
    this.targetPcId,
    this.entryCaption,
  }) : assert(
         (source == InjectSource.image) ==
             (imageB64 != null && imageMime != null),
         'InjectRequestSchema: source:image requires image_b64 + image_mime, '
         'and neither may appear on any other source (F-2350)',
       );

  Map<String, Object?> toJson() => <String, Object?>{
    'text': text,
    'source': source.name,
    // 🔴 ALWAYS WRITTEN, both values, never omitted — unlike every other optional
    // field on this frame. Omitting `live` would look like a harmless saving and
    // would destroy the only diagnosis this feature has: with a 0.2.48 phone
    // stamping unconditionally, an ABSENT key on the PC can ONLY mean 「it was
    // stripped along the way」
    // (a relay older than 0.2.48 — zod strips unknown keys and the relay
    // forwards `parsed.data`). If we omitted `live`, absence would mean that OR
    // 「this is a live utterance」, and 「why did a backfill delivery still get
    // injected」 would have no evidence either
    // way. Same lesson as `duration_ms` in 0.2.43, learned one round earlier.
    'inject_origin': injectOrigin.name,
    if (requestId != null && requestId!.isNotEmpty) 'request_id': requestId,
    if (entryId != null && entryId!.isNotEmpty) 'entry_id': entryId,
    // No longer gated to source:'manual' — see the class doc.
    if (mode != null) 'mode': mode!.name,
    // Written ONLY for an image send — the remaining superRefine still rejects
    // the frame if these keys appear on any other source.
    if (source == InjectSource.image) ...<String, Object?>{
      'image_b64': imageB64,
      'image_mime': imageMime,
    },
    if (createdAt != null) 'created_at': createdAt!.toUtc().toIso8601String(),
    // Always present, never conditionally omitted: an explicit JSON null IS a
    // meaningful value on this field (see [sourceText]'s doc), not an absence.
    'source_text': sourceText,
    if (entryType != null) 'entry_type': entryType,
    if (thumbB64 != null && thumbB64!.isNotEmpty) 'thumb_b64': thumbB64,
    if (deviceLabel != null && deviceLabel!.isNotEmpty)
      'device_label': deviceLabel,
    // Omit-when-null, like target_pc_id: absence means「this frame did not say」, and the
    // schema rejects negatives, so a defensive clamp is done here once.
    if (durationMs != null && durationMs! >= 0) 'duration_ms': durationMs,
    if (targetPcId != null && targetPcId!.isNotEmpty)
      'target_pc_id': targetPcId,
    // Same 「null ⇒ omit」 shape as `target_pc_id` above, and for the same
    // reason: the schema's superRefine REFUSES the key on any non-image row, so
    // an empty-string write would turn every transcript frame into a rejected
    // one. Omission is the only correct encoding of 「this row has no caption text」.
    if (entryCaption != null && entryCaption!.isNotEmpty)
      'entry_caption': entryCaption,
  };
}

/// compose:start — ComposeStartSchema.task (§3.4). Exactly the three buffer AI
/// operations the design allows (REDESIGN §6.2 ④ polish/organize/translate);
/// the schema's
/// enum has no fourth value and `realtime` is deliberately NOT accepted there
/// (realtime never enters the LLM path).
///
/// The wire literal for polish is `draft_polish`, NOT `polish` — WP-R0-1 kept it
/// out of the history-mode rename window (protocol-schemas-compose.ts §3.4
/// NOTE), so the name is frozen as-is.
enum ComposeTask {
  draftPolish('draft_polish'),
  organize('organize'),
  translate('translate');

  const ComposeTask(this.wire);

  /// The zod enum literal. Never `name` — draftPolish ≠ 'draftPolish'.
  final String wire;
}

/// compose:start — ComposeStartSchema (M→S, answered by compose:chunk* +
/// compose:done | compose:error straight back to THIS socket). Protocol is
/// FROZEN; this DTO only mirrors the existing shape.
///
/// [draft] is hard-wired true and never a constructor parameter: F-2137 defines
/// `draft:true` as the draft-origin marker meaning 「only modifies the editable
/// buffer, does not inject in the same breath」, which is exactly and only what
/// the mobile AI row does. Omitting it
/// would declare the Tier-1 auto-compose intent (compose result gets INJECTED),
/// so the flag is not optional here — an AI-row frame that could be read as
/// "inject this" is a red-line hazard, not a default.
class ComposeStartPayload {
  final ComposeTask task;

  /// The current compose buffer. Sent verbatim; the result comes back to the
  /// buffer, never to the injection path.
  final String sourceText;

  /// Omitted by default so the server resolves it (translate defaults to
  /// `en` in prompt.ts) — the mobile does not hardcode a language pair.
  final String? targetLang;

  /// The spoken language, when known (GA-01: the utterance path knows it from
  /// stt:final). Optional in ComposeStartSchema; omitted for a buffer run, where
  /// the text was typed and no STT language was ever observed — sending a guess
  /// would be worse than letting the server detect.
  final String? sourceLang;

  /// Echo key. The server copies it onto every chunk/done/error, which is how a
  /// late reply from a superseded run is discarded instead of overwriting the
  /// buffer the user has since moved on from.
  final String requestId;

  /// GA-01: the timeline row this run belongs to (ComposeStartSchema's additive
  /// `entry_id`). The server treats it as an opaque correlation token and echoes
  /// it back unchanged; the phone uses it to write the result onto the right row.
  /// Absent for a buffer run, which has no row.
  final String? entryId;

  const ComposeStartPayload({
    required this.task,
    required this.sourceText,
    required this.requestId,
    this.targetLang,
    this.sourceLang,
    this.entryId,
  });

  Map<String, Object?> toJson() => <String, Object?>{
    'task': task.wire,
    'source_text': sourceText,
    if (sourceLang != null && sourceLang!.isNotEmpty) 'source_lang': sourceLang,
    if (targetLang != null && targetLang!.isNotEmpty) 'target_lang': targetLang,
    // draft:true on EVERY compose:start, utterance runs included. 0.1.0's server
    // has no history/inject side-effect on compose at all, so this is a pure
    // marker — but it is the marker that says "the server never commits a row or
    // injects on my behalf", and the phone is the sole author of both. Keeping it
    // costs nothing and keeps that invariant stated on the wire (GA-01 ruling 7).
    'draft': true,
    if (requestId.isNotEmpty) 'request_id': requestId,
    if (entryId != null && entryId!.isNotEmpty) 'entry_id': entryId,
  };
}

/// control:key — ControlKeySchema.kind
/// (packages/protocol/src/protocol-schemas-inject.ts; renamed from the legacy
/// flow-message in the WP-R0-1 window, 04 §3.7). These act on the PC's FOCUSED
/// window, never on the local compose buffer.
///
/// TWO FAMILIES, and the enum name IS the wire value in both:
///   · the six CHORD keys — the desktop maps each to a virtual-key sequence;
///   · the six `punct*` keys (v0.2.1) — the desktop TYPES the glyph instead,
///     because full-width CJK punctuation has no virtual key.
///
/// The `punct` family reverses 08 §5's「punctuation is LOCAL」on owner's 2026-07-28
/// ruling: tapping 。 completes the sentence that is already on the PC, so
/// putting it in a compose box here was making the user take two more steps to
/// reach the place they meant.
enum ControlKeyKind {
  enter,
  backspace,
  undo,
  clear,
  tab,
  space,
  punctComma,
  punctQuestion,
  punctExclamation,
  punctEnumeration,
  punctColon,
  punctPeriod,
}

/// The literal each punctuation kind produces. Mirrors `CONTROL_KEY_PUNCTUATION`
/// in packages/protocol — the phone renders the glyph on the button and the
/// desktop types it from its own copy of the table, so the WIRE only ever
/// carries the kind. `null` for the chord kinds.
String? controlKeyGlyph(ControlKeyKind kind) => switch (kind) {
  ControlKeyKind.punctComma => '，',
  ControlKeyKind.punctQuestion => '？',
  ControlKeyKind.punctExclamation => '！',
  ControlKeyKind.punctEnumeration => '、',
  ControlKeyKind.punctColon => '：',
  ControlKeyKind.punctPeriod => '。',
  ControlKeyKind.enter ||
  ControlKeyKind.backspace ||
  ControlKeyKind.undo ||
  ControlKeyKind.clear ||
  ControlKeyKind.tab ||
  ControlKeyKind.space => null,
};

/// Dart's `camelCase` enum names are not the wire's `snake_case` kinds, and the
/// server's zod enum is the authority. Mapped explicitly rather than by string
/// mangling: a mangling rule is a second place for the two to drift.
String controlKeyWireName(ControlKeyKind kind) => switch (kind) {
  ControlKeyKind.punctComma => 'punct_comma',
  ControlKeyKind.punctQuestion => 'punct_question',
  ControlKeyKind.punctExclamation => 'punct_exclamation',
  ControlKeyKind.punctEnumeration => 'punct_enumeration',
  ControlKeyKind.punctColon => 'punct_colon',
  ControlKeyKind.punctPeriod => 'punct_period',
  ControlKeyKind.enter ||
  ControlKeyKind.backspace ||
  ControlKeyKind.undo ||
  ControlKeyKind.clear ||
  ControlKeyKind.tab ||
  ControlKeyKind.space => kind.name,
};

/// control:key — ControlKeySchema. `payload` is an untyped escape hatch we never
/// use, so the wire shape is `{kind}` plus the one additive field below.
///
/// REQ-12-13 (2026-08-12): [deviceLabel] — WHICH PHONE pressed it. Additive
/// optional on an already-whitelisted event (Book 04 F-3115, contract Book 15 §2.0-e).
/// The desktop now mints a PC timeline row per remote key press, and a PC is a
/// SHARED destination — two phones deliver into one timeline — so a row that
/// cannot say where it came from is what makes crosstalk invisible.
///
/// 🔴 OMITTED WHEN NULL, never sent as `''`: `NonEmpty` refuses an empty string at
/// the server boundary, and a refusal there is anonymous (the frame dies as a zod
/// error naming no field). Same 「omit when null」 shape `target_pc_id` uses.
///
/// 🔴 NO `target_pc_id` HERE, and that is the ruling rather than an omission —
/// this event has no queue (nothing re-derives 「whoever is connected now」 at
/// drain time) and no result frame (a mismatched address could only be refused
/// SILENTLY). See the long note at `ControlKeySchema.device_label`.
class ControlKeyPayload {
  final ControlKeyKind kind;
  final String? deviceLabel;
  const ControlKeyPayload(this.kind, {this.deviceLabel});
  Map<String, Object?> toJson() => <String, Object?>{
    'kind': controlKeyWireName(kind),
    if (deviceLabel != null && deviceLabel!.isNotEmpty) 'device_label': deviceLabel,
  };
}

/// audio:pause — AudioPauseSchema (carries a non-empty reason, e.g.
/// 'background' when the app is backgrounded so the PC capsule collapses).
///
/// Card F1 (anti-façade ④): the「so the PC capsule collapses」half was an assertion
/// about another end that had NO implementation — grep for a desktop handler
/// returned zero until this card. It is now true, and its anchors are
/// `AUDIO_PAUSE` in apps/desktop/src-tauri/src/socket/fanout.rs
/// (`on_capsule_audio_edges`) and `onAudioPause` in
/// apps/desktop/src/capsule/controller.ts.
class AudioPausePayload {
  final String reason;
  const AudioPausePayload(this.reason);
  Map<String, Object?> toJson() => <String, Object?>{'reason': reason};
}

// AudioHeartbeatPayload was deleted on 2026-07-31 together with the
// `audio:heartbeat` event (stage-5 protocol cleanup): this app emitted it every
// 5 s and no server has ever listened. Its only field, last_chunk_seq, existed
// to drive a server-side gap-replay loop that was never built. Liveness is
// unaffected — the plain `heartbeat` below rides the SAME timer and IS handled.

/// heartbeat — HeartbeatSchema.
class HeartbeatPayload {
  final int ts;
  const HeartbeatPayload(this.ts);
  Map<String, Object?> toJson() => <String, Object?>{'ts': ts};
}

/// sys:pong — SysPongSchema (reply to sys:ping).
class SysPongPayload {
  final String nonce;
  final bool ok;
  const SysPongPayload({required this.nonce, this.ok = true});
  Map<String, Object?> toJson() => <String, Object?>{'nonce': nonce, 'ok': ok};
}

/// mobile:reconnect — MobileReconnectSchema.
class MobileReconnectPayload {
  final String token;

  /// v0.2.4 — this handset's machine-level id. On reconnect the row is already
  /// found by token, so this is a pure BACKFILL: it is how a pairing made by a
  /// pre-0.2.4 build learns which phone it belongs to, and it can never move
  /// the connection to a different row.
  final String? deviceUid;
  const MobileReconnectPayload(this.token, {this.deviceUid});
  Map<String, Object?> toJson() => <String, Object?>{
    'token': token,
    if (deviceUid != null && deviceUid!.isNotEmpty) 'device_uid': deviceUid,
  };
}

/// mobile:pair — MobilePairSchema (union: short_code | qr_payload |
/// cloud_instance). Built via the [PairEntry] parser so the dial endpoint is
/// resolved alongside the wire payload.
class MobilePairPayload {
  final String? shortCode;
  final String? qrPayload;
  final bool cloudInstance;

  /// 0.2.66 — the relay's per-PC public address (9 decimal digits), typed by
  /// hand beside the 4-digit code. Additive and optional exactly like
  /// [mobileName]/[deviceUid] below: omitted, this is byte-for-byte the frame
  /// 0.2.65 sent, which is what keeps LAN pairing unchanged (design §3 rows 1-2
  /// — 「LAN has no PCID」).
  ///
  /// 🔴 SHORT-CODE ARM ONLY. A QR carries its own `pcid=` inside the link and
  /// the phone forwards that link VERBATIM ([PairEntry.parse]), so putting a
  /// second copy beside it would be two answers to 「which one is being paired
  /// with」. The
  /// cloud-instance arm addresses no PC at all.
  final String? pcid;
  const MobilePairPayload.shortCode(String code, {this.pcid})
    : shortCode = code,
      qrPayload = null,
      cloudInstance = false;
  const MobilePairPayload.qrPayload(String payload)
    : shortCode = null,
      qrPayload = payload,
      cloudInstance = false,
      pcid = null;
  const MobilePairPayload.cloudInstance()
    : shortCode = null,
      qrPayload = null,
      cloudInstance = true,
      pcid = null;

  /// owner 2026-07-27: this phone's own name (「model-<4-digit device
  /// fingerprint>」). Additive and
  /// optional on every variant — omitted, the server still mints its
  /// `Phone-<4>` fallback, so an unnamed client behaves exactly as before.
  ///
  /// v0.2.4 [deviceUid] rides in the same slot and is what the server actually
  /// keys 「this phone is back」 on. Both stay optional: a phone that can supply
  /// neither is exactly the pre-0.2.4 client, and that path still works.
  Map<String, Object?> toJson({String? mobileName, String? deviceUid}) {
    final Map<String, Object?> named = <String, Object?>{
      if (mobileName != null && mobileName.isNotEmpty) 'mobile_name': mobileName,
      if (deviceUid != null && deviceUid.isNotEmpty) 'device_uid': deviceUid,
    };
    if (cloudInstance) return <String, Object?>{'cloud_instance': true, ...named};
    if (shortCode != null) {
      return <String, Object?>{
        'short_code': shortCode,
        // Same omit-when-empty shape as the two named fields above, and for the
        // same reason: an old relay strips the unknown key and a new relay
        // treats「not carrying one」as「a bare code」, so the absent case must
        // stay literally absent
        // rather than a null the schema would have to tolerate.
        if (pcid != null && pcid!.isNotEmpty) 'pcid': pcid,
        ...named,
      };
    }
    return <String, Object?>{'qr_payload': qrPayload, ...named};
  }
}

/// A resolved pairing entry: the wire [payload] plus the [endpoint] the mobile
/// must dial. For a bare 4-digit code the endpoint is unknown (the caller
/// supplies a default / previously-known standalone endpoint); a QR carries its
/// own endpoint (08 §4: "dial the PC's real LAN IP using the endpoint carried
/// inside the QR").
class PairEntry {
  final MobilePairPayload payload;
  final String? endpoint;

  /// D2LAN-B3 — the QR's `fp=`: the SPKI fingerprint of the sidecar's LAN TLS
  /// key (apps/server-core/src/lan-tls/fingerprint.ts, symbol `spkiFingerprint`).
  ///
  /// `null` for a bare 4-digit code, for a hand-typed address, for the
  /// cloud-instance
  /// entry, and for a QR minted by a sidecar serving plain — four different
  /// situations that share one property: THIS PAIRING HAS NOTHING TO PIN. What
  /// they do NOT share is what the phone does next (TOFU vs. plain vs. the
  /// relay's real CA chain), which is why that decision is not made here.
  final String? fingerprint;

  const PairEntry({required this.payload, this.endpoint, this.fingerprint});

  /// Parse raw user/scan input into a PairEntry.
  ///   - `1234`                                → short_code (endpoint = null)
  ///   - `flowmic://pair?endpoint=ws://..&code=1234[&channel=..]` → qr_payload
  ///     (endpoint extracted from the QR)
  /// Throws [FormatException] on anything else so the caller surfaces a
  /// fail-loud pairing error (08 §4 four-way error classification is a UI card).
  ///
  /// 0.2.66 — [pcid] rides the SHORT-CODE arm only (design §7-3). A link
  /// already carries its own `pcid=` and is forwarded verbatim, so a value
  /// passed alongside one is dropped here rather than duplicated onto the
  /// frame: 「which one the QR code says it is」 has exactly one author.
  static PairEntry parse(String raw, {String? pcid}) {
    final String input = raw.trim();
    if (RegExp(r'^\d{4}$').hasMatch(input)) {
      return PairEntry(payload: MobilePairPayload.shortCode(input, pcid: pcid));
    }
    if (input.startsWith('flowmic://pair')) {
      final Uri uri = Uri.parse(input);
      final String? endpoint = uri.queryParameters['endpoint'];
      final String? code = uri.queryParameters['code'];
      if (code == null || !RegExp(r'^\d{4}$').hasMatch(code)) {
        throw const FormatException('QR payload missing a 4-digit code');
      }
      // D2LAN-B3 — additive-optional, exactly like `alt=`: a payload without it
      // parses byte-for-byte as it always did.
      //
      // 🔴 PRESENT-BUT-MALFORMED IS A REFUSAL, not a shrug. Dropping it would
      // pair in the clear while the desktop believes it published a pin, and the
      // phone would show 「unencrypted」 for a PC that is in fact serving TLS —
      // a wrong
      // status word with no failure anywhere (R11). `buildQrPayload` cannot emit such a
      // value (it drops one it cannot carry intact), so seeing one means the
      // payload was edited on its way here, and that is worth stopping for.
      final String fp = (uri.queryParameters['fp'] ?? '').trim();
      if (fp.isNotEmpty && !isWellFormedLanTlsFingerprint(fp)) {
        throw const FormatException('QR payload carries a malformed fp=');
      }
      return PairEntry(
        payload: MobilePairPayload.qrPayload(input),
        endpoint: (endpoint != null && endpoint.isNotEmpty) ? endpoint : null,
        fingerprint: fp.isEmpty ? null : fp,
      );
    }
    throw FormatException('unrecognized pairing input: $raw');
  }

  /// The fixed 「cloud instance」 solo-session entry (no code, no PC peer).
  static PairEntry cloud({String? endpoint}) => PairEntry(
    payload: const MobilePairPayload.cloudInstance(),
    endpoint: endpoint,
  );
}
