// VERBATIM MOVE out of chat_message_tile.dart (800-line cap: card fix-015 took
// that file to 841/800). This file owns ONE thing — **how a row explains why it
// says what it says**: the five functions that decide whether a face speaks at
// all, which copy table answers for a given code, and whether that answer goes
// into the meta row as a bare identifier or onto its own full-width line.
//
// 🔴 THE SEAM IS COHESION, NOT LINE COUNT, AND IT IS NOT AN ARCHITECTURAL CLAIM.
// These five call each other and nothing outside the library calls any of them;
// they were already documented as one family — `_faceSpeaksReason`'s entire
// reason for existing is that `_reasonLineFor` and `_reasonNoteFor` must never
// disagree about whether a row speaks, so those two cannot live apart. Cutting
// anywhere else in the file would have split a pair that has to stay together.
// The widget's behaviour is unchanged; nothing here is a layering statement.
//
// `part of`, not a standalone library, for the same two load-bearing reasons the
// sibling `live_draft_tile.dart` gives in its own header:
//   ① these helpers are library-private and stay that way. A standalone file
//      would have forced them public — a wider surface for functions whose whole
//      point is that ONE place decides — or duplicated, and a duplicate is how
//      the meta-row line and the full-width note would come to disagree;
//   ② every existing `import 'chat_message_tile.dart'` keeps resolving, so this
//      move touches zero call sites.
//
// 🔴 Diff discipline: the body below is byte-identical to what stood at
// chat_message_tile.dart:92-237. No rename, no reflow, no comment edit. Any
// other diff is a bug.

part of 'chat_message_tile.dart';

/// Cap the failure-code label so a long detail cannot stretch the meta row.
String _truncateFailureReason(String reason) {
  if (reason.length <= 28) return reason;
  return '${reason.substring(0, 28)}…';
}

/// The optional 「· 详情」("· details") clause beside the status pill — ONE
/// place that
/// decides both WHETHER a reason shows and WHAT it says, so the two decisions
/// (documented at length at this function's one call site, in [build]) cannot
/// drift apart from each other the way two separately-maintained conditions
/// would.
///
/// 🔴 Card B4-12 (Book 15 G-16 partial) — this is the ONLY widening of the
/// long-
/// standing rule (RV-14/RV-67: ✗/⛔ show the raw identifier, every other face
/// shows nothing). [AppStrings.cloudImageRelayErrorNote] recognises exactly
/// two codes; every other code on every other face is UNCHANGED — verified in
/// test/cloud_image_error_copy_test.dart, including a reverse control that
/// removing this function's `undelivered` branch makes a quota refusal go
/// back to showing nothing at all (not a raw identifier — undelivered never
/// showed
/// one), which is the actual production regression this function exists to
/// prevent.
/// 🔴 Card U5 — adds this table to the `??` chain: the delivery segment's
/// terminal refusal
/// (`AppStrings.deliveryRefusalNote` — `INJECT_FRAME_TOO_LARGE` /
/// `INJECT_FRAME_INVALID` / `INJECT_PC_MISMATCH` / `INJECT_PC_UNSPECIFIED`).
/// The three tables are mutually exclusive (each one's code set is disjoint,
/// `deliveryRefusalNote`'s own docs already prove it 「does not overlap」 the
/// cloud-image codes and the queue's local terminal states), so the order
/// does not change the answer for any existing code —
/// what is added is only the ones none of the three tables previously
/// recognized, and which therefore fell back to the bare identifier.
///
/// 🔴 Card G-16-a — the third table now also has `INJECT_PC_OFFLINE`, **the
/// only NON-TERMINAL
/// member of that table**, and mutual exclusivity is unaffected (the three
/// tables are still disjoint). Because it is non-terminal, it is **the only
/// member of that table that ever reaches
/// [DeliveryFace.undelivered]** (the other four are all judged terminal by
/// `isTerminalRefusalCode`
/// ⇒ ⛔) ⇒ it takes the B4-12
/// `undelivered && human != null` branch in [_faceSpeaksReason] below.
/// ⚠️ 「only」 holds **only within that table**: the two cloud-image codes
/// also land on `undelivered`, but they belong to
/// the FIRST table — do not read this sentence as 「it's the only one on the
/// whole chain that reaches that face」.
///
/// ⚠️ **This paragraph deliberately no longer states how many codes each
/// table has**: the previous version wrote 「the inject segment has six」,
/// and after MAC-05 added
/// 63/64 it had already become eight — **nobody is going to touch a comment
/// just to update a count**, so it
/// lay here as a stale truth (the cheapest shape of anti-façade ④). To
/// count, go read those three `switch`es.
/// Human copy takes priority: cloud image → inject segment → delivery
/// segment. When all three tables return `null` the caller falls back to
/// the bare code.
String? _humanNoteFor(String code, AppStrings strings) =>
    strings.cloudImageRelayErrorNote(code) ??
    strings.injectVerdictNote(code) ??
    strings.deliveryRefusalNote(code);

/// Whether this face says 「why」("为什么") at all — [_reasonLineFor] and
/// [_reasonNoteFor] share the SAME
/// judgement, so 「show it or not」 always has exactly one answer (the whole
/// reason this function exists).
bool _faceSpeaksReason(DeliveryFace face, String? human) =>
    face == DeliveryFace.failed ||
    face == DeliveryFace.refused ||
    face == DeliveryFace.deliveredNotInjected ||
    // 🔴 Card B4-12 — undelivered stays silent for every code EXCEPT the
    // ones [human]
    // recognises. Left silent for them too, a quota/size refusal would show
    // 「📥 undelivered」 with a live resend button and ZERO explanation —
    // worse than a
    // raw identifier, and arguably a silent failure of its own.
    //
    // 🔴 Card G-16-a — `INJECT_PC_OFFLINE` now also takes this branch (on
    // the socket leg the relay sends
    // `mode:'cached'` ⇒ the row settles `cached + cachedByVerdict` ⇒ this
    // face), and it is B4-12's
    // **strongest example**: that face's word is 「待投递」("pending
    // delivery"), and before this it said not one word about this code
    // ⇒ what the user read was pure waiting, without even 「waiting for
    // what」. See the criteria in
    // test/pc_offline_note_test.dart's group ② (one face per leg).
    (face == DeliveryFace.undelivered && human != null);

/// 🔴 Card M6-1 (0.2.53) — for codes that have human copy, the human copy
/// gets **its own full line** ([_reasonNoteFor]),
/// no longer squeezed into the meta row. The source is a real-device
/// screenshot: that row already had six slots —
/// badge/time/pill/resend/provenance/word-count —, and
/// `Flexible + ellipsis` clipped `INJECT_SELF_WINDOW_NO_INPUT` down to
/// 「INJ…」.
/// From here on this function produces **only** the bare-code tier —
/// unrecognized codes, behaviour unchanged to the letter.
String? _reasonLineFor(DeliveryFace face, String? code, AppStrings strings) {
  if (code == null || code.isEmpty) return null;
  final String? human = _humanNoteFor(code, strings);
  if (human != null) return null;
  // RV-14 / RV-67: the long-standing surface — ✗/⛔ name the code, every other
  // face stays silent. 🔴 Card F2 added `deliveredNotInjected`, for the same
  // reason as ✗/⛔,
  // and the opposite of `noFocus`: that face serves only one code (the word
  // already says it all), this face
  // covers multiple codes ⇒ the code is the only thing that can say 「which
  // one it is」. It does not carry
  // the stale-code risk: the face **is derived from** the code
  // (`deliveryFaceOf`
  // reads it), so if the face exists, the code must exist too.
  if (_faceSpeaksReason(face, human)) {
    return '· ${_truncateFailureReason(code)}';
  }
  // 🔴 Card L7 × Card L8 — `INJECT_DEFERRED_NOT_AUTOINJECTED` deliberately
  // does **NOT** get a third
  // exception added here, and the reason can be grep-verified (anti-façade
  // ④, not a 「deal with it later」):
  //
  //   ① The two cloud-image codes need the exception because they land on
  //      `undelivered`, and **that face is shared by many codes** —
  //      without printing a named explanation, all the user reads is one
  //      generic word, telling them nothing.
  //      This code **has its own face** (`DeliveryFace.deferredNotInjected`,
  //      `status_badge.dart` `_isDeferredNotInjectedReason` — greppable,
  //      and it is that face's
  //      **sole** trigger condition) ⇒ the face's word already IS the
  //      explanation for this code, printing it again just says the same
  //      fact twice.
  //      This uses **the same existing argument** `noFocus` uses (see this
  //      file's call site, paragraph 4).
  //   ② That face's word has already said everything there is to say:
  //      「已投递 · 未自动注入」("delivered · not auto-injected") — delivery
  //      succeeded (first word),
  //      injection was not done (second half), four-language copy in
  //      `AppStrings.statusDeferredNotInjected`.
  //   ③ 🔴 **The long sentence in `ERROR_CODES` must NOT be moved here**:
  //      that sentence is **meant to be read by the PC side**
  //      (「the message has reached the PC and stayed on the PC's
  //      timeline」), while this is a **phone** row — the phone should not
  //      describe the PC's timeline on the PC's behalf, which is exactly
  //      the boundary-crossing the two-segment terminology exists to tear
  //      down (Book 15 §2.0 rule 2).
  //
  // ⇒ If, in the future, a second code is ever folded into
  //   `deferredNotInjected`, THAT is the moment to add it back here
  //   (the ✗/⛔ shape: one face covers multiple codes ⇒ the code is needed
  //   to say which one).
  return null;
}

/// 🔴 Card M6-1 (0.2.53) — the whole human-copy sentence, rendered on **its
/// own full line below the body text** (`build`'s only call site).
///
/// Why it cannot stay in the meta row: that row is a `Row` + a string of
/// `Flexible(maxLines:1,
/// ellipsis)`, and the longer the sentence, the harder it gets clipped —
/// down to three letters on a real device in 0.2.52. Full line +
/// `maxLines:3`
/// after that, this sentence **physically** fits
/// (`inject_verdict_note_test.dart` nails it down with measurement:
/// what it asserts is rendered width and actual line count, not
/// `Text.data`).
///
/// 🔴 Card fix-015 — [hasResendAffordance] is the ONE fact that picks between the
/// generic sentence and the PICTURE-ROW one ([AppStrings.imageInjectVerdictNote]).
///
/// ⚠️ This line deliberately no longer lists which codes that table
/// recognizes today (the original text listed
/// 63/64, and card fix-015's closing round added
/// `INJECT_FOCUS_LOST` ⇒ that list expired on the spot). This file just
/// established the same rule above, for the three tables' **counts**:
/// **nobody is going to touch a comment just to update a list**. To know
/// which ones, go read that `switch`.
///
/// It is deliberately the SAME boolean that draws the button
/// (`canRetry` in [build]) and not a second re-derivation from the code, because
/// the defect being fixed is precisely a sentence disagreeing with the row it is
/// printed on: the generic copy for those two codes ends 「…再重发」("…resend
/// again") while a picture
/// row carries no resend control (`canResendImage` is false — the verdict
/// settles the
/// queue item terminal) and the PC offers no re-inject for a picture either
/// (`TimelinePage.vue` `rowCanReinject` = `entry_type !== 'image' && …`). One
/// boolean, one answer ⇒ the row can never say 「重发」("resend") while
/// showing no resend control.
///
/// ⚠️ This is why the gate is NOT 「is the code 63/64」: card `fix-018` is in flight
/// to give 63 a bounded retry, which would put the item back in
/// `resendableImageEntryIds` and make the button real again. On that day this
/// function needs no edit — the generic sentence returns by itself, because the
/// thing it asks about is the affordance, not the code.
String? _reasonNoteFor(
  DeliveryFace face,
  TimelineEntry entry,
  AppStrings strings, {
  required bool hasResendAffordance,
}) {
  final String? code = entry.failureReason;
  if (code == null || code.isEmpty) return null;
  final String? human = _humanNoteFor(code, strings);
  if (human == null) return null;
  if (!_faceSpeaksReason(face, human)) return null;
  if (entry.isImage && !hasResendAffordance) {
    // Replaces the generic sentence rather than joining it: the two differ only
    // in their last clause, and printing both would put a 「再重发」("resend
    // again") and a 「没有再
    // 粘贴一次的入口」("no entry point to paste it again") on the same row.
    // Falls through untouched for every code the
    // picture table does not recognise (it returns null), so nothing else on any
    // row changes.
    final String? picture = strings.imageInjectVerdictNote(code);
    if (picture != null) return picture;
  }
  return human;
}
