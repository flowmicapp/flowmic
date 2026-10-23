// 800-line cap: moved VERBATIM from status_badge.dart; no behavior change.
part of 'status_badge.dart';

/// Colour + AppStrings label for the chat-header connection dot (T-5b-mobile).
/// Four visual states; [ConnectionState] has five — connecting|reconnecting
/// share amber. Labels come from [AppStrings] (never OS locale).
class ConnDotMeta {
  final Color color;
  final String label;
  const ConnDotMeta(this.color, this.label);
}

/// Pure map: FSM [ConnectionState] → header-dot colour + copy.
///
/// | ConnectionState | colour | string |
/// |---|---|---|
/// | connected | green | [AppStrings.connConnected] |
/// | connecting / reconnecting | amber | connecting / recLinkDegraded |
/// | error | red | [AppStrings.connError] |
/// | disconnected | slate | [AppStrings.notConnected] |
///
/// RV-60: [albumAway] / [ladderReconnecting] softens a bare disconnected/error
/// into amber reconnecting copy — still not "connected", never a lie.
ConnDotMeta connDotMeta(
  ConnectionState state,
  AppStrings strings, {
  bool albumAway = false,
  bool ladderReconnecting = false,
}) {
  if (state == ConnectionState.connected) {
    return ConnDotMeta(FlowMicColors.green, strings.connConnected);
  }
  if (albumAway) {
    return ConnDotMeta(FlowMicColors.amber, strings.bannerAlbumAway);
  }
  if (state == ConnectionState.connecting ||
      state == ConnectionState.reconnecting ||
      ladderReconnecting) {
    return ConnDotMeta(
      FlowMicColors.amber,
      state == ConnectionState.connecting
          ? strings.connecting
          : strings.recLinkDegraded,
    );
  }
  switch (state) {
    case ConnectionState.error:
      return ConnDotMeta(FlowMicColors.red, strings.connError);
    case ConnectionState.disconnected:
      return ConnDotMeta(FlowMicColors.slate, strings.notConnected);
    case ConnectionState.connected:
    case ConnectionState.connecting:
    case ConnectionState.reconnecting:
      // Exhaustiveness — the early returns above already covered these.
      return ConnDotMeta(FlowMicColors.amber, strings.recLinkDegraded);
  }
}

/// (icon, label, fg, bg) for a history-row mode badge.
///
/// V2-17 replaced the ①②③ numerals with symbols. A numeral only says WHERE a
/// mode sits on the keyboard — the user had to memorise a mapping table to
/// read their own rows. The shape says WHAT the mode did:
///   realtime  → waveform (speech flowed straight through)
///   translate → swap arrows (two languages exchanged)
///   organize  → list (the utterance was structured into text)
/// Three shapes from three shape families (vertical bars / crossing arrows /
/// horizontal lines), so the silhouette alone tells them apart at 18×18.
///
/// The trio is FIXED — three locked modes, never a fourth — and mirrors the
/// desktop ICONS names waveform/swap/list (Icon.vue, also what the capsule
/// will reuse), so one record reads identically on both ends.
class ModeBadgeMeta {
  final IconData icon;

  /// The badge's queryable word (Semantics label + long-press Tooltip). The
  /// 18×18 chip has no room for text, but an unexplained icon is just a new
  /// kind of numeral — the word must be askable.
  ///
  /// Resolved from [AppStrings], never written here: it is user-visible copy,
  /// and three literals baked into a widget mid-way through the
  /// Chinese/English/Japanese/Korean (中/英/日/韩) work would be three strings
  /// the language switch silently cannot reach.
  final String label;
  final Color fg;
  final Color bg;
  const ModeBadgeMeta(this.icon, this.label, this.fg, this.bg);
}

ModeBadgeMeta modeBadgeMeta(FlowMode mode, AppStrings strings) {
  switch (mode) {
    case FlowMode.realtime:
      // Not a const creation: FlowMicColors fields are static final.
      return ModeBadgeMeta(
        Icons.graphic_eq,
        strings.modeLabel(mode),
        FlowMicColors.brand,
        FlowMicColors.brandSoft,
      );
    case FlowMode.translate:
      return ModeBadgeMeta(
        Icons.swap_horiz,
        strings.modeLabel(mode),
        FlowMicColors.teal,
        FlowMicColors.tealSoft,
      );
    case FlowMode.organize:
      return ModeBadgeMeta(
        Icons.format_list_bulleted,
        strings.modeLabel(mode),
        FlowMicColors.amber,
        FlowMicColors.amberSoft,
      );
  }
}

/// The mode badge — colour + symbol encode the entry's mode (was ①②③).
class ModeBadge extends StatelessWidget {
  const ModeBadge(this.mode, {super.key, required this.strings});
  final FlowMode mode;

  /// Required, deliberately — no `AppStrings.of(AppLocale.zh)` fallback. A
  /// friendly default here would render Chinese to an English user and look
  /// like it worked (façade rule ②: a DI default is either the real thing or
  /// it throws).
  final AppStrings strings;

  @override
  Widget build(BuildContext context) {
    final ModeBadgeMeta m = modeBadgeMeta(mode, strings);
    // Two ways to ask "what does this symbol mean": a screen reader gets the
    // Semantics label, a long press raises the Tooltip. excludeFromSemantics
    // on the Tooltip keeps the explicit label the single source in the tree.
    return Semantics(
      label: m.label,
      child: Tooltip(
        message: m.label,
        excludeFromSemantics: true,
        child: Container(
          width: 18,
          height: 18,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: m.bg,
            borderRadius: BorderRadius.circular(6),
          ),
          child: Icon(m.icon, size: 11.5, color: m.fg),
        ),
      ),
    );
  }
}

/// Coloured status dot.
class StatusDot extends StatelessWidget {
  const StatusDot(this.color, {super.key, this.size = 8});
  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
  );
}

/// glyph/icon + label — the delivery pill, one of [DeliveryFace]'s faces.
///
/// N2: takes the FACE, not the [EntryStatus]. A pill that took the status could
/// not draw the "delivering" (投递中) / "undelivered" (未投递) distinction at
/// all, and a pill that took the whole row would decide the distinction in
/// two places.
class StatusPill extends StatelessWidget {
  const StatusPill(this.face, {super.key, required this.strings});
  final DeliveryFace face;

  /// Required, deliberately — see [ModeBadge.strings] (façade rule ②: a DI
  /// default is either the real thing or it throws).
  final AppStrings strings;

  @override
  Widget build(BuildContext context) {
    final StatusMeta m = deliveryFaceMeta(face, strings);
    // CARD-UI (owner 2026-10-14): no leading dot. The face's colour is already
    // carried by its glyph and its words, and on a 360 dp phone the dot's
    // 15 px were what pushed the longest states off the card's first line.
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (m.icon != null) ...<Widget>[
          Icon(m.icon, size: 12, color: m.color),
          const SizedBox(width: 3),
        ],
        // The status word is never truncated (R11: a state word must say the
        // whole fact). Flexible lets it WRAP to a second line when the pill is
        // wider than the card, instead of overflowing the row: `fr`
        // "Enregistrement seul" at 360 dp / text scale 1.3 overflowed by 27 px.
        Flexible(
          child: Text(
            m.glyph.isEmpty ? m.label : '${m.glyph} ${m.label}',
            style: TextStyle(
              color: m.color,
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ],
    );
  }
}

/// The ✎ "edited" (已编辑) corner overlay — orthogonal to status (§4.0 D). Neutral chip,
/// deliberately NOT a status colour, so the underlying delivery colour still
/// reads through the row. Label resolved by the caller from AppStrings
/// ([AppStrings.editedMark]) — same contract as [PolishSkippedMark.label].
///
/// CARD-UI: [compact] draws the pencil alone, for a card line that cannot hold
/// the word (`MetaOptional` picks it only then). The word is still there for
/// a screen reader (the semantics label) and on a tap (the tooltip).
class EditedMark extends StatelessWidget {
  const EditedMark({
    super.key,
    required this.label,
    this.compact = false,
    this.tapShowsLabel = true,
  });
  final String label;
  final bool compact;

  /// Compact form: a tap shows [label]. False in selection mode, where a tap
  /// must reach the row and toggle it (the semantics label still carries
  /// [label]). Never a long press: that opens the row's menu.
  final bool tapShowsLabel;

  @override
  Widget build(BuildContext context) {
    final Widget chip = Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: FlowMicColors.surface2,
        border: Border.all(color: FlowMicColors.line),
        borderRadius: BorderRadius.circular(7),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.edit_outlined, size: 10, color: FlowMicColors.t2),
          if (!compact) ...<Widget>[
            const SizedBox(width: 3),
            Text(
              label,
              style: TextStyle(
                color: FlowMicColors.t2,
                fontSize: 9.5,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ],
      ),
    );
    if (!compact) return chip;
    return Semantics(
      label: label,
      child: Tooltip(
        message: label,
        triggerMode: tapShowsLabel
            ? TooltipTriggerMode.tap
            : TooltipTriggerMode.manual,
        excludeFromSemantics: true,
        child: chip,
      ),
    );
  }
}

/// CARD-UI: the inline Resend's compact form — the same action and the same
/// words (its semantics label), drawn as one circular-arrow icon in the
/// face's colour, for a card whose two meta lines cannot hold the word
/// (`MetaOptional` picks it only then; the word form is preferred). No
/// tooltip: a long-press tooltip would take the long press that opens the
/// row's menu.
class ResendIcon extends StatelessWidget {
  const ResendIcon({
    super.key,
    required this.label,
    required this.color,
    required this.onTap,
  });
  final String label;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: label,
    child: GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2),
        child: Icon(Icons.refresh, size: 15, color: color),
      ),
    ),
  );
}

/// WP-R4-6 ⑦: transient polish-skipped corner mark — orthogonal to the
/// five-state status pill (original spec: docs/archive/strategy/
/// R4-PRIVATE-TASK-CARDS.md WP-R4-6 ⑦, "amber, attention, not delivery
/// failure"). UI-1 (2026-10-13): amber only where the user can fix something
/// ([needsAction], i.e. `PolishBadge.noModel` / `modelRejected`); every other
/// kind is a missed optional polish on text that WAS delivered and renders as
/// the same calm neutral chip as [EditedMark]. Label comes from AppStrings
/// (explicit locale), never OS locale.
class PolishSkippedMark extends StatelessWidget {
  const PolishSkippedMark({
    super.key,
    required this.label,
    this.fullLabel,
    this.needsAction = false,
    this.tapShowsFull = true,
  });
  final String label;

  /// With [fullLabel]: a tap shows it. False in selection mode, where a tap
  /// must reach the row and toggle it (the semantics label still carries it).
  final bool tapShowsFull;

  /// CARD-UI: set when [label] is the short wording; the full one is then the
  /// screen-reader label and shows on a tap.
  final String? fullLabel;

  /// true ⇒ amber attention style; false ⇒ neutral style.
  final bool needsAction;

  @override
  Widget build(BuildContext context) {
    final Widget chip = Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: needsAction ? FlowMicColors.amberSoft : FlowMicColors.surface2,
        border: Border.all(
          color: needsAction ? const Color(0x4DFBBF24) : FlowMicColors.line,
        ),
        borderRadius: BorderRadius.circular(7),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: needsAction ? FlowMicColors.amber : FlowMicColors.t2,
          fontSize: 9.5,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
    if (fullLabel case final String full?) {
      return Semantics(
        label: full,
        excludeSemantics: true,
        child: Tooltip(
          message: full,
          triggerMode: tapShowsFull
              ? TooltipTriggerMode.tap
              : TooltipTriggerMode.manual,
          excludeFromSemantics: true,
          child: chip,
        ),
      );
    }
    return chip;
  }
}
