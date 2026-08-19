// FlowMic desktop library crate.
//
// The audited core — injection pipeline (inject/), focus tracking (focus/),
// window enumeration (window_enum), the socket.io client to server-core
// (socket/), and the protocol event/error-code mirrors (events/error_codes) —
// is tauri-free so `cargo test` and the golden-path example exercise it without
// the WebView2 toolchain. The Tauri window shell is the `app` feature on top.

/// MAC-01 — where this product's per-user files live, per platform. The single
/// owner of that question; before it, three call sites each answered it privately
/// and macOS got `$TMPDIR` from all three (which the OS prunes).
pub mod app_dirs;
pub mod caret;
pub mod error_codes;
pub mod events;
/// HOW this process ended — the classification, the declaration latch, and the
/// one place an exit line is written. Exists because every teardown path used
/// to converge on a single forensic sentence, so a long-running instance that
/// went away could not be attributed from its own log.
pub mod exit_reason;
pub mod focus;
pub mod forensic;
pub mod inject;
/// GA-10 — this PC's display name: the unique default a fresh install proposes,
/// and the 04 §3.7 validity rule shared with the rename command.
pub mod pc_name;
/// Portable record format FPR v1 (docs/rebuild/16) — the file layer of export / import: the zip
/// container, the row pictures on either side of it, and the 「user actively picks the destination」
/// dialog. The FORMAT itself has one author and it is on the frontend side; see
/// portable/mod.rs for why the split runs where the bytes are.
pub mod portable;
pub mod sidecar;
/// owner 2026-07-27 — one desktop process per user session, and therefore exactly
/// one spawned sidecar (a second UI would adopt the first's server and drive it
/// from two places).
pub mod single_instance;
pub mod socket;
/// UP-3a — the in-app update CORE: manifest contract, version compare, fetch,
/// SHA-256 gate, and install-form detection. Tauri-free on purpose so all of it
/// is testable under the lean build; UP-3b adds the UI, the installer hand-off
/// and the four-language strings on top.
pub mod update;
/// U6 — the Rust-side UI string table + locale state (tray, exit dialog,
/// autostart errors). Keyed by the SAME `flowmic.ui.locale` tags the Vue side
/// persists; default zh-CN; NEVER the OS locale (red line).
pub mod ui_i18n;
/// P0-PKG — carries WebView2 `localStorage` across the identifier rename to
/// `app.flowmic.windows` (the retired value is named inside that module, which
/// is the one place it is load-bearing). Tauri derives the webview profile
/// path from the identifier, so the rename moves it; this module moves the 56 KB
/// that carries meaning and leaves the old tree alone. NOT feature-gated: it is
/// pure path + file work with its own tests, and the `app` feature is exactly
/// the configuration `cargo test` does not build.
pub mod webview_profile;
pub mod window_enum;

// The Tauri window shell (dual window + tray + capsule commands) — only under the
// `app` feature so `cargo test` never drags in wry/webview2.
#[cfg(feature = "app")]
pub mod shell;

/// Read the server URL + PC name from the environment (sidecar default), used
/// by both the Tauri shell and the golden-path example.
pub fn socket_config_from_env() -> socket::SocketConfig {
    let url = std::env::var("FLOWMIC_SERVER_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:41879".to_string());
    // GA-10: the default is UNIQUE per machine (owner's iron rule ④). It used to be the
    // literal "FlowMic PC", so two machines on one account showed the phone two
    // identical rows. FLOWMIC_PC_NAME still overrides — that env is the reason a
    // rename was technically possible before this card, and the smokes use it.
    let device_name =
        std::env::var("FLOWMIC_PC_NAME").unwrap_or_else(|_| pc_name::default_pc_name());
    socket::SocketConfig {
        url,
        device_name,
        credentials_path: socket::Credentials::default_path(),
        // G-13 default = this machine's ONE dedup table (`dedup::machine_deduper`).
        // Deliberately NOT the mirror of the `credentials_path` line above it:
        // that slot is per channel and this one must never be — see
        // SocketConfig::deduper. `sidecar_ctl::connect_socket` leaves it alone
        // for both channels, which is what makes them share.
        deduper: None,
        inject_foreground_allowlist: smoke_allowlist_from_env(),
        // R6 T-2 defaults = the LAN channel: no Cloud Key on the handshake and no
        // auth-failure hook. `shell::sidecar_ctl::connect_socket` overrides
        // credential slot / jwt / hook / device_name (C-1: reconciled machine
        // name, never the factory default) when it dials either channel.
        jwt: None,
        auth_failure: None,
        // Default: no bridge (the golden-path example + tests run headless). The
        // `app` shell overrides this with a real AppHandle::emit sink in `run()`.
        bridge: None,
        // GA-28 defaults = a single LAN session with NO capsule gate, which is
        // exactly what a headless caller wants: the golden example and the smokes
        // own the only socket in their process, so 「who is primary」 has one answer.
        // `shell::sidecar_ctl` overrides both when it brings the two channels up.
        channel: socket::Channel::Lan,
        admission: None,
    }
}

/// Smoke-safety allowlist from `FLOWMIC_SMOKE_ALLOWLIST` (comma-separated
/// process names). Unset in production → `None` → inject into any foreground.
pub fn smoke_allowlist_from_env() -> Option<Vec<String>> {
    std::env::var("FLOWMIC_SMOKE_ALLOWLIST").ok().map(|raw| {
        raw.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    })
}

/// Tauri window shell entry. Feature-gated so the lean test/example build never
/// drags in wry/webview2. WP-R2-2 wires the dual-window UI: the bordered main
/// window (timeline + settings) and the transparent, non-activating capsule HUD.
/// The transparent-HUD occlusion launch arg is env-level in tauri.conf.json
/// (`additionalBrowserArgs … CalculateNativeWinOcclusion`) and shared by both
/// WebView2 windows; the capsule's WS_EX_NOACTIVATE styles + SW_SHOWNOACTIVATE
/// surface are applied in `shell`.
#[cfg(feature = "app")]
pub fn run() {
    use tauri::Manager;

    // 🔴🔴 UP-3b — THE MOVER INTERCEPT. THIS MUST BE THE FIRST STATEMENT, AND THE
    // ORDER IS THE WHOLE POINT.
    //
    // When this process was started with `--flowmic-apply-update <job>`, it is not
    // the application: it is a detached copy of this binary whose only job is to
    // wait for the real app to release its image lock and then rename the new tree
    // into place. It must therefore take NO instance lock, create NO window, and
    // start NO sidecar.
    //
    // Moving this below `single_instance::acquire` does not merely misbehave — it
    // DEADLOCKS, and it deadlocks against exactly the process it is waiting for:
    // the mover would be refused the lock (the app still holds it), return early
    // per the `else` branch below, and never perform the swap; meanwhile the app
    // has already exited expecting to be replaced. Nothing times out and nothing
    // is logged as a failure. The user sees an update that silently never happens.
    //
    // 🔴 `update::apply_arg` initialises forensics itself for this path, precisely
    // because the initialisation below is on the other side of this early return.
    //
    // ⚠️ A literal-anchor test (`update::apply_arg`'s test module) reads THIS FILE
    // and fails if `single_instance::acquire` appears before this call. That guard
    // exists because the ordering is invisible at every other layer — nothing
    // about the types or the tests below would go red if these two lines swapped.
    if update::apply_arg::intercept() {
        // `intercept` initialised forensics itself, so this line lands in the
        // SAME log the application writes to — which is precisely why it is
        // needed: without it, a log containing a mover run and an app death
        // cannot say which process each line came from, and「the app vanished
        // during an update」and「the mover did its job and stopped」look alike.
        // Uptime is deliberately unknown here: the process-start stamp belongs
        // to the application and this process is not one.
        exit_reason::record_exit(
            exit_reason::ExitPath::UpdateMoverFinished,
            &exit_reason::ExitContext::from_process(),
        );
        return;
    }

    // 0.3.8 — the MSI chain's sibling of the above, under the same rule and for
    // the same reason: this copy runs the installer, waits for it, and starts the
    // application again. Taking the instance lock here would be holding the lock
    // the app it is about to start needs, so it is intercepted at the same depth.
    //
    // 🔴 AFTER the mover's intercept, not before, because the two flags are
    // mutually exclusive and the mover's is the older contract — a process that
    // somehow carried both should behave the way it always did.
    if update::msi::intercept() {
        exit_reason::record_exit(
            exit_reason::ExitPath::UpdateMoverFinished,
            &exit_reason::ExitContext::from_process(),
        );
        return;
    }

    // From here down this process IS the application, so its lifetime becomes a
    // fact worth carrying to the exit line ("it had been up 3d02h" is the
    // difference between 「the user quit」 and 「it just died on its own」).
    exit_reason::mark_process_start();

    // owner 2026-07-27:「本地的 SERVER 端与 PC 端只存在一份运行实例」 ("locally, the
    // SERVER side and the PC side only ever have one running instance"). Claim the
    // per-user instance IDENTITY before the Tauri builder does anything — before
    // a tray icon appears, before a window is created, and above all before the
    // sidecar bring-up. A second instance that got as far as bring-up would find
    // the sidecar port taken, adopt the FIRST instance's server, and leave two
    // UIs driving one room. The identity is released by the OS when this process
    // ends, so a crash never wedges the next launch out. Forensics first so the
    // refusal is on the record — a launch that does nothing must still SAY why
    // (red line).
    //
    // ⚠️ In-place correction: this used to read「the per-user instance LOCK」and「:41879
    // taken」, and both were true when written. Neither is any more — the holder
    // is a named kernel object on Windows (`single_instance`'s header explains
    // why a path could not be the identity) and the port is
    // `FLOWMIC_SIDECAR_PORT`-overridable (`sidecar::port`). The rest of the
    // paragraph, including WHY this has to happen here, is unchanged.
    forensic::init_default();
    // D5 — process-wide panic forensics, installed before ANY thread spawns so a
    // worker-thread panic can never again vanish (the frontend has full error
    // boundaries; until this line the Rust side had nothing). The ONE call site.
    forensic::install_panic_hook();
    // U6 — adopt the persisted UI locale before any UI surface (tray menu, a
    // pre-WebView exit dialog) is built. Reads the file `ui_locale_set` mirrors
    // the frontend's choice into; missing/garbage → the zh-CN product default.
    // NEVER the OS locale (red line).
    ui_i18n::init_from_disk();

    // 🔴 CONFIG PREFLIGHT, BEFORE ANY IDENTITY IS CLAIMED OR ANY WINDOW EXISTS.
    //
    // Both settings below can only be WRONG in ways that are dangerous rather
    // than merely untidy, so both refuse the launch instead of falling back:
    //   • a bad FLOWMIC_SIDECAR_PORT falling back to the default would put this
    //     copy's server on the port a running copy is serving, and the adopt
    //     probe can then reclaim that port with `taskkill`;
    //   • a bad FLOWMIC_INSTANCE_TAG falling back to「no tag」would hand a
    //     developer who believes they are isolated the ordinary instance's
    //     identity.
    // A refused launch still SAYS why (red line: no silent failures) and is attributable at
    // the exit line as `startup-config-refused`.
    let sidecar_port = match sidecar::io::sidecar_port_checked() {
        Ok(p) => p,
        Err(e) => {
            forensic::record("startup", &format!("REFUSING to launch: {e}"));
            eprintln!("[flowmic] {e}");
            exit_reason::record_exit(
                exit_reason::ExitPath::StartupConfigRefused,
                &exit_reason::ExitContext::from_process(),
            );
            return;
        }
    };
    let scope = match single_instance::scope_from_env(sidecar_port) {
        Ok(s) => s,
        Err(e) => {
            forensic::record("startup", &format!("REFUSING to launch: {e}"));
            eprintln!("[flowmic] {e}");
            exit_reason::record_exit(
                exit_reason::ExitPath::StartupConfigRefused,
                &exit_reason::ExitContext::from_process(),
            );
            return;
        }
    };

    let Some(instance_lock) = single_instance::acquire_instance(&scope) else {
        // U10 — a second launch must not be a silent no-op: the user clicked the
        // shortcut while the app sits in the tray, so summon the FIRST instance's
        // main window. This is an explicit user-intent action on the MAIN window
        // — not the HUD, whose never-activate red line is untouched.
        let summoned = single_instance::signal_running_instance(&scope);
        forensic::record(
            "startup",
            &format!(
                "another FlowMic already holds the instance identity {} — this launch exits \
                 (single instance); summon signal to the running instance: {}",
                scope.mutex_name,
                if summoned { "sent" } else { "NO LISTENER FOUND (its window will not surface)" }
            ),
        );
        exit_reason::record_exit(
            exit_reason::ExitPath::SingleInstanceYielded,
            &exit_reason::ExitContext::from_process(),
        );
        return;
    };
    forensic::record(
        "startup",
        &format!(
            "instance identity claimed via {} (tag={:?}, sidecar port :{sidecar_port})",
            instance_lock.describe(),
            scope.tag
        ),
    );

    // 🔴 P0-PKG — CARRY THE WEBVIEW PROFILE BEFORE ANY WINDOW EXISTS.
    //
    // Tauri resolves the webview `data_directory` to `LocalData/<identifier>`
    // while building the FIRST window, and creates it if absent. So this call
    // has exactly one correct position: after the instance identity is claimed
    // (so two launches cannot copy the same tree at once) and before
    // `tauri::Builder`. Moving it into `.setup()` would be a coin flip on
    // whether the destination already exists, and losing that flip looks like a
    // successful migration that carried nothing.
    //
    // It never fails the launch: the worst outcome is the fresh profile the user
    // would have had anyway, and it says so in forensics either way.
    webview_profile::migrate_from_env();

    // The setup closure must be `'static` (Tauri stores it), so it takes its own
    // copy of the scope rather than borrowing the one `run()` owns. Two owners
    // of one VALUE, not two answers to one question — `resolve_scope` ran once.
    let setup_scope = scope.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // V2-10 boot autostart: the launch arg marks an OS-launched instance so setup
        // can keep the main window hidden (criterion 2 — autostart goes to the tray only).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![shell::autostart::AUTOSTART_ARG]),
        ))
        .invoke_handler(tauri::generate_handler![
            shell::accessibility::accessibility_status,
            shell::accessibility::open_accessibility_settings,
            shell::settings_update,
            shell::settings_list,
            // 0.2.27: `history_list` / `history_update` / `history_delete` /
            // `history_inject` are GONE. The server stores no transcripts (owner's
            // architecture ruling), so a pull returns nothing forever and an edit/delete has no
            // remote row to mirror; the PC owns its timeline and writes it locally.
            // Deferred re-delivery kept its command and lost its round trip — see shell::reinject.
            shell::reinject::timeline_reinject,
            // RV-93 two sizes: the row list keeps the 256 px thumbnail; the DELIVERED
            // picture lives on disk and is fetched only when the user opens one.
            shell::timeline_images::timeline_image,
            shell::timeline_images::timeline_images_drop,
            shell::connection::pairing_code,
            shell::connection::connection_snapshot,
            shell::refresh_pairing_code,
            shell::paired::list_paired_mobiles,
            shell::release_mobile,
            shell::naming::pc_rename,
            shell::sidecar_ctl::sidecar_state,
            shell::sidecar_ctl::sidecar_retry,
            shell::cloud::cloud_status,
            shell::cloud::cloud_save_key,
            shell::cloud::cloud_clear_key,
            // L3 account card: the LIVE read (`/api/me` + `/api/cloud/summary`). The card
            // used to render the JWT's own frozen claims — see the long note above
            // `cloud_account_fetch`.
            shell::cloud::cloud_account_fetch,
            // `channel_switch` is GONE (owner's 2026-07-30 ruling ②): the device page's
            // 「set as primary channel」 select was the only caller, and 「which channel
            // carries runtime traffic」 is
            // derived from which phone is admitted, not chosen.
            shell::capsule_resize,
            shell::capsule_move,
            // REQ-12-15: the capsule drag is the OS's own move loop, not a
            // position recomputed per pointermove. `capsule_position` is the
            // read-back — the WebView never sees the pointer during a native
            // drag, so it cannot know where the drag ended.
            shell::capsule_drag::capsule_start_drag,
            shell::capsule_drag::capsule_position,
            shell::caret_rect,
            shell::capsule_click_through,
            shell::capsule_surface,
            shell::capsule_hide,
            shell::clipboard_copy::capsule_copy_text,
            shell::show_main,
            shell::open_log_directory,
            shell::append_forensic,
            inject::probe_diag::focus_diagnostic,
            // 🔴 owner 2026-08-02 (F1a): our own input box must be able to receive
            // injection. The WebView pushes
            // 「is there right now an input-capable focus in this window of mine」; the HWND is resolved in Rust
            // from the invoking window, never sent by the page. See
            // inject/self_focus.rs for the failure direction (could not get an answer ⇒ not injected · cached).
            inject::self_focus::self_focus_report,
            shell::autostart::autostart_state,
            shell::autostart::autostart_set,
            // P7 (0.3.1) — the manual offline switch (devices page top-right;
            // the tray toggle goes through the same shell::offline::apply).
            shell::offline::offline_state,
            shell::offline::offline_set,
            // UP-3b online update. 🔴 `update_check` takes the manifest BASE URL as a
            // parameter — the default lives in @flowmic/protocol, never as a
            // literal in Rust (shell/cloud.rs's standing rule), and it is
            // deliberately NOT CloudConfig.endpoint: 「which relay am I paired
            // with」 and 「where is the authoritative release list」 are two
            // different questions.
            shell::update_ctl::update_state,
            shell::update_ctl::update_check,
            shell::update_ctl::update_download,
            shell::update_ctl::update_apply,
            shell::update_ctl::update_set_auto_check,
            shell::update_ctl::update_dismiss_pending,
            // U6 — the frontend mirrors its persisted UI locale here (boot +
            // every change) so the Rust surface (tray / exit dialog / autostart
            // errors) speaks the app language. See shell/locale_sync.rs.
            shell::locale_sync::ui_locale_set,
            // doc 16 FPR v1 export / import. The two `pick_*` commands are the ONLY way
            // a destination is chosen (§7-2 ⛔ must not default-export to a location
            // that gets auto-synced away).
            portable::commands::portable_picture_sizes,
            portable::commands::portable_picture_digests,
            portable::commands::portable_pick_save,
            portable::commands::portable_pick_open,
            portable::commands::portable_export,
            portable::commands::portable_read_archive,
            portable::commands::portable_restore_pictures,
        ])
        .on_window_event(|window, event| {
            // 07 §7: a native close hides the window to the tray (socket kept
            // alive); the ONLY real quit is the tray Quit. Applies to both windows
            // (the capsule × is a frontend Dismiss that calls capsule_hide).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            // Forensics first (07 §10) so the sidecar bring-up + socket lifecycle
            // are captured from the very first line.
            forensic::init_default();
            // Managed state, established BEFORE the async bring-up touches it:
            //   • SocketState — the TWO resident channel sessions (07 §6) + the
            //     shared capsule latch. Both slots start empty, so commands resolve
            //     to `false` (fail-loud pending) until a channel actually connects.
            //     The preferred channel is seeded to the LAN default here and
            //     corrected from the persisted CloudState by `sidecar_ctl::start`.
            //   • SidecarState — the lifecycle + pairing-endpoint source.
            app.manage(shell::SocketState::new(shell::Sessions::new(socket::Channel::Lan)));
            app.manage(shell::sidecar_ctl::SidecarState::new());
            // P7 — the manual offline flag. Managed BEFORE setup_tray and any
            // dial: connect_on_main reads it on every dial attempt.
            app.manage(shell::offline::OfflineState::new());
            //   • CloudState — the R6 T-2 channel selection + Cloud Key (DPAPI at
            //     rest). Managed BEFORE the bring-up because `sidecar_ctl::start`
            //     reads it to decide whether to spawn a local server at all.
            app.manage(shell::cloud::CloudState::load());
            //   • UpdateState — UP-3b. 🔴 Constructing it READS AND CLEARS the
            //     `update-pending.json` breadcrumb, which is the only channel
            //     carrying「what happened after we exited last time」. It is
            //     managed here, before any window, so that the answer is already
            //     in hand when the About card first renders — and cleared on
            //     read, so a months-old attempt cannot be re-announced forever.
            app.manage(shell::update_ctl::UpdateState::new());
            // Bring-up (07 §5 / supervisor ruling #4 / R6 T-2): on the LAN channel,
            // resolve→spawn→handshake→health on a background thread (never blocks
            // the window), then connect the socket at its endpoint —
            // FLOWMIC_SERVER_URL still overrides = dev mode. On the cloud channel
            // no local server is started; the socket dials the relay with the
            // Cloud Key instead. The device page shows the live status either way.
            shell::sidecar_ctl::start(app.handle());
            // V2-10 criterion 2: an autostart launch goes straight to the tray — the
            // main window is created hidden (tauri.conf `visible: false`) and
            // only a MANUAL launch (no --flowmic-autostart on the command line)
            // shows it here. The semantics of autostart IS standing by in the
            // background; popping the main window on boot is harassment. Also
            // deliberately does not provide a yes/no setting for 「pop it or not」
            // (the no-advanced-folding red line). Recorded so a
            // boot that showed nothing still SAYS it ran (no silent failures).
            let autostart_launch = std::env::args().any(|a| a == shell::autostart::AUTOSTART_ARG);
            forensic::record(
                "startup",
                if autostart_launch {
                    "launch mode: autostart (--flowmic-autostart) — main window stays hidden, tray only"
                } else {
                    "launch mode: manual — showing main window"
                },
            );
            if !autostart_launch {
                shell::show_main_window(app.handle());
            }
            // Capsule: WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW so it never steals focus.
            shell::configure_capsule_window(app.handle());
            // Tray — the only quit path (07 §7) + dynamic three-state tooltip
            // (07 §7 narrowed from seven on 2026-08-19; see socket/pump.rs tray_state).
            shell::setup_tray(app.handle())?;
            // U10 — listen for a second launch's summon signal (named event set
            // by the refused instance above) and surface the main window. The
            // event is created HERE, synchronously, so the listening side exists
            // for as long as the lock-holding side does; window ops hop to the
            // main thread (Tauri window methods are not free-threaded).
            {
                let handle = app.handle().clone();
                let spawned = single_instance::spawn_summon_listener_status(&setup_scope, move || {
                    // Counted so the exit line can say 「someone came knocking」: a process
                    // that was summoned five minutes before it died was being
                    // used, which is the difference between an idle background
                    // instance disappearing and an active one doing so.
                    exit_reason::note_summon();
                    forensic::record(
                        "startup",
                        "second-launch summon received — surfacing the main window",
                    );
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || shell::show_main_window(&h));
                });
                match spawned {
                    single_instance::SummonListener::Running => {}
                    // Fail loud on the record: without the listener a second
                    // launch degrades to the old silent no-op.
                    single_instance::SummonListener::Failed => forensic::record(
                        "startup",
                        "summon listener FAILED to start — a second launch will not surface this window",
                    ),
                    // NOT a failure — see SummonListener's doc comment. Saying
                    // 「FAILED」 here (which is what this branch used to do) blamed
                    // macOS for a fault it did not have, in the one file whose job
                    // is to be believed afterwards.
                    single_instance::SummonListener::UnsupportedOnThisPlatform => forensic::record(
                        "startup",
                        "summon listener not supported on this platform — a second launch still exits (single instance), it just cannot surface the running window",
                    ),
                }
            }
            // Forensics dual-perspective window startup snapshot (07 §10).
            shell::forensic_window_snapshot(app.handle(), "startup");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building FlowMic desktop")
        .run(|handle, event| {
            // On real quit (tray Quit → app.exit): terminate the spawned sidecar
            // child so no orphaned `node server.js` is left behind (07 §5). Adopted
            // / dev endpoints own no child, so this is a no-op there.
            if let tauri::RunEvent::Exit = event {
                // 🔴 THE ATTRIBUTION POINT. `RunEvent::Exit` fires for every way
                // the event loop can end and carries NO originator, so the only
                // way this line can say HOW is for the deciding path to have
                // said so on its way past (`exit_reason::declare`). Nothing
                // declared ⇒ `Undeclared`, whose sentence names the three
                // possibilities we genuinely cannot separate from here — that is
                // an honest bucket, not a guess.
                //
                // The session slots are read HERE rather than inside
                // `exit_reason` because they live in Tauri-managed state and
                // that module is deliberately tauri-free (the lean
                // `cargo test --lib` build exercises the whole classification).
                let ctx = match handle.try_state::<shell::SocketState>() {
                    Some(sockets) => {
                        let g = sockets.lock().unwrap_or_else(|p| p.into_inner());
                        exit_reason::ExitContext::from_process()
                            .with_sessions(g.lan.is_some(), g.cloud.is_some())
                    }
                    // No managed state ⇒ we exited before setup ran. Reported as
                    // `unknown-here`, never as 「no session」.
                    None => exit_reason::ExitContext::from_process(),
                };
                let path =
                    exit_reason::take_declared().unwrap_or(exit_reason::ExitPath::Undeclared);
                exit_reason::record_exit(path, &ctx);
                if let Some(state) = handle.try_state::<shell::sidecar_ctl::SidecarState>() {
                    // The child line carries the same path tag, so the two
                    // records join by eye. Before this, `kill_child` wrote one
                    // sentence for three different callers.
                    state.kill_child(exit_reason::SidecarKillCause::AppExit(path));
                }
            }
        });

    // Held for the whole life of the app: `run()` blocks until the app exits, so
    // dropping the lock HERE (rather than letting it fall out of scope early) is
    // what makes "one instance" mean "one instance for as long as we are alive".
    drop(instance_lock);
}
