// v0.2.4 — "is this the same phone / the same PC", asserted on both halves.
//
// owner 2026-07-29:「PC 端要有一个唯一的实例名或 ID 来区分是否同一 PC，手机也是，
// 手机在外部网络是通过云端中继来访问，如外出办公，在内网环境使用本地局域网环境，但
// 应能明确知道是否都是同一台手机和同一台 PC」.
//
// Two things are under test and they fail differently, which is why both are
// here rather than only the visible one:
//
//   · [deviceUid] is the phone's OWN identity, sent on mobile:pair. The server
//     reuses a pairing row when it matches, so a uid that is unstable mints
//     duplicates (the 0.2.3 bug returning) and a uid that is SHARED merges two
//     real handsets into one row (worse, and silent).
//   · [groupPairingsByMachine] is a display rule, and its failure mode is a
//     confident lie: two rows drawn as "the same PC" that are not.

import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/session/device_label.dart';
import 'package:flowmic/src/session/machine_group.dart';
import 'package:flutter_test/flutter_test.dart';

MobileSession _row({
  required String token,
  String? machineUid,
  String channel = 'standalone',
  String? pcName = 'Studio PC',
  String? alias,
}) => MobileSession(
  token: token,
  endpoint: 'http://192.168.1.5:41879',
  channel: channel,
  pcName: pcName,
  displayAlias: alias,
  pcMachineUid: machineUid,
);

void main() {
  group('deviceUid — the handset key', () {
    test('is stable for one seed and differs between seeds', () {
      // Stability is the whole reason it exists: ANDROID_ID survives an APK
      // reinstall, which is precisely the case that used to mint a second row.
      expect(deviceUid('android-id-aaaa'), deviceUid('android-id-aaaa'));
      expect(deviceUid('android-id-aaaa'), isNot(deviceUid('android-id-bbbb')));
    });

    test('matches the protocol shape so the server does not silently drop it', () {
      // protocol-primitives.ts DeviceUid = /^[a-z]{2}-[0-9a-f]{16,48}$/ with
      // `.catch(undefined)` — a malformed uid is DISCARDED at the boundary and
      // nothing anywhere says so. Asserting the shape here is what makes that
      // silence safe.
      final String uid = deviceUid('android-id-aaaa')!;
      expect(RegExp(r'^[a-z]{2}-[0-9a-f]{16,48}$').hasMatch(uid), isTrue, reason: uid);
      expect(uid.startsWith('mb-'), isTrue, reason: 'never confusable with a PC uid');
      expect(uid.length, 3 + 16);
    });

    test('a phone with no device id claims NOTHING, not a placeholder', () {
      // A constant fallback would be identical on every phone that also has no
      // id — and the server keys row reuse on this, so it would merge
      // strangers. Null degrades to the 0.2.3 behaviour (match on name), which
      // is a path that already works.
      expect(deviceUid(null), isNull);
      expect(deviceUid(''), isNull);
      expect(deviceUid('   '), isNull);
    });

    test('the raw ANDROID_ID never appears in the uid', () {
      // The privacy claim, asserted rather than asserted-in-a-comment.
      const String seed = 'a1b2c3d4e5f60718';
      expect(deviceUid(seed)!.contains(seed), isFalse);
    });

    test('the two halves are not the same 8 hex characters twice', () {
      // The construction is two DOMAIN-SEPARATED FNV-1a 32s. If the separation
      // were ever dropped the uid would be one 32-bit value repeated — 16 hex
      // characters that carry 32 bits — and the collision headroom this exists
      // for would be gone with nothing visibly different.
      final String hex = deviceUid('android-id-aaaa')!.substring(3);
      expect(hex.substring(0, 8), isNot(hex.substring(8)));
    });
  });

  group('groupPairingsByMachine — "the same PC"', () {
    test('two rows sharing a uid become ONE group that keeps both rows', () {
      final List<MachineGroup> g = groupPairingsByMachine(<MobileSession>[
        _row(token: 'a', machineUid: 'pc-00112233445566aa'),
        _row(token: 'b', machineUid: 'pc-00112233445566aa'),
      ]);
      expect(g, hasLength(1));
      expect(g.single.isShared, isTrue);
      expect(g.single.rows.map((MobileSession r) => r.token), <String>['a', 'b']);
    });

    test('a null uid groups with nothing — including another null', () {
      final List<MachineGroup> g = groupPairingsByMachine(<MobileSession>[
        _row(token: 'a'),
        _row(token: 'b'),
      ]);
      expect(g, hasLength(2));
      expect(g.every((MachineGroup x) => !x.isShared), isTrue);
    });

    test('a blank uid is treated as absent, not as a key', () {
      // Otherwise two rows stamped with '' would fuse. Trimmed, so '  ' too.
      final List<MachineGroup> g = groupPairingsByMachine(<MobileSession>[
        _row(token: 'a', machineUid: ''),
        _row(token: 'b', machineUid: '   '),
      ]);
      expect(g, hasLength(2));
    });

    test('the cloud instance is never grouped, even if a uid arrives on it', () {
      // It is a virtual PC row on the server, not a machine — "the same PC"
      // would be a category error, not merely a wrong value.
      final List<MachineGroup> g = groupPairingsByMachine(<MobileSession>[
        _row(token: 'a', machineUid: 'pc-00112233445566aa'),
        _row(token: 'c', machineUid: 'pc-00112233445566aa', channel: 'saas'),
      ]);
      expect(g, hasLength(2));
      expect(g.first.rows.single.token, 'a');
      expect(g.last.machineUid, isNull);
    });

    test('groups sit where their FIRST-listed member was', () {
      // The list is most-recent-first. A computer used moments ago must not
      // sink to the bottom because its other channel is stale.
      final List<MachineGroup> g = groupPairingsByMachine(<MobileSession>[
        _row(token: 'newest', machineUid: 'pc-aaaaaaaaaaaaaaaa'),
        _row(token: 'other', machineUid: 'pc-bbbbbbbbbbbbbbbb'),
        _row(token: 'older-same', machineUid: 'pc-aaaaaaaaaaaaaaaa'),
      ]);
      expect(g, hasLength(2));
      expect(g.first.rows.map((MobileSession r) => r.token), <String>['newest', 'older-same']);
      expect(g.last.rows.single.token, 'other');
    });

    test('the group label prefers a user alias over the device name', () {
      // A phone-local rename never leaves this device, so a header labelled
      // with the raw device name would contradict the rows under it.
      final List<MachineGroup> g = groupPairingsByMachine(<MobileSession>[
        _row(token: 'a', machineUid: 'pc-aaaaaaaaaaaaaaaa'),
        _row(token: 'b', machineUid: 'pc-aaaaaaaaaaaaaaaa', alias: '家里那台'),
      ]);
      expect(machineGroupLabel(g.single), '家里那台');
    });

    test('a group whose rows name nothing falls back rather than showing blank', () {
      final List<MachineGroup> g = groupPairingsByMachine(<MobileSession>[
        _row(token: 'a', machineUid: 'pc-aaaaaaaaaaaaaaaa', pcName: null),
        _row(token: 'b', machineUid: 'pc-aaaaaaaaaaaaaaaa', pcName: '  '),
      ]);
      expect(machineGroupLabel(g.single, fallback: 'PC'), 'PC');
    });

    test('an empty list is an empty list (no phantom group)', () {
      expect(groupPairingsByMachine(const <MobileSession>[]), isEmpty);
    });
  });

  group('MobileSession — the machine uid survives a storage round-trip', () {
    test('written and read back through toJson/fromJson', () {
      // It is persisted, so a phone that has not reconnected since the ack must
      // still be able to group. A field that only lived in memory would make
      // the header appear and disappear across app launches.
      final MobileSession s = _row(token: 'a' * 32, machineUid: 'pc-00112233445566aa');
      final MobileSession? back = MobileSession.fromJson(s.toJson());
      expect(back!.pcMachineUid, 'pc-00112233445566aa');
    });

    test('a row stored before the field existed reads back null, not empty', () {
      final MobileSession? back = MobileSession.fromJson(<String, Object?>{
        'token': 'a' * 32,
        'endpoint': 'http://192.168.1.5:41879',
      });
      expect(back!.pcMachineUid, isNull);
    });
  });
}
