// Diagnostic probe (2026-07-29): does a LARGE inject:request survive the phone's
// OWN socket stack?
//
// Text injection and image injection use the identical path — ComposeGate.
// emitInject over one socket_io_client connection — and text works while image
// dies with no trace on either server. The only variable left is FRAME SIZE, so
// this drives the app's real client package (socket_io_client, same version) at
// growing payloads and reports, per rung, which of three things happened:
//
//   PC RECEIVED  — the frame crossed everything (relay forwarded it)
//   REJECTED     — the server answered a 0.2.11 reject verdict (frame arrived)
//   NOTHING      — no answer at all: the frame never reached the server
//
// Run: dart run tool/probe_large_frame.dart <url> <short_code>
// (tool/probe_large_frame_server.mjs boots a throwaway server + PC socket and
// prints those two arguments.)

import 'dart:async';
import 'dart:io';

import 'package:socket_io_client/socket_io_client.dart' as sio;

Future<void> main(List<String> args) async {
  final String url = args[0];
  final String shortCode = args[1];

  // Same options the app uses (socket_core.dart): websocket-only, no built-in
  // reconnect, forceNew, auth carries schema_ver.
  sio.Socket open({String? token}) => sio.io(url, <String, dynamic>{
    'transports': <String>['websocket'],
    'autoConnect': false,
    'reconnection': false,
    'forceNew': true,
    'auth': <String, dynamic>{
      'schema_ver': 3,
      if (token != null) 'token': token,
    },
  });

  final sio.Socket s = open();
  final Completer<void> connected = Completer<void>();
  s.onConnect((_) => connected.complete());
  s.onConnectError((Object? e) => stdout.writeln('[dart] connect_error $e'));
  s.onDisconnect((Object? r) => stdout.writeln('[dart] !! DISCONNECT $r'));
  s.connect();
  await connected.future.timeout(const Duration(seconds: 10));
  stdout.writeln('[dart] connected');

  final Completer<Map<String, dynamic>> paired = Completer<Map<String, dynamic>>();
  s.emitWithAck('mobile:pair', <String, dynamic>{'short_code': shortCode},
      ack: (dynamic r) => paired.complete(Map<String, dynamic>.from(r as Map)));
  final Map<String, dynamic> pair = await paired.future.timeout(const Duration(seconds: 10));
  stdout.writeln('[dart] paired pairing_id=${pair['pairing_id']}');

  final Map<String, String> answered = <String, String>{};
  s.on('inject:result', (dynamic d) {
    final Map<String, dynamic> m = Map<String, dynamic>.from(d as Map);
    final String rid = (m['request_id'] ?? '?') as String;
    answered[rid] = (m['error'] ?? (m['ok'] == true ? 'OK' : '?')) as String;
  });

  // Canonical base64 of the requested length (%4 == 0), same shape the real
  // image_b64 has.
  String b64(int n) => 'A' * (n - (n % 4));

  for (final int n in <int>[200000, 800000, 1600000, 3200000, 3900000, 5600000, 9000000]) {
    final String rid = 'dart-$n';
    final int t0 = DateTime.now().millisecondsSinceEpoch;
    try {
      s.emit('inject:request', <String, dynamic>{
        'text': '',
        'source': 'image',
        'request_id': rid,
        'entry_id': 'loc_dartprobe_$n',
        'image_b64': b64(n),
        'image_mime': 'image/png',
      });
    } on Object catch (e) {
      stdout.writeln('[dart] ${n} chars → emit THREW synchronously: $e');
      continue;
    }
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 10));
    while (!answered.containsKey(rid) &&
        !File('${Directory.systemTemp.path}/pcgot-$n').existsSync() &&
        DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    final int ms = DateTime.now().millisecondsSinceEpoch - t0;
    final bool pcGot = File('${Directory.systemTemp.path}/pcgot-$n').existsSync();
    final String verdict = pcGot
        ? 'PC RECEIVED (${ms}ms)'
        : answered.containsKey(rid)
            ? 'REJECTED by server: ${answered[rid]} (${ms}ms) — the frame DID arrive'
            : 'NOTHING in 10s  ← the frame never reached the server';
    stdout.writeln('[dart] ${n.toString()} chars → $verdict   connected=${s.connected}');
    if (!s.connected) {
      stdout.writeln('[dart] socket is DOWN — stopping ladder');
      break;
    }
  }
  s.dispose();
  stdout.writeln('[dart] done');
  exit(0);
}
