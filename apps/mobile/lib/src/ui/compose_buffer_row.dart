// Part of compose_band.dart — row 2's (the buffer/edit row) plain form, plus
// three components shared across files (the buffer box / policy chip /
// buffer hint strip).
//
// SPEC-REF:
//   docs/ui-design/2026-08-11-ai-pills-edit-mode-and-floating-confirm.md §2
//   docs/ui-design/2026-08-06-fb8-manual-send-edit-flow.md §3 (flow design)
//   docs/ui-design/2026-08-06-fb3-fb4-composer-redesign.md §3 (row 2)
//   docs/decisions/2026-08-06-owner-rulings-ui-mcp-pairing.md D4
//
// ── Ruling #4 (2026-08-11): the FB-8 confirm card MOVED OUT of this file ──────
// In edit mode ([composeEditHold]), row 2 no longer swaps in-place into a
// confirm card — it steps aside entirely: the card became a page-level
// overlay, living in chat_flow_edit_card.dart (a `part` file of
// chat_flow_page), pinned to the bottom of the timeline. What remains here is:
//   · [_bufferRow]: the step-aside branch (edit mode ⇒ full-width zero-height
//     placeholder) + the plain form;
//   · [_plainBufferRow]: direct, or manual with the buffer still empty;
//   · [ComposeBufferPreview]: since T-2, **the cell row 2 draws when idle**
//     (not an input field);
//   · [ComposeBufferField] / [SendPolicyChip] / [ComposeModeSwitchHint]:
//     the plain row and the floating card **share the exact same**
//     components (one component, one key, one author) — these three are
//     made public exactly so the floating card never has to copy a second one.
//
// FB-8 §2's position has not changed: buffer folding, snapshot sending, noted
// settlement, the outbox's six send sites — all existing mechanisms. This
// card, wherever it lives, adds not one line of new delivery logic.
//
// ── 🔴 T-2 (0.2.63, owner Q3㋐): row 2 idle **no longer has a TextField** ────
// Design doc §2-1/§3: all four states S1/S2/S3/S8 render [ComposeBufferPreview].
// ⇒ [ComposeBufferField] **has no callers left** in this file: its two homes
// today are both page-level (the floating card chat_flow_edit_card.dart's S4,
// and T-3's expanded face), and the two are mutually exclusive, so the key
// `compose.field` is still unique across the whole tree. It stays in this file
// because **it IS the one shared component those two homes use** (the file
// header's "one component, one key, one author" holds unchanged).

part of 'compose_band.dart';

extension _ComposeBufferRow on _ComposeBandState {
  // 🔴 The `_speaking` yield that stood here moved UP a level in PA-1 (the
  // whole band returns a full-width zero-height box outside the three idle
  // faces — [composeIdleRowsVisible], SUP-4), and the `_editHold` yield died
  // with PA-4: a manual non-empty draft now shows the FULL idle row with the
  // draft in the preview strip (contract §4 A2) — the edit surface is the
  // page-level sheet, which COVERS this row instead of swapping it out.

  Widget _bufferRow() => _plainBufferRow();

  // ── PLAIN FORM (PA-1 / contract §4 A1–A2: `[+][preview]`, no other cells) ─
  Widget _plainBufferRow() => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: <Widget>[
      if (widget.buffer.trim().isNotEmpty) ...<Widget>[
        ComposeModeSwitchHint(strings: widget.strings),
        const SizedBox(height: 6),
      ],
      Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: <Widget>[
          ...widget.leading,
          // 🔴 T-2: this cell is the preview strip, not an input field. PA-1
          // (SUP-2/SUP-3) removed the
          // policy chip and the send button from this row, so the strip now
          // takes everything after `[+]` — the width account is simply
          // "row width − 44 − 8" at every width.
          Expanded(child: _previewStrip()),
        ],
      ),
    ],
  );

  /// The cell row 2 draws when idle (S1/S2/S3/S8).
  Widget _previewStrip() => ComposeBufferPreview(
    strings: widget.strings,
    enabled: widget.enabled,
    buffer: widget.buffer,
    onTap: widget.onExpand,
  );
}

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

  @override
  Widget build(BuildContext context) {
    final String text = buffer.trim();
    final bool has = text.isNotEmpty;
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
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(
              !enabled
                  ? strings.composeDisabled
                  : has
                  ? text
                  : strings.composeEntryStrip,
              key: const ValueKey<String>('compose.preview.text'),
              // Single line + ellipsis is the definition of a **preview**. The
              // 0.2.53 rule still applies, just to a different surface: "can
              // the entry-point sentence be read in full" is judged on the
              // RENDERED result (see compose_preview_strip_test.dart's
              // four-language measurement assertions); while a long draft
              // being truncated to one line **is this card's spec**, not a
              // defect — the path to reading the full text is tapping it open.
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                // The mock gives the strip ONE type size (13px) and colours the
                // draft apart from the placeholder rather than sizing it apart.
                color: enabled && has
                    ? FlowMicDockColors.ink
                    : FlowMicDockColors.sub,
                fontSize: 13,
              ),
            ),
          ),
          if (enabled && has) ...<Widget>[
            const SizedBox(width: 6),
            Text(
              strings.entryWordCountLabel(textWordCount(buffer)),
              key: const ValueKey<String>('compose.preview.count'),
              maxLines: 1,
              style: TextStyle(color: FlowMicDockColors.sub, fontSize: 10.5),
            ),
          ],
          // 🔴 THE TRAILING `keyboard_arrow_up` IS GONE (mock `.hint` is a bare
          // bordered field — every A-frame draws it with text only). The
          // affordance it carried did not evaporate: the strip's whole surface
          // is the tap target, the Semantics label below still SAYS what the
          // tap does, and the Tooltip still names it on long-press. What the
          // chevron bought was a second, silent copy of that promise; what it
          // cost was 19dp of the narrowest row on the narrowest screen.
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

/// The editable buffer box (key `compose.field`). ONE widget for its two homes
/// (floating edit card / T-3 expanded face) so 「16px / D4 no-autofocus / hint
/// precedence」 cannot fork between them.
///
/// 🔴 WP8 VF-4 — THE BOX IS GONE, AND THAT IS THE HEADLINE OF THIS ROUND.
/// Visual-fidelity contract §0 row **D5** is the delta the owner rejected WP7
/// over: 「Sheet body = text inside a gray rounded box」 vs the mock's
/// 「**Naked 16sp/1.75 text on the white sheet panel** — no inner box」. The
/// mock's `.bdy` is `font-size:16px;line-height:1.75;flex:1` and NOTHING else —
/// no background, no border, no radius, no inset of its own (its left edge is
/// the sheet's 16dp padding, which is why the horizontal padding died here too:
/// 12dp of it would indent the body relative to the header above it).
///
/// ⚠️ Only the FACE moved. The key, the controller/focus wiring, `isDense` +
/// the four [InputBorder.none]s, the hint precedence, `minLines`/[maxLines] and
/// the T-5 `alignment` rule are byte-for-byte what they were.
class ComposeBufferField extends StatelessWidget {
  const ComposeBufferField({
    super.key,
    required this.controller,
    required this.strings,
    required this.enabled,
    required this.buffer,
    required this.onChanged,
    this.focusNode,
    this.maxLines = 5,
  });

  final TextEditingController controller;
  final AppStrings strings;
  final bool enabled;
  final String buffer;
  final ValueChanged<String> onChanged;

  /// 🔴 T-3: the page's focus node, supplied ONLY by the expanded face so that
  /// "tap the preview strip ⇒ expand and focus" can be one step (owner Q3㋐).
  ///
  /// ⚠️ Null everywhere else, and that is the D4 boundary in one line: the
  /// floating card passes nothing, so it still cannot pull the keyboard up by
  /// appearing. The alternative — `autofocus: true` — would fire on EVERY
  /// mount, which is precisely the rule D4 states.
  final FocusNode? focusNode;

  /// 🔴 T-5 (0.2.63, owner supplementary ruling #4 "the edit surface should
  /// use as much screen as reasonably possible" 「编辑界面要尽量占屏大一些」)
  /// — THE CEILING, AND WHY IT IS A PARAMETER RATHER THAN A NEW NUMBER.
  ///
  /// The default is 5, byte-identical to what this widget hard-coded before, so
  /// the plain row (and every test that measures it) is unchanged. The floating
  /// edit card passes `null` = "no line ceiling" and BOUNDS THE FIELD WITH ITS
  /// PARENT instead (a loose `Flexible` inside the card's Column, whose own
  /// ceiling is the timeline Stack minus the 10dp gaps) — design doc §6-2 rule
  /// 2: "the ceiling changes from 'five lines' to 'the card's available height'".
  ///
  /// ⚠️ The two homes now differ in ONE property, and that is the point rather
  /// than a fork: "how many lines tall" is a question about the SPACE the
  /// field is standing in, and the two homes stand in different spaces.
  /// Everything the header's "cannot fork between them" was protecting — the
  /// 14px face, the D4 no-autofocus, the hint precedence — is still decided
  /// here, once.
  ///
  /// ⚠️ `expands` stays FALSE: with `maxLines: null` the field sizes to its
  /// CONTENT and only then gets clamped by the parent, which is what keeps
  /// design doc §6-2 rule 1 ("a short draft must never be forced to fill the
  /// whole screen") true. `expands: true` would fill the
  /// available height at one character.
  final int? maxLines;

  @override
  Widget build(BuildContext context) {
    // Placeholder precedence: not-connected reason > idle hint.
    //
    // 🔴 T-4 RETIRED THE MIDDLE BRANCH (design doc §3 S5 / §9 ⑦). It read
    // "buffer empty and interim non-empty ⇒ treat interim as the
    // placeholder", i.e. the live words were drawn HERE as a one-line
    // ellipsised placeholder while they were ALSO growing in the timeline's
    // live draft row. Two faces for one fact, and the worse of the two won
    // the user's attention because it sat right above the speak key. S5
    // settles it by structure instead of by priority: row 2 is not laid out
    // at all while recording, and `liveText` has exactly ONE render site in
    // the whole app.
    // ⚠️ `interimText` went with it — the parameter, its two call sites and its
    // `''` default. A branch nobody can reach plus an input nobody passes is how
    // this face would quietly come back (R8: never leave dead content behind).
    // ⚠️ The guard is a TEST, not this comment: anti-façade rule ④ says a
    // comment asserting somebody else's behaviour cannot notice when that
    // behaviour changes. See live_interim_single_render_site_test.dart.
    final String hint = !enabled ? strings.composeDisabled : strings.composeHint;
    return Container(
      // 🔴 WP8 VF-4 / contract §0 D5: NO `decoration` and NO horizontal padding.
      // The wrapper survives for two reasons only, both structural: the 38dp
      // floor (a one-line draft still gets a real touch target) and the T-5
      // `alignment` rule below. The moment it carries a fill or a border again,
      // the rejected "gray rounded box" is back — sheet_faces_test.dart's
      // naked-body guard asserts on this very RenderObject's decoration.
      constraints: const BoxConstraints(minHeight: 38),
      // 🔴 T-5, MEASURED: `alignment` is what made the first cut of the tall
      // card fill the screen at ONE character. A `Container` with an alignment
      // wraps its child in a factor-less `Align`, and `RenderPositionedBox`
      // takes `constraints.biggest` whenever those constraints are BOUNDED — so
      // the moment the card gave this box a ceiling to grow into, the box took
      // all of it and design doc §6-2 rule 1 ("a short draft must never be
      // forced to fill the whole screen") was dead. It
      // never showed up before because the field's two homes had always handed
      // it an UNBOUNDED height, where the same `Align` shrink-wraps.
      //
      // ⇒ null in ceiling mode: the box is then sized by its child (the field's
      // own content height, clamped by the parent), which is the whole
      // difference between "use as much screen as reasonably possible" and
      // "always fill the screen".
      // ⚠️ Kept verbatim in the default (5-line) mode so the plain row's pixels
      // do not move: there the constraints are unbounded and the `Align` is
      // harmless, and "one line of text vertically centered in a 38px box" is
      // its job there.
      alignment: maxLines == null ? null : Alignment.centerLeft,
      child: TextField(
        key: const ValueKey<String>('compose.field'),
        controller: controller,
        focusNode: focusNode,
        enabled: enabled,
        onChanged: onChanged,
        minLines: 1,
        // FB-3 pain point 5 / FB-8 §3-1: a 13px × 3-line box "looks like a
        // subordinate input field", and cannot carry the weight of "your
        // words are right here, edit and send". The box needs to be big and
        // grow with its content.
        // ⚠️ T-5: that 5 is now [maxLines]'s **default value** (the floating
        // card passes null), the semantics unchanged.
        // ⚠️ D4: no autofocus — the card must not pop the keyboard
        // automatically when it appears (that would interrupt continuous
        // dictation); it only focuses on tap. Pinned by
        // fb8_confirm_card_test.dart.
        maxLines: maxLines,
        cursorColor: FlowMicDockColors.pri,
        // Mock `.bdy{font-size:16px;line-height:1.75}`. The 14 that stood here
        // was FB-3's answer to the same pain point 5 asked; the mock answers
        // it with a bigger number, and the mock wins (contract §0 rule).
        style: TextStyle(
          color: FlowMicDockColors.ink,
          fontSize: 16,
          height: 1.75,
        ),
        decoration: InputDecoration(
          isDense: true,
          border: InputBorder.none,
          enabledBorder: InputBorder.none,
          focusedBorder: InputBorder.none,
          disabledBorder: InputBorder.none,
          contentPadding: const EdgeInsets.symmetric(vertical: 9),
          hintText: hint,
          hintMaxLines: 1,
          hintStyle: TextStyle(
            color: FlowMicDockColors.sub,
            fontSize: 13,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ),
    );
  }
}

/// The EXPLICIT policy chip (FB-3 pain point 1 / FB-8 §4) — the manual/direct
/// **visible** entry point, key `compose.policy`. The only entry point before
/// this was a long-press on the send button (a 4px dot in the top-right
/// corner as a hint); FB-8 §1 assigned half the root cause of "the feature
/// isn't done" to it: the mechanism was there, but the entry point was invisible.
///
/// ⚠️ **The long-press is deliberately kept** (design doc §3 "long-press
/// still stays for compatibility"): this ADDS an entry point, it does not
/// relocate the existing one. The plain row's chip and the long-press go
/// through the SAME `_handleTogglePolicy`; the floating card's chip goes
/// through a page-level handler (chat_flow_edit_card.dart explains why that
/// end has no 800ms flash strip).
///
/// 🔴 The wording uses the EXISTING [AppStrings.sendPolicyManual] /
/// [sendPolicyDirect] ("manual send" 手动发送 / "direct send" 直接发送),
/// **NOT the demo's "manual"/"automatic" pair** — the same concept already has
/// a name in the 800ms overlay, the send button's tooltip and the settings
/// panel, and following the demo instead would give the same thing two names
/// (the copy-surface version of this repo's #1 bug shape). Flagged and awaiting a ruling.
/// 🔴 WP8 VF-2 — the face is the mock's `.strat`, not this app's chip
/// convention: `r99 · padding 6v×12h · 12sp/600 · label + ' ⇄'`, and NO leading
/// icon. The ➤/⚡ pair that stood here died with the send button it was paired
/// with (SUP-2) — a second glyph vocabulary for a control that now stands alone
/// is exactly the "carry the app's convention over" the owner rejected.
class SendPolicyChip extends StatelessWidget {
  const SendPolicyChip({
    super.key,
    required this.policy,
    required this.strings,
    required this.onTap,
    this.muted = false,
  });

  final SendPolicy policy;
  final AppStrings strings;
  final VoidCallback onTap;

  /// A-11 (record-only): `<span class="strat" style="color:var(--sub);
  /// border-color:var(--line)">` — the chip goes neutral because there is no
  /// PC to deliver to, so "direct/manual send" is a choice about a
  /// destination that is not there.
  ///
  /// 🔴 It is NOT a disabled flag. The chip stays tappable in this face, and
  /// deliberately so: the policy it sets is the one the NEXT utterance will use
  /// once a PC is back, and greying out a control that still changes something
  /// is the fabricated-disabled-state lie (R11's shape, in the other
  /// direction). Only the paint changes.
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final bool manual = policy == SendPolicy.manual;
    final String label =
        manual ? strings.sendPolicyManual : strings.sendPolicyDirect;
    final String hint =
        manual ? strings.sendPolicyManualHint : strings.sendPolicyDirectHint;
    // Three faces, one row of the mock each:
    //   A-01 direct  — `.strat` bare: pri text, 1dp pri border, no fill.
    //   A-02 manual  — `style="background:var(--pri);color:#fff"`, border kept.
    //   A-11 muted   — `style="color:var(--sub);border-color:var(--line)"`.
    final Color fg = muted
        ? FlowMicDockColors.sub
        : manual
        ? FlowMicDockColors.onPri
        : FlowMicDockColors.pri;
    final Color border =
        muted ? FlowMicDockColors.line : FlowMicDockColors.pri;
    // null, not a transparent literal: two of the three faces paint NO fill,
    // so there is no colour there for a design token to name.
    final Color? bg = manual && !muted ? FlowMicDockColors.pri : null;
    return Tooltip(
      message: '$label · $hint',
      child: Semantics(
        // 🔴 The ' ⇄' below is a LAYOUT glyph, concatenated here and nowhere
        // else — it is not in the strings shard and it must not reach a screen
        // reader, which would read it out as a symbol name. So the accessible
        // label keeps the bare sentence.
        label: '$label · $hint',
        button: true,
        child: InkWell(
          key: const ValueKey<String>('compose.policy'),
          onTap: onTap,
          borderRadius: BorderRadius.circular(99),
          child: Container(
            height: 32,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            // NO `alignment:` here — a Container with alignment set EXPANDS
            // to its max constraint, and inside row 1's Wrap that meant the
            // chip measured the full band width, fell to its own run, and
            // rendered as a full-width bar (tablet-measured 2026-08-13,
            // WP7 acceptance). The Row(min) child + vertical centering via
            // height is all this chip needs to stay intrinsic-width.
            decoration: BoxDecoration(
              color: bg,
              border: Border.all(color: border),
              borderRadius: BorderRadius.circular(99),
            ),
            // 🔴 ExcludeSemantics, and it is the ⇄ that makes it necessary.
            // The `Semantics(label:)` above already names this control; the
            // painted Text would otherwise ALSO reach the tree as its own node
            // and a screen reader would read the glyph out ("left right arrow")
            // after the sentence. It is not `excludeSemantics: true` on the
            // wrapper: that would drop the InkWell's tap ACTION with it, and an
            // announced button nobody can activate is worse than a stray glyph.
            child: ExcludeSemantics(
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Text(
                    '$label ⇄',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: fg,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// PA-1 (SUP-3 + MD-6) — the row-1 policy chip WITH the V2-04 ~800ms flash.
///
/// The chip moved from row 2 to row 1 (SUP-3) and the send button whose
/// long-press used to be the hidden second toggle is gone (SUP-2), so this is
/// now the ONLY strategy toggle — which is exactly why the flash still rides
/// it: the chip's own face flips, but the one-line HINT ("goes into the input
/// field first after speaking..." 「说完先进输入框…」)
/// is what tells a first-time user what the new state means, and it must not
/// become a permanent label (V2-04: the switch leaves no standing UI behind).
///
/// MD-6: this is the SAME 800ms mechanism `_ComposeBandState` used to own,
/// re-anchored to the chip's new home — not a new toast system.
///
/// 🔴 WP8 VF-2 MOVED IT AGAIN, and the reason is the mock rather than a taste
/// call. WP7 hung the notice BELOW the chip 「because above it is the timeline,
/// where an overlay would sit over foreign content」 — but the mock's A-02 puts
/// this exact notice IN the timeline: a brand-filled white-text pill,
/// self-centred, riding the timeline's lower edge (`<div class="evt"
/// style="background:var(--pri);color:#fff">`). Sitting over the timeline is
/// the design, not a side effect.
///
/// It renders through an [OverlayPortal] rather than a `Stack` inside the chip
/// for one reason: 「centred across the band」 is not expressible from inside a
/// right-aligned intrinsic-width chip's own box. The 800ms lifecycle, the
/// pointer-transparency and the 「leaves the tree entirely afterwards」 rule are
/// byte-for-byte the same as before.
class SendPolicyFlashChip extends StatefulWidget {
  const SendPolicyFlashChip({
    super.key,
    required this.policy,
    required this.strings,
    required this.onToggle,
    this.muted = false,
  });

  /// The policy the chip currently wears (pre-toggle).
  final SendPolicy policy;
  final AppStrings strings;

  /// Passed straight through to [SendPolicyChip.muted] (A-11 record-only).
  final bool muted;

  /// Flips the policy (ChatController.toggleSendPolicy). The usage counter and
  /// the flash both fire HERE, so every entry point that renders this widget
  /// counts switches the same way (R-UX-09: counted by act).
  final VoidCallback onToggle;

  @override
  State<SendPolicyFlashChip> createState() => _SendPolicyFlashChipState();
}

class _SendPolicyFlashChipState extends State<SendPolicyFlashChip> {
  final OverlayPortalController _portal = OverlayPortalController();
  Timer? _flashTimer;
  SendPolicy? _flashPolicy;
  bool _flashVisible = false;

  /// The chip's own global rect, sampled at the instant of the toggle.
  ///
  /// Sampled ONCE rather than read every frame on purpose: the notice lives for
  /// 800ms over a dock that does not move in that window, and a per-frame
  /// re-measure would make the pill chase a relayout instead of sitting still.
  Rect? _anchor;

  @override
  void dispose() {
    _flashTimer?.cancel();
    super.dispose();
  }

  /// V2-04: flip the policy AND say what it flipped to. The label names the
  /// state the switch moved TO — computed here because the parent's rebuild
  /// with the new [SendPolicyFlashChip.policy] lands after this handler
  /// returns.
  void _handleToggle() {
    countUsage(UsageEvent.sendPolicyToggle);
    widget.onToggle();
    final SendPolicy next = widget.policy == SendPolicy.manual
        ? SendPolicy.direct
        : SendPolicy.manual;
    _flashTimer?.cancel();
    final RenderObject? box = context.findRenderObject();
    setState(() {
      _anchor = box is RenderBox && box.hasSize
          ? box.localToGlobal(Offset.zero) & box.size
          : null;
      _flashPolicy = next;
      _flashVisible = true;
    });
    _portal.show();
    _flashTimer = Timer(const Duration(milliseconds: 800), () {
      if (!mounted) return;
      setState(() => _flashVisible = false);
    });
  }

  /// The mock's A-02 pill: `.evt` geometry (11sp, 4v×12h, r99, self-centred)
  /// wearing the brand fill the frame sets inline
  /// (`background:var(--pri);color:#fff`).
  ///
  /// 🔴 The ➤/⚡ glyphs that used to lead this sentence are GONE, and that is
  /// not a copy edit: they were concatenated here in widget code (the strings
  /// shard never carried them). They existed to echo the send button's two
  /// faces — a button SUP-2 deleted — and the mock's chip carries no glyph, so
  /// keeping them would re-import the convention this package is undoing.
  Widget _buildFlash(BuildContext context) {
    final Rect? anchor = _anchor;
    final SendPolicy? policy = _flashPolicy;
    if (anchor == null || policy == null) return const SizedBox.shrink();
    final AppStrings s = widget.strings;
    // The dock's top border is [kDockPaddingTop] above row 1, and the chip is
    // vertically centred inside that row; clearing the border by 8dp puts the
    // pill over the TIMELINE, which is where the mock draws it. Pinned by a
    // rendered-geometry assertion (dock_faces_test.dart) rather than by this
    // comment — a comment cannot notice when the padding is retuned.
    final double bottom =
        MediaQuery.sizeOf(context).height - anchor.top + kDockPaddingTop + 8;
    return Positioned(
      left: 0,
      right: 0,
      bottom: bottom,
      child: IgnorePointer(
        child: Center(
          child: AnimatedOpacity(
            opacity: _flashVisible ? 1 : 0,
            duration: const Duration(milliseconds: 200),
            onEnd: () {
              if (!_flashVisible && mounted) {
                _portal.hide();
                setState(() => _flashPolicy = null);
              }
            },
            child: Container(
              padding: const EdgeInsets.symmetric(
                horizontal: 12,
                vertical: 4,
              ),
              decoration: BoxDecoration(
                color: FlowMicDockColors.pri,
                borderRadius: BorderRadius.circular(99),
              ),
              child: Text(
                policy == SendPolicy.manual
                    ? '${s.sendPolicyManual} · ${s.sendPolicyManualHint}'
                    : '${s.sendPolicyDirect} · ${s.sendPolicyDirectHint}',
                style: TextStyle(
                  color: FlowMicDockColors.onPri,
                  fontSize: 11,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return OverlayPortal(
      controller: _portal,
      overlayChildBuilder: _buildFlash,
      child: SendPolicyChip(
        policy: widget.policy,
        strings: widget.strings,
        muted: widget.muted,
        onTap: _handleToggle,
      ),
    );
  }
}

/// The buffer hint strip (FB-3 plan A: the replacement for the confirm
/// dialog), key `compose.modeSwitchHint`.
///
/// 🔴 This is a **protection**, not decoration. M4's "switching modes clears
/// the buffer, are you sure?" confirm dialog was cancelled by D1 (a direct
/// pick needs no confirmation), and the gate that was cancelled was
/// originally blocking something real: switching modes clears words the user
/// hasn't sent yet. The only possible replacement is a sentence on screen
/// **beforehand** — a toast after the fact stops nothing.
///
/// ⚠️ The words that get cleared **do not vanish**: each of their rows
/// settles into 📥 noted through the existing mechanism
/// (`discardBufferedRowsRouted`), so what this says is "this box will be
/// cleared", NOT "what you said is gone" — the latter would be false, and
/// writing it that way would make users afraid to switch modes.
class ComposeModeSwitchHint extends StatelessWidget {
  const ComposeModeSwitchHint({super.key, required this.strings});

  final AppStrings strings;

  @override
  Widget build(BuildContext context) => Row(
    key: const ValueKey<String>('compose.modeSwitchHint'),
    mainAxisSize: MainAxisSize.min,
    children: <Widget>[
      Icon(Icons.info_outline, size: 11, color: FlowMicColors.t3),
      const SizedBox(width: 4),
      Flexible(
        child: Text(
          strings.composeModeSwitchClearsHint,
          key: const ValueKey<String>('compose.modeSwitchHint.text'),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(color: FlowMicColors.t3, fontSize: 10.5, height: 1.3),
        ),
      ),
    ],
  );
}
