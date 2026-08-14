// 🔴 Card U5 [measured] — MOBILES_LIMIT_EXCEEDED falling into pairError's
// bare-identifier fallback sentence.
//
// 0.2.53 was patched precisely because a code like this hit the screen
// (the real-device photo cited in `inject_verdict_note_test.dart`'s header).
// This is another member of the same accident class, and measured it looks
// even worse: `pairError` today, in the `default:` arm, has only this answer
// for MOBILES_LIMIT_EXCEEDED:
//
//     配对失败：MOBILES_LIMIT_EXCEEDED
//
// — a **paid, subscribed** user pairing the N+1st phone reads exactly that line.
//
// Source (SSOT): packages/protocol/src/error-codes.ts
//   MOBILES_LIMIT_EXCEEDED: { zh_CN: '已达套餐手机数量上限。', en: 'Plan mobile
//   limit reached.' }
// The comment right after that code (F-2325 / SB-1): plan changes can only be
// made by an **account admin** on the **web console** (in-app payment is locked
// by restraint-#4); the phone has no, and must not pretend to have, an
// 「upgrade」 button or a 「device management」 page — `apps/mobile/lib` has no
// such surface (grepped 套餐/billing/upgrade/设备管理, all unrelated hits).
// So the four sentences below state only two true things: the quota is full,
// and an account admin has to handle it; they invent no entry this App does
// not have.
//
// Style mirrors `pairing_revoked_message_test.dart` (same owner, same-day
// ruling): not the generic fallback, no bare code, long enough, distinct from
// neighbouring arms, and does not fall into the wrong vocabulary register.

import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('U5 · pairError(MOBILES_LIMIT_EXCEEDED) must speak in human words', () {
    for (final AppLocale locale in AppLocale.values) {
      test(locale.name, () {
        final AppStrings s = AppStrings(locale);
        final String shown = s.pairError('MOBILES_LIMIT_EXCEEDED');

        // ① Must not fall back to the bare-identifier sentence.
        expect(
          shown,
          isNot(contains('MOBILES_LIMIT_EXCEEDED')),
          reason: '$locale dumped the on-wire identifier onto a paying user',
        );
        expect(
          shown,
          isNot(equals(s.pairError(null))),
          reason: '$locale is still the 「配对失败：未知错误」 sentence',
        );

        // ② Distinct from neighbouring arms — not a casual copy of some existing arm.
        expect(shown, isNot(equals(s.pairError('PC_BUSY'))), reason: '$locale');
        expect(shown, isNot(equals(s.pairError('PAIR_RELEASED'))), reason: '$locale');
        expect(shown, isNot(equals(s.pairError('AUTH_TOKEN_INVALID'))), reason: '$locale');
        expect(shown.length, greaterThan(12), reason: '$locale is too short to explain why');

        // ③ 🔴 Honesty boundary: must not invent an 「upgrade」/「device management」
        //    button or page the phone does not have
        //    (F-2325/SB-1: only an account admin can change the plan on the web console).
        for (final String wrongUi in <String>[
          '设置里',
          'in Settings',
          '設定内',
          '설정에서',
        ]) {
          expect(shown, isNot(contains(wrongUi)), reason: '$locale invented an entry the phone does not have');
        }
      });
    }

    test('each of the four languages is its own sentence, not the same sentence copied four times', () {
      final Set<String> seen = <String>{};
      for (final AppLocale locale in AppLocale.values) {
        final String shown = AppStrings(locale).pairError('MOBILES_LIMIT_EXCEEDED');
        expect(seen.add(shown), isTrue, reason: '$locale used the same sentence as a previous language');
      }
    });
  });

  test('🔴 reverse control: PCS_LIMIT_EXCEEDED (desktop-only, unreachable on the phone) stays unchanged —'
      'this card did not open the whole limit table in one go', () {
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings(locale);
      expect(
        s.pairError('PCS_LIMIT_EXCEEDED'),
        contains('PCS_LIMIT_EXCEEDED'),
        reason: '$locale: this code never arrives on the phone, so it must not grow its own human sentence',
      );
    }
  });
}
