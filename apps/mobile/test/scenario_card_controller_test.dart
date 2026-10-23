// WP-R3-3 (rewritten 2026-09-03, WP-B2) — the scenario card is PHONE-OWNED and
// the controller has NO wire.
//
// owner rulings (docs/decisions/2026-09-03-owner-web-rulings-phone-owned-settings.md
// Q6/Q7 plus 追加裁定二 ②): the card lives only on this phone; each phone has its
// own; and it reaches a server by riding the request that starts a transcription
// cycle. So this controller's whole contract is two sentences:
//
//   ① every edit applies the capped transform and persists to the device-local
//      store immediately — no save button, no staging;
//   ② nothing it does puts a frame on any wire. The card is READ from [card] by
//      settings/phone_prefs_payload.dart when `audio:start` / `compose:start`
//      is built, and that path is pinned in phone_prefs_payload_test.dart.
//
// The push-era cases (「every edit pushes settings:update」, 「every admission
// re-pushes」, 「offline ⇒ pending ⇒ re-pushed」) are DELETED, not ported: they
// specified a mechanism the server now refuses, and a test that keeps asserting
// a deleted mechanism is how a deletion gets quietly undone. What survives from
// them is ②'s negative half, which is asserted against the WHOLE transport
// rather than against one event name (G13 rule 1: 「only one event name did not
// arrive」 proves nothing).
//
// ── REVERSE CONTROL (executed 2026-09-03) ──────────────────────────────────
// See phone_prefs_payload_test.dart's header: putting a `settings:update` back
// on the wire is the break, and it is recorded there because that file owns the
// 「no settings writer left」 assertion for the whole app.

import 'dart:convert';

import 'package:flowmic/generated/flowmic_settings.g.dart';
import 'package:flowmic/src/settings/scenario_card.dart';
import 'package:flowmic/src/settings/scenario_card_controller.dart';
import 'package:flowmic/src/settings/scenario_taxonomy.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

({ScenarioCardController ctrl, InMemoryScenarioCardCache cache}) _wire({
  ScenarioCard cached = ScenarioCard.empty,
}) {
  final InMemoryScenarioCardCache cache = InMemoryScenarioCardCache(cached);
  return (ctrl: ScenarioCardController(cache: cache), cache: cache);
}

void main() {
  // ── ① apply-and-save-immediately ──────────────────────────────────────────
  test('toggling a profession applies the transform and persists it in the same '
      'breath — no save button', () async {
    final w = _wire();
    w.ctrl.toggleProfession('software-dev');

    expect(w.ctrl.card.hasProfession('software-dev'), isTrue);
    expect((await w.cache.load()).professions, <String>['software-dev']);
    w.ctrl.dispose();
  });

  test('the card exposes exactly the ScenarioCardSchema JSON the bundle carries', () async {
    final w = _wire();
    w.ctrl.toggleProfession('software-dev');
    expect(w.ctrl.card.toJson(), <String, Object?>{
      'professions': <String>['software-dev'],
      'domains': <String>[],
      'packs': <String>[],
      'terms': <Object>[],
    });
    // No stamp: there is no second writer to arbitrate against any more.
    expect(w.ctrl.card.toJson().containsKey('updated_at'), isFalse);
    w.ctrl.dispose();
  });

  test('a term with aliases keeps the {term, aliases} shape and a bare term '
      'stays a bare string', () async {
    final w = _wire();
    expect(w.ctrl.addTerm('FlowMic', aliases: <String>['flow mic', 'flomic']),
        TermAddOutcome.added);
    expect(w.ctrl.addTerm('幂等'), TermAddOutcome.added);

    expect(w.ctrl.card.toJson()['terms'], <Object>[
      <String, Object?>{'term': 'FlowMic', 'aliases': <String>['flow mic', 'flomic']},
      '幂等',
    ]);
    w.ctrl.dispose();
  });

  test('a no-op transform (rejected term) changes nothing and writes nothing', () async {
    final w = _wire();
    expect(w.ctrl.addTerm('   '), TermAddOutcome.empty);
    expect(w.ctrl.card.isEmpty, isTrue);
    expect((await w.cache.load()).isEmpty, isTrue);
    w.ctrl.dispose();
  });

  test('load() hydrates from the device-local store — THE copy', () async {
    final w = _wire(
      cached: const ScenarioCard(terms: <ScenarioTerm>[ScenarioTerm('灰度发布')]),
    );
    await w.ctrl.load();
    expect(w.ctrl.card.termNames, <String>['灰度发布']);
    w.ctrl.dispose();
  });

  test('adopt() (the settings restore path) replaces the card and persists it', () async {
    final w = _wire();
    w.ctrl.adopt(const ScenarioCard(domains: <String>['frontend']));
    expect(w.ctrl.card.domains, <String>['frontend']);
    expect((await w.cache.load()).domains, <String>['frontend']);
    w.ctrl.dispose();
  });

  // ── the store: every shape ever written loads ─────────────────────────────
  test('a stamped-era envelope cache loads its card and drops the stamp; a bare '
      'card loads as-is; a term written as {term, aliases} keeps its aliases', () async {
    final InMemoryScenarioCardCache bare = InMemoryScenarioCardCache(
      ScenarioCard.fromJson(<String, Object?>{
        'professions': <String>['law'],
        'domains': <String>[],
        'packs': <String>[],
        'terms': <Object>['A', <String, Object?>{'term': 'B', 'aliases': <String>['bee']}],
      }),
    );
    final ScenarioCard loaded = await bare.load();
    expect(loaded.professions, <String>['law']);
    expect(loaded.terms, const <ScenarioTerm>[
      ScenarioTerm('A'),
      ScenarioTerm('B', aliases: <String>['bee']),
    ]);
    // The envelope form is read by SharedPrefsScenarioCardCache; its
    // discrimination is exercised in settings_backup_test.dart over real mock
    // SharedPreferences, where the envelope can actually be planted.
  });

  // ── ③ the one-time id migration (2026-09-04) ──────────────────────────────
  test('load() folds a pre-id card (labels from two UI languages) onto ids AND '
      'writes the migrated card back to the store in the same breath', () async {
    final InMemoryScenarioCardCache cache = InMemoryScenarioCardCache(
      ScenarioCard.fromJson(<String, Object?>{
        // The real device's array, verbatim (scenario_taxonomy_test.dart).
        'professions': <String>[
          'software development', 'product design', 'writing / editing',
          'devops / SRE', 'finance', '软件开发', '产品设计', '云原生 / 运维',
        ],
        'domains': <String>['frontend', 'data / ML'],
        'packs': <String>['tech-dev'],
        'terms': <Object>['灰度发布'],
      }),
    );
    final ScenarioCardController ctrl = ScenarioCardController(cache: cache);
    await ctrl.load();

    expect(ctrl.card.professions, <String>[
      'software-dev', 'product-design', 'writing-editing', 'devops-sre', 'finance',
    ]);
    expect(ctrl.card.domains, <String>['frontend', 'data-ml']);
    // 🔴 THE HALF THAT IS EASY TO MISS: the STORE, not just the in-memory card.
    // The settings backup exports straight out of the store, so a migration
    // that only lived in memory would ship the duplicates to the next phone.
    expect((await cache.load()).professions, ctrl.card.professions);
    expect(ctrl.card.packs, <String>['tech-dev']);
    expect(ctrl.card.termNames, <String>['灰度发布']);
    ctrl.dispose();
  });

  test('load() of a card that is already ids writes nothing (the migration is '
      'one-time, not a write on every boot)', () async {
    final _CountingCache cache = _CountingCache(
      const ScenarioCard(professions: <String>['law'], domains: <String>['legal']),
    );
    final ScenarioCardController ctrl = ScenarioCardController(cache: cache);
    await ctrl.load();
    expect(ctrl.card.professions, <String>['law']);
    expect(cache.saves, 0);
    ctrl.dispose();
  });

  // ── FM-001: a card already on the phone that breaks a schema cap ──────────
  // The state a phone is left in by a pre-FM-001 restore of a hand-edited
  // backup. Planted as RAW JSON in real mock SharedPreferences through the
  // production cache, because the bug lives in the parse: an in-memory card
  // would skip the very step that let it in.
  //
  // ── REVERSE CONTROL (executed 2026-10-16) ─────────────────────────────────
  // Break: drop `.normalizedToLimits()` from ScenarioCardController.load.
  // OBSERVED: this test went red on the first wire-cap expectation (the term
  // count — Expected: <= 100, Actual: 108).
  test('load() brings an over-limit stored card inside every wire cap and writes '
      'the normalized card back; a second load writes nothing', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{
      SharedPrefsScenarioCardCache.cacheKey: jsonEncode(<String, Object?>{
        'professions': ScenarioAxis.professions.ids, // nine, cap is eight
        'domains': <String>['frontend', 'frontend'],
        'packs': <Object>[for (int i = 0; i < 17; i++) 'pack-$i', 'p' * 41],
        'terms': <Object>[
          // The tester's shape first (47 chars each), then a 41-char one, a
          // padded duplicate, and enough short legal terms to overflow 100.
          for (int i = 0; i < 3; i++) '${i.toString().padLeft(3, '0')}${'x' * 44}',
          'y' * 41,
          '  ok  ', 'ok',
          for (int i = 0; i < 101; i++) 't$i',
          <String, Object?>{
            'term': 'FlowMic',
            'aliases': <String>[
              'FlowMic', 'z' * 41, 'flow mic', 'flow mic',
              for (int i = 0; i < 9; i++) 'alias $i',
            ],
          },
        ],
      }),
    });
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    final SharedPrefsScenarioCardCache store = SharedPrefsScenarioCardCache(prefs);
    expect((await store.load()).terms.length, greaterThan(FlowMicScenarioLimits.maxTerms),
        reason: 'precondition: the parse really lets an over-limit card in');

    final ScenarioCardController ctrl = ScenarioCardController(cache: store);
    await ctrl.load();

    // The wire caps, asserted on toWireJson() itself — not through the
    // card's own fitsWireSchema, which would be grading its own homework.
    final Map<String, Object?> wire = ctrl.card.toWireJson();
    bool label(Object? v) =>
        v is String && v.trim().isNotEmpty && v.trim().length <= FlowMicScenarioLimits.maxLabelLen;
    final List<Object?> terms = wire['terms']! as List<Object?>;
    expect(terms.length, lessThanOrEqualTo(FlowMicScenarioLimits.maxTerms));
    expect((wire['professions']! as List<Object?>).length,
        lessThanOrEqualTo(FlowMicScenarioLimits.maxProfessions));
    expect((wire['domains']! as List<Object?>).length,
        lessThanOrEqualTo(FlowMicScenarioLimits.maxDomains));
    expect((wire['packs']! as List<Object?>).length,
        lessThanOrEqualTo(FlowMicScenarioLimits.maxPacks));
    for (final String k in <String>['professions', 'domains', 'packs']) {
      expect((wire[k]! as List<Object?>).every(label), isTrue, reason: k);
    }
    for (final Object? t in terms) {
      if (t is String) {
        expect(label(t), isTrue, reason: t);
      } else {
        final Map<Object?, Object?> m = t! as Map<Object?, Object?>;
        expect(label(m['term']), isTrue);
        final List<Object?> aliases = m['aliases']! as List<Object?>;
        expect(aliases.length, lessThanOrEqualTo(FlowMicScenarioLimits.maxAliasesPerTerm));
        expect(aliases.every(label), isTrue);
      }
    }
    expect(ctrl.card.fitsWireSchema, isTrue);

    // What survives is the head of each array, in order, deduped.
    expect(ctrl.card.professions,
        ScenarioAxis.professions.ids.take(FlowMicScenarioLimits.maxProfessions).toList());
    expect(ctrl.card.domains, <String>['frontend']);
    expect(ctrl.card.packs.first, 'pack-0');
    // Over-long dropped, padded duplicate folded, then the head up to 100.
    expect(ctrl.card.termNames,
        <String>['ok', for (int i = 0; i < FlowMicScenarioLimits.maxTerms - 1; i++) 't$i']);

    // Re-persisted: the STORE holds the normalized card (the backup exports
    // straight out of it), and loading it again changes nothing.
    expect(await store.load(), ctrl.card);
    final _CountingCache again = _CountingCache(await store.load());
    final ScenarioCardController ctrl2 = ScenarioCardController(cache: again);
    await ctrl2.load();
    expect(again.saves, 0);
    ctrl.dispose();
    ctrl2.dispose();
  });

  test('normalizedToLimits keeps the legal part of each entry: trims, drops a '
      'blank/over-long/self alias, dedupes, caps aliases at eight', () {
    final ScenarioCard c = ScenarioCard.fromJson(<String, Object?>{
      'professions': <String>[],
      'domains': <String>[],
      'packs': <String>[],
      'terms': <Object>[
        <String, Object?>{
          'term': 'FlowMic',
          'aliases': <String>[
            'FlowMic', 'z' * 41, 'flow mic', 'flow mic',
            for (int i = 0; i < 9; i++) 'alias $i',
          ],
        },
        'FlowMic',
      ],
    }).normalizedToLimits();
    expect(c.terms, hasLength(1));
    expect(c.terms.single.aliases, <String>[
      'flow mic',
      for (int i = 0; i < FlowMicScenarioLimits.maxAliasesPerTerm - 1; i++) 'alias $i',
    ]);
    expect(identical(c.normalizedToLimits(), c), isTrue, reason: 'idempotent');
  });
}

/// A cache that counts writes — the only way to tell 「migrated once」 from
/// 「re-persisted on every boot」.
class _CountingCache implements ScenarioCardCache {
  _CountingCache(this._card);
  ScenarioCard _card;
  int saves = 0;

  @override
  Future<ScenarioCard> load() async => _card;

  @override
  Future<void> save(ScenarioCard card) async {
    saves++;
    _card = card;
  }
}
