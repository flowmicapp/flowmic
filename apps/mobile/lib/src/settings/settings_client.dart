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
//     reads held something else — a silent inconsistency. The one settings
//     rising edge below now pulls the server snapshot (settings:list), and the
//     client subscribes to peer pushes (settings:updated); both land on ONE
//     outbound [entries] stream, so a consumer cannot accidentally treat
//     "hydrated" and "pushed" as different things. Credential-bearing keys are
//     already filtered server-side (settings.handler.ts) — nothing to re-judge
//     here.
//
//  4. 🔴 THE EDGE IS `PttSession.roomJoins`, NOT `SocketStatus.connected` —
//     F-1, for the third time, and on this path it was silent in BOTH
//     directions. Measured on the code as it stood before this card:
//       · `SocketCore`'s status stream is `sync: true` and fires from inside
//         socket.io's `onConnect` (socket_core.dart), i.e. BEFORE
//         `mobile:reconnect` is even emitted. The server stamps auth inside
//         that handler (mobile.handler.ts) and joins the room on the next
//         line — so everything this class did on `connected` was done by an
//         UNAUTHENTICATED socket.
//       · The write half emitted settings:update fire-and-forget with NO ack
//         callback, so it "succeeded" because the transport did not throw:
//         `_dirty` was cleared and [pendingSync] went false while the server
//         answered AUTH_TOKEN_INVALID into an ack nobody had registered. The
//         edit was lost AND reported as synced — the 没有静默失败 red line
//         broken in the worse of its two directions.
//       · The read half returned early on that error ack leaving
//         [_hydratedThisSpan] false, which is meant to re-arm — but
//         `SocketCore._setStatus` de-dupes identical statuses, so no second
//         `connected` edge ever arrived and the retry never happened.
//     `roomJoins` is a COUNTER whose only writers are a successful
//     `mobile:pair` and an accepted `mobile:reconnect` (ptt_pair.dart /
//     ptt_reconnect_ack.dart) — i.e. it fires exactly when the far end has
//     admitted us, and it fires AGAIN on a second join, which a bool could not.
//     Same idiom, same reasoning, same words as
//     `timeline/cloud/blind_store_cloud_leg.dart`.
//     ⚠️ The `connected` listener is KEPT, with exactly one job left: a drop
//     re-arms the snapshot pull. That is a fact about the socket, which is the
//     one question that edge does answer honestly.
//
//  5. 🔴 `updated_at` — WHO WINS, decided by the server (04 §3.7-a). The wire
//     carries an OPTIONAL ISO-8601 stamp on settings:update / settings:updated
//     / each settings:list item. It is [String?] all the way through this file
//     and null means UNKNOWN — never epoch, never `DateTime.now()`. Minting a
//     stamp for a value whose edit time we do not know would hand the arbitration
//     a fabricated number to compare against a real one, and the arbitration
//     would then be confidently wrong instead of correctly abstaining.
//     Absence degrades to exactly the pre-stamp behaviour, which is what makes
//     this safe against an older relay that strips the field.

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
  const SettingsEntry({required this.key, required this.value, this.updatedAt});
  final String key;
  final Object? value;

  /// When the server says this value was last written (ISO-8601), or null when
  /// it does not know / does not say. See header point 5: null is UNKNOWN and a
  /// consumer must abstain from ranking on it, not substitute a number.
  ///
  /// ⚠️ Legitimately null in production for more than just an old relay:
  /// `withEffectiveDefaults` SYNTHESISES `stt.polish` and `capability.llm` on
  /// every read (settings.handler.ts) and those rows were never written by
  /// anyone, so there is no moment to report.
  final String? updatedAt;

  @override
  String toString() => 'SettingsEntry($key)';
}

/// One queued write: the value AND the stamp it was made at, kept together
/// because re-flushing the value while dropping its stamp would turn a
/// last-write-wins arbitration into a coin toss.
@immutable
class _PendingWrite {
  const _PendingWrite(this.value, this.updatedAt);
  final Object? value;
  final String? updatedAt;
}

class SettingsClient {
  SettingsClient({
    required SocketTransport transport,
    required ValueListenable<int> roomJoins,
  }) : _transport = transport,
       _roomJoins = roomJoins {
    // THE settings rising edge — see header point 4 for why it is this edge and
    // not `connected`. Both halves, in this order, because the order is
    // load-bearing: a pending offline edit must be on the wire BEFORE
    // settings:list is, or the snapshot we hydrate from is exactly the value our
    // own un-flushed edit is about to replace, and we would overwrite the user's
    // edit with the value it supersedes. socket.io preserves per-socket emit
    // order, so flush-then-list makes last-write-wins fall out for free.
    _roomJoins.addListener(_onRoomJoined);
    // Cold-start guard, same as BlindStoreCloudLeg.attach(): if a join somehow
    // predates construction there is no second edge coming, and waiting for one
    // is how a session ends up never syncing at all. In main.dart this cannot
    // fire (the PttSession is built in the same synchronous block and a join
    // needs a network round trip), so it costs nothing there and is honest
    // anywhere else.
    if (_roomJoins.value > 0) _onRoomJoined();
    _statusSub = _transport.status.listen((SocketStatus s) {
      // The ONE thing the socket edge still answers: we lost the link, so the
      // next admission is a new span and owes a fresh snapshot.
      if (s != SocketStatus.connected) _hydratedThisSpan = false;
    });
    // Peer pushes (the desktop edited the scenario card): same-key refresh.
    _incomingSub = _transport.incoming.listen(_onIncoming);
  }

  final SocketTransport _transport;
  final ValueListenable<int> _roomJoins;
  StreamSubscription<SocketStatus>? _statusSub;
  StreamSubscription<EventEnvelope>? _incomingSub;

  /// The admission edge, re-exposed for the settings consumers this client
  /// already feeds ([ScenarioCardController] subscribes here). Deliberately a
  /// pass-through rather than a second constructor argument threaded through
  /// main.dart: two references to one notifier is fine, two ANSWERS to "when
  /// may settings talk to the server" is the shape this repo keeps paying for.
  ValueListenable<int> get roomJoins => _roomJoins;

  void _onRoomJoined() {
    _flushPending();
    unawaited(hydrate());
  }

  /// Latest write per key; re-sent on the next admission (last-write-wins).
  final Map<String, _PendingWrite> _latest = <String, _PendingWrite>{};

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
  /// the room-join edge above AND — GA-11, the lead's ruling — by a successful
  /// pairing (main.dart wires ConnectionsController.onPaired). Those two now
  /// overlap by design rather than by accident: `mobile:pair` writes
  /// [PttSession.roomJoins] too, and `hydrate()` is idempotent per span, so the
  /// second caller costs at most one ack. Never throws: a dead socket / ack
  /// timeout / error ack leaves the last-known local values in place and
  /// re-arms for the next admission — the snapshot is a refresh, never an
  /// authority to blank the UI with.
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
        _publish(item['key'], item['value'], item['updated_at']);
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
    _publish(data['key'], data['value'], data['updated_at']);
  }

  /// Republish one {key, value, updated_at?} triple. An off-contract frame
  /// (missing / empty / non-string key) is dropped rather than turned into a
  /// nameless refresh.
  ///
  /// A non-string `updated_at` is read as ABSENT rather than stringified: an
  /// unknown stamp makes the arbitration abstain, whereas '42' would make it
  /// rank a value it cannot actually place in time.
  void _publish(Object? key, Object? value, Object? updatedAt) {
    if (key is! String || key.isEmpty) return;
    if (_entriesCtl.isClosed) return;
    _entriesCtl.add(SettingsEntry(
      key: key,
      value: value,
      updatedAt: updatedAt is String && updatedAt.isNotEmpty ? updatedAt : null,
    ));
  }

  /// Generic settings:update wire verb — VARIABLE key. The sole literal-key
  /// caller is [pushScenarioCard]; every other caller passes a generated
  /// constant, so this method's own call sites never trip the drift lint's SET
  /// regex (only the literal in the anchor below does, by design).
  ///
  /// [updatedAt] is the caller's own edit time (ISO-8601 UTC) when it has one.
  /// Omitting it is not a lesser call: the server treats an absent stamp as
  /// UNKNOWN and writes unconditionally, i.e. exactly the behaviour every
  /// caller had before stamps existed.
  void updateSetting(String key, Object? value, {String? updatedAt}) {
    final _PendingWrite w = _PendingWrite(value, updatedAt);
    _latest[key] = w;
    if (_emit(key, w)) {
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
  void pushScenarioCard(Object? value, {String? updatedAt}) =>
      updateSetting('scenario.card', value, updatedAt: updatedAt);

  void _flushPending() {
    if (_latest.isEmpty) return;
    for (final MapEntry<String, _PendingWrite> e in _latest.entries) {
      if (_emit(e.key, e.value)) _dirty.remove(e.key);
    }
    _refreshPending();
  }

  void _refreshPending() => pendingSync.value = _dirty.isNotEmpty;

  /// Try to put a settings:update on the wire. Returns false (→ pending) when the
  /// transport is down / pre-admission; the room-join listener re-flushes it.
  ///
  /// `updated_at` is included ONLY when known. Sending the key with a null value
  /// would make "no stamp" and "a stamp we lost" identical on the wire, which is
  /// the same distinction the server's own `withStamp` helper protects.
  bool _emit(String key, _PendingWrite w) {
    try {
      _transport.emit(
        FlowMicEvents.settingsUpdate,
        <String, Object?>{
          'key': key,
          'value': w.value,
          if (w.updatedAt != null) 'updated_at': w.updatedAt,
        },
      );
      return true;
    } on Object {
      return false;
    }
  }

  Future<void> dispose() async {
    _roomJoins.removeListener(_onRoomJoined);
    await _statusSub?.cancel();
    await _incomingSub?.cancel();
    await _entriesCtl.close();
    pendingSync.dispose();
  }
}
