// Card F2 / ruling ④ — session state and history for the same computer are merged by machine.
//
// SPEC-REF:
//   docs/decisions/2026-08-04-owner-ten-rulings-0.3.0.md ruling ④
//   docs/strategy/2026-08-04-f2-machine-merge-design.md §2.2 §2.5
//   docs/strategy/2026-08-05-f2-machine-merge-delivery-cn.md §4 (verbatim red output)
//
// 🔴 The two primary-control tests below were written BEFORE the change and were seen RED
// against the pre-F2 read surfaces (`TimelineStore.entriesForInstance` /
// `OutboxPendingView.countFor(instanceId)`); the verbatim output is pasted in
// the delivery report §4.1. Everything after them is a REVERSE control: each one
// states something the merge must NOT do, and the merge is only worth having if
// they all stay green.

import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/session/instance_machine_map.dart';
import 'package:flowmic/src/session/machine_key.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_pending_view.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/di.dart';

class _FakeOwner implements InstanceOwnerProbe {
  _FakeOwner(this.instanceId, this.instanceName);
  @override
  String? instanceId;
  @override
  String? instanceName;
}

/// The LAN pairing to computer A.
const MobileSession kLan = MobileSession(
  token: 'tok-lan-0000000000000000000000000000',
  endpoint: 'ws://192.0.2.5:55889',
  channel: 'standalone',
  pcInstanceId: 'inst-lan',
  pcMachineUid: 'machine-AAAA',
  pcId: 'pc-lan',
  pcName: 'DESKTOP-A',
);

/// The relay pairing to the SAME computer A — same `pc_machine_uid`, different
/// instance id, different `pc_id`.
///
/// 🔴 `channel` is `'standalone'`, NOT `'relay'` and NOT `'saas'`. Measured in
/// `ptt_session.dart:526`: the ONLY producer of `'saas'` is
/// `entry.payload.cloudInstance`, i.e. the fixed cloud-instance solo entry
/// (`wire_payloads.dart:559`「no code, no PC peer」). A pairing to a real PC is
/// `'standalone'` on BOTH channels — the endpoint differs, the channel string
/// does not. An earlier draft of this file wrote `'relay'`, which no production
/// path ever produces: it passed for the wrong reason (anything ≠ `'saas'`
/// groups) and it made the two identities differ in their PREFIX as well as
/// their instance id, hiding the fact that in the field they differ ONLY in the
/// instance id.
const MobileSession kRelay = MobileSession(
  token: 'tok-relay-000000000000000000000000000',
  endpoint: 'wss://relay.example/ws',
  channel: 'standalone',
  pcInstanceId: 'inst-relay',
  pcMachineUid: 'machine-AAAA',
  pcId: 'pc-relay',
  pcName: 'DESKTOP-A',
);

/// A DIFFERENT computer.
const MobileSession kOther = MobileSession(
  token: 'tok-b-00000000000000000000000000000',
  endpoint: 'ws://192.0.2.9:55889',
  channel: 'standalone',
  pcInstanceId: 'inst-b',
  pcMachineUid: 'machine-BBBB',
  pcId: 'pc-b',
  pcName: 'DESKTOP-B',
);

/// The cloud instance — a virtual PC row on the server, not a machine.
const MobileSession kCloud = MobileSession(
  token: 'tok-cloud-000000000000000000000000000',
  endpoint: 'wss://saas.example/ws',
  channel: 'saas',
  pcInstanceId: 'inst-cloud',
  pcId: 'pc-cloud',
);

/// Two pre-0.2.4 pairings: neither could report a machine uid.
const MobileSession kOldOne = MobileSession(
  token: 'tok-old-1-00000000000000000000000000',
  endpoint: 'ws://192.0.2.20:55889',
  pcInstanceId: 'inst-old-1',
  pcId: 'pc-old-1',
);
const MobileSession kOldTwo = MobileSession(
  token: 'tok-old-2-00000000000000000000000000',
  endpoint: 'ws://192.0.2.21:55889',
  pcInstanceId: 'inst-old-2',
  pcId: 'pc-old-2',
);

const List<MobileSession> kAllPairings = <MobileSession>[
  kLan,
  kRelay,
  kOther,
  kCloud,
  kOldOne,
  kOldTwo,
];

Set<String> _ownersOf(MobileSession connected) => ownerIdsFor(
  machineUid: connected.pcMachineUid,
  pairingIdentity: connected.connectionIdentity,
  pairings: kAllPairings,
);

OutboxItem _queued({
  required String requestId,
  required String? machineUid,
  required String? pairingIdentity,
}) => OutboxItem(
  requestId: requestId,
  entryId: 'loc_$requestId',
  coveredEntryIds: <String>['loc_$requestId'],
  kind: OutboxPayloadKind.text,
  source: 'manual',
  text: 'hello pc',
  mode: 'realtime',
  createdAt: DateTime.utc(2026, 8, 5, 9),
  enqueuedAt: DateTime.utc(2026, 8, 5, 9, 0, 1),
  destinationMachineUid: machineUid,
  destinationPairingIdentity: pairingIdentity,
  enqueuedPcId: 'pc-lan',
);

TimelineStore _storeWith(List<(MobileSession?, String)> rows) {
  final _FakeOwner owner = _FakeOwner(null, null);
  final TimelineStore s = newTestStore(deviceId: 'phone', owner: owner);
  int i = 0;
  for (final (MobileSession? p, String text) in rows) {
    owner.instanceId = p?.connectionIdentity;
    owner.instanceName = p?.pcName;
    s.buildFromUtterance(
      clientId: 'u${i++}',
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      text: text,
    );
  }
  return s;
}

List<String> _texts(List<TimelineEntry> rows) =>
    rows.map((TimelineEntry e) => e.outputText).toList();

void main() {
  group('primary control — the two pairings to the same computer are one screen', () {
    test('a row written over LAN is visible on the session surface when read as the relay identity', () {
      final TimelineStore s = _storeWith(<(MobileSession?, String)>[
        (kLan, 'said over LAN'),
        (kRelay, 'said over relay'),
      ]);

      expect(
        _texts(s.entriesForOwners(_ownersOf(kRelay))),
        containsAll(<String>['said over LAN', 'said over relay']),
      );
      // …and symmetrically, because it is ONE surface and not a redirect.
      expect(
        _texts(s.entriesForOwners(_ownersOf(kLan))),
        containsAll(<String>['said over LAN', 'said over relay']),
      );
    });

    test('an item enqueued on LAN is still counted by the banner after switching to the same-machine relay pairing', () {
      final OutboxPendingView v = OutboxPendingView.of(<OutboxItem>[
        _queued(
          requestId: 'r1',
          machineUid: 'machine-AAAA',
          pairingIdentity: kLan.connectionIdentity,
        ),
      ]);

      expect(
        v.countFor(
          machineUid: kRelay.pcMachineUid,
          pairingIdentity: kRelay.connectionIdentity,
        ),
        1,
      );
    });
  });

  group('reverse control — things the merge must not do', () {
    test('two computers with different uids never see each other', () {
      final TimelineStore s = _storeWith(<(MobileSession?, String)>[
        (kLan, 'to A over LAN'),
        (kRelay, 'to A over relay'),
        (kOther, 'to B'),
      ]);

      expect(_texts(s.entriesForOwners(_ownersOf(kOther))), <String>['to B']);
      expect(
        _texts(s.entriesForOwners(_ownersOf(kLan))),
        isNot(contains('to B')),
      );
      expect(_ownersOf(kOther), <String>{kOther.connectionIdentity});
    });

    test('two 「could not ask for a uid」 are never the same computer', () {
      // 「could not ask」≠「is」. Two pre-0.2.4 pairings both report a null uid; treating
      // that as a match is the crosstalk `resolveOutboxTarget` refuses by the
      // same argument (machine_group.dart rule ①).
      final TimelineStore s = _storeWith(<(MobileSession?, String)>[
        (kOldOne, 'to old one'),
        (kOldTwo, 'to old two'),
      ]);

      expect(_ownersOf(kOldOne), <String>{kOldOne.connectionIdentity});
      expect(
        _texts(s.entriesForOwners(_ownersOf(kOldOne))),
        <String>['to old one'],
      );
      expect(
        scopeKeyFor(
          machineUid: kOldOne.pcMachineUid,
          pairingIdentity: kOldOne.connectionIdentity,
        ),
        isNot(
          scopeKeyFor(
            machineUid: kOldTwo.pcMachineUid,
            pairingIdentity: kOldTwo.connectionIdentity,
          ),
        ),
      );
    });

    test('cloud light records (channel==saas) never enter the machine view', () {
      final TimelineStore s = _storeWith(<(MobileSession?, String)>[
        (kLan, 'to A over LAN'),
        (kCloud, 'to the cloud'),
      ]);

      expect(
        _texts(s.entriesForOwners(_ownersOf(kLan))),
        isNot(contains('to the cloud')),
      );
      expect(_ownersOf(kLan), isNot(contains(kCloud.connectionIdentity)));
      // …even if a uid somehow arrived on the cloud row: it is not a machine.
      expect(
        ownerIdsFor(
          machineUid: 'machine-AAAA',
          pairingIdentity: kCloud.connectionIdentity,
          pairings: kAllPairings,
        ),
        <String>{kCloud.connectionIdentity},
      );
    });

    test('a row whose spoken_to_instance_id is null is not merged into any machine', () {
      final TimelineStore s = _storeWith(<(MobileSession?, String)>[
        (kLan, 'to A over LAN'),
        (null, 'legacy row'),
      ]);

      expect(
        _texts(s.entriesForOwners(_ownersOf(kLan))),
        <String>['to A over LAN'],
      );
      expect(_texts(s.entriesWithUnknownInstance), <String>['legacy row'],
          reason: 'still in all-history, marked unknown instance — hidden nowhere');
    });

    test('an empty owner set reads empty, not 「everything is yours」', () {
      final TimelineStore s = _storeWith(<(MobileSession?, String)>[
        (kLan, 'to A over LAN'),
      ]);
      expect(s.entriesForOwners(const <String>{}), isEmpty);
      expect(ownerIdsFor(machineUid: 'machine-AAAA', pairingIdentity: null),
          isEmpty);
    });

    test('banner: another computer\'s queue items do not count on this screen', () {
      final OutboxPendingView v = OutboxPendingView.of(<OutboxItem>[
        _queued(
          requestId: 'r1',
          machineUid: 'machine-AAAA',
          pairingIdentity: kLan.connectionIdentity,
        ),
        _queued(
          requestId: 'r2',
          machineUid: 'machine-BBBB',
          pairingIdentity: kOther.connectionIdentity,
        ),
      ]);

      expect(
        v.countFor(
          machineUid: kRelay.pcMachineUid,
          pairingIdentity: kRelay.connectionIdentity,
        ),
        1,
      );
      expect(
        v.countFor(
          machineUid: kOther.pcMachineUid,
          pairingIdentity: kOther.connectionIdentity,
        ),
        1,
      );
      expect(v.countFor(machineUid: null, pairingIdentity: null), 0);
    });

    test('banner: two 「could not ask for a uid」 queue items do not bleed into each other', () {
      final OutboxPendingView v = OutboxPendingView.of(<OutboxItem>[
        _queued(
          requestId: 'r1',
          machineUid: null,
          pairingIdentity: kOldOne.connectionIdentity,
        ),
      ]);

      expect(
        v.countFor(
          machineUid: kOldTwo.pcMachineUid,
          pairingIdentity: kOldTwo.connectionIdentity,
        ),
        0,
      );
      expect(
        v.countFor(
          machineUid: kOldOne.pcMachineUid,
          pairingIdentity: kOldOne.connectionIdentity,
        ),
        1,
      );
    });
  });

  group('scopeKeyFor — the bucket-key ladder', () {
    test('has a uid ⇒ machine key; both channels share the key', () {
      expect(
        scopeKeyFor(
          machineUid: kLan.pcMachineUid,
          pairingIdentity: kLan.connectionIdentity,
        ),
        'machine:machine-AAAA',
      );
      expect(
        scopeKeyFor(
          machineUid: kRelay.pcMachineUid,
          pairingIdentity: kRelay.connectionIdentity,
        ),
        'machine:machine-AAAA',
      );
    });

    test('no uid ⇒ instance key (old behaviour kept as-is)', () {
      expect(
        scopeKeyFor(
          machineUid: null,
          pairingIdentity: kOldOne.connectionIdentity,
        ),
        'instance:standalone|instance:inst-old-1',
      );
    });

    test('cloud identity ⇒ instance key, even if it carries a uid', () {
      expect(
        scopeKeyFor(
          machineUid: 'machine-AAAA',
          pairingIdentity: kCloud.connectionIdentity,
        ),
        'instance:saas|instance:inst-cloud',
      );
    });

    test('nothing at all ⇒ null (no scope, not 「all」)', () {
      expect(scopeKeyFor(machineUid: null, pairingIdentity: null), isNull);
      expect(scopeKeyFor(machineUid: '  ', pairingIdentity: '  '), isNull);
      expect(scopeKeyFor(machineUid: 'machine-AAAA', pairingIdentity: null),
          'machine:machine-AAAA');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 2 — the learned instance→machine table (design §3.2). Phase 1 answers
  // 「who else is on this computer」 from the pairing list, which stops being true the day
  // the user deletes one of the two pairings.
  // ───────────────────────────────────────────────────────────────────────────
  group('card F2 phase 2 — after a pairing is forgotten', () {
    tearDown(() => installInstanceMachineMap(null));

    test('🔴 the user deleted the other same-machine pairing; merged history does not shrink', () {
      // The user removed the relay pairing; only the LAN one is left in storage.
      const List<MobileSession> afterForget = <MobileSession>[kLan];

      // Positive control ① — WITHOUT the learned table this is the shortening
      // phase 1 could not prevent: the forgotten pairing's rows leave the machine
      // view. (They are still in all-history — nothing is lost — but 「history of
      // the same computer」 silently gets shorter, which is the defect this phase closes.)
      expect(
        ownerIdsFor(
          machineUid: kLan.pcMachineUid,
          pairingIdentity: kLan.connectionIdentity,
          pairings: afterForget,
        ),
        <String>{kLan.connectionIdentity},
      );

      // …and WITH it, the mapping remembers what the pairing list forgot.
      expect(
        ownerIdsFor(
          machineUid: kLan.pcMachineUid,
          pairingIdentity: kLan.connectionIdentity,
          pairings: afterForget,
          learned: <String, String>{
            kRelay.connectionIdentity: 'machine-AAAA',
          },
        ),
        <String>{kLan.connectionIdentity, kRelay.connectionIdentity},
      );
    });

    test('🔴 reverse control: another machine\'s rows in the table must not bleed in', () {
      expect(
        ownerIdsFor(
          machineUid: kLan.pcMachineUid,
          pairingIdentity: kLan.connectionIdentity,
          pairings: kAllPairings,
          learned: <String, String>{
            kOther.connectionIdentity: 'machine-BBBB',
            kRelay.connectionIdentity: 'machine-AAAA',
          },
        ),
        <String>{kLan.connectionIdentity, kRelay.connectionIdentity},
      );
    });

    test('🔴 reverse control: a cloud identity in the table must not enter the machine view (read side checks again)', () {
      // The seed excludes `channel == 'saas'` at the WRITE. This asserts the
      // READ refuses it too — a table is a thing other code can write to, and
      // 「the write side already blocked it」 is an assertion about somebody else's code.
      expect(
        ownerIdsFor(
          machineUid: kLan.pcMachineUid,
          pairingIdentity: kLan.connectionIdentity,
          pairings: <MobileSession>[kLan],
          learned: <String, String>{
            kCloud.connectionIdentity: 'machine-AAAA',
          },
        ),
        <String>{kLan.connectionIdentity},
      );
    });

    test('🔴 wiring: the moment the ack lands, SessionScope itself writes the mapping into the table and widens on the spot', () async {
      // Anti-façade ③ —「unit tests all green prove nothing about wiring」. The two tests above drive
      // `ownerIdsFor` directly, so they would all stay green with the ack-side
      // writer deleted and with `learned:` never passed. This one drives the
      // production entry point (`SessionScope.note`, which is what
      // `PttSession.applyPairedIdentity` calls) and asserts BOTH halves: the row
      // was written, and the widened owner set used it.
      final InMemoryInstanceMachineMap map = InMemoryInstanceMachineMap();
      installInstanceMachineMap(map);
      // Storage remembers ONLY the LAN pairing — the relay one was forgotten,
      // so the pairing list cannot supply it and the table is the only source.
      final TokenStorage storage = InMemoryTokenStorage();
      await storage.addOrUpdatePairing(kLan);

      final SessionScope scope = SessionScope();
      // ① The relay ack arrives first (an earlier session), and is remembered.
      scope.note(session: kRelay, storage: storage);
      await pumpEventQueue();
      expect(await map.readAll(),
          <String, String>{kRelay.connectionIdentity: 'machine-AAAA'},
          reason: 'the ack-side writer is not wired ⇒ the table forever has only the seed copy');

      // ② Later the phone connects over LAN. The relay pairing is NOT in
      // storage, so phase 1 alone would show only the LAN rows.
      scope.note(session: kLan, storage: storage);
      expect(scope.ownerIds, <String>{kLan.connectionIdentity},
          reason: 'the narrow set must be published first: waiting for the table read before publishing would leave the previous connection\'s history on screen');
      await pumpEventQueue();
      expect(scope.key, 'machine:machine-AAAA');
      expect(scope.ownerIds,
          <String>{kLan.connectionIdentity, kRelay.connectionIdentity});
    });

    test('a cloud ack must not leave a row in the table', () async {
      final InMemoryInstanceMachineMap map = InMemoryInstanceMachineMap();
      installInstanceMachineMap(map);
      final TokenStorage storage = InMemoryTokenStorage();
      final SessionScope scope = SessionScope();
      // A cloud identity carrying a uid it should not have — the shape the
      // write-side guard exists for.
      scope.note(
        session: kCloud.copyWith(pcMachineUid: 'machine-AAAA'),
        storage: storage,
      );
      await pumpEventQueue();
      expect(await map.readAll(), isEmpty);
      expect(scope.key, 'instance:${kCloud.connectionIdentity}');
    });
  });
}
