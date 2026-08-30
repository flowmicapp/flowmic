// Phone-follows-PC — is it WIRED, and is the wiring inert on a single-node
// deployment?
//
// SPEC-REF:
//   apps/mobile/lib/src/ptt/ptt_reconnect_ack.dart (_followNodeIfMisplaced)
//   apps/mobile/lib/src/signaling/node_list_client.dart (planNodeHop)
//
// 🔴 WHY THIS FILE EXISTS SEPARATELY FROM THE PLANNER'S TESTS. This repo's rule
// is that a green unit suite proves nothing about WIRING — `planNodeHop` can be
// perfect and called by nobody, which is the defect class the anti-façade rule
// names. `node_follow_test.dart` and `node_hop_plan_test.dart` prove the
// decision; this proves somebody asks for it, and that asking costs nothing on
// every installation that exists today.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('🔴 the production caller exists — planNodeHop is not orphaned', () {
    // A grep, deliberately, and not a mock: the question is whether PRODUCTION
    // code reaches it, and only production source can answer that.
    final File site = File('lib/src/ptt/ptt_reconnect_ack.dart');
    expect(site.existsSync(), isTrue,
        reason: 'positive control: run from apps/mobile or this is blind');
    final String src = site.readAsStringSync();

    expect(src.contains('planNodeHop('), isTrue,
        reason: 'the reconnect ack is the ONE moment the phone holds both node '
            'facts from a single instant. If this call has gone, the decision '
            'layer is dead code and the phone will sit on the wrong node '
            'reporting its PC offline, silently.');
    expect(src.contains('_followNodeIfMisplaced(s, token, ack)'), isTrue,
        reason: 'and it must be reached from onAccepted, not from a timer or a '
            'poll — re-deriving the two facts later re-opens the race the '
            'two-field design closed');
  });

  test('🔴 it hops on the ACK, never on a schedule', () {
    // Stated as a negative because the tempting refactor is a periodic
    // "am I on the right node?" check, and that would compare two answers
    // taken at two different instants with a reconnect possible in between —
    // exactly what carrying BOTH fields on one ack was designed to prevent.
    final String src =
        File('lib/src/ptt/ptt_reconnect_ack.dart').readAsStringSync();
    final int at = src.indexOf('_followNodeIfMisplaced(s, token, ack)');
    expect(at, greaterThan(0));
    // The call sits inside the onAccepted closure, which is the only place
    // `ack` is in scope at all — so the type system already forbids a timer
    // calling it with a stale ack. What a Timer WOULD need is a stored copy,
    // and there is none: assert no Timer in this file reaches it.
    expect(src.contains('Timer(') && src.contains('_followNodeIfMisplaced'),
        isFalse,
        reason: 'a scheduled node check would need to re-derive both facts, '
            'and they would come from two different instants');
  });

  test('the hop is fire-and-forget, so the ack never waits on the network', () {
    // Everything else in onAccepted is this ack's own business. Awaiting a node
    // list there would put an HTTP round trip in front of the room rejoin on
    // every reconnect.
    final String src =
        File('lib/src/ptt/ptt_reconnect_ack.dart').readAsStringSync();
    expect(src.contains('unawaited(_followNodeIfMisplaced('), isTrue);
  });

  test('🔴 it drops the socket with disconnect(), never `superseded`', () {
    // `superseded` publishes `connecting`, on which the reconnect ladder
    // deliberately schedules NOTHING (F-5, the capsule-flicker fix). Using it
    // here would tear the socket down and then never dial anywhere — the phone
    // would simply stop, which is worse than the wrong node.
    final String src =
        File('lib/src/ptt/ptt_reconnect_ack.dart').readAsStringSync();
    final int hop = src.indexOf('_followNodeIfMisplaced(\n');
    expect(hop, greaterThan(0), reason: 'positive control: found the function');
    final String body = src.substring(hop);
    expect(body.contains('transport.disconnect()'), isTrue);
    // 🔴 Asserted on the NAMED-ARGUMENT form, not on the word. The first
    // version of this test looked for 'superseded' anywhere in the body and
    // went red on the comment explaining why not to use it — a ruler measuring
    // the explanation instead of the code. The colon form is the only shape
    // that could actually change the verb.
    expect(body.contains('superseded:'), isFalse,
        reason: 'the ladder schedules nothing on `connecting`, so a superseded '
            'teardown would drop the socket and never dial anywhere');
  });

  test('🔴 it persists BEFORE it dials', () {
    // A cold start must go straight to the right node, and the persisted
    // endpoint is the whole of "remember the last known node per instance".
    // If the order inverted, a hop that was interrupted by the app being
    // killed would be forgotten and repeat on every launch.
    final String src =
        File('lib/src/ptt/ptt_reconnect_ack.dart').readAsStringSync();
    final int persist = src.indexOf('persistDialedEndpoint(');
    final int dial = src.indexOf('transport.disconnect()');
    expect(persist, greaterThan(0));
    expect(dial, greaterThan(persist),
        reason: 'persist first, then drop the socket');
  });

  // ── 2026-08-30, added after a cross-check found the other half missing ─────
  //
  // 🔴 EVERY TEST ABOVE WAS GREEN WHILE THE FEATURE WAS HALF-WIRED. They assert
  // that the RECONNECT leg calls the follow, and it does — and the PAIR leg did
  // not, for as long as this file has existed. So "phone-follows-PC is wired"
  // read as true while a first-time cloud pairing to a PC on a replica put the
  // phone in a room its PC would never join. ONE wired caller was mistaken for
  // a wired feature, by a file written specifically to check wiring.
  test('🔴 the PAIR leg follows too — a first pairing is an admission as much '
      'as a reconnect is', () {
    final File site = File('lib/src/ptt/ptt_pair.dart');
    expect(site.existsSync(), isTrue,
        reason: 'positive control: run from apps/mobile or this is blind');
    final String src = site.readAsStringSync();

    expect(src.contains('_followNodeIfMisplaced(this, token, ack)'), isTrue,
        reason: 'mobile:pair is writer-only, so a phone always pairs on the '
            'WRITER while its PC may have settled on a replica. Nothing '
            'reconnects after a successful pair — connections_controller goes '
            'straight to _rememberActive, onPaired, load() — so without this '
            'the phone sits in the writer\'s room until an unrelated socket '
            'drop happens to trigger the reconnect leg. And the audio leg fails '
            'SILENTLY there: mirrorToPc is `if (pc) send(pc)`, so the frame is '
            'dropped with no error, no refusal and no log.');
  });

  test('REVERSE CONTROL — the reconnect leg still has its own call', () {
    // Without this, deleting the reconnect caller and keeping only the pair one
    // would satisfy the assertion above. Two admissions, two callers, and
    // neither is redundant: a phone can reconnect for months without ever
    // re-pairing, and a PC can move nodes in between.
    final String src =
        File('lib/src/ptt/ptt_reconnect_ack.dart').readAsStringSync();
    expect(src.contains('_followNodeIfMisplaced(s, token, ack)'), isTrue);
  });
}
