// SPEC-REF: Linux desktop milestone L-3/L-4; doc 07 §2 and doc 15 delivery truth.
// X11 selection ownership is a SERVICE, not a byte buffer. One persistent thread
// owns its display and answers consumers even after save → paste → restore ends.
// Native Wayland is refused before opening Xlib; XWayland availability alone is
// not permission to inject into the foreground Wayland application.

mod keys;
mod selection;
mod transfer;

use super::{ClipboardSnapshot, InjectError};
use crate::focus::linux_session::{current_backend, DisplayBackend};
use std::sync::{mpsc, OnceLock};

type Reply<T> = mpsc::Sender<Result<T, String>>;
enum Command {
    Save(Reply<ClipboardSnapshot>),
    Restore(ClipboardSnapshot, Reply<()>),
    Write(String, Reply<()>),
    Paste(
        String,
        std::time::Duration,
        u64,
        mpsc::Sender<Result<super::ConfirmOutcome, InjectError>>,
    ),
}

fn service() -> Result<&'static mpsc::Sender<Command>, InjectError> {
    if current_backend() != DisplayBackend::X11 {
        return Err(InjectError::Unsupported(
            "X11 clipboard requires an established X11 session",
        ));
    }
    static SERVICE: OnceLock<Result<mpsc::Sender<Command>, String>> = OnceLock::new();
    SERVICE
        .get_or_init(|| {
            let (send, receive) = mpsc::channel();
            let (ready_send, ready_receive) = mpsc::channel();
            std::thread::Builder::new()
                .name("flowmic-x11-selection".into())
                .spawn(move || match selection::Owner::open() {
                    Ok(mut owner) => {
                        if ready_send.send(Ok(())).is_err() {
                            return;
                        }
                        loop {
                            match receive.recv_timeout(std::time::Duration::from_millis(2)) {
                                Ok(Command::Save(reply)) => {
                                    let _ = reply.send(owner.save());
                                }
                                Ok(Command::Restore(snapshot, reply)) => {
                                    let _ = reply.send(owner.restore(snapshot));
                                }
                                Ok(Command::Write(text, reply)) => {
                                    let _ = reply.send(owner.write_text(&text));
                                }
                                Ok(Command::Paste(text, hold, target, reply)) => {
                                    let _ = reply.send(owner.paste(&text, hold, target));
                                }
                                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                                Err(mpsc::RecvTimeoutError::Timeout) => {}
                            }
                            if let Err(error) = owner.pump() {
                                crate::forensic::record(
                                    "inject",
                                    &format!("X11 clipboard event: {error}"),
                                );
                            }
                        }
                    }
                    Err(error) => {
                        let _ = ready_send.send(Err(error));
                    }
                })
                .map_err(|e| format!("start X11 clipboard thread: {e}"))?;
            ready_receive
                .recv()
                .map_err(|e| format!("X11 clipboard startup: {e}"))??;
            Ok(send)
        })
        .as_ref()
        .map_err(|e| failure(e))
}

fn failure(detail: &str) -> InjectError {
    crate::forensic::record("inject", &format!("X11 clipboard: {detail}"));
    InjectError::Native(detail.into())
}

fn request<T>(make: impl FnOnce(Reply<T>) -> Command) -> Result<T, InjectError> {
    let (reply, receive) = mpsc::channel();
    service()?
        .send(make(reply))
        .map_err(|e| failure(&e.to_string()))?;
    // No caller timeout: abandoning an in-flight mutation would let it happen
    // after a caller had already reported failure or started restoring.
    receive
        .recv()
        .map_err(|e| failure(&e.to_string()))?
        .map_err(|e| failure(&e))
}

pub fn save_clipboard() -> Result<ClipboardSnapshot, InjectError> {
    request(Command::Save)
}

pub fn restore_clipboard(snapshot: ClipboardSnapshot) -> Result<(), InjectError> {
    request(|reply| Command::Restore(snapshot, reply))
}

pub fn write_text(text: &str) -> Result<(), InjectError> {
    request(|reply| Command::Write(text.into(), reply))
}

pub fn write_clipboard_formats(_: Vec<(u32, Vec<u8>)>) -> Result<(), InjectError> {
    Err(InjectError::Unsupported(
        "Win32 clipboard format ids are not X11 targets; use write_text",
    ))
}

pub(crate) fn paste_with_target(
    text: &str,
    hold: std::time::Duration,
    expected_target: u64,
) -> Result<super::ConfirmOutcome, InjectError> {
    let (reply, receive) = mpsc::channel();
    service()?
        .send(Command::Paste(text.into(), hold, expected_target, reply))
        .map_err(|e| failure(&e.to_string()))?;
    receive.recv().map_err(|e| {
        InjectError::SubmissionUncertain(format!("X11 paste worker ended before result: {e}"))
    })?
}

pub(crate) fn send_chords(
    chords: &[super::KeyChord],
    expected_target: u64,
) -> Result<(), super::FlowKeyError> {
    if current_backend() != DisplayBackend::X11 {
        return Err(super::FlowKeyError::Native(
            "synthetic keys require an established X11 session".into(),
        ));
    }
    let connection =
        crate::focus::linux_x11::Connection::open().map_err(super::FlowKeyError::Native)?;
    keys::send(&connection, chords, expected_target, None).map_err(|error| match error {
        keys::SubmitError::Focus(detail) => super::FlowKeyError::TargetChanged(detail),
        keys::SubmitError::Before(detail) => super::FlowKeyError::Native(detail),
        keys::SubmitError::Uncertain(detail) => super::FlowKeyError::SubmissionUncertain(detail),
    })
}
