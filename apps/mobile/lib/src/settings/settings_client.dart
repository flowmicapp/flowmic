// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.7 (settings:list / settings:update /
//     settings:updated)
//   docs/strategy/2026-07-25-full-gap-audit/03-MOBILE.md GA-11 (mobile never
//     pulled the server snapshot → silent inconsistency (静默不一致))
//   packages/protocol/src/protocol-schemas-sync.ts (SettingsListSchema = {},
//     SettingsUpdateSchema / SettingsUpdatedSchema = { key: NonEmpty,
//     value: unknown })
//   packages/protocol/src/constants.ts (SETTINGS_KEY_SCENARIO_CARD — the key the
//     server compose pipeline reads; mirrored to Dart as
//     FlowMicSettingsKeys.scenarioCard by the codegen)
//   docs/decisions/2026-07-23-settings-key-drift-literal-anchors.md (the ruling
//     this file implements)
//
// The mobile ↔ server settings client (write half + read half). Three
// deliberate design points:
//
//  1. LITERAL-KEY SET ANCHOR (settings-key-drift lint). [pushScenarioCard] is the
//     ONE place in apps/mobile that names the key as a string literal —
//     `updateSetting('scenario.card', …)` — so the drift lint's SET regex has a
//     real writer to match against the server's readSetting('scenario.card') GET
//     anchor (decision 2026-07-23). Every OTHER reference to the key uses the
//     generated FlowMicSettingsKeys.scenarioCard constant, and a test pins the
//     literal here == that constant. This is the mechanical "the key has a live
//     writer AND a live reader" proof the anti-façade lint exists to give; a
//     constant-only reference is invisible to it.
//
//  2. "Save on every change" (即改即存) is BEST-EFFORT + re-flush on reconnect +
//     FAIL-LOUD offline. The controller writes the local cache synchronously;
//     the wire push is a side-effect that must not throw into the UI. A push
//     made while the socket is down is remembered as PENDING (surfaced to the
//     user as "已存本地" ("saved locally") — SETTINGS_SYNC_FAIL, never a
//     silent drop) and re-emitted the instant the socket reconnects, so a
//     card edited offline reaches the server on recovery.
//
//  3. GA-11 — THE READ HALF. Before this card the app only ever WROTE settings:
//     a reinstall (or any desktop-side edit) left the phone showing a stale or
//     blank scenario card while the server KV the correction pipeline actually
//     reads held something else — a silent inconsistency. The one connected
//     rising edge below now pulls the server snapshot (settings:list), and the
//     client subscribes to peer pushes (settings:updated); both land on ONE
//     outbound [entries] stream, so a consumer cannot accidentally treat
//     "hydrated" and "pushed" as different things. Credential-bearing keys are
//     already filtered server-side (settings.handler.ts) — nothing to re-judge
//     here.

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../generated/flowmic_events.g.dart';
import '../signaling/socket_core.dart';

/// One server-authoritative settings value, from either the connect-time
/// snapshot (settings:list) or a peer push (settings:updated). Deliberately ONE
/// type for both: a consumer refreshes a key the same way whichever way the
/// value arrived.
@immutable
class SettingsEntry {
  const SettingsEntry({required this.key, required this.value});
  final String key;
  final Object? value;

  @override
  String toString() => 'SettingsEntry($key)';
}

class SettingsClient {
  SettingsClient({required SocketTransport transport}) : _transport = transport {
    // THE settings rising edge — both halves, in this order, because the order
    // is load-bearing: a pending offline edit must be on the wire BEFORE
    // settings:list is, or the snapshot we hydrate from is exactly the value our
    // own un-flushed edit is about to replace, and we would overwrite the user's
    // edit with the value it supersedes. socket.io preserves per-socket emit
    // order, so flush-then-list makes last-write-wins fall out for free.
    _statusSub = _transport.status.listen((SocketStatus s) {
      if (s != SocketStatus.connected) {
        _hydratedThisSpan = false; // a drop re-arms the snapshot pull
        return;
      }
      _flushPending();
      unawaited(hydrate());
    });
    // Peer pushes (the desktop edited the scenario card): same-key refresh.
    _incomingSub = _transport.incoming.listen(_onIncoming);
  }

  final SocketTransport _transport;
  StreamSubscription<SocketStatus>? _statusSub;
  StreamSubscription<EventEnvelope>? _incomingSub;

  /// Latest value pushed per key; re-sent on reconnect (last-write-wins).
  final Map<String, Object?> _latest = <String, Object?>{};

  /// Keys whose latest value has NOT yet reached a live wire (queued offline /
  /// after a failed emit). Cleared per key once a reconnect flush emits it.
  final Set<String> _dirty = <String>{};

  /// True while any edited key is still waiting to sync. The settings UI (via
  /// ScenarioCardController) surfaces this as the SETTINGS_SYNC_FAIL 「已存本地」
  /// ("saved locally") note — the edit is safe locally and will re-sync, but
  /// the failure is shown, never swallowed (red line: no silent failure —
  /// 没有静默失败).
  final ValueNotifier<bool> pendingSync = ValueNotifier<bool>(false);

  /// Whether [key] specifically is still pending sync (per-key so a caller can
  /// ask about its own SSOT key without knowing the others).
  bool isKeyPending(String key) => _dirty.contains(key);

  /// Server-authoritative values arriving from settings:list / settings:updated.
  /// Broadcast + sync so a consumer registered at construction sees the connect
  /// edge that happens in the same turn.
  final StreamController<SettingsEntry> _entriesCtl =
      StreamController<SettingsEntry>.broadcast(sync: true);
  Stream<SettingsEntry> get entries => _entriesCtl.stream;

  /// Whether this connected span already got a snapshot. Reset by any
  /// non-connected status, so ONE settings:list is pulled per reconnect and a
  /// repeated `connected` (status jitter) does not re-pull.
  bool _hydratedThisSpan = false;
  bool _hydrating = false;

  /// Pull the server settings snapshot and republish it on [entries]. Driven by
  /// the connected rising edge above AND — GA-11, the lead's ruling — by a successful
  /// pairing (main.dart wires ConnectionsController.onPaired), because a FIRST
  /// pairing gets its identity mid-connection, after that edge has already
  /// passed and its settings:list came back AUTH_TOKEN_INVALID. Idempotent per
  /// connected span, so the second caller costs at most one ack. Never throws: a dead socket / ack timeout / error ack leaves the
  /// last-known local values in place and re-arms for the next connect — the
  /// snapshot is a refresh, never an authority to blank the UI with.
  Future<void> hydrate() async {
    if (_hydratedThisSpan || _hydrating) return;
    _hydrating = true;
    try {
      final Object? resp = await _transport.emitWithAck<Object?>(
        FlowMicEvents.settingsList,
        <String, Object?>{},
      );
      if (resp is! Map) return;
      // AUTH_TOKEN_INVALID here is the honest answer on a socket that has not
      // presented its token yet (the pair flow stamps auth mid-session): keep
      // local, stay un-hydrated, retry on the next connect.
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

  /// Republish one {key, value} pair. An off-contract frame (missing / empty /
  /// non-string key) is dropped rather than turned into a nameless refresh.
  void _publish(Object? key, Object? value) {
    if (key is! String || key.isEmpty) return;
    if (_entriesCtl.isClosed) return;
    _entriesCtl.add(SettingsEntry(key: key, value: value));
  }

  /// Generic settings:update wire verb — VARIABLE key. The sole literal-key
  /// caller is [pushScenarioCard]; every other caller passes a generated
  /// constant, so this method's own call sites never trip the drift lint's SET
  /// regex (only the literal in the anchor below does, by design).
  void updateSetting(String key, Object? value) {
    _latest[key] = value;
    if (_emit(key, value)) {
      _dirty.remove(key);
    } else {
      _dirty.add(key);
    }
    _refreshPending();
  }

  /// THE literal-key SET anchor (settings-key-drift lint). [value] is the
  /// ScenarioCardSchema JSON. The literal 'scenario.card' here is pinned ==
  /// FlowMicSettingsKeys.scenarioCard (settings_client_test), which is the SAME
  /// SSOT string the server reads via readSetting('scenario.card'). Keep this the
  /// ONLY literal-keyed settings write in apps/mobile.
  void pushScenarioCard(Object? value) => updateSetting('scenario.card', value);

  void _flushPending() {
    if (_latest.isEmpty) return;
    for (final MapEntry<String, Object?> e in _latest.entries) {
      if (_emit(e.key, e.value)) _dirty.remove(e.key);
    }
    _refreshPending();
  }

  void _refreshPending() => pendingSync.value = _dirty.isNotEmpty;

  /// Try to put a settings:update on the wire. Returns false (→ pending) when the
  /// transport is down / pre-connect; the reconnect listener re-flushes it.
  bool _emit(String key, Object? value) {
    try {
      _transport.emit(
        FlowMicEvents.settingsUpdate,
        <String, Object?>{'key': key, 'value': value},
      );
      return true;
    } on Object {
      return false;
    }
  }

  Future<void> dispose() async {
    await _statusSub?.cancel();
    await _incomingSub?.cancel();
    await _entriesCtl.close();
    pendingSync.dispose();
  }
}
