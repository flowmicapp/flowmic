// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §5 (sidecar bring-up: adopt-first on :41879)
//   CLAUDE.md red line: no silent failure
//
// owner 2026-07-27:「确保PC端在启动后，本地的SERVER端与PC端只存在一份运行实例」
// ("Ensure that after the PC side starts up, only one running instance of the
// local SERVER side and the PC side exists.").
//
// Two instances of the desktop are not merely untidy — each one brings up its own
// channel pumps, its own tray icon and its own capsule, and the SECOND one's
// sidecar bring-up finds :41879 already taken. The adopt-first probe then hands it
// the FIRST instance's server, so two UIs drive one server and the owner sees two
// capsules argue over one room. Worse, the probe cannot tell OUR server from a
// stale one left by another build (the real-device 「attach 到旧线 legacy server」
// ("attach to the old-line legacy server") trap), so the safe move is to never get there: one UI process per user session,
// and therefore exactly one spawned sidecar.
//
// The lock is an exclusively-opened file rather than a named mutex on purpose:
//   • it needs no new crate feature (std + one Windows share-mode flag);
//   • Windows releases the handle when the process dies — INCLUDING a crash or a
//     taskkill — so a stale lock cannot wedge the app out of starting, which is
//     the classic failure mode of a hand-rolled pidfile;
//   • it lives beside the DB and the standalone secret in FLOWMIC_HOME, so the
//     whole per-user footprint stays in one directory.
//
// 🔴🔴 IN-PLACE CORRECTION (原地更正) — THE THIRD BULLET WAS THE DEFECT, AND ON WINDOWS THE WHOLE
// PARAGRAPH IS NOW HISTORY. Original kept above because it was true when
// written and its first two reasons are still the reasons the REPLACEMENT was
// chosen; only the third one has flipped sign.
//
// WHAT WENT WRONG: "it lives in FLOWMIC_HOME" resolves through
// `crate::app_dirs::roaming_home`, which on Windows is `%APPDATA%\FlowMic`.
// `%APPDATA%` is an ENVIRONMENT VARIABLE, so it is not an identity — it is a
// per-process opinion. Launch a second copy with `APPDATA` pointed elsewhere and
// it mints a second lock file, becomes a second「first instance」, and starts a
// second sidecar. The two then contend for one hard-coded TCP port, the loser's
// adopt probe (`crate::sidecar::adopt::probe_existing`) can rule the winner
// FOREIGN — it does exactly that whenever the two copies run different
// `server.js` files, which is the normal state of a dev tree beside an install —
// and `crate::sidecar::portclear::clear_port` then reclaims the port with
// `netstat -ano` + `taskkill /F /PID`. The end of that chain is one copy killing
// the OTHER copy's live server out from under a user who was speaking into it.
//
// WHY A NAMED KERNEL OBJECT AND NOT A DIFFERENT DIRECTORY: on Windows there is
// no environment-independent PATH available to us. `%APPDATA%`, `%LOCALAPPDATA%`,
// `%USERPROFILE%`, `%TEMP%` are all env vars; the only env-free answer is
// `SHGetKnownFolderPath`, which would mean a new `windows` crate feature
// (`Win32_UI_Shell`) and a COM-ish call for something that is not really about
// files at all. A named mutex in the `Local\` namespace has NO path component to
// redirect: the name is resolved by the kernel against the LOGON SESSION, which
// is the exact scope owner asked for (「PC 端只存在一份运行实例」("on the PC side
// there exists only one running instance"), per user
// session). It keeps both surviving reasons from the original list — no new
// crate feature (`Win32_System_Threading` is already enabled for the summon
// event right below) and kernel-released on process death, crash and taskkill
// alike — and it drops the one that turned out to be a hazard.
//
// WHAT IT NOW PROTECTS AGAINST, precisely: a second copy of this app cannot
// become a second「first instance」by redirecting ANY environment variable,
// because the identity is no longer derived from anything a process can set for
// itself. It does NOT protect against a second copy run by a DIFFERENT logon
// session (correct: that is a different user's FlowMic and it is entitled to its
// own), nor against someone who deliberately asks for a second instance — see
// `INSTANCE_TAG_ENV` for the named door that exists so nobody has to pick the
// lock.
//
// ⚠️ NON-WINDOWS KEEPS THE FILE LOCK, and that is a stated boundary rather than
// an oversight: `%APPDATA%` does not exist there, and the kill chain above does
// not either — `portclear::clear_port` refuses by name on every non-Windows
// target ("port clear is Windows-only"), so a duplicated lock costs a duplicate
// window rather than someone else's server. The macOS/Linux equivalent hardening
// (a HOME-independent identity) is a real but separate account, and doing it
// blind on a platform this window cannot run is the kind of untested guess the
// `app_dirs` header already refuses to make.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

/// Held for the life of the process; dropping it releases the lock.
pub struct InstanceLock {
    held: Held,
}

/// What is actually holding the identity. Modelled rather than flattened,
/// because「a named object holds it」and「a file holds it」have different
/// release semantics and the forensic line must be able to say which one ran.
enum Held {
    /// Windows: a named mutex in the per-logon-session object namespace.
    /// `handle` is a `HANDLE` carried as `usize` (raw pointers are not `Send`,
    /// and this value only ever moves within one stack).
    #[cfg(windows)]
    Mutex { name: String, handle: usize },
    /// Non-Windows: the exclusively-opened lock file. `_file` is the lock; it is
    /// held for RAII and never read.
    File { _file: File, path: PathBuf },
    /// We could not establish exclusion at all and are saying so instead of
    /// pretending. See `acquire`'s doc for why this fails OPEN.
    Unenforced { why: &'static str },
}

impl InstanceLock {
    /// The lock FILE path, when a file is what holds the identity.
    ///
    /// `None` on the named-mutex path on purpose: there is no path, and
    /// returning a plausible-looking one is how a directory got mistaken for an
    /// identity in the first place.
    pub fn path(&self) -> Option<&Path> {
        match &self.held {
            #[cfg(windows)]
            Held::Mutex { .. } => None,
            Held::File { path, .. } => Some(path.as_path()),
            Held::Unenforced { .. } => None,
        }
    }

    /// One phrase for the startup forensic line — a reader must be able to tell
    /// which mechanism actually ran, because they behave differently on a crash.
    pub fn describe(&self) -> String {
        match &self.held {
            #[cfg(windows)]
            Held::Mutex { name, .. } => format!("named mutex {name}"),
            Held::File { path, .. } => format!("lock file {}", path.display()),
            Held::Unenforced { why } => {
                format!("NOTHING (single-instance exclusion is not in force: {why})")
            }
        }
    }
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        match &self.held {
            // The kernel would release this at process death anyway; closing it
            // explicitly is what makes the lock re-acquirable inside one process,
            // which is what the unit test needs in order to be a real test.
            #[cfg(windows)]
            Held::Mutex { handle, .. } => unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(
                    windows::Win32::Foundation::HANDLE(*handle as *mut core::ffi::c_void),
                );
            },
            _ => {}
        }
    }
}

/// The lock FILE's home — the non-Windows identity, and on Windows only a
/// leftover that nothing in `run()` calls any more (see the header block).
///
/// 🔴 `crate::app_dirs::roaming_home` is deliberately NOT changed by this card.
/// It answers「where does this product keep the DB and the standalone secret」,
/// and moving THAT would strand every existing install's data to fix a problem
/// that lives in a different question. The chain is cut here instead: the
/// instance identity stopped riding on the data directory.
pub fn default_lock_path(tag: Option<&str>) -> PathBuf {
    let name = match tag {
        None => "instance.lock".to_string(),
        Some(t) => format!("instance-{t}.lock"),
    };
    crate::sidecar::io::default_home().join(name)
}

/// Try to become THE running instance.
///
/// `Some(lock)` — we own it; keep the value alive for the whole process.
/// `None`       — another instance already holds it; the caller must exit.
///
/// A lock file that cannot be created at all (unwritable home) returns `Some` with
/// no real exclusion rather than refusing to launch: failing open is right here,
/// because a missing lock costs the owner a duplicate window while a false
/// negative would cost them the application entirely.
pub fn acquire(path: &Path) -> Option<InstanceLock> {
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return Some(unenforced("the lock directory could not be created"));
        }
    }
    match open_exclusive(path) {
        Ok(file) => Some(InstanceLock { held: Held::File { _file: file, path: path.to_path_buf() } }),
        Err(e) if is_sharing_violation(&e) => None,
        // Any other error (permissions, read-only volume) → fail OPEN, see above.
        Err(_) => Some(unenforced("the lock file could not be opened (permissions / read-only volume)")),
    }
}

/// The fail-open value. It owns no OS resource at all — the previous version
/// opened a throwaway temp file so the struct still had a `File` to hold, which
/// made「我们锁住了」("we locked it") and「我们什么也没锁住」("we locked nothing")
/// the same shape in the debugger and in
/// the forensic line. `describe()` now says which one happened.
fn unenforced(why: &'static str) -> InstanceLock {
    InstanceLock { held: Held::Unenforced { why } }
}

// ── the instance SCOPE: what identity this launch is claiming ────────────────

/// Explicit opt-in for a SECOND, isolated instance on this machine.
///
/// Unset (the shipping case) → this launch claims the one product identity.
/// Set to a tag → this launch claims `…SingleInstance.<tag>` instead, and gets
/// its own summon channel and its own lock file name, so it neither refuses nor
/// summons the ordinary instance.
///
/// 🔴 SETTING THIS ALONE IS REFUSED, and the refusal is the entire safety
/// argument. A second identity that still uses the default TCP port is not two
/// isolated instances — it is the exact configuration the old `%APPDATA%`
/// accident produced, only now on purpose: two servers racing for one port,
/// with `crate::sidecar::adopt::probe_existing` free to rule the other one
/// foreign and `crate::sidecar::portclear::clear_port` free to `taskkill` it.
/// ⇒ A tag is only honoured together with `crate::sidecar::io::SIDECAR_PORT_ENV`
/// moved OFF the default. The port is what makes the second instance safe; the
/// tag only makes it possible.
pub const INSTANCE_TAG_ENV: &str = "FLOWMIC_INSTANCE_TAG";

/// The base name of the single-instance mutex. `Local\` = this logon session,
/// the same scope the summon event uses, so the two can never disagree about
/// who「the running instance」is.
pub const SINGLE_INSTANCE_MUTEX: &str = "Local\\FlowMic.SingleInstance";

/// Longest tag we accept. Kernel object names are capped at MAX_PATH; this is
/// far below it and short enough to stay readable in a forensic line.
const TAG_MAX_LEN: usize = 32;

/// Which identity this launch claims, and the two channel names derived from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceScope {
    /// `None` = the ordinary product instance.
    pub tag: Option<String>,
    /// The named mutex that IS the identity on Windows.
    pub mutex_name: String,
    /// The summon event, scoped alongside it — otherwise a tagged dev instance's
    /// second launch would raise the ordinary instance's window.
    pub summon_event_name: String,
}

/// Why a requested scope was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeError {
    /// The tag was set but empty/whitespace. Refused rather than read as
    ///「unset」: a silent fallback to the shared identity is how a developer
    /// ends up believing they are isolated when they are not.
    EmptyTag,
    /// A character that either cannot appear in a kernel object name or would
    /// change which namespace the name lands in. `\` is the dangerous one: it
    /// is the namespace separator, so `Local\FlowMic.SingleInstance.a\b` is a
    /// DIFFERENT object tree, not a differently-named object.
    IllegalTag(String),
    /// The tag is fine, but the port was left on the default. See
    /// `INSTANCE_TAG_ENV`.
    TagWithoutOwnPort { tag: String, port: u16 },
}

impl std::fmt::Display for ScopeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ScopeError::EmptyTag => write!(
                f,
                "{INSTANCE_TAG_ENV} is set but empty — refusing to start rather than silently joining the ordinary instance's identity"
            ),
            ScopeError::IllegalTag(t) => write!(
                f,
                "{INSTANCE_TAG_ENV}={t:?} contains a character that is not allowed in an instance tag (use A-Z a-z 0-9 - _ , at most {TAG_MAX_LEN})"
            ),
            ScopeError::TagWithoutOwnPort { tag, port } => write!(
                f,
                "{INSTANCE_TAG_ENV}={tag:?} asks for a second isolated instance, but {} is still :{port} — a second instance MUST have its own port, or the two race for one and the adopt probe can taskkill the other one's server. Set {} to a free port and try again",
                crate::sidecar::io::SIDECAR_PORT_ENV,
                crate::sidecar::io::SIDECAR_PORT_ENV,
            ),
        }
    }
}

/// The pure half: a raw tag plus the port this launch resolved → the scope, or
/// a named refusal. No environment access, so the whole policy is testable
/// without mutating a process-global.
pub fn resolve_scope(raw_tag: Option<&str>, port: u16, default_port: u16) -> Result<InstanceScope, ScopeError> {
    let Some(raw) = raw_tag else {
        return Ok(InstanceScope {
            tag: None,
            mutex_name: SINGLE_INSTANCE_MUTEX.to_string(),
            summon_event_name: SUMMON_EVENT_NAME.to_string(),
        });
    };
    let tag = raw.trim();
    if tag.is_empty() {
        return Err(ScopeError::EmptyTag);
    }
    if tag.len() > TAG_MAX_LEN
        || !tag.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(ScopeError::IllegalTag(tag.to_string()));
    }
    if port == default_port {
        return Err(ScopeError::TagWithoutOwnPort { tag: tag.to_string(), port });
    }
    Ok(InstanceScope {
        tag: Some(tag.to_string()),
        mutex_name: format!("{SINGLE_INSTANCE_MUTEX}.{tag}"),
        summon_event_name: format!("{SUMMON_EVENT_NAME}.{tag}"),
    })
}

/// Production wrapper: read `INSTANCE_TAG_ENV` and judge it against the port
/// this launch actually resolved.
pub fn scope_from_env(port: u16) -> Result<InstanceScope, ScopeError> {
    resolve_scope(
        std::env::var(INSTANCE_TAG_ENV).ok().as_deref(),
        port,
        crate::sidecar::io::SIDECAR_PORT_DEFAULT,
    )
}

/// Claim THE instance identity for this scope. `None` = somebody else holds it
/// and this launch must stand down.
///
/// Windows takes the named mutex (see the header block for why it is not a
/// path); every other target keeps the file lock, also for the reason given
/// there.
pub fn acquire_instance(scope: &InstanceScope) -> Option<InstanceLock> {
    #[cfg(windows)]
    {
        acquire_named_mutex(&scope.mutex_name)
    }
    #[cfg(not(windows))]
    {
        acquire(&default_lock_path(scope.tag.as_deref()))
    }
}

/// The Windows identity. `Some` = we created it and own it; `None` = it already
/// existed, i.e. another FlowMic in this logon session has it.
///
/// `CreateMutexW` + `ERROR_ALREADY_EXISTS` is the documented single-instance
/// idiom. The refused side CLOSES its handle immediately (the caller drops the
/// `None` and returns), which matters: a refused process that kept the handle
/// open would keep the named object alive after the real owner died, and the
/// NEXT launch would then be refused by a ghost.
#[cfg(windows)]
fn acquire_named_mutex(name: &str) -> Option<InstanceLock> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;

    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    // bInitialOwner = true: if we are the creator we also own it. Ownership is
    // never waited on anywhere — the OBJECT's existence is the lock — so no
    // ReleaseMutex path exists and an abandoned mutex is not a state we can
    // reach.
    let Ok(handle) = (unsafe { CreateMutexW(None, true, PCWSTR(wide.as_ptr())) }) else {
        // Could not even create the object (an exotic sandbox / name-space
        // denial). Fail OPEN, exactly like the file path's non-sharing errors:
        // a missing lock costs a duplicate window, a false refusal costs the
        // application entirely.
        return Some(unenforced("the single-instance mutex could not be created"));
    };
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        let _ = unsafe { CloseHandle(handle) };
        return None;
    }
    Some(InstanceLock {
        held: Held::Mutex { name: name.to_string(), handle: handle.0 as usize },
    })
}

#[cfg(windows)]
fn open_exclusive(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    // dwShareMode = 0 → no other process may open this file until we close it.
    const FILE_SHARE_NONE: u32 = 0;
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .share_mode(FILE_SHARE_NONE)
        .open(path)
}

#[cfg(not(windows))]
fn open_exclusive(path: &Path) -> std::io::Result<File> {
    // Non-Windows is dev-only for this app; there is no exclusive-open primitive
    // in std, so this degrades to "always acquires" rather than pretending.
    //
    // 🔴 In-place correction (MAC-07, 2026-08-07) — **the original text below is
    // kept, because it was true word-for-word at the time it was written**:
    // 「non-Windows is dev-only」was true then, and std genuinely had no
    // exclusive-open primitive at the time, so 「degrading to always acquiring」
    // was **honest** (it did not pretend to have locked). **Both premises no
    // longer hold today**:
    //   ① macOS is now a real shipping platform (owner's three-platform portable ruling);
    //   ② `File::try_lock()` is now stable in std (confirmed usable on this
    //      machine's rustc 1.95 / Mac mini 1.97),
    //      **zero new dependencies** — the sentence 「there is no exclusive-open primitive in std」is a
    //      **stale truth** (the textbook shape of anti-façade rule ④: a comment
    //      asserting behaviour elsewhere, while elsewhere changed and the comment did not).
    // ⇒ It now really locks. The honest degradation was correct while it was the
    // only option; it is no longer the only option.
    //
    // The semantics are deliberately aligned with the Windows half: when the
    // process dies (including crash/kill), the kernel releases the flock,
    // so a stale lock **cannot possibly** lock the app out — that is exactly the
    // classic failure shape of a hand-rolled pidfile,
    // and it is also the second reason the file header chose 「a lock file rather
    // than a named mutex」.
    let file = OpenOptions::new().create(true).write(true).truncate(false).open(path)?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        // Somebody else is holding it → translate into `WouldBlock`, claimed by
        // `is_sharing_violation`, so `acquire`'s three-branch judgement is
        // **the same one** across both platforms, with no need to write it twice.
        Err(std::fs::TryLockError::WouldBlock) => {
            Err(std::io::Error::new(std::io::ErrorKind::WouldBlock, "instance lock held"))
        }
        // A real IO error (read-only volume, a filesystem that doesn't support
        // flock) → propagate as-is,
        // falling into `acquire`'s fail-open branch. **Deliberately not treated
        // as「occupied」**: that would turn 「we could not tell」into 「another
        // instance is running」, exactly the kind of false report the red line forbids.
        Err(std::fs::TryLockError::Error(e)) => Err(e),
    }
}

#[cfg(windows)]
fn is_sharing_violation(e: &std::io::Error) -> bool {
    // ERROR_SHARING_VIOLATION (32) — someone else holds it with share_mode 0.
    // ERROR_LOCK_VIOLATION (33) is the sibling case on some filesystems.
    matches!(e.raw_os_error(), Some(32) | Some(33))
}

#[cfg(not(windows))]
fn is_sharing_violation(e: &std::io::Error) -> bool {
    // MAC-07: `open_exclusive` above translates a held `flock` into `WouldBlock`.
    // Before that card this was a flat `false` — correct then (nothing could ever
    // report contention), a false negative now.
    e.kind() == std::io::ErrorKind::WouldBlock
}

// ── U10: the second-launch summon signal ─────────────────────────────────────
//
// The lock above makes a second launch EXIT — and until this card, exit was all
// it did: one forensic line, nothing on screen. The user who double-clicked the
// shortcut while the app sat in the tray read that as「坏了」("broken"). The file lock has
// no notification channel of its own, so this is the minimal real one: a named
// auto-reset Win32 event in the per-logon-session namespace (`Local\` — the same
// per-user scope the lock file has). The refused instance opens-and-sets it; the
// running instance holds a thread parked on it and surfaces the MAIN window.
// The main window is the explicitly-summoned surface here — the capsule HUD and
// its never-activate red line are untouched.

/// The BASE name; the live name comes from `InstanceScope::summon_event_name`,
/// which appends the instance tag when there is one. `Local\` = this logon
/// session, matching the mutex that holds the identity.
///
/// ⚠️ The untagged name is byte-identical to what shipped, so an ordinary
/// launch's summon behaviour is unchanged by the scope work.
pub const SUMMON_EVENT_NAME: &str = "Local\\FlowMic.SummonMainWindow";

/// Second-launch side: tell the running instance to surface its main window.
/// `true` = the event existed and was set (the running instance WILL see it);
/// `false` = no listener event found / set failed — the caller records that
/// loudly, because it means the old silent-no-op behavior just happened.
///
/// Takes the scope so a tagged second instance signals ITS own peer. Without
/// that, a developer's isolated instance would raise the ordinary instance's
/// window — a second-order version of the same「two copies believed they were
/// the same product」bug this card exists to remove.
pub fn signal_running_instance(scope: &InstanceScope) -> bool {
    signal_summon_event(&scope.summon_event_name)
}

/// Running-instance side: create the event NOW (synchronously, so the window
/// between「lock held」and「listener exists」is as small as it can be) and park
/// a thread on it; every signal invokes `on_summon`. Returns whether the
/// listener is actually up — `false` must be recorded by the caller (a missing
/// listener silently restores the no-op the card exists to kill).
pub fn spawn_summon_listener(scope: &InstanceScope, on_summon: impl Fn() + Send + 'static) -> bool {
    spawn_summon_listener_named(&scope.summon_event_name, on_summon)
}

#[cfg(windows)]
fn signal_summon_event(name: &str) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenEventW, SetEvent, EVENT_MODIFY_STATE};
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    // No listener yet (first instance still between lock and setup, or a
    // pre-U10 build) → OpenEventW fails and the answer is an honest `false`.
    let Ok(handle) = (unsafe { OpenEventW(EVENT_MODIFY_STATE, false, PCWSTR(wide.as_ptr())) })
    else {
        return false;
    };
    let set_ok = unsafe { SetEvent(handle) }.is_ok();
    let _ = unsafe { CloseHandle(handle) };
    set_ok
}

#[cfg(windows)]
fn spawn_summon_listener_named(name: &str, on_summon: impl Fn() + Send + 'static) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::WAIT_OBJECT_0;
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject, INFINITE};
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    // Auto-reset (bManualReset=false): each SetEvent wakes exactly one wait and
    // re-arms, so every second launch produces one summon.
    let Ok(handle) = (unsafe { CreateEventW(None, false, false, PCWSTR(wide.as_ptr())) }) else {
        return false;
    };
    // HANDLE is a raw pointer (not Send); carry it across as usize. The handle
    // is owned by the listener thread for the life of the process — the kernel
    // object dies with the process, so there is deliberately no teardown path.
    let raw = handle.0 as usize;
    std::thread::Builder::new()
        .name("summon-listener".into())
        .spawn(move || {
            let handle = windows::Win32::Foundation::HANDLE(raw as *mut core::ffi::c_void);
            loop {
                if unsafe { WaitForSingleObject(handle, INFINITE) } != WAIT_OBJECT_0 {
                    // WAIT_FAILED/abandoned on an event we own = the handle is
                    // gone; spinning here would burn a core. Park permanently —
                    // the OS reclaims the thread at exit.
                    return;
                }
                on_summon();
            }
        })
        .is_ok()
}

/// Non-Windows (dev/CI only — no tray, no second-launch story): honest no-ops.
#[cfg(not(windows))]
fn signal_summon_event(_name: &str) -> bool {
    false
}

#[cfg(not(windows))]
fn spawn_summon_listener_named(_name: &str, _on_summon: impl Fn() + Send + 'static) -> bool {
    false
}

/// Why there is no summon listener — because `false` was being asked to answer
/// two different questions and could only ever tell the truth about one.
///
/// 🔴 Found in the first real macOS launch [measured 2026-08-07, Mac mini]. The
/// forensic log said:
///   `summon listener FAILED to start — a second launch will not surface this window`
/// **Nothing failed.** The listener is a named Win32 event object; off Windows
/// `spawn_summon_listener_named` returns `false` unconditionally because the
/// mechanism does not exist there. The caller had a bool meaning 「有没有监听器」
/// ("whether there is a listener")
/// and printed a sentence meaning 「有没有出错」("whether there was an error") — the two coincide on Windows and
/// come apart everywhere else, so the record accused the platform of a fault it
/// did not have.
///
/// This is the vol. 15 R11 shape in miniature: the layer writing the sentence did
/// not hold the fact its sentence depended on. The fix is to hand it that fact
/// rather than to reword the sentence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SummonListener {
    /// Listening — a second launch will surface the running window.
    Running,
    /// Tried and could not. A real fault worth reporting as one.
    Failed,
    /// This platform has no summon mechanism at all. Not a fault: the second
    /// launch still exits (the lock does that), it just cannot raise the window.
    /// macOS's equivalent would be `NSApplication` reopen handling, which is a
    /// product decision that has not been made — registered, not invented.
    UnsupportedOnThisPlatform,
}

/// Start the listener and say precisely what happened.
pub fn spawn_summon_listener_status(
    scope: &InstanceScope,
    on_summon: impl Fn() + Send + 'static,
) -> SummonListener {
    if cfg!(windows) {
        if spawn_summon_listener(scope, on_summon) {
            SummonListener::Running
        } else {
            SummonListener::Failed
        }
    } else {
        // Deliberately does not call through: off Windows the callee is a
        // `false` constant, and running it would only launder that constant into
        // something that looks measured.
        let _ = on_summon;
        SummonListener::UnsupportedOnThisPlatform
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_lock(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("flowmic-si-test-{tag}.lock"))
    }

    #[test]
    fn first_acquire_succeeds() {
        let p = temp_lock("first");
        let _ = std::fs::remove_file(&p);
        let lock = acquire(&p);
        assert!(lock.is_some(), "the first instance must acquire the lock");
        assert_eq!(lock.as_ref().unwrap().path(), Some(p.as_path()));
    }

    // ── the identity is no longer a path ────────────────────────────────────

    /// 🔴 THE CARD, ASSERTED AS A PROPERTY RATHER THAN AS A STRING. A test that
    /// only said「the mutex name is X」would still have been green on the broken
    /// design, because the broken design ALSO had a stable name — it just had a
    /// stable name per `%APPDATA%`. The criterion has to be「the identity does
    /// not contain any path the environment can move」, which means checking it.
    #[test]
    fn the_instance_identity_contains_no_environment_derived_path() {
        let scope = resolve_scope(None, 41879, 41879).expect("the ordinary launch always resolves");
        assert_eq!(scope.tag, None);
        assert_eq!(scope.mutex_name, SINGLE_INSTANCE_MUTEX);
        // The two env vars whose redirection produced the reported hazard, plus
        // the two nearest neighbours somebody would reach for next.
        for var in ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "TEMP", "TMP", "HOME"] {
            if let Ok(val) = std::env::var(var) {
                if val.len() < 3 {
                    continue; // a degenerate value would match everything
                }
                assert!(
                    !scope.mutex_name.contains(&val),
                    "the instance identity embeds %{var}% — redirecting it forks the identity, which is the whole defect"
                );
            }
        }
        // …and it must still be scoped to the logon session, not machine-wide:
        // `Global\` would make one user's FlowMic refuse another user's.
        assert!(scope.mutex_name.starts_with("Local\\"), "{}", scope.mutex_name);
        assert!(scope.summon_event_name.starts_with("Local\\"), "{}", scope.summon_event_name);
    }

    /// The escape hatch, and the coupling that makes it safe. Both halves are
    /// asserted, because the dangerous configuration is the one that LOOKS
    /// isolated: a second identity sharing the first one's port.
    #[test]
    fn a_second_instance_is_possible_only_when_it_is_asked_for_and_given_its_own_port() {
        // Asked for + own port → granted, with every channel name separated.
        let dev = resolve_scope(Some("dev"), 41880, 41879).expect("a tagged scope on its own port is legitimate");
        assert_eq!(dev.tag.as_deref(), Some("dev"));
        let plain = resolve_scope(None, 41879, 41879).unwrap();
        assert_ne!(dev.mutex_name, plain.mutex_name, "the two instances must not refuse each other");
        assert_ne!(
            dev.summon_event_name, plain.summon_event_name,
            "a tagged instance's second launch must not raise the ordinary instance's window"
        );
        assert_ne!(dev.mutex_name, dev.summon_event_name);
        // The lock-file name is separated too, for the platforms that still use one.
        assert_ne!(default_lock_path(Some("dev")), default_lock_path(None));

        // Asked for WITHOUT its own port → refused. This is the assertion that
        // encodes「the port is what makes it safe」.
        let err = resolve_scope(Some("dev"), 41879, 41879).unwrap_err();
        assert_eq!(err, ScopeError::TagWithoutOwnPort { tag: "dev".to_string(), port: 41879 });
        let msg = err.to_string();
        assert!(msg.contains(crate::sidecar::io::SIDECAR_PORT_ENV), "the refusal must name the way out: {msg}");
        assert!(msg.contains("taskkill"), "the refusal must say what it is preventing: {msg}");
    }

    /// A tag is a kernel object name fragment, not free text. `\` is the
    /// namespace separator — a tag containing one would not name a different
    /// object, it would name an object in a different NAMESPACE, which is a
    /// silent way to lose the exclusion entirely.
    #[test]
    fn an_unusable_tag_is_refused_by_name_rather_than_sanitised() {
        assert_eq!(resolve_scope(Some(""), 41880, 41879), Err(ScopeError::EmptyTag));
        assert_eq!(resolve_scope(Some("   "), 41880, 41879), Err(ScopeError::EmptyTag));
        for bad in ["a\\b", "a/b", "Global\\x", "a b", "ünïcode", &"x".repeat(33)] {
            let got = resolve_scope(Some(bad), 41880, 41879);
            assert!(matches!(got, Err(ScopeError::IllegalTag(_))), "{bad:?} → {got:?}");
        }
        for ok in ["dev", "DEV-2", "lane_3", "a", &"x".repeat(32)] {
            assert!(resolve_scope(Some(ok), 41880, 41879).is_ok(), "{ok:?} should be usable");
        }
    }

    /// The Windows identity really excludes — same shape as the file-lock test
    /// right above, on the mechanism that replaced it. A unique per-process name
    /// so concurrent test runs cannot cross-claim.
    #[cfg(windows)]
    #[test]
    fn the_named_mutex_refuses_a_second_claim_and_frees_on_drop() {
        let scope = InstanceScope {
            tag: Some("test".to_string()),
            mutex_name: format!("Local\\FlowMic.SingleInstanceTest.{}", std::process::id()),
            summon_event_name: format!("Local\\FlowMic.SummonTest.{}", std::process::id()),
        };
        let first = acquire_instance(&scope).expect("the first claim must succeed");
        assert!(first.describe().contains("named mutex"), "{}", first.describe());
        assert_eq!(first.path(), None, "a named object has no path to report");
        assert!(acquire_instance(&scope).is_none(), "a second claim must be refused");
        drop(first);
        // …and the identity is reusable once the holder is gone — the property a
        // pidfile cannot offer after a crash, carried over from the file lock.
        assert!(acquire_instance(&scope).is_some(), "the identity must free on release");
    }

    /// 🔴 MAC-07 —— **this test used to carry `#[cfg(windows)]`, and that gate was
    /// itself the shape of the defect**:
    /// it is not that 「this property is only required on Windows」, but that
    /// 「the non-Windows implementation always acquires,
    /// so this would go red the moment the gate was lifted」. ⇒ **the gate was
    /// removed, meaning this property now holds on every platform**,
    /// and the first time it ran on mac WAS the MAC-07 evidence itself.
    /// (flock is bound to the open file description, and two independent `open`
    /// calls are two different fds ⇒ a real
    /// conflict happens even within the same process, so this test can catch real
    /// mutual exclusion without forking a child process.)
    #[test]
    fn second_acquire_is_refused_while_the_first_is_held() {
        let p = temp_lock("second");
        let _ = std::fs::remove_file(&p);
        let first = acquire(&p).expect("first acquires");
        assert!(acquire(&p).is_none(), "a second instance must be refused");
        drop(first);
        // …and once the holder is gone the lock is free again — the property a
        // pidfile cannot offer after a crash.
        assert!(acquire(&p).is_some(), "the lock must be reusable after release");
    }

    /// U10 — the whole headless-testable half of the card: signal → listener →
    /// callback. A unique per-process event name so parallel/concurrent test
    /// runs cannot cross-signal; production uses the fixed SUMMON_EVENT_NAME on
    /// both sides (lib.rs run(): refused branch signals, setup branch listens).
    /// What this cannot prove headlessly: that `show_main_window` visibly
    /// surfaces the window — that is real-machine-only and reported as such.
    #[cfg(windows)]
    #[test]
    fn a_second_launch_signal_reaches_the_running_instances_listener() {
        use std::sync::mpsc;
        use std::time::Duration;

        let name = format!("Local\\FlowMic.SummonTest.{}", std::process::id());

        // Order matters and is the production order reversed first: with NO
        // listener yet, signaling must answer false (that is the honest branch
        // the refused instance records as「NO LISTENER FOUND」).
        assert!(
            !signal_summon_event(&name),
            "signaling with no listener must report failure, not fake a summon"
        );

        let (tx, rx) = mpsc::channel::<()>();
        assert!(
            spawn_summon_listener_named(&name, move || {
                let _ = tx.send(());
            }),
            "the running instance's listener must come up"
        );

        // The second launch's click.
        assert!(signal_summon_event(&name), "the second launch must find the event");
        rx.recv_timeout(Duration::from_secs(5))
            .expect("the summon callback must fire — this is U10's entire mechanism");

        // Auto-reset: a THIRD launch summons again (each click = one surface).
        assert!(signal_summon_event(&name));
        rx.recv_timeout(Duration::from_secs(5))
            .expect("every subsequent second-launch must summon again");
    }
}
