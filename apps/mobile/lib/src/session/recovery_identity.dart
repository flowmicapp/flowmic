// Card RC-1a — THE FOUR IDENTIFIERS A RECOVERY ATTEMPT PUTS ON THE WIRE.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (the field table; the wire SSOT)
//   packages/protocol/src/recovery-protocol.ts (the schema half)
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A6-1 (four layers, one question each), §A6-2 (partial ⇒ whole range
//     again), §A3-2a (sample is the time base), §A7 (the field table)
//
// ── WHY FOUR AND NOT ONE ────────────────────────────────────────────────────
//
// §A6-1 records what a single key cost: keying on `(recordingId, range)` throws
// away a user's deliberate re-transcription as a duplicate, and adding `mode` to
// that key still cannot tell two same-mode attempts apart. So each layer answers
// exactly one question and none of them answers a second:
//
//   recordingId  — which sound is this
//   jobId        — which RESULT of that sound (range + variant); stable across
//                  retries, so every attempt at the same thing shares it
//   attemptId    — which try; new for every real recognition attempt
//   operationId  — which network send of that try; the same across re-sends
//
// 🔴 `jobId` IS DERIVED, NOT MINTED. Two runs of the app that resume the same
// range with the same variant must compute the same value or the whole 「same
// job ⇒ new version of one row」 rule collapses into 「every restart is a new
// row」. That is why it is a hash of the inputs and not a random id — and why
// `sha256` is used rather than a hand-rolled mixer: the value crosses a process
// boundary (it is written into a manifest and read back after a kill), so it has
// to be reproducible by a build that is not this one.
//
// 🔴 THE SERVER DOES NOT PARSE IT (04 §3.3-a). Nothing here may become a
// protocol-visible structure — the string is opaque on the wire and its shape
// belongs to this file alone.

import 'dart:convert';

import 'package:crypto/crypto.dart' show sha256;
import 'package:flutter/foundation.dart';

import '../audio/retained_audio_manifest.dart';

/// 04 §3.3-a `attempt_kind`.
///
/// 🔴 NO [RecoveryIdentity] MAY EVER CARRY [live]. A recovery that stamped it
/// would tell the server a person is standing there waiting, which is the one
/// thing the deferred-delivery ruling turns on. The microphone leg stamps it
/// through [liveStartFields] instead — a separate producer, in this file, so
/// the wire spelling still has exactly one home.
///
/// ⚠️ This block used to read 「`live` is deliberately ABSENT from this file's
/// producers」, which was true until card LS-1b needed the live press to name
/// its recording. What has not changed is the rule underneath it, so the rule
/// is what the sentence now states.
enum RecoveryAttemptKind {
  /// The ordinary press: a person is speaking into the microphone right now.
  /// Produced ONLY by [liveStartFields]; see the note above.
  live,

  /// Something we owe the user: an automatic retry of a failed recovery.
  autoRetry,

  /// The user pressed a button. 🔴 RESERVED FOR CARD RC-1b — this card has no
  /// UI, so nothing here produces it. Present because the backoff, the
  /// metering flag and the copy all branch on it and a two-valued enum added
  /// later is a two-valued enum somebody has to re-thread.
  userRetranscribe;

  /// The wire spelling (04 §3.3-a). Not `name`: the protocol is snake_case and
  /// a Dart rename must not silently move a wire value.
  String get wire => switch (this) {
        RecoveryAttemptKind.live => 'live',
        RecoveryAttemptKind.autoRetry => 'auto_retry',
        RecoveryAttemptKind.userRetranscribe => 'user_retranscribe',
      };
}

/// A half-open sample range `[startSample, endSample)` inside one recording.
///
/// 🔴 SAMPLES, NEVER MILLISECONDS AND NEVER `byteOffset / 6400` (§A3-2a). 6400
/// is the TRANSPORT frame size; a residual partial at the end of a recording is
/// shorter than that, so an offset derived by dividing by it is wrong for
/// exactly the stretch a recovery is most likely to be resuming.
@immutable
class RecoverySampleRange {
  const RecoverySampleRange(this.startSample, this.endSample);

  /// Convert a byte range in a PCM file to samples using that file's OWN
  /// format. Throws [ArgumentError] on a byte offset that is not a sample
  /// boundary — §A3-2a calls such an offset corrupt AS A COORDINATE, and
  /// rounding it would move the boundary of the audio a user gets back.
  factory RecoverySampleRange.fromBytes(
    JournalByteRange bytes,
    AudioJournalFormat format,
  ) {
    final int frame = format.bytesPerFrame;
    if (frame <= 0 || bytes.start % frame != 0 || bytes.end % frame != 0) {
      throw ArgumentError(
          'byte range $bytes is not aligned to ${format.bytesPerFrame}-byte frames');
    }
    return RecoverySampleRange(bytes.start ~/ frame, bytes.end ~/ frame);
  }

  final int startSample;
  final int endSample;

  int get lengthSamples => endSample - startSample;

  bool get isEmpty => endSample <= startSample;

  /// True when [next] starts exactly where this ends — the `range_boundary_
  /// continuity_test` property: adjacent ranges touch, never overlap and never
  /// leave a hole.
  bool joinsTo(RecoverySampleRange next) => next.startSample == endSample;

  bool overlaps(RecoverySampleRange o) =>
      startSample < o.endSample && o.startSample < endSample;

  @override
  bool operator ==(Object other) =>
      other is RecoverySampleRange &&
      other.startSample == startSample &&
      other.endSample == endSample;

  @override
  int get hashCode => Object.hash(startSample, endSample);

  @override
  String toString() => '[$startSample,$endSample)';
}

/// §A6-1 ② — 「which KIND of result does this range produce」.
///
/// Mode + spoken language + a digest of the processing preferences. Two
/// attempts that agree on all three are two tries at the SAME result and share
/// a job; a change in any of them is a different result the user may legitimately
/// want alongside the first, which is why the variant is inside the job key and
/// not compared separately anywhere.
@immutable
class RecoveryResultVariant {
  const RecoveryResultVariant({
    required this.mode,
    required this.sourceLang,
    required this.prefsDigest,
  });

  /// Read the variant out of a manifest's `configSnapshot` — the values as of
  /// the moment the microphone opened (§A6 R-5).
  ///
  /// Returns null when the snapshot does not carry them, which is the LEGACY
  /// case and is deliberately not papered over: `chat_inbound_routes.dart:43`
  /// reads the CURRENT spoken language, and substituting that silently is the
  /// very defect R-5 exists to close. The caller decides, and says so in its
  /// diagnostics.
  static RecoveryResultVariant? fromConfigSnapshot(Map<String, Object?> snap) {
    final Object? mode = snap[kConfigSnapshotMode];
    final Object? lang = snap[kConfigSnapshotSourceLang];
    if (mode is! String || mode.isEmpty || lang is! String || lang.isEmpty) {
      return null;
    }
    final Object? digest = snap[kConfigSnapshotPrefsDigest];
    return RecoveryResultVariant(
      mode: mode,
      sourceLang: lang,
      prefsDigest: digest is String ? digest : '',
    );
  }

  final String mode;
  final String sourceLang;
  final String prefsDigest;

  String get canonical => '$mode|$sourceLang|$prefsDigest';

  @override
  bool operator ==(Object other) =>
      other is RecoveryResultVariant && other.canonical == canonical;

  @override
  int get hashCode => canonical.hashCode;

  @override
  String toString() => 'variant($canonical)';
}

/// Manifest `configSnapshot` keys. One place, because the writer
/// (`ptt_edges.dart`'s `pttDown`, through `RetainedAudioSpill`) and the reader
/// (this file) are three directories apart and a typo between them degrades
/// silently into 「legacy session」.
const String kConfigSnapshotMode = 'mode';
const String kConfigSnapshotSourceLang = 'sourceLang';
const String kConfigSnapshotPrefsDigest = 'prefsDigest';

/// Build the snapshot written at recording time (§A6 R-5).
///
/// CALLER: `PttSessionEdges.pttDown` (ptt/ptt_edges.dart), immediately before
/// `audio.start()` — the one line that already holds all three values.
Map<String, Object?> recordingConfigSnapshot({
  required String mode,
  required String sourceLang,
  Map<String, Object?>? prefs,
}) =>
    <String, Object?>{
      kConfigSnapshotMode: mode,
      kConfigSnapshotSourceLang: sourceLang,
      kConfigSnapshotPrefsDigest: digestPrefs(prefs),
    };

/// Stable digest of a preference bundle. Keys are sorted, so two bundles that
/// differ only in insertion order are ONE variant — otherwise a rebuilt map
/// would fork a job on every launch.
String digestPrefs(Map<String, Object?>? prefs) {
  if (prefs == null || prefs.isEmpty) return '';
  final List<String> keys = prefs.keys.toList()..sort();
  final StringBuffer b = StringBuffer();
  for (final String k in keys) {
    b.write(k);
    b.write('=');
    b.write(jsonEncode(prefs[k]));
    b.write(';');
  }
  return sha256.convert(utf8.encode(b.toString())).toString().substring(0, 16);
}

/// 04 §3.3-a (b) — WHAT THIS ATTEMPT PUT ON `audio:start`, kept so the coverage
/// receipt's echo can be compared with what was SENT.
///
/// 🔴 NULL MEANS 「not sent」, AND IT IS COMPARED AS SUCH. The server echoes a
/// key only when the start frame carried one (`recoveryEchoOf` in
/// apps/server-core/src/engine/stt-session-receipt.ts), so a field this phone
/// never sent must come back absent. A value appearing where nothing was sent
/// is a server answering a question only the phone can answer, and [matches]
/// refuses it — the same direction the receipt's own doc argues for.
///
/// 🔴 WHY IT IS NOT ALWAYS FOUR VALUES, i.e. why the pin is not just 「the
/// range」. A recovery attempt knows its range before it opens the session (it
/// is resuming a stretch that is already on disk); a LIVE press does not — the
/// recording ends when the user lets go, which is long after `audio:start`. So
/// the live leg sends `range_start_sample: 0` and NO end, and this class is
/// what lets ONE predicate check both legs without either of them inventing a
/// number. Sending `range_end_sample: 0` instead would have been a lie the
/// server stores in `recovery_operations`.
@immutable
class StartEcho {
  const StartEcho({
    this.recordingId,
    this.attemptId,
    this.rangeStartSample,
    this.rangeEndSample,
  });

  final String? recordingId;
  final String? attemptId;
  final int? rangeStartSample;
  final int? rangeEndSample;

  /// True when the receipt echoed back EXACTLY these four values.
  ///
  /// Takes the four fields rather than a `CoverageReceipt` so this file does
  /// not have to import the stt layer: the comparison is between two sets of
  /// nullable identifiers, and neither side of it belongs to the receipt type.
  bool matches({
    String? recordingId,
    String? attemptId,
    int? rangeStartSample,
    int? rangeEndSample,
  }) =>
      recordingId == this.recordingId &&
      attemptId == this.attemptId &&
      rangeStartSample == this.rangeStartSample &&
      rangeEndSample == this.rangeEndSample;

  @override
  String toString() => 'StartEcho($recordingId/$attemptId '
      '[$rangeStartSample,$rangeEndSample))';
}

/// Card LS-1b — the LIVE press's half of 04 §3.3-a (a).
///
/// 🔴 FIVE KEYS, NOT EIGHT, AND EACH OMISSION IS A DECISION:
///   · `job_id` — nothing reads it for a live press. A job names 「which RESULT
///     of this sound」 so two attempts at the same thing can share a row; a live
///     press has exactly one attempt and no second version to reconcile with.
///   · `operation_id` — sending one ENGAGES THE SERVER'S IDEMPOTENCY REGISTRY
///     (`audio-start-operation.ts` returns early for a frame that names none),
///     which would put every ordinary press through a billing-adjacent path
///     built for re-sends that this leg never performs.
///   · `range_end_sample` — unknown when the session opens. See [StartEcho].
///
/// The three that ARE sent are the ones the settle predicate needs back:
/// [recordingId] and [attemptId] pin the receipt to this recording, and
/// `range_start_sample: 0` says the fed range starts at the first sample —
/// which is true of a live press by construction (the journal is opened by
/// `AudioCapture.start` and the first captured frame is its first byte).
///
/// CALLER: `PttSessionEdges.pttDown` (ptt/ptt_edges.dart), spread into the
/// `audio:start` payload exactly the way `beginBackfill` spreads
/// [RecoveryIdentity.toStartFields].
Map<String, Object?> liveStartFields({
  required String recordingId,
  required String attemptId,
  required int audioFormatVersion,
}) =>
    <String, Object?>{
      'recording_id': recordingId,
      'attempt_id': attemptId,
      'attempt_kind': RecoveryAttemptKind.live.wire,
      'range_start_sample': kLiveRangeStartSample,
      'audio_format_version': audioFormatVersion,
    };

/// The one sample a live press can name at `audio:start`. Named rather than
/// spelled `0` twice: [liveStartFields] sends it and the settle path builds the
/// [StartEcho] it will be compared against, and those are two files.
const int kLiveRangeStartSample = 0;

/// Everything one recovery attempt says about itself on `audio:start`.
@immutable
class RecoveryIdentity {
  const RecoveryIdentity({
    required this.recordingId,
    required this.jobId,
    required this.attemptId,
    required this.operationId,
    required this.attemptKind,
    required this.range,
    required this.audioFormatVersion,
  });

  /// Derive one. [attemptId] and [operationId] are supplied rather than minted
  /// here so a re-send can reuse the operation and a test can be deterministic;
  /// [jobId] is never supplied, because a caller that could pass it could pass
  /// a wrong one.
  factory RecoveryIdentity.forAttempt({
    required String recordingId,
    required RecoverySampleRange range,
    required RecoveryResultVariant variant,
    required String attemptId,
    required String operationId,
    required RecoveryAttemptKind attemptKind,
    required int audioFormatVersion,
  }) =>
      RecoveryIdentity(
        recordingId: recordingId,
        jobId: deriveJobId(
            recordingId: recordingId, range: range, variant: variant),
        attemptId: attemptId,
        operationId: operationId,
        attemptKind: attemptKind,
        range: range,
        audioFormatVersion: audioFormatVersion,
      );

  final String recordingId;
  final String jobId;
  final String attemptId;
  final String operationId;
  final RecoveryAttemptKind attemptKind;
  final RecoverySampleRange range;
  final int audioFormatVersion;

  /// What the settle predicate will compare the coverage receipt against.
  /// Derived from the identity rather than re-stated by the caller, so 「what
  /// we sent」 and 「what we expect back」 cannot drift apart.
  StartEcho get startEcho => StartEcho(
        recordingId: recordingId,
        attemptId: attemptId,
        rangeStartSample: range.startSample,
        rangeEndSample: range.endSample,
      );

  /// The eight additive optional keys of `AudioStartSchema` (04 §3.3-a).
  ///
  /// 🔴 IT DOES NOT CONTAIN `delivery`. That key is written by
  /// `beginBackfill` and is `none` unconditionally; letting an identity carry
  /// it would give one wire field two authors, and the one it would be wrong
  /// about is the one that decides whether a stale sentence lands on somebody's
  /// PC.
  Map<String, Object?> toStartFields() => <String, Object?>{
        'recording_id': recordingId,
        'job_id': jobId,
        'attempt_id': attemptId,
        'operation_id': operationId,
        'attempt_kind': attemptKind.wire,
        'range_start_sample': range.startSample,
        'range_end_sample': range.endSample,
        'audio_format_version': audioFormatVersion,
      };

  @override
  String toString() => 'RecoveryIdentity($recordingId job=$jobId '
      'attempt=$attemptId op=$operationId ${attemptKind.wire} $range)';
}

/// §A6-1 ② — the stable derivation. Documented as a FORMAT because a manifest
/// written by today's build is read by tomorrow's: changing the input order or
/// the separator forks every job in flight on the device.
///
/// 🔴 ITS PRODUCTION CALLER IS ONE HOP AWAY, and the anchor is here because a
/// grep for this name alone finds only tests and reads as dead code:
///   deriveJobId -> [RecoveryIdentity.forAttempt] (the only place a jobId is
///     ever produced; the constructor deliberately will not take one)
///     -> `recovery_journal_leg.dart`'s `_attempt`
///     -> [RecoveryIdentity.toStartFields] -> `ptt_backfill.dart`'s
///        `transport.emit(audioStart, …)`, as the wire key `job_id`.
/// Grep: grep -rn "forAttempt|toStartFields" apps/mobile/lib
/// Pinned: `pending_recovery_actions_test.dart` asserts `job_id` on the frame
/// that actually left the phone.
String deriveJobId({
  required String recordingId,
  required RecoverySampleRange range,
  required RecoveryResultVariant variant,
}) {
  final String canonical =
      'v1|$recordingId|${range.startSample}|${range.endSample}|${variant.canonical}';
  return sha256.convert(utf8.encode(canonical)).toString().substring(0, 32);
}
