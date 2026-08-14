// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §3 (event-driven focus tracker: an OS event
//     source feeds ForegroundChanged; Stage-1 forces the OS foreground onto the
//     inject target before any keystroke)
//   docs/strategy/2026-08-06-mac-usable-work-breakdown.md §A MAC-04
//   packages/protocol/src/protocol-schemas-focus.ts (process_name carries the
//     executable basename VERBATIM)
//
// The macOS half of `focus::tracker`. It answers exactly the same two questions
// the Win32 half answers — 「which foreign program is in front of the user?」 and
// 「put that program in front again」 — through NSWorkspace instead of
// SetWinEventHook/SetForegroundWindow. The FSM, the channel, the fan-out
// discipline and the pipeline above it are byte-for-byte unchanged.
//
// ── 🔴 THE ONE THING THIS PLATFORM CANNOT DO, SAID OUT LOUD ──────────────────
//
// macOS activation is APP-LEVEL, not window-level. `NSRunningApplication`
// activates an application; there is no public, permission-free way to raise one
// specific window of another process, and there is no public, permission-free way
// to read another process's window TITLE either (the Accessibility API needs
// AXIsProcessTrusted, CGWindowListCopyWindowInfo's kCGWindowName needs Screen
// Recording). So:
//
//   · the u64 slot that carries an `HWND` on Windows carries a **pid** here. It
//     is the same slot because the FSM/pipeline treat it as an opaque token and
//     never dereference it — see `FocusEvent::ForegroundChanged` in state.rs,
//     which now says so at the field.
//   · `current_window_title` returns "" ALWAYS, and that is a structural answer
//     rather than a failure. It is the same value Win32 returns when it cannot
//     read a title, so every existing caller already handles it.
//   · every forensic line says 「app-level」 in words. A log that reads exactly
//     like the Windows one would imply a window granularity this code does not
//     have, and the next person to read it would build on that.
//
// NSWorkspace needs NO TCC permission — neither the activation notification nor
// `frontmostApplication` prompts for anything. (The synthetic keystroke DOES; that
// is `inject/macos/secure_input.rs`'s business, checked before any side effect.)
//
// ⚠️ THE EXPORTED NAME `WindowsWinEventSource` IS A HOLDOVER, not a claim. The
// seam (`WinEventSource`) is platform-neutral and its production type is named
// after the Win32 hook that was its first implementation; `socket/client.rs`
// constructs it by that name on every platform. Renaming the trait and the type
// would touch `socket/`, which the MAC-04 card may not — so the name stays and
// this paragraph is the correction (anti-façade ④: an out-of-date name is only
// dangerous when nothing says so).

use crate::focus::state::FocusEvent;
use crate::focus::tracker::{HookHandle, WinEventSource};
use std::ptr::NonNull;
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Mutex, OnceLock};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
use objc2_app_kit::{
    NSApplicationActivationOptions, NSRunningApplication, NSWorkspace,
    NSWorkspaceDidActivateApplicationNotification,
};
use objc2_foundation::NSNotification;

/// Every resident channel's sender, one observer — the same shape (and the same
/// reason) as the Win32 side's `SENDERS`.
///
/// GA-28 keeps BOTH channels connected, so `socket::connect` runs twice and calls
/// `FocusTracker::start` twice. A single-slot sender starves whichever channel
/// registered second, and a starved pump is indistinguishable from a desktop
/// nobody has clicked on — the v0.2.6 bug, reproduced in
/// `tracker.rs`'s `the_old_single_sender_shape_starves_the_second_channel`.
///
/// The list self-prunes: `try_send` to a dropped receiver returns `Disconnected`.
static SENDERS: OnceLock<Mutex<Vec<SyncSender<FocusEvent>>>> = OnceLock::new();

fn senders() -> &'static Mutex<Vec<SyncSender<FocusEvent>>> {
    SENDERS.get_or_init(|| Mutex::new(Vec::new()))
}

/// The ONE process-wide NSWorkspace observer, kept for the process lifetime and
/// deliberately never removed — a second subscriber must not be able to take the
/// first one's delivery path away (identical reasoning to `tracker.rs`'s `HOOK`).
struct ObserverToken(#[allow(dead_code)] Retained<ProtocolObject<dyn NSObjectProtocol>>);
// SAFETY: the token is only ever stored and dropped-never; it is not messaged
// from any thread after `install`. The observer registration itself is what keeps
// the notification alive, and NSNotificationCenter is documented thread-safe.
unsafe impl Send for ObserverToken {}
unsafe impl Sync for ObserverToken {}
static OBSERVER: OnceLock<ObserverToken> = OnceLock::new();

/// A subscriber owns nothing: the observer is process-wide and its sender is
/// pruned by the next event once its receiver is gone.
pub struct SubscriberHandle;
impl HookHandle for SubscriberHandle {}

/// The production focus source. See the module header for why the name is what
/// it is.
pub struct WindowsWinEventSource;

impl WinEventSource for WindowsWinEventSource {
    fn install(&self, sender: SyncSender<FocusEvent>) -> Box<dyn HookHandle> {
        match senders().lock() {
            Ok(mut v) => v.push(sender),
            Err(p) => p.into_inner().push(sender),
        }
        OBSERVER.get_or_init(|| {
            // The block ignores the notification payload and re-reads
            // `frontmostApplication`. The notification is the TRIGGER; the
            // workspace is the FACT. Reading the userInfo app instead would
            // answer 「who activated」, which is a different question from 「who is
            // in front right now」 and drifts from it the moment two activations
            // land back to back.
            let block = RcBlock::new(|_note: NonNull<NSNotification>| {
                on_frontmost_changed();
            });
            let workspace = NSWorkspace::sharedWorkspace();
            let center = workspace.notificationCenter();
            // SAFETY: a well-formed observer registration. `name` is the AppKit
            // constant, `obj`/`queue` are null (⇒ delivered synchronously on the
            // posting thread, which is AppKit's main thread), and the block is
            // 'static (it captures nothing and calls a free function).
            let token = unsafe {
                center.addObserverForName_object_queue_usingBlock(
                    Some(NSWorkspaceDidActivateApplicationNotification),
                    None,
                    None,
                    &block,
                )
            };
            crate::forensic::record(
                "focus",
                "NSWorkspace didActivateApplication observer installed (process-wide; \
                 app-level activation, no window granularity, no TCC permission needed)",
            );
            ObserverToken(token)
        });
        Box::new(SubscriberHandle)
    }

    fn seed_current(&self) -> Option<FocusEvent> {
        // Cold read of the CURRENT frontmost app: the observer only delivers NEW
        // activations, so without this the FSM has no candidate until the user
        // switches apps at least once.
        frontmost_event()
    }
}

/// The observer body. Split out of the block so the block itself holds nothing
/// and so this can be reasoned about (and forensically recorded) in one place.
fn on_frontmost_changed() {
    let extracted = frontmost_event();
    // The ONE line that tells 「the observer never fired」 apart from 「it fired and
    // was filtered」 apart from 「it fired and nobody drained it」. Activations
    // happen a few times a minute, so this is a bounded record, and it doubles as
    // the history of what the inject layer was ever aiming at.
    crate::forensic::record(
        "focus",
        &match &extracted {
            Some(FocusEvent::ForegroundChanged { app_name, hwnd, .. }) => format!(
                "frontmost app → {app_name} (pid={hwnd}; macOS activation is APP-level — no \
                 window is named here because none can be)"
            ),
            _ => "activation IGNORED (our own app / no frontmost application)".to_string(),
        },
    );
    let Some(event) = extracted else { return };
    let Ok(mut list) = senders().lock().or_else(|p| Ok::<_, ()>(p.into_inner())) else {
        return;
    };
    // Fan out to EVERY resident channel and prune the dead ones. `try_send`
    // rather than `send`: drop the event rather than block AppKit's main thread
    // on a slow consumer — sub-millisecond duplicates are the same app anyway.
    list.retain(|tx| !matches!(tx.try_send(event.clone()), Err(TrySendError::Disconnected(_))));
}

/// Is this pid our own process?
///
/// Our own windows are not a foreground the inject layer may aim at, and they must
/// not pollute the FSM's `last_foreground` either — glancing at FlowMic would
/// otherwise erase the app the user was actually working in. Same rule, same
/// reason, and the same `None` answer as `tracker.rs::is_own_window`.
fn is_own_pid(pid: i32) -> bool {
    pid > 0 && pid as u32 == std::process::id()
}

/// The frontmost application as a `FocusEvent`, or `None` when there is none or
/// it is us.
fn frontmost_event() -> Option<FocusEvent> {
    let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
    let pid = app.processIdentifier();
    if pid <= 0 || is_own_pid(pid) {
        return None;
    }
    Some(FocusEvent::ForegroundChanged {
        // 🔴 A PID, not a window handle. See the module header.
        hwnd: pid as u64,
        app_name: executable_basename(&app),
        // Structural, not a failure — macOS hands out no window title here.
        window_title: String::new(),
    })
}

/// The app's executable basename — `/Applications/TextEdit.app/Contents/MacOS/
/// TextEdit` → `TextEdit`.
///
/// Deliberately the EXECUTABLE name and not `localizedName`, and deliberately with
/// NO fallback to it: this value is the protocol's `process_name` and the
/// `AppLearningStore` key, and Win32 fills both from
/// `QueryFullProcessImageNameW`'s basename. One question, one source. An app whose
/// `executableURL` is nil answers "" — byte-for-byte what the Win32 side answers
/// when `OpenProcess`/`QueryFullProcessImageNameW` fails.
fn executable_basename(app: &NSRunningApplication) -> String {
    let Some(url) = app.executableURL() else {
        return String::new();
    };
    match url.lastPathComponent() {
        Some(name) => name.to_string(),
        None => String::new(),
    }
}

/// macOS exposes no window title for another process without Accessibility or
/// Screen-Recording permission, so this is "" ALWAYS and by construction.
///
/// It is not a stub waiting to be filled in: reading titles would move MAC-04 from
/// 「needs no permission」 to 「needs TCC」, which is a product decision and not a
/// gap in this file. Every caller already handles "" because Win32 returns it too
/// (`GetWindowTextLengthW <= 0`).
pub fn current_window_title(_pid: u64) -> String {
    String::new()
}

/// The executable basename for a pid, or "" when the process is gone.
pub fn current_app_name(pid: u64) -> String {
    let Ok(p) = i32::try_from(pid) else {
        return String::new();
    };
    match NSRunningApplication::runningApplicationWithProcessIdentifier(p) {
        Some(app) => executable_basename(&app),
        None => String::new(),
    }
}

/// Stage-1 force-switch: put the application that owns `pid` in front.
///
/// `true` = AppKit accepted the activation; `false` = the process is gone or the
/// OS refused. The caller MUST surface INJECT_FOCUS_LOST on `false` — never
/// silently paste into whatever happens to be in front (pipeline.rs `stage1_focus`).
///
/// ⚠️ WHAT `true` CLAIMS, EXACTLY: the APP was activated. Not 「that window is in
/// front」 — macOS activation brings the app's main and key windows forward and
/// there is no public way to name one specific window of another process. When the
/// target app is already frontmost (the common case: the user is typing in it and
/// speaks into the phone) this is a re-assert with no visible effect.
///
/// Options are deliberately EMPTY rather than `ActivateAllWindows`: raising every
/// window of the target is more disruption than 「give me back the app I was in」
/// asks for. `ActivateIgnoringOtherApps` is not used because macOS 14 deprecated it
/// and it has no effect there — using it would be a line that looks like a
/// guarantee and is not one.
pub fn set_foreground_window(pid: u64) -> bool {
    if pid == 0 {
        return false;
    }
    let Ok(p) = i32::try_from(pid) else {
        return false;
    };
    let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(p) else {
        crate::forensic::record(
            "focus",
            &format!("stage1 activate pid={p} FAILED — no running application with that pid"),
        );
        return false;
    };
    let ok = app.activateWithOptions(NSApplicationActivationOptions::empty());
    crate::forensic::record(
        "focus",
        &format!(
            "stage1 activate pid={p} → {ok} (APP-level activation; 「true」 means AppKit accepted \
             it, not that any particular window is in front)"
        ),
    );
    ok
}

/// The LIVE frontmost pid (0 when there is none).
///
/// Deliberately UNFILTERED — it is the direct analog of `GetForegroundWindow()` and
/// is read by `probe_diag`, which exists to report what is really there including
/// 「it is us」. The filtered answer is `current_foreground_target`.
pub fn current_foreground_hwnd() -> u64 {
    match NSWorkspace::sharedWorkspace().frontmostApplication() {
        Some(app) => {
            let pid = app.processIdentifier();
            if pid > 0 {
                pid as u64
            } else {
                0
            }
        }
        None => 0,
    }
}

/// Current foreground as `(pid, window_title, app_name)`, or `None` when there is
/// none or it is our own app. `window_title` is always "" — see
/// [`current_window_title`].
pub fn current_foreground_target() -> Option<(u64, String, String)> {
    match frontmost_event() {
        Some(FocusEvent::ForegroundChanged {
            hwnd,
            app_name,
            window_title,
        }) => Some((hwnd, window_title, app_name)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Our own process is never an inject target. This is the one branch of
    /// `frontmost_event` that can be proved without a desktop, and it is the one
    /// that matters: the day it inverts, a glance at FlowMic erases the app the
    /// user was really working in (`tracker.rs`'s `is_own_window` note, v0.2.2).
    #[test]
    fn our_own_pid_is_never_a_foreground_the_inject_layer_may_aim_at() {
        assert!(is_own_pid(std::process::id() as i32));
        assert!(!is_own_pid(0), "pid 0 is not a process");
        assert!(!is_own_pid(-1), "a negative pid is not a process");
        // Some other live pid — pid 1 (launchd) always exists and is never us.
        assert!(!is_own_pid(1), "launchd is not FlowMic");
    }

    /// The title is "" BY CONSTRUCTION, not by accident, and that has to be
    /// asserted rather than commented: a future 「casual completeness pass」 that starts returning a
    /// localizedName here would be putting an APP name in the WINDOW-title field —
    /// one value answering a question it was not asked.
    #[test]
    fn the_window_title_is_structurally_empty_on_macos() {
        for pid in [0u64, 1, 4242, u64::MAX] {
            assert_eq!(current_window_title(pid), "");
        }
    }

    /// pid 0 / an out-of-range pid must be refused BEFORE AppKit is asked. Stage 1
    /// reads `false` as INJECT_FOCUS_LOST, which is the truthful answer for 「there
    /// is no such process」.
    #[test]
    fn activation_refuses_a_pid_that_cannot_be_one() {
        assert!(!set_foreground_window(0), "pid 0 is not a target");
        assert!(
            !set_foreground_window(u64::MAX),
            "a pid that does not fit pid_t is not a target"
        );
    }

    /// A pid that is not running has no name — "" rather than a guess.
    #[test]
    fn an_unknown_pid_has_no_app_name() {
        // 0 is never a running application; u64::MAX cannot be a pid_t at all.
        assert_eq!(current_app_name(0), "");
        assert_eq!(current_app_name(u64::MAX), "");
    }
}
