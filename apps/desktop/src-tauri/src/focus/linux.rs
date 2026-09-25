// SPEC-REF: Linux milestone L-5; docs/rebuild/07-DESKTOP-SPEC.md §3.
// Each subscriber owns one connection and a stoppable poller. Both resident
// channels receive updates; no global first-subscriber-only sender exists.
// EWMH active-window state alone can be stale while a native Wayland app is
// active. A target is returned only when XGetInputFocus is in its window tree.

use super::linux_session::{current_backend, DisplayBackend};
use super::linux_x11::{Connection, Property};
use super::tracker::{HookHandle, WinEventSource};
use super::FocusEvent;
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use x11_dl::xlib;

#[cfg(test)]
#[path = "linux_live_tests.rs"]
mod live_tests;

pub struct WindowsWinEventSource;
struct PollHandle {
    stop: mpsc::Sender<()>,
    worker: Option<JoinHandle<()>>,
}
impl HookHandle for PollHandle {}
impl Drop for PollHandle {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl WinEventSource for WindowsWinEventSource {
    fn install(&self, sender: SyncSender<FocusEvent>) -> Box<dyn HookHandle> {
        let (stop, stopped) = mpsc::channel();
        let worker = std::thread::Builder::new().name("linux-focus".into()).spawn(move || {
            if current_backend() != DisplayBackend::X11 {
                crate::forensic::record("focus", "Linux focus source unavailable: selected backend is not X11");
                return;
            }
            let connection = match Connection::open() {
                Ok(connection) => connection,
                Err(error) => { crate::forensic::record("focus", &error); return; }
            };
            let mut last = None;
            let mut last_error = None;
            loop {
                let target = match target_with(&connection) {
                    Ok(target) => { last_error = None; target }
                    Err(error) => {
                        if last_error.as_ref() != Some(&error) {
                            crate::forensic::record("focus", &format!("Linux focus sample unavailable: {error}"));
                            last_error = Some(error);
                        }
                        None
                    }
                };
                if target != last {
                    if let Some((hwnd, title, app)) = &target {
                        let event = FocusEvent::ForegroundChanged { hwnd: *hwnd, window_title: title.clone(), app_name: app.clone() };
                        match sender.try_send(event) {
                            Ok(()) => crate::forensic::record("focus", &format!("Linux foreground xid={hwnd:#x} app={app} title={title}")),
                            Err(TrySendError::Full(_)) => {
                                crate::forensic::record("focus", "Linux foreground event not queued: subscriber full; retrying latest observation");
                                if stopped.recv_timeout(Duration::from_millis(50)).is_ok() { return; }
                                continue;
                            }
                            Err(TrySendError::Disconnected(_)) => return,
                        }
                    }
                    last = target;
                }
                if stopped.recv_timeout(Duration::from_millis(50)).is_ok() { return; }
            }
        });
        let worker = match worker {
            Ok(worker) => Some(worker),
            Err(error) => {
                crate::forensic::record("focus", &format!("Linux focus thread failed: {error}"));
                None
            }
        };
        Box::new(PollHandle { stop, worker })
    }

    fn seed_current(&self) -> Option<FocusEvent> {
        current_foreground_target().map(|(hwnd, window_title, app_name)| {
            FocusEvent::ForegroundChanged {
                hwnd,
                window_title,
                app_name,
            }
        })
    }
}

fn active_with(connection: &Connection) -> Result<u64, String> {
    let active = connection
        .property(connection.root, "_NET_ACTIVE_WINDOW")?
        .first_word()
        .unwrap_or(0);
    if active != 0 && connection.contains_focus(active)? {
        Ok(active)
    } else {
        Ok(0)
    }
}

fn pid_with(connection: &Connection, window: u64) -> Option<u32> {
    connection
        .property(window, "_NET_WM_PID")
        .ok()?
        .first_word()
        .and_then(|pid| u32::try_from(pid).ok())
}

fn title_with(connection: &Connection, window: u64) -> String {
    for name in ["_NET_WM_NAME", "WM_NAME"] {
        if let Some(text) = connection
            .property(window, name)
            .ok()
            .and_then(|value| value.text())
        {
            if !text.is_empty() {
                return text;
            }
        }
    }
    String::new()
}

fn app_with(connection: &Connection, window: u64) -> String {
    if let Some(pid) = pid_with(connection, window) {
        if let Ok(path) = std::fs::read_link(format!("/proc/{pid}/exe")) {
            if let Some(name) = path.file_name() {
                return name.to_string_lossy().into_owned();
            }
        }
    }
    match connection.property(window, "WM_CLASS") {
        Ok(Property::Bytes(bytes)) => bytes
            .split(|b| *b == 0)
            .find(|part| !part.is_empty())
            .map(|part| String::from_utf8_lossy(part).into_owned())
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn target_with(connection: &Connection) -> Result<Option<(u64, String, String)>, String> {
    let window = active_with(connection)?;
    if window == 0 || pid_with(connection, window) == Some(std::process::id()) {
        return Ok(None);
    }
    Ok(Some((
        window,
        title_with(connection, window),
        app_with(connection, window),
    )))
}

fn with_connection<T>(operation: &'static str, read: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    static FAILURES: OnceLock<Mutex<std::collections::HashMap<&'static str, String>>> = OnceLock::new();
    let result = if current_backend() != DisplayBackend::X11 {
        Err(format!("Linux focus requires X11; selected backend={:?}", current_backend()))
    } else {
        Connection::open().and_then(|connection| read(&connection))
    };
    let mut failures = FAILURES.get_or_init(Mutex::default).lock().unwrap_or_else(|e| e.into_inner());
    match &result {
        Ok(_) => { failures.remove(operation); }
        Err(error) if failures.get(operation) != Some(error) => {
            crate::forensic::record("focus", &format!("Linux {operation} unavailable: {error}"));
            failures.insert(operation, error.clone());
        }
        Err(_) => {}
    }
    result
}

pub fn current_foreground_hwnd() -> u64 {
    with_connection("foreground window", active_with).unwrap_or(0)
}
pub fn current_foreground_target() -> Option<(u64, String, String)> {
    with_connection("foreground target", target_with).ok().flatten()
}
pub fn current_window_title(hwnd: u64) -> String {
    with_connection("window title", |c| Ok(title_with(c, hwnd))).unwrap_or_default()
}
pub fn current_app_name(hwnd: u64) -> String {
    with_connection("application name", |c| Ok(app_with(c, hwnd))).unwrap_or_default()
}

/// Ask the WM to activate, then verify actual keyboard focus. No direct
/// XSetInputFocus fallback: that could bypass the WM and aim input incorrectly.
pub fn set_foreground_window(hwnd: u64) -> bool {
    if hwnd == 0 {
        return false;
    }
    let result = with_connection("activation", |connection| {
        let current = active_with(connection)?;
        if current == hwnd {
            return Ok(true);
        }
        // A stale saved XID must not pull focus away from an unobservable native
        // Wayland target. No live X11 focus means there is no safe activation.
        if current == 0 {
            return Ok(false);
        }
        let mut data = xlib::ClientMessageData::new();
        data.set_long(0, 1); // EWMH source: normal application.
        data.set_long(1, connection.server_time()? as _);
        let mut event = xlib::XEvent {
            client_message: xlib::XClientMessageEvent {
                type_: xlib::ClientMessage,
                serial: 0,
                send_event: 1,
                display: connection.display,
                window: hwnd,
                message_type: connection.atom("_NET_ACTIVE_WINDOW")?,
                format: 32,
                data,
            },
        };
        let sent = unsafe {
            (connection.api.XSendEvent)(
                connection.display,
                connection.root,
                0,
                xlib::SubstructureRedirectMask | xlib::SubstructureNotifyMask,
                &mut event,
            )
        };
        connection.sync()?;
        if sent == 0 {
            return Err("XSendEvent activation failed".into());
        }
        let deadline = Instant::now() + Duration::from_millis(300);
        while Instant::now() < deadline {
            if active_with(connection)? == hwnd {
                return Ok(true);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(false)
    });
    match result {
        Ok(value) => value,
        Err(error) => {
            crate::forensic::record(
                "focus",
                &format!("Linux activation refused xid={hwnd:#x}: {error}"),
            );
            false
        }
    }
}
