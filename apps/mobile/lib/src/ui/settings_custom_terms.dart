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
              for (final String term in card.terms)
                settingsRow(
                  child: Row(
                    children: <Widget>[
                      Expanded(
                        child: Text(term, style: TextStyle(color: FlowMicColors.t1, fontSize: 13)),
                      ),
                      InkWell(
                        onTap: () => scenario.removeTerm(term),
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
    final TextEditingController tc = TextEditingController();
    final String? entered = await showDialog<String>(
      context: context,
      builder: (BuildContext ctx) => AlertDialog(
        backgroundColor: FlowMicColors.surface,
        title: Text(s.addTerm, style: TextStyle(color: FlowMicColors.t1, fontSize: 15)),
        content: TextField(
          controller: tc,
          autofocus: true,
          maxLength: FlowMicScenarioLimits.maxLabelLen,
          style: TextStyle(color: FlowMicColors.t1),
          decoration: InputDecoration(
            hintText: s.termInputHint,
            hintStyle: TextStyle(color: FlowMicColors.t3),
            counterStyle: TextStyle(color: FlowMicColors.t3),
          ),
          onSubmitted: (String v) => Navigator.of(ctx).pop(v),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: Text(s.cancel, style: TextStyle(color: FlowMicColors.t2)),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(tc.text),
            child: Text(s.add, style: TextStyle(color: FlowMicColors.brand)),
          ),
        ],
      ),
    );
    tc.dispose();
    if (entered == null) return;
    final TermAddOutcome outcome = scenario.addTerm(entered);
    if (outcome != TermAddOutcome.added && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(s.termAddError(_feedback(outcome)))),
      );
    }
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
    case TermAddOutcome.added:
      return TermFeedback.empty; // unreachable — added never surfaces an error
  }
}
