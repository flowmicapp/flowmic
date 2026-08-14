// Q2 (2026-08-12) — **cross-language mirror guard**: every enumerated
// restriction reason the protocol defines must have a phone sentence, in all
// four languages.
//
// 🔴 WHY A MACHINE HAS TO HOLD THIS. Dart cannot see a TypeScript symbol, so
// "both ends read the same list" is a wish until something checks it. The wire carries the
// KEY and never the sentence (`restriction-reasons.ts`: the server would have to
// choose the reader's language to send a sentence, and 「UI 不跟随 OS locale」 puts
// that choice on the client) — which means the phone renders from a table it
// mirrors BY HAND. CLAUDE.md records that exact gap as 「仍然开着的根因」 for error
// codes: 「没有任何机制把协议注册表与手机那张表绑在一起」. This file is that
// mechanism for this one table.
//
// WHAT IT COSTS WHEN IT IS MISSING, measured on the real path: an unmirrored key
// reaches a RESTRICTED user — somebody who has already been told they cannot use
// the product — as a bare `automated_or_bulk_use` under a sentence promising to
// tell them why. The Terms make that promise; this table is what keeps it.
//
// The technique is not new here: `inject_verdict_authorship_mirror_test.dart`
// reads `inject-verdict-authorship.ts` the same way, and the desktop's
// `error_codes.rs` reads `error-codes.ts` from Rust. Same handle, third table.
//
// SPEC-REF:
//   packages/protocol/src/restriction-reasons.ts (the single source)
//   apps/server-core/src/auth/account-restriction.ts (restrictionRefusalBody)
//   docs/decisions/2026-08-12-owner-needle-closure-and-default-authority.md §Q2

import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

/// `flutter test` runs with this package's root as its working directory.
final File _ssot = File('../../packages/protocol/src/restriction-reasons.ts');

/// Only matches a real table entry — `  key_name: {` at the top level of
/// `RESTRICTION_REASONS`. A key named inside a doc comment does not match (those
/// lines start with `*` or `//`), and neither does `export const … = {`.
final RegExp _entry = RegExp(r'^  ([a-z][a-z0-9_]*):\s*\{\s*$', multiLine: true);

Set<String> _keysFromSsot() {
  // A guard that passes when it cannot find its source is not a guard.
  expect(
    _ssot.existsSync(),
    isTrue,
    reason: 'protocol source not found at ${_ssot.path} '
        '(working directory should be apps/mobile)',
  );
  return _entry
      .allMatches(_ssot.readAsStringSync())
      .map((RegExpMatch m) => m.group(1)!)
      .toSet();
}

void main() {
  group('restriction reasons — phone copy mirrors the protocol table', () {
    test('the parser is not blind (positive control)', () {
      // 🔴 THIS RUNS FIRST ON PURPOSE. Every assertion below is of the form
      // 「for each key in the SSOT …」, and a regex that matched nothing would
      // make all of them vacuously green. Two independent checks: a plausible
      // count, and one key named literally.
      final Set<String> keys = _keysFromSsot();
      expect(keys.length, greaterThanOrEqualTo(5),
          reason: 'parsed ${keys.length} keys — the regex has probably drifted');
      expect(keys, contains('terms_violation'));
      expect(keys, contains('other'));
      // And it must NOT have swallowed the surrounding syntax as a key.
      expect(keys, isNot(contains('export')));
    });

    test('🔴 every protocol reason has phone copy, in all four languages', () {
      // The one assertion this file exists for. A new reason added on the server
      // fails here BEFORE it can reach a restricted user as a bare identifier.
      final Set<String> keys = _keysFromSsot();
      for (final String key in keys) {
        for (final AppLocale locale in AppLocale.values) {
          final String? copy = AppStrings(locale).restrictionReasonNote(key);
          expect(
            copy,
            isNotNull,
            reason: 'restriction reason `$key` has no $locale copy — add it to '
                'lib/src/settings/strings/pairing_strings.dart '
                '(restrictionReasonNote), mirroring ${_ssot.path}',
          );
          expect(copy!.trim().length, greaterThanOrEqualTo(8),
              reason: '`$key` $locale copy is too short to have said anything');
        }
      }
    });

    test('🔴 no two reasons share a sentence', () {
      // A stub that answered all five keys with one string would satisfy the
      // test above while telling four of five restricted users something false
      // about themselves. The protocol table's own notes say why these must stay
      // apart: "you used it too hard" and "you did something you shouldn't" are heard completely
      // differently, and `account_security` is the one restriction that is FOR
      // the account holder rather than against them.
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings(locale);
        final List<String> sentences = _keysFromSsot()
            .map((String k) => s.restrictionReasonNote(k)!)
            .toList();
        expect(sentences.toSet().length, sentences.length,
            reason: '$locale reuses one sentence for two different reasons');
      }
    });

    test("🔴 owner's copy rules hold on the phone too", () {
      // The protocol suite asserts these on the server table. They are asserted
      // AGAIN here rather than assumed, because these are two tables — that is
      // the whole premise of this file — and a rule enforced on only one of them
      // is enforced on the one users do not read.
      //
      //   · no 「封/ban/suspend」: a restriction is not a ban, and the difference
      //     is not cosmetic to the person it is about;
      //   · nothing promising anyone will reply: owner ruled there is no appeal
      //     channel, so a sentence implying one is a promise the product cannot
      //     keep (the `INJECT_PC_MISMATCH` precedent).
      const List<String> forbidden = <String>[
        '封号', '封禁', '停用', 'ban', 'banned', 'suspend', 'suspended',
        '申诉', 'appeal', '联系', 'contact', 'support', '問い合わせ', '이의', '문의',
        '@', 'http',
      ];
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings(locale);
        for (final String key in _keysFromSsot()) {
          final String copy = s.restrictionReasonNote(key)!.toLowerCase();
          for (final String bad in forbidden) {
            expect(copy, isNot(contains(bad.toLowerCase())),
                reason: '$locale `$key` says 「$bad」');
          }
        }
      }
    });

    test('an UNKNOWN key gets no sentence — never a fabricated one', () {
      // 0.2.53's rule applied one level down. The catch-all `other` is a reason
      // an operator CHOOSES; handing its sentence to a key we do not recognise
      // would tell a specific person that a human reviewed their account when
      // nobody here knows that. Null is how the caller learns to fall back to
      // the labelled identifier instead.
      const AppStrings s = AppStringsZh();
      for (final String? key in <String?>[
        null,
        '',
        'a_sixth_reason_nobody_mirrored',
        'OTHER',
        'terms_violation ',
      ]) {
        expect(s.restrictionReasonNote(key), isNull, reason: '$key');
      }
    });

    // ── the render half: what a restricted user actually reads ───────────────
    group('pairError renders the reason beside the refusal', () {
      test('🔴 a known reason becomes a second sentence, in every language', () {
        for (final AppLocale locale in AppLocale.values) {
          final AppStrings s = AppStrings(locale);
          final String bare = s.pairError('ACCOUNT_RESTRICTED');
          final String withReason =
              s.pairError('ACCOUNT_RESTRICTED:automated_or_bulk_use');
          // The refusal itself is unchanged — the reason RIDES BESIDE the code,
          // it does not replace it (account-restriction.ts says the same about
          // the wire).
          expect(withReason, startsWith(bare), reason: '$locale');
          expect(
            withReason,
            contains(s.restrictionReasonNote('automated_or_bulk_use')!),
            reason: '$locale dropped the reason the server sent',
          );
          // And the raw key never reaches the screen when we can render it.
          expect(withReason, isNot(contains('automated_or_bulk_use')),
              reason: '$locale showed the identifier next to its own sentence');
        }
      });

      test('no reason on the wire ⇒ the refusal alone, byte for byte', () {
        // A restriction applied before this column existed genuinely has no
        // recorded reason, and the server omits the field rather than
        // substituting the catch-all. The phone must degrade the same way.
        for (final AppLocale locale in AppLocale.values) {
          final AppStrings s = AppStrings(locale);
          expect(
            s.pairError('ACCOUNT_RESTRICTED:'),
            equals(s.pairError('ACCOUNT_RESTRICTED')),
            reason: '$locale invented a reason line from an empty key',
          );
        }
      });

      test('🔴 an unknown reason keeps the identifier, labelled — the '
          'error-code precedent', () {
        const AppStrings s = AppStringsZh();
        final String shown = s.pairError('ACCOUNT_RESTRICTED:brand_new_reason');
        // Kept: it is the one artefact the user can quote to a maintainer.
        expect(shown, contains('brand_new_reason'));
        // Labelled as an identifier, in the SAME words the unknown-error-code
        // arm uses — one vocabulary for "this is not a sentence written for you to read".
        expect(shown, contains('诊断码'));
        // Not swallowed into the generic refusal…
        expect(shown, contains(s.pairError('ACCOUNT_RESTRICTED')));
        // …and NOT given a fabricated sentence borrowed from a real reason.
        expect(shown, isNot(contains(s.restrictionReasonNote('other')!)));
        expect(shown, isNot(contains(s.restrictionReasonNote('terms_violation')!)));
      });

      test('no OTHER code acquires a reason line (the codes that carry colons '
          'of their own are untouched)', () {
        // `decodeRestrictionReason` splits on one prefix only. The regression it
        // could plausibly cause is on the two codes that already carry payloads
        // through this same channel, so they are named rather than assumed.
        const AppStrings s = AppStringsZh();
        expect(s.pairError('PC_BUSY:8000'), isNot(contains('诊断码')));
        expect(s.pairError('PAIR_RELEASED:60000'), isNot(contains('诊断码')));
        expect(s.pairError('PAIR_TIMEOUT: some exception text'),
            equals(s.pairError('PAIR_TIMEOUT: other text')),
            reason: 'the PAIR_TIMEOUT arm stopped ignoring its own tail');
      });
    });

    // ── the wire half ────────────────────────────────────────────────────────
    //
    // 🔴 WITHOUT THIS GROUP THE TABLE ABOVE WOULD BE A FAÇADE. Every assertion
    // so far calls `pairError` with a string a test wrote. The defect this card
    // fixes is one layer earlier and has no symbol to grep for: the server sends
    // `reason` beside `error`, the phone reads `error` and drops the sibling, and
    // nothing anywhere is null or red — the copy table is simply never reached.
    // That is the L-② shape `mobile_reconnect_flow.dart` already carries two
    // scars from, so it is measured on the real controller path rather than
    // assumed. CLAUDE.md anti-façade ③: unit-green proves nothing about wiring.
    group('a refusal ack carrying `reason` reaches the copy table', () {
      late FakeSocketTransport t;
      late ConnectionsController ctl;

      Future<ConnectOutcome> refuseWith(Map<String, Object?> ack) async {
        t = FakeSocketTransport()..connectSucceeds = true;
        final PttSession session = PttSession(
          transport: t,
          audio: AudioCapture(recorder: FakeAudioRecorder()),
          tokenStorage: InMemoryTokenStorage(),
        );
        ctl = ConnectionsController(
          session: session,
          login: LoginController(
            transport: t,
            accountStore: InMemoryAccountStore(),
            saasEndpoint: 'https://saas.test:443',
          ),
          healthReader: (Uri u, Duration d) async => HealthReading.offline,
        );
        await session.tokenStorage.addOrUpdatePairing(const MobileSession(
          token: 'tok-seeded-00000000000000000000',
          endpoint: 'http://192.168.1.5:41879',
          channel: 'standalone',
          pcName: 'Studio PC',
          pairingId: 'pair-seed',
        ));
        await ctl.load();
        t.defaultAck = ack;
        return ctl.connectTo(ctl.pairings.first);
      }

      test('🔴 the enumerated reason survives the trip to the screen', () async {
        // Byte-shape of the real refusal: `restrictionRefusalBody` in
        // apps/server-core/src/auth/account-restriction.ts.
        final ConnectOutcome out = await refuseWith(<String, Object?>{
          'error': 'ACCOUNT_RESTRICTED',
          'reason': 'legal_requirement',
        });
        expect(out.success, isFalse);
        // Packed into the one channel that reaches `pairError` at all.
        expect(out.error, 'ACCOUNT_RESTRICTED:legal_requirement');
        const AppStrings zh = AppStringsZh();
        final String shown = zh.pairError(out.error);
        expect(shown, contains(zh.restrictionReasonNote('legal_requirement')!));
        // POSITIVE CONTROL for the negative below: this rig CAN produce the
        // reason line, so its absence in the next test means the ack lacked one.
        expect(shown, isNot(contains('legal_requirement')),
            reason: 'the raw key reached the screen beside its own sentence');
      });

      test('an ack with no `reason` is unchanged — "the server did not say" stays that way',
          () async {
        final ConnectOutcome out = await refuseWith(<String, Object?>{
          'error': 'ACCOUNT_RESTRICTED',
        });
        expect(out.error, 'ACCOUNT_RESTRICTED', reason: 'a suffix was invented');
        const AppStrings zh = AppStringsZh();
        expect(zh.pairError(out.error), equals(zh.pairError('ACCOUNT_RESTRICTED')));
      });

      test('a non-restriction refusal is not touched by any of this', () async {
        // The regression a new decode most plausibly causes. `PAIR_RELEASED`
        // carries a budget through the SAME channel, and it must still arrive
        // with its `:ms` intact and no reason machinery in the way.
        final ConnectOutcome out = await refuseWith(<String, Object?>{
          'error': 'PAIR_RELEASED',
          'retryable': true,
          'retry_after_ms': 47000,
          // Present and deliberately ignored: `reason` belongs to one code.
          'reason': 'terms_violation',
        });
        expect(out.error, 'PAIR_RELEASED:47000');
        expect(AppStrings(AppLocale.zh).pairError(out.error), contains('47'));
      });
    });
  });
}
