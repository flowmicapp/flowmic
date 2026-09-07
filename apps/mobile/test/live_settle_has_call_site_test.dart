// Card LS-1b — THE PREDICATE HAS EXACTLY TWO PRODUCTION CALLERS, AND
// `justDone` IS NOT A DELETE TRIGGER.
//
// SPEC-REF:
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A6-3 (one answer to 「may these bytes go」), §A9 E25, E21/E48 (what
//     `justDone` does not prove)
//   apps/mobile/lib/src/session/recovery_settle.dart
//
// 🔴 WHY A SOURCE-LEVEL TEST AND NOT A BEHAVIOURAL ONE. What is being defended
// is the ABSENCE of a second answer, and absence has no symbol to drive: a
// third call site, or a `justDone` sitting next to a delete, would break
// nothing that any behavioural test exercises. `live_settle_test.dart` proves
// the live path works; this proves nobody has quietly added a shorter route
// past the predicate.
//
// 🔴 IT READS THE SOURCE, SO IT CAN LIE ABOUT ITSELF IF THE PATHS ROT. Every
// file it opens is asserted to exist first — a grep over a file that is not
// there returns zero matches and would read as 「clean」, which is the shape
// this repo calls a measurement that answered a different question.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// `apps/mobile` — the test process runs with that as its working directory.
File _src(String relative) => File('lib/src/$relative');

String _read(String relative) {
  final File f = _src(relative);
  expect(f.existsSync(), isTrue,
      reason: 'positive control: lib/src/$relative must exist, or every grep '
          'below is vacuously clean');
  return f.readAsStringSync();
}

/// Every `.dart` under `lib/`, so 「no third caller」 is a statement about the
/// whole product rather than about the files this test happened to name.
List<File> _allSources() => Directory('lib')
    .listSync(recursive: true)
    .whereType<File>()
    .where((File f) => f.path.endsWith('.dart'))
    .toList(growable: false);

void main() {
  test('the settle predicate has exactly two production call sites', () {
    final List<String> callers = <String>[];
    for (final File f in _allSources()) {
      if (f.readAsStringSync().contains('evaluateRecoverySettle(')) {
        callers.add(f.path.replaceAll(r'\', '/'));
      }
    }
    // The declaration itself is one of the matches; the other two are the legs.
    expect(
      callers.map((String p) => p.split('/').last).toSet(),
      <String>{
        'recovery_settle.dart', // the declaration
        'recovery_leg_settle.dart', // caller ①: the recovery queue
        'live_settle.dart', // caller ②: the live press (card LS-1b)
      },
      reason: 'A6-3: ONE answer to 「may these bytes go」. A third caller is a '
          'second answer, and the weaker of two wins by accident.',
    );
  });

  test('the live settle is reached only from a terminal final', () {
    final String settle = _read('session/chat_utterance_settle.dart');
    expect(settle.contains('settleLiveRecording('), isTrue,
        reason: 'positive control: the call site is in this file');
    // The call must sit inside the `!f.isSegment` guard. Asserting on the
    // text between the guard and the call is crude and deliberate: a
    // continuous recording produces many soft-segment finals over ONE journal,
    // and settling on any of them would delete audio still being written.
    final int guard = settle.indexOf('if (!f.isSegment) {');
    final int call = settle.indexOf('settleLiveRecording(');
    expect(guard, greaterThan(-1),
        reason: 'the terminal-final guard must still be spelled this way, or '
            'this assertion is measuring nothing');
    expect(call, greaterThan(guard));
    expect(call - guard, lessThan(600),
        reason: 'the call must be INSIDE that guard, not merely after it');
  });

  test('no delete is triggered by justDone alone', () {
    // E21/E48: the FSM comes to rest on a stall and on a watchdog teardown too.
    // `justDone` may be read as ONE INPUT to the predicate (condition (ii)'s
    // local half) and may never be the thing that publishes a settle.
    //
    // The two files below are allowed to do both, and only because the FIRST
    // test in this file proves they route through `evaluateRecoverySettle` on
    // the way. Anything else that grows this pair is a shorter route.
    const Set<String> throughThePredicate = <String>{
      'live_settle.dart',
      // Two names for one leg since the 800-line split: the settle chapter
      // holds the publish, and the wait that reads `justDone` stayed with the
      // attempt body next door.
      'recovery_leg_settle.dart',
      'recovery_journal_leg.dart',
    };
    for (final File f in _allSources()) {
      final String name = f.path.replaceAll(r'\', '/').split('/').last;
      if (throughThePredicate.contains(name)) continue;
      final String s = f.readAsStringSync();
      if (!s.contains('SessionState.justDone')) continue;
      expect(s.contains('publishLiveSettle('), isFalse,
          reason: '${f.path}: reads justDone AND publishes a settle verdict.');
      expect(s.contains('markSettledForCleanup('), isFalse,
          reason: '${f.path}: reads justDone AND marks a recording cleanable.');
    }
    // Positive control: the one file that legitimately reads justDone for this
    // purpose does so as an INPUT, and hands the verdict to somebody else.
    final String live = _read('session/live_settle.dart');
    expect(live.contains('SessionState.justDone'), isTrue);
    expect(live.contains('evaluateRecoverySettle('), isTrue);
    expect(live.contains('deleteFile('), isFalse,
        reason: 'the decision and the delete are two files on purpose');
  });

  test('the deleted per-segment verb has not come back', () {
    // Audit item E25. `RetainedAudioSpill.settleSegment` was removed rather
    // than wired: on the legacy face, retained bytes are the bytes the server
    // never received, so 「a final arrived ⇒ settle that segment」 deletes audio
    // nothing transcribed. If the name reappears, so has that bug.
    //
    // ⚠️ CODE LINES ONLY. The spill carries a comment block at the site saying
    // the verb was deleted and why, and a grep that counted that block would
    // fail against the very documentation the audit asked for — a measurement
    // answering a different question.
    for (final File f in _allSources()) {
      for (final String line in f.readAsStringSync().split('\n')) {
        final String t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('///')) {
          continue;
        }
        expect(t.contains('settleSegment('), isFalse,
            reason: '${f.path}: E25 was closed by deleting this verb.');
      }
    }
    // Positive control: the block that records the deletion is still there, so
    // the next reader is told why rather than being left to re-derive it.
    expect(_read('audio/retained_audio_spill.dart').contains('E25 CLOSED'),
        isTrue);
  });

  test('the live attempt kind on the wire and in the manifest are one string',
      () {
    // The audio layer takes `attempt_kind` as a parameter rather than importing
    // the session layer's enum (a directory cycle for one four-letter string).
    // This is the pin that keeps the two spellings from drifting.
    expect(_read('session/recovery_identity.dart').contains("=> 'live',"),
        isTrue,
        reason: 'RecoveryAttemptKind.live.wire must still be `live`');
    expect(
      _read('session/live_settle.dart')
          .contains('attemptKindWire: RecoveryAttemptKind.live.wire'),
      isTrue,
      reason: 'the manifest must be written with the WIRE spelling, not a '
          'second copy of it',
    );
  });
}
