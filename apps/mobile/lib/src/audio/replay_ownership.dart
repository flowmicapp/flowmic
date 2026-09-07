// Card RC-1a (audit P1-2) - WHO IS ALLOWED TO PUT A STRETCH OF AUDIO ON THE
// WIRE RIGHT NOW.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     E45 (the reconnect replay re-sends the WHOLE 30 s ring with no notion of
//     whether anything else is already sending those bytes), A4's corrected
//     replay rules, A9 stage 1's reconnect.dart row (P1-2)
//   apps/mobile/lib/src/signaling/reconnect.dart - `_replayBuffered`
//   apps/mobile/lib/src/session/recovery_journal_leg.dart - the claimant
//
// 🔴 THE ONE SENTENCE THAT DECIDES HOW THIS CLASS IS ALLOWED TO BE USED, from
// A4's own R3 correction: 「a single send owner solves CONCURRENCY only. It is
// NOT a delete criterion and NOT a proof of delivery.」 A claim says somebody
// STARTED sending; it says nothing about whether the server received anything.
// Deleting on a claim, or declining to re-send because of one after the sender
// has gone, are both the mistake this file exists to prevent - which is why
// nothing here is readable by recovery_settle.dart and why a claim is released
// in a `finally`.
//
// ── WHAT IT ACTUALLY DOES, MINIMALLY AND HONESTLY ───────────────────────────
//
// With the journal face OFF - every build shipped today - it answers `true` to
// everything and the reconnect replay behaves byte for byte as it always has.
// That is deliberate: the overlap it guards against cannot happen while the
// journal leg cannot run.
//
// With the journal face ON it refuses the ring replay in exactly two states:
//
//   ① the recorder has STOPPED (the link died and the session layer judged the
//      recording over locally) and the recovery leg has CLAIMED that recording.
//      The journal holds those same bytes and a recovery attempt is feeding
//      them back under a proper `audio:start` with a range and an attempt id;
//      the ring replay would put the same samples on the same socket with no
//      identity at all;
//   ② there is no evidence the ORIGINAL server session survived. The replay's
//      own comment says its premise is that the session lived through its grace
//      window; when the reconnect ack carries no `audio_last_contiguous_seq`
//      there is nothing saying it did, and A4 is explicit that new bytes must
//      not be handed to a session that may not exist. The recovery leg is the
//      path that negotiates a fresh attempt, and it is already running.
//
// 🔴 IN BOTH CASES THE BYTES ARE NOT LOST AND NOT DELETED. The journal has
// them; refusing here only decides WHO sends them.

import 'package:flutter/foundation.dart';

/// Which recordings a recovery attempt is currently feeding back.
///
/// One instance per [RetainedAudioSpill] (it is the object that owns the
/// journal, and both parties - the leg and the reconnect ladder - can already
/// reach it). Claims are held for the duration of ONE attempt and released in
/// a `finally`, so a crashed attempt cannot leave a permanent refusal behind.
class ReplayOwnership {
  final Set<String> _claims = <String>{};

  /// WRITER: `RecoveryJournalLeg._attempt`, immediately before the first
  /// `audio:start` of an attempt.
  void claim(String recordingId) => _claims.add(recordingId);

  /// WRITER: `RecoveryJournalLeg._attempt`'s `finally`.
  void release(String recordingId) => _claims.remove(recordingId);

  bool get anyClaimed => _claims.isNotEmpty;

  @visibleForTesting
  Set<String> get claims => Set<String>.unmodifiable(_claims);
}

/// Why a replay was refused. Named so the diagnostic can say which of the two
/// states it was - they have different remedies and one of them is a bug
/// elsewhere if it persists.
enum ReplayRefusal {
  /// A recovery attempt owns these bytes right now.
  claimedByRecovery,

  /// Nothing says the original server session is still there.
  noServerSession,
}

/// The gate `ReconnectCoordinator` consults before re-emitting the ring.
///
/// [journalFaceOn] false ⇒ always null (allowed), which is today's product.
ReplayRefusal? replayRefusalFor({
  required bool journalFaceOn,
  required ReplayOwnership? ownership,
  required bool recorderRunning,
  required int? serverAudioWatermark,
}) {
  if (!journalFaceOn || ownership == null) return null;
  // A recording still running is LIVE audio on a socket that just came back:
  // the ring replay is the mechanism that catches it up and nothing else is
  // sending it. Refusing here would lose the very thing GA-04M added.
  if (!recorderRunning && ownership.anyClaimed) {
    return ReplayRefusal.claimedByRecovery;
  }
  // 🔴 ABSENT IS NOT ZERO. The watermark is the only thing on the ack that
  // says the server still has this audio session; when it is missing, the
  // ladder's own premise is unproven. -1 IS a statement (「I have observed
  // nothing yet」) and is therefore allowed through.
  if (!recorderRunning && serverAudioWatermark == null) {
    return ReplayRefusal.noServerSession;
  }
  return null;
}
