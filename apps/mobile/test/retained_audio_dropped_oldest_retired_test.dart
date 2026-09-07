// Card RC-1 (2026-09-06) — the `dropped-oldest` retention notice is retired,
// and this file is the only thing that can say so.
//
// SPEC-REF:
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-
//     threshold.md (owner ruling O-2 — the cap refuses, it never evicts)
//   apps/mobile/lib/src/audio/retained_audio_store.dart (the tombstone comment
//     where the constant used to stand)
//
// 🔴 WHY A SOURCE-TEXT TEST AND NOT A BEHAVIOURAL ONE. The thing being
// asserted is an ABSENCE, and every behavioural route to it is weaker than it
// looks: a test that drives the cap and checks the code is never announced is
// green both when the code is gone and when it is present with no producer —
// which is precisely the state card LS-3 left behind and this card is closing.
// The only judgment that separates "no producer" from "gone" is whether the
// identifier and its wire string exist in the source at all.
//
// ⚠️ IT SCANS lib/ ONLY, ON PURPOSE. The wire string still appears in two
// TEST files, as the literal a resurrected eviction path would announce
// (`retained_audio_cap_test.dart`, `retained_audio_test.dart`). Those are
// guards, not producers; widening this scan to test/ would delete the guards
// to satisfy the scanner.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the dropped-oldest notice code and its constant are gone from lib/',
      () {
    final Directory lib = Directory('lib');
    expect(lib.existsSync(), isTrue,
        reason: 'positive control: the scan runs from apps/mobile, so lib/ '
            'must be here — an empty result set from a missing directory '
            'would look exactly like a clean tree');

    final List<File> darts = lib
        .listSync(recursive: true)
        .whereType<File>()
        .where((File f) => f.path.endsWith('.dart'))
        .toList();
    expect(darts.length, greaterThan(200),
        reason: 'second positive control: the scanner is awake. A glob that '
            'matched nothing would report a clean tree for a tree it never '
            'read.');

    // Assembled rather than written whole, so this file does not become the
    // hit it is looking for if the scan is ever pointed at test/ too.
    const String wire = 'retained-audio-' 'dropped-oldest';
    const String ident = 'code' 'DroppedOldest';

    final List<String> wireHits = <String>[];
    final List<String> identHits = <String>[];
    int controlHits = 0;
    for (final File f in darts) {
      final String src = f.readAsStringSync();
      if (src.contains(wire)) wireHits.add(f.path);
      if (src.contains(ident)) identHits.add(f.path);
      // Third control: a sibling code that MUST still be there. If this stays
      // zero the reader is broken, and both empty lists above mean nothing.
      if (src.contains('retained-audio-cap-reached')) controlHits++;
    }

    expect(controlHits, greaterThan(0),
        reason: 'control code retained-audio-cap-reached must still be found '
            'in lib/ — it has a live producer');
    expect(wireHits, isEmpty,
        reason: 'the wire string outlived its producer once already (card '
            'LS-3 deleted _makeRoomFor and kept the sentence); RC-1 is the '
            'card that named itself as the removal');
    expect(identHits, isEmpty,
        reason: 'the constant, likewise: a user-visible string leaves with '
            'its producer (INJECT_NO_RECEIPT precedent)');
  });
}
