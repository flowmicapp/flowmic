// FlowMic mobile entrypoint.
//
// WP-R3-3 grows the composition root to own the settings surface: the scenario-
// card controller (writes settings:update{scenario.card}), the app-settings
// controller (the explicit locale + theme — instant-apply, instant-persist
// device-local prefs), the
// login controller (mobile:login, fail-loud) and the settings client.
// The gear on the chat header pushes the settings screen. The theme is the
// user's tri-state choice (default follow-system; V2-07.4 wired the real selector —
// an earlier dark-only façade selector had been removed), resolved through
// FlowMicTheme. UI never follows OS locale — AppStrings is driven purely by
// the explicit AppSettingsController.locale.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'src/audio/retained_audio_dir.dart';
import 'src/audio/retained_audio_spill.dart';
import 'src/audio/retained_audio_store.dart';
import 'src/auth/account_store.dart';
import 'src/auth/login_controller.dart';
import 'src/auth/saas_endpoint.dart';
import 'src/auth/token_storage.dart';
import 'src/diag/diag_log.dart';
import 'src/crypto/blind_store_keyring.dart';
import 'src/destination/destination_controller.dart';
import 'src/ptt/ptt_session.dart';
import 'src/settings/app_settings.dart';
import 'src/session/usage_counters.dart';
import 'package:sqflite/sqflite.dart' show databaseFactory, getDatabasesPath;

import 'src/portable/asset_inventory.dart';
// REQ-12-02: the ONE clear surface, reached from a second entry point.
import 'src/portable/stats_clear_sheet.dart';
import 'src/settings/app_strings.dart';
import 'src/portable/platform_portable.dart';
import 'src/portable/portable_controller.dart';
import 'src/portable/portable_export.dart';
import 'src/portable/portable_import.dart';
import 'src/portable/timeline_import_sink.dart';
import 'src/portable/unknown_field_vault.dart';
import 'src/settings/local_prefs.dart';
import 'src/update/update_controller.dart';
import 'src/update/update_prefs.dart';
import 'src/settings/scenario_card_controller.dart';
import 'src/settings/settings_client.dart';
import 'src/session/chat_controller.dart';
import 'src/session/outbox_blob_store.dart';
import 'src/session/instance_machine_map.dart';
import 'src/session/outbox_store.dart';
import 'src/session/connections_controller.dart';
import 'src/session/instance_probe.dart' show ServerChannel;
import 'src/timeline/cloud/blind_store_cloud_client.dart';
import 'src/timeline/cloud/blind_store_cloud_leg.dart';
import 'src/timeline/cloud/blind_store_cloud_state.dart';
import 'src/timeline/cloud/blind_store_cloud_sync.dart';
import 'src/timeline/cloud/blind_store_key_provisioner.dart';
import 'src/timeline/cloud/blind_store_keymeta_client.dart';
import 'src/timeline/cloud/blind_store_secure_key_store.dart';
import 'src/timeline/cloud/blind_store_timeline_bridge.dart';
import 'src/timeline/timeline_reaper.dart';
import 'src/timeline/timeline_sqlite.dart';
import 'src/timeline/timeline_store.dart';
import 'src/timeline/timeline_sync.dart';
import 'src/ui/app_lifecycle_bridge.dart';
import 'src/ui/chat_flow_page.dart';
import 'src/ui/connections_page.dart';
import 'src/ui/first_run_locale_page.dart';
import 'src/ui/history_page.dart';
import 'src/ui/login_sheet.dart' show showLoginSheet;
import 'src/ui/onboarding/first_run_onboarding_page.dart';
import 'src/ui/settings_page.dart';
import 'src/session/platform_device_info.dart';
import 'src/ui/text_scale_scope.dart';
import 'src/ui/tokens.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  // V2-05 / R-UX-09: install the local usage counters before the first frame,
  // so no tap between boot and the first page goes uncounted. Local only —
  // this never leaves the phone (see usage_counters.dart).
  installUsageCounters(UsageCounters(prefs));
  // Still constructed here (not by AppSettingsController — A1c removed its
  // LocalPrefs dependency along with the toggle that was its only use of one):
  // FlowMicApp threads this SAME instance to ChatController etc. below.
  final LocalPrefs localPrefs = SharedPrefsLocalPrefs(prefs);
  final AppSettingsController appSettings = AppSettingsController(prefs: prefs);
  // Hydrate device-local prefs before the first frame so the default mode +
  // language are correct from frame one (no OS-locale flash).
  //
  // 🔴 U1 — THIS CALL'S POSITION IS PART OF A MECHANISM, not just an ordering
  // habit. load() also resolves「does this install still owe the user the
  // first-run language question?」, and its signal for「brand-new install」is
  // 「no flowmic.* pref exists yet」. That is only true BEFORE this boot writes
  // any of its own — and openTimelinePersistence below stamps
  // `flowmic.timeline.migrated.sqlite.v1` on the first boot of EVERY install,
  // a fresh one included. Move this line under that one and every install
  // reads as an upgrade ⇒ the picker never fires. See
  // AppSettingsController._resolveFirstRunPrompt.
  await appSettings.load();
  // V2-07.4: follow-system is LIVE, not a boot-time snapshot — resolve once now
  // (load() already pushed the hydrated choice into FlowMicTheme) and arm the
  // observer that re-resolves on every later OS light/dark flip.
  FlowMicTheme.init();
  // owner 2026-07-27 phone naming: resolve 「model-<4-digit device fingerprint>」
  // once, here, so the
  // pairing path can read it synchronously. Awaited because it is one cheap
  // platform read and the alternative — resolving it inside pairing — would put
  // a round-trip in front of the user's pairing tap for a purely cosmetic string.
  await deviceLabel();
  // V2-06a-2: open the timeline store (and run the one-time shared_prefs import)
  // BEFORE the first frame. Awaited here rather than inside initState because
  // the result decides which store the app is on, and a page that renders the
  // history footnote before that is known would have to guess — see
  // TimelineStorageOpen for what a failure does (it never yields an empty page).
  // Resolved once: both the timeline database and the queue's picture blobs
  // live under it (see FlowMicApp.outboxBlobDir).
  final String dbDir = await getDatabasesPath();
  final TimelineStorageOpen storage = await openTimelinePersistence(
    prefs: prefs,
    factory: databaseFactory,
    // Plain join: the only production host is Android, whose databases path is
    // POSIX. Pulling in `package:path` for one separator would add a direct
    // dependency to save nothing.
    path: '$dbDir/$kTimelineDbFile',
  );
  // 🔴 Card F2 phase 2 — THE SEED RUNS HERE, AFTER open() RETURNED, IN ITS OWN TRY.
  //
  // Not inside openTimelinePersistence. That function's catch is deliberately
  // broad (every open failure has the same right answer: keep the history
  // readable on the 100-row store and say so), so a seed failure folded into it
  // would demote the user's ENTIRE history to fix nothing — 「downgrading the
  // user's entire history to the 100-row cap for the sake of a merge」, which
  // is worse by an order of magnitude than not
  // merging. Design §3.2 makes the position a structural requirement, and
  // timeline_migration_test.dart 「Card F2 §3.2 — a seed failure must not fold
  // the entire database into the fallback」
  // pins it.
  //
  // `machineMap` is null on the shared_preferences fallback and the seed
  // no-ops — installing nothing leaves the reader on the pairing list, i.e.
  // phase 1's behavior, which is honest and complete for every pairing still stored.
  installInstanceMachineMap(storage.machineMap);
  await seedInstanceMachineMap(
    map: storage.machineMap,
    storage: SecureTokenStorage(),
  );
  // SEG-2 (design 2026-08-11 §2-R3) — THE PRODUCTION CONSTRUCTION OF THE
  // RETAINED-AUDIO LAYER. The layer shipped complete (N1-B3) and constructed
  // by nothing: Book 15 §2.0-b's correction block measured this exact absence,
  // so production wrote zero bytes while every retention test was green.
  // Opened here — the directory comes from path_provider, which is async, and
  // PttSession's construction (initState) is not — and handed down as the
  // DEFAULT capture's spill.
  //
  // ⚠️ Failure direction: an open failure must not take the app down over its
  // own safety net. null degrades to the pre-SEG-2 product (no retention),
  // LOUDLY — and ptt_link_loss.dart then refuses to claim retention in the
  // user-facing notice, so the degradation never becomes an unbacked promise.
  RetainedAudioSpill? retainedAudio;
  try {
    final RetainedAudioStore retainedStore = await openRetainedAudioStore();
    // Retention events must be heard (store contract: 「no silent failures」 runs in
    // both directions). The diagnostics log is the minimum surface the store's
    // own doc names; listener attached BEFORE the sweep so expiry notices from
    // a previous run's orphans are not announced into the void.
    retainedStore.notices.listen(
      (RetainedAudioNotice n) =>
          diag('audio.retained.notice', <String, Object?>{
        'code': n.code,
        'segment': n.segmentIdx,
        'bytes': n.bytes,
      }),
    );
    // The orphan backstop retained_audio_dir.dart asks every opener to run:
    // audio no session can ever claim again ages out, announced on the way.
    unawaited(retainedStore.sweep());
    retainedAudio = RetainedAudioSpill(store: retainedStore);
  } on Object catch (e) {
    debugPrint('[flowmic.audio] retained-audio store failed to open: $e — '
        'link-loss retention is DISABLED for this run');
  }
  runApp(
    FlowMicApp(
      prefs: prefs,
      localPrefs: localPrefs,
      appSettings: appSettings,
      storage: storage,
      retainedAudio: retainedAudio,
      outboxBlobDir: '$dbDir/$kOutboxBlobDirName',
      portableWorkDir: dbDir,
    ),
  );
}

class FlowMicApp extends StatefulWidget {
  const FlowMicApp({
    super.key,
    required this.prefs,
    required this.localPrefs,
    required this.appSettings,
    required this.storage,
    required this.retainedAudio,
    required this.outboxBlobDir,
    required this.portableWorkDir,
  });

  final SharedPreferences prefs;
  final LocalPrefs localPrefs;
  final AppSettingsController appSettings;

  /// SEG-2 — the retained-audio layer, opened in main() (async directory).
  /// Null exactly when the store failed to open at boot: the capture then has
  /// no spill and the link-loss notice states no retention (the honest half).
  final RetainedAudioSpill? retainedAudio;

  /// V2-06a-2: which store the timeline is actually on, plus why if it is not
  /// the one we wanted. Carried down so the 「All History」footnote states the truth
  /// instead of a compiled-in assumption.
  final TimelineStorageOpen storage;

  /// Window B3-2a: where a QUEUED picture's compressed bytes wait on disk.
  ///
  /// Resolved from sqflite's `getDatabasesPath()` — the same app-private area
  /// the timeline database already lives in, so the queue adds no dependency
  /// and no permission. Compressed bytes only; the camera original is never
  /// written (「the original image's pixels never touch disk」 is untouched).
  final String outboxBlobDir;

  /// Window C: where an export's scratch archive is assembled before the user picks
  /// a destination for it.
  ///
  /// The app-private databases directory — deliberately NOT a shared/external
  /// location: Book 16 §7-2 forbids the file landing anywhere that gets synced
  /// automatically, and a half-built archive sitting in Downloads would be
  /// exactly that with no user consent at all.
  final String portableWorkDir;

  @override
  State<FlowMicApp> createState() => _FlowMicAppState();
}

class _FlowMicAppState extends State<FlowMicApp> {
  late final PttSession _session;
  late final TimelineStore _store;
  late final DestinationController _destination;
  late final TimelineSyncGate _syncGate;
  late final SettingsClient _settingsClient;
  late final ScenarioCardController _scenario;
  late final LoginController _login;
  late final ChatController _controller;
  late final ConnectionsController _connections;
  late final PortableController _portable;
  late final AssetInventory _inventory;
  late final UpdateController _update;

  /// Card E-CL — the blind-store cloud leg. null ⇔ SQLite failed to open (see the
  /// block in initState).
  BlindStoreCloudLeg? _blindStore;

  @override
  void initState() {
    super.initState();
    // Persist pairings (MobileSession list, incl. token) via the R3-1 secure
    // token storage so the instance list survives relaunch (Android Keystore).
    // onAuthExpired routes the SaaS-JWT watchdog to the login controller so an
    // expired bearer clears the stored JWT + drives back to login (fail-loud).
    _session = PttSession(
      tokenStorage: SecureTokenStorage(),
      // SEG-2 — the retained-audio layer for the default (real-recorder)
      // capture; opened in main(), see the field's doc.
      spill: widget.retainedAudio,
      onAuthExpired: () => _login.handleAuthExpired(),
    );
    // Window C2 —— these three things must be built BEFORE TimelineStore, because
    // **a row's bytes belong to the row**
    // (RV-93), and deleting a row must delete everything it owns (Book 16 §6.2-2).
    //   · `portableImages` and the export / open-full-image flow use the
    //     **SAME directory**, so 「where is this row's picture」 has exactly one
    //     answer;
    //   · `vault` is a debt Window C put on the books (Book 16 §9b-4 「a vault
    //     entry is left behind when the row it belongs to is deleted」)
    //     — this round's deleter is the one who pays it off;
    //   · the cutoff lands in prefs, so 「what range got cleared」 is still
    //     answerable after a restart.
    final OutboxBlobStore portableImages = FileOutboxBlobStore(
      widget.outboxBlobDir,
    );
    final UnknownFieldVault vault = SharedPrefsUnknownFieldVault(widget.prefs);
    _store = TimelineStore(
      // V2-06a-2: whatever openTimelinePersistence actually managed to open —
      // SQLite normally, the old capped blob when it could not. Never a store
      // chosen here, because this line cannot know which one survived.
      persistence: widget.storage.persistence,
      // 🔴 THE ONE DELETER. Without this argument the store would not compile —
      // deliberately, see TimelineStore's ctor: G-21 happened precisely because a
      // deletion path could exist without knowing about the bytes, and a lost
      // constructor parameter leaves no new symbol to grep (Book 13 §7 F1 ①).
      reaper: TimelineReaper(
        persistence: widget.storage.persistence,
        images: portableImages,
        vault: vault,
        cutoffs: SharedPrefsCutoffStore(widget.prefs),
        // Card E-CL — ④ the cloud copy. **Without this argument, 「the phone
        // deleted it, so the cloud deletes it too」 does not exist**:
        // the row would vanish as usual while the cloud copy stays forever, and
        // **nothing anywhere remembers that it is still there**
        // (the owner's ruling wants 「space freed」). null ⇔ SQLite failed to
        // open — with nowhere to record the debt in that state,
        // running it is worse than not running it; see TimelineStorageOpen.cloudState.
        cloudDeleter: widget.storage.cloudState,
      ),
      // V2-06a-1: the REAL owner probe. Without this line the store keeps its
      // `_NoOwner` default and every row is born ownerless — the store would
      // still compile, still pass its unit tests, and quietly record nothing,
      // which is the exact shape of the defect that left the microphone
      // unopened for a whole rewrite (Book 13 §7 F1).
      owner: _SessionInstanceOwner(_session),
    );
    _destination = DestinationController();
    // 0.2.27: two constructor arguments left with the history uplink (owner's
    // architecture ruling, docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md).
    // `localPrefs` fed the §4.0 C noted-sync gate and `onCreateLanded` stamped
    // `markSynced` off the server's create ack; neither has a subject now. The
    // gate's remaining jobs are the delivery link probe and the http image
    // ingress's item shape.
    _syncGate = TimelineSyncGate(transport: _session.transport);
    _settingsClient = SettingsClient(transport: _session.transport);
    _scenario = ScenarioCardController(
      settingsClient: _settingsClient,
      cache: SharedPrefsScenarioCardCache(widget.prefs),
    );
    // Persist the SaaS JWT + public user (never the password) across launches so
    // the account area shows email/plan on boot (hydrate below).
    _login = LoginController(
      transport: _session.transport,
      accountStore: SecureAccountStore(),
    );
    _controller = ChatController(
      session: _session,
      store: _store,
      destination: _destination,
      syncGate: _syncGate,
      localPrefs: widget.localPrefs,
      // The source of the speaking language (audio:start.source_lang). It is the
      // **SAME instance** the settings page reads, so 「what was chosen in
      // settings」 and 「what the next utterance sends on the wire」 cannot disagree.
      appSettings: widget.appSettings,
      // Window B3-2a — the delivery queue's disk.
      //
      // ⚠️ THE FALLBACK IS EXPLICIT AND IS A REAL DEGRADATION. When SQLite could
      // not be opened, `storage.outbox` is null and undelivered messages live
      // only in RAM — they do NOT survive a relaunch, which is most of what this
      // queue is for. It is written HERE, in the open, rather than defaulted
      // inside the queue, so the degradation is a visible decision at the
      // composition root; `storage.failure` already carries the reason to the
      // All History footnote. The alternative (a friendly default deeper down) is
      // exactly the shape Book 13 §7 F1 ② bans.
      outboxStore: widget.storage.outbox ?? InMemoryOutboxStore(),
      outboxBlobs: FileOutboxBlobStore(widget.outboxBlobDir),
    );
    // Window C export / import (Book 16). Everything here is explicit at the composition
    // root, which is the only place that knows all the pieces:
    //   · the picture store is the SAME FileOutboxBlobStore instance shape the
    //     chat controller uses (same directory), so 「where is this row's
    //     picture」 has one
    //     answer for the export and for opening the full-size image;
    //   · the import sink writes through `storage.persistence` — the SAME
    //     instance TimelineStore holds — which is what keeps the two writers
    //     ordered (see timeline_import_sink.dart's header);
    //   · `workDir` is the app-private databases path, so the scratch archive is
    //     never built anywhere a backup agent would pick it up.
    // `portableImages` / `vault` are the SAME instances the reaper above holds —
    // one picture directory, one vault, so export, statistics and clear cannot
    // disagree about what exists (unified design §1).
    _inventory = TimelineAssetInventory(
      rows: TimelineStoreRows(_store),
      images: portableImages,
    );
    final AssetInventory inventory = _inventory;
    _portable = PortableController(
      inventory: inventory,
      exporter: PortableExporter(
        inventory: inventory,
        images: portableImages,
        destination: const SafExportDestination(),
        version: const PackageAppVersion(),
        vault: vault,
        workDir: widget.portableWorkDir,
        // Already warmed in main() before the first frame; null simply omits
        // `source.device` rather than inventing a name.
        deviceName: cachedDeviceLabel(),
      ),
      importer: PortableImporter(
        source: const SafImportSource(),
        sink: TimelineImportSink(
          persistence: widget.storage.persistence,
          store: _store,
        ),
        images: portableImages,
        vault: vault,
        workDir: widget.portableWorkDir,
      ),
    );
    _connections = ConnectionsController(
      session: _session,
      login: _login,
      // GA-11: a first pairing gets its identity mid-connection, after the
      // connected edge that normally pulls the settings snapshot.
      onPaired: () => unawaited(_settingsClient.hydrate()),
    );
    // UP-2 in-app update. 🔴 `version:` and the 「About」 section, the export
    // metadata, are the **SAME** port
    // implementation (`_buildSettings`'s `PackageAppVersion` below) — 「what
    // version am I」 has only one answer in this
    // App, otherwise 「the version shown」 and 「the version compared against」 could
    // each tell a different story.
    _update = UpdateController(
      version: const PackageAppVersion(),
      prefs: SharedPrefsUpdatePrefs(widget.prefs),
    );
    // Card E-CL — the blind-store cloud leg. When `storage.cloudState` is null
    // (SQLite failed to open), the whole leg
    // is **NOT built**: running it with nowhere to record the debt would turn
    // 「deleted from the cloud」 into a promise nobody keeps.
    //
    // 🔴 `isCloudRelay` here is **the no-crosstalk red line's shape on the
    // blind store**, not an optimization: `timeline:push`
    // is authenticated server-side by the **pairing token** (auth/middleware.ts
    // reads user_id from `mobile_pairings`),
    // so a push over a LAN standalone link **would be accepted** and written into
    // that machine's `timeline_blobs`. The judgement must be MEASURED — `serverChannel`
    // reads from the server's own `/api/health.mode`, and null (「could not tell」)
    // is always treated as 「not cloud」.
    final SqfliteBlindStoreCloudStateStore? cloudState =
        widget.storage.cloudState;
    if (cloudState != null) {
      final BlindStoreKeyring keyring = BlindStoreKeyring(
        store: const SecureBlindStoreKeyStore(),
      );
      // SALT-2 — the keymeta provisioner (design 2026-08-11 §3.2). The single
      // enrolment entry E-B2 will call, AND the confirmation authority the
      // push gate below asks (keymetaConfirmed → ensureConfirmed()). The
      // credential is the account JWT — the login layer's one copy — and the
      // endpoint is the SaaS host that ISSUED that JWT, deliberately not the
      // pairing endpoint: keymeta is account data and lives where the account
      // lives, regardless of which server the session socket currently dials.
      final BlindStoreKeyProvisioner keymetaProvisioner =
          BlindStoreKeyProvisioner(
            keyring: keyring,
            client: HttpBlindStoreKeymetaClient(
              endpoint: resolveSaasEndpoint(),
              bearer: () => _login.jwt,
            ),
            accountKey: () => _login.email,
          );
      _blindStore = BlindStoreCloudLeg(
        keyring: keyring,
        provisioner: keymetaProvisioner,
        roomJoins: _session.roomJoins,
        sync: BlindStoreCloudSync(
          keyring: keyring,
          client: BlindStoreCloudClient(transport: _session.transport),
          state: cloudState,
          bridge: BlindStoreTimelineBridge(
            persistence: widget.storage.persistence,
            // The **SAME** reaper semantics TimelineStore holds (the same
            // persistence / picture directory / vault), so 「what deleting a
            // row deletes」 has one answer.
            reaper: TimelineReaper(
              persistence: widget.storage.persistence,
              images: portableImages,
              vault: vault,
              cutoffs: SharedPrefsCutoffStore(widget.prefs),
              // ⚠️ Deliberately **NOT** given a cloudDeleter: this reaper only serves
              // the 「the cloud says it's gone」
              // path — queuing another delete request would bounce the deletion
              // back and forth between the two devices.
            ),
            reload: _store.load,
          ),
          cursor: SharedPrefsBlindStoreCursorStore(widget.prefs),
          isCloudRelay: () =>
              _session.serverChannel.value == ServerChannel.cloudRelay,
          // Account key: the cursor is a position on **one particular account's**
          // server-side seq sequence. Switching accounts must switch the cursor,
          // otherwise a new account would pull forward from the old account's
          // position and those rows would never be pulled back.
          accountKey: () => _login.email,
          // SALT-2 push gate: the provisioner is the confirmation authority
          // (its cache makes the confirmed steady state free of network).
          keymetaConfirmed: () async =>
              (await keymetaProvisioner.ensureConfirmed()).isConfirmed,
        ),
      );
      _blindStore!.attach();
    }
    // 🔴 Anti-façade: **without this line, 「auto-detect」 does not exist**, and
    // the whole section becomes a
    // sign that only moves when a manual button is pressed, while the owner's
    // first requirement was 「the phone side does **auto-detect**」.
    // It internally judges 「does this build carry the capability / did the user
    // turn it off / is it time to check」 itself,
    // and **never throws, never blocks**: a failed check only writes into its own
    // field, nothing else changes anywhere.
    unawaited(_update.maybeAutoCheck());
    _store.load();
    // 🔴 G-2 — WITHOUT THIS LINE THE QUEUE'S CROSS-RESTART HALF DOES NOT EXIST.
    //
    // `DeliveryOutbox.load()` is what reads the durable table back at boot and,
    // critically, revives anything left at `inflight` by a process that died
    // between the emit and the receipt (`REVIVED_FROM_INFLIGHT_ON_BOOT`). That
    // is the red line 「a latch closed by a remote event must have a local
    // watchdog」 in its ACROSS-RESTARTS form:
    // the in-process watchdog cannot fire for a process that no longer exists,
    // so this is the only thing standing between such an item and being stranded
    // at `inflight` for the life of the install.
    //
    // ⚠️ It was written, unit-tested and never called — the whole durability
    // story was a façade at the composition root, which is exactly where this
    // repo's anti-façade rule points (grep the production caller, or the capability
    // does not exist). Pinned by a test that asserts SOMEBODY CALLS IT, not just
    // that it works when called.
    unawaited(_controller.outbox.load());
    _scenario.load();
    // R6 T-3a: rehydrate the device-local send policy (⚡ direct / ➤ manual) so
    // the habit survives a relaunch. Defaults to direct when never set (08 §5).
    _controller.loadSendPolicy();
    // GA-01: same for the translate target language — a device-local habit that
    // must survive a relaunch, or the first translation after a restart quietly
    // goes to the wrong language.
    _controller.loadTranslateTarget();
    // R6 T-3b ③: rehydrate the device-local Favorites (F-5) so the 「+」 panel
    // and the ⭐ markers on history rows are correct from the first frame.
    _controller.favorites.load();
    // Rehydrate the logged-in resting state (email/plan) from secure storage.
    _login.hydrate();
  }

  @override
  void dispose() {
    _blindStore?.dispose();
    _update.dispose();
    _portable.dispose();
    _connections.dispose();
    _controller.dispose();
    _login.dispose();
    _scenario.dispose();
    _settingsClient.dispose();
    _destination.dispose();
    _store.dispose();
    _session.dispose();
    widget.appSettings.dispose();
    super.dispose();
  }

  SettingsPage _buildSettings() => SettingsPage(
    scenario: _scenario,
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
  );

  /// Chat page + live alias label. Listens to [_connections] so a rename
  /// (setAlias → load → notify) refreshes the header without writing the
  /// alias into [PttSession.connectedDeviceName].
  Widget _buildChat() => ListenableBuilder(
    // UP-2 — the badge on the gear icon is `_update`'s state, so it must also be
    // in this merge:
    // listening only to `_connections`, **nothing would rebuild this tree** when
    // a check result comes back,
    // and the badge would only appear by coincidence on the next connection-state
    // change (anti-façade: a capability wired up but never triggered).
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

  final GlobalKey<NavigatorState> _navKey = GlobalKey<NavigatorState>();

  @override
  Widget build(BuildContext context) {
    // R6 P0-R5: the app-root lifecycle bridge routes background/lock-screen →
    // audio:pause and return-from-background → audio:resume (08 §3 / §B-3).
    // Hosted here so one observer covers the whole session.
    // 🔴 Card F1 corrected this comment: it used to say「both PttSession guards keep
    // the calls inert unless a capture is actually in flight」. That was the
    // defect, not the design — backgrounding while IDLE told the PC nothing at
    // all. The wire frames now always go out; the bridge (not a recorder-state
    // guard) is what makes the edges idempotent and pairs them 1:1.
    return AppLifecycleBridge(
      onBackground: () => _session.pauseCapture(reason: 'background'),
      onForeground: () async {
        // ONE return-from-background edge, two independent consumers: restore a
        // paused capture (and un-pause the PC capsule) and replace the instance
        // list's stale probe snapshot. Starting both before awaiting also keeps
        // probing alive if audio resume later reports an error.
        // ⚠️ Card F1 narrowed WHEN this runs: `resumed` edges that were never a
        // background (a permission dialog, the notification shade) no longer
        // reach it. That is the point for `resumeCapture` — an unpaired resume
        // re-surfaces a PC capsule the user dismissed — and it is harmless for
        // the probe snapshot, which is only stale after a real absence.
        await Future.wait<void>(<Future<void>>[
          _session.resumeCapture(),
          _connections.refreshReachability(),
        ]);
      },
      // V2-07.3/.4: the palette is switchable and the settings selector is
      // WIRED (history: the visual contract was dark-only and a non-functional
      // theme selector was once removed as a façade — this listener is the
      // REAL wiring: FlowMicColors getters resolve per-build, ThemeData
      // follows the same notifier, and the whole tree rebuilds on change).
      child: ValueListenableBuilder<Brightness>(
        valueListenable: FlowMicTheme.brightness,
        builder: (BuildContext context, Brightness brightness, _) => MaterialApp(
          title: 'FlowMic',
          debugShowCheckedModeBanner: false,
          navigatorKey: _navKey,
          theme: ThemeData(
            brightness: brightness,
            scaffoldBackgroundColor: FlowMicColors.canvas,
            colorSchemeSeed: FlowMicColors.brandDeep,
            useMaterial3: true,
          ),
          // 🔴 FB-4 — the ONE place in the whole App where the three-tier global
          // text-scale setting takes effect.
          //
          // Placed on `builder:` rather than wrapping around MaterialApp, because
          // every route the Navigator pushes (settings page, history page,
          // diagnostics sheet…) is built INSIDE MaterialApp —
          // wrapping outside would hand them a MediaQuery that has **not been
          // multiplied**, so 「the text-scale tier would only take effect on the
          // home page」. That is why the `builder` slot exists, not an arbitrarily
          // picked spot.
          //
          // ⚠️ This is deliberately **two separate subscriptions to the same
          // controller** as the `home:` ListenableBuilder layer below:
          // that layer answers 「which page should be painted right now」, this
          // layer answers 「at what size should it be painted」. Merging them into
          // one layer would make a text-scale change rebuild ConnectionsPage
          // (exactly what that layer's deliberate use of `child:` avoids).
          builder: (BuildContext context, Widget? page) => TextScaleScope(
            appSettings: widget.appSettings,
            child: page!,
          ),
        // Startup home is the instance list (08 §1: paired→connection list; no
        // auto-connect on launch).
        //
        // U1 — except on the very first run of a new install, which gets the
        // language question first. It REPLACES the home rather than floating
        // over it: the nav behind it is in a language the user may not read,
        // and letting them poke at it is the problem this screen exists to
        // solve. The ListenableBuilder is what makes the choice immediate —
        // chooseLocale notifies, this rebuilds, and the instance list paints
        // in the chosen language on the next frame with no restart. The
        // instance list is passed as `child` so it is built once and not
        // rebuilt on every later appSettings change.
        //
        // 🔴 P-7 — AND THEN THE 3-PAGE GUIDE, IN THIS ORDER: language question
        // → guide → instance list. The guide is prose, so asking it before the
        // language is settled would show it in a language nobody picked — the
        // exact problem U1 exists to solve, reintroduced one screen later.
        // Skipping the guide and finishing it land in the SAME place
        // (`finishOnboarding`); see that method for why they must.
        // ⚠️ The gate that decides `needsOnboarding` is resolved in `load()`
        // BEFORE the locale one, because the locale one WRITES a pref — see
        // AppSettingsController.load's comment. Reading this ternary as the
        // ordering is a mistake: this is the ordering of SCREENS, that is the
        // ordering of DECISIONS, and they are deliberately opposite.
        home: ListenableBuilder(
          listenable: widget.appSettings,
          builder: (BuildContext context, Widget? child) =>
              widget.appSettings.needsLocaleChoice
                  ? FirstRunLocalePage(appSettings: widget.appSettings)
                  : widget.appSettings.needsOnboarding
                      ? FirstRunOnboardingPage(appSettings: widget.appSettings)
                      : child!,
          child: ConnectionsPage(
            connections: _connections,
            appSettings: widget.appSettings,
            login: _login,
            destination: _destination,
            chatPageBuilder: _buildChat,
            settingsPageBuilder: _buildSettings,
            historyPageBuilder: _buildHistory,
          ),
        ),
        ),
      ),
    );
  }
}

/// V2-06a-1 — reads the live session so a row is stamped with whoever the phone
/// was actually connected to when it was spoken.
///
/// Reads on EVERY call rather than caching: the connection changes under the
/// store's feet (pair / resume / leave), and a cached identity is how rows end
/// up attributed to the previous machine.
class _SessionInstanceOwner implements InstanceOwnerProbe {
  const _SessionInstanceOwner(this._session);
  final PttSession _session;

  @override
  String? get instanceId => _session.connectedInstanceId;

  @override
  String? get instanceName => _session.pcDisplayName;
}
