// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §3 (PCM 16 kHz mono s16le streaming)
//   docs/rebuild/08-MOBILE-SPEC.md §8 (Android platform integration)
//
// Platform-backed implementation of the [AudioRecorder] interface, wrapping the
// `record` package. AudioCapture's DI seam means the rest of the pipeline (ring
// buffer, slicer, amplitude meter) is wholly platform-independent and unit-
// testable with a fake. Guarded so a test runner without the media plugin
// raises UnsupportedError rather than NPE'ing deeper in the plugin.
//
// Ported from legacy audio/real_audio_recorder.dart (mechanics carried over).

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:record/record.dart' as rec;

import 'audio_capture.dart';

/// Builds a platform `record.AudioRecorder`. Tests substitute a stub factory so
/// the platform plugin is never touched.
typedef PlatformRecorderFactory = rec.AudioRecorder Function();

/// Production AudioRecorder implementation backed by the `record` package. The
/// platform recorder is built lazily so constructing this class does not pull
/// in platform code paths.
class RealAudioRecorder implements AudioRecorder {
  RealAudioRecorder({PlatformRecorderFactory? factory})
    : _factory = factory ?? (() => rec.AudioRecorder());

  final PlatformRecorderFactory _factory;
  rec.AudioRecorder? _recorder;
  StreamController<Uint8List>? _pcmCtl;
  StreamSubscription<Uint8List>? _platformSub;
  StreamSubscription<rec.RecordState>? _stateSub;

  rec.AudioRecorder _ensure() {
    final rec.AudioRecorder? r = _recorder;
    if (r != null) return r;
    final rec.AudioRecorder built;
    try {
      built = _factory();
    } on Object catch (e) {
      throw UnsupportedError('record plugin unavailable: $e');
    }
    _recorder = built;
    return built;
  }

  @override
  Future<bool> hasPermission() async {
    try {
      return await _ensure().hasPermission();
    } on Object {
      // Plugin-missing / unsupported: report "no permission" so the caller
      // falls back to a permission prompt rather than spinning on crashes.
      return false;
    }
  }

  @override
  Future<void> start({required int sampleRate, required int numChannels}) async {
    final rec.AudioRecorder recorder = _ensure();
    final rec.RecordConfig cfg = rec.RecordConfig(
      encoder: rec.AudioEncoder.pcm16bits,
      sampleRate: sampleRate,
      numChannels: numChannels,
      bitRate: sampleRate * 16 * numChannels,
      // owner 2026-07-27, measured on the tablet: startStream() succeeded, the
      // recording UI ran, and the native layer never created an AudioRecord at
      // all — `audio intake {"chunks":0,"bytes":0}` on the server, zero record
      // clients in media.audio_flinger. The plugin's defaults are the suspect:
      //   · manageBluetooth defaults to TRUE, so with any BT device paired (this
      //     tablet always has one) it goes off to negotiate a headset SCO link
      //     before recording. FlowMic has no business hijacking a headset
      //     mid-utterance, and a stalled SCO negotiation produces exactly this
      //     silence.
      //   · audioSource defaults to `defaultSource`, which OEM audio policies
      //     route as they please. `mic` names the device we actually mean.
      androidConfig: const rec.AndroidRecordConfig(
        audioSource: rec.AndroidAudioSource.mic,
        manageBluetooth: false,
      ),
    );
    final Stream<Uint8List> raw;
    try {
      raw = await recorder.startStream(cfg);
    } on Object catch (e) {
      throw StateError('failed to start audio stream: $e');
    }
    // owner 2026-07-27 — the plugin reports a failed start on its STATE channel,
    // not on the audio-chunk channel we listen to, so a native failure reached
    // nobody: startStream() returns cleanly, the UI records, and zero bytes ever
    // arrive. Subscribe to the channel the plugin actually talks on.
    unawaited(_stateSub?.cancel());
    _stateSub = recorder.onStateChanged().listen(
      (rec.RecordState s) => debugPrint('[flowmic.audio] recorder state: $s'),
      onError: (Object e) => debugPrint('[flowmic.audio] recorder FAILED: $e'),
    );
    final StreamController<Uint8List> ctl =
        StreamController<Uint8List>.broadcast();
    _pcmCtl = ctl;
    _platformSub = raw.listen(
      ctl.add,
      // owner 2026-07-27: whatever the platform says here USED to end up on a
      // broadcast stream nobody had an error handler on — an unhandled async
      // error, which release builds swallow. If the plugin has been telling us
      // why the microphone never opened, this is where it was saying it.
      onError: (Object e, StackTrace st) {
        debugPrint('[flowmic.audio] platform recorder error: $e');
        ctl.addError(e, st);
      },
      onDone: () {
        if (!ctl.isClosed) ctl.close();
      },
      cancelOnError: false,
    );
  }

  @override
  Stream<Uint8List> get pcmStream {
    final StreamController<Uint8List>? ctl = _pcmCtl;
    if (ctl == null) {
      final StreamController<Uint8List> empty =
          StreamController<Uint8List>.broadcast();
      _pcmCtl = empty;
      return empty.stream;
    }
    return ctl.stream;
  }

  @override
  Future<void> stop() async {
    final rec.AudioRecorder? recorder = _recorder;
    if (recorder != null) {
      try {
        await recorder.stop();
      } on Object {
        // Stop errors are non-fatal — audio_capture treats them as
        // "stream has ended either way".
      }
    }
    await _platformSub?.cancel();
    _platformSub = null;
    await _stateSub?.cancel();
    _stateSub = null;
    final StreamController<Uint8List>? ctl = _pcmCtl;
    if (ctl != null && !ctl.isClosed) await ctl.close();
    _pcmCtl = null;
  }

  /// Test-visible disposal so the platform recorder (and any open stream
  /// controllers) shut down cleanly. Called by the composition root in prod.
  Future<void> dispose() async {
    await stop();
    try {
      await _recorder?.dispose();
    } on Object {
      // Plugins occasionally throw on double-dispose; swallow.
    }
    _recorder = null;
  }
}
