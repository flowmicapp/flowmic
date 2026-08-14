// 0.2.27 acceptance — THE HISTORY UPLINK IS GONE, PROVEN AT RUNTIME.
//
// owner architecture ruling (docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md):
// phone↔PC does no cloud storage sync; the cloud does not store transcripts. The phone OWNS its timeline.
//
// WHAT THIS FILE USED TO BE: the C5 acceptance suite (owner 2026-07-30 ruling ③
// 「两端改删互不推、但都上行云端、冲突以服务器为准」) — six exit criteria over the edit
// uplink, the conflict verdict and `markSynced`. Every one of them asserted a
// conversation with a server that does not hold these rows any more, so they went
// with `pushEdit` / `pushRowEdit` / `emitDelete` / the two conflict outcomes / the
// banner / the two i18n sentences.
//
// WHAT IT IS NOW, and why keeping the file beats deleting it: card A1 item 2 is
// 「停止上行」 ("stop the uplink"), and a grep proves only that no CALL exists in the files I thought to
// look at. This drives the REAL ChatController + TimelineStore + TimelineSyncGate
// over a fake socket through every path that used to uplink — hand edit, second
// edit, punctuation key, delete, deferred catch-up, the 「仅记录」 red line, and the connected
// rising edge that used to re-flush — and asserts NOT ONE `history:*` frame
// reaches the wire. A re-added uplink trips over this; it cannot trip over a grep.
//
// Each case also pins the half that must NOT change: the local mutation still
// MOVES THE ROW. Retiring the report while quietly retiring the record would be
// data loss dressed up as cleanup.
//
// SPEC-REF: master-plan §4.0 A (source_text is immutable) / §4.0 C (「仅记录」 stays on the phone);
//   13 册 §10 F17 (emitted ≠ the server received it).

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// Every event the phone must never put on the wire again. Written out one by one
/// rather than matched on the `history:` prefix: a prefix test would silently
/// admit a future `history:something` while looking like it forbids it.
const List<String> _kRetiredUplink = <String>[
  FlowMicEvents.historyCreate,
  FlowMicEvents.historyUpdate,
  FlowMicEvents.historyDelete,
  FlowMicEvents.historyInject,
  FlowMicEvents.historyList,
];

/// Same shape as main.dart's `_SessionInstanceOwner`: read live, because the
/// connection changes under the store's feet.
class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

class _Rig {
  _Rig() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    store = newTestStore(owner: _SessionOwner(session));
    prefs = InMemoryLocalPrefs(sendPolicy: SendPolicy.direct);
    gate = TimelineSyncGate(transport: transport);
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: DestinationController(),
      syncGate: gate,
      localPrefs: prefs,
    );
    transport.pushStatus(SocketStatus.connected);
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final InMemoryLocalPrefs prefs;
  late final TimelineSyncGate gate;
  late final ChatController controller;

  /// Connect AND pair for real so `session.connectedInstanceId` is populated —
  /// the punctuation path reads rows through `entriesForInstance`, so an unpaired
  /// rig would exercise the empty state (same reason chat_controller_test pairs).
  Future<void> pair() async {
    transport.connectSucceeds = true;
    transport.ackQueue.add(<String, Object?>{
      'token': 'tok-c5-0000000000000000000000000',
      'pc_name': '书房电脑',
      'pc_instance_id': 'inst-study',
    });
    await session.pair(PairEntry.parse('1234'), endpoint: 'ws://192.0.2.5:41879');
    transport.pushStatus(SocketStatus.connected);
  }

  /// One committed row, wire log cleared so a test only sees what IT caused.
  ///
  /// This was `seedSynced` and it called `markSynced` — the "the server also has this row"
  /// state. There is no such state now (see timeline_store.dart's retirement
  /// block), which is why every case below is one row shape instead of two.
  TimelineEntry seedRow(
    String text, {
    Delivery delivery = Delivery.inject,
    String clientId = 'u1-000001',
  }) {
    final TimelineEntry row = store.buildFromUtterance(
      clientId: clientId,
      mode: FlowMode.realtime,
      delivery: delivery,
      text: text,
    );
    transport.emitted.clear();
    return store.findById(row.id)!;
  }

  List<Map<String, Object?>> framesOf(String event) => transport
      .emittedWhere(event)
      .map((EventEnvelope e) => Map<String, Object?>.from(e.data! as Map))
      .toList();

  /// The assertion this whole file exists for.
  void expectNoUplink({String? because}) {
    for (final String event in _kRetiredUplink) {
      expect(transport.emittedNames, isNot(contains(event)),
          reason: because ?? 'no history:* frame may leave this device');
    }
  }

  Future<void> dispose() async {
    await controller.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  test('a hand edit moves the row and puts NOTHING on the wire', () async {
    final _Rig rig = _Rig();
    final TimelineEntry row = rig.seedRow('原来的样子');

    rig.controller.editEntry(row, '改过之后');
    await pumpEventQueue();

    // The record moved — retiring the report must not retire the record.
    expect(rig.store.findById(row.id)!.outputText, '改过之后');
    expect(rig.store.findById(row.id)!.edited, isTrue);
    // Red line §4.0 A: the original stays untouchable.
    expect(rig.store.findById(row.id)!.sourceText, '原来的样子');
    rig.expectNoUplink();
    await rig.dispose();
  });

  test('a SECOND edit behaves exactly like the first — the C5 bug was a row that '
      'silently stopped going up, and now nothing goes up at all', () async {
    final _Rig rig = _Rig();
    final TimelineEntry row = rig.seedRow('第一版');

    rig.controller.editEntry(row, '第二版');
    await pumpEventQueue();
    rig.controller.editEntry(rig.store.findById(row.id)!, '第三版');
    await pumpEventQueue();

    expect(rig.store.findById(row.id)!.outputText, '第三版');
    rig.expectNoUplink();
    await rig.dispose();
  });

  test('a delete removes the row locally and sends no tombstone', () async {
    final _Rig rig = _Rig();
    final TimelineEntry row = rig.seedRow('删掉我');

    rig.controller.deleteEntry(row);
    await pumpEventQueue();

    expect(rig.store.findById(row.id), isNull);
    rig.expectNoUplink();
    await rig.dispose();
  });

  test('🔴 a control key travels on control:key ONLY — no uplink, and (since '
      'T-1) no local row edit either', () async {
    // 🔴 THIS CASE WAS INVERTED BY T-1 (2026-08-13). Its old title was 「a
    // punctuation key still appends to the phone's copy — and only to it」, and
    // the 「appends」 half is gone: owner Q2㋐ deleted the punctuation group and
    // with it `_appendPunctuation`.
    //
    // The half worth keeping is the one this FILE is about — 「and only to it」:
    // a control key never travels on a `history:*` event. That guarantee is
    // untouched, so the case keeps its rig and its `expectNoUplink()`; only the
    // subject of the local assertion flipped.
    final _Rig rig = _Rig();
    await rig.pair();
    final TimelineEntry row = rig.seedRow('好的');

    final bool sent = rig.controller.sendControlKey(ControlKeyKind.punctPeriod);

    // The keystroke still reaches the PC's focused window: that is what the key
    // IS, and it never travelled on a history:* event.
    expect(sent, isTrue);
    expect(rig.framesOf(FlowMicEvents.controlKey), hasLength(1));
    // 🔴 The local row is untouched now.
    expect(
      rig.store.findById(row.id)!.outputText,
      '好的',
      reason: 'a control key mutated the local row ⇒ `_appendPunctuation` was not fully deleted',
    );
    // The C5 ② uplink that used to follow is gone, and the fork it was added to
    // prevent (phone 「好的。」 vs server 「好的」) cannot happen any more — now for
    // two independent reasons: there is no server copy to fork from, AND the
    // phone no longer edits its own copy on a keypress.
    rig.expectNoUplink();
    await rig.dispose();
  });

  test('the connected rising edge no longer re-flushes anything', () async {
    final _Rig rig = _Rig();
    // Two rows built while nobody was listening — exactly what `pendingSync` used
    // to hand `reflushPending` on the next edge.
    rig.seedRow('离线的第一句', clientId: 'u1-000001');
    rig.seedRow('离线的第二句', clientId: 'u2-000002');
    rig.transport.pushStatus(SocketStatus.disconnected);
    rig.transport.emitted.clear();

    rig.transport.pushStatus(SocketStatus.connected);
    await pumpEventQueue();

    // Both rows are still here, unchanged: the queue was abolished, not drained,
    // and nothing about the user's records was "flushed away".
    expect(rig.store.entries, hasLength(2));
    rig.expectNoUplink(
        because: 'the replay queue was abolished, not left retrying forever');
    await rig.dispose();
  });

  test('deferred catch-up of a never-uploaded row asks the retired table for nothing', () async {
    final _Rig rig = _Rig();
    await rig.pair();
    final TimelineEntry row = rig.seedRow('补投这一条');

    rig.controller.reInject(row);
    await pumpEventQueue();

    // It delivered, carrying its own words (the frame shape is asserted in
    // inject_result_watchdog_test); here the point is what did NOT go out.
    expect(rig.framesOf(FlowMicEvents.injectRequest), hasLength(1));
    expect(rig.framesOf(FlowMicEvents.injectRequest).single['text'], '补投这一条');
    rig.expectNoUplink();
    await rig.dispose();
  });

  test('a 「仅记录」 row stays on the phone — the withholding is structural, '
      'there is no toggle left that could turn it off', () async {
    // §4.0 C used to be enforced by a gate that read a device-local toggle
    // (`LocalPrefs.isNotedSyncEnabled`), and criterion 5 of the old suite asserted
    // both directions of it. Card A1 retired the gate, and card A1c (this
    // window) deleted the toggle itself — there is no longer a setting to flip
    // either way. The red line holds because there is no uplink for ANY row,
    // in any shape, regardless of any stored preference value.
    final _Rig rig = _Rig();
    final TimelineEntry row = rig.seedRow('留在手机', delivery: Delivery.none);
    rig.controller.editEntry(row, '留在手机，改过');
    await pumpEventQueue();

    expect(rig.store.findById(row.id)!.outputText, '留在手机，改过');
    rig.expectNoUplink();
    await rig.dispose();
  });
}
