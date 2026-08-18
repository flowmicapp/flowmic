// SPEC-REF:
//   docs/ui-design/demo/mobile.html frame 7 (settings page: account / mode /
//     scenario card·recognition correction / custom terms / sync / preferences
//     / about — anchor sections, apply-and-persist immediately)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.1 (structured scenario
//     card: profession/domain multi-select chips + word-pack checkboxes + term list)
//   CLAUDE.md red line: settings apply-and-persist immediately, no save
//     button, no "advanced" collapsible section; the scenario card is
//     structured, not free text; UI does not follow the OS locale
//
// The settings screen. Every control applies and persists immediately — a tap writes through its
// controller immediately (no save button, no staging, no advanced section). The
// scenario card is STRUCTURED: profession/domain are fixed curated multi-selects
// (chips, never a free prompt box), packs are checkboxes over the protocol
// DICTIONARY_PACKS ids, and only the ≤40-char custom terms are free input.
// Shared primitives + presets live in settings_widgets.dart.

import 'package:flutter/material.dart';

import '../../generated/flowmic_settings.g.dart';
import '../auth/login_controller.dart';
import '../destination/destination_controller.dart';
import '../portable/asset_inventory.dart';
import '../timeline/timeline_store.dart';
import '../portable/export_sheet.dart';
import '../portable/stats_clear_sheet.dart';
import '../portable/portable_controller.dart';
import '../portable/portable_import.dart';
import '../portable/portable_ports.dart' show AppVersionPort;
import '../ptt/ptt_session.dart';
import '../settings/app_settings.dart';
import '../settings/app_strings.dart';
import '../settings/scenario_card.dart';
import '../settings/scenario_card_controller.dart';
import '../support/help_link.dart' show kHelpUrl;
import '../update/update_controller.dart' show UpdateController;
import 'onboarding/first_run_onboarding_page.dart' show OnboardingReviewPage;
import 'settings_update_card.dart';
import 'settings_widgets.dart';
import 'tokens.dart';

part 'settings_custom_terms.dart';
// W5a Lane 1 — the preferences card and about card moved here; the reason
// (including the verbatim-move discipline) is written in that file's header.
part 'settings_preferences.dart';

class SettingsPage extends StatelessWidget {
  const SettingsPage({
    super.key,
    required this.scenario,
    required this.appSettings,
    required this.login,
    required this.destination,
    required this.session,
    required this.portable,
    required this.inventory,
    required this.timeline,
    required this.version,
    required this.update,
  });

  final ScenarioCardController scenario;
  final AppSettingsController appSettings;
  final LoginController login;
  final DestinationController destination;
  final PttSession session;

  /// Window C export / import (doc 16). REQUIRED, with no default: a settings
  /// page that silently rendered the "data" section against a null controller
  /// would show two
  /// rows that do nothing, which is the façade shape this repo's anti-façade
  /// rule exists to catch.
  final PortableController portable;

  /// Window C2 stats + clear (doc 16 §6.1 / §6.2). REQUIRED for the same
  /// reason
  /// [portable] is: a "data" section rendered against nothing would show a
  /// row that opens an empty sheet — anti-façade.
  ///
  /// ⚠️ It takes the **SAME** inventory instance as [PortableController]
  /// (the one main.dart's
  /// composition root hands down), so "export says N rows" and "stats says N
  /// rows" cannot ever disagree.
  final AssetInventory inventory;

  /// The store that clear acts on — stats is read-only, clear writes, and
  /// both act on the same table.
  final TimelineStore timeline;

  /// Card U9 — the ONE source of the version shown in the "about" block.
  /// REQUIRED, no default and no hardcoded
  /// fallback string: this is the exact anti-façade shape §4.1 warns about for
  /// [portable]/[inventory] above, applied to a version number instead of a
  /// row of buttons — a hardcoded "0.3.0" would silently stop matching the
  /// installed build the moment either one moves.
  final AppVersionPort version;

  /// UP-2 in-app update (check + reminder). REQUIRED, no default — for the
  /// same reason as [portable] / [inventory] / [version] above, and the cost
  /// here is even higher:
  /// if an optional parameter is forgotten in production wiring, the
  /// "update" section would **silently vanish**, and "this build doesn't
  /// carry this feature" and "we forgot to wire it up" would look identical.
  /// That is exactly what the anti-façade discipline exists to prevent — make
  /// it unable to say anything at compile time.
  final UpdateController update;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: FlowMicColors.canvas,
      body: SafeArea(
        child: ListenableBuilder(
          listenable: Listenable.merge(<Listenable>[
            appSettings,
            scenario,
            login,
            destination,
            portable,
          ]),
          builder: (BuildContext context, _) {
            final AppStrings s = AppStrings.of(appSettings.locale);
            return Column(
              children: <Widget>[
                _appBar(context, s),
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(14, 8, 14, 24),
                    children: <Widget>[
                      settingsSection(s.secAccount),
                      _accountCard(context, s),
                      settingsSection(s.secScenario),
                      _scenarioChipsCard(s),
                      _packsCard(s),
                      _customTermsSection(context, s),
                      settingsSection(s.secData),
                      _dataCard(context, s),
                      settingsSection(s.secPreferences),
                      _preferencesCard(s),
                      settingsSection(s.secAbout),
                      // P-7 — the "about" card added "review onboarding guide",
                      // which needs to push a route
                      // ⇒ needs context (this card didn't need one before).
                      _aboutCard(context, s),
                      // UP-2 — its own section, deliberately not stuffed into
                      // the "about" card above:
                      // that card's `last:` divider ownership was already
                      // changed once by P-7
                      // (settings_preferences.dart:212-216 notes the cost in place).
                      settingsSection(s.secUpdate),
                      SettingsUpdateCard(controller: update, strings: s),
                    ],
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _appBar(BuildContext context, AppStrings s) => Container(
    key: const ValueKey<String>('settings.appBar'),
    height: 52,
    padding: const EdgeInsets.symmetric(horizontal: 6),
    decoration: BoxDecoration(
      border: Border(bottom: BorderSide(color: FlowMicColors.line)),
    ),
    child: Row(
      children: <Widget>[
        InkWell(
          key: const ValueKey<String>('settings.back'),
          onTap: () => Navigator.of(context).maybePop(),
          borderRadius: BorderRadius.circular(10),
          child: SizedBox(
            width: 40,
            height: 40,
            child: Center(
              child: Icon(
                Icons.arrow_back_ios_new,
                size: 16,
                color: FlowMicColors.t2,
              ),
            ),
          ),
        ),
        Expanded(
          child: Text(
            s.settingsTitle,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: FlowMicColors.t1,
              fontSize: 15,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
      ],
    ),
  );

  // ── ACCOUNT + CLOUD INSTANCE ─────────────────────────────────────────────
  Widget _accountCard(BuildContext context, AppStrings s) => settingsCard(
    child: Column(
      children: <Widget>[
        ValueListenableBuilder<bool>(
          valueListenable: session.paired,
          builder: (BuildContext context, bool paired, _) {
            return ValueListenableBuilder<String>(
              valueListenable: session.connectedDeviceName,
              builder: (BuildContext context, String name, _) {
                final String device = name.isNotEmpty ? name : 'DESKTOP';
                return settingsRow(
                  child: Row(
                    children: <Widget>[
                      settingsDot(paired ? FlowMicColors.green : const Color(0xFF4A4F63)),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text(
                              paired ? device : s.notConnected,
                              style: TextStyle(color: FlowMicColors.t1, fontSize: 13.5),
                            ),
                            if (paired) ...<Widget>[
                              const SizedBox(height: 2),
                              Text(s.connectedLan, style: kRowSub),
                            ],
                          ],
                        ),
                      ),
                      if (paired)
                        ghostButton(s.disconnect, onTap: () => session.transport.disconnect()),
                    ],
                  ),
                );
              },
            );
          },
        ),
        _cloudInstanceRow(context, s),
      ],
    ),
  );

  Widget _cloudInstanceRow(BuildContext context, AppStrings s) {
    final bool fixed = destination.isFixed;
    final bool loggedIn = login.isLoggedIn;
    // 🔴 Vertical stack, not [icon | copy | CTA] on one Row.
    // EN 「Enter Notes (Record only)」 + 「Sign in to use · no pairing · …」
    // side-by-side at 360dp left the subtitle ~50dp wide — one or two
    // letters per line. JA/KO strings are longer still. Copy gets the
    // full card width; the CTA sits on its own row and is allowed to wrap.
    // L3 is unchanged: this is still only a navigator, never a second logout.
    return settingsRow(
      last: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.only(top: 1),
                child: Icon(Icons.cloud_outlined, size: 20, color: FlowMicColors.brand),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: LayoutBuilder(
                  builder: (BuildContext context, BoxConstraints c) {
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Wrap(
                          spacing: 8,
                          runSpacing: 6,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: <Widget>[
                            Text(
                              s.cloudInstance,
                              style: TextStyle(
                                color: FlowMicColors.t1,
                                fontSize: 13.5,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            if (loggedIn) ...<Widget>[
                              ConstrainedBox(
                                constraints: BoxConstraints(maxWidth: c.maxWidth),
                                child: settingsPill(
                                  login.email ?? '',
                                  FlowMicColors.brand,
                                  FlowMicColors.brandSoft,
                                ),
                              ),
                              if (login.plan.isNotEmpty)
                                settingsPill(
                                  s.planLabel(login.plan),
                                  FlowMicColors.teal,
                                  FlowMicColors.tealSoft,
                                ),
                            ],
                          ],
                        ),
                        const SizedBox(height: 6),
                        Text(
                          fixed ? s.cloudFixedNote : s.cloudInstanceSub,
                          key: const ValueKey<String>('settings.notes.sub'),
                          style: kRowSub,
                        ),
                        if (!loggedIn &&
                            login.phase == LoginPhase.error &&
                            login.errorCode != null) ...<Widget>[
                          const SizedBox(height: 4),
                          Text(
                            s.loginError(login.errorCode),
                            style: TextStyle(color: FlowMicColors.amber, fontSize: 10.5),
                          ),
                        ],
                        if (!loggedIn && login.logoutNotice != null) ...<Widget>[
                          const SizedBox(height: 4),
                          Text(
                            s.logoutNotice(login.logoutNotice),
                            style: TextStyle(color: FlowMicColors.amber, fontSize: 10.5),
                          ),
                        ],
                      ],
                    );
                  },
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Align(
            alignment: Alignment.centerLeft,
            child: KeyedSubtree(
              key: const ValueKey<String>('settings.notes.cta'),
              child: ghostButton(
                fixed ? s.exitCloudInstance : s.enterCloudInstance,
                onTap: () {
                  destination.configureFixed(fixedRecordOnly: !fixed);
                  Navigator.of(context).maybePop();
                },
              ),
            ),
          ),
          if (!fixed) ...<Widget>[
            const SizedBox(height: 8),
            // 🔴 L3 (owner 2026-08-02): this is a navigator, not a second
            // login/logout. Pop returns to ConnectionsPage, which hosts the
            // one CloudSignOutRow. Copy must wrap — the EN sentence is long
            // enough to clip on 320dp if it stayed a single unwrapped line.
            GestureDetector(
              onTap: () => Navigator.of(context).maybePop(),
              child: Text(
                s.manageCloudOnDevices,
                key: const ValueKey<String>('settings.notes.manage'),
                style: TextStyle(
                  color: FlowMicColors.brand,
                  fontSize: 11.5,
                  fontWeight: FontWeight.w600,
                  height: 1.35,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  // ── SCENARIO CARD: profession/domain chips ───────────────────────────────
  Widget _scenarioChipsCard(AppStrings s) {
    final ScenarioCard card = scenario.card;
    return settingsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 2),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text('${s.profession} / ${s.domain}', style: kRowTitle),
                const SizedBox(height: 2),
                Text(s.scenarioHint, style: kRowSub),
                if (scenario.syncPending) ...<Widget>[
                  const SizedBox(height: 4),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Icon(Icons.cloud_off_outlined, size: 12, color: FlowMicColors.amber),
                      const SizedBox(width: 4),
                      Text(
                        s.syncPendingNote,
                        style: TextStyle(color: FlowMicColors.amber, fontSize: 10.5),
                      ),
                    ],
                  ),
                ]
                // GA-11: the card below is the SERVER's value, and it displaced
                // one the user had already seen — say so rather than swapping it
                // under them. Mutually exclusive with the pending note: pending
                // means the local edit won and nothing was displaced.
                else if (scenario.remoteRefreshed) ...<Widget>[
                  const SizedBox(height: 4),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Icon(Icons.sync, size: 12, color: FlowMicColors.teal),
                      const SizedBox(width: 4),
                      Text(
                        s.scenarioRemoteNote,
                        style: TextStyle(color: FlowMicColors.teal, fontSize: 10.5),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
          _chipGroup(
            title: s.profession,
            presets: kProfessionPresets,
            label: s.professionLabel,
            isOn: card.hasProfession,
            onToggle: scenario.toggleProfession,
          ),
          _chipGroup(
            title: s.domain,
            presets: kDomainPresets,
            label: s.domainLabel,
            isOn: card.hasDomain,
            onToggle: scenario.toggleDomain,
            last: true,
          ),
        ],
      ),
    );
  }

  Widget _chipGroup({
    required String title,
    required List<String> presets,
    required String Function(String) label,
    required bool Function(String) isOn,
    required void Function(String) onToggle,
    bool last = false,
  }) => Padding(
    padding: EdgeInsets.fromLTRB(14, 10, 14, last ? 14 : 6),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(title, style: TextStyle(color: FlowMicColors.t3, fontSize: 10.5, fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        Wrap(
          spacing: 7,
          runSpacing: 7,
          children: presets
              .map((String p) => settingsChip(
                    label(p),
                    on: isOn(p),
                    onTap: () => onToggle(p),
                  ))
              .toList(),
        ),
      ],
    ),
  );

  // ── SCENARIO CARD: word-pack checkboxes ──────────────────────────────────
  Widget _packsCard(AppStrings s) {
    final ScenarioCard card = scenario.card;
    const List<FlowMicDictionaryPack> packs = FlowMicDictionaryPacks.all;
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: settingsCard(
        child: Column(
          children: <Widget>[
            for (int i = 0; i < packs.length; i++)
              settingsCheckRow(
                title: s.packLabel(packs[i].id, packs[i].label),
                sub: packs[i].preview,
                checked: card.hasPack(packs[i].id),
                onTap: () => scenario.togglePack(packs[i].id),
                last: i == packs.length - 1,
              ),
          ],
        ),
      ),
    );
  }

  // ── DATA: export / import (window C, doc 16) ─────────────────────────────
  // The order is "export before import", matching owner's ruling order
  // (export is the safety net for an irreversible action, overview design
  // §3: 4 comes before 5). Both rows only act when pressed — this page
  // never walks the timeline during build.
  Widget _dataCard(BuildContext context, AppStrings s) => settingsCard(
    child: Column(
      children: <Widget>[
        settingsRow(
          child: Row(
            children: <Widget>[
              Icon(Icons.insights_outlined, size: 20, color: FlowMicColors.brand),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(s.statsTitle, style: kRowTitle),
                    const SizedBox(height: 3),
                    Text(s.statsSub, style: kRowSub),
                  ],
                ),
              ),
              ghostButton(
                s.statsOpen,
                onTap: () => showStatsClearSheet(
                  context,
                  inventory: inventory,
                  store: timeline,
                  strings: s,
                ),
              ),
            ],
          ),
        ),
        // 🔴 Export and import keep their CTA on its OWN row (the
        // _cloudInstanceRow shape above, for the same reason): both labels
        // are sentences ("Choose a location and export"), and as inflexible
        // Row children they squeezed the title+sub column to ~30-70px in
        // fr/ru/es/de at 360dp — fr overflowed a 320dp screen outright
        // (measured 2026-08-17; under Ahem these were the 99px/50px
        // overflows the WP3 handback registered). Inside an Align the
        // ghostButton's bare Text has a finite max-width, so an extreme
        // locale wraps instead of striping. The stats row above deliberately
        // KEEPS the inline shape: its label is a short verb in all nine
        // locales (worst ru ≈112px of the row's 302px), and stacking it
        // would spend a whole extra line on nothing. Pinned by the
        // zero-overflow assertion in spoken_language_test.dart ("0.2.53 law").
        settingsRow(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Icon(Icons.ios_share, size: 20, color: FlowMicColors.brand),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(s.exportTitle, style: kRowTitle),
                        const SizedBox(height: 3),
                        Text(s.exportSub, style: kRowSub),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Align(
                alignment: Alignment.centerLeft,
                child: ghostButton(
                  s.exportAction,
                  onTap: portable.busy
                      ? null
                      : () => showExportSheet(
                          context,
                          controller: portable,
                          strings: s,
                        ),
                ),
              ),
            ],
          ),
        ),
        // Same stacked shape as the export row above, same measurements.
        settingsRow(
          last: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Icon(Icons.file_download_outlined, size: 20, color: FlowMicColors.brand),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(s.importTitle, style: kRowTitle),
                        const SizedBox(height: 3),
                        Text(s.importSub, style: kRowSub),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Align(
                alignment: Alignment.centerLeft,
                child: ghostButton(
                  portable.busy ? s.importRunning : s.importAction,
                  onTap: portable.busy ? null : () => _runImport(context, s),
                ),
              ),
            ],
          ),
        ),
      ],
    ),
  );

  /// 🔴 Doc 16 §5.2: the report is SHOWN, always — including the partial and the
  /// refused cases. There is no branch here that ends without saying something,
  /// because "import complete" over swallowed rows is the red line this
  /// whole feature
  /// is written around.
  Future<void> _runImport(BuildContext context, AppStrings s) async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final ImportReport report = await portable.import();
    messenger.showSnackBar(
      SnackBar(
        content: Text(importReportSentence(report, s)),
        duration: const Duration(seconds: 6),
      ),
    );
  }
}
