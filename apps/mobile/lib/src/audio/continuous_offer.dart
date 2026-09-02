// SPEC-REF:
//   docs/strategy/2026-08-29-continuous-recording-and-resumable-transcription-task-unit.md
//     §4.A (where the entry may appear), §4.B (where the ceiling comes from),
//     §5-1/§5-2 (what must be told before the press), §6 C1c / C6
//   docs/ui-design/2026-08-29-continuous-recording-demo.html — cells A-1
//     (available), A-2 (translate/organize), A-3 (paired: zero diff),
//     B-1 / B-2 (the pre-flight sheet, and the balance-bound variant)
//   apps/mobile/lib/src/auth/cloud_summary.dart (`continuousMinutes` — its doc
//     states why a null may never become a default)
//
// ── WHETHER THIS PHONE MAY START A CONTINUOUS RECORDING, AND WHAT TO SAY ─────
//
// **Pure.** No clock, no I/O, no widgets. Every branch below is testable without
// pumping a frame — and the two that are about RENDERED text are asserted on the
// rendered text elsewhere (0.2.53's law), not here.
//
// ── 🔴 TWO QUESTIONS, TWO FIELDS, AND THAT SEPARATION IS THE POINT ──────────
//
// 「May it be pressed?」 and 「what should the user be told?」 are not the same
// question, and an enum answering both would have to RANK the reasons — at which
// point a link that is down would hide the fact that the mode is also wrong, and
// the user would fix one thing, press again, and be refused a second time by
// something we already knew.
//
// So: [ContinuousOffer.enabled] is the AND of every gate, and
// [ContinuousOffer.reason] is 「the sentence this control owes the user」 — which
// is sometimes null even while disabled. See [ContinuousBlock].

import '../auth/cloud_summary.dart' show CloudSummary;
import '../session/instance_probe.dart' show ServerChannel;
import '../signaling/wire_payloads.dart' show FlowMode;

/// Why the entry cannot be pressed, when the entry itself owes an explanation.
///
/// 🔴 THERE IS DELIBERATELY NO `linkDown` MEMBER, and its absence is a decision
/// with a precedent in this exact dock. When the link is down the entry dims like
/// everything else and says NOTHING of its own, because the compose band one
/// centimetre up already says 未连接 — `compose_band.dart`'s A8 branch makes the
/// same call in the same place and writes the same reason: 「the preview strip one
/// centimetre up already says 未连接 … a third copy is noise」.
///
/// ⇒ a dimmed entry with no sentence is not a missing explanation. It is a
/// refusal to give one screen two voices for one fact.
enum ContinuousBlock {
  /// Owner ruling (2026-09-02): long-form recording lives ONLY inside Light
  /// Records, and Light Records require a cloud sign-in — so this is checked
  /// BEFORE every other gate below, including the mode and the link.
  ///
  /// 🔴 THIS IS WHY [continuousEntryNoCeilingNote]'s OLD RATIONALE NO LONGER
  /// HOLDS. That sentence used to cover two causes it could not tell apart —
  /// "not signed in" and "signed in, and the server did not answer" — because
  /// nothing here carried a sign-in fact of its own. [continuousOffer] now
  /// takes `signedIn` as an explicit, always-known boolean (never a guess),
  /// so the two causes finally have two different sentences: this one, and
  /// [ContinuousBlock.ceilingUnknown] for the case that remains genuinely
  /// ambiguous (signed in, but the account's ceiling could not be read).
  notSignedIn,

  /// A-2. translate / organize process a WHOLE utterance at once (compose is
  /// strictly single-flight, owner 2026-08-11), so half an hour of audio would
  /// produce nothing until the end and lose everything on any failure.
  ///
  /// Shown disabled WITH this reason rather than hidden: hiding it teaches the
  /// user the feature does not exist, and this is a block they can clear
  /// themselves with the mode chip on the same screen. Same argument the repo
  /// made for `INJECT_NO_ACCESSIBILITY` — a failure the user can fix must never
  /// be presented as impossible.
  modeNotRealtime,

  /// SIGNED IN, and the per-session ceiling still could not be read — a
  /// narrower claim than this member used to make. Before `signedIn` existed
  /// as its own field, a null ceiling was the ONLY signal available and stood
  /// in for "not signed in" too; now that the caller states sign-in
  /// separately (see [notSignedIn]), reaching this branch means the account
  /// is real and the read itself failed or has not landed yet.
  ///
  /// 🔴 THE CEILING IS A PRECONDITION, NOT A DECORATION. `CloudSummary`'s own
  /// doc states it: a continuous recording may not START without this number —
  /// its whole shape is a bounded sitting, and the on-device retention budget was
  /// sized against the 30-minute worst case. Starting an unbounded one would
  /// spend a budget nobody checked.
  ceilingUnknown,

  /// The month's transcription minutes are spent. Nothing would be transcribed,
  /// so offering a recording would be offering a silence.
  ///
  /// ⚠️ Its own member rather than a zero-minute ceiling or a 「stops early, in
  /// about 0 minutes」 sheet: pressing again after this one does not help, and
  /// W8-4 is the account this repo already paid for saying two opposite things
  /// with one sentence.
  quotaSpent,
}

/// What the continuous-recording entry should do and say, right now.
class ContinuousOffer {
  const ContinuousOffer({
    required this.visible,
    required this.enabled,
    this.reason,
    this.capMinutes,
    this.remainingMinutes,
  });

  /// Is the entry on the tree at all?
  ///
  /// 🔴 FALSE MEANS ABSENT, NOT DIMMED, and only one thing produces it: a
  /// destination that injects into a PC (demo cell A-3). Ruling ⑧ asks for a
  /// paired dock with 「零 diff」 — not one pixel added — so the entry is not
  /// there to be explained. Where the user learns the feature exists is the
  /// light-record page's own empty state, which is ruling ⑫'s 落点 and lives on
  /// light-record's own ground.
  final bool visible;

  /// May it be pressed? The AND of every gate, including the ones that owe no
  /// sentence (see [ContinuousBlock]).
  final bool enabled;

  /// The sentence this control owes, or null when it owes none — either because
  /// nothing is wrong, or because something else on the screen already said it.
  final ContinuousBlock? reason;

  /// This account's ceiling for ONE sitting, in whole minutes, or null when it
  /// could not be read.
  final int? capMinutes;

  /// Minutes left in this billing month, or null when that meter could not be
  /// read.
  ///
  /// 🔴 NULL IS DRAWN AS NOTHING — never as 0, never as 「unlimited」, never
  /// folded into a vaguer sentence. §5-2 states it and `quota_gauge.dart`
  /// established it: one end unreadable ⇒ that end is not drawn. A 0 here would
  /// read as 「you have none left」, a claim we do not have.
  final int? remainingMinutes;

  /// B-2 — will this sitting be ended by the MONTH's balance rather than by the
  /// per-session ceiling?
  ///
  /// 🔴 NOT AN EDGE CASE — IT IS THE FREE TIER'S SECOND RECORDING. 20 minutes a
  /// month against a 10-minute ceiling is exactly two sittings, and the second
  /// usually ends mid-way. Owner's ruling is that we say so before the press
  /// instead of leaving the user to subtract two numbers; making them do the
  /// arithmetic is making them find out afterwards.
  bool get boundedByBalance {
    final int? cap = capMinutes;
    final int? left = remainingMinutes;
    if (cap == null || left == null) return false;
    return left < cap;
  }

  /// How long this sitting can actually run, in whole minutes — the smaller of
  /// the two ceilings — or null when we cannot say.
  ///
  /// ⚠️ A DISPLAY figure, never an enforcement one. The timer is armed from
  /// [capMinutes] (card CR-6): the month's balance is spent against the SERVER's
  /// meter and the server is the only thing that may end a recording for it —
  /// CQ5 keeps that stop labelled `quota_exhausted` rather than the local
  /// ceiling. A phone arming its own timer on the balance would be answering the
  /// server's question with a number it guessed.
  int? get minutesAvailable {
    final int? cap = capMinutes;
    if (cap == null) return null;
    final int? left = remainingMinutes;
    if (left == null) return cap;
    return left < cap ? left : cap;
  }
}

/// The entry is absent — the one shape that adds nothing to a paired dock.
const ContinuousOffer _absent = ContinuousOffer(visible: false, enabled: false);

/// Decide what the continuous-recording entry should do and say.
///
/// [recordOnly] is the DESTINATION mode (`destination.isRecordOnly`) — the same
/// mode-level fact the dock's own column count reads, deliberately, and never
/// the transient `PttVisual` face: a control that appears and disappears as the
/// FSM moves is the 0.3.1 P3 defect (the dock re-arranged under a pressed
/// finger).
///
/// [linkUp] gates without explaining — see [ContinuousBlock].
///
/// [summary] is the last believed `/api/cloud/summary`, or null when there is
/// none. Null is 「we do not know」 in both directions and never a default.
///
/// [channel] — WP-9 (2026-09-02, findings-crossend-quota.md #2) — WHICH
/// connection this recording would actually run over, or null when that is not
/// known yet. `summary`'s two meters describe the CLOUD account's managed-STT
/// month; a LAN recording is transcribed by the paired PC's own engine and
/// never draws from that month at all. Before this parameter existed the
/// balance side of `summary` was applied unconditionally, so a phone on a
/// standalone/LAN PC — which has no cloud login and therefore no meter to
/// read — inherited whatever the LAST logged-in cloud account's balance
/// happened to be (or, more often, no summary at all, which is a SEPARATE gap:
/// standalone answering its own [continuousMinutes] ceiling is `/api/limits`,
/// server-side plumbing landing in this same card; this phone-side fix is only
/// the balance-judgement half).
ContinuousOffer continuousOffer({
  required bool recordOnly,
  required FlowMode mode,
  required bool linkUp,
  // Owner ruling (2026-09-02): continuous recording is a Light Records
  // feature and Light Records require a cloud account — so this is read
  // BEFORE the mode, the link, or the ceiling. Always a real boolean (never
  // null): the composition root threads `LoginController.isLoggedIn` as a
  // getter for the same reason the "+" panel's Light-record tab does (see
  // `ChatFlowPage.isSignedIn`'s own doc) — a value copied at some earlier
  // instant would go stale the moment the user signs in without leaving this
  // screen.
  required bool signedIn,
  required CloudSummary? summary,
  ServerChannel? channel,
}) {
  // ① Destination first, and it is the only input that can remove the entry.
  if (!recordOnly) return _absent;

  final int? cap = summary?.continuousMinutes;
  // 🔴 A LAN channel's monthly balance question does not apply — see the
  // parameter doc above — so `left` is forced null rather than read from a
  // summary that may belong to an unrelated (or no) cloud account. Forcing it
  // here, once, keeps every downstream reader ([boundedByBalance],
  // [minutesAvailable], the `quotaSpent` branch below) honest without each of
  // them re-deriving "is this channel exempt from the balance question".
  final bool balanceApplies = channel != ServerChannel.lan;
  final int? left = balanceApplies ? _wholeMinutesLeft(summary) : null;

  // ② Everything else is 「visible」, and the gates are collected rather than
  // ranked. `reason` takes the first sentence in a fixed order; the link
  // contributes no sentence at all, so a link-down phone in translate mode still
  // learns about the mode.
  final ContinuousBlock? reason = !signedIn
      // Outranks every other gate, including the mode: a signed-out phone
      // does not have an account to check the mode or the ceiling against,
      // and telling it "realtime mode only" would be answering a question
      // one step ahead of the one that actually blocks it.
      ? ContinuousBlock.notSignedIn
      : mode != FlowMode.realtime
      ? ContinuousBlock.modeNotRealtime
      : cap == null
      ? ContinuousBlock.ceilingUnknown
      // Read as 「the meter said zero」, never as 「there was no meter」: `left` is
      // null in the second case (including every LAN channel, always) and falls
      // through to enabled, where the sub-line simply omits a number it does
      // not have.
      : left == 0
      ? ContinuousBlock.quotaSpent
      : null;

  return ContinuousOffer(
    visible: true,
    enabled: linkUp && reason == null,
    reason: reason,
    // 🔴 THE NUMBERS ARE CARRIED WHATEVER THE GATE SAYS, and that is not
    // sloppiness. 「最多 30 分钟」 is true of this account while the mode is wrong,
    // while the link is down, and while the month is spent — it is a property of
    // the plan, not of this moment. Withholding it would make a disabled entry
    // say less about the product than an enabled one, and the sub-line is how a
    // user finds out the ceiling exists at all.
    capMinutes: cap,
    remainingMinutes: left,
  );
}

/// Whole minutes left on the month's speech meter, or null when it could not be
/// read.
///
/// 🔴 FLOORED, NEVER ROUNDED. A balance of 0.6 minutes displayed as 「1」 is a
/// minute the user does not have, and the sentence built on it (「stops in about
/// 1 minute」) would be wrong in the direction that surprises them. Floor
/// under-promises, the only safe direction for a number somebody is about to
/// plan a meeting around.
///
/// Clamped at zero: a negative balance is a real state (the server settles usage
/// AFTER a session, so an overrun lands here) and it means the same thing as zero
/// to a user. Clamped for DISPLAY only — nothing here decides what the server
/// charges.
int? _wholeMinutesLeft(CloudSummary? summary) {
  final meter = summary?.minutes;
  if (meter == null) return null;
  final double left = meter.limit - meter.used;
  if (!left.isFinite) return null;
  if (left <= 0) return 0;
  return left.floor();
}
