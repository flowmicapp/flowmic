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
// JournalInterrupt only: the named stop reasons card LS-2 records. The journal
// itself is the spill's business, not this file's.
import 'retained_audio_manifest.dart' show JournalInterrupt;
import 'retained_audio_spill.dart';

// 700-line cap — the card LS-2 journal call sites (see that file's header).
// Same library, so `_spill` and `_accumulator` stay in scope.
part 'audio_capture_journal.dart';
part 'audio_capture_pcm.dart';

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
  final StreamController<int> _platformBytesController =
      StreamController<int>.broadcast();

  /// Card LS-4 — the store session key the CURRENT recording's bytes are filed
  /// under, snapshotted by [start]. See there for why it is not read live.
  String? _retainSessionKey;

  /// Capture faults that the transport layer must surface LOUDLY. Currently one:
  /// `no-audio-captured`.
  Stream<String> get faults => _faultsController.stream;

  /// Every PCM delivery from the platform recorder, as a byte count, BEFORE it
  /// is sliced into chunks and before the state gate — the same instant
  /// [_platformBytes] is incremented.
  ///
  /// 🔴 IT EXISTS BECAUSE [chunks] CANNOT ANSWER "ARE BYTES STILL ARRIVING".
  /// A chunk is 200 ms of audio (6400 bytes); a recorder that delivers 64
  /// bytes and then stops produces NO chunk, ever. `AsrHealthTracker`'s
  /// `byteStall` was fed from [chunks] and so never saw a first byte, and the
  /// dead-capture watchdog below is one-shot on `_platformBytes > 0` and so
  /// saw one and stood down — between the two, a sub-chunk trickle left the
  /// live row saying 「Transcribing」 for the whole recording with nothing
  /// contradicting it. Two watchdogs, two facts, and this stream is the one
  /// that carries the second (`session/chat_asr_health_wire.dart` is its
  /// single production consumer).
  ///
  /// ⚠️ COUNTS ONLY. The bytes themselves stay on [chunks]: a second copy of
  /// the payload here would be a second author of "what audio was captured".
  Stream<int> get platformBytes => _platformBytesController.stream;

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
    if (_state == RecorderState.recording) {
      // 🔴 DEFECT D-3 (round-four device drill, 2026-09-06) — THIS EARLY RETURN
      // IS CORRECT AND IT USED TO BE SILENT, WHICH IS WHAT MADE IT DANGEROUS.
      // One recording, one journal: the caller below opens it, so a second
      // `start()` on a live recorder opens NOTHING and everything captured from
      // here is appended to the PREVIOUS recording's file. On device that
      // produced a second 「long recording」 whose audio landed inside the first
      // article — 38,912,000 -> 40,115,200 B, no new file — and a Stop that
      // closed the wrong one. The guard against it is
      // `PttSession.beginContinuous` refusing outright; this line is how the
      // failure announces itself if that ever stops holding.
      debugPrint('[flowmic.audio] start() IGNORED — a recording is already '
          'running; its journal stays open and nothing new was created');
      return;
    }
    if (!permissionPreflighted && !await requestPermission()) {
      throw StateError('microphone permission denied');
    }
    _seq = 0;
    _accumulator.clear();
    _ringBuffer.clear();
    _platformBytes = 0;
    // 🔴 CARD LS-4 — REMEMBER WHICH SESSION KEY THIS RECORDING'S BYTES ARE
    // FILED UNDER, AT THE MOMENT IT STARTS. A cancel must tombstone THIS
    // recording, and by the time the cancel path reaches [fenceAndStop] the
    // store's cursor may already have moved: `PttSession.pttCancel` runs
    // `endContinuous()` first, which calls `RetainedAudioSpill.endSession()`
    // and rolls the cursor to a fresh per-run key. Tombstoning "whatever the
    // cursor says now" would therefore mark an EMPTY key and leave the real
    // bytes pending — the defect intact, with a marker file to prove it was
    // handled. Same identity rule the journal already uses for its recording
    // id: mint at start, not at teardown.
    _retainSessionKey = _spill?.store.sessionKey;
    // Card LS-2 — open this recording's journal BEFORE the recorder can hand
    // us a byte. No-op unless the spill was built with retainFromFirstFrame.
    _journalBeginRecording(this);
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
    // Card LS-2 — the partial below has always been discarded. It still is,
    // from the wire; the journal keeps a copy first. Pause closes nothing:
    // a paused recording is one recording, and resume() continues it.
    _journalTakePausePartial(this);
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
  /// 🔴 P1-1 (card LS-1b) — THE `finally` IS THE POINT, NOT TIDINESS.
  /// Retention is a best-effort safety net; releasing the microphone is the
  /// user's own instruction. Before this, a throw out of [retainUnsentTail]
  /// skipped `_detachRecorder()` and the transition, so a disk error left the
  /// recorder running and the state machine still in `recording` — the app
  /// would have been unable to stop because its safety net failed. §A9 P1-1 ③:
  /// a write failure must never block stopping.
  Future<void> stop() async {
    if (_state == RecorderState.stopped) return;
    // 🔴 CARD LS-1b — BEFORE THE FIRST `await`. The terminal `stt:final` can
    // land inside `retainUnsentTail()` below (same race
    // `ptt_up_final_race_test.dart` measures for the FSM), and the settle it
    // triggers needs this count. See `_journalNoteFrames`.
    _journalNoteFrames(this);
    try {
      // N1-B3: before the ring goes stale, keep the tail if the uplink is down.
      // No-ops entirely on a healthy link.
      await retainUnsentTail();
    } finally {
      // Card LS-2 — an ordinary end: no interrupt reason. Inside the `finally`
      // for the same reason everything else here is (P1-1 ③): a retention
      // failure must never leave the microphone open.
      _journalEndRecording(this, null);
      await _detachRecorder();
      _accumulator.clear();
      _transition(RecorderState.stopped);
    }
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
  /// 🔴 CARD LS-4 (owner ruling O-5, 2026-09-06) — [reason] NAMES THE CALLER,
  /// AND ONE OF THE FOUR NAMES CARRIES A TOMBSTONE.
  ///
  /// Pass [JournalInterrupt.cancelled] and this verb ALSO writes the persistent
  /// tombstone: the bytes already on disk are kept and are never fed back to
  /// the engine on their own. The other three reasons
  /// ([JournalInterrupt.captureFault] / [JournalInterrupt.autoStopped] /
  /// [JournalInterrupt.authDrained]) stay RECOVERABLE — nobody threw those
  /// words away.
  ///
  /// ⚠️ THE DEFAULT IS `autoStopped`, WHICH IS NOT A NEUTRAL CHOICE. It exists
  /// so ptt_inbound.dart's `audio:auto-stopped` arm — the one call site card
  /// LS-4 was not allowed to edit — keeps the right reason without being
  /// touched. A future caller that forgets the argument gets a wrong-but-
  /// recoverable reason rather than a tombstone it did not ask for; the failure
  /// direction is deliberate (§5-4: fail toward retention, never toward loss).
  void fenceAndStop({String reason = JournalInterrupt.autoStopped}) {
    if (_state == RecorderState.stopped) return;
    _transition(RecorderState.stopped);
    // Card LS-4 — the tombstone, BEFORE the close. Both rides the spill's
    // journal queue, so ordering here is what puts `cancelled:true` on the
    // manifest the close then commits. On the legacy face it writes the marker
    // file that keeps `BackfillRunner` from ever listing these bytes again.
    if (reason == JournalInterrupt.cancelled) _journalTombstoneCancelled(this);
    // Card LS-2 — record WHY, and nothing else. The ring tail is still
    // discarded (SEG-2 §5-5, frozen); what changes is that a journal opened at
    // the first frame now closes carrying a NAMED reason instead of being
    // abandoned open. 🔴 The reason is not the tombstone — the line above is.
    _journalEndRecording(this, reason);
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
  ///
  /// 🔴 P1-1 (card LS-1b) — same `finally` as [stop], same reason: the
  /// retention hand-off must not be able to keep the microphone open. The
  /// `.catchError` on the queued tail is the second half — `unawaited` on a
  /// future that rejects is an unhandled async error, and this verb's whole
  /// job is to be the path that still works when everything else has failed.
  bool stopForLinkLoss() => stopKeepingTail(reason: JournalInterrupt.linkLoss);

  /// The body of verb ③, with the journal reason as a parameter.
  ///
  /// 🔴 EXTRACTED FOR DEFECT D-2 (round-four device drill, 2026-09-06) AND FOR
  /// EXACTLY ONE SECOND CALLER. The per-sitting ceiling has to be able to end a
  /// recording whose link died — that is the whole of D-2 — and the three verbs
  /// above answer the wrong questions for it: [stop] talks on a wire that is
  /// gone, [fenceAndStop] throws the tail away, and [stopForLinkLoss] would
  /// file the ending under 「the connection died」 twenty minutes after it did.
  ///
  /// ⚠️ WHAT IS PARAMETERISED IS THE WORD, NOT THE BEHAVIOUR. Both callers keep
  /// the tail, say nothing on the wire, and end in `stopped`; the only thing
  /// that differs is the name the manifest carries, which is precisely the
  /// thing a recovery pass reads. Anything else that starts to differ between
  /// the two belongs in a verb of its own.
  ///
  /// Callers (grep `stopKeepingTail`): [stopForLinkLoss] above, and
  /// `PttSession.stopForContinuousCap` (ptt/ptt_continuous.dart).
  bool stopKeepingTail({required String reason}) {
    if (_state == RecorderState.stopped) return false;
    try {
      takeResidualChunk();
      final RetainedAudioSpill? spill = _spill;
      final bool kept = spill != null && _ringBuffer.size > 0;
      if (spill != null) {
        spill.noteUplinkDown();
        unawaited(
          spill.retainTail(_ringBuffer.since(cutoffMs: -1)).catchError(
            (Object e) {
              debugPrint('[flowmic.audio] retainTail failed on link loss: $e');
            },
          ),
        );
      }
      return kept;
    } finally {
      // Card LS-2 — the link died: name it, so a recovery pass can tell this
      // apart from an ordinary stop without guessing from a timestamp.
      _journalEndRecording(this, reason);
      _transition(RecorderState.stopped);
      _accumulator.clear();
      unawaited(_detachRecorder());
    }
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
    // Card LS-2 — the stop tail. Hooked at the TAKER rather than at the three
    // stop verbs because the ordinary path's taker is the CALLER (pttUp emits
    // this ahead of audio:stop) while stopForLinkLoss calls it internally.
    _journalAppend(this, payload);
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
  /// 🔴 CARD LS-2 CHANGED THIS GUARD, AND THE CHANGE IS THE POINT OF THE CARD.
  /// The `spill.uplinkUp` early return is what made the storage face a
  /// function of the socket (E7). Under `retainFromFirstFrame` it does not
  /// apply: the bytes are already journalled, and what the stop path still
  /// needs is the COMMIT, which is what `retainTail` gives it there. Under the
  /// legacy face the guard stands unchanged.
  Future<void> retainUnsentTail() async {
    final RetainedAudioSpill? spill = _spill;
    if (spill == null) return;
    if (!spill.retainFromFirstFrame && spill.uplinkUp) return;
    await spill.retainTail(_ringBuffer.since(cutoffMs: -1));
  }

  /// Tear down stream controllers. Tests should call this in `tearDown` so the
  /// broadcast streams don't leak between cases.
  Future<void> dispose() async {
    _deadCaptureTimer?.cancel();
    _deadCaptureTimer = null;
    await _detachRecorder();
    await _faultsController.close();
    await _platformBytesController.close();
    await _chunksController.close();
    await _amplitudeController.close();
    await _stateController.close();
  }
}
