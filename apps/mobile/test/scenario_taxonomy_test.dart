// 2026-09-04 — the profession/domain taxonomy: stable ids, one English
// canonical per id, nine catalogue labels, and the migration off the labels
// this app used to store.
//
// ── WHAT WENT WRONG, MEASURED ────────────────────────────────────────────────
// A real device's settings backup held
//   professions: ["software development","product design","writing / editing",
//                 "devops / SRE","finance","软件开发","产品设计","云原生 / 运维"]
//   domains:     ["frontend","backend","data / ML","cloud native"]
// — the same four professions stored twice because the user had used the app in
// two UI languages, and the server's compose prompt counted EIGHT of them. That
// exact array is the fixture in 「the real device backup」 below; it is not a
// made-up worst case.
//
// 「云原生 / 运维」 is in that array and is NOT any current label, canonical or
// id (today's zh strings are 「云原生」 for the domain and 「运维 / SRE」 for the
// profession). It is the unknown-value case, and it is why the migration drops
// rather than passes through: a string nothing recognises reaching the prompt
// IS the defect.
//
// ── REVERSE CONTROL (executed 2026-09-04, see the report) ────────────────────
// Recorded at the bottom of this file, next to the case it breaks.

import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/scenario_card.dart';
import 'package:flowmic/src/settings/scenario_taxonomy.dart';
import 'package:flutter_test/flutter_test.dart';

/// The professions on the real device's backup, verbatim.
const List<String> kDeviceProfessions = <String>[
  'software development',
  'product design',
  'writing / editing',
  'devops / SRE',
  'finance',
  '软件开发',
  '产品设计',
  '云原生 / 运维',
];

const List<String> kDeviceDomains = <String>[
  'frontend',
  'backend',
  'data / ML',
  'cloud native',
];

void main() {
  final List<ScenarioAxis> axes = <ScenarioAxis>[
    ScenarioAxis.professions,
    ScenarioAxis.domains,
  ];

  group('registry completeness', () {
    test('ids are unique within an axis and across both axes', () {
      for (final ScenarioAxis axis in axes) {
        final List<String> ids = axis.ids;
        expect(ids.toSet(), hasLength(ids.length), reason: axis.name);
      }
      // Across axes too: the card keeps them in two arrays, but a reader that
      // ever indexed them together (a prompt, a log line) must not find one id
      // meaning two things.
      final Set<String> all = <String>{
        ...ScenarioAxis.professions.ids,
        ...ScenarioAxis.domains.ids,
      };
      expect(all,
          hasLength(ScenarioAxis.professions.ids.length +
              ScenarioAxis.domains.ids.length));
    });

    test('English canonicals are unique within an axis and non-empty', () {
      for (final ScenarioAxis axis in axes) {
        final List<String> canonicals = axis.options
            .map((ScenarioOption o) => o.canonical)
            .toList(growable: false);
        expect(canonicals.toSet(), hasLength(canonicals.length),
            reason: axis.name);
        for (final String c in canonicals) {
          expect(c.trim(), isNotEmpty);
        }
      }
    });

    test('ids are kebab-case (never rendered, so they may never drift into '
        'looking like copy)', () {
      final RegExp kebab = RegExp(r'^[a-z0-9]+(-[a-z0-9]+)*$');
      for (final ScenarioAxis axis in axes) {
        for (final String id in axis.ids) {
          expect(kebab.hasMatch(id), isTrue, reason: id);
        }
      }
    });

    test('every id has a real label in all nine UI locales, and the nine '
        'labels of one axis never collide across options', () {
      expect(AppLocale.values, hasLength(9));
      for (final ScenarioAxis axis in axes) {
        for (final AppLocale locale in AppLocale.values) {
          final List<String> labels = <String>[];
          for (final String id in axis.ids) {
            final String label = axis.labelIn(locale, id);
            expect(label.trim(), isNotEmpty, reason: '$id/$locale');
            // A missing catalogue entry falls through to the raw value, so an
            // id coming back as itself means nobody translated it.
            expect(label, isNot(id), reason: '$id/$locale is untranslated');
            labels.add(label);
          }
          expect(labels.toSet(), hasLength(labels.length),
              reason: 'two ${axis.name} share one label in $locale');
        }
      }
    });

    test('the migration index resolves every spelling to exactly one id — no '
        'two options answer to the same string', () {
      for (final ScenarioAxis axis in axes) {
        // 11 spellings per option (id + canonical + 9 labels); collisions
        // reduce the count, which is the thing being denied.
        final Map<String, String> index = axis.debugIndex;
        for (final ScenarioOption o in axis.options) {
          expect(index[o.id], o.id);
          expect(index[o.canonical.toLowerCase()], o.id);
          for (final AppLocale locale in AppLocale.values) {
            expect(index[axis.labelIn(locale, o.id).toLowerCase()], o.id,
                reason: '${o.id}/$locale');
          }
        }
      }
    });
  });

  group('migration', () {
    test('every locale label of every id migrates back to that id', () {
      for (final ScenarioAxis axis in axes) {
        for (final AppLocale locale in AppLocale.values) {
          for (final String id in axis.ids) {
            expect(axis.migrate(<String>[axis.labelIn(locale, id)]), <String>[id],
                reason: '${axis.name}/$id/$locale');
          }
        }
      }
    });

    test('the English canonical migrates to the id, and the id is a no-op', () {
      for (final ScenarioAxis axis in axes) {
        for (final ScenarioOption o in axis.options) {
          expect(axis.migrate(<String>[o.canonical]), <String>[o.id]);
          expect(axis.migrate(<String>[o.id]), <String>[o.id]);
        }
      }
    });

    test('matching is case- and whitespace-insensitive (the values came off a '
        'screen and out of a hand-editable file)', () {
      expect(ScenarioAxis.professions.migrate(<String>['  Software Development ']),
          <String>['software-dev']);
      expect(ScenarioAxis.domains.migrate(<String>['DATA / ML']), <String>['data-ml']);
    });

    test('two spellings of one option collapse to one entry, first-seen order '
        'kept', () {
      expect(
        ScenarioAxis.professions
            .migrate(<String>['软件开发', 'law', 'software development', 'Recht']),
        <String>['software-dev', 'law'],
      );
    });

    test('an unknown string is dropped, not passed through', () {
      expect(ScenarioAxis.professions.migrate(<String>['云原生 / 运维']), isEmpty);
      expect(ScenarioAxis.domains.migrate(<String>['', 'astrology']), isEmpty);
    });

    test('the real device backup: eight professions in two languages become '
        'five ids, and the untranslatable one is gone', () {
      expect(ScenarioAxis.professions.migrate(kDeviceProfessions), <String>[
        'software-dev',
        'product-design',
        'writing-editing',
        'devops-sre',
        'finance',
      ]);
      expect(ScenarioAxis.domains.migrate(kDeviceDomains),
          <String>['frontend', 'backend', 'data-ml', 'cloud-native']);
    });

    test('migratedToIds is idempotent and leaves packs and terms alone', () {
      final ScenarioCard legacy = ScenarioCard.fromJson(<String, Object?>{
        'professions': kDeviceProfessions,
        'domains': kDeviceDomains,
        'packs': <String>['tech-dev'],
        'terms': <Object>['灰度发布'],
      });
      final ScenarioCard once = legacy.migratedToIds();
      expect(once.migratedToIds(), once);
      expect(once.packs, <String>['tech-dev']);
      expect(once.termNames, <String>['灰度发布']);
      // A card that is ALREADY ids returns its own instance — that identity is
      // what the controller's one-time re-persist reads to decide not to write.
      expect(identical(once.migratedToIds(), once), isTrue);
      expect(identical(legacy.migratedToIds(), legacy), isFalse);
    });
  });

  group('the wire carries English canonicals, never ids and never labels', () {
    test('toWireJson maps ids to the exact strings this app has always sent', () {
      final ScenarioCard card = ScenarioCard.fromJson(<String, Object?>{
        'professions': kDeviceProfessions,
        'domains': kDeviceDomains,
        'packs': <String>['tech-dev'],
        'terms': <Object>['灰度发布'],
      }).migratedToIds();

      expect(card.toJson()['professions'], <String>[
        'software-dev',
        'product-design',
        'writing-editing',
        'devops-sre',
        'finance',
      ]);
      expect(card.toWireJson()['professions'], <String>[
        'software development',
        'product design',
        'writing / editing',
        'devops / SRE',
        'finance',
      ]);
      expect(card.toWireJson()['domains'],
          <String>['frontend', 'backend', 'data / ML', 'cloud native']);
      // Everything else is byte-for-byte the stored shape.
      expect(card.toWireJson()['packs'], card.toJson()['packs']);
      expect(card.toWireJson()['terms'], card.toJson()['terms']);
    });

    test('no non-English string can reach the wire: every localized label, fed '
        'in as a legacy value, comes out as its English canonical', () {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        final ScenarioCard card = ScenarioCard(
          professions: ScenarioAxis.professions.ids
              .map((String id) => ScenarioAxis.professions.label(s, id))
              .toList(growable: false),
        ).migratedToIds();
        expect(card.toWireJson()['professions'],
            ScenarioAxis.professions.options
                .map((ScenarioOption o) => o.canonical)
                .toList(growable: false),
            reason: '$locale');
      }
    });

    test('an id the registry does not know never reaches the wire', () {
      const ScenarioCard bogus = ScenarioCard(professions: <String>['not-a-job']);
      expect(bogus.toWireJson()['professions'], isEmpty);
    });
  });
}
