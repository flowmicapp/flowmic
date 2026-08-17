// 「这台电脑现在属于另一个账号」 ("this computer now belongs to a different
// account") really arrives from the WIRE and reaches the word the list prints.
// The other half — that the word reaches the screen — is
// pc_other_account_render_test.dart.
//
// SPEC-REF:
//   apps/server-core/src/room/machine-reassigned.ts (the reason, derived at read
//     time, and why it is not a member of the stored `PC_ABSENT_REASONS`)
//   apps/server-core/src/http/presence-routes.ts (`pc_absent_reason` on the wire)
//   apps/mobile/lib/src/session/pc_presence.dart
//     ([PcAbsentReason.machineReassigned] / [InstanceLivenessFace.pcOtherAccount])
//   apps/server-core/test/pc-machine-reassigned.test.ts (the server's own half)
//
// 🔴 THE DEFECT (production, 2026-08-17). `pc_devices` held NINE rows for one
// machine — one per account that ever registered it — and the phone's pairing
// resolved to the row abandoned when the desktop signed into a different
// account. The phone said 「电脑已离线」 while the desktop said it was connected.
// Both were telling the truth about different rooms. The user was sent to check
// a machine that was powered on, running, and fine.
//
// 🔴 WHY THIS FILE IS SEPARATE FROM THE RENDER TEST, and it is not a
// preference: `TestWidgetsFlutterBinding` installs HttpOverrides for the whole
// SUITE, so one `testWidgets` anywhere in a file turns every `HttpClient` in it
// into a double. pc_signed_out_wire_test.dart's header records the two
// occasions this repo paid for that. ⇒ bare `test`, a real loopback
// `HttpServer`, a real `HttpClient`, and therefore a real answer to 「我们读的
// 到底是不是线上那个字段」 ("is it really the field on the wire that we read").
//
// ── REVERSE CONTROL (executed 2026-08-17, observed — not reasoned) ──────────
// Break: in `PcAbsentReason.parse` (pc_presence.dart), delete the
// `'machine_reassigned' => PcAbsentReason.machineReassigned` arm — the enum
// member still exists, the face still exists, the copy still exists, and the
// wire value simply stops being recognised (i.e. the state every phone released
// before this card is in).
// Observed — 2 pass / 3 FAIL:
//   'the probe reads machine_reassigned off a REAL server response'
//     Expected: <PcAbsentReason.machineReassigned>   Actual: <null>
//   'wire to face: a machine_reassigned absence becomes pcOtherAccount'
//     Expected: <PcAbsentReason.machineReassigned>   Actual: <null>
//     (fails at its `pcAbsentReasonOf` line, one assertion BEFORE the face
//      comparison)
//   'an unknown reason string is still null, never a guess'
//     Expected: <PcAbsentReason.machineReassigned>   Actual: <null>
// ⚠️ The prediction written here first said TWO would fail. Three did — the
// third is the case whose closing line asserts that the KNOWN string parses,
// which is exactly the assertion a 「never a guess」 test needs so that it cannot
// be satisfied by a parser that returns null for everything. Recorded as
// observed rather than as predicted: a reverse control is only evidence if what
// is written down is what happened, and this repo has corrected the same slip
// once before (pc_signed_out_wire_test.dart §head).
// 🔴 Both survivors are the negative controls, which is the correct shape: an
// unrecognised reason must degrade to the plain 「offline」 sentence, and under
// the break it does. That is the same degradation an OLD phone performs against
// a NEW relay, so this run doubles as the compatibility measurement.
// Restored, re-run: 5/5 green.

import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// The relay's answer for a PC that is absent BECAUSE the machine behind it is
/// in a room under another account — the exact shape `presence-routes.ts`
/// builds when `isMachineServingAnotherAccount` says yes.
const Map<String, Object?> _absentReassigned = <String, Object?>{
  'ok': true,
  'pc_id': 'pc-1',
  'pc_online': false,
  'pc_absent_reason': 'machine_reassigned',
};

/// The same absence with NO reason — a machine that is simply switched off.
/// `pc_absent_reason` is OMITTED, not null, and the server test pins that too.
const Map<String, Object?> _absentNoReason = <String, Object?>{
  'ok': true,
  'pc_id': 'pc-1',
  'pc_online': false,
};

MobileSession _seeded(String endpoint) => MobileSession(
  token: 'tok-seeded-00000000000000000000',
  endpoint: endpoint,
  channel: 'standalone',
  pcName: 'Studio PC',
  pairingId: 'pair-seed',
  pcId: 'pc-1',
);

Future<HealthReading> _relayReachable(Uri url, Duration timeout) async =>
    const HealthReading(ok: true, channel: ServerChannel.cloudRelay);

Future<ConnectionsController> _controller(String endpoint) async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final InMemoryTokenStorage storage = InMemoryTokenStorage();
  await storage.addOrUpdatePairing(_seeded(endpoint));
  final PttSession session = PttSession(
    transport: FakeSocketTransport(),
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    tokenStorage: storage,
    retireTransport: () => FakeSocketTransport(),
  );
  return ConnectionsController(
    session: session,
    login: newTestLogin(transport: session.transport),
    healthReader: _relayReachable,
    // 🔴 No presence double: null routes to the PRODUCTION probe, which is the
    // whole point of this file.
  );
}

Future<({String url, HttpServer server})> _serve(Map<String, Object?> body) async {
  final HttpServer server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((HttpRequest req) {
    req.response
      ..statusCode = 200
      ..write(jsonEncode(body));
    req.response.close();
  });
  return (url: 'http://127.0.0.1:${server.port}', server: server);
}

void main() {
  test('🔴 the probe reads machine_reassigned off a REAL server response', () async {
    final s = await _serve(_absentReassigned);
    addTearDown(() => s.server.close(force: true));
    final PcPresenceReading r = await httpPcPresenceRead(
      Uri.parse('${s.url}/api/pc/presence'),
      'tok',
      const Duration(seconds: 3),
    );
    // The absence itself is unchanged: that room really is empty.
    expect(r.presence, PcPresence.offline);
    expect(r.absentReason, PcAbsentReason.machineReassigned);
  });

  test('🔴 wire to face: a machine_reassigned absence becomes pcOtherAccount', () async {
    final s = await _serve(_absentReassigned);
    addTearDown(() => s.server.close(force: true));
    final ConnectionsController c = await _controller(s.url);
    await c.load();
    await c.refreshReachability();

    final MobileSession p = c.pairings.single;
    expect(c.presenceOf(p), PcPresence.offline);
    expect(c.pcAbsentReasonOf(p), PcAbsentReason.machineReassigned);

    // 🔴 Nothing above named `machineReassigned` on the way IN. It came off a
    // real socket, through the production parser, into the controller's own
    // table, and out as the word the page will print.
    expect(
      instanceLivenessFaceOf(
        reach: InstanceReach.online,
        answeringChannel: ServerChannel.cloudRelay,
        target: InstanceTarget.pc,
        pcPresence: c.presenceOf(p),
        pcAbsentReason: c.pcAbsentReasonOf(p),
      ),
      InstanceLivenessFace.pcOtherAccount,
    );
  });

  test('🔴 THE DISTINCTION: the same absence WITHOUT a reason still says pcOffline', () async {
    // The negative control, and the one that matters most on this card. Without
    // it, 「it says the machine changed accounts」 could be true of EVERY absent
    // PC — and that implementation is worse than the defect, because it would
    // tell everyone whose computer is simply switched off to go and re-pair.
    final s = await _serve(_absentNoReason);
    addTearDown(() => s.server.close(force: true));
    final ConnectionsController c = await _controller(s.url);
    await c.load();
    await c.refreshReachability();

    final MobileSession p = c.pairings.single;
    expect(c.presenceOf(p), PcPresence.offline);
    expect(c.pcAbsentReasonOf(p), isNull);
    expect(
      instanceLivenessFaceOf(
        reach: InstanceReach.online,
        answeringChannel: ServerChannel.cloudRelay,
        target: InstanceTarget.pc,
        pcPresence: c.presenceOf(p),
        pcAbsentReason: c.pcAbsentReasonOf(p),
      ),
      InstanceLivenessFace.pcOffline,
    );
  });

  test('an unknown reason string is still null, never a guess', () {
    // The set grew by one; the rule did not change. A reason a build does not
    // know must fall back to the sentence it already had — never to a confident
    // sentence about a cause it invented.
    for (final Object? raw in <Object?>[
      'machine_reassigned_v2',
      'machine reassigned',
      'MACHINE_REASSIGNED',
      '',
      7,
      null,
    ]) {
      expect(PcAbsentReason.parse(raw), isNull, reason: '$raw');
    }
    expect(PcAbsentReason.parse('machine_reassigned'), PcAbsentReason.machineReassigned);
    // The member that was already there is untouched.
    expect(PcAbsentReason.parse('auth_expired'), PcAbsentReason.authExpired);
  });

  test('🔴 the reason cannot make an ONLINE row absent', () async {
    // The server only ever sends a reason alongside `pc_online:false` — but the
    // phone must not depend on that promise, because a reason arriving next to
    // `true` would otherwise be a value able to overrule a measurement.
    final s = await _serve(<String, Object?>{
      'ok': true,
      'pc_id': 'pc-1',
      'pc_online': true,
      'pc_absent_reason': 'machine_reassigned',
    });
    addTearDown(() => s.server.close(force: true));
    final PcPresenceReading r = await httpPcPresenceRead(
      Uri.parse('${s.url}/api/pc/presence'),
      'tok',
      const Duration(seconds: 3),
    );
    expect(r.presence, PcPresence.online);
    expect(
      instanceLivenessFaceOf(
        reach: InstanceReach.online,
        answeringChannel: ServerChannel.cloudRelay,
        target: InstanceTarget.pc,
        pcPresence: r.presence,
        pcAbsentReason: r.absentReason,
      ),
      InstanceLivenessFace.pcOnline,
    );
  });
}
