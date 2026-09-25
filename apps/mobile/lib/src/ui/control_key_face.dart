// The words a remote control key wears — its NAME, and (card MP-14) the one
// sentence shown when the far end could not apply it.
//
// Pure Dart: no Flutter import, so `banner_queue.dart` (which declares itself
// widget-free so the whole priority/dedupe contract is unit-testable without a
// WidgetTester) can reach this, and so can `chat_control_tile.dart`.
//
// 🔴 ONE KEY, ONE NAME. [controlKeyLabel] is a VERBATIM move out of
// chat_control_tile.dart — same body, same comment, same behaviour — so the key
// called 「清除」("Clear") on the toolbar is called 「清除」 in the history row AND
// in the refusal notice. A second mapping here would be the copy-side version of
// this repo's #1 defect shape, which is exactly what that function's own comment
// was already guarding against for two surfaces and now guards for three.

import '../settings/app_strings.dart';

/// Translates the wire kind into **the name the key itself carries on the
/// toolbar**.
///
/// 🔴 Reuses `keyEnter` and the three other existing getters, rather than
/// starting a second vocabulary: the same key called 「清除」("Clear") on the
/// button and something else in history is the same thing under two names
/// (the copy-side version of this repo's #1 defect shape).
///
/// An unrecognised kind prints **the raw identifier verbatim**, never a made-up
/// sentence — the same posture the phone takes for an unregistered error code
/// (the 0.2.53 lesson: inventing a sentence for a code you don't recognise is
/// worse than printing the identifier). `tab`/`space` are in the whitelist but
/// have no button on the toolbar; landing here they can still say who they
/// are.
String controlKeyLabel(AppStrings strings, String kind) => switch (kind) {
  'enter' => strings.keyEnter,
  'backspace' => strings.keyBackspace,
  'undo' => strings.keyUndo,
  'clear' => strings.keyClear,
  _ => kind,
};

/// Card MP-14 — one `control:key-result` that said `ok:false`, held for the
/// transient notice it raises.
///
/// 🔴 [ticket] IS THE IDENTITY, not [kind] + [reason]. Two refusals of the same
/// key for the same cause are two pieces of news, and the auto-hide reconciler
/// decides 「is this a fresh occurrence」 by comparing the face value it saw last
/// tick. Without a ticket the second press would inherit whatever was left of
/// the first one's window — the same reason `pairingSuccess` and the continuous
/// cap warning are tickets rather than flags.
class ControlKeyRefusal {
  final int ticket;

  /// The wire kind, rendered through [controlKeyLabel] at display time — never
  /// stored as a rendered sentence, because these outlive a UI-language switch.
  final String kind;

  /// The wire `reason`, verbatim, or null when the frame did not carry one.
  /// Coarsened into a sentence by [controlKeyRefusalText] and nowhere else.
  final String? reason;
  final String? errorCode;

  const ControlKeyRefusal({
    required this.ticket,
    required this.kind,
    this.reason,
    this.errorCode,
  });
}

/// The sentence for one refusal.
///
/// 🔴 THREE SENTENCES, NOT ONE, because the three wire reasons lead to three
/// different moves and a single 「it did not work」 would hide which one this is:
/// `unsupported_here` means try another destination, `no_target` means click
/// into a box first, `failed` means try again. Collapsing them here would throw
/// away the only thing the enum was built to carry.
///
/// 🔴 AN UNKNOWN REASON FALLS TO THE `failed` SENTENCE, AND THAT IS THE ONLY
/// SAFE DIRECTION. It is the coarsest of the three: it never invents a specific
/// cause and it never claims the key worked. A far end that grows a fourth
/// reason therefore degrades to 「the computer could not use this key」, which is
/// true of every refusal there is. The same applies to an absent `reason` on a
/// failure — the schema cannot make it required without also refusing senders
/// older than it.
///
/// ⚠️ THE COPY SAYS 「computer」 AND THAT IS AN APPROXIMATION WORTH NAMING. The
/// far end of a room is a PC today; a web target page registers in the same
/// role and could in principle answer this too. Every string this phone already
/// owns for that end says 「电脑」/「computer」 (`keyEnterHint`,
/// `controlRowClearNote`, the whole compose-error family), so this one says it
/// as well rather than inventing a second word for the same place. If the phone
/// ever really pairs with a page, this is one of the strings that has to change
/// — registered here rather than discovered then.
String controlKeyRefusalText(AppStrings strings, ControlKeyRefusal refusal) {
  final String? named = refusal.errorCode == null ? null : strings.injectVerdictNote(refusal.errorCode!);
  if (named != null) return named;
  final String key = controlKeyLabel(strings, refusal.kind);
  return switch (refusal.reason) {
    'unsupported_here' => strings.controlKeyRefusedUnsupported(key),
    'no_target' => strings.controlKeyRefusedNoTarget(key),
    _ => strings.controlKeyRefusedFailed(key),
  };
}
