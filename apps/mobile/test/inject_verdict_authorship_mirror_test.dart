// Card F2 — **cross-language mirror guard**: the phone-side [kPcInjectionVerdictCodes]
// must be byte-for-byte equal to the protocol-side single source of truth.
//
// 🔴 Why a machine has to own this: Dart cannot see TypeScript symbols, so
// "both ends read the same list" is only a wish without a guard — the next
// person adds a code in TS, the phone silently misses one, and the missing
// one shows up as **a message that forever displays 「待投递」**, with nothing
// reporting an error.
//
// The technique is not this card's invention: `apps/desktop/src-tauri/src/error_codes.rs`
// `desktop_error_codes_are_a_subset_of_the_protocol_ssot` already reads the
// `error-codes.ts` source to check the Rust constants. This is the Dart edition
// of the same technique.
//
// SPEC-REF:
//   packages/protocol/src/inject-verdict-authorship.ts (single source of truth)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0.1

import 'dart:io';

import 'package:flowmic/src/session/outbox_inject_authorship.dart';
import 'package:flowmic/src/session/outbox_item.dart' show isTerminalRefusalCode;
import 'package:flutter_test/flutter_test.dart';

/// `flutter test`'s working directory is fixed at this package's root (apps/mobile).
final File _ssot = File(
  '../../packages/protocol/src/inject-verdict-authorship.ts',
);

/// Only accept "one entry per line" table rows: `  CODE_NAME: 'author',`.
/// Code names that appear in comments will not match (they are preceded by
/// `//` or `*`), nor will the union type `| 'pc-injection'` (no `CODE:` prefix).
final RegExp _entry = RegExp(
  r"^\s*([A-Z][A-Z0-9_]*)\s*:\s*'(pc-injection|pc-admission|relay|none)'\s*,",
  multiLine: true,
);

Map<String, String> _parseSsot() {
  // Fail immediately if the file cannot be read: a guard that "quietly passes
  // when the file is missing" is no guard at all.
  expect(
    _ssot.existsSync(),
    isTrue,
    reason: 'cannot find the protocol-side single source of truth ${_ssot.path} (cwd should be apps/mobile)',
  );
  final Map<String, String> out = <String, String>{};
  for (final RegExpMatch m in _entry.allMatches(_ssot.readAsStringSync())) {
    out[m.group(1)!] = m.group(2)!;
  }
  return out;
}

void main() {
  group('inject verdict authorship — phone mirror vs protocol single source of truth', () {
    test('the parser is not blind: all four authorships parsed (positive control)', () {
      // 🔴 This case runs first. If the equality assertion below were built on
      // a regex that parsed 0 rows, it would be "green and meaningless" —
      // negative / equality assertions must carry their own positive control
      // (a written rule of this repo).
      final Map<String, String> ssot = _parseSsot();
      expect(ssot.length, greaterThanOrEqualTo(50), reason: 'parsed count is abnormal; the regex may have drifted');
      final Set<String> authors = ssot.values.toSet();
      expect(authors, containsAll(<String>['pc-injection', 'pc-admission', 'relay', 'none']));
    });

    test('🔴 the pc-injection sets are byte-for-byte equal on both ends', () {
      final Map<String, String> ssot = _parseSsot();
      final Set<String> fromTs = ssot.entries
          .where((MapEntry<String, String> e) => e.value == 'pc-injection')
          .map((MapEntry<String, String> e) => e.key)
          .toSet();
      expect(
        fromTs,
        equals(kPcInjectionVerdictCodes),
        reason:
            'the protocol side changed authorship and outbox_inject_authorship.dart did not follow (or the reverse). '
            'Change packages/protocol/src/inject-verdict-authorship.ts first, then the phone mirror.',
      );
    });

    test('🔴 the pc-admission sets are byte-for-byte equal on both ends, and never mix with pc-injection', () {
      // owner 2026-08-02:「被占用时……只能先记录等它退出」⇒ the row = 待投递, the queue still owes it.
      // It is the PC speaking in its own voice, yet it is **not** evidence that
      // the delivery segment finished — that is exactly why authorship is three values.
      final Map<String, String> ssot = _parseSsot();
      final Set<String> fromTs = ssot.entries
          .where((MapEntry<String, String> e) => e.value == 'pc-admission')
          .map((MapEntry<String, String> e) => e.key)
          .toSet();
      expect(fromTs, equals(kPcAdmissionRefusalCodes));
      expect(ssot['INJECT_NOT_PRIMARY'], 'pc-admission');
      expect(isPcAdmissionRefusalCode('INJECT_NOT_PRIMARY'), isTrue);
      // 🔴 The two sets are disjoint: if one code is both "evidence delivery
      // succeeded" and "still owed", settle and the row's criterion will fight
      // on the spot.
      for (final String code in kPcAdmissionRefusalCodes) {
        expect(isPcInjectionVerdictCode(code), isFalse, reason: code);
      }
    });

    test('🔴 disjoint from the terminal-refusal table', () {
      // `settle` first asks "is this a PC injection-segment verdict" then
      // "is this a terminal refusal code". If the two sets intersect, that
      // order becomes a coin toss — so pin the disjointness itself.
      for (final String code in kPcInjectionVerdictCodes) {
        expect(
          isTerminalRefusalCode(code),
          isFalse,
          reason: '$code is both "evidence delivery succeeded" and "terminal refusal"; the two branches will fight',
        );
      }
    });

    test('unknown codes are always false (failure direction)', () {
      // Judging true = saying something unfinished was finished (red line R2
      // second direction, irreversible); judging false only falls back to
      // today's behaviour. The phone's own local codes naturally land on the
      // false side, and that is correct: no PC has spoken for them.
      for (final String? code in <String?>[
        null,
        '',
        'LINK_DOWN',
        'WIRE_EMIT_FAILED',
        'INJECT_NO_RESULT',
        'OUTBOX_OVERFLOW',
        'INJECT_SOMETHING_NEW',
      ]) {
        expect(isPcInjectionVerdictCode(code), isFalse, reason: '$code');
        expect(isPcAdmissionRefusalCode(code), isFalse, reason: '$code');
      }
    });
  });
}
