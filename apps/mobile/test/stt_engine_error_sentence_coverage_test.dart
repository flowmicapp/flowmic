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
//
// 🔴 TWO TREES RUN THIS SUITE (RELEASE-IRONRULES §1-13, discovered
// 2026-09-02 as the first public-CI red on the 0.3.58 export sync):
//   - the PRIVATE tree, where all three source roots below exist and the
//     union of discoverable codes is 6 (measured);
//   - the PUBLIC export, where `packages/stt-cloud` is EXCLUDEd by name
//     (`scripts/opensource-manifest.mjs`: "私有云端 STT 厂商适配器…我们的
//     key、我们的成本、闭源集成") — its directory is structurally absent
//     there, and the union drops to 4 (measured).
// A positive control written for the private tree's total (>=5) is a false
// alarm in the public tree: it fails not because a producer moved or the
// regex broke, but because that tree never had `packages/stt-cloud` to
// begin with. `if (!dir.existsSync()) continue;` in the scanner below
// already tolerated a missing root silently — it could not tell "this root
// is intentionally excluded from this tree" apart from "this root moved and
// the scan is now blind". The fix is to test each root against its OWN
// measured floor (so a moved/renamed root still fails loudly) and to say,
// by name, when a root is absent by export design rather than by accident.
import 'dart:io';

import 'package:flowmic/generated/protocol_error_sentences.g.dart'
    show protocolErrorSentence;
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flutter_test/flutter_test.dart';

/// `flutter test`'s working directory is fixed at this package's root
/// (apps/mobile), same as the inject-verdict mirror test.
const String _engineDir = '../../apps/server-core/src/engine';
const String _sttDir = '../../apps/server-core/src/stt';
const String _sttCloudDir = '../../packages/stt-cloud/src';

const List<String> _serverStttEngineSourceDirs = <String>[
  _engineDir,
  _sttDir,
  _sttCloudDir,
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

/// Scans a single root. Returns the empty set for a root that does not
/// exist in this tree — the caller decides whether that absence is
/// expected (export-excluded) or alarming (a root that must always exist).
Set<String> _discoverCodesIn(String dirRel) {
  final Set<String> found = <String>{};
  final Directory dir = Directory(dirRel);
  if (!dir.existsSync()) return found;
  for (final FileSystemEntity entry in dir.listSync(recursive: true)) {
    if (entry is! File || !entry.path.endsWith('.ts')) continue;
    if (entry.path.endsWith('.test.ts')) continue; // test fixtures, not producers
    final String text = entry.readAsStringSync();
    for (final RegExpMatch m in _codeAssignment.allMatches(text)) {
      found.add(m.group(1)!);
    }
  }
  return found..removeAll(_notSttErrorCodes);
}

/// Union across every root present in THIS tree. Used by the sentence-
/// coverage test, which must cover whatever codes this tree can actually
/// produce — no more, no less.
Set<String> _discoverCandidateCodes() {
  final Set<String> found = <String>{};
  for (final String dirRel in _serverStttEngineSourceDirs) {
    found.addAll(_discoverCodesIn(dirRel));
  }
  return found;
}

void main() {
  group('WP-8: every STT-engine code:\'X\' producer has a phone sentence', () {
    test('positive control: the scan is not blind', () {
      final Set<String> total = _discoverCandidateCodes();
      // Universal floor: true in BOTH trees — it is the PUBLIC tree's
      // structural minimum (measured 2026-09-02: engine=0, stt=4,
      // stt-cloud absent). If this ever drops below it in EITHER tree, a
      // root that must always exist moved or the regex broke — either way
      // the sentence-coverage test below would pass VACUOUSLY, which is
      // worse than failing loudly here first.
      expect(total.length, greaterThanOrEqualTo(4),
          reason: 'discovered: $total — scan may have drifted');
      expect(total, contains('STT_NETWORK_DROP'),
          reason:
              "the stt root's cold-open verdict literal (cold-open-verdict.ts) must be found");

      // apps/server-core/src/engine is NOT export-excluded — it must exist
      // in every tree this suite runs in.
      expect(Directory(_engineDir).existsSync(), isTrue,
          reason: '$_engineDir must exist in every tree (not export-excluded)');
      // Measured 2026-09-02: this root yields 0 literal `code: 'X'`
      // producers of its own today — `stt-session.ts`'s `o.on('error', …)`
      // forwards `e.code` (a variable read off the thrown error), not a
      // string literal, so this regex legitimately never matches here. It
      // stays in the scan for when that changes; no non-trivial minimum is
      // asserted because 0 is the honest, current floor and asserting
      // `>= 0` would prove nothing.

      // apps/server-core/src/stt is NOT export-excluded either.
      expect(Directory(_sttDir).existsSync(), isTrue,
          reason: '$_sttDir must exist in every tree (not export-excluded)');
      final Set<String> sttCodes = _discoverCodesIn(_sttDir);
      expect(sttCodes.length, greaterThanOrEqualTo(4),
          reason: 'discovered in $_sttDir: $sttCodes — scan may have drifted');

      // packages/stt-cloud IS export-excluded (opensource-manifest.mjs:
      // "私有云端 STT 厂商适配器 (Soniox 等):我们的 key、我们的成本、闭源
      // 集成"). Present only in the private tree.
      final Directory sttCloudDir = Directory(_sttCloudDir);
      if (sttCloudDir.existsSync()) {
        final Set<String> cloudCodes = _discoverCodesIn(_sttCloudDir);
        expect(cloudCodes.length, greaterThanOrEqualTo(2),
            reason: 'discovered in $_sttCloudDir: $cloudCodes — scan may have drifted');
        expect(
          cloudCodes,
          containsAll(<String>['STT_ENGINE_AUTH_FAIL', 'STT_ENGINE_RATE_LIMITED']),
          reason: 'discovered in $_sttCloudDir: $cloudCodes',
        );
      } else {
        markTestSkipped(
          'packages/stt-cloud is not part of this tree (public export '
          'excludes it — scripts/opensource-manifest.mjs). Its codes are '
          'not asserted here; the universal floor above still guards '
          'against a blind scan of the roots this tree DOES carry.',
        );
      }
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
