// Card RC-1a / RC-1b - THE JOURNAL LEG'S PRIVATE VALUE TYPES.
//
// A `part` of recovery_journal_leg.dart, split out for the audit's 700-line
// discipline (A9) when card RC-1b added `runOne`. The cut is where this tree
// already puts it, and recovery_leg_policy.dart's header states the rule
// verbatim: everything here is a VALUE, and nothing here does anything.
//
// MOVED, NOT REWRITTEN. Every class below is byte-for-byte what stood at the
// bottom of recovery_journal_leg.dart, and they stay PRIVATE - a `part` shares
// the library, so no name became visible to anyone new.

part of 'recovery_journal_leg.dart';

/// How one attempt ended, from the sweep's point of view.
///
/// IT REPLACED A `bool`, AND THE REASON IS CARD RC-1b: the sweep only ever
/// needed "keep going or stop", but the user-facing entry point needs to tell
/// "a press is holding the microphone" apart from "the attempt ran and did not
/// land" - two facts that a bool answered with the same `false`, and that lead
/// to opposite sentences on screen.
/// [recordingGone] — the user deleted this recording while the step was in
/// flight (owner ruling O-5, card RC-1b's screen). It is NOT [completed]: no
/// attempt reached a terminal outcome, and calling it done would put
/// [PendingRetryOutcome.done] on a press that transcribed nothing. It is also
/// not a failure, so it must not stop a sweep — there is simply nothing left
/// to work on.
enum _StepOutcome { completed, refusedByGate, linkLost, recordingGone }

@immutable
class _Candidate {
  const _Candidate({
    required this.scan,
    required this.manifest,
    required this.status,
  });

  final RecordingScan scan;
  final RecordingManifest manifest;
  final RecoveryJobStatus status;

  JournalByteRange get range => scan.verifiedRecoverableRange;
}

/// Three timestamps, so the four deadlines each measure their own thing.
class _ProgressClocks {
  _ProgressClocks(this._clock)
      : lastUploadMs = _clock(),
        lastEngineMs = _clock();

  final int Function() _clock;
  int lastUploadMs;
  int lastEngineMs;
  bool sawEngine = false;

  int get lastAnyMs => math.max(lastUploadMs, lastEngineMs);

  void noteUpload() => lastUploadMs = _clock();

  void noteEngine() {
    sawEngine = true;
    lastEngineMs = _clock();
  }
}

@immutable
class _WaitOutcome {
  const _WaitOutcome({
    this.reachedTerminal = false,
    this.timedOut = false,
    this.timeoutKind,
    this.stallCode,
  });

  final bool reachedTerminal;
  final bool timedOut;
  final String? timeoutKind;

  /// The wire code off a terminal `stt:error` that ended this wait, when there
  /// was one. Separate from [timeoutKind] because they answer different
  /// questions - 「a clock ran out here」 versus 「the server named a reason」 -
  /// and only the second is worth writing into the manifest as the failure.
  final String? stallCode;
}

@immutable
class _AttemptResult {
  const _AttemptResult({
    this.framesEmitted = 0,
    this.endedOnTerminalFinal = false,
    this.receipt,
    this.resultText,
    this.newRowIds = const <String>[],
    this.timeoutKind,
    this.refusalCode,
    this.refusedByGate = false,
    this.linkLost = false,
  });

  final int framesEmitted;
  final bool endedOnTerminalFinal;
  final CoverageReceipt? receipt;

  /// A5-4 - the words the TERMINAL final carried, or null when none arrived.
  /// Read off the same frame [receipt] is read off, for the reason
  /// `RecoverySettleInputs.resultText` gives: the row can hold a stale interim
  /// the engine never produced, and the engine's own text cannot.
  final String? resultText;

  final List<String> newRowIds;
  final String? timeoutKind;

  /// The server's own code for why this attempt ended, when it gave one. It is
  /// recorded on the closed attempt in place of the generic `stall_*` label; the
  /// manifest is the history, and 「the server refused it, and here is what it
  /// called the refusal」 is a different fact from 「something stalled」.
  final String? refusalCode;

  /// The FSM refused to open a recovery session (a press, or no link). Nothing
  /// was sent and nothing was recorded.
  final bool refusedByGate;

  final bool linkLost;
}
