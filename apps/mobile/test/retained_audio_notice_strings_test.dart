// F6 (2026-09-02 audit) — `RetainedAudioStore` announces eviction and TTL
// notices on `.notices` (and, since this card, on `.lastNotice`), but until
// now nothing translated `RetainedAudioNotice.code` into a sentence a user
// could read: the store's own header says "callers MUST surface these" and
// the only caller (`retained_audio_boot.dart`) wrote a diag line only. This
// pins the localised half of the fix — the selector every future UI binding
// needs, across all 9 locales this repo ships.

import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('every retained-audio notice code has a distinct, non-empty sentence '
      'in all 9 locales', () {
    final List<String> codes = <String>[
      RetainedAudioNotice.codeDroppedOldest,
      RetainedAudioNotice.codeCapReached,
      RetainedAudioNotice.codeExpired,
    ];
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      final Set<String> sentences = <String>{};
      for (final String code in codes) {
        final String msg = s.retainedAudioNoticeMessage(code);
        expect(msg, isNotEmpty, reason: '$locale/$code');
        sentences.add(msg);
      }
      expect(sentences, hasLength(codes.length),
          reason: '$locale: the three codes name opposite/unrelated facts '
              '(dropped-oldest ≠ cap-reached ≠ expired) and must not collapse '
              'onto the same sentence');
    }
  });

  test('the selector is keyed on the store\'s own named constants, not a '
      'guessed literal', () {
    final AppStrings en = AppStrings.of(AppLocale.en);
    // Reverse control for the wiring itself: an unrecognised code must not
    // silently borrow one of the three real sentences — that would be the
    // exact "confident sentence about something nobody verified" shape
    // `recordingAutoStoppedUnknown` was written to avoid.
    final String unknown = en.retainedAudioNoticeMessage('not-a-real-code');
    expect(unknown, 'not-a-real-code');
    expect(en.retainedAudioNoticeMessage(RetainedAudioNotice.codeDroppedOldest),
        isNot(unknown));
  });
}
