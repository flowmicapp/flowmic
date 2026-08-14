// Card E-CL — the write path, the read-back and the delete, end to end over a real
// [BlindStoreCloudClient] driven by a fake socket.
//
// 🔴 WHY THE REAL CLIENT AND NOT A FAKE ONE. The frame shape and the ack
// decoding are half of what this card delivers, and a hand-written fake client
// would be me writing down what I THINK the server says and then agreeing with
// myself — the exact shape CLAUDE.md records as 「测试把我们的假设念回给我们听」
// (the Soniox FakeWs lesson). The acks queued below are copied from
// apps/server-core/src/socket/handlers/timeline.handler.ts's actual replies:
//   push      → {ok:true, assigned:[{id,seq}]}
//   pull      → {blobs:[…], next_seq}
//   tombstone → {ok:true, tombstoned:n}
//   any error → {error:'CODE'}

import 'dart:convert';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/crypto/blind_store_keyring.dart';
import 'package:flowmic/src/crypto/blind_store_params.dart';
import 'package:flowmic/src/portable/unknown_field_vault.dart';
import 'package:flowmic/src/session/outbox_blob_store.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_client.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_state.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_sync.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_payload.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_reaper.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

final Argon2Cost kFast = Argon2Cost.reducedForTestsOnly(
  memoryKiB: 64,
  iterations: 1,
  lanes: 1,
);

const String kAccount = 'owner@example.com';

TimelineEntry lightRecord({
  String id = 'loc_dev_e1',
  String text = 'a light record',
  String origin = 'cloud',
}) => TimelineEntry.fromJson(<String, Object?>{
  'id': id,
  'client_id': id,
  'origin': origin,
  'output_text': text,
  'mode': 'realtime',
  'delivery': 'none',
  'status': 'noted',
  'created_at': '2026-08-08T01:02:03.000Z',
  'updated_at': '2026-08-08T01:02:03.000Z',
})!;

/// The whole leg, assembled over in-memory parts.
class Harness {
  Harness({this.cloudRelay = true, bool keymetaConfirmed = true})
    : keymetaOk = keymetaConfirmed;

  final bool cloudRelay;

  /// SALT-2 — what the push gate's confirmation check answers. Defaults to
  /// confirmed so every pre-gate test keeps measuring what it measured.
  bool keymetaOk;

  /// When set, the confirmation check THROWS — the fail-closed direction.
  bool keymetaGateThrows = false;

  /// How many times the gate actually asked.
  int keymetaAsks = 0;

  final FakeSocketTransport transport = FakeSocketTransport();
  final InMemoryTimelinePersistence persistence = InMemoryTimelinePersistence();
  final InMemoryBlindStoreCloudStateStore state =
      InMemoryBlindStoreCloudStateStore();
  final InMemoryBlindStoreCursorStore cursor = InMemoryBlindStoreCursorStore();
  late final BlindStoreKeyring keyring;
  late final BlindStoreCloudSync sync;
  int reloads = 0;

  Future<void> boot({bool enrol = true}) async {
    keyring = BlindStoreKeyring(
      store: InMemoryBlindStoreKeyStore(),
      cost: kFast,
    );
    if (enrol) await keyring.enroll('pass-1');
    sync = BlindStoreCloudSync(
      keyring: keyring,
      client: BlindStoreCloudClient(transport: transport),
      state: state,
      bridge: BlindStoreTimelineBridge(
        persistence: persistence,
        reaper: TimelineReaper(
          persistence: persistence,
          images: InMemoryOutboxBlobStore(),
          vault: InMemoryUnknownFieldVault(),
          cutoffs: InMemoryCutoffStore(),
        ),
        reload: () async => reloads++,
      ),
      cursor: cursor,
      isCloudRelay: () => cloudRelay,
      accountKey: () => kAccount,
      keymetaConfirmed: () async {
        keymetaAsks++;
        if (keymetaGateThrows) {
          throw StateError('keymeta confirmation check exploded');
        }
        return keymetaOk;
      },
    );
  }

  List<EventEnvelope> get pushes =>
      transport.emittedWhere(FlowMicEvents.timelinePush);
  List<EventEnvelope> get tombstones =>
      transport.emittedWhere(FlowMicEvents.timelineTombstone);

  /// The entries array of the Nth push frame.
  List<Map<String, Object?>> pushedEntries([int n = 0]) {
    final Map<String, Object?> payload =
        (pushes[n].data! as Map).cast<String, Object?>();
    return <Map<String, Object?>>[
      for (final Object? e in payload['entries']! as List)
        (e! as Map).cast<String, Object?>(),
    ];
  }

  static Object emptyPull({int nextSeq = 0}) =>
      <String, Object?>{'blobs': <Object?>[], 'next_seq': nextSeq};

  static Object pushAck(List<String> ids) => <String, Object?>{
    'ok': true,
    'assigned': <Object?>[
      for (int i = 0; i < ids.length; i++)
        <String, Object?>{'id': ids[i], 'seq': i + 1},
    ],
  };

  /// One row as `timeline:pull` serves it.
  static Map<String, Object?> remoteBlob({
    required String id,
    required String ciphertext,
    int seq = 1,
    bool deleted = false,
  }) => <String, Object?>{
    'id': id,
    'seq': seq,
    'ciphertext': ciphertext,
    'created_at': 1754614923000,
    'schema_ver': 1,
    if (deleted) 'deleted': true,
  };
}

void main() {
  group('WRITE — a light record goes up sealed', () {
    test('one push frame, e2e:v1: ciphertext, no plaintext on the wire', () async {
      final Harness h = Harness();
      await h.boot();
      await h.persistence.upsert(lightRecord(text: 'the quick brown fox'));
      h.transport.ackQueue.addAll(<Object?>[
        Harness.pushAck(<String>['loc_dev_e1']),
        Harness.emptyPull(),
      ]);

      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.blocked, isNull);
      expect(r.pushed, 1);
      expect(h.pushes, hasLength(1));

      final Map<String, Object?> blob = h.pushedEntries().single;
      expect(blob['id'], 'loc_dev_e1');
      expect(blob['schema_ver'], kBlindStoreBlobSchemaVer);
      expect(blob['ciphertext'], startsWith(kBlindStoreEnvelopePrefix));
      // 🔴 The red line, asserted on the FRAME rather than on our intent.
      expect(blob['ciphertext'], isNot(startsWith('enc:v1:')));

      // 🔴 And the server really is blind: the words are nowhere in the frame.
      final String wire = jsonEncode(h.pushes.single.data);
      expect(wire, isNot(contains('the quick brown fox')));
    });

    test('a second run pushes nothing — idempotent by content', () async {
      final Harness h = Harness();
      await h.boot();
      await h.persistence.upsert(lightRecord());
      h.transport.ackQueue.addAll(<Object?>[
        Harness.pushAck(<String>['loc_dev_e1']),
        Harness.emptyPull(),
      ]);
      await h.sync.syncNow();

      h.transport.ackQueue.add(Harness.emptyPull());
      final BlindStoreSyncReport second = await h.sync.syncNow();

      expect(second.pushed, 0);
      expect(h.pushes, hasLength(1), reason: 'no second write of the same content');
    });

    test('an edit re-pushes; the server sees a changed ciphertext', () async {
      final Harness h = Harness();
      await h.boot();
      await h.persistence.upsert(lightRecord(text: 'before'));
      h.transport.ackQueue.addAll(<Object?>[
        Harness.pushAck(<String>['loc_dev_e1']),
        Harness.emptyPull(),
      ]);
      await h.sync.syncNow();

      await h.persistence.upsert(lightRecord(text: 'after'));
      h.transport.ackQueue.addAll(<Object?>[
        Harness.pushAck(<String>['loc_dev_e1']),
        Harness.emptyPull(),
      ]);
      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.pushed, 1);
      expect(h.pushes, hasLength(2));
      expect(
        h.pushedEntries(1).single['ciphertext'],
        isNot(h.pushedEntries(0).single['ciphertext']),
      );
    });

    test('PC-bound rows are not light records and never go up', () async {
      final Harness h = Harness();
      await h.boot();
      await h.persistence.upsert(lightRecord(id: 'loc_dev_p1', origin: 'paired'));
      h.transport.ackQueue.add(Harness.emptyPull());

      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.pushed, 0);
      expect(h.pushes, isEmpty);
    });

    test('an id the server did not acknowledge is NOT recorded as pushed', () async {
      final Harness h = Harness();
      await h.boot();
      await h.persistence.upsert(lightRecord());
      // The server answered ok, but said nothing about this id.
      h.transport.ackQueue.addAll(<Object?>[
        <String, Object?>{'ok': true, 'assigned': <Object?>[]},
        Harness.emptyPull(),
      ]);
      await h.sync.syncNow();

      // Next run must try again rather than assume it landed.
      h.transport.ackQueue.addAll(<Object?>[
        Harness.pushAck(<String>['loc_dev_e1']),
        Harness.emptyPull(),
      ]);
      final BlindStoreSyncReport second = await h.sync.syncNow();
      expect(second.pushed, 1);
      expect(h.pushes, hasLength(2));
    });
  });

  group('🔴 DESTINATION — a LAN link is not this account cloud store', () {
    test('not a cloud relay ⇒ nothing is emitted at all', () async {
      // timeline:push authenticates off the PAIRING TOKEN (server auth/
      // middleware.ts), so a standalone LAN server would ACCEPT this and write
      // the user's records into its own database. Being connected and paired
      // cannot answer 「is this the cloud」 — only the measured channel can.
      final Harness h = Harness(cloudRelay: false);
      await h.boot();
      await h.persistence.upsert(lightRecord());

      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.blocked, BlindStoreSyncBlock.notCloudRelay);
      expect(h.transport.emitted, isEmpty, reason: 'not one frame, not even a pull');
    });

    test('positive control: the same setup on a cloud relay DOES emit', () async {
      final Harness h = Harness();
      await h.boot();
      await h.persistence.upsert(lightRecord());
      h.transport.ackQueue.addAll(<Object?>[
        Harness.pushAck(<String>['loc_dev_e1']),
        Harness.emptyPull(),
      ]);

      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.blocked, isNull);
      expect(h.pushes, hasLength(1));
    });

    test('a locked keyring emits nothing — never an unsealed row', () async {
      final Harness h = Harness();
      await h.boot(enrol: false);
      await h.persistence.upsert(lightRecord());

      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.blocked, BlindStoreSyncBlock.keyringLocked);
      expect(h.transport.emitted, isEmpty);
    });
  });

  group('🔴 PUSH GATE — keymeta must be CONFIRMED first (SALT-2, design '
      '2026-08-11 §3.2 step 4)', () {
    test('🔴 unconfirmed ⇒ blocked BY NAME and ZERO frames on the wire', () async {
      // The race loser's shape: enrolled, unlocked, on a cloud relay, logged
      // in — and holding a salt the account's keymeta row may contradict. A
      // blob sealed under it would be an orphan ciphertext no other device of
      // this account could ever open, so the gate must hold with everything
      // else green. The assertion is on FRAMES (transport.emitted), not on our
      // intent — the G13 law: only the wire can prove 「not one character left」.
      final Harness h = Harness(keymetaConfirmed: false);
      await h.boot();
      await h.persistence.upsert(lightRecord());

      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.blocked, BlindStoreSyncBlock.keymetaUnconfirmed);
      expect(h.pushes, isEmpty);
      expect(
        h.transport.emitted,
        isEmpty,
        reason: 'fail-closed: not one frame, not even a pull',
      );
      expect(h.keymetaAsks, 1, reason: 'the gate really asked — see the '
          'positive control below for the frames-flow half');
    });

    test('positive control: the SAME setup, confirmed ⇒ the push happens', () async {
      // Without this pair the zero above could mean the probe is blind rather
      // than the gate is holding (negative assertions carry their own positive
      // control — repo law).
      final Harness h = Harness(keymetaConfirmed: true);
      await h.boot();
      await h.persistence.upsert(lightRecord());
      h.transport.ackQueue.addAll(<Object?>[
        Harness.pushAck(<String>['loc_dev_e1']),
        Harness.emptyPull(),
      ]);

      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.blocked, isNull);
      expect(r.pushed, 1);
      expect(h.pushes, hasLength(1));
      expect(h.keymetaAsks, 1);
    });

    test('🔴 fail-closed: a confirmation check that THROWS blocks, never passes', () async {
      // 「we did not get an answer」 is not 「confirmed」 — the same rule the notCloudRelay judge
      // applies to a null channel reading.
      final Harness h = Harness();
      await h.boot();
      h.keymetaGateThrows = true;
      await h.persistence.upsert(lightRecord());

      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.blocked, BlindStoreSyncBlock.keymetaUnconfirmed);
      expect(h.transport.emitted, isEmpty);
    });

    test('the gate sits BEHIND the cheaper judges — a locked keyring never '
        'even asks', () async {
      // Order matters for what the block reason MEANS: on every real install
      // today the keyring is locked, and the leg must keep resting on
      // keyringLocked (zero network) rather than dialing keymeta GETs.
      final Harness h = Harness(keymetaConfirmed: false);
      await h.boot(enrol: false);

      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.blocked, BlindStoreSyncBlock.keyringLocked);
      expect(h.keymetaAsks, 0);
    });
  });

  group('READ-BACK — decrypt, merge, and count what will not open', () {
    test('a record from another device is decrypted and stored', () async {
      final Harness h = Harness();
      await h.boot();
      final String sealed = h.keyring.seal(
        entryId: 'loc_devB_x1',
        plaintext: encodeBlindStorePayload(
          lightRecord(id: 'loc_devB_x1', text: 'said on the tablet'),
        ),
      )!;
      h.transport.ackQueue.add(<String, Object?>{
        'blobs': <Object?>[
          Harness.remoteBlob(id: 'loc_devB_x1', ciphertext: sealed, seq: 7),
        ],
        'next_seq': 7,
      });

      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.merged, 1);
      expect(r.undecryptable, 0);
      final List<TimelineEntry> rows = await h.persistence.loadAll();
      expect(rows.single.id, 'loc_devB_x1');
      expect(rows.single.outputText, 'said on the tablet');
      expect(h.reloads, 1, reason: 'the UI is refreshed once per run, not per row');
      expect(h.cursor.read(kAccount), 7);
    });

    test('a merged record is not immediately pushed back up', () async {
      // Without the fingerprint written at merge time this loops forever: every
      // device re-uploads what it just downloaded and bumps everyone else's seq.
      final Harness h = Harness();
      await h.boot();
      final String sealed = h.keyring.seal(
        entryId: 'loc_devB_x1',
        plaintext: encodeBlindStorePayload(lightRecord(id: 'loc_devB_x1')),
      )!;
      h.transport.ackQueue.add(<String, Object?>{
        'blobs': <Object?>[
          Harness.remoteBlob(id: 'loc_devB_x1', ciphertext: sealed),
        ],
        'next_seq': 1,
      });
      await h.sync.syncNow();

      h.transport.ackQueue.add(Harness.emptyPull(nextSeq: 1));
      final BlindStoreSyncReport second = await h.sync.syncNow();

      expect(second.pushed, 0);
      expect(h.pushes, isEmpty);
    });

    test('🔴 a blob that will not open is COUNTED, not silently skipped', () async {
      final Harness h = Harness();
      await h.boot();
      // Sealed by a different account's key — the wrong-passphrase shape.
      final BlindStoreKeyring stranger = BlindStoreKeyring(
        store: InMemoryBlindStoreKeyStore(),
        cost: kFast,
      );
      await stranger.enroll('someone else');
      final String foreign = stranger.seal(
        entryId: 'loc_devB_x1',
        plaintext: encodeBlindStorePayload(lightRecord(id: 'loc_devB_x1')),
      )!;
      h.transport.ackQueue.add(<String, Object?>{
        'blobs': <Object?>[
          Harness.remoteBlob(id: 'loc_devB_x1', ciphertext: foreign),
        ],
        'next_seq': 3,
      });

      final BlindStoreSyncReport r = await h.sync.syncNow();

      // 🔴 The report must be able to say 「1 row will not open」. An empty timeline and
      // 「one row cannot be read」 are different facts and the second must survive to the
      // surface — design §2.1 / §3.2.
      expect(r.undecryptable, 1);
      expect(r.merged, 0);
      expect(await h.persistence.loadAll(), isEmpty);
    });

    test('a blob whose inner id disagrees with its row is refused', () async {
      final Harness h = Harness();
      await h.boot();
      // Authenticates (right key, right aad) but claims to be a different entry.
      final String sealed = h.keyring.seal(
        entryId: 'loc_devB_x1',
        plaintext: encodeBlindStorePayload(lightRecord(id: 'loc_SOMETHING_ELSE')),
      )!;
      h.transport.ackQueue.add(<String, Object?>{
        'blobs': <Object?>[
          Harness.remoteBlob(id: 'loc_devB_x1', ciphertext: sealed),
        ],
        'next_seq': 1,
      });

      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.undecryptable, 1);
      expect(r.merged, 0);
    });
  });

  group('DELETE — the server answer is taken at face value, and no further', () {
    test('a pending tombstone is sent and cleared on ack', () async {
      final Harness h = Harness();
      await h.boot();
      h.state.seedPendingDelete('loc_dev_gone');
      h.transport.ackQueue.addAll(<Object?>[
        <String, Object?>{'ok': true, 'tombstoned': 1},
        Harness.emptyPull(),
      ]);

      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.deletesConfirmed, 1);
      expect(r.deletesStillPending, 0);
      expect(
        (h.tombstones.single.data! as Map)['ids'],
        <String>['loc_dev_gone'],
      );
    });

    test('🔴 a refused tombstone keeps the debt — no fake success', () async {
      final Harness h = Harness();
      await h.boot();
      h.state.seedPendingDelete('loc_dev_gone');
      h.transport.ackQueue.add(<String, Object?>{'error': 'AUTH_TOKEN_INVALID'});

      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.deletesConfirmed, 0);
      expect(r.deletesStillPending, 1);
      expect(r.failure, 'refused:AUTH_TOKEN_INVALID');
      expect(await h.state.pendingDeletes(), <String>['loc_dev_gone']);
    });

    test('an unanswered tombstone is not reported as a server verdict', () async {
      final Harness h = Harness();
      await h.boot();
      h.state.seedPendingDelete('loc_dev_gone');
      h.transport.failEmits = true;

      final BlindStoreSyncReport r = await h.sync.syncNow();

      // 「we did not get an answer」 must never read as 「the server said something」.
      expect(r.failure, startsWith('unreachable:'));
      expect(r.deletesConfirmed, 0);
      expect(r.deletesStillPending, 1);
    });

    test('the server holding no such row is still a settled delete', () async {
      // `tombstoned: 0` means the id was not there — which is the end state the
      // user asked for. Treating it as failure would retry forever.
      final Harness h = Harness();
      await h.boot();
      h.state.seedPendingDelete('loc_dev_never_pushed');
      h.transport.ackQueue.addAll(<Object?>[
        <String, Object?>{'ok': true, 'tombstoned': 0},
        Harness.emptyPull(),
      ]);

      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.deletesConfirmed, 1);
      expect(r.deletesStillPending, 0);
    });

    test('🔴 a row owed a tombstone is never re-pushed (no resurrection)', () async {
      // The crash window: the marker landed, the row is still on disk, and the
      // drain has not succeeded yet. Stage 2 must not upload it again.
      final Harness h = Harness();
      await h.boot();
      await h.persistence.upsert(lightRecord());
      h.state.seedPendingDelete('loc_dev_e1');
      h.transport.ackQueue.add(<String, Object?>{'error': 'TIMELINE_BLOB_REJECTED'});

      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.deletesStillPending, 1);
      expect(h.pushes, isEmpty, reason: 'a failed delete must not become an upload');
    });

    test('🔴 a pull does not merge back a row awaiting its tombstone', () async {
      // The reachable resurrection: the user deleted it, the drain was refused,
      // so the server still serves it as a LIVE row. Merging it would put a
      // deleted record back on the user's screen.
      final Harness h = Harness();
      await h.boot();
      final TimelineEntry deleted = lightRecord(id: 'loc_dev_gone');
      h.state.seedPendingDelete('loc_dev_gone');
      final String sealed = h.keyring.seal(
        entryId: 'loc_dev_gone',
        plaintext: encodeBlindStorePayload(deleted),
      )!;
      h.transport.ackQueue.addAll(<Object?>[
        <String, Object?>{'error': 'TIMELINE_BLOB_REJECTED'}, // drain refused
        <String, Object?>{
          'blobs': <Object?>[
            Harness.remoteBlob(id: 'loc_dev_gone', ciphertext: sealed, seq: 5),
          ],
          'next_seq': 5,
        },
      ]);

      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.deletesStillPending, 1);
      expect(r.merged, 0, reason: 'a deleted row must not come back');
      expect(await h.persistence.loadAll(), isEmpty);
      // 🔴 And it is not miscounted as a decryption problem either — it opened
      // perfectly well; we chose not to take it.
      expect(r.undecryptable, 0);
    });

    test('🔴 a remote tombstone deletes locally and raises no false alarm', () async {
      final Harness h = Harness();
      await h.boot();
      final TimelineEntry doomed = lightRecord(id: 'loc_devB_x1');
      await h.persistence.upsert(doomed);
      // The realistic state: this row is already up there (that is WHY another
      // device could delete it), so stage 2 has nothing to push and the only
      // frame in this run is the pull.
      await h.state.markPushed(
        entryId: doomed.id,
        payloadHash: blindStorePayloadHash(encodeBlindStorePayload(doomed)),
      );
      // What E-B0 really serves: the row survives, the BYTES do not — the
      // ciphertext is the bare prefix. Decrypting it would fail, so the reader
      // must branch on `deleted` first or a correct delete looks like corruption.
      h.transport.ackQueue.add(<String, Object?>{
        'blobs': <Object?>[
          Harness.remoteBlob(
            id: 'loc_devB_x1',
            ciphertext: kBlindStoreEnvelopePrefix,
            seq: 9,
            deleted: true,
          ),
        ],
        'next_seq': 9,
      });

      final BlindStoreSyncReport r = await h.sync.syncNow();

      expect(r.tombstonesApplied, 1);
      expect(r.undecryptable, 0, reason: 'a payload-less tombstone is not a failure');
      expect(await h.persistence.loadAll(), isEmpty);
    });
  });

  test('the cursor is per account — a different login starts fresh', () async {
    final Harness h = Harness();
    await h.boot();
    h.transport.ackQueue.add(Harness.emptyPull(nextSeq: 42));
    await h.sync.syncNow();

    expect(h.cursor.read(kAccount), 42);
    expect(
      h.cursor.read('someone.else@example.com'),
      0,
      reason: 'another account must not inherit this position and skip its own rows',
    );
  });
}
