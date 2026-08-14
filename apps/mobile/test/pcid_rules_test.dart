// 0.2.66 PCID — the pure rules and the wire shape.
//
// SSOT: docs/strategy/2026-08-14-0266-cloud-pcid-pairing-design.md §4 (form),
// §7-1 (visibility), §7-3 (payload). The widget half — that the sheet actually
// USES these, and that a server refusal overrules the guess — is
// `pcid_field_wiring_test.dart`, and it has to be a separate test: every
// assertion in THIS file stays green if the production wiring is deleted, which
// is precisely the failure this repo requires both halves for.

import 'package:flowmic/src/session/pcid.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('readPcid — "did they fill it in right" and "what goes on the wire" are one answer', () {
    test('nine bare digits are the PCID, verbatim', () {
      expect(readPcid('123456789'), '123456789');
    });

    test('the display grouping we teach is accepted back, and stripped', () {
      // The hint prints `123 456 789`. Refusing the user for typing what we
      // showed them would be our formatting charged to them.
      expect(readPcid('123 456 789'), '123456789');
      expect(readPcid('  123456789  '), '123456789');
    });

    test('fullwidth digits from a Chinese IME fold to ASCII', () {
      // Same substitution class as WP-R4-2 ⑥ (the address field's original
      // real-device finding): identical glyphs, different codepoints.
      expect(readPcid('１２３４５６７８９'), '123456789');
    });

    test('eight or ten digits are NOT a PCID', () {
      expect(readPcid('12345678'), isNull);
      expect(readPcid('1234567890'), isNull);
    });

    test('empty / blank is not a PCID', () {
      expect(readPcid(''), isNull);
      expect(readPcid('   '), isNull);
    });

    test('letters do not pad the length', () {
      // '12345678a' has nine characters and eight digits. A length check on the
      // RAW string would have called this a PCID and sent eight digits.
      expect(readPcid('12345678a'), isNull);
    });
  });

  group('addressIsCloudRelay — the GUESS that decides what to draw', () {
    const String relay = 'https://flowmic.app';

    test('the relay host, however the user spells the scheme', () {
      expect(addressIsCloudRelay('flowmic.app', relay), isTrue);
      expect(addressIsCloudRelay('http://flowmic.app', relay), isTrue);
      expect(addressIsCloudRelay('https://flowmic.app', relay), isTrue);
      expect(addressIsCloudRelay('wss://flowmic.app', relay), isTrue);
      expect(addressIsCloudRelay('FlowMic.App', relay), isTrue);
    });

    test('port is not compared — the guess errs toward SHOWING the field', () {
      expect(addressIsCloudRelay('flowmic.app:8443', relay), isTrue);
    });

    test('a LAN address is not the relay (owner: 「局域网……没有 PCID」)', () {
      expect(addressIsCloudRelay('192.168.1.5:41879', relay), isFalse);
      expect(addressIsCloudRelay('ws://192.168.1.5:41879', relay), isFalse);
      expect(addressIsCloudRelay('flowmic-pc.local:41879', relay), isFalse);
    });

    test('nothing typed yet ⇒ no field', () {
      expect(addressIsCloudRelay('', relay), isFalse);
      expect(addressIsCloudRelay('   ', relay), isFalse);
    });

    test('a self-hosted relay is recognised when it IS the configured one', () {
      // `saasEndpoint` is a --dart-define seam (auth/saas_endpoint.dart), so a
      // private build pointed elsewhere gets the field on its own host.
      expect(
        addressIsCloudRelay('relay.example.internal', 'https://relay.example.internal'),
        isTrue,
      );
    });

    test(
      '🔴 THE GUESS IS WRONG HERE, AND THAT IS THE POINT — a relay typed as a '
      'bare IP answers false; only the server can correct it',
      () {
        // Recorded as a KNOWN gap, not a defect: the remedy is
        // `isPcidRequiredRefusal` + the sheet's force-show, which
        // `pcid_field_wiring_test.dart` proves. If this ever starts returning
        // true by some cleverness, that test is the one that still matters.
        expect(addressIsCloudRelay('203.0.113.9', 'https://flowmic.app'), isFalse);
      },
    );
  });

  group('isPcidRequiredRefusal — the server overruling the guess', () {
    test('the registered code, exactly', () {
      expect(isPcidRequiredRefusal(kPairPcidRequired), isTrue);
      expect(kPairPcidRequired, 'PAIR_PCID_REQUIRED');
    });

    test('and nothing else — including its sibling', () {
      // 🔴 The sibling must NOT force the field: `PAIR_PCID_UNKNOWN` means a
      // PCID was supplied, so the field is already on screen. Treating the two
      // as one would be a code answering two questions.
      expect(isPcidRequiredRefusal(kPairPcidUnknown), isFalse);
      expect(isPcidRequiredRefusal('PAIR_INVALID_CODE'), isFalse);
      expect(isPcidRequiredRefusal('PAIR_TIMEOUT: whatever'), isFalse);
      expect(isPcidRequiredRefusal(null), isFalse);
      expect(isPcidRequiredRefusal(''), isFalse);
    });
  });

  group('MobilePairPayload — additive, and absent means absent', () {
    test('the short-code arm carries the pcid when there is one', () {
      final Map<String, Object?> json =
          const MobilePairPayload.shortCode('1234', pcid: '123456789').toJson();
      expect(json['short_code'], '1234');
      expect(json['pcid'], '123456789');
    });

    test('no pcid ⇒ the KEY IS ABSENT, not present-and-null', () {
      // A null would make the relay's zod choose between tolerating it and
      // refusing the frame; absent is what "LAN unchanged" actually means on the
      // wire. Same shape as mobile_name/device_uid.
      final Map<String, Object?> json =
          const MobilePairPayload.shortCode('1234').toJson();
      expect(json.containsKey('pcid'), isFalse);
      expect(json, <String, Object?>{'short_code': '1234'});
    });

    test('an empty pcid is omitted too', () {
      final Map<String, Object?> json =
          const MobilePairPayload.shortCode('1234', pcid: '').toJson();
      expect(json.containsKey('pcid'), isFalse);
    });

    test('pcid rides alongside mobile_name/device_uid without disturbing them', () {
      final Map<String, Object?> json =
          const MobilePairPayload.shortCode('1234', pcid: '123456789')
              .toJson(mobileName: 'Pixel-ab12', deviceUid: 'uid-1');
      expect(json, <String, Object?>{
        'short_code': '1234',
        'pcid': '123456789',
        'mobile_name': 'Pixel-ab12',
        'device_uid': 'uid-1',
      });
    });

    test('the QR arm is untouched — the link already carries its own pcid=', () {
      const String link =
          'flowmic://pair?endpoint=ws://192.168.1.5:41879&code=1234&pcid=123456789';
      final Map<String, Object?> json =
          const MobilePairPayload.qrPayload(link).toJson();
      expect(json, <String, Object?>{'qr_payload': link});
      expect(json.containsKey('pcid'), isFalse,
          reason: 'a second copy beside the link is a second author');
    });

    test('the cloud-instance arm is untouched (it addresses no PC)', () {
      expect(
        const MobilePairPayload.cloudInstance().toJson(),
        <String, Object?>{'cloud_instance': true},
      );
    });
  });

  group('PairEntry.parse threads the pcid onto the short-code arm only', () {
    test('a bare 4-digit code + pcid', () {
      final PairEntry e = PairEntry.parse('1234', pcid: '987654321');
      expect(e.payload.shortCode, '1234');
      expect(e.payload.pcid, '987654321');
      expect(e.payload.toJson()['pcid'], '987654321');
    });

    test('no pcid supplied ⇒ byte-for-byte the 0.2.65 frame', () {
      expect(PairEntry.parse('1234').payload.toJson(),
          <String, Object?>{'short_code': '1234'});
    });

    test('a pcid handed alongside a LINK is dropped, not duplicated', () {
      const String link =
          'flowmic://pair?endpoint=ws://192.168.1.5:41879&code=1234&pcid=111222333';
      final PairEntry e = PairEntry.parse(link, pcid: '999888777');
      expect(e.payload.qrPayload, link);
      expect(e.payload.pcid, isNull);
      expect(e.payload.toJson().containsKey('pcid'), isFalse);
    });
  });
}
