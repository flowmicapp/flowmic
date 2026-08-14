// T-6b — pure back-policy tests. Widget layer must not await PttSession here.

import 'package:flowmic/src/ui/chat_back_policy.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('recording wins over an unsent buffer', () {
    expect(
      chatBackKind(isRecording: true, hasUnsentBuffer: true),
      ChatBackKind.stopRecording,
    );
  });

  test('unsent buffer alone → confirm discard', () {
    expect(
      chatBackKind(isRecording: false, hasUnsentBuffer: true),
      ChatBackKind.confirmDiscard,
    );
  });

  test('idle empty buffer → leave', () {
    expect(
      chatBackKind(isRecording: false, hasUnsentBuffer: false),
      ChatBackKind.leave,
    );
  });
}
