// GA-30 — what a scanned barcode means.
//
// The camera cannot be driven in a unit test, so the contract worth pinning is
// the classification: aiming produces a stream of nothings (silence), somebody
// else's QR produces a NAMED refusal (not a bogus pairing error), and our own
// link is passed through untouched to the parser that already owns it.

import 'package:flutter_test/flutter_test.dart';
import 'package:flowmic/src/ui/scan_payload.dart';

void main() {
  group('classifyScan', () {
    test('an empty / absent value is silence, not an error', () {
      // This fires many times a second while the user aims. Anything louder than
      // nothing would make the sheet strobe.
      for (final String? raw in <String?>[null, '', '   ', '\n']) {
        expect(classifyScan(raw).verdict, ScanVerdict.nothing);
        expect(classifyScan(raw).isTerminal, isFalse);
      }
    });

    test('our pairing link is passed through VERBATIM', () {
      const String link =
          'flowmic://pair?endpoint=ws://192.168.1.20:41879&code=4821&channel=standalone';
      final ScanResult r = classifyScan('  $link  ');
      expect(r.verdict, ScanVerdict.pairLink);
      // Verbatim matters: addByCode/PairEntry.parse owns the format, and a
      // helpful rewrite here would be a second parser to drift.
      expect(r.payload, link);
      expect(r.isTerminal, isTrue);
    });

    test('the saas channel form is ours too', () {
      final ScanResult r = classifyScan(
        'flowmic://pair?endpoint=wss://flowmic.app&code=1234&channel=saas',
      );
      expect(r.verdict, ScanVerdict.pairLink);
    });

    test('a foreign QR is refused BY NAME, never handed to the pairing call', () {
      // The failure this prevents: scanning a Wi-Fi/URL QR and being told
      // 「配对码无效」, which sends the user looking for a code problem that does
      // not exist.
      for (final String raw in <String>[
        'WIFI:S:home;T:WPA;P:hunter2;;',
        'https://example.com',
        '4821',
        'flowmicpair?code=1',
      ]) {
        final ScanResult r = classifyScan(raw);
        expect(r.verdict, ScanVerdict.foreign, reason: raw);
        expect(r.payload, isNull);
        expect(r.isTerminal, isFalse);
      }
    });

    test('a LOGIN link gets its own verdict — right app, wrong screen', () {
      final ScanResult r = classifyScan('flowmic://login?t=abc123');
      expect(r.verdict, ScanVerdict.loginLink);
      expect(r.isTerminal, isFalse);
    });

    test('the scheme match is case-insensitive but the payload is not lowercased', () {
      final ScanResult r = classifyScan('FLOWMIC://PAIR?endpoint=ws://H:1&code=0001');
      expect(r.verdict, ScanVerdict.pairLink);
      expect(r.payload, 'FLOWMIC://PAIR?endpoint=ws://H:1&code=0001');
    });
  });

  group('parseLoginLink (GA-31 scan-to-login)', () {
    test('reads the nonce and the endpoint the console encoded', () {
      final LoginScan? scan =
          parseLoginLink('flowmic://login?endpoint=https://flowmic.app&t=abc123');
      expect(scan, isNotNull);
      expect(scan!.nonce, 'abc123');
      expect(scan.endpoint, 'https://flowmic.app');
    });

    test('an absent endpoint means「use the one the app is configured with」, not an empty dial', () {
      final LoginScan? scan = parseLoginLink('flowmic://login?t=abc123');
      expect(scan!.nonce, 'abc123');
      expect(scan.endpoint, isNull);
    });

    test('a link with no nonce is NOT a login code', () {
      // Guessing here would send an empty credential to the server and surface
      // as「wrong account or password」 for a user who typed nothing.
      for (final String raw in <String>[
        'flowmic://login',
        'flowmic://login?t=',
        'flowmic://login?t=%20%20',
        'flowmic://pair?endpoint=ws://h:1&code=1234',
        'https://flowmic.app/login?t=abc',
      ]) {
        expect(parseLoginLink(raw), isNull, reason: raw);
      }
    });
  });

  group('resolvePairEntryMode (owner: 扫码优先于手输)', () {
    test('scan is the default entry', () {
      final PairEntryMode m = resolvePairEntryMode(
        cameraUsable: true,
        cameraUnavailableReason: 'x',
      );
      expect(m.tab, PairTab.scan);
      expect(m.fallbackReason, isNull);
    });

    test('no camera falls back to manual AND carries the reason', () {
      // The red line: falling back is correct, falling back silently is not —
      // the user would just see a form and never learn the camera was refused.
      final PairEntryMode m = resolvePairEntryMode(
        cameraUsable: false,
        cameraUnavailableReason: '相机权限被拒绝',
      );
      expect(m.tab, PairTab.manual);
      expect(m.fallbackReason, '相机权限被拒绝');
    });
  });
}
