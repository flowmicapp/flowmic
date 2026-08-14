// 0.2.66 PCID — the two new refusals, as the user READS them.
//
// 🔴 ASSERTED ON THE RENDERED TREE, NOT ON `Text.data`. 0.2.53 shipped because a
// test asserted the string a widget was handed while the screen showed three
// clipped letters (`inject_verdict_note_test.dart`'s header carries the full
// story). The pairing banner wraps rather than ellipsis-clips, so the check is
// simpler here — but it is still 「find the sentence in the tree the user is
// looking at」, driven through the real sheet by a real refusal, and never
// `s.pairError(...) == '…'` alone.
//
// Modelled on `pair_expired_code_render_test.dart`, which did the same thing for
// PAIR_EXPIRED_CODE.

import 'dart:async';

import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/pcid.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/add_pairing_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/mobile_scanner_fake.dart';

const String kRelay = 'https://relay.test';

void main() {
  late FakeSocketTransport transport;
  late ConnectionsController controller;

  setUp(() {
    MobileScannerPlatform.instance = FakeMobileScannerPlatform();
    transport = FakeSocketTransport()..connectSucceeds = true;
    controller = ConnectionsController(
      session: newTestSession(transport: transport),
      login: newTestLogin(transport: transport),
      saasEndpoint: kRelay,
    );
  });

  /// Open the real sheet, fill the manual tab, submit. [pcid] is entered when
  /// the field is on screen (it always is here — the address is the relay).
  Future<void> submit(
    WidgetTester tester, {
    required AppStrings strings,
    String? pcid,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (BuildContext context) => ElevatedButton(
              onPressed: () {
                unawaited(
                  showAddPairingSheet(
                    context,
                    controller: controller,
                    strings: strings,
                    initialEndpoint: kRelay,
                  ),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text(strings.pairTabManual));
    await tester.pumpAndSettle();

    if (pcid != null) {
      await tester.enterText(
        find.byKey(const ValueKey<String>('pair.pcid')),
        pcid,
      );
    }
    await tester.enterText(find.byKey(const ValueKey<String>('pair.code')), '1234');
    await tester.tap(find.text(strings.pairConnect));
    await tester.pumpAndSettle();
  }

  for (final AppLocale locale in AppLocale.values) {
    testWidgets('$locale · PAIR_PCID_REQUIRED renders a sentence naming the action',
        (WidgetTester tester) async {
      transport.ackQueue.add(<String, Object?>{'error': kPairPcidRequired});
      final AppStrings s = AppStrings.of(locale);

      // The sheet's own local validation would fire first with the field empty,
      // so a well-formed PCID is supplied: this test is about what the SERVER
      // says, and reaching that path is part of what it proves.
      await submit(tester, strings: s, pcid: '123456789');

      final String expected = s.pairError(kPairPcidRequired);
      // Positive control: the mapping produces a real sentence, so "the bare
      // code is not on screen" cannot be true for the wrong reason (an empty
      // string is also "not the code").
      expect(expected, isNot(kPairPcidRequired), reason: '$locale');
      expect(expected.length, greaterThan(20), reason: '$locale');

      expect(find.text(expected), findsOneWidget,
          reason: '$locale — the user must be able to read what to do');
      expect(find.textContaining(kPairPcidRequired), findsNothing,
          reason: '$locale — the bare identifier must not be on screen');
      // …and the sentence is NOT the honest-but-useless generic fallback.
      expect(expected, isNot(s.pairError('SOME_UNMAPPED_CODE')), reason: '$locale');

      // 🔴 The action this sentence names is on screen by the time it is read.
      // A sentence naming a control that is not there is the
      // promise-this-screen-cannot-keep shape (INJECT_PC_MISMATCH).
      expect(find.byKey(const ValueKey<String>('pair.pcid')), findsOneWidget,
          reason: '$locale');

      await tester.tap(find.byIcon(Icons.close));
      await tester.pumpAndSettle();
    });

    testWidgets('$locale · PAIR_PCID_UNKNOWN renders its own, different sentence',
        (WidgetTester tester) async {
      transport.ackQueue.add(<String, Object?>{'error': kPairPcidUnknown});
      final AppStrings s = AppStrings.of(locale);

      await submit(tester, strings: s, pcid: '123456789');

      final String expected = s.pairError(kPairPcidUnknown);
      expect(expected, isNot(kPairPcidUnknown), reason: '$locale');
      expect(find.text(expected), findsOneWidget, reason: '$locale');
      expect(find.textContaining(kPairPcidUnknown), findsNothing, reason: '$locale');

      // 🔴 TWO CODES, TWO SENTENCES. Folding them would send a user who typed a
      // wrong PCID off to scan a QR they already declined to scan — and would
      // tell a user who typed none that their PCID does not exist.
      expect(expected, isNot(s.pairError(kPairPcidRequired)), reason: '$locale');
      // And neither of them says 「配对码无效」: the code may be perfectly right.
      expect(expected, isNot(s.pairError('PAIR_INVALID_CODE')), reason: '$locale');

      await tester.tap(find.byIcon(Icons.close));
      await tester.pumpAndSettle();
    });
  }

  test('the four languages are all present and distinct for both codes', () {
    // Cheap guard against a copy-paste that leaves one locale on the zh string
    // — the i18n lint covers `error-codes.ts`, and NOTHING covers this table
    // (CLAUDE.md: 「没有任何机制把协议注册表与手机那张表绑在一起」).
    for (final String code in <String>[kPairPcidRequired, kPairPcidUnknown]) {
      final Set<String> seen = <String>{};
      for (final AppLocale locale in AppLocale.values) {
        final String copy = AppStrings.of(locale).pairError(code);
        expect(copy.trim(), isNotEmpty, reason: '$code/$locale');
        expect(copy, contains('PCID'),
            reason: '$code/$locale — the desktop prints「PCID」beside the number');
        seen.add(copy);
      }
      expect(seen.length, AppLocale.values.length,
          reason: '$code — two locales share one sentence');
    }
  });
}
