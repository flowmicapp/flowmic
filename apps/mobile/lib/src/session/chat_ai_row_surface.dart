// Part of chat_controller.dart — the AI/translate row's PLAIN, non-host-
// interface surface (card B2-O, 2026-09-02).
//
// ── WHY THIS SPLIT, AND WHAT IT IS NOT ───────────────────────────────────────
// chat_controller.dart sat AT the 800-line cap (`verify/lint/file-size.mjs`
// SRC_MAX = 800), and this card needed to add the retained-audio notice's
// field, its constructor subscription and its listener stub — none of which
// can move (Dart has no partial classes, so STATE stays with the class; see
// ptt_wire_keepalive.dart's header for the identical constraint). Only
// BEHAVIOUR can move, and only behaviour that is not an `@override`: the
// coordinator's own note on chat_ptt_lifecycle.dart/chat_status_surface.dart
// says it plainly — extension members are resolved STATICALLY and do NOT
// implement interfaces, so anything satisfying `AiComposeHost` (aiBuffer,
// aiCanStart, aiInstanceId, aiNotify, aiTranslateTarget) had to stay put.
//
// 🔴 NOTHING HERE CHANGED BEHAVIOUR. Every member below is what it was in
// chat_controller.dart — declaration, doc comment and body — with exactly ONE
// mechanical edit, the same one chat_explicit_delivery.dart's header
// declares for the identical reason: `notifyListeners()` became `notifyUi()`
// in [setTranslateTarget] / [loadTranslateTarget], because `notifyListeners`
// is `@protected` and an extension is not a subclass. **Any diff beyond that
// one is a bug.**
//
// WHY THIS SET AND NOT SOME OTHER SET: these are the two "de facto AI/compose"
// sections' NON-override remainder — [translateTarget] / [setTranslateTarget]
// / [loadTranslateTarget] (the "GA-01 utterance transform" section) and
// [aiTask] / [isAiComposing] / [canAiCompose] / [startAiCompose] /
// [restorableOriginal] / [restoreOriginal] (the "AI action row" section).
// Both sections already sat next to their `@override` siblings for the same
// reason — they read the same underlying run ([aiCompose] /
// [utteranceCompose]) — and both left behind exactly the members an
// interface never asked for. The field these getters read
// (`_translateTarget`) STAYS in chat_controller.dart, next to the section
// header that used to introduce this whole block; see that file for why.

part of 'chat_controller.dart';

extension ChatAiRowSurface on ChatController {
  /// The translate target language (GA-01 ruling 2). DEVICE-LOCAL like the send
  /// policy — this phone's habit, never a synced settings key. Snapshotted into
  /// compose:start per utterance, so changing it mid-sentence cannot re-aim the
  /// sentence already spoken.
  String get translateTarget => _translateTarget;

  Future<void> setTranslateTarget(String lang) async {
    if (lang.isEmpty || lang == _translateTarget) return;
    _translateTarget = lang;
    notifyUi();
    await localPrefs.setTranslateTarget(lang);
  }

  /// Hydrate the device-local translate target (called with the other
  /// local-prefs loads at startup).
  Future<void> loadTranslateTarget() async {
    _translateTarget = await localPrefs.translateTarget();
    notifyUi();
  }

  /// The task currently streaming, or null when the row is idle.
  ComposeTask? get aiTask => aiCompose.task;
  bool get isAiComposing => aiCompose.isRunning;

  /// AI-row enable gate. Deliberately NOT gated on [ChatController.destination]
  /// or on a live PC: compose is a phone↔server round trip that produces
  /// TEXT, not a delivery. Greying it out on a cloud instance would disable
  /// something that demonstrably works there.
  bool get canAiCompose => aiCompose.canStart;

  AiComposeFailure? startAiCompose(ComposeTask task) => aiCompose.start(task);

  /// 🔴 T-6 (owner supplement #5) — the text a successful organize/translate/polish
  /// replaced, or
  /// null. The card draws 「restore original」 iff this is non-null; see
  /// [AiComposeController.restorableOriginal] for the no-stacking rule.
  String? get restorableOriginal => aiCompose.restorableOriginal;

  /// Put that text back into the buffer. The notify rides on the controller's
  /// own `aiNotify`, so the field, the button and the send gate all repaint
  /// from one write.
  bool restoreOriginal() => aiCompose.restoreOriginal();
}
