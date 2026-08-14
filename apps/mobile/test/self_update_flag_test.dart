// UP-2 —— the build-time flag that forks store channels (design §6).
//
// 🔴 **This file pins the DIRECTION of the default, and that direction IS the
// safety property.**
//   · Forget the define ⇒ lose the feature, degrade to the status quo (the
//     user keeps using the build they already have);
//   · If the default were on, a Play build that forgot the define ⇒ ship a
//     package that violates policy.
// One is our own loss; the other is a consequence someone else bears for us.
// **The failure direction decides the default.**
//
// ⚠️ dart-define **enters neither lint, nor the type checker, nor any gate** ——
// this test is the only mechanical guard on that direction.

import 'package:flowmic/src/update/self_update_flag.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('🔴 without --dart-define, in-app update is **off**', () {
    // This is the condition `flutter test` runs under: no define is passed.
    expect(
      kSelfUpdateEnabled,
      isFalse,
      reason: 'the default must be off — a Play build that forgot the define '
          'must not carry the self-install path',
    );
  });

  test('the define name is pinned as FLOWMIC_SELF_UPDATE', () {
    // Pin the literal rather than comparing the constant to itself: a
    // self-referential assertion would move with a rename, and **the publish
    // command lives in docs and the runbook**, so renaming without updating
    // those is a silent failure.
    expect(kSelfUpdateDefineKey, 'FLOWMIC_SELF_UPDATE');
  });
}
