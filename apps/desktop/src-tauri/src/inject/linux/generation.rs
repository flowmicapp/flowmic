// SPEC-REF: L-3 same-XID copy protection. XFixes observes every server-side
// selection ownership change, including SetSelectionOwner to the same window.
// Querying an owner's TIMESTAMP alone leaves a race before the server grab;
// this subscribed event counter is drained after that grab has synchronized.
use crate::focus::linux_x11::Connection;
use std::cell::Cell;
use x11_dl::{xfixes, xlib};

pub(super) struct Monitor {
    _api: xfixes::Xlib,
    event_base: i32,
    window: xlib::Window,
    selection: xlib::Atom,
    revision: Cell<u64>,
}
impl Monitor {
    pub fn new(
        connection: &Connection,
        window: xlib::Window,
        selection: xlib::Atom,
    ) -> Result<Self, String> {
        let api = xfixes::Xlib::open()
            .map_err(|e| format!("XFixes selection generation unavailable: {e}"))?;
        let (mut event_base, mut error_base) = (0, 0);
        if unsafe {
            (api.XFixesQueryExtension)(connection.display, &mut event_base, &mut error_base)
        } == 0
        {
            return Err("XFixes required to protect external same-window clipboard copies".into());
        }
        let (mut major, mut minor) = (2, 0);
        if unsafe { (api.XFixesQueryVersion)(connection.display, &mut major, &mut minor) } == 0
            || major < 1
        {
            return Err("XFixes selection notification version unavailable".into());
        }
        // Xfixeswire.h: owner-set, selection-window-destroy, owner-client-close.
        unsafe {
            (api.XFixesSelectSelectionInput)(connection.display, window, selection, 1 | 2 | 4);
        }
        connection.sync()?;
        Ok(Self {
            _api: api,
            event_base,
            window,
            selection,
            revision: Cell::new(0),
        })
    }
    pub fn event(&self, event: &xlib::XEvent) -> bool {
        if event.get_type() != self.event_base {
            return false;
        }
        let notice = unsafe {
            &*(event as *const xlib::XEvent as *const xfixes::XFixesSelectionNotifyEvent)
        };
        if notice.window == self.window && notice.selection == self.selection {
            self.revision.set(self.revision.get().saturating_add(1));
        }
        true
    }
    pub fn current(&self, connection: &Connection) -> Result<u64, String> {
        connection.sync()?;
        loop {
            let mut event = unsafe { std::mem::zeroed() };
            if unsafe {
                (connection.api.XCheckTypedWindowEvent)(
                    connection.display,
                    self.window,
                    self.event_base,
                    &mut event,
                )
            } == 0
            {
                break;
            }
            self.event(&event);
        }
        Ok(self.revision.get())
    }
}
