// WP-R3-3 — the STRUCTURED scenario card model: profession/domain/pack toggles
// (idempotent, capped) + custom-term add (trim → non-empty → ≤40 → dedupe → cap)
// + exactly-ScenarioCardSchema toJson. These caps mirror the protocol zod schema
// (FlowMicScenarioLimits, generated from the SSOT) so a card assembled here
// always survives the server round-trip. SPEC-REF: master-plan §4.1.

import 'package:flowmic/generated/flowmic_settings.g.dart';
import 'package:flowmic/src/settings/scenario_card.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('membership toggles (chips / checkboxes)', () {
    test('toggle adds then removes; idempotent per value', () {
      ScenarioCard c = ScenarioCard.empty;
      c = c.toggleProfession('software development');
      expect(c.hasProfession('software development'), isTrue);
      c = c.toggleProfession('software development');
      expect(c.hasProfession('software development'), isFalse);
    });

    test('professions cap refuses the over-cap add (schema-safe)', () {
      ScenarioCard c = ScenarioCard.empty;
      for (int i = 0; i < FlowMicScenarioLimits.maxProfessions + 3; i++) {
        c = c.toggleProfession('prof-$i');
      }
      expect(c.professions.length, FlowMicScenarioLimits.maxProfessions);
    });

    test('pack toggle stores the pack id (the ScenarioCard.packs contract)', () {
      final ScenarioCard c = ScenarioCard.empty.togglePack('tech-dev');
      expect(c.packs, <String>['tech-dev']);
      expect(c.hasPack('tech-dev'), isTrue);
    });
  });

  group('custom terms', () {
    test('a normal term is trimmed and added', () {
      final TermAddResult r = ScenarioCard.empty.addTerm('  幂等  ');
      expect(r.outcome, TermAddOutcome.added);
      expect(r.card.terms, <String>['幂等']);
    });

    test('empty / whitespace-only term is rejected', () {
      expect(ScenarioCard.empty.addTerm('   ').outcome, TermAddOutcome.empty);
      expect(ScenarioCard.empty.addTerm('').outcome, TermAddOutcome.empty);
    });

    test('term over the ≤40 cap is rejected', () {
      final String tooLong = 'a' * (FlowMicScenarioLimits.maxLabelLen + 1);
      expect(ScenarioCard.empty.addTerm(tooLong).outcome, TermAddOutcome.tooLong);
      // exactly 40 is allowed
      final String exact = 'b' * FlowMicScenarioLimits.maxLabelLen;
      expect(ScenarioCard.empty.addTerm(exact).outcome, TermAddOutcome.added);
    });

    test('duplicate term is rejected', () {
      final ScenarioCard one = ScenarioCard.empty.addTerm('SenseVoice').card;
      expect(one.addTerm('SenseVoice').outcome, TermAddOutcome.duplicate);
    });

    test('term count cap is enforced', () {
      ScenarioCard c = ScenarioCard.empty;
      for (int i = 0; i < FlowMicScenarioLimits.maxTerms; i++) {
        c = c.addTerm('t$i').card;
      }
      expect(c.terms.length, FlowMicScenarioLimits.maxTerms);
      expect(c.termsAtCap, isTrue);
      final TermAddResult over = c.addTerm('one-too-many');
      expect(over.outcome, TermAddOutcome.atCap);
      expect(over.card.terms.length, FlowMicScenarioLimits.maxTerms);
    });

    test('removeTerm drops exactly the term', () {
      final ScenarioCard c =
          ScenarioCard.empty.addTerm('A').card.addTerm('B').card.removeTerm('A');
      expect(c.terms, <String>['B']);
    });
  });

  group('serialization is exactly the ScenarioCardSchema shape', () {
    test('toJson emits the four required arrays', () {
      final ScenarioCard c = ScenarioCard.empty
          .toggleProfession('software development')
          .toggleDomain('cloud native')
          .togglePack('tech-dev')
          .addTerm('灰度发布')
          .card;
      expect(c.toJson(), <String, Object?>{
        'professions': <String>['software development'],
        'domains': <String>['cloud native'],
        'packs': <String>['tech-dev'],
        'terms': <String>['灰度发布'],
      });
    });

    test('empty card round-trips to four empty arrays', () {
      expect(ScenarioCard.empty.toJson(), <String, Object?>{
        'professions': <String>[],
        'domains': <String>[],
        'packs': <String>[],
        'terms': <String>[],
      });
    });

    test('fromJson tolerates a malformed blob (degrades to empty)', () {
      expect(ScenarioCard.fromJson('not-a-map'), ScenarioCard.empty);
      expect(
        ScenarioCard.fromJson(<String, Object?>{'professions': 'nope', 'terms': <Object>[1, 'ok']}),
        const ScenarioCard(professions: <String>[], terms: <String>['ok']),
      );
    });

    test('fromJson(toJson) is an identity round-trip', () {
      final ScenarioCard c = ScenarioCard.empty
          .toggleProfession('research')
          .togglePack('proper-noun')
          .addTerm('FlowMic')
          .card;
      expect(ScenarioCard.fromJson(c.toJson()), c);
    });
  });
}
