// Y1 — RV-28 keyed claims (regression) + F3 latency counters + RV-30 late ✓.
//
// RV-28's original "single-slot claim" premise was already fixed by RV-02
// (ManualDelivery keeps one _InFlightSend per delivery, keyed by request_id /
// covered entry ids). These cases pin that two image-shaped arms settle
// independently under out-of-order verdicts — the failure mode the card named.
//
// F3: the two event names must appear on the existing DiagLog trail with a
// measurable ms field (sourced here from a synthetic inject settle).

import 'dart:typed_data';

import 'package:flowmic/src/session/image_payload.dart' show ImagePickSpec;
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/session/image_send_controller.dart';
import 'package:flowmic/src/session/manual_delivery.dart';
import 'package:flowmic/src/signaling/inbound_payloads.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'package:flowmic/src/session/delivery_outbox.dart';
import 'support/di.dart';

const String _kInst = 'standalone|instance:y1';

class _Owner implements InstanceOwnerProbe {
  @override
  String? get instanceId => _kInst;
  @override
  String? get instanceName => 'y1-pc';
}

class _Host implements ManualDeliveryHost {
  @override
  late final DeliveryOutbox outbox = newTestOutbox();

  _Host(this.store, this.syncGate);
  @override
  final TimelineStore store;
  @override
  final TimelineSyncGate syncGate;
  @override
  bool get canCompose => true;
  @override
  bool get noPcTarget => false;
  @override
  FlowMode get mode => FlowMode.realtime;
  @override
  String? get pcDisplayName => 'Y1 PC';
  @override
  String? get targetPcId => 'pc-y1-test';
  @override
  String? get deliveryInstanceId => 'inst-y1';

  @override
  void deliveryNotify() {}
  @override
  Future<void> kickLink() async {}
  @override
  Future<bool> awaitLinkUp(Duration timeout) async => true;
  @override
  LanImageIngress? get lanImageIngress => null;
}

class _NoPicker implements ImagePickerPort {
  @override
  Future<Uint8List?> pickImage(ImagePickSpec spec) async => null;
}

class _Rig {
  _Rig({Duration timeout = const Duration(milliseconds: 80)}) {
    transport = FakeSocketTransport();
    store = TimelineStore(
      persistence: InMemoryTimelinePersistence(),
      reaper: newTestReaper(),
      owner: _Owner(),
    );
    gate = TimelineSyncGate(transport: transport);
    host = _Host(store, gate);
    delivery = ManualDelivery(
      host: host,
      gate: ComposeGate(transport: transport),
      resultTimeout: timeout,
    );
    imageSend = ImageSendController(
      host: host,
      gate: ComposeGate(transport: transport),
      delivery: delivery,
      picker: _NoPicker(),
      rowImages: newTestOutboxBlobs(),
    );
  }

  late final FakeSocketTransport transport;
  late final TimelineStore store;
  late final TimelineSyncGate gate;
  late final _Host host;
  late final ManualDelivery delivery;
  late final ImageSendController imageSend;

  /// Image-shaped arm: request_id + one covered entry_id (what pickAndSend does).
  ({String requestId, String entryId}) armImage(String label) {
    final String requestId = delivery.mintRequestId('i');
    final TimelineEntry e = delivery.buildDeliveryRow(
      clientId: requestId,
      text: label,
      entryType: TimelineEntry.kImage,
    );
    delivery.armInFlight(requestId, <String>[e.id]);
    return (requestId: requestId, entryId: e.id);
  }

  EntryStatus statusOf(String id) => store.findById(id)!.status;

  void dispose() {
    delivery.dispose();
    imageSend.dispose();
    store.dispose();
  }
}

void main() {
  setUp(() {
    DiagLog.instance.clear();
    DiagLog.instance.clock = () => DateTime.utc(2026, 7, 30, 13);
  });

  group('RV-28: keyed claims (regression — already List<_InFlightSend> since RV-02)', () {
    test('two in-flight image arms settle each row; out-of-order is fine', () {
      final _Rig r = _Rig();
      final a = r.armImage('图甲');
      final b = r.armImage('图乙');

      // Second claim must NOT retire the first — that was the single-slot bug.
      expect(r.statusOf(a.entryId), EntryStatus.cached);
      expect(r.statusOf(b.entryId), EntryStatus.cached);

      // Out of order: B first, then A.
      r.delivery.applyInjectResult(
        InjectResult(ok: true, mode: 'clipboard', entryId: b.entryId),
        r.store,
      );
      r.delivery.applyInjectResult(
        InjectResult(ok: true, mode: 'clipboard', requestId: a.requestId),
        r.store,
      );
      expect(r.statusOf(a.entryId), EntryStatus.injected);
      expect(r.statusOf(b.entryId), EntryStatus.injected);
      r.dispose();
    });

    test('an unclaimed result still leaves a forensic line (recv.inject_result)', () {
      final _Rig r = _Rig();
      DiagLog.instance.clear();
      r.delivery.applyInjectResult(
        const InjectResult(ok: true, mode: 'clipboard', entryId: 'nobody'),
        r.store,
      );
      final String line = DiagLog.instance.snapshot().singleWhere(
        (String l) => l.contains('recv.inject_result'),
      );
      expect(line, contains('correlation=nobody'));
      r.dispose();
    });
  });

  group('RV-30: one on-screen conclusion after a late ✓', () {
    test('late ok retires the watchdog noResult banner for that delivery', () async {
      final _Rig r = _Rig();
      final a = r.armImage('迟到的图');
      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(r.delivery.failure, ComposeSendFailure.noResult);
      expect(r.statusOf(a.entryId), EntryStatus.failed);

      r.imageSend.progress.value =
          const ImageSendProgress(ImageSendStage.waitingSocketAck);

      r.imageSend.onInjectSettled(
        InjectResult(ok: true, mode: 'clipboard', entryId: a.entryId),
        r.delivery,
        3,
      );
      expect(r.delivery.failure, isNull);
      expect(r.imageSend.progress.value, isNull);
      r.dispose();
    });
  });

  group('F3: latency counters on DiagLog', () {
    test('ack_to_visible_ms is a real number on the shared trail', () {
      final _Rig r = _Rig();
      DiagLog.instance.clear();
      r.imageSend.onInjectSettled(
        const InjectResult(ok: true, mode: 'clipboard', entryId: 'x'),
        r.delivery,
        7,
      );
      final String line = DiagLog.instance.snapshot().singleWhere(
        (String l) => l.contains('latency.ack_to_visible_ms'),
      );
      expect(line, contains('ms=7'));
      // Source: synthetic settle in this unit test (not a device run).
      r.dispose();
    });
  });
}
