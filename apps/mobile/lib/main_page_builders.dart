// Part of main.dart — the three page builders of `_FlowMicAppState`.
//
// ── WHY THIS SPLIT ──────────────────────────────────────────────────────────
// main.dart sat EXACTLY at the 800-line cap (`verify/lint/file-size.mjs`
// SRC_MAX=800), which is this repo's standing note that the next card touching
// the file owes it a split — the same account bootstrap.ts was left holding at
// 798/800. Card SC-5 adds two lines to `main()` (the build-stamp diagnostics
// line), so it is that card.
//
// This family was chosen for the reason the ptt_session parts were: it is
// coherent and fully self-contained — three builders that take nothing, return
// a page, and are referenced only from `build` and from one another. Nothing
// outside this library names any of them.
//
// 🔴 DIFF DISCIPLINE: all three bodies are moved **character-for-character**,
// with the one mechanical edit this kind of split always makes — they become
// extension members, so every existing call site and tear-off
// (`_buildSettings()`, `chatPageBuilder: _buildChat`, …) is untouched.
// **Any other difference in the diff is a bug.**

part of 'main.dart';

extension _PageBuilders on _FlowMicAppState {
  SettingsPage _buildSettings() => SettingsPage(
    scenario: _settingsRoot.scenario,
    prefs: _settingsRoot.prefs,
    backup: _settingsRoot.backup,
    appSettings: widget.appSettings,
    login: _login,
    destination: _destination,
    session: _session,
    portable: _portable,
    // The SAME inventory instance as _portable: statistics, export, and clear
    // read the same single traversal (unified design §1).
    inventory: _inventory,
    timeline: _store,
    // Card U9 — the SAME real port PortableExporter uses to write export
    // metadata (`version: const PackageAppVersion()` below): the About section
    // reads the SAME version number this phone has installed, not a separate
    // read path.
    version: const PackageAppVersion(),
    update: _update,
    cloudSummary: _cloudSummary,
  );

  /// Chat page + live alias label. Listens to [_connections] so a rename
  /// (setAlias → load → notify) refreshes the header without writing the
  /// alias into [PttSession.connectedDeviceName].
  Widget _buildChat() => ListenableBuilder(
    // UP-2 — the gear badge is `_update`'s state, so it must be in this merge:
    // on `_connections` alone **nothing rebuilds this tree** when a check comes
    // back, and the badge would appear only by coincidence on the next
    // connection-state change (anti-façade: wired up but never triggered).
    listenable: Listenable.merge(<Listenable>[_connections, _update]),
    builder: (BuildContext context, _) => ChatFlowPage(
      controller: _controller,
      appSettings: widget.appSettings,
      // Card F10: the SAME persistence [_store] was built on (line above), so the
      // chat list's owner-scoped pages and the store's global page read one
      // table. Without this argument the page falls back to filtering the
      // store's in-memory page — the pre-F10 defect where a PC you spoke to
      // yesterday showed an empty conversation.
      historySource: widget.storage.persistence,
      deviceNameOverride: _connections.activePairingDisplayName,
      isCloudInstance: _connections.activePairingIsCloudInstance,
      // 🔴 Card CR-9 — the continuous entry's numbers, and whether it appears.
      cloudSummary: _cloudSummary,
      onOpenSettings: () => Navigator.of(
        _navKey.currentContext!,
      ).push<void>(MaterialPageRoute<void>(builder: (_) => _buildSettings())),
      // REQ-12-02 (owner 2026-08-12) — the transcription page's one-tap clear.
      //
      // 🔴 SAME sheet, SAME inventory instance, SAME store as Settings → Data →
      // Statistics & Clear (`_buildSettings` above hands these three to SettingsPage).
      // 「statistics says N rows / export produces N rows / clear zeroes it out」
      // are structurally incapable of disagreeing, purely because they
      // traverse the same single traversal — coming in through the second entry
      // point must still be that same traversal, otherwise this guarantee
      // silently fails on the new entry point. ⇒ this line must NOT
      // "conveniently" construct a new inventory.
      onClearHistory: () => showStatsClearSheet(
        _navKey.currentContext!,
        inventory: _inventory,
        store: _store,
        strings: AppStrings.of(widget.appSettings.locale),
      ),
      // Design §5.1 「the notice surface」: a badge that does not steal focus,
      // pointing at that section of the settings page.
      // The one source of truth, read in both places — this does not
      // separately judge 「does this count as an update」 again.
      hasUpdate: _update.hasUpdate,
      // Back = return to the instance list; disconnect so the list is a clean
      // resting state (08 §1 Option B: no auto-connect; re-enter by tapping again).
      onBack: () => _session.transport.disconnect(),
      // REQ-12-09 09-B — the account state and sign-in entry point for the 「+」
      // panel's lightweight-record tab.
      //
      // 🔴 Passing a getter, not a bool: the user can sign in **inside the
      // panel**, and freezing a value from the moment the panel opened
      // would tell them 「you are signed out」 right after they finished signing
      // in. The one source of truth is `_login` — this just asks it.
      isSignedIn: () => _login.isLoggedIn,
      // The **SAME** sheet the instance list uses to enter the cloud
      // (`showLoginSheet` in connections_page.dart) — sign-in has exactly one
      // entry-point implementation in this App; the panel does not get a
      // second one built for it.
      onSignIn: () async {
        await showLoginSheet(
          _navKey.currentContext!,
          controller: _login,
          strings: AppStrings.of(widget.appSettings.locale),
        );
      },
    ),
  );

  /// V2-06b (requirement ④): All History — the whole local table across every instance,
  /// entered from the home header's history icon. The same [_store] the chat
  /// pages write to; the page narrows nothing.
  Widget _buildHistory() => HistoryPage(
    store: _store,
    // V2-06a-2: the footnote reports the store that actually opened.
    storageKind: widget.storage.kind,
    appSettings: widget.appSettings,
  );
}
