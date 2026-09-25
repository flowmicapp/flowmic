// card HANGUP-3 — the phone declares `stt.segment_not_transcribed` on its
// admission frames, and ONLY because it has its own sentence for the code.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (c′)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d (HANGUP-3 block)
//
// THE JOIN THIS FILE HOLDS. The server sends STT_SEGMENT_NOT_TRANSCRIBED only to
// a client that declared the capability, because a phone without the sentence
// renders 「Speech engine reported an error (STT_SEGMENT_NOT_TRANSCRIBED)」
// (measured on 0.3.94 code). So the declaration must never outlive the sentence.
// It is DERIVED from the banner selector (lib/src/settings/
// declared_client_capabilities.dart), and the rows below pin both halves: the
// declaration is there while the sentence is, and it is carried on the real
// pair and reconnect frames.
//
// REVERSE CONTROL (run, SAW RED 〔2026-09-23, lane-c, card HANGUP-3〕): the arm
// `if (code == 'STT_SEGMENT_NOT_TRANSCRIBED') return sttStallSegmentNotTranscribed;`
// deleted from recording_strings.dart ⇒ +3 -3: the declaration row, the pair-frame row
// and the reconnect-frame row red (the code then falls to the registry fallback,
// which speaks en / zh-CN only, so at least one locale no longer answers with the
// phone's own sentence). Restored from a byte backup (cmp identical); same
// command green again.

import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/declared_client_capabilities.dart';
import 'package:flowmic/src/signaling/mobile_reconnect_flow.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const String _cap = 'stt.segment_not_transcribed';
const String _code = 'STT_SEGMENT_NOT_TRANSCRIBED';

void main() {
  group('the declaration is derived from the sentence', () {
    String own(AppStrings s) => s.sttStallSegmentNotTranscribed;

    test('this build declares the capability, because every locale answers the code with its own sentence', () {
      expect(phoneSaysCodeInEveryLocale(_code, own), isTrue);
      expect(declaredClientCapabilities(), <String>[_cap]);
    });

    test('NEGATIVE CONTROLS: a code the selector does not route to that sentence is not "said"', () {
      // Unknown everywhere ⇒ the raw-identifier fallback.
      expect(phoneSaysCodeInEveryLocale('NOT_A_REGISTERED_CODE_X', own), isFalse);
      // A registered code that routes to a DIFFERENT sentence.
      expect(phoneSaysCodeInEveryLocale('STT_NETWORK_DROP', own), isFalse);
    });

    test('the names mirror packages/protocol (the phone cannot import TS)', () {
      final String schemas = File('../../packages/protocol/src/protocol-schemas-auth.ts').readAsStringSync();
      expect(schemas, contains("CLIENT_CAPABILITY_STT_SEGMENT_NOT_TRANSCRIBED = '$_cap'"));
      final String codes = File('../../packages/protocol/src/error-codes.ts').readAsStringSync();
      expect(codes, contains('  $_code: {'));
      expect(kDeclarableCapabilities.keys, <String>[_cap]);
      expect(kDeclarableCapabilities[_cap]!.$1, _code);
    });
  });

  group('the declaration rides both admission frames', () {
    test('payload shape: carried when non-empty, omitted when empty', () {
      expect(const MobileReconnectPayload('t', clientCaps: <String>[_cap]).toJson()['client_caps'], <String>[_cap]);
      expect(const MobileReconnectPayload('t').toJson().containsKey('client_caps'), isFalse);
      expect(const MobilePairPayload.shortCode('4242').toJson(clientCaps: <String>[_cap])['client_caps'], <String>[_cap]);
      expect(const MobilePairPayload.qrPayload('flowmic://pair?x').toJson().containsKey('client_caps'), isFalse);
    });

    test('the real pair leg puts it on the mobile:pair frame', () async {
      final FakeSocketTransport transport = FakeSocketTransport()..connectSucceeds = true;
      final PttSession session = newTestSession(transport: transport, audio: AudioCapture(recorder: FakeAudioRecorder()));
      transport.defaultAck = <String, Object?>{'token': 'tok-h3-0123456789abcdefghijklmnop', 'pairing_id': 'pair-h3'};
      final PairResult r = await session.pair(PairEntry.parse('4242'), endpoint: 'ws://127.0.0.1:41880');
      expect(r.ok, isTrue, reason: '${r.error}');
      final Map<String, Object?> frame = transport.emittedWhere('mobile:pair').single.data! as Map<String, Object?>;
      expect(frame['short_code'], '4242'); // positive control: this is the real frame
      expect(frame['client_caps'], <String>[_cap]);
      await session.dispose();
    });

    test('the real reconnect leg puts it on the mobile:reconnect frame', () async {
      final FakeSocketTransport transport = FakeSocketTransport()..connectSucceeds = true;
      transport.defaultAck = <String, Object?>{'pc_name': 'H3 PC'};
      final bool ok = await runMobileReconnect(
        transport: transport,
        tokenStorage: InMemoryTokenStorage(),
        token: 'tok-h3-0123456789abcdefghijklmnop',
        timeout: const Duration(seconds: 1),
        surfaceTransientFailure: false,
        suspectedReplicaLag: () => false,
        onAccepted: (dynamic _) {},
        onRejected: (bool _, bool _, String? _, int? _) {},
      );
      expect(ok, isTrue);
      final Map<String, Object?> frame = transport.emittedWhere('mobile:reconnect').single.data! as Map<String, Object?>;
      expect(frame['token'], 'tok-h3-0123456789abcdefghijklmnop'); // positive control
      expect(frame['client_caps'], <String>[_cap]);
    });
  });
}
