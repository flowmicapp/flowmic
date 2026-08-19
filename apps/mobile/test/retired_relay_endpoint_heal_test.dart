// Inventory card A1 — a phone that paired over the cloud BEFORE the relay moved
// hosts (2026-08-17) stores an address that no longer serves, re-dials it
// forever, and has no way back except delete-and-re-pair. The desktop already
// heals itself (apps/desktop/src-tauri/src/socket/cloud_endpoint.rs
// `plan_migration`); this file pins the phone's mirror of that rule.
//
// 🔴 WHAT THESE ASSERTIONS ARE ABOUT: THE VALUE ON DISK AFTER A ROUND TRIP.
// A heal that only fixed the object handed back would still leave the retired
// address in secure storage for the life of the install, so `readPairings()` is
// driven through a REAL `SecureTokenStorage` over a map this file owns, and that
// map is read back afterwards. Asserting「the healer was called」or「the returned
// session looks right」would both stay green against that broken half.
//
// 🔴 REVERSE CONTROL — RUN IN THIS WINDOW AND OBSERVED RED. The rewrite in
// `MobileSession.fromJson` was reverted by hand to `endpoint: e` (the code
// exactly as it stood before this card) and this file re-run. The reading,
// verbatim except for ONE marked elision (see below):
//
//   00:01 +9 -1: the round trip: what is left ON DISK a SHIPPED retired address
//   is healed and the stored bytes change [E]
//     Expected: 'https://flowmic.app'
//       Actual: 'https://<RETIRED>'
//      Which: is different.
//     the object handed back
//   00:01 +10 -2: the round trip: what is left ON DISK nothing else on the row
//   is disturbed by a heal [E]
//   00:01 +10 -3: the round trip: what is left ON DISK
//   legacy_row_channel_inference_reads_the_raw_address [E]
//   00:01 +10 -3: Some tests failed.
//
// ⚠️ THE ELISION IS DELIBERATE AND IS THE ONLY EDIT. `<RETIRED>` stands for the
// one host in `kLegacySaasEndpoints`; the run printed it in full. It is elided
// for the same reason cloud_endpoint.rs's tests use a fictional name — the
// owner ruled that domain out of the project (decision 2026-08-17), and a
// pasted log is not a product need. Restored by hand and re-verified: 13
// passed; `grep REVERSE-CONTROL` finds nothing under apps/mobile/lib.
//
// 🔴 AND THE HALF OF THIS CONTROL THAT DID NOT FIRE, WHICH IS WORTH MORE THAN
// THE HALF THAT DID. Three of the four disk tests went red; the fourth —「a
// second read writes nothing further」— stayed GREEN with the fix removed,
// because it compares one read against the next and both were equally
// unhealed. It cannot tell「healed once, then stable」from「never healed at
// all」, and on its own it would have certified this defect as fixed. It is
// kept (idempotency is a real property, and it is what stops a rewrite loop)
// but it is NOT evidence that anything moves: the three named above are.
//
// ⚠️ THE FIXTURES ARE RFC 2606 `.example` NAMES, ON PURPOSE, exactly as
// cloud_endpoint.rs's tests are. The rule is domain-agnostic — it compares a
// stored value against a list handed to it — so a fixture naming the real
// retired host would be testing the fixture rather than the mechanism, and
// would put a domain the owner retired back into a file with no product need
// for it. The tests that must drive the REAL shipped list do so without naming
// it, by iterating `kLegacySaasEndpoints`.

import 'dart:convert';

import 'package:flowmic/src/auth/saas_endpoint.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/signaling/lan_tls_fingerprint.dart' show kLanTlsFpChars;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

/// A fictional retired host and a fictional third-party relay. Neither can ever
/// resolve (RFC 2606 reserves `.example`), which is what makes them safe to
/// write down — and neither is in the shipped list, which is what makes them
/// usable as negative controls.
const String kFictionalRetired = 'https://relay.retired.example';
const String kSelfHosted = 'https://relay.example';

const String kSessionKey = 'flowmic.mobile.session.v2';

/// One persisted row, in the shape the v2 secure-storage key actually holds.
Map<String, Object?> rowFor(String endpoint, {String channel = 'saas'}) =>
    <String, Object?>{
      'token': 'tok-0123456789abcdef0123456789abcdef',
      'endpoint': endpoint,
      'channel': channel,
      'pc_instance_id': 'inst-1',
    };

/// Seed secure storage with [rows] and hand back both the store and the map it
/// is backed by, so a test can read the BYTES afterwards rather than the
/// objects. `setMockInitialValues` keeps a reference to this very map, and
/// `SecureTokenStorage._persist` writes through to it.
(SecureTokenStorage, Map<String, String>) storeHolding(
  List<Map<String, Object?>> rows,
) {
  final Map<String, String> disk = <String, String>{
    kSessionKey: jsonEncode(rows),
  };
  FlutterSecureStorage.setMockInitialValues(disk);
  return (SecureTokenStorage(), disk);
}

String? storedEndpoint(Map<String, String> disk, {int at = 0}) {
  final Object? raw = jsonDecode(disk[kSessionKey]!);
  return ((raw as List<Object?>)[at]! as Map<String, Object?>)['endpoint']
      as String?;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('the rule (mirrors cloud_endpoint.rs plan_migration, decision for decision)', () {
    test('a retired address heals to the canonical one', () {
      expect(
        planRetiredSaasEndpointHeal(
          kFictionalRetired,
          legacy: const <String>[kFictionalRetired],
        ),
        kDefaultSaasEndpoint,
      );
    });

    // 🔴 THE CONTROL THAT GUARDS THE DANGEROUS DIRECTION, and the reason the
    // rule is value equality rather than「anything that is not canonical」. A
    // pairing's endpoint is not always ours: `addByCode` stores whatever address
    // the user typed or scanned, and a private build points `resolveSaasEndpoint`
    // at its own relay on purpose. Rewriting one of these would take a working
    // install off its own server — a worse bug than the one being fixed.
    test('a self-hosted or third-party endpoint is never rewritten', () {
      for (final String host in <String>[
        kSelfHosted,
        'http://192.0.2.9:41879',
        'https://relay.retired.example.evil.test',
        // A build-time override: whatever `--dart-define=FLOWMIC_SAAS_ENDPOINT`
        // names, it is not in the retired list, so it is not this rule's
        // business either.
        'https://private-build.example',
      ]) {
        expect(
          planRetiredSaasEndpointHeal(
            host,
            legacy: const <String>[kFictionalRetired],
          ),
          isNull,
          reason: '$host must be left alone',
        );
      }
    });

    test('a trailing slash, surrounding space or different case still matches', () {
      for (final String stored in <String>[
        '$kFictionalRetired/',
        '$kFictionalRetired///',
        'HTTPS://Relay.Retired.Example',
        '  $kFictionalRetired  ',
      ]) {
        expect(
          planRetiredSaasEndpointHeal(
            stored,
            legacy: const <String>[kFictionalRetired],
          ),
          kDefaultSaasEndpoint,
          reason: '$stored must heal',
        );
      }
    });

    test('a different scheme or a subdomain is NOT a match', () {
      for (final String stored in <String>[
        'http://relay.retired.example',
        'https://www.relay.retired.example',
        'https://api.relay.retired.example',
      ]) {
        expect(
          planRetiredSaasEndpointHeal(
            stored,
            legacy: const <String>[kFictionalRetired],
          ),
          isNull,
          reason: '$stored is not the listed value',
        );
      }
    });

    test('blank stored, blank canonical and a blank list entry all do nothing', () {
      // Never configured ⇒ unchanged behaviour, not "helpfully" filled in.
      expect(
        planRetiredSaasEndpointHeal('', legacy: const <String>[kFictionalRetired]),
        isNull,
      );
      expect(
        planRetiredSaasEndpointHeal('   ', legacy: const <String>[kFictionalRetired]),
        isNull,
      );
      // Never rewrite a real endpoint into nothing.
      expect(
        planRetiredSaasEndpointHeal(
          kFictionalRetired,
          canonical: '   ',
          legacy: const <String>[kFictionalRetired],
        ),
        isNull,
      );
      // A malformed list must never become a wildcard.
      expect(
        planRetiredSaasEndpointHeal(kSelfHosted, legacy: const <String>['', '  ']),
        isNull,
      );
    });

    test('the canonical value is left alone even if the list wrongly contains it', () {
      // The second line of defence against an entry that would migrate onto
      // itself forever; the first is the shipped-list assertion below.
      expect(
        planRetiredSaasEndpointHeal(
          kDefaultSaasEndpoint,
          legacy: const <String>[kDefaultSaasEndpoint, '$kDefaultSaasEndpoint/'],
        ),
        isNull,
      );
    });
  });

  group('the shipped list', () {
    // Drives the REAL default list without naming its contents — that is the
    // point of the loop. An empty list is a legitimate value (a build that is
    // not our hosted service has retired nothing), which makes this vacuous
    // rather than red there; see the declaration's note on deployment data.
    test('every entry is in normal form, is an absolute URL, and heals', () {
      for (final String entry in kLegacySaasEndpoints) {
        expect(entry, entry.trim().toLowerCase(), reason: 'normal form');
        expect(entry.endsWith('/'), isFalse, reason: 'no trailing slash');
        expect(entry, matches(RegExp(r'^https?://[^/]+$')));
        expect(
          entry,
          isNot(kDefaultSaasEndpoint),
          reason: 'an entry equal to the canonical value would never converge',
        );
        expect(planRetiredSaasEndpointHeal(entry), kDefaultSaasEndpoint);
      }
    });

    // 🔴 THERE IS DELIBERATELY NO「the list is not empty」ASSERTION HERE, and
    // that is a decision rather than an omission. Empty is the CORRECT value in
    // an exported tree (a build that is not our hosted service has retired
    // nothing), so such an assertion would ship a test that is red out of the
    // box — the shape verify/lint/oss-absent-sweep's own header warns about:
    // "a lint that is red on a tree the exporter accepts is a lint somebody
    // switches off within a week".
    //
    // The question it would have asked IS answered, twice, and neither answer is
    // a copy of the other:
    //   · that OUR list is non-empty — packages/protocol/test/saas-endpoints
    //     .test.ts, 'is not empty (an empty list makes the migration a no-op
    //     nobody would notice)', which the export strips for exactly this reason;
    //   · that the Dart list equals the TypeScript one — BY CONSTRUCTION, not by
    //     assertion: `kLegacySaasEndpoints` IS the generated value
    //     (tool/gen_protocol.mjs `readLegacySaasEndpoints`), so no hand copy
    //     survives that could drift and there is nothing here to guard.
  });

  // ⚠️ THE `for (… in kLegacySaasEndpoints)` LOOPS BELOW ARE VACUOUS IN AN
  // EXPORTED TREE, and stating it is cheaper than someone discovering it. There
  // the generated list is `[]`, so those bodies never run — which is correct,
  // because there is nothing to heal in a build that has retired nothing. What
  // still runs everywhere, and carries the weight there, is the whole first
  // group: the rule itself, driven with `.example` fixtures.
  group('the round trip: what is left ON DISK', () {
    // 🔴 STATED FIRST ON PURPOSE. Without it, "an unknown host was rewritten"
    // and "the retired host was rewritten" are the same green.
    test('an address that is NOT in the shipped list is left alone, bytes included',
        () async {
      final (SecureTokenStorage store, Map<String, String> disk) =
          storeHolding(<Map<String, Object?>>[rowFor(kFictionalRetired)]);
      final String before = disk[kSessionKey]!;

      final List<MobileSession> got = await store.readPairings();

      expect(got.single.endpoint, kFictionalRetired);
      expect(
        disk[kSessionKey],
        before,
        reason: 'an untouched row must not even be rewritten',
      );
    });

    test('a self-hosted row survives a read unchanged', () async {
      final (SecureTokenStorage store, Map<String, String> disk) =
          storeHolding(<Map<String, Object?>>[
        rowFor(kSelfHosted, channel: 'standalone'),
      ]);
      final String before = disk[kSessionKey]!;

      final List<MobileSession> got = await store.readPairings();

      expect(got.single.endpoint, kSelfHosted);
      expect(disk[kSessionKey], before);
    });

    test('a SHIPPED retired address is healed and the stored bytes change',
        () async {
      for (final String retired in kLegacySaasEndpoints) {
        final (SecureTokenStorage store, Map<String, String> disk) =
            storeHolding(<Map<String, Object?>>[rowFor(retired)]);

        final List<MobileSession> got = await store.readPairings();

        expect(
          got.single.endpoint,
          kDefaultSaasEndpoint,
          reason: 'the object handed back',
        );
        expect(
          storedEndpoint(disk),
          kDefaultSaasEndpoint,
          reason: 'the stored bytes still name the retired host',
        );
        expect(
          disk[kSessionKey]!.contains(retired),
          isFalse,
          reason: 'nothing anywhere in the persisted row may still carry it',
        );
      }
    });

    test('a second read writes nothing further (idempotent by construction)',
        () async {
      for (final String retired in kLegacySaasEndpoints) {
        final (SecureTokenStorage store, Map<String, String> disk) =
            storeHolding(<Map<String, Object?>>[rowFor(retired)]);
        await store.readPairings();
        final String afterFirst = disk[kSessionKey]!;
        await store.readPairings();
        expect(disk[kSessionKey], afterFirst);
      }
    });

    test('nothing else on the row is disturbed by a heal', () async {
      for (final String retired in kLegacySaasEndpoints) {
        final Map<String, Object?> full = <String, Object?>{
          ...rowFor(retired),
          'pc_machine_uid': 'uid-9',
          'pc_id': 'pc-9',
          'pairing_id': 'pair-9',
          'pc_name': 'Study desktop',
          'display_alias': 'the one at home',
          'last_connected_at': '2026-08-15T10:00:00.000Z',
          'endpoint_candidates': <String>[kSelfHosted],
          'lan_tls_fp': 'A' * kLanTlsFpChars,
        };
        final (SecureTokenStorage store, Map<String, String> _) =
            storeHolding(<Map<String, Object?>>[full]);

        final MobileSession got = (await store.readPairings()).single;

        expect(got.endpoint, kDefaultSaasEndpoint);
        expect(got.token, full['token']);
        expect(got.pcMachineUid, 'uid-9');
        expect(got.pairingId, 'pair-9');
        expect(got.pcName, 'Study desktop');
        expect(got.displayAlias, 'the one at home');
        expect(got.lastConnectedAt, DateTime.utc(2026, 8, 15, 10));
        // The candidate list is deliberately NOT healed: it is written from the
        // pairing QR's `alt=` (the PC's own NICs) and a relay pairing has a
        // single candidate, so it cannot hold a retired host. Were one ever to
        // appear there, the ladder still never moves onto it —
        // `resolveLadderUrl` (session/endpoint_candidates.dart) refuses unless
        // `current` is itself in the list, and after a heal it is not.
        expect(got.endpointCandidates, <String>[kSelfHosted]);
        // Credential-grade: a migration is exactly the kind of event a pin has
        // to survive untouched.
        expect(got.lanTlsFp, 'A' * kLanTlsFpChars);
      }
    });

    test('legacy_row_channel_inference_reads_the_raw_address', () async {
      for (final String retired in kLegacySaasEndpoints) {
        // A row so old it predates the `channel` field. `_inferChannel` must see
        // the address that was ACTUALLY stored: inferring from the healed value
        // would flip this row to 'saas', which means「this peer is the virtual
        // cloud instance」and is a different claim entirely.
        final Map<String, Object?> ancient = <String, Object?>{
          'token': 'tok-0123456789abcdef0123456789abcdef',
          'endpoint': retired,
        };
        final (SecureTokenStorage store, Map<String, String> disk) =
            storeHolding(<Map<String, Object?>>[ancient]);

        final MobileSession got = (await store.readPairings()).single;

        expect(got.endpoint, kDefaultSaasEndpoint);
        expect(got.channel, 'standalone');
        expect(storedEndpoint(disk), kDefaultSaasEndpoint);
      }
    });
  });
}
