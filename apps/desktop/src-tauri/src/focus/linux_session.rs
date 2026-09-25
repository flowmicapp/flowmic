// SPEC-REF: docs/strategy/2026-09-21-codex-milestone-handover-linux-web-embed-mcp-sync.md
// §3.5 / L-2: X11 delivery, native Wayland refusal, and explicit WSLg backend evidence.
// Environment describes available transports; GTK's actual display describes this app.
// Neither proves that a third-party target currently has X11 keyboard focus.

use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayBackend {
    X11,
    Wayland,
    Unknown,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionFacts {
    pub session_type: String,
    pub display: String,
    pub wayland_display: String,
    pub gdk_backend: String,
}

impl SessionFacts {
    pub fn from_env() -> Self {
        Self {
            session_type: std::env::var("XDG_SESSION_TYPE").unwrap_or_default(),
            display: std::env::var("DISPLAY").unwrap_or_default(),
            wayland_display: std::env::var("WAYLAND_DISPLAY").unwrap_or_default(),
            gdk_backend: std::env::var("GDK_BACKEND").unwrap_or_default(),
        }
    }
}

/// Headless fallback is conservative when both transports exist. Explicit single-backend
/// selection is useful to the real headless injection example; a comma-separated GTK
/// preference is not evidence that its first backend actually opened.
pub fn classify(facts: &SessionFacts, actual: Option<DisplayBackend>) -> DisplayBackend {
    // An XWayland connection only describes our transport, not access to native
    // Wayland targets. A declared Wayland session remains unsupported even when
    // GTK itself opened X11. WSLg's X11 path (no Wayland session type) is separate.
    if facts.session_type.trim() == "wayland" {
        return DisplayBackend::Wayland;
    }
    if let Some(backend) = actual {
        return backend;
    }
    match facts.gdk_backend.trim() {
        "wayland" => return DisplayBackend::Wayland,
        "x11" if !facts.display.is_empty() => return DisplayBackend::X11,
        _ => {}
    }
    match facts.session_type.as_str() {
        "wayland" => DisplayBackend::Wayland,
        "x11" if !facts.display.is_empty() => DisplayBackend::X11,
        _ if !facts.wayland_display.is_empty() => DisplayBackend::Wayland,
        _ if !facts.display.is_empty() => DisplayBackend::X11,
        _ => DisplayBackend::Unknown,
    }
}

// Set only from GTK's main thread, before the sidecar can start socket workers.
// 0 means no runtime observation, 3 means an observed unsupported display type.
static ACTUAL_BACKEND: AtomicU8 = AtomicU8::new(0);

pub fn current_backend() -> DisplayBackend {
    let actual = match ACTUAL_BACKEND.load(Ordering::Acquire) {
        1 => Some(DisplayBackend::X11),
        2 => Some(DisplayBackend::Wayland),
        3 => Some(DisplayBackend::Unknown),
        _ => None,
    };
    classify(&SessionFacts::from_env(), actual)
}

#[cfg(feature = "app")]
pub fn capture_gtk_backend() {
    use gtk::prelude::*;
    let name = gtk::gdk::Display::default()
        .map(|display| display.type_().name().to_string())
        .unwrap_or_else(|| "no-default-display".to_string());
    let backend = match name.as_str() {
        "GdkX11Display" => 1,
        "GdkWaylandDisplay" => 2,
        _ => 3,
    };
    ACTUAL_BACKEND.store(backend, Ordering::Release);
    crate::forensic::record(
        "linux-session",
        &format!(
            "GTK actual={name} selected={:?} env={:?}",
            current_backend(),
            SessionFacts::from_env()
        ),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wslg_without_session_type_uses_transport_facts() {
        let mut facts = SessionFacts {
            display: ":0".into(),
            wayland_display: "wayland-0".into(),
            ..Default::default()
        };
        assert_eq!(classify(&facts, None), DisplayBackend::Wayland);
        facts.gdk_backend = "x11".into();
        assert_eq!(classify(&facts, None), DisplayBackend::X11);
        facts.gdk_backend = "wayland".into();
        assert_eq!(classify(&facts, None), DisplayBackend::Wayland);
    }

    #[test]
    fn runtime_display_overrules_environment_hints() {
        let facts = SessionFacts {
            session_type: "x11".into(),
            display: ":0".into(),
            ..Default::default()
        };
        assert_eq!(
            classify(&facts, Some(DisplayBackend::Wayland)),
            DisplayBackend::Wayland
        );
        assert_eq!(
            classify(&facts, Some(DisplayBackend::Unknown)),
            DisplayBackend::Unknown
        );
        let facts = SessionFacts {
            session_type: "wayland".into(),
            ..facts
        };
        assert_eq!(
            classify(&facts, Some(DisplayBackend::X11)),
            DisplayBackend::Wayland
        );
    }

    #[test]
    fn transport_presence_is_not_wayland_permission() {
        let mut facts = SessionFacts {
            session_type: "wayland".into(),
            display: ":0".into(),
            ..Default::default()
        };
        assert_eq!(classify(&facts, None), DisplayBackend::Wayland);
        facts.session_type.clear();
        assert_eq!(classify(&facts, None), DisplayBackend::X11);
        facts.display.clear();
        assert_eq!(classify(&facts, None), DisplayBackend::Unknown);
        facts.gdk_backend = "x11,wayland".into();
        facts.wayland_display = "wayland-0".into();
        assert_eq!(classify(&facts, None), DisplayBackend::Wayland);
    }
}
