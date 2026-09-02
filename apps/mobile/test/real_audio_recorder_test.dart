// F5 (2026-09-02 audit) — `RealAudioRecorder.stop()` used to read
// `_platformSub`/`_stateSub`/`_pcmCtl` off its OWN FIELDS *after* awaiting the
// platform's `recorder.stop()`. That await is a real round trip and a fast
// re-press can land while it is still outstanding: `start()` overwrites those
// fields with the NEW press's instances, so the OLD `stop()` call — once its
// await finally resolves — cancels and CLOSES the NEW press's subscription
// and stream controller instead of its own. The new press's native capture
// keeps running, but every byte it produces is piped into a controller this
// stale `stop()` call just closed: the phone reads that as a false
// 「没有听到语音」("no speech was heard") for a press that really did record.
//
// This test drives the platform call itself through a fake `rec.AudioRecorder`
// subclass whose `stop()` blocks on a completer, so a fast re-press can be
// interleaved deterministically while the FIRST press's `stop()` is still
// waiting on the (fake) native call.

import 'dart:async';
import 'dart:typed_data';

import 'package:flowmic/src/audio/real_audio_recorder.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:record/record.dart' as rec;

/// A `rec.AudioRecorder` double with NO platform channel behind it: every
/// method that would otherwise reach `RecordPlatform.instance` is overridden.
/// `stop()` blocks on [stopGate] so a test can hold it open on purpose.
class _FakePlatformRecorder extends rec.AudioRecorder {
  final Completer<void> stopGate = Completer<void>();
  int stopCalls = 0;

  /// One raw controller per `startStream()` call, kept OPEN (unlike
  /// `Stream.empty()`, which fires `onDone` on its own the moment it is
  /// listened to and would close `RealAudioRecorder`'s piped-through
  /// controller for a reason unrelated to the bug this test is about).
  final List<StreamController<Uint8List>> rawStreams =
      <StreamController<Uint8List>>[];

  @override
  Future<bool> hasPermission() async => true;

  @override
  Future<Stream<Uint8List>> startStream(rec.RecordConfig config) async {
    final StreamController<Uint8List> ctl = StreamController<Uint8List>();
    rawStreams.add(ctl);
    return ctl.stream;
  }

  @override
  Stream<rec.RecordState> onStateChanged() =>
      const Stream<rec.RecordState>.empty();

  @override
  Future<String?> stop() async {
    stopCalls++;
    await stopGate.future;
    return null;
  }
}

void main() {
  test(
      'F5: a fast re-press during stop() keeps the NEW press\'s subscription '
      'alive — the old stop() must not cancel it', () async {
    final _FakePlatformRecorder fake = _FakePlatformRecorder();
    final RealAudioRecorder r = RealAudioRecorder(factory: () => fake);
    addTearDown(r.dispose);
    addTearDown(() {
      for (final StreamController<Uint8List> c in fake.rawStreams) {
        if (!c.isClosed) c.close();
      }
    });

    // Press #1 starts and is released. `stop()` is NOT awaited yet — it is
    // the "old" call whose platform round trip (`fake.stop()`) is about to
    // block on `stopGate`.
    await r.start(sampleRate: 16000, numChannels: 1);
    final Future<void> oldStop = r.stop();
    await pumpEventQueue();
    expect(fake.stopCalls, 1,
        reason: 'the old stop() call must have reached the platform recorder '
            'before the fast re-press');

    // The fast re-press: a NEW recording starts while the OLD stop() is still
    // waiting on the platform. `start()` replaces the internal subscription +
    // controller with this press's own.
    await r.start(sampleRate: 16000, numChannels: 1);
    final Stream<Uint8List> newPressStream = r.pcmStream;
    bool newPressStreamClosed = false;
    final StreamSubscription<Uint8List> newPressSub = newPressStream.listen(
      (_) {},
      onDone: () => newPressStreamClosed = true,
    );
    addTearDown(newPressSub.cancel);

    // Now let the OLD stop() call's platform round trip finish.
    fake.stopGate.complete();
    await oldStop;

    // 🔴 THE ASSERTION THAT MATTERS (F5). Before the fix, the old `stop()`
    // call reads `_pcmCtl`/`_platformSub` AFTER its await — by now those
    // fields belong to the NEW press — and closes/cancels them. Reverting
    // the fix (reading the fields after the await instead of capturing them
    // before it) turns this assertion red.
    expect(newPressStreamClosed, isFalse,
        reason: "the fast re-press's own stream must still be open — the old "
            "stop() call owns a DIFFERENT (stale) subscription");

    // Positive control: bytes the fast re-press's NATIVE stream produces
    // still make it all the way through — the raw platform subscription the
    // old stop() call must NOT have cancelled, piped into the controller it
    // must NOT have closed.
    final List<int> received = <int>[];
    final StreamSubscription<Uint8List> secondListener =
        r.pcmStream.listen(received.addAll);
    addTearDown(secondListener.cancel);
    fake.rawStreams.last.add(Uint8List.fromList(<int>[7, 8, 9]));
    await pumpEventQueue();
    expect(received, <int>[7, 8, 9],
        reason: "a byte the fast re-press's mic produced must still reach "
            'the pipeline — proof the pipe from raw stream to broadcast '
            'controller was never torn down');

    await r.stop();
  });
}
