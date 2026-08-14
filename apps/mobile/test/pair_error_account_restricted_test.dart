// F1 (2026-08-12) — `pairError('ACCOUNT_RESTRICTED')` must be a sentence, and
// the sentence must not tell the user to do something that cannot work.
//
// WHY THIS CODE REACHES THE PHONE AT ALL, AS OF THIS ROUND: the socket admission
// gates (`mobile:pair` in all three shapes, and `mobile:reconnect`) now refuse a
// restricted account by name. Before this round the phone could never receive
// the code, so no copy existed for it.
//
// WHAT THE DEFAULT ARM WOULD HAVE SHOWN — measured, not imagined:
//
//     配对失败，请检查网络后重试 · 诊断码 ACCOUNT_RESTRICTED
//
// That is a worse failure than the bare identifier card U5 fixed, because it is
// a bare identifier PLUS a false instruction. Checking the network is not the
// remedy for a moderation decision and neither is retrying, so the one actionable
// sentence on the screen sends the user somewhere that cannot possibly help.
//
// WHY THERE IS NO IMPERATIVE IN THE REPLACEMENT: owner ruled 「不提供申诉通道」 —
// there is no appeal channel. The two things a restricted user MAY still do
// (export their data, close their account) live in the web console and have no
// entry point in this app, so naming them here would be a promise this screen
// cannot keep. That is the `INJECT_PC_MISMATCH` precedent: a refusal with no
// available action says so plainly rather than inventing one.
//
// SCOPE OF THIS TEST: it pins the code→sentence MAPPING. It deliberately does not
// assert readability-after-layout — that class of assertion must be made against
// the rendered box (0.2.53), and this string has no dedicated widget of its own;
// it flows into the same toast and sheet surfaces every other `pairError` string
// already uses.

import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('F1 · pairError(ACCOUNT_RESTRICTED) says a true thing', () {
    for (final AppLocale locale in AppLocale.values) {
      test(locale.name, () {
        final AppStrings s = AppStrings(locale);
        final String shown = s.pairError('ACCOUNT_RESTRICTED');

        // (1) It must not fall through to the identifier-carrying default arm.
        expect(
          shown,
          isNot(contains('ACCOUNT_RESTRICTED')),
          reason: '$locale handed the protocol identifier to the user',
        );

        // (2) It must not repeat the default arm's false instruction. Those are
        //     the exact tokens that arm uses to tell the user to check the
        //     network and try again.
        for (final String falseRemedy in <String>[
          '检查网络',
          'check the network',
          'ネットワークを確認',
          '네트워크를 확인',
        ]) {
          expect(
            shown,
            isNot(contains(falseRemedy)),
            reason: '$locale told a restricted user to check their network',
          );
        }

        // (3) No appeal channel, and no contact affordance standing in for one.
        for (final String appeal in <String>[
          '申诉',
          '联系',
          'appeal',
          'contact',
          'support',
          '@',
          'http',
          '異議',
          '問い合わせ',
          '이의',
          '문의',
        ]) {
          expect(
            shown.toLowerCase(),
            isNot(contains(appeal.toLowerCase())),
            reason: '$locale offered a channel owner ruled does not exist',
          );
        }

        // (4) It is a real sentence, not a stub.
        expect(shown.trim().length, greaterThanOrEqualTo(12),
            reason: '$locale is too short to have said anything');
      });
    }

    // POSITIVE CONTROL. Without this, every assertion above would still pass if
    // `pairError` had been broken into returning a constant for everything — the
    // suite would be measuring nothing. An unknown code must STILL reach the
    // default arm and still carry its diagnostic tail, because this round did not
    // change that behaviour and 0.2.53 ruled it correct: we do not invent a
    // specific reason for a code we do not recognise.
    test('positive control — an unknown code still falls to the default arm', () {
      const AppStrings s = AppStringsZh();
      final String unknown = s.pairError('SOME_CODE_WE_DO_NOT_KNOW');
      expect(unknown, contains('SOME_CODE_WE_DO_NOT_KNOW'));
      expect(unknown, contains('检查网络'));
      // And the two answers must genuinely differ, which is the whole point.
      expect(s.pairError('ACCOUNT_RESTRICTED'), isNot(equals(unknown)));
    });
  });
}
