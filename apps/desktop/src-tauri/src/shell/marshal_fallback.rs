// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §3 (focus tracking / Win32 hook install
//     must run on a thread with a live message pump), §10 (forensics)
//
// Pure decision for the `run_on_main_thread` failure arm in `sidecar_ctl`
// (RV-19). Extracted so the "skip connect + forensic wording" contract is
// unit-testable without a Tauri runtime, and so `sidecar_ctl.rs` stays under
// the file-size gate.
//
// The Win32 hook install itself and Tauri's marshal cannot be exercised here —
// those need a live message pump. Production uses only this struct's fields:
// record `forensic_detail`, and never call `connect_socket` when
// `install_tracker` is false.

use crate::socket::channel::Channel;

/// Pure decision for the `run_on_main_thread` failure arm (RV-19).
///
/// Extracted so the "skip connect + forensic wording" contract is unit-testable
/// without a Tauri runtime. The Win32 hook install itself and Tauri's marshal
/// cannot be exercised here — those need a live message pump; see the test
/// module note below. Production uses only this struct's fields: record
/// `forensic_detail`, and never call `connect_socket` when `install_tracker`
/// is false.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct MarshalFailAction {
    pub(super) forensic_detail: String,
    /// Always false on this path — installing on a dying thread latches OnceLock.
    pub(super) install_tracker: bool,
}

pub(super) fn marshal_fail_action(channel: Channel) -> MarshalFailAction {
    MarshalFailAction {
        forensic_detail: format!(
            "run_on_main_thread FAILED (channel={}) — channel NOT connected this attempt \
             (marshal failed; connect_socket skipped — installing Win32 hook on a dying \
             thread would latch process-wide OnceLock forever)",
            channel.tag()
        ),
        install_tracker: false,
    }
}

#[cfg(test)]
mod marshal_fail_tests {
    use super::*;

    #[test]
    fn marshal_fail_skips_tracker_and_names_the_reason() {
        for ch in [Channel::Lan, Channel::Cloud] {
            let a = marshal_fail_action(ch);
            assert!(
                !a.install_tracker,
                "marshal-fail path must never install the focus tracker"
            );
            assert!(
                a.forensic_detail.contains("run_on_main_thread FAILED"),
                "forensic must name the marshal failure: {}",
                a.forensic_detail
            );
            assert!(
                a.forensic_detail.contains("channel NOT connected"),
                "forensic must say the channel did not connect: {}",
                a.forensic_detail
            );
            assert!(
                a.forensic_detail.contains("connect_socket skipped"),
                "forensic must say connect was skipped (no inline fallback): {}",
                a.forensic_detail
            );
            assert!(
                !a.forensic_detail.contains("inline fallback"),
                "forensic must not claim an inline fallback that no longer runs: {}",
                a.forensic_detail
            );
            assert!(
                a.forensic_detail.contains("OnceLock"),
                "forensic must name the OnceLock latch hazard: {}",
                a.forensic_detail
            );
            assert!(
                a.forensic_detail.contains(ch.tag()),
                "forensic must name the channel: {}",
                a.forensic_detail
            );
        }
    }

    // Not unit-tested here (and must not be faked with a friendly no-op DI):
    //   • Tauri `AppHandle::run_on_main_thread` — needs a live event loop;
    //   • `SetWinEventHook` / HOOK OnceLock latch — needs a Win32 message pump
    //     on the installing thread. Production proof is the absence of
    //     `connect_socket` in the `is_err` arm of `connect_on_main`
    //     (sidecar_ctl.rs — grep that arm).
}
