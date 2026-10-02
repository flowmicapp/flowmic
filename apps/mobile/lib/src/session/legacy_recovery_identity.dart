// NR-138 ③ — THE IDENTITY A LEGACY SEGMENT START PUTS ON THE WIRE, AND THE
// CAPABILITY IT NEEDS BEFORE IT MAY SEND ONE.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a, NR-138 correction (2026-10-01) ③
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.9 (RC-R: an automatic
//     job is metered once per `(user, operation_id, 'stt')`)
//   apps/mobile/lib/src/session/recovery_identity.dart (the derivations reused)
//   apps/server-core/test/legacy-backfill-bills-once.test.ts (the relay half)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// ── WHY THE LEGACY LEG NEEDED ONE ───────────────────────────────────────────
//
// Until this card the pre-journal segment leg sent a bare `audio:start`. The
// relay's `meterOnce` (server-core `billing/usage-tracker.ts`) runs the effect
// directly when a frame names no `operation_id`, so every automatic retry of
// one stuck segment debited the full segment again. The journal leg had the
// protection since RC-R; this file gives the legacy leg the same fields,
// derived the same way, so the relay registers the second automatic start of
// one segment as a `resend` and charges it once.
//
// ── WHAT EACH FIELD IS FOR A LEGACY SEGMENT ─────────────────────────────────
//
//   recording_id — `<session>__seg-<n>`: the file's own name without `.pcm`.
//                  Per SEGMENT, not per session, because every segment's range
//                  starts at sample 0 of its own file: one id per session would
//                  give two equal-length segments the same job, and the second
//                  would never be billed. It is also the id the journal scan
//                  already sees for these files (`PendingRecoveryStore
//                  ._looksLegacySegment`).
//   range        — `[0, samples)` of that file. The whole file is fed, always.
//   variant      — `realtime | source_lang | prefs digest`. The legacy face has
//                  no config snapshot, so the CURRENT language and preferences
//                  stand in, exactly as the journal leg's legacy-variant branch
//                  does (`recovery_leg_attempt.dart`). A change of language
//                  between attempts is a new job, and is billed as one.
//   operation_id — automatic: `deriveOperationId(jobId, auto_retry)`, generation
//                  0. The binding the relay stores never changes for one job
//                  (recording, range, kind, mode are all constant), so the
//                  relay has no reason to refuse it; if it ever did, the start
//                  fails and spends one slot of the five-start budget.
//                  user_retranscribe: a fresh id per press (owner ruling O-4).

import '../audio/retained_audio_manifest.dart'
    show AudioJournalFormat, RecordingManifest;
import '../signaling/wire_payloads.dart' show FlowMode;
import 'recovery_gate.dart';
import 'recovery_identity.dart';

/// The recording id a legacy segment carries on the wire.
String legacySegmentRecordingId(String sessionKey, int segmentIdx) =>
    '${sessionKey}__seg-$segmentIdx';

/// Everything one legacy segment start says about itself.
///
/// [freshOperationId] is required for [RecoveryAttemptKind.userRetranscribe]
/// and ignored for [RecoveryAttemptKind.autoRetry], whose id is derived.
RecoveryIdentity legacySegmentIdentity({
  required String sessionKey,
  required int segmentIdx,
  required int pcmBytes,
  required String sourceLang,
  required Map<String, Object?>? prefs,
  required RecoveryAttemptKind kind,
  required String attemptId,
  String? freshOperationId,
  // NR-137 round 3 (review B1) — a kept-words press feeds ALL of a session's
  // kept segments as ONE start: one recording, one range, one operation.
  String? recordingIdOverride,
}) {
  final String recordingId =
      recordingIdOverride ?? legacySegmentRecordingId(sessionKey, segmentIdx);
  final int frame = AudioJournalFormat.current.bytesPerFrame;
  final RecoverySampleRange range =
      RecoverySampleRange(0, frame <= 0 ? 0 : pcmBytes ~/ frame);
  final RecoveryResultVariant variant = RecoveryResultVariant(
    mode: FlowMode.realtime.name,
    sourceLang: sourceLang,
    prefsDigest: digestPrefs(prefs),
  );
  final String jobId =
      deriveJobId(recordingId: recordingId, range: range, variant: variant);
  final String operationId = switch (kind) {
    RecoveryAttemptKind.autoRetry =>
      deriveOperationId(jobId: jobId, attemptKind: kind),
    RecoveryAttemptKind.userRetranscribe => freshOperationId ??
        (throw ArgumentError.notNull('freshOperationId')),
    RecoveryAttemptKind.live =>
      throw ArgumentError.value(kind, 'kind', 'a recovery is never live'),
  };
  return RecoveryIdentity.forAttempt(
    recordingId: recordingId,
    range: range,
    variant: variant,
    attemptId: attemptId,
    operationId: operationId,
    attemptKind: kind,
    audioFormatVersion: RecordingManifest.currentFormatVersion,
  );
}

/// What the server in front of us allows the legacy leg to do.
enum LegacyRecoveryGate {
  /// No capability ack yet. Nothing is sent and nothing is written; the next
  /// `DeliveryLinkUp` sweep asks again (`RecoveryTier.undetermined`'s rule).
  undetermined,

  /// The server answered and an account can be charged, but it does not
  /// advertise `recovery.idempotent_operation`: a start there would be billed
  /// on every attempt. Nothing is sent; the audio stays and the pending page
  /// says this server cannot recover it safely.
  refused,

  /// May start.
  open,
}

/// 🔴 THE SAME PARSED ACK AND THE SAME METERED ANSWER THE JOURNAL LEG READS,
/// through `evaluateRecoveryGate`, so the capability rules have one author.
///
/// ⚠️ IT ASKS LESS THAN TIER A, ON PURPOSE: the legacy leg has no use for a
/// coverage receipt (its delete rule is durable row readback, 04 册 2026-09-30)
/// and it has always sent `delivery: none`. What this card adds is the one bit
/// that decides whether a retry is billed again.
LegacyRecoveryGate legacyRecoveryGateOf(RecoveryGateVerdict v) {
  if (!v.ackSeen) return LegacyRecoveryGate.undetermined;
  if (v.metered && !v.idempotentOperation) return LegacyRecoveryGate.refused;
  return LegacyRecoveryGate.open;
}
