// P-8 —— [LocalEngineStatusStore]'s vocabulary and identity triple.
//
// This file covers only the **store-and-read** layer. Rendering is in
// `diagnostics_engine_section_test.dart`, 「did the production path actually
// hang it up」 is in `p8_engine_status_wire_test.dart` — three things, three
// files, because the 0.2.51 lesson is: if you only test the tracker, deleting
// the wiring line still leaves every test green.
//
// 🔴 What must be bitten here is not 「it remembers」, it is **「remembered
// still must not be used wrongly」**: an observation belongs to the
// (channel, endpoint, PC) triple; crossing it is the 「never mix IDs」 variant
// on the status-display face. So every happy path below is paired with a
// 「swap one member of the triple ⇒ cannot be read back」.

import 'package:flowmic/src/session/local_engine_status.dart';
import 'package:flutter_test/flutter_test.dart';

const String kEndpoint = 'ws://192.168.1.5:41879';
const String kPcId = 'pc_abc';
final DateTime kAt = DateTime.utc(2026, 8, 7, 6, 32);

LocalEngineStatusStore _stored({
  String provider = 'funasr-ws',
  String status = 'ready',
  bool channelIsLan = true,
  String endpoint = kEndpoint,
  String? pcId = kPcId,
}) {
  final LocalEngineStatusStore s = LocalEngineStatusStore();
  s.observeFrame(
    <String, Object?>{'provider': provider, 'status': status},
    channelIsLan: channelIsLan,
    endpoint: endpoint,
    pcId: pcId,
    nowUtc: kAt,
  );
  return s;
}

LocalEngineObservation? _readBack(
  LocalEngineStatusStore s, {
  bool channelIsLan = true,
  String endpoint = kEndpoint,
  String? pcId = kPcId,
}) => s.readFor(channelIsLan: channelIsLan, endpoint: endpoint, pcId: pcId);

void main() {
  group('① a real stt:engine-status frame is recorded, one of each of the three states', () {
    test('ready / reconnecting / failed each map, and the instant is the moment the frame was received', () {
      const Map<String, LocalEngineOutcome> table = <String, LocalEngineOutcome>{
        'ready': LocalEngineOutcome.ready,
        'reconnecting': LocalEngineOutcome.reconnecting,
        'failed': LocalEngineOutcome.failed,
      };
      for (final MapEntry<String, LocalEngineOutcome> e in table.entries) {
        final LocalEngineObservation? o = _readBack(_stored(status: e.key));
        expect(o, isNotNull, reason: 'status=${e.key} should have been accepted');
        expect(o!.outcome, e.value);
        expect(o.provider, 'funasr-ws');
        // The instant used is **when we received it**, not some field on the
        // frame — the frame has no instant at all.
        expect(o.atUtc, kAt);
      }
    });

    test('a later frame overwrites an earlier one: what is asked is 「the most recent」', () {
      final LocalEngineStatusStore s = _stored(status: 'ready');
      s.observeFrame(
        <String, Object?>{'provider': 'sensevoice', 'status': 'failed'},
        channelIsLan: true,
        endpoint: kEndpoint,
        pcId: kPcId,
        nowUtc: kAt.add(const Duration(minutes: 3)),
      );
      final LocalEngineObservation? o = _readBack(s);
      expect(o!.outcome, LocalEngineOutcome.failed);
      expect(o.provider, 'sensevoice');
      expect(o.atUtc, kAt.add(const Duration(minutes: 3)));
    });
  });

  group('② off-contract frames are dropped whole, never half-accepted', () {
    // 🔴 The defect is the opposite of this group: accepting the provider and
    // dropping an unreadable status would mint an observation that has 「a
    // name, no conclusion」, and it is type-identical to a real observation.
    test('status not in the three states ⇒ nothing is recorded', () {
      for (final Object? bad in <Object?>['ok', 'READY', '', null, 1, true]) {
        final LocalEngineStatusStore s = LocalEngineStatusStore();
        s.observeFrame(
          <String, Object?>{'provider': 'funasr-ws', 'status': bad},
          channelIsLan: true,
          endpoint: kEndpoint,
          pcId: kPcId,
          nowUtc: kAt,
        );
        expect(_readBack(s), isNull, reason: 'status=$bad must not be accepted');
      }
    });

    test('provider missing/empty/wrong type ⇒ nothing is recorded', () {
      for (final Object? bad in <Object?>[null, '', 42, <String>['a']]) {
        final LocalEngineStatusStore s = LocalEngineStatusStore();
        s.observeFrame(
          <String, Object?>{'provider': bad, 'status': 'ready'},
          channelIsLan: true,
          endpoint: kEndpoint,
          pcId: kPcId,
          nowUtc: kAt,
        );
        expect(_readBack(s), isNull, reason: 'provider=$bad must not be accepted');
      }
    });

    test('a bad frame must not wipe a previous good one', () {
      final LocalEngineStatusStore s = _stored(status: 'ready');
      s.observeFrame(
        <String, Object?>{'provider': 'x', 'status': 'nonsense'},
        channelIsLan: true,
        endpoint: kEndpoint,
        pcId: kPcId,
        nowUtc: kAt.add(const Duration(minutes: 1)),
      );
      expect(_readBack(s)!.provider, 'funasr-ws');
    });
  });

  group('③ identity triple: the shape of mixed IDs on the status-display face', () {
    test('all three match ⇒ readable (positive control; without it the four below could be permanently null)', () {
      expect(_readBack(_stored()), isNotNull);
    });

    test('the observation happened on the cloud leg ⇒ the local channel cannot read it back', () {
      expect(_readBack(_stored(channelIsLan: false)), isNull);
    });

    test('now on the cloud leg (or channel unknown) ⇒ cannot be read back, even if the observation was local', () {
      expect(_readBack(_stored(), channelIsLan: false), isNull);
    });

    test('endpoint changed ⇒ cannot be read back', () {
      expect(_readBack(_stored(), endpoint: 'ws://192.168.1.9:41879'), isNull);
    });

    test('endpoint empty ⇒ cannot be read back (two empty strings must not 「equal」 and pass)', () {
      expect(_readBack(_stored(endpoint: ''), endpoint: ''), isNull);
    });

    test('PC changed ⇒ cannot be read back', () {
      expect(_readBack(_stored(), pcId: 'pc_other'), isNull);
    });

    test('pcId null on both sides is the same machine (a QR pairing may have no pcId)', () {
      expect(_readBack(_stored(pcId: null), pcId: null), isNotNull);
    });

    test('one side has a pcId and the other does not ⇒ not the same machine', () {
      expect(_readBack(_stored(pcId: null)), isNull);
      expect(_readBack(_stored(), pcId: null), isNull);
    });
  });

  test('④ no observation at all ⇒ null (not a 「looks reasonable」 default)', () {
    expect(_readBack(LocalEngineStatusStore()), isNull);
  });
}
