// IT-10 — SessionScope must die with its PttSession; late `_widen` is a NO-OP.
//
// SPEC-REF:
//   apps/mobile/lib/src/ptt/ptt_session.dart (holds `scope`)
//   apps/mobile/lib/src/session/machine_key.dart (SessionScope + `_widen`)
//
// Observable behaviour only — not "was dispose() called". A fix that kills all
// notification would look identical to a correct dispose unless the positive
// control below stays green.

import 'dart:async';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/instance_probe.dart' show HealthReading;
import 'package:flowmic/src/session/machine_key.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'f2_machine_merge_test.dart' show kLan, kRelay;
import 'support/fakes.dart';
import 'support/mic_permission_fakes.dart';

/// Holds `readPairings` open until [release] so `_widen` can be mid-flight
/// when the scope is disposed.
class _GatedPairingsStorage extends InMemoryTokenStorage {
  final Completer<void> _gate = Completer<void>();

  void release() {
    if (!_gate.isCompleted) _gate.complete();
  }

  @override
  Future<List<MobileSession>> readPairings() async {
    await _gate.future;
    return super.readPairings();
  }
}

PttSession _newSession({TokenStorage? tokenStorage}) {
  final PttSession session = PttSession(
    transport: FakeSocketTransport()..connectSucceeds = true,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    stateMachine: FlowmicStateMachine(),
    tokenStorage: tokenStorage ?? InMemoryTokenStorage(),
    micPermission: newTestMicPermission(),
  );
  session.healthReader =
      (Uri url, Duration timeout) async => HealthReading.offline;
  return session;
}

void main() {
  test('POSITIVE CONTROL: a live session scope still notifies listeners', () {
    final PttSession session = _newSession();
    addTearDown(() => session.dispose());

    int ticks = 0;
    session.scope.addListener(() => ticks++);
    session.scope.note(session: kLan, storage: session.tokenStorage);
    expect(ticks, 1,
        reason: 'a change that kills notification entirely would look like a '
            'correct dispose fix — this control must stay green');
    expect(session.scope.ownerIds, <String>{kLan.connectionIdentity});
  });

  test('session dispose disposes scope — using it afterwards throws', () async {
    final PttSession session = _newSession();
    final SessionScope scope = session.scope;

    int ticks = 0;
    scope.addListener(() => ticks++);
    scope.note(session: kLan, storage: session.tokenStorage);
    expect(ticks, 1);

    await session.dispose();

    // ChangeNotifier.addListener after dispose throws FlutterError — that is
    // the observable death of the notifier, not a spy on dispose().
    expect(
      () => scope.addListener(() {}),
      throwsA(isA<FlutterError>()),
      reason: 'scope outliving the session is the named leak IT-10 closes',
    );
    expect(ticks, 1, reason: 'no further notifications after session dispose');
  });

  test('late _widen after dispose is a NO-OP — no throw, no state write',
      () async {
    final _GatedPairingsStorage storage = _GatedPairingsStorage();
    await storage.addOrUpdatePairing(kLan);
    await storage.addOrUpdatePairing(kRelay);

    final SessionScope scope = SessionScope();
    final List<Set<String>> ownerSnapshots = <Set<String>>[];
    scope.addListener(() {
      ownerSnapshots.add(Set<String>.from(scope.ownerIds));
    });

    scope.note(session: kLan, storage: storage);
    expect(scope.ownerIds, <String>{kLan.connectionIdentity},
        reason: 'narrow set publishes synchronously before _widen awaits');
    expect(ownerSnapshots, hasLength(1));

    // Tear down while _widen is parked on readPairings.
    scope.dispose();

    storage.release();
    await pumpEventQueue();

    expect(scope.ownerIds, <String>{kLan.connectionIdentity},
        reason: 'late _widen must not widen ownerIds after dispose');
    expect(ownerSnapshots, hasLength(1),
        reason: 'late _widen must not notifyListeners after dispose');
  });

  test(
      'POSITIVE CONTROL: without dispose, gated _widen still widens and notifies',
      () async {
    final _GatedPairingsStorage storage = _GatedPairingsStorage();
    await storage.addOrUpdatePairing(kLan);
    await storage.addOrUpdatePairing(kRelay);

    final SessionScope scope = SessionScope();
    addTearDown(scope.dispose);

    int ticks = 0;
    scope.addListener(() => ticks++);
    scope.note(session: kLan, storage: storage);
    expect(ticks, 1);
    expect(scope.ownerIds, <String>{kLan.connectionIdentity});

    storage.release();
    await pumpEventQueue();

    expect(
      scope.ownerIds,
      <String>{kLan.connectionIdentity, kRelay.connectionIdentity},
      reason: 'if _widen never notifies, the teardown-guard test is vacuously green',
    );
    expect(ticks, 2);
  });
}
