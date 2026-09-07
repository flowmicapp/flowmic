// Card LS-1 — the per-recording manifest that the LS-1 journal commits.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A3-1 (journal + manifest separation), §A3-2a (sample is the time base),
//     §A3-3 (commit order), §A3-8 (startup recovery: three separate quantities)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-b
//
// This file is DATA ONLY: a value type and its JSON codec. Everything that
// touches a filesystem lives in retained_audio_journal.dart, because the
// startup scan has to be able to read a manifest written by a build whose
// journal implementation no longer exists.
//
// 🔴 THE ONE RULE THIS FILE EXISTS TO ENFORCE: `committedClaimBytes` IS A
// CLAIM, NOT A FACT. It is what a previous run said it had committed. It is
// not the length of the PCM file, and it is not the range that has been
// verified as replayable. §A3-8 names all three separately on purpose — this
// project's headline defect shape is one value answering two questions, and
// the storage-face version of it would be a single `length` field that means
// "claimed" on Monday and "observed" on Tuesday.

import 'dart:convert';

/// PCM layout of one recording. Carried per manifest rather than assumed
/// globally: §A3-2a — offsets from two recordings with different formats are
/// not interchangeable, so the format travels with the offsets it indexes.
class AudioJournalFormat {
  final String codec;
  final int sampleRate;
  final int channels;

  /// Bytes per frame (all channels of one sample instant). `sampleIndex =
  /// byteOffset / bytesPerFrame`, so a byte offset that is not a multiple of
  /// this is CORRUPT AS A COORDINATE — §A3-2a — which is not the same as
  /// "the file is ruined" and never licenses deleting the odd byte.
  final int bytesPerFrame;

  const AudioJournalFormat({
    this.codec = 'pcm_s16le',
    this.sampleRate = 16000,
    this.channels = 1,
    this.bytesPerFrame = 2,
  });

  /// The format every current capture path produces (`audio_capture.dart`
  /// kAudioSampleRate / kAudioChannels, PCM16 mono).
  static const AudioJournalFormat current = AudioJournalFormat();

  Map<String, Object?> toJson() => <String, Object?>{
        'codec': codec,
        'sampleRate': sampleRate,
        'channels': channels,
        'bytesPerFrame': bytesPerFrame,
      };

  static AudioJournalFormat fromJson(Map<String, Object?> j) =>
      AudioJournalFormat(
        codec: _str(j['codec']) ?? 'pcm_s16le',
        sampleRate: _int(j['sampleRate']) ?? 16000,
        channels: _int(j['channels']) ?? 1,
        bytesPerFrame: _int(j['bytesPerFrame']) ?? 2,
      );

  bool sameAs(AudioJournalFormat o) =>
      codec == o.codec &&
      sampleRate == o.sampleRate &&
      channels == o.channels &&
      bytesPerFrame == o.bytesPerFrame;

  @override
  String toString() => '$codec/$sampleRate/$channels';
}

/// A half-open byte range `[start, end)` inside one recording's PCM file.
class JournalByteRange {
  final int start;
  final int end;

  const JournalByteRange(this.start, this.end);

  static const JournalByteRange empty = JournalByteRange(0, 0);

  int get length => end - start;

  bool get isEmpty => end <= start;

  Map<String, Object?> toJson() =>
      <String, Object?>{'start': start, 'end': end};

  static JournalByteRange fromJson(Map<String, Object?> j) =>
      JournalByteRange(_int(j['start']) ?? 0, _int(j['end']) ?? 0);

  @override
  String toString() => '[$start,$end)';
}

/// A byte range this recording KNOWS is missing from the PCM file.
///
/// Recorded when an append failed: the audio for those bytes existed, we were
/// asked to keep it, and we could not. §A9 P1-1 forbids swallowing that — a
/// silently missing interval reads downstream as continuous speech.
class JournalHole {
  final int start;
  final int length;

  /// Machine-readable cause (`io_error`, `cap_refused`, …). Never a sentence:
  /// user-facing wording is the banner layer's job, and this is a JSON file.
  final String reason;

  const JournalHole({
    required this.start,
    required this.length,
    required this.reason,
  });

  Map<String, Object?> toJson() => <String, Object?>{
        'start': start,
        'length': length,
        'reason': reason,
      };

  static JournalHole fromJson(Map<String, Object?> j) => JournalHole(
        start: _int(j['start']) ?? 0,
        length: _int(j['length']) ?? 0,
        reason: _str(j['reason']) ?? 'unknown',
      );

  @override
  String toString() => 'hole($start+$length:$reason)';
}

/// One recovery attempt over this recording. §A3-1 reserves the slot; the
/// recovery queue that fills it is card RC-1 and does not exist yet.
class JournalAttempt {
  /// Card RC-1a - the three outcomes a finished attempt can carry. Strings
  /// because they are an on-disk format; the settle path's richer refusal
  /// codes go in [failureCode], which nothing branches on.
  static const String outcomeSettled = 'settled';
  static const String outcomeSettledUnverified = 'settled_unverified';
  static const String outcomeFailed = 'failed';

  final String attemptId;
  final int startedAtMs;
  final String? outcome;

  /// Card RC-1a - the job this attempt served (A6-1 (2)). Persisted so a
  /// restart can tell two attempts at the SAME result from two attempts at
  /// different ones without recomputing a hash whose inputs may be gone.
  final String? jobId;

  /// A6-1 (4) - the network-send key. One attempt keeps ONE operation across
  /// its re-sends, which is what the server's idempotency is keyed on.
  final String? operationId;

  /// `auto_retry` / `user_retranscribe` (04 SPEC 3.3-a). 🔴 The automatic
  /// retry budget counts only the former; see recovery_backoff.dart.
  final String? kind;

  /// Why it did not settle, in the settle predicate's own vocabulary
  /// (`RecoverySettleDecision.reasonCode`): the refusal names joined with '+'.
  ///
  /// 🔴 ONE READER BRANCHES ON IT, so the format is now a contract rather than
  /// a diagnostic. `PendingRecoveryStore._onlyTierBKeptBytes` asks whether the
  /// ONLY refusal was `serverTierKeepsBytes` — the difference between telling
  /// a user 「we could not confirm your transcription was complete」 and 「it was
  /// complete; we keep audio for this server version anyway」. Grep:
  ///   grep -rn "failureCode" apps/mobile/lib
  final String? failureCode;

  const JournalAttempt({
    required this.attemptId,
    required this.startedAtMs,
    this.outcome,
    this.jobId,
    this.operationId,
    this.kind,
    this.failureCode,
  });

  JournalAttempt closedWith({
    required String outcome,
    String? failureCode,
  }) =>
      JournalAttempt(
        attemptId: attemptId,
        startedAtMs: startedAtMs,
        outcome: outcome,
        jobId: jobId,
        operationId: operationId,
        kind: kind,
        failureCode: failureCode,
      );

  Map<String, Object?> toJson() => <String, Object?>{
        'attemptId': attemptId,
        'startedAtMs': startedAtMs,
        if (outcome != null) 'outcome': outcome,
        if (jobId != null) 'jobId': jobId,
        if (operationId != null) 'operationId': operationId,
        if (kind != null) 'kind': kind,
        if (failureCode != null) 'failureCode': failureCode,
      };

  static JournalAttempt fromJson(Map<String, Object?> j) => JournalAttempt(
        attemptId: _str(j['attemptId']) ?? '',
        startedAtMs: _int(j['startedAtMs']) ?? 0,
        outcome: _str(j['outcome']),
        jobId: _str(j['jobId']),
        operationId: _str(j['operationId']),
        kind: _str(j['kind']),
        failureCode: _str(j['failureCode']),
      );
}

/// Named interrupt causes. §A3-9 asks every abnormal end to carry a NAMED
/// reason so the UI can eventually answer "from which second was nothing
/// saved" — an unnamed boolean cannot answer it.
class JournalInterrupt {
  static const String none = 'none';
  static const String ioError = 'io_error';
  static const String diskFull = 'disk_full';
  static const String capRefused = 'cap_refused';
  static const String processGone = 'process_gone';
  static const String captureFault = 'capture_fault';

  /// Card LS-2 — `AudioCapture.stopForLinkLoss`: the link died, the session
  /// layer judged the recording over locally, and nothing was said on the
  /// wire. The bytes are complete up to this point; what is unknown is
  /// whether anybody upstream heard them.
  static const String linkLoss = 'link_loss';

  /// Defect D-2 (round-four device drill, 2026-09-06) —
  /// `PttSession.stopForContinuousCap` ended this recording because it reached
  /// the account's per-sitting ceiling WITH NO LINK. The bytes are complete;
  /// nothing failed.
  ///
  /// 🔴 ITS OWN REASON RATHER THAN [linkLoss], EVEN THOUGH THE LINK REALLY WAS
  /// DOWN. Both are true of the moment and only one of them explains the
  /// ending: a reader asking 「why did this recording stop where it did?」 gets
  /// 「the connection died」 from `link_loss` — which is the right answer for a
  /// recording that ended AT the drop, and this one ran on for another twenty
  /// minutes afterwards. Two causes, two words.
  ///
  /// ⚠️ THE ONLINE CEILING DOES NOT WRITE IT. That path is the ordinary
  /// release (`pttUp` -> `AudioCapture.stop`), whose journal reason is `none`
  /// because nothing interrupted it — the recording ended the way every
  /// ordinary recording ends, just on a timer. Only the offline ceiling is an
  /// INTERRUPT, and only interrupts are named here.
  static const String capReached = 'cap_reached';

  /// 🔴 CARD LS-4 SPLIT `cancelled_or_fault` INTO FOUR, AND THE SPLIT IS THE
  /// POINT. `AudioCapture.fenceAndStop` has four callers and LS-2 gave all
  /// four one reason, so the one disposition that differs between them — owner
  /// ruling O-5's tombstone — was unrepresentable in the manifest. A recording
  /// that reads `cancelled_or_fault` cannot answer 「may this ever be
  /// re-transcribed?」, and that question has opposite answers for a swipe-up
  /// and for a dead microphone.
  ///
  /// The four, one per call site (grep `fenceAndStop`):
  ///   · [cancelled]    — `PttSession.pttCancel` (ptt/ptt_edges.dart). THE
  ///     ONLY ONE that also sets [RecordingManifest.cancelled].
  ///   · [captureFault] — `_onCaptureFault` (ptt/ptt_capture_pump.dart).
  ///   · [autoStopped]  — the `audio:auto-stopped` arm (ptt/ptt_inbound.dart).
  ///   · [authDrained]  — `AuthExpiredHandler.drain`
  ///     (signaling/auth_expired_handler.dart).
  ///
  /// ⚠️ A FAULT IS NOT A CANCEL. [captureFault] / [autoStopped] /
  /// [authDrained] stay RECOVERABLE: the user did not throw those words away,
  /// something else ended the recording, and RC-1 is meant to be able to pick
  /// them up. Only [cancelled] is a tombstone.
  ///
  /// 🔴 THE REASON IS STILL NOT THE TOMBSTONE. The disposition is
  /// [RecordingManifest.cancelled], a separate field, written in the same
  /// breath by the same caller. Two fields rather than one because a reader
  /// asking 「may I feed this back?」 must not have to know the reason
  /// vocabulary — a new reason added later would silently join the wrong side
  /// of a string comparison, which is this repo's headline defect shape.
  static const String cancelled = 'cancelled';

  /// The server had already ended the session (`audio:auto-stopped`). The
  /// utterance DID happen and DOES mint a row; see `fenceAndStop`'s doc for
  /// why its ring tail is still discarded.
  ///
  /// ⚠️ IT IS ALSO `fenceAndStop`'s DEFAULT, because ptt_inbound.dart is the
  /// one caller card LS-4 was not allowed to edit (a concurrent lane owns that
  /// file). A new caller that forgets the argument therefore records
  /// `auto_stopped` — wrong, but recoverable-wrong, which is the failure
  /// direction §5-4 asks for. It is NOT a tombstone by accident.
  static const String autoStopped = 'auto_stopped';

  /// `AuthExpiredHandler.drain`: capture authority is gone. The bytes are
  /// whole; what ended is our right to keep recording.
  static const String authDrained = 'auth_drained';

  /// Historical. LS-2 wrote this for all four callers; LS-4 replaced it with
  /// the four above. Kept as a READ-SIDE name so a manifest written by an LS-2
  /// build still parses to something meaningful — nothing writes it any more
  /// (grep `cancelledOrFault`: this declaration and its tests).
  static const String cancelledOrFault = 'cancelled_or_fault';
}

/// SD-2 — how long a [RecordingManifest.liveSettlePendingAtMs] stamp is
/// believed before a reader treats the recording as ordinary again.
///
/// 🔴 IT IS A CRASH BOUND, NOT A TIMEOUT FOR THE SETTLE. The settle path it
/// covers is a handful of awaits (a journal-queue turn, `awaitPersisted`, a
/// commit) and finishes in milliseconds; nothing waits this long in the healthy
/// case. The number exists so that a process killed BETWEEN the stamp and the
/// settle cannot hide a recording forever — the failure this bounds is a dead
/// process, not a slow one.
///
/// 🔴 WHICH DIRECTION TO ERR IN, STATED SO THE NEXT PERSON DOES NOT RETUNE IT
/// BLIND. Too short ⇒ the duplicate transcription SD-2 removes comes back
/// (the user is billed twice and gets two rows). Too long ⇒ a recording whose
/// settle never ran waits before the recovery queue offers to re-transcribe
/// it — a delay, never a loss, and the pending-recovery list shows it the whole
/// time. Two minutes is three orders of magnitude above the healthy path and
/// below anything a user would call "stuck".
///
/// ⚠️ THE OTHER CASE IT COVERS, SAID OUT LOUD. A press that produced no row
/// (a silent one, after SD-1) never reaches the publish that clears the stamp,
/// so it too waits out this window before the recovery queue will look at it.
/// That is a delay in offering to re-transcribe silence, and the pending list
/// shows the recording throughout — which is why the number is 30 s and not
/// the two minutes a pure crash bound would justify.
const int kLiveSettlePendingGraceMs = 30 * 1000;

/// The committed metadata for one recording.
///
/// 🔴 [committedClaimBytes] is always EVEN (§A3-2a: an odd byte offset is not
/// a sample coordinate). The journal floors to the frame boundary before
/// writing; the odd trailing byte stays in the PCM file untouched.
class RecordingManifest {
  /// Bumped when the on-disk shape changes. A reader that does not recognise
  /// the version QUARANTINES rather than guesses (§A3-8).
  static const int currentFormatVersion = 1;

  /// Card LK-1 — the ON-DISK name for 「this press transcribed and the words
  /// were persisted; the only thing missing is a proof this server cannot
  /// give」.
  ///
  /// 🔴 IT LIVES HERE, IN THE AUDIO LAYER, BECAUSE THE TTL SWEEP READS IT AND
  /// THE SWEEP CANNOT IMPORT THE SESSION LAYER. Every other queue-state name is
  /// spelled in `RecoveryQueueState` (session/recovery_backoff.dart), and that
  /// class takes THIS constant rather than repeating the string — one author,
  /// two readers, no drift. `RecoveryQueueState.transcribedUnverified` is the
  /// name the session layer uses and it is `identical` to this by construction.
  ///
  /// 🔴 IT IS NOT [settled] AND IT IS NOT `settled_unverified`. `settled` means
  /// the §A5-3 threshold was met and the bytes may go NOW;
  /// `settled_unverified` means something about THIS recording could not be
  /// confirmed (a short receipt, a mismatch) and the bytes are kept
  /// indefinitely. This one means the recording is fine and the SERVER cannot
  /// issue receipts at all — so the words are in the timeline, nothing is owed,
  /// and the audio is TTL-eligible (owner ruling O-2 exempts UNRECOVERED audio,
  /// and this is not that).
  static const String recoveryStateTranscribedUnverified =
      'transcribed_unverified';

  final String recordingId;
  final AudioJournalFormat format;
  final int formatVersion;
  final int committedClaimBytes;
  final String interruptReason;
  final List<JournalHole> holes;
  final List<JournalAttempt> attempts;

  /// Timeline row id once a recovery attempt produced one. Slot only —
  /// written by card RC-1.
  final String? resultRef;

  /// 🔴 THE TOMBSTONE (owner ruling O-5, 2026-09-06; card LS-4).
  ///
  /// True when the user swiped this recording away. The bytes are KEPT — the
  /// ruling is 「保留但永不自动转」 ("keep it, never auto-transcribe it") — and this
  /// flag is what makes the second half true: [RetainedAudioJournalScan] reports
  /// it (`RecordingScan.cancelled`) so the recovery queue skips it, and the TTL
  /// sweep in retained_audio_policy.dart refuses to take it even if something
  /// ever marks it settled.
  ///
  /// WRITER: [RetainedAudioJournal.markCancelled], reached from
  /// `RetainedAudioSpill.tombstoneCurrentRecording`, reached from
  /// `AudioCapture.fenceAndStop(reason: JournalInterrupt.cancelled)`, reached
  /// from `PttSession.pttCancel` — one path, no second author.
  ///
  /// ⚠️ IT IS NOT [JournalInterrupt.cancelled]. The reason says how the
  /// recording ended; this says what may be done with it. See that constant's
  /// doc for why they are two fields.
  final bool cancelled;

  /// Mode / spoken language / prefs digest as of the moment recording began.
  /// §A6 R-5 exists because `chat_inbound_routes.dart:43-44` reads the CURRENT
  /// setting at recovery time instead. Slot only — wired by card RC-1.
  final Map<String, Object?> configSnapshot;

  /// 🔴 THE ONE FLAG THE TTL SWEEP IS ALLOWED TO READ (card LS-3, owner
  /// ruling O-2, 2026-09-06).
  ///
  /// `true` means and ONLY means: this recording's bytes have been through
  /// the A5-3 clearing gate — coverage receipt complete, the session ended on
  /// a normal final, and the result row was read back from persistent storage
  /// — so deleting them loses nothing the user does not already have. Anything
  /// else is `false`, INCLUDING every shape of "we think it probably worked":
  /// A5-3 names that state `settled_unverified` and it is not this field.
  ///
  /// ⚠️ ADDITIVE AND OPTIONAL, so [formatVersion] does not move: a manifest
  /// written before this field existed decodes to `false`, which is the safe
  /// direction (it is never swept). A reader that treated a missing key as
  /// `true` would delete every pre-LS-3 recording on first sweep.
  ///
  /// 🔴 NOTHING WRITES `true` TODAY. The writer is card RC-1, which is the
  /// only place that can hold all three A5-3 preconditions at once; until it
  /// lands, the TTL sweep removes nothing, and that is the intended
  /// direction of the ruling rather than an omission.
  final bool settled;

  /// Card RC-1a (A6 R-3) - WHERE THE RECOVERY QUEUE THINKS THIS RECORDING IS.
  ///
  /// One of `RecoveryQueueState`'s constants (session/recovery_backoff.dart).
  /// 🔴 PERSISTED BECAUSE EVERY ONE OF ITS VALUES OUTLIVES THE PROCESS:
  /// `awaiting_server_capability` describes a server, `needs_manual` describes
  /// a budget already spent, and `settled_unverified` describes a decision that
  /// must never be re-litigated into an automatic retry. Holding them in memory
  /// would reset all three on relaunch - "at most five attempts" would become
  /// five per launch.
  ///
  /// Additive and optional: an older manifest decodes to `pending`, which
  /// retries rather than forgets.
  final String recoveryState;

  /// Wall-clock milliseconds before which no AUTOMATIC attempt may start.
  /// See `RecoveryJobStatus.nextEligibleAtMs` for the clock caveat.
  final int? nextEligibleAtMs;

  /// Set by the startup scan when a manifest claimed more than the PCM file
  /// holds (§A3-8). Evidence of a violated commit order; the high-water mark
  /// itself is deliberately NOT rewritten down to the observed length.
  final int? claimAheadOfObservedAt;

  /// 🔴 SD-2 — A LIVE SETTLE IS ON ITS WAY FOR THIS RECORDING; DO NOT FEED IT
  /// BACK YET. Wall-clock milliseconds at which the ordinary stop closed the
  /// journal, or null.
  ///
  /// THE ACCOUNT. The live settle (`session/live_settle.dart`) runs on the
  /// TERMINAL FINAL, which arrives after `AudioCapture.stop()` has already
  /// closed the journal. Between those two moments the manifest says
  /// `settled:false` and `RetainedAudioSpill.currentRecordingId` is already
  /// null — the two facts `RecoveryJournalLeg._scanCandidates` judges on — so a
  /// CR-5 edge-2 sweep (`chat_outbox_host.onFsmChangeRouted`, 「a recording just
  /// ended」) landing in that window sees an unsettled orphan and opens a
  /// recovery attempt on a recording that is being settled live. That is a
  /// SECOND transcription of the same audio, billed to the user, and a second
  /// timeline row for one press.
  ///
  /// 🔴 IT IS A TIMESTAMP AND NOT A BOOLEAN, and that is the whole safety
  /// argument. A flag set before the journal closes is a flag a crash can leave
  /// standing forever, and a recording nothing will ever list is worse than the
  /// duplicate this field exists to prevent (owner ruling O-2 names the
  /// invisible-undeletable shape as a defect in its own right). Readers ignore
  /// it once [kLiveSettlePendingGraceMs] has passed, so the worst a crash can
  /// cost is that one bounded delay.
  ///
  /// WRITER: [RetainedAudioJournal.markLiveSettlePending], from
  /// `RetainedAudioSpill.endRecording` on an ORDINARY stop only. CLEARED by
  /// [RetainedAudioJournal.clearLiveSettlePending], from the settle path — on
  /// both of its outcomes and on the exits where it declines to settle at all.
  ///
  /// ⚠️ IT IS NOT [settled] AND IT IS NOT A DISPOSITION. It says 「somebody is
  /// still deciding」, which is exactly the state neither of the two existing
  /// flags could express; the TTL sweep still reads [settled] alone.
  final int? liveSettlePendingAtMs;

  const RecordingManifest({
    required this.recordingId,
    this.format = AudioJournalFormat.current,
    this.formatVersion = currentFormatVersion,
    this.committedClaimBytes = 0,
    this.interruptReason = JournalInterrupt.none,
    this.holes = const <JournalHole>[],
    this.attempts = const <JournalAttempt>[],
    this.resultRef,
    this.cancelled = false,
    this.settled = false,
    this.configSnapshot = const <String, Object?>{},
    this.recoveryState = 'pending',
    this.nextEligibleAtMs,
    this.claimAheadOfObservedAt,
    this.liveSettlePendingAtMs,
  });

  RecordingManifest copyWith({
    int? committedClaimBytes,
    String? interruptReason,
    List<JournalHole>? holes,
    List<JournalAttempt>? attempts,
    String? resultRef,
    bool? cancelled,
    bool? settled,
    Map<String, Object?>? configSnapshot,
    String? recoveryState,
    int? nextEligibleAtMs,
    bool clearNextEligibleAt = false,
    int? claimAheadOfObservedAt,
    int? liveSettlePendingAtMs,
    bool clearLiveSettlePending = false,
  }) =>
      RecordingManifest(
        recordingId: recordingId,
        format: format,
        formatVersion: formatVersion,
        committedClaimBytes: committedClaimBytes ?? this.committedClaimBytes,
        interruptReason: interruptReason ?? this.interruptReason,
        holes: holes ?? this.holes,
        attempts: attempts ?? this.attempts,
        resultRef: resultRef ?? this.resultRef,
        cancelled: cancelled ?? this.cancelled,
        settled: settled ?? this.settled,
        configSnapshot: configSnapshot ?? this.configSnapshot,
        recoveryState: recoveryState ?? this.recoveryState,
        // 🔴 An explicit clear, because `null` already means 「leave it」 for
        // every other optional here, and 「there is no wait any more」 is a
        // thing a caller genuinely needs to say.
        nextEligibleAtMs: clearNextEligibleAt
            ? null
            : (nextEligibleAtMs ?? this.nextEligibleAtMs),
        claimAheadOfObservedAt:
            claimAheadOfObservedAt ?? this.claimAheadOfObservedAt,
        // Same explicit-clear shape as `nextEligibleAtMs` above, and for the
        // same reason: 「the settle is over」 is a thing a caller must be able to
        // say, and `null` already means 「leave it alone」 here.
        liveSettlePendingAtMs: clearLiveSettlePending
            ? null
            : (liveSettlePendingAtMs ?? this.liveSettlePendingAtMs),
      );

  Map<String, Object?> toJson() => <String, Object?>{
        'recordingId': recordingId,
        'format': format.toJson(),
        'formatVersion': formatVersion,
        'committedClaimBytes': committedClaimBytes,
        'interruptReason': interruptReason,
        'holes': holes.map((JournalHole h) => h.toJson()).toList(),
        'attempts': attempts.map((JournalAttempt a) => a.toJson()).toList(),
        'resultRef': resultRef,
        'cancelled': cancelled,
        'settled': settled,
        'configSnapshot': configSnapshot,
        'recoveryState': recoveryState,
        if (nextEligibleAtMs != null) 'nextEligibleAtMs': nextEligibleAtMs,
        if (claimAheadOfObservedAt != null)
          'claimAheadOfObservedAt': claimAheadOfObservedAt,
        if (liveSettlePendingAtMs != null)
          'liveSettlePendingAtMs': liveSettlePendingAtMs,
      };

  String encode() => jsonEncode(toJson());

  /// Parse a manifest. Throws [ManifestFormatException] on anything it cannot
  /// read — the caller's only correct response is quarantine (§A3-8). A
  /// lenient parser that returned a half-filled object would hand the recovery
  /// queue a `committedClaimBytes: 0` indistinguishable from a real one.
  static RecordingManifest decode(String source) {
    final Object? raw;
    try {
      raw = jsonDecode(source);
    } on FormatException catch (e) {
      throw ManifestFormatException('not JSON: ${e.message}');
    }
    if (raw is! Map<String, Object?>) {
      throw const ManifestFormatException('top level is not an object');
    }
    final String? id = _str(raw['recordingId']);
    if (id == null || id.isEmpty) {
      throw const ManifestFormatException('recordingId missing');
    }
    final int? version = _int(raw['formatVersion']);
    if (version == null) {
      throw const ManifestFormatException('formatVersion missing');
    }
    if (version > currentFormatVersion) {
      throw ManifestFormatException(
          'formatVersion $version is newer than $currentFormatVersion');
    }
    final Object? fmt = raw['format'];
    if (fmt is! Map<String, Object?>) {
      throw const ManifestFormatException('format missing');
    }
    final int? claim = _int(raw['committedClaimBytes']);
    if (claim == null || claim < 0) {
      throw const ManifestFormatException('committedClaimBytes missing');
    }
    return RecordingManifest(
      recordingId: id,
      format: AudioJournalFormat.fromJson(fmt),
      formatVersion: version,
      committedClaimBytes: claim,
      interruptReason: _str(raw['interruptReason']) ?? JournalInterrupt.none,
      holes: _list(raw['holes']).map(JournalHole.fromJson).toList(),
      attempts: _list(raw['attempts']).map(JournalAttempt.fromJson).toList(),
      resultRef: _str(raw['resultRef']),
      cancelled: raw['cancelled'] == true,
      // Missing ⇒ false ⇒ never swept. See the field's doc for why the
      // opposite default would delete every pre-LS-3 recording.
      settled: raw['settled'] == true,
      configSnapshot: raw['configSnapshot'] is Map<String, Object?>
          ? Map<String, Object?>.from(raw['configSnapshot']! as Map)
          : const <String, Object?>{},
      recoveryState: _str(raw['recoveryState']) ?? 'pending',
      nextEligibleAtMs: _int(raw['nextEligibleAtMs']),
      claimAheadOfObservedAt: _int(raw['claimAheadOfObservedAt']),
      // Additive and optional: a manifest written before SD-2 decodes to null,
      // i.e. 「no settle is pending」, which is the pre-SD-2 behaviour exactly.
      liveSettlePendingAtMs: _int(raw['liveSettlePendingAtMs']),
    );
  }
}

/// Thrown by [RecordingManifest.decode]. Quarantine, never guess.
class ManifestFormatException implements Exception {
  final String message;

  const ManifestFormatException(this.message);

  @override
  String toString() => 'ManifestFormatException: $message';
}

String? _str(Object? v) => v is String ? v : null;

int? _int(Object? v) => v is int ? v : (v is num ? v.toInt() : null);

List<Map<String, Object?>> _list(Object? v) => v is List
    ? v.whereType<Map<String, Object?>>().toList()
    : const <Map<String, Object?>>[];

/// The running record of what did not land, in STREAM coordinates.
///
/// 🔴 A HOLE'S `start` IS A POSITION IN THE CAPTURED STREAM, NOT A FILE OFFSET.
/// The two agree only until the first loss. Drill D-5b (2026-09-06, device
/// HA2F8D3H) recorded 132 holes at 2 distinct starts: nothing had landed
/// between the failures, so every catch re-used the same file length and all
/// 132 ranges overlapped. `sum(length)` was right (835,584 B) but the UNION of
/// the ranges was 6,400 B — a reader who merges instead of adding under-reports
/// the loss by ~130x. This ledger advances the cursor past every missing byte,
/// so union == sum by construction.
class JournalHoleLedger {
  final List<JournalHole> _holes = <JournalHole>[];
  int _missing = 0;

  List<JournalHole> get holes => List<JournalHole>.unmodifiable(_holes);

  /// Total bytes recorded as missing. Equals the sum of [holes] lengths.
  int get missingBytes => _missing;

  /// Stream position of the next byte, given the file currently holds
  /// [observedBytes].
  int cursor(int observedBytes) => observedBytes + _missing;

  /// Reload from a manifest being resumed, so the cursor continues past what a
  /// previous run already lost.
  void restore(List<JournalHole> prior) {
    _holes.addAll(prior);
    for (final JournalHole h in prior) {
      _missing += h.length;
    }
  }

  /// Record [length] bytes missing at stream position [start].
  ///
  /// Adjacent holes with the same reason coalesce: a disk that stays full emits
  /// one failure per captured chunk, and 132 rows describing one continuous gap
  /// are 132 chances for a reader to mis-add them.
  void record({
    required int start,
    required int length,
    required String reason,
  }) {
    if (length <= 0) return;
    _missing += length;
    if (_holes.isNotEmpty) {
      final JournalHole last = _holes.last;
      if (last.reason == reason && last.start + last.length == start) {
        _holes[_holes.length - 1] = JournalHole(
          start: last.start,
          length: last.length + length,
          reason: reason,
        );
        return;
      }
    }
    _holes.add(JournalHole(start: start, length: length, reason: reason));
  }
}
