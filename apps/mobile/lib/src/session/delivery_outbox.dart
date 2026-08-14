// SPEC-REF:
//   docs/strategy/2026-07-31-mobile-outbox-design-draft.md §3 (mechanism, full text)
//   docs/decisions/2026-07-31-queue-destination-is-a-machine-not-a-connection.md
//   docs/decisions/2026-07-31-owner-two-channels-transit-not-storage.md ④⑤⑨
//   docs/decisions/2026-07-31-owner-b2-outbox-rulings.md ①⑤
//   CLAUDE.md red line: no silent failure (banned in both directions) / a
//     remote latch must have a local watchdog / cross-wiring IDs is absolutely forbidden
//
// ── THIS PROJECT'S FIRST STORE-AND-FORWARD QUEUE ─────────────────────────────
//
// Before this file, not one line of delivery survived a process death. What was
// mistaken for a retry queue (`pendingSync` / `reflushPending` / `syncState` /
// `markSynced`) only ever pushed rows into the server's `transcript_history`
// table — it never delivered a single thing to a PC, and that table is gone.
//
// 🔴 THOSE NAMES ARE BANNED HERE, and the ban is not stylistic. 「did this go
// out」 and 「does the server have this row」 are different questions; reusing
// the names would rebuild this repo's #1 bug (one value answering two
// questions) on purpose, in the one place where getting it wrong types a
// stranger's sentence into your document.
//
// ── THE SHAPE: ENQUEUE-FIRST, ONE FUNNEL ─────────────────────────────────────
//
// Every delivery lands on disk BEFORE any emit; the emit is merely 「an
// attempt」. This ordering is the whole point and cannot be weakened to 「only
// enqueue after it fails」: the failure this queue exists for (RV-60 — the
// photo picker backgrounds the app, the OS severs the TCP, and the send falls
// into a 「dead but undetected」 window) can kill the process between the emit
// and the receipt. Only what is already on disk survives that, so 「only
// enqueue after it fails」 is not a weaker fix, it is no fix.
//
// WHAT THIS CLASS DOES NOT REPLACE. The existing `_InFlightSend` registry, the
// 20 s result watchdog and the failure banner all stay exactly as they are and
// keep being driven by the send paths; this queue sits IN FRONT of the two exits
// (ComposeGate.emitInject and the LAN http ingress) and decides WHAT goes out
// and WHEN. Two watchdogs is not duplication: theirs settles the ROW's delivery
// truth, [_armItemWatchdog] below settles the ITEM's queue state, and the red
// line forbids either latch from having no local timer.

import 'dart:async';
import 'dart:typed_data';

import '../diag/diag_log.dart';
import '../signaling/wire_payloads.dart' show InjectOrigin;
import 'outbox_blob_store.dart';
// 卡 F2 — the phone-side mirror of 「who made this ruling」 (single source of
// truth is in packages/protocol).
import 'outbox_inject_authorship.dart';
import 'outbox_inject_origin.dart';
import 'outbox_cloud_image_policy.dart';
import 'outbox_destination.dart';
import 'outbox_drain_host.dart';
import 'outbox_drain_report.dart';
import 'outbox_failure_text.dart';
import 'outbox_item.dart';
import 'outbox_pending_view.dart';
import 'outbox_store.dart';

// 窗口B3-2b: [OutboxDrainHost] and [OutboxDrainReport] moved to their own files
// for the 800-line cap and are re-exported HERE so the move stays invisible —
// every existing `import 'delivery_outbox.dart'` keeps resolving them, in
// production and in the whole outbox suite. A structural split that forces its
// callers to be edited is not 「move only, no behavior change」.
export 'outbox_drain_host.dart';
export 'outbox_drain_report.dart';
// 窗口B4-7: same rule for the derived-state projection — the move must not force
// a single caller to be edited, or it is not 「move only, no behavior change」.
export 'outbox_pending_view.dart';

// 卡 B4-17 — this file's THREE top-level declarations (the two bounds and
// `_Attempt`) live in the part below, same cap, same rule. A `part` and not
// another library so `_Attempt` stays library-private and both constants stay
// exported from HERE: not one caller had to be edited.
part 'delivery_outbox_terms.dart';
// 卡 L8 — the SETTLE half (verdict → terminal state + the item watchdog). Same
// library, same reason as the part above (800-line cap), and the same rule:
// nothing moved changed behaviour, and no caller had to be edited.
part 'delivery_outbox_settle.dart';
// 卡 D9 ② — the DISK-DEGRADATION seam (`_persistItem` / `_loadPendingMerged` /
// `_findItemByRequestId` and the rationale that goes with them). Same library,
// same reason as the two parts above (800-line cap: this file hit 827), and the
// same rule — the class kept one-line delegates under the original names, so
// the move edited zero call sites.
part 'delivery_outbox_degraded.dart';
// 800-line cap (this file stood at 798/800): the ATTEMPT half of the drain —
// address ONE item, then send it, hold it with a reason, or settle it
// terminally. Same library, same reason as the three parts above, and the same
// rule: nothing moved changed behaviour, and no caller had to be edited.
part 'delivery_outbox_attempt.dart';

class DeliveryOutbox {
  DeliveryOutbox({
    required OutboxStore store,
    required OutboxBlobStore blobs,
    required OutboxDrainHost host,
    int capacity = kOutboxCapacity,
    Duration inflightTimeout = kOutboxInflightTimeout,
  }) : _store = store,
       _blobs = blobs,
       _host = host,
       _capacity = capacity,
       _inflightTimeout = inflightTimeout;

  final OutboxStore _store;
  final OutboxBlobStore _blobs;
  final OutboxDrainHost _host;
  final int _capacity;
  final Duration _inflightTimeout;

  final Map<String, Timer> _watchdogs = <String, Timer>{};

  /// Everything the UI reads synchronously, refreshed on every mutation.
  /// 窗口B4-7: the three fields and their one-pass recompute moved to
  /// outbox_pending_view.dart (800-line src cap) — see that file's header.
  OutboxPendingView _derived = OutboxPendingView.empty;

  /// 🔴 「N items still not delivered」 FOR ONE INSTANCE (RV-91). Rendered by
  /// `BannerIds.outboxPending`, fed through `ChatController.outboxPending`,
  /// scoped by `session.connectedInstanceId` — the same scope the transcript
  /// screen already filters its ROWS by. owner ruled the banner is NON-BLOCKING
  /// observability — 「no matter how long it takes, everything must be
  /// delivered」 — so it is `info` and gates nothing. Reasoning for
  /// instance-vs-machine: [OutboxPendingView.countFor].
  ///
  /// 卡 F2 (2026-08-05): the scope is now the MACHINE behind [instanceId] when
  /// there is one (ruling ④) — see [OutboxPendingView.countFor]'s correction
  /// block.
  ///
  /// 🔴 THE UID IS ONLY BORROWED FOR THE LIVE SCREEN. `instanceId` names WHICH
  /// screen is asking; the phone only knows which machine that is when the
  /// screen is the connection it is on. Attributing the live uid to some OTHER
  /// pairing would answer 「how many items should another computer's instance
  /// count」 with THIS computer's queue — the crosstalk shape, arrived at
  /// through a count instead of an address. A non-live identity therefore
  /// falls back to instance scope, i.e. exactly the pre-F2 answer. (Phase 2's
  /// `instance_machine_map` is what would let this be answered for a screen
  /// the phone is not currently on; nothing today asks —
  /// `ChatController.outboxPending` passes `connectedInstanceId`.)
  int pendingCountFor(String? instanceId) {
    final String asked = (instanceId ?? '').trim();
    final LiveConnection live = _host.liveConnection;
    final bool isLiveScreen =
        asked.isNotEmpty && asked == (live.pairingIdentity ?? '').trim();
    return _derived.countFor(
      machineUid: isLiveScreen ? live.machineUid : null,
      pairingIdentity: asked,
    );
  }

  /// ⚠️ FORENSICS ONLY — consumer is the `outbox.loaded` diag below. Never a
  /// banner: a screen-wide number on a per-instance screen IS the RV-91 defect.
  int get pendingCountTotal => _derived.totalCount;

  Set<String> get queuedEntryIds => _derived.queuedEntryIds;

  /// 卡 F7 — 「is this row's delivery still owed」 (queued OR inflight). See
  /// [OutboxPendingView.owedEntryIds] for why this is NOT [queuedEntryIds].
  Set<String> get owedEntryIds => _derived.owedEntryIds;

  Set<String> get resendableImageEntryIds => _derived.resendableImageEntryIds;

  Future<void> _refreshDerived() async {
    _derived = OutboxPendingView.of(await _loadPendingMerged());
  }

  // ── D9 ② — a broken disk must not abort a delivery ─────────────────────────
  //
  // The shadow of every item whose LATEST state could not be written to disk:
  // a failed write parks the item here (loudly) and every read merges it over
  // the stored rows, so a persistence failure degrades DURABILITY and never
  // delivery — the contract all four enqueue call sites already stated while
  // this class was still throwing out of them.
  //
  // 🔴 THE MECHANISM, THE CONTRACT QUOTES AND WHAT IS HONESTLY LOST all moved
  // VERBATIM to delivery_outbox_degraded.dart (800-line cap) together with the
  // three functions that maintain this map. The three delegates below keep the
  // original names so no call site moved with them.
  final Map<String, OutboxItem> _unpersisted = <String, OutboxItem>{};

  Future<void> _persistItem(OutboxItem item, {required String op}) =>
      outboxPersistItem(this, item, op: op);

  Future<List<OutboxItem>> _loadPendingMerged() => outboxLoadPendingMerged(this);

  Future<OutboxItem?> _findItemByRequestId(String requestId) =>
      outboxFindItemByRequestId(this, requestId);

  /// Overflow that has happened in this install and has NOT been acknowledged.
  ///
  /// 🔴 「it got cleared」 must not degrade after a restart into 「there was
  /// never anything there」: the dropped items are NOT
  /// deleted — they stay in the table as terminal `refused('OUTBOX_OVERFLOW')`
  /// rows, so the fact survives a restart in the only place that cannot be lost.
  ///
  /// ⚠️⚠️ Correction (卡 G-9, ruling 2026-08-05, landed 2026-08-07). This line
  /// used to read 「This counter is merely the fast path for a banner.」 ——
  /// **anti-façade ④: there is no such banner and there never was.** The banner comes from
  /// [_noteTerminal] (called beside the `++` below) off [_terminalNotice], never
  /// off this int ⇒ no 「silent failure」 is at stake and no new face is wanted. This int
  /// feeds one thing: `overflowed_total` on the `outbox.overflow` diag line.
  /// **Grep it — sole consumer; no hits ⇒ this comment has rotted too.**
  ///
  /// 🔴 PROCESS-SCOPED, ZERO AFTER A RESTART, while the dropped deliveries stay
  /// in the table. Hence the public getter that sat here was DELETED, not wired
  /// to a face (production consumers: none; sole reader was one line of
  /// outbox_test.dart, now re-pointed at the diag key — the real consumer): on a
  /// face it would say 0 with those `OUTBOX_OVERFLOW` rows still present, **a
  /// second answer to 「how many were lost」 and the new one wrong.** The durable answer is
  /// already on the rows.
  int _overflowed = 0;

  /// 🔴 The most recent terminal the QUEUE ITSELF decided
  /// (`OUTBOX_IMAGE_BYTES_GONE` / `OUTBOX_OVERFLOW`), held until read. Neither
  /// crosses a wire, so neither is a protocol code (reasoning in
  /// outbox_failure_text.dart); both still owe the user a sentence, because a
  /// delivery that stops for good with nothing saying why is 「silent failure」.
  ///
  /// ✅ 窗口B3-2b — IT NOW HAS A RENDERER, and the note that used to sit here is
  /// kept as a correction rather than deleted (anti-façade ④). It read: 「⚠️
  /// before B3-2b landed, this sentence was produced and nobody displayed
  /// it」 and ended 「if that card ships
  /// without reading this, delete the sentence and its producer」. That card is
  /// this one, and it read it: the consumer is `BannerIds.outboxTerminal`
  /// (banner_queue.dart), reached through `ChatController.outboxTerminal` and
  /// `chatBannerSources` (ui/chat_banner_sources.dart). **Grep either symbol —
  /// if the hits are gone, this comment is lying and the façade is back.**
  ///
  /// It holds the FACT, not the words: an [OutboxTerminal], resolved to one of
  /// four languages at render time. See outbox_failure_text.dart for why a
  /// sentence frozen down here was the wrong layer as well as the wrong locale.
  OutboxTerminal? _terminalNotice;

  /// ⚠️ RAW, FORENSICS/TESTS ONLY — the screen reads [terminalNoticeFor]: an
  /// unscoped notice drawn on a per-instance screen is the RV-91 defect (same
  /// stance as [pendingCountTotal] and `PcBusyTracker.raw`).
  OutboxTerminal? get terminalNotice => _terminalNotice;

  /// 🔴 G-20 ⑤ — WHICH INSTANCE'S SCREEN [_terminalNotice] is news for, stamped
  /// by the one writer ([_noteTerminal]) from the LIVE connection at the moment
  /// the queue decided the terminal (§2.5.1 fourth rule). Same vocabulary
  /// [pendingCountFor] compares its `asked` against.
  String? _terminalNoticeInstanceId;

  /// The queue's own terminal **for the instance whose screen is asking** —
  /// hidden while parked on another instance, never dropped (§2.5.1 is
  /// 「hidden」 not 「lost」). Blank-vs-null normalised exactly like [pendingCountFor]'s
  /// `asked`, so 「no connection」 stamped as null and asked as null is a REAL
  /// match, not a wildcard.
  OutboxTerminal? terminalNoticeFor(String? instanceId) {
    if (_terminalNotice == null) return null;
    final String asked = (instanceId ?? '').trim();
    final String stamped = (_terminalNoticeInstanceId ?? '').trim();
    return stamped == asked ? _terminalNotice : null;
  }

  /// Record a queue-owned terminal. Server codes are ignored: the PC's refusals
  /// are the PC's to phrase, and they are already carried on the ROW by name.
  void _noteTerminal(String code) {
    final OutboxTerminal? terminal = outboxTerminalOf(code);
    if (terminal == null) return;
    _terminalNotice = terminal;
    // G-20 ⑤: both terminals are decided during an action taken on the LIVE
    // screen (an admit that overflowed / a drain that found bytes gone), so the
    // live connection's identity IS the screen the news belongs to.
    _terminalNoticeInstanceId = _host.liveConnection.pairingIdentity;
    diag('outbox.terminal_notice', <String, Object?>{
      'code': code,
      'terminal': terminal.name,
    });
  }

  /// Shown already; stop re-showing. Separate from the counters: 「an overflow
  /// happened」 and 「whether the user has seen that sentence」 are different facts.
  void dismissTerminalNotice() {
    if (_terminalNotice == null) return;
    _terminalNotice = null;
    _terminalNoticeInstanceId = null;
    _host.onOutboxChanged();
  }

  /// Load the durable state at boot. Anything left at `inflight` from a previous
  /// process is returned to `queued`: the process that was waiting for its
  /// verdict is gone, so nothing will ever answer it, and leaving it inflight
  /// would strand it forever — the exact 「never park at inflight」 red line, in its
  /// across-restarts form.
  Future<void> load() async {
    final List<OutboxItem> pending = await _loadPendingMerged();
    int revived = 0;
    for (final OutboxItem item in pending) {
      if (item.state != OutboxDeliveryState.inflight) continue;
      await _persistItem(
        item.copyWith(
          state: OutboxDeliveryState.queued,
          lastRefusalNote: 'REVIVED_FROM_INFLIGHT_ON_BOOT',
        ),
        op: 'revive_on_boot',
      );
      revived++;
    }
    await _refreshDerived();
    diag('outbox.loaded', <String, Object?>{
      'pending': pendingCountTotal,
      'revived_from_inflight': revived,
    });
    _host.onOutboxChanged();
  }

  // ── enqueue ────────────────────────────────────────────────────────────────

  /// Put ONE text delivery on disk. Returns the durable item.
  ///
  /// [requestId] is minted by the CALLER and passed in, because the caller also
  /// needs it as the row's client id — but it is minted ONCE, at enqueue, and
  /// this item will re-send under it for the rest of its life (Gate 1).
  Future<OutboxItem?> enqueueText({
    required String requestId,
    required String entryId,
    /// 🔴 Whether this frame stamps `entry_id`. REQUIRED and explicitly nullable
    /// — never defaulted to [entryId]: passing the settle anchor is precisely the
    /// 窗口B3-2a regression (one id on a frame covering N rows ⇒ the PC writes
    /// that row's truth over all N). Answer 「did this delivery itself create
    /// that row」.
    required String? wireEntryId,
    List<String>? coveredEntryIds,
    required String source,
    required String text,
    required String mode,
    required DateTime createdAt,
    String? sourceText,
    String? deviceLabel, int? durationMs,
  }) async {
    final OutboxItem item = OutboxItem(
      requestId: requestId,
      entryId: entryId,
      wireEntryId: wireEntryId,
      // Defaults to just the representative — a delivery always settles at
      // least its own row. Never an empty list: a drained item that settles
      // NOTHING leaves the user's row at ⏳ with nobody left to move it.
      coveredEntryIds: coveredEntryIds == null || coveredEntryIds.isEmpty
          ? <String>[entryId]
          : List<String>.unmodifiable(coveredEntryIds),
      kind: OutboxPayloadKind.text,
      source: source,
      text: text,
      mode: mode,
      // 🔴 Gate 3 — the SPEAKING instant, handed in by the caller off the row.
      createdAt: createdAt,
      enqueuedAt: DateTime.now().toUtc(),
      sourceText: sourceText,
      deviceLabel: deviceLabel, durationMs: durationMs,
      // 🔴 Gate 2 — freeze the destination from the CURRENT connection, once.
      destinationMachineUid: _host.liveConnection.machineUid,
      destinationPairingIdentity: _host.liveConnection.pairingIdentity,
      enqueuedPcId: _host.liveConnection.pcId,
    );
    return _admit(item);
  }

  /// 🔴 A queued delivery MUST be born with a destination it can be redeemed at.
  ///
  /// WHY THIS GUARD EXISTS AND WHEN IT CAN FIRE. The queue's whole reason to
  /// exist is the offline window, so the first question asked of it is: when the
  /// link is down, is the frozen destination empty? It is NOT — and that safety
  /// rests on a property nobody had written down: `PttSession
  /// .clearConnectedInstance()` (which nulls all three identities) has exactly
  /// ONE caller in the repo, `connections_controller.dart:307 leaveRoom()`, i.e.
  /// the user deliberately leaving the session. A dropped socket, a
  /// backgrounded app and an EMUI-severed TCP do NOT call it, so the identities
  /// survive the outage and an enqueue during it freezes a complete address.
  ///
  /// This guard covers the one case where they are genuinely gone (after
  /// `leaveRoom`). Freezing an empty destination there would mint a ticket that
  /// can never be redeemed: `resolveOutboxTarget` would refuse it forever and it
  /// would sit in the queue being counted as 「not delivered」 for the life of the
  /// install. Refusing loudly at the door is the honest disposition.
  bool _hasRedeemableDestination(OutboxItem item) =>
      (item.destinationMachineUid != null &&
          item.destinationMachineUid!.isNotEmpty) ||
      (item.destinationPairingIdentity != null &&
          item.destinationPairingIdentity!.isNotEmpty);

  /// Put ONE picture delivery on disk — BYTES FIRST.
  ///
  /// Returns null when the bytes could not be written. That is reported, never
  /// swallowed: an item enqueued without its payload would be a promise with
  /// nothing behind it, and the drain would later refuse it for a reason the
  /// user could not act on.
  Future<OutboxItem?> enqueueImage({
    required String requestId,
    required String entryId,
    required Uint8List bytes,
    required String imageMime,
    required String extension,
    required String label,
    required String mode,
    required DateTime createdAt,
    String? thumbB64,
    String? deviceLabel,
  }) async {
    final String? path = await _blobs.put(
      requestId: requestId,
      bytes: bytes,
      extension: extension,
    );
    if (path == null) {
      diag('outbox.enqueue_refused', <String, Object?>{
        'request_id': requestId,
        'reason': 'BLOB_WRITE_FAILED',
        'bytes': bytes.length,
      });
      return null;
    }
    final OutboxItem item = OutboxItem(
      requestId: requestId,
      entryId: entryId,
      // A picture send ALWAYS builds its own row, so the frame names it.
      wireEntryId: entryId,
      // A picture is always exactly one row.
      coveredEntryIds: <String>[entryId],
      kind: OutboxPayloadKind.image,
      source: 'image',
      // The protocol requires `text`; a picture carries none. The DESCRIPTOR is
      // kept separately so nothing can accidentally type 「🖼 PNG · 214 KB」 into
      // the user's document and call it a delivery.
      text: '',
      mode: mode,
      createdAt: createdAt,
      enqueuedAt: DateTime.now().toUtc(),
      sourceText: null,
      entryType: 'image',
      thumbB64: thumbB64,
      imagePath: path,
      imageMime: imageMime,
      deviceLabel: deviceLabel,
      destinationMachineUid: _host.liveConnection.machineUid,
      destinationPairingIdentity: _host.liveConnection.pairingIdentity,
      enqueuedPcId: _host.liveConnection.pcId,
    );
    // `label` rides the local row, not the frame — kept out of the item so there
    // is exactly one producer of that string (owner RV-68 ruling).
    assert(label.isNotEmpty, 'an image row always has a descriptor');
    return _admit(item);
  }

  /// Persist a new item, enforce the cap, refresh the count. Null ⇒ refused at
  /// the door (see [_hasRedeemableDestination]).
  Future<OutboxItem?> _admit(OutboxItem item) async {
    if (!_hasRedeemableDestination(item)) {
      diag('outbox.enqueue_refused', <String, Object?>{
        'request_id': item.requestId,
        'reason': 'NO_DESTINATION',
      });
      return null;
    }
    // D9 ②: a failed write parks the item in [_unpersisted] and the enqueue
    // KEEPS GOING — the four call sites' contract is 「degrade durability, never
    // delivery」, and before this card a throw here aborted the whole send.
    await _persistItem(item, op: 'enqueue');
    // ⚠️ SELF-EXPOSING LINE — 「which parts of this item's addressing are
    // empty」. Ids and booleans
    // only: never the text, never the picture. A queued delivery whose
    // destination fields are all null is deliverable ONLY on its own pairing,
    // and this is the one place that fact is visible before it becomes a
    // mystery three days later.
    diag('outbox.enqueued', <String, Object?>{
      'request_id': item.requestId,
      'entry_id': item.entryId,
      'kind': item.kind.name,
      'source': item.source,
      'has_machine_uid': item.destinationMachineUid != null,
      'has_pairing_identity': item.destinationPairingIdentity != null,
      'has_enqueued_pc_id': item.enqueuedPcId != null,
      // D9 ②: false ⇒ this delivery will not survive a process death — the one
      // honest bit that separates 「queued」 from 「persisted to disk」.
      'persisted': !_unpersisted.containsKey(item.requestId),
      'created_at_age_ms':
          DateTime.now().toUtc().difference(item.createdAt).inMilliseconds,
    });
    await _enforceCapacity();
    await _refreshDerived();
    _host.onOutboxChanged();
    return item;
  }

  /// 🔴 Overflow MUST speak, and must not degrade into 「there was never
  /// anything there」.
  ///
  /// The oldest pending item is settled `refused('OUTBOX_OVERFLOW')` — a named
  /// terminal state, KEPT IN THE TABLE. It is not deleted, because a row that is
  /// gone cannot tell the user (or the next session) that it was ever dropped;
  /// that is precisely the degradation the PC timeline's trimming rule already
  /// banned. Oldest-first because the newest is what the user just said and is
  /// watching for.
  Future<void> _enforceCapacity() async {
    final List<OutboxItem> pending = await _loadPendingMerged();
    while (pending.length > _capacity) {
      final OutboxItem victim = pending.removeAt(0); // oldest
      final OutboxItem dropped = victim.copyWith(
        state: OutboxDeliveryState.refused,
        refusedCode: kOutboxOverflow,
      );
      await _persistItem(dropped, op: 'overflow');
      // 🔴 RV-93 — the picture is NOT deleted here. Overflow drops the DELIVERY,
      // and the row it belongs to is still on the user's timeline showing that
      // picture; deleting the bytes would empty the tap-to-enlarge view for a row nobody removed.
      _overflowed++;
      _noteTerminal(kOutboxOverflow);
      diag('outbox.overflow', <String, Object?>{
        'dropped_request_id': victim.requestId,
        'cap': _capacity,
        'overflowed_total': _overflowed,
      });
    }
  }

  // ── drain ──────────────────────────────────────────────────────────────────

  bool _draining = false;

  /// Attempt every pending item, oldest first.
  ///
  /// ORDER OF OPERATIONS IS THE CONTRACT (design draft §3.5 then §3.3):
  ///   1. re-seed the destination — or the queue flies out with no target;
  ///   2. prove the link with an ACKED round trip — or every item is marked
  ///      inflight into a dead pipe and the whole queue is lost at once;
  ///   3. only then, address and send each item.
  ///
  /// 🔴 [userRequestedEntryIds] — L8 (owner 2026-08-02). The rows the USER just
  /// asked for, by pressing something (➤ / frequently-used / inline resend).
  /// owner: 「manual user action … the user pressed a key, there is
  /// readiness」 ⇒ those may be injected, unconditionally and without
  /// looking at the clock; everything ELSE this drain carries is an automatic
  /// backfill delivery and must not be.
  ///
  /// ⚠️ IT IS A SET OF ROWS AND NOT A FLAG ON THE DRAIN, because a drain is never
  /// only about one item: `ManualDelivery.deliverText` enqueues the sentence the
  /// user just sent and then drains THE WHOLE QUEUE, so one pass routinely carries
  /// 「the one the user just pressed」 next to 「three that piled up after last
  /// night's disconnect」. A per-drain flag would stamp
  /// them all alike — and it would stamp them alike in the dangerous direction.
  Future<OutboxDrainReport> drain({
    Set<String> userRequestedEntryIds = const <String>{},
  }) async {
    if (_draining) {
      return const OutboxDrainReport(
        attempted: 0,
        sent: 0,
        held: <String, OutboxAddressRefusal>{},
        refused: <String, String>{},
        linkOk: false,
      );
    }
    _draining = true;
    try {
      final List<OutboxItem> pending = await _loadPendingMerged();
      final List<OutboxItem> queued = pending
          .where((OutboxItem i) => i.state == OutboxDeliveryState.queued)
          .toList();
      if (queued.isEmpty) {
        return const OutboxDrainReport(
          attempted: 0,
          sent: 0,
          held: <String, OutboxAddressRefusal>{},
          refused: <String, String>{},
          linkOk: true,
        );
      }
      await _host.reseedDestination();
      final bool linkOk = await _host.ensureLink();
      diag('outbox.drain_begin', <String, Object?>{
        'queued': queued.length,
        'link_ok': linkOk,
      });
      if (!linkOk) {
        // Nothing moves. Not a failure of any item — the pipe is not there, and
        // owner ruled these wait however long it takes.
        return OutboxDrainReport(
          attempted: 0,
          sent: 0,
          held: <String, OutboxAddressRefusal>{
            for (final OutboxItem i in queued)
              i.requestId: OutboxAddressRefusal.noConnection,
          },
          refused: <String, String>{},
          linkOk: false,
        );
      }
      int sent = 0;
      final Map<String, OutboxAddressRefusal> held =
          <String, OutboxAddressRefusal>{};
      final Map<String, String> refused = <String, String>{};
      for (final OutboxItem item in queued) {
        final _Attempt outcome = await _attempt(
          item,
          // 🔴 Per ITEM. `coveredEntryIds` and not `entryId`: a ➤ over N buffered
          // utterances is ONE delivery covering N rows, and the caller names the
          // rows it just sent — asking only about the representative would leave
          // the other N-1 judged as a backfill delivery inside the very press that produced them.
          userRequested: item.coveredEntryIds.any(userRequestedEntryIds.contains),
        );
        if (outcome.held != null) {
          held[item.requestId] = outcome.held!;
        } else if (outcome.refusedCode != null) {
          refused[item.requestId] = outcome.refusedCode!;
        } else {
          sent++;
        }
      }
      await _refreshDerived();
      _host.onOutboxChanged();
      return OutboxDrainReport(
        attempted: queued.length,
        sent: sent,
        held: held,
        refused: refused,
        linkOk: true,
      );
    } finally {
      _draining = false;
    }
  }

  // ── attempt ────────────────────────────────────────────────────────────────
  //
  // 800-line cap: `_attempt` moved VERBATIM to delivery_outbox_attempt.dart (a
  // `part` of this library — see that file's header for the cut). It stayed an
  // INSTANCE member rather than becoming a `outboxX(box, …)` top-level like the
  // three parts above, so the body needed no receiver edits at all and the call
  // site in [drain] above is byte-for-byte what it was.

  // ── settle ─────────────────────────────────────────────────────────────────
  //
  // 卡 L8 800-line cap: the BODY moved VERBATIM to delivery_outbox_settle.dart
  // (a `part` of this library — see that file's header for the cut and why the
  // receiver became explicit). The METHOD stays here, so every caller and every
  // test double is byte-for-byte unchanged: a structural split that forces its
  // callers to be edited is not 「move only, no behavior change」.

  /// The PC answered. See [outboxSettle] for the whole rule.
  ///
  /// 🔴 `inflight → delivered` is flipped by the PC's own `inject:result` and by
  /// nothing else — not a timer, not an emit returning true.
  Future<void> settle({
    required String correlationId,
    required bool ok,
    String? code,
  }) => outboxSettle(this, correlationId: correlationId, ok: ok, code: code);

  /// The derived-state recompute, reachable from the settle part file.
  ///
  /// ⚠️ Named rather than left as `_refreshDerived` because a `part` may reach a
  /// private member but a READER should not have to prove that to themselves —
  /// and because 「who is allowed to recompute derived state」 is worth one grep-able name. Same one-pass
  /// projection ([OutboxPendingView]); there is no second implementation.
  Future<void> refreshDerivedForSettle() => _refreshDerived();

  /// Load a queued picture's bytes for a send. Null ⇒ the bytes are gone and the
  /// item must be settled `OUTBOX_IMAGE_BYTES_GONE` rather than sent empty.
  Future<Uint8List?> imageBytes(OutboxItem item) {
    final String? path = item.imagePath;
    if (path == null || path.isEmpty) return Future<Uint8List?>.value();
    return _blobs.read(path);
  }

  void dispose() {
    for (final Timer t in _watchdogs.values) {
      t.cancel();
    }
    _watchdogs.clear();
  }
}
