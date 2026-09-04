// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.1 (STRUCTURED scenario
//     card — profession/domain multi-select)
//   packages/protocol/src/scenario.ts (ScenarioCardSchema keeps professions and
//     domains as free `Label` strings — the protocol is NOT changed by this
//     file; what changes is which string this phone puts in them)
//   CLAUDE.md red line 「用户看得见的每个字不许是内部词汇」 — the id defined here
//     is never rendered; the catalogue label for the ACTIVE UI locale is.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Until 2026-09-04 the scenario card stored THE LABEL STRING THAT WAS ON SCREEN
// when the chip was tapped. That made the stored value a function of the UI
// language, with three measured consequences on one real device backup:
//   · the same profession was stored twice, once per language the user had
//     used — professions read
//     ["software development", … , "软件开发", "产品设计", "云原生 / 运维"];
//   · the server's compose prompt therefore counted EIGHT professions for a
//     user who had picked four;
//   · switching the UI language silently deselected every chip, because the
//     new locale's label is a different string from the stored one.
// A user of any of the nine UI languages has to see these chips in their own
// language AND have them survive a language switch, and the server's prompt
// templates are English. Those two facts want two different strings, so there
// are now two, plus a third that is neither:
//
//   id        — kebab-case, locale-independent, NEVER rendered and NEVER sent.
//               This is what the card stores and what the settings backup
//               writes. It is the only one of the three that is allowed to be
//               stable forever, because nothing about it is a translation and
//               nothing about it is copy.
//   canonical — the English name that rides `audio:start` / `compose:start`.
//               It is deliberately the EXACT string this app has always sent
//               (「software development」, 「devops / SRE」, 「data / ML」…), so
//               a server that predates this change reads a card from a phone
//               that postdates it and sees no difference at all.
//   label     — the catalogue string for the ACTIVE UI locale, resolved through
//               AppStrings.professionLabel / domainLabel. Nine languages, all
//               of which already existed; this change translated nothing.
//
// ⚠️ THE CANONICAL IS NOT A LABEL AND MUST NOT BE RENDERED. It is an English
// name for a machine reader (the prompt). The day someone shows it to a user,
// the German user is reading English again and this file bought nothing.
//
// ── THE REVERSE INDEX IS THE MIGRATION ──────────────────────────────────────
// Every string this app has ever stored in these two arrays is either an id, a
// canonical, or one of the nine locales' labels — so an index over all eleven
// spellings per option maps every legacy value home. It is built from the
// catalogue at runtime rather than typed out here, which is what stops it
// going stale the day a translation is corrected: a corrected label is a
// changed key in this index automatically, and the OLD label stops being
// recognised — a deliberate, narrow loss that scenario_taxonomy_test.dart
// states plainly rather than a table that would claim to know better.

import 'package:flutter/foundation.dart';

import '../diag/diag_log.dart';
import 'app_settings.dart' show AppLocale;
import 'app_strings.dart';

/// One row of the scenario taxonomy: a stable id and the English name that
/// rides the wire for it. The nine display labels are NOT here — they live in
/// the string catalogue with every other translated string.
@immutable
class ScenarioOption {
  const ScenarioOption({required this.id, required this.canonical});

  /// Stored on this phone and in the settings backup. Locale-independent.
  final String id;

  /// The English name sent to the server. See the header: not a label.
  final String canonical;
}

/// The professions, in the order the chips render.
const List<ScenarioOption> kProfessionOptions = <ScenarioOption>[
  ScenarioOption(id: 'software-dev', canonical: 'software development'),
  ScenarioOption(id: 'product-design', canonical: 'product design'),
  ScenarioOption(id: 'devops-sre', canonical: 'devops / SRE'),
  ScenarioOption(id: 'research', canonical: 'research'),
  ScenarioOption(id: 'writing-editing', canonical: 'writing / editing'),
  ScenarioOption(id: 'teaching', canonical: 'teaching'),
  ScenarioOption(id: 'medicine', canonical: 'medicine'),
  ScenarioOption(id: 'law', canonical: 'law'),
  ScenarioOption(id: 'finance', canonical: 'finance'),
];

/// The domains, in the order the chips render.
const List<ScenarioOption> kDomainOptions = <ScenarioOption>[
  ScenarioOption(id: 'cloud-native', canonical: 'cloud native'),
  ScenarioOption(id: 'frontend', canonical: 'frontend'),
  ScenarioOption(id: 'backend', canonical: 'backend'),
  ScenarioOption(id: 'data-ml', canonical: 'data / ML'),
  ScenarioOption(id: 'healthcare', canonical: 'healthcare'),
  ScenarioOption(id: 'legal', canonical: 'legal'),
  ScenarioOption(id: 'education', canonical: 'education'),
  ScenarioOption(id: 'ecommerce', canonical: 'e-commerce'),
];

/// How a label is looked up for one axis. Taking the resolver rather than a
/// string map is what keeps the nine translations in the catalogue instead of
/// growing a second copy here (the shadow catalogue V2-07.7 already deleted
/// once — see settings_strings.dart's own note about it).
typedef ScenarioLabelResolver = String Function(AppStrings strings, String canonical);

/// One axis of the scenario card (professions, or domains) together with
/// everything the rest of the app may ask about it: the chip order, the wire
/// name for an id, the label for an id, and the legacy migration.
class ScenarioAxis {
  ScenarioAxis._(this.name, this.options, this._resolveLabel);

  /// Diagnostic name only (`professions` / `domains`); matches the card's
  /// JSON key so a log line points at a field a reader can find.
  final String name;

  final List<ScenarioOption> options;
  final ScenarioLabelResolver _resolveLabel;

  static final ScenarioAxis professions = ScenarioAxis._(
    'professions',
    kProfessionOptions,
    (AppStrings s, String canonical) => s.professionLabel(canonical),
  );

  static final ScenarioAxis domains = ScenarioAxis._(
    'domains',
    kDomainOptions,
    (AppStrings s, String canonical) => s.domainLabel(canonical),
  );

  /// The ids in chip order — what the settings screen iterates.
  List<String> get ids =>
      options.map((ScenarioOption o) => o.id).toList(growable: false);

  ScenarioOption? optionOf(String id) {
    for (final ScenarioOption o in options) {
      if (o.id == id) return o;
    }
    return null;
  }

  /// The English wire name for [id], or null when [id] is not in the registry.
  String? canonicalOf(String id) => optionOf(id)?.canonical;

  /// The chip label for [id] in [strings]' language. An id the registry does
  /// not know returns the id itself rather than an empty chip — that is a bug
  /// path, and a visible one beats a blank one.
  String label(AppStrings strings, String id) {
    final ScenarioOption? o = optionOf(id);
    return o == null ? id : _resolveLabel(strings, o.canonical);
  }

  /// The chip label for [id] in [locale]. Used by the migration index and by
  /// tests; the screen goes through [label] with the AppStrings it already has.
  String labelIn(AppLocale locale, String id) => label(AppStrings.of(locale), id);

  /// id / canonical / every locale's label -> id. Built once, lazily: it calls
  /// into the catalogue, so it cannot be const, and building it at import time
  /// would run nine locale classes' constructors for an app that may never
  /// open the settings screen.
  late final Map<String, String> _index = _buildIndex();

  Map<String, String> _buildIndex() {
    final Map<String, String> index = <String, String>{};
    void put(String key, String id) {
      final String k = _normalize(key);
      // First writer wins. A collision would mean two options answer to one
      // spelling, which scenario_taxonomy_test.dart refuses outright — this
      // guard only decides what a build with such a collision would DO, and
      // 「the earlier chip」 is at least deterministic.
      index.putIfAbsent(k, () => id);
    }

    for (final ScenarioOption o in options) {
      put(o.id, o.id);
      put(o.canonical, o.id);
      for (final AppLocale locale in AppLocale.values) {
        put(labelIn(locale, o.id), o.id);
      }
    }
    return index;
  }

  /// Case- and whitespace-insensitive, because the strings being matched came
  /// off a screen and out of a hand-editable JSON file, not off a wire with a
  /// schema. Nothing beyond that is normalised: 「devops / SRE」 keeps its
  /// spaces around the slash because that is how it was stored.
  static String _normalize(String raw) => raw.trim().toLowerCase();

  /// The id [raw] means, or null if this axis has never had such a value.
  String? idOf(String raw) => _index[_normalize(raw)];

  /// Turn whatever is in a stored card into ids.
  ///
  /// Three transforms, in this order, and each of them is a decision:
  ///   · a value that resolves (id, canonical, or any locale's label) becomes
  ///     its id — this is what makes 「软件开发」 and 「software development」
  ///     stop being two professions;
  ///   · a value that does not resolve is DROPPED, not passed through. Passing
  ///     it through is exactly the bug: an unrecognised string reaching the
  ///     prompt is what let a localized label be counted as a profession;
  ///   · the result is de-duplicated, keeping first-seen order, because two
  ///     spellings of one profession collapsing to one id would otherwise
  ///     leave the id in the list twice.
  ///
  /// The cap is NOT applied here: [ScenarioCard] owns the caps, and a migration
  /// that silently truncated would answer a question ("which eight?") that
  /// nobody asked it.
  List<String> migrate(List<String> raw) {
    final List<String> out = <String>[];
    int dropped = 0;
    for (final String value in raw) {
      final String? id = idOf(value);
      if (id == null) {
        dropped++;
        continue;
      }
      if (!out.contains(id)) out.add(id);
    }
    if (dropped > 0 || out.length != raw.length) {
      // ⚠️ COUNTS ONLY, NEVER THE VALUE. This trail is uploaded to the PC on
      // request (diag_log.dart header: transcript text and typed text must
      // never enter it), and a value that failed to resolve is by definition a
      // string we cannot vouch for the provenance of.
      diag('scenario.migrate', <String, Object?>{
        'axis': name,
        'in': raw.length,
        'out': out.length,
        'dropped': dropped,
      });
    }
    return List<String>.unmodifiable(out);
  }

  /// ids -> the English names the server's prompt reads. An id the registry
  /// does not know is dropped for the same reason [migrate] drops it: the
  /// failure this whole file exists to stop is an unvetted string reaching the
  /// prompt, and a card that has been through [migrate] cannot contain one.
  List<String> toCanonical(List<String> ids) {
    final List<String> out = <String>[];
    for (final String id in ids) {
      final String? canonical = canonicalOf(id);
      if (canonical == null) {
        diag('scenario.wire_drop', <String, Object?>{'axis': name});
        continue;
      }
      out.add(canonical);
    }
    return List<String>.unmodifiable(out);
  }

  @visibleForTesting
  Map<String, String> get debugIndex => Map<String, String>.unmodifiable(_index);
}
