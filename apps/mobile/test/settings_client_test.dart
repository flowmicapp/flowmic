// WP-R3-3 — the settings write path + the settings-key-drift literal anchor
// (decision 2026-07-23-settings-key-drift-literal-anchors). Pins the two claims
// that ruling rests on: (1) pushScenarioCard names the key as the literal
// 'scenario.card' AND that literal == the generated SSOT constant the rest of
// the app uses (so the drift lint's SET anchor and the app agree); (2) an
// offline push is remembered PENDING and re-flushed on the next admission —
// save-as-you-go is fail-loud, never a silent drop (CLAUDE.md red line: no
// silent failure).
//
// ── 🔴 THE EDGE MOVED, AND SO DID THE PROMISE THIS FILE PINS ────────────────
// Every case below used to drive the client with `pushStatus(connected)`, and
// that was not a test-harness detail: it was this file asserting the production
// contract "settings talk on the socket-connected edge". That contract was
// wrong in both directions (settings_client.dart header point 4), so these
// cases now drive `roomJoins` instead. This is a behaviour-contract change, not
// maintenance — the same shape as F-1 and 49-3, on the settings path.
//
// One case was DELETED rather than ported: "a failed snapshot (error ack) …
// stays re-armed" used to queue `{'error': 'AUTH_TOKEN_INVALID'}` and document
// it as "the honest answer on a pre-pair socket". That state is now
// unreachable — the client does not speak until the server has admitted it —
// and pinning an unreachable state is how a fixed defect gets re-specified as a
// requirement (0.2.52 §3 paid for that exact mistake). Its useful half (an
// error ack publishes nothing and re-arms) survives below with the error code
// that CAN still occur, and the state it used to document is now pinned as its
// opposite by the F-1 regression guard at the bottom of this file.
//
// ── REVERSE CONTROL (executed 2026-08-16) ───────────────────────────────────
// Break: in settings_client.dart's constructor, replace the roomJoins edge with
// the old socket edge — i.e. `_roomJoins.addListener(_onRoomJoined);` deleted
// and the status listener restored to `{ if (s != connected) {…; return;}
// _flushPending(); unawaited(hydrate()); }`.
// OBSERVED: `+4 -7: Some tests failed.` — seven red, the two decisive ones being
//   · "F-1 REGRESSION GUARD: a bare `connected` with NO room join says NOTHING"
//     → Expected: empty / Actual: [   (the settings:update the un-admitted
//       socket had no business sending)
//   · "the room-join edge pulls the snapshot, AFTER flushing pending edits"
//     → Expected: ['settings:update', 'settings:list']
//       Actual: WhereIterable<String>:[]
// CONTROL-ON-CONTROL: the four cases that assert WHAT is said rather than WHEN
// ("pushScenarioCard is the LITERAL-key SET anchor…", "updateSetting is the
// generic variable-key verb", "a stamp rides settings:update ONLY when known…",
// "settings:updated is consumed and republished…") stayed GREEN — the `+4` in
// that line is exactly those four — proving the break is specific to the edge.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/generated/flowmic_settings.g.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

/// A transport whose emit throws until it is brought [online] — models a socket
/// that is down, then recovers on the next admission.
class _FlakyTransport extends FakeSocketTransport {
  bool online = false;
  @override
  void emit(String event, Object? payload) {
    if (!online) throw StateError('offline');
    super.emit(event, payload);
  }
}

/// The admission counter, standing in for `PttSession.roomJoins`. Bumping it is
/// the same gesture `outbox_drains_on_room_join_test.dart` makes with
/// `session.noteRoomJoined()` — a COUNTER, so a second join fires again.
class _Joins extends ValueNotifier<int> {
  _Joins() : super(0);
  void join() => value++;
}

Map<String, Object?> _payload(FakeSocketTransport t) =>
    (t.emittedWhere(FlowMicEvents.settingsUpdate).last.data as Map).cast<String, Object?>();

void main() {
  test('pushScenarioCard is the LITERAL-key SET anchor, pinned == the SSOT '
      'constant the rest of the app uses', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final SettingsClient c = SettingsClient(transport: t, roomJoins: _Joins());
    c.pushScenarioCard(<String, Object?>{
      'professions': <String>['software development'],
      'domains': <String>[],
      'packs': <String>['tech-dev'],
      'terms': <String>['FlowMic'],
    });

    final Map<String, Object?> p = _payload(t);
    // The anchor's literal string and the generated constant are the SAME key —
    // this is the equality the drift-lint ruling depends on.
    expect(p['key'], 'scenario.card');
    expect(p['key'], FlowMicSettingsKeys.scenarioCard);
    expect((p['value']! as Map)['packs'], <String>['tech-dev']);
    await c.dispose();
  });

  test('updateSetting is the generic variable-key verb', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final SettingsClient c = SettingsClient(transport: t, roomJoins: _Joins());
    // Key passed as a VARIABLE (not an inline literal) so this generic-verb test
    // never plants a phantom SET anchor for the settings-key-drift lint — only
    // the production pushScenarioCard literal is a real anchor.
    const String key = 'some.other.key';
    c.updateSetting(key, 42);
    expect(_payload(t)['key'], key);
    expect(_payload(t)['value'], 42);
    await c.dispose();
  });

  test('a stamp rides settings:update ONLY when known — absent is omitted, '
      'never sent as null', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final SettingsClient c = SettingsClient(transport: t, roomJoins: _Joins());
    const String key = 'some.other.key';

    c.updateSetting(key, 1);
    // Not `isNull`: the KEY must be absent. `{'updated_at': null}` and "no
    // stamp" are the same thing to a null check and different things to the
    // server, which is the whole reason this assertion is written on the map.
    expect(_payload(t).containsKey('updated_at'), isFalse);

    c.updateSetting(key, 2, updatedAt: '2026-08-16T09:00:00.000Z');
    expect(_payload(t)['updated_at'], '2026-08-16T09:00:00.000Z');
    await c.dispose();
  });

  test('an offline push is PENDING then re-flushed on the next room join '
      '(no silent loss), carrying its stamp', () async {
    final _FlakyTransport t = _FlakyTransport();
    final _Joins joins = _Joins();
    final SettingsClient c = SettingsClient(transport: t, roomJoins: joins);

    // Socket down: the emit fails, but the edit is remembered + surfaced.
    c.pushScenarioCard(<String, Object?>{'terms': <String>['幂等']},
        updatedAt: '2026-08-16T09:00:00.000Z');
    expect(t.emittedWhere(FlowMicEvents.settingsUpdate), isEmpty);
    expect(c.isKeyPending(FlowMicSettingsKeys.scenarioCard), isTrue);
    expect(c.pendingSync.value, isTrue);

    // Admitted: the pending value is re-emitted and the pending flag clears.
    t.online = true;
    joins.join();
    expect(t.emittedWhere(FlowMicEvents.settingsUpdate), isNotEmpty);
    // The stamp survives the queue. Re-flushing the value while dropping the
    // stamp would turn the server's arbitration into a coin toss.
    expect(_payload(t)['updated_at'], '2026-08-16T09:00:00.000Z');
    expect(c.isKeyPending(FlowMicSettingsKeys.scenarioCard), isFalse);
    expect(c.pendingSync.value, isFalse);
    await c.dispose();
  });

  // ── GA-11: the READ half ───────────────────────────────────────────────

  test('the room-join edge pulls the snapshot, AFTER flushing pending edits '
      '(order is the anti-clobber guarantee)', () async {
    final _FlakyTransport t = _FlakyTransport();
    final _Joins joins = _Joins();
    final SettingsClient c = SettingsClient(transport: t, roomJoins: joins);
    // An edit made while the socket was down.
    c.pushScenarioCard(<String, Object?>{'terms': <String>['offline']});
    t.ackQueue.add(<String, Object?>{'items': <Object?>[]});

    t.online = true;
    joins.join();
    await Future<void>.delayed(Duration.zero);

    // Both frames left, and settings:update came FIRST — otherwise the snapshot
    // we hydrate from is the value our own un-flushed edit is about to replace.
    expect(
      t.emittedNames.where((String n) =>
          n == FlowMicEvents.settingsUpdate || n == FlowMicEvents.settingsList),
      <String>[FlowMicEvents.settingsUpdate, FlowMicEvents.settingsList],
    );
    // settings:list carries the empty payload SettingsListSchema demands.
    expect(t.emittedWhere(FlowMicEvents.settingsList).single.data, <String, Object?>{});
    await c.dispose();
  });

  test('settings:list items are republished on the entries stream, stamp and '
      'all', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final _Joins joins = _Joins();
    final SettingsClient c = SettingsClient(transport: t, roomJoins: joins);
    final List<SettingsEntry> seen = <SettingsEntry>[];
    c.entries.listen(seen.add);
    t.ackQueue.add(<String, Object?>{
      'items': <Object?>[
        <String, Object?>{
          'key': 'scenario.card',
          'value': <String, Object?>{'terms': <String>['A']},
          'updated_at': '2026-08-16T09:00:00.000Z',
        },
        // A SYNTHESIZED row (withEffectiveDefaults) carries no stamp — nobody
        // ever wrote it, so there is no moment to report. Unknown, not epoch.
        <String, Object?>{'key': 'stt.polish', 'value': true},
        // Off-contract stamp: read as UNKNOWN rather than stringified, so the
        // arbitration abstains instead of ranking a value it cannot place.
        <String, Object?>{'key': 'llm.config', 'value': 1, 'updated_at': 42},
        <String, Object?>{'value': 'no key at all'}, // off-contract → dropped
      ],
    });

    joins.join();
    await Future<void>.delayed(Duration.zero);

    expect(seen.map((SettingsEntry e) => e.key),
        <String>['scenario.card', 'stt.polish', 'llm.config']);
    expect((seen.first.value! as Map)['terms'], <String>['A']);
    expect(seen[0].updatedAt, '2026-08-16T09:00:00.000Z');
    expect(seen[1].updatedAt, isNull);
    expect(seen[2].updatedAt, isNull);
    await c.dispose();
  });

  test('ONE settings:list per connected span: a repeated join does not re-pull, '
      'a real drop+re-join does', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final _Joins joins = _Joins();
    final SettingsClient c = SettingsClient(transport: t, roomJoins: joins);
    t.defaultAck = <String, Object?>{'items': <Object?>[]};

    joins.join();
    await Future<void>.delayed(Duration.zero);
    // A second admission with no drop in between costs no second snapshot.
    joins.join();
    joins.join();
    await Future<void>.delayed(Duration.zero);
    expect(t.emittedWhere(FlowMicEvents.settingsList), hasLength(1));

    // A real drop re-arms exactly one more pull. The socket edge still answers
    // THIS question honestly — "we lost the link" is a fact about the socket.
    t.pushStatus(SocketStatus.disconnected);
    t.pushStatus(SocketStatus.connected);
    joins.join();
    await Future<void>.delayed(Duration.zero);
    expect(t.emittedWhere(FlowMicEvents.settingsList), hasLength(2));
    await c.dispose();
  });

  test('a failed snapshot (error ack / dead socket) publishes nothing, does not '
      'throw, and stays re-armed', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final _Joins joins = _Joins();
    final SettingsClient c = SettingsClient(transport: t, roomJoins: joins);
    final List<SettingsEntry> seen = <SettingsEntry>[];
    c.entries.listen(seen.add);
    // SETTINGS_SYNC_FAIL, not AUTH_TOKEN_INVALID: see this file's header. The
    // server answers this one when reading the rows throws, which an admitted
    // socket can still hit.
    t.ackQueue.add(<String, Object?>{'error': 'SETTINGS_SYNC_FAIL'});
    t.defaultAck = <String, Object?>{'items': <Object?>[]};

    joins.join();
    await Future<void>.delayed(Duration.zero);
    expect(seen, isEmpty);

    // Un-hydrated → the very next admission tries again (no drop needed).
    joins.join();
    await Future<void>.delayed(Duration.zero);
    expect(t.emittedWhere(FlowMicEvents.settingsList), hasLength(2));
    await c.dispose();
  });

  test('settings:updated is consumed and republished; a keyless frame is dropped',
      () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final SettingsClient c = SettingsClient(transport: t, roomJoins: _Joins());
    final List<SettingsEntry> seen = <SettingsEntry>[];
    c.entries.listen(seen.add);

    t.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{
      'key': 'scenario.card',
      'value': <String, Object?>{'packs': <String>['legal']},
      'updated_at': '2026-08-16T10:00:00.000Z',
    });
    t.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{'value': 1});
    t.pushIncoming(FlowMicEvents.settingsUpdated, 'not a map');
    t.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{'key': 'x'});

    expect(seen, hasLength(1));
    expect(seen.single.key, 'scenario.card');
    expect((seen.single.value! as Map)['packs'], <String>['legal']);
    expect(seen.single.updatedAt, '2026-08-16T10:00:00.000Z');
    await c.dispose();
  });

  test('a re-join flushes the LATEST offline value (last-write-wins)', () async {
    final _FlakyTransport t = _FlakyTransport();
    final _Joins joins = _Joins();
    final SettingsClient c = SettingsClient(transport: t, roomJoins: joins);
    c.pushScenarioCard(<String, Object?>{'terms': <String>['v1']},
        updatedAt: '2026-08-16T09:00:00.000Z');
    c.pushScenarioCard(<String, Object?>{'terms': <String>['v2']},
        updatedAt: '2026-08-16T09:00:01.000Z');

    t.online = true;
    joins.join();
    // Exactly one settings:update for the key, carrying the latest value AND
    // the latest stamp.
    final envs = t.emittedWhere(FlowMicEvents.settingsUpdate);
    expect(envs, hasLength(1));
    expect(((envs.single.data as Map)['value'] as Map)['terms'], <String>['v2']);
    expect((envs.single.data as Map)['updated_at'], '2026-08-16T09:00:01.000Z');
    await c.dispose();
  });

  // ── F-1, the third time ────────────────────────────────────────────────

  test('F-1 REGRESSION GUARD: a bare `connected` with NO room join says NOTHING',
      () async {
    // 🔴 This is the defect, stated as an assertion. `SocketCore`'s status
    // stream is sync and fires from inside socket.io's onConnect — BEFORE
    // `mobile:reconnect` is emitted and therefore before the server has stamped
    // auth on this socket. Anything sent here is answered AUTH_TOKEN_INVALID
    // into an ack this client never registered: the write is lost AND reported
    // as synced, and the read gives up without ever re-arming (SocketCore
    // de-dupes identical statuses, so no second `connected` edge is coming).
    final _FlakyTransport t = _FlakyTransport();
    t.online = true;
    final _Joins joins = _Joins();
    final SettingsClient c = SettingsClient(transport: t, roomJoins: joins);
    t.defaultAck = <String, Object?>{'items': <Object?>[]};
    c.pushScenarioCard(<String, Object?>{'terms': <String>['edited offline']});
    t.emitted.clear();

    t.pushStatus(SocketStatus.disconnected);
    t.pushStatus(SocketStatus.connected);
    await Future<void>.delayed(Duration.zero);

    expect(t.emittedWhere(FlowMicEvents.settingsUpdate), isEmpty,
        reason: 'an un-admitted socket cannot be told an edit "synced"');
    expect(t.emittedWhere(FlowMicEvents.settingsList), isEmpty,
        reason: 'and a snapshot pulled before auth comes back as an error ack '
            'nobody gets a second chance to retry');

    // And the moment the server actually admits us, both halves go.
    joins.join();
    await Future<void>.delayed(Duration.zero);
    expect(t.emittedWhere(FlowMicEvents.settingsUpdate), hasLength(1));
    expect(t.emittedWhere(FlowMicEvents.settingsList), hasLength(1));
    await c.dispose();
  });
}
