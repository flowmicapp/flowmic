// Package-wide test harness. Flutter runs this around EVERY test file in
// apps/mobile/test, so it is the one place a cross-cutting seam can be wired
// without touching dozens of files.
//
// Why it exists (V2-05 / R-UX-09):
//
// `countUsage()` asserts that `installUsageCounters()` has run. That assert is
// deliberate — 13 册 §7 F1 bans the friendly empty default, because this app
// once shipped an entire rewrite with the microphone never opened, the missing
// dependency having quietly fallen back to a polite stub. The assert is what
// makes "someone deleted the install" a loud failure instead of counters that silently
// read zero forever.
//
// The moment it was wired, nine widget tests went red — which is the assert
// doing exactly its job: those tests really were exercising counted controls
// with no counter installed. The fix is to give the suite a REAL counter over
// mock prefs, not to soften the assert into the very no-op it exists to forbid.

import 'dart:async';

import 'package:flowmic/src/session/usage_counters.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  // In-memory prefs; each test file gets its own process, so counts cannot leak
  // between files. Individual tests that need their own seed still call
  // setMockInitialValues themselves — that just replaces the store beneath us.
  SharedPreferences.setMockInitialValues(<String, Object>{});
  installUsageCounters(UsageCounters(await SharedPreferences.getInstance()));
  await testMain();
}
