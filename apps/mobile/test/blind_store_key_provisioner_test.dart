// SALT-2 — the §3.2 provisioner, every outcome BY TYPE, and the 409 race
// end-to-end.
//
// The fake below implements the server's putFirstWriter semantics verbatim
// (apps/server-core/src/db/repos/timeline-keymeta.repo.ts through
// timeline-keymeta-routes.ts): no row ⇒ created; identical bytes ⇒ identical;
// differing bytes ⇒ conflict, row untouched. The race is staged the way it
// actually happens — the winner's row lands BETWEEN this device's GET and its
// PUT — not by scripting a canned answer sequence, so the fake cannot drift
// into agreeing with an order of events the server would never produce.

import 'dart:typed_data';

import 'package:flowmic/src/crypto/blind_store_keyring.dart';
import 'package:flowmic/src/crypto/blind_store_params.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_cloud_client.dart'
    show BlindStoreCloudRefusal, BlindStoreCloudUnreachable;
import 'package:flowmic/src/timeline/cloud/blind_store_key_provisioner.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_keymeta_client.dart';
import 'package:flowmic/src/timeline/cloud/blind_store_secure_key_store.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

/// Real Argon2id, small parameters — the keyring test's own reduced-cost
/// factory, test-only and staying that way (correctness is pinned by
/// blind_store_kdf_vector_test.dart against RFC 9106).
final Argon2Cost kFast = Argon2Cost.reducedForTestsOnly(
  memoryKiB: 64,
  iterations: 1,
  lanes: 1,
);

bool _sameBytes(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (int i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

/// First-writer-wins keymeta storage, in memory.
class FakeKeymetaClient implements BlindStoreKeymetaClient {
  ({Uint8List salt, String sentinel})? row;

  int gets = 0;
  int puts = 0;

  /// Thrown by the next calls when set (persistent until cleared — a down
  /// server stays down until the test says otherwise).
  Exception? throwOnGet;
  Exception? throwOnPut;

  /// The other device's write, applied immediately BEFORE this device's next
  /// PUT is judged — the §3.2 step-3 race, staged where it really happens.
  ({Uint8List salt, String sentinel})? winnerLandsBeforeNextPut;

  /// What this device's LAST PUT carried — for the race test this is the
  /// doomed freshly minted salt, captured so the discard can be asserted.
  Uint8List? lastPutSalt;
  String? lastPutSentinel;

  @override
  Future<BlindStoreKeymetaRow?> get() async {
    gets++;
    final Exception? e = throwOnGet;
    if (e != null) throw e;
    final ({Uint8List salt, String sentinel})? r = row;
    if (r == null) return null;
    return BlindStoreKeymetaRow(
      salt: Uint8List.fromList(r.salt),
      sentinel: r.sentinel,
      schemaVer: 1,
    );
  }

  @override
  Future<BlindStoreKeymetaPutOutcome> put({
    required Uint8List salt,
    required String sentinel,
  }) async {
    puts++;
    final Exception? e = throwOnPut;
    if (e != null) throw e;
    final ({Uint8List salt, String sentinel})? winner = winnerLandsBeforeNextPut;
    if (winner != null) {
      row = winner;
      winnerLandsBeforeNextPut = null;
    }
    lastPutSalt = Uint8List.fromList(salt);
    lastPutSentinel = sentinel;
    final ({Uint8List salt, String sentinel})? r = row;
    if (r == null) {
      row = (salt: Uint8List.fromList(salt), sentinel: sentinel);
      return BlindStoreKeymetaPutOutcome.created;
    }
    if (_sameBytes(r.salt, salt) && r.sentinel == sentinel) {
      return BlindStoreKeymetaPutOutcome.identical;
    }
    return BlindStoreKeymetaPutOutcome.conflict;
  }
}

class Rig {
  Rig({String? account = 'owner@example.com'}) : accountKey = account {
    keyring = BlindStoreKeyring(
      store: store,
      cost: kFast,
    );
    provisioner = BlindStoreKeyProvisioner(
      keyring: keyring,
      client: client,
      accountKey: () => accountKey,
    );
  }

  final FakeKeymetaClient client = FakeKeymetaClient();
  final InMemoryBlindStoreKeyStore store = InMemoryBlindStoreKeyStore();
  String? accountKey;
  late final BlindStoreKeyring keyring;
  late final BlindStoreKeyProvisioner provisioner;
}

/// Another device of the same account: a keyring enrolled elsewhere whose
/// material can be planted as the server row.
Future<({BlindStoreKeyring ring, Uint8List salt, String sentinel})> _otherDevice(
  String passphrase,
) async {
  final BlindStoreKeyring ring = BlindStoreKeyring(
    store: InMemoryBlindStoreKeyStore(),
    cost: kFast,
  );
  await ring.enroll(passphrase);
  final ({Uint8List salt, String sentinel}) m = (await ring.sharedKeyMaterial())!;
  return (ring: ring, salt: m.salt, sentinel: m.sentinel);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('outcome: confirmed', () {
    test('first device, empty account: enroll → PUT created → confirmed', () async {
      final Rig rig = Rig();

      final BlindStoreProvisionResult r =
          await rig.provisioner.provision(passphrase: 'first words');

      expect(r.outcome, BlindStoreProvisionOutcome.confirmed);
      expect(r.isConfirmed, isTrue);
      // The account row IS this device's material now.
      final ({Uint8List salt, String sentinel}) m =
          (await rig.keyring.sharedKeyMaterial())!;
      expect(_sameBytes(rig.client.row!.salt, m.salt), isTrue);
      expect(rig.client.row!.sentinel, m.sentinel);
      expect(rig.keyring.isUnlocked, isTrue);
    });

    test('confirmed is CACHED per account — a second call costs no network', () async {
      final Rig rig = Rig();
      await rig.provisioner.provision(passphrase: 'first words');
      final int gets = rig.client.gets;
      final int puts = rig.client.puts;

      final BlindStoreProvisionResult again =
          await rig.provisioner.ensureConfirmed();

      expect(again.outcome, BlindStoreProvisionOutcome.confirmed);
      expect(rig.client.gets, gets, reason: 'no re-GET on every sync');
      expect(rig.client.puts, puts);
    });

    test('second device, same passphrase: adopts the row and opens the first '
        'device blobs', () async {
      final ({BlindStoreKeyring ring, Uint8List salt, String sentinel}) a =
          await _otherDevice('shared secret');
      final String sealedByA =
          a.ring.seal(entryId: 'e1', plaintext: 'from device A')!;

      final Rig rig = Rig();
      rig.client.row = (salt: a.salt, sentinel: a.sentinel);

      final BlindStoreProvisionResult r =
          await rig.provisioner.provision(passphrase: 'shared secret');

      // Plain adoption, not the race path — the row was there all along.
      expect(r.outcome, BlindStoreProvisionOutcome.confirmed);
      expect(rig.keyring.open(entryId: 'e1', envelope: sealedByA),
          'from device A');
      expect(rig.client.puts, 0,
          reason: 'adopting a stored row never writes one');
    });
  });

  group('🔴 outcome: conflictAdopted — the 409 race, end to end', () {
    test('loser discards its mint and survives with the SERVER bytes', () async {
      // Device W (the winner) enrolled the same account concurrently. Its row
      // lands between this device's GET (which saw nothing) and its PUT.
      final ({BlindStoreKeyring ring, Uint8List salt, String sentinel}) w =
          await _otherDevice('shared passphrase');
      final String sealedByWinner =
          w.ring.seal(entryId: 'e9', plaintext: 'winner wrote this')!;

      final Rig rig = Rig();
      rig.client.winnerLandsBeforeNextPut = (salt: w.salt, sentinel: w.sentinel);

      final BlindStoreProvisionResult r =
          await rig.provisioner.provision(passphrase: 'shared passphrase');

      expect(r.outcome, BlindStoreProvisionOutcome.conflictAdopted);
      expect(r.isConfirmed, isTrue);

      // The doomed mint went ON THE WIRE once (that is what the server judged
      // the conflict against) and is NOT what survived on the device.
      final Uint8List doomed = rig.client.lastPutSalt!;
      final ({Uint8List salt, String sentinel}) surviving =
          (await rig.keyring.sharedKeyMaterial())!;
      expect(_sameBytes(doomed, surviving.salt), isFalse,
          reason: 'the freshly minted salt must not survive the lost race');
      // 🔴 The surviving material is the SERVER's bytes, byte for byte.
      expect(_sameBytes(surviving.salt, w.salt), isTrue);
      expect(surviving.sentinel, w.sentinel);
      // And the row itself was never overwritten by the loser.
      expect(_sameBytes(rig.client.row!.salt, w.salt), isTrue);

      // The real proof the surviving key IS the winner's key: it opens what
      // the winner sealed.
      expect(rig.keyring.open(entryId: 'e9', envelope: sealedByWinner),
          'winner wrote this');

      expect(rig.client.puts, 1, reason: 'the loser never PUTs again');
      expect(rig.client.gets, 2, reason: 'initial GET + the re-GET of the row');
    });

    test('race lost AND passphrases differ: the loud type, and the doomed '
        'mint is still gone', () async {
      final ({BlindStoreKeyring ring, Uint8List salt, String sentinel}) w =
          await _otherDevice('winner words');
      final Rig rig = Rig();
      rig.client.winnerLandsBeforeNextPut = (salt: w.salt, sentinel: w.sentinel);

      await expectLater(
        () => rig.provisioner.provision(passphrase: 'loser words'),
        throwsA(isA<BlindStorePassphraseRejected>()),
      );

      // The discard already happened (design §3.2: discard the material just minted on the 409,
      // not on the adopt): no doomed salt lingers looking enrolled.
      expect(await rig.keyring.sharedKeyMaterial(), isNull);
      expect(rig.keyring.isUnlocked, isFalse);
      // And nothing is confirmed — the gate stays shut.
      final BlindStoreProvisionResult after =
          await rig.provisioner.ensureConfirmed();
      expect(after.outcome, BlindStoreProvisionOutcome.needsPassphrase);
      expect(after.isConfirmed, isFalse);
    });
  });

  group('outcome: needsPassphrase (ensureConfirmed cannot invent one)', () {
    test('nothing enrolled ⇒ needsPassphrase, and ZERO network', () async {
      final Rig rig = Rig();

      final BlindStoreProvisionResult r = await rig.provisioner.ensureConfirmed();

      expect(r.outcome, BlindStoreProvisionOutcome.needsPassphrase);
      expect(rig.client.gets, 0,
          reason: 'no material ⇒ nothing to verify ⇒ nothing to dial');
    });

    test('account row differs from local material ⇒ needsPassphrase, material '
        'untouched', () async {
      final Rig rig = Rig();
      await rig.keyring.enroll('mine');
      final ({Uint8List salt, String sentinel}) mine =
          (await rig.keyring.sharedKeyMaterial())!;
      final ({BlindStoreKeyring ring, Uint8List salt, String sentinel}) other =
          await _otherDevice('theirs');
      rig.client.row = (salt: other.salt, sentinel: other.sentinel);

      final BlindStoreProvisionResult r = await rig.provisioner.ensureConfirmed();

      expect(r.outcome, BlindStoreProvisionOutcome.needsPassphrase);
      // Passphrase-less, nothing may be discarded or adopted.
      final ({Uint8List salt, String sentinel}) still =
          (await rig.keyring.sharedKeyMaterial())!;
      expect(_sameBytes(still.salt, mine.salt), isTrue);
    });
  });

  group('outcome: unreachable (design §3.2 step d, verbatim)', () {
    test('PUT unreachable ⇒ material INTACT, NOT confirmed — and the next '
        'passphrase-less walk completes the registration', () async {
      final Rig rig = Rig();
      rig.client.throwOnPut = const BlindStoreCloudUnreachable('cable pulled');

      final BlindStoreProvisionResult r =
          await rig.provisioner.provision(passphrase: 'first words');

      expect(r.outcome, BlindStoreProvisionOutcome.unreachable);
      expect(r.isConfirmed, isFalse);
      // Step d: the mint survives — re-prompting the user would be the cost of
      // throwing it away, and nothing about the material is wrong.
      expect(await rig.keyring.sharedKeyMaterial(), isNotNull);
      expect(rig.keyring.isUnlocked, isTrue);
      expect(rig.client.row, isNull, reason: 'nothing registered yet');

      // The server comes back: ensureConfirmed finishes the PUT with NO
      // passphrase — this is why step d keeps the material.
      rig.client.throwOnPut = null;
      final BlindStoreProvisionResult healed =
          await rig.provisioner.ensureConfirmed();
      expect(healed.outcome, BlindStoreProvisionOutcome.confirmed);
      final ({Uint8List salt, String sentinel}) m =
          (await rig.keyring.sharedKeyMaterial())!;
      expect(_sameBytes(rig.client.row!.salt, m.salt), isTrue);
    });

    test('GET unreachable ⇒ unreachable, nothing minted', () async {
      final Rig rig = Rig();
      rig.client.throwOnGet = const BlindStoreCloudUnreachable('no route');

      final BlindStoreProvisionResult r =
          await rig.provisioner.provision(passphrase: 'words');

      expect(r.outcome, BlindStoreProvisionOutcome.unreachable);
      expect(await rig.keyring.sharedKeyMaterial(), isNull,
          reason: 'no enrolment on a link we could not even read');
    });
  });

  group('outcome: refused', () {
    test('the server verdict rides through with its own code', () async {
      final Rig rig = Rig();
      rig.client.throwOnGet =
          const BlindStoreCloudRefusal('AUTH_TOKEN_INVALID');

      final BlindStoreProvisionResult r =
          await rig.provisioner.provision(passphrase: 'words');

      expect(r.outcome, BlindStoreProvisionOutcome.refused);
      expect(r.detail, 'AUTH_TOKEN_INVALID');
      expect(r.isConfirmed, isFalse);
    });
  });

  group('🔴 wrong passphrase = the keyring own loud type, never 「cloud empty」', () {
    test('adopting the account row with the wrong words throws '
        'BlindStorePassphraseRejected and leaves no half-enrolment', () async {
      final ({BlindStoreKeyring ring, Uint8List salt, String sentinel}) a =
          await _otherDevice('right words');
      final Rig rig = Rig();
      rig.client.row = (salt: a.salt, sentinel: a.sentinel);

      await expectLater(
        () => rig.provisioner.provision(passphrase: 'wrong words'),
        throwsA(isA<BlindStorePassphraseRejected>()),
      );

      expect(await rig.keyring.sharedKeyMaterial(), isNull);
      expect(rig.keyring.isUnlocked, isFalse);
    });
  });

  group('the confirmation cache is per-account AND per-material', () {
    test('an account switch re-verifies instead of inheriting', () async {
      final Rig rig = Rig();
      await rig.provisioner.provision(passphrase: 'words');
      final int getsAfterConfirm = rig.client.gets;

      rig.accountKey = 'someone.else@example.com';
      final BlindStoreProvisionResult r = await rig.provisioner.ensureConfirmed();

      // The material happens to match this fake's single row, so the OUTCOME
      // is confirmed — the assertion is that the cache did NOT answer for the
      // new account and a real GET happened (the cursor-store precedent:
      // keying by account makes a switch a fresh question by construction).
      expect(r.outcome, BlindStoreProvisionOutcome.confirmed);
      expect(rig.client.gets, getsAfterConfirm + 1);
    });

    test('discarded material un-confirms — the cache is a fingerprint, not a '
        'flag', () async {
      final Rig rig = Rig();
      await rig.provisioner.provision(passphrase: 'words');

      await rig.keyring.discardKeyMaterial();
      final BlindStoreProvisionResult r = await rig.provisioner.ensureConfirmed();

      expect(r.outcome, BlindStoreProvisionOutcome.needsPassphrase);
      expect(r.isConfirmed, isFalse);
    });
  });

  test('provision is idempotent: re-entering with the row already adopted '
      'answers confirmed without touching the keyring', () async {
    final ({BlindStoreKeyring ring, Uint8List salt, String sentinel}) a =
        await _otherDevice('shared');
    final Rig rig = Rig();
    rig.client.row = (salt: a.salt, sentinel: a.sentinel);
    await rig.provisioner.provision(passphrase: 'shared');
    final int puts = rig.client.puts;

    final BlindStoreProvisionResult again =
        await rig.provisioner.provision(passphrase: 'shared');

    expect(again.outcome, BlindStoreProvisionOutcome.confirmed);
    expect(rig.client.puts, puts);
  });

  // ── AUD-D P1-1 — the account-partitioned slot + proof-gated legacy migration.
  //
  // These run against the REAL production stores (`AccountScopedBlindStoreKeyStore`
  // / `SecureBlindStoreKeyStore`), not `InMemoryBlindStoreKeyStore`, because the
  // bug this closes lived IN the storage layer: a single fixed platform-keystore
  // slot shared by every account. `FlutterSecureStorage.setMockInitialValues`
  // backs every store instance below with the SAME in-memory "disk" map, which
  // is what lets two SEPARATE `BlindStoreKeyring`/provisioner pairs (one per
  // account, exactly like two logins on one physical phone) actually share a
  // device the way production does.
  group('🔴 AUD-D P1-1: the account-scoped store never lets two accounts '
      'share one key slot', () {
    setUp(() => FlutterSecureStorage.setMockInitialValues(<String, String>{}));

    /// One "account" on this one physical device: its own scoped store, its
    /// own keyring, its own provisioner — talking to the SAME [client] (the
    /// one server every account on this phone would actually reach).
    ({BlindStoreKeyring keyring, BlindStoreKeyProvisioner provisioner})
    accountOn(FakeKeymetaClient client, String email) {
      final BlindStoreKeyring keyring = BlindStoreKeyring(
        store: AccountScopedBlindStoreKeyStore(accountKey: () => email),
        cost: kFast,
      );
      final BlindStoreKeyProvisioner provisioner = BlindStoreKeyProvisioner(
        keyring: keyring,
        client: client,
        accountKey: () => email,
        legacyStore: const SecureBlindStoreKeyStore(),
      );
      return (keyring: keyring, provisioner: provisioner);
    }

    test('the A-then-B scenario: A enrolls, B logs in on the SAME phone — B '
        'gets NOTHING of A\'s, and A survives untouched', () async {
      final FakeKeymetaClient client = FakeKeymetaClient();
      final ({BlindStoreKeyring keyring, BlindStoreKeyProvisioner provisioner})
      a = accountOn(client, 'alice@example.com');

      final BlindStoreProvisionResult aResult =
          await a.provisioner.provision(passphrase: 'alice-words');
      expect(aResult.outcome, BlindStoreProvisionOutcome.confirmed);
      final ({Uint8List salt, String sentinel}) aMaterial =
          (await a.keyring.sharedKeyMaterial())!;

      // B logs in on the same phone. A FRESH keyring/provisioner pair — this
      // is exactly what main.dart's single long-lived `BlindStoreKeyring`
      // does NOT give you (its `_key` would still be A's in memory), which is
      // why `LoginController.onSignedOut` / `detachForAccountChange` exist —
      // but the STORAGE half, tested here, is safe even without that: B's
      // account-scoped slot is physically a different keystore entry.
      final ({BlindStoreKeyring keyring, BlindStoreKeyProvisioner provisioner})
      b = accountOn(client, 'bob@example.com');
      expect(await b.keyring.sharedKeyMaterial(), isNull,
          reason: "B's slot must start empty — A's enrolment must not have "
              'leaked into it');

      final BlindStoreProvisionResult bResult = await b.provisioner.ensureConfirmed();
      // B has no material and the server has no row for B ⇒ B needs a
      // passphrase of THEIR OWN. The bug this closes would instead have seen
      // A's leftover material in the (formerly shared) slot and silently
      // registered it as B's — never asking B for anything.
      expect(bResult.outcome, BlindStoreProvisionOutcome.needsPassphrase);
      expect(client.puts, 1, reason: "only A's enrolment ever PUT anything");

      // A is completely unaffected by B having logged in on the same phone.
      final ({Uint8List salt, String sentinel}) aStill =
          (await a.keyring.sharedKeyMaterial())!;
      expect(_sameBytes(aStill.salt, aMaterial.salt), isTrue);
      expect(aStill.sentinel, aMaterial.sentinel);
    });

    test('REVERSE CONTROL: the OLD single fixed slot really does leak — same '
        'script, the pre-fix store class, A\'s material appears under B\'s '
        'name', () async {
      // `SecureBlindStoreKeyStore` is kept in the tree on purpose (as the
      // migration SOURCE — see its own file header). Constructing it TWICE,
      // once "as" each account, is exactly what the pre-fix `main.dart` did:
      // one keyring, one fixed slot, no account in the picture at all.
      final BlindStoreKeyring sharedRing = BlindStoreKeyring(
        store: const SecureBlindStoreKeyStore(),
        cost: kFast,
      );
      await sharedRing.enroll('alice-words');
      final ({Uint8List salt, String sentinel}) aMaterial =
          (await sharedRing.sharedKeyMaterial())!;

      // "B logs in" — but the pre-fix code hands B the SAME store, so B's
      // "local material" IS A's.
      final BlindStoreKeyring bAsSeenByOldCode = BlindStoreKeyring(
        store: const SecureBlindStoreKeyStore(),
        cost: kFast,
      );
      final ({Uint8List salt, String sentinel})? whatBSees =
          await bAsSeenByOldCode.sharedKeyMaterial();
      expect(whatBSees, isNotNull,
          reason: 'this is the defect: B sees SOMETHING, and it is not B\'s');
      expect(_sameBytes(whatBSees!.salt, aMaterial.salt), isTrue,
          reason: "the 'something' B sees is byte-for-byte A's salt");
      expect(whatBSees.sentinel, aMaterial.sentinel);
    });

    test('legacy migration ADOPTS when the account\'s OWN server row proves '
        'the bytes — the honest half of the passive recovery path', () async {
      // Simulate a device that enrolled BEFORE this fix (material lives in
      // the old shared slot) and whose PUT already reached the server under
      // account alice — design §3.2 step d's ordinary "PUT succeeded, but we
      // have not re-verified it locally yet" state.
      final BlindStoreKeyring legacyRing = BlindStoreKeyring(
        store: const SecureBlindStoreKeyStore(),
        cost: kFast,
      );
      await legacyRing.enroll('alice-words');
      final ({Uint8List salt, String sentinel}) legacyMaterial =
          (await legacyRing.sharedKeyMaterial())!;
      final FakeKeymetaClient client = FakeKeymetaClient()
        ..row = (salt: legacyMaterial.salt, sentinel: legacyMaterial.sentinel);

      final ({BlindStoreKeyring keyring, BlindStoreKeyProvisioner provisioner})
      alice = accountOn(client, 'alice@example.com');
      expect(await alice.keyring.sharedKeyMaterial(), isNull,
          reason: "alice's OWN scoped slot starts empty (only the legacy "
              'slot holds anything)');

      final BlindStoreProvisionResult r = await alice.provisioner.ensureConfirmed();

      expect(r.outcome, BlindStoreProvisionOutcome.confirmed);
      expect(client.puts, 0, reason: 'a proven match adopts — it never re-PUTs');
      final ({Uint8List salt, String sentinel}) migrated =
          (await alice.keyring.sharedKeyMaterial())!;
      expect(_sameBytes(migrated.salt, legacyMaterial.salt), isTrue);
      expect(migrated.sentinel, legacyMaterial.sentinel);
      // First prover wins: the shared slot is retired so nobody else can also
      // claim these bytes later.
      expect(await const SecureBlindStoreKeyStore().read(), isNull);
    });

    test('legacy migration REFUSES when there is no server row at all — "no '
        'row" is not proof, it is exactly the gap this fix closes', () async {
      final BlindStoreKeyring legacyRing = BlindStoreKeyring(
        store: const SecureBlindStoreKeyStore(),
        cost: kFast,
      );
      await legacyRing.enroll('orphaned-words');
      final ({Uint8List salt, String sentinel}) orphan =
          (await legacyRing.sharedKeyMaterial())!;
      final FakeKeymetaClient client = FakeKeymetaClient(); // no row anywhere

      final ({BlindStoreKeyring keyring, BlindStoreKeyProvisioner provisioner})
      bob = accountOn(client, 'bob@example.com');

      final BlindStoreProvisionResult r = await bob.provisioner.ensureConfirmed();

      expect(r.outcome, BlindStoreProvisionOutcome.needsPassphrase);
      expect(client.puts, 0, reason: 'unproven material must never be PUT '
          'under a name it was never shown to belong to');
      expect(await bob.keyring.sharedKeyMaterial(), isNull,
          reason: "bob's own slot must stay empty");
      // The orphaned material is left exactly where it was — "kept aside",
      // not deleted, not adopted, still readable by whoever CAN prove it.
      final BlindStoreKeyMaterial? stillThere =
          await const SecureBlindStoreKeyStore().read();
      expect(stillThere, isNotNull);
      expect(_sameBytes(stillThere!.salt, orphan.salt), isTrue);
    });

    test('legacy migration REFUSES when the server row belongs to someone '
        'else', () async {
      final BlindStoreKeyring legacyRing = BlindStoreKeyring(
        store: const SecureBlindStoreKeyStore(),
        cost: kFast,
      );
      await legacyRing.enroll('legacy-words');
      final ({Uint8List salt, String sentinel}) legacyMaterial =
          (await legacyRing.sharedKeyMaterial())!;
      final ({BlindStoreKeyring ring, Uint8List salt, String sentinel})
      someoneElse = await _otherDevice('someone elses words');
      final FakeKeymetaClient client = FakeKeymetaClient()
        ..row = (salt: someoneElse.salt, sentinel: someoneElse.sentinel);

      final ({BlindStoreKeyring keyring, BlindStoreKeyProvisioner provisioner})
      carol = accountOn(client, 'carol@example.com');

      final BlindStoreProvisionResult r = await carol.provisioner.ensureConfirmed();

      expect(r.outcome, BlindStoreProvisionOutcome.needsPassphrase);
      expect(await carol.keyring.sharedKeyMaterial(), isNull);
      final BlindStoreKeyMaterial? stillThere =
          await const SecureBlindStoreKeyStore().read();
      expect(_sameBytes(stillThere!.salt, legacyMaterial.salt), isTrue,
          reason: 'untouched — carol proved nothing about it');
    });
  });
}
