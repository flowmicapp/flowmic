// SPEC-REF:
//   T-6b PopScope / header ← — shared exit disposition for the chat-flow page.
//   Pure so widget tests never await a real PttSession chain (FakeAsync deadlock).

/// What the chat-flow back affordance should do given live controller truth.
enum ChatBackKind {
  /// Leave immediately (call onBack + pop).
  leave,

  /// Confirm discarding unsent compose-buffer text first.
  confirmDiscard,

  /// Stop an in-flight PTT via pttUp (keep path) and stay on the page.
  stopRecording,
}

/// Pure policy: recording wins over buffer confirm (stop first, never silent-drop).
ChatBackKind chatBackKind({
  required bool isRecording,
  required bool hasUnsentBuffer,
}) {
  if (isRecording) return ChatBackKind.stopRecording;
  if (hasUnsentBuffer) return ChatBackKind.confirmDiscard;
  return ChatBackKind.leave;
}
