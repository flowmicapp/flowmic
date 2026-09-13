// Card MP-3, the phone's half — **parse `payer`, change nothing**.
//
// 🔴 WHY A TEST FOR A FIELD NOTHING READS. The desktop half of MP-3 ships a
// sentence; this half ships one nullable field and no behaviour, and a field
// with no behaviour is exactly the thing that silently grows one. The two
// assertions worth having are therefore:
//   ① the word is carried when the relay says it, and becomes `null` — never
//      `'self'` — in every way of not being told;
//   ② the meter is byte-for-byte the same whatever the word says. A phone's own
//      frame cannot honestly say `far_end` until card MP-1 exists (the phone IS
//      the speaker, and the speaker pays — owner 2026-09-11 「谁说扣谁」), so any
//      difference this field makes on this screen today is a difference nobody
//      is entitled to make.
//
// ⚠️ ② is the one that will be doing work later. When MP-1 lands and a phone
// speaking into a third party's page really does receive `far_end`, whoever
// wires the phone's sentence has to change this file on purpose — which is the
// difference between adding a branch and discovering one.
//
// -- CARD G-2c (2026-09-11): (2) WAS CALLED IN, EXACTLY AS ITS OWN WARNING SAID
//    IT WOULD BE. READ THIS BEFORE TRUSTING ANYTHING ABOVE. -------------------
//
// owner's re-ruling the same day replaced 「谁说扣谁」 with 「只要有对端，就扣对端」
// — whenever a far end exists it pays, signed in or not — so `'far_end'` now
// reaches an ORDINARY paired handset as a matter of course, not as an MP-1 edge
// case. The premise under (2) ("no producer can send this phone that word") is
// gone, and the conclusion with it: a frame about somebody else's ledger folded
// into this account's meter is a plausible number about the wrong ledger, which
// is the defect R11 is named after.
//
// 🔴 THE HEADER ABOVE IS KEPT VERBATIM RATHER THAN REWRITTEN. It was true when
// it was written, and it is the evidence for the part worth carrying forward: a
// negative assertion outlives the fact it was derived from, and goes on
// asserting it after that fact stops being true (0.2.52's law — a reverse
// control pointed the wrong way does not miss a defect, it writes the defect
// down as the acceptance criterion). What saved it here is that (2) named, in
// advance, who would have to change it and when.
//
// WHAT IS ASSERTED NOW: (1) is untouched. (2) becomes 「the word decides WHETHER
// the reading is ours to apply, and nothing else」 — `'self'` and every way of
// not being told still move the meter byte for byte, `'far_end'` and `'trial'`
// do not move it at all. The SENTENCE that replaces the missing movement is not
// this file's subject; it is asserted on the screen it appears on, in
// `far_end_payer_faces_test.dart`.

import 'package:flowmic/src/auth/cloud_summary.dart';
import 'package:flowmic/src/auth/cloud_summary_controller.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/signaling/inbound_payloads.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/cloud_summary_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart';

Map<String, Object?> _frame({Object? payer = _absent}) => <String, Object?>{
  'remaining_ms': 600000,
  'mode': 'plan',
  'resets_at': 1780000000000,
  'reason': 'heartbeat',
  if (!identical(payer, _absent)) 'payer': payer,
};

const Object _absent = Object();

Future<CloudSummaryController> _controller() async {
  final LoginController login = newTestLogin(
    transport: FakeSocketTransport(),
    accountStore: InMemoryAccountStore(
      const CloudAccount(jwt: 'jwt-mp3', email: 'a@example.com', plan: 'pro'),
    ),
  );
  await login.hydrate();
  final CloudSummaryController c = newTestCloudSummary(
    login: login,
    fetcher: fixedCloudSummary(testSummary(usedMin: 12, limitMin: 900)),
  );
  c.refresh();
  // The fetcher is a synchronous future; one microtask turn is enough for the
  // summary to land. Asserted rather than assumed — with no summary on screen
  // `applyBudget` returns early, and every assertion below would pass for the
  // wrong reason.
  await Future<void>.delayed(Duration.zero);
  expect(c.summary, isNotNull, reason: 'the fixture must land, or this file proves nothing');
  return c;
}

void main() {
  group('MP-3 · the phone carries the payer word', () {
    test('the three contract values survive the parse', () {
      for (final String p in BillingBudget.payers) {
        expect(BillingBudget.tryFromJson(_frame(payer: p))?.payer, p);
      }
    });

    // 🔴 Every way of not being told is `null`, and `null` never means 'self'.
    // A build that read absence as 「you are paying」 would answer a question it
    // was never asked, on behalf of a relay that did not speak.
    test('absent, unknown and malformed all read as null', () {
      expect(BillingBudget.tryFromJson(_frame())?.payer, isNull);
      expect(BillingBudget.tryFromJson(_frame(payer: 'integrator_key'))?.payer, isNull);
      expect(BillingBudget.tryFromJson(_frame(payer: ''))?.payer, isNull);
      expect(BillingBudget.tryFromJson(_frame(payer: 7))?.payer, isNull);
      expect(BillingBudget.tryFromJson(_frame(payer: null))?.payer, isNull);
    });

    // 🔴 THE OPPOSITE RULE FROM `mode`, on purpose. A missing `mode` drops the
    // whole frame (an invented provenance is a lie about the number); a payer
    // word this build does not know costs only a sentence nothing renders yet,
    // so the reading is kept. Positive control included: the numbers really are
    // still there, so this is 「kept」 rather than 「the probe looked elsewhere」.
    test('an unrecognised payer does not cost us the reading', () {
      final BillingBudget? b = BillingBudget.tryFromJson(_frame(payer: 'landlord'));
      expect(b, isNotNull);
      expect(b!.remainingMs, 600000);
      expect(b.mode, 'plan');
      expect(b.payer, isNull);
      // and the contrast: a missing `mode` still drops the frame whole.
      expect(BillingBudget.tryFromJson(<String, Object?>{'remaining_ms': 1}), isNull);
    });
  });

  group('G-2c · the word decides whether the reading is OURS to apply', () {
    /// Apply one frame to a freshly loaded card and report what the minutes
    /// meter says afterwards. 12 of 900 used before the frame; 600 000 ms left
    /// of 900 ⇒ 890 used if the frame was applied.
    Future<double> after(Object? payer) async {
      final CloudSummaryController c = await _controller();
      final BillingBudget? b = BillingBudget.tryFromJson(_frame(payer: payer));
      expect(b, isNotNull);
      c.applyBudget(b!);
      final CloudMeter? m = c.summary?.minutes;
      expect(m, isNotNull);
      c.dispose();
      return m!.used;
    }

    // The pre-card behaviour, unchanged and asserted FIRST: a build that
    // refused every frame would satisfy the case below and would be the
    // opposite defect — refusing to answer a question we can answer.
    test("'self', absence and an unknown word all still move it", () async {
      expect(await after('self'), closeTo(890, 0.001));
      expect(await after(_absent), closeTo(890, 0.001),
          reason: 'a relay that never learned the word must keep the behaviour '
              'it had');
      expect(await after('landlord'), closeTo(890, 0.001),
          reason: 'an unrecognised word parses to null, and null is "not told"');
    });

    // The card. That number is the FAR END's remainder; applying it here draws
    // one account's minutes draining on another account's card.
    test("'far_end' and 'trial' do not move it at all", () async {
      expect(await after('far_end'), 12);
      expect(await after('trial'), 12,
          reason: 'a demo grant is two minutes; against a 900-minute ceiling '
              'the arithmetic reports this account hundreds of minutes over');
    });

    test('a refused frame never repaints the card either', () async {
      final CloudSummaryController c = await _controller();
      c.applyBudget(BillingBudget.tryFromJson(_frame(payer: 'self'))!);
      int paints = 0;
      void count() => paints += 1;
      c.addListener(count);
      // The same numbers again, then a word that refuses them. Neither is a
      // change this card can show, so neither may cost a repaint.
      c.applyBudget(BillingBudget.tryFromJson(_frame(payer: 'self'))!);
      c.applyBudget(BillingBudget.tryFromJson(_frame(payer: 'far_end'))!);
      expect(paints, 0);
      c.removeListener(count);
      c.dispose();
    });
  });
}
