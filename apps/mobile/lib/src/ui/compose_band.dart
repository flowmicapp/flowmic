// SPEC-REF:
//   docs/ui-design/2026-08-13-plan-a-dock-and-edit-sheet-contract.md §4 (the
//     dock state table A1–A9), §5-1 (PC key group geometry), §2 SUP-2 (the idle
//     dock has NO send button), SUP-4 (keys hide during processing/justDone
//     too), SUP-8 (the + button joins the 44dp ruler)
//   docs/ui-design/2026-08-13-compose-band-redesign.md §2-2 (the 44×44 touch
//     ruler — inherited), §2-3 (the punctuation deletion list — inherited)
//   docs/rebuild/08-MOBILE-SPEC.md §5 + its 2026-08-13 correction block
//     (QuickActions = four REMOTE keys; they NEVER touch this phone's draft)
//
// ── PA-1 (Plan A′, 2026-08-13): what this band is now ────────────────────────
// Two rows: row 2 = `[+][preview strip]`, and the PC KEY GROUP — the four remote
// keys inside an outlined container with a `电脑/PC` (computer/PC) edge label
// and per-key
// visible labels (Plan A′ §8 Q3: 「different shape, different color,
// different layer from『delivery』, never lining up as
// twins」). What LEFT this file, by contract:
//   · the send button (`_sendButton`) and its long-press policy toggle —
//     SUP-2. Delivering a draft is the edit sheet's footer now; the policy
//     chip in row 1 is the only strategy toggle.
//   · the policy chip's home (row 2 → row 1, SUP-3) and the V2-04 800ms flash
//     that rides it — both live in [SendPolicyFlashChip]
//     (compose_buffer_row.dart), re-anchored per MD-6.
//   · the horizontal reverse-scroll toolbar: the group is equal-flex inside a
//     full-width container, so 「hugs the right edge」 holds by construction
//     and nothing can
//     overflow. The V2-03 owner ruling (「put the high-frequency key on the
//     right」) is satisfied by ⏎
//     keeping the rightmost slot inside the group.
//
// T-1 history (0.2.63): the six punctuation keys, their chevron and the
// LocalPrefs habit are GONE, not hidden — owner Q2㋐. The 「remote punctuation
// append」 went with them; the protocol is untouched, so the `punct_*` kinds
// stay on the control:key whitelist as sender-less.
//
// 🔴 T-2 (0.2.63, owner Q3㋐): THIS WIDGET RENDERS NO TEXT FIELD. What row 2
// paints while idle
// is [ComposeBufferPreview] (NOT a TextField, see its class doc), and the ONE
// editable [ComposeBufferField] lives at PAGE level (the edit sheet). Both are
// handed `_ChatFlowPageState._composeText`, so 「where the cursor is」 has one author.

import 'dart:async';

import 'package:flutter/material.dart';

import '../session/usage_counters.dart';
import '../settings/app_strings.dart';
import '../signaling/wire_payloads.dart' show ControlKeyKind, SendPolicy;
// T-2: the preview strip's character count goes through THE one word-count implementation
// (that file's header: 「Do not add a second `.length` … anywhere else」), so the
// strip and the live draft row cannot answer 「how many characters this passage has」 differently.
import '../timeline/entry_metrics.dart' show textWordCount;
import 'haptics.dart';
// The band asks ONE question of the session — which face the dock wears — and
// the answer arrives as the [PttVisual] the composer already computed for PttBar.
import 'ptt_bar.dart' show PttVisual;
import 'tokens.dart';

// Row 2's ordinary form + the parts shared across files (preview strip /
// buffer box / policy chip + flash strip / buffer hint strip).
part 'compose_buffer_row.dart';

/// 🔴 SUP-4 (Plan A′ contract §2) — the ONE predicate for 「the idle rows and
/// the PC key group are on the tree」. Row 1 (chat_flow_composer.dart) and this
/// band both read it; a second copy of the condition is this repo's #1
/// historical bug shape (one question, two authors).
///
/// Spelled as a POSITIVE list of the three visible faces rather than
/// 「not recording…」: SUP-4 closed compose-band contract §10-1 in the 「hide」
/// direction, so a future [PttVisual] value now deliberately falls on the
/// HIDDEN side until somebody rules otherwise — the dock's recording/processing
/// faces are 「one main thing at a time」, and a new face leaking the full dock
/// under them would break that silently.
bool composeIdleRowsVisible(PttVisual visual) =>
    visual == PttVisual.idle ||
    visual == PttVisual.noted ||
    visual == PttVisual.disabled;

/// REQ-14-01 — the four PC remote keys answer 「act on the focused PC field」.
/// A record-only / light-record destination has no PC focus, so the keys are
/// off the tree (not dimmed-and-explained). One author, shared with the
/// composer's tablet two-column predicate: a dock whose right column would be
/// empty must not re-column.
bool composePcKeysVisible(PttVisual visual) =>
    composeIdleRowsVisible(visual) && visual != PttVisual.noted;

// PA-4 (SUP-5): `composeEditHold` — 「edit mode ≡ manual ∧ buffer non-empty」, the old
// visibility author for the floating card and row 2's yield — is DELETED, not
// parked: the sheet's explicit `sheetOpen` bit is the one visibility author
// now, and a collapsed sheet over a manual non-empty draft is a legal state
// (contract §4 A2). A predicate with no consumers is R8's dead content.

/// T-1 (0.2.63): one touch ruler for everything the lower band still has a
/// finger on — the four remote keys and (since SUP-8) the `+` button.
///
/// 🔴 It is the TOUCH TARGET, not the icon. owner 2026-08-13 supplement #1 read
/// 「icon sizes are inconsistent」, and the honest fix for that is a uniform box you can hit,
/// plus one glyph tier inside it ([kComposeGlyphSize]).
const double kComposeTouchTarget = 44;

/// The single glyph tier inside those targets.
const double kComposeGlyphSize = 17;

/// The dock container's top inset — the mock's
/// `.dock{padding:10px 12px 14px}`, first number.
///
/// 🔴 It is a shared constant rather than a literal inside
/// `chat_flow_composer.dart` because a SECOND widget depends on it: the policy
/// flash (`SendPolicyFlashChip`) floats just OUTSIDE the dock's top border, and
/// the only thing that tells it where that border is, is how far the dock is
/// padded above row 1. Two copies of this number would put the pill inside the
/// dock the first time somebody retuned the padding, which is precisely the
/// 「one question, two authors」 shape.
const double kDockPaddingTop = 10;

/// The uniform gap between the dock's rows (`.dock{…gap:9px}`).
const double kDockRowGap = 9;

// ── VF-8 · tablet (mock frame A-TAB) ────────────────────────────────────────
// `<div class="dock" style="flex-direction:row;gap:12px;align-items:stretch;
//                           padding:12px 20px 16px">`
//   `<div style="flex:1;max-width:430px;margin:0 auto;…gap:9px">` — speak column
//   `<div class="keys" style="flex-direction:column;width:92px;flex:none">`
//
// 🔴 THE THRESHOLD IS THE DOCK'S OWN WIDTH, NOT THE SCREEN'S. Read through a
// `LayoutBuilder` in `chat_flow_composer.dart`, so a phone-sized split-screen
// window on a tablet gets the phone dock — which is the honest answer, because
// what makes the two-column arrangement work is 「is there room for a 430dp
// speak column AND a 92dp key column side by side」, and a `MediaQuery` screen
// width does not answer that question for a window occupying half of it.

/// A-TAB: the dock width at which the IDLE dock re-columns.
///
/// 430 (speak) + 12 (gap) + 92 (keys) + 40 (padding) = 574 is what the mock's
/// own frame needs; 560 is the contract's stated breakpoint, and below it the
/// speak column simply gets less than its 430 ceiling rather than anything
/// breaking. Below this width the dock is byte-identical to the phone.
const double kDockTabletMinWidth = 560;

/// A-TAB `max-width:430px` on the speak/input column.
const double kDockTabletSpeakMaxWidth = 430;

/// A-TAB `width:92px;flex:none` on the key column.
const double kDockTabletKeyColumnWidth = 92;

/// A-TAB `.dock{gap:12px}` — the gap BETWEEN the two columns. Deliberately not
/// [kDockRowGap]: that one is the gap between rows WITHIN a column, and the
/// mock gives the two different numbers (9 inside, 12 between).
const double kDockTabletColumnGap = 12;

/// Which part of the band a given instance draws.
///
/// 🔴 It exists because the tablet splits the band's two rows into two DIFFERENT
/// COLUMNS of the dock — `[+][preview]` goes in the speak column, the PC keys
/// become the right column — and they are then no longer siblings. The
/// alternative (a second widget that re-draws the key faces) is the one thing
/// the card forbids: the key's panel/line/r10 face, its 44dp floor, its
/// tooltip, its inert/dim rules and its haptics would all exist twice, and the
/// second copy is the one that would stop matching.
enum ComposeBandPart {
  /// Phone (A-01…A-11): `[+][preview]` stacked above the PC key group.
  stacked,

  /// Tablet speak column: the `[+][preview]` row alone.
  bufferRow,

  /// Tablet right column: the PC key group alone, laid out vertically.
  keyColumn,
}

/// The four QuickAction keys. Each maps to a control:key kind on the whitelist.
///
/// owner 2026-07-28:「enter goes last … swap the positions of enter and
/// clear」. ⏎ is the
/// highest-frequency key of the four and sits at the far right, deepest in the
/// one-handed thumb arc; ✕ (clear, the most destructive of the four) takes the
/// position furthest from it.
const List<ControlKeyKind> kComposeControlKeys = <ControlKeyKind>[
  ControlKeyKind.clear,
  ControlKeyKind.backspace,
  ControlKeyKind.undo,
  ControlKeyKind.enter,
];

class ComposeBand extends StatefulWidget {
  const ComposeBand({
    super.key,
    required this.buffer,
    required this.strings,
    required this.enabled,
    required this.onControlKey,
    required this.onExpand,
    required this.visual,
    this.leading = const <Widget>[],
    this.part = ComposeBandPart.stacked,
  });

  /// The authoritative buffer text (ChatController.buffer).
  final String buffer;

  final AppStrings strings;

  /// ChatController.canCompose (via `_composeFieldEnabled`). False ⇒ A8: the
  /// preview goes grey-and-says-why, and the key group dims — but the keys
  /// keep ANSWERING taps (see [_ComposeBandState._controlButton]).
  final bool enabled;

  /// 🔴 REQ-12-13 — RETURNS WHETHER THE FRAME LEFT THE DEVICE (2026-08-12).
  ///
  /// It decides which haptic fires: sent out ⇒ [FlowMicHaptics.controlKeySent],
  /// not sent out ⇒ [FlowMicHaptics.controlKeyRefused] (two pulses). The refusal
  /// ALSO raises the compose banner inside `sendControlKey` — the buzz says
  /// 「something happened」, the banner says WHAT.
  ///
  /// 🔴 PA-1 (contract §4 A8): a DISCONNECTED tap now goes through here too,
  /// instead of the key playing dead — `sendControlKey` refuses with the
  /// existing `ComposeSendFailure.notConnected` sentence, which is the honesty
  /// path the contract names. Record-only (A9) stays inert: that condition is
  /// standing, and its explanation is the standing reason line, not a banner
  /// per tap.
  final bool Function(ControlKeyKind kind) onControlKey;

  /// 🔴 T-3 → PA-4: the preview strip's tap, reported UP to the page (which
  /// owns the edit sheet). Required with no friendly no-op default (anti-façade
  /// ②): the strip's own copy is a promise, and a caller that forgot to wire
  /// this would ship exactly the affordance lie this card exists to remove.
  final VoidCallback onExpand;

  /// Widgets placed before the preview strip — today the 「+」 panel button.
  final List<Widget> leading;

  /// 🔴 THREADED IN, NEVER RE-DERIVED. This is the SAME [PttVisual] instance
  /// `chat_flow_composer.dart` already computes from
  /// `ChatController.sessionState` and hands to PttBar. Deriving a second one
  /// from `sessionState` in here would give 「is it recording」 two authors.
  ///
  /// It answers two questions here, each through a named predicate:
  ///   · [composeIdleRowsVisible] — whether the band lays out at all (SUP-4);
  ///   · `== PttVisual.noted` — the A9 record-only face of the key group.
  final PttVisual visual;

  /// VF-8: which of the band's two rows this instance draws. Defaults to the
  /// phone's [ComposeBandPart.stacked] so every existing call site and test is
  /// untouched.
  ///
  /// ⚠️ The visibility rule does NOT branch on it: all three parts still yield
  /// through the one [composeIdleRowsVisible] predicate below, so the tablet's
  /// key column disappears during recording for exactly the same reason — and
  /// at exactly the same moment — as the phone's key group.
  final ComposeBandPart part;

  @override
  State<ComposeBand> createState() => _ComposeBandState();
}

class _ComposeBandState extends State<ComposeBand> {
  @override
  Widget build(BuildContext context) {
    // 🔴 SUP-4 / contract §4 A3–A5: outside the three idle faces the whole
    // band yields — a FULL-WIDTH zero-height box, not `SizedBox.shrink()`
    // (a 0×0 box would let the parent Column centre later siblings).
    if (!composeIdleRowsVisible(widget.visual)) {
      return const SizedBox(width: double.infinity, height: 0);
    }
    return switch (widget.part) {
      ComposeBandPart.bufferRow => _bufferRow(),
      ComposeBandPart.keyColumn => _pcKeyColumn(),
      ComposeBandPart.stacked => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _bufferRow(),
          // REQ-14-01: light-record / noted has no PC focus — the key group
          // is absent, not dimmed. The gap only exists when the group does.
          if (composePcKeysVisible(widget.visual)) ...<Widget>[
            const SizedBox(height: kDockRowGap),
            _pcKeyGroup(),
          ],
        ],
      ),
    };
  }

  // ── PC key group (Plan A′ §5-1) ──────────────────────────────────────────
  /// The four remote keys in their own outlined container with the 电脑/PC
  /// (computer/PC) edge label — 「separated from the draft-type controls at
  /// the container level」 (mock ①'s caption). The container
  /// is the answer to Plan A′ §8 Q3: these keys act on the OTHER machine, and
  /// the box + label say so before any key is read.
  Widget _pcKeyGroup() {
    // A9 (record-only): the whole group dims and a standing reason line
    // explains; A8 (link down): the group dims but keys still answer taps
    // (the refusal banner is the explanation there — a standing line would
    // duplicate the preview strip's own 「not connected」 sentence one centimetre up).
    final bool noted = widget.visual == PttVisual.noted;
    final bool dim = noted || !widget.enabled;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Opacity(
          opacity: dim ? 0.4 : 1,
          child: Container(
            key: const ValueKey<String>('compose.keys.group'),
            padding: const EdgeInsets.all(6),
            // `.keys{border:1px solid var(--line);border-radius:15px;
            //        padding:6px;background:var(--bg)}` — the group's fill is
            // the PAGE colour, one step BEHIND the dock panel it sits on. That
            // inversion is the whole point of the container (Plan A′ §8 Q3):
            // these four keys act on the other machine, so they must not read
            // as part of this phone's draft surface.
            decoration: BoxDecoration(
              color: FlowMicDockColors.bg,
              border: Border.all(color: FlowMicDockColors.line),
              borderRadius: BorderRadius.circular(15),
            ),
            child: Row(
              children: <Widget>[
                _groupLabel(),
                const SizedBox(width: 6),
                // Equal-flex keys: the group spans the band, each key gets a
                // quarter, and every touch box clears the 44dp ruler via the
                // key's own minHeight (width follows the flex share, which at
                // 320dp is already > 44).
                //
                // ⚠️ The 6dp gaps sit BETWEEN keys only. ⏎ keeps the rightmost
                // slot — the V2-03 thumb-arc ruling, now inside the group.
                for (int i = 0; i < kComposeControlKeys.length; i++) ...<Widget>[
                  if (i > 0) const SizedBox(width: 6),
                  Expanded(child: _controlButton(kComposeControlKeys[i])),
                ],
              ],
            ),
          ),
        ),
        if (noted) ...<Widget>[
          const SizedBox(height: 4),
          // A9's standing reason line. On the phone the group is a full-width
          // row, so two lines is plenty.
          _reasonLine(maxLines: 2),
        ],
      ],
    );
  }

  // ── VF-8 · the same group as a 92dp COLUMN (mock A-TAB) ─────────────────────
  /// `<div class="keys" style="flex-direction:column;width:92px;flex:none">`
  /// with `<div class="key" style="flex:1">` ×4 and the edge label moved to the
  /// top, horizontal.
  ///
  /// 🔴 Every face here comes from [_controlButton] and [_groupLabel] — the SAME
  /// two builders the phone row uses. Nothing about a key (its panel fill, its
  /// line border, its r10, its 44dp floor, its tooltip, its inert rule, its two
  /// haptics) is restated in this method, because a second statement of any of
  /// them is a second thing to keep in step.
  Widget _pcKeyColumn() {
    // Same hide as the phone row — the tablet right column is this group.
    if (!composePcKeysVisible(widget.visual)) {
      return const SizedBox(width: double.infinity, height: 0);
    }
    final bool noted = widget.visual == PttVisual.noted;
    final bool dim = noted || !widget.enabled;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // 🔴 CONTENT-SIZED, NOT `Expanded` INSIDE A STRETCHED ROW — a MEASURED
        // correction, not a preference.
        // The first cut expressed A-TAB's `align-items:stretch` + `flex:1`
        // literally: `IntrinsicHeight(Row(crossAxisAlignment: stretch))` with
        // the four keys `Expanded`. `stretch` needs a BOUNDED height and this
        // Row has none (the dock shrink-wraps inside the page's Column), so
        // IntrinsicHeight was what supplied the bound — and an intrinsic height
        // is a PREDICTION of a child's height, not a measurement of it. The
        // speak column beside this one holds a `Wrap` and a two-line-capable
        // caption whose real height at 430dp differs from what they report
        // unconstrained, so the Row came out short and the column inside it
        // overflowed. MEASURED, in `selection_wire_test.dart`'s en case at
        // 800×900: `A RenderFlex overflowed by 2.0 pixels on the bottom`.
        // ⇒ The keys keep their own 44dp floor and the group sizes to its
        //   content. NAMED DEVIATION from `flex:1`, and it costs nothing at the
        //   mock's own sizes: this column (4×44 + 3×6 + label + padding ≈ 232dp)
        //   is TALLER than the speak column (≈192dp), so the stretched version
        //   measured 44dp per key too — the flex was already inert. The two
        //   differ only if the speak column ever grows past this one (a large OS
        //   text scale), where the group now stops at its own height instead of
        //   following. That is a gap at the bottom of a column, not a lie.
        Opacity(
          opacity: dim ? 0.4 : 1,
          child: Container(
            key: const ValueKey<String>('compose.keys.group'),
            padding: const EdgeInsets.all(6),
            decoration: BoxDecoration(
              color: FlowMicDockColors.bg,
              border: Border.all(color: FlowMicDockColors.line),
              borderRadius: BorderRadius.circular(15),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                _groupLabel(forceHorizontal: true),
                const SizedBox(height: 6),
                for (int i = 0; i < kComposeControlKeys.length; i++)
                  ...<Widget>[
                    if (i > 0) const SizedBox(height: 6),
                    _controlButton(kComposeControlKeys[i]),
                  ],
              ],
            ),
          ),
        ),
        if (noted) ...<Widget>[
          const SizedBox(height: 4),
          // 🔴 FOUR lines here, two on the phone, and that is a MEASUREMENT not
          // a preference: the column is 92dp wide, and 「in record-only mode
          // there is no PC focus, the PC keys are unavailable」 (仅记录模式没有
          // 电脑焦点，电脑键不可用) is 18 CJK glyphs — about 8 to a line at 10.5sp, so two
          // lines would cut it in half. The 0.2.53 law says a sentence the user
          // cannot read is a sentence that was not printed, and this one is the
          // whole explanation for why four visible keys do nothing. Vertical
          // room is what this column has most of.
          _reasonLine(maxLines: 4),
        ],
      ],
    );
  }

  /// A9's standing reason line — one author, two line budgets.
  ///
  /// A-11: `<div style="font-size:10.5px;color:var(--sub);text-align:center">
  /// 仅记录模式没有电脑焦点，电脑键不可用</div>`
  Widget _reasonLine({required int maxLines}) => Text(
    widget.strings.pcKeysUnavailableNoted,
    key: const ValueKey<String>('compose.keys.reason'),
    textAlign: TextAlign.center,
    maxLines: maxLines,
    overflow: TextOverflow.ellipsis,
    style: TextStyle(color: FlowMicDockColors.sub, fontSize: 10.5),
  );

  /// The 电脑/PC (computer/PC) edge label. The zh/ja/ko mocks write it vertically (two CJK
  /// glyphs stacked); the EN mock switches to horizontal 「PC」 — the decision
  /// is made on the LABEL's own length, not on the locale, so a future locale
  /// with a short label gets the vertical face for free.
  ///
  /// [forceHorizontal] is the A-TAB override: in the key COLUMN the label sits
  /// across the top whatever its length, because there is no left edge for it
  /// to run down any more (`writing-mode:horizontal-tb;justify-content:center;
  /// padding:2px 0;letter-spacing:2px`).
  Widget _groupLabel({bool forceHorizontal = false}) {
    final String label = widget.strings.pcKeysGroupLabel;
    // `.klb{writing-mode:vertical-rl;font-size:10px;color:var(--sub);
    //       letter-spacing:3px;padding:0 3px}`. Flutter has no writing-mode, so
    //  the stacked-glyph Column below IS the vertical variant, and the CSS's
    //  letter-spacing (which runs along the writing direction) becomes the
    //  Column's line height rather than a per-glyph tracking.
    final TextStyle style = TextStyle(
      color: FlowMicDockColors.sub,
      fontSize: 10,
      height: 1.4,
    );
    if (forceHorizontal) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Text(
          label,
          key: const ValueKey<String>('compose.keys.groupLabel'),
          textAlign: TextAlign.center,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: style.copyWith(letterSpacing: 2),
        ),
      );
    }
    if (label.characters.length <= 2) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 3),
        child: Column(
          key: const ValueKey<String>('compose.keys.groupLabel'),
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            for (int i = 0; i < label.characters.length; i++) ...<Widget>[
              // The mock's 3px vertical tracking, spent BETWEEN the stacked
              // glyphs rather than under the last one — a trailing gap would
              // push the two-glyph stack off the group's centre line.
              if (i > 0) const SizedBox(height: 3),
              Text(label.characters.elementAt(i), style: style),
            ],
          ],
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Center(
        child: Text(
          label,
          key: const ValueKey<String>('compose.keys.groupLabel'),
          // The EN mock lays 「PC」 horizontally; the same 1px tracking the
          // frame gives it keeps the two capitals from reading as a word.
          style: style.copyWith(letterSpacing: 1),
        ),
      ),
    );
  }

  Widget _controlButton(ControlKeyKind kind) {
    final AppStrings s = widget.strings;
    // M3: the tooltip is the long-press truth — per key it names WHAT happens
    // on the PC, because the glyph alone cannot say「what I'm operating is
    // the computer, not this input box」.
    final (IconData icon, String label, String hint) = switch (kind) {
      ControlKeyKind.enter => (Icons.keyboard_return, s.keyEnter, s.keyEnterHint),
      ControlKeyKind.backspace => (
        Icons.backspace_outlined,
        s.keyBackspace,
        s.keyBackspaceHint,
      ),
      ControlKeyKind.undo => (Icons.undo, s.keyUndo, s.keyUndoHint),
      ControlKeyKind.clear => (Icons.close, s.keyClear, s.keyClearHint),
      // The whitelist has more kinds than the band surfaces: tab/space never
      // had a button, and since T-1 the punct* family has no button anywhere
      // (it stays on the wire whitelist as sender-less). Reaching either
      // through here would mean the row drew a control it does not own, so
      // both fall to an inert placeholder rather than an invented icon.
      ControlKeyKind.tab ||
      ControlKeyKind.space ||
      ControlKeyKind.punctComma ||
      ControlKeyKind.punctQuestion ||
      ControlKeyKind.punctExclamation ||
      ControlKeyKind.punctEnumeration ||
      ControlKeyKind.punctColon ||
      ControlKeyKind.punctPeriod => (Icons.more_horiz, '', ''),
    };
    // A9 (noted) is the ONE inert face: the condition is standing and the
    // standing reason line under the group explains it. A8 (disconnected)
    // keeps the tap alive — `sendControlKey` answers it with the existing
    // notConnected banner + the refused haptic (contract §4 A8).
    final bool inert = widget.visual == PttVisual.noted;
    return Tooltip(
      message: hint.isEmpty ? label : '$label · $hint',
      child: InkWell(
        key: ValueKey<String>('compose.ctrl.${kind.name}'),
        // R-UX-09: counted by KIND, never by position.
        onTap: inert
            ? null
            : () {
                countUsage(UsageEvent.remoteKey);
                // REQ-12-13: the press's own answer decides the sensation.
                // Fired unawaited like every other haptic in this app.
                unawaited(
                  widget.onControlKey(kind)
                      ? FlowMicHaptics.controlKeySent()
                      : FlowMicHaptics.controlKeyRefused(),
                );
              },
        borderRadius: BorderRadius.circular(10),
        child: Container(
          constraints:
              const BoxConstraints(minHeight: kComposeTouchTarget),
          alignment: Alignment.center,
          // `.key{…border-radius:10px;background:var(--panel);
          //       border:1px solid var(--line)}` — a white slab ON the page-bg
          // group, the inverse of the flat grey slab-in-grey-band WP7 shipped
          // (contract §0 D3).
          decoration: BoxDecoration(
            color: FlowMicDockColors.panel,
            border: Border.all(color: FlowMicDockColors.line),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              // 🔴 NAMED DEVIATION — the mock's glyphs are the unicode
              // characters ✕ ⌫ ↶ ⏎ (`.kg{font-size:16px}`); these stay
              // MATERIAL icons at the same 16dp. A missing glyph on an Android
              // device font renders as a tofu box, and ⌫/↶/⏎ are exactly the
              // range where OEM fonts differ — a key whose face is a rectangle
              // is worse than a key that is 3% off the board. Size and colour
              // follow the mock; only the glyph SOURCE does not.
              // ⚠️ The dim face is NOT re-stated here: the group's own
              // `Opacity` above already covers `noted || !enabled`, which is
              // this branch's exact condition. Two authors for one dim is how
              // they drift.
              Icon(icon, size: 16, color: FlowMicDockColors.ink),
              const SizedBox(height: 2),
              // Plan A′ §5-1: the key's visible label — the four words reuse
              // keyEnter/Backspace/Undo/Clear, the same names the history rows
              // print (controlRowLabel), so one key has one name everywhere.
              Text(
                label,
                key: ValueKey<String>('compose.ctrl.${kind.name}.label'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                // `.kt{font-size:10px;color:var(--sub)}`
                style: TextStyle(color: FlowMicDockColors.sub, fontSize: 10),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // ── ② input row ────────────────────────────────────────────────────────────
  // Row 2's ordinary form and its yield branch live in compose_buffer_row.dart
  // (`_bufferRow` / `_plainBufferRow`). That part file is the same library as
  // this one, so it can still reach this file's private state.
}
