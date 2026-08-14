// SPEC-REF:
//   docs/strategy/2026-07-31-mobile-outbox-design-draft.md §3.2 (four states, terminal states must be named)
//   docs/decisions/2026-07-31-queue-destination-is-a-machine-not-a-connection.md
//   CLAUDE.md red line: status only records delivery truth / no silent failure (banned in both directions)
//
// ONE queued delivery, and the state machine the queue moves it through.
//
// ── WHY `delivery_state` IS A NEW FIELD AND NOT A SIXTH `status` ─────────────
// `TimelineEntry.status` (injected/cached/failed/noted + edited) answers
// 「这一条的投递真相是什么」 ("what is this row's delivery truth") — what
// actually happened to the user's sentence.
// `delivery_state` answers 「队列拿它怎么办」 ("what does the queue do with
// it"). They are different questions with
// different lifetimes: a row can be `failed` (a real, reported delivery truth)
// while its queue item is `queued` (still to be retried), and collapsing them
// would make the timeline lie in whichever direction the queue happened to move
// last. Two questions, two fields — the one discipline this repo pays for most.
//
// 🔴 `queued` IS NEVER RENDERED AS 「已发送」 ("sent"). owner has already paid
// once for a promise that had not been kept (「待投递」 ("pending delivery") →
// 「未注入」 ("not injected")). The UI card (B3-2b)
// owns the wording; this file owns the guarantee that the distinction survives
// to reach it.
//
// ⚠️ Card L7 (2026-08-02) — **the PREMISE behind that earlier fix (in the
// paragraph above) has since lapsed; the PROHIBITION itself has not.**
// 「待投递」("pending delivery") was an empty promise in 0.1.x, because **there
// was no queue at all back then**; from 0.2.33 on there is a durable outbound
// queue (persisted to disk before sending, resumed after a disconnect/reconnect)
// ⇒ it went from a lie to a statement of fact, and owner personally brought
// this word back on 2026-08-02 (`DeliveryFace.queued`'s wording is now
// 「待投递 · 排队中」 ("pending delivery · queued"),
// docs/rebuild/15 §2.0/§2.5). **What remains banned is the class of words like
// 「已发送」 ("sent") that claim something happened when it did not**
// — that is what that tuition actually bought. **Do not, on the strength of
// the paragraph above, change the UI wording back to 「未注入」 ("not
// injected")**: that is the vocabulary of stage ② (PC → focus window), and the
// queue layer cannot answer that question at all.

/// What a queued delivery actually carries.
///
/// Two kinds, not a boolean, because the drain treats them differently in ways a
/// `isImage` flag would keep having to re-explain: a text item is complete once
/// it is on disk, while an image item's payload lives in a SEPARATE file whose
/// presence is itself a user-visible fact ([OutboxItem.hasImageBytes]).
enum OutboxPayloadKind { text, image }

OutboxPayloadKind? outboxPayloadKindFromWire(Object? v) {
  for (final OutboxPayloadKind k in OutboxPayloadKind.values) {
    if (k.name == v) return k;
  }
  return null;
}

/// The four states, and nothing else (design draft §3.2).
enum OutboxDeliveryState {
  /// On disk, not on the wire. The only state a delivery may WAIT in.
  queued,

  /// Handed to the transport; the PC's verdict is outstanding.
  ///
  /// ⚠️ A terminal state it is NOT. Red line: 「远端事件闭合的 latch 必须有本地
  /// 看门狗」 ("a latch closed by a remote event must have a local watchdog"):
  /// nothing may stop here. The drain's watchdog returns it to [queued] or moves
  /// it to [refused] with a named code — see [DeliveryOutbox].
  inflight,

  /// The PC's own `inject:result` said it landed. Terminal, and the ONLY state
  /// that may be reached from a remote success.
  delivered,

  /// Terminal failure with a NAMED reason ([OutboxItem.refusedCode]).
  ///
  /// Reached only for failures that retrying cannot fix (see
  /// [isTerminalRefusalCode]). A reachability failure is NOT this — it goes back
  /// to [queued], because owner ruled 「不管时间多久，全部都要投递——除非一直连不上」
  /// ("no matter how long it takes, everything must be delivered — unless it
  /// truly never connects").
  refused,
}

// ── THE QUEUE'S OWN TWO TERMINAL CODES ───────────────────────────────────────
//
// 🔴 WHY THESE TWO ARE **NOT** IN THE PROTOCOL'S `ERROR_CODES` TABLE
// (the coordinator's 2026-07-31 ruling, recorded here rather than only in the card because this
// is where the next person will ask the question).
//
// `ERROR_CODES` is the vocabulary for things that CROSS A BOUNDARY: one end
// produces the code, the other end displays it, and the table is what keeps the
// two ends agreeing. Both codes below are produced by the phone, consumed by the
// phone, and can never appear on a wire — the server has no idea a queue exists
// and the desktop never sees an item that was not sent. Putting them in the
// protocol table would make 「协议错误码」 ("protocol error code") answer two
// questions at once (「对端说了什么」 ("what did the other end say") and
// 「我这边自己决定了什么」 ("what did I decide on my own side")) — this repo's #1
// bug shape, in the one
// table whose whole job is to have exactly one meaning per string. It would also
// spend a counting-guard bump and a relay deploy on a string that never leaves
// the handset.
//
// ⚠️ WHAT DOES NOT CHANGE: they are named to the same standard. Each has a
// constant (so no call site spells it as a literal), each is terminal by the
// same predicate every server code is judged by, and each has a user-readable
// Chinese sentence with a grep-able producer — see `outboxTerminalMessage` in
// outbox_failure_text.dart. A local terminal without those would be 「静默失败」
// ("silent failure")
// wearing a code.

/// The compressed picture this item was to deliver is no longer on disk, so
/// there is genuinely nothing left to send. The third state of the picture
/// two-stage model (queued-with-bytes / delivered-and-bytes-released / bytes-gone-but-the-row-remains).
const String kOutboxImageBytesGone = 'OUTBOX_IMAGE_BYTES_GONE';

/// Dropped to keep the queue inside `kOutboxCapacity`. Terminal by construction
/// — it was removed precisely because it could not be kept.
const String kOutboxOverflow = 'OUTBOX_OVERFLOW';

/// 🔴 Which named failures are TERMINAL — i.e. which ones must stop retrying.
///
/// owner/the coordinator, 2026-07-31, made a hard requirement rather than a comment: `pc_id`
/// is a random UUID minted per server row, so reinstalling the PC (or clearing
/// its database) gives the SAME computer a NEW `pc_id`. A queued item frozen
/// against the old one is then refused by the server FOREVER. Retrying it on
/// every reconnect for the rest of the phone's life is the 「无限重试」
/// ("infinite retry") this
/// predicate exists to prevent: the item is settled `refused`, keeps the
/// server's own code, and the user is told rather than left with a queue that
/// silently never empties.
///
/// THE RULE — **two clauses**, stated so the next addition is decidable rather
/// than a coin flip. A code is terminal iff EITHER:
///
///   ① **re-sending this exact frame on a healthy link could not produce a
///      different answer** (anything that depends on WHEN or on WHICH LINK is
///      retryable and belongs in [queued]); OR
///   ② 🔴 **it is a RED-LINE signal, which must never be retried into eventual
///      success.**
///
/// ⚠️ CLAUSE ② WAS ADDED DELIBERATELY AND IS NOT A LOOPHOLE (window B3-2a, when the
/// protocol round asked for `INJECT_PC_UNSPECIFIED`). Clause ① alone does NOT
/// actually cover `INJECT_PC_MISMATCH`, and pretending it did would have been a
/// comment that argues for a design it does not support — the exact anti-façade ④
/// shape this file has already had to correct once. The honest reasoning:
/// `target_pc_id` is NOT frozen on the item; it is re-resolved from the LIVE
/// connection on every attempt (see outbox_destination.dart), so a later attempt
/// genuinely COULD carry a different address and succeed. By clause ① it would
/// therefore be retryable.
///
/// It is terminal anyway, by clause ②, and the reason is worth the words: a
/// `PC_MISMATCH` means a frame reached the server addressed to a PC this
/// connection is not bound to — i.e. **the no-crosstalk red line actually
/// fired**. Gate 2 is built so that frame can never be BUILT (a machine mismatch is
/// refused locally and the item stays `queued`), so if the server ever has to
/// refuse one, our local addressing is already wrong. Quietly retrying it until
/// it happens to land is the single worst response available: it converts a
/// red-line alarm into an eventual silent success. It stops, keeps the server's
/// own code, and becomes visible.
///
/// ⚠️ `INJECT_PC_OFFLINE` / `PC_BUSY` / `PC_UNREACHABLE` / `INJECT_NO_RESULT`
/// are deliberately absent: every one of them is 「现在不行」 ("not right now"), and owner's ruling
/// is that those wait, however long it takes.
bool isTerminalRefusalCode(String code) => switch (code) {
  // 🔴 Clause ② — the red line fired. See the long note above for why this is
  // NOT justified by clause ① and must not be re-argued from it.
  'INJECT_PC_MISMATCH' => true,
  // 🔴 Clause ① AND ②, 0.2.33 (protocol round, 56→57). 「这条投递没有指明目标
  // 电脑」 ("this delivery does not specify a target computer"). Clause ①: the frame that lacks the field lacks it on every resend.
  // Clause ②: the outbox structurally CANNOT emit one — `resolveOutboxTarget`
  // never yields an address without a non-empty `pc_id` (it refuses with
  // `addressUnknown` instead), so an item that earns this code was emitted by
  // something that dropped the field. Retrying that is retrying a bug.
  'INJECT_PC_UNSPECIFIED' => true,
  // The frame itself does not satisfy the schema / is over cap. Bytes will not
  // become valid by waiting.
  'INJECT_FRAME_INVALID' || 'INJECT_FRAME_TOO_LARGE' => true,
  // The queue's own two terminals — see the block above for why they are named
  // constants here and deliberately NOT protocol error codes.
  kOutboxImageBytesGone => true,
  kOutboxOverflow => true,
  _ => false,
};

/// One durable delivery. Immutable; every transition returns a new instance so a
/// half-applied state cannot exist.
class OutboxItem {
  const OutboxItem({
    required this.requestId,
    required this.entryId,
    required this.coveredEntryIds,
    this.wireEntryId,
    required this.kind,
    required this.source,
    required this.text,
    required this.mode,
    required this.createdAt,
    required this.enqueuedAt,
    required this.destinationMachineUid,
    required this.destinationPairingIdentity,
    required this.enqueuedPcId,
    this.sourceText,
    this.entryType,
    this.thumbB64,
    this.imagePath,
    this.imageMime,
    this.deviceLabel,
    this.durationMs,
    this.state = OutboxDeliveryState.queued,
    this.refusedCode,
    this.attempts = 0,
    this.lastAttemptAt,
    this.lastRefusalNote,
  });

  /// 🔴 Gate 1 — MINTED AT ENQUEUE, PERSISTED, AND NEVER RE-MINTED.
  ///
  /// `manual_delivery.dart`'s `mintRequestId` states the cost of getting this
  /// wrong at its own definition: a fresh id per drain attempt would break the
  /// server's HTTP `request_id` ledger AND the desktop's INJ-3 replay dedup at
  /// the same time, so one reconnect flap would type the same sentence twice.
  /// A retry of THIS delivery re-sends THIS id; that is what makes the retry
  /// idempotent instead of duplicative.
  ///
  /// Also the primary key: the table physically cannot hold two rows for one
  /// delivery.
  final String requestId;

  /// The local timeline row this delivery settles onto (A-58 correlation).
  ///
  /// For a multi-row send this is the REPRESENTATIVE (the earliest covered row)
  /// — the same one the pre-queue code stamped as `entry_id`. Which rows the
  /// verdict actually settles is [coveredEntryIds].
  ///
  /// ⚠️⚠️ CORRECTION (window B3-2c) — THE SECOND SENTENCE ABOVE IS FALSE, AND IT SHIPPED
  /// A REGRESSION. Kept verbatim rather than rewritten, per anti-façade ④: a
  /// comment that argues for a design is itself a greppable claim, and this one
  /// was wrong on the day it was written.
  ///
  /// The pre-queue code stamped `entryId: typedEntry?.id` — i.e. **null, and
  /// therefore no `entry_id` on the wire at all**, whenever the send covered
  /// rows it had not built (a multi-utterance buffered ➤). Window B3-2a replaced
  /// that with `settle.first`, which is never null, so every buffered send
  /// began stamping one row's id on a frame covering N rows. The PC then writes
  /// that row's truth over all of them — the exact cost typed_send_row_test.dart
  /// states in its own words, and the red it went for one window.
  ///
  /// ⇒ This field is now PURELY LOCAL: the settle anchor and the A-58 fallback
  /// key. What goes on the wire is [wireEntryId], and nothing else.
  final String entryId;

  /// 🔴 Whether this frame stamps `inject:request.entry_id`, and with what.
  ///
  /// Null ⇒ the field is OMITTED (not sent empty — an empty string is a value,
  /// and `entry_id` means 「这一帧说的是这一行」 ("this frame is about this
  /// row")). Non-null exactly when THIS
  /// delivery built the row it names: a typed ➤, a direct-send utterance, a
  /// picture, a deferred delivery (补投). Null for a ➤ over rows that already existed, because no
  /// single row is what that frame is about.
  ///
  /// Deliberately a separate field from both [entryId] and [coveredEntryIds]:
  /// 「结算锚点」 ("the settlement anchor") and 「线上盖不盖那个键」 ("whether
  /// that key is stamped on the wire") are two questions, and merging them is
  /// what produced the regression recorded above.
  final String? wireEntryId;

  /// EVERY row this one delivery settles (§4.0 A: each utterance keeps its own
  /// row; one ➤ is one delivery ACTION over them).
  ///
  /// A separate field from [entryId] because they answer different questions —
  /// 「这一帧的关联键是哪个」 ("which correlation key does this frame carry") vs
  /// 「这次投递管着哪些行」 ("which rows does this delivery cover") — and RV-15
  /// is the bug that happens when one value is asked both: the banner's resend
  /// guessed 「最新那条失败的行」 ("the most recent failed row") and re-sent 1 of
  /// N, silently dropping the rest.
  final List<String> coveredEntryIds;

  final OutboxPayloadKind kind;

  /// `inject:request.source` (stt/llm/manual/history/image), verbatim.
  final String source;

  /// The words to deliver. Empty for an image (the picture is the payload).
  final String text;

  /// The mode the ROW was produced under (RV-74) — never 「现在选的是哪个」 ("whichever is currently selected").
  final String mode;

  /// 🔴 Gate 3 — WHEN THE USER SPOKE, not when the frame is finally sent.
  ///
  /// owner: 「不管时间多久，全部都要投递」 ("no matter how long it takes,
  /// everything must be delivered") — this field is the entire reason that
  /// ruling is implementable. A drain is a FIRST delivery, so the PC records the
  /// utterance's own instant even if it has been queued for days.
  ///
  /// ⚠️ Do NOT copy `manual_delivery.dart`'s deferred-delivery (补投) line, which stamps
  /// `DateTime.now()`. That path is an active resend (主动重投) — a NEW decision by the user —
  /// and its own comment says in as many words that window B2 must not copy it.
  /// Two events, one field: a drain records the speaking, a re-send records the
  /// re-sending.
  final DateTime createdAt;

  /// When it entered the queue (forensics + overflow ordering; never sent).
  final DateTime enqueuedAt;

  /// 🔴 The frozen destination — see outbox_destination.dart for the whole
  /// argument. The machine is the destination; the pairing is the legacy
  /// fallback; the pc_id is audit-only and addresses nothing.
  final String? destinationMachineUid;
  final String? destinationPairingIdentity;
  final String? enqueuedPcId;

  final String? sourceText;
  final String? entryType;
  final String? thumbB64;

  /// Where the COMPRESSED picture lives on disk (image items only).
  ///
  /// ⚠️⚠️ CORRECTION (RV-93, owner 2026-08-01). This doc used to read: 「owner ①: the
  /// queue is for delivering, not an album — the file is removed once the
  /// delivery succeeds. Its presence/absence is therefore a FACT the UI may query
  /// (「这条还能不能重发」 — "can this one still be resent")」. owner revoked that
  /// ruling — 「投递成功即删，改为存下来」 ("delete on successful delivery —
  /// changed to: keep it stored instead")
  /// — so BOTH sentences are now false and the second one was the load-bearing
  /// one: presence no longer answers 「能不能重发」 ("can it be resent"), because it is now always true
  /// for a picture item. That question is answered by the item's STATE
  /// ([isPending]); see `OutboxPendingView.resendableImageEntryIds`.
  ///
  /// What this field is now: THE QUEUE'S REFERENCE to a file the TIMELINE ROW
  /// owns (outbox_blob_store.dart header). The row reaches the same file through
  /// `OutboxBlobStore.pathFor(entry.clientId)` without consulting this item at
  /// all — deliberately, because the queue is scheduled to be shrunk (15 册 G-12)
  /// and the picture must not go with it.
  ///
  /// ⚠️ It can still be null on an image item, and that is not a contradiction:
  /// the file failed to write at enqueue (`enqueueImage` returns null then), or
  /// something outside the app removed it. The drain settles
  /// `OUTBOX_IMAGE_BYTES_GONE` in that case rather than sending an empty frame.
  final String? imagePath;
  final String? imageMime;

  final String? deviceLabel;

  /// owner 2026-08-02 「语音时长要找回来」 ("we need to get the voice duration
  /// back") — the row's engine-reported duration, ms.
  /// Persisted WITH the item so a retried delivery carries the same duration the
  /// live send did (一条晚到的行不许比准时的那条少一块内容 — "a late-arriving row
  /// must not be missing a piece of content compared to an on-time one"). Null for typed/manual
  /// and image items — absence, never 0. Column added by DB v3 (timeline_sqlite).
  final int? durationMs;

  final OutboxDeliveryState state;

  /// The named reason for [OutboxDeliveryState.refused]. Never null in that
  /// state, always null outside it — enforced by [_assertRefusalInvariant].
  final String? refusedCode;

  final int attempts;
  final DateTime? lastAttemptAt;

  /// Why the LAST drain attempt did not put this on the wire, when it did not.
  /// Purely diagnostic (「这一条为什么还在队列里」 — "why is this one still in
  /// the queue") — it never becomes a status.
  final String? lastRefusalNote;

  bool get isTerminal =>
      state == OutboxDeliveryState.delivered ||
      state == OutboxDeliveryState.refused;

  /// True when this item still owes the user a delivery. The queue's own
  /// definition of 「还有 N 条未投递」 ("N still undelivered") (B3-2b renders it; nothing here does).
  bool get isPending => !isTerminal;

  /// Whether the picture this item would deliver is still on disk.
  ///
  /// 🔴 RV-93 — THIS IS NO LONGER THE RESEND GATE, IT IS ONLY HALF OF IT.
  ///
  /// It used to be the whole answer (owner 2026-07-31: 「不找原图了，就只管还在的
  /// 那份」 ("stop hunting for the original image — just go by whatever copy is
  /// still there") ⇒ two states, button ⇔ bytes). Since 「投递成功即删」
  /// ("delete on successful delivery") was revoked the
  /// bytes are permanent, so this is TRUE for a delivered picture too and a gate
  /// built on it alone would put a resend button on a picture that already landed.
  ///
  /// The gate is 「这一条还没有投递成功」 ("this one has not yet been
  /// successfully delivered") ([isPending]) AND this. This half survives
  /// for the R8 reason it was written for: a button offered with no bytes behind
  /// it could do nothing when pressed, and 「一个改变不了任何东西的控件比没有控件
  /// 更坏」 ("a control that changes nothing is worse than no control at all").
  bool get hasImageBytes =>
      kind == OutboxPayloadKind.image &&
      imagePath != null &&
      imagePath!.isNotEmpty;

  OutboxItem copyWith({
    OutboxDeliveryState? state,
    String? refusedCode,
    int? attempts,
    DateTime? lastAttemptAt,
    String? lastRefusalNote,
    // ⚠️ `bool clearImagePath` STOOD HERE AND IS GONE (RV-93). Its ONE caller was
    // `DeliveryOutbox._releaseBytes`, deleted with owner's revocation of 「投递成功
    // 即删」 ("delete on successful delivery") — a picture's path is never cleared any more, because the picture is
    // never deleted. Removed rather than left unused: a `copyWith` flag nobody
    // passes is a capability the next reader will assume is live.
    bool clearRefusedCode = false,
    bool clearRefusalNote = false,
  }) {
    final OutboxItem next = OutboxItem(
      requestId: requestId,
      entryId: entryId,
      wireEntryId: wireEntryId,
      coveredEntryIds: coveredEntryIds,
      kind: kind,
      source: source,
      text: text,
      mode: mode,
      createdAt: createdAt,
      enqueuedAt: enqueuedAt,
      destinationMachineUid: destinationMachineUid,
      destinationPairingIdentity: destinationPairingIdentity,
      enqueuedPcId: enqueuedPcId,
      sourceText: sourceText,
      entryType: entryType,
      thumbB64: thumbB64,
      imagePath: imagePath,
      imageMime: imageMime,
      deviceLabel: deviceLabel,
      durationMs: durationMs,
      state: state ?? this.state,
      refusedCode: clearRefusedCode ? null : (refusedCode ?? this.refusedCode),
      attempts: attempts ?? this.attempts,
      lastAttemptAt: lastAttemptAt ?? this.lastAttemptAt,
      lastRefusalNote:
          clearRefusalNote ? null : (lastRefusalNote ?? this.lastRefusalNote),
    );
    next._assertRefusalInvariant();
    return next;
  }

  /// `refused` ⇔ a named code. Asserted rather than merely documented because
  /// an unnamed terminal failure is the exact shape of 「静默失败」 ("silent
  /// failure") — the user
  /// would see a delivery stop happening with nothing anywhere saying why.
  void _assertRefusalInvariant() {
    assert(
      (state == OutboxDeliveryState.refused) ==
          (refusedCode != null && refusedCode!.isNotEmpty),
      'OutboxItem: refused MUST carry a named code, and only refused may '
      '(state=$state, code=$refusedCode)',
    );
  }

  Map<String, Object?> toJson() => <String, Object?>{
    'request_id': requestId,
    'entry_id': entryId,
    'covered_entry_ids': coveredEntryIds.join(','),
    'wire_entry_id': wireEntryId,
    'kind': kind.name,
    'source': source,
    'text': text,
    'mode': mode,
    'created_at': createdAt.toUtc().millisecondsSinceEpoch,
    'enqueued_at': enqueuedAt.toUtc().millisecondsSinceEpoch,
    'dest_machine_uid': destinationMachineUid,
    'dest_pairing_identity': destinationPairingIdentity,
    'enqueued_pc_id': enqueuedPcId,
    'source_text': sourceText,
    'entry_type': entryType,
    'thumb_b64': thumbB64,
    'image_path': imagePath,
    'image_mime': imageMime,
    'device_label': deviceLabel,
    'duration_ms': durationMs,
    'delivery_state': state.name,
    'refused_code': refusedCode,
    'attempts': attempts,
    'last_attempt_at': lastAttemptAt?.toUtc().millisecondsSinceEpoch,
    'last_refusal_note': lastRefusalNote,
  };

  /// Decode one row. Returns null for a row that will not parse — the caller
  /// SKIPS it rather than substituting a default, for the same reason
  /// `SqfliteTimelinePersistence._decode` does: half an item is worse than a
  /// gap, and there is nothing truthful to put in its place.
  static OutboxItem? fromJson(Map<String, Object?> j) {
    final Object? rid = j['request_id'];
    final Object? eid = j['entry_id'];
    if (rid is! String || rid.isEmpty) return null;
    if (eid is! String || eid.isEmpty) return null;
    final OutboxPayloadKind? kind = outboxPayloadKindFromWire(j['kind']);
    if (kind == null) return null;
    final Object? created = j['created_at'];
    final Object? enq = j['enqueued_at'];
    if (created is! int || enq is! int) return null;
    final OutboxDeliveryState? state = _stateFromWire(j['delivery_state']);
    if (state == null) return null;
    final Object? code = j['refused_code'];
    // The invariant is checked on DECODE too: a row that violates it is
    // corrupt, and adopting it would let an unnamed terminal failure back in
    // through the one door the constructor cannot guard.
    final bool named = code is String && code.isNotEmpty;
    if ((state == OutboxDeliveryState.refused) != named) return null;
    return OutboxItem(
      requestId: rid,
      entryId: eid,
      wireEntryId: _str(j['wire_entry_id']),
      coveredEntryIds: _covered(j['covered_entry_ids'], eid),
      kind: kind,
      source: j['source'] is String ? j['source']! as String : 'manual',
      text: j['text'] is String ? j['text']! as String : '',
      mode: j['mode'] is String ? j['mode']! as String : 'realtime',
      createdAt: DateTime.fromMillisecondsSinceEpoch(created, isUtc: true),
      enqueuedAt: DateTime.fromMillisecondsSinceEpoch(enq, isUtc: true),
      destinationMachineUid: _str(j['dest_machine_uid']),
      destinationPairingIdentity: _str(j['dest_pairing_identity']),
      enqueuedPcId: _str(j['enqueued_pc_id']),
      sourceText: _str(j['source_text']),
      entryType: _str(j['entry_type']),
      thumbB64: _str(j['thumb_b64']),
      imagePath: _str(j['image_path']),
      imageMime: _str(j['image_mime']),
      deviceLabel: _str(j['device_label']),
      // Old rows (pre-v3) read the column as null — absence, exactly right.
      durationMs: j['duration_ms'] is int && (j['duration_ms']! as int) >= 0
          ? j['duration_ms']! as int
          : null,
      state: state,
      refusedCode: named ? code : null,
      attempts: j['attempts'] is int ? j['attempts']! as int : 0,
      lastAttemptAt: j['last_attempt_at'] is int
          ? DateTime.fromMillisecondsSinceEpoch(
              j['last_attempt_at']! as int,
              isUtc: true,
            )
          : null,
      lastRefusalNote: _str(j['last_refusal_note']),
    );
  }

  static String? _str(Object? v) => v is String && v.isNotEmpty ? v : null;

  /// Comma-joined on disk. Falls back to `[entryId]` for a row written before
  /// the column existed — the honest reading (a delivery always settles at
  /// least its own row), never an empty list, which would make a drained item
  /// settle NOTHING and leave the user's row at ⏳ forever.
  static List<String> _covered(Object? v, String entryId) {
    if (v is! String || v.isEmpty) return <String>[entryId];
    return v.split(',').where((String s) => s.isNotEmpty).toList();
  }

  static OutboxDeliveryState? _stateFromWire(Object? v) {
    for (final OutboxDeliveryState s in OutboxDeliveryState.values) {
      if (s.name == v) return s;
    }
    return null;
  }
}
