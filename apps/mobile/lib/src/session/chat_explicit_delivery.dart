// Part of chat_controller.dart — the six places where the USER explicitly asks
// for something to be put on the wire (Lane K, 2026-08-05).
//
// ── WHY THIS SPLIT, AND WHAT IT IS NOT ───────────────────────────────────────
// chat_controller.dart sat at 799 against `verify/lint/file-size.mjs`'s
// SRC_MAX = 800; see chat_ptt_lifecycle.dart's header for the full reason and
// for why the mechanism here is an `extension` rather than an eighth
// `xxxRouted` top-level function, plus the price that choice carries.
//
// 🔴 NOTHING HERE CHANGED BEHAVIOUR. Every member below is what it was in
// chat_controller.dart — declaration, doc comment and body — with exactly ONE
// mechanical edit, listed here so the claim stays checkable:
//   (1) in `sendControlKey`'s body, `notifyListeners()` became `notifyUi()`,
//       because `notifyListeners` is `@protected` and an extension is not a
//       subclass. `notifyUi`'s entire body is `=> notifyListeners()`. Same edit,
//       same reason, as chat_notices.dart / chat_mode_chip.dart declare in their
//       own headers. It is the ONLY body in this file that repaints directly.
// **Any diff beyond that one is a bug.**
//
// WHY THIS SET AND NOT SOME OTHER SET: 🔴 this cut was drawn by the file, not by
// me. Three of the moved comments already say these belong together, verbatim:
// `reInject` — 「deferred delivery is the fourth EXPLICIT delivery, and it
// belongs with the other three」; `imageSend` (the field, still in the class)
// — 「an image send is a manual delivery with a different payload, not a
// second delivery mechanism」; `sendFavorite` — 「Delivered through the SAME
// emission path as ➤ ([ManualDelivery.deliverText] is the only place a
// manual inject:request is built)」. Six entry points, one emission path ⇒
// change the delivery policy and all six change together. The opposite
// family — rewrite a row WITHOUT re-delivering it — is chat_row_rewrite.dart,
// and it is a separate file on purpose: 「whether editing a row triggers a
// re-delivery」 must have exactly one answer per file.
//
// ⚠️ THE SECTION HEADER 「── long-press actions ──」 CAME ALONG WITH `reInject`,
// which was the member directly under it in chat_controller.dart. Its other
// three members (`editEntry` / `reprocessEntry` / `deleteEntry`) are in
// chat_row_rewrite.dart — that separator's scope is now split across two files.
// It was moved rather than dropped because this card does not delete existing
// prose; where it landed is recorded here and in that file's header.

part of 'chat_controller.dart';

extension ChatExplicitDelivery on ChatController {
  /// The 「+」 panel's photo-album images. Null on success or user cancel; a
  /// real failure is returned AND parked on [imageFailure]. [original] = the
  /// "original image" checkbox, passed in per call — no state is kept here.
  Future<ImageSendFailure?> sendImage({bool original = false}) =>
      imageSend.pickAndSend(original: original);

  // ── ComposeBand: explicit send + remote control keys (T-3a ①②) ───────

  /// The explicit ➤. Delivers the CURRENT buffer, then empties it. Returns
  /// null on success, or the fail-loud reason (body in chat_utterance.dart —
  /// this file is at the source cap).
  Future<ComposeSendFailure?> sendBuffer() => _sendBuffer(this);

  /// F-5 「点选即发」("tap to send"). Delivered through the SAME emission path as ➤
  /// ([ManualDelivery.deliverText] is the only place a manual inject:request
  /// is built) so a tapped phrase gets identical row-building, correlation and
  /// fail-loud behaviour. It deliberately does NOT route through the buffer
  /// (overwriting a composition the user never asked to discard); it settles
  /// no buffered rows, so it always builds its own row (D10).
  Future<ComposeSendFailure?> sendFavorite(String text) =>
      delivery.deliverText(text.trim(), covered: const <String>[]);

  /// REQ-12-09 09-F/09-J — the 「+」 panel's multi-select send. The SEVENTH explicit delivery entry
  /// point, and it adds no eighth emission path: it ends in the same
  /// [ManualDelivery.deliverText] as ➤ / Favorites, and in the same
  /// [ImageSendController] leg every other picture uses.
  ///
  /// 🔴 THE SHAPE IS THE RULING, AND IT IS ASYMMETRIC ON PURPOSE (owner
  /// 2026-08-12): the ticked TEXT is already ONE composed string by the time it
  /// gets here — joined in tick order with a single '\n' and no decoration, see
  /// `joinSelectedTexts` — so it is **exactly one** `deliverText`, hence exactly
  /// one timeline row (D10). Each ticked PICTURE is its own delivery and its own
  /// row: 「Images must be sendable in new line, not merging to text line.」
  /// ⇒ N texts + M pictures ⇒ **1 + M** messages and **1 + M** rows, and with
  /// M = 0 that is still exactly one.
  ///
  /// 🔴 SEQUENTIAL, NOT `Future.wait`. `ImageSendController` drops a send that
  /// starts while another is in flight (its `_sending` guard, which exists so a
  /// double tap cannot duplicate a delivery) — firing M of them at once would
  /// silently deliver ONE picture and return success for all M. That is the
  /// 「claiming something got done when it didn't」 half of the red line, and
  /// it would look like a working feature.
  ///
  /// ⚠️ [text] is null when nothing textual was ticked; then there is no text
  /// message at all, rather than an empty one. `deliverText` would refuse an
  /// empty string anyway (`ComposeSendFailure.emptyBuffer`), and asking it to
  /// refuse something we already know is not there is how a real refusal gets
  /// buried among rehearsed ones.
  ///
  /// ⚠️ Outcomes are NOT aggregated into a return value, deliberately. Each leg
  /// already parks its own fail-loud conclusion where the user is looking (the
  /// compose banner / the image banner) and settles its own row; inventing a
  /// combined 「1 of 3 failed」 verdict here would be a second, competing
  /// answer to a question two mechanisms already answer per delivery.
  ///
  /// 🔴 card F4 — THE LENGTH REFUSAL IS A PRE-FLIGHT, AND THAT ORDERING IS THE
  /// WHOLE POINT. `deliverText` refuses an over-cap text on its own (it is the
  /// gate for ➤ and Favorites too), but a refusal discovered THERE would already be
  /// too late here: the loop below would go on to deliver M pictures, leaving a
  /// half-sent selection whose two halves nobody can tell apart from the phone.
  /// A user who ticked 3 notes and 2 photos would see 2 messages arrive and have
  /// no way to know which of the five made it. Refuse the whole selection or
  /// refuse nothing.
  ///
  /// ⚠️ It is NOT the outcome aggregation ruled out above: nothing is being
  /// summarised after the fact: this is a check made BEFORE the first leg
  /// starts, and it uses the same `exceedsInjectTextCap` predicate the gate in
  /// `deliverText` uses, so there is one rule with two call sites rather than
  /// two rules. The refusal is raised on the same banner every other text
  /// failure uses (`ManualDelivery.raise`) — no second surface.
  ///
  /// ⚠️ Deliberately narrow: it bails for THIS reason only, not for every
  /// `deliverText` failure. `notConnected` / `linkDown` would stop the pictures
  /// on their own (they share the transport); over-length is the one refusal the
  /// text can hit while every picture beside it is perfectly deliverable — which
  /// is exactly why it is the one that produces a split send.
  Future<void> sendPlusSelection({
    required String? text,
    required List<TimelineEntry> images,
  }) async {
    if (text != null && exceedsInjectTextCap(text)) {
      delivery.raise(ComposeSendFailure.tooLong);
      return;
    }
    if (text != null && text.isNotEmpty) {
      await delivery.deliverText(text, covered: const <String>[]);
    }
    for (final TimelineEntry picture in images) {
      await imageSend.sendStoredImage(picture);
    }
  }

  /// The remote keys (⏎⌫↶✕ + the punct* family). See chat_control_keys.dart.
  bool sendControlKey(ControlKeyKind kind) {
    final ({bool sent, bool changed}) r = runControlKey(this, kind);
    if (r.changed) notifyUi();
    return r.sent;
  }

  /// The row's inline resend — 🔴 TWO ACTIONS, NOT ONE (body + argument:
  /// `outboxResendEntry`). Consumer: `ChatMessageTile.onRetry`.
  void resendEntry(TimelineEntry entry) => outboxResendEntry(this, entry);

  // ── long-press actions ───────────────────────────────────────────────
  /// Deferred delivery: re-deliver an existing row to the current PC focus.
  ///
  /// RV-02 moved the body into [ManualDelivery] — deferred delivery is the
  /// fourth EXPLICIT delivery, and it belongs with the other three so it
  /// shares their in-flight claim, their 20 s inject:result watchdog and
  /// their fail-loud write-back instead of being the one path with none of
  /// them. Stays `void` here: all four entry points (the row's inline ✗
  /// resend / long-press deferred-delivery / resend-after-edit / banner
  /// resend) fire and forget, and the outcome is told on the row and in the
  /// banner, never in a return.
  void reInject(TimelineEntry entry) => unawaited(delivery.reInject(entry));
}
