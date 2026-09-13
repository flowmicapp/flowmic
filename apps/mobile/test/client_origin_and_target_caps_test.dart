// card S2-01 — the phone half: it declares WHICH KIND of end it is on
// `mobile:pair`, and it reads what the TARGET can receive off the ack.
//
// SPEC-REF:
//   packages/protocol/src/protocol-schemas-auth.ts (the field declarations)
//   docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §1.1
//   docs/strategy/2026-09-06-web-client-parity-privacy-image-and-ux-addendum.md §3
//
// 🔴 THE ACK SIDE IS DELIBERATELY UNCONSUMED IN PRODUCTION. The image UI that
// asks before sending is card S3-02, so nothing reads `canSendImage` yet — which
// is exactly the situation this repo's anti-façade rule ③ warns about, and why
// these tests drive the REAL `ReconnectCoordinator` writer rather than the parser
// alone. A parser test alone would stay green if the ack legs never called it.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/portable/portable_ports.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/platform_device_info.dart';
import 'package:flowmic/src/signaling/reconnect.dart';
import 'package:flowmic/src/signaling/target_caps.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// A version port that answers, so the pairing frame has something to carry.
class _FixedVersion implements AppVersionPort {
  const _FixedVersion(this.value);
  final String? value;
  @override
  Future<String?> appVersion() async => value;
}

void main() {
  group('mobile:pair declares which kind of end this is', () {
    test('all three arms carry client and client_version', () {
      final List<MobilePairPayload> arms = <MobilePairPayload>[
        const MobilePairPayload.shortCode('4831'),
        const MobilePairPayload.qrPayload('https://flowmic.app/go/pair?code=4831&v=1'),
        const MobilePairPayload.cloudInstance(),
      ];
      for (final MobilePairPayload p in arms) {
        final Map<String, Object?> json =
            p.toJson(client: 'app', clientVersion: '0.3.78');
        expect(json['client'], 'app', reason: '$p');
        expect(json['client_version'], '0.3.78', reason: '$p');
      }
    });

    test('a frame from a build that cannot read its own version omits the key', () {
      // 🔴 OMITTED, not '' and not 'unknown'. 「we could not read our version」
      // and 「our version is the string unknown」 are different facts, and the
      // second one would land in a DB column and a device list as if it were
      // true. The absent case has to be byte-for-byte a pre-S2-01 frame.
      for (final String? v in <String?>[null, '']) {
        final Map<String, Object?> json =
            const MobilePairPayload.shortCode('4831').toJson(client: 'app', clientVersion: v);
        expect(json.containsKey('client_version'), isFalse, reason: 'version=$v');
        expect(json['client'], 'app');
      }
    });

    test('the fields that were already there are untouched', () {
      final Map<String, Object?> json = const MobilePairPayload.shortCode('4831', pcid: '930582147')
          .toJson(mobileName: 'Pixel 9-3f2a', deviceUid: 'mb-00112233445566aa', client: 'app');
      expect(json['short_code'], '4831');
      expect(json['pcid'], '930582147');
      expect(json['mobile_name'], 'Pixel 9-3f2a');
      expect(json['device_uid'], 'mb-00112233445566aa');
    });
  });

  group('target_caps — three states, read into the session', () {
    test('an ack with no key is UNDECLARED, and undeclared ALLOWS', () {
      final TargetCaps caps = parseTargetCaps(<String, Object?>{'pairing_id': 'p1'});
      expect(caps.declared, isFalse);
      expect(caps.image, isNull);
      // The rule every installed target depends on: absence must not become a
      // refusal, or image delivery stops for everyone on the day this ships.
      expect(caps.canSendImage, isTrue);
    });

    test('a declared yes and a declared no are both statements', () {
      final TargetCaps yes = parseTargetCaps(<String, Object?>{
        'target_caps': <String, Object?>{'image': true},
      });
      expect(yes.declared, isTrue);
      expect(yes.image, isTrue);
      expect(yes.canSendImage, isTrue);

      final TargetCaps no = parseTargetCaps(<String, Object?>{
        'target_caps': <String, Object?>{'image': false, 'image_note': 'text only'},
      });
      expect(no.declared, isTrue);
      expect(no.image, isFalse);
      expect(no.imageNote, 'text only');
      expect(no.canSendImage, isFalse);
    });

    test('a malformed declaration is undeclared, never a refusal', () {
      // Tolerant in ONE direction: a broken capability must not break a pairing
      // that is otherwise fine, and it must never be mistaken for a "no".
      for (final Object? raw in <Object?>[
        'yes',
        <String, Object?>{'image': 'true'},
        <String, Object?>{'image': 1},
        <String, Object?>{},
        null,
      ]) {
        final TargetCaps caps = parseTargetCaps(<String, Object?>{'target_caps': raw});
        expect(caps.declared, isFalse, reason: 'raw=$raw');
        expect(caps.canSendImage, isTrue, reason: 'raw=$raw');
      }
    });

    test('an empty note is dropped rather than shown as a blank reason', () {
      final TargetCaps caps = parseTargetCaps(<String, Object?>{
        'target_caps': <String, Object?>{'image': false, 'image_note': '   '},
      });
      expect(caps.image, isFalse);
      expect(caps.imageNote, isNull);
    });
  });

  // 🔴 THE WIRING, not the parts. Everything above this group would stay green
  // if `pair()` never passed the fields and never called `noteTargetCaps` — the
  // exact shape of anti-façade ③ (「a unit suite proves nothing about a wire」)
  // and of the article-screen defect (both ends tested, the middle untested).
  group('the real pair leg carries it out and reads it back', () {
    setUp(resetClientVersionCache);
    tearDown(resetClientVersionCache);

    Future<(FakeSocketTransport, PttSession)> pairWith(Object? ack) async {
      final FakeSocketTransport transport = FakeSocketTransport()..connectSucceeds = true;
      final PttSession session = newTestSession(
        transport: transport,
        audio: AudioCapture(recorder: FakeAudioRecorder()),
      );
      transport.defaultAck = ack;
      final PairResult r = await session.pair(
        PairEntry.parse('4242'),
        endpoint: 'ws://127.0.0.1:41880',
      );
      expect(r.ok, isTrue, reason: 'harness pair failed: ${r.error}');
      return (transport, session);
    }

    test('the frame on the wire says which kind of end this is', () async {
      await warmClientVersion(port: const _FixedVersion('0.3.78'));
      final (FakeSocketTransport t, PttSession s) = await pairWith(<String, Object?>{
        'token': 'tok-s201-0123456789abcdefghijklmn',
        'pairing_id': 'pair-s201',
        'pc_name': 'S2-01 PC',
      });
      final Object? payload = t.emittedWhere('mobile:pair').single.data;
      expect(payload, isA<Map<String, Object?>>());
      final Map<String, Object?> frame = payload! as Map<String, Object?>;
      expect(frame['client'], 'app');
      expect(frame['client_version'], '0.3.78');
      expect(frame['short_code'], '4242'); // positive control: the real frame
      await s.dispose();
    });

    test('a build that could not read its own version still pairs, with no key', () async {
      await warmClientVersion(port: const _FixedVersion(null));
      final (FakeSocketTransport t, PttSession s) = await pairWith(<String, Object?>{
        'token': 'tok-s201-0123456789abcdefghijklmn',
        'pairing_id': 'pair-s201',
      });
      final Map<String, Object?> frame =
          t.emittedWhere('mobile:pair').single.data! as Map<String, Object?>;
      expect(frame.containsKey('client_version'), isFalse);
      expect(frame['client'], 'app');
      await s.dispose();
    });

    test('the ack it gets back lands in the session', () async {
      final (FakeSocketTransport _, PttSession s) = await pairWith(<String, Object?>{
        'token': 'tok-s201-0123456789abcdefghijklmn',
        'pairing_id': 'pair-s201',
        'target_caps': <String, Object?>{'image': false, 'image_note': 'text only'},
      });
      expect(s.reconnect.targetCaps.declared, isTrue);
      expect(s.reconnect.targetCaps.canSendImage, isFalse);
      expect(s.reconnect.targetCaps.imageNote, 'text only');
      await s.dispose();
    });

    test('an ack from a target that says nothing leaves it undeclared', () async {
      final (FakeSocketTransport _, PttSession s) = await pairWith(<String, Object?>{
        'token': 'tok-s201-0123456789abcdefghijklmn',
        'pairing_id': 'pair-s201',
      });
      // Positive control: the pair itself succeeded (asserted in `pairWith`), so
      // this zero is a real answer and not a probe that never ran.
      expect(s.reconnect.targetCaps.declared, isFalse);
      expect(s.reconnect.targetCaps.canSendImage, isTrue);
      await s.dispose();
    });
  });

  group('the ladder stores what the last ack said', () {
    // The REAL coordinator, not a stand-in: `noteTargetCaps` is called from the
    // two ack legs and the field lives on this class, so a fake would test the
    // parser twice and the wiring not at all.
    ReconnectCoordinator ladder() => ReconnectCoordinator(
          transport: FakeSocketTransport(),
          bufferedChunksProvider: AudioCapture(recorder: FakeAudioRecorder()).bufferedChunkPayloads,
        );

    test('starts undeclared — nothing has answered yet', () {
      expect(ladder().targetCaps.declared, isFalse);
    });

    test('a fresh ack REPLACES, never merges', () {
      // The target may have been replaced between two acks, and a capability
      // that outlived the connection that declared it is a claim nobody present
      // has made. Same rule as serverCapabilities right beside it.
      final ReconnectCoordinator l = ladder();
      l.noteTargetCaps(<String, Object?>{'target_caps': <String, Object?>{'image': true}});
      expect(l.targetCaps.image, isTrue);
      l.noteTargetCaps(<String, Object?>{'pairing_id': 'p1'}); // an ack with nothing to say
      expect(l.targetCaps.declared, isFalse);
      expect(l.targetCaps.image, isNull);
    });

    test('it is a SEPARATE field from serverCapabilities — two questions', () {
      // Reading one off the other is the bug shape this repo names first: the
      // two even fail in opposite directions (server unknown ⇒ fail closed,
      // target unknown ⇒ fail open).
      final ReconnectCoordinator l = ladder();
      l.noteServerCapabilities(<String, Object?>{
        'capabilities': <String>['recovery.coverage_receipt'],
      });
      l.noteTargetCaps(<String, Object?>{'target_caps': <String, Object?>{'image': false}});
      expect(l.serverCapabilities.has('recovery.coverage_receipt'), isTrue);
      expect(l.targetCaps.canSendImage, isFalse);
      // …and an ack that carries only the server's array leaves the target's
      // answer untouched at "undeclared", rather than borrowing from it.
      final ReconnectCoordinator other = ladder();
      other.noteServerCapabilities(<String, Object?>{'capabilities': <String>['x']});
      other.noteTargetCaps(<String, Object?>{'capabilities': <String>['x']});
      expect(other.targetCaps.declared, isFalse);
    });
  });
}
