// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.1 (STRUCTURED scenario
//     card — profession/domain multi-select + dictionary-pack checkboxes +
//     custom-term list; each term ≤40 chars, arrays capped; explicitly NOT a
//     free-form ≤500-char prompt — a free text box would be a user-defined
//     prompt template, which would effectively void constraint #2)
//   packages/protocol/src/scenario.ts (ScenarioCardSchema: professions ≤8 /
//     domains ≤8 / packs ≤16 / terms ≤100, each label trimmed non-empty ≤40)
//
// The mobile-side mirror of the protocol ScenarioCard. Kept STRUCTURED (four
// typed arrays) on purpose — there is deliberately no free-text field beyond the
// per-term ≤40-char labels. Every transform enforces the SAME caps the server
// zod schema enforces (FlowMicScenarioLimits, generated from the SSOT), so a card
// assembled here always survives the server round-trip; the compose pipeline
// (WP-R1-4) then renders it as a delimited "background data, not instructions"
// block. toJson() is exactly the ScenarioCardSchema shape.

import 'package:flutter/foundation.dart';

import '../../generated/flowmic_settings.g.dart';

/// Why an add-term attempt did (not) mutate the card — drives inline UI feedback.
enum TermAddOutcome { added, empty, tooLong, duplicate, atCap }

/// The result of [ScenarioCard.addTerm]: the (possibly unchanged) card + outcome.
typedef TermAddResult = ({ScenarioCard card, TermAddOutcome outcome});

@immutable
class ScenarioCard {
  const ScenarioCard({
    this.professions = const <String>[],
    this.domains = const <String>[],
    this.packs = const <String>[],
    this.terms = const <String>[],
  });

  final List<String> professions;
  final List<String> domains;
  final List<String> packs;
  final List<String> terms;

  static const ScenarioCard empty = ScenarioCard();

  bool get isEmpty =>
      professions.isEmpty && domains.isEmpty && packs.isEmpty && terms.isEmpty;

  int get selectionCount =>
      professions.length + domains.length + packs.length + terms.length;

  ScenarioCard _copy({
    List<String>? professions,
    List<String>? domains,
    List<String>? packs,
    List<String>? terms,
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

  // ── custom terms (the only free-input field; each ≤40 chars) ────────────
  /// Add a custom term, mirroring the protocol `Term` rule (trim → non-empty →
  /// ≤40) plus a client-side dedupe and the ≤100 cap. Returns the outcome so the
  /// UI can explain a rejected add (apply-and-save-immediately has nothing to save; a bad add just
  /// no-ops with a reason).
  TermAddResult addTerm(String raw) {
    final String t = raw.trim();
    if (t.isEmpty) return (card: this, outcome: TermAddOutcome.empty);
    if (t.length > FlowMicScenarioLimits.maxLabelLen) {
      return (card: this, outcome: TermAddOutcome.tooLong);
    }
    if (terms.contains(t)) return (card: this, outcome: TermAddOutcome.duplicate);
    if (terms.length >= FlowMicScenarioLimits.maxTerms) {
      return (card: this, outcome: TermAddOutcome.atCap);
    }
    return (
      card: _copy(terms: <String>[...terms, t]),
      outcome: TermAddOutcome.added,
    );
  }

  ScenarioCard removeTerm(String term) =>
      _copy(terms: terms.where((String e) => e != term).toList(growable: false));

  bool get termsAtCap => terms.length >= FlowMicScenarioLimits.maxTerms;

  // ── (de)serialization — exactly ScenarioCardSchema ──────────────────────
  Map<String, Object?> toJson() => <String, Object?>{
    'professions': professions,
    'domains': domains,
    'packs': packs,
    'terms': terms,
  };

  /// Defensive load from the local cache. A malformed blob degrades to the empty
  /// card rather than throwing (the authoritative copy lives server-side; a
  /// corrupt local cache must never wedge the settings screen).
  factory ScenarioCard.fromJson(Object? json) {
    if (json is! Map) return ScenarioCard.empty;
    List<String> strs(String key) {
      final Object? v = json[key];
      if (v is! List) return const <String>[];
      return v.whereType<String>().toList(growable: false);
    }

    return ScenarioCard(
      professions: strs('professions'),
      domains: strs('domains'),
      packs: strs('packs'),
      terms: strs('terms'),
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
