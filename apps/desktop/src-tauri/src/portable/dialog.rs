// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §7-2 (⛔ must not default-export
//     to a location that gets auto-synced away, such as the photo album /
//     downloads folder / cloud backup, **the user must actively pick the destination**)
//
// The one place the USER says where the export lands (and which file to import).
//
// ── WHY NOT `tauri-plugin-dialog` ───────────────────────────────────────────
//
// It would work, and it costs four touch points in files two other lanes are
// editing this hour: a crate + its tree in `Cargo.toml`/`Cargo.lock`, a plugin
// registration in `lib.rs`, a permission in `capabilities/*.json`, and an npm
// package for the JS half. Against that, `GetSaveFileNameW` / `GetOpenFileNameW`
// are a FEATURE of the `windows` crate this crate already depends on — the same
// trade Cargo.toml already records twice in its own words (`Win32_UI_Input_Ime`:
// 「A FEATURE of the `windows` crate we already depend on, not a new dependency」;
// `Win32_Graphics_Imaging`: 「the card admits no new crates」). One line of
// Cargo.toml, no lockfile churn, no capability surface.
//
// ⚠️ WHAT THE TRADE COSTS: comdlg32 is Windows-only, so this product's file
// picker is Windows-only. That is not a regression — the injection layer, the
// clipboard layer and the tray are already Win32, and the desktop ships for
// Windows alone.
//
// ── WHY ITS OWN THREAD ──────────────────────────────────────────────────────
//
// The modern common dialog is a COM object underneath, and it wants an
// apartment-initialised thread. A Tauri command runs on a pooled thread whose
// COM state belongs to whoever used it last, and `CoInitializeEx` there would
// leave that apartment behind for the next command. A short-lived thread that
// initialises, shows, and uninitialises owns its own state end to end.

/// Where the user chose to put / take the archive. `None` = the user cancelled,
/// which is a NORMAL answer and must never be reported as a failure.
pub type Chosen = Option<String>;

/// The archive extension, in one place (the filter, the default extension, and
/// the suggested file name all have to agree).
pub const EXT: &str = "zip";

#[cfg(windows)]
mod win {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Controls::Dialogs::{
        GetOpenFileNameW, GetSaveFileNameW, OPENFILENAMEW, OFN_EXPLORER, OFN_FILEMUSTEXIST,
        OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The double-NUL-terminated filter pair comdlg32 wants.
    fn filter(label: &str) -> Vec<u16> {
        let mut v: Vec<u16> = label.encode_utf16().collect();
        v.push(0);
        v.extend("*.zip".encode_utf16());
        v.push(0);
        v.push(0);
        v
    }

    /// `save = true` → GetSaveFileNameW, otherwise GetOpenFileNameW.
    pub fn pick(save: bool, title: &str, filter_label: &str, suggested: &str) -> super::Chosen {
        // MAX_PATH is not the ceiling for a UNICODE dialog; 32 K is the real one,
        // and a user with a deep OneDrive path really does exceed 260.
        let mut buf: Vec<u16> = vec![0; 32 * 1024];
        let sug = wide(suggested);
        // The suggestion is a NAME, never a directory: the dialog opens wherever
        // the shell last left the user, which is exactly 「the user actively picks the destination」.
        let n = sug.len().min(buf.len() - 1);
        buf[..n].copy_from_slice(&sug[..n]);

        let title_w = wide(title);
        let mut filt = filter(filter_label);
        let defext = wide(super::EXT);

        let mut ofn = OPENFILENAMEW {
            lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
            lpstrFilter: PCWSTR(filt.as_mut_ptr()),
            nFilterIndex: 1,
            lpstrFile: PWSTR(buf.as_mut_ptr()),
            nMaxFile: buf.len() as u32,
            lpstrTitle: PCWSTR(title_w.as_ptr()),
            lpstrDefExt: PCWSTR(defext.as_ptr()),
            // OFN_NOCHANGEDIR: without it the dialog moves the PROCESS working
            // directory to wherever the user browsed, and everything this app
            // resolves relatively afterwards follows it.
            Flags: OFN_EXPLORER
                | OFN_NOCHANGEDIR
                | OFN_PATHMUSTEXIST
                | if save { OFN_OVERWRITEPROMPT } else { OFN_FILEMUSTEXIST },
            ..Default::default()
        };

        let ok = unsafe {
            // The HRESULT is deliberately not `?`-ed: S_FALSE means「already
            // initialised on this thread」, which is a success for our purpose.
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let shown = if save {
                GetSaveFileNameW(&mut ofn).as_bool()
            } else {
                GetOpenFileNameW(&mut ofn).as_bool()
            };
            if hr.is_ok() {
                CoUninitialize();
            }
            shown
        };
        if !ok {
            // `CommDlgExtendedError() == 0` is the user pressing Cancel. Anything
            // else is a real failure, and it is recorded rather than swallowed —
            // but both give the caller `None`, because the only honest thing to
            // tell the user is 「no file was picked」 and the reason belongs in the log.
            let code = unsafe { windows::Win32::UI::Controls::Dialogs::CommDlgExtendedError() };
            if code.0 != 0 {
                crate::forensic::record(
                    "portable",
                    &format!("file dialog failed, CommDlgExtendedError=0x{:04x}", code.0),
                );
            }
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let path = String::from_utf16_lossy(&buf[..end]);
        if path.is_empty() {
            None
        } else {
            Some(path)
        }
    }
}

#[cfg(not(windows))]
mod win {
    /// 🔴 NOT A FRIENDLY DEFAULT (doc 13 §7 F1 ②). This build has no file picker,
    /// and the caller's `None` means 「the user did not pick a destination」— so nothing is written
    /// anywhere. It never invents a path, which is the failure mode the ban on
    /// friendly DI defaults exists to prevent.
    pub fn pick(_save: bool, _t: &str, _f: &str, _s: &str) -> super::Chosen {
        crate::forensic::record("portable", "file dialog unavailable on this platform");
        None
    }
}

/// Ask the user where to WRITE the archive. `suggested` is the file name only.
pub fn save_as(title: &str, filter_label: &str, suggested: &str) -> Chosen {
    run(true, title, filter_label, suggested)
}

/// Ask the user WHICH archive to read.
pub fn open(title: &str, filter_label: &str) -> Chosen {
    run(false, title, filter_label, "")
}

fn run(save: bool, title: &str, filter_label: &str, suggested: &str) -> Chosen {
    let (t, f, s) = (title.to_string(), filter_label.to_string(), suggested.to_string());
    // A panic inside the dialog thread would otherwise take the join with it; a
    // failed join reads as 「no file was picked」, the same as Cancel.
    std::thread::spawn(move || win::pick(save, &t, &f, &s))
        .join()
        .unwrap_or(None)
}
