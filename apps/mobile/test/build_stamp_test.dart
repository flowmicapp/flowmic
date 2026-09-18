// Card SC-5 — the APK carries the commit it was built from, and
// scripts/publish.mjs GATE 0f reads it back out of the bytes.
//
// What this pins is the SEAM, because the seam is where it can silently break:
// the stamp prefix is spelled in three languages (Dart here, Rust in
// apps/desktop/src-tauri/src/build_stamp.rs, JS in
// scripts/build-stamp/require-clean-sha.mjs) and none of them can import the
// others. Rename it on one side with nothing checking and the gate scans every
// good APK for a string no build produces — it would refuse, loudly, about the
// wrong thing, and the fix someone would reach for (rebuild the APK) would not
// work. So the JS spelling is read from disk and compared.

import 'dart:io';

import 'package:flowmic/src/diag/build_stamp.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the stamp prefix is the one the publish gate scans for', () {
    final File js = File('../../scripts/build-stamp/require-clean-sha.mjs');
    if (!js.existsSync()) {
      // Release tooling may be absent (an open-source checkout): a missing file
      // is not a failing assertion about this app.
      return;
    }
    final RegExpMatch? m =
        RegExp(r"export const STAMP_PREFIX = '([^']+)'").firstMatch(js.readAsStringSync());
    expect(m, isNotNull, reason: 'STAMP_PREFIX not found in require-clean-sha.mjs');
    expect(
      kBuildShaStamp.startsWith(m!.group(1)!),
      isTrue,
      reason: 'the APK stamps "$kBuildShaStamp" but GATE 0f scans for "${m.group(1)}" — '
          'the gate would read every build as BLIND',
    );
  });

  test('a build with no define does not claim a commit', () {
    // `flutter test` passes no define, so this run IS the unstamped case. It
    // must read as unstamped rather than as an empty commit id: GATE 0f
    // branches on exactly this value, and an empty string would make the
    // artifact look stamped with nothing.
    expect(kBuildSha, 'unstamped-dev');
    expect(kBuildShaStamp, 'flowmic-build-sha:unstamped-dev');
  });

  test('the define key is the one the Makefile passes', () {
    final File mk = File('Makefile');
    if (!mk.existsSync()) return;
    final String text = mk.readAsStringSync();
    expect(
      text.contains('--dart-define=$kBuildShaDefineKey={sha}'),
      isTrue,
      reason: 'the release target does not pass $kBuildShaDefineKey — the APK would ship unstamped '
          'and publish GATE 0f would refuse it',
    );
  });
}
