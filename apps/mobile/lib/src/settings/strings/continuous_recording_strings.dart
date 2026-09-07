// AppStrings copy-catalogue shard: card CR-9 — the continuous (long-form)
// recording entry, its pre-flight sheet, its live face, and the single
// pre-ceiling reminder.
//
// Split out of `compose_strings.dart` for the file-size cap (S5, 2026-09-05
// audio-durability pass: that file was 799 lines, past the 700-line target
// after the last lane's `continuousEntry*Note` getters), the same way
// `RecordingRetentionStrings` was split out of `recording_strings.dart` a
// card earlier. Moved verbatim, comments included — this shard holds copy
// and its reasoning only.
part of '../app_strings.dart';

mixin ContinuousRecordingStrings on AppStringsLeaves {
  // ── Card CR-9 — the continuous-recording entry (demo cells A-1 / A-2) ─────
  //
  // It stands where the PC key group would be on an inject destination, in the
  // one dock that has no PC focus to act on. `ContinuousOffer`
  // (audio/continuous_offer.dart) decides which of these is drawn; this shard
  // only owns the words.

  /// The entry's own label. Names what the user gets — a recording that can run
  /// for a long time — rather than the mechanism behind it.
  String get continuousEntryTitle => _lfContinuousEntryTitle;

  /// Sub-line when the per-session ceiling is known and the month's balance is
  /// NOT (§5-2 「读不到就不画」).
  ///
  /// 🔴 IT SAYS ONE THING AND STOPS. The rule this obeys was set by
  /// `quota_gauge.dart`: an end of the meter we could not read is an end we do
  /// not draw. Printing 「还剩 0 分」 for a balance we never received would be a
  /// claim we do not have, and softening the whole line into 「额度有限」 would
  /// throw away the number we DO have.
  String continuousEntryCap(Object? minutes) => _lfContinuousEntryCap(minutes);

  /// Sub-line when both numbers are known — 「最多 X 分 · 本月还剩 Y 分」.
  ///
  /// 🔴 TWO NUMBERS, TWO QUESTIONS, AND OWNER'S RULING ⑭ KEEPS THEM APART. The
  /// ceiling answers 「how long may this sitting be」 and the balance answers
  /// 「how much of the month is left」; free is 20 minutes a month against a
  /// 10-minute ceiling, so one blended figure would be wrong in both directions
  /// at once.
  ///
  /// ⚠️ Both digits are INTERPOLATED, not baked into nine translations — and
  /// the ceiling is the same value that arms the stop timer, so the button and
  /// the enforcement can never disagree. `recordingStoppedContinuousCap` carries
  /// no digits for the mirror-image reason: it has no way to read them.
  String continuousEntryCapAndLeft(Object? minutes, Object? left) =>
      _lfContinuousEntryCapAndLeft(minutes, left);

  /// Owner ruling (2026-09-02) — a signed-out phone gets this INSTEAD of
  /// [continuousEntryModeNote] or [continuousEntryNoCeilingNote], because long-
  /// form recording lives only inside Light Records and Light Records require
  /// a cloud account. Tells the user the one step that unblocks it — sign in —
  /// rather than a generic 「不可用」.
  String get continuousEntrySignInNote => _lfContinuousEntrySignInNote;

  /// A-2 — why the entry is dimmed under translate / organize.
  ///
  /// Says which mode DOES work, because that is the step the user can take: the
  /// mode chip is on the same screen. A bare 「不可用」 would turn a block they
  /// can clear in one tap into a dead end — the `INJECT_NO_ACCESSIBILITY`
  /// argument, in a place with no error code.
  String get continuousEntryModeNote => _lfContinuousEntryModeNote;

  /// SIGNED IN, and the ceiling still could not be read — see
  /// `ContinuousBlock.ceilingUnknown`'s doc for why this is now a narrower
  /// claim than it used to be.
  ///
  /// ⚠️ It names the account, not the network, because the account is what the
  /// user can check. It no longer needs to hedge between 「not signed in」 and
  /// 「signed in, and the server did not answer」 (2026-09-02): `continuousOffer`
  /// now takes sign-in as its own explicit fact and answers that question with
  /// [continuousEntrySignInNote] instead, so reaching this string already means
  /// the account is real.
  String get continuousEntryNoCeilingNote => _lfContinuousEntryNoCeilingNote;

  /// The three NAMED account refusals the ceiling read can answer with, split
  /// out of [continuousEntryNoCeilingNote] because that sentence asked for a
  /// retry that cannot work. `ContinuousBlock.emailNotVerified` /
  /// `.accountRestricted` / `.sessionExpired` carry the measurement and the
  /// reason the restricted one deliberately names no action.
  String get continuousEntryVerifyEmailNote => _lfContinuousEntryVerifyEmailNote;
  String get continuousEntryRestrictedNote => _lfContinuousEntryRestrictedNote;
  String get continuousEntrySessionExpiredNote =>
      _lfContinuousEntrySessionExpiredNote;

  /// The month's transcription minutes are gone.
  ///
  /// ⚠️ NOT ONE DIGIT AND NOT ONE TIER NAME, exactly as
  /// [recordingAutoStoppedQuota] carries none and for the same reason: the
  /// per-plan numbers live in `billing/plans.ts`, and a copy of them here is a
  /// third copy that goes stale in silence.
  String get continuousEntryQuotaSpentNote => _lfContinuousEntryQuotaSpentNote;

  // ── Card CR-9 — the pre-flight sheet (demo cells B-1 / B-2) ──────────────
  //
  // 🔴 A BRIEFING, NOT A CONFIRM, AND THE TWO MUST NOT BE MERGED LATER.
  // `confirmDestructive` exists for actions that destroy something and its own
  // header refuses to be used more widely: 「a confirm on everything trains
  // people to tap through confirms, which is how the one that mattered gets
  // tapped through」. Starting a recording destroys nothing. This sheet is here
  // because of ruling ⑥ — 「按下的时候它就知道」 — the user is being TOLD three
  // things, and 「cancel」 is simply the way out of being told.
  //
  // ⚠️ It is also the ONLY moment the user can change their mind, which is why
  // the no-cancel sentence belongs here and not somewhere later.

  /// B-1 line 1 — this sitting's ceiling, and what happens when it is reached.
  ///
  /// Both halves are provable at the moment it is drawn: the number is the same
  /// `continuous_minutes` that arms the timer, and 「stops and saves」 is the
  /// ordinary release path (`audio:stop` → terminal final), never
  /// `fenceAndStop()` — whose meaning is 「this utterance never happened」.
  String continuousSheetCap(Object? minutes) => _lfContinuousSheetCap(minutes);

  /// B-1 line 2 — the month's balance.
  ///
  /// ⚠️ ONE STRING FOR THIS FACT, deliberately, where the approved demo drew two
  /// (「本月还剩 X」 in B-1 and 「本月只剩 X」 in B-2). The two differ only in
  /// tone, and B-2 already carries [continuousSheetEarlyStop] saying the
  /// recording will end early — a second author for the same number, whose only
  /// job is to sound more worried, is a copy that can drift out of step with the
  /// sentence doing the actual work.
  String continuousSheetLeft(Object? minutes) => _lfContinuousSheetLeft(minutes);

  /// B-2 — the balance is below the ceiling, so this sitting ends on the MONTH
  /// rather than on the ceiling, and roughly when.
  ///
  /// 🔴 THIS IS THE FREE TIER'S SECOND RECORDING, NOT AN EDGE CASE: 20 minutes a
  /// month against a 10-minute ceiling is exactly two sittings. Owner's ruling is
  /// that the subtraction is ours to do — putting two numbers on screen and
  /// leaving the user to work out which one bites is how they find out
  /// afterwards.
  ///
  /// ⚠️ 「about」 is load-bearing and must survive translation. The figure is a
  /// floored balance measured before the press; the server settles usage after
  /// the session, so an exact promise here would be a number we cannot keep.
  String continuousSheetEarlyStop(Object? minutes) =>
      _lfContinuousSheetEarlyStop(minutes);

  /// B-1 line 3 — there is a stop and there is no cancel.
  ///
  /// 🔴 IT DELIBERATELY DOES NOT SAY 「留在这一篇里」, and the demo's own B-1 does.
  /// 「一篇」 is the article data model, card CR-7, and it does not exist yet:
  /// until it does, a continuous recording settles into ordinary light-record
  /// rows. Volume 15 §2.0-b's ban is on copy that promises a mechanism we have
  /// not built, and this would be one — the same reason CR-3's offline banner
  /// says 「audio kept on this phone」 and not 「will be transcribed later」.
  ///
  /// ⚠️ WHEN CR-7 LANDS, THIS SENTENCE IS PART OF ITS SCOPE. What it may then
  /// say is 「everything you say stays in this one piece」, because there will be
  /// one piece. Registered here rather than in a task list, because this is the
  /// file somebody edits when they are looking at these words.
  String get continuousSheetNoCancel => _lfContinuousSheetNoCancel;

  /// The go-ahead, when the sitting will run its full length.
  String get continuousSheetStart => _lfContinuousSheetStart;

  /// The go-ahead in the B-2 case.
  ///
  /// A DIFFERENT LABEL, not the same one: the user has just been told this
  /// recording will be cut short, and a button that still says 「start
  /// recording」 reads as though the warning above it were decoration. The demo
  /// makes the same change for the same reason.
  String get continuousSheetStartAnyway => _lfContinuousSheetStartAnyway;

  /// The way out.
  ///
  /// ⚠️ Its own string rather than a reach into another surface's 「取消」: this
  /// catalogue already keeps four, one per surface, so that a locale needing a
  /// different word in one place can have it without moving the other three.
  String get continuousSheetCancel => _lfContinuousSheetCancel;

  // ── Card CR-9 — the in-progress face (demo cell C-1) ─────────────────────
  //
  // The user's finger left the screen minutes ago. Everything here is something
  // WE say without being asked, and the one control is 「stop」.

  /// The live label beside the red dot.
  String get continuousLiveLabel => _lfContinuousLiveLabel;

  /// 🔴 A COUNTDOWN, NOT A STOPWATCH, and the copy has to keep it one. The
  /// question a user asks mid-meeting is 「how much longer can I go」, not 「how
  /// long have I been going」 — and one clock answering both is how somebody
  /// finds out in the last minute that they did the subtraction wrong.
  String continuousRemaining(Object? clock) => _lfContinuousRemaining(clock);

  /// How many segments the SERVER has finalised so far.
  ///
  /// ⚠️ Deliberately terse: it shares a row with the label, the clock and the
  /// screen note. `SegmentBuffer.finalizedCount`'s doc carries what the number
  /// means and why it counts finalised slots rather than slots.
  String continuousSegments(Object? n) => _lfContinuousSegments(n);

  /// 🔴 DRAWN ONLY WHEN `ScreenWakeHold.isHeld` IS TRUE, and that flag exists
  /// for this sentence: it is false when we asked the platform and were
  /// refused, which is exactly the case where this line would be a lie. Its own
  /// doc says so in as many words — 「read this before drawing any 『screen
  /// stays on』 face」.
  String get continuousScreenOn => _lfContinuousScreenOn;

  /// The only control on this face.
  ///
  /// 🔴 THERE IS NO CANCEL AND THERE MUST NOT BE ONE (CR-D ③, owner-approved
  /// 2026-08-29). Push-to-talk has swipe-up-to-cancel; a continuous recording
  /// physically cannot be cancelled, because each segment is finished and saved
  /// as it is spoken. A cancel button that cannot undo anything is worse than
  /// no button.
  String get continuousStop => _lfContinuousStop;

  /// The caption under the stop button.
  ///
  /// 🔴 IT SAYS 「FINISHED PARTS」, NOT 「everything you have said」, AND THE
  /// DIFFERENCE IS THE SENTENCE STILL IN THE AIR. The segment being spoken has
  /// not been finalised, so it is not saved yet; the claim is trimmed to the
  /// part that is provable at every instant it is on screen.
  ///
  /// ⚠️ It also avoids 「这一篇」 for the reason [continuousSheetNoCancel] gives
  /// at length: the article is CR-7 and does not exist yet.
  String get continuousLiveCaption => _lfContinuousLiveCaption;

  /// C-2 — the single reminder before the ceiling.
  ///
  /// 🔴 EVENT-TYPE, ONCE, A FEW SECONDS (owner §5-4). A permanent 「1:00 left」
  /// bar turns the last minute of somebody's meeting into an anxiety meter, and
  /// the person it interrupts is mid-sentence. The RUNNING countdown belongs on
  /// the recording face, where the user chose to look at it.
  ///
  /// ⚠️ The number is interpolated from `kContinuousCapWarningLead` rather than
  /// written into nine translations: a hard-coded 「1」 here becomes nine lies the
  /// day the lead is retuned, and nothing would go red.
  String continuousCapWarning(Object? minutes) =>
      _lfContinuousCapWarning(minutes);
}
