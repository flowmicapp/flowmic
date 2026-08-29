// SEG-2 — the banned-word guard on the link-loss copy.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-b
//     (constraint 3: 「待转录」 may not ship until a re-transcription mechanism
//      exists — and it does not, design §6; constraints 1–2: the ⊖ segment may
//      not borrow ①②'s delivery words nor 「识别中」/「处理中」)
//   docs/strategy/2026-08-11-unified-transcription-session-design.md §2-R4
//     (the copy states the two provable facts and NOTHING about transcription)
//
// ── WHY A GUARD TEST AND NOT A COMMENT ───────────────────────────────────────
// The ban's natural failure mode is a later, well-meaning copy edit (「上线后
// 会自动转录」 reads like an improvement). A comment on the string cannot go
// red; this file can. REVERSE CONTROL (recorded in the SEG-2 delivery report):
// appending "It will be transcribed later." to the en kept-variant turns the
// en/transcri assertion red verbatim; reverted after recording.

import 'package:flowmic/src/audio/local_stop_reasons.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flutter_test/flutter_test.dart';

/// Per-language banned lexemes for the ⊖-segment link-loss copy. Substring
/// matches, deliberately broad (e.g. 'transcri' catches transcribe /
/// transcribed / transcription): a promise fragment is as banned as the word.
const Map<String, List<String>> _banned = <String, List<String>>{
  // 15 册 §2.0-b: no transcription promise (constraint 3), no borrowed
  // delivery words (constraint 1), no 「识别中」/「处理中」 (constraint 2).
  'zh': <String>['待转录', '转录', '转写', '稍后', '投递', '识别中', '处理中'],
  'en': <String>['transcri', 'later', 'deliver', 'pending'],
  'ja': <String>['文字起こし', '転写', '後で', 'あとで'],
  'ko': <String>['전사', '나중에'],
};

void main() {
  final Map<AppLocale, String> localeKey = <AppLocale, String>{
    for (final AppLocale l in AppLocale.values) l: l.name,
  };

  for (final AppLocale locale in AppLocale.values) {
    final AppStrings s = AppStrings(locale);
    final List<String> words = <String>[
      for (final List<String> l in _banned.values) ...l,
    ];
    // The whole table applies to every language: the scripts are disjoint, so
    // cross-language checks cost nothing and catch a pasted-in wrong-language
    // fragment too. en matched case-insensitively.
    for (final MapEntry<String, String> entry in <String, String>{
      'kept': s.recordingStoppedLinkLossKept,
      'plain': s.recordingStoppedLinkLoss,
      // Card CR-3 (2026-08-29) — the OFFLINE-RECORDING banner joins this table
      // rather than getting a guard file of its own. It is the same ban, on the
      // same grounds, over the same three constraints; a second table would be
      // a second answer to 「which words are unbacked here?」 and the two would
      // drift the first time one of them was updated.
      //
      // 🔴 And it is the string this ban is now MOST likely to be broken on:
      // this one is shown while the recording is still going, which is exactly
      // the moment a well-meaning edit wants to reassure the user that the
      // audio will be caught up. It will be — after card CR-5. Not today.
      'continuousOffline': s.bannerContinuousOffline,
    }.entries.toList()) {
      test(
          '${localeKey[locale]}/${entry.key}: no transcription promise, no '
          'borrowed segment words', () {
        final String copy = entry.value.toLowerCase();
        for (final String banned in words) {
          expect(copy.contains(banned.toLowerCase()), isFalse,
              reason: 'banned lexeme 「$banned」 found in ${localeKey[locale]} '
                  '${entry.key} copy: 「${entry.value}」 — the upload/'
                  're-transcription mechanism does not exist (design §6), so '
                  'any wait or promise named here is unbacked');
        }
      });
    }
  }

  test('the selector maps both LOCAL reasons to their own sentences, in every '
      'language — never to the unknown branch, never to each other', () {
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings(locale);
      expect(s.recordingAutoStoppedMessage(kLocalStopReasonLinkLossKept),
          s.recordingStoppedLinkLossKept);
      expect(s.recordingAutoStoppedMessage(kLocalStopReasonLinkLoss),
          s.recordingStoppedLinkLoss);
      expect(s.recordingStoppedLinkLossKept,
          isNot(s.recordingStoppedLinkLoss),
          reason: 'the retention claim is the whole difference; collapsing '
              'them would show it unbacked or hide it when true');
    }
  });

  test('🔴 card CR-6: the per-session ceiling has its OWN sentence, and it is '
      'not the monthly quota one', () {
    // The W8-4 account, in a new dimension. The ceiling means 「press it again
    // and keep going」 — it resets with the next session. Quota exhaustion means
    // 「this month is gone」 and pressing again achieves nothing. Showing one
    // sentence for both is the more expensive direction in exactly one way: a
    // user told to wait for next month, when they could simply press again,
    // loses the recording they were about to make.
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings(locale);
      expect(s.recordingAutoStoppedMessage(kLocalStopReasonContinuousCap),
          s.recordingStoppedContinuousCap,
          reason: 'it must not fall through to the unknown branch');
      expect(s.recordingStoppedContinuousCap,
          isNot(s.recordingAutoStoppedQuota),
          reason: 'quota exhaustion and a per-session ceiling lead the user '
              'somewhere opposite');
      expect(s.recordingStoppedContinuousCap, isNot(s.recordingAutoStopped),
          reason: "and it is not the server's hard_limit sentence either");
    }
  });

  test('🔴 card CR-6: the ceiling sentence carries no digits in any language',
      () {
    // The minutes live in billing/plans.ts and differ per tier. Nine
    // translations quoting 「30 分钟」 become nine lies the day a tier is re-cut,
    // and free would have been wrong on the day it shipped. Same rule
    // recordingAutoStoppedQuota already carries, asserted rather than trusted.
    for (final AppLocale locale in AppLocale.values) {
      final String copy = AppStrings(locale).recordingStoppedContinuousCap;
      expect(RegExp(r'[0-9]').hasMatch(copy), isFalse,
          reason: 'digit found in ${locale.name}: 「$copy」 — the number '
              'belongs on the start button, read from the value that '
              'enforced the stop');
    }
  });

  test('the local reasons keep their collision guard (the `local:` prefix — '
      'wire reasons are bare snake_case and can never alias them)', () {
    expect(kLocalStopReasonLinkLossKept, startsWith('local:'));
    expect(kLocalStopReasonLinkLoss, startsWith('local:'));
    expect(kLocalStopReasonLinkLossKept,
        isNot(kLocalStopReasonLinkLoss));
  });
}
