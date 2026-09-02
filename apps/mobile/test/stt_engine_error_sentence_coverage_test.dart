// WP-8 (2026-09-02) — "every server code:'X' producer under
// apps/server-core/src that reaches a phone has a sentence"
// (docs/strategy/2026-09-02-full-implementation-audit-and-next-plan.md
// §5-4 item 7 / F1-b). Scoped to the STT engine-error family reaching
// `stt:error` (`engine/stt-session.ts`'s `o.on('error', …)` forwards
// whatever the ENGINE named as `code`, defaulting to STT_NETWORK_DROP) — the
// exact frame F1-b measured a raw identifier reaching the user on.
//
// The technique is not this file's invention: `inject_verdict_authorship_
// mirror_test.dart` already reads a TS source file with Dart's `dart:io`
// rather than trusting a hand-copied list; this is the same discipline
// pointed at a different question — not "do two tables agree" but "does
// every code the SERVER can actually emit here land on a real sentence".
//
// 🔴 WHAT THIS DOES NOT COVER, stated rather than implied: pairing/compose
// codes (pairing_strings.dart / compose_strings.dart) are a different
// producer family, owned by a different file set, and are not swept here.
// This is one slice of the audit item, not the whole of it.

import 'dart:io';

import 'package:flowmic/generated/protocol_error_sentences.g.dart'
    show protocolErrorSentence;
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flutter_test/flutter_test.dart';

/// `flutter test`'s working directory is fixed at this package's root
/// (apps/mobile), same as the inject-verdict mirror test.
const List<String> _serverStttEngineSourceDirs = <String>[
  '../../apps/server-core/src/engine',
  '../../apps/server-core/src/stt',
  '../../packages/stt-cloud/src',
];

/// Matches `code: 'SOME_CODE'` / `code = 'SOME_CODE'` — the two forms these
/// three trees actually use to name an `stt:error` code. Deliberately does
/// NOT match arbitrary uppercase identifiers elsewhere (log messages, enum
/// members with no `code` prefix) — the anchor is the field/variable name,
/// not the shouty-case shape alone, which would also catch things like
/// Node's `'EACCES'` (measured: an early draft of this regex did, and had to
/// be narrowed).
final RegExp _codeAssignment = RegExp(r"\bcode\s*[:=]\s*'([A-Z][A-Z0-9_]*)'");

/// Codes this family is known to name that are NOT protocol `ErrorCode`s at
/// all (local model-download faults, a different frame entirely) — excluded
/// by name rather than by "isn't in the registry", so a genuinely new engine
/// code with a typo cannot silently join this allow-list.
const Set<String> _notSttErrorCodes = <String>{
  'MODEL_DISK_FULL',
  'MODEL_DOWNLOAD_FAILED',
  'MODEL_INTEGRITY_MISMATCH',
  'MODEL_SOURCE_UNREACHABLE',
  'MODEL_WRITE_DENIED',
};

Set<String> _discoverCandidateCodes() {
  final Set<String> found = <String>{};
  for (final String dirRel in _serverStttEngineSourceDirs) {
    final Directory dir = Directory(dirRel);
    if (!dir.existsSync()) continue; // see the positive control below
    for (final FileSystemEntity entry in dir.listSync(recursive: true)) {
      if (entry is! File || !entry.path.endsWith('.ts')) continue;
      if (entry.path.endsWith('.test.ts')) continue; // test fixtures, not producers
      final String text = entry.readAsStringSync();
      for (final RegExpMatch m in _codeAssignment.allMatches(text)) {
        found.add(m.group(1)!);
      }
    }
  }
  return found..removeAll(_notSttErrorCodes);
}

void main() {
  group('WP-8: every STT-engine code:\'X\' producer has a phone sentence', () {
    test('positive control: the scan is not blind', () {
      final Set<String> codes = _discoverCandidateCodes();
      // If this ever drops to 0, the directories moved or the regex broke —
      // either way the test below would pass VACUOUSLY, which is worse than
      // failing loudly here first.
      expect(codes.length, greaterThanOrEqualTo(5),
          reason: 'discovered: $codes — scan may have drifted');
      expect(codes, contains('STT_NETWORK_DROP'),
          reason: 'the o.on(\'error\', …) DEFAULT in engine/stt-session.ts must be found');
    });

    test('every discovered code renders a real sentence, in both locales '
        'the registry carries', () {
      final Set<String> codes = _discoverCandidateCodes();
      for (final String code in codes) {
        for (final AppLocale locale in <AppLocale>[AppLocale.zh, AppLocale.en]) {
          final AppStrings s = AppStrings.of(locale);
          final String rendered = s.sttStallBannerMessage(
            SttStall(SttStallReason.engineError, code: code),
          );
          final bool hasBespokeCase = !rendered.contains(code);
          final bool hasGeneratedFallback =
              protocolErrorSentence(code, preferZh: locale == AppLocale.zh) != null;
          expect(
            hasBespokeCase || hasGeneratedFallback,
            isTrue,
            reason:
                '$code ($locale) reaches the phone as a raw identifier: neither a '
                'bespoke recording_strings.dart case nor the generated protocol '
                'fallback covers it — rendered: "$rendered"',
          );
          // The rendered text and the registry-fallback claim must agree, not
          // merely both be "true": a bespoke case wins outright (it may say
          // MORE than the registry does — e.g. an action to take), but if
          // there is no bespoke case the rendered text must BE the fallback,
          // not a third, undiscoverable string.
          if (!hasBespokeCase) {
            expect(rendered, protocolErrorSentence(code, preferZh: locale == AppLocale.zh));
          }
        }
      }
    });
  });
}
