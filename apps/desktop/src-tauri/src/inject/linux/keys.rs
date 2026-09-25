// SPEC-REF: Linux desktop L-4. XTEST keycodes are resolved from X keysyms;
// Win32 virtual-key numbers never reach XKeysymToKeycode. Snapshot the server's
// held modifiers and restore only what this operation changed. A server grab
// bounds that edit so another client's events cannot interleave its pairs.

use crate::focus::linux_session::{current_backend, DisplayBackend};
use crate::focus::linux_x11::Connection;
use crate::inject::flow_key::KeyChord;
use x11_dl::{keysym, xtest};

#[derive(Debug)]
pub(super) enum SubmitError {
    Before(String),
    Focus(String),
    Uncertain(String),
}
impl From<String> for SubmitError {
    fn from(value: String) -> Self {
        Self::Before(value)
    }
}
impl From<&str> for SubmitError {
    fn from(value: &str) -> Self {
        Self::Before(value.into())
    }
}

pub(super) fn send(
    connection: &Connection,
    chords: &[KeyChord],
    expected_target: u64,
    selection: Option<(x11_dl::xlib::Atom, x11_dl::xlib::Window)>,
) -> Result<(), SubmitError> {
    if current_backend() != DisplayBackend::X11 {
        return Err("synthetic keys require an established X11 session".into());
    }
    let api = xtest::Xf86vmode::open().map_err(|e| format!("load XTEST: {e}"))?;
    let (mut event, mut error, mut major, mut minor) = (0, 0, 0, 0);
    if unsafe {
        (api.XTestQueryExtension)(
            connection.display,
            &mut event,
            &mut error,
            &mut major,
            &mut minor,
        )
    } == 0
    {
        return Err("XTEST extension unavailable".into());
    }
    let code = |symbol: u16| -> Result<u8, String> {
        let code = unsafe { (connection.api.XKeysymToKeycode)(connection.display, symbol as _) };
        if code == 0 {
            Err(format!(
                "X keysym {symbol:#x} is absent from current keyboard map"
            ))
        } else {
            Ok(code)
        }
    };
    let mut resolved = Vec::new();
    for chord in chords {
        let key = code(chord.vk)?;
        let modifiers = chord
            .modifiers
            .iter()
            .map(|m| code(*m))
            .collect::<Result<Vec<_>, _>>()?;
        resolved.push((key, modifiers));
    }
    let modifier_symbols = [
        keysym::XK_Shift_L,
        keysym::XK_Shift_R,
        keysym::XK_Control_L,
        keysym::XK_Control_R,
        keysym::XK_Alt_L,
        keysym::XK_Alt_R,
        keysym::XK_Super_L,
        keysym::XK_Super_R,
        keysym::XK_Meta_L,
        keysym::XK_Meta_R,
        keysym::XK_ISO_Level3_Shift,
    ];
    let mut modifiers: Vec<_> = modifier_symbols
        .iter()
        .filter_map(|m| code(*m as u16).ok())
        .collect();
    modifiers.sort_unstable();
    modifiers.dedup();
    connection.sync()?;
    unsafe {
        (connection.api.XGrabServer)(connection.display);
    }
    struct Ungrab<'a>(&'a Connection);
    impl Drop for Ungrab<'_> {
        fn drop(&mut self) {
            unsafe {
                (self.0.api.XUngrabServer)(self.0.display);
                (self.0.api.XFlush)(self.0.display);
            }
        }
    }
    let _ungrab = Ungrab(connection);
    if expected_target == 0 || !connection.contains_focus(expected_target as _)? {
        return Err(SubmitError::Focus(
            "the Stage-1 target no longer contains keyboard focus; no keys sent".into(),
        ));
    }
    if let Some((selection, owner)) = selection {
        if unsafe { (connection.api.XGetSelectionOwner)(connection.display, selection) } != owner {
            return Err("clipboard ownership changed before keys; no keys sent".into());
        }
    }
    let mut state = [0i8; 32];
    unsafe {
        (connection.api.XQueryKeymap)(connection.display, state.as_mut_ptr());
    }
    connection.sync()?;
    let held = |key: u8| (state[key as usize / 8] as u8 & (1 << (key % 8))) != 0;
    if resolved.iter().any(|(key, _)| held(*key)) {
        return Err("flow-key primary key is physically held; no synthetic events sent".into());
    }
    let held_modifiers: Vec<_> = modifiers.iter().copied().filter(|m| held(*m)).collect();
    let mut rejected = false;
    let mut emit = |key: u8, down: bool| {
        if unsafe { (api.XTestFakeKeyEvent)(connection.display, key as _, i32::from(down), 0) } == 0
        {
            rejected = true;
        }
    };
    // Suppress the user's modifiers only for the synthetic chord; restore the
    // initial state before releasing the server. CapsLock/NumLock are toggles,
    // not held keys, and this path never toggles them.
    for modifier in &held_modifiers {
        emit(*modifier, false);
    }
    for (key, modifiers) in resolved {
        for modifier in &modifiers {
            emit(*modifier, true);
        }
        emit(key, true);
        emit(key, false);
        for modifier in modifiers.iter().rev() {
            emit(*modifier, false);
        }
    }
    for modifier in &held_modifiers {
        emit(*modifier, true);
    }
    #[cfg(test)]
    if TEST_POST_SUBMISSION_XERROR.swap(false, std::sync::atomic::Ordering::SeqCst) {
        // Real X server error, injected only by an explicit native test after
        // real key events. It exercises the actual asynchronous error handler.
        unsafe {
            (connection.api.XDestroyWindow)(connection.display, 0);
        }
    }
    connection.sync().map_err(SubmitError::Uncertain)?;
    if rejected {
        return Err(SubmitError::Uncertain(
            "XTEST rejected at least one key event; submission may be partial".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(super) static TEST_POST_SUBMISSION_XERROR: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
