// Linux L-2/L-7: the selected display backend is a capability fact, never
// evidence of the focused element's editability. Refuse before touching input.
use crate::error_codes;
use crate::focus::linux_session::DisplayBackend;
use super::pipeline::{InjectMode, InjectOutcome};

pub fn verdict(backend: DisplayBackend) -> Option<InjectOutcome> {
    let (code, detail) = match backend {
        DisplayBackend::X11 => return None,
        DisplayBackend::Wayland => (error_codes::INJECT_WAYLAND_UNSUPPORTED,
            "selected display is Wayland; cross-application input is unavailable; no keys or clipboard writes performed"),
        DisplayBackend::Unknown => (error_codes::INJECT_DISPLAY_UNAVAILABLE,
            "no supported display backend observed; no keys or clipboard writes performed"),
    };
    crate::forensic::record("inject", detail);
    Some(InjectOutcome { ok: false, mode: InjectMode::Cached,
        error_code: Some(code), error_message: Some(detail.into()), focus_evidence: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linux_wayland_refusal_is_not_input_or_focus_confirmation() {
        let result = verdict(DisplayBackend::Wayland).expect("explicit refusal");
        assert!(!result.ok);
        assert_eq!(result.mode, InjectMode::Cached);
        assert_eq!(result.error_code, Some(error_codes::INJECT_WAYLAND_UNSUPPORTED));
        assert_eq!(result.focus_evidence, None);
        assert!(verdict(DisplayBackend::X11).is_none());
        assert_eq!(verdict(DisplayBackend::Unknown).unwrap().error_code, Some(error_codes::INJECT_DISPLAY_UNAVAILABLE));
    }
}
