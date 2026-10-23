// NR-279 review S3 — the 「pending wording」 skip must fail LOUDLY if it
// outlives its purpose.
//
// WHY THIS EXISTS. test/support/pending_wording_faces.dart lists faces that are
// their own presentation state but still borrow another face's word, and the
// three 「every face has its own word」 tests (delivery_terminology_test,
// inject_state_narrowing_test, outbox_ui_surface_test) SKIP those faces. That
// skip is silent: if the card that lands the word never comes, nothing goes
// red — the swap-point pin in row_no_result_note_test stays green forever and
// the distinctness tests keep not looking.
//
// THE TRIPWIRE. The skip was granted for the 0.3.115 → 0.3.116 interval only
// (owner 2026-10-19: 0.3.116 does not ship before the word lands). So this test
// FAILS when the set is non-empty AND the app version in pubspec.yaml is
// 0.3.116 or later — i.e. at the version bump, unless the wording card already
// emptied the set. It reads the version from pubspec.yaml because that is what
// `scripts/bump-version.mjs` rewrites; it does not read any other face.
//
// If this goes red: land the word (swap the arm in status_badge.dart
// `deliveryFaceMeta`, empty the set, update the pin) — do NOT bump the
// threshold below to make it pass; that would be the silent skip again.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'support/pending_wording_faces.dart';

/// The first version that must not ship with a borrowed word.
const List<int> _kMustHaveOwnWordingBy = <int>[0, 3, 116];

List<int> _pubspecVersion() {
  final String text = File('pubspec.yaml').readAsStringSync();
  final RegExpMatch? m =
      RegExp(r'^version:\s*(\d+)\.(\d+)\.(\d+)', multiLine: true)
          .firstMatch(text);
  if (m == null) {
    throw StateError('pubspec.yaml has no parsable `version:` line');
  }
  return <int>[
    int.parse(m.group(1)!),
    int.parse(m.group(2)!),
    int.parse(m.group(3)!),
  ];
}

bool _atLeast(List<int> v, List<int> floor) {
  for (int i = 0; i < 3; i++) {
    if (v[i] != floor[i]) return v[i] > floor[i];
  }
  return true;
}

void main() {
  test('a borrowed status word does not survive into 0.3.116', () {
    final List<int> version = _pubspecVersion();
    // Positive control on the reader: a real version was parsed (a blind
    // reader returning zeros would make this test pass forever).
    expect(version.first + version[1] + version.last, greaterThan(0));
    if (!_atLeast(version, _kMustHaveOwnWordingBy)) return;
    expect(
      kFacesAwaitingOwnWording,
      isEmpty,
      reason: 'app version ${version.join('.')} ships while these faces still '
          'borrow another face\'s word: $kFacesAwaitingOwnWording. Land the '
          'word and empty test/support/pending_wording_faces.dart (see this '
          'file\'s header) — do not move the threshold.',
    );
  });
}
