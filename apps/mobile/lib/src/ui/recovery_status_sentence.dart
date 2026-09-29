import '../session/pending_recovery.dart';
import '../settings/app_strings.dart';

/// Complete recording status, including overrides above the state mapping.
/// All surfaces must call this rather than select a state sentence themselves.
/// EXHAUSTIVE, NO DEFAULT: a new recovery state must name its own sentence.
/// A default would silently borrow another state's claim about what happened
/// to the recording, defeating the pending screen's purpose and R11.
String recoveryStatusSentence(
  PendingRecoveryState state,
  AppStrings s, {
  bool otherAccount = false,
}) {
  if (otherAccount) return s.pendingRecoveryOtherAccount;
  return switch (state) {
    PendingRecoveryState.waitingAuto => s.pendingRecoveryStateWaiting,
    PendingRecoveryState.needsManual => s.pendingRecoveryStateNeedsManual,
    PendingRecoveryState.shortfall => s.pendingRecoveryStateShortfall,
    PendingRecoveryState.settledUnverified => s.pendingRecoveryStateUnverified,
    PendingRecoveryState.settledServerKeepsAudio =>
      s.pendingRecoveryStateServerKeepsAudio,
    PendingRecoveryState.emptyResult => s.pendingRecoveryStateEmptyResult,
    PendingRecoveryState.emptyConfirmed => s.pendingRecoveryStateEmptyConfirmed,
    PendingRecoveryState.serverUnsupported =>
      s.pendingRecoveryStateServerUnsupported,
    PendingRecoveryState.cancelled => s.pendingRecoveryStateCancelled,
    PendingRecoveryState.unreadable => s.pendingRecoveryStateUnreadable,
  };
}
