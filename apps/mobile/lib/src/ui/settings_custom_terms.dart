// Part of settings_page.dart — the 自定义术语 (custom terms) family.
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// Same shape and same reason as ptt_wire_keepalive.dart (0.2.52 §5):
// settings_page.dart crossed the 800-line cap (`verify/lint/file-size.mjs`
// SRC_MAX=800) when U9 gave the About card a real version row, and that row
// brought a `version` field with it. Dart has no partial classes, so the state
// has to stay on the class and only BEHAVIOUR can move out.
//
// This family was chosen because it is the largest fully self-contained one
// left: two methods plus one pure helper, no field of its own, and no caller
// outside this library (grep: `_customTermsSection` and `_showAddTerm` have two
// call sites between them, both in settings_page.dart). Nothing about the
// custom-terms feature changed in this pass — the reason it moved is the line
// count of a DIFFERENT card.
//
// 🔴 DIFF DISCIPLINE: the bodies below are moved **character-for-character**.
// There are exactly two mechanical edits, and **any other difference in the
// diff is a bug**:
//   ① the two instance methods become extension members, so both existing call
//      sites are untouched;
//   ② `_feedback` loses its `static` and becomes a library-private top-level
//      function, its body de-indented by the two spaces that class membership
//      was paying for. An extension's static members can only be reached as
//      `SettingsPageCustomTerms._feedback(...)`, which would have forced an
//      edit inside `_showAddTerm` at the one line that calls it. It was already
//      pure (it never touched `this`), so top-level costs nothing and keeps
//      that call site byte-identical.

part of 'settings_page.dart';

extension SettingsPageCustomTerms on SettingsPage {
  // ── CUSTOM TERMS ──────────────────────────────────────────────────────────
  Widget _customTermsSection(BuildContext context, AppStrings s) {
    final ScenarioCard card = scenario.card;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(2, 14, 2, 6),
          child: Row(
            children: <Widget>[
              Text(
                s.secCustomTerms.toUpperCase(),
                style: TextStyle(color: FlowMicColors.t3, fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 0.5),
              ),
              const SizedBox(width: 8),
              Text(
                s.termCounter(card.terms.length, FlowMicScenarioLimits.maxTerms),
                style: TextStyle(color: FlowMicColors.t3, fontSize: 11),
              ),
            ],
          ),
        ),
        settingsCard(
          child: Column(
            children: <Widget>[
              // 2026-09-03 (owner Q1): a term may carry the other spellings it
              // stands for; they render as a second line under the term so
              // the row still reads as ONE entry with one ✕.
              for (final ScenarioTerm term in card.terms)
                settingsRow(
                  child: Row(
                    children: <Widget>[
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text(term.term, style: TextStyle(color: FlowMicColors.t1, fontSize: 13)),
                            if (term.aliases.isNotEmpty) ...<Widget>[
                              const SizedBox(height: 2),
                              Text(s.termAliasesLabel(term.aliases.join(', ')), style: kRowSub),
                            ],
                          ],
                        ),
                      ),
                      InkWell(
                        onTap: () => scenario.removeTerm(term.term),
                        child: Icon(Icons.close, size: 15, color: FlowMicColors.t3),
                      ),
                    ],
                  ),
                ),
              settingsRow(
                last: true,
                child: Row(
                  children: <Widget>[
                    ghostButton(
                      s.addTerm,
                      icon: Icons.add,
                      onTap: card.termsAtCap ? null : () => _showAddTerm(context, s),
                    ),
                    const SizedBox(width: 10),
                    // Expanded, not [Spacer + rigid Text]: with two rigid ends
                    // this row overflowed 360dp by 12px under Ahem, and real
                    // fonts leave only ~20px of margin on a 320dp screen in ru
                    // (≈242px of 262px, measured 2026-08-17) — one notch of
                    // the system accessibility scale (which FlowMicTextScaler
                    // multiplies in) eats that. Expanded + textAlign.end keeps
                    // the hint right-flush and lets it wrap instead of
                    // striping. Pinned by the zero-overflow assertion in
                    // spoken_language_test.dart ("0.2.53 law").
                    Expanded(
                      child: Text(
                        s.termMaxHint,
                        textAlign: TextAlign.end,
                        style: TextStyle(color: FlowMicColors.t2, fontSize: 12),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Future<void> _showAddTerm(BuildContext context, AppStrings s) async {
    // 2026-09-03 (owner Q1): an optional second field for the other spellings,
    // comma-separated. The dialog returns BOTH texts so the pair is added in
    // one commit; splitting and trimming is the model's job (ScenarioCard.addTerm).
    //
    // The two TextEditingControllers live in the dialog's own State now, not
    // in this method: disposing them the moment `showDialog` returned — the
    // one-field version's shape — left the fields rebuilding against a
    // disposed controller during the route's exit animation (measured in
    // settings_general_prefs_widget_test.dart as 「A TextEditingController was
    // used after being disposed」 on the aliases field).
    final ({String term, String aliases})? entered =
        await showDialog<({String term, String aliases})>(
      context: context,
      builder: (BuildContext ctx) => _AddTermDialog(strings: s),
    );
    if (entered == null) return;
    final TermAddOutcome outcome = scenario.addTerm(
      entered.term,
      aliases: entered.aliases.split(','),
    );
    if (outcome != TermAddOutcome.added && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(s.termAddError(_feedback(outcome)))),
      );
    }
  }
}

/// The add-term dialog: the term, and the other spellings it stands for.
/// Owns its two controllers so their lifetime is the dialog's (see _showAddTerm).
class _AddTermDialog extends StatefulWidget {
  const _AddTermDialog({required this.strings});
  final AppStrings strings;

  @override
  State<_AddTermDialog> createState() => _AddTermDialogState();
}

class _AddTermDialogState extends State<_AddTermDialog> {
  final TextEditingController _term = TextEditingController();
  final TextEditingController _aliases = TextEditingController();

  @override
  void dispose() {
    _term.dispose();
    _aliases.dispose();
    super.dispose();
  }

  void _submit() =>
      Navigator.of(context).pop((term: _term.text, aliases: _aliases.text));

  @override
  Widget build(BuildContext context) {
    final AppStrings s = widget.strings;
    return AlertDialog(
      backgroundColor: FlowMicColors.surface,
      title: Text(s.addTerm, style: TextStyle(color: FlowMicColors.t1, fontSize: 15)),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          TextField(
            controller: _term,
            autofocus: true,
            maxLength: FlowMicScenarioLimits.maxLabelLen,
            style: TextStyle(color: FlowMicColors.t1),
            decoration: InputDecoration(
              hintText: s.termInputHint,
              hintStyle: TextStyle(color: FlowMicColors.t3),
              counterStyle: TextStyle(color: FlowMicColors.t3),
            ),
            onSubmitted: (_) => _submit(),
          ),
          TextField(
            key: const ValueKey<String>('settings.term.aliases'),
            controller: _aliases,
            style: TextStyle(color: FlowMicColors.t1),
            decoration: InputDecoration(
              hintText: s.termAliasesHint,
              hintStyle: TextStyle(color: FlowMicColors.t3),
            ),
            onSubmitted: (_) => _submit(),
          ),
        ],
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(s.cancel, style: TextStyle(color: FlowMicColors.t2)),
        ),
        TextButton(
          onPressed: _submit,
          child: Text(s.add, style: TextStyle(color: FlowMicColors.brand)),
        ),
      ],
    );
  }
}

TermFeedback _feedback(TermAddOutcome o) {
  switch (o) {
    case TermAddOutcome.empty:
      return TermFeedback.empty;
    case TermAddOutcome.tooLong:
      return TermFeedback.tooLong;
    case TermAddOutcome.duplicate:
      return TermFeedback.duplicate;
    case TermAddOutcome.atCap:
      return TermFeedback.atCap;
    case TermAddOutcome.aliasTooLong:
      return TermFeedback.aliasTooLong;
    case TermAddOutcome.tooManyAliases:
      return TermFeedback.tooManyAliases;
    case TermAddOutcome.added:
      return TermFeedback.empty; // unreachable — added never surfaces an error
  }
}
