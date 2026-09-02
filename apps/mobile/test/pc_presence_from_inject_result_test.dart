// Card B3 (2026-09-02, WP-6) — `INJECT_PC_OFFLINE` is authored from "no PC in
// THIS node's room", never from PC presence. On a multi-node deployment a
// perfectly reachable PC living on a different node produces the identical
// refusal, and this file's job is to prove the phone no longer paints it
// offline for that reason — the same `presenceAnswerIsAboutAnotherNode`
// safety direction the idle poll already uses (presence_route_test.dart),
// applied to the OTHER path that can set `PcPresence.offline`.
//
// SPEC-REF: apps/mobile/lib/src/session/pc_presence.dart
//   `pcPresenceFromInjectResult`; apps/server-core/src/socket/handlers/
//   relay.handler.ts `answerReject('INJECT_PC_OFFLINE', …)`;
//   docs/strategy/2026-09-02-full-implementation-audit-and-next-plan.md §3-B B3.

import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('pcPresenceFromInjectResult — the base cases are unchanged', () {
    test('ok:true is always online, regardless of node/homeNode', () {
      expect(pcPresenceFromInjectResult(ok: true), PcPresence.online);
      expect(
        pcPresenceFromInjectResult(ok: true, node: 'srvjp', homeNode: 'srvny'),
        PcPresence.online,
      );
    });

    test('no error ⇒ no testimony', () {
      expect(pcPresenceFromInjectResult(ok: false), null);
    });

    test('a non-absence refusal (e.g. frame too large) gives no testimony',
        () {
      expect(
        pcPresenceFromInjectResult(ok: false, error: 'INJECT_FRAME_TOO_LARGE'),
        null,
      );
    });

    test(
        'INJECT_PC_OFFLINE with NEITHER node nor homeNode still means offline (single-node / old relay)',
        () {
      expect(
        pcPresenceFromInjectResult(ok: false, error: 'INJECT_PC_OFFLINE'),
        PcPresence.offline,
      );
    });
  });

  group('🔴 B3 — a wrong-node INJECT_PC_OFFLINE gives NO testimony', () {
    test('node != homeNode ⇒ null, never offline', () {
      expect(
        pcPresenceFromInjectResult(
          ok: false,
          error: 'INJECT_PC_OFFLINE',
          node: 'srvjp',
          homeNode: 'srvny',
        ),
        null,
      );
    });

    test('node == homeNode ⇒ genuinely offline', () {
      expect(
        pcPresenceFromInjectResult(
          ok: false,
          error: 'INJECT_PC_OFFLINE',
          node: 'srvny',
          homeNode: 'srvny',
        ),
        PcPresence.offline,
      );
    });

    test('only node known (no home_node on the frame) ⇒ cannot compare, still offline', () {
      // Absence of EITHER half must not be read as agreement — a stale/never-
      // set homeNode must not silently license every future offline reading,
      // but it must also not manufacture doubt this repo cannot back. The
      // pre-B3 behaviour (offline) is the honest fallback when only one side
      // of the comparison is known.
      expect(
        pcPresenceFromInjectResult(
          ok: false,
          error: 'INJECT_PC_OFFLINE',
          node: 'srvjp',
        ),
        PcPresence.offline,
      );
    });

    test('only homeNode known (no node on the frame) ⇒ still offline', () {
      expect(
        pcPresenceFromInjectResult(
          ok: false,
          error: 'INJECT_PC_OFFLINE',
          homeNode: 'srvny',
        ),
        PcPresence.offline,
      );
    });

    test('empty-string node/homeNode are treated as unknown, not as a match',
        () {
      expect(
        pcPresenceFromInjectResult(
          ok: false,
          error: 'INJECT_PC_OFFLINE',
          node: '',
          homeNode: '',
        ),
        PcPresence.offline,
      );
    });
  });
}
