import 'dart:convert';

import '../audio/recording_account.dart';
import '../audio/retained_audio_manifest.dart';
import 'recovery_backoff.dart';
import 'recovery_identity.dart';

/// Facts that must still agree before a recovery attempt can send audio.
///
/// Contains the verified send bounds, all owed stretches (including placement
/// and completed stretches), format/identity inputs, ownership, queue/debt
/// state and attempt history used by the budget, binding-conflict generation
/// and settle rules. Keep this projection aligned with those consumers.
///
/// Observation/bookkeeping timestamps, especially claimAheadOfObservedAt
/// re-stamped by every scan, are deliberately excluded: observing unchanged
/// debt must not restart a sender forever. nextEligibleAtMs and
/// liveSettlePendingAtMs are included because they *gate* recovery; they are
/// not scan observations. Attempt start timestamps do not affect eligibility.
String recoveryRelevantProjection(
  RecordingManifest manifest,
  JournalByteRange sendRange,
) => jsonEncode(<String, Object?>{
  'recordingId': manifest.recordingId,
  'formatVersion': manifest.formatVersion,
  'format': manifest.format.toJson(),
  'committedClaimBytes': manifest.committedClaimBytes,
  'sendRange': sendRange.toJson(),
  'owedRanges': manifest.owedRanges.map((r) => r.toJson()).toList(),
  'cancelled': manifest.cancelled,
  'settled': manifest.settled,
  'recoveryState': RecoveryQueueState.normalise(manifest.recoveryState),
  'nextEligibleAtMs': manifest.nextEligibleAtMs,
  'liveSettlePendingAtMs': manifest.liveSettlePendingAtMs,
  'account': manifest.configSnapshot[kConfigSnapshotAccount],
  'mode': manifest.configSnapshot[kConfigSnapshotMode],
  'sourceLang': manifest.configSnapshot[kConfigSnapshotSourceLang],
  'prefsDigest': manifest.configSnapshot[kConfigSnapshotPrefsDigest],
  'attempts': [
    for (final a in manifest.attempts)
      [a.jobId, a.kind, a.outcome, a.failureCode],
  ],
});
