// ── WHY THIS FILE EXISTS: THE 800-LINE CAP, AND NOTHING ELSE ─────────────────
//
// `verify:lint` file-size (SRC_MAX = 800) — plus_panel.dart sat at exactly 800
// when card CR-12-F had to add the 「with times」 chip to the send bar. The
// favorites (常用) list moved out first, in its own commit, so the feature
// diff stays readable.
//
// 🔴 **THIS IS A MOVE.** `_list`, `_favTick` and `_row` are byte-for-byte what
// they were in plus_panel.dart, doc comments included; so are the favorites
// header and its save-buffer button (`_header`, `_saveBlocked`,
// `_saveButton`), moved in a second pass to keep plus_panel.dart under 700
// lines once the chip landed. The only mechanical
// change is the wrapper: they were instance methods of `_PlusPanelState` and
// are now members of a private extension on it, so every call site
// (`_list(context)` and `_header(context)` in `build`, `_favTick(text)` in
// `_row`) is unchanged.
// A `part` for the same reason as `plus_panel_image_tile.dart`: the state
// class is private, and a second library would force a rename.

part of 'plus_panel.dart';

extension _PlusPanelFavoritesList on _PlusPanelState {
  Widget _list(BuildContext context) {
    if (favorites.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              strings.favoritesEmpty,
              style: TextStyle(color: FlowMicColors.t2, fontSize: 13),
            ),
            const SizedBox(height: 4),
            Text(
              strings.favoritesEmptyHint,
              style: TextStyle(color: FlowMicColors.t3, fontSize: 11),
            ),
          ],
        ),
      );
    }
    final List<String> items = favorites.items;
    return ListView.builder(
      shrinkWrap: true,
      itemCount: items.length,
      itemBuilder: (BuildContext context, int i) => _row(context, items[i]),
    );
  }

  /// 09-D — the tick box for a favorites (常用) phrase.
  ///
  /// 🔴 A SEPARATE TAP TARGET, and the row body keeps the meaning it has had
  /// since F-5: a tap on the phrase is still tap-to-send (点选即发). Making the
  /// body's meaning
  /// depend on whether anything else happens to be ticked would be a mode the
  /// user cannot see — and tap-to-send (点选即发) is a shipped behaviour, not
  /// something this
  /// card was asked to replace. Same shape as `_ImageTile._originalTick`, which
  /// states the same rule for the same reason.
  Widget _favTick(String text) {
    final PlusPanelSelection sel = _selection!;
    final bool on = sel.contains(PlusPick.keyForFavorite(text));
    return InkWell(
      key: ValueKey<String>('plus.fav.tick.$text'),
      onTap: () => sel.toggle(PlusPick.favorite(text)),
      borderRadius: BorderRadius.circular(9),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(0, 11, 8, 11),
        child: Icon(
          on ? Icons.check_box_outlined : Icons.check_box_outline_blank,
          size: 17,
          color: on ? FlowMicColors.brand : FlowMicColors.t3,
        ),
      ),
    );
  }

  Widget _row(BuildContext context, String text) => Container(
    decoration: BoxDecoration(
      border: Border(top: BorderSide(color: FlowMicColors.line)),
    ),
    child: Row(
      children: <Widget>[
        if (_selection != null) _favTick(text),
        Expanded(
          child: InkWell(
            key: ValueKey<String>('plus.fav.send.$text'),
            // Tap-to-send (点选即发) — inert on a cloud instance, where the caption above
            // already states there is nothing to inject into.
            onTap: noPcTarget
                ? null
                : () {
                    Navigator.of(context).pop();
                    widget.onSend(text);
                  },
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 11),
              child: Row(
                children: <Widget>[
                  Icon(
                    Icons.star_rounded,
                    size: 14,
                    color: noPcTarget
                        ? FlowMicColors.t3
                        : FlowMicColors.amber,
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(
                      text,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: noPcTarget
                            ? FlowMicColors.t2
                            : FlowMicColors.t1,
                        fontSize: 13,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        InkWell(
          key: ValueKey<String>('plus.fav.remove.$text'),
          // owner 2026-07-27: a 14px ✕ sitting beside a tappable phrase is the
          // easiest thing on this panel to hit by mistake.
          onTap: () async {
            final bool sure = await confirmDestructive(
              context,
              title: strings.removeFavoriteConfirmTitle(text),
              message: strings.removeFavoriteConfirmBody,
              confirmLabel: strings.confirmDelete,
              cancelLabel: strings.cancel,
            );
            if (sure) await favorites.remove(text);
          },
          borderRadius: BorderRadius.circular(9),
          child: Tooltip(
            message: strings.favoritesRemove,
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: Icon(
                Icons.close,
                size: 14,
                color: FlowMicColors.t3,
              ),
            ),
          ),
        ),
      ],
    ),
  );

  Widget _header(BuildContext context) => Row(
    children: <Widget>[
      Icon(Icons.star_rounded, size: 16, color: FlowMicColors.amber),
      const SizedBox(width: 7),
      Text(
        strings.favorites,
        style: TextStyle(
          color: FlowMicColors.t1,
          fontSize: 14,
          fontWeight: FontWeight.w600,
        ),
      ),
      const SizedBox(width: 7),
      Text(
        strings.favoritesCounter(favorites.length, kFavoritesMax),
        style: TextStyle(color: FlowMicColors.t3, fontSize: 10.5),
      ),
      const Spacer(),
      _saveButton(context),
    ],
  );

  /// W2.5-E. Rendered only while [aiComposing]; the empty-box case keeps its
  /// original treatment (the favorites (常用) empty state already tells the
  /// user to type
  /// something first — [AppStrings.favoritesEmptyHint]), so this line means
  /// exactly one thing: 「有内容，但现在不是存它的时候」("there's content, but now
  /// isn't the time to save it").
  Widget _saveBlocked() => Padding(
    key: const ValueKey<String>('plus.fav.save.blocked'),
    padding: const EdgeInsets.only(top: 7),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Icon(Icons.info_outline, size: 14, color: FlowMicColors.amber),
        const SizedBox(width: 7),
        Expanded(
          child: Text(
            strings.favoritesSaveBlockedAiComposing,
            style: TextStyle(color: FlowMicColors.amber, fontSize: 10.5),
          ),
        ),
      ],
    ),
  );

  /// Save current buffer (存当前缓冲) (F-5). Disabled with a stated reason when the box is empty —
  /// never a live-looking button that quietly does nothing.
  ///
  /// ── W2.5-E: THE SECOND CRITERION, AND WHY IT IS ON *THIS* HALF ────────────
  /// [aiComposing] is the live-compose term. It is here because a favourite is
  /// PERMANENT: `ai_compose_controller.dart` streams `compose:chunk` deltas
  /// straight into the buffer (`_host.aiBuffer` in `onEvent`), so mid-run the
  /// buffer holds partial, unvalidated model output — and once that is saved,
  /// tapping it later goes `ChatController.sendFavorite` →
  /// `ManualDelivery.deliverText` (chat_explicit_delivery.dart:60), which has
  /// no compose term at all.
  ///
  /// 🔴 THE FIX IS THE SAVE HALF ONLY. `deliverText` is deliberately NOT
  /// guarded on compose state, and must not be: a favourite is a phrase the
  /// user wrote, not model output, and gating delivery on 「is some unrelated
  /// AI run streaming right now」 would answer a question the send path was
  /// never asking. Keep the partial text OUT of the store; do not re-validate
  /// it on the way out.
  ///
  /// ⚠️ [aiComposing] is a snapshot taken when the sheet opened (same shape as
  /// [imageSending] / [noPcTarget] / [buffer] — this panel is built once by
  /// `showPlusPanel` and only rebuilds on [favorites]). Both ways it can go
  /// stale are stated rather than assumed:
  ///   · run STARTS while the sheet is open — impossible: the AI action row
  ///     (操作行) lives
  ///     behind this modal (`ai_action_row.dart` is on ChatFlowPage), and the
  ///     one production caller passes `s.controller.isAiComposing` at open time
  ///     (`chat_flow_composer.dart` `_openPlusPanelRouted`).
  ///   · run ENDS while the sheet is open — possible, and it leaves the button
  ///     disabled one sheet too long. That is the direction that refuses a
  ///     legitimate save instead of storing a half-written one, and it costs
  ///     the user one reopen. Lifting the whole panel onto a controller
  ///     listenable to fix it would trade that for a live rebuild path this
  ///     widget has never had; not done without a ruling.
  Widget _saveButton(BuildContext context) {
    final bool on = buffer.trim().isNotEmpty && !aiComposing;
    return InkWell(
      key: const ValueKey<String>('plus.fav.save'),
      onTap: on
          ? () async {
              final FavoriteAddOutcome outcome = await favorites.add(buffer);
              widget.onFeedback(strings.favoriteAddResult(outcome));
            }
          : null,
      borderRadius: BorderRadius.circular(9),
      child: Container(
        height: 30,
        padding: const EdgeInsets.symmetric(horizontal: 11),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: on ? FlowMicColors.brandSoft : FlowMicColors.surface2,
          borderRadius: BorderRadius.circular(9),
          border: Border.all(
            // Same alpha over the TOKEN, following settings_widgets.dart:110:
            // 0x66818CF8 is dark-brand @ .4, so dark stays pixel-identical while
            // light stops being indigo-400 where brand deepens to indigo-600.
            color: on ? FlowMicColors.brand.withValues(alpha: 0.4) : FlowMicColors.line,
          ),
        ),
        child: Text(
          strings.favoritesSaveBuffer,
          style: TextStyle(
            color: on ? FlowMicColors.brand : FlowMicColors.t3,
            fontSize: 12,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}
