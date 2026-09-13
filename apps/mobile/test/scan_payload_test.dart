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

    // S1-02 — the web-client stage 1 https form of the same QR
    // (2026-09-05-web-client-protocol-and-api-addendum.md §3). Without this,
    // the camera path would show 「foreign QR」 for the new code before it ever
    // reaches PairEntry.parse (add_pairing_sheet.dart's `_onDetect` returns on
    // ScanVerdict.foreign and never calls addByCode).
    test('the new https QR is passed through VERBATIM, same as flowmic://', () {
      const String link =
          'https://flowmic.app/go/pair?endpoint=wss://relay.flowmic.app/relay&code=4831&channel=saas&pcid=930582147';
      final ScanResult r = classifyScan('  $link  ');
      expect(r.verdict, ScanVerdict.pairLink);
      expect(r.payload, link);
      expect(r.isTerminal, isTrue);
    });

    test('the https form and the flowmic:// form of the SAME query classify '
        'identically', () {
      const String query =
          'endpoint=ws://192.168.1.20:41879&code=4821&channel=standalone';
      final ScanResult legacy = classifyScan('flowmic://pair?$query');
      final ScanResult https = classifyScan('https://flowmic.app/go/pair?$query');
      expect(https.verdict, legacy.verdict);
      expect(https.isTerminal, legacy.isTerminal);
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
        // Same host family as ours, but not our host — a foreign https URL
        // must not ride in on being「close enough」 to flowmic.app.
        'https://evil.flowmic.app/pair?code=1234',
        'https://not-flowmic.app/go/pair?code=1234',
        // DOM-1 — `www.` is refused here for the same reason it is refused in
        // wire_payloads: only the apex is declared to either OS, and a parser
        // that accepted more than the OS routes would disagree with itself
        // depending on how the link arrived.
        'https://www.flowmic.app/go/pair?code=1234',
        // DOM-1 — the hostname this product planned on and then did not take
        // (owner ruling 2026-09-08). A pre-ruling desktop build prints it; the
        // scan must come back「foreign」so the user is pushed to update rather
        // than left with a second live origin.
        'https://go.flowmic.app/pair?code=1234',
        // Our host, the pre-/go/ path. Refused for the same reason.
        'https://flowmic.app/pair?code=1234',
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

  // The prefix is no longer typed in lib/: `kPairLinkPrefixHttps` IS
  // `FlowMicPairLink.httpsPrefix`, generated from PAIR_HTTPS_HOST +
  // PAIR_HTTPS_PATH (packages/protocol/src/constants.ts) by
  // apps/mobile/tool/gen_protocol.mjs, which `make gen` runs before every
  // analyze/test/build.
  //
  // 🔴 THE LITERAL BELOW IS DELIBERATE AND MUST STAY HAND-WRITTEN. Generation
  // removes the possibility of the two sides disagreeing; it also removes the
  // possibility of NOTICING when the value moves, because everything that reads
  // it moves with it. This test is the one place that does not: change the path
  // in constants.ts, re-run the generator, and this fails — which is the whole
  // reverse control for the seam. A test that read the generated constant on
  // both sides would assert `x == x` and pass through any change at all.
  group('the generated https prefix', () {
    test('is the link this product actually prints and declares', () {
      // Same string as: the desktop QR builder's output
      // (apps/desktop/src/lib/pairing.ts `buildHttpsQrPayload`), the Android
      // intent-filter and the iOS `applinks:` entitlement (both pinned to the
      // protocol constants by verify/lint/applink-declarations.mjs).
      expect(kPairLinkPrefixHttps, 'https://flowmic.app/go/pair');
    });

    test('is what classifyScan accepts, so the two cannot drift apart', () {
      expect(
        classifyScan('$kPairLinkPrefixHttps?code=1234&v=1').verdict,
        ScanVerdict.pairLink,
      );
    });
  });
}
