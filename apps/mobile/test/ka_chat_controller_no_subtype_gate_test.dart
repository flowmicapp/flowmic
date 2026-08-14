// Card K-a (ruling 2026-08-05, landed 2026-08-13) — nobody may subtype
// ChatController, and the gate fires AT THE MOMENT somebody first does.
//
// SPEC-REF:
//   docs/decisions/2026-08-05-it18-leftover-items-rulings.md §K-a
//   apps/mobile/lib/src/session/chat_ptt_lifecycle.dart (header: why the four
//     `part` files use `extension`, and the price)
//
// ── THE TRAP THIS GUARDS ────────────────────────────────────────────────────
// Four `part` files extend ChatController via `extension`. Extension members
// resolve STATICALLY: they do not satisfy interfaces and cannot be overridden.
// A subclass / `implements` / mixin application of ChatController therefore
// LOOKS like it can override `sendBuffer` or `autoStopped` and silently
// cannot — the fake compiles, the tests pass, and the double answers with the
// real implementation's behaviour. Today apps/mobile has ZERO subtypes and
// every test constructs the real ChatController, so the hazard is real and
// untriggered — exactly when a gate is cheap.
//
// ── WHY A TEST AND NOT (ONLY) THE FOUR FILE HEADERS ─────────────────────────
// The ruling's own words: the person who trips this 「正在写测试，不是在读那
// 四个文件头」. A warning only readable by someone who already knows to look
// for it is not a gate. This file scans lib/ AND test/ — the subtype, when it
// comes, will almost certainly be a test double — and its failure message says
// what to do instead. The acceptance criterion the ruling fixed is the
// TRIGGER MOMENT, not the mechanism: this red shows up in the same
// `flutter test` run that compiles the first subtype.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Matches a type header clause that subtypes ChatController:
///   `extends ChatController`, `implements …, ChatController[, …]`,
///   `with …, ChatController[, …]` — but NOT `extension … on ChatController`
///   (that is the four part-files' own mechanism and is exactly not a subtype)
///   and NOT identifiers that merely contain the name (ChatControllerFake is
///   still a violation only if it subtypes; its NAME is fine).
final RegExp kSubtypeClause = RegExp(
  r'\b(extends|implements|with)\b[^;{]*\bChatController\b',
);

String _stripLineComments(String src) => src
    .split('\n')
    .map((String l) {
      final int at = l.indexOf('//');
      return at < 0 ? l : l.substring(0, at);
    })
    .join('\n');

/// This gate must not report itself: its own doc and the regex above spell the
/// forbidden clause out.
const String kSelf = 'ka_chat_controller_no_subtype_gate_test.dart';

void main() {
  test('K-a: no class extends / implements / mixes in ChatController', () {
    final List<String> hits = <String>[];
    for (final String root in <String>['lib', 'test']) {
      for (final FileSystemEntity f
          in Directory(root).listSync(recursive: true)) {
        if (f is! File || !f.path.endsWith('.dart')) continue;
        if (f.path.endsWith(kSelf)) continue;
        final String src = _stripLineComments(f.readAsStringSync());
        for (final RegExpMatch m in kSubtypeClause.allMatches(src)) {
          // `extension X on ChatController` never matches (no
          // extends/implements/with), and `on ChatController` inside a mixin
          // declaration constrains rather than subtypes — but `with` in a
          // class header does apply a mixin, so it stays flagged.
          hits.add('${f.path.replaceAll(r'\', '/')}: 「${m.group(0)!.trim()}」');
        }
      }
    }
    expect(
      hits,
      isEmpty,
      reason: 'somebody just subtyped ChatController. Four of its part files '
          '(chat_ptt_lifecycle / chat_notices / chat_status_surface / '
          'chat_explicit_delivery vintage) add members via `extension`, which '
          'resolve STATICALLY: your subclass cannot override or even satisfy '
          'them, so a test double built this way silently answers with the '
          'real implementation. Build fixtures the way every existing test '
          'does — construct the real ChatController over fakes of its '
          'collaborator interfaces (ManualDeliveryHost / AiComposeHost / '
          'OutboxDrainHost are all fakeable). Found:\n  ${hits.join('\n  ')}',
    );
  });

  test('positive control: the clause detector actually detects', () {
    expect(
      kSubtypeClause.hasMatch('class Fake extends ChatController {'),
      isTrue,
    );
    expect(
      kSubtypeClause.hasMatch(
        'class Fake with Something, ChatController {',
      ),
      isTrue,
    );
    expect(
      kSubtypeClause.hasMatch(
        'class Fake implements AiComposeHost, ChatController {',
      ),
      isTrue,
    );
    // The legitimate shapes stay clean.
    expect(
      kSubtypeClause.hasMatch('extension Foo on ChatController {'),
      isFalse,
      reason: 'the part files\' own mechanism must not trip the gate',
    );
    expect(
      kSubtypeClause.hasMatch('final ChatController controller;'),
      isFalse,
    );
  });
}
