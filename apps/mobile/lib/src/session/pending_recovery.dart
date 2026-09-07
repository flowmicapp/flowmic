// Card RC-1b - WHAT THE USER IS SHOWN ABOUT AUDIO THAT IS STILL ON THIS PHONE.
//
// SPEC-REF:
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md  (O-3 no playback/export, O-5 cancelled audio is kept and
//     only the user may delete it, O-8 no 「send to PC」 entry, O-9 five
//     automatic attempts then it is the user's move)
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A6 R-2 (a manual retry must EXIST), §A7-3 (the three server classes),
//     §A8-1 P2-10 (the copy branches on what is actually possible)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-b
//   apps/mobile/lib/src/session/pending_recovery_store.dart (the real source)
//   apps/mobile/lib/src/ui/pending_recovery_page.dart (the screen)
//
// ── WHY THIS IS A VALUE LAYER WITH NO I/O IN IT ─────────────────────────────
//
// The screen has to answer one question per recording - 「what is happening to
// this, and what may I do about it」 - and the answer comes from four places
// that do not know about each other: the manifest's persisted queue state, the
// A7-3 server tier, the O-5 cancel tombstone, and whether a press is holding
// the microphone right now. Resolving them inside a widget would put the
// product's rules in a `build`, where nothing can test them and where the next
// state has to be threaded through a constructor.
//
// 🔴 EVERY STATE BELOW EXISTS BECAUSE ITS SENTENCE IS DIFFERENT FROM THE OTHER
// FOUR, and 15 册 §2.0-b is what makes that non-negotiable: a word like
// 「待转录」 ("waiting to be transcribed") is only allowed to appear because the
// journal plus this queue actually redeem it. Collapsing 「the server cannot do
// this safely」 into 「waiting」 would turn a permanent condition into a promise
// nothing keeps - the exact shape that ruling was coined to ban.

import 'package:flutter/foundation.dart';

/// Which sentence a recording gets, and which actions it may offer.
///
/// 🔴 THE ORDER IS THE PRECEDENCE ORDER used by [PendingRecoveryStore] when a
/// recording qualifies for more than one - most specific first. A recording the
/// user threw away is described as thrown away even if the server is also old,
/// because the two facts lead to different actions and only one of them is
/// about something the user did.
enum PendingRecoveryState {
  /// Owner ruling O-5. The user cancelled it; the bytes are kept and are never
  /// fed back on their own. The only action is [PendingRecoveryAction.delete] -
  /// offering a retry here would resurrect a sentence somebody deliberately
  /// threw away, which is the defect card LS-4 closed.
  cancelled,

  /// Audit A5-3. Words were produced and no complete proof came back with
  /// them. Kept, never automatically retried (the user already has the words),
  /// and delete is the only thing left to do.
  settledUnverified,

  /// A7-3 tier B. The words came back and the receipt was complete; the audio
  /// is kept because this server version is not one we let license a delete.
  ///
  /// 🔴 SPLIT OUT OF [settledUnverified] BECAUSE THAT SENTENCE WAS A CLAIM
  /// ABOUT THE USER'S WORDS. Both states are 「transcribed, bytes kept」 in the
  /// manifest, but one of them means 「we could not confirm it was complete」
  /// and the other means 「it WAS complete, and we keep audio for this server
  /// anyway」. Routed on the settle's own refusal code, so the two cannot
  /// drift apart. Delete is the only action either way.
  settledServerKeepsAudio,

  /// A5-4 - the engine answered, and answered with nothing.
  ///
  /// 🔴 IT IS NOT [settledUnverified], AND THE DIFFERENCE IS WHAT THE USER
  /// MAY DO NEXT. That state means "the words are already yours and we cannot
  /// prove the audio was complete", so a retry would only re-transcribe words
  /// the user has. Here there are NO words: the recording is still owed a
  /// transcription, and a retry against a working engine may legitimately
  /// produce one. So this is the one settled-but-kept state that offers
  /// [PendingRecoveryAction.retryNow].
  ///
  /// MEASURED 2026-09-06 (drills B-7 / B-1 run 2 / D-7): before it existed an
  /// empty terminal final took the same road as a real transcript and the audio
  /// was deleted - 2.8 s, then 40 s, then 18.4 MiB.
  emptyResult,

  /// A7-3 tier C. Not one `audio:start` may be sent to this server, so there is
  /// no retry to offer - a button here would be refused by
  /// `recovery_gate.dart` every time it was pressed.
  serverUnsupported,

  /// Owner ruling O-9. The five automatic attempts are spent. The audio is
  /// still here and the user's own attempt is the route that remains - §A6 R-2
  /// is the whole reason this screen exists.
  needsManual,

  /// The ordinary case: the queue owes this recording an attempt and will make
  /// one on its own.
  waitingAuto,

  /// 🔴 OWNER RULING O-2 — audio we cannot read still counts against the cap,
  /// so it has to be visible and it has to be deletable.
  ///
  /// PCM with no manifest, a manifest this build could not parse (quarantined),
  /// or a manifest whose capture format this build cannot feed
  /// (`formatMismatch`). All three mean the same thing to the person holding
  /// the phone — 「we cannot read this」 — and none of them can be transcribed,
  /// so the only action is [PendingRecoveryAction.delete].
  ///
  /// ⚠️ IT IS NOT PART OF [PendingRecoveryStore]'s precedence chain. The four
  /// states above are decided from a manifest that WAS read; this one is
  /// decided by the scan before there is anything to apply precedence to.
  ///
  /// 🔴 WHY IT EXISTS AT ALL: until it did, these recordings were skipped by
  /// the list AND by `RecoveryJournalLeg._scanCandidates`, which made them
  /// invisible and undeletable while still occupying the cap — an orphan
  /// nothing on the device could name, which ruling O-2 calls a defect.
  unreadable,
}

/// What a card may offer. Deliberately NOT a bag of booleans on the item: the
/// three forbidden actions (play, export, send to PC - O-3 / O-8) are absent by
/// having no name here at all, which is stronger than a `false`.
enum PendingRecoveryAction {
  /// §A6 R-2, `RecoveryAttemptKind.userRetranscribe`.
  retryNow,

  /// Owner ruling O-5's only sanctioned deletion path.
  delete,
}

/// One recording, as this screen sees it.
@immutable
class PendingRecoveryItem {
  const PendingRecoveryItem({
    required this.id,
    required this.state,
    required this.durationMs,
    required this.legacy,
    this.recordedAtMs,
    this.partlySaved = false,
  });

  /// The journal `recordingId`, or the legacy store's session key.
  ///
  /// 🔴 NEVER RENDERED. It is an internal identifier and owner's 2026-08-22
  /// rule is that no internal vocabulary reaches the screen; it is here so an
  /// action can name the thing it is acting on.
  final String id;

  final PendingRecoveryState state;

  /// How much audio this is, measured from the verified recoverable range.
  ///
  /// ⚠️ MEASURED, NOT ESTIMATED, and it is not a prediction of how long a
  /// recovery would take - nothing on this device knows that. Same rule as
  /// `articleBackfillPending`.
  final int durationMs;

  /// When the recording was made, or null when this build cannot tell.
  ///
  /// 🔴 NULL IS RENDERED AS ABSENCE, NEVER AS A GUESS. See
  /// [recordedAtMsFromId] for where the value comes from and why it can fail.
  final int? recordedAtMs;

  /// Card FX-1 — the manifest records at least one hole, or an `io_error`
  /// interrupt: a stretch of this recording was never written to this phone.
  ///
  /// 🔴 ORTHOGONAL TO [state] ON PURPOSE. 「how much of it is here」 and 「what is
  /// happening to it」 are two questions, and the answer to the second one does
  /// not change because of the first: a partly saved recording is still owed an
  /// attempt, and the attempt can still succeed on what is left. Making it a
  /// ninth [PendingRecoveryState] would have put the two answers in one value —
  /// this repo's headline defect shape.
  ///
  /// ⚠️ FALSE IS NOT A PROMISE. It means 「this manifest records no hole」, and a
  /// manifest that could not be written records nothing (drill D-5b, and
  /// `ManifestRepublishQueue` for what now happens instead). Absence of a hole
  /// is not proof of completeness and no copy on this screen says it is.
  final bool partlySaved;

  /// True for audio written by the pre-journal storage face.
  ///
  /// It changes exactly one thing the user could notice: a legacy recording has
  /// no manifest, so it carries no attempt history and no per-recording queue
  /// state - the automatic route retries it on every edge and no budget is
  /// spent. It therefore never reaches [PendingRecoveryState.needsManual].
  final bool legacy;

  /// 🔴 THE ONE PLACE THAT DECIDES WHICH BUTTONS EXIST. A widget that decided
  /// this for itself would be a second author of the rule, and the two would
  /// drift the first time a state was added.
  Set<PendingRecoveryAction> get actions => switch (state) {
        // O-5 / A5-3: the words are either unwanted or already in hand. Delete
        // is the whole offer.
        PendingRecoveryState.cancelled ||
        PendingRecoveryState.settledUnverified ||
        PendingRecoveryState.settledServerKeepsAudio =>
          const <PendingRecoveryAction>{PendingRecoveryAction.delete},
        // A7-3 tier C: `evaluateRecoveryGate` would refuse every press, so the
        // button is absent rather than present-and-futile (R8).
        PendingRecoveryState.serverUnsupported =>
          const <PendingRecoveryAction>{PendingRecoveryAction.delete},
        // O-2: nothing here can be fed to an engine — there is no readable
        // range and no format to feed it in. Delete is the only honest offer,
        // and it is the reason this state is listed at all.
        PendingRecoveryState.unreadable =>
          const <PendingRecoveryAction>{PendingRecoveryAction.delete},
        // 🔴 AND ONLY WHEN THERE IS SOMETHING FOR THE BUTTON TO DRIVE. The
        // legacy storage face has no per-recording entry into the recovery
        // leg — a press would have to sweep everything, which means a button
        // on THIS card transcribing some OTHER recording. Its automatic route
        // needs no rescue anyway: with no manifest there is no attempt budget,
        // so the sweep re-reads it on every edge and it never gets stuck at
        // 「no attempts left」. Withheld rather than drawn-and-inert (R8).
        // A5-4: nothing was transcribed, so the recording is still owed one and
        // the button has something real to drive. Same legacy caveat as below.
        PendingRecoveryState.emptyResult ||
        PendingRecoveryState.needsManual ||
        PendingRecoveryState.waitingAuto =>
          legacy
              ? const <PendingRecoveryAction>{PendingRecoveryAction.delete}
              : const <PendingRecoveryAction>{
                  PendingRecoveryAction.retryNow,
                  PendingRecoveryAction.delete,
                },
      };

  @override
  String toString() =>
      'PendingRecoveryItem($id ${state.name} ${durationMs}ms legacy=$legacy)';
}

/// What happened when the user pressed 「try again now」.
///
/// 🔴 EVERY ARM IS A DIFFERENT SENTENCE AND A DIFFERENT NEXT MOVE. A single
/// bool would have to be rendered as 「it didn't work」, which answers neither
/// 「why」 nor 「what do I do」 - R11 in its plainest form.
enum PendingRetryOutcome {
  /// An attempt ran to a terminal outcome. 🔴 NOT 「it worked」: the settle
  /// rules (A5-3) may still have kept the bytes, and the screen therefore
  /// re-reads its list rather than announcing a success it cannot see. What
  /// this arm rules out is the two refusals and the throw.
  done,

  /// The FSM refused: a press holds the session, or the link is down. Nothing
  /// was sent.
  ///
  /// 🔴 THIS COMES FROM THE REAL GATE (`PttSession.beginBackfill`), not from a
  /// check this layer made first. The screen also hides the button while a
  /// recording is running, but that is a courtesy - the gate is the authority,
  /// because it is the thing that would be wrong to disagree with.
  refusedBusy,

  /// A7-3 tier C: the server may not be asked. Nothing was sent.
  refusedServer,

  /// The attempt ran and did not finish. The bytes are still here.
  failed,

  /// There is no recovery channel on this build at all (no retained-audio
  /// layer). Stated rather than shown as a failure: nothing went wrong.
  unavailable,
}

/// What happened when the user confirmed 「delete」.
///
/// 🔴 IT IS AN OUTCOME AND NOT A `void`, AND THAT IS THE WHOLE OF Z1. The
/// delete used to swallow a failed file removal into a diag line and then
/// remove the manifest anyway: the PCM stayed on disk, the scan reported it as
/// `manifestMissing`, every reader skipped it — and it went on counting
/// against the cap (owner ruling O-2) with nothing on the device able to name
/// it or remove it. A caller that cannot be told 「that did not work」 cannot
/// say so, and 「the card is still there」 is not a sentence, it is a shrug.
enum PendingDeleteOutcome {
  /// Every byte this recording owned is off the disk.
  done,

  /// At least one file could not be removed. NOTHING further was deleted —
  /// see [PendingRecoverySource.delete] for why stopping is the safe half.
  failed,
}

/// Where the screen gets its list and where its two actions go.
///
/// An interface so the page can be mounted over a fake in a widget test - the
/// production implementation touches the filesystem, the socket and the FSM,
/// and none of those belong in a copy test.
abstract class PendingRecoverySource {
  /// Everything on this phone the user may be told about, newest first.
  Future<List<PendingRecoveryItem>> list();

  /// §A6 R-2. Mints a NEW attempt stamped
  /// `RecoveryAttemptKind.userRetranscribe`.
  Future<PendingRetryOutcome> retryNow(PendingRecoveryItem item);

  /// Owner ruling O-5's deletion. Removes the audio bytes and the record of
  /// them; there is no undo and the confirm sheet says so.
  ///
  /// 🔴 IT STOPS AT THE FIRST FILE IT COULD NOT REMOVE, and the order is PCM
  /// first. Carrying on would delete the manifest of a recording whose audio is
  /// still there, which is precisely how an invisible, undeletable orphan is
  /// made (see [PendingDeleteOutcome]). Stopping leaves the card exactly where
  /// it was, so the next press tries the same file again.
  Future<PendingDeleteOutcome> delete(PendingRecoveryItem item);

  /// Whether a recording is running right now.
  ///
  /// ⚠️ A COURTESY, NOT A GATE - see [PendingRetryOutcome.refusedBusy].
  bool get recordingNow;
}

/// The recording time carried by the identifier itself, or null.
///
/// 🔴 IT IS PARSING AN ID, AND THAT IS SAID OUT LOUD RATHER THAN HIDDEN.
/// Neither storage face records a wall-clock 「recorded at」: `RecordingManifest`
/// has no such field and the legacy face has no manifest at all. What both DO
/// have is an identifier minted from a clock at the moment capture opened:
///
///   · journal — `retained_audio_spill.dart` `beginRecording`:
///     `'${_store.sessionKey}-r${_clock()}'`, whose default `_clock` is
///     `_wallClock() => DateTime.now().microsecondsSinceEpoch` — MICROseconds;
///   · legacy  — `retained_audio_store.dart` `_defaultSessionKey`:
///     `'run-${DateTime.now().microsecondsSinceEpoch}'`, MICROseconds.
///
/// 🔴 BOTH ARE MICROSECONDS. This doc used to say the `-r` half was
/// milliseconds and the parser believed it, so every journal recording rendered
/// with a date about 56,000 years out. MEASURED 2026-09-06 (drill D-2):
/// `run-1788670774204536-r1788670774204592` — the two halves are 56 µs apart,
/// i.e. the SAME clock, and reading the second as milliseconds gives year
/// ~58,600.
///
/// ⚠️ NOBODY SAW THE ABSURDITY, WHICH IS THE POINT. The card renders it with
/// `MaterialLocalizations.formatMediumDate` — weekday, month, day, NO YEAR — so
/// a 56,000-year error reads as an ordinary "Sat, Sep 21" on the one screen
/// whose job is deciding what to delete. A wrong date that looks right is worse
/// than none, which is what the paragraph below is about.
///
/// 🔴 ANY SHAPE IT DOES NOT RECOGNISE RETURNS NULL AND THE CARD OMITS THE LINE.
/// A fabricated 「just now」 on a week-old recording is the fabricated-zero this
/// repo's red line forbids. `pending_recovery_page_test.dart` pins both shapes
/// and the refusal, so a change to either minting site fails here rather than
/// on somebody's screen.
int? recordedAtMsFromId(String id) {
  final int r = id.lastIndexOf('-r');
  if (r >= 0) {
    final int? us = int.tryParse(id.substring(r + 2));
    if (us != null && us > 0) return us ~/ 1000;
  }
  if (id.startsWith('run-')) {
    final int? us = int.tryParse(id.substring(4));
    if (us != null && us > 0) return us ~/ 1000;
  }
  return null;
}
