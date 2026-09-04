// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.7 (settings:list / settings:updated)
//   packages/protocol/src/protocol-schemas-sync.ts (SettingsListSchema = {},
//     SettingsUpdatedSchema = { key: NonEmpty, value: unknown })
//   packages/protocol/src/constants.ts (SETTINGS_KEY_CAPABILITY_LLM)
//   docs/decisions/2026-09-03-owner-web-rulings-phone-owned-settings.md
//     追加裁定二 ② + docs/strategy/2026-09-03-phone-owned-settings-design-and-
//     task-book.md D1 (corrected): the phone's preferences ride the request
//     that starts a transcription cycle; the server refuses a settings:update
//     of those four keys (SETTINGS_SCHEMA_INVALID) for everyone.
//
// ── THIS CLASS IS READ-ONLY NOW ─────────────────────────────────────────────
//
// It pulls the server's `capability.*` snapshot on every admission and
// republishes it. That is all it does. What left on 2026-09-03 (WP-B2), and
// why, so nobody puts it back:
//
//   · `updateSetting` and the three literal-key SET anchors (`pushScenarioCard`
//     / `pushPolish` / `pushRefine`) plus `pushInferenceConsent`. The server
//     REFUSES those four keys from any client now, so keeping a writer would be
//     a method whose every call is rejected — the loudest possible façade. The
//     literal-key SET anchors the settings-key-drift lint pairs with the
//     server's `readSetting('…')` moved WITH the write: they live in
//     settings/phone_prefs_payload.dart, which is what actually puts those keys
//     on the wire now (that file's header carries the anchor argument).
//     ⚠️ Nothing else in apps/mobile ever wrote a setting, so this class no
//     longer emits `settings:update` at all — which is exactly what
//     test/settings_client_test.dart asserts about the whole transport.
//
//   · `pendingSync` / `isKeyPending` / the `_dirty` set, and with them the
//     「saved locally · pending sync」 note on the settings screen. They answered
//     「an edit has not reached the server yet」, and on the request-carrier
//     model there is nothing an edit could be waiting for: the value is used
//     the next time the user speaks, and if the link is down there is no next
//     time to be late for. Keeping the note would be a promise about a
//     mechanism that no longer exists — the same shape as 「待投递」 before
//     there was a queue (CLAUDE.md red line F2).
//
//   · `updated_at` and the SettingsStampClock (left with WP-B, 2026-09-03):
//     they arbitrated this phone's edit against a copy the server stored.
//
// 🔴 THE READ HALF IS NARROWED TO `capability.*`. A `settings:list` item or a
// `settings:updated` frame for any other key is dropped in [_publish], which is
// what makes 「the server cannot push a preference back at this phone」 a
// property of this class rather than a discipline in its consumers. The one
// capability key today is `capability.llm` — a fact about the PC that the
// server synthesises on every read and the phone's mode row renders
// (llm_capability.dart; verify/lint/settings-key-drift.mjs requires that
// consumer to exist).
//
// 🔴 THE EDGE IS `PttSession.roomJoins`, NOT `SocketStatus.connected` — F-1,
// and on this path it was silent in BOTH directions. `SocketCore`'s status
// stream is `sync: true` and fires from inside socket.io's `onConnect`, i.e.
// BEFORE `mobile:reconnect` is even emitted; the server stamps auth inside that
// handler and joins the room on the next line. Everything this class did on
// `connected` was therefore done by an UNAUTHENTICATED socket, and the ack it
// got back was `AUTH_TOKEN_INVALID`. `roomJoins` is a COUNTER whose only
// writers are a successful `mobile:pair` and an accepted `mobile:reconnect`
// (ptt_pair.dart / ptt_reconnect_ack.dart) — it fires exactly when the far end
// has admitted us, and it fires AGAIN on a second join, which a bool could not.

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../generated/flowmic_events.g.dart';
import '../../generated/flowmic_settings.g.dart';
import '../signaling/socket_core.dart';

/// The prefix of the read-only facts the server synthesises per read
/// (packages/protocol/src/constants.ts SETTINGS_CAPABILITY_KEY_PREFIX). Derived
/// from the one generated capability key rather than typed a second time.
final String _capabilityPrefix = FlowMicSettingsKeys.capabilityLlm.substring(
  0,
  FlowMicSettingsKeys.capabilityLlm.indexOf('.') + 1,
);

/// One server-synthesised fact (a `capability.*` key), from either the
/// connect-time snapshot (settings:list) or a push (settings:updated).
/// Deliberately ONE type for both: a consumer refreshes a key the same way
/// whichever way the value arrived.
@immutable
class SettingsEntry {
  const SettingsEntry({required this.key, required this.value});
  final String key;
  final Object? value;

  @override
  String toString() => 'SettingsEntry($key)';
}

class SettingsClient {
  SettingsClient({
    required SocketTransport transport,
    required ValueListenable<int> roomJoins,
  }) : _transport = transport,
       _roomJoins = roomJoins {
    // THE settings rising edge — see the header for why it is this edge and not
    // `connected`. Its one job now is the capability snapshot; nothing else in
    // this app talks to the server on it.
    _roomJoins.addListener(_onRoomJoined);
    // Cold-start guard, same as BlindStoreCloudLeg.attach(): if a join somehow
    // predates construction there is no second edge coming, and waiting for one
    // is how a span ends up with no capability answer at all. In main.dart this
    // cannot fire (the PttSession is built in the same synchronous block and a
    // join needs a network round trip), so it costs nothing there and is honest
    // anywhere else.
    if (_roomJoins.value > 0) _onRoomJoined();
    _statusSub = _transport.status.listen((SocketStatus s) {
      // The ONE thing the socket edge still answers: we lost the link, so the
      // next admission is a new span and owes a fresh capability snapshot.
      if (s != SocketStatus.connected) _hydratedThisSpan = false;
    });
    _incomingSub = _transport.incoming.listen(_onIncoming);
  }

  final SocketTransport _transport;
  final ValueListenable<int> _roomJoins;
  StreamSubscription<SocketStatus>? _statusSub;
  StreamSubscription<EventEnvelope>? _incomingSub;

  void _onRoomJoined() => unawaited(hydrate());

  /// Server-synthesised `capability.*` facts arriving from settings:list /
  /// settings:updated. Broadcast + sync so a consumer registered at
  /// construction sees the connect edge that happens in the same turn.
  final StreamController<SettingsEntry> _entriesCtl =
      StreamController<SettingsEntry>.broadcast(sync: true);
  Stream<SettingsEntry> get entries => _entriesCtl.stream;

  /// Whether this connected span already got a snapshot. Reset by any
  /// non-connected status, so ONE settings:list is pulled per reconnect and a
  /// repeated `connected` (status jitter) does not re-pull.
  bool _hydratedThisSpan = false;
  bool _hydrating = false;

  /// Pull the server's capability snapshot and republish it on [entries].
  /// Driven by the room-join edge above AND by a successful pairing (main.dart
  /// wires ConnectionsController.onPaired). Those two overlap by design rather
  /// than by accident: `mobile:pair` writes [PttSession.roomJoins] too, and
  /// this is idempotent per span, so the second caller costs at most one ack.
  /// Never throws: a dead socket / ack timeout / error ack leaves the last
  /// answer in place and re-arms for the next admission — the snapshot is a
  /// refresh, never an authority to blank the UI with.
  Future<void> hydrate() async {
    if (_hydratedThisSpan || _hydrating) return;
    _hydrating = true;
    try {
      final Object? resp = await _transport.emitWithAck<Object?>(
        FlowMicEvents.settingsList,
        <String, Object?>{},
      );
      if (resp is! Map) return;
      if (resp['error'] != null) return;
      final Object? items = resp['items'];
      if (items is! List) return;
      _hydratedThisSpan = true;
      for (final Object? item in items) {
        if (item is! Map) continue;
        _publish(item['key'], item['value']);
      }
    } on Object {
      // Swallowed on purpose — see the doc comment. The UI keeps showing the
      // last value it actually had, which is still true.
    } finally {
      _hydrating = false;
    }
  }

  void _onIncoming(EventEnvelope e) {
    if (e.name != FlowMicEvents.settingsUpdated) return;
    final Object? data = e.data;
    if (data is! Map) return;
    _publish(data['key'], data['value']);
  }

  /// Republish one {key, value} pair IF it is a capability fact. An off-contract
  /// frame (missing / empty / non-string key) is dropped rather than turned into
  /// a nameless refresh, and so is any key this phone owns: nothing the server
  /// says about `scenario.card` / `stt.polish` / … is a fact about this phone.
  void _publish(Object? key, Object? value) {
    if (key is! String || key.isEmpty) return;
    if (!key.startsWith(_capabilityPrefix)) return;
    if (_entriesCtl.isClosed) return;
    _entriesCtl.add(SettingsEntry(key: key, value: value));
  }

  Future<void> dispose() async {
    _roomJoins.removeListener(_onRoomJoined);
    await _statusSub?.cancel();
    await _incomingSub?.cancel();
    await _entriesCtl.close();
  }
}
