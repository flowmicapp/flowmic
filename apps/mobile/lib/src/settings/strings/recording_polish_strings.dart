// NR118-3: moved verbatim from RecordingStrings (799 lines before this card).
part of '../app_strings.dart';

mixin PolishStrings on AppStringsLeaves {
  // ── STT polish honest signal (WP-R4-6 ⑦) ────────────────────────────────
  /// Transient chat-bubble corner mark when stt:final arrives with
  /// polish:'skipped'. Delivery still happened (two-stage text); this only
  /// tells the user the LLM polish layer did not apply. Never a status five-state.
  String get polishSkipped => _lfPolishSkipped;
  String get polishNotApplied => _lfPolishNotApplied;
  String get polishTimedOut => _lfPolishTimedOut;
  String get polishUnavailable => _lfPolishUnavailable;
  /// NR-123 — row badge for polish_reason `not_configured` (short).
  String get polishNoModel => _lfPolishNoModel;
  /// NR-123 — the one-time chat hint that says where on the computer a model
  /// is set up. Shown only on the LAN route (ChatStatusSurface.polishNoModelHint).
  String get polishNoModelHint => _lfPolishNoModelHint;
  /// NR-130 — row badge for polish_reason `model_rejected` (short).
  String get polishModelRejected => _lfPolishModelRejected;
  /// NR-130 — the one-time chat hint: the model set up on the computer was
  /// refused; check its settings there. LAN route only
  /// (ChatStatusSurface.polishModelRejectedHint).
  String get polishModelRejectedHint => _lfPolishModelRejectedHint;

}
