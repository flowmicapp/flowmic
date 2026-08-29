// Part of compose_band.dart — the collapsed draft PREVIEW STRIP, split out of
// compose_buffer_row.dart at the 800-line cap (repo standing move: a STRUCTURAL
// split, evidence intact — [ComposeBufferPreview] and its whole reasoning block
// moved VERBATIM, not one sentence rewritten).
//
// SPEC-REF:
//   docs/ui-design/2026-08-06-fb3-fb4-composer-redesign.md §3 (row 2)
//   docs/ui-design/2026-08-27-nr4p3-edit-sheet-and-at-cancel-design.md §3 (the
//     two-line clamp + the origin glyph)
//
// ⚠️ The key `compose.preview` and its children (`compose.preview.text`,
// `compose.preview.count`, `compose.preview.origin`, `compose.preview.tap`) did
// NOT move with the file. Tests find this strip by key, and a structural split
// that renames anything is no longer a structural split.

part of 'compose_band.dart';

// ── SHARED COMPONENTS (plain row + floating card, one implementation) ───────

/// 🔴 T-2 (0.2.63, owner Q3㋐) — the cell row 2 shows when idle, key
/// `compose.preview`.
///
/// ── WHY THIS IS A StatelessWidget AND NOT A "READ-ONLY TextField" ─────────
/// owner's own words judged row 2's fake box as "not particularly
/// meaningful", and its **concrete harm** is that it is tappable: a
/// `readOnly: true` TextField still grabs focus, still pops the system
/// keyboard, and is still an `EditableText` in the tree. Design doc §9 ④
/// therefore writes the criterion as a **TYPE**, not an appearance — "the
/// preview strip is **NOT** a TextField (it CANNOT grab focus or pop the
/// keyboard)". This cell being unable to do that thing **is structural**, not
/// something switched off by a boolean.
///
/// ⚠️ This does NOT conflict with D4 — it is actually the same rule: D4
/// guards against **automatically** popping the keyboard; this cell cannot
/// pop it even **manually** — the keyboard only comes up through T-3's
/// expanded face (which the user taps by hand).
///
/// ── THREE FACES (design doc §3's S1/S2/S3 and S8) ──────────────────────
///   · buffer empty (S1/S3): one line of small entry-point text
///     [AppStrings.composeEntryStrip], t3;
///   · buffer non-empty (S2): a single-line preview (ellipsis) + word count,
///     body text color;
///   · `!enabled` (S8): a grey strip + the existing sentence
///     [AppStrings.composeDisabled], and it is **inert** — **it doesn't even
///     build an InkWell**. This is deliberately NOT "an InkWell with
///     onTap: null": the latter is still a control that swallows a tap,
///     while S8's contract is that this cell accepts nothing at all.
///
/// 🔴 The word count goes through **the one and only copy in this repo**,
/// `textWordCount` + [AppStrings
/// .entryWordCountLabel] (`entry_metrics.dart`'s file header states, verbatim,
/// "Do not add a second `.length` … anywhere else in the app"). Writing
/// `buffer.length` would let "how many words is this" have one answer on the
/// live draft row and another on this cell, and the two answers would
/// diverge the moment Chinese and English text are mixed — a literal replay
/// of this repo's #1 bug shape.
class ComposeBufferPreview extends StatelessWidget {
  const ComposeBufferPreview({
    super.key,
    required this.strings,
    required this.enabled,
    required this.buffer,
    required this.onTap,
    this.origin,
  });

  final AppStrings strings;

  /// ChatController.canCompose. false ⇒ S8: grey, can say why, accepts nothing.
  final bool enabled;

  /// The authoritative buffer text (ChatController.buffer).
  final String buffer;

  /// T-3: opens the expanded face. **No friendly default** (anti-façade
  /// rule ②) — an entry-point strip that does nothing when tapped is exactly
  /// the kind of thing this card exists to eliminate.
  final VoidCallback onTap;

  /// NR-4 (e), 2026-08-27 — `true` this draft was spoken, `false` it was
  /// typed, `null` there is no draft.
  ///
  /// SPEC-REF: docs/ui-design/2026-08-27-nr4p3-edit-sheet-and-at-cancel-design.md §3
  ///
  /// 🔴 A PARAMETER, NOT A LOOKUP, AND THAT IS THE ASSERTION WORTH KEEPING.
  /// The fact has ONE author (`_ChatFlowPageState._sheetSrcVoice`) and the
  /// sheet's own header already reads it to pick between 「transcribed」 and
  /// 「typed」. Reading it here through an `InheritedWidget` or a controller
  /// would give the strip a second, independent way to answer the same
  /// question — and the day the two disagreed, the mic icon on the collapsed
  /// row and the header inside the sheet would contradict each other about the
  /// same sentence. `compose_preview_origin_test.dart` pins that this widget
  /// only ever reports what it was handed.
  ///
  /// ⚠️ There is no 「appending」 value on purpose. The sheet header's rule is
  /// `appending > voice > typed`; the first rung cannot occur while the sheet
  /// is COLLAPSED, so the collapsed face is the same rule with an unreachable
  /// branch removed — not a second, similar rule.
  final bool? origin;

  @override
  Widget build(BuildContext context) {
    final String text = buffer.trim();
    final bool has = text.isNotEmpty;
    // The glyph rides on the same `enabled && has` gate as the word count: S8
    // is not showing a draft at all (it is saying the cell is closed), and an
    // empty buffer has no origin to report.
    final Widget? originGlyph = !(enabled && has) || origin == null
        ? null
        : origin!
        ? MicGlyph(size: 14, color: FlowMicDockColors.sub)
        : Icon(
            Icons.edit_outlined,
            size: 14,
            color: FlowMicDockColors.sub,
          );
    final Widget strip = Container(
      key: const ValueKey<String>('compose.preview'),
      // 🔴 WP8 VF-2 — the mock's `.hint{height:44px;border:1px solid var(--line);
      // border-radius:13px;padding:0 14px;color:var(--sub);font-size:13px}`.
      // ⚠️ 38 → 44 REOPENS the 320/360dp width account the T-2 comment here
      // warned about, and it was re-measured rather than assumed: the strip is
      // the row's only flexible child ("row width − 44 − 8"), so the extra 6dp is
      // pure HEIGHT — the width account is untouched by it. The horizontal
      // padding did move (4 → 14), and that IS width; it is bought back by the
      // trailing chevron leaving (see below), which was 4 + 15.
      constraints: const BoxConstraints(minHeight: kComposeTouchTarget),
      padding: const EdgeInsets.symmetric(horizontal: 14),
      decoration: BoxDecoration(
        border: Border.all(color: FlowMicDockColors.line),
        borderRadius: BorderRadius.circular(13),
      ),
      alignment: Alignment.centerLeft,
      // NR-4 (e) — TWO nested Rows, and the nesting is what puts each piece on
      // the line it belongs to. Outer is `start`, so the origin glyph rides
      // beside the FIRST word; inner is `end` and is exactly as tall as the
      // text, so the word count hugs the LAST line instead of floating beside
      // the first one.
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (originGlyph != null) ...<Widget>[
            Padding(
              key: const ValueKey<String>('compose.preview.origin'),
              // 1dp down: the glyph's optical centre sits slightly above a
              // 13px line's.
              padding: const EdgeInsets.only(right: 6, top: 1),
              child: originGlyph,
            ),
          ],
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: <Widget>[
                Expanded(
                  child: Text(
                    !enabled
                        ? strings.composeDisabled
                        : has
                        ? text
                        : strings.composeEntryStrip,
                    key: const ValueKey<String>('compose.preview.text'),
                    // 🔴 NR-4 (e), 2026-08-27: 1 → 2. The paragraph this
                    // replaces argued that ONE line 「is the definition of a
                    // preview」, and the argument survives verbatim at two:
                    // this is still a preview, it still ellipsises, and the way
                    // to read the whole draft is still to tap it open. What the
                    // ledger's row (e) reported is that one line of a 13px font
                    // in a 44dp strip shows so little of a dictated sentence
                    // that the user cannot tell WHICH draft is sitting there —
                    // and 「which one is this」 is the question the collapsed
                    // row exists to answer.
                    //
                    // ⚠️ `maxLines` being SET is what keeps
                    // `didExceedMaxLines` a real instrument here. The lesson in
                    // onboarding_view.dart's `_body` is the opposite case (no
                    // `maxLines` ⇒ the reading is permanently false); this one
                    // sets it deliberately, so the truncation test can go red.
                    //
                    // The 0.2.53 rule still applies, just to a different
                    // surface: "can the entry-point sentence be read in full"
                    // is judged on the RENDERED result (see
                    // compose_preview_strip_test.dart's four-language
                    // measurement assertions).
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      // The mock gives the strip ONE type size (13px) and
                      // colours the draft apart from the placeholder rather
                      // than sizing it apart.
                      color: enabled && has
                          ? FlowMicDockColors.ink
                          : FlowMicDockColors.sub,
                      fontSize: 13,
                    ),
                  ),
                ),
                if (enabled && has) ...<Widget>[
                  const SizedBox(width: 6),
                  // 🔴 STILL ITS OWN `Text`, deliberately not a trailing
                  // `TextSpan` inside the sentence above. Inside, it would be
                  // the first thing the ellipsis ate — on exactly the long
                  // drafts where knowing the length is worth something.
                  Text(
                    strings.entryWordCountLabel(textWordCount(buffer)),
                    key: const ValueKey<String>('compose.preview.count'),
                    maxLines: 1,
                    style: TextStyle(
                      color: FlowMicDockColors.sub,
                      fontSize: 10.5,
                    ),
                  ),
                ],
                // 🔴 THE TRAILING `keyboard_arrow_up` IS GONE (mock `.hint` is
                // a bare bordered field — every A-frame draws it with text
                // only). The affordance it carried did not evaporate: the
                // strip's whole surface is the tap target, the Semantics label
                // below still SAYS what the tap does, and the Tooltip still
                // names it on long-press. What the chevron bought was a second,
                // silent copy of that promise; what it cost was 19dp of the
                // narrowest row on the narrowest screen.
              ],
            ),
          ),
        ],
      ),
    );
    // S8: inert — no InkWell wrapper, so it doesn't even swallow one tap.
    if (!enabled) return strip;
    return Tooltip(
      message: strings.composeExpandHint,
      child: Semantics(
        label: '${has ? text : strings.composeEntryStrip} · '
            '${strings.composeExpandHint}',
        button: true,
        child: InkWell(
          key: const ValueKey<String>('compose.preview.tap'),
          onTap: onTap,
          borderRadius: BorderRadius.circular(13),
          child: strip,
        ),
      ),
    );
  }
}
