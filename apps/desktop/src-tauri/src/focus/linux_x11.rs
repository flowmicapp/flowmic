// SPEC-REF: Linux milestone L-5. Xlib resources stay on their creating thread.
// BadWindow is expected when an external application closes between two reads;
// it must return an error, not invoke Xlib's default process-exit handler.

use std::collections::HashMap;
use std::ffi::{c_int, c_ulong, CString};
use std::ptr;
use std::sync::{Arc, Mutex, OnceLock};
use x11_dl::xlib;

type ErrorHandler = unsafe extern "C" fn(*mut xlib::Display, *mut xlib::XErrorEvent) -> c_int;
static XLIB: OnceLock<Result<Arc<xlib::Xlib>, String>> = OnceLock::new();
static ERRORS: OnceLock<Mutex<HashMap<usize, u8>>> = OnceLock::new();
static PREVIOUS_HANDLER: OnceLock<Option<ErrorHandler>> = OnceLock::new();

/// The real app calls this before GTK/Tauri opens any display. Headless consumers
/// also call it before their first connection. Failure prevents our X11 backend.
pub fn initialize_threads() -> Result<Arc<xlib::Xlib>, String> {
    XLIB.get_or_init(|| {
        let api = xlib::Xlib::open().map_err(|e| format!("load Xlib: {e}"))?;
        if unsafe { (api.XInitThreads)() } == 0 {
            return Err("XInitThreads failed".into());
        }
        Ok(Arc::new(api))
    })
    .clone()
}

fn errors() -> &'static Mutex<HashMap<usize, u8>> {
    ERRORS.get_or_init(|| Mutex::new(HashMap::new()))
}

unsafe extern "C" fn error_handler(
    display: *mut xlib::Display,
    event: *mut xlib::XErrorEvent,
) -> c_int {
    if let Some(error) = errors()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_mut(&(display as usize))
    {
        *error = (*event).error_code;
        return 0;
    }
    // Preserve the toolkit's handler for displays that it owns.
    if let Some(Some(previous)) = PREVIOUS_HANDLER.get() {
        return previous(display, event);
    }
    0
}

pub struct Connection {
    pub api: Arc<xlib::Xlib>,
    pub display: *mut xlib::Display,
    pub root: xlib::Window,
}

impl Connection {
    pub fn open() -> Result<Self, String> {
        let api = initialize_threads()?;
        PREVIOUS_HANDLER.get_or_init(|| unsafe { (api.XSetErrorHandler)(Some(error_handler)) });
        let display = unsafe { (api.XOpenDisplay)(ptr::null()) };
        if display.is_null() {
            return Err("XOpenDisplay failed".into());
        }
        errors()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(display as usize, 0);
        let root = unsafe { (api.XDefaultRootWindow)(display) };
        Ok(Self { api, display, root })
    }

    pub fn sync(&self) -> Result<(), String> {
        unsafe {
            (self.api.XSync)(self.display, 0);
        }
        let mut map = errors().lock().unwrap_or_else(|p| p.into_inner());
        let error = map
            .get_mut(&(self.display as usize))
            .expect("registered X display");
        let code = std::mem::take(error);
        if code == 0 {
            Ok(())
        } else {
            Err(format!("X11 protocol error {code}"))
        }
    }

    pub fn atom(&self, name: &str) -> Result<xlib::Atom, String> {
        let name = CString::new(name).map_err(|_| "atom name contains NUL")?;
        let atom = unsafe { (self.api.XInternAtom)(self.display, name.as_ptr(), 0) };
        self.sync()?;
        Ok(atom)
    }

    /// Reads bounded properties; format=32 is native unsigned long in Xlib,
    /// including on LP64. The wire's four-byte width is not the buffer stride.
    pub fn property(&self, window: xlib::Window, name: &str) -> Result<Property, String> {
        let atom = self.atom(name)?;
        let (mut actual_type, mut format, mut count, mut after) = (0, 0, 0, 0);
        let mut bytes = ptr::null_mut();
        let status = unsafe {
            (self.api.XGetWindowProperty)(
                self.display,
                window,
                atom,
                0,
                4096,
                0,
                xlib::AnyPropertyType as c_ulong,
                &mut actual_type,
                &mut format,
                &mut count,
                &mut after,
                &mut bytes,
            )
        };
        let result = if status != 0 {
            Err(format!("XGetWindowProperty {name}: status={status}"))
        } else if after != 0 {
            Err(format!("XGetWindowProperty {name}: over 16KiB limit"))
        } else if bytes.is_null() || count == 0 {
            Ok(Property::Missing)
        } else {
            // SAFETY: Xlib owns count entries of the returned format until XFree.
            unsafe {
                match format {
                    8 => Ok(Property::Bytes(
                        std::slice::from_raw_parts(bytes, count as usize).to_vec(),
                    )),
                    32 => Ok(Property::Words(
                        std::slice::from_raw_parts(bytes.cast::<c_ulong>(), count as usize)
                            .to_vec(),
                    )),
                    _ => Err(format!(
                        "XGetWindowProperty {name}: unsupported format {format}"
                    )),
                }
            }
        };
        if !bytes.is_null() {
            unsafe {
                (self.api.XFree)(bytes.cast());
            }
        }
        self.sync()?;
        result
    }

    pub fn input_focus(&self) -> Result<xlib::Window, String> {
        let (mut window, mut revert) = (0, 0);
        unsafe {
            (self.api.XGetInputFocus)(self.display, &mut window, &mut revert);
        }
        self.sync()?;
        Ok(window)
    }

    pub fn parent(&self, window: xlib::Window) -> Result<xlib::Window, String> {
        let (mut root, mut parent, mut count) = (0, 0, 0);
        let mut children = ptr::null_mut();
        let status = unsafe {
            (self.api.XQueryTree)(
                self.display,
                window,
                &mut root,
                &mut parent,
                &mut children,
                &mut count,
            )
        };
        if !children.is_null() {
            unsafe {
                (self.api.XFree)(children.cast());
            }
        }
        self.sync()?;
        if status == 0 {
            Err("XQueryTree failed".into())
        } else {
            Ok(parent)
        }
    }

    pub fn contains_focus(&self, target: xlib::Window) -> Result<bool, String> {
        let mut focus = self.input_focus()?;
        for _ in 0..64 {
            if focus == 0 || focus == 1 || focus == self.root {
                return Ok(false);
            }
            if focus == target {
                return Ok(true);
            }
            focus = self.parent(focus)?;
        }
        Err("X11 focus ancestry exceeds 64 windows".into())
    }

    pub fn server_time(&self) -> Result<c_ulong, String> {
        let property = self.atom("_FLOWMIC_SERVER_TIME")?;
        let window = unsafe { (self.api.XCreateSimpleWindow)(self.display, self.root, 0, 0, 1, 1, 0, 0, 0) };
        unsafe {
            (self.api.XSelectInput)(self.display, window, xlib::PropertyChangeMask);
            (self.api.XChangeProperty)(self.display, window, property, xlib::XA_INTEGER, 8,
                xlib::PropModeAppend, ptr::null(), 0);
            (self.api.XSync)(self.display, 0);
        }
        let mut timestamp = None;
        unsafe {
            // Do not drain unrelated events: the same connection can own the
            // clipboard, whose pending SelectionRequest must remain serviceable.
            let mut event = std::mem::zeroed();
            if (self.api.XCheckTypedWindowEvent)(self.display, window, xlib::PropertyNotify, &mut event) != 0 {
                timestamp = Some(event.property.time);
            }
            (self.api.XDestroyWindow)(self.display, window);
        }
        self.sync()?;
        timestamp.ok_or_else(|| "X11 server timestamp unavailable".into())
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        unsafe {
            (self.api.XCloseDisplay)(self.display);
        }
        errors()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&(self.display as usize));
    }
}

pub enum Property {
    Missing,
    Bytes(Vec<u8>),
    Words(Vec<c_ulong>),
}
impl Property {
    pub fn first_word(&self) -> Option<c_ulong> {
        match self {
            Self::Words(words) => words.first().copied(),
            _ => None,
        }
    }
    pub fn text(&self) -> Option<String> {
        match self {
            Self::Bytes(bytes) => {
                Some(String::from_utf8_lossy(bytes).trim_end_matches('\0').into())
            }
            _ => None,
        }
    }
}
