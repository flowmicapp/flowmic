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
/// [refusedNoLink] — card WB-6. Split out of [refusedByGate] for the reason
/// that enum's own doc gives one layer down ([BackfillStart]): 「a press is
/// holding the microphone」 and 「this phone is not connected」 were one value,
/// and the screen said the first one to a person whose network was off.
enum _StepOutcome {
  completed,
  refusedByGate,
  refusedNoLink,
  linkLost,
  recordingGone,
}

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
///
/// Card RC-2 added the engine's reported position beside them ([ackedAudioMs]
/// and when it came); [RecoveryPacing] turns those facts into an allowance.
class _ProgressClocks {
  _ProgressClocks(this._clock)
      : lastUploadMs = _clock(),
        lastEngineMs = _clock(),
        startedAtMs = _clock(),
        ackedReportedAtMs = _clock();

  final int Function() _clock;
  int lastUploadMs;
  int lastEngineMs;
  bool sawEngine = false;

  /// Card RC-2 — when this attempt began; the pacing allowance's zero while no
  /// position has been reported.
  final int startedAtMs;

  /// Card RC-2 — the highest `acked_audio_ms` any interim of this attempt
  /// carried, or null while none has (a relay that reports nothing stays null).
  int? ackedAudioMs;

  /// Card RC-2 — when the last report came, advancing or not: a report that
  /// repeats the same position is the engine saying it is stuck, and re-anchors
  /// the allowance to where it is.
  int ackedReportedAtMs;

  int get lastAnyMs => math.max(lastUploadMs, lastEngineMs);

  void noteUpload() => lastUploadMs = _clock();

  void noteEngine() {
    sawEngine = true;
    lastEngineMs = _clock();
  }

  void noteAcked(int ms) {
    ackedAudioMs = math.max(ackedAudioMs ?? 0, ms);
    ackedReportedAtMs = _clock();
  }

  int paceLimitMs(RecoveryPacing p) => p.limitMs(
        ackedMs: ackedAudioMs,
        reportedAtMs: ackedReportedAtMs,
        startedAtMs: startedAtMs,
        nowMs: _clock(),
      );
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
    this.refusedNoLink = false,
    this.linkLost = false,
    this.fedWholeRange = true,
    this.resultEmptyReason,
  });

  /// Card RC6 (F3) — `empty_reason` off the terminal final, when the relay put one.
  final String? resultEmptyReason;

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

  /// Card WB-6 — WHICH of [refusedByGate]'s two causes it was. True only for
  /// 「there is no connected link」; false is 「a press holds the session」.
  /// Meaningless unless [refusedByGate].
  final bool refusedNoLink;

  final bool linkLost;

  /// Codex review ① — the whole requested range went out (see _streamRange).
  final bool fedWholeRange;
}
