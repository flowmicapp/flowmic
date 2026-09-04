// Part of settings_page.dart — the phone-owned recognition preferences (AI
// polish, two-pass refine, the scenario-inference consent) and the settings
// backup rows.
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// Same shape and same reason as settings_custom_terms.dart / settings_preferences.dart:
// settings_page.dart was at 710/800 (`verify/lint/file-size.mjs` SRC_MAX=800)
// when owner 2026-09-03 moved these switches from the PC to the phone
// (docs/decisions/2026-09-03-owner-web-rulings-phone-owned-settings.md Q2/Q3
// and the backup of Q6/Q8). Dart has no partial classes, so the fields
// (`prefs`, `backup`, `scenario`) stay on the class and only BEHAVIOUR lives
// here. Nothing was MOVED into this file — every member below is new, which is
// why there is no diff-discipline block: there is no 「moved over」 half to
// separate from the 「newly written」 half.
//
// ── WHAT EACH ROW IS ─────────────────────────────────────────────────────
// · AI polish — the switch plus a strict/smooth choice. Two `settingsChip`s,
//   the theme row's shape, because it IS a two-way choice and not a slider.
//   The choice row is only built while polish is on: a strength for a layer
//   that is not running would be a control that changes nothing.
// · Two-pass refine — a switch. The utterance floor is the server's.
// · Scenario inference — a switch whose sentence is the consent itself
//   (design D8): the phone cannot show the PC's model endpoint, so the copy
//   asks for the widest thing and says so plainly.
// Every one applies-and-persists on the tap (red line). 🔴 NONE of them
// talks to a server: owner ruled 2026-09-03 that these preferences ride the
// transcription request itself, so `settings/phone_prefs_payload.dart` reads
// them at the next `audio:start` / `compose:start` and there is nothing to
// sync. The 「saved locally · pending sync」 note that used to sit at the top of
// this card went with the push — a note about an edit waiting to reach the
// server is a promise about a mechanism that no longer exists.
//
// ── THE BACKUP ROWS ──────────────────────────────────────────────────────
// Two rows appended to the data card, in the same stacked shape as the record
// export/import rows above them (title + sub, CTA on its own line — the
// 2026-08-17 overflow measurement in settings_page.dart `_dataCard` applies to
// these sentences too). The restore row takes `last: true` from the record
// import row: `settingsRow.last` decides whether a divider is painted, and
// leaving it on the import row would draw a stray line inside the card.

part of 'settings_page.dart';

extension SettingsPageGeneralPrefs on SettingsPage {
  // ── RECOGNITION AND AI ──────────────────────────────────────────────────
  Widget _generalPrefsCard(AppStrings s) => settingsCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        settingsSwitchRow(
          title: s.polishTitle,
          sub: s.polishSub,
          value: prefs.polishEnabled,
          onChanged: prefs.setPolishEnabled,
          switchKey: const ValueKey<String>('settings.polish.switch'),
        ),
        if (prefs.polishEnabled)
          settingsRow(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                // Wrap, not a bare Row: the title is a sentence fragment in
                // de/ru and the two chips must be allowed to drop under it on
                // a 320dp screen rather than squeeze it (the spoken-language
                // row's precedent).
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: <Widget>[
                    Text(s.polishStrengthTitle, style: kRowTitle),
                    settingsChip(
                      s.polishStrict,
                      on: prefs.polishStrength == PolishStrength.strict,
                      onTap: () => prefs.setPolishStrength(PolishStrength.strict),
                    ),
                    settingsChip(
                      s.polishSmooth,
                      on: prefs.polishStrength == PolishStrength.smooth,
                      onTap: () => prefs.setPolishStrength(PolishStrength.smooth),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  s.polishStrengthNote,
                  style: TextStyle(color: FlowMicColors.t3, fontSize: 11, height: 1.4),
                ),
              ],
            ),
          ),
        settingsSwitchRow(
          title: s.refineTitle,
          sub: s.refineSub,
          value: prefs.refineEnabled,
          onChanged: prefs.setRefineEnabled,
          switchKey: const ValueKey<String>('settings.refine.switch'),
        ),
        settingsSwitchRow(
          title: s.inferenceTitle,
          sub: s.inferenceSub,
          value: prefs.inferenceGranted,
          onChanged: prefs.setInferenceGranted,
          switchKey: const ValueKey<String>('settings.inference.switch'),
          last: true,
        ),
      ],
    ),
  );

  // ── DATA: settings backup / restore (owner Q6 note, Q8 a) ───────────────
  List<Widget> _settingsBackupRows(BuildContext context, AppStrings s) => <Widget>[
    _backupRow(
      icon: Icons.tune,
      title: s.settingsBackupTitle,
      sub: s.settingsBackupSub,
      action: s.settingsBackupAction,
      actionKey: 'settings.backup.export',
      onTap: () => _runSettingsBackup(context, s),
    ),
    _backupRow(
      icon: Icons.settings_backup_restore,
      title: s.settingsRestoreTitle,
      sub: s.settingsRestoreSub,
      action: s.settingsRestoreAction,
      actionKey: 'settings.backup.import',
      onTap: () => _runSettingsRestore(context, s),
      last: true,
    ),
  ];

  Widget _backupRow({
    required IconData icon,
    required String title,
    required String sub,
    required String action,
    required String actionKey,
    required VoidCallback onTap,
    bool last = false,
  }) => settingsRow(
    last: last,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Icon(icon, size: 20, color: FlowMicColors.brand),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(title, style: kRowTitle),
                  const SizedBox(height: 3),
                  Text(sub, style: kRowSub),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Align(
          alignment: Alignment.centerLeft,
          child: KeyedSubtree(
            key: ValueKey<String>(actionKey),
            child: ghostButton(action, onTap: onTap),
          ),
        ),
      ],
    ),
  );

  /// The report is SHOWN, always — a cancel says cancelled, a failure says
  /// what failed, and a success says WHERE the file is (Book 16 §7-3).
  Future<void> _runSettingsBackup(BuildContext context, AppStrings s) async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final SettingsBackupOutcome outcome = await backup.export();
    messenger.showSnackBar(
      SnackBar(
        content: Text(settingsBackupOutcomeText(outcome, s)),
        duration: const Duration(seconds: 6),
      ),
    );
  }

  Future<void> _runSettingsRestore(BuildContext context, AppStrings s) async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final SettingsRestoreOutcome outcome = await backup.import();
    messenger.showSnackBar(
      SnackBar(
        content: Text(settingsRestoreOutcomeText(outcome, s)),
        duration: const Duration(seconds: 6),
      ),
    );
  }
}

/// The sentence for a backup outcome. Top-level so the wording is testable
/// without pumping the page, and so 「cancelled」 provably never reads as a
/// failure (export_sheet.dart's `exportOutcomeText` precedent).
String settingsBackupOutcomeText(SettingsBackupOutcome o, AppStrings s) {
  if (o.ok) return s.settingsBackupDone(o.landing!.displayPath);
  if (o.cancelled) return s.settingsBackupCancelled;
  return s.settingsBackupFailed(o.detail ?? '');
}

/// Same, for a restore.
String settingsRestoreOutcomeText(SettingsRestoreOutcome o, AppStrings s) {
  if (o.cancelled) return s.settingsRestoreCancelled;
  final SettingsRestoreRefusal? refusal = o.refusal;
  if (refusal != null) return s.settingsRestoreRefused(refusal, o.otherEnd);
  if (o.detail != null) return s.settingsRestoreFailed(o.detail!);
  return s.settingsRestoreDone(o.keysWritten);
}
