// Part of chat_controller.dart — AW-1b, wiring `AsrHealthTracker`
// (asr_health.dart) onto the real ASR-leg event sources.
//
// ── WHY THIS SPLIT ────────────────────────────────────────────────────────
// chat_controller.dart sits at the 800-line cap (verify/lint/file-size.mjs
// SRC_MAX), so this card's wiring cannot live in the constructor body
// beyond one delegating call (`wireAsrHealth(this);`). Same practice as
// every part file before it: take the whole coherent unit out, comments and
// all, rather than compress the reasoning to make room. The same pressure is
// why every handle this file opens lives on ONE field
// (`ChatController._asrHealthHooks`, a [_AsrHealthHooks] declared below)
// instead of eight fields on the pinned file.
//
// ── WHY EVERY SUBSCRIPTION HERE IS A *NEW*, INDEPENDENT LISTENER ─────────
// `ChatController`'s own routers (`_finalSub`, `_interimSub`, `_fsmSub`,
// `_amplitudeSub`, …) already listen on `session.stt.finals` / `.interims` /
// `session.audio.amplitudeDb` / `session.fsm.changes` for their own reasons.
// This file does NOT hook into those routers' bodies: every stream involved
// (`SttStream.finals`/`.interims`, `AudioCapture.chunks`/`.amplitudeDb`,
// `FlowmicStateMachine.changes`/`.sttErrorImmediate`/`.sttRetryableErrors`) is
// declared `.broadcast()`, so adding a second listener changes nothing about
// the pre-existing behaviour — this file is purely an observer, exactly the
// posture asr_health.dart's own header demands ("read-only observation …
// never drives the FSM"). Reusing an existing handler body would have
// required editing `chat_ptt_lifecycle.dart` / `chat_outbox_host.dart`, files
// the AW-1b card's own boundary does not need to touch.
//
// ── WHAT THIS FILE READS OFF `AudioCapture`, AND THE ONE THING IT ASKED FOR ─
// It reads the already-public `AudioCapture.chunks` stream,
// `CapturedChunk.payload`, and the `AudioCapture.amplitudeDb` dBFS meter,
// exactly the way `chat_controller.dart`'s constructor already reads
// `session.audio.amplitudeDb` and `session.audio.retainedAudio`.
//
// 🔴 ONE FIELD WAS ADDED THERE, AND ONLY BECAUSE NOTHING EXISTING COULD ANSWER
// THE QUESTION. `AudioCapture.platformBytes` (a count per raw PCM delivery)
// was added because `chunks` cannot say 「bytes are still arriving」: a chunk is
// 200 ms of audio, so a recorder trickling 64 bytes and then stopping produces
// none at all. An earlier revision of this header said 「nothing under
// `lib/src/audio/` is edited」, which was true and was also the reason
// `byteStall` could not fire on the one failure it exists for.
//
// 🔴 THE AMPLITUDE FEED IS NOT DECORATION — it is the sound-activity gate.
// `AsrHealthTracker` used to unlock "no first result" on any nonzero byte,
// which a live microphone's noise floor satisfies in an empty room, so a user
// who held PTT and thought for five seconds got an alert on a healthy path.
// The gate is now amplitude at/above `soundFloorDbfs` sustained for
// `soundActivityMinDuration`, and `amplitudeObserved` below is its ONLY
// source. Both thresholds are constructor parameters and BOTH ARE
// UNCALIBRATED CANDIDATES (card T-6 measures them on a device).
//
// ── WHY `state_machine.dart` GREW TWO STREAMS INSTEAD OF `ptt_session.dart` ──
// `ptt_session.dart` sits EXACTLY on the 800-line cap (no headroom at all),
// while `state_machine.dart` — where `onSttTerminalError` already lives —
// had room. `sttErrorImmediate`/`sttRetryableErrors` are exposed straight off
// `FlowmicStateMachine`, reached here as `session.fsm.sttErrorImmediate` /
// `session.fsm.sttRetryableErrors` — `session.fsm` is already public (the
// constructor's own `_fsmSub = session.fsm.changes.listen(_onFsmChange);`
// proves it), so no new getter on `PttSession` was needed either.
//
// 🔴 ANTI-FAÇADE EVIDENCE — BOTH DIRECTIONS (CLAUDE.md 反 façade ①). The
// input half alone is half an argument: a tracker can be perfectly fed and
// still compute fields nobody reads, which is the same "capability nobody
// calls" shape read from the other end.
//
//   INPUTS — every tracker method has exactly one production caller, here:
//     grep -n "h\.\(recordingStarted\|bytesArrived\|platformBytesArrived\|amplitudeObserved\|interimArrived\|finalArrived\|terminalError\|retryableError\|recordingEnded\|tick\)(" \
//       apps/mobile/lib/src/session/chat_asr_health_wire.dart
//     → ten call sites below, each inside exactly one `.listen`/
//       `Timer.periodic` closure, none duplicated elsewhere in `lib/`.
//
//   OUTPUTS — every field of `AsrHealthSnapshot` has exactly one consumer,
//   or is explicitly diag-only:
//     byteStall        → `liveHealthNote` (ui/live_health_copy.dart), one
//                        branch, one sentence.
//     digitalSilence   → `liveHealthNote`, its own branch and its own
//                        sentence (it used to be computed and never shown).
//     noFirstResult    → `liveHealthNote`, two branches (level2, level1).
//     noProgress       → `liveHealthNote`, one branch.
//     terminalError    → `liveHealthNote`, which reuses
//                        `AppStrings.sttStallBannerMessage`.
//     retryableBounces → DIAG-ONLY, deliberately: `diag(
//                        'asr.health.retryable_bounce', …)` below is its one
//                        consumer, and nothing in the UI reads it. There is
//                        no honest sentence for "the engine bounced N times
//                        and recovered" (asr_health.dart says why at the
//                        field), and a number on screen with no action
//                        attached is the 「一个改变不了任何东西的控件」 shape.
//     grep -n "snapshot\." apps/mobile/lib/src/ui/live_health_copy.dart
//       → byteStall, digitalSilence, noFirstResult (×2), noProgress,
//         terminalError; that is the whole snapshot minus retryableBounces.

part of 'chat_controller.dart';

// `clock.now()`, not raw `DateTime.now()` — identical in production (the
// default `Clock` delegates straight to `DateTime.now()`), but it lets this
// file's wiring test drive the tracker's own thresholds with
// `package:fake_async`'s virtual clock instead of waiting on real wall time.
int _asrHealthNowMs() => clock.now().millisecondsSinceEpoch;

/// Every handle `wireAsrHealth` opens, on one object, so `ChatController`
/// carries ONE field for this card instead of eight (that file is at the
/// 800-line cap; see this file's header).
///
/// [trackerListener] is stored rather than passed anonymously for a reason
/// that already bit once: `disposeRouted` called
/// `asrHealth.removeListener(c.notifyUi)` while the registration here was an
/// anonymous closure, so the removal matched nothing and quietly did nothing.
/// A listener you cannot name is a listener you cannot remove.
class _AsrHealthHooks {
  StreamSubscription<FlowmicStateSnapshot>? fsmSub;
  StreamSubscription<CapturedChunk>? chunksSub;
  StreamSubscription<int>? platformBytesSub;
  StreamSubscription<double>? amplitudeSub;
  StreamSubscription<SttInterim>? interimSub;
  StreamSubscription<SttFinal>? finalSub;
  StreamSubscription<SttStall>? terminalErrorSub;
  StreamSubscription<SttStall>? retryableSub;
  Timer? ticker;
  VoidCallback? trackerListener;

  /// Releases everything this card opened. Does NOT dispose the tracker
  /// itself — that stays `disposeRouted`'s call, next to every other
  /// `dispose()` it owns.
  Future<void> release(AsrHealthTracker tracker) async {
    await fsmSub?.cancel();
    await chunksSub?.cancel();
    await platformBytesSub?.cancel();
    await amplitudeSub?.cancel();
    await interimSub?.cancel();
    await finalSub?.cancel();
    await terminalErrorSub?.cancel();
    await retryableSub?.cancel();
    ticker?.cancel();
    ticker = null;
    final VoidCallback? l = trackerListener;
    if (l != null) tracker.removeListener(l);
    trackerListener = null;
  }
}

/// Wires [ChatController.asrHealth] onto the production event sources named
/// in asr_health.dart's own header. Called once, at the end of
/// [ChatController]'s constructor; everything it opens is released in
/// `disposeRouted` (chat_transient_banner_timers.dart).
void wireAsrHealth(ChatController c) {
  final AsrHealthTracker h = c.asrHealth;
  final _AsrHealthHooks hooks = _AsrHealthHooks();
  c._asrHealthHooks = hooks;

  // ── recording start/end + the ticker that ages threshold signals ───────
  // `SessionState.recording` only — the boundary asr_health.dart's header
  // draws for byte-level signals (byteStall/digitalSilence only make sense
  // while the mic is actually open); PROCESSING is out of scope by the same
  // "ASR leg only" fence that keeps this module off the LLM leg.
  SessionState prevSess = c.session.fsm.session;
  // AW-1b (b) — "one differentiated haptic on the FIRST transition into any
  // non-normal state per recording": a flag reset on every recordingStarted,
  // so a recording that goes bad twice (e.g. noProgress clears then fires
  // again) still buzzes only once, and a fresh recording always gets its own
  // first warning even if the previous one ended mid-fault.
  bool warnedThisRecording = false;
  hooks.fsmSub = c.session.fsm.changes.listen((FlowmicStateSnapshot s) {
    final int nowMs = _asrHealthNowMs();
    final bool wasRecording = prevSess == SessionState.recording;
    final bool isRecording = s.session == SessionState.recording;
    if (!wasRecording && isRecording) {
      h.recordingStarted(nowMs);
      warnedThisRecording = false;
      hooks.ticker?.cancel();
      // 500ms: well under every threshold in asr_health.dart's constructor
      // (the shortest, byteStallWindow, defaults to 1500ms), so no signal can
      // go stale by more than one tick.
      hooks.ticker = Timer.periodic(
        const Duration(milliseconds: 500),
        (_) => h.tick(_asrHealthNowMs()),
      );
    } else if (wasRecording && !isRecording) {
      h.recordingEnded(nowMs);
      hooks.ticker?.cancel();
      hooks.ticker = null;
    }
    prevSess = s.session;
  });

  // ── bytes: AudioCapture.chunks, read-only (see file header) ─────────────
  hooks.chunksSub = c.session.audio.chunks.listen((CapturedChunk chunk) {
    final Uint8List payload = chunk.payload;
    bool allZero = true;
    for (int i = 0; i < payload.length; i++) {
      if (payload[i] != 0) {
        allZero = false;
        break;
      }
    }
    h.bytesArrived(_asrHealthNowMs(), payload.length, allZero: allZero);
  });

  // ── raw platform deliveries: the ONLY feed a SUB-CHUNK trickle can reach
  //    (`AudioCapture.platformBytes`, counts only). `chunks` above still marks
  //    byte arrivals, but it could not be the only one: 64 bytes then silence
  //    completes no 200 ms chunk, so `byteStall` had no first byte to stall
  //    from — while `AudioCapture`'s dead-capture watchdog had already stood
  //    down, because it is one-shot on `_platformBytes > 0`. Two watchdogs,
  //    and the gap between them was a whole recording of 「Transcribing」.
  //    Read-only, like every other subscription in this file.
  hooks.platformBytesSub =
      c.session.audio.platformBytes.listen((int byteCount) {
    h.platformBytesArrived(_asrHealthNowMs(), byteCount);
  });

  // ── amplitude: the sound-activity gate's ONLY source (file header) ──────
  // Same meter, same cadence (one reading per chunk) as the level bar the
  // recording panel already draws — not a second measurement of loudness
  // invented here, which would be two answers to one question.
  hooks.amplitudeSub = c.session.audio.amplitudeDb.listen((double dbfs) {
    h.amplitudeObserved(_asrHealthNowMs(), dbfs);
  });

  // ── interim/final: SttStream, the same typed streams ChatController's own
  //    router already listens on (a second, independent listener) ─────────
  hooks.interimSub = c.session.stt.interims.listen((SttInterim i) {
    h.interimArrived(_asrHealthNowMs());
  });
  hooks.finalSub = c.session.stt.finals.listen((SttFinal f) {
    h.finalArrived(_asrHealthNowMs(), !f.isSegment);
  });

  // ── terminal / retryable stt:error — state_machine.dart's two AW-1b
  //    observation streams (see file header for why they live there) ──────
  hooks.terminalErrorSub =
      c.session.fsm.sttErrorImmediate.listen((SttStall s) {
    h.terminalError(_asrHealthNowMs(), code: s.code, message: s.message);
  });
  hooks.retryableSub = c.session.fsm.sttRetryableErrors.listen((SttStall s) {
    h.retryableError(_asrHealthNowMs(), code: s.code, message: s.message);
    // The bounce counter's ONE consumer (file header, OUTPUTS): a device
    // trail, never a sentence. `code` only — `message` can carry engine
    // prose, and diag_log.dart's own rule is scalars and fixed names.
    diag('asr.health.retryable_bounce', <String, Object?>{
      'code': s.code,
      'count': h.value.retryableBounces,
    });
  });

  // ── surfacing: the live draft row reads `c.asrHealth.value` at build time
  //    (live_health_copy.dart), so this screen must repaint on every change.
  //    Same posture as the constructor's `session.pcBusyListenable
  //    .addListener(notifyUi)` two lines up in chat_controller.dart — a
  //    second notifier, one more listener, no new rebuild mechanism invented.
  //
  // The SAME listener also carries the haptic gate: it needs the tracker's
  // OWN notion of "changed", not a second poller, so the first tick that
  // pushes a snapshot from normal into any non-normal shape sees it here,
  // once. It is STORED (not anonymous) so `release` can actually remove it.
  void onHealthChanged() {
    final AsrHealthSnapshot v = h.value;
    final bool nonNormal = v.byteStall ||
        v.digitalSilence ||
        v.noFirstResult != AsrHealthLevel.none ||
        v.noProgress ||
        v.terminalError != null;
    if (nonNormal && !warnedThisRecording) {
      warnedThisRecording = true;
      unawaited(_fireAsrHealthHaptic());
    }
    c.notifyUi();
  }

  hooks.trackerListener = onHealthChanged;
  h.addListener(onHealthChanged);
}

/// [FlowMicHaptics.asrHealthWarning] is a `flutter/services.dart`
/// MethodChannel call, which throws when no Flutter binding exists — true of
/// every plain `test()` (not `testWidgets`) that drives a real ChatController
/// through a terminal/retryable stt:error, which is most of
/// chat_controller_test.dart. The nudge is a nice-to-have, never a
/// correctness signal (the label change on the live draft row is the thing
/// that actually carries the fact), so a missing channel must swallow here
/// rather than crash a caller that has nothing to do with haptics.
Future<void> _fireAsrHealthHaptic() async {
  try {
    await FlowMicHaptics.asrHealthWarning();
  } catch (_) {
    // See doc comment above.
  }
}
