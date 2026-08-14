// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §3 (event-driven focus tracker:
//     SetWinEventHook EVENT_SYSTEM_FOREGROUND, OUTOFCONTEXT|SKIPOWNPROCESS;
//     process name = QueryFullProcessImageNameW basename minus .exe;
//     SetForegroundWindow for Stage-1 inject focus)
//   packages/protocol/src/protocol-schemas-focus.ts (process_name carries the
//     basename VERBATIM — `explorer`, never `explorer.exe`)
//
// FocusTracker bridges Win32's SetWinEventHook to a channel of FocusEvent. The
// hook callback runs on the OS message-pump thread; each notification is
// marshalled into ForegroundChanged and sent down the channel.
//
// NOTE vs the legacy line: the channel is std `sync_channel` (bounded, try_send
// drop-on-backpressure) rather than a tokio mpsc — the mechanism (hook →
// callback → bounded channel → consumer) is identical, but keeping it in std
// lets the whole crate stay tokio-free. `WinEventSource` is the DI seam so no
// test ever installs a real Win32 hook.

use crate::focus::state::FocusEvent;
use std::sync::mpsc::SyncSender;

/// Opaque RAII handle keeping the OS-level hook alive. Drop = unhook.
pub trait HookHandle: Send {}

/// Pluggable producer of FocusEvent values. Production uses
/// WindowsWinEventSource; tests use a fake. The trait keeps Win32 out of tests.
pub trait WinEventSource: Send {
    /// Wire `sender` to the source; the returned handle releases the OS
    /// resource on drop. The source MUST send `ForegroundChanged` only.
    fn install(&self, sender: SyncSender<FocusEvent>) -> Box<dyn HookHandle>;

    /// Synchronous cold-read of the CURRENT foreground window — seeds the
    /// bridge before the first hook callback fires (the hook only delivers NEW
    /// changes). `None` when nothing is foreground (lock screen / non-Windows).
    fn seed_current(&self) -> Option<FocusEvent>;
}

/// Async-free receiver wrapper. Hold it for as long as you want OS focus
/// events; dropping it releases the hook.
pub struct FocusTracker {
    rx: std::sync::mpsc::Receiver<FocusEvent>,
    _hook: Box<dyn HookHandle>,
}

impl FocusTracker {
    /// Foreground events fire at most a few Hz; 64 is comfortably over-provisioned.
    pub const CHANNEL_CAPACITY: usize = 64;

    pub fn start<S: WinEventSource + 'static>(source: S) -> Self {
        let (tx, rx) = std::sync::mpsc::sync_channel(Self::CHANNEL_CAPACITY);
        let hook = source.install(tx);
        Self { rx, _hook: hook }
    }

    /// Block for the next focus event, or `None` when the source dropped the
    /// sender (shutdown).
    pub fn next_event(&self) -> Option<FocusEvent> {
        self.rx.recv().ok()
    }

    /// Non-blocking poll for a pending focus event.
    pub fn try_next_event(&self) -> Option<FocusEvent> {
        self.rx.try_recv().ok()
    }
}

// ─── Win32 production source (windows-only) ────────────────────────────

#[cfg(target_os = "windows")]
mod win32 {
    use super::*;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::sync::{Mutex, OnceLock};
    use std::sync::mpsc::TrySendError;
    use windows::Win32::Foundation::{HMODULE, HWND};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        SetForegroundWindow, EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT,
        WINEVENT_SKIPOWNPROCESS,
    };

    /// Win32 callbacks are bare extern "system" fns with no user-data slot, so
    /// the subscribers are stashed here.
    ///
    /// v0.2.6 — this was a `OnceLock<SyncSender<…>>`, i.e. exactly ONE
    /// subscriber, and `install` discarded the second registration with
    /// `let _ = SENDER.set(sender)`. GA-28 made both channels resident, so
    /// `socket::connect` runs TWICE and calls `FocusTracker::start` twice: the
    /// first channel's sender won the lock and the second channel's receiver was
    /// wired to a sender nobody would ever use again.
    ///
    /// The consequence was not subtle and was not cosmetic. The second channel's
    /// pump never drained a single focus event, so its FSM had no target,
    /// forever — and EVERY inject arriving on that channel resolved
    /// `INJECT_FOCUS_LOST / cached`. Which channel lost depended only on connect
    /// order (owner 2026-07-29: 「sending images looks like it isn't working」 — reproduced headlessly,
    /// where text failed identically, which is what proved it was not an image
    /// bug at all).
    ///
    /// Nothing reported it: `let _ = …set()` throws the `Err` away, and a pump
    /// that receives nothing looks exactly like a desktop nobody has clicked on.
    ///
    /// A Vec of senders, one hook. The list self-prunes: a `try_send` to a
    /// dropped receiver returns `Disconnected`, which is how a retired channel
    /// removes itself without any teardown bookkeeping.
    static SENDERS: OnceLock<Mutex<Vec<SyncSender<FocusEvent>>>> = OnceLock::new();

    /// The ONE process-wide hook. Installed on first subscribe; deliberately
    /// never unhooked while the process lives, because a second subscriber must
    /// not be able to remove the first one's delivery path (the previous code
    /// installed a hook per subscriber, so each event was also delivered N
    /// times).
    static HOOK: OnceLock<WinEventHookHandle> = OnceLock::new();

    fn senders() -> &'static Mutex<Vec<SyncSender<FocusEvent>>> {
        SENDERS.get_or_init(|| Mutex::new(Vec::new()))
    }

    /// Process-wide hook token kept in `HOOK` for the process lifetime.
    /// The inner handle is intentionally unread: we deliberately never call
    /// `UnhookWinEvent` (see `HOOK` above), so this exists only as ownership
    /// proof that the OS hook stays registered — not a lost read site.
    pub struct WinEventHookHandle {
        _raw: HWINEVENTHOOK,
    }
    unsafe impl Send for WinEventHookHandle {}
    unsafe impl Sync for WinEventHookHandle {}

    /// What a subscriber holds. Owns nothing: the hook is process-wide and the
    /// subscriber's sender is pruned by the callback once its receiver is gone.
    pub struct SubscriberHandle;
    impl HookHandle for SubscriberHandle {}


    pub struct WindowsWinEventSource;

    impl WinEventSource for WindowsWinEventSource {
        fn install(&self, sender: SyncSender<FocusEvent>) -> Box<dyn HookHandle> {
            // EVERY subscriber is kept, not just the first — see SENDERS.
            match senders().lock() {
                Ok(mut v) => v.push(sender),
                Err(p) => p.into_inner().push(sender),
            }
            HOOK.get_or_init(|| {
                // SAFETY: valid extern "system" callback + null HMODULE;
                // OUTOFCONTEXT fires on the installer's thread, no DLL injection.
                let raw = unsafe {
                    SetWinEventHook(
                        EVENT_SYSTEM_FOREGROUND,
                        EVENT_SYSTEM_FOREGROUND,
                        HMODULE::default(),
                        Some(win_event_proc),
                        0,
                        0,
                        WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
                    )
                };
                if raw.is_invalid() {
                    // Fail LOUD. A hook that did not install means the whole
                    // injection feature is dead, and the only previous symptom
                    // was 「injection failed」 on every single utterance.
                    crate::forensic::record(
                        "focus",
                        "SetWinEventHook FAILED — foreground tracking is dead, every inject will report INJECT_FOCUS_LOST",
                    );
                } else {
                    crate::forensic::record("focus", "foreground hook installed (process-wide)");
                }
                WinEventHookHandle { _raw: raw }
            });
            // The hook outlives every individual subscriber, so a subscriber's
            // handle owns nothing. Dropping a tracker just closes its receiver,
            // and the next event prunes its sender.
            Box::new(SubscriberHandle)
        }

        fn seed_current(&self) -> Option<FocusEvent> {
            let hwnd = unsafe { GetForegroundWindow() };
            extract_foreground_event(hwnd)
        }
    }

    unsafe extern "system" fn win_event_proc(
        _hook: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        _id_object: i32,
        _id_child: i32,
        _id_event_thread: u32,
        _dwms_event_time: u32,
    ) {
        if event != EVENT_SYSTEM_FOREGROUND {
            return;
        }
        let extracted = extract_foreground_event(hwnd);
        // v0.2.6 — the ONE line that tells 「the hook never fired」 apart from 「it fired
        // and was filtered」
        // apart from 「it fired but nobody drained it」. Foreground changes happen a few times a
        // minute, so this is a bounded record, and it doubles as the history of
        // what the inject layer was ever aiming at.
        crate::forensic::record(
            "focus",
            &match &extracted {
                Some(FocusEvent::ForegroundChanged { app_name, .. }) => {
                    format!("foreground → {app_name}")
                }
                _ => "foreground event IGNORED (own window / null hwnd)".to_string(),
            },
        );
        let Some(fg) = extracted else { return };
        let Ok(mut list) = senders().lock().or_else(|p| Ok::<_, ()>(p.into_inner())) else { return };
        // Fan out to EVERY resident channel's pump, and prune the ones whose
        // receiver has gone. `try_send` rather than `send`: drop the event
        // rather than block the OS message pump on a slow consumer —
        // sub-millisecond duplicates are the same window anyway.
        list.retain(|tx| !matches!(tx.try_send(fg.clone()), Err(TrySendError::Disconnected(_))));
    }

    /// Shared extractor used by both the hook callback and the cold-read seed.
    /// `None` for a null HWND (lock screen / no foreground window).
    /// Does `hwnd` belong to THIS process?
    ///
    /// v0.2.2. Nothing anywhere excluded our own windows from being an injection
    /// target, so FlowMic's main window could become one — and does, in a case
    /// that is not exotic at all: the user is looking at the timeline, sends a
    /// picture from the phone, and the manual-delivery path (no `audio:start`,
    /// so no SPEAKING lock) resolves the LIVE foreground, which is us. Ctrl+V
    /// then goes into our own WebView, no target ever reads the clipboard, and
    /// the user is told 「injection failed」 about an app they never aimed at.
    ///
    /// Injecting into ourselves is never what anyone means: the whole product is
    /// 「speak on the phone → the program you are currently using」, and FlowMic is by definition not that
    /// program. The capsule is already non-activating for the same reason; the
    /// main window just never got the same treatment.
    fn is_own_window(hwnd: HWND) -> bool {
        use windows::Win32::System::Threading::GetCurrentProcessId;
        let mut pid: u32 = 0;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32)) };
        pid != 0 && pid == unsafe { GetCurrentProcessId() }
    }

    fn extract_foreground_event(hwnd: HWND) -> Option<FocusEvent> {
        if hwnd.0.is_null() {
            return None;
        }
        // Our own windows are not a foreground the inject layer may aim at, and
        // they must not pollute the `last_foreground` sidecar either — glancing
        // at FlowMic would otherwise erase the app you were actually working in.
        // `None` is the honest answer and every caller already handles it:
        // `audio:start` skips the lock ("a following inject caches"), and a
        // manual delivery reports `cached` instead of pasting into us.
        if is_own_window(hwnd) {
            return None;
        }
        Some(FocusEvent::ForegroundChanged {
            hwnd: hwnd.0 as usize as u64,
            app_name: current_app_name_inner(hwnd),
            window_title: current_window_title_inner(hwnd),
        })
    }

    fn current_window_title_inner(hwnd: HWND) -> String {
        let len = unsafe { GetWindowTextLengthW(hwnd) };
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; (len as usize) + 1];
        let copied = unsafe { GetWindowTextW(hwnd, &mut buf) } as usize;
        OsString::from_wide(&buf[..copied]).to_string_lossy().into_owned()
    }

    fn current_app_name_inner(hwnd: HWND) -> String {
        let mut pid: u32 = 0;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32)) };
        if pid == 0 {
            return String::new();
        }
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) };
        let handle = match process {
            Ok(h) => h,
            Err(_) => return String::new(),
        };
        let mut buf = vec![0u16; 1024];
        let mut size: u32 = buf.len() as u32;
        let res = unsafe {
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_FORMAT(0),
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut size,
            )
        };
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(handle);
        }
        if res.is_err() {
            return String::new();
        }
        let full = OsString::from_wide(&buf[..size as usize]).to_string_lossy().into_owned();
        // Strip directory + extension → executable basename ("explorer", not
        // "explorer.exe"): the process_name the focus:state mirror carries.
        let basename = full.rsplit(['\\', '/']).next().unwrap_or(&full);
        basename.trim_end_matches(".exe").to_string()
    }

    pub fn current_window_title(hwnd: u64) -> String {
        let h = HWND(hwnd as *mut _);
        if h.0.is_null() {
            return String::new();
        }
        current_window_title_inner(h)
    }

    pub fn current_app_name(hwnd: u64) -> String {
        let h = HWND(hwnd as *mut _);
        if h.0.is_null() {
            return String::new();
        }
        current_app_name_inner(h)
    }

    /// Stage-1 force-switch of the OS foreground onto `hwnd` before SendInput.
    /// `true` on success; `false` when the OS refused (null/destroyed HWND,
    /// foreground-lock timeout). The caller MUST surface INJECT_FOCUS_LOST on
    /// `false` — never silently inject into an arbitrary window.
    pub fn set_foreground_window(hwnd: u64) -> bool {
        if hwnd == 0 {
            return false;
        }
        let h = HWND(hwnd as *mut _);
        unsafe { SetForegroundWindow(h).as_bool() }
    }

    /// The LIVE OS foreground HWND (0 when none) — used to resolve the inject
    /// target when there is no SPEAKING lock (this card has no audio session).
    pub fn current_foreground_hwnd() -> u64 {
        let h = unsafe { GetForegroundWindow() };
        h.0 as u64
    }

    /// Convenience: current foreground as (hwnd, title, process_name), or None.
    pub fn current_foreground_target() -> Option<(u64, String, String)> {
        let hwnd = unsafe { GetForegroundWindow() };
        match extract_foreground_event(hwnd) {
            Some(FocusEvent::ForegroundChanged {
                hwnd,
                app_name,
                window_title,
            }) => Some((hwnd, window_title, app_name)),
            _ => None,
        }
    }
}

#[cfg(target_os = "windows")]
pub use win32::{
    current_app_name, current_foreground_hwnd, current_foreground_target, current_window_title,
    set_foreground_window, WindowsWinEventSource,
};

// ─── macOS production source (MAC-04) ──────────────────────────────────
//
// Same trait, same channel, same fan-out discipline; a different OS underneath.
// The implementation is a sibling FILE rather than an inline `mod mac` beside
// `mod win` only because this one is already 560 lines and the 800-line cap is a
// hard lint (verify/lint/file-size.mjs).
//
// 🔴 THE u64 SLOT CARRIES A **pid** ON macOS, NOT A WINDOW HANDLE, and the
// window_title is always "". Both are stated at `FocusEvent::ForegroundChanged`
// in state.rs as well, because that is where a reader meets the field. macOS
// activation is APP-level and there is no permission-free way to name or raise a
// single window of another process — see `focus/macos.rs` for the whole account.
#[cfg(target_os = "macos")]
pub use crate::focus::macos::{
    current_app_name, current_foreground_hwnd, current_foreground_target, current_window_title,
    set_foreground_window, WindowsWinEventSource,
};

// ─── Every OTHER host: no-op impls so cargo check / test pass on CI ─────
//
// ⚠️ CORRECTED IN PLACE 2026-08-07: this block used to be `cfg(not(target_os = "windows"))`
// and its heading read 「Non-Windows」. That was true until macOS got a real
// source; leaving it would have made the two arms fight over the same symbols.
// The no-ops themselves are unchanged — and note what they are: an honest 「this
// host has no window manager to ask」, NOT the friendly-empty-implementation shape
// doc 13 §7 F1 ② forbids. `seed_current() → None` and `set_foreground_window() →
// false` both send the pipeline down its truthful cached path; they never claim a
// target that does not exist.

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
mod noop_nonwin {
    use super::*;

    pub struct WindowsWinEventSource;

    impl WinEventSource for WindowsWinEventSource {
        fn install(&self, _sender: SyncSender<FocusEvent>) -> Box<dyn HookHandle> {
            struct Noop;
            impl HookHandle for Noop {}
            Box::new(Noop)
        }
        fn seed_current(&self) -> Option<FocusEvent> {
            None
        }
    }

    pub fn current_window_title(_hwnd: u64) -> String {
        String::new()
    }
    pub fn current_app_name(_hwnd: u64) -> String {
        String::new()
    }
    pub fn set_foreground_window(_hwnd: u64) -> bool {
        false
    }
    pub fn current_foreground_hwnd() -> u64 {
        0
    }
    pub fn current_foreground_target() -> Option<(u64, String, String)> {
        None
    }
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
pub use noop_nonwin::{
    current_app_name, current_foreground_hwnd, current_foreground_target, current_window_title,
    set_foreground_window, WindowsWinEventSource,
};

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    // ── v0.2.6: EVERY resident channel must receive focus events ────────────
    //
    // GA-28 keeps both channels connected, so `socket::connect` — and with it
    // `FocusTracker::start` — runs TWICE. The Win32 source used to stash a
    // single sender in a `OnceLock` and DISCARD the second registration
    // (`let _ = SENDER.set(…)`), so whichever channel connected second had a
    // receiver wired to a sender nobody would ever use.
    //
    // That channel's pump then drained nothing, its FSM never acquired a target,
    // and every inject arriving on it resolved INJECT_FOCUS_LOST / cached —
    // silently, because an empty channel is indistinguishable from a desktop
    // nobody has clicked on. owner 2026-07-29 saw it as 「sending images looks like it isn't working」;
    // sending TEXT down the same path failed identically, which is what showed
    // it was never an image bug.
    //
    // A fan-out source cannot be tested through the real Win32 hook, so this
    // asserts the CONTRACT every source owes: two subscribers, both fed.

    /// A source that keeps every sender, like the fixed Win32 one.
    struct FanOutSource {
        senders: Arc<Mutex<Vec<SyncSender<FocusEvent>>>>,
    }
    struct NoopHandle;
    impl HookHandle for NoopHandle {}

    impl WinEventSource for FanOutSource {
        fn install(&self, sender: SyncSender<FocusEvent>) -> Box<dyn HookHandle> {
            self.senders.lock().unwrap().push(sender);
            Box::new(NoopHandle)
        }
        fn seed_current(&self) -> Option<FocusEvent> {
            None
        }
    }

    /// The pre-fix behaviour, kept as the NEGATIVE control: a source that keeps
    /// only the first sender. Without this the test above would pass against a
    /// broken implementation that merely happened to have one subscriber.
    struct FirstOnlySource {
        first: Arc<Mutex<Option<SyncSender<FocusEvent>>>>,
    }
    impl WinEventSource for FirstOnlySource {
        fn install(&self, sender: SyncSender<FocusEvent>) -> Box<dyn HookHandle> {
            let mut slot = self.first.lock().unwrap();
            if slot.is_none() {
                *slot = Some(sender);
            }
            Box::new(NoopHandle)
        }
        fn seed_current(&self) -> Option<FocusEvent> {
            None
        }
    }

    fn sample() -> FocusEvent {
        FocusEvent::ForegroundChanged {
            hwnd: 4242,
            app_name: "notepad.exe".into(),
            window_title: "Untitled - Notepad".into(),
        }
    }

    #[test]
    fn two_trackers_both_receive_every_event() {
        // The fix, stated as the property that was missing.
        let senders = Arc::new(Mutex::new(Vec::new()));
        let a = FocusTracker::start(FanOutSource { senders: senders.clone() });
        let b = FocusTracker::start(FanOutSource { senders: senders.clone() });

        for tx in senders.lock().unwrap().iter() {
            tx.try_send(sample()).expect("send");
        }
        assert!(a.try_next_event().is_some(), "channel A (connected first)");
        assert!(b.try_next_event().is_some(), "channel B — the one that used to be blind");
    }

    #[test]
    fn the_old_single_sender_shape_starves_the_second_channel() {
        // NEGATIVE CONTROL: this is what shipped, and what it did. If a future
        // change reintroduces a single-slot sender, the test above starts
        // failing and this one keeps passing — which names the regression
        // instead of leaving a green suite and a dead feature.
        let first = Arc::new(Mutex::new(None));
        let a = FocusTracker::start(FirstOnlySource { first: first.clone() });
        let b = FocusTracker::start(FirstOnlySource { first: first.clone() });

        first.lock().unwrap().as_ref().unwrap().try_send(sample()).expect("send");
        assert!(a.try_next_event().is_some());
        assert!(
            b.try_next_event().is_none(),
            "the second subscriber receives nothing — this is the bug, reproduced"
        );
    }

    /// Fake source that captures the sender so a test can drive OS foreground
    /// changes WITHOUT installing a real Win32 hook.
    struct FakeSource {
        captured: Arc<Mutex<Option<SyncSender<FocusEvent>>>>,
        seed: Option<FocusEvent>,
    }
    struct FakeHandle;
    impl HookHandle for FakeHandle {}

    impl WinEventSource for FakeSource {
        fn install(&self, sender: SyncSender<FocusEvent>) -> Box<dyn HookHandle> {
            *self.captured.lock().unwrap() = Some(sender);
            Box::new(FakeHandle)
        }
        fn seed_current(&self) -> Option<FocusEvent> {
            self.seed.clone()
        }
    }

    #[test]
    fn tracker_delivers_events_pushed_through_the_captured_sender() {
        let captured = Arc::new(Mutex::new(None));
        let source = FakeSource {
            captured: captured.clone(),
            seed: None,
        };
        let tracker = FocusTracker::start(source);
        let tx = captured.lock().unwrap().clone().expect("sender captured on install");
        tx.try_send(FocusEvent::ForegroundChanged {
            hwnd: 0x42,
            app_name: "notepad".into(),
            window_title: "Untitled - Notepad".into(),
        })
        .unwrap();
        match tracker.next_event() {
            Some(FocusEvent::ForegroundChanged { hwnd, app_name, .. }) => {
                assert_eq!(hwnd, 0x42);
                assert_eq!(app_name, "notepad", "basename, extension already stripped");
            }
            other => panic!("expected a ForegroundChanged, got {other:?}"),
        }
    }

    #[test]
    fn seed_current_is_read_through_the_source() {
        let source = FakeSource {
            captured: Arc::new(Mutex::new(None)),
            seed: Some(FocusEvent::ForegroundChanged {
                hwnd: 7,
                app_name: "explorer".into(),
                window_title: String::new(),
            }),
        };
        assert!(source.seed_current().is_some());
    }
}
