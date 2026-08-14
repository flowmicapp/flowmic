// v0.2.6 — 「云端轻记录」 must never bleed into a real PC session.
//
// owner 2026-07-29:「云端中继和云端轻记录这两个实例是不一样的。仅记录这个云端的，
// 相当于是个单向的……云端中继的话，它是链接到 PC，说的话是能够注入到 PC 这一端的
// 相应的焦点上去的。转录的界面顶上其实是没有显示这个 PC 的实例名称的，然后我语音
// 发出去之后它体现的状态是仅记录……又串了起来」.
//
// Both symptoms, one root cause: `DestinationController.isFixed` was answering
// TWO questions.
//
//   · "can the destination toggle be tapped" — which it genuinely is; and
//   · "is the peer a virtual cloud instance" — which it is not. That is a property of the
//     PAIRING, and the lock merely follows from it.
//
// The lock outlives the session that set it. Enter 「云端轻记录」 once, then pair a
// real PC by code — `_add` was the one entry path that never re-scoped the
// destination — and the lock is still on: the chat header prints 「云端轻记录」 in
// place of the PC's name, and every utterance is delivered as `Delivery.none`
// to a PC that was perfectly able to receive it. Silent non-delivery, which is
// the exact shape 「没有静默失败」 forbids.
//
// The fix moves the scoping to the ONE funnel every entry path goes through and
// keys it on the pairing. These tests pin the rule at the level where it can be
// asserted without a device.

import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery;
import 'package:flutter_test/flutter_test.dart';

MobileSession _pairing({required String channel, String endpoint = 'http://192.168.1.5:41879'}) =>
    MobileSession(
      token: 'tok-$channel-000000000000000000000',
      endpoint: endpoint,
      channel: channel,
      pcName: 'Studio PC',
      pairingId: 'pair-$channel',
    );

/// The rule `_enterChat` applies, as a pure expression of the same question.
bool fixedFor(MobileSession? active) => active?.channel == 'saas';

void main() {
  group('the destination is scoped by the PAIRING, not by the last session', () {
    test('a real PC reached over the CLOUD RELAY still injects', () {
      // The owner's case. `channel` is 'standalone' — it was paired by code
      // against a real PC — and the endpoint being the relay is a TRANSPORT
      // fact that must not change the destination. (Conflating those two is the
      // v0.2.3 channel-chip bug; this is the same pair of questions one layer
      // down, which is why it deserves its own assertion.)
      final MobileSession relayPc = _pairing(channel: 'standalone', endpoint: 'https://flowmic.app');
      final DestinationController d = DestinationController();
      d.configureFixed(fixedRecordOnly: fixedFor(relayPc));

      expect(d.isFixed, isFalse, reason: 'the toggle must be usable');
      expect(d.isRecordOnly, isFalse);
      expect(d.delivery, Delivery.inject, reason: 'words must reach the PC');
    });

    test('the 「云端轻记录」 instance stays pinned record-only', () {
      final DestinationController d = DestinationController();
      d.configureFixed(fixedRecordOnly: fixedFor(_pairing(channel: 'saas')));
      expect(d.isFixed, isTrue);
      expect(d.delivery, Delivery.none);
      // …and the lock really is inert, not merely a default.
      d.toggle();
      expect(d.delivery, Delivery.none, reason: 'a cloud instance has no PC to inject into');
    });

    test('THE BLEED: 「云端轻记录」 → then a PC, and the PC injects', () {
      // The regression, in the order it actually happened. Before the fix the
      // second scoping never ran (the add-by-code path did not call it), so the
      // controller was still pinned and the PC silently received nothing.
      final DestinationController d = DestinationController();
      d.configureFixed(fixedRecordOnly: fixedFor(_pairing(channel: 'saas')));
      expect(d.delivery, Delivery.none);

      d.configureFixed(fixedRecordOnly: fixedFor(_pairing(channel: 'standalone')));
      expect(d.isFixed, isFalse);
      expect(d.delivery, Delivery.inject);
    });

    test('THE REVERSE BLEED: a PC → then 「云端轻记录」, and nothing is injected', () {
      // The mirror, and the more dangerous direction: a record-only instance
      // that inherited `inject` would try to deliver to a PC that does not
      // exist — and "record-only entries must not sync to the PC by default" is a red line.
      final DestinationController d = DestinationController();
      d.configureFixed(fixedRecordOnly: fixedFor(_pairing(channel: 'standalone')));
      d.setRecordOnly();
      d.setInject();
      expect(d.delivery, Delivery.inject);

      d.configureFixed(fixedRecordOnly: fixedFor(_pairing(channel: 'saas')));
      expect(d.delivery, Delivery.none);
      expect(d.isFixed, isTrue);
    });

    test('a mid-session record-only choice does NOT survive re-entry', () {
      // master-plan §4.0 B: session stickiness only. A sticky record-only across
      // sessions is a silent "your words never reached the PC" trap — the same failure this whole
      // file is about, arriving from the user's own toggle instead of a leak.
      final DestinationController d = DestinationController();
      d.configureFixed(fixedRecordOnly: fixedFor(_pairing(channel: 'standalone')));
      d.setRecordOnly();
      expect(d.delivery, Delivery.none);

      d.configureFixed(fixedRecordOnly: fixedFor(_pairing(channel: 'standalone')));
      expect(d.delivery, Delivery.inject, reason: 're-entry returns to the default');
    });

    test('no active pairing defaults to INJECT, not to record-only', () {
      // Guessing wrong in this direction merely shows a toggle that should have
      // been locked; guessing the other way silently drops the user's words.
      final DestinationController d = DestinationController();
      d.configureFixed(fixedRecordOnly: fixedFor(null));
      expect(d.delivery, Delivery.inject);
    });
  });

  group('the two questions have two sources', () {
    test('"who is on the other side" is the pairing channel, not the destination lock', () {
      // The header used to read `isFixed` for the NAME. These are the two rows
      // that made that indistinguishable — same lock state, different peers.
      expect(fixedFor(_pairing(channel: 'saas')), isTrue);
      expect(fixedFor(_pairing(channel: 'standalone', endpoint: 'https://flowmic.app')), isFalse);
    });
  });
}
