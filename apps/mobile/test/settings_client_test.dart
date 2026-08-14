// WP-R3-3 — the settings write path + the settings-key-drift literal anchor
// (decision 2026-07-23-settings-key-drift-literal-anchors). Pins the two claims
// that ruling rests on: (1) pushScenarioCard names the key as the literal
// 'scenario.card' AND that literal == the generated SSOT constant the rest of
// the app uses (so the drift lint's SET anchor and the app agree); (2) an
// offline push is remembered PENDING and re-flushed on reconnect — save-as-you-go is
// fail-loud, never a silent drop (CLAUDE.md red line: no silent failure).

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/generated/flowmic_settings.g.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

/// A transport whose emit throws until it is brought [online] — models a socket
/// that is down, then recovers on the next connected status.
class _FlakyTransport extends FakeSocketTransport {
  bool online = false;
  @override
  void emit(String event, Object? payload) {
    if (!online) throw StateError('offline');
    super.emit(event, payload);
  }
}

Map<String, Object?> _payload(FakeSocketTransport t) =>
    (t.emittedWhere(FlowMicEvents.settingsUpdate).last.data as Map).cast<String, Object?>();

void main() {
  test('pushScenarioCard is the LITERAL-key SET anchor, pinned == the SSOT '
      'constant the rest of the app uses', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final SettingsClient c = SettingsClient(transport: t);
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
    final SettingsClient c = SettingsClient(transport: t);
    // Key passed as a VARIABLE (not an inline literal) so this generic-verb test
    // never plants a phantom SET anchor for the settings-key-drift lint — only
    // the production pushScenarioCard literal is a real anchor.
    const String key = 'some.other.key';
    c.updateSetting(key, 42);
    expect(_payload(t)['key'], key);
    expect(_payload(t)['value'], 42);
    await c.dispose();
  });

  test('an offline push is PENDING then re-flushed on reconnect (no silent loss)',
      () async {
    final _FlakyTransport t = _FlakyTransport();
    final SettingsClient c = SettingsClient(transport: t);

    // Socket down: the emit fails, but the edit is remembered + surfaced.
    c.pushScenarioCard(<String, Object?>{'terms': <String>['幂等']});
    expect(t.emittedWhere(FlowMicEvents.settingsUpdate), isEmpty);
    expect(c.isKeyPending(FlowMicSettingsKeys.scenarioCard), isTrue);
    expect(c.pendingSync.value, isTrue);

    // Reconnect: the pending value is re-emitted and the pending flag clears.
    t.online = true;
    t.pushStatus(SocketStatus.connected);
    expect(t.emittedWhere(FlowMicEvents.settingsUpdate), isNotEmpty);
    expect(c.isKeyPending(FlowMicSettingsKeys.scenarioCard), isFalse);
    expect(c.pendingSync.value, isFalse);
    await c.dispose();
  });

  // ── GA-11: the READ half ───────────────────────────────────────────────

  test('the connected rising edge pulls the snapshot, AFTER flushing pending '
      'edits (order is the anti-clobber guarantee)', () async {
    final _FlakyTransport t = _FlakyTransport();
    final SettingsClient c = SettingsClient(transport: t);
    // An edit made while the socket was down.
    c.pushScenarioCard(<String, Object?>{'terms': <String>['offline']});
    t.ackQueue.add(<String, Object?>{'items': <Object?>[]});

    t.online = true;
    t.pushStatus(SocketStatus.connected);
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

  test('settings:list items are republished on the entries stream', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final SettingsClient c = SettingsClient(transport: t);
    final List<SettingsEntry> seen = <SettingsEntry>[];
    c.entries.listen(seen.add);
    t.ackQueue.add(<String, Object?>{
      'items': <Object?>[
        <String, Object?>{'key': 'scenario.card', 'value': <String, Object?>{'terms': <String>['A']}},
        <String, Object?>{'key': 'stt.polish', 'value': true},
        <String, Object?>{'value': 'no key at all'}, // off-contract → dropped
      ],
    });

    t.pushStatus(SocketStatus.connected);
    await Future<void>.delayed(Duration.zero);

    expect(seen.map((SettingsEntry e) => e.key), <String>['scenario.card', 'stt.polish']);
    expect((seen.first.value! as Map)['terms'], <String>['A']);
    await c.dispose();
  });

  test('ONE settings:list per connected span: status jitter does not re-pull, a '
      'real drop+reconnect does', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final SettingsClient c = SettingsClient(transport: t);
    t.defaultAck = <String, Object?>{'items': <Object?>[]};

    t.pushStatus(SocketStatus.connected);
    await Future<void>.delayed(Duration.zero);
    // Repeated `connected` with no drop in between = jitter, not a new span.
    t.pushStatus(SocketStatus.connected);
    t.pushStatus(SocketStatus.connected);
    await Future<void>.delayed(Duration.zero);
    expect(t.emittedWhere(FlowMicEvents.settingsList), hasLength(1));

    // A real drop re-arms exactly one more pull.
    t.pushStatus(SocketStatus.disconnected);
    t.pushStatus(SocketStatus.connected);
    await Future<void>.delayed(Duration.zero);
    expect(t.emittedWhere(FlowMicEvents.settingsList), hasLength(2));
    await c.dispose();
  });

  test('a failed snapshot (error ack / dead socket) publishes nothing, does not '
      'throw, and stays re-armed', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final SettingsClient c = SettingsClient(transport: t);
    final List<SettingsEntry> seen = <SettingsEntry>[];
    c.entries.listen(seen.add);
    // Not authenticated yet — the honest answer on a pre-pair socket.
    t.ackQueue.add(<String, Object?>{'error': 'AUTH_TOKEN_INVALID'});
    t.defaultAck = <String, Object?>{'items': <Object?>[]};

    t.pushStatus(SocketStatus.connected);
    await Future<void>.delayed(Duration.zero);
    expect(seen, isEmpty);

    // Un-hydrated → the very next connected edge tries again (no drop needed).
    t.pushStatus(SocketStatus.connected);
    await Future<void>.delayed(Duration.zero);
    expect(t.emittedWhere(FlowMicEvents.settingsList), hasLength(2));
    await c.dispose();
  });

  test('settings:updated is consumed and republished; a keyless frame is dropped',
      () async {
    final FakeSocketTransport t = FakeSocketTransport();
    final SettingsClient c = SettingsClient(transport: t);
    final List<SettingsEntry> seen = <SettingsEntry>[];
    c.entries.listen(seen.add);

    t.pushIncoming(FlowMicEvents.settingsUpdated,
        <String, Object?>{'key': 'scenario.card', 'value': <String, Object?>{'packs': <String>['legal']}});
    t.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{'value': 1});
    t.pushIncoming(FlowMicEvents.settingsUpdated, 'not a map');
    t.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{'key': 'x'});

    expect(seen, hasLength(1));
    expect(seen.single.key, 'scenario.card');
    expect((seen.single.value! as Map)['packs'], <String>['legal']);
    await c.dispose();
  });

  test('reconnect flushes the LATEST offline value (last-write-wins)', () async {
    final _FlakyTransport t = _FlakyTransport();
    final SettingsClient c = SettingsClient(transport: t);
    c.pushScenarioCard(<String, Object?>{'terms': <String>['v1']});
    c.pushScenarioCard(<String, Object?>{'terms': <String>['v2']});

    t.online = true;
    t.pushStatus(SocketStatus.connected);
    // Exactly one settings:update for the key, carrying the latest value.
    final envs = t.emittedWhere(FlowMicEvents.settingsUpdate);
    expect(envs, hasLength(1));
    expect(((envs.single.data as Map)['value'] as Map)['terms'], <String>['v2']);
    await c.dispose();
  });
}
