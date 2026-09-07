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
  // 🔴 Card RC-1 (2026-09-06) retired `codeDroppedOldest` and its nine
  // sentences: its producer went away with owner ruling O-2 (card LS-3) and
  // the string left with it. Three codes now, not four.
  test('every retained-audio notice code has a distinct, non-empty sentence '
      'in all 9 locales', () {
    final List<String> codes = <String>[
      RetainedAudioNotice.codeCapReached,
      RetainedAudioNotice.codeExpired,
      // Card LS-2. Added here in the same change that added the code: this
      // list is the only thing that notices a code shipping without nine
      // sentences behind it, and 0.2.53 is what that costs on a screen.
      RetainedAudioNotice.codeWriteFailed,
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
          reason: '$locale: the codes name unrelated facts '
              '(cap-reached ≠ expired ≠ write-failed) and '
              'must not collapse onto the same sentence. write-failed is the '
              'one that is not about space at all — borrowing the cap '
              'sentence for it would send the user to free up storage for a '
              'problem storage did not cause.');
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
    expect(en.retainedAudioNoticeMessage(RetainedAudioNotice.codeCapReached),
        isNot(unknown));
  });
}
