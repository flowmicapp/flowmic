// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md
//     §A8 (the signal table — byte stall / digital silence / no-first-result /
//       no-progress are named as SEPARATE signals that must never collapse
//       into one sentence; the 「数字全零样本」row and its VAD note)
//     §A8-1 (`state_machine.dart:485-491` — the ASR leg's watchdog does not
//       cover translate/organize; that LLM leg has its own net in
//       `ai_compose_controller.dart:159/:234`)
//     §A9 stage 2 (「distance to 700 lines ⇒ new logic lives in a new file,
//       this file」; the row naming this module `asr_health.dart`)
//     §A10 card AW-1 (「预警分腿 + 门控（阈值走可配置）」— thresholds are
//       parameters, never bare literals; the render layer's job, not this
//       one, is to assert the wording)
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ─────────────────────────────────────
//
// A pure, clock-injected tracker of the ASR leg's health signals. Its ONE
// production caller is `session/chat_asr_health_wire.dart` (card AW-1b),
// which drives every input below off the real event sources
// (`AudioCapture.chunks`/`amplitudeDb`, `SttStream.interims`/`finals`,
// `state_machine.dart`'s two stt:error observation streams) — grep:
//   grep -n "h\.\(recordingStarted\|bytesArrived\|amplitudeObserved\|interimArrived\|finalArrived\|terminalError\|retryableError\|recordingEnded\|tick\)(" \
//     apps/mobile/lib/src/session/chat_asr_health_wire.dart
// That file's own header carries the matching evidence block for both
// directions (every input has a caller; every OUTPUT field has a consumer or
// is marked diag-only), which is what CLAUDE.md 反 façade ① asks for.
//
// ── SCOPE: ASR LEG ONLY ───────────────────────────────────────────────────
//
// This tracks realtime/translate/organize's SPEECH-TO-TEXT leg — capture →
// interim/final — and nothing past it. `state_machine.dart:485-491` already
// draws this boundary for the FSM's own PROCESSING watchdog: it covers
// exactly PTT-up → terminal `stt:final`, and deliberately does NOT cover the
// translate/organize LLM leg (that one has its own watchdog in
// `ai_compose_controller.dart:159/:234`). This module inherits the same
// boundary on purpose — a caller that wants LLM-leg health must build (or
// bind to) a second tracker, not overload this one. One value answering two
// questions is this repo's head-of-list bug shape (CLAUDE.md
// 「一个值只回答一个问题」).
//
// ── FOUR SIGNALS, NEVER COLLAPSED (§A8) ──────────────────────────────────
//
//   byteStall       — bytes WERE flowing from the platform recorder and then
//                      stopped: at least one delivery has landed for this
//                      recording, and none has landed inside the sliding
//                      window since. Distinct from silence: a live mic in a
//                      quiet room still delivers bytes, just quiet ones.
//                      TWO WATCHDOGS, TWO DIFFERENT FACTS — this one does
//                      NOT own "the recorder never opened / never produced a
//                      first byte". That fact belongs to `AudioCapture`'s own
//                      dead-capture watchdog (`audio/audio_capture.dart`,
//                      `kDeadCaptureAfter` / `_armDeadCaptureWatchdog`, which
//                      raises a capture fault when no platform byte has
//                      arrived since the recorder started). Before this gate
//                      existed, `byteStall` fired 1.5 s into EVERY recording
//                      — that window is the recorder warming up, not a stall,
//                      and reporting it as one is a state word that cannot
//                      answer the R11 question (CLAUDE.md).
//   digitalSilence  — bytes ARE arriving, but the samples inside them are
//                      all zero for a sustained span. §A8: 「全零」不是
//                      「没字节」— these are two different facts, and this
//                      module reports the fact only. It does NOT infer a
//                      cause (occupied mic / hardware mute / OS-level
//                      silence are all indistinguishable from here — P2-7).
//   noFirstResult   — recording has run past T1 (then T2, a second more
//                      severe level) with SOUND ACTIVITY having been
//                      observed, and no interim/final has landed yet.
//                      GATED ON SOUND ACTIVITY, NOT ON "some byte was not
//                      zero". A live microphone's noise floor makes almost
//                      every delivery nonzero, so a nonzero-byte gate is
//                      satisfied by an empty room — and a user who holds PTT
//                      and thinks for five seconds on a perfectly healthy
//                      path was told "still waiting for a transcription" and
//                      then escalated at T2. §A8's own推论 (「静音/VAD 无
//                      interim 不得报错」) only holds if the gate measures
//                      more than the noise floor, so the gate is
//                      [AsrHealthTracker.soundFloorDbfs] sustained for
//                      [AsrHealthTracker.soundActivityMinDuration], fed from
//                      the SAME dBFS meter the level bar already renders
//                      (`AudioCapture.amplitudeDb`).
//   noProgress      — independent of noFirstResult: the last interim is
//                      older than T3 while recording continues AND sound has
//                      been above the floor inside that same window. A
//                      session that got one interim and then stalled is a
//                      DIFFERENT failure from one that never got a first
//                      result, and needs a different sentence.
//
// 🔴 IT IS SOUND ACTIVITY, NOT VOICE ACTIVITY, AND THE NAME IS THE HONEST ONE.
// The gate is an RMS level over one 200 ms chunk compared against a floor:
// there is no speech model anywhere in this module, so a fan, a television,
// road noise or a slammed door held long enough all satisfy it, and this file
// used to call that 「voice activity」 while the sentences on screen said
// somebody was speaking.
//
// THAT IS ACCEPTED, and the reason is that the sentence stays true either
// way. What noFirstResult reports is 「sound is reaching the microphone and no
// transcription has come back」, which is exactly as true of a room with a
// television in it as of a person talking — the engine had audio and returned
// nothing, and that is worth saying. What the gate buys is the carve-out it
// was added for: a SILENT room produces no alert at all, so a user who holds
// PTT and thinks is never told anything. Claiming speech would be the part we
// cannot back (R11); claiming sound is measured, and it is what the copy now
// says in every locale.
//
// terminalErrorCode is surfaced IMMEDIATELY, not latched — this module is a
// read side, not the FSM; latching (so the FSM can consume it once, on
// PTT-up) is `state_machine.dart:535-551`'s job, unchanged by this file.
//
// retryableBounces counts `stt:error(retryable:true)` — never fatal, but a
// device trail should be able to say the engine bounced N times even if it
// eventually recovered and no terminal error ever arrived (P2-4's own
// diagnosis gap, mirrored here at the health layer).
//
// ── THRESHOLDS ARE PARAMETERS, NEVER LITERALS (AW-1's own DoD) ───────────
//
// The candidate windows below are quoted directly from §A8's row: 3–5 s for
// the first level of 「no first result」, 8–10 s for the second. 🔴 THESE ARE
// CANDIDATES, NOT CALIBRATED VALUES — §A8 says so explicitly ("这两个数字是
// 候选，不是定值"), and card T-6 is the one that calibrates them on a real
// device. The same warning applies with MORE force to [soundFloorDbfs]: a
// -45 dBFS floor is a guess at where a phone's noise floor ends and speech
// begins, and the true value differs per handset, per microphone and per
// room. It MUST be calibrated on a device (card T-6) before anyone quotes it
// as a product behaviour; until then it is a constructor argument, so
// calibrating it is not a code edit. Every comparison against a threshold in this file reads a
// constructor field; none is a bare literal, so calibration is a
// constructor-argument change, not a code edit.
//
// ── NO USER-VISIBLE STRINGS, NO SIDE EFFECTS ─────────────────────────────
//
// This module never renders a sentence and never stops capture or drives the
// FSM. §A8: 「没看屏幕也不许丢录音——预警只是告知，不得由预警触发自动停止
// 采集」. Wording belongs to `live_draft_tile.dart` (per the 0.2.53 render-
// result testing law); this module only classifies facts.

import 'dart:async';

import 'package:flutter/foundation.dart';

/// Escalation level for a threshold-gated signal. [none] means the signal has
/// not fired; [level1]/[level2] are the two severities §A8 asks for (the
/// first, milder prompt and the "still nothing" escalation).
enum AsrHealthLevel { none, level1, level2 }

/// A terminal `stt:error` fact, surfaced immediately (not latched — see file
/// header). [code]/[message] ride verbatim off the wire, mirroring
/// `SttError`/`onSttTerminalError`'s own fields so a future caller does not
/// need a second parse of the same frame.
@immutable
class AsrTerminalError {
  final String? code;
  final String? message;
  const AsrTerminalError({this.code, this.message});

  @override
  bool operator ==(Object other) =>
      other is AsrTerminalError && other.code == code && other.message == message;

  @override
  int get hashCode => Object.hash(code, message);
}

/// Immutable snapshot of every ASR-leg health signal at one instant. Each
/// field answers exactly one question (CLAUDE.md 「一个值只回答一个问题」);
/// none is derived from another inside this class, so a caller cannot
/// accidentally read one signal's answer as if it were another's.
@immutable
class AsrHealthSnapshot {
  /// True while recording is live, at least one platform byte has already
  /// arrived for this recording, and none has arrived inside the byte-stall
  /// window since. Distinct from [digitalSilence]; distinct also from "the
  /// recorder never opened", which is `AudioCapture`'s dead-capture
  /// watchdog's fact, not this one's (see the file header).
  final bool byteStall;

  /// True while bytes are arriving but the samples inside them have been all
  /// zero for the digital-silence window. A fact about content, not a cause
  /// (§A8 P2-7) — never true at the same instant as [byteStall], because
  /// byte stall means no bytes to inspect at all.
  final bool digitalSilence;

  /// Escalation level of "recording has run a while, sound has been reaching
  /// the microphone, and no interim/final yet". [AsrHealthLevel.none] before
  /// T1, [level1] from T1 to T2, [level2] from T2 on. Stays [none] the whole
  /// session if sound never rose above the floor (the quiet-room carve-out —
  /// see [AsrHealthTracker.soundFloorDbfs], and the file header on why this
  /// gate measures sound rather than speech).
  final AsrHealthLevel noFirstResult;

  /// True once the FIRST interim/final has landed and then more than the
  /// no-progress window has elapsed with recording still live and sound above
  /// the floor RECENTLY — inside that same window, not merely at some point in
  /// this recording. Independent of [noFirstResult]: a session that got one
  /// interim and then stalled is not "no first result".
  ///
  /// 🔴 RECENTLY, NOT EVER, AND THAT IS THE WHOLE OF THE FIX. It used to read
  /// a latch that never cleared inside a recording, so a person who spoke,
  /// got their interim, and then deliberately paused to think was told after
  /// six seconds that nothing new had come back — while the honest answer was
  /// that they had not said anything new. The engine cannot be behind on audio
  /// nobody gave it.
  final bool noProgress;

  /// The most recent terminal `stt:error`, or null if none has arrived since
  /// the last [AsrHealthTracker.recordingStarted]/[AsrHealthTracker.recordingEnded].
  /// Immediate, never latched (file header).
  final AsrTerminalError? terminalError;

  /// Count of `stt:error(retryable:true)` bounces observed since the last
  /// [AsrHealthTracker.recordingStarted]. Never fatal on its own.
  ///
  /// DIAG-ONLY, by decision and not by omission. There is no honest
  /// user-facing sentence for "the engine bounced N times and then
  /// recovered": the utterance may still finish fine, the number means
  /// nothing to the person holding the phone, and a count on screen with no
  /// action attached to it is the 「一个改变不了任何东西的控件」 shape. Its
  /// ONE consumer is the device trail (`diag('asr.health.retryable_bounce',
  /// ...)` in `chat_asr_health_wire.dart`); `live_health_copy.dart`
  /// deliberately has no branch for it, and nothing in the UI reads it.
  final int retryableBounces;

  const AsrHealthSnapshot({
    this.byteStall = false,
    this.digitalSilence = false,
    this.noFirstResult = AsrHealthLevel.none,
    this.noProgress = false,
    this.terminalError,
    this.retryableBounces = 0,
  });

  static const AsrHealthSnapshot clear = AsrHealthSnapshot();

  AsrHealthSnapshot copyWith({
    bool? byteStall,
    bool? digitalSilence,
    AsrHealthLevel? noFirstResult,
    bool? noProgress,
    AsrTerminalError? terminalError,
    bool clearTerminalError = false,
    int? retryableBounces,
  }) {
    return AsrHealthSnapshot(
      byteStall: byteStall ?? this.byteStall,
      digitalSilence: digitalSilence ?? this.digitalSilence,
      noFirstResult: noFirstResult ?? this.noFirstResult,
      noProgress: noProgress ?? this.noProgress,
      terminalError:
          clearTerminalError ? null : (terminalError ?? this.terminalError),
      retryableBounces: retryableBounces ?? this.retryableBounces,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is AsrHealthSnapshot &&
      other.byteStall == byteStall &&
      other.digitalSilence == digitalSilence &&
      other.noFirstResult == noFirstResult &&
      other.noProgress == noProgress &&
      other.terminalError == terminalError &&
      other.retryableBounces == retryableBounces;

  @override
  int get hashCode => Object.hash(
        byteStall,
        digitalSilence,
        noFirstResult,
        noProgress,
        terminalError,
        retryableBounces,
      );

  @override
  String toString() =>
      'AsrHealthSnapshot(byteStall: $byteStall, digitalSilence: $digitalSilence, '
      'noFirstResult: $noFirstResult, noProgress: $noProgress, '
      'terminalError: $terminalError, retryableBounces: $retryableBounces)';
}

/// Pure, clock-injected ASR-leg health tracker (card AW-1). No production
/// wiring lives here — see the file header. A future caller (AW-1b) drives
/// [recordingStarted]/[bytesArrived]/[interimArrived]/[finalArrived]/
/// [terminalError]/[retryableError]/[recordingEnded] off the real event
/// sources and calls [tick] on a timer (or before reading [value]) so
/// threshold-based signals age even between events.
///
/// Exposed as a [ValueListenable] to match the
/// `ValueNotifier<BackfillProgress>` at `session/backfill_runner.dart:273` —
/// a future UI binds to both the same way.
class AsrHealthTracker implements ValueListenable<AsrHealthSnapshot> {
  /// Sliding window (§A8 "新增滑动窗"): recording is live and this many ms
  /// have passed with no platform byte (zero or nonzero) arriving.
  final Duration byteStallWindow;

  /// Sustained span of all-zero-sample chunks before [digitalSilence] fires.
  final Duration digitalSilenceWindow;

  /// First "no result yet" escalation (§A8 candidate: 3–5 s). CANDIDATE, not
  /// calibrated — see file header; card T-6 calibrates this on device.
  final Duration noFirstResultT1;

  /// Second, more severe "still no result" escalation (§A8 candidate: 8–10
  /// s). Must be >= [noFirstResultT1]; enforced in the constructor.
  final Duration noFirstResultT2;

  /// No-progress window: how stale the last interim may get, while recording
  /// continues and sound has been above the floor inside this same window,
  /// before [AsrHealthSnapshot.noProgress] fires. One window, both roles:
  /// asking for recent sound over a DIFFERENT span would be a second
  /// threshold nobody could calibrate against the first.
  final Duration noProgressWindow;

  /// Sound-activity floor in dBFS, read off the SAME meter the level bar
  /// renders (`AudioCapture.amplitudeDb`, RMS over one chunk, clamped to
  /// [-100, 0]). A chunk at or above this level counts as evidence that SOUND
  /// is reaching the microphone; below it counts as room tone.
  ///
  /// ⚠️ IT IS A LEVEL, NOT A VOICE DETECTOR. A fan, a television or traffic
  /// clears it just as a person does — see the file header for why that is
  /// accepted and why the sentences on screen say 「sound」.
  ///
  /// CANDIDATE, NOT CALIBRATED (card T-6, and the file header says so at
  /// length): -45 dBFS is a guess. It must be measured on a real handset
  /// before anyone treats it as a product behaviour. Nothing in this file
  /// compares against a literal, so calibrating it is a constructor argument
  /// change.
  final double soundFloorDbfs;

  /// How long the amplitude must stay at or above [soundFloorDbfs] before it
  /// counts as sound activity. A single loud chunk is a door slam, not a room
  /// with something happening in it; requiring a sustained span is what keeps
  /// one transient from unlocking [AsrHealthSnapshot.noFirstResult] in an
  /// otherwise silent room. Also a candidate, also calibrated by T-6.
  final Duration soundActivityMinDuration;

  AsrHealthTracker({
    this.byteStallWindow = const Duration(milliseconds: 1500),
    this.digitalSilenceWindow = const Duration(milliseconds: 3000),
    this.noFirstResultT1 = const Duration(milliseconds: 4000),
    this.noFirstResultT2 = const Duration(milliseconds: 9000),
    this.noProgressWindow = const Duration(milliseconds: 6000),
    this.soundFloorDbfs = -45.0,
    this.soundActivityMinDuration = const Duration(milliseconds: 300),
  }) : assert(
          noFirstResultT2 >= noFirstResultT1,
          'noFirstResultT2 must be >= noFirstResultT1 (T2 is the escalation '
          'of T1, not an unrelated window)',
        ) {
    _controller = ValueNotifier<AsrHealthSnapshot>(AsrHealthSnapshot.clear);
  }

  late final ValueNotifier<AsrHealthSnapshot> _controller;

  @override
  AsrHealthSnapshot get value => _controller.value;

  /// [Stream] form for a caller that prefers listening over polling
  /// [value]. Backed by the same [ValueNotifier], so every emission here is
  /// also visible via [value] and [addListener].
  Stream<AsrHealthSnapshot> get stream => _asStream();

  Stream<AsrHealthSnapshot> _asStream() {
    late final void Function() listener;
    late final StreamController<AsrHealthSnapshot> ctl;
    ctl = StreamController<AsrHealthSnapshot>.broadcast(
      onCancel: () => _controller.removeListener(listener),
    );
    listener = () => ctl.add(_controller.value);
    _controller.addListener(listener);
    return ctl.stream;
  }

  @override
  void addListener(VoidCallback listener) => _controller.addListener(listener);

  @override
  void removeListener(VoidCallback listener) =>
      _controller.removeListener(listener);

  // ------------------------------------------------------------- state

  bool _recording = false;
  int? _recordingStartedAtMs;
  int? _lastByteAtMs;
  int? _digitalSilenceSinceMs;
  int? _lastInterimOrFinalAtMs;
  // Sound-activity evidence, in three parts because two different questions
  // are asked of it:
  //   · the timestamp the amplitude first went at/above `soundFloorDbfs` in
  //     the current above-floor run (null while below it);
  //   · a LATCH that flips once such a run lasted `soundActivityMinDuration`
  //     and never clears inside a recording. noFirstResult wants exactly
  //     that: "something was making noise at second 2" stays true at second 9,
  //     because the engine has owed us a first result ever since;
  //   · the LAST INSTANT that condition held. noProgress wants this one
  //     instead — a deliberate pause is not the engine falling behind, and
  //     reading the latch made every pause past the window look like one.
  int? _aboveFloorSinceMs;
  bool _sawSoundActivity = false;
  int? _lastSoundActivityAtMs;

  void _emit(AsrHealthSnapshot next) {
    if (_controller.value == next) return;
    _controller.value = next;
  }

  // ------------------------------------------------------------- inputs

  /// A fresh recording began. Clears every signal — a stale fault from the
  /// PREVIOUS utterance must never bleed into this one (mirrors the FSM's own
  /// rule for `onSttTerminalError`'s latch: "Every other exit from RECORDING
  /// … clears the latch, so it can never leak across utterances").
  void recordingStarted(int nowMs) {
    _recording = true;
    _recordingStartedAtMs = nowMs;
    _lastByteAtMs = null;
    _digitalSilenceSinceMs = null;
    _lastInterimOrFinalAtMs = null;
    _aboveFloorSinceMs = null;
    _sawSoundActivity = false;
    _lastSoundActivityAtMs = null;
    _emit(AsrHealthSnapshot.clear);
  }

  /// The platform recorder delivered [byteCount] bytes (mirrors
  /// `AudioCapture._onPcm`'s counting-before-the-state-gate stance — this
  /// tracker only cares that bytes arrived, not which FSM state owns them).
  /// [allZero] is the digital-silence content check (§A8 P2-7): true when
  /// every PCM sample in this delivery decoded to zero.
  void bytesArrived(int nowMs, int byteCount, {required bool allZero}) {
    if (byteCount <= 0) return;
    _lastByteAtMs = nowMs;
    if (!allZero) {
      _digitalSilenceSinceMs = null;
    } else {
      _digitalSilenceSinceMs ??= nowMs;
    }
    _recompute(nowMs);
  }

  /// The platform recorder handed us [byteCount] raw bytes — the delivery
  /// itself, before it is sliced into chunks and before the state gate
  /// (`AudioCapture.platformBytes`).
  ///
  /// 🔴 THIS, NOT [bytesArrived], IS WHAT MAKES [AsrHealthSnapshot.byteStall]
  /// ANSWERABLE. `bytesArrived` is fed from `AudioCapture.chunks`, and a chunk
  /// is 200 ms of audio: a recorder that delivers 64 bytes and then stops
  /// never completes one, so the tracker never saw a first byte, `byteStall`
  /// stayed false for want of one, and `AudioCapture`'s own dead-capture
  /// watchdog had already stood down because it is one-shot on
  /// `_platformBytes > 0`. Between the two the tile said 「Transcribing」 for
  /// the whole recording and nothing on the device contradicted it.
  ///
  /// [bytesArrived] still marks a byte arrival too — a chunk IS bytes — but it
  /// can no longer be the only source of one.
  void platformBytesArrived(int nowMs, int byteCount) {
    if (byteCount <= 0) return;
    _lastByteAtMs = nowMs;
    _recompute(nowMs);
  }

  /// One amplitude reading off `AudioCapture.amplitudeDb` (dBFS, RMS over
  /// one chunk). This is the ONLY input that can produce sound-activity
  /// evidence; [bytesArrived] deliberately cannot, because a nonzero byte is
  /// only the noise floor (see the file header's noFirstResult row).
  void amplitudeObserved(int nowMs, double dbfs) {
    if (!_recording) return;
    if (dbfs >= soundFloorDbfs) {
      _aboveFloorSinceMs ??= nowMs;
      if ((nowMs - _aboveFloorSinceMs!) >=
          soundActivityMinDuration.inMilliseconds) {
        _sawSoundActivity = true;
        _lastSoundActivityAtMs = nowMs;
      }
    } else {
      _aboveFloorSinceMs = null;
    }
    _recompute(nowMs);
  }

  /// An `stt:interim` landed for this utterance.
  void interimArrived(int nowMs) {
    _lastInterimOrFinalAtMs = nowMs;
    _recompute(nowMs);
  }

  /// An `stt:final` landed. [isTerminal] mirrors `SttFinal.isSegment ==
  /// false` — a soft-segment final still counts as progress and as a first
  /// result, exactly like an interim; only the terminal one additionally
  /// closes the utterance, which this tracker leaves to
  /// `recordingEnded`/`SessionState` to decide, not to itself.
  void finalArrived(int nowMs, bool isTerminal) {
    _lastInterimOrFinalAtMs = nowMs;
    _recompute(nowMs);
  }

  /// `stt:error(retryable:false)` — mirrors `onSttTerminalError`'s trigger,
  /// but this is a plain read: it does not latch, does not gate on FSM
  /// session state, and never clears itself except via [recordingStarted]/
  /// [recordingEnded]. Immediate visibility even while still recording (§A8:
  /// 「立刻显露」).
  void terminalError(int nowMs, {String? code, String? message}) {
    _emit(_controller.value.copyWith(
      terminalError: AsrTerminalError(code: code, message: message),
    ));
  }

  /// `stt:error(retryable:true)` — mirrors the P2-4 bounce the FSM leaves
  /// unlatched; this tracker counts it so a device trail keeps a number even
  /// when the engine eventually recovers and no terminal error ever fires.
  /// Never sets [AsrHealthSnapshot.terminalError] — a bounce is not fatal.
  void retryableError(int nowMs, {String? code, String? message}) {
    _emit(_controller.value.copyWith(
      retryableBounces: _controller.value.retryableBounces + 1,
    ));
  }

  /// The utterance ended (normal close, cancel, or capture-dead). Clears
  /// every signal — an ended recording cannot still be byte-stalled.
  void recordingEnded(int nowMs) {
    _recording = false;
    _recordingStartedAtMs = null;
    _lastByteAtMs = null;
    _digitalSilenceSinceMs = null;
    _lastInterimOrFinalAtMs = null;
    _aboveFloorSinceMs = null;
    _sawSoundActivity = false;
    _lastSoundActivityAtMs = null;
    _emit(AsrHealthSnapshot.clear);
  }

  /// Ages the threshold-gated signals forward even when no new event has
  /// arrived — a caller on a periodic timer (or immediately before reading
  /// [value]) should call this so "no bytes for 5 minutes" is discoverable
  /// without waiting for the next byte that never comes.
  void tick(int nowMs) => _recompute(nowMs);

  // ------------------------------------------------------------- derive

  void _recompute(int nowMs) {
    if (!_recording || _recordingStartedAtMs == null) return;
    final int startedAt = _recordingStartedAtMs!;

    // byteStall = recording is live, at least one PLATFORM byte has arrived
    // for it, and none has arrived inside the window since.
    //
    // Bytes must have FLOWED before they can STOP. With no first byte yet this
    // is the recorder warming up, and the fact belongs to `AudioCapture`'s
    // dead-capture watchdog, not here (file header). What changed with
    // [platformBytesArrived] is WHICH byte counts as the first: a delivery,
    // not a completed 200 ms chunk. A trickle below the chunk boundary used to
    // satisfy the dead-capture watchdog and reach this tracker never, so
    // neither watchdog spoke.
    final bool byteStall = _lastByteAtMs != null &&
        (nowMs - _lastByteAtMs!) >= byteStallWindow.inMilliseconds;

    final bool digitalSilence = !byteStall &&
        _digitalSilenceSinceMs != null &&
        (nowMs - _digitalSilenceSinceMs!) >= digitalSilenceWindow.inMilliseconds;

    // noFirstResult: gated on SOUND ACTIVITY (the quiet-room carve-out —
    // §A8's own推论). A recording nobody has spoken into yet has nothing to
    // transcribe, so "still waiting for a transcription" would be a claim
    // this tracker cannot back.
    AsrHealthLevel noFirstResult = AsrHealthLevel.none;
    if (_sawSoundActivity && _lastInterimOrFinalAtMs == null) {
      final int elapsed = nowMs - startedAt;
      if (elapsed >= noFirstResultT2.inMilliseconds) {
        noFirstResult = AsrHealthLevel.level2;
      } else if (elapsed >= noFirstResultT1.inMilliseconds) {
        noFirstResult = AsrHealthLevel.level1;
      }
    }

    // noProgress: independent of noFirstResult — only evaluated once a
    // first interim/final has already landed, and only while sound is STILL
    // arriving. The recency test is the fix: a latch ("something made a noise
    // earlier in this recording") is true for the rest of the recording, so a
    // person who spoke, got their interim and then paused to think was told
    // six seconds later that nothing new had come back. Nothing new had been
    // SAID; the engine cannot fall behind on audio it was never given.
    final int? soundAt = _lastSoundActivityAtMs;
    final bool soundRecently = soundAt != null &&
        (nowMs - soundAt) <= noProgressWindow.inMilliseconds;
    final bool noProgress = _lastInterimOrFinalAtMs != null &&
        soundRecently &&
        (nowMs - _lastInterimOrFinalAtMs!) >= noProgressWindow.inMilliseconds;

    _emit(_controller.value.copyWith(
      byteStall: byteStall,
      digitalSilence: digitalSilence,
      noFirstResult: noFirstResult,
      noProgress: noProgress,
    ));
  }

  void dispose() => _controller.dispose();
}
