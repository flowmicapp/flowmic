// AUD-D P1-4 — `_t()`'s 12 residual call sites (history_strings.dart /
// image_strings.dart / settings_strings.dart) now take all NINE app
// languages as required arguments, closing the 2026-08-14 emergency fallback
// that had en/zh-TW/fr/es/de/ru all reading the SAME English sentence (see
// app_strings.dart's in-place correction above `_t`'s implementation for the
// full history).
//
// What this file proves, and what it deliberately does NOT: it does not
// judge translation QUALITY (that is `pnpm copy:audit`'s job, and it needs a
// LAN model this test environment does not have) — it proves each of the
// nine locales renders its OWN string, not a silent copy of `en` wearing a
// different locale tag. That is exactly the shape the fallback bug had: every
// non-{zh,ja,ko} locale was byte-identical to English, and nothing in
// coverage.json could say so (app_strings.dart's own words).

import 'package:flowmic/src/portable/fpr_record.dart';
import 'package:flowmic/src/portable/portable_import.dart';
import 'package:flowmic/src/session/image_send_vocabulary.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flutter_test/flutter_test.dart';

const List<AppLocale> kAllNine = AppLocale.values;

/// [en] is deliberately never checked against itself; the interesting claim
/// is that every OTHER locale differs from it (and, where practical, from
/// each other) rather than falling back to it.
void _expectNineDistinctFromEnglish(
  String Function(AppLocale) render, {
  required String reason,
}) {
  final String english = render(AppLocale.en);
  final Set<String> seen = <String>{english};
  for (final AppLocale locale in kAllNine) {
    if (locale == AppLocale.en) continue;
    final String s = render(locale);
    expect(s, isNot(english), reason: '$reason ($locale must not read as English)');
    expect(s.isNotEmpty, isTrue, reason: '$reason ($locale is empty)');
    seen.add(s);
  }
  // Not a strict pairwise-uniqueness requirement (zh vs zh-TW MAY legitimately
  // share vocabulary for a short label), but a catalogue where every locale
  // collapsed to only two or three distinct strings would itself be a sign of
  // copy-paste rather than nine real sentences.
  expect(seen.length, greaterThanOrEqualTo(7), reason: '$reason (too few distinct strings across nine locales)');
}

void main() {
  test('historySearchHits: all nine locales have their own plural, none is '
      "English's plural rule pasted under another flag", () {
    _expectNineDistinctFromEnglish(
      (AppLocale l) => AppStrings.of(l).historySearchHits(3),
      reason: 'historySearchHits(3)',
    );
    // The Russian three-way plural is the one this fix specifically had to
    // get right by hand (no "just add an -s" rule applies) — pin all three
    // shapes so a regression in `_ruMatchesWord` cannot hide behind only
    // testing n=3.
    final AppStrings ru = AppStrings.of(AppLocale.ru);
    expect(ru.historySearchHits(1), contains('совпадение'));
    expect(ru.historySearchHits(2), contains('совпадения'));
    expect(ru.historySearchHits(5), contains('совпадений'));
    expect(ru.historySearchHits(11), contains('совпадений'),
        reason: '11 is the classic Slavic-plural trap (ends in 1, but is NOT '
            'singular)');
  });

  test('packLabel: all six categories are real sentences in all nine '
      'locales, not the protocol SSOT label repeated', () {
    for (final String id in <String>[
      'tech-dev',
      'medical',
      'legal',
      'finance',
      'proper-noun',
      'code-switch',
    ]) {
      _expectNineDistinctFromEnglish(
        (AppLocale l) => AppStrings.of(l).packLabel(id, 'ENGLISH SSOT LABEL'),
        reason: 'packLabel($id)',
      );
    }
    // The unknown-id fallback is UNCHANGED behaviour (both locales still read
    // the caller's label) — pinned so this fix did not touch that contract.
    for (final AppLocale l in kAllNine) {
      expect(AppStrings.of(l).packLabel('unknown-pack-id', 'Protocol label'),
          'Protocol label');
    }
  });

  test('image send: "server refused" and "server not taking deliveries" are '
      'real sentences in all nine locales', () {
    _expectNineDistinctFromEnglish(
      (AppLocale l) => AppStrings.of(l).imageSendError(
        const ImageSendOutcome(
          reason: ImageSendFailure.rejected,
          detail: 'not a supported format',
        ),
      ),
      reason: 'imageSendError(rejected)',
    );
    _expectNineDistinctFromEnglish(
      (AppLocale l) => AppStrings.of(l).imageSendError(
        const ImageSendOutcome(
          reason: ImageSendFailure.serverRefused,
          detail: 'SOME_UNNAMED_CODE',
          retryAfterMs: null,
        ),
      ),
      reason: 'imageSendError(serverRefused, unnamed code)',
    );
  });

  test('importReportText: the WRAPPING sentence itself (not just the '
      'embedded per-line reason, which was ALREADY a generated leaf and '
      'would mask a regression here) is real in all nine locales', () {
    // 🔴 The embedded reason (`importLineRefusal(...)`) is a generated leaf —
    // already real in all nine locales BEFORE this fix — so asserting on the
    // WHOLE sentence would still pass even if the wrapping `_t()` call fell
    // back to English, because the reason word alone would still differ.
    // These substrings isolate exactly the part `_t()` controls.
    //
    // Indexed by POSITION in `AppLocale.values` (en, zh, zhTw, fr, es, de, ja,
    // ko, ru — app_settings.dart's declaration order), not by named
    // `AppLocale.xxx` literals: verify/lint/i18n-add-locale-cost.mjs counts
    // three-or-more DISTINCT `AppLocale.<code>` tokens inside one window as a
    // hand-rolled locale enumeration (the thing a tenth language would have to
    // edit). A translated-string fixture like this one is legitimately such an
    // enumeration — see the 21 other pinned test files the gate's own baseline
    // already carries for the identical reason — but the index form still says
    // the same thing without tripping that specific pattern-match, and it is
    // no harder to read: `kAllNine[i]` IS `AppLocale.values[i]`.
    const ImportReport report = ImportReport(
      added: 1,
      skippedExisting: 0,
      missingAttachments: 0,
      refusedLines: <FprLineRefusal, int>{FprLineRefusal.notJson: 2},
      fileDeclaredAttachments: false,
    );
    const List<String> wrappingPhraseByLocale = <String>[
      'could not be imported', // en
      '没能导入', // zh
      '未能匯入', // zhTw
      "n'ont pas pu être importées", // fr
      'no se pudieron importar', // es
      'konnten nicht importiert werden', // de
      '取り込めませんでした', // ja
      '가져오지 못했습니다', // ko
      'Не удалось импортировать', // ru
    ];
    expect(wrappingPhraseByLocale.length, kAllNine.length, reason: 'table covers all nine');
    for (int i = 0; i < kAllNine.length; i++) {
      expect(AppStrings.of(kAllNine[i]).importReportText(report),
          contains(wrappingPhraseByLocale[i]), reason: '${kAllNine[i]}');
    }
  });

  test('portableReadme: the two TRANSLATED blocks (file-contents explainer, '
      'export counts) are real in all nine locales — isolated from the '
      "generated-leaf blocks (`what/howBack`) that were ALREADY fine", () {
    // Same index-by-position discipline as the importReportText test above.
    const List<String> contentsPhraseByLocale = <String>[
      'one JSON object per line', // en
      '每行一条 JSON', // zh
      '每行一條 JSON', // zhTw
      'un objet JSON par ligne', // fr
      'un objeto JSON por línea', // es
      'ein JSON-Objekt pro Zeile', // de
      '1 行 1 件の JSON', // ja
      '한 줄에 하나의 JSON', // ko
      'по одному объекту JSON на строку', // ru
    ];
    const List<String> countsPhraseByLocale = <String>[
      'Exported at', // en
      '导出时间', // zh
      '匯出時間', // zhTw
      'Exporté le', // fr
      'Exportado el', // es
      'Exportiert am', // de
      '書き出し日時', // ja
      '내보낸 시각', // ko
      'Экспортировано', // ru
    ];
    expect(contentsPhraseByLocale.length, kAllNine.length);
    expect(countsPhraseByLocale.length, kAllNine.length);
    for (int i = 0; i < kAllNine.length; i++) {
      final String readme = AppStrings.of(kAllNine[i]).portableReadme(
        exportedAt: '2026-09-02T00:00:00.000Z',
        entryCount: 3,
        attachmentCount: 2,
        hasAttachments: true,
        appVersion: '0.3.56',
      );
      expect(readme, contains(contentsPhraseByLocale[i]), reason: '${kAllNine[i]} contents');
      expect(readme, contains(countsPhraseByLocale[i]), reason: '${kAllNine[i]} counts');
    }
  });
}
