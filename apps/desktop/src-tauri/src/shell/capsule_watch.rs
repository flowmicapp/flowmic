// SPEC-REF:
//   CLAUDE.md red line: ambient surfacing never steals focus by activating / no silent failures
//   docs/strategy/2026-08-12-device-line-r8-session-close.md §2-1
//     (the exstyle-monitor design this file REDIRECTS — see below)
//   docs/strategy/2026-08-13-0263-requirements-backlog.md §REQ-13-16
//   docs/rebuild/07-DESKTOP-SPEC.md §4 (the capsule surface is NON-ACTIVATING)
//
// ── WHAT THIS WATCHES, AND WHY IT IS NOT WHAT THE DESIGN ASKED FOR ───────────
//
// R8 §2-1 measured `exstyle=0x00040118 NOACTIVATE=False TOOLWINDOW=False` on a
// running capsule and designed a monitor that PRINTS WHEN A BIT CHANGES, on the
// theory that something inside tao strips what `configure_capsule_window` OR'd
// in — with `capsule_resize`'s `set_size` named as 「the only remaining
// candidate」 and marked, in
// that same paragraph, 「item 4 is an assumption, not a measurement」.
//
// It has since been measured, on 0.2.62, 2026-08-13:
//   · suspect #4 is REFUTED — the bit survives morph up AND down, drag, and
//     click; `set_size` does not rewrite it;
//   · against a real-click Notepad baseline the capsule did NOT take foreground;
//   · `configure_capsule_window` is called EXACTLY ONCE (lib.rs, in `setup`),
//     and there is a ~100 ms window at birth in which the raw tao default
//     (NOACTIVATE unset — tao only sets it for a window built `focusable:false`,
//     which ours is not) is the live ex-style.
//
// A bit-change monitor asks「who cleared it?」. If nothing clears it, that
// monitor is silent forever and the silence is indistinguishable from「the
// instrument is not wired up」. The hypothesis that survives the measurements is
// a DIFFERENT one: the ex-style was never cleared on the window we configured —
// the window we configured is not the window on screen. WebView2 / tao can
// tear down and recreate the native window, and `configure_capsule_window` runs
// once, in `setup`, so a recreated capsule carries tao's defaults and nothing
// re-applies ours.
//
// So this watches for **the HWND changing**, and reports whether configure has
// re-run for the new one. It keeps the cheap bit check as a SECONDARY line, not
// because #4 is believed, but so that the refutation has something that would
// go loud if it ever stopped being true.
//
// ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────
// · No thread, no timer, no polling. It rides touchpoints the capsule path
//   already crosses (`resize` / `move` / `click_through` / `surface` / `drag`).
//   A poll would answer「when did it change」at the cost of a permanent thread
//   for an instrument that should not outlive the investigation.
// · It changes NO behaviour: every entry point returns `()` and the only effect
//   is a forensic line. It does not re-apply the ex-style. Re-OR-ing the bits at
//   each touchpoint would turn a timing defect into a patch applied forever and
//   would DESTROY the evidence this exists to collect (R8 §2-1's own warning:
//  「don't rush to 'OR it in again on surface'」).
// · It is Windows-gated from its `mod` declaration down, and so is every call
//   site. There is deliberately no not-windows stub: a no-op stub is still
//   non-Windows code, and non-Windows code gets ZERO proof from the gates that
//   run here.
//   ⚠️ The two sentences above are spelled in prose on purpose. `verify:lint`'s
//   `platform-cfg-count` tripwire counts the ATTRIBUTE TEXT, not parsed items,
//   so writing the attribute inside a comment inflates the non-Windows census
//   and demands a Mac run this file does not owe. Measured here: quoting it
//   twice moved `cfg(not(windows))` from 24 to 26 with zero non-Windows code
//   added. Do not "restore" the backticked form.
//
// ── WHY THE STATE IS A PLAIN STRUCT AND NOT ATOMICS ──────────────────────────
// `Watch` holds no handles and calls no Win32; the Win32 read happens in the
// caller and is handed in as two integers. That is what makes the decision —
// the part with the branches, the dedupe and the wording — a pure function with
// unit tests that actually run in `verify:rust-tests`' `--features app` leg.

use std::sync::Mutex;

/// `WS_EX_NOACTIVATE` / `WS_EX_TOOLWINDOW` as plain integers so the decision
/// layer needs no Win32 types (and so its tests run without a window).
///
/// 🔴 A hand-written number-to-meaning table is exactly what the IJ-03 spike got
/// wrong. `bits_match_the_windows_crate` below pins both against the crate's own
/// constants, so this pair cannot drift into a comfortable lie.
pub(crate) const NOACTIVATE_BIT: isize = 0x0800_0000;
pub(crate) const TOOLWINDOW_BIT: isize = 0x0000_0080;
const WANT: isize = NOACTIVATE_BIT | TOOLWINDOW_BIT;

/// Process-wide watcher state. A `Mutex` and not atomics because the dedupe and
/// the comparison have to be one decision, not four independent reads.
static WATCH: Mutex<Watch> = Mutex::new(Watch::new());

/// What `configure_capsule_window` last saw, and what we have already said.
#[derive(Debug)]
pub(crate) struct Watch {
    /// The HWND `configure_capsule_window` last applied the ex-style to.
    /// `0` = it has never run (or never got as far as an HWND).
    configured_hwnd: isize,
    /// The ex-style READ BACK after that write — what the OS actually holds,
    /// not what we asked for.
    configured_exstyle: isize,
    /// How many times configure has completed. Named in the forensic line so a
    /// reader can tell「it never re-ran」from「it re-ran and lost the race」.
    configure_runs: u32,
    /// Dedupe: the HWND we have already reported as new/unconfigured.
    reported_hwnd: isize,
    /// Dedupe: the HWND we have already reported as having lost the bits.
    reported_bits_hwnd: isize,
}

impl Watch {
    const fn new() -> Self {
        Self {
            configured_hwnd: 0,
            configured_exstyle: 0,
            configure_runs: 0,
            reported_hwnd: 0,
            reported_bits_hwnd: 0,
        }
    }

    /// Record the window `configure_capsule_window` just configured.
    ///
    /// Clears both dedupe slots: after a re-configure every earlier report is
    /// about a window that is no longer the reference, so the next divergence
    /// deserves to be said again.
    pub(crate) fn on_configure(&mut self, hwnd: isize, exstyle_after: isize) {
        self.configured_hwnd = hwnd;
        self.configured_exstyle = exstyle_after;
        self.configure_runs = self.configure_runs.saturating_add(1);
        self.reported_hwnd = 0;
        self.reported_bits_hwnd = 0;
    }

    /// The whole decision, as a pure function: given what a touchpoint sees,
    /// what (if anything) should the forensics log say?
    ///
    /// `None` is the overwhelmingly common answer — the same window we
    /// configured, still carrying both bits. Anything else is said ONCE per
    /// offending HWND, because these touchpoints fire per morph / per drag and
    /// an instrument that floods the log is one nobody reads.
    pub(crate) fn observe(&mut self, site: &str, hwnd: isize, exstyle: isize) -> Option<String> {
        if hwnd == 0 {
            // No handle to compare. The call sites already fail loud about a
            // missing capsule window; inventing a second voice for it here
            // would just double-report the same fact.
            return None;
        }
        if self.configured_hwnd == 0 {
            // Configure has never run — either the ~100 ms birth window
            // (measured 2026-08-13) or a configure that returned early. Either
            // way the live window is running on tao's defaults RIGHT NOW.
            if self.reported_hwnd == hwnd {
                return None;
            }
            self.reported_hwnd = hwnd;
            return Some(format!(
                "watch@{site} UNCONFIGURED — capsule hwnd=0x{:X} reached this touchpoint \
                 before configure_capsule_window ever applied the ex-style (configure_runs=0); {}",
                hwnd as usize,
                decode(exstyle)
            ));
        }
        if hwnd != self.configured_hwnd {
            // 🔴 THE LINE THIS FILE EXISTS FOR. `configured_hwnd` is written by
            // configure and by nothing else, so「it differs from the live one」
            // IS「configure has not re-run for the live one」— the two halves the
            // brief asks for are the same read.
            if self.reported_hwnd == hwnd {
                return None;
            }
            self.reported_hwnd = hwnd;
            return Some(format!(
                "watch@{site} RECREATED — configured hwnd=0x{:X}, live hwnd=0x{:X}; \
                 configure_capsule_window has NOT re-run for the live one \
                 (configure_runs={}, still pointing at the old hwnd); {}",
                self.configured_hwnd as usize,
                hwnd as usize,
                self.configure_runs,
                decode(exstyle)
            ));
        }
        if exstyle & WANT != WANT {
            // Secondary. Suspect #4 was refuted on 0.2.62; this is what would
            // make the refutation stop being silently assumed.
            if self.reported_bits_hwnd == hwnd {
                return None;
            }
            self.reported_bits_hwnd = hwnd;
            return Some(format!(
                "watch@{site} BITS LOST — same hwnd=0x{:X} we configured, but now {}; \
                 at configure time it read {}",
                hwnd as usize,
                decode(exstyle),
                decode(self.configured_exstyle)
            ));
        }
        None
    }
}

/// The ex-style as a reader of the R8 §2-1 measurement would expect to see it —
/// same shape (`exstyle=0x00040118 NOACTIVATE=False TOOLWINDOW=False`) so the
/// two readings can be compared without a decoder ring.
pub(crate) fn decode(exstyle: isize) -> String {
    format!(
        "exstyle=0x{:08X} NOACTIVATE={} TOOLWINDOW={}",
        exstyle as usize as u32,
        exstyle & NOACTIVATE_BIT != 0,
        exstyle & TOOLWINDOW_BIT != 0
    )
}

/// Hand `configure_capsule_window`'s read-back to the watcher.
pub(crate) fn note_configured(hwnd: isize, exstyle_after: isize) {
    // Poisoned lock is fine: this guards a report, never an invariant, and an
    // observation layer must never bite back at the main flow (07 §10).
    let mut w = WATCH.lock().unwrap_or_else(|p| p.into_inner());
    w.on_configure(hwnd, exstyle_after);
}

/// A touchpoint on the capsule path. Reads the live HWND + ex-style and records
/// a forensic line only when something is off. `site` names the action, which is
/// the closest a touchpoint-based instrument can get to「which action did it」.
pub(crate) fn observe_window(w: &tauri::WebviewWindow, site: &str) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GWL_EXSTYLE};

    let Ok(h) = w.hwnd() else {
        // The caller owns the「no window」story; see the `hwnd == 0` arm.
        return;
    };
    let raw = h.0 as isize;
    let exstyle = unsafe { GetWindowLongPtrW(HWND(h.0), GWL_EXSTYLE) };
    let line = {
        let mut guard = WATCH.lock().unwrap_or_else(|p| p.into_inner());
        guard.observe(site, raw, exstyle)
    };
    if let Some(line) = line {
        crate::forensic::record("capsule", &line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OK: isize = 0x0004_0118 | NOACTIVATE_BIT | TOOLWINDOW_BIT;

    #[test]
    fn bits_match_the_windows_crate() {
        use windows::Win32::UI::WindowsAndMessaging::{WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW};
        // The whole reason the two literals above are allowed to exist.
        assert_eq!(NOACTIVATE_BIT, WS_EX_NOACTIVATE.0 as isize);
        assert_eq!(TOOLWINDOW_BIT, WS_EX_TOOLWINDOW.0 as isize);
    }

    #[test]
    fn the_configured_window_carrying_its_bits_says_nothing() {
        let mut w = Watch::new();
        w.on_configure(0x1234, OK);
        assert_eq!(w.observe("resize", 0x1234, OK), None);
        assert_eq!(w.observe("drag", 0x1234, OK), None);
    }

    #[test]
    fn a_different_hwnd_is_reported_as_recreation_naming_both() {
        let mut w = Watch::new();
        w.on_configure(0x1234, OK);
        let line = w.observe("resize", 0x5678, 0x0004_0118).expect("must report");
        assert!(line.contains("RECREATED"), "{line}");
        assert!(line.contains("watch@resize"), "{line}");
        assert!(line.contains("0x1234"), "old hwnd must be named: {line}");
        assert!(line.contains("0x5678"), "new hwnd must be named: {line}");
        assert!(line.contains("has NOT re-run"), "{line}");
        assert!(line.contains("configure_runs=1"), "{line}");
        assert!(line.contains("NOACTIVATE=false"), "{line}");
    }

    #[test]
    fn recreation_is_said_once_per_hwnd_not_once_per_morph() {
        let mut w = Watch::new();
        w.on_configure(0x1234, OK);
        assert!(w.observe("resize", 0x5678, 0).is_some());
        assert_eq!(w.observe("resize", 0x5678, 0), None);
        assert_eq!(w.observe("drag", 0x5678, 0), None);
        // …but a THIRD window is a new fact and is said again.
        assert!(w.observe("move", 0x9abc, 0).is_some());
    }

    #[test]
    fn a_re_configure_on_the_new_hwnd_makes_it_quiet_again() {
        // This is the shape the FIX would have: if recreation ever re-runs
        // configure, the instrument must stop shouting — otherwise the device
        // line cannot tell a fixed build from a broken one.
        let mut w = Watch::new();
        w.on_configure(0x1234, OK);
        assert!(w.observe("resize", 0x5678, 0).is_some());
        w.on_configure(0x5678, OK);
        assert_eq!(w.observe("resize", 0x5678, OK), None);
    }

    #[test]
    fn a_touchpoint_before_configure_ever_ran_is_the_birth_window() {
        let mut w = Watch::new();
        let line = w.observe("surface", 0x1234, 0x0004_0118).expect("must report");
        assert!(line.contains("UNCONFIGURED"), "{line}");
        assert!(line.contains("configure_runs=0"), "{line}");
        assert_eq!(w.observe("surface", 0x1234, 0x0004_0118), None, "said once");
    }

    #[test]
    fn losing_a_bit_on_the_same_window_is_reported_separately() {
        let mut w = Watch::new();
        w.on_configure(0x1234, OK);
        // TOOLWINDOW still there, NOACTIVATE gone — suspect #4's shape.
        let line = w
            .observe("resize", 0x1234, OK & !NOACTIVATE_BIT)
            .expect("must report");
        assert!(line.contains("BITS LOST"), "{line}");
        assert!(line.contains("NOACTIVATE=false TOOLWINDOW=true"), "{line}");
        assert!(line.contains("at configure time it read"), "{line}");
        assert_eq!(w.observe("resize", 0x1234, OK & !NOACTIVATE_BIT), None);
    }

    #[test]
    fn a_missing_handle_is_not_this_instruments_story() {
        let mut w = Watch::new();
        w.on_configure(0x1234, OK);
        assert_eq!(w.observe("resize", 0, 0), None);
    }

    #[test]
    fn decode_reads_like_the_r8_measurement() {
        assert_eq!(
            decode(0x0004_0118),
            "exstyle=0x00040118 NOACTIVATE=false TOOLWINDOW=false"
        );
        assert_eq!(
            decode(0x0004_0118 | NOACTIVATE_BIT | TOOLWINDOW_BIT),
            "exstyle=0x08040198 NOACTIVATE=true TOOLWINDOW=true"
        );
    }
}
