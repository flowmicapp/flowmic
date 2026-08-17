// 「那台电脑开着，只是云端登录失效了」 ("that computer is on — its cloud sign-in
// just lapsed") really arrives from the WIRE and reaches the word the list
// prints. The other half — that the word reaches the screen — is
// pc_signed_out_render_test.dart.
//
// SPEC-REF:
//   apps/server-core/src/room/pc-absence.ts (`PC_ABSENT_REASONS`, one member)
//   apps/server-core/src/http/presence-routes.ts (`pc_absent_reason` on the wire)
//   apps/mobile/lib/src/session/pc_presence.dart
//     ([PcAbsentReason] / [InstanceLivenessFace.pcSignedOut])
//
// 🔴 THE DEFECT. `pc_absent_reason` has been on the wire the whole time and the
// phone had ZERO consumers of it — the probe parsed `ok`, `pc_online`, `pc_id`
// and dropped the rest on the floor. So the one absence whose correct action is
// NOT 「去把电脑打开」 ("go turn the computer on") was rendered with exactly that
// sentence, and the user went to look at a computer that was powered on,
// running fine, and had nothing wrong with it. The ten-second fix — re-enter
// the Cloud Key over there — was named nowhere on the screen.
//
// 🔴 WHY THIS FILE IS SEPARATE FROM THE RENDER TEST, and it is not a
// preference. `TestWidgetsFlutterBinding` installs HttpOverrides for the whole
// SUITE, so one `testWidgets` anywhere in a file turns every `HttpClient` in it
// into a double — measured here, not assumed: with the two halves in one file
// the real-server tests came back `PcPresence.unknown` because the dial never
// left the fake layer. pc_presence_probe_test.dart's header states the same
// rule, and this file is the second time the repo has paid for it.
//
// ⇒ this file: bare `test`, a real loopback `HttpServer`, a real `HttpClient`,
// and therefore a real answer to 「我们读的到底是不是线上那个字段」 ("is it
// really the field on the wire that we read").
//
// ── REVERSE CONTROL (executed 2026-08-16, observed — not reasoned) ──────────
// Break: in `httpPcPresenceRead` (pc_presence_probe.dart), replace
// `absentReason: PcAbsentReason.parse(decoded['pc_absent_reason'])` with
// `absentReason: null` — the probe goes back to ignoring the field, which is
// exactly the state this card found it in.
// Observed — 4 pass / 2 FAIL:
//   'the probe reads pc_absent_reason off a REAL server response'
//     Expected: PcAbsentReason:<PcAbsentReason.authExpired>   Actual: <null>
//   'wire to face: an auth_expired absence becomes pcSignedOut'
//     Expected: PcAbsentReason:<PcAbsentReason.authExpired>   Actual: <null>
// ⚠️ The second one fails at its `pcAbsentReasonOf` line, one assertion BEFORE
// the face comparison — worth recording exactly, because the prediction written
// here first said it would fail on `pcSignedOut` vs `pcOffline`. It does not
// get that far. The test still proves what it claims (the reason never reaches
// the controller's table, so the face cannot possibly be right), but a reverse
// control is only evidence if what is written down is what was observed.
// 🔴 This is the proof this file reads the WIRE rather than a value it invented
// for itself: nothing here names `authExpired` on the way IN — only the JSON
// the server sent over a real socket.
// ⚠️ Control on the control: pc_signed_out_render_test.dart stayed GREEN under
// this break (7/7). It is fed a reading directly and CANNOT see the parse —
// which is why that file has its own, different break.
// Restored, re-run: 6/6 green.

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

/// The relay's answer for a PC that is absent BECAUSE its cloud sign-in
/// lapsed — the exact shape `presence-routes.ts` builds.
const Map<String, Object?> _absentAuthExpired = <String, Object?>{
  'ok': true,
  'pc_id': 'pc-1',
  'pc_online': false,
  'pc_absent_reason': 'auth_expired',
};

/// The same absence with NO reason recorded. `pc_absent_reason` is OMITTED, not
/// null — the route says so in as many words, and 「没说」 ("didn't say") has to
/// keep meaning the pre-existing sentence.
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
  test('🔴 the probe reads pc_absent_reason off a REAL server response', () async {
    final s = await _serve(_absentAuthExpired);
    addTearDown(() => s.server.close(force: true));
    final PcPresenceReading r = await httpPcPresenceRead(
      Uri.parse('${s.url}/api/pc/presence'),
      'tok',
      const Duration(seconds: 3),
    );
    expect(r.presence, PcPresence.offline);
    expect(r.absentReason, PcAbsentReason.authExpired);
  });

  test('an absence with no reason recorded carries none — omitted stays "didn\'t say"', () async {
    final s = await _serve(_absentNoReason);
    addTearDown(() => s.server.close(force: true));
    final PcPresenceReading r = await httpPcPresenceRead(
      Uri.parse('${s.url}/api/pc/presence'),
      'tok',
      const Duration(seconds: 3),
    );
    expect(r.presence, PcPresence.offline);
    expect(r.absentReason, isNull);
  });

  test('🔴 a reason string this build does not know is null, never a guess', () {
    // The server's set is closed and has one member today. When it grows, an
    // older phone must fall back to the sentence it already had — NOT invent a
    // face for a cause it cannot describe.
    for (final Object? raw in <Object?>[
      'session_revoked',
      '',
      42,
      <String, Object?>{},
      null,
    ]) {
      expect(PcAbsentReason.parse(raw), isNull, reason: '$raw');
    }
    expect(PcAbsentReason.parse('auth_expired'), PcAbsentReason.authExpired);
  });

  test('🔴 wire to face: an auth_expired absence becomes pcSignedOut', () async {
    final s = await _serve(_absentAuthExpired);
    addTearDown(() => s.server.close(force: true));
    final ConnectionsController c = await _controller(s.url);
    await c.load();
    await c.refreshReachability();

    final MobileSession p = c.pairings.single;
    expect(c.presenceOf(p), PcPresence.offline);
    expect(c.pcAbsentReasonOf(p), PcAbsentReason.authExpired);

    // 🔴 Nothing above named `authExpired` on the way IN. It came off a real
    // socket, through the production parser, into the controller's own table,
    // and out as the word the page will print.
    expect(
      instanceLivenessFaceOf(
        reach: InstanceReach.online,
        answeringChannel: ServerChannel.cloudRelay,
        target: InstanceTarget.pc,
        pcPresence: c.presenceOf(p),
        pcAbsentReason: c.pcAbsentReasonOf(p),
      ),
      InstanceLivenessFace.pcSignedOut,
    );
  });

  test('wire to face: the same absence WITHOUT a reason still says pcOffline', () async {
    // The negative control for the test above. Without it, 「it says signed
    // out」 could be true because EVERY absence says signed out — the same
    // defect pointed the other way.
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

  test('🔴 a reason alone can never make a row absent', () {
    // A relay only sends the key on an absence, but the phone must not be
    // relying on the relay's good manners: an online row with a stray reason
    // attached is still online.
    expect(
      instanceLivenessFaceOf(
        reach: InstanceReach.online,
        answeringChannel: ServerChannel.cloudRelay,
        target: InstanceTarget.pc,
        pcPresence: PcPresence.online,
        pcAbsentReason: PcAbsentReason.authExpired,
      ),
      InstanceLivenessFace.pcOnline,
    );
    // …and an unreachable ADDRESS still outranks it: we never got to ask.
    expect(
      instanceLivenessFaceOf(
        reach: InstanceReach.offline,
        answeringChannel: ServerChannel.cloudRelay,
        target: InstanceTarget.pc,
        pcPresence: PcPresence.offline,
        pcAbsentReason: PcAbsentReason.authExpired,
      ),
      InstanceLivenessFace.unreachable,
    );
  });
}
