// PTT session chain test (WP-R3-1): pair → PTT down (audio:start+chunks) → PTT
// up (residual + audio:stop) → stt:final, plus delivery-none, swipe-up cancel,
// and an inbound auth:expired drain — all in-process with fakes (no socket).
//
// SPEC-REF: docs/rebuild/08-MOBILE-SPEC.md §2-4;
//           docs/strategy/2026-07-23-relaunch-master-plan.md §4.0 A/B.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/mic_permission_fakes.dart';

void main() {
  late FakeSocketTransport t;
  late FakeAudioRecorder rec;
  late PttSession session;

  setUp(() {
    t = FakeSocketTransport()..connectSucceeds = true;
    rec = FakeAudioRecorder();
    session = PttSession(
      transport: t,
      audio: AudioCapture(recorder: rec),
      stateMachine: FlowmicStateMachine(),
      tokenStorage: InMemoryTokenStorage(),
      // Card U2: pttDown now gates on the mic permission first. The production
      // default is the REAL platform flow, which has no binding here — this
      // fixture's subject is the PTT wire chain, so it names a granted mic.
      micPermission: newTestMicPermission(),
    );
    // RV-89: pair()/resumePairing() fire a real `/api/health` probe at the
    // fixture's `ws://127.0.0.1:41879`. That used to be inert (the ws scheme
    // made HttpClient throw before a byte moved); now it reaches whatever is
    // listening on that port, which on a developer machine running FlowMic is a
    // live server. Nothing in this file is about the channel label, so it says
    // so rather than letting the box answer for it.
    session.healthReader =
        (Uri url, Duration timeout) async => HealthReading.offline;
  });

  tearDown(() => session.dispose());

  Future<void> pair() async {
    t.defaultAck = <String, Object?>{
      'token': 'tok-abcdefghijklmnopqrstuvwxyz012345',
      'pairing_id': 'pair-1',
      'pc_name': 'Studio PC',
    };
    final PairResult r = await session.pair(
      PairEntry.parse('1234'),
      endpoint: 'ws://127.0.0.1:41879',
    );
    expect(r.ok, isTrue);
  }

  test('pair persists the token and marks paired', () async {
    final DateTime before = DateTime.now().toUtc();
    await pair();
    expect(session.paired.value, isTrue);
    expect(session.connectedDeviceName.value, 'Studio PC');
    expect(await session.tokenStorage.readToken(), startsWith('tok-'));
    final MobileSession stored = (await session.tokenStorage.readSession())!;
    expect(stored.lastConnectedAt, isNotNull);
    expect(stored.lastConnectedAt!.isBefore(before), isFalse);
    expect(session.fsm.connection, ConnectionState.connected);
    expect(session.fsm.session, SessionState.idle);
  });

  group('last_connected_at is accepted-ack truth', () {
    test('legacy JSON has no guessed timestamp; a valid value round-trips as UTC', () {
      final MobileSession legacy = MobileSession.fromJson(<String, Object?>{
        'token': 'tok-legacy',
        'endpoint': 'http://192.168.1.8:41879',
      })!;
      expect(legacy.lastConnectedAt, isNull);
      expect(legacy.toJson().containsKey('last_connected_at'), isFalse);

      final DateTime stamp = DateTime.parse('2026-07-28T01:02:03+08:00');
      final MobileSession current = legacy.copyWith(lastConnectedAt: stamp);
      final MobileSession decoded = MobileSession.fromJson(current.toJson())!;
      expect(decoded.lastConnectedAt, DateTime.utc(2026, 7, 27, 17, 2, 3));
    });

    test('successful mobile:reconnect ack advances the persisted timestamp', () async {
      final DateTime old = DateTime.utc(2025, 1, 2, 3, 4);
      final MobileSession remembered = MobileSession(
        token: 'tok-reconnect-abcdefghijklmnopqrstuvwxyz',
        endpoint: 'ws://127.0.0.1:41879',
        pcName: 'Old name',
        lastConnectedAt: old,
      );
      await session.tokenStorage.addOrUpdatePairing(remembered);
      t.defaultAck = <String, Object?>{'pc_name': 'Current name'};
      final DateTime beforeAck = DateTime.now().toUtc();

      expect(await session.resumePairing(remembered), isTrue);

      final MobileSession stored = (await session.tokenStorage.readSession())!;
      expect(stored.pcName, 'Current name'); // enrichByToken ran on this ack.
      expect(stored.lastConnectedAt, isNotNull);
      expect(stored.lastConnectedAt!.isBefore(beforeAck), isFalse);
    });

    test('a rejected reconnect preserves the old timestamp', () async {
      final DateTime old = DateTime.utc(2025, 1, 2, 3, 4);
      final MobileSession remembered = MobileSession(
        token: 'tok-rejected-abcdefghijklmnopqrstuvwxyz',
        endpoint: 'ws://127.0.0.1:41879',
        lastConnectedAt: old,
      );
      await session.tokenStorage.addOrUpdatePairing(remembered);
      // A transient rejection keeps the pairing, making a false pre-ack stamp
      // directly observable (AUTH_TOKEN_INVALID correctly purges the whole row).
      t.defaultAck = <String, Object?>{'error': 'PC_BUSY'};

      expect(await session.resumePairing(remembered), isFalse);

      final MobileSession stored = (await session.tokenStorage.readSession())!;
      expect(stored.lastConnectedAt, old);
    });
  });

  test('full PTT chain: audio:start(delivery) → chunks → residual → audio:stop → stt:final', () async {
    await pair();

    final bool down = await session.pttDown(delivery: Delivery.inject);
    expect(down, isTrue);
    expect(session.fsm.session, SessionState.recording);

    // audio:start carries the fixed delivery intent (§4.0 B).
    final start = t.emittedWhere('audio:start').single;
    expect((start.data! as Map)['delivery'], 'inject');

    rec.feed(makePcm(6400)); // one live chunk
    await pumpEventQueue();
    rec.feed(makePcm(3200)); // sub-chunk tail, no live chunk
    await pumpEventQueue();

    await session.pttUp();
    expect(session.fsm.session, SessionState.processing);

    // Two audio:chunk (one live + one residual), and audio:stop is LAST.
    expect(t.emittedWhere('audio:chunk').length, 2);
    expect(t.emittedNames.last, 'audio:stop');
    // Residual chunk was emitted AHEAD of audio:stop (F-2223 ordering).
    final names = t.emittedNames;
    expect(names.lastIndexOf('audio:chunk'), lessThan(names.indexOf('audio:stop')));

    // Terminal stt:final drives PROCESSING → JUST_DONE.
    t.pushIncoming('stt:final', <String, Object?>{
      'text': '你好世界',
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 1200,
    });
    expect(session.fsm.session, SessionState.justDone);
    expect(session.segments.joined, '你好世界');
  });

  test('a soft-segment stt:final keeps recording (only the terminal closes)', () async {
    await pair();
    await session.pttDown();
    t.pushIncoming('stt:final', <String, Object?>{
      'text': '第一段',
      'confidence': 0.9,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': true, // soft-segment boundary, NOT terminal
      'duration_ms': 800,
    });
    // FSM stays RECORDING because we have not yet PTT-up'd / hit the terminal.
    expect(session.fsm.session, SessionState.recording);
  });

  test('delivery=none emits audio:start with record-only intent', () async {
    await pair();
    await session.pttDown(delivery: Delivery.none);
    final start = t.emittedWhere('audio:start').single;
    expect((start.data! as Map)['delivery'], 'none');
  });

  test('swipe-up cancel: no PROCESSING, audio:stop sent, no entry built', () async {
    await pair();
    await session.pttDown();
    expect(session.fsm.session, SessionState.recording);
    await session.pttCancel();
    expect(session.fsm.session, SessionState.idle); // straight back, no PROCESSING
    expect(t.emittedNames, contains('audio:stop'));
    // No stt:final was awaited → the utterance never became a timeline entry.
    expect(session.segments.isEmpty, isTrue);
  });

  test('inbound auth:expired drains the session (paired → false)', () async {
    await pair();
    await session.pttDown();
    t.pushIncoming('auth:expired', const <String, Object?>{});
    await pumpEventQueue();
    expect(session.paired.value, isFalse);
    expect(session.fsm.session, SessionState.disconnected);
    expect(await session.tokenStorage.readToken(), isNull);
  });

  test('background pause / resume emit audio:pause{reason} and audio:resume', () async {
    await pair();
    await session.pttDown();
    expect(session.fsm.session, SessionState.recording);
    await session.pauseCapture(reason: 'background');
    final pause = t.emittedWhere('audio:pause').single;
    expect((pause.data! as Map)['reason'], 'background');
    await session.resumeCapture();
    expect(t.emittedWhere('audio:resume').length, 1);
  });

  // ── GA-03 ②: stt:error as a terminal FSM edge ────────────────────────────
  test('stt:error{retryable:false} while PROCESSING closes it immediately', () async {
    await pair();
    final stalls = <SttStall>[];
    session.sttStalled.listen(stalls.add);
    await session.pttDown();
    await session.pttUp();
    expect(session.fsm.session, SessionState.processing);
    t.pushIncoming('stt:error', <String, Object?>{
      'code': 'ENGINE_DEAD',
      'message': 'provider closed the stream',
      'retryable': false,
    });
    await pumpEventQueue();
    // Back to IDLE without waiting out the 15 s net → PTT is usable again.
    expect(session.fsm.session, SessionState.idle);
    expect(stalls, hasLength(1));
    expect(stalls.single.reason, SttStallReason.engineError);
    // ENG-3: the wire code+message survive onto the stall event — this arm
    // used to keep only `retryable` and drop both.
    expect(stalls.single.code, 'ENGINE_DEAD');
    expect(stalls.single.message, 'provider closed the stream');
  });

  test('stt:error{retryable:true} while RECORDING does not touch the FSM', () async {
    await pair();
    final stalls = <SttStall>[];
    session.sttStalled.listen(stalls.add);
    await session.pttDown();
    t.pushIncoming('stt:error', <String, Object?>{
      'code': 'ENGINE_RECONNECTING',
      'message': 'reconnecting to provider',
      'retryable': true,
    });
    await pumpEventQueue();
    expect(session.fsm.session, SessionState.recording);
    expect(stalls, isEmpty);
  });

  // ── ENG-3 (fix-030): the P0 shape, driven through the REAL inbound arm ─────
  // The test that stood here asserted 「a terminal stt:error while RECORDING is
  // also ignored」— which is the measured defect written down as spec: the
  // stock-install cold-open failure (`STT_CONFIG_MISSING` on `audio:start`)
  // arrives moments into the press, while the FSM is RECORDING, and the old
  // `fsm.session == processing` clause in ptt_inbound swallowed it. The owner
  // then read 「没有听到语音」/「未收到转写结果」 and never 「转写引擎报错」.
  test('ENG-3: a terminal stt:error while RECORDING is latched — capture '
      'continues through the press, and PTT-up surfaces the NAMED refusal '
      'immediately', () async {
    await pair();
    final stalls = <SttStall>[];
    session.sttStalled.listen(stalls.add);
    await session.pttDown();
    t.pushIncoming('stt:error', <String, Object?>{
      'code': 'STT_CONFIG_MISSING',
      'message': "sherpa-local open failed: Cannot find module 'sherpa-onnx-node'",
      'retryable': false,
    });
    await pumpEventQueue();
    // Mid-press: the recording is not torn down (unchanged behaviour).
    expect(session.fsm.session, SessionState.recording);
    expect(stalls, isEmpty);
    await session.pttUp();
    // The press ended → the latched terminal error closes PROCESSING at once,
    // named. No 15 s of silence, no timeout banner blaming the link.
    expect(session.fsm.session, SessionState.idle);
    expect(stalls, hasLength(1));
    expect(stalls.single.reason, SttStallReason.engineError);
    expect(stalls.single.code, 'STT_CONFIG_MISSING');
  });

  test('sys:ping is answered with sys:pong', () async {
    await pair();
    t.pushIncoming('sys:ping', <String, Object?>{'nonce': 'n-123'});
    final pong = t.emittedWhere('sys:pong').single;
    expect((pong.data! as Map)['nonce'], 'n-123');
    expect((pong.data! as Map)['ok'], true);
  });

  // ── owner 2026-07-27: the PC's name must survive in STORAGE, not just in the
  // header. The connections list renders from the persisted MobileSession, so a
  // rename the phone only ever saw at runtime left the list showing the name
  // captured when the pairing was made — the owner's tablet still said
  // 「FlowMic PC」 (an ancient default) while the PC was 「office-pc-windows」.
  group('PC rename reaches the persisted pairing (connections-list truth)', () {
    test('pc:mobile-joined persists the name, not just the header', () async {
      await pair();
      expect(session.connectedDeviceName.value, 'Studio PC');

      t.pushIncoming('pc:mobile-joined', const <String, Object?>{
        'pc_name': 'office-pc-windows',
      });
      await pumpEventQueue();

      expect(session.connectedDeviceName.value, 'office-pc-windows');
      final MobileSession? stored = await session.tokenStorage.readSession();
      expect(stored, isNotNull);
      // THE assertion: the list reads this field, so it must have moved too.
      expect(stored!.pcName, 'office-pc-windows');
      expect(pairingDisplayName(stored), 'office-pc-windows');
    });

    test('settings:updated{device.pc_name} persists the rename', () async {
      await pair();
      t.pushIncoming('settings:updated', const <String, Object?>{
        'key': 'device.pc_name',
        'value': <String, Object?>{'pc_name': 'renamed-by-pc'},
      });
      await pumpEventQueue();
      final MobileSession? stored = await session.tokenStorage.readSession();
      expect(stored!.pcName, 'renamed-by-pc');
    });

    test('a local alias still wins over a freshly-learned PC name', () async {
      await pair();
      final MobileSession before = (await session.tokenStorage.readSession())!;
      await session.tokenStorage.setPairingAlias(before, '家里那台');

      t.pushIncoming('pc:mobile-joined', const <String, Object?>{
        'pc_name': 'office-pc-windows',
      });
      await pumpEventQueue();

      final MobileSession after = (await session.tokenStorage.readSession())!;
      // Big label = the alias the user chose…
      expect(pairingDisplayName(after), '家里那台');
      // …and the small line shows the PC's own (now current) name beneath it.
      expect(pairingOriginalName(after), 'office-pc-windows');
    });
  });

}
