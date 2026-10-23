// SPEC-REF:
//   docs/decisions/2026-10-10-owner-rulings-renewal-longrec-billing-eu.md item 2
//     (owner chose A: leaving the app PAUSES a long recording, and the app says
//      so — a notice on return, a marked gap in the text, and the one-minute
//      reminder moved to after the return)
//   docs/strategy/2026-10-10-long-recording-app-switch-review.md §3 D1 / D3 / D5,
//     §4 plan A
//
// ── WHAT THIS IS ────────────────────────────────────────────────────────────
//
// The phone-local record of 「the user left FlowMic during a long recording and
// came back」. Nothing here goes on the wire: the away interval is a fact only
// this phone has (the relay sees `audio:pause` / `audio:resume`, but not the
// difference between a pause the user chose and one the platform imposed).
//
// It answers three questions at the return edge, and only there:
//   · how long was the recording paused (the notice and the gap marker);
//   · WHERE in the recording's audio that pause sits (the marker's place);
//   · what happened to the recording while the user was not looking — still
//     running, the one-minute reminder came due unseen (D5), or the ceiling
//     stopped it.
//
// ⚠️ IT OUTLIVES THE RECORDING ON PURPOSE. The ceiling can end a recording
// while the user is away (`PttSession.stopForContinuousCap` runs from a timer),
// and the return is the first moment anybody can be told. [begin] resets it;
// `ContinuousRecording.end` only stamps the end.

import 'package:flutter/foundation.dart';

/// What the recording did while the user was away.
enum ContinuousAwayOutcome {
  /// Still recording when the user came back.
  resumed,

  /// Still recording, and the one-minute reminder came due while away — so the
  /// user never saw it (D5). The return notice carries it instead.
  resumedNearCap,

  /// The ceiling stopped the recording while the user was away.
  stoppedAtCap,

  /// Something else ended the recording while away (a terminal engine error,
  /// a recorder fault). Those endings raise their own notices; this one only
  /// keeps the gap marker honest about how long nothing was recorded.
  endedOther,
}

/// One away-and-back, reported at the return edge.
@immutable
class ContinuousAwayReturn {
  const ContinuousAwayReturn({
    required this.ticket,
    required this.articleId,
    required this.atAudioMs,
    required this.notRecordedMs,
    required this.outcome,
  });

  /// A fresh number per return, so the banner reconciler can tell a new
  /// return from a still-standing one (same contract as
  /// `ContinuousCapTimer.warningTicket`).
  final int ticket;

  /// The recording the pause belongs to.
  final String articleId;

  /// Where the pause sits in the recording, in milliseconds of RECORDED AUDIO
  /// — the unit `TimelineEntry.articleOffsetMs` is in — not wall time.
  final int atAudioMs;

  /// How long nothing was recorded: from leaving until coming back, or until
  /// the recording ended if it ended while the user was away.
  final int notRecordedMs;

  final ContinuousAwayOutcome outcome;
}

/// The away log of the open long recording.
class ContinuousAway {
  ContinuousAway({DateTime Function()? now}) : _now = now ?? DateTime.now;

  DateTime Function() _now;

  /// Tests drive the clock; production reads the wall clock.
  @visibleForTesting
  set debugClock(DateTime Function() now) => _now = now;

  String? _articleId;
  DateTime? _startedAt;
  int _awayTotalMs = 0;
  DateTime? _leftAt;
  int _leftAtAudioMs = 0;
  bool _warnedWhileAway = false;
  DateTime? _endedAt;
  bool _endedAtCap = false;
  bool _capStopPending = false;
  int _ticket = 0;

  /// When the ceiling falls due (start + cap), or null when none was given.
  /// Clamps 「not recorded」: a frozen phone runs no timers, so the cap stop
  /// can land long after the deadline, and nothing was going to be recorded
  /// past it anyway (review F3).
  DateTime? _capDeadline;

  /// Where the latest return's absence began; read when an ending relabels
  /// that return's notice ([noteEnded]).
  DateTime? _lastLeftAt;

  /// The return notice standing right now, or null.
  ///
  /// 🔴 ITS OWN VALUE, NOT [lastReturn]. [lastReturn] is the fact of the
  /// return (the persisted gap reads it, once); this is what may be SAID about
  /// it, and that can change after the return: on Android 16 the network is
  /// cut 3-4 s after leaving and the relay keeps the session 30 s, so a longer
  /// absence ends the recording at the reconnect, AFTER `resumeCapture` has
  /// already said 「recording again」 — and a phone thawed past its ceiling
  /// can run the overdue cap stop after the resume edge. [noteEnded] then
  /// withdraws or relabels this, never the fact (review F1).
  ({int ticket, ContinuousAwayOutcome outcome, int notRecordedMs})? get notice =>
      _notice;
  ({int ticket, ContinuousAwayOutcome outcome, int notRecordedMs})? _notice;

  /// Non-zero while the return notice is standing (EVENT-type: the banner
  /// reconciler hides it after a few seconds through [dismissNotice]). Same
  /// ticket contract as `ContinuousCapTimer.warningTicket`. Zero for
  /// [ContinuousAwayOutcome.endedOther]: that ending raised its own notice.
  int get noticeTicket => _notice?.ticket ?? 0;

  void dismissNotice() => _notice = null;

  /// The latest return, or null before the first one. Listened to by the
  /// chat controller (notice + persisted gap).
  final ValueNotifier<ContinuousAwayReturn?> lastReturn =
      ValueNotifier<ContinuousAwayReturn?>(null);

  /// Is the user away from a long recording right now?
  bool get isAway => _leftAt != null;

  /// A long recording for [articleId] starts now.
  void begin(String articleId, {Duration? cap}) {
    _articleId = articleId;
    _notice = null;
    _lastLeftAt = null;
    _startedAt = _now();
    _capDeadline = cap == null ? null : _startedAt!.add(cap);
    _awayTotalMs = 0;
    _leftAt = null;
    _warnedWhileAway = false;
    _endedAt = null;
    _endedAtCap = false;
    _capStopPending = false;
  }

  /// The app left the foreground while the recording was capturing.
  void left() {
    final DateTime? start = _startedAt;
    if (_articleId == null || start == null || _endedAt != null || isAway) {
      return;
    }
    final DateTime at = _now();
    _leftAt = at;
    final int audio = at.difference(start).inMilliseconds - _awayTotalMs;
    _leftAtAudioMs = audio < 0 ? 0 : audio;
  }

  /// The one-minute reminder came due. Only remembered while away: in the
  /// foreground the reminder is on screen and needs no second telling.
  void noteWarning() {
    if (isAway) _warnedWhileAway = true;
  }

  /// The ceiling is about to stop the recording. Read by [noteEnded], which
  /// the stop reaches through `endContinuous` a few lines later.
  void noteCapStop() => _capStopPending = true;

  /// The recording ended (every exit runs `endContinuous`, which calls this).
  void noteEnded() {
    if (_articleId == null || _endedAt != null) return;
    _endedAt = _now();
    _endedAtCap = _capStopPending;
    _capStopPending = false;
    // F1 — a standing 「recording again」 is no longer true.
    final n = _notice;
    if (n == null ||
        (n.outcome != ContinuousAwayOutcome.resumed &&
            n.outcome != ContinuousAwayOutcome.resumedNearCap)) {
      return;
    }
    _notice = _endedAtCap && _lastLeftAt != null
        // The overdue ceiling: it is a stop at the cap that the user was away
        // for. The not-recorded span was already clamped to the deadline.
        ? (
            ticket: ++_ticket,
            outcome: ContinuousAwayOutcome.stoppedAtCap,
            notRecordedMs: n.notRecordedMs,
          )
        // Any other ending says its own sentence (the link-loss stop) —
        // withdrawn, so the queue's first-pushed-wins rule cannot hide it.
        : null;
  }

  /// The app came back. Returns the episode, or null when the user was not
  /// away from a long recording.
  ContinuousAwayReturn? returned() {
    final DateTime? leftAt = _leftAt;
    final String? id = _articleId;
    if (leftAt == null || id == null) return null;
    _leftAt = null;
    final DateTime back = _now();
    final DateTime? ended = _endedAt;
    DateTime until = ended != null && ended.isBefore(back) ? ended : back;
    final DateTime? deadline = _capDeadline;
    if (deadline != null && deadline.isBefore(until)) until = deadline; // F3
    _lastLeftAt = leftAt;
    final int away = until.difference(leftAt).inMilliseconds;
    final int notRecorded = away < 0 ? 0 : away;
    _awayTotalMs += back.difference(leftAt).inMilliseconds;
    final ContinuousAwayOutcome outcome = ended == null
        ? (_warnedWhileAway
              ? ContinuousAwayOutcome.resumedNearCap
              : ContinuousAwayOutcome.resumed)
        : (_endedAtCap
              ? ContinuousAwayOutcome.stoppedAtCap
              : ContinuousAwayOutcome.endedOther);
    _warnedWhileAway = false;
    final ContinuousAwayReturn r = ContinuousAwayReturn(
      ticket: ++_ticket,
      articleId: id,
      atAudioMs: _leftAtAudioMs,
      notRecordedMs: notRecorded,
      outcome: outcome,
    );
    _notice = outcome == ContinuousAwayOutcome.endedOther
        ? null
        : (ticket: r.ticket, outcome: outcome, notRecordedMs: notRecorded);
    if (!_disposed) lastReturn.value = r;
    return r;
  }

  bool _disposed = false;

  /// Idempotent: `ContinuousRecording.dispose` is (continuous_recording_test).
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    lastReturn.dispose();
  }
}
