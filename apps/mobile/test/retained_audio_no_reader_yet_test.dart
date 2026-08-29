// Card CR-4 → CR-5 HANDOFF GUARD.
//
// The retained-audio store mixes two sessions' bytes into one file. That is
// measured, not suspected — `retained_audio_orphan_adoption_test.dart` (across
// app runs) and `retained_audio_session_identity_test.dart` (across sessions in
// one run, no crash required) both pass today.
//
// It is currently HARMLESS, and only for one reason: nothing in production ever
// reads those bytes back. The recovery path is card CR-5 and it does not exist.
//
// 🔴 SO THIS FILE EXISTS TO ANSWER 「IF I AM WRONG, WHO TELLS ME?」 — the
// question this repo requires before leaving a known defect unfixed. The answer
// must not be 「a comment nobody greps」. The moment somebody wires a reader,
// the contamination stops being latent and starts being a user reading someone
// else's meeting inside their own article, silently. This test goes red on that
// commit, before the reader can ship.
//
// ── WHY THE FIX IS DEFERRED RATHER THAN DONE HERE ───────────────────────────
//
// The file key has to say WHICH ARTICLE the audio belongs to, and the article
// model is card CR-7. Choosing the key now, with no consumer to satisfy, is how
// you get a key that CR-7 has to change — so the requirement is recorded with
// passing measurements instead, and the fix belongs to CR-5's first step.
//
// ── HOW TO RETIRE THIS FILE ─────────────────────────────────────────────────
//
// Give the retained files a session identity, delete this guard in the same
// commit, and say so in the message. Do NOT add your reader to the allowlist
// below — the allowlist is for callers that do not read BYTES.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Members that hand out retained AUDIO BYTES, or the list of what is on disk
/// to go and read. These are the ones that expose the contamination.
const List<String> _byteReaders = <String>[
  'pendingSegments(',
  'readSegment(',
];

/// Production files allowed to mention a reader WITHOUT reading bytes — i.e.
/// the layer's own implementation. Anything else is a real consumer.
const List<String> _allowed = <String>[
  'retained_audio_spill.dart',
  'retained_audio_store.dart',
];

void main() {
  test('🔴 no production code reads retained audio yet — and it must not until '
      'the files say whose they are', () async {
    final Directory lib = Directory('lib');
    expect(lib.existsSync(), isTrue,
        reason: 'positive control: run from apps/mobile, or this test is blind');

    final List<String> offenders = <String>[];
    int scanned = 0;
    bool sawTheLayerItself = false;

    await for (final FileSystemEntity e in lib.list(recursive: true)) {
      if (e is! File || !e.path.endsWith('.dart')) continue;
      scanned++;
      final String name = e.uri.pathSegments.last;
      final String src = e.readAsStringSync();
      if (_allowed.contains(name)) {
        if (_byteReaders.any(src.contains)) sawTheLayerItself = true;
        continue;
      }
      for (final String reader in _byteReaders) {
        if (src.contains(reader)) offenders.add('${e.path} → $reader');
      }
    }

    // 🔴 The scan must be able to FIND these strings, or "zero offenders" is
    // just a broken path. The layer's own files are the positive control.
    expect(sawTheLayerItself, isTrue,
        reason: 'positive control failed: the scan did not find $_byteReaders '
            'even in ${_allowed.join(" / ")}, so its zero result means '
            'nothing. Fix the scan before trusting it.');
    expect(scanned, greaterThan(100),
        reason: 'positive control: only $scanned dart files seen under lib/');

    expect(
      offenders,
      isEmpty,
      reason: '\n'
          'A production caller now reads retained audio:\n'
          '  ${offenders.join("\n  ")}\n\n'
          'Retained segment files are named seg-<idx>.pcm with no session in\n'
          'the name, open() adopts whatever it finds, append is\n'
          'FileMode.append, and the phone\'s segment key never returns to 0\n'
          'while the server\'s does (reset per session in orchestrator-core\n'
          'start()). Two sessions therefore share a file -- measured in\n'
          'retained_audio_session_identity_test.dart: 300 + 120 bytes = one\n'
          '420-byte file, from two ordinary recordings in a row.\n\n'
          'Reading those bytes back hands one session\'s audio to another\n'
          'session\'s article, with nothing to detect it. Give the files a\n'
          'session identity FIRST (card CR-4 remainder / CR-5 step one), then\n'
          'delete this guard in the same commit.',
    );
  });
}
