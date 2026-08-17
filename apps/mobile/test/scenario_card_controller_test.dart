// WP-R3-3 — save-as-you-edit + the settings-key-drift closure in action. Every scenario
// edit must emit settings:update with key == FlowMicSettingsKeys.scenarioCard
// (the SAME SSOT string the server compose reader uses) and value == the exact
// ScenarioCardSchema JSON. Uses the REAL SettingsClient over a fake transport so
// the generated event + key constants are exercised end to end.
//
// ── 🔴 WHAT CHANGED, AND WHY IT IS A CONTRACT CHANGE ───────────────────────
// This card added `updated_at` arbitration (04 §3.7-a) and moved the settings
// edge off `connected` onto `PttSession.roomJoins` (settings_client.dart header
// points 4 and 5). Two consequences show up here:
//   · the hydration cases drive `roomJoins` instead of `pushStatus(connected)`;
//   · `ScenarioCardCache` now carries a stamp alongside the card
//     ([CachedScenarioCard]), because a card whose stamp was dropped in the
//     pipeline cannot be arbitrated at all.
// Nothing here relaxes the old promise: an un-stamped server value is still
// adopted, byte for byte as before. That is the assertion at the bottom, and it
// is the one that makes the deployment order (relay first or phone first) a
// non-question.
//
// ── REVERSE CONTROL (executed 2026-08-16) ───────────────────────────────────
// Break: delete precedence rule 4 from `ScenarioCardController._onRemoteEntry`
// (scenario_card_controller.dart) — i.e. remove the whole
// `if (_incomingIsStale(e.updatedAt)) { … return; }` block so a stale snapshot
// falls through to rule 5 and is adopted.
// OBSERVED: `+13 -1: Some tests failed.` — EXACTLY one red, and it is this one:
//   · "a STALE server snapshot never displaces a NEWER local card — and the
//      stale side is told" [E]
//     Expected: ['v2 local']
//       Actual: ['v1 server']
//     (it fails on the first assertion, before it can even reach the re-push)
// CONTROL-ON-CONTROL: "a server value with NO stamp is ADOPTED (status quo …)"
// stayed GREEN, and so did "a NEWER server snapshot IS adopted…" — the break is
// specific to stamp arbitration, not to adoption in general. Had the absent-
// stamp case gone red too, the break would have been "stop adopting" rather
// than "stop arbitrating", and this reverse control would have proved nothing.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/generated/flowmic_settings.g.dart';
import 'package:flowmic/src/settings/scenario_card.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/settings/settings_client.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

/// The admission counter, standing in for `PttSession.roomJoins` — the same
/// gesture `outbox_drains_on_room_join_test.dart` makes with
/// `session.noteRoomJoined()`.
class _Joins extends ValueNotifier<int> {
  _Joins() : super(0);
  void join() => value++;
}

({
  SettingsClient client,
  FakeSocketTransport transport,
  ScenarioCardController ctrl,
  _Joins joins,
}) _wire({CachedScenarioCard cached = CachedScenarioCard.empty}) {
  final FakeSocketTransport t = FakeSocketTransport();
  final _Joins joins = _Joins();
  final SettingsClient client = SettingsClient(transport: t, roomJoins: joins);
  final ScenarioCardController ctrl = ScenarioCardController(
    settingsClient: client,
    cache: InMemoryScenarioCardCache(cached),
  );
  return (client: client, transport: t, ctrl: ctrl, joins: joins);
}

Map<String, Object?> _lastSettingsUpdate(FakeSocketTransport t) {
  final envelopes = t.emittedWhere(FlowMicEvents.settingsUpdate);
  expect(envelopes, isNotEmpty, reason: 'expected a settings:update emit');
  return (envelopes.last.data as Map).cast<String, Object?>();
}

/// A card that is distinguishable from every other card in this file by one
/// term, so an assertion can name WHICH card won rather than merely that one did.
Map<String, Object?> _card(String term) => <String, Object?>{
      'professions': <String>[],
      'domains': <String>[],
      'packs': <String>[],
      'terms': <String>[term],
    };

void main() {
  test('toggling a profession pushes settings:update{scenario.card} with the '
      'exact schema JSON (key from the shared SSOT constant)', () async {
    final w = _wire();
    w.ctrl.toggleProfession('software development');

    final Map<String, Object?> payload = _lastSettingsUpdate(w.transport);
    // The key is the generated constant — identical to the server's
    // SETTINGS_KEY_SCENARIO_CARD. This IS the bidirectional interlock.
    expect(payload['key'], FlowMicSettingsKeys.scenarioCard);
    expect(payload['key'], 'scenario.card');
    expect(payload['value'], <String, Object?>{
      'professions': <String>['software development'],
      'domains': <String>[],
      'packs': <String>[],
      'terms': <String>[],
    });
    // A local edit is the one moment the app KNOWS an edit time, so it stamps.
    expect(payload['updated_at'], isA<String>());
    expect(DateTime.tryParse(payload['updated_at']! as String), isNotNull,
        reason: 'the server parses this; a stamp it cannot parse is treated as '
            'absent and silently loses every arbitration');
    await w.client.dispose();
  });

  test('a full structured edit assembles one card and pushes it', () async {
    final w = _wire();
    w.ctrl.toggleProfession('software development');
    w.ctrl.toggleDomain('cloud native');
    w.ctrl.togglePack('tech-dev');
    expect(w.ctrl.addTerm('灰度发布'), TermAddOutcome.added);

    final Map<String, Object?> payload = _lastSettingsUpdate(w.transport);
    expect(payload['value'], <String, Object?>{
      'professions': <String>['software development'],
      'domains': <String>['cloud native'],
      'packs': <String>['tech-dev'],
      'terms': <String>['灰度发布'],
    });
    // Four edits → four settings:update emits (save-as-you-edit, no batching / save button).
    expect(w.transport.emittedWhere(FlowMicEvents.settingsUpdate).length, 4);
    await w.client.dispose();
  });

  test('a no-op transform (rejected term) does NOT push', () async {
    final w = _wire();
    w.ctrl.addTerm('术语'); // 1 push
    final int after = w.transport.emittedWhere(FlowMicEvents.settingsUpdate).length;
    final TermAddOutcome outcome = w.ctrl.addTerm('术语'); // duplicate → no push
    expect(outcome, TermAddOutcome.duplicate);
    expect(
      w.transport.emittedWhere(FlowMicEvents.settingsUpdate).length,
      after,
    );
    await w.client.dispose();
  });

  test('the emitted event is the settings:update whitelist constant (no literal)',
      () async {
    final w = _wire();
    w.ctrl.togglePack('proper-noun');
    expect(w.transport.emittedNames, contains('settings:update'));
    expect(FlowMicEvents.settingsUpdate, 'settings:update');
    await w.client.dispose();
  });

  // ── GA-11: hydration + peer push ───────────────────────────────────────

  test('a blank card (fresh install) hydrates from the room-join snapshot',
      () async {
    final w = _wire();
    expect(w.ctrl.card.isEmpty, isTrue);
    w.transport.ackQueue.add(<String, Object?>{
      'items': <Object?>[
        <String, Object?>{
          'key': FlowMicSettingsKeys.scenarioCard,
          'value': <String, Object?>{
            'professions': <String>['software development'],
            'domains': <String>[],
            'packs': <String>['tech-dev'],
            'terms': <String>['灰度发布'],
          },
          'updated_at': '2026-08-16T09:00:00.000Z',
        },
      ],
    });

    w.joins.join();
    await Future<void>.delayed(Duration.zero);

    expect(w.ctrl.card.hasProfession('software development'), isTrue);
    expect(w.ctrl.card.hasPack('tech-dev'), isTrue);
    expect(w.ctrl.card.terms, <String>['灰度发布']);
    // Nothing visible was displaced — a first hydration is not an overwrite.
    expect(w.ctrl.remoteRefreshed, isFalse);
    // An empty local card is NOT pushed on the join: "I have nothing" is not a
    // fact worth overwriting anyone's card with.
    expect(w.transport.emittedWhere(FlowMicEvents.settingsUpdate), isEmpty);
    await w.client.dispose();
  });

  test('settings:updated{scenario.card} refreshes the card and says so; the '
      'note clears on the next local edit', () async {
    final w = _wire();
    w.ctrl.togglePack('legal'); // something visible the user already had
    int notifies = 0;
    w.ctrl.addListener(() => notifies++);

    w.transport.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{
      'key': FlowMicSettingsKeys.scenarioCard,
      'value': <String, Object?>{
        'professions': <String>[],
        'domains': <String>['legal tech'],
        'packs': <String>['legal', 'finance'],
        'terms': <String>[],
      },
      // Strictly NEWER than the stamp `togglePack` just minted (that one is
      // `DateTime.now()`), so this is rule 5 by the newer-wins route rather
      // than by the unknown-stamp route.
      'updated_at': '2099-01-01T00:00:00.000Z',
    });

    expect(w.ctrl.card.hasPack('finance'), isTrue);
    expect(w.ctrl.card.hasDomain('legal tech'), isTrue);
    expect(w.ctrl.remoteRefreshed, isTrue, reason: 'displaced a visible card');
    expect(notifies, 1);

    w.ctrl.togglePack('medical');
    expect(w.ctrl.remoteRefreshed, isFalse);
    await w.client.dispose();
  });

  test('an unrelated key does NOT refresh the card (no spurious rebuild)',
      () async {
    final w = _wire();
    w.ctrl.togglePack('legal');
    final ScenarioCard before = w.ctrl.card;
    int notifies = 0;
    w.ctrl.addListener(() => notifies++);

    w.transport.pushIncoming(FlowMicEvents.settingsUpdated,
        <String, Object?>{'key': 'stt.polish', 'value': true});
    // Same-value echo of our OWN key is also a non-event.
    w.transport.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{
      'key': FlowMicSettingsKeys.scenarioCard,
      'value': before.toJson(),
    });

    expect(w.ctrl.card, before);
    expect(notifies, 0);
    await w.client.dispose();
  });

  test('an UN-SYNCED local edit is never clobbered by a server value '
      '(last-write-wins + the pending note stays up)', () async {
    final FakeSocketTransport t = FakeSocketTransport();
    t.failEmits = true; // socket down: the edit cannot reach the server
    final SettingsClient client = SettingsClient(transport: t, roomJoins: _Joins());
    final ScenarioCardController ctrl = ScenarioCardController(
      settingsClient: client,
      cache: InMemoryScenarioCardCache(),
    );
    expect(ctrl.addTerm('本地未同步'), TermAddOutcome.added);
    expect(ctrl.syncPending, isTrue);

    // A stale server value arrives while our edit is still queued.
    t.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{
      'key': FlowMicSettingsKeys.scenarioCard,
      'value': <String, Object?>{'terms': <String>['服务端旧值']},
    });

    expect(ctrl.card.terms, <String>['本地未同步'],
        reason: 'the queued local edit is the later write — it wins');
    expect(ctrl.syncPending, isTrue, reason: 'and the user is still told so');
    expect(ctrl.remoteRefreshed, isFalse);
    ctrl.dispose();
    await client.dispose();
    await t.close();
  });

  // ── 04 §3.7-a: cross-channel convergence by `updated_at` ────────────────

  test('a STALE server snapshot never displaces a NEWER local card — and the '
      'stale side is told', () async {
    // The real scenario: the card was edited on the LAN channel, then the phone
    // switches to the cloud relay, whose database has never seen that edit.
    // Adopting there would silently undo the edit on both channels within one
    // reconnect, because this device would then push the older card back.
    final w = _wire(
      cached: const CachedScenarioCard(
        ScenarioCard(terms: <String>['v2 local']),
        '2026-08-16T12:00:00.000Z',
      ),
    );
    await w.ctrl.load();
    w.transport.emitted.clear();

    w.transport.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{
      'key': FlowMicSettingsKeys.scenarioCard,
      'value': _card('v1 server'),
      'updated_at': '2026-08-16T09:00:00.000Z', // three hours older
    });

    expect(w.ctrl.card.terms, <String>['v2 local'],
        reason: 'the older write must not win');
    expect(w.ctrl.remoteRefreshed, isFalse,
        reason: 'nothing was refreshed, so nothing may claim it was');
    // 🔴 Not merely "ignored": the reason that server is stale is that nobody
    // told it. Exactly one push, carrying OUR value and OUR stamp, so the
    // server can arbitrate it rather than take our word for it.
    final envs = w.transport.emittedWhere(FlowMicEvents.settingsUpdate);
    expect(envs, hasLength(1));
    final Map<String, Object?> p = (envs.single.data as Map).cast<String, Object?>();
    expect((p['value']! as Map)['terms'], <String>['v2 local']);
    expect(p['updated_at'], '2026-08-16T12:00:00.000Z');
    await w.client.dispose();
  });

  test('a NEWER server snapshot IS adopted (the desktop edited it five minutes '
      'ago and this phone has not)', () async {
    final w = _wire(
      cached: const CachedScenarioCard(
        ScenarioCard(terms: <String>['v2 local']),
        '2026-08-16T12:00:00.000Z',
      ),
    );
    await w.ctrl.load();
    w.transport.emitted.clear();

    w.transport.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{
      'key': FlowMicSettingsKeys.scenarioCard,
      'value': _card('v3 server'),
      'updated_at': '2026-08-16T15:00:00.000Z',
    });

    expect(w.ctrl.card.terms, <String>['v3 server']);
    expect(w.ctrl.remoteRefreshed, isTrue,
        reason: 'it displaced a card the user could already see');
    expect(w.transport.emittedWhere(FlowMicEvents.settingsUpdate), isEmpty,
        reason: 'adopting is not an edit; pushing it back would be an echo');
    await w.client.dispose();
  });

  test('a server value with NO stamp is ADOPTED (status quo — this is what '
      'makes the deployment order a non-question)', () async {
    // 🔴 THE DEPLOYMENT-SAFETY ASSERTION. An older relay strips `updated_at`
    // (it is an additive optional field), and a synthesized row never had one.
    // Both land here, and here is byte-for-byte the behaviour this method had
    // before stamps existed. If this ever goes red, a phone build has become
    // dependent on a relay build, and the two do not ship together.
    final w = _wire(
      cached: const CachedScenarioCard(
        ScenarioCard(terms: <String>['v2 local']),
        '2026-08-16T12:00:00.000Z',
      ),
    );
    await w.ctrl.load();
    w.transport.emitted.clear();

    w.transport.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{
      'key': FlowMicSettingsKeys.scenarioCard,
      'value': _card('v1 server'),
      // no updated_at at all
    });

    expect(w.ctrl.card.terms, <String>['v1 server'],
        reason: 'unknown means abstain, and abstaining means today’s behaviour');
    expect(w.ctrl.remoteRefreshed, isTrue);
    await w.client.dispose();
  });

  test('THE ABSENT ROW: settings:list omits scenario.card entirely, and the '
      'join still pushes what this device holds', () async {
    // 🔴 The half no timestamp can fix. `scenario.card` is not seeded
    // (apps/server-core/src/settings/defaults.ts), so on a server this phone has
    // never written there is NO row — settings:list simply has no such item.
    // Nothing arrives to arbitrate, and the correction pipeline runs on
    // EMPTY_CARD while the phone shows a full card and nobody is told.
    final w = _wire(
      cached: const CachedScenarioCard(
        ScenarioCard(terms: <String>['v2 local']),
        '2026-08-16T12:00:00.000Z',
      ),
    );
    await w.ctrl.load();
    w.transport.emitted.clear();
    // The snapshot the server would actually answer for such an account: the
    // seeded/synthesized rows, and no scenario.card.
    w.transport.ackQueue.add(<String, Object?>{
      'items': <Object?>[
        <String, Object?>{'key': 'stt.polish', 'value': <String, Object?>{'enabled': true}},
      ],
    });

    w.joins.join();
    await Future<void>.delayed(Duration.zero);

    final envs = w.transport.emittedWhere(FlowMicEvents.settingsUpdate);
    expect(envs, hasLength(1), reason: 'the absent row must be filled by a push');
    final Map<String, Object?> p = (envs.single.data as Map).cast<String, Object?>();
    expect(p['key'], FlowMicSettingsKeys.scenarioCard);
    expect((p['value']! as Map)['terms'], <String>['v2 local']);
    expect(p['updated_at'], '2026-08-16T12:00:00.000Z');
    // And the card the user sees is untouched by a snapshot that said nothing
    // about it.
    expect(w.ctrl.card.terms, <String>['v2 local']);
    await w.client.dispose();
  });

  test('a LEGACY prefs cache (bare card, no envelope) loads as a card with NO '
      'stamp — and therefore never blocks a server value', () async {
    // The pre-stamp cache shape lived under the same prefs key. Renaming the key
    // would have blanked every upgrading user's card, so the shape is
    // discriminated instead; the honest stamp for a value nobody ever timed is
    // no stamp.
    final w = _wire();
    w.ctrl.togglePack('legal'); // a visible card with a real, brand-new stamp
    await w.client.dispose();

    // Same controller state, but as it would come back from a legacy cache:
    // card present, stamp unknown.
    final w2 = _wire(
      cached: const CachedScenarioCard(
        ScenarioCard(terms: <String>['legacy']),
        null,
      ),
    );
    await w2.ctrl.load();
    w2.transport.emitted.clear();

    w2.transport.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{
      'key': FlowMicSettingsKeys.scenarioCard,
      'value': _card('v1 server'),
      'updated_at': '2000-01-01T00:00:00.000Z', // ancient, but OUR side is unknown
    });

    expect(w2.ctrl.card.terms, <String>['v1 server'],
        reason: 'one unknown stamp is enough to disqualify the comparison');
    await w2.client.dispose();
  });

  test('an UNPARSEABLE stamp is treated as unknown, not ranked as a string',
      () async {
    // `Iso8601` in @flowmic/protocol is `z.string().min(1)` — a name, not a
    // validator — so junk crosses the boundary. Compared lexically, 'yesterday'
    // sorts ABOVE '2026-…' and would win every arbitration forever.
    final w = _wire(
      cached: const CachedScenarioCard(
        ScenarioCard(terms: <String>['v2 local']),
        '2026-08-16T12:00:00.000Z',
      ),
    );
    await w.ctrl.load();
    w.transport.emitted.clear();

    w.transport.pushIncoming(FlowMicEvents.settingsUpdated, <String, Object?>{
      'key': FlowMicSettingsKeys.scenarioCard,
      'value': _card('junk stamped'),
      'updated_at': 'yesterday',
    });

    expect(w.ctrl.card.terms, <String>['junk stamped'],
        reason: 'unparseable = unknown = rule 5 (adopt), never a comparable');
    await w.client.dispose();
  });
}
