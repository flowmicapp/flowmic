// Card RC-1a - THE JOURNAL LEG OF THE RECOVERY QUEUE.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     A6 (extend BackfillRunner, do NOT build a second recovery system),
//     A6-2 (a partial result means the WHOLE range again, never a splice),
//     A6-3 (the order: row -> read back -> manifest fsync -> delete),
//     A5-3 (the three preconditions), A7-3 (the three server tiers),
//     P1-3 (bounded streaming and FOUR separate timeouts)
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-threshold.md
//   apps/mobile/lib/src/session/backfill_runner.dart - the owner of this object
//
// WHAT THIS IS, AND WHAT IT IS NOT
//
// It is the SECOND SOURCE of the one recovery mechanism. `BackfillRunner` still
// owns the single-flight latch, the live-press priority and the progress value;
// this class answers one question for it - 「what does the per-recording journal
// owe, and what happens to it」 - and it is reached only when the spill is
// running the journal face (`retainFromFirstFrame`). With the flag off, which
// is every build shipped today, `BackfillRunner` never constructs it and the
// legacy segment leg runs byte-for-byte as before.
//
// 🔴 IT IS NOT A SECOND QUEUE. It does not own a latch, does not schedule
// itself, and cannot be swept concurrently with the legacy leg: its only entry
// point is called from inside the runner's own pass.

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import '../audio/retained_audio_journal.dart';
import '../audio/retained_audio_spill.dart';
import '../diag/diag_log.dart';
import '../ptt/ptt_session.dart';
import '../settings/phone_prefs_payload.dart';
import '../signaling/state_machine.dart';
import '../signaling/wire_payloads.dart' show FlowMode;
import '../stt/stt_stream.dart';
import '../timeline/article.dart' show pcmBytesToMs;
import '../timeline/timeline_entry.dart';
import '../timeline/timeline_store.dart';
import 'recovery_backoff.dart';
import 'recovery_gate.dart';
import 'recovery_identity.dart';
import 'pending_recovery.dart';
import 'recovery_leg_policy.dart';
import 'recovery_settle.dart';

export 'recovery_leg_policy.dart';

part 'recovery_leg_internals.dart';
part 'recovery_leg_wire.dart';

part 'recovery_leg_settle.dart';

/// The journal-sourced recovery. One instance per [BackfillRunner].
class RecoveryJournalLeg {
  RecoveryJournalLeg({
    required PttSession session,
    required TimelineStore timeline,
    required RetainedAudioSpill spill,
    PhonePrefsSource? phonePrefs,
    LegacyServerVerifier legacyVerifier = const DenyAllLegacyServerVerifier(),
    RecoveryTimeouts timeouts = const RecoveryTimeouts(),
    int readBlockBytes = kRecoveryReadBlockBytes,
    Duration blockCadence = const Duration(milliseconds: 20),
    JournalFileSystem fs = const IoJournalFileSystem(),
    int Function()? clock,
    String Function()? newId,
    bool Function()? metered,
    Future<void> Function(Duration)? sleep,
  })  : _session = session,
        _timeline = timeline,
        _spill = spill,
        _phonePrefs = phonePrefs,
        _legacyVerifier = legacyVerifier,
        _timeouts = timeouts,
        _readBlockBytes = readBlockBytes,
        _blockCadence = blockCadence,
        _fs = fs,
        _clock = clock ?? (() => DateTime.now().millisecondsSinceEpoch),
        _newId = newId ?? _defaultId,
        // 🔴 DEFAULTS TO METERED. A7-3 requires `recovery.idempotent_operation`
        // where an account can be charged; guessing 「standalone」 would drop
        // that requirement on the one deployment where getting it wrong costs
        // the user money.
        _metered = metered ?? (() => true),
        _sleep = sleep ?? Future<void>.delayed;

  final PttSession _session;
  final TimelineStore _timeline;
  final RetainedAudioSpill _spill;
  final PhonePrefsSource? _phonePrefs;
  final LegacyServerVerifier _legacyVerifier;
  final RecoveryTimeouts _timeouts;
  final int _readBlockBytes;
  final Duration _blockCadence;
  final JournalFileSystem _fs;

  /// Card FX-4 — the recording whose PCM `_finish` decided may go, held until
  /// the handle that is still open on that file has been closed.
  ///
  /// 🔴 IT IS A FIELD RATHER THAN A CALL AT THE DECISION POINT BECAUSE WINDOWS
  /// REFUSES TO DELETE AN OPEN FILE, and this leg's journal handle is open on
  /// the PCM for the whole of `_finish` (the `finally` below is what closes
  /// it). MEASURED while writing this card: the delete threw a sharing
  /// violation, the catch swallowed it as designed, and the bytes stayed —
  /// i.e. exactly the behaviour FX-4 exists to remove, with a line of code
  /// that looked like it removed it. The live path has the same ordering for
  /// the same reason: it deletes after its own `finally` closes the handle.
  String? _releaseAfterClose;
  final int Function() _clock;
  final String Function() _newId;
  final bool Function() _metered;
  final Future<void> Function(Duration) _sleep;

  static int _idCounter = 0;

  static String _defaultId() =>
      '${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}'
      '-${(_idCounter++).toRadixString(36)}';

  /// One pass. Returns what it found; refuses on its own when the tier, the
  /// link or a live press says not now.
  Future<RecoveryLegOutcome> run({required String fallbackSourceLang}) async {
    final RecoveryGateVerdict verdict = evaluateRecoveryGate(
      caps: _session.reconnect.serverCapabilities,
      metered: _metered(),
      verifier: _legacyVerifier,
    );
    // 🔴 NO SERVER HAS ANSWERED YET - THE PASS ENDS, AND WRITES NOTHING.
    //
    // Not a scan, not a state, not a sentence. MEASURED 2026-09-06 (drill D-2):
    // this pass used to run 1.3 s BEFORE the ack that carries `capabilities`,
    // read tier C out of "we have not asked anybody", and PERSIST
    // `awaiting_server_capability` onto every recording - after which the
    // screen told the user their server could not recover audio safely, about a
    // server advertising all three bits, for as long as they looked at it. The
    // trigger edge moved with this change (chat_outbox_host.dart: the sweep now
    // hangs off `DeliveryLinkUp`, which is by construction after an ack), and
    // this guard is what keeps the outcome honest if it ever fires early again.
    final List<_Candidate> candidates = await _scanCandidates();
    if (verdict.tier == RecoveryTier.undetermined) {
      diag('audio.recovery.capability_undetermined', <String, Object?>{
        ...verdict.toDiag(),
        'recordings': candidates.length,
      });
      // ⚠️ IT STILL TALLIES. The scan is a read; what this pass may not do
      // is WRITE a verdict or open a session. Returning zeros instead would
      // take the retained-audio banner down while the audio is still owed a
      // transcription - a second false statement in place of the first one.
      return _tally(RecoveryTier.undetermined, candidates, stopEarly: false);
    }
    if (candidates.isEmpty) {
      return RecoveryLegOutcome(
        tier: verdict.tier,
        pendingBytes: 0,
        needsManual: 0,
        settledUnverified: 0,
        stopEarly: false,
      );
    }
    if (!verdict.tier.mayStart) {
      // A7-3 tier C. Not one `audio:start`, and the state is PERSISTED so the
      // next launch does not have to rediscover it and the face can say so.
      diag('audio.recovery.awaiting_capability', <String, Object?>{
        ...verdict.toDiag(),
        'recordings': candidates.length,
      });
      for (final _Candidate c in candidates) {
        // Card LK-2 — 🔴 ONLY ONTO A RECORDING THAT IS ACTUALLY OWED ONE.
        // `awaiting_server_capability` renders as 「this server version cannot
        // recover audio safely」, which is a true sentence about the server and
        // a false one about a recording whose words are already in the
        // timeline. Stamping it over a terminal settle also DESTROYS the only
        // record of what happened — the state is the thing card RC-1b routes
        // its sentence on.
        if (RecoveryQueueState.isTerminalSettle(c.status.state)) continue;
        await _persistState(c, RecoveryQueueState.awaitingServerCapability);
      }
      return _tally(verdict.tier, candidates, stopEarly: false);
    }
    // A recording carrying a tier-C verdict from an EARLIER pass is re-judged
    // now that a server has answered: the persisted state outlives the process
    // (that is why it is written at all), so nothing else would ever clear it
    // and the screen would keep the old sentence against a server that can.
    // A no-op for every recording not in that state (`_persistState` returns
    // early when the state already matches).
    for (final _Candidate c in candidates) {
      if (c.status.state == RecoveryQueueState.awaitingServerCapability) {
        await _persistState(c, RecoveryQueueState.pending);
      }
    }
    bool stop = false;
    for (final _Candidate c in candidates) {
      if (!c.status.mayAutoAttemptAt(_clock())) continue;
      final _StepOutcome step = await _attempt(c, verdict, fallbackSourceLang);
      // A recording the user deleted mid-sweep is not a reason to stop: the
      // debt it represented is gone, and the next candidate is still owed one.
      if (step == _StepOutcome.recordingGone) continue;
      if (step != _StepOutcome.completed) {
        stop = true;
        break;
      }
    }
    return _tally(verdict.tier, await _scanCandidates(), stopEarly: stop);
  }

  /// Card RC-1b (audit A6 R-2, owner ruling O-9) - ONE recording, because the
  /// user asked for it.
  ///
  /// IT IS NOT A SECOND QUEUE AND NOT A SECOND POLICY. It reuses the same
  /// gate, the same candidate scan, the same attempt body and the same settle
  /// rules; the only two things it does differently are both required by the
  /// ruling:
  ///   - it does NOT consult [RecoveryJobStatus.mayAutoAttemptAt] - that
  ///     predicate answers "may the AUTOMATIC route try", and a user whose
  ///     automatic budget is spent is precisely the person this entry point
  ///     exists for;
  ///   - the attempt is stamped [RecoveryAttemptKind.userRetranscribe], which
  ///     is what keeps it off the automatic budget (`RecoveryJobStatus
  ///     .fromManifest` counts `auto_retry` failures only) and what tells the
  ///     server this is a deliberate re-transcription.
  ///
  /// SINGLE-FLIGHT IS STILL THE RUNNER'S. This method is only ever entered
  /// from inside `BackfillRunner.retranscribe`, which queues it behind whatever
  /// sweep is running - two `audio:start` frames on one socket is the
  /// corruption the runner's header describes, and a user's button press is not
  /// an exception to it.
  Future<PendingRetryOutcome> runOne({
    required String recordingId,
    required String fallbackSourceLang,
  }) async {
    final RecoveryGateVerdict verdict = evaluateRecoveryGate(
      caps: _session.reconnect.serverCapabilities,
      metered: _metered(),
      verifier: _legacyVerifier,
    );
    if (!verdict.tier.mayStart) {
      diag('audio.recovery.user_retry_refused', <String, Object?>{
        ...verdict.toDiag(),
        'recording_id': recordingId,
      });
      // 🔴 TWO REFUSALS, TWO SENTENCES. `refusedServer` says "this server
      // cannot do it safely", which is a claim about a server - and under
      // [RecoveryTier.undetermined] no server has spoken, so it would be a
      // claim about nobody. What IS true then is the plain one: nothing got
      // through and the audio is still here.
      return verdict.tier.isVerdict
          ? PendingRetryOutcome.refusedServer
          : PendingRetryOutcome.failed;
    }
    _Candidate? found;
    for (final _Candidate c in await _scanCandidates()) {
      if (c.scan.recordingId == recordingId) found = c;
    }
    // Gone, cancelled, settled or unreadable: `_scanCandidates` is the one
    // place that decides what may be fed back, and a user press does not
    // widen it. Owner ruling O-5 in particular - a cancelled recording is
    // never fed back, by anybody.
    if (found == null) return PendingRetryOutcome.unavailable;
    final _StepOutcome step = await _attempt(
      found,
      verdict,
      fallbackSourceLang,
      kind: RecoveryAttemptKind.userRetranscribe,
    );
    return switch (step) {
      _StepOutcome.completed => PendingRetryOutcome.done,
      _StepOutcome.refusedByGate => PendingRetryOutcome.refusedBusy,
      _StepOutcome.linkLost => PendingRetryOutcome.failed,
      // Deleted underneath the press. The screen re-reads its list either way
      // and the card is gone; `unavailable` is the arm that says 「nothing to
      // drive and nothing went wrong」 and renders no sentence.
      _StepOutcome.recordingGone => PendingRetryOutcome.unavailable,
    };
  }

  RecoveryLegOutcome _tally(
    RecoveryTier? tier,
    List<_Candidate> candidates, {
    required bool stopEarly,
  }) {
    int bytes = 0;
    int outage = 0;
    int manual = 0;
    int unverified = 0;
    for (final _Candidate c in candidates) {
      switch (c.status.state) {
        case RecoveryQueueState.needsManual:
          manual += 1;
        case RecoveryQueueState.settledUnverified:
          unverified += 1;
      }
      if (c.status.state != RecoveryQueueState.settled) {
        bytes += c.range.length;
        // Card LK-3 — 🔴 THE INTERRUPT REASON IS THE ONLY THING THAT KNOWS
        // WHETHER THE LINK WAS DOWN. The banner used to infer an outage from
        // 「something is owed」, which is true of a paused recording and of a
        // press whose receipt never came.
        if (c.manifest.interruptReason == JournalInterrupt.linkLoss) {
          outage += c.range.length;
        }
      }
    }
    return RecoveryLegOutcome(
      tier: tier,
      pendingBytes: bytes,
      outagePendingBytes: outage,
      needsManual: manual,
      settledUnverified: unverified,
      stopEarly: stopEarly,
    );
  }

  /// Everything on disk this leg is allowed to touch.
  ///
  /// 🔴 THE EXCLUSIONS ARE THE INTERESTING PART, and every one of them is
  /// somebody's ruling rather than a tidy-up:
  ///   · `cancelled` - owner ruling O-5. The user swiped it away; it is kept
  ///     and never fed back;
  ///   · `quarantined` / `manifestMissing` - audit A3-8 / O-7. A manifest we
  ///     cannot read is not a licence to invent a recordingId for the bytes;
  ///   · `formatMismatch` - A3-2a. Refuse, keep, never transcode;
  ///   · the recording being written RIGHT NOW - that is live audio, not a debt;
  ///   · an empty `verifiedRecoverableRange` - there is nothing to feed.
  Future<List<_Candidate>> _scanCandidates() async {
    final String dir = _spill.store.dirPath;
    final String? live = _spill.currentRecordingId;
    final List<RecordingScan> scans =
        await RetainedAudioJournalScan.scan(dirPath: dir, fs: _fs);
    final List<_Candidate> out = <_Candidate>[];
    for (final RecordingScan s in scans) {
      final RecordingManifest? m = s.manifest;
      if (m == null || s.quarantined || s.manifestMissing) continue;
      if (s.formatMismatch || s.cancelled || m.settled) continue;
      // Card LK-1 — a recording that transcribed against a receiptless server
      // is FINISHED. Its bytes are waiting for the TTL sweep, not for this
      // leg: feeding it back would re-transcribe (and re-bill) words the user
      // already has, and — before this line — the tier-C branch below stamped
      // `awaiting_server_capability` over its state, which is how every
      // ordinary press ended up on the pending screen (observed 2026-09-07).
      if (RecoveryQueueState.normalise(m.recoveryState) ==
          RecoveryQueueState.transcribedUnverified) {
        continue;
      }
      if (s.recordingId == live) continue;
      // 🔴 SD-2 — A RECORDING BEING SETTLED LIVE IS NOT AN ORPHAN, AND NEITHER
      // OF THE TWO FACTS ABOVE CAN SEE THAT. The live settle runs on the
      // terminal final, which lands after `AudioCapture.stop()` closed the
      // journal: for the length of that gap `live` is ALREADY null and the
      // manifest STILL says `settled:false`. A CR-5 edge-2 sweep fires on
      // exactly that transition (`chat_outbox_host.onFsmChangeRouted`, 「a
      // recording just ended」), so this is the ordinary interleaving rather
      // than a rare race, and what it buys the user is a SECOND transcription
      // of one press — billed twice, two rows.
      // ⚠️ A HOLD, NOT AN EXCLUSION: the flag expires, so a crash between the
      // stamp and the settle costs one bounded delay instead of a recording
      // nothing ever offers to recover (`RecordingScan.liveSettlePending`).
      if (s.liveSettlePending) continue;
      if (s.verifiedRecoverableRange.isEmpty) continue;
      out.add(_Candidate(
        scan: s,
        manifest: m,
        status: RecoveryJobStatus.fromManifest(m),
      ));
    }
    return out;
  }

  /// One recording, one attempt. Returns false when the caller should stop the
  /// whole sweep (no link, or a press holds the session).
  Future<_StepOutcome> _attempt(
    _Candidate c,
    RecoveryGateVerdict verdict,
    String fallbackSourceLang, {
    RecoveryAttemptKind kind = RecoveryAttemptKind.autoRetry,
  }) async {
    final AudioJournalFormat fmt = c.manifest.format;
    final RecoverySampleRange range;
    try {
      range = RecoverySampleRange.fromBytes(c.range, fmt);
    } on ArgumentError catch (e) {
      // A3-2a: an unaligned byte offset is not a coordinate. Keep the bytes,
      // do not guess a boundary.
      diag('audio.recovery.range_unaligned', <String, Object?>{
        'recording_id': c.scan.recordingId,
        'error': '$e',
      });
      return _StepOutcome.completed;
    }
    // A6 R-5. A recording captured before the snapshot existed is LEGACY, and
    // the substitution is named in the diagnostics rather than made silently -
    // that silence is the defect R-5 exists to close.
    RecoveryResultVariant? variant =
        RecoveryResultVariant.fromConfigSnapshot(c.manifest.configSnapshot);
    final bool legacyVariant = variant == null;
    variant ??= RecoveryResultVariant(
      mode: FlowMode.realtime.name,
      sourceLang: fallbackSourceLang,
      prefsDigest: digestPrefs(_phonePrefs?.call()),
    );
    final RecoveryIdentity identity = RecoveryIdentity.forAttempt(
      recordingId: c.scan.recordingId,
      range: range,
      variant: variant,
      attemptId: 'a-${_newId()}',
      // A6-1 (4): one operation per attempt. A RE-SEND of this attempt would
      // reuse it; this card never re-sends, so every attempt mints one and the
      // field is honest about what it is rather than reserved for later.
      operationId: 'o-${_newId()}',
      attemptKind: kind,
      audioFormatVersion: c.manifest.formatVersion,
    );
    diag('audio.recovery.attempt', <String, Object?>{
      'recording_id': identity.recordingId,
      'job_id': identity.jobId,
      'attempt_id': identity.attemptId,
      'range': range.toString(),
      'legacy_config_snapshot': legacyVariant,
      'source_lang': variant.sourceLang,
      'tier': verdict.tier.name,
      'attempt_kind': kind.wire,
    });
    final RetainedAudioJournal j = await _openJournal(c.scan.recordingId);
    try {
      // 🔴 ASKED AGAIN, AFTER THE HANDLE IS OPEN. `_scanCandidates` ran before
      // this and the user's delete (owner ruling O-5) can land in between —
      // and from here on EVERY write through this handle would recreate the
      // manifest of audio that is gone, starting with the `commit` a few lines
      // down. On a phone the unlink succeeds while the handle stays perfectly
      // valid, so there is no error to catch; there is only the question,
      // asked of the disk.
      if (!await _fs.exists(_manifestPathOf(identity.recordingId))) {
        diag('audio.recovery.recording_gone', <String, Object?>{
          'recording_id': identity.recordingId,
          'attempt_id': identity.attemptId,
        });
        return _StepOutcome.recordingGone;
      }
      // OPENED BEFORE THE WIRE IS TOUCHED: a process killed mid-attempt must
      // still leave a record that the attempt happened, or the budget resets
      // on every crash.
      j.addAttempt(JournalAttempt(
        attemptId: identity.attemptId,
        startedAtMs: _clock(),
        jobId: identity.jobId,
        operationId: identity.operationId,
        kind: identity.attemptKind.wire,
      ));
      await j.commit();
      // P1-2: tell the reconnect ring replay that these bytes have a sender.
      // A CLAIM IS NOT DELIVERY - see audio/replay_ownership.dart.
      _spill.replayOwnership.claim(identity.recordingId);
      final _AttemptResult r =
          await _runOnWire(c, identity, variant.sourceLang);
      if (r.refusedByGate) return _StepOutcome.refusedByGate;
      await _finish(c, j, identity, r, verdict);
      return r.linkLost ? _StepOutcome.linkLost : _StepOutcome.completed;
    } finally {
      _spill.replayOwnership.release(identity.recordingId);
      // 🔴 CLOSE COMMITS, SO IT IS ASKED FIRST WHETHER THERE IS ANYTHING LEFT
      // TO COMMIT TO. The user can delete this recording at any point while
      // the attempt runs (owner ruling O-5, card RC-1b's screen), through a
      // different object and a different handle — this one stays perfectly
      // valid, and its closing commit would write the manifest back for audio
      // that is gone. The scan would then list the recording again with its
      // claim ahead of an absent file, and the delete would look as though it
      // had silently failed. `_finish` makes the same check before ITS writes;
      // this one covers the commit `close` performs on its own.
      if (await _fs.exists(_manifestPathOf(identity.recordingId))) {
        await j.close();
        // Card FX-4 — the handle is gone, so the bytes can go. Only ever set
        // by the settled branch of `_finish`; the abandon branch below drops
        // it unused, because a recording the user deleted has no bytes left to
        // release and no manifest that would license one.
        final String? release = _releaseAfterClose;
        if (release != null) await _releaseBytes(release);
      } else {
        await j.abandon();
      }
      _releaseAfterClose = null;
    }
  }
}
