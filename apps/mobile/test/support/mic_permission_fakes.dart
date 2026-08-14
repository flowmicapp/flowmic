// Card U2 test doubles for the mic-permission seam (ptt/mic_permission.dart).
// Same contract as support/fakes.dart: the fakes say 「this is a test double」 in the name;
// production defaults stay the real thing (PlatformMicPermission).

import 'dart:typed_data';

import 'package:flowmic/src/ptt/mic_permission.dart';

import 'fakes.dart';

/// A [MicPermissionPort] the test scripts by hand. `request()` answers
/// [requestAnswer] when set (and makes it the new [current]) — that is how a
/// test plays 「the user tapped 允许 and the OS said X」.
class FakeMicPermissionPort implements MicPermissionPort {
  FakeMicPermissionPort(this.current);

  MicPermissionProbe current;
  MicPermissionProbe? requestAnswer;

  int statusCalls = 0;
  int requestCalls = 0;
  int openSettingsCalls = 0;

  @override
  Future<MicPermissionProbe> status() async {
    statusCalls++;
    return current;
  }

  @override
  Future<MicPermissionProbe> request() async {
    requestCalls++;
    final MicPermissionProbe? next = requestAnswer;
    if (next != null) current = next;
    return current;
  }

  @override
  Future<void> openSettings() async {
    openSettingsCalls++;
  }
}

/// A [MicPermissionFlow] over the fake port, for harnesses whose subject is NOT
/// the microphone permission. GRANTED by default: those fixtures describe a
/// phone that can record.
///
/// 🔴 Why every PTT fixture needs one (measured 2026-08-04, Card U2): the
/// PRODUCTION default `PttSession` builds is the real `PlatformMicPermission`,
/// and in a plain `test()` — no `TestWidgetsFlutterBinding` — its first
/// `MethodChannel.invokeMethod` throws 「Binding has not yet been initialized」.
/// The moment `pttDown` grew its gate, 77 tests across 11 files went red on
/// exactly that. That is the DI seam WORKING (a fixture that never named a
/// microphone was relying on there being no gate at all); the fix is a named
/// double here, never a friendlier production default (13 册 §7 F1 ②).
MicPermissionFlow newTestMicPermission({
  MicPermissionProbe probe = MicPermissionProbe.granted,
  bool askedBefore = true,
}) => MicPermissionFlow(
  port: FakeMicPermissionPort(probe),
  asked: InMemoryMicAskedStore(asked: askedBefore),
);

/// A recorder whose permission IS granted and whose `start()` STILL throws —
/// the U2-④ shape (`AudioCapture.start` failing for a non-permission reason),
/// which must surface as 「无法启动录音」, never as a borrowed 「权限被拒」 and
/// never silently.
class ExplodingAudioRecorder extends FakeAudioRecorder {
  @override
  Future<void> start({required int sampleRate, required int numChannels}) async {
    throw StateError('recorder exploded (test double)');
  }

  @override
  Stream<Uint8List> get pcmStream => const Stream<Uint8List>.empty();
}
