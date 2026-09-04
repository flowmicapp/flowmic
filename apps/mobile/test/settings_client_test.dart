// WP-R3-3 (rewritten 2026-09-03, WP-B2) — the settings client is READ-ONLY.
//
// The write half is gone. owner's follow-up ruling that evening made the
// transcription request the carrier for the four phone-owned keys, and the
// server now REFUSES a `settings:update` of them from any client — so a writer
// here would be a method whose every call is rejected. Nothing else in
// apps/mobile ever wrote a setting, so this class emits no `settings:update`
// at all, and the literal-key SET anchors the settings-key-drift lint pairs
// with the server's `readSetting('…')` moved WITH the write, to
// settings/phone_prefs_payload.dart (pinned by phone_prefs_payload_test.dart).
//
// What this file pins now:
//   (1) the client is a READER — no frame it can be made to send is a
//       `settings:update`, on any path, including the admission edge that used
//       to flush the pending writes;
//   (2) the read half is NARROWED to `capability.*`: settings:list items and
//       settings:updated frames for any key this phone owns are dropped here,
//       so nothing the server says about `scenario.card` / `stt.polish` / …
//       can reach a consumer;
//   (3) ONE snapshot per connected span, and the edge is `roomJoins` (F-1) —
//       a bare `connected` on an un-admitted socket says nothing.
//
// The write-half cases (literal anchors, pending/offline, the owner's join
// re-push) are DELETED, not ported: they specified a mechanism that no longer
// exists, and a test that keeps asserting a deleted mechanism is how a deletion
// gets quietly undone.
//
// ── REVERSE CONTROL (executed 2026-09-03) ──────────────────────────────────
// Break: in `_publish`, delete `if (!key.startsWith(_capabilityPrefix)) return;`.
// OBSERVED: 「settings:list republishes ONLY capability facts」 goes red —
// Expected: ['capability.llm'] Actual: ['scenario.card', 'stt.polish',
// 'capability.llm'] — and 「a settings:updated for a phone-owned key is
// dropped」 goes red the same way.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/generated/flowmic_settings.g.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

class _Joins extends ValueNotifier<int> {
  _Joins() : super(0);
  void join() => value++;
}

void main() {
  // ── (1) nothing here writes a setting ─────────────────────────────────────
  test('the client emits settings:list and NOTHING else — no settings:update '
      'exists on this path any more', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final _Joins joins = _Joins();
    t.defaultAck = <String, Object?>{'items': <Object?>[]};
    final SettingsClient c = SettingsClient(transport: t, roomJoins: joins);

    joins.join();
    await Future<void>.delayed(Duration.zero);
    t.pushStatus(SocketStatus.disconnected);
    t.pushStatus(SocketStatus.connected);
    joins.join();
    await Future<void>.delayed(Duration.zero);

    expect(t.emittedWhere(FlowMicEvents.settingsUpdate), isEmpty);
    expect(
      t.emittedNames.toSet(),
      <String>{FlowMicEvents.settingsList},
      reason: 'positive control: the client DID talk (two snapshots), and '
          'everything it said was a read',
    );
    await c.dispose();
  });

  // ── (2) the read half: capability facts only ──────────────────────────────
  test('settings:list republishes ONLY capability facts; the phone-owned keys are dropped', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final _Joins joins = _Joins();
    final SettingsClient c = SettingsClient(transport: t, roomJoins: joins);
    final List<SettingsEntry> seen = <SettingsEntry>[];
    c.entries.listen(seen.add);
    t.ackQueue.add(<String, Object?>{
      'items': <Object?>[
        <String, Object?>{'key': 'scenario.card', 'value': <String, Object?>{'terms': <String>['A']}},
        <String, Object?>{'key': 'stt.polish', 'value': <String, Object?>{'enabled': true}},
        <String, Object?>{'key': FlowMicSettingsKeys.capabilityLlm, 'value': <String, Object?>{'usable': false}},
        <String, Object?>{'value': 'no key at all'}, // off-contract → dropped
      ],
    });
    joins.join();
    await Future<void>.delayed(Duration.zero);
    expect(seen.map((SettingsEntry e) => e.key), <String>[FlowMicSettingsKeys.capabilityLlm]);
    expect((seen.single.value! as Map)['usable'], isFalse);
    await c.dispose();
  });

  test('a settings:updated for a phone-owned key is dropped; one for a capability fact is republished', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final SettingsClient c = SettingsClient(transport: t, roomJoins: _Joins());
    final List<SettingsEntry> seen = <SettingsEntry>[];
    c.entries.listen(seen.add);
    t.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{
      'key': 'stt.polish',
      'value': <String, Object?>{'enabled': false},
    });
    t.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{
      'key': FlowMicSettingsKeys.capabilityLlm,
      'value': <String, Object?>{'usable': true},
    });
    await Future<void>.delayed(Duration.zero);
    expect(seen.map((SettingsEntry e) => e.key), <String>[FlowMicSettingsKeys.capabilityLlm]);
    await c.dispose();
  });

  // ── (3) the admission edge ────────────────────────────────────────────────
  test('F-1 REGRESSION GUARD: a bare `connected` with NO room join says NOTHING', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final SettingsClient c = SettingsClient(transport: t, roomJoins: _Joins());
    t.pushStatus(SocketStatus.connected);
    await Future<void>.delayed(Duration.zero);
    expect(t.emittedNames, isEmpty,
        reason: 'the un-admitted socket has no business asking for settings');
    await c.dispose();
  });

  test('cold start: a join that predates construction still pulls the snapshot '
      '(no second edge is coming)', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final _Joins joins = _Joins()..join();
    t.defaultAck = <String, Object?>{'items': <Object?>[]};
    final SettingsClient c = SettingsClient(transport: t, roomJoins: joins);
    await Future<void>.delayed(Duration.zero);
    expect(t.emittedWhere(FlowMicEvents.settingsList), hasLength(1));
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
    joins.join();
    await Future<void>.delayed(Duration.zero);
    expect(t.emittedWhere(FlowMicEvents.settingsList), hasLength(1));

    t.pushStatus(SocketStatus.disconnected);
    t.pushStatus(SocketStatus.connected);
    joins.join();
    await Future<void>.delayed(Duration.zero);
    expect(t.emittedWhere(FlowMicEvents.settingsList), hasLength(2));
    await c.dispose();
  });

  test('a failed snapshot (error ack) publishes nothing, does not throw, and stays re-armed', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final _Joins joins = _Joins();
    final SettingsClient c = SettingsClient(transport: t, roomJoins: joins);
    final List<SettingsEntry> seen = <SettingsEntry>[];
    c.entries.listen(seen.add);
    t.ackQueue.add(<String, Object?>{'error': 'SETTINGS_SYNC_FAIL'});
    t.defaultAck = <String, Object?>{
      'items': <Object?>[
        <String, Object?>{'key': FlowMicSettingsKeys.capabilityLlm, 'value': <String, Object?>{'usable': true}},
      ],
    };
    joins.join();
    await Future<void>.delayed(Duration.zero);
    expect(seen, isEmpty);
    joins.join();
    await Future<void>.delayed(Duration.zero);
    expect(seen, hasLength(1));
    await c.dispose();
  });
}
