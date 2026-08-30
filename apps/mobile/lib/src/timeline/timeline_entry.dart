// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 A (utterance = entry;
//     source_text immutable; injected snapshot on the processed side), §4.0 D
//     (status enum = injected|cached|failed|noted; `edited` split into an
//     independent boolean bit — fixes the legacy injected→edited info loss)
//   docs/rebuild/08-MOBILE-SPEC.md §7 (local timeline table + loc_ idempotency
//     key lineage, F-2367)
//   packages/protocol/src/protocol-schemas-sync.ts (HistoryItemSchema:
//     status enum, additive `edited` bit)
//
// The lean 0.1.0 timeline entry. This is deliberately NOT the legacy 26-field
// E2EE model — E2EE cloud sync is out of 0.1.0 (master-plan §4.2). It carries
// exactly what the chat flow renders, what room-sync (history:create) needs on
// the wire, and what local persistence round-trips. `source_text` is written
// once at build time and never mutates (there is no sourceText parameter on
// copyWith); editing moves the display face (`outputText`) and sets `edited`.

import '../signaling/wire_payloads.dart' show FlowMode, Delivery;

// The device-local JSON codec. Split out at the 800-line cap; see that file's
// header for the cut and the one mechanical edit it carries.
part 'timeline_entry_codec.dart';

/// master-plan §4.0 D: status records DELIVERY TRUTH ONLY. Five badges in the
/// UI = these four statuses plus the orthogonal [TimelineEntry.edited] overlay.
///
/// N2 / RV-43 §1 re-defined what each WORD means (the SET is unchanged, and the
/// protocol is untouched):
enum EntryStatus {
  /// ✓ delivered to the keyboard focus while that focus was accepting input
  /// (RV-43 §1 — narrower than the old 「目标应用收下了这段字」("the target app
  /// accepted this text")).
  injected,

  /// **Two faces, and telling them apart is the whole of N2.**
  ///
  /// * 投递中 ("in delivery") — this row is still WAITING for a delivery truth
  ///   (born here, or
  ///   put back here by a deferred delivery (补投)). [TimelineEntry.cachedByVerdict]
  ///   is false.
  /// * 未投递 ("not delivered") — a verdict actually came back saying
  ///   `mode:'cached'`: nothing was
  ///   delivered and it can be re-sent. [TimelineEntry.cachedByVerdict] is true.
  ///
  /// One status, because RV-43 adds no fifth state and no protocol field. The
  /// two faces are a DISPLAY distinction the phone can draw on its own, and
  /// drawing it is mandatory: showing 「waiting」 and 「did not happen」 as the
  /// same pill is this repo's headline bug shape (一个值答两个问题 / "one value
  /// answers two questions").
  cached,

  /// ✗ we know it did not succeed — either the precondition failed (the focus
  /// was not accepting input) or the action itself failed (RV-43 §1). Never
  /// silent (red line).
  failed,

  /// 📥 neutral grey — record-only (`delivery:'none'`): the utterance was
  /// captured but was never meant for the PC. "留在手机" ("stays on the phone").
  noted;

  String get wire => name;

  static EntryStatus fromWire(Object? v) {
    switch (v) {
      case 'injected':
        return EntryStatus.injected;
      case 'failed':
        return EntryStatus.failed;
      case 'noted':
        return EntryStatus.noted;
      case 'cached':
      default:
        return EntryStatus.cached;
    }
  }
}

/// F-3112 injection provenance — the window an utterance landed in. Mirrors
/// InjectTargetSchema (window_title / process_name / injected_at).
class InjectTarget {
  final String windowTitle;
  final String processName;
  final String injectedAt;
  const InjectTarget({
    required this.windowTitle,
    required this.processName,
    required this.injectedAt,
  });

  static InjectTarget? tryParse(Object? raw) {
    if (raw is! Map) return null;
    final Object? proc = raw['process_name'];
    if (proc is! String || proc.isEmpty) return null;
    return InjectTarget(
      windowTitle: raw['window_title'] is String
          ? raw['window_title'] as String
          : '',
      processName: proc,
      injectedAt: raw['injected_at'] is String
          ? raw['injected_at'] as String
          : '',
    );
  }

  Map<String, Object?> toJson() => <String, Object?>{
    'window_title': windowTitle,
    'process_name': processName,
    'injected_at': injectedAt,
  };
}

class TimelineEntry {
  TimelineEntry({
    required this.id,
    required this.clientId,
    required this.mode,
    required this.delivery,
    required this.sourceText,
    required this.outputText,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
    this.sourceLang,
    this.outputLang,
    this.processMode,
    this.processedText,
    this.refinedAt,
    this.injectTarget,
    this.pcName,
    this.spokenToInstanceId,
    this.spokenToInstanceName,
    this.edited = false,
    this.durationMs,
    this.segmentsCount = 0,
    this.origin = 'paired',
    this.deleted = false,
    this.entryType = kTranscript,
    this.thumbB64,
    this.controlKind,
    this.failureReason,
    this.cachedByVerdict = false,
    this.lastResentAt,
    this.articleId,
    this.articleOffsetMs,
  });

  /// [entryType] values. The first pair mirrors `TimelineEntry.entry_type` in
  /// packages/protocol/src/types.ts — the SAME two values, deliberately not a
  /// third one invented there.
  static const String kTranscript = 'transcript';
  static const String kImage = 'image';

  /// 🔴 REQ-12-13 (owner P0 2026-08-12) — a REMOTE KEY PRESS this phone sent
  /// (clear / backspace / undo / enter). Contract: docs/rebuild/15 §2.0-e.
  ///
  /// **DEVICE-LOCAL, AND UNLIKE [kImage] IT STAYS THAT WAY.** owner lifted the
  /// device-local restriction on `entry_type` in 2026-07-27 so a picture could
  /// say what it was on the wire; this value is NOT part of that. The protocol's
  /// `EntryTypeSchema` still has exactly two members on purpose — if a frame could
  /// claim `entry_type:'control'`, a phone could send an `inject:request` carrying
  /// text to type while calling itself a keypress row. The author of a control row
  /// can only be the end that performed the act, so [toHistoryItem] never emits it
  /// and no `inject:request` ever carries it.
  ///
  /// 🔴 EVERY PREDICATE THAT OFFERS A ROW AN ACTION MUST NAME ITS KIND POSITIVELY.
  /// Before this card the repo asked `!isImage` everywhere — an OPEN test — so a
  /// third kind silently inherited resend / deferred-delivery / edit / rerun
  /// (重发 / 补投 / 编辑 / 重跑), and deferred delivery (补投) re-delivers a
  /// row's text. See [isControl] for the predicate that closes them.
  static const String kControl = 'control';

  /// 🔴 CR-7 — THE HEAD OF ONE CONTINUOUS RECORDING (「一篇」/ "a piece").
  ///
  /// **DEVICE-LOCAL, for the same structural reason as [kControl] and not a
  /// weaker one.** The protocol's `EntryTypeSchema` still has exactly two
  /// members; an article head carries no words of its own — its text is a
  /// TITLE, derived from the first segment — so a frame that could claim
  /// `entry_type:'article'` would be a frame carrying prose the receiving end
  /// is told not to read as prose. [toHistoryItem] never emits it.
  ///
  /// ⚠️ **IT IS A HEAD, NOT A CONTAINER.** Ruling 4.C 乙 keeps the segment as
  /// the row: every segment of a continuous recording is an ordinary
  /// [kTranscript] row that settles, recovers, syncs and exports exactly as it
  /// always did, and the only new thing on it is [articleId]. The head holds
  /// what is true of the WHOLE — when it started, how long, how many segments,
  /// its title — because those are questions no single segment can answer.
  /// Option 甲 (the whole recording in one row) was refused because it would
  /// undo 「段＝可独立结算单元」("a segment is an independently settleable
  /// unit"): one failure would then cost the entire recording.
  ///
  /// 🔴 A HEAD IS NEVER THE ANSWER TO 「what did the user say」. It has no
  /// [sourceText]; nothing may re-deliver, re-inject, edit-as-text or count its
  /// words as speech. Every predicate that offers a row an action names its
  /// kind positively for exactly this reason (see [kControl]).
  static const String kArticle = 'article';

  /// The idempotency key. `loc_{deviceId}_{clientId}` for a phone-minted entry
  /// (F-2367 lineage); a server-synced entry keeps the server id verbatim.
  final String id;

  /// The utterance client id (`u{seq}-{micros}`) — also the inject `request_id`
  /// / re-inject correlation anchor.
  final String clientId;

  final FlowMode mode;

  /// The delivery intent fixed at audio:start. Immutable for the utterance;
  /// the entry can still be re-injected after the fact (long-press deferred
  /// delivery / 补投).
  final Delivery delivery;

  /// The immutable original transcript (master-plan §4.0 A). Written once.
  final String? sourceText;

  /// The display / delivered face. == [sourceText] for a plain realtime entry;
  /// diverges when a compose result overlays it, or when the user edits.
  final String outputText;

  final String? sourceLang;
  final String? outputLang;

  /// 'translate' | 'organize' | null (realtime). Non-null ⇒ the UI shows the
  /// 「原文」("original text") source line.
  final String? processMode;

  /// The compose product (translate/organize), when one exists.
  final String? processedText;

  /// GA-14: when a two-pass refine replaced this row's text, or null. A
  /// DISPLAY marker only — the row is otherwise an ordinary row, and the bit
  /// is deliberately NOT `edited` (that one means 「人改过」("a human edited it")).
  final DateTime? refinedAt;

  final InjectTarget? injectTarget;

  /// owner 2026-07-27:「手机端要有 PC端实例名 → 目标 的信息」("the phone side needs
  /// PC-side instance name → target information").
  ///
  /// The PC this row was DELIVERED to, stamped alongside [injectTarget] at the
  /// moment the result came back. Deliberately stored per-row instead of read
  /// live from the current pairing: a phone can be paired to more than one PC
  /// over its life, and rendering today's PC name against yesterday's row would
  /// be a confident lie about where that utterance went.
  ///
  /// DEVICE-LOCAL — never on the wire. The console resolves the same fact
  /// server-side (by id, so a rename shows through); the phone keeps what it
  /// saw, because it is the only end that knows which PC it was talking to.
  final String? pcName;

  /// V2-06a-1 (requirement ④ (需求④) 「进到某个 PC 实例里，只显示与该实例相关的历史」
  /// ("when entering a specific PC instance, only show history related to
  /// that instance")).
  ///
  /// WHICH INSTANCE THIS WAS SAID TO — the stable
  /// [MobileSession.connectionIdentity] of whatever the phone was connected to
  /// at the moment the row was created.
  ///
  /// Deliberately NOT merged with [pcName], and the difference is the whole
  /// point. `pcName` is stamped only where a row actually LANDED
  /// (`timeline_store.dart`: `pcName: ok ? pcName : null`), so on `noted` rows
  /// (「留在手机」/ "stays on the phone") and on failed ones it is null forever.
  /// Filtering an
  /// instance's view by `pcName` would therefore silently drop exactly the rows
  /// the user chose to keep on the phone — betraying the feature it was meant
  /// to serve. One field records 「说给谁」("who it was said to"), the other
  /// 「落到哪」("where it landed"), and on a
  /// noted row they are legitimately different.
  ///
  /// **Null on legacy rows, and that is the truth.** Rows written before this
  /// field existed have no owner and must render as unknown-instance
  /// (未知实例) in the all-history (全部历史)
  /// view while appearing in NO instance's narrowed view. Adopting them into
  /// 「whoever is connected right now」 would make history lie — the same red
  /// line as requirement ③'s (需求③) ban on back-filling `now` onto old pairings.
  final String? spokenToInstanceId;

  /// The instance's display name **as it read at the time**, not looked up live.
  ///
  /// Same reasoning as [pcName]: the name (名字) lives in token_storage, so once the
  /// user swipes a pairing away a live lookup blanks the 「目标」("target") column for
  /// that whole batch of history. History is a record of what happened; it has
  /// to carry its own name.
  final String? spokenToInstanceName;

  /// master-plan §4.0 D: delivery truth. See [EntryStatus].
  final EntryStatus status;

  /// master-plan §4.0 D: orthogonal overlay bit. Absence = an un-edited row.
  final bool edited;

  final int? durationMs;
  final int segmentsCount;

  /// 'paired' (a PC-bound utterance) | 'cloud' (a cloud-instance record).
  final String origin;

  // `syncState` ('local_only' | 'synced') was REMOVED in 0.2.27. It answered
  // 「服务器上有没有这一行」("whether this row exists on the server"), and
  // owner's architecture ruling (架构裁定) (cloud does not store transcripts /
  // 云端不存转录) removed the server
  // copy the question was about — see the retirement block in timeline_store.dart.
  // It is deleted rather than frozen at one value: a field every row carries,
  // that answers a question nobody can ask, is read by the next person as if it
  // still meant something. No migration is needed — it lived only inside the
  // sqlite `payload` JSON (never a projected column, never on the wire), so an
  // old row's key is simply ignored on read and dropped on the next write.
  // ⚠️ NOT a substitute for it: window B's persistent outbox will need to know
  // 「这条投出去了吗」("was this one sent out"), which is a DIFFERENT question (and `status` already answers
  // the delivery half). Re-using this name for that would be the one-value-two-
  // questions shape all over again — give it its own field.

  final bool deleted;

  /// R6 T-4: [kTranscript] (spoken or typed words) | [kImage] (a picture the
  /// user sent from the 「+」 panel). Written once at build time and never
  /// mutated — a row does not change what it IS, only what happened to it.
  ///
  /// **DEVICE-LOCAL ONLY, and deliberately so.** `HistoryItemSchema`
  /// **owner 2026-07-27 lifted this.** It USED to be device-local: the schema
  /// had no `entry_type`, the protocol was frozen for that card, and emitting a
  /// key zod would strip is worse than not shipping it — so the PC inferred
  /// imageness from its own inject path, i.e. guessed about someone else's row,
  /// and a picture synced as a line of prose (「🖼 PNG · 78 KB」). With the
  /// protocol change authorised, [toHistoryItem] now emits `entry_type` (and
  /// `thumb_b64`) as additive optional fields.
  final String entryType;

  /// owner 2026-07-27: the bounded inline thumbnail (longest edge 256 px,
  /// base64, no data: prefix) that makes a picture row recognisable here, on the
  /// PC and in the console. Null on every transcript row and on a picture whose
  /// thumbnail could not be produced — a missing preview never blocks the send.
  final String? thumbB64;

  /// 🔴 CR-7 — WHICH continuous recording (「一篇」) this row belongs to, or null
  /// for every row that belongs to none (which is almost all of them).
  ///
  /// It is BOTH a projected sqlite column and a payload key, and that
  /// duplication is the design (4.C 乙), not an oversight:
  ///   · the COLUMN is what makes 「list the articles」 and 「the rows of this
  ///     article」 indexed queries instead of a whole-table decode — the exact
  ///     cost `LightRecordQuery` documents itself paying for `origin`;
  ///   · the PAYLOAD key is what makes the grouping survive BLIND-STORE SYNC.
  ///     The cloud copy is ciphertext (`e2e:v1:`); the server cannot store a
  ///     column it never receives, and a phone restoring from the blind store
  ///     gets back exactly the JSON it uploaded. A grouping that lived only in
  ///     the column would evaporate on restore and the user would find a
  ///     recording scattered into loose lines.
  ///
  /// ⚠️ The two are written from ONE value at ONE moment (the store's builders)
  /// and never edited afterwards, so they cannot drift. A row does not change
  /// which recording it came from.
  final String? articleId;

  /// 🔴 CR-8 — where this row starts INSIDE its article, in milliseconds of
  /// recorded audio counted from the article's first byte.
  ///
  /// **AUDIO TIME, NOT WALL-CLOCK TIME, AND NOT ARRIVAL TIME.** The offset is
  /// the sum of the durations of everything recorded before it in this article
  /// — engine-reported `duration_ms` for a live segment, bytes ÷ 32,000 for a
  /// stretch recorded while the link was down. Both are properties of the audio
  /// itself.
  ///
  /// 🔴 THE BANNED SOURCE IS 「when the final reached this phone」. That value is
  /// sitting right there, it looks like a timestamp, and it is systematically
  /// late by the engine's own latency — one value (arrival) answering a
  /// different question (when it was said). Doc §4.D names it explicitly.
  ///
  /// Null on every row outside an article, and null on an article HEAD (a head
  /// has no position inside itself).
  final int? articleOffsetMs;

  /// 🔴 REQ-12-13 — WHICH remote key this row records (`clear` / `backspace` /
  /// `undo` / `enter`). Non-null **if and only if** [entryType] is [kControl];
  /// null on every other row. Contract: docs/rebuild/15 §2.0-e.
  ///
  /// **THE ROW'S WHOLE CONTENT IS THIS FIELD**, and the face is composed from it
  /// at render time rather than stored in [outputText]. Two reasons, both concrete:
  /// ① a sentence written at mint time would be frozen in the app language of that
  /// moment, and rows outlive a language switch; ② [outputText] is what
  /// resend (重发)/deferred delivery (补投)
  /// re-delivers — a row with no text is a row nothing can accidentally re-send.
  ///
  /// 🔴 **[status] IS NOT THIS ROW'S ANSWER, AND MUST NOT BE READ AS ONE.** The ⌨
  /// segment has exactly one thing this phone can prove — 「帧离开了本机」("the
  /// frame left this device") — and the
  /// row's EXISTENCE is that statement (it is only ever minted after
  /// `sendControlKey` returned true; a key that never left the device raises the
  /// compose banner instead, and mints nothing). `EntryStatus` answers 「投递真相」
  /// ("delivery truth"),
  /// a different question, and this end can never answer it here: `control:key` has
  /// no receipt frame, so 「电脑收到了吗」("did the computer receive it") has no
  /// evidence on this side at all
  /// (docs/rebuild/15 §6 G-24).
  ///
  /// ⚠️ **One honest deviation, stated explicitly (一处诚实偏差，明写)**: the
  /// column is non-null, so a control row still
  /// carries a status — [EntryStatus.noted]. It is chosen because it is the only
  /// value whose failure mode is a LOW claim rather than a high one: if some future
  /// caller renders it despite the guards, the user reads 「留在手机」("stays on
  /// the phone") rather than
  /// 「已投递」("delivered"). Everything that could read it is gated on
  /// [isControl] instead
  /// (`deliveryFaceOf` is never asked, resend/deferred-delivery/edit/rerun
  /// (重发/补投/编辑/重跑) are withheld, the word
  /// count returns null, the export excludes the row).
  ///
  /// **DEVICE-LOCAL** — same shape as [failureReason] / [cachedByVerdict]: it
  /// round-trips through [toJson]/[fromJson] (i.e. the sqlite `payload` column, no
  /// migration) and is deliberately absent from [toHistoryItem] and from every
  /// `inject:request` frame.
  final String? controlKind;

  /// Named delivery-failure code (e.g. `INJECT_NO_RESULT`, `LINK_DOWN`).
  /// DEVICE-LOCAL only — never on the wire ([toHistoryItem] does not emit it).
  ///
  /// [copyWith] uses `failureReason ?? this.failureReason`, so passing null
  /// cannot clear a prior value: a landed row may keep a stale reason; the UI
  /// only reads it while status is failed.
  final String? failureReason;

  /// N2 / RV-43 §4.1 — WHY this row sits at [EntryStatus.cached].
  ///
  /// True ⇒ a delivery verdict came back and it said `mode:'cached'`
  /// (「没有投递，留着可以补投」("not delivered — keep it, it can be
  /// redelivered later")). False ⇒ the row is still WAITING for a verdict.
  ///
  /// This exists because RV-43 forbids both a fifth status and a protocol
  /// field, while §4 requires 投递中("in delivery") and 未投递("not
  /// delivered") to READ differently. Without it
  /// the amber pill would answer two different questions with one word — the
  /// bug shape CLAUDE.md §3 names as this repo's number one. It answers exactly
  /// one: 「是判决说的，还是还在等判决？」("is this what the verdict said, or is
  /// it still waiting for a verdict?")
  ///
  /// **DEVICE-LOCAL only** — same shape as [failureReason]: it round-trips
  /// through [toJson]/[fromJson] and is deliberately absent from
  /// [toHistoryItem]. Nothing on the wire changes, and no peer has to learn it.
  ///
  /// Unlike [failureReason], [copyWith] CAN clear it: the parameter is `bool?`,
  /// so passing `false` writes false (only `null` means 「不变」("unchanged")).
  /// `markReinjecting`
  /// relies on that — a row going back to 投递中("in delivery") must stop
  /// claiming a verdict.
  final bool cachedByVerdict;

  /// owner 2026-07-31 real-device (真机):「如果是重发，最好是在手机端也显示一下重发的时间，这样好
  /// 识别区分，但原时间也要保留，即在原消息上显示一个最后的重发时间」("if it's a
  /// resend, it would be best to also show the resend time on the phone side,
  /// so it's easier to identify and distinguish, but the original time should
  /// also be kept — i.e. show a 'last resent at' time on the original
  /// message").
  ///
  /// WHEN this row was last put back into delivery by a resend/deferred
  /// delivery (重发/补投), or **null on a
  /// row nobody ever re-sent** — and that null is load-bearing, not a gap. The
  /// tile renders nothing for it (`chat_message_tile.dart`), because a field that
  /// forever shows 「—」 is worse than no field at all (CLAUDE.md red line:
  /// a control that can't change anything is worse than no control at all /
  /// 一个改变不了任何东西的控件比没有控件更坏).
  ///
  /// **IT RECORDS THE ACT, NOT ITS OUTCOME**, and that split is the whole design.
  /// 「什么时候重发的」("when was it resent") and 「重发成功了吗」("did the
  /// resend succeed") are two questions; [status] (+
  /// [failureReason]) already owns the second one, and red line 「status 只记投递真相」
  /// ("status only records delivery truth")
  /// is a constraint on THAT field, not a ban on recording the act elsewhere.
  /// Stamping this one only on success would make one value answer both — this
  /// repo's headline bug shape — and would leave a re-send that failed with NO
  /// trace at all, so the user cannot tell whether today's ✗ came from the
  /// original send or from the resend (重发) he pressed five minutes ago. That
  /// is the exact
  /// confusion owner asked to remove (「这样好识别区分」/ "this way it's easier
  /// to tell apart").
  ///
  /// **Both ends are deliberately asymmetric — do not casually unify them
  /// (两端刻意不对称——不要顺手统一).** On the PC a redelivery (重投) is a NEW
  /// ROW stamped with
  /// the re-delivery instant (RV-72, owner 2026-07-31; PC timeline = delivery
  /// log / PC 时间线 = 投递日志). Here
  /// the row is the OWNER of the utterance, so it keeps its original
  /// [createdAt], keeps its place in the list, and merely gains this extra
  /// instant. Two different answers on the two ends is the ruling, not a drift.
  ///
  /// **DEVICE-LOCAL only** — same shape as [failureReason] / [cachedByVerdict]:
  /// it round-trips through [toJson]/[fromJson] (and therefore through the
  /// sqlite `payload` column, no migration) and is deliberately absent from
  /// [toHistoryItem] and from every `inject:request` frame. Nothing on the wire
  /// changes and no peer has to learn it.
  ///
  /// Like [refinedAt], [copyWith] cannot clear it (`?? this.lastResentAt`): a
  /// row that has been re-sent once has been re-sent, forever.
  final DateTime? lastResentAt;

  /// The row is waiting for a delivery truth that has not arrived yet (⏳
  /// 投递中 / "in delivery").
  ///
  /// This — not `status == cached` — is what 「还在等回执」("still waiting for
  /// a receipt") means now, so every
  /// caller that used to ask the status gets the narrower question it actually
  /// wanted (see `TimelineStore.lastAwaitingInject` / `markNoted`).
  bool get awaitingDelivery =>
      status == EntryStatus.cached && !cachedByVerdict;

  /// A verdict said it was NOT delivered and can be re-sent (📥 未投递 / "not
  /// delivered").
  bool get undelivered => status == EntryStatus.cached && cachedByVerdict;

  /// True for a picture row — the 🖼 face, the withheld edit (编辑) action, and the
  /// suppressed original-text (原文) line all key off this.
  bool get isImage => entryType == kImage;

  /// REQ-12-13 — true for a REMOTE KEY PRESS row (⌨). See [kControl].
  ///
  /// 🔴 Read it as 「这一行不是一句话」("this row is not a sentence"), not as
  /// 「这一行是特殊的」("this row is special"): the row has no
  /// [sourceText], its [outputText] is empty (the face is composed at render time
  /// from [controlKind], so nothing on the row can be re-delivered or re-typed),
  /// and its [status] is NOT the delivery truth of anything — see [controlKind].
  bool get isControl => entryType == kControl;

  /// CR-7 — true for an ARTICLE HEAD row. See [kArticle].
  ///
  /// 🔴 Read it as 「这一行不是一句话，是一整篇的封面」("this row is not a
  /// sentence, it is the cover of a whole piece"). Like [isControl] it must be
  /// asked POSITIVELY: a predicate that offers an action to `!isImage` hands
  /// resend / deferred delivery / edit / re-run to a head, and a head has
  /// nothing to deliver.
  bool get isArticle => entryType == kArticle;

  /// CR-7 — a row that is PART OF an article, never the head itself.
  bool get isInArticle => articleId != null && !isArticle;

  /// §2A.1 display fallback: processed/edited face over the immutable source.
  String get displayText {
    if (outputText.isNotEmpty) return outputText;
    return sourceText ?? '';
  }

  /// The UI shows the 「原文」("original text") line when a compose transform diverged the face
  /// from the immutable original (translate/organize). A merely-edited realtime
  /// row does NOT show it (demo frame 2).
  bool get showsSourceLine =>
      processMode != null &&
      sourceText != null &&
      sourceText!.isNotEmpty &&
      sourceText != displayText;

  static String mintLocId(String deviceId, String clientId) {
    final String d = deviceId.isEmpty ? 'mobile' : deviceId;
    return 'loc_${d}_$clientId';
  }

  static bool isLocId(String id) => id.startsWith('loc_');

  /// F-3110 style: no `sourceText` — the original is immutable.
  TimelineEntry copyWith({
    String? outputText,
    EntryStatus? status,
    DateTime? updatedAt,
    String? processMode,
    String? processedText,
    DateTime? refinedAt,
    InjectTarget? injectTarget,
    String? pcName,
    String? spokenToInstanceId,
    String? spokenToInstanceName,
    bool? edited,
    bool? deleted,
    int? durationMs,
    String? failureReason,
    bool? cachedByVerdict,
    DateTime? lastResentAt,
  }) => TimelineEntry(
    id: id,
    clientId: clientId,
    mode: mode,
    delivery: delivery,
    sourceText: sourceText,
    outputText: outputText ?? this.outputText,
    sourceLang: sourceLang,
    outputLang: outputLang,
    processMode: processMode ?? this.processMode,
    processedText: processedText ?? this.processedText,
    refinedAt: refinedAt ?? this.refinedAt,
    injectTarget: injectTarget ?? this.injectTarget,
    pcName: pcName ?? this.pcName,
    spokenToInstanceId: spokenToInstanceId ?? this.spokenToInstanceId,
    spokenToInstanceName: spokenToInstanceName ?? this.spokenToInstanceName,
    edited: edited ?? this.edited,
    status: status ?? this.status,
    createdAt: createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
    durationMs: durationMs ?? this.durationMs,
    segmentsCount: segmentsCount,
    origin: origin,
    deleted: deleted ?? this.deleted,
    // No parameter, like `sourceText`: a row's KIND is written once.
    entryType: entryType,
    thumbB64: thumbB64,
    // No parameter either, and for the same reason: WHICH key was pressed is the
    // row's identity, not a fact about it that could later be revised.
    controlKind: controlKind,
    // CR-7/CR-8 — no parameters, same rule again: which recording a row came
    // from, and where inside it, are facts about the audio that produced the
    // row. An edit changes the words; it does not move the row in time.
    articleId: articleId,
    articleOffsetMs: articleOffsetMs,
    // Null cannot clear — see [failureReason] field comment.
    failureReason: failureReason ?? this.failureReason,
    // `false` DOES clear (only null means 「不变」/ "unchanged") — a row put
    // back to 投递中("in delivery") must
    // stop claiming a verdict it no longer has.
    cachedByVerdict: cachedByVerdict ?? this.cachedByVerdict,
    // Null cannot clear, like [refinedAt]: 「这一行被重发过」("this row has
    // been resent") is not a fact that
    // un-happens. TimelineStore.markReinjecting is its ONLY writer.
    lastResentAt: lastResentAt ?? this.lastResentAt,
  );

  final DateTime createdAt;
  final DateTime updatedAt;

  // ── local persistence (device-local JSON, never the wire) ──────────────
  //
  // 🔴 BOTH BODIES MOVED to timeline_entry_codec.dart (a `part` of this
  // library) when card CR-7 pushed this file past the 800-line cap. The two
  // NAMES stay here, so every caller and every test double is unchanged —
  // see that file for the cut, and for the one mechanical edit it carries.
  Map<String, Object?> toJson() => timelineEntryToJson(this);

  static TimelineEntry? fromJson(Map<String, Object?> j) =>
      timelineEntryFromJson(j);


  /// HistoryItemSchema wire shape for `history:create` / room sync. `status`
  /// records delivery truth only; `edited` is the additive overlay bit.
  ///
  /// [entryType] and [thumbB64] ride along on a PICTURE row only (owner
  /// 2026-07-27, protocol change authorised). A transcript emits neither key,
  /// so its frame is byte-for-byte what it was before the fields existed.
  ///
  /// **Deliberately NOT here**: [failureReason], [cachedByVerdict] and
  /// [lastResentAt]. All three are device-local (RV-43 §4.2: 「本卡不加协议字段」
  /// / "this card does not add protocol fields"),
  /// and emitting a key the wire zod would strip is worse than not having it —
  /// it looks synced and is not. [lastResentAt] in particular is a PHONE display
  /// fact: the PC answers 「这一行是什么时候重投的」("when was this row
  /// redelivered") with a whole new row of its own
  /// (RV-72), so there is nothing for it to learn here.
  Map<String, Object?> toHistoryItem({
    String? pairingId,
    required String pcDeviceId,
    required String userId,
    String? mobileId,
  }) => <String, Object?>{
    'id': id,
    'pairing_id': pairingId,
    'pc_device_id': pcDeviceId,
    'user_id': userId,
    'mobile_id': mobileId,
    'mode': mode.name,
    'source_text': sourceText,
    'source_lang': sourceLang,
    'output_text': outputText,
    'output_lang': outputLang,
    'duration_ms': durationMs,
    'segments_count': segmentsCount,
    'status': status.wire,
    'edited': edited,
    // owner 2026-07-27 (protocol change authorised): a picture row now SAYS it
    // is one and carries its preview. Both keys are additive and optional, and
    // a transcript emits neither — so an older peer sees exactly what it saw
    // before, and this row stops being a sentence pretending to be a picture.
    if (isImage) 'entry_type': kImage,
    if (thumbB64 != null && thumbB64!.isNotEmpty) 'thumb_b64': thumbB64,
    'created_at': createdAt.toUtc().toIso8601String(),
    'updated_at': updatedAt.toUtc().toIso8601String(),
  };

}
