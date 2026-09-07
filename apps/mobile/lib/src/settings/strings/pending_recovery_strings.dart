// AppStrings copy-catalogue shard: card RC-1b, the pending-recovery screen.
//
// SPEC-REF:
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md  (O-3, O-5, O-8, O-9)
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A8-1 P2-10 (the copy branches on what is actually possible),
//     §A6 R-2, §A7-3
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-b
//
// ── FIVE SENTENCES, AND WHY NOT ONE ─────────────────────────────────────────
//
// §A8-1 P2-10 is explicit: the recovery copy must branch by REAL CAPABILITY and
// must not 「写一句话糊三种状态」 (write one sentence to smear over three
// states). The five below are five different facts with five different next
// moves — wait / press the button / nothing, the words are already yours /
// nothing, this server cannot / nothing, you threw it away. Any merge answers
// two questions with one answer, which is this repo's headline bug shape.
//
// 🔴 WHAT NONE OF THEM MAY SAY, and each prohibition has a ruling behind it:
//   · 「needs manual sending」 / anything about the PC — owner ruling O-8 says
//     there is no send entry, and §A8-1 P2-10 ② forbids naming an action that
//     does not exist. Not one sentence here mentions a computer.
//   · 「it will take about …」 — nothing on this device knows how fast the
//     engine is (`articleBackfillPending` carries the same prohibition).
//   · a promise that the retry will work. [pendingRecoveryRetryNow] is an
//     invitation to try, and [pendingRecoveryRetryFailed] exists precisely
//     because the try can fail.
//   · an identifier, an error code, a tier letter or an attempt count — owner
//     2026-08-22: nothing internal reaches the screen. That is why
//     「the automatic attempts have stopped」 carries no number: the ceiling is
//     an owner ruling (five), not something the user chose or can change.
//
// 🔴 「等待转写」 ("waiting to be transcribed") IS ONLY ALLOWED BECAUSE IT IS
// REDEEMED. Book 15 §2.0-b bans naming a wait that no mechanism honours — the
// word was retired once, for exactly that reason, and came back when a
// persistent queue arrived. Here the queue is `RecoveryJournalLeg` and the
// promise is the manifest's own backoff schedule; the moment that runs out the
// sentence CHANGES to [pendingRecoveryStateNeedsManual], which stops promising
// and offers the button instead. The two sentences are the mechanism made
// visible, not two shades of the same one.

part of '../app_strings.dart';

mixin PendingRecoveryStrings on AppStringsLeaves {
  /// The screen's title, and the row that opens it. Deliberately the SAME
  /// sentence: a list entry and the page it leads to naming the same thing
  /// differently makes the user check whether they arrived somewhere else.
  String get pendingRecoveryTitle => _lfPendingRecoveryTitle;

  String get pendingRecoveryEntry => _lfPendingRecoveryEntry;

  /// The screen with nothing on it.
  ///
  /// Reachable: the last card can be deleted, or a recovery can land, while the
  /// page is open. It says 「nothing is waiting」 rather than 「no recordings」 —
  /// the phone may well hold recordings, and this page is not the place that
  /// would know.
  String get pendingRecoveryEmpty => _lfPendingRecoveryEmpty;

  /// The queue owes this one an attempt and will make it.
  String get pendingRecoveryStateWaiting => _lfPendingRecoveryStateWaiting;

  /// Owner ruling O-9: the automatic budget is spent.
  ///
  /// 🔴 IT MUST NOT READ AS A FAILURE. Nothing was lost — the audio is here and
  /// a route remains. It also must not read as a reprimand: the reason the
  /// automatic route stopped is our ceiling, not the user's doing.
  String get pendingRecoveryStateNeedsManual =>
      _lfPendingRecoveryStateNeedsManual;

  /// Audit A5-3 — words exist, the proof does not.
  ///
  /// 🔴 BOTH HALVES ARE LOAD-BEARING. 「Transcribed」 alone would invite the
  /// user to delete audio we are keeping for a reason; 「could not confirm」
  /// alone would suggest the words are missing when they are already in the
  /// timeline. The audit's own wording is 「完整性未知」 — completeness unknown.
  String get pendingRecoveryStateUnverified =>
      _lfPendingRecoveryStateUnverified;

  /// A7-3 TIER B — the words came back complete, and the audio is kept anyway.
  ///
  /// 🔴 IT IS NOT [pendingRecoveryStateUnverified], AND THE DIFFERENCE IS THE
  /// WHOLE REASON IT EXISTS. That sentence says 「we could not confirm it was
  /// complete」, which is true when a receipt was missing, mismatched or short.
  /// On tier B the receipt was fine and every condition passed: the ONLY
  /// refusal was that this server version is not one we let license a delete
  /// (`RecoverySettleRefusal.serverTierKeepsBytes`). Telling that user their
  /// transcription might be incomplete is a claim about their words that
  /// nothing measured — R11 in one sentence.
  ///
  /// ⚠️ It names the SERVER and offers nothing to press, like the tier-C
  /// sentence, because there is nothing the person can do about it and
  /// pretending otherwise would be worse than saying so.
  String get pendingRecoveryStateServerKeepsAudio =>
      _lfPendingRecoveryStateServerKeepsAudio;

  /// A5-4 - the engine answered and produced no words.
  ///
  /// 🔴 IT MUST NOT READ AS A FAILURE OF THE RECORDING. Nothing is
  /// wrong with the audio and nothing was lost; the sentence states what came
  /// back (nothing) and then where the audio is, because the person is looking
  /// at a screen whose whole job is deciding what to delete.
  ///
  /// ⚠️ It does not name a cause. A quiet room, a muted microphone and
  /// a broken engine are indistinguishable from here, and each guess would be
  /// wrong two thirds of the time - the same reasoning
  /// [pendingRecoveryStateUnreadable] gives. The card offers a retry, which is
  /// the honest answer to all three.
  String get pendingRecoveryStateEmptyResult =>
      _lfPendingRecoveryStateEmptyResult;

  /// A7-3 tier C.
  ///
  /// 🔴 IT NAMES THE SERVER, NOT THE USER AND NOT THE RECORDING. Nothing here
  /// is wrong with the audio, and there is nothing to press — so the sentence
  /// states the condition and then says where the audio is, which is the one
  /// thing the person in front of it actually wants to know (§A8: every warning
  /// must also answer 「where is that audio now」).
  ///
  /// ⚠️ It does not say 「wait for an upgrade」 either: we cannot promise one.
  String get pendingRecoveryStateServerUnsupported =>
      _lfPendingRecoveryStateServerUnsupported;

  /// Owner ruling O-5 — the user cancelled it and the bytes were kept anyway.
  ///
  /// 🔴 THE KEEPING HAS TO BE SAID OUT LOUD. A person who cancels a recording
  /// reasonably assumes it is gone; it is not, and a screen that listed it
  /// without explaining why would look like the cancel had failed. The second
  /// half also names the only thing that removes it, because that is the whole
  /// reason the ruling asked for this list.
  String get pendingRecoveryStateCancelled =>
      _lfPendingRecoveryStateCancelled;

  /// Owner ruling O-2 — audio this build cannot read: PCM with no manifest, a
  /// manifest that would not parse, or a capture format this build cannot
  /// feed.
  ///
  /// 🔴 THE SECOND HALF IS WHY THE SENTENCE EXISTS. Before it, none of these
  /// were listed at all: they were skipped by this screen AND by the recovery
  /// queue, while still counting against the retention cap — so the phone held
  /// audio that nothing could name and nobody could remove. The sentence says
  /// the two things the person can act on: it will not become words, and it is
  /// costing space until they delete it.
  ///
  /// ⚠️ It names no cause. 「Cannot be read」 is the whole of what this build
  /// knows; a missing manifest, an unparseable one and a format from another
  /// build are indistinguishable from where the user stands, and each of the
  /// three guesses would be wrong two thirds of the time.
  String get pendingRecoveryStateUnreadable =>
      _lfPendingRecoveryStateUnreadable;

  /// Card FX-1 — a stretch of this recording never reached the disk.
  ///
  /// 🔴 IT IS A SECOND LINE, NOT A NINTH STATE. Every sentence in the switch
  /// above answers 「what is happening to this recording」 and exactly one of
  /// them is true at a time; this answers a different question — 「is all of it
  /// here」 — and it can be true alongside any of them. Folding it into the
  /// state would force a choice between telling the user their audio is
  /// incomplete and telling them what is being done about it.
  ///
  /// ⚠️ SAME §A9 P1-1 ④ CONSTRAINT as the banner sentence: 「part of」, never
  /// 「nothing since」. What is left is real audio and a retry can still turn it
  /// into words — that is why this line does not remove the retry button.
  ///
  /// MEASURED 2026-09-06 (drill D-5b): 26.5 s of a 30.2 s press never reached
  /// the disk, the card said 「3s · Waiting for the next automatic attempt」 and
  /// nothing anywhere said the rest was gone.
  String get pendingRecoveryPartlySaved => _lfPendingRecoveryPartlySaved;

  /// [PendingDeleteOutcome.failed] — the file would not go.
  ///
  /// 🔴 IT SAYS WHERE THE AUDIO IS, like every other sentence on this screen.
  /// The person just confirmed a destructive dialog; 「could not be deleted」
  /// alone leaves them unsure whether half of it went.
  String get pendingRecoveryDeleteFailed => _lfPendingRecoveryDeleteFailed;

  /// §A6 R-2's button.
  ///
  /// 「Try」, never 「transcribe this」: the attempt can be refused by the FSM,
  /// refused by the gate, or simply not land. A label that promised the result
  /// would be a promise made by the one layer that cannot keep it.
  String get pendingRecoveryRetryNow => _lfPendingRecoveryRetryNow;

  /// [PendingRetryOutcome.refusedBusy] — a press is holding the microphone.
  String get pendingRecoveryRetryBusy => _lfPendingRecoveryRetryBusy;

  /// [PendingRetryOutcome.failed] — it ran and did not land.
  ///
  /// 🔴 THE SECOND HALF IS THE POINT. 「It failed」 on a screen about audio
  /// durability reads as 「your recording is gone」; the sentence exists to say
  /// the opposite, which is also what actually happened (a failed attempt
  /// deletes nothing — `recovery_journal_leg.dart`'s settle rules).
  String get pendingRecoveryRetryFailed => _lfPendingRecoveryRetryFailed;

  /// The confirm sheet. It names the object; the body names the consequence.
  String get pendingRecoveryDeleteTitle => _lfPendingRecoveryDeleteTitle;

  /// 🔴 IT STATES WHAT IS LOST AND DOES NOT SOFTEN IT. `confirmDestructive`'s
  /// own doc: a confirm that only asks 「are you sure?」 makes the user guess at
  /// what they are agreeing to. This delete really is total for that recording,
  /// so it gets no reassurance panel either.
  String get pendingRecoveryDeleteBody => _lfPendingRecoveryDeleteBody;

  /// The tap target on the retained-audio banner.
  ///
  /// One word, because it sits inside a banner that has already said the thing
  /// — and it appears only when there is in fact something to show
  /// (`BackfillProgress.hasKeptAudio`).
  String get pendingRecoveryBannerAction => _lfPendingRecoveryBannerAction;
}
