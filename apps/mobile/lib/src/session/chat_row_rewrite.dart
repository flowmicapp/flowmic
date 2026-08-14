// Part of chat_controller.dart — rewriting a row that ALREADY EXISTS, without
// re-delivering it (lane K, 2026-08-05).
//
// ── WHY THIS SPLIT, AND WHAT IT IS NOT ───────────────────────────────────────
// chat_controller.dart sat at 799 against `verify/lint/file-size.mjs`'s
// SRC_MAX = 800; see chat_ptt_lifecycle.dart's header for the full reason and
// for why the mechanism here is an `extension` rather than an eighth
// `xxxRouted` top-level function, plus the price that choice carries.
//
// 🔴 NOTHING HERE CHANGED BEHAVIOUR. Every member below — declaration, doc
// comment and body — is byte-for-byte what it was in chat_controller.dart.
// Like chat_status_surface.dart, this file needed NOT EVEN the `notifyUi` edit:
// all four bodies delegate, so none of them touches `notifyListeners`.
// **Any diff at all is a bug.**
//
// WHY THIS SET AND NOT SOME OTHER SET: this is the EXACT COMPLEMENT of
// chat_explicit_delivery.dart, and the file said so before I did —
// `reprocessEntry`'s own comment reads 「Nothing is re-delivered — long-press
// resend remains the deliberate way to send it」. All four members change what one
// local row SAYS or whether it exists (rewrite / re-run / delete / adopt a
// second-pass transcript) and none of them puts a frame on the wire. The
// question 「does touching a row re-deliver it?」 must get ONE answer per file,
// which is why these are not in the delivery file: there, the answer is always
// yes; here, always no.
//
// ⚠️ ALL FOUR BODIES LIVE IN OLDER PART FILES ALREADY (chat_row_uplink.dart for
// the edit/delete family, chat_utterance.dart for `_applyRefined` and
// `_reprocessEntry`). What moves here is the DECLARATION and the prose above
// it — which in this file is most of the bytes. This card does not touch any
// pre-existing part file.
//
// ⚠️ WHERE THE 「── long-press actions ──」 SEPARATOR WENT: it sat directly above
// `reInject` in chat_controller.dart and travelled with it into
// chat_explicit_delivery.dart. `editEntry` / `reprocessEntry` / `deleteEntry`
// were the rest of that section; they are long-press actions too, and this
// paragraph is the only record of that, since the separator itself was moved
// verbatim rather than copied.
//
// ⚠️ THE 0.2.27 REMOVAL NOTE BELOW SAYS 「removed here」. 「Here」 meant the class
// body in chat_controller.dart. It is moved VERBATIM (this card does not
// rewrite existing prose), so read that word against that file.

part of 'chat_controller.dart';

extension ChatRowRewrite on ChatController {
  /// Edit (C5 ②/③ — body in chat_row_uplink.dart, which owns the whole
  /// 「how does a local edit reconcile with the server afterward」 family).
  void editEntry(TimelineEntry entry, String newText) =>
      _editEntry(this, entry, newText);

  // 0.2.27: `pushRowEdit` (the awaitable edit uplink) and the two conflict
  // members (`timelineConflict` / `dismissTimelineConflict`) were removed here.
  // The server no longer holds this phone's rows, so an edit has nobody to report
  // to and no peer that could overrule it — see chat_row_uplink.dart.

  /// GA-13 — re-translate/re-organize an existing row with the CURRENT mode.
  ///
  /// Re-runs over the immutable `source_text`, so this is never a translation of
  /// a translation. The result is written as a MACHINE update: the row's text
  /// moves, the `edited` bit does not (that bit means 「a human edited it」).
  /// Nothing is re-delivered — long-press resend remains the deliberate way to
  /// send it.
  AiComposeFailure? reprocessEntry(TimelineEntry entry) => _reprocessEntry(this, entry);

  /// GA-14 — adopt a second-pass transcript (body in chat_utterance.dart, the
  /// same-library part file the utterance terminals already live in).
  void _onRefined(String text) => _applyRefined(this, text);

  /// Delete (C5 §4 — body in chat_row_uplink.dart, beside the edit uplink it
  /// shares its 「whether the server still has this row」 question with).
  void deleteEntry(TimelineEntry entry) => _deleteEntry(this, entry);
}
