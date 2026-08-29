// Part of settings_page.dart — the preferences and about cards.
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// Same shape and same reason as settings_custom_terms.dart (which cites
// ptt_wire_keepalive.dart, 0.2.52 §5): settings_page.dart was at 706/800
// (`verify/lint/file-size.mjs` SRC_MAX=800) and W5a Lane 1 adds TWO rows to it
// — the FB-4 three-tier text-size row in the preferences card and the P-7
// 「view the usage guide」row
// in the about card. Dart has no partial classes, so only BEHAVIOUR can move;
// the fields (`appSettings`, `version`, …) stay on the class.
//
// These two cards were chosen because they are exactly the ones this window
// grows, so the file that has to be read while working on them is small.
//
// 🔴 DIFF DISCIPLINE: the two bodies below were moved **character-for-character**
// out of settings_page.dart. There is exactly ONE mechanical edit — the two
// instance methods become extension members, so both call sites in `build()`
// are untouched — and **any other difference in that move is a bug**. The rows
// this window ADDS are appended after the move, and each is marked with its own
// card number so the diff separates 「what was moved over」 from 「what was newly written」.

part of 'settings_page.dart';

// ── the text-size slider's two pure functions (owner ruling 2026-08-27) ──────
//
// Top-level rather than extension members so that neither of them can reach
// `appSettings` — a slider position must be a function of the position ALONE.
// The chip row they replace could not get this wrong (each chip named its own
// rung); a slider can, and the way it goes wrong is 「reads the current rung to
// decide what the user just asked for」.

/// Which rung the thumb is sitting on. [v] is an INDEX into
/// [AppTextScale.ladder] — the slider's `divisions` already snapped it, and
/// `round()` is the second lock on the same door: a position that is not one
/// of the five has no rung to map to, and inventing one is the only way an
/// in-between size could ever reach the pref.
AppTextScale _textScaleAt(double v) => AppTextScale
    .ladder[v.round().clamp(0, AppTextScale.ladder.length - 1)];

/// The one place this row turns a rung into the words on screen.
/// `AppTextScale.percent` does the arithmetic (medium = 100%, derived from the
/// real factor); this only adds the sign, and it is shared by the read-out,
/// the drag bubble, the screen-reader value and the note — four surfaces that
/// must never be able to disagree about what rung the user is on.
String _textScalePercentLabel(AppTextScale step) => '${step.percent}%';

extension SettingsPagePreferences on SettingsPage {
  // ── preferences (WP-R4-3 + V2-07.4) ─────────────────────────────────────────────
  // UI language = an explicit choice (the UI never follows the OS locale —
  // red line). Apply-and-save-immediately: tapping a chip calls setLocale
  // directly (persists flowmic.pref.locale), and the whole page re-renders
  // instantly through AppStrings.
  // Theme = three states, defaults to following the system; setThemeMode
  // persists + re-resolves FlowMicTheme,
  // and the whole tree recolors instantly via main.dart's
  // ValueListenableBuilder, with no restart needed.
  Widget _preferencesCard(AppStrings s) => settingsCard(
    child: Column(
      children: <Widget>[
        settingsRow(
          // Title on its own line so EN "Interface language" cannot collide
          // with the chips, and so a 48dp Material splash cannot cover
          // the section below. Chips wrap across the full card width.
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(s.uiLanguage, style: kRowTitle),
              const SizedBox(height: 8),
              // 🔴 In-place correction (2026-08-14): this was four hand-written chips
              // naming `AppLocale.zh/en/ja/ko` and reading `s.langZh` … one by
              // one. It now iterates [AppLocale.values] and labels each chip
              // with the enum's own endonym. Two things changed, and only the
              // first is cosmetic:
              //   ① nine languages is too many to spell out;
              //   ② a hand-written row list cannot fail to compile when a
              //      language is added, so the five that landed on 2026-08-14
              //      would have been reachable from the first-run screen and
              //      then UNREACHABLE from settings — a user who picked Français
              //      on install could never have got back to it, and no test and
              //      no gate would have said a word.
              //
              // ⚠️ The chip label is the ENDONYM.
              // In-place correction (WP3 C11, 2026-08-18): the paragraph that
              // stood here said the four hand-written name strings
              // (`s.langZh`/`s.langEn`…) 「stay exactly where they are and
              // keep their only remaining reader: spokenLangLabel」. That
              // reader now derives from [AppLocale] endonyms too (the spoken
              // row grew 4 → 8 and a nine-arm hand table would have been the
              // #1 defect shape this comment warned about), so the four
              // getters are DELETED — both rows now read the one
              // registry-mirrored source, and the spoken row's `(tag)`
              // suffix keeps the two rows distinguishable on screen and in
              // every `find.text`.
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: <Widget>[
                  for (final AppLocale l in AppLocale.values)
                    settingsChip(
                      l.endonym,
                      on: appSettings.locale == l,
                      onTap: () => appSettings.setLocale(l),
                    ),
                ],
              ),
            ],
          ),
        ),
        // Spoken language = the audio:start.source_lang that goes on the
        // wire. Placed right next to the UI language row,
        // because the two are most easily mistaken for one thing — so their
        // titles each speak for themselves, and a sentence underneath
        // clarifies which path it governs (owner ruling: the cloud-relay
        // path; when connected to your own computer, that computer's engine
        // setting takes over). Apply-and-save-immediately: tapping a chip
        // calls setSpokenLang directly, taking effect on the next
        // press-and-hold (the snapshot is taken at the instant of PTT-down, §4.0 B).
        settingsRow(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Text(s.spokenLangTitle, style: kRowTitle),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Wrap(
                      alignment: WrapAlignment.end,
                      spacing: 8,
                      runSpacing: 8,
                      children: <Widget>[
                        for (final String tag in kSpokenLangs)
                          settingsChip(
                            s.spokenLangLabel(tag),
                            on: appSettings.spokenLang == tag,
                            onTap: () => appSettings.setSpokenLang(tag),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                s.spokenLangNote,
                style: TextStyle(color: FlowMicColors.t3, fontSize: 11, height: 1.4),
              ),
            ],
          ),
        ),
        settingsRow(
          child: Row(
            children: <Widget>[
              Expanded(child: Text(s.themeTitle, style: kRowTitle)),
              settingsChip(
                s.themeSystem,
                on: appSettings.themeMode == AppThemeMode.system,
                onTap: () => appSettings.setThemeMode(AppThemeMode.system),
              ),
              const SizedBox(width: 8),
              settingsChip(
                s.themeLight,
                on: appSettings.themeMode == AppThemeMode.light,
                onTap: () => appSettings.setThemeMode(AppThemeMode.light),
              ),
              const SizedBox(width: 8),
              settingsChip(
                s.themeDark,
                on: appSettings.themeMode == AppThemeMode.dark,
                onTap: () => appSettings.setThemeMode(AppThemeMode.dark),
              ),
            ],
          ),
        ),
        // ── FB-4 three-tier text size (owner ruling D3, 2026-08-06) ────────────────────────
        //
        // 🔴 `last: true` has been **moved to this row** from the theme row.
        // It is not decoration: settingsRow's
        // `last` controls 「whether to paint the bottom divider line」, and
        // leaving it on the previous row would draw a stray extra line at
        // the card's bottom edge.
        // (This one line is the ONLY byte this pass touches on the theme row.)
        //
        // Uses Wrap rather than copying the theme row's bare Row:
        // `textScaleSmall` is 「작게」 in ko,
        // and the three ja/ko chips are much wider than 大/中/小
        // (large/medium/small), while this row's title 「字号」(text size) is
        // only marginally narrower than 「主题」(theme) — the language row
        // (four chips) already used Wrap for the same reason, and this one
        // follows that precedent rather than betting that all four locales
        // will fit exactly.
        //
        // 🔴🔴 IN-PLACE CORRECTION (owner ruling 2026-08-27,
        // `docs/decisions/2026-08-27-owner-text-scale-slider.md`). The
        // paragraph above is kept verbatim because it is the record of how
        // this row got here — and **the chips it describes are gone**.
        //
        // WHAT FAILED, in owner's own words from an English device: 「there
        // are two 'large' entries; tapping them really does give different
        // sizes」. There were five: Small / Medium / Large / Larger /
        // Largest. Three of them are the same adjective inflected, and on
        // glass, side by side, they do not sort themselves in the reader's
        // head. (zh/ja/ko never had this — 小/中/大/更大/最大 is a scale.
        // The defect existed in exactly the language the tests are written
        // in, and every one of those tests was green.)
        //
        // ⇒ ONE SLIDER, five stops, and the current rung reads as a
        // **percentage** — a scale that already sorts itself, in every
        // language, with no word to confuse. What did NOT change: the enum,
        // the pref key, and the five factors (owner's ruling scoped this to
        // the *picker*, not to the rungs).
        //
        // ⚠️ Three things this row still owes, each pinned by a case in
        // `test/text_scale_test.dart` ②b:
        //   ① **apply-and-save in the same gesture** (settings red line —
        //      no save button anywhere in this page). Hence BOTH callbacks:
        //      `onChanged` for the live drag and for a tap on the track,
        //      `onChangeEnd` so the rung the finger was let go on is the
        //      rung that lands even if a rebuild raced the last frame.
        //      `setTextScale` returns early when nothing changed, so the
        //      pair costs one write per rung crossed, not one per frame.
        //   ② **it may only ever stop on the five rungs** — `divisions`
        //      makes the thumb snap, and the value is an INDEX into
        //      `AppTextScale.ladder`, so there is no representation for an
        //      in-between value to be persisted as.
        //   ③ **accessibility**: a bare slider announces 「50%」 of its own
        //      range, which here would be a number that means nothing.
        //      MergeSemantics + the row title give the merged node this
        //      row's name, and `semanticFormatterCallback` makes it
        //      announce the same percentage the sighted user reads.
        settingsRow(
          last: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                children: <Widget>[
                  // Expanded on the TITLE, not on the read-out: on a 320dp
                  // screen at the top rung it is the title that must be
                  // allowed to wrap, while the percentage — four glyphs that
                  // ARE the current value — must never be the thing that
                  // gets squeezed.
                  Expanded(child: Text(s.textScaleTitle, style: kRowTitle)),
                  const SizedBox(width: 10),
                  Text(
                    _textScalePercentLabel(appSettings.textScale),
                    key: const ValueKey<String>('settings.textScale.percent'),
                    style: kRowTitle.copyWith(
                      color: FlowMicColors.brand,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
              MergeSemantics(
                child: Semantics(
                  label: s.textScaleTitle,
                  child: Slider(
                    key: const ValueKey<String>('settings.textScale.slider'),
                    min: 0,
                    max: (AppTextScale.ladder.length - 1).toDouble(),
                    // Five stops ⇒ four intervals. Written from the ladder's
                    // own length so appending a sixth rung one day cannot
                    // leave a slider that silently refuses to reach it.
                    divisions: AppTextScale.ladder.length - 1,
                    value: AppTextScale.ladder
                        .indexOf(appSettings.textScale)
                        .toDouble(),
                    // The bubble above the thumb while dragging.
                    label: _textScalePercentLabel(appSettings.textScale),
                    semanticFormatterCallback: (double v) =>
                        _textScalePercentLabel(_textScaleAt(v)),
                    activeColor: FlowMicColors.brand,
                    onChanged: (double v) =>
                        appSettings.setTextScale(_textScaleAt(v)),
                    onChangeEnd: (double v) =>
                        appSettings.setTextScale(_textScaleAt(v)),
                  ),
                ),
              ),
              const SizedBox(height: 6),
              Text(
                // 🔴 The number in this sentence is `large.percent`, computed,
                // not typed into nine translation files: it answers 「which
                // rung is how the app looked before」, and `large` is that rung
                // BY DEFINITION (`app_settings.dart`: factor 1.00, the default
                // arm of `load()`). Typing 「109%」 into the catalogue would go
                // on saying 109 in nine languages the day a factor moves.
                s.textScaleNote(_textScalePercentLabel(AppTextScale.large)),
                style: TextStyle(color: FlowMicColors.t3, fontSize: 11, height: 1.4),
              ),
            ],
          ),
        ),
      ],
    ),
  );

  // ── about (卡 U9) ─────────────────────────────────────────────────────────
  // The phone had no on-screen surface for its own build: package_info was
  // only ever read for export metadata (portable_export.dart), never shown
  // to the user. A support thread that starts with 「what version are you on?」 had no
  // answer the user could read off their own screen. [version] is read fresh
  // on every build of this widget (FutureBuilder, not a cached field) — a
  // dev-menu reinstall or hot-restart never shows a stale number.
  Widget _aboutCard(BuildContext context, AppStrings s) => settingsCard(
    child: Column(
      children: <Widget>[
        settingsRow(
          // 卡 U7 (mobile half) —— the help row below only exists while
          // `kHelpUrl` is non-empty (see help_link.dart). Today it is empty,
          // so this version row is the last (and only) row, same as before
          // U7 touched this card.
          //
          // 🔴 P-7 correction: **no longer the last row**. 「view the usage
          // guide」 renders unconditionally
          // (the page it points to ships inside the package, unlike
          // kHelpUrl which points to a page that doesn't exist),
          // so ownership of `last` shifted down by one row entirely. Keeping
          // the old `last: kHelpUrl.isEmpty`
          // would draw a divider line under the version row AND another
          // under the guide row — visually one too many,
          // and mechanically the question 「which row is last」 would have two answers.
          child: FutureBuilder<String?>(
            future: version.appVersion(),
            builder: (BuildContext context, AsyncSnapshot<String?> snap) {
              final String? v = snap.data;
              // Only a non-empty real answer counts — [AppVersionPort.appVersion]'s
              // own contract is "null when it genuinely cannot be read", and while
              // the future is still pending `snap.data` is also null, so both read
              // as the honest "not known (yet)" copy rather than a blank line.
              final String value = (v != null && v.isNotEmpty)
                  ? s.appVersionValue(v)
                  : s.appVersionUnknown;
              return Row(
                children: <Widget>[
                  Icon(Icons.info_outline, size: 20, color: FlowMicColors.brand),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(s.appVersionLabel, style: kRowTitle),
                        const SizedBox(height: 3),
                        Text(value, style: kRowSub),
                      ],
                    ),
                  ),
                ],
              );
            },
          ),
        ),
        // ── P-7's 「review again」 entry point for the first-run guide
        // (owner ruling 7-2: put it in the 「about」 section) ────────
        //
        // 🔴 It is a **different kind of thing** from the kHelpUrl row,
        // don't add a condition just by copying that one: the help row
        // points to a page that still does not exist today, so it must
        // first prove it has a real destination before it is allowed to
        // appear (façade guard);
        // the guide page ships inside this very package, `OnboardingReviewPage`
        // is reachable at compile time — it has no
        // 「might have no destination」 state.
        //
        // Wiring criterion (anti-façade, greppable): this row is the
        // **sole** production caller of `OnboardingReviewPage`,
        // and `onboarding_first_run_test.dart`'s 「the settings-page row
        // really does pop the guide」 assertion targets it and asserts
        // guide page 1 appears in the tree.
        settingsRow(
          last: kHelpUrl.isEmpty,
          child: InkWell(
            key: const ValueKey<String>('settings.openGuide'),
            onTap: () => Navigator.of(context).push<void>(
              MaterialPageRoute<void>(
                builder: (_) => OnboardingReviewPage(appSettings: appSettings),
              ),
            ),
            child: Row(
              children: <Widget>[
                Icon(Icons.menu_book_outlined, size: 20, color: FlowMicColors.brand),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(s.onboardingReviewTitle, style: kRowTitle),
                      const SizedBox(height: 3),
                      Text(s.onboardingReviewSub, style: kRowSub),
                    ],
                  ),
                ),
                Icon(Icons.chevron_right, size: 18, color: FlowMicColors.t3),
              ],
            ),
          ),
        ),
        // 卡 U7 (mobile half) —— FAÇADE GUARD: `kHelpUrl` is '' right now (no
        // verified help/FAQ page exists — see help_link.dart), so this row
        // must not render at all. A visible "Help & support" row with nowhere
        // to go would be worse than the section not existing
        // (test/help_link_facade_test.dart pins this).
        if (kHelpUrl.isNotEmpty)
          settingsRow(
            last: true,
            child: Row(
              children: <Widget>[
                Icon(Icons.help_outline, size: 20, color: FlowMicColors.brand),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(s.helpLabel, style: kRowTitle),
                      const SizedBox(height: 3),
                      SelectableText(kHelpUrl, style: kRowSub),
                    ],
                  ),
                ),
              ],
            ),
          ),
      ],
    ),
  );
}
