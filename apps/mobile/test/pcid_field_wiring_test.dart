// 0.2.66 PCID — the WIRING half, driven through the real add-pairing sheet.
//
// 🔴 WHY THIS FILE EXISTS SEPARATELY FROM `pcid_rules_test.dart`. Every
// assertion over there stays green if the sheet never calls any of it: the
// predicate would still return the right answers, the payload would still
// serialise, and the user would still face a screen with no PCID field and a
// frame with no PCID on it. This repo has paid for that shape more than once
// (「单测全绿对『接线』零证明力」), so the four claims that actually matter are
// asserted HERE, against the widget a user touches:
//
//   ① the field appears for the relay address and NOT for a LAN one;
//   ② typing a relay address into a LAN-opened sheet reveals it;
//   ③ 🔴 a `PAIR_PCID_REQUIRED` refusal FORCE-SHOWS and FOCUSES it even when
//      our host guess said 「this is LAN」 (the bare-IP / self-hosted-relay user);
//   ④ the nine digits the user typed reach the emitted `mobile:pair` frame —
//      the anti-façade claim: a dropped parameter anywhere between the field
//      and `emitWithAck` is invisible to every other test in this repo.
//
// The pair ack is seeded as a REFUSAL on purpose in the frame-content tests:
// the frame is emitted before the ack is read, so the assertion is identical,
// and a successful pair would start the presence poll + reconnect ladder
// (periodic timers) and hang `pumpAndSettle`.

import 'dart:async';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show EventEnvelope;
import 'package:flowmic/src/ui/add_pairing_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/mobile_scanner_fake.dart';

/// The relay this fixture's phone is configured for (`--dart-define`
/// seam). Deliberately NOT flowmic.app: a test that only ever sees the
/// hardcoded default cannot tell 「compared against the config」 from 「hardcoded a domain」.
const String kRelay = 'https://relay.test';
const String kRelayHost = 'relay.test';
const String kLanAddress = '192.168.1.5:41879';

/// A relay reached by bare IP — our host guess says LAN, the server says PCID.
const String kRelayByIp = '203.0.113.9';

const Key kPcidField = ValueKey<String>('pair.pcid');
const Key kCodeField = ValueKey<String>('pair.code');

void main() {
  late FakeSocketTransport transport;
  late ConnectionsController controller;

  setUp(() {
    MobileScannerPlatform.instance = FakeMobileScannerPlatform();
    // Defaults to false (RCA-v3 doc in support/fakes.dart); without it
    // `transport.connect()` inside pair() pushes SocketStatus.error and the
    // seeded ack is never delivered.
    transport = FakeSocketTransport()..connectSucceeds = true;
    controller = ConnectionsController(
      session: newTestSession(transport: transport),
      login: newTestLogin(transport: transport),
      saasEndpoint: kRelay,
    );
  });

  /// Opens the REAL sheet the only way a user reaches it, and lands on the
  /// manual tab (GA-30: scan is the default one).
  Future<void> openManual(
    WidgetTester tester, {
    required AppStrings strings,
    required String initialEndpoint,
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
                    initialEndpoint: initialEndpoint,
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
  }

  Map<String, Object?>? lastPairFrame() {
    final List<EventEnvelope> frames =
        transport.emittedWhere(FlowMicEvents.mobilePair);
    if (frames.isEmpty) return null;
    return frames.last.data as Map<String, Object?>;
  }

  const AppStrings s = AppStringsZh();

  testWidgets('① relay address ⇒ the PCID field is on screen', (tester) async {
    await openManual(tester, strings: s, initialEndpoint: kRelay);

    expect(find.byKey(kPcidField), findsOneWidget);
    expect(find.text(s.pcidLabel), findsOneWidget);
    // Positive control for the negative test below: three fields, not two.
    expect(find.byType(TextField), findsNWidgets(3));
  });

  testWidgets(
    '① LAN address ⇒ NO PCID field (owner: 「本地局域网……没有 PCID」)',
    (tester) async {
      await openManual(tester, strings: s, initialEndpoint: kLanAddress);

      expect(find.byKey(kPcidField), findsNothing);
      expect(find.text(s.pcidLabel), findsNothing);
      // …and the LAN sheet is otherwise EXACTLY what 0.2.65 showed.
      expect(find.byType(TextField), findsNWidgets(2));
      expect(find.byKey(kCodeField), findsOneWidget);
    },
  );

  testWidgets('② typing the relay address reveals the field live', (tester) async {
    await openManual(tester, strings: s, initialEndpoint: kLanAddress);
    expect(find.byKey(kPcidField), findsNothing);

    await tester.enterText(find.byType(TextField).at(0), kRelayHost);
    await tester.pump();

    expect(find.byKey(kPcidField), findsOneWidget,
        reason: 'the address field must drive a rebuild, not wait for one');
  });

  testWidgets(
    '🔴 ③ a PAIR_PCID_REQUIRED refusal force-shows AND focuses the field, '
    'even though the host guess said LAN',
    (tester) async {
      transport.ackQueue.add(<String, Object?>{'error': 'PAIR_PCID_REQUIRED'});
      await openManual(tester, strings: s, initialEndpoint: kRelayByIp);

      // Precondition: our guess hid it. This is the user the design §7-1 red
      // line is about — without the force-show they have no way in.
      expect(find.byKey(kPcidField), findsNothing);

      await tester.enterText(find.byKey(kCodeField), '1234');
      await tester.tap(find.text(s.pairConnect));
      await tester.pumpAndSettle();

      expect(find.byKey(kPcidField), findsOneWidget,
          reason: 'the server is the source of truth, not our host comparison');
      final TextField field = tester.widget<TextField>(find.byKey(kPcidField));
      expect(field.focusNode?.hasFocus, isTrue,
          reason: 'revealed but unfocused makes the user hunt for what changed');
      // The frame DID go out (this is not a local refusal) and it carried no
      // pcid — which is exactly what the relay complained about.
      expect(lastPairFrame()?.containsKey('pcid'), isFalse);
    },
  );

  testWidgets(
    '🔴 ④ ANTI-FAÇADE — the nine digits typed reach the emitted mobile:pair frame',
    (tester) async {
      transport.ackQueue.add(<String, Object?>{'error': 'PAIR_INVALID_CODE'});
      await openManual(tester, strings: s, initialEndpoint: kRelay);

      await tester.enterText(find.byKey(kPcidField), '123456789');
      await tester.enterText(find.byKey(kCodeField), '1234');
      await tester.tap(find.text(s.pairConnect));
      await tester.pumpAndSettle();

      final Map<String, Object?>? frame = lastPairFrame();
      expect(frame, isNotNull, reason: 'no frame left the phone at all');
      expect(frame!['short_code'], '1234');
      expect(frame['pcid'], '123456789');
    },
  );

  testWidgets(
    '④b the display grouping is accepted and the WIRE gets bare digits',
    (tester) async {
      transport.ackQueue.add(<String, Object?>{'error': 'PAIR_INVALID_CODE'});
      await openManual(tester, strings: s, initialEndpoint: kRelay);

      await tester.enterText(find.byKey(kPcidField), '123 456 789');
      await tester.enterText(find.byKey(kCodeField), '1234');
      await tester.tap(find.text(s.pairConnect));
      await tester.pumpAndSettle();

      expect(lastPairFrame()?['pcid'], '123456789');
    },
  );

  testWidgets(
    '④c LAN control — a LAN pairing still emits a frame with NO pcid key',
    (tester) async {
      // The negative assertion above needs this positive twin: 「no pcid on the frame」 must
      // mean 「LAN is unchanged」, not 「we broke the whole path」.
      transport.ackQueue.add(<String, Object?>{'error': 'PAIR_INVALID_CODE'});
      await openManual(tester, strings: s, initialEndpoint: kLanAddress);

      await tester.enterText(find.byKey(kCodeField), '1234');
      await tester.tap(find.text(s.pairConnect));
      await tester.pumpAndSettle();

      final Map<String, Object?>? frame = lastPairFrame();
      expect(frame, isNotNull);
      expect(frame, <String, Object?>{'short_code': '1234'});
    },
  );

  testWidgets(
    '⑤ local validation: field visible + empty ⇒ named error and NO frame',
    (tester) async {
      await openManual(tester, strings: s, initialEndpoint: kRelay);

      await tester.enterText(find.byKey(kCodeField), '1234');
      await tester.tap(find.text(s.pairConnect));
      await tester.pumpAndSettle();

      expect(find.text(s.pairNeedPcid), findsOneWidget);
      expect(transport.emittedWhere(FlowMicEvents.mobilePair), isEmpty,
          reason: 'a frame we know the relay will refuse must not be sent');
    },
  );

  testWidgets('⑤b eight digits is not a PCID either', (tester) async {
    await openManual(tester, strings: s, initialEndpoint: kRelay);

    await tester.enterText(find.byKey(kPcidField), '12345678');
    await tester.enterText(find.byKey(kCodeField), '1234');
    await tester.tap(find.text(s.pairConnect));
    await tester.pumpAndSettle();

    expect(find.text(s.pairNeedPcid), findsOneWidget);
    expect(transport.emittedWhere(FlowMicEvents.mobilePair), isEmpty);
  });

  testWidgets(
    '⑤c the field caps at nine digits, so a tenth cannot be typed',
    (tester) async {
      await openManual(tester, strings: s, initialEndpoint: kRelay);

      await tester.enterText(find.byKey(kPcidField), '1234567890123');
      await tester.pump();

      expect(
        tester.widget<TextField>(find.byKey(kPcidField)).controller?.text,
        '123456789',
      );
    },
  );

  testWidgets(
    '⑥ a PCID typed, then a LAN address ⇒ it does NOT ride along to the sidecar',
    (tester) async {
      transport.ackQueue.add(<String, Object?>{'error': 'PAIR_INVALID_CODE'});
      await openManual(tester, strings: s, initialEndpoint: kRelay);

      await tester.enterText(find.byKey(kPcidField), '123456789');
      await tester.enterText(find.byType(TextField).at(0), kLanAddress);
      await tester.pump();
      // The field is gone, and with it the value's right to be on the wire.
      expect(find.byKey(kPcidField), findsNothing);

      await tester.enterText(find.byKey(kCodeField), '1234');
      await tester.tap(find.text(s.pairConnect));
      await tester.pumpAndSettle();

      expect(lastPairFrame(), <String, Object?>{'short_code': '1234'});
    },
  );
}
