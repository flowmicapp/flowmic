// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §3 (PCM 16 kHz mono s16le; 6400 B = 200 ms
//     slices; seq monotonic from 0; 30 s ring buffer; dBFS RMS amplitude meter;
//     PTT-up flushes < 200 ms residual tail AHEAD of audio:stop)
//   packages/protocol/src/protocol-schemas-audio.ts (AudioChunkSchema)
//   13-LESSONS-LEARNED §3 (F-2063: gate on mic permission or PTT looks alive
//     but zero chunks reach the server)
//
// Owns the platform recorder, slices PCM into 200 ms chunks, exposes the
// streams and lifecycle hooks the PTT session uses to drive the `audio:*`
// events. The platform recorder is injected via the [AudioRecorder] interface
// so unit tests drive a fake without touching the OS microphone.
//
// Ported from legacy audio/audio_capture.dart (mechanics carried over).

import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:permission_handler/permission_handler.dart';

import 'ring_buffer.dart';
import 'audio_emitter.dart';
import 'retained_audio_spill.dart';

/// 08 §3: 16 kHz mono s16le.
const int kAudioSampleRate = 16000;
const int kAudioChannels = 1;

/// 08 §3: 200 ms chunk → 200 ms × 16 kHz × 2 bytes = 6400 bytes.
const int kBytesPerSample = 2; // s16le
const int kChunkBytes = (kAudioSampleRate * kBytesPerSample * 200) ~/ 1000;

/// Lifecycle states emitted on [AudioCapture.state].
enum RecorderState { idle, recording, paused, stopped }

@immutable
class CapturedChunk {
  final int seq;
  final int tsMs;
  final Uint8List payload;
  const CapturedChunk({
    required this.seq,
    required this.tsMs,
    required this.payload,
  });
}

/// DI seam for the platform recorder (real impl backed by the `record`
/// package; fake impl used in unit tests + the integration WAV driver).
abstract class AudioRecorder {
  Future<bool> hasPermission();
  Future<void> start({required int sampleRate, required int numChannels});
  Stream<Uint8List> get pcmStream;
  Future<void> stop();
}

/// Owns the mic, slices PCM into 200 ms chunks, fans out to
/// [chunks] / [amplitudeDb] / [state] streams, and feeds the 30 s
/// [AudioRingBuffer] used by the reconnect coordinator.
///
/// RV-20 / 13 册 §7 F1 ②: [recorder] is required. The old `_NoopAudioRecorder`
/// DI default is what let the rewrite ship with a microphone that was never
/// opened — start() succeeded, the PTT UI looked alive, zero PCM reached the
/// server, and release builds were silent (the stub only named itself in
/// assert). Production passes RealAudioRecorder; tests pass a fake.
class AudioCapture {
  final AudioRecorder _recorder;
  final Duration _chunkDuration;
  late final AudioRingBuffer _ringBuffer;
  final int Function() _clock;

  /// N1-B3 retained-audio layer, or null when this instance has none (tests,
  /// and any build where the uplink signal has no production caller yet). When
  /// present, chunks aging out of the ring while the uplink is down are kept on
  /// disk instead of ceasing to exist. See retained_audio_spill.dart.
  final RetainedAudioSpill? _spill;

  final StreamController<CapturedChunk> _chunksController =
      StreamController<CapturedChunk>.broadcast();
  final StreamController<double> _amplitudeController =
      StreamController<double>.broadcast();
  final StreamController<RecorderState> _stateController =
      StreamController<RecorderState>.broadcast();

  final BytesBuilder _accumulator = BytesBuilder(copy: false);
  StreamSubscription<Uint8List>? _pcmSub;

  RecorderState _state = RecorderState.idle;
  int _seq = 0;
  final int _chunkBytes;

  // owner 2026-07-27 — DEAD-CAPTURE WATCHDOG. The platform recorder can accept
  // start(), report no error, drive the whole recording UI, and deliver zero PCM
  // for the entire utterance. Measured on the tablet: red PTT bar, running timer,
  // a 「转录中」("Transcribing") row… and `audio intake {"chunks":0,"bytes":0}` on
  // the server. The user was then told 「没有听到语音」("No speech was heard"),
  // which blames the room for a microphone that never opened. Bytes-in is the
  // only honest test, so it is tested.
  int _platformBytes = 0;
  Timer? _deadCaptureTimer;
  final StreamController<String> _faultsController =
      StreamController<String>.broadcast();

  /// Capture faults that the transport layer must surface LOUDLY. Currently one:
  /// `no-audio-captured`.
  Stream<String> get faults => _faultsController.stream;

  /// How long a live recorder may deliver nothing before we call it dead. Long
  /// enough that a slow OEM mic warm-up is not slandered, short enough that the
  /// user hears about it while still holding the button.
  static const Duration kDeadCaptureAfter = Duration(milliseconds: 1500);

  /// [spill] opts this instance into the N1-B3 retained-audio layer. When a
  /// caller supplies its own [ringBuffer] it also owns that buffer's
  /// `onEvict` wiring — otherwise the eviction seam would silently point at
  /// nothing, which is the one failure this layer must not have.
  AudioCapture({
    required AudioRecorder recorder,
    Duration chunkDuration = const Duration(milliseconds: 200),
    AudioRingBuffer? ringBuffer,
    RetainedAudioSpill? spill,
    int Function()? clock,
  }) : _recorder = recorder,
       _chunkDuration = chunkDuration,
       _spill = spill,
       _clock = clock ?? _wallClock,
       _chunkBytes = _bytesFor(chunkDuration) {
    if (_chunkBytes <= 0) {
      throw ArgumentError.value(
        chunkDuration,
        'chunkDuration',
        'chunkDuration must produce > 0 bytes (08-MOBILE-SPEC §3)',
      );
    }
    _ringBuffer = ringBuffer ?? AudioRingBuffer(onEvict: spill?.onEvicted);
  }

  static int _wallClock() => DateTime.now().millisecondsSinceEpoch;

  static int _bytesFor(Duration d) =>
      (kAudioSampleRate * kBytesPerSample * d.inMilliseconds) ~/ 1000;

  // ---------------------------------------------------------------- streams

  Stream<CapturedChunk> get chunks => _chunksController.stream;
  Stream<double> get amplitudeDb => _amplitudeController.stream;
  Stream<RecorderState> get state => _stateController.stream;

  RecorderState get currentState => _state;
  int get currentSeq => _seq;
  Duration get chunkDuration => _chunkDuration;

  // ------------------------------------------------------------- lifecycle

  /// 08 §3 / F-304: gate audio start on microphone permission. Returns whether
  /// the permission is granted after the request.
  Future<bool> requestPermission() async {
    if (await _recorder.hasPermission()) return true;
    final status = await Permission.microphone.request();
    return status.isGranted;
  }

  /// Begin a fresh capture session: resets seq=0, transitions to recording,
  /// starts the underlying recorder + slice subscription.
  ///
  /// F-2063: gate on microphone permission first — the legacy façade shipped
  /// [requestPermission] defined but never called, so `record` silently
  /// produced no PCM (PTT looked alive but zero chunks reached the server).
  ///
  /// P6 (0.3.1): [permissionPreflighted] lets a caller that JUST probed a
  /// definitive GRANTED (MicPermissionFlow.gateForPtt, one platform hop ago on
  /// the same press) skip the redundant probe here — this path is the press
  /// latency the owner measured at ~2 s, and [requestPermission] costs one to
  /// two more platform round trips on it. Only ever pass true for a
  /// definitive grant: the F-2063 gate above stays the sole guard for every
  /// other caller, and a stale `true` still fails loudly in [_attachRecorder]
  /// (startStream throws, the caller renders captureStartFailed).
  Future<void> start({bool permissionPreflighted = false}) async {
    if (_state == RecorderState.recording) return;
    if (!permissionPreflighted && !await requestPermission()) {
      throw StateError('microphone permission denied');
    }
    _seq = 0;
    _accumulator.clear();
    _ringBuffer.clear();
    _platformBytes = 0;
    await _attachRecorder();
    _transition(RecorderState.recording);
    _armDeadCaptureWatchdog();
  }

  /// A recorder that has been running for [kDeadCaptureAfter] without producing
  /// a single byte is not a quiet room — it is a microphone that never opened.
  /// Say so; the alternative is 「没有听到语音」("No speech was heard") blaming
  /// the user.
  void _armDeadCaptureWatchdog() {
    _deadCaptureTimer?.cancel();
    _deadCaptureTimer = Timer(kDeadCaptureAfter, () {
      if (_state != RecorderState.recording || _platformBytes > 0) return;
      debugPrint('[flowmic.audio] DEAD CAPTURE — 0 bytes from the platform '
          'recorder after ${kDeadCaptureAfter.inMilliseconds}ms');
      if (!_faultsController.isClosed) _faultsController.add('no-audio-captured');
    });
  }

  /// 08 §3 / F-407: stops the recorder but keeps state=paused until [resume].
  /// No chunks are emitted while paused. [reason] is forwarded to the upstream
  /// `audio:pause` event by the caller.
  Future<void> pause({String reason = 'background'}) async {
    if (_state != RecorderState.recording) return;
    await _detachRecorder();
    _accumulator.clear();
    _transition(RecorderState.paused);
  }

  /// Resume after a [pause]. Re-arms the recorder; seq continues monotonic.
  Future<void> resume() async {
    if (_state != RecorderState.paused) return;
    await _attachRecorder();
    _transition(RecorderState.recording);
  }

  /// STOP VERB ① of three — the NORMAL end of a capture (SEG-2, design
  /// 2026-08-11 §2-R3: 「三个动词三份注释，各自写明调用方清单」).
  ///
  ///   · WHO CALLS ME: `PttSession.pttUp` (ptt/ptt_session.dart) — the user
  ///     released the button. Grep `audio.stop()`.
  ///   · TAIL: RETAINED when the uplink is down ([retainUnsentTail], a no-op on
  ///     a healthy link). The caller has already emitted the residual chunk and
  ///     `audio:stop` on the wire — the wire half is the caller's job, not mine.
  ///
  /// Finalize: stops the recorder and emits the terminal state. After this the
  /// capture instance is single-shot — call [start] again for a new run.
  Future<void> stop() async {
    if (_state == RecorderState.stopped) return;
    // N1-B3: before the ring goes stale, keep the tail if the uplink is down.
    // No-ops entirely on a healthy link.
    await retainUnsentTail();
    await _detachRecorder();
    _accumulator.clear();
    _transition(RecorderState.stopped);
  }

  /// STOP VERB ② of three — cancel / fault: the utterance NEVER HAPPENED.
  ///
  ///   · WHO CALLS ME (grep `fenceAndStop`): `PttSession.pttCancel`
  ///     (ptt/ptt_session.dart — swipe-up cancel), the `audio:auto-stopped`
  ///     arm (ptt/ptt_inbound.dart — the server already ended the session),
  ///     `_onCaptureFault` (ptt/ptt_capture_pump.dart — dead microphone) and
  ///     `AuthExpiredHandler.drain` (signaling/auth_expired_handler.dart —
  ///     capture authority is gone).
  ///   · TAIL: DISCARDED, deliberately (SEG-2 §5-5: this semantics is frozen).
  ///
  /// Immediately revokes capture authority, then releases the recorder. Used by
  /// PTT swipe-up cancel (08 §2 cancelPtt) so synchronous listeners already
  /// observe a non-recording state before a role demotion is published.
  ///
  /// ⚠️ N1-B3: deliberately does NOT retain the ring tail, unlike [stop]. This
  /// is the cancel / capture-fault path — 「no timeline row, the utterance never
  /// happened」. Retaining audio the user explicitly threw away would resurface
  /// it later as 「待转录」, i.e. the app would insist on transcribing something
  /// that was cancelled on purpose.
  ///
  /// 🔴 W8-3/C3 — ONE caller above does not fit this verb's headline, and the
  /// ledger flagged the mismatch, so it is written down instead of left to
  /// read like an accident: on the `audio:auto-stopped` arm the utterance DID
  /// happen and DOES mint a row (the server flushes a terminal `stt:final`
  /// right behind that frame). The discard is still correct there, for a
  /// DIFFERENT reason than the cancel caller's: when the frame arrives the
  /// server's AudioSession is already `auto_stopped` and its pushChunk drops
  /// every later chunk (server-core `stt/audio/session.ts`), so what this
  /// verb throws away is (a) ring audio that was ALREADY uploaded — the ring
  /// exists for reconnect replay, it is never the only copy on a live link —
  /// and (b) a sub-chunk (<200 ms) residual from at/past the ceiling that no
  /// engine will ever be asked about. The row is minted from what the engine
  /// heard BEFORE the ceiling; nothing discarded here could still reach a
  /// transcript. Retaining it would be the actual bug — audio surfacing as
  /// 「待转录」 for a session that has already settled. Same action as cancel,
  /// different justification; the headline's 「never happened」 is only the
  /// cancel/fault callers' truth. (SEG-2 §5-5 freezes the ACTION; this
  /// paragraph corrects the per-caller explanation, not the behaviour.)
  void fenceAndStop() {
    if (_state == RecorderState.stopped) return;
    _transition(RecorderState.stopped);
    _accumulator.clear();
    unawaited(_detachRecorder());
  }

  /// STOP VERB ③ of three — the link is DEAD: keep the tail, tell no one on
  /// the wire (SEG-2, design 2026-08-11 §2-R3, the RT3-A hole: the FSM's 3 s
  /// drop grace expired mid-recording and, before this verb, NOTHING stopped
  /// the microphone — it ran on with the ring evicting until the next
  /// `start()` cleared what was left).
  ///
  ///   · WHO CALLS ME (grep `stopForLinkLoss`): `PttSession._onLinkLossEdge`
  ///     (ptt/ptt_link_loss.dart) — the one edge on which the session layer
  ///     has judged the recording dead locally.
  ///   · TAIL: RETAINED — the residual sub-chunk partial is folded into the
  ///     ring first ([takeResidualChunk], NOT emitted: the link is dead and a
  ///     frame emitted into it would be a lie), then everything still in the
  ///     ring is handed to the retention layer.
  ///   · WIRE: NOTHING. This verb never touches a transport (it has none) and
  ///     its caller must not emit either — no `audio:stop`, no residual chunk.
  ///
  /// Returns whether the tail was actually handed to a live retention layer
  /// (spill wired AND there was audio to keep). The caller words the
  /// user-visible notice off this fact: claiming 「已录的音频保留在这台手机上」
  /// ("the recorded audio has been kept on this phone") on a build whose spill
  /// construction failed — or for a press that produced zero audio — would be
  /// exactly the unbacked promise 15 册 §2.0-b bans.
  ///
  /// ⚠️ `noteUplinkDown()` below is NOT a second writer of the uplink fact
  /// (the transport-status edge in ptt_capture_pump.dart stays the live one).
  /// It RESTATES this verb's own precondition — the name says the link is dead
  /// — so a mis-wired status signal degrades to extra disk, never to lost
  /// speech (design §5-4: fail toward duplication/retention, never loss).
  ///
  /// Synchronous decision, queued I/O: the retention writes ride the spill's
  /// own serialised chain; await [RetainedAudioSpill.flush] to observe them.
  bool stopForLinkLoss() {
    if (_state == RecorderState.stopped) return false;
    takeResidualChunk();
    final RetainedAudioSpill? spill = _spill;
    final bool kept = spill != null && _ringBuffer.size > 0;
    if (spill != null) {
      spill.noteUplinkDown();
      unawaited(spill.retainTail(_ringBuffer.since(cutoffMs: -1)));
    }
    _transition(RecorderState.stopped);
    _accumulator.clear();
    unawaited(_detachRecorder());
    return kept;
  }

  /// F-2223 / 08 §3: pop the trailing sub-chunk partial — the < 200 ms of PCM
  /// past the last full 6400-byte boundary that [_onPcm] leaves in the
  /// accumulator. Returns it as a final [CapturedChunk] (next monotonic seq,
  /// pushed to the ring buffer so a reconnect replay still includes the tail)
  /// and empties the accumulator; null when nothing is buffered. Deliberately
  /// does NOT add to [chunks] — the caller emits it directly so it is ordered
  /// on the wire AHEAD of audio:stop (a stream add lands on a later microtask,
  /// which is exactly the race that dropped the utterance tail). Stop-path
  /// only; [pause] still discards its partial.
  CapturedChunk? takeResidualChunk() {
    if (_accumulator.length <= 0) return null;
    final Uint8List payload = _accumulator.takeBytes();
    final int tsMs = _clock();
    final CapturedChunk captured = CapturedChunk(
      seq: _seq,
      tsMs: tsMs,
      payload: payload,
    );
    _ringBuffer.push(seq: _seq, tsMs: tsMs, payload: payload, nowMs: tsMs);
    _seq += 1;
    return captured;
  }

  /// Replay window (08 §4): forwards to the ring buffer. Used by the reconnect
  /// coordinator when the WS comes back up.
  List<BufferedChunk> replaySince({required int cutoffMs}) =>
      _ringBuffer.since(cutoffMs: cutoffMs);

  // `replay({fromSeq, toSeq})` was removed on 2026-07-31 with the
  // `audio:resend-request` event it served (stage-5 cleanup): the server has
  // never emitted that request, so this seq-slice accessor had no live caller.
  // The full-window replay below is the recovery path that actually runs.

  /// Every chunk currently retained in the 30 s ring buffer, encoded as an
  /// `audio:chunk` payload (same shape [AudioEmitter.buildChunkPayload]
  /// produces). The reconnect coordinator pulls this on a successful reconnect
  /// and re-emits each entry so the server resumes losslessly. Read-only.
  ///
  /// SEG-2 / design 2026-08-11 §2-R5 — [cutoffSeq] is the server's OWN
  /// watermark (`audio_last_contiguous_seq` off the `mobile:reconnect` ack,
  /// = SeqTracker.lastContiguousSeq): the last seq it has contiguously
  /// observed for the live recording session. The trim predicate is
  /// 「resend ONLY `seq > cutoffSeq`」 — a chunk AT the watermark is observed,
  /// so it is trimmed; the one after it is not proven, so it is sent.
  ///
  /// 🔴 FAILURE DIRECTION (§5-4): `null` — the ack had no such field, or a
  /// malformed one — means FULL replay, i.e. byte-for-byte today's behaviour;
  /// `-1` is a legal VALUE (session live, zero chunks observed) and trims
  /// nothing because every seq is > -1. The trim may only ever remove chunks
  /// the server has stated it observed; every failure falls toward
  /// duplication (deduped server-side by SeqTracker.hasObserved), never loss.
  List<Map<String, Object?>> bufferedChunkPayloads({int? cutoffSeq}) {
    final List<BufferedChunk> chunks = _ringBuffer.since(cutoffMs: -1);
    return <Map<String, Object?>>[
      for (final BufferedChunk c in chunks)
        if (cutoffSeq == null || c.seq > cutoffSeq)
          AudioEmitter.buildChunkPayload(
            seq: c.seq,
            tsMs: c.tsMs,
            payload: c.payload,
          ),
    ];
  }

  @visibleForTesting
  int get bufferedSize => _ringBuffer.size;

  /// How many SECONDS of audio the 30 s ring buffer is currently holding.
  int get bufferedSeconds =>
      (_ringBuffer.size * _chunkDuration.inMilliseconds) ~/ 1000;

  // ------------------------------------------- retained audio (card N1-B3)

  /// The retained-audio layer, or null when this instance has none.
  RetainedAudioSpill? get retainedAudio => _spill;

  /// 🔴 THE ONE SIGNAL THIS LAYER CANNOT DERIVE BY ITSELF.
  /// AudioCapture never touches the transport, so it cannot know the uplink is
  /// down; the production caller is the transport STATUS edge —
  /// `_noteUplinkStatus` in `ptt/ptt_capture_pump.dart` (wired from
  /// `PttSession`'s `_statusSub`).
  ///
  /// ⚠️ SEG-2 amendment (2026-08-11): the paragraph that stood here pointed at
  /// `_emitChunk`'s catch block as the site 「that already holds exactly this
  /// fact」, and said no caller existed yet. Both halves had expired:
  /// `_noteUplinkStatus`'s own header MEASURED the catch-block theory false
  /// (`SocketCore.emit` does not throw on a network outage — see
  /// retained_audio_wiring_test.dart, which pins it against the real
  /// SocketCore), and N1-B2 wired the status edge as the caller. The 「待转录」
  /// ban (15 册 §2.0-b constraint 3) still stands — on its remaining leg: the
  /// upload/re-transcription mechanism does not exist (design 2026-08-11 §6).
  void noteUplinkDown() => _spill?.noteUplinkDown();

  /// See [noteUplinkDown].
  void noteUplinkUp() => _spill?.noteUplinkUp();

  /// Record a `segment_idx` observed on an inbound stt frame, so retained audio
  /// is keyed to the segment the server actually delimited.
  void noteSegmentObserved(int segmentIdx) =>
      _spill?.noteSegmentObserved(segmentIdx);

  /// Retain whatever is still sitting in the ring when capture ends with the
  /// uplink down.
  ///
  /// Without this, the last ≤ 30 s of every outage-ending utterance would be
  /// lost anyway: those chunks never aged out, so [AudioRingBuffer.onEvict]
  /// never saw them, and the next [start] clears the ring. The eviction trigger
  /// alone covers the middle of an outage but not its tail.
  Future<void> retainUnsentTail() async {
    final RetainedAudioSpill? spill = _spill;
    if (spill == null || spill.uplinkUp) return;
    await spill.retainTail(_ringBuffer.since(cutoffMs: -1));
  }

  // ---------------------------------------------------------- internals

  Future<void> _attachRecorder() async {
    await _recorder.start(
      sampleRate: kAudioSampleRate,
      numChannels: kAudioChannels,
    );
    _pcmSub = _recorder.pcmStream.listen(
      _onPcm,
      onError: _chunksController.addError,
    );
  }

  Future<void> _detachRecorder() async {
    _deadCaptureTimer?.cancel();
    _deadCaptureTimer = null;
    await _pcmSub?.cancel();
    _pcmSub = null;
    try {
      await _recorder.stop();
    } catch (_) {
      // Stop errors during pause/stop are non-fatal — the spec only requires
      // that the upstream audio:pause / audio:stop event fires.
    }
  }

  void _onPcm(Uint8List data) {
    // Counted BEFORE the state gate: bytes that arrive are proof the microphone
    // opened, even if this instance is no longer the one recording them.
    _platformBytes += data.length;
    if (_state != RecorderState.recording) return;
    _accumulator.add(data);
    while (_accumulator.length >= _chunkBytes) {
      final taken = _accumulator.takeBytes();
      // takeBytes() returns the entire accumulator — slice off one chunk and
      // put the remainder back so partial fills survive across reads.
      final chunk = Uint8List.sublistView(taken, 0, _chunkBytes);
      if (taken.length > _chunkBytes) {
        _accumulator.add(Uint8List.sublistView(taken, _chunkBytes, taken.length));
      }
      _emitChunk(chunk);
    }
  }

  void _emitChunk(Uint8List payload) {
    final tsMs = _clock();
    final captured = CapturedChunk(seq: _seq, tsMs: tsMs, payload: payload);
    _ringBuffer.push(seq: _seq, tsMs: tsMs, payload: payload, nowMs: tsMs);
    _chunksController.add(captured);
    _amplitudeController.add(_amplitudeDbFor(payload));
    _seq += 1;
  }

  void _transition(RecorderState next) {
    if (_state == next) return;
    _state = next;
    _stateController.add(next);
  }

  /// 08 §3: the amplitude meter feeds off this. Returns dBFS in `[-100, 0]`
  /// (silence → -100). Pure function over the slice payload so tests assert
  /// without microphone hardware.
  double _amplitudeDbFor(Uint8List payload) {
    if (payload.isEmpty) return -100.0;
    final samples = Int16List.view(
      payload.buffer,
      payload.offsetInBytes,
      payload.lengthInBytes ~/ 2,
    );
    var sumSq = 0.0;
    for (final s in samples) {
      sumSq += s * s;
    }
    final rms = math.sqrt(sumSq / samples.length);
    if (rms <= 0) return -100.0;
    final db = 20.0 * (math.log(rms / 32768.0) / math.ln10);
    return db.clamp(-100.0, 0.0).toDouble();
  }

  /// Tear down stream controllers. Tests should call this in `tearDown` so the
  /// broadcast streams don't leak between cases.
  Future<void> dispose() async {
    _deadCaptureTimer?.cancel();
    _deadCaptureTimer = null;
    await _detachRecorder();
    await _faultsController.close();
    await _chunksController.close();
    await _amplitudeController.close();
    await _stateController.close();
  }
}
