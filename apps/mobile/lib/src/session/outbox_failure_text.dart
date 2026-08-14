// SPEC-REF:
//   apps/mobile/lib/src/session/outbox_item.dart (kOutboxImageBytesGone /
//     kOutboxOverflow, and the block explaining why they are NOT protocol codes)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.5 / §3.2
//   CLAUDE.md red line: no silent failure (banned both directions) / status
//     only records delivery truth
//
// ── The queue's own two terminal states, and the sentence spoken to the
//    user about them ──────────────────────────────────────────────────────
//
// 🔴 WHY THIS FILE EXISTS INSTEAD OF TWO NEW ROWS IN `ERROR_CODES`
// (lead's 2026-07-31 ruling — the reasoning lives in BOTH places on purpose:
// there, because that is where someone will look for the code; here, because
// this is what got built instead).
//
// `ERROR_CODES` is the vocabulary for things that CROSS A BOUNDARY — one end
// mints the code, the other end displays it, and the shared table is what stops
// the two ends from drifting. Both codes below are minted by the phone,
// displayed by the phone, and can never appear on a wire: the server does not
// know a queue exists, and the desktop never hears about an item that was not
// sent. Adding them to the protocol table would make 「protocol error code」
// answer two questions at once (「what did the other side say」 vs 「what did
// I myself decide on this side」) — this repo's #1 bug shape, in the one table
// whose entire job is one meaning per string — and would spend a
// counting-guard bump plus a relay deploy on a string that never leaves the
// handset.
//
// ⚠️ WHAT IS NOT RELAXED BY STAYING LOCAL. A terminal state with no sentence
// for the user is 「silent failure」 wearing a code: the delivery stops
// happening and nothing anywhere says why. So these are held to the same
// standard as any server code — a named constant (no call site spells a
// literal), a terminal verdict from the same predicate, and a sentence with
// a grep-able producer. The ban is on the TABLE, not on the courtesy.
//
// ── Window B3-2b: THIS FILE NO LONGER HOLDS THE SENTENCE ─────────────────
//
// It used to return a hard-coded Chinese string. That was wrong in a way the
// 「nobody displays it」 gap was hiding: the app ships zh/en/ja/ko from ONE
// catalogue with an EXPLICIT locale (never the OS's), so a zh literal down
// here would have rendered Chinese at an English user the moment anybody
// wired it up — anti-façade ② in its copy form (a friendly default that
// looks like it worked).
//
// It is also the wrong LAYER, and that half is what makes the fix stick: the
// queue runs in the session layer, where there is no `AppStrings` and no reason
// to have one, and a sentence frozen at the instant a delivery failed would go
// stale the moment the user switched UI language — a message about a
// picture from last week, still in the language they left. So the queue
// stores the FACT (an [OutboxTerminal]) and the UI resolves the words at
// render time. This is the same shape `ComposeSendFailure` /
// `ImageSendOutcome` already use, which is why it needs no new machinery.

import 'outbox_item.dart';

/// The queue's own terminals, as a CLOSED vocabulary the UI can switch on
/// exhaustively.
///
/// An enum rather than the raw code string for one reason worth the type: a
/// `String` would let the UI receive a server code it has no words for and
/// render nothing — a terminal that stops the delivery and says nothing, i.e.
/// exactly the "silent failure" this file exists to prevent. With two members and an
/// exhaustive switch, adding a third terminal FAILS TO COMPILE until somebody
/// writes its four sentences.
enum OutboxTerminal {
  /// The compressed picture is no longer on disk, so there is genuinely nothing
  /// left to send ([kOutboxImageBytesGone]).
  imageBytesGone,

  /// Dropped to keep the queue inside `kOutboxCapacity` ([kOutboxOverflow]).
  overflow,
}

/// Which queue-owned terminal [code] is, or null when the queue does not own it.
///
/// 🔴 Null is the load-bearing case and is deliberately NOT a fallback like
/// 「delivery failed」: a server code is the SERVER's to phrase, and answering
/// for it here would invent words the PC never said. A default sentence
/// would swallow an unrecognised terminal into a shrug, which is "no silent
/// failure"'s second direction. The caller decides what to do with a code
/// this file does not own —
/// on the row it is shown BY NAME (chat_message_tile), which is this repo's
/// standing treatment of error codes as identifiers rather than copy.
OutboxTerminal? outboxTerminalOf(String code) => switch (code) {
  kOutboxImageBytesGone => OutboxTerminal.imageBytesGone,
  kOutboxOverflow => OutboxTerminal.overflow,
  _ => null,
};
