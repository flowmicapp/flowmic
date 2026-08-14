// 🔴 Card L7 — machine guard, on the phone side, for the two-leg
// delivery / injection terminology.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0 (two-leg
//     terminology table + three laws), §2.0.1 (phone triad ↔ queue/receipt
//     mapping), §2.5 (per-face word table)
//   docs/decisions/2026-08-02-delivery-vs-injection-terminology-contract.md
//
// owner 2026-08-02, two quotes verbatim:
//   ①「要明确手机->PC，叫**投递**（投递成功/未投递），PC->焦点窗口叫**注入**
//      （注入成功/未注入，已缓存），这个状态必须要明确而且清晰」
//   ②「手机端的历史记录显示：已投递/待投递/未投递，**不要显示已注入了**，因为这个
//      状态本来就是开放式的，PC 名称要显示」
//
// ⚠️ Why the assertion is 「which family of words appears on which face」 and
// not a byte-for-byte compare: a byte-for-byte compare is only useful on the
// day the words change; the next day someone adds another face and it is still
// green. **This asserts classification** — the first word of every face must
// be one of the triad, and a face that 「will retry」 must never carry a
// terminal word.
//
// ⚠️ This file has one REVERSE CONTROL (see the end). It really went red
// against a deliberately broken implementation; the raw output is in the
// delivery report. A negative assertion that has never been seen red is not
// evidence.

import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/status_badge.dart';
import 'package:flutter_test/flutter_test.dart';

const List<AppLocale> _locales = <AppLocale>[
  AppLocale.zh,
  AppLocale.en,
  AppLocale.ja,
  AppLocale.ko,
];

/// First word of the triad in the four locales. ja 「投递」＝送信、ko＝전송, matching
/// the existing word table.
const Map<AppLocale, ({String delivered, String pending, String notDelivered})>
_triad = <AppLocale, ({String delivered, String pending, String notDelivered})>{
  AppLocale.zh: (delivered: '已投递', pending: '待投递', notDelivered: '未投递'),
  AppLocale.en: (
    delivered: 'Delivered',
    pending: 'Pending',
    notDelivered: 'Not delivered',
  ),
  AppLocale.ja: (delivered: '送信済み', pending: '送信待ち', notDelivered: '未送信'),
  AppLocale.ko: (delivered: '전송됨', pending: '전송 대기', notDelivered: '미전송'),
};

String _label(DeliveryFace face, AppLocale loc) =>
    deliveryFaceMeta(face, AppStrings(loc)).label;

void main() {
  // ── ① owner quote ②: 「不要显示已注入了」 ─────────────────────────────────────
  group('card L7 ① the phone row no longer claims 「注入」', () {
    test('the injected face says 「已投递」; none of the four locales contains an injection word', () {
      for (final AppLocale loc in _locales) {
        final String w = _label(DeliveryFace.injected, loc);
        expect(
          w,
          startsWith(_triad[loc]!.delivered),
          reason: '$loc: the injected face must start with the triad\'s 「已投递」, got 「$w」',
        );
        for (final String ban in <String>['已注入', 'Injected', '注入済み', '주입됨']) {
          expect(
            w.contains(ban),
            isFalse,
            reason: '$loc: 「$w」 must not still say 「$ban」(owner 2026-08-02)',
          );
        }
      }
    });

    // 🔴 The one face still allowed to carry the word 「注入」, and its first
    // word is still 「已投递」 — because INJECT_NO_TEXT_TARGET is **the PC's own
    // answer**, and the answer itself proves the frame reached the PC.
    // owner 2026-08-01's verbatim 「无焦点未注入」 is kept as-is in the second half.
    // 🔴 Card L7 × card L8 — for 「the PC deliberately did not inject」, the
    // delivery-leg answer is **已投递**. The queue side (L8) has already
    // settled it as the terminal `delivered`; if the row face still said
    // 「待投递」, that would be the CLAUDE.md red line verbatim (promising a
    // wait that no mechanism honours).
    test('the deferredNotInjected face also starts with 「已投递」, and contains no terminal/waiting word', () {
      for (final AppLocale loc in _locales) {
        final String w = _label(DeliveryFace.deferredNotInjected, loc);
        expect(w, startsWith(_triad[loc]!.delivered), reason: '$loc: got 「$w」');
        expect(w.contains(_triad[loc]!.pending), isFalse, reason: '$loc: nobody will deliver it again');
        expect(w.contains(_triad[loc]!.notDelivered), isFalse, reason: '$loc: it was delivered');
      }
      // It and noFocus must be two different faces, two different words: the
      // user actions are opposite (tap into the input box and resend vs. tap
      // 「重新注入」 on the PC side).
      expect(
        _label(DeliveryFace.deferredNotInjected, AppLocale.zh),
        isNot(_label(DeliveryFace.noFocus, AppLocale.zh)),
      );
      // The copy must not call itself a failure / not-arrived (delivery succeeded).
      for (final AppLocale loc in _locales) {
        final String w = _label(DeliveryFace.deferredNotInjected, loc);
        for (final String ban in <String>['失败', '失敗', '실패', 'failed', 'Failed']) {
          expect(w.contains(ban), isFalse, reason: '$loc: 「$w」 must not contain 「$ban」');
        }
      }
    });

    test('noFocus face ＝ 「已投递 · 无焦点未注入」: first half is the triad, second half is the owner\'s verbatim words', () {
      final String zh = _label(DeliveryFace.noFocus, AppLocale.zh);
      expect(zh, startsWith('已投递'));
      expect(zh, contains('无焦点未注入')); // owner 2026-08-01, verbatim
      for (final AppLocale loc in _locales) {
        expect(_label(DeliveryFace.noFocus, loc), startsWith(_triad[loc]!.delivered));
      }
    });
  });

  // ── ② §2.0.1 triad mapping: 「still in the queue」 and 「gave up」 must stay apart ──
  group('card L7 ② 待投递 (will retry) vs 未投递 (terminal)', () {
    // The queue still owes these three faces: queued / delivering / undelivered.
    const List<DeliveryFace> retryable = <DeliveryFace>[
      DeliveryFace.queued,
      DeliveryFace.delivering,
      DeliveryFace.undelivered,
    ];
    // The two that will not move again: refused (terminal code) / failed.
    const List<DeliveryFace> settled = <DeliveryFace>[
      DeliveryFace.refused,
      DeliveryFace.failed,
    ];

    test('🔴 faces the queue will still retry start with 「待投递」 in every locale', () {
      for (final AppLocale loc in _locales) {
        for (final DeliveryFace f in retryable) {
          final String w = _label(f, loc);
          expect(
            w,
            startsWith(_triad[loc]!.pending),
            reason: '$loc/$f: 「$w」 must start with 「${_triad[loc]!.pending}」',
          );
        }
      }
    });

    // 🔴 THE ONE THAT OWNER HIT. The user action for 「未投递」 is 「resend /
    // check the network」; the user action for 「待投递」 is 「wait」. When
    // another phone holds the PC (PC_BUSY / INJECT_NOT_IN_ROOM, neither a
    // terminal code) the queue keeps retrying, but the UI said 「未投递」.
    test('🔴 a face that will retry must never carry the terminal word 「未投递」', () {
      for (final AppLocale loc in _locales) {
        for (final DeliveryFace f in retryable) {
          final String w = _label(f, loc);
          expect(
            w.contains(_triad[loc]!.notDelivered),
            isFalse,
            reason:
                '$loc/$f: 「$w」 contains the terminal word 「${_triad[loc]!.notDelivered}」 — '
                'this family of the queue still owes it; calling it 「未投递」 turns 「wait」 into 「go resend」',
          );
        }
      }
    });

    test('the two terminal faces start with 「未投递」 in every locale', () {
      for (final AppLocale loc in _locales) {
        for (final DeliveryFace f in settled) {
          final String w = _label(f, loc);
          expect(
            w,
            startsWith(_triad[loc]!.notDelivered),
            reason: '$loc/$f: 「$w」 must start with 「${_triad[loc]!.notDelivered}」',
          );
        }
      }
    });

    // RV-67's red line is harder under the new word table, not merged away:
    // a benign retry says 「待投递」, a red-line refusal says 「未投递」 — the
    // two families already differ in the first word. The old second-half
    // distinctions are all still there.
    test('RV-67 / window B3-2b old distinctions are all kept in the second half', () {
      const AppStrings zh = AppStringsZh();
      expect(deliveryFaceMeta(DeliveryFace.queued, zh).label, contains('排队中'));
      expect(deliveryFaceMeta(DeliveryFace.delivering, zh).label, contains('投递中'));
      expect(deliveryFaceMeta(DeliveryFace.refused, zh).label, contains('投递被拒'));
      expect(deliveryFaceMeta(DeliveryFace.failed, zh).label, contains('未成功'));
      // …and the eight faces are pairwise distinct (merging any two would go
      // red here).
      final Set<String> all = <String>{
        for (final DeliveryFace f in DeliveryFace.values)
          deliveryFaceMeta(f, zh).label,
      };
      expect(all.length, DeliveryFace.values.length);
    });
  });

  // ── ③ Queue banner: change the word only, do not touch the count (§2.0.1's real ledger) ──
  group('card L7 ③ 「还有 N 条待投递」', () {
    test('the banner says 「待投递」; none of the four locales contains the terminal word', () {
      for (final AppLocale loc in _locales) {
        // Sentence-level compare is case-insensitive (the badge is a word;
        // this is a sentence, and in en it appears mid-sentence).
        final String s = AppStrings(loc).outboxPendingNotice(3).toLowerCase();
        expect(s, contains(_triad[loc]!.pending.toLowerCase()));
        expect(
          s.contains(_triad[loc]!.notDelivered.toLowerCase()),
          isFalse,
          reason:
              '$loc: 「$s」 — `pendingCountFor` counts queued+inflight (still in the queue), '
              'not the ones the queue gave up on; what was wrong was always this word, not the count',
        );
      }
    });
  });

  // ── ④ noted is not a delivery state ──────────────────────────────────────
  test('🔴 noted (record-only) must not wear any of the triad\'s clothes', () {
    // R9: 「仅记录」 unconditionally does not deliver to the PC ⇒ it is not on
    // the delivery leg at all. Calling it 「未投递」 makes the user think
    // something failed to go out (they chose not to send it); calling it
    // 「待投递」 is worse.
    for (final AppLocale loc in _locales) {
      final String w = _label(DeliveryFace.noted, loc);
      final ({String delivered, String pending, String notDelivered}) t =
          _triad[loc]!;
      for (final String word in <String>[t.delivered, t.pending, t.notDelivered]) {
        expect(w.contains(word), isFalse, reason: '$loc: noted face 「$w」 must not contain 「$word」');
      }
    }
  });
}
