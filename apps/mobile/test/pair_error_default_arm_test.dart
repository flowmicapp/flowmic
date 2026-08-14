// 🔴 Card U5 remainder — the tension between 「the default: arm must not print a
// bare identifier」 and the 0.2.53 precedent 「an unrecognized code is unchanged
// in behaviour, still prints the bare identifier, do not invent a sentence for
// it」. What is tested is the point where BOTH hold:
//
//   ① An unrecognized code is no longer the entire sentence on screen (it used
//      to be 「配对失败：$code」, the whole readable text being a protocol-internal
//      codename) — the default arm's return now has a meaning independent of
//      repeating `pairError.dart`'s reasoning comment.
//   ② The original code itself **was not deleted and was not rewritten into an
//      invented concrete cause** — it still appears in the sentence
//      character-for-character, only demoted from 「the only content」 to
//      「secondary diagnostic detail」.
//
// Both are tested together; either one alone would miss the other half of the
// regression: testing only ① is easy to cheat with 「delete the code, swap in a
// purely generic sentence」 (the other façade 0.2.53 forbids — swallowing the
// diagnostic too); testing only ② (already covered by the reverse control in
// `pair_mobiles_limit_test.dart`) cannot catch 「the whole sentence is still a
// bare code」, which is U5's own problem.

import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('U5 remainder · pairError\'s default arm', () {
    // Deliberately a code that does not exist in the protocol right now and
    // may be added later — this layer genuinely does not know it at this
    // moment, so the assertion cannot cheat on "what this specific case
    // happens to say".
    const String unknown = 'SOME_FUTURE_CODE_NOT_YET_NAMED';

    for (final AppLocale locale in AppLocale.values) {
      test('$locale: unrecognized code — a human sentence wrapping the codename, the codename kept verbatim', () {
        final AppStrings s = AppStrings(locale);
        final String shown = s.pairError(unknown);

        // ① No longer 「the entire sentence == the bare identifier」.
        expect(shown, isNot(equals(unknown)), reason: '$locale the entire sentence is the bare identifier');
        expect(
          shown.length,
          greaterThan(unknown.length + 8),
          reason: '$locale has no real human words around the codename, just a few punctuation marks',
        );

        // ② 0.2.53 precedent: unrecognized code — do not delete, do not rewrite,
        //    do not invent a concrete cause; leave the trace verbatim.
        expect(shown, contains(unknown), reason: '$locale swallowed the unrecognized code entirely');

        // ③ The default's human words must stand as their own sentence, not a
        //    casual borrow from some already-named arm.
        expect(shown, isNot(equals(s.pairError('PC_BUSY'))), reason: '$locale');
        expect(shown, isNot(equals(s.pairError('AUTH_TOKEN_INVALID'))), reason: '$locale');
        expect(shown, isNot(equals(s.pairError('MOBILES_LIMIT_EXCEEDED'))), reason: '$locale');
      });

      test('$locale: code is null (not even an ack) is also a human sentence, never the literal "null"', () {
        final AppStrings s = AppStrings(locale);
        final String shown = s.pairError(null);
        expect(shown, isNot(contains('null')), reason: '$locale printed Dart\'s null onto the screen');
        expect(shown.length, greaterThan(6), reason: '$locale is too short to say what happened');
      });
    }

    test(
      'four-language reverse control: PCS_LIMIT_EXCEEDED (desktop-only code, unreachable on the phone) —'
      'this default arm still does not invent a concrete cause for it, it just no longer lets it run bare',
      () {
        for (final AppLocale locale in AppLocale.values) {
          final AppStrings s = AppStrings(locale);
          final String shown = s.pairError('PCS_LIMIT_EXCEEDED');
          expect(shown, contains('PCS_LIMIT_EXCEEDED'), reason: '$locale: the diagnostic code must not be swallowed');
          expect(
            shown,
            isNot(equals('PCS_LIMIT_EXCEEDED')),
            reason: '$locale: the entire sentence must not still be the bare identifier',
          );
        }
      },
    );
  });
}
