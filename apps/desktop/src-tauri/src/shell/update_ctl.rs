// UP-3b — the Tauri command surface for in-app update.
//
// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §4.3 / §5.0 / §5.2
//
// Everything decidable lives in `crate::update` (tauri-free, unit-tested under
// the lean build). This file owns only what needs an `AppHandle`: managed state,
// the worker threads, and the DTO the WebView reads.
//
// ── 🔴 THE BASE URL IS A PARAMETER FROM THE FRONTEND ────────────────────────
//
// `update_check(base)` takes it, and this crate holds no default — the standing
// rule `shell/cloud.rs` states:「the DEFAULT lives in @flowmic/protocol on the
// frontend, never as a literal in Rust」.
//
// ⚠️ And it is deliberately NOT `CloudConfig.endpoint`. 「Which relay am I paired
// with」 and 「where is the authoritative list of releases」 are two different
// questions; design §1.1 says the latter is a global fact independent of the
// former. Answering both from one value would be this repo's headline bug shape,
// and it would break the legitimate case of a user paired to a self-hosted relay
// (which correctly 404s, and 404 has its own honest sentence).

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::update::{
    self, breadcrumb, prefs, swap, InstallForm, ManualReason, UpdateFailure, UpdatePlan,
};

/// The event the WebView listens on for progress and verdict changes.
pub const UPDATE_EVENT: &str = "update:state";

/// A failure, flattened for the wire.
///
/// 🔴 `tag` is the string-table KEY and `detail` is a diagnostic. The frontend
/// renders from `tag` through an exhaustive map, never from `detail` — `detail`
/// is deliberately not a sentence and must never be shown as one.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FailureDto {
    pub tag: String,
    pub detail: String,
    pub blocking: bool,
}

impl From<&UpdateFailure> for FailureDto {
    fn from(f: &UpdateFailure) -> Self {
        Self { tag: f.tag().to_string(), detail: f.to_string(), blocking: f.is_blocking() }
    }
}

/// What the last attempted update did, read once at startup.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PendingDto {
    pub outcome: String,
    pub from: String,
    pub to: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
pub struct DownloadDto {
    pub active: bool,
    pub received: u64,
    pub total: u64,
}

/// Everything the About card needs, in one payload.
///
/// 🔴 `last_success_check` travels in the SAME payload as `plan`, and that is
/// structural rather than convenient: design §5.0 calls shipping 「已是最新」
/// ("already up to date") without 「上次成功检查于 …」("last successful check
/// at …") this card's most likely silent failure, because a
/// client that has never once reached the server and one that just checked look
/// identical. Putting them in one struct means a renderer cannot have one without
/// the other in hand.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct UpdateStateDto {
    pub current_version: String,
    /// `dev` | `msi` | `portable` | `unknown` | `unsupported_platform`
    pub form: String,
    pub auto_check: bool,
    pub last_success_check: Option<String>,
    pub checking: bool,
    /// `null` until a check has been attempted this session. 🔴 NOT the same as
    /// `up_to_date`, and the frontend must not conflate them.
    pub plan: Option<String>,
    pub latest: Option<String>,
    pub notes_url: Option<String>,
    pub manual_reason: Option<String>,
    pub failure: Option<FailureDto>,
    pub download: DownloadDto,
    /// Present once the hash gate has passed. `verified_sha256` is shown to the
    /// user as the 「✓ 已校验完整性」("✓ integrity verified") evidence line (design §5.2).
    pub verified_filename: Option<String>,
    pub verified_sha256: Option<String>,
    pub verified_size: Option<u64>,
    /// 🔴 Portable only. `false` means we know, BEFORE exiting, that this copy
    /// cannot be replaced where it stands.
    pub can_swap_in_place: Option<bool>,
    pub pending: Option<PendingDto>,
}

#[derive(Default)]
struct Inner {
    checking: bool,
    plan: Option<UpdatePlan>,
    failure: Option<UpdateFailure>,
    download: DownloadDto,
    verified: Option<update::VerifiedPackage>,
    can_swap_in_place: Option<bool>,
    pending: Option<PendingDto>,
}

pub struct UpdateState {
    inner: Mutex<Inner>,
}

impl UpdateState {
    /// Built at startup. Reads (and clears) the breadcrumb here, once.
    ///
    /// 🔴 Cleared on read whatever it says — a breadcrumb that survived would
    /// re-announce a months-old update on every launch. It describes ONE attempt.
    pub fn new() -> Self {
        let dir = crate::app_dirs::local_home();
        let pending = breadcrumb::read_in(&dir).map(|crumb| {
            let outcome = breadcrumb::evaluate(&crumb, breadcrumb::current_version());
            crate::forensic::record(
                "update",
                &format!(
                    "breadcrumb found: {} → {} ({}), verdict {}",
                    crumb.from,
                    crumb.to,
                    crumb.detail.clone().unwrap_or_else(|| "no mover detail".to_string()),
                    outcome.tag(),
                ),
            );
            let (from, to, detail) = match &outcome {
                breadcrumb::PendingOutcome::Completed { to } => {
                    (crumb.from.clone(), to.clone(), None)
                }
                breadcrumb::PendingOutcome::NotCompleted { from, to, detail, .. } => {
                    (from.clone(), to.clone(), detail.clone())
                }
            };
            PendingDto { outcome: outcome.tag().to_string(), from, to, detail }
        });
        if pending.is_some() {
            breadcrumb::clear_in(&dir);
        }
        Self { inner: Mutex::new(Inner { pending, ..Inner::default() }) }
    }
}

impl Default for UpdateState {
    fn default() -> Self {
        Self::new()
    }
}

/// This machine's install form, resolved once per call from the RUNNING process's
/// real path (never a compile-time constant — `form.rs`).
fn form() -> InstallForm {
    #[cfg(all(windows, feature = "app"))]
    {
        update::current_install_form(&update::registered_install_dirs())
    }
    #[cfg(not(all(windows, feature = "app")))]
    {
        update::current_install_form(&[])
    }
}

fn snapshot(state: &UpdateState) -> UpdateStateDto {
    let inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    let p = prefs::load();
    let f = form();
    let (plan_tag, latest, notes_url, manual_reason) = match &inner.plan {
        Some(UpdatePlan::Available { latest, notes_url, .. }) => (
            Some("available".to_string()),
            Some(latest.to_string()),
            notes_url.clone(),
            None,
        ),
        Some(UpdatePlan::ManualOnly { latest, notes_url, reason, .. }) => (
            Some("manual_only".to_string()),
            Some(latest.to_string()),
            notes_url.clone(),
            Some(
                match reason {
                    ManualReason::UnknownForm => "unknown_form",
                    ManualReason::UnsupportedPlatform => "unsupported_platform",
                    ManualReason::NoFetchableKind { .. } => "no_fetchable_kind",
                }
                .to_string(),
            ),
        ),
        Some(other) => (Some(other.tag().to_string()), None, None, None),
        None => (None, None, None, None),
    };
    UpdateStateDto {
        current_version: breadcrumb::current_version().to_string(),
        form: f.tag().to_string(),
        auto_check: p.auto_check,
        last_success_check: p.last_success_check,
        checking: inner.checking,
        plan: plan_tag,
        latest,
        notes_url,
        manual_reason,
        failure: inner.failure.as_ref().map(FailureDto::from),
        download: inner.download.clone(),
        verified_filename: inner
            .verified
            .as_ref()
            .and_then(|v| v.path().file_name().map(|n| n.to_string_lossy().to_string())),
        verified_sha256: inner.verified.as_ref().map(|v| v.sha256().to_string()),
        verified_size: inner.verified.as_ref().map(update::VerifiedPackage::size),
        can_swap_in_place: inner.can_swap_in_place,
        pending: inner.pending.clone(),
    }
}

fn push(app: &AppHandle, state: &UpdateState) {
    let _ = app.emit(UPDATE_EVENT, snapshot(state));
}

#[tauri::command]
pub fn update_state(state: State<'_, UpdateState>) -> UpdateStateDto {
    snapshot(&state)
}

/// Turn automatic checking on or off. Changes save immediately (即改即存), no save button (red line).
#[tauri::command]
pub fn update_set_auto_check(enabled: bool, state: State<'_, UpdateState>) -> UpdateStateDto {
    let mut p = prefs::load();
    p.auto_check = enabled;
    if let Err(e) = prefs::save(&p) {
        crate::forensic::record("update", &format!("could not persist auto_check: {}", e.kind()));
    }
    snapshot(&state)
}

/// Ask the manifest endpoint. Blocking; `fetch_manifest` runs its own thread.
///
/// 🔴 A dev build short-circuits inside `update::check` BEFORE any network call
/// (design §4.2 「完全不检查更新」("does not check for updates at all")), and the resulting plan is `not_checked` —
/// which the UI must never render as 「已是最新」("already up to date").
#[tauri::command]
pub fn update_check(base: String, state: State<'_, UpdateState>) -> UpdateStateDto {
    {
        let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.checking = true;
        inner.failure = None;
    }
    let f = form();
    let locale = crate::ui_i18n::current().tag().to_string();
    let result = update::check(&base, &f, &locale);

    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    inner.checking = false;
    match result {
        Ok(plan) => {
            // 🔴 ONLY a check that actually read a manifest writes the timestamp.
            // A failed one leaves the old value standing, which is what lets the
            // UI say 「检查失败」("check failed") and 「上次成功检查于 三天前」
            // ("last successful check was 3 days ago") at once — the true
            // state, and far more useful than either sentence alone.
            if !matches!(plan, UpdatePlan::NotChecked { .. }) {
                let mut p = prefs::load();
                p.last_success_check = Some(prefs::now_iso8601());
                let _ = prefs::save(&p);
            }
            // For a portable copy, answer 「can this location be replaced」 NOW,
            // while we are still on screen to say so.
            inner.can_swap_in_place = match (&f, &plan) {
                (InstallForm::Portable, UpdatePlan::Available { .. }) => {
                    Some(swap::preflight(&install_dir_of_running_copy()).is_ok())
                }
                _ => None,
            };
            // 🔴 0.3.24 — RECORD THE VERDICT, not just the failures. Until this
            // line, a successful check wrote nothing to the forensic log: the
            // 「why does my machine say it can only update manually」 question
            // asked from a real Windows 10 box on 2026-08-21 could not be
            // answered from that box's own log, and the root cause had to be
            // re-derived from the live manifest and the locale registry instead.
            // A check that succeeds and explains nothing is the diagnostic twin
            // of a status word with no evidence behind it (R11).
            crate::forensic::record(
                "update",
                &format!(
                    "check → plan={} form={} locale={locale}{}",
                    plan.tag(),
                    f.tag(),
                    match &plan {
                        UpdatePlan::Available { latest, artifact, .. } =>
                            format!(" latest={latest} artifact={}", artifact.filename),
                        UpdatePlan::ManualOnly { latest, reason, .. } =>
                            format!(" latest={latest} reason={reason:?}"),
                        _ => String::new(),
                    }
                ),
            );
            inner.plan = Some(plan);
        }
        Err(e) => {
            crate::forensic::record("update", &format!("check failed — {e}"));
            inner.failure = Some(e);
        }
    }
    drop(inner);
    snapshot(&state)
}

/// The directory the running portable copy lives in.
fn install_dir_of_running_copy() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
        .unwrap_or_default()
}

/// Download the planned artifact and put it through the hash gate.
#[tauri::command]
pub fn update_download(app: AppHandle, state: State<'_, UpdateState>) -> UpdateStateDto {
    let artifact = {
        let inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        match &inner.plan {
            Some(UpdatePlan::Available { artifact, .. }) => artifact.clone(),
            _ => return snapshot(&state),
        }
    };
    {
        let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.failure = None;
        inner.verified = None;
        inner.download = DownloadDto { active: true, received: 0, total: artifact.size };
    }
    push(&app, &state);

    let dir = update::updates_dir();
    // Housekeeping first: design §4.3 ② —「每次启动清理 updates\ 里不是当前目标的
    // 文件」("on every launch, clean out files in updates\ that are not the
    // current target"). Keeping the current target (and its `.part`) means calling this
    // cannot delete the download it is about to make.
    let sweep = update::sweep_stale(&dir, Some(&artifact.filename));
    if sweep.removed > 0 || sweep.failed > 0 {
        crate::forensic::record(
            "update",
            &format!("swept updates dir — removed {}, failed {}", sweep.removed, sweep.failed),
        );
    }

    let mut last_emit = std::time::Instant::now();
    let app2 = app.clone();
    let result = update::download_and_verify(&artifact, &dir, &mut |received, total| {
        // Throttled: a 64 KiB chunk over ~100 MB is ~1600 events, and a WebView
        // repainting a progress bar 1600 times is worse than one that moves in
        // readable steps.
        if last_emit.elapsed() >= std::time::Duration::from_millis(120) {
            last_emit = std::time::Instant::now();
            let _ = app2.emit(
                UPDATE_EVENT,
                serde_json::json!({ "progress": { "received": received, "total": total } }),
            );
        }
    });

    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    inner.download.active = false;
    match result {
        Ok(pkg) => {
            crate::forensic::record(
                "update",
                &format!("package verified — {} bytes, sha256 {}", pkg.size(), pkg.sha256()),
            );
            inner.download.received = pkg.size();
            inner.verified = Some(pkg);
        }
        Err(e) => {
            crate::forensic::record("update", &format!("download failed — {e}"));
            inner.failure = Some(e);
        }
    }
    drop(inner);
    let dto = snapshot(&state);
    let _ = app.emit(UPDATE_EVENT, dto.clone());
    dto
}

/// 🔴 Install. **This function exits the application** on success.
///
/// Both branches obey design §4.3 ④b: the thing that will do the work is started
/// BEFORE we exit, because after we exit there is no process left to start
/// anything.
#[tauri::command]
pub fn update_apply(app: AppHandle, state: State<'_, UpdateState>) -> UpdateStateDto {
    let (pkg_path, kind) = {
        let inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        match &inner.verified {
            Some(v) => (v.path().to_path_buf(), v.kind().to_string()),
            // Nothing verified. Never install anything we have not hashed — and
            // there is no code path here that could, because `VerifiedPackage` is
            // the only carrier of a package path (`download.rs`).
            None => return snapshot(&state),
        }
    };
    let to = {
        let inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        match &inner.plan {
            Some(UpdatePlan::Available { latest, .. }) => latest.to_string(),
            _ => return snapshot(&state),
        }
    };
    let from = breadcrumb::current_version().to_string();
    let crumbs = crate::app_dirs::local_home();

    let outcome: Result<(), UpdateFailure> = match form() {
        InstallForm::Portable if kind == "portable-zip" => {
            let install = install_dir_of_running_copy();
            // prepare(): preflight → verify_root → extract → sanity → breadcrumb.
            // Every one of these happens while we are still on screen.
            match swap::prepare(
                &install,
                &pkg_path,
                update::WINDOWS_PORTABLE_ROOT,
                &from,
                &to,
                &crumbs,
            ) {
                Ok(prepared) => {
                    let source = std::env::current_exe().unwrap_or_else(|_| install.join("FlowMic.exe"));
                    update::apply_arg::spawn_mover(&prepared.job, &source).map(|pid| {
                        crate::forensic::record("update", &format!("mover started (pid {pid})"));
                    })
                }
                Err(e) => Err(e),
            }
        }
        InstallForm::MsiInstalled { .. } if kind == "msi" => {
            if let Err(e) = breadcrumb::write_in(
                &crumbs,
                &breadcrumb::Breadcrumb {
                    from: from.clone(),
                    to: to.clone(),
                    kind: breadcrumb::PendingKind::Msi,
                    started_at: prefs::now_iso8601(),
                    detail: None,
                },
            ) {
                crate::forensic::record("update", &format!("breadcrumb write failed: {}", e.kind()));
            }
            // 0.3.8 — the installer is started BY A DETACHED COPY OF THIS BINARY,
            // which then waits on it and starts the app again. Before this, we
            // spawned msiexec ourselves and exited, and the install succeeded
            // while「新版本也没启动起来」("the new version never started"), with the
            // instruction to reopen it printed on the window this chain closes.
            // See update/msi.rs for why the relaunch is not a WiX change.
            let source = std::env::current_exe();
            match source {
                Ok(source) => update::msi::spawn_installer_runner(
                    &update::msi::InstallJob {
                        package: pkg_path.clone(),
                        // MSI upgrades replace the file at this path, so it names
                        // the new build afterwards — and the old one if nothing
                        // was installed, which is the point.
                        relaunch_exe: source.clone(),
                        from: from.clone(),
                        to: to.clone(),
                    },
                    &source,
                )
                .map(|pid| {
                    crate::forensic::record("update", &format!("installer runner started (pid {pid})"));
                }),
                // Refused rather than improvised: without our own path there is
                // nothing to relaunch, and starting msiexec anyway would recreate
                // exactly the defect this replaces.
                Err(e) => Err(UpdateFailure::InstallerNotLaunched {
                    detail: format!("current_exe:{}", e.kind()),
                }),
            }
        }
        // A verified package that does not match this form. Refused rather than
        // improvised: handing an MSI to the portable swap (or the reverse) is a
        // guess about a user's machine.
        other => Err(UpdateFailure::StagedTreeIncomplete {
            missing: vec![format!("no installer path for form `{}` with kind `{kind}`", other.tag())],
        }),
    };

    if let Err(e) = outcome {
        crate::forensic::record("update", &format!("apply failed — {e}"));
        breadcrumb::clear_in(&crumbs);
        let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.failure = Some(e);
        drop(inner);
        return snapshot(&state);
    }

    let dto = snapshot(&state);
    // 🔴 Exit through the NORMAL path (design §4.3 ④c): `app.exit` runs the
    // `RunEvent::Exit` handler in lib.rs, which kills the sidecar child, and the
    // instance lock is released with the process. A second exit path here would
    // leave `node server.js` orphaned and `instance.lock` held — and the mover
    // would then wait 90 seconds for an image lock that never clears.
    crate::forensic::record("update", "handing off to the installer and exiting normally");
    // Declared BEFORE the exit, for the same reason the tray quit declares:
    // `RunEvent::Exit` has no way to learn who asked. Without this the log would
    // show an app that vanished at the exact moment an update was pending, and
    //「它自己崩了」("it crashed on its own") and「它是去装更新了」("it went off to
    // install an update") are the two readings a user would give it.
    crate::exit_reason::declare(crate::exit_reason::ExitPath::UpdateInstallHandoff);
    app.exit(0);
    dto
}

/// Dismiss the 「上次的更新没有完成」("the last update did not complete") notice.
#[tauri::command]
pub fn update_dismiss_pending(state: State<'_, UpdateState>) -> UpdateStateDto {
    {
        let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.pending = None;
    }
    snapshot(&state)
}
