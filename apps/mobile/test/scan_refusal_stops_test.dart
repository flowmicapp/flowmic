// P1b (0.3.1) — a refused scan STOPS the scanner; 「重新扫描」 re-arms it by hand.
//
// SPEC-REF:
//   docs/strategy/2026-08-15-031-fix-batch-design.md §3 (P1b contract)
//   lib/src/ui/add_pairing_sheet.dart  _onDetect / _submitScanned
//
// WHY: `DetectionSpeed.noDuplicates` resets its native dedup on barcode-free
// frames, so a QR held in front of the camera refires several times a second.
// The old `_submitScanned` re-armed after EVERY failure, so each refire burned
// another `pairLimiter` token (ending in PAIR_RATE_LIMITED) while the error
// banner was cleared and re-set each cycle — the sheet-height oscillation the
// owner reported as flicker. A refusal is a property of the scanned QR (or of
// the PC's row), not a transient: auto-retrying the same payload can never
// succeed. So the scanner stays consumed and the user re-arms deliberately.
//
// COVERAGE HOLE CLOSED: this is the first file that FEEDS the fake scanner
// stream (support/mobile_scanner_fake.dart `addBarcode`) — every earlier test
// pumped the real sheet only so initState would not throw, which left the
// entire scan→refusal path invisible to the suite.
//
// 🔴 REVERSE CONTROL (recorded, 2026-08-15, machine dev-pc-a): this
// file was written FIRST and run against the pre-fix sheet (`_submitScanned`
// ending in `setState(() => _scanConsumed = false)`). Verbatim failures,
// `00:02 +1 -3: Some tests failed.`:
//   · 「refusal stops the scanner」:
//       Expected: <1>
//         Actual: <2>
//       a refusal is a property of the scanned QR — auto-retry cannot succeed
//       and only burns the PAIR_RATE_LIMITED budget
//     — the second capture of the SAME QR started a second pair attempt.
//   · 「scan-again re-arms」: The finder "Found 0 widgets with text "重新扫描":
//       []" (used in a call to "tap()") could not find any matching widgets.
//     — the re-arm button did not exist.
//   · 「BUSY is not silence」:
//       Actual: _TextWidgetFinder:<Found 0 widgets with text "配对中…": []>
//     — the BUSY early-exit left no copy on screen at all.
// ⚠️ HONEST RECORD — the fourth test (scanner remount) was GREEN against the
// old code too: Flutter's trailing-child sync happened to preserve the element
// even with the notice inserted above the pane. It is a regression guard for
// the ordering this fix ships (notices now render below the pane, so the pane
// is always the branch's FIRST child and no re-sync can displace it), not part
// of the red evidence. Its first draft also asserted rect equality and went
// red against the FIXED code — because in a bottom-anchored sheet any content
// growth moves the pane; that assertion measured the wrong thing and was
// removed (the in-test comment carries the full reasoning).
// The three reds went green after the fix with no assertion edited.

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

const String kRelay = 'https://relay.test';

/// A well-formed pairing link (04 §3.1): its own endpoint + a 4-digit code, so
/// `PairEntry.parse` accepts it and the refusal under test is the SERVER's,
/// never a local FormatException.
const String kPairLink = 'flowmic://pair?endpoint=ws://192.168.1.5:41879&code=1234';

BarcodeCapture _capture(String raw) =>
    BarcodeCapture(barcodes: <Barcode>[Barcode(rawValue: raw)]);

/// `addByCode`'s silent early exit, made reachable. In production 'BUSY' needs
/// a pair attempt started OUTSIDE the sheet (e.g. the reconnect ladder) to be
/// in flight between `_onDetect`'s guard and `addByCode`'s `_busy` check — a
/// cross-path race a widget test cannot schedule, because both checks read the
/// same field with no await between them on the scan path. The double keeps
/// the REAL sheet and fakes only the outcome, which is exactly the value under
/// test ('BUSY' arrives with `lastError` left null — silence, before P1b).
class _BusyControllerFake extends ConnectionsController {
  _BusyControllerFake({
    required super.session,
    required super.login,
    super.saasEndpoint,
  });

  int addByCodeCalls = 0;

  @override
  Future<ConnectOutcome> addByCode({
    required String rawEndpoint,
    required String code,
    String? pcid,
  }) async {
    addByCodeCalls++;
    return const ConnectOutcome.failed('BUSY');
  }
}

void main() {
  late FakeMobileScannerPlatform scanner;
  late FakeSocketTransport transport;
  late ConnectionsController controller;

  setUp(() {
    scanner = FakeMobileScannerPlatform();
    MobileScannerPlatform.instance = scanner;
    // connectSucceeds: without it the fake pushes SocketStatus.error on dial
    // and the seeded refusal ack is never delivered (support/fakes.dart doc).
    transport = FakeSocketTransport()..connectSucceeds = true;
    controller = ConnectionsController(
      session: newTestSession(transport: transport),
      login: newTestLogin(transport: transport),
      saasEndpoint: kRelay,
    );
  });

  const AppStrings s = AppStringsZh();

  /// Opens the REAL sheet the only way a user reaches it. Scan is the default
  /// tab (GA-30), so the camera pane is live immediately — no tab tap.
  Future<void> openSheet(
    WidgetTester tester, {
    ConnectionsController? withController,
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
                    controller: withController ?? controller,
                    strings: s,
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
  }

  /// One camera capture, delivered and settled: the broadcast stream hands the
  /// frame over on a microtask (first pump), the pair round-trip then runs to
  /// its ack (pumpAndSettle).
  Future<void> feed(WidgetTester tester, String raw) async {
    scanner.addBarcode(_capture(raw));
    await tester.pump();
    await tester.pumpAndSettle();
  }

  List<EventEnvelope> pairFrames() =>
      transport.emittedWhere(FlowMicEvents.mobilePair);

  testWidgets(
    '🔴 refusal stops the scanner: the same QR refiring starts NO second attempt, '
    'the copy stays put, and the re-arm button is on screen',
    (WidgetTester tester) async {
      // Two acks seeded on purpose: the fixed sheet consumes only the first.
      // Under the pre-fix sheet the second capture consumed the second ack —
      // that is the reverse-control red recorded in the header.
      transport.ackQueue.add(<String, Object?>{'error': 'PAIR_INVALID_CODE'});
      transport.ackQueue.add(<String, Object?>{'error': 'PAIR_INVALID_CODE'});
      await openSheet(tester);

      await feed(tester, kPairLink);
      expect(pairFrames().length, 1,
          reason: 'positive control — the first capture must really pair');
      final String refusal = s.pairError('PAIR_INVALID_CODE');
      expect(find.text(refusal), findsOneWidget,
          reason: 'the refusal must be readable, not swallowed');

      // Production reality: noDuplicates resets on barcode-free frames, so the
      // SAME QR fires again fractions of a second later.
      await feed(tester, kPairLink);
      expect(pairFrames().length, 1,
          reason: 'a refusal is a property of the scanned QR — auto-retry '
              'cannot succeed and only burns the PAIR_RATE_LIMITED budget');

      // No oscillation: the banner neither blinks away nor stacks as frames go by.
      await tester.pump(const Duration(milliseconds: 120));
      await tester.pump(const Duration(milliseconds: 120));
      expect(find.text(refusal), findsOneWidget);

      // The way back in is deliberate, and it is on screen.
      expect(find.text(s.pairScanAgain), findsOneWidget);
      // The camera pane itself stays mounted — stopping ATTEMPTS must not read
      // as the app switching the user to manual entry.
      expect(find.byType(MobileScanner), findsOneWidget);
    },
  );

  testWidgets(
    '「重新扫描」 re-arms exactly one more attempt and clears the old refusal',
    (WidgetTester tester) async {
      transport.ackQueue.add(<String, Object?>{'error': 'PAIR_INVALID_CODE'});
      transport.ackQueue.add(<String, Object?>{'error': 'PAIR_EXPIRED_CODE'});
      await openSheet(tester);

      await feed(tester, kPairLink);
      expect(pairFrames().length, 1);
      expect(find.text(s.pairError('PAIR_INVALID_CODE')), findsOneWidget);

      await tester.tap(find.text(s.pairScanAgain));
      await tester.pump();
      // Re-arming clears the shown refusal: a stale sentence over a live
      // camera would be a status word nothing currently backs (R11).
      expect(find.text(s.pairError('PAIR_INVALID_CODE')), findsNothing);

      await feed(tester, kPairLink);
      expect(pairFrames().length, 2,
          reason: 'the button is the ONE way a stopped scanner comes back');
      // The second refusal renders once — banners do not stack.
      expect(find.text(s.pairError('PAIR_EXPIRED_CODE')), findsOneWidget);
      expect(find.text(s.pairError('PAIR_INVALID_CODE')), findsNothing);
    },
  );

  testWidgets(
    "the 'BUSY' early exit is not silence: an honest line, and the scanner stops",
    (WidgetTester tester) async {
      final _BusyControllerFake busy = _BusyControllerFake(
        session: newTestSession(transport: transport),
        login: newTestLogin(transport: transport),
        saasEndpoint: kRelay,
      );
      await openSheet(tester, withController: busy);

      await feed(tester, kPairLink);
      expect(busy.addByCodeCalls, 1);
      // 'BUSY' sets no lastError (connections_controller.dart addByCode's
      // early return), so before P1b this path showed NOTHING. The honest
      // reusable line is 「配对中…」 — a pair attempt IS in flight, which is
      // exactly what the code means.
      expect(find.text(s.pairing), findsOneWidget,
          reason: "silence over a swallowed attempt is the banned shape");

      await feed(tester, kPairLink);
      expect(busy.addByCodeCalls, 1,
          reason: 'BUSY stops the scanner like any other refusal');
    },
  );

  testWidgets(
    'a scan notice must not remount the scanner subtree (preview restart)',
    (WidgetTester tester) async {
      await openSheet(tester);
      final Element beforeElement = tester.element(find.byType(MobileScanner));

      // A readable barcode that is not ours — the loud, named refusal whose
      // banner used to be inserted ABOVE the scan pane in the unkeyed Column.
      scanner.addBarcode(_capture('WIFI:T:WPA;S:home;P:pw;;'));
      await tester.pump();
      await tester.pump();

      expect(find.text(s.pairScanForeign), findsOneWidget,
          reason: 'positive control — the notice must actually be on screen');
      // 🔴 THE RULER, CHECKED: an earlier draft asserted rect equality and it
      // was measuring the wrong thing — this is a bottom-anchored sheet, so
      // ANY content growth (above or below the pane) resizes the sheet and
      // moves the pane on screen; rect equality is not an invariant anyone
      // can hold here. What 「preview restart」 actually is: the ELEMENT being
      // remounted by an unkeyed-Column re-sync — a remounted platform view is
      // a torn-down and re-created camera. So identity is what gets pinned.
      expect(identical(tester.element(find.byType(MobileScanner)), beforeElement),
          isTrue,
          reason: 'notices may not cause the MobileScanner element to remount');
    },
  );
}
