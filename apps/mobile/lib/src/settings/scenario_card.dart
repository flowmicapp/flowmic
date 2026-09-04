// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.1 (STRUCTURED scenario
//     card — profession/domain multi-select + dictionary-pack checkboxes +
//     custom-term list; each term ≤40 chars, arrays capped; explicitly NOT a
//     free-form ≤500-char prompt — a free text box would be a user-defined
//     prompt template, which would effectively void constraint #2)
//   packages/protocol/src/scenario.ts (ScenarioCardSchema: professions ≤8 /
//     domains ≤8 / packs ≤16 / terms ≤100, each label trimmed non-empty ≤40;
//     TermEntrySchema — a term is EITHER a bare string OR {term, aliases?},
//     aliases ≤8 per term)
//   docs/decisions/2026-09-03-owner-web-rulings-phone-owned-settings.md Q1
//     (the personal dictionary retires; a custom term may carry aliases)
//
// The mobile-side mirror of the protocol ScenarioCard. Kept STRUCTURED (four
// typed arrays) on purpose — there is deliberately no free-text field beyond the
// per-term ≤40-char labels. Every transform enforces the SAME caps the server
// zod schema enforces (FlowMicScenarioLimits, generated from the SSOT), so a
// card assembled here always survives the server round-trip; the compose
// pipeline (WP-R1-4) then renders it as a delimited "background data, not
// instructions" block. toJson() is exactly the ScenarioCardSchema shape.
//
// 2026-09-04 (profession/domain ids): `professions` and `domains` hold STABLE
// IDS now, not the label that happened to be on screen when the chip was
// tapped. [toJson] (this phone's store + the settings backup) writes ids;
// [toWireJson] (audio:start / compose:start) writes the English canonical
// names the server's prompt templates have always read, so the protocol is
// untouched. [migratedToIds] folds every value this app ever stored — ids,
// canonicals, and all nine locales' labels — back onto ids. Why that mattered
// and what it cost a real device is in scenario_taxonomy.dart's header.
//
// 2026-09-03 (WP-B): a term is now [ScenarioTerm] — a spelling plus the other
// spellings it stands for. On the wire a term WITHOUT aliases is still the bare
// string it has always been (so a server that predates aliases parses every card
// this phone sends, and a cache written before aliases existed loads unchanged);
// only a term that actually has aliases takes the `{term, aliases}` object form.

import 'package:flutter/foundation.dart';

import '../../generated/flowmic_settings.g.dart';
import 'scenario_taxonomy.dart';

/// Why an add-term attempt did (not) mutate the card — drives inline UI feedback.
enum TermAddOutcome {
  added,
  empty,
  tooLong,
  duplicate,
  atCap,
  /// One of the aliases is longer than the per-label cap.
  aliasTooLong,
  /// More aliases than one term may carry.
  tooManyAliases,
}

/// The result of [ScenarioCard.addTerm]: the (possibly unchanged) card + outcome.
typedef TermAddResult = ({ScenarioCard card, TermAddOutcome outcome});

/// One custom term: the canonical spelling and the other spellings the engine
/// should read as it. [aliases] is empty for a term entered without any.
@immutable
class ScenarioTerm {
  const ScenarioTerm(this.term, {this.aliases = const <String>[]});

  final String term;
  final List<String> aliases;

  /// The wire/cache form. Bare string when there are no aliases — see the file
  /// header for why that is a compatibility rule and not a space saving.
  Object toJson() => aliases.isEmpty
      ? term
      : <String, Object?>{'term': term, 'aliases': aliases};

  /// Accepts BOTH shapes the schema allows. Anything else (a number, an object
  /// without a usable `term`) is null so a malformed entry drops rather than
  /// becoming a blank term.
  static ScenarioTerm? tryFromJson(Object? json) {
    if (json is String) {
      final String t = json.trim();
      return t.isEmpty ? null : ScenarioTerm(t);
    }
    if (json is! Map) return null;
    final Object? term = json['term'];
    if (term is! String || term.trim().isEmpty) return null;
    final Object? rawAliases = json['aliases'];
    final List<String> aliases = rawAliases is List
        ? rawAliases
            .whereType<String>()
            .map((String a) => a.trim())
            .where((String a) => a.isNotEmpty)
            .toList(growable: false)
        : const <String>[];
    return ScenarioTerm(term.trim(), aliases: aliases);
  }

  @override
  bool operator ==(Object other) =>
      other is ScenarioTerm &&
      term == other.term &&
      listEquals(aliases, other.aliases);

  @override
  int get hashCode => Object.hash(term, Object.hashAll(aliases));

  @override
  String toString() =>
      aliases.isEmpty ? term : '$term (${aliases.join(', ')})';
}

@immutable
class ScenarioCard {
  const ScenarioCard({
    this.professions = const <String>[],
    this.domains = const <String>[],
    this.packs = const <String>[],
    this.terms = const <ScenarioTerm>[],
  });

  final List<String> professions;
  final List<String> domains;
  final List<String> packs;
  final List<ScenarioTerm> terms;

  static const ScenarioCard empty = ScenarioCard();

  bool get isEmpty =>
      professions.isEmpty && domains.isEmpty && packs.isEmpty && terms.isEmpty;

  int get selectionCount =>
      professions.length + domains.length + packs.length + terms.length;

  /// The canonical spellings only — what the term list, the counter and the
  /// duplicate check look at.
  List<String> get termNames =>
      terms.map((ScenarioTerm t) => t.term).toList(growable: false);

  ScenarioCard _copy({
    List<String>? professions,
    List<String>? domains,
    List<String>? packs,
    List<ScenarioTerm>? terms,
  }) => ScenarioCard(
    professions: professions ?? this.professions,
    domains: domains ?? this.domains,
    packs: packs ?? this.packs,
    terms: terms ?? this.terms,
  );

  // ── membership toggles (chips / checkboxes) ─────────────────────────────
  // Toggling OFF is always allowed; toggling ON is refused (returns the same
  // card) once the array is at its cap, so the card can never exceed the schema.
  ScenarioCard toggleProfession(String value) =>
      _copy(professions: _toggle(professions, value, FlowMicScenarioLimits.maxProfessions));

  ScenarioCard toggleDomain(String value) =>
      _copy(domains: _toggle(domains, value, FlowMicScenarioLimits.maxDomains));

  ScenarioCard togglePack(String id) =>
      _copy(packs: _toggle(packs, id, FlowMicScenarioLimits.maxPacks));

  static List<String> _toggle(List<String> list, String value, int cap) {
    if (list.contains(value)) {
      return list.where((String e) => e != value).toList(growable: false);
    }
    if (list.length >= cap) return list; // at cap → refuse the add
    return <String>[...list, value];
  }

  bool hasProfession(String v) => professions.contains(v);
  bool hasDomain(String v) => domains.contains(v);
  bool hasPack(String id) => packs.contains(id);
  bool hasTerm(String term) => termNames.contains(term);

  // ── custom terms (the only free-input field; each ≤40 chars) ────────────
  /// Add a custom term, mirroring the protocol `Term` rule (trim → non-empty →
  /// ≤40) plus a client-side dedupe and the ≤100 cap. Returns the outcome so the
  /// UI can explain a rejected add (apply-and-save-immediately has nothing to
  /// save; a bad add just no-ops with a reason).
  ///
  /// [aliases] go through the same per-label rule; blanks are dropped, the
  /// canonical spelling and repeats are folded out, and more than the protocol
  /// cap is refused rather than truncated — silently keeping eight of ten is a
  /// choice the user did not make.
  TermAddResult addTerm(String raw, {List<String> aliases = const <String>[]}) {
    final String t = raw.trim();
    if (t.isEmpty) return (card: this, outcome: TermAddOutcome.empty);
    if (t.length > FlowMicScenarioLimits.maxLabelLen) {
      return (card: this, outcome: TermAddOutcome.tooLong);
    }
    if (hasTerm(t)) return (card: this, outcome: TermAddOutcome.duplicate);
    if (terms.length >= FlowMicScenarioLimits.maxTerms) {
      return (card: this, outcome: TermAddOutcome.atCap);
    }
    final List<String> cleaned = <String>[];
    for (final String a in aliases) {
      final String alias = a.trim();
      if (alias.isEmpty || alias == t || cleaned.contains(alias)) continue;
      if (alias.length > FlowMicScenarioLimits.maxLabelLen) {
        return (card: this, outcome: TermAddOutcome.aliasTooLong);
      }
      cleaned.add(alias);
    }
    if (cleaned.length > FlowMicScenarioLimits.maxAliasesPerTerm) {
      return (card: this, outcome: TermAddOutcome.tooManyAliases);
    }
    return (
      card: _copy(terms: <ScenarioTerm>[...terms, ScenarioTerm(t, aliases: cleaned)]),
      outcome: TermAddOutcome.added,
    );
  }

  ScenarioCard removeTerm(String term) => _copy(
        terms: terms.where((ScenarioTerm e) => e.term != term).toList(growable: false),
      );

  bool get termsAtCap => terms.length >= FlowMicScenarioLimits.maxTerms;

  // ── legacy values -> ids (2026-09-04) ───────────────────────────────────
  /// Fold `professions` / `domains` onto the taxonomy's stable ids: a value
  /// that is already an id stays put, a value that is an English canonical or
  /// any of the nine locales' labels becomes its id, a value nothing knows is
  /// dropped, and two spellings of one option collapse into one entry.
  ///
  /// IDEMPOTENT on purpose — it is called on every load, and it has to be safe
  /// to call on a card that has already been through it. That is also what
  /// makes `migrated != original` a usable answer to 「did this load actually
  /// change anything on disk」, which is how the one-time re-persist decides
  /// whether to write (scenario_card_controller.dart `load`).
  ///
  /// `packs` and `terms` are deliberately untouched: pack ids were always
  /// protocol ids, and a term is the user's own word.
  ScenarioCard migratedToIds() {
    final List<String> p = ScenarioAxis.professions.migrate(professions);
    final List<String> d = ScenarioAxis.domains.migrate(domains);
    if (listEquals(p, professions) && listEquals(d, domains)) return this;
    return _copy(professions: p, domains: d);
  }

  // ── (de)serialization — exactly ScenarioCardSchema ──────────────────────
  /// THE STORED shape: ids in `professions` / `domains`. This is what the
  /// device-local cache and the settings backup file hold.
  Map<String, Object?> toJson() => <String, Object?>{
    'professions': professions,
    'domains': domains,
    'packs': packs,
    'terms': terms.map((ScenarioTerm t) => t.toJson()).toList(growable: false),
  };

  /// THE WIRE shape: the same object with `professions` / `domains` rendered as
  /// the English canonical names. It is a SEPARATE method rather than a flag on
  /// [toJson] because the two answer different questions — 「what does this
  /// phone remember」 and 「what does the prompt read」 — and the whole reason
  /// this card was wrong for a year is that one value answered both.
  ///
  /// 🔴 The protocol is unchanged: ScenarioCardSchema still takes free `Label`
  /// strings, and these are byte-for-byte the strings this app has always sent.
  Map<String, Object?> toWireJson() => <String, Object?>{
    ...toJson(),
    'professions': ScenarioAxis.professions.toCanonical(professions),
    'domains': ScenarioAxis.domains.toCanonical(domains),
  };

  /// Defensive load from the local cache. A malformed blob degrades to the empty
  /// card rather than throwing (a corrupt local cache must never wedge the
  /// settings screen). Every term shape the schema has ever allowed loads.
  factory ScenarioCard.fromJson(Object? json) {
    if (json is! Map) return ScenarioCard.empty;
    List<String> strs(String key) {
      final Object? v = json[key];
      if (v is! List) return const <String>[];
      return v.whereType<String>().toList(growable: false);
    }

    final Object? rawTerms = json['terms'];
    final List<ScenarioTerm> terms = rawTerms is List
        ? rawTerms
            .map(ScenarioTerm.tryFromJson)
            .whereType<ScenarioTerm>()
            .toList(growable: false)
        : const <ScenarioTerm>[];

    return ScenarioCard(
      professions: strs('professions'),
      domains: strs('domains'),
      packs: strs('packs'),
      terms: terms,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is ScenarioCard &&
      listEquals(professions, other.professions) &&
      listEquals(domains, other.domains) &&
      listEquals(packs, other.packs) &&
      listEquals(terms, other.terms);

  @override
  int get hashCode => Object.hash(
    Object.hashAll(professions),
    Object.hashAll(domains),
    Object.hashAll(packs),
    Object.hashAll(terms),
  );

  @override
  String toString() =>
      'ScenarioCard(prof:$professions, dom:$domains, packs:$packs, terms:$terms)';
}
