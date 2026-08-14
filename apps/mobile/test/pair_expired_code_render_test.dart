// Card U3 (0.3.0) — mobile-side proof that a PAIR_EXPIRED_CODE refusal renders the
// four-language friendly sentence, not a bare identifier.
//
// WHY THIS TEST EXISTS. The server half of card U3 (apps/server-core/src/room/
// registry.ts, resolvePcForPair) now distinguishes an aged-out/superseded code
// from one that never existed: PAIR_EXPIRED_CODE vs PAIR_INVALID_CODE.
// pairing_strings.dart has carried a `case 'PAIR_EXPIRED_CODE':` sentence
// since the code was added to packages/protocol/src/error-codes.ts, but until
// the server fix landed that branch was DEAD CODE on the mobile side — nothing
// the server could send would ever select it. This test drives the REAL
// production widget (`showAddPairingSheet`, reached the only way a user
// reaches it: tap Manual, type a 4-digit code, submit) through a faked
// transport whose pairing ack is `{'error': 'PAIR_EXPIRED_CODE'}`, and asserts
// on the RENDERED text, not `Text.data` alone.
//
// 🔴 This repo shipped 0.2.53 precisely because a different test asserted
// `Text.data` while the actual screen showed three clipped letters
// (see inject_verdict_note_test.dart's header for the full story, and its
// house style for measuring rendered text this file follows). Here the
// `_errorBanner` Text has no maxLines/overflow (it wraps, it does not
// ellipsis-clip), so the relevant rendered-result check is simpler — but the
// same rule applies: find the SENTENCE in the rendered tree, not the code.
//
// SCOPE: mobile TEST ONLY. No production edits, no pairing_strings.dart edits
// (U5 owns mobile strings this wave). This test also documents, without
// fixing, the neighbouring default-branch defect in AppStrings.pairError that
// prints a bare identifier for unmapped codes (U5's card, not this one's).
//
// mobile_scanner risk: `_AddPairingSheet.initState` unconditionally builds a
// real MobileScannerController and starts it (autoStart defaults true), so
// pumping the real sheet with no platform double would throw
// MissingPluginException. The fix below is the pattern from the package's OWN
// test suite (mobile_scanner-7.4.0/test/mobile_scanner_widget/
// detect_barcode_test.dart): swap MobileScannerPlatform.instance for a plain
// Dart Fake overriding only what the exercised path calls. Every method the
// Fake does NOT override throws UnimplementedError by construction (see
// mobile_scanner_platform_interface.dart), so nothing here silently routes
// through the real MethodChannel.

import 'dart:async';

import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/add_pairing_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// Minimal platform double for the pairing sheet's camera pane. Traced call
/// path: `_initializeController` → `controller.attach()` (no platform call) →
/// `controller.start()` → `_setupListeners()` (needs the three stream
/// getters) → `MobileScannerPlatform.instance.start()` → the preview widget
/// calls `buildCameraView()`. Switching away from the scan tab disposes the
/// `MobileScanner` widget, which calls `controller.stop()` (since `autoStart`
/// is true) → platform `stop()`; ending the whole sheet later disposes the
/// controller itself → platform `dispose()`. Those are the only six methods
/// this fixture needs, and 0 of them touch a MethodChannel.
class _FakeMobileScannerPlatform extends MobileScannerPlatform {
  final StreamController<BarcodeCapture> _barcodes =
      StreamController<BarcodeCapture>.broadcast();

  @override
  Stream<BarcodeCapture?> get barcodesStream => _barcodes.stream;

  @override
  Stream<TorchState> get torchStateStream =>
      Stream<TorchState>.value(TorchState.unavailable);

  @override
  Stream<double> get zoomScaleStateStream => Stream<double>.value(1);

  @override
  Future<MobileScannerViewAttributes> start(StartOptions startOptions) {
    return Future<MobileScannerViewAttributes>.value(
      const MobileScannerViewAttributes(
        cameraDirection: CameraFacing.back,
        currentTorchMode: TorchState.unavailable,
        size: Size(200, 200),
        numberOfCameras: 1,
      ),
    );
  }

  @override
  Widget buildCameraView() => const SizedBox.square(dimension: 100);

  @override
  Future<void> stop() async {}

  @override
  Future<void> dispose() async {}
}

void main() {
  late FakeSocketTransport transport;
  late ConnectionsController controller;

  setUp(() {
    // Installed once; every MobileScannerController built by every sheet in
    // this file (one per pumpWidget) talks to this same double.
    MobileScannerPlatform.instance = _FakeMobileScannerPlatform();

    // FakeSocketTransport.connectSucceeds defaults to false (RCA-v3 doc in
    // support/fakes.dart) — without this, transport.connect() during pair()
    // pushes SocketStatus.error and the ack-carrying emitWithAck throws a
    // StateError instead of ever delivering the seeded PAIR_EXPIRED_CODE ack.
    transport = FakeSocketTransport()..connectSucceeds = true;

    final session = newTestSession(transport: transport);
    final login = newTestLogin(transport: transport);
    controller = ConnectionsController(session: session, login: login);
  });

  /// Drives the REAL sheet (via the public showAddPairingSheet entry point)
  /// from "tap to open" through "submit a manual 4-digit code", exactly the
  /// path a user takes. A single dial candidate (manual code ⇒ no QR
  /// endpoint) means chooseDialEndpoint short-circuits with zero network
  /// probing, so no health-reader fake is needed here.
  Future<void> openSheetAndSubmitCode(
    WidgetTester tester, {
    required AppStrings strings,
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

    // GA-30: scan is the default tab; manual entry is the second one.
    await tester.tap(find.text(strings.pairTabManual));
    await tester.pumpAndSettle();

    final Finder fields = find.byType(TextField);
    expect(fields, findsNWidgets(2), reason: 'expected address field + code field');
    await tester.enterText(fields.at(0), '192.168.1.50:41999');
    await tester.enterText(fields.at(1), '1234');
    await tester.pump();

    await tester.tap(find.text(strings.pairConnect));
    await tester.pumpAndSettle();
  }

  testWidgets(
    '🔴 U3 — PAIR_EXPIRED_CODE renders the friendly sentence, not the bare code',
    (WidgetTester tester) async {
      transport.ackQueue.add(<String, Object?>{'error': 'PAIR_EXPIRED_CODE'});
      const AppStrings s = AppStringsZh();

      await openSheetAndSubmitCode(tester, strings: s);

      // Positive control: the mapping produces an actual sentence distinct
      // from the code — otherwise "the bare code is absent" would be true for
      // the wrong reason (e.g. an empty string is also "not the code").
      final String expected = s.pairError('PAIR_EXPIRED_CODE');
      expect(expected, isNot('PAIR_EXPIRED_CODE'));
      expect(expected, isNotEmpty);

      // Rendered result: the full friendly sentence is actually on screen...
      expect(
        find.text(expected),
        findsOneWidget,
        reason: 'user must be able to read why pairing failed',
      );
      // ...and the bare identifier the server actually sent is NOT — this is
      // exactly the gap 0.2.53 taught this repo to check explicitly, applied
      // here to a code that (before the server fix) could never even reach
      // this render site to be checked.
      expect(find.textContaining('PAIR_EXPIRED_CODE'), findsNothing);

      // Fail-loud: the sheet stays open on a failed pair (no fake success),
      // which also confirms this is the SAME tree the user is looking at.
      expect(find.text(s.pairConnect), findsOneWidget);
    },
  );

  testWidgets(
    'PAIR_EXPIRED_CODE sentence renders for all four locales',
    (WidgetTester tester) async {
      for (final AppLocale locale in AppLocale.values) {
        transport.ackQueue.add(<String, Object?>{'error': 'PAIR_EXPIRED_CODE'});
        final AppStrings s = AppStrings.of(locale);

        await openSheetAndSubmitCode(tester, strings: s);

        final String expected = s.pairError('PAIR_EXPIRED_CODE');
        expect(expected, isNot('PAIR_EXPIRED_CODE'), reason: '$locale');
        expect(find.text(expected), findsOneWidget, reason: '$locale');
        expect(
          find.textContaining('PAIR_EXPIRED_CODE'),
          findsNothing,
          reason: '$locale',
        );

        // The Navigator/Overlay backing this MaterialApp is a STATEFUL object
        // that survives a plain pumpWidget() call when the new root widget is
        // structurally identical (same type, no key) — Flutter updates the
        // existing element tree rather than remounting it. A bottom sheet
        // route pushed in a previous iteration would therefore still be on
        // screen (and its barrier would eat the next "open" tap) unless it is
        // popped through the sheet's own close control first, exactly as a
        // real user would dismiss it.
        await tester.tap(find.byIcon(Icons.close));
        await tester.pumpAndSettle();
      }
    },
  );

  testWidgets(
    '③ reported, not fixed — U5\'s neighbouring defect: an unmapped code still '
    'prints the bare identifier via the default branch',
    (WidgetTester tester) async {
      // Not this card's fix (mobile strings/production are U5's this wave).
      // Recorded here as the one place this test happens to walk past it, so
      // the finding is not lost between the two cards' reports.
      transport.ackQueue.add(<String, Object?>{'error': 'SOME_UNMAPPED_CODE'});
      const AppStrings s = AppStringsEn();

      await openSheetAndSubmitCode(tester, strings: s);

      expect(
        find.textContaining('SOME_UNMAPPED_CODE'),
        findsOneWidget,
        reason:
            'AppStrings.pairError default branch prints the bare code for '
            'unmapped errors — this is the U5-owned defect, unchanged by U3',
      );
    },
  );
}
