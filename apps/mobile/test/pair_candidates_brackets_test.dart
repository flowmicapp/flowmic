// NR-286 A3 (device 2026-10-20, `.local/device-evidence/0316-upgrade/report.md`
// A3) — the per-address lines of the 「none of these addresses reached the
// computer」 message wrapped every reason in full-width 「（…）」 in every
// language, so the English and Russian screens read
// 「https://100.64.7.68:41879（connection failed）」.
//
// The rule (pairing_strings.dart `pairCandidatesFailed`): full-width only where
// the catalogue itself writes full-width brackets (zh-CN / zh-TW / ja); every
// other language, Korean included, gets 「 (…)」. Punctuation only — the words
// are the existing `pairCandidatesFailed__*` leaves.

import 'package:flowmic/src/session/endpoint_candidates.dart'
    show CandidateFailure;
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flutter_test/flutter_test.dart';

const String _a = 'https://100.64.7.68:41879';
const String _b = 'http://192.168.1.20:41879';

const List<MapEntry<String, CandidateFailure>> _tried =
    <MapEntry<String, CandidateFailure>>[
  MapEntry<String, CandidateFailure>(_a, CandidateFailure.dialFailed),
  MapEntry<String, CandidateFailure>(_b, CandidateFailure.unreachable),
];

const Set<AppLocale> _fullWidth = <AppLocale>{
  AppLocale.zh,
  AppLocale.zhTw,
  AppLocale.ja,
};

void main() {
  test('every locale: the address lines use the brackets that language writes', () {
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      final List<String> lines = s
          .pairCandidatesFailed(_tried)
          .split('\n')
          .where((String l) => l.startsWith('· '))
          .toList();
      expect(lines, hasLength(2), reason: '$locale: one line per address');
      for (final String line in lines) {
        if (_fullWidth.contains(locale)) {
          expect(line, matches(RegExp(r'^· \S+（[^（）]+）$')), reason: '$locale: $line');
          expect(line, isNot(contains(' (')), reason: '$locale');
        } else {
          expect(line, matches(RegExp(r'^· \S+ \([^()]+\)$')), reason: '$locale: $line');
          expect(line, isNot(contains('（')), reason: '$locale');
          expect(line, isNot(contains('）')), reason: '$locale');
        }
      }
      // The words themselves are untouched: each reason is the catalogue leaf.
      expect(lines.first, contains(_a));
      expect(lines.last, contains(_b));
    }
  });

  test('the device screen, verbatim: English reads 「address (connection failed)」', () {
    final AppStrings en = AppStrings.of(AppLocale.en);
    final String shown = en.pairCandidatesFailed(
      const <MapEntry<String, CandidateFailure>>[
        MapEntry<String, CandidateFailure>(_a, CandidateFailure.dialFailed),
      ],
    );
    expect(shown, contains('· $_a ('));
    expect(shown, isNot(contains('$_a（')),
        reason: 'report.md A3: a full-width bracket glued to a Latin address');
  });
}
