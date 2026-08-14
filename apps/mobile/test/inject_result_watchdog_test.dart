// v0.2.8 — a delivery whose result never comes must FAIL, not wait forever.
//
// owner 2026-07-29, sending a picture:「手机端这边是能够正常看得到图片，但是 PC
// 这端是没有接收到这个图片，也没有相应的消息」.
//
// Everything downstream was verified at the time: a 258 KB image pushed through
// the LIVE LAN chain reached the PC and came back with a real verdict
// (`INJECT_NO_TEXT_TARGET` — the machine was unattended), and the server logs
// every malformed frame it drops, having logged none. So the frame was not
// leaving the phone — and NOTHING anywhere said so, because the send armed its
// correlation with no deadline at all.
//
// `emitInject` returns true whenever the socket call did not throw, which for
// socket.io means 「the frame was handed over」, not 「it left」. The only proof
// of delivery this path has is the PC's own `inject:result`, so its ABSENCE is
// a failure and the row has to say so. Red line F2, verbatim: 任何「成功」回执要能
// 回答「凭什么知道对方收到了」. The AI-compose path has had exactly this
// watchdog since day one; this one was simply never given it.
//
// Tested at the layer that OWNS the timer rather than through the image
// harness: the picker/thumbnail path needs real platform image decode, and the
// rule under test has nothing to do with pictures. A short injected timeout
// keeps it fast and honest.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/session/manual_delivery.dart';
import 'package:flowmic/src/signaling/inbound_payloads.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'package:flowmic/src/session/delivery_outbox.dart';
import 'support/di.dart';

/// Stable instance id for rows this rig births — RV-17 reflush filters on it.
const String _kRigInstanceId = 'standalone|instance:watchdog-pc';

class _RigOwner implements InstanceOwnerProbe {
  @override
  String? get instanceId => _kRigInstanceId;
  @override
  String? get instanceName => 'watchdog-pc';
}

class _Host implements ManualDeliveryHost {
  /// Kept as a field (rather than built inline) so a case can reach the queue's
  /// drain host — card B4-18's 「a new send first retracts the previous conclusion」
  /// runs a real `deliverText`, which enqueues and drains.
  final RecordingDrainHost drainHost = RecordingDrainHost();
  @override
  late final DeliveryOutbox outbox = newTestOutbox(host: drainHost);

  _Host(this.store, this.syncGate);
  @override
  final TimelineStore store;
  @override
  final TimelineSyncGate syncGate;

  /// RV-02: the link gate every explicit delivery judges itself by. Mutable so a
  /// test can say 「the client already knows the link is down」 — which is a
  /// different fact from 「the emit was refused」 and gets a different answer.
  bool linkUp = true;
  @override
  bool get canCompose => linkUp;
  @override
  bool get noPcTarget => false;
  @override
  FlowMode get mode => FlowMode.realtime;
  @override
  String? get pcDisplayName => 'Studio PC';
  @override
  String? get targetPcId => 'pc-studio-test';

  /// Card B4-18 — 「which instance does this transcript screen belong to now」.
  /// MUTABLE on purpose: the whole defect is that ONE app-level ChatController
  /// serves every instance in turn, so a fixed value here could never have
  /// caught it. Production changes this value through
  /// `PttSession.applyPairedIdentity` / `clearConnectedInstance`.
  String? instanceId = 'inst-watchdog';
  @override
  String? get deliveryInstanceId => instanceId;

  @override
  void deliveryNotify() {}
  // RCA-v3 seams: the watchdog suite never exercises link recovery.
  @override
  Future<void> kickLink() async {}
  @override
  Future<bool> awaitLinkUp(Duration timeout) async => true;
  @override
  LanImageIngress? get lanImageIngress => null;
}

class _Rig {
  _Rig({Duration timeout = const Duration(milliseconds: 40)}) {
    transport = FakeSocketTransport();
    store = TimelineStore(
      persistence: InMemoryTimelinePersistence(),
      reaper: newTestReaper(),
      owner: _RigOwner(),
    );
    gate = TimelineSyncGate(transport: transport);
    host = _Host(store, gate);
    delivery = ManualDelivery(
      host: host,
      gate: ComposeGate(transport: transport),
      resultTimeout: timeout,
    );
  }
  late final FakeSocketTransport transport;
  late final TimelineStore store;
  late final TimelineSyncGate gate;
  late final _Host host;
  late final ManualDelivery delivery;

  /// One in-flight delivery covering one row — exactly the shape an image send
  /// builds (row first, then the emit, then the correlation is armed).
  String arm() {
    final String requestId = delivery.mintRequestId('i');
    final TimelineEntry e = delivery.buildDeliveryRow(
      clientId: requestId,
      text: '[图片] PNG 12 KB',
      entryType: TimelineEntry.kImage,
    );
    delivery.armInFlight(requestId, <String>[e.id]);
    return e.id;
  }

  /// [n] rows covered by ONE send — the shape a manual ➤ over N buffered
  /// utterances has, and the shape RV-15 is about.
  List<String> buildRows(int n) => <String>[
    for (int i = 0; i < n; i++)
      delivery
          .buildDeliveryRow(
            clientId: delivery.mintRequestId('m'),
            text: '第 $i 段',
          )
          .id,
  ];

  EntryStatus statusOf(String id) =>
      store.entries.firstWhere((TimelineEntry e) => e.id == id).status;

  TimelineEntry entryOf(String id) => store.findById(id)!;

  /// A PC-bound row catch-up delivery (补投) acts on.
  ///
  /// 0.2.27: `syncedRow` and `localRow` used to be two DIFFERENT shapes — the
  /// server-held row and the 「left on the phone」 row a catch-up delivery had
  /// to register first. With the uplink retired there is one shape (owner
  /// architecture ruling: the phone owns the row), so `syncedRow` is now the
  /// same row under its old name, kept so the RV-02 cases below read unchanged.
  TimelineEntry syncedRow(String text) => localRow(text);

  TimelineEntry localRow(String text) => store.buildFromUtterance(
    clientId: delivery.mintRequestId('r'),
    mode: FlowMode.realtime,
    delivery: Delivery.inject,
    text: text,
  );

  /// The row ids that actually left the device as `history:inject`, in emission
  /// order — counted on the WIRE, never through an `extends`-based spy.
  /// The rows a catch-up delivery (补投) put on the wire, in order.
  ///
  /// 0.2.27: read off `inject:request` frames with `source:'history'` instead of
  /// off `history:inject{id}`. Catch-up delivery carries its own text now (the
  /// server cannot look the row up), and `entry_id` is the same correlation key
  /// it always was.
  List<Map<String, Object?>> get reinjectFrames => transport
      .emittedWhere(FlowMicEvents.injectRequest)
      .map((EventEnvelope e) => Map<String, Object?>.from(e.data! as Map))
      .where((Map<String, Object?> f) => f['source'] == 'history')
      .toList();

  List<String> get injectedIds =>
      reinjectFrames.map((Map<String, Object?> f) => f['entry_id']! as String).toList();

  void dispose() {
    delivery.dispose();
    // Card B4-18: the queue arms its own per-item watchdog, and a case that really
    // enqueues would otherwise leave one live past teardown.
    host.outbox.dispose();
    store.dispose();
  }
}

void main() {
  test('a delivery the PC never answers settles as failed with a NAMED reason',
      () async {
    final _Rig r = _Rig();
    final String id = r.arm();
    // Still legitimately in flight. The PC pipeline does a foreground switch,
    // an 80 ms clipboard settle and up to 700 ms of read-back verification —
    // crying early is its own kind of lie, which is why production waits 20 s.
    expect(r.statusOf(id), EntryStatus.cached);
    expect(r.delivery.failure, isNull);

    await Future<void>.delayed(const Duration(milliseconds: 140));
    expect(r.statusOf(id), EntryStatus.failed);
    expect(r.delivery.failure, ComposeSendFailure.noResult);
    r.dispose();
  });

  test('a result that DOES arrive disarms the watchdog', () async {
    // Otherwise a settled row would flip to failed twenty seconds later — a
    // worse lie than the silence being fixed.
    final _Rig r = _Rig();
    final String id = r.arm();
    r.delivery.applyInjectResult(
      InjectResult(ok: true, mode: 'clipboard', entryId: id),
      r.store,
    );
    expect(r.statusOf(id), EntryStatus.injected);

    await Future<void>.delayed(const Duration(milliseconds: 140));
    expect(r.statusOf(id), EntryStatus.injected,
        reason: 'a settled row must never be re-settled by a stale timer');
    expect(r.delivery.failure, isNull);
    r.dispose();
  });

  test('two sends in flight keep their OWN deadlines — neither borrows the '
      "other's", () async {
    final _Rig r = _Rig();
    final String first = r.arm();
    await Future<void>.delayed(const Duration(milliseconds: 25));
    final String second = r.arm();
    await Future<void>.delayed(const Duration(milliseconds: 25));
    expect(r.statusOf(second), EntryStatus.cached,
        reason: "the FIRST send's deadline must not settle the second's row");
    // RV-02: and the first send settles on its own deadline. While this class
    // held ONE slot, the second arm overwrote it and cancelled the first
    // watchdog — so an unanswered first send was silently orphaned at ⏳, the
    // exact failure this timer exists to prevent.
    expect(r.statusOf(first), EntryStatus.failed);
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect(r.statusOf(second), EntryStatus.failed);
    r.dispose();
  });

  test('dispose cancels the timer — nothing is written after teardown', () async {
    final _Rig r = _Rig();
    final String id = r.arm();
    r.delivery.dispose();
    await Future<void>.delayed(const Duration(milliseconds: 140));
    expect(r.statusOf(id), EntryStatus.cached,
        reason: 'a disposed delivery must not keep writing to the store');
    r.store.dispose();
  });

  // ── RV-15 ────────────────────────────────────────────────────────────────
  // The banner's 重发 used to walk the store for the NEWEST failed row, because
  // this class settled every covered row as ✗ and then told nobody WHICH rows
  // they were. These four cases pin the exposed answer and its lifetime; the
  // banner half is in send_retry_banner_test.dart.
  group('RV-15: the failed batch is stated, not left to be guessed', () {
    test('a wire failure over N rows records ALL N ids, in send order', () {
      final _Rig r = _Rig();
      final List<String> ids = r.buildRows(3);
      r.delivery.failSettled(ids, ComposeSendFailure.wireFailed);

      expect(r.delivery.lastFailedCoveredIds, ids);
      for (final String id in ids) {
        expect(r.statusOf(id), EntryStatus.failed,
            reason: 'every covered row is ✗ — that is why all of them are '
                'retryable');
      }
      r.dispose();
    });

    test('a watchdog timeout over N rows records ALL N ids too', () async {
      final _Rig r = _Rig();
      final List<String> ids = r.buildRows(3);
      r.delivery.armInFlight('m-req-0', ids);
      expect(r.delivery.lastFailedCoveredIds, isEmpty,
          reason: 'arming a send clears whatever the previous banner covered');

      await Future<void>.delayed(const Duration(milliseconds: 140));
      expect(r.delivery.failure, ComposeSendFailure.noResult);
      expect(r.delivery.lastFailedCoveredIds, ids);
      r.dispose();
    });

    test('the batch never outlives its banner: dismiss and a send that reached '
        'the wire both clear it', () {
      final _Rig r = _Rig();
      final List<String> ids = r.buildRows(2);

      r.delivery.failSettled(ids, ComposeSendFailure.wireFailed);
      r.delivery.dismissFailure();
      expect(r.delivery.lastFailedCoveredIds, isEmpty);

      r.delivery.failSettled(ids, ComposeSendFailure.wireFailed);
      // A later send got onto the wire: offering 重发 for rows that send has
      // already re-covered would deliver the same words twice.
      r.delivery.armInFlight('m-req-1', r.buildRows(1));
      expect(r.delivery.lastFailedCoveredIds, isEmpty);
      r.dispose();
    });

    test('a failure that settled NO rows does not inherit an earlier batch', () {
      // The case that would bite: a QuickAction control key fails on the wire
      // and raises the SAME wireFailed reason the banner offers 重发 for. It
      // settled nothing, so it must carry nothing — otherwise one ✕ key press
      // would offer to re-deliver an earlier send's rows.
      final _Rig r = _Rig();
      r.delivery.failSettled(r.buildRows(2), ComposeSendFailure.wireFailed);
      expect(r.delivery.lastFailedCoveredIds, hasLength(2));

      r.delivery.raise(ComposeSendFailure.wireFailed);
      expect(r.delivery.failure, ComposeSendFailure.wireFailed);
      expect(r.delivery.lastFailedCoveredIds, isEmpty);
      r.dispose();
    });
  });

  // ── RV-02 ────────────────────────────────────────────────────────────────
  // Catch-up delivery (补投) was the FOURTH delivery path and the only one that
  // answered 「did it go out」 with silence: no watchdog, a swallowed emit
  // failure, and an optimistic markSynced (retired in 0.2.27 with the server
  // row it claimed). All four production entry points (in-row ✗ 重发 /
  // long-press 补投 / resend-after-edit / banner 重发) call
  // ChatController.reInject, which is now one line onto ManualDelivery.reInject
  // — so every case below covers all four of them.
  group('RV-02: catch-up delivery (补投) answers for itself', () {
    test('one the PC never answers stops pretending: ✗ with a NAMED reason',
        () async {
      final _Rig r = _Rig();
      final TimelineEntry row = r.syncedRow('这句要补投');
      expect(await r.delivery.reInject(row), isNull);
      expect(r.injectedIds, <String>[row.id]);
      expect(r.statusOf(row.id), EntryStatus.cached,
          reason: 'legitimately in flight — the PC pipeline is slow by design');

      await Future<void>.delayed(const Duration(milliseconds: 140));
      expect(r.statusOf(row.id), EntryStatus.failed,
          reason: 'before this card it stayed at ⏳ for the rest of the session');
      expect(r.entryOf(row.id).failureReason, 'INJECT_NO_RESULT');
      expect(r.delivery.failure, ComposeSendFailure.noResult);
      expect(r.delivery.lastFailedCoveredIds, <String>[row.id]);
      r.dispose();
    });

    test('a verdict that DOES arrive releases the deadline', () async {
      final _Rig r = _Rig();
      final TimelineEntry row = r.syncedRow('补投成功的一句');
      await r.delivery.reInject(row);
      r.delivery.applyInjectResult(
        InjectResult(ok: true, mode: 'clipboard', entryId: row.id),
        r.store,
      );
      expect(r.statusOf(row.id), EntryStatus.injected);

      await Future<void>.delayed(const Duration(milliseconds: 140));
      expect(r.statusOf(row.id), EntryStatus.injected,
          reason: 'a stale timer flipping a delivered row to ✗ would be a worse '
              'lie than the silence being fixed');
      expect(r.delivery.failure, isNull);
      r.dispose();
    });

    test('an emit that never left the device is a NAMED ✗, never a ⏳', () async {
      final _Rig r = _Rig();
      final TimelineEntry row = r.syncedRow('发不出去的一句');
      // TimelineSyncGate.emitInject used to swallow this and return void.
      r.transport.failEmits = true;
      expect(await r.delivery.reInject(row), ComposeSendFailure.wireFailed);
      expect(r.statusOf(row.id), EntryStatus.failed);
      expect(r.entryOf(row.id).failureReason, 'WIRE_EMIT_FAILED');
      expect(r.delivery.failure, ComposeSendFailure.wireFailed);
      r.dispose();
    });

    test('a link the client KNOWS is down fails at once and emits nothing', () async {
      final _Rig r = _Rig();
      final TimelineEntry row = r.syncedRow('断线时按下的重发');
      r.host.linkUp = false;
      expect(await r.delivery.reInject(row), ComposeSendFailure.notConnected);
      expect(r.injectedIds, isEmpty,
          reason: 'no point handing a frame to a link we already know is dead');
      expect(r.statusOf(row.id), EntryStatus.failed);
      expect(r.entryOf(row.id).failureReason, 'LINK_DOWN',
          reason: '「link known down」 and 「socket refused」 are different facts');
      r.dispose();
    });

    test('a row deleted since the banner went up is not re-sent', () async {
      // Otherwise the verdict would fall back onto lastAwaitingInject and write
      // this delivery's truth onto somebody else's row.
      final _Rig r = _Rig();
      final TimelineEntry row = r.syncedRow('待会儿被删掉');
      r.store.delete(row.id);
      expect(await r.delivery.reInject(row), isNull);
      expect(r.injectedIds, isEmpty);
      r.dispose();
    });

    // ── 0.2.27 (card A1 ①): catch-up delivery (补投) supplies its own text ──
    //
    // These two cases replace the pair that used to live here ('an unsynced row
    // is NOT stamped synced until the create ack lands' / '…IS stamped when it
    // lands'). Both were about `history:create` registering a 「left on the
    // phone」 row so the server could look its text up for `history:inject`.
    // The server holds no rows now (owner architecture ruling), so the OWNER
    // supplies the words — and that is what has to be proven instead.
    test('catch-up delivery (补投) carries the row\'s own text as inject:request{source:history}, and '
        'asks the retired history table for nothing', () async {
      final _Rig r = _Rig();
      final TimelineEntry row = r.localRow('从未同步过的一句');
      await r.delivery.reInject(row);
      await pumpEventQueue();

      expect(r.reinjectFrames, hasLength(1));
      final Map<String, Object?> f = r.reinjectFrames.single;
      // The words, from the row this device owns — not an id for someone else to
      // resolve. This is the whole card: 「补投 collapsed onto inject:request」.
      expect(f['text'], '从未同步过的一句');
      expect(f['source'], 'history',
          reason: 'byte-for-byte the frame history.handler.ts used to emit, so '
              'the PC sees the frame it has always seen for a catch-up delivery (补投)');
      expect(f['entry_id'], row.id, reason: 'A-58: the verdict comes back on it');
      // RV-72前置 flipped this. It used to assert `request_id` was ABSENT, under
      // 「one delivery, one correlation key」 — but `entry_id` was then answering
      // two questions at once (「which row」 for A-58 and 「which delivery」 for
      // the queue's idempotency), which is this repo's #1 bug shape. The two
      // are now split: entry_id keeps the row, request_id names THIS delivery,
      // and they must not be the same value or the split is decorative.
      expect(f['request_id'], isNotNull);
      expect(f['request_id'], isNot(row.id));
      // The claim is still keyed on entry_id (`InjectResult.correlationId`
      // prefers it), which is what the timeout case below goes on proving.
      // No history:* frame at all — not the create it used to register with, not
      // the inject it used to ask for.
      for (final String retired in <String>[
        FlowMicEvents.historyCreate,
        FlowMicEvents.historyInject,
        FlowMicEvents.historyUpdate,
        FlowMicEvents.historyDelete,
      ]) {
        expect(r.transport.emittedNames, isNot(contains(retired)));
      }
      r.dispose();
    });

    test('a row with nothing to say emits nothing and claims nothing', () async {
      // Before 0.2.27 the server supplied the text, so this phone could not see
      // the case: the frame went out with an empty `text`, the PC answered
      // ok:true, and the row settled ✓ injected with nothing typed anywhere.
      //
      // An invariant guard, in the same 「structurally inert」 shape as the cloud
      // and image gates: no frame, no banner, and the row's settled truth is NOT
      // disturbed into a fake ⏳ or a ✗ nobody caused. (`localRow` builds with a
      // blank face; a REAL row cannot reach this state — see reInject's comment.)
      final _Rig r = _Rig();
      final TimelineEntry row = r.localRow('   ');
      final EntryStatus before = r.statusOf(row.id);
      expect(await r.delivery.reInject(row), isNull);
      expect(r.reinjectFrames, isEmpty);
      expect(r.delivery.failure, isNull);
      expect(r.statusOf(row.id), before);
      r.dispose();
    });

    test('three rows re-injected in ONE banner press: every verdict lands on its '
        'own row, and only the unanswered row is a casualty', () async {
      final _Rig r = _Rig();
      final List<TimelineEntry> rows = <TimelineEntry>[
        r.syncedRow('甲'),
        r.syncedRow('乙'),
        r.syncedRow('丙'),
      ];
      // Exactly the shape of chat_flow_page._retryFailedSend: one reInject per
      // row, nothing awaited in between — three deliveries in flight at once.
      for (final TimelineEntry e in rows) {
        await r.delivery.reInject(e);
      }
      expect(r.injectedIds, <String>[rows[0].id, rows[1].id, rows[2].id]);

      // Verdicts come back OUT OF ORDER, and one never comes at all.
      r.delivery.applyInjectResult(
        InjectResult(ok: true, mode: 'clipboard', entryId: rows[2].id),
        r.store,
      );
      r.delivery.applyInjectResult(
        InjectResult(
          ok: false,
          mode: 'cached',
          error: 'INJECT_FOCUS_LOST',
          entryId: rows[0].id,
        ),
        r.store,
      );
      expect(r.statusOf(rows[2].id), EntryStatus.injected);
      expect(r.entryOf(rows[0].id).failureReason, 'INJECT_FOCUS_LOST');
      expect(r.statusOf(rows[1].id), EntryStatus.cached,
          reason: 'still legitimately in flight');

      await Future<void>.delayed(const Duration(milliseconds: 140));
      expect(r.statusOf(rows[1].id), EntryStatus.failed);
      expect(r.entryOf(rows[1].id).failureReason, 'INJECT_NO_RESULT');
      expect(r.statusOf(rows[2].id), EntryStatus.injected,
          reason: "one row's deadline must never re-settle another's answered row");
      expect(r.entryOf(rows[0].id).failureReason, 'INJECT_FOCUS_LOST');
      expect(r.delivery.lastFailedCoveredIds, <String>[rows[1].id],
          reason: 'the banner names the row that actually went unanswered, not '
              'the whole press');
      r.dispose();
    });

    test('a catch-up delivery (补投) retires ONLY its own row from the banner batch, and leaves the '
        'banner standing', () async {
      final _Rig r = _Rig();
      final List<TimelineEntry> rows = <TimelineEntry>[
        r.syncedRow('甲'),
        r.syncedRow('乙'),
        r.syncedRow('丙'),
      ];
      final List<String> ids =
          rows.map((TimelineEntry e) => e.id).toList(growable: false);
      r.delivery.failSettled(ids, ComposeSendFailure.wireFailed);

      await r.delivery.reInject(rows[1]);
      expect(r.delivery.lastFailedCoveredIds, <String>[ids[0], ids[2]],
          reason: '乙 is on its way — offering 重发 for it again would deliver '
              'the same words twice');
      expect(r.delivery.failure, ComposeSendFailure.wireFailed,
          reason: 'a catch-up delivery (补投) of one row must not silently sweep away a visible '
              'failure about the others (「没有静默失败」 cuts both ways)');
      r.dispose();
    });
  });

  // ── Card B4-18 ────────────────────────────────────────────────────────────
  // The third instance of 「the whole app has only one ChatController」. The
  // first two are already fixed: RV-91's 「还有 N 条未投递」 is bucketed by
  // `connectedInstanceId`, and RV-97's picture-failure banner likewise. The
  // third is the **text-send failure banner** (`ManualDelivery.failure`) —
  // hit a send failure on instance A, switch to instance B's transcript page,
  // and that red bar is still hanging there, with nothing on B to explain it.
  //
  // 🔴 The reverse control is written into every case: the positive half
  // (visible on A's own screen / visible again after returning to A) must be
  // green at the same time, otherwise 「not visible on B」 may just mean the
  // probe is blind, not that the implementation is right.
  group('card B4-18: the text-send failure banner is isolated per instance', () {
    test('a failure on instance A does not appear on instance B\'s screen, and is still there after returning to A', () {
      final _Rig r = _Rig();
      r.host.instanceId = 'inst-A';
      final List<String> ids = r.buildRows(2);
      r.delivery.failSettled(ids, ComposeSendFailure.wireFailed);
      expect(r.delivery.failure, ComposeSendFailure.wireFailed,
          reason: 'positive control: the screen where the failure happened must be able to see it (no silent failure)');

      // User backed out to the list and entered another computer's transcript page.
      r.host.instanceId = 'inst-B';
      expect(r.delivery.failure, isNull,
          reason: '🔴 THE CARD: B\'s screen must not hang a red bar that is about A');

      r.host.instanceId = 'inst-A';
      expect(r.delivery.failure, ComposeSendFailure.wireFailed,
          reason: 'it was hidden, not dropped — dropping it would silently swallow '
              'a failure nobody has seen, which is the other half of F2');
      r.dispose();
    });

    test('a new send on B must not clear a failure on A that nobody has seen yet', () {
      final _Rig r = _Rig();
      r.host.instanceId = 'inst-A';
      final List<String> ids = r.buildRows(2);
      r.delivery.failSettled(ids, ComposeSendFailure.wireFailed);

      r.host.instanceId = 'inst-B';
      // 「the previous conclusion is void」 holds only for **this screen**: a
      // delivery on B has nothing to do with that failure on A.
      r.delivery.armInFlight('m-req-on-B', r.buildRows(1));
      expect(r.delivery.failure, isNull, reason: 'B could not see it to begin with');

      r.host.instanceId = 'inst-A';
      expect(r.delivery.failure, ComposeSendFailure.wireFailed,
          reason: 'sending a sentence elsewhere does not constitute 「that failure on A no longer counts」');
      expect(r.delivery.lastFailedCoveredIds, ids,
          reason: 'the resend batch follows its own banner');
      r.dispose();
    });

    test('the watchdog records 「which screen this delivery was sent from」, not which screen is being looked at when it times out',
        () async {
      final _Rig r = _Rig();
      r.host.instanceId = 'inst-A';
      final String id = r.arm();
      // Within 20 s (40 ms here) the user switched away. This is the only path
      // that blows up if 「instance」 is read at raise time: `_raise` would get B.
      r.host.instanceId = 'inst-B';
      await Future<void>.delayed(const Duration(milliseconds: 140));

      expect(r.statusOf(id), EntryStatus.failed,
          reason: 'the row still settles ✗ — it lives on A\'s timeline, independent of which screen the user is looking at');
      expect(r.delivery.failure, isNull,
          reason: '🔴 B\'s screen must not sprout a red bar about A out of nowhere');

      r.host.instanceId = 'inst-A';
      expect(r.delivery.failure, ComposeSendFailure.noResult,
          reason: 'positive control: back on A, that timeout still has to be spoken');
      expect(r.delivery.lastFailedCoveredIds, <String>[id]);
      r.dispose();
    });

    test('the same batch later really delivers ⇒ the red bar is retracted; it must not stand next to a ✓', () {
      // wireFailed / linkDown / noResult all **do not drop** this delivery: the
      // queue item is still owed, the next drain sends it, the PC types it in,
      // the row becomes ✓ — and the red bar underneath is still saying the opposite.
      final _Rig r = _Rig();
      final List<String> ids = r.buildRows(2);
      r.delivery.failSettled(ids, ComposeSendFailure.wireFailed);
      expect(r.delivery.failure, ComposeSendFailure.wireFailed);

      r.delivery.applyInjectResult(
        InjectResult(ok: true, mode: 'clipboard', entryId: ids.first),
        r.store,
      );
      expect(r.statusOf(ids.first), EntryStatus.injected);
      expect(r.delivery.failure, isNull,
          reason: '🔴 the other half of red line F2: do not say a done thing was not done');
      expect(r.delivery.lastFailedCoveredIds, isEmpty,
          reason: 'the banner is gone, its resend batch must follow');
      r.dispose();
    });

    test('another row delivering, or the same row failing again, does not count as 「disproof」', () {
      // Negative control, two legs: a blanket-clear implementation goes red at
      // the first, an implementation that conflates ok with !ok goes red at the
      // second.
      final _Rig r = _Rig();
      final List<String> ids = r.buildRows(2);
      final String unrelated = r.buildRows(1).single;
      r.delivery.failSettled(ids, ComposeSendFailure.wireFailed);

      r.delivery.applyInjectResult(
        InjectResult(ok: true, mode: 'clipboard', entryId: unrelated),
        r.store,
      );
      expect(r.delivery.failure, ComposeSendFailure.wireFailed,
          reason: 'an unrelated success must not casually sweep away someone else\'s banner');

      r.delivery.applyInjectResult(
        InjectResult(
          ok: false,
          mode: 'cached',
          error: 'INJECT_FOCUS_LOST',
          entryId: ids.first,
        ),
        r.store,
      );
      expect(r.delivery.failure, ComposeSendFailure.wireFailed,
          reason: 'a failed receipt does not contradict 「it never left」, so it must not be retracted');
      r.dispose();
    });

    test('a new send first retracts the previous conclusion — the red bar must not stand next to 「sending」', () async {
      final _Rig r = _Rig();
      r.delivery.failSettled(r.buildRows(1), ComposeSendFailure.wireFailed);
      expect(r.delivery.failure, ComposeSendFailure.wireFailed);

      // Do not await: retracting the conclusion happens before the first await
      // (snapshot rule), so at this moment the UI already has only the
      // 「sending」 conclusion left.
      final Future<ComposeSendFailure?> sending =
          r.delivery.deliverText('再发一次', covered: const <String>[]);
      expect(r.delivery.failure, isNull,
          reason: '🔴 same calibre as RV-97 ③: one screen may hold only one conclusion at a time');
      expect(await sending, isNull, reason: 'positive control: this one really went out');
      r.dispose();
    });
  });

  test('the production budget is generous, not twitchy', () {
    // A short timeout would turn a slow-but-successful paste into a false
    // failure — exactly the opposite mistake, and a more damaging one.
    expect(kInjectResultTimeout.inSeconds, greaterThanOrEqualTo(10));
  });
}
