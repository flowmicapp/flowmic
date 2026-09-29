// NR118-3: this records the polish outcome, never the delivery status.
import '../settings/app_strings.dart';
import '../stt/stt_stream.dart';

enum PolishBadge {
  notApplied,
  timedOut,
  unavailable,
  /// NR-123: nothing is configured (no AI model on that server). Not
  /// [unavailable]: "not set up" and "broken" are two facts with two fixes.
  noModel,
  /// NR-130: a model IS set up and its provider refused it (bad key, unknown
  /// model). Not [unavailable] (waiting will not fix it) and not [noModel]
  /// (something is set up); the fix is in the model settings.
  modelRejected,
  skipped;

  static PolishBadge? fromFinal(SttFinal f) {
    if (f.polish != SttPolish.skipped) return null;
    if (f.polishReason == 'empty_output' && f.text.trim().isEmpty) return null;
    return switch (f.polishReason) {
      'guard_reject' || 'empty_output' => PolishBadge.notApplied,
      'timeout' => PolishBadge.timedOut,
      'llm_error' => PolishBadge.unavailable,
      'not_configured' => PolishBadge.noModel,
      'model_rejected' => PolishBadge.modelRejected,
      _ => PolishBadge.skipped,
    };
  }

  String label(AppStrings strings) => switch (this) {
    PolishBadge.notApplied => strings.polishNotApplied,
    PolishBadge.timedOut => strings.polishTimedOut,
    PolishBadge.unavailable => strings.polishUnavailable,
    PolishBadge.noModel => strings.polishNoModel,
    PolishBadge.modelRejected => strings.polishModelRejected,
    PolishBadge.skipped => strings.polishSkipped,
  };
}
