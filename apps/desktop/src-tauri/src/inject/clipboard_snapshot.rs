// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (Stage 3 clipboard fallback — snapshot
//     → write CF_UNICODETEXT → paste → unconditionally restore the original clipboard)
//
// Win32 clipboard backup and ownership-safe replacement, byte-preserving for
// everything that IS bytes. The `ClipboardApi` trait is the test seam;
// production wires `WinClipboardApi`. Non-Windows definitions keep cross-target
// `cargo check` compiling.
//
// v0.2.10 (owner 2026-07-29, confirmed INJECT_CLIPBOARD_FAIL paste=Win32 error: 6):
// not every clipboard format is an HGLOBAL — CF_BITMAP / CF_METAFILEPICT /
// CF_ENHMETAFILE / CF_PALETTE are GDI handles, and GlobalSize on one fails with
// ERROR_INVALID_HANDLE (6). The old all-or-nothing read let ONE such format
// (a screenshot the user copied earlier) fail the whole snapshot, which failed
// every image paste before the paste was even attempted. A format that cannot
// be read as bytes is now SKIPPED and NAMED on the forensic record; the paste
// proceeds, and the restore brings back everything that was readable. The
// skipped format does not survive the restore — said out loud, never silent.
//
// RV-38 (2026-07-30): that policy was RIGHT and its MECHANISM was fatal. See
// `is_hglobal_bytes_format` — 「GlobalSize on a GDI handle returns an error」 was
// an observation, not a contract, and the other outcome is a dead process.
//
// *** HUMAN-AUDIT SENSITIVE (injection path) ***

use crate::inject::sendinput::InjectError;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClipboardSnapshot {
    pub formats: Vec<(u32, Vec<u8>)>,
    /// Formats that were on the clipboard but could not be snapshotted as
    /// bytes (GDI-handle formats such as CF_BITMAP — see the module header).
    /// They are absent from `formats`, so a restore cannot bring them back;
    /// `save_clipboard` says so on the forensic record.
    pub skipped: Vec<u32>,
}

/// ⚠️ GATED 2026-08-07 (MAC-05): this trait and the two functions below are the
/// WIN32 seam — `open`/`empty`/`EnumClipboardFormats`/HGLOBAL is a Windows shape,
/// and macOS reaches NSPasteboard through `inject/macos/pasteboard.rs` instead. On
/// a macOS build they would otherwise be dead code (a warning, and `verify:clippy`
/// runs with `-D warnings`). `test` is in the gate because the round-trip proofs
/// below drive them through `FakeClip` on EVERY platform, which is the whole point
/// of the seam and must not be lost to a cfg.
#[cfg(any(target_os = "windows", test))]
trait ClipboardApi {
    type Handle: Copy;

    fn open(&mut self) -> Result<(), u32>;
    fn close(&mut self) -> Result<(), u32>;
    fn empty(&mut self) -> Result<(), u32>;
    fn enum_next(&mut self, previous: u32) -> Result<Option<u32>, u32>;
    fn read(&mut self, format: u32) -> Result<Vec<u8>, u32>;
    fn allocate(&mut self, size: usize) -> Result<Self::Handle, u32>;
    fn write(&mut self, handle: Self::Handle, bytes: &[u8]) -> Result<(), u32>;
    fn set(&mut self, format: u32, handle: Self::Handle) -> Result<(), u32>;
    fn free(&mut self, handle: Self::Handle);
}

#[cfg(any(target_os = "windows", test))]
fn save_with(api: &mut impl ClipboardApi) -> Result<ClipboardSnapshot, InjectError> {
    api.open().map_err(InjectError::Win32)?;
    let result = (|| {
        let mut formats = Vec::new();
        let mut skipped = Vec::new();
        let mut previous = 0;
        while let Some(format) = api.enum_next(previous).map_err(InjectError::Win32)? {
            // A single unreadable format (a GDI handle, an owner that refuses
            // to render) must not veto the whole snapshot — skip it by id and
            // keep the rest (v0.2.10, the Win32-error-6 fix).
            match api.read(format) {
                Ok(bytes) => formats.push((format, bytes)),
                Err(_) => skipped.push(format),
            }
            previous = format;
        }
        Ok(ClipboardSnapshot { formats, skipped })
    })();
    let close_err = api.close().err();
    if let Err(e) = result {
        return Err(e);
    }
    if let Some(code) = close_err {
        return Err(InjectError::Win32(code));
    }
    Ok(result.expect("inner result was Ok"))
}

#[cfg(any(target_os = "windows", test))]
fn replace_with<A: ClipboardApi>(
    api: &mut A,
    formats: Vec<(u32, Vec<u8>)>,
) -> Result<(), InjectError> {
    // Allocate + populate every handle BEFORE the destructive EmptyClipboard.
    let mut owned: Vec<(u32, Option<A::Handle>)> = Vec::with_capacity(formats.len());
    for (format, bytes) in formats {
        match api.allocate(bytes.len()) {
            Ok(handle) => {
                if let Err(code) = api.write(handle, &bytes) {
                    api.free(handle);
                    for (_, pending) in owned.drain(..) {
                        api.free(pending.expect("owned handle"));
                    }
                    return Err(InjectError::Win32(code));
                }
                owned.push((format, Some(handle)));
            }
            Err(code) => {
                for (_, handle) in owned.drain(..) {
                    api.free(handle.expect("owned handle"));
                }
                return Err(InjectError::Win32(code));
            }
        }
    }

    if let Err(code) = api.open() {
        for (_, handle) in owned.drain(..) {
            api.free(handle.expect("owned handle"));
        }
        return Err(InjectError::Win32(code));
    }

    // Explicit Result type: bare `result?` cannot infer E (InjectError has
    // multiple From impls); the old `if let Err(e) = result { return Err(e); }`
    // avoided that, and clippy::question_mark wants `?` once the type is known.
    let result: Result<(), InjectError> = (|| {
        api.empty().map_err(InjectError::Win32)?;
        for (format, handle) in &mut owned {
            let value = handle.expect("owned handle before transfer");
            api.set(*format, value).map_err(InjectError::Win32)?;
            // SetClipboardData success transfers ownership to the system.
            *handle = None;
        }
        Ok(())
    })();
    let close_err = api.close().err();
    for (_, handle) in owned {
        if let Some(value) = handle {
            api.free(value);
        }
    }
    result?;
    if let Some(code) = close_err {
        return Err(InjectError::Win32(code));
    }
    Ok(())
}

/// Whether `GetClipboardData(format)` yields an HGLOBAL of BYTES — the only
/// thing `GlobalSize`/`GlobalLock` may legally be handed, and the only thing a
/// byte-level save/restore can round-trip.
///
/// *** RV-38 — this is the STATUS_HEAP_CORRUPTION root cause, not a style rule.
///
/// The v0.2.10 note above says a GDI-handle format 「fails with
/// ERROR_INVALID_HANDLE (6)」. That is not a contract — it is one outcome of
/// undefined behaviour. Measured on the owner's machine 2026-07-30, with a
/// picture on the clipboard, `GlobalSize` fed the handle that
/// `GetClipboardData(CF_BITMAP)` returns:
///
/// ```text
///     in this binary   0xffffffffac053dd6 / 0x12052211 / 0xffffffffa5051e43
///                      → 3 of 3 killed the process, 0xC0000374
///                        (STATUS_HEAP_CORRUPTION), and one of those runs did
///                        NOTHING else first — no decode, no paste, no
///                        snapshot — so this call IS the corruption, not a
///                        later detector of someone else's
///     in a bare pwsh   the same API on the same clipboard → 6 of 6 returned 0
///                      harmlessly
/// ```
///
/// The handle is an HBITMAP: a 32-bit GDI handle sign-extended into a 64-bit
/// slot, which is not a heap pointer and never was. Which branch of
/// GlobalSize/RtlSizeHeap then decides to fail-fast rather than shrug is NOT
/// established here, and guessing at it would be inventing a cause (the same
/// discipline `clipboard_confirm::set_delayed` applies to its own unexplained
/// 6). What IS established is the only thing that matters: the outcome is not
/// predictable from the call site, it is unrecoverable when it goes the other
/// way — no SEH, no `catch_unwind`, no forensic line, no last words — and
/// therefore 「it returned 6 last time」 and 「the tests pass now」 are both worth
/// nothing. The decision has to be made from the FORMAT ID, before the handle
/// is touched at all.
///
/// Probably — not provably — also the 2026-07-28 crash `gate.rs` was written
/// for: WER logged FlowMic.exe 0.2.0.0 dying twice with this same 0xC0000374 in
/// ntdll, same StackHash, immediately after re-injecting an image from the
/// phone's history menu, which is precisely when a picture is on the clipboard
/// and this snapshot runs. What is certain is that this hazard needs no
/// concurrency at all — one injection on one thread reaches it. That does NOT
/// retire `inject_gate()`: the interleaving it prevents (a shared `PENDING`
/// render slot, a restore putting back the other run's clipboard) is a real
/// second defect and still needs the lock.
///
/// Denied here, with the handle type each one really carries (Winuser.h):
///   CF_BITMAP / CF_DSPBITMAP          HBITMAP
///   CF_PALETTE                        HPALETTE
///   CF_ENHMETAFILE / CF_DSPENHMETAFILE HENHMETAFILE
///   CF_METAFILEPICT / CF_DSPMETAFILEPICT
///       an HGLOBAL, so Global* would not crash — but it EMBEDS an HMETAFILE
///       that `EmptyClipboard` deletes, so a byte copy 「restored」 afterwards
///       hands the next consumer a dangling GDI handle. Not memory-unsafe for
///       us; still not round-trippable, and the same answer serves both.
///   CF_OWNERDISPLAY                   no data at all (the owner draws it)
///   CF_PRIVATEFIRST..=CF_PRIVATELAST  owner-defined; the OS neither owns nor
///                                     frees them, so the handle type is
///                                     unknown by construction
///   CF_GDIOBJFIRST..=CF_GDIOBJLAST    GDI object handles by definition
///
/// Everything else — CF_TEXT / CF_DIB / CF_DIBV5 / CF_UNICODETEXT / CF_HDROP /
/// CF_LOCALE / CF_WAVE / CF_TIFF and every registered format — is an HGLOBAL of
/// bytes and still round-trips exactly as before.
#[cfg(target_os = "windows")]
fn is_hglobal_bytes_format(format: u32) -> bool {
    const CF_BITMAP: u32 = 2;
    const CF_METAFILEPICT: u32 = 3;
    const CF_PALETTE: u32 = 9;
    const CF_ENHMETAFILE: u32 = 14;
    const CF_OWNERDISPLAY: u32 = 0x0080;
    const CF_DSPBITMAP: u32 = 0x0082;
    const CF_DSPMETAFILEPICT: u32 = 0x0083;
    const CF_DSPENHMETAFILE: u32 = 0x008E;
    const CF_PRIVATEFIRST: u32 = 0x0200;
    const CF_PRIVATELAST: u32 = 0x02FF;
    const CF_GDIOBJFIRST: u32 = 0x0300;
    const CF_GDIOBJLAST: u32 = 0x03FF;
    !matches!(
        format,
        CF_BITMAP
            | CF_METAFILEPICT
            | CF_PALETTE
            | CF_ENHMETAFILE
            | CF_OWNERDISPLAY
            | CF_DSPBITMAP
            | CF_DSPMETAFILEPICT
            | CF_DSPENHMETAFILE
    ) && !(CF_PRIVATEFIRST..=CF_PRIVATELAST).contains(&format)
        && !(CF_GDIOBJFIRST..=CF_GDIOBJLAST).contains(&format)
}

#[cfg(target_os = "windows")]
struct WinClipboardApi;

#[cfg(target_os = "windows")]
impl ClipboardApi for WinClipboardApi {
    type Handle = windows::Win32::Foundation::HGLOBAL;

    fn open(&mut self) -> Result<(), u32> {
        // Retried on ERROR_ACCESS_DENIED, and it is not a rare case here: the
        // RESTORE runs immediately after Ctrl+V, exactly while the target app is
        // opening the clipboard to READ what we just pasted. owner 2026-07-29
        // (0.2.14, a real image send): `paste=Win32 error: 5` — the picture had
        // been pasted and the restore lost the race, and because a restore error
        // outranks the paste result the delivery was reported as failed.
        //
        // 10×15 ms mirrors clipboard_confirm::open_clipboard_retrying. Only
        // contention is waited out; any other error is returned at once.
        use windows::Win32::Foundation::{GetLastError, HWND};
        use windows::Win32::System::DataExchange::OpenClipboard;
        const ATTEMPTS: usize = 10;
        const ACCESS_DENIED: u32 = 5;
        let mut last = 0u32;
        for attempt in 0..ATTEMPTS {
            match unsafe { OpenClipboard(HWND(std::ptr::null_mut())) } {
                Ok(()) => return Ok(()),
                Err(_) => {
                    last = unsafe { GetLastError() }.0;
                    if last != ACCESS_DENIED {
                        return Err(last);
                    }
                    if attempt + 1 < ATTEMPTS {
                        std::thread::sleep(std::time::Duration::from_millis(15));
                    }
                }
            }
        }
        Err(last)
    }

    fn close(&mut self) -> Result<(), u32> {
        use windows::Win32::Foundation::GetLastError;
        use windows::Win32::System::DataExchange::CloseClipboard;
        unsafe { CloseClipboard().map_err(|_| GetLastError().0) }
    }

    fn empty(&mut self) -> Result<(), u32> {
        use windows::Win32::Foundation::GetLastError;
        unsafe {
            windows::Win32::System::DataExchange::EmptyClipboard().map_err(|_| GetLastError().0)
        }
    }

    fn enum_next(&mut self, previous: u32) -> Result<Option<u32>, u32> {
        use windows::Win32::Foundation::{GetLastError, SetLastError, WIN32_ERROR};
        use windows::Win32::System::DataExchange::EnumClipboardFormats;
        unsafe {
            SetLastError(WIN32_ERROR(0));
            let format = EnumClipboardFormats(previous);
            if format != 0 {
                return Ok(Some(format));
            }
            let error = GetLastError().0;
            if error == 0 {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }

    fn read(&mut self, format: u32) -> Result<Vec<u8>, u32> {
        use windows::Win32::Foundation::{GetLastError, HGLOBAL};
        use windows::Win32::System::DataExchange::GetClipboardData;
        use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
        // RV-38: decided from the FORMAT ID, before the handle is fetched, let
        // alone passed to the HGLOBAL API. For a handle-typed format the next
        // line is not 「returns an error we can report」 — it is 「the process is
        // killed by ntdll with no last words」. See `is_hglobal_bytes_format`.
        if !is_hglobal_bytes_format(format) {
            // ERROR_INVALID_HANDLE — the very code v0.2.10 built the skip path
            // around, so the CALLER's behaviour is byte-for-byte what it already
            // was: `save_with` skips this format and `save_clipboard` names it on
            // the forensic record. Only the way we arrive here changes, from
            // 「a wild Global* call happened to come back」 to 「we never made it」.
            return Err(6);
        }
        unsafe {
            let handle = GetClipboardData(format).map_err(|_| GetLastError().0)?;
            let global = HGLOBAL(handle.0);
            let size = GlobalSize(global);
            if size == 0 {
                return Err(GetLastError().0);
            }
            let source = GlobalLock(global) as *const u8;
            if source.is_null() {
                return Err(GetLastError().0);
            }
            let bytes = std::slice::from_raw_parts(source, size).to_vec();
            let _ = GlobalUnlock(global);
            Ok(bytes)
        }
    }

    fn allocate(&mut self, size: usize) -> Result<Self::Handle, u32> {
        use windows::Win32::Foundation::GetLastError;
        use windows::Win32::System::Memory::{GlobalAlloc, GMEM_MOVEABLE};
        unsafe { GlobalAlloc(GMEM_MOVEABLE, size).map_err(|_| GetLastError().0) }
    }

    fn write(&mut self, memory: Self::Handle, bytes: &[u8]) -> Result<(), u32> {
        use windows::Win32::Foundation::GetLastError;
        use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
        unsafe {
            let target = GlobalLock(memory) as *mut u8;
            if target.is_null() {
                return Err(GetLastError().0);
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), target, bytes.len());
            let _ = GlobalUnlock(memory);
            Ok(())
        }
    }

    fn set(&mut self, format: u32, handle: Self::Handle) -> Result<(), u32> {
        use windows::Win32::Foundation::{GetLastError, HANDLE};
        unsafe {
            windows::Win32::System::DataExchange::SetClipboardData(format, HANDLE(handle.0))
                .map(|_| ())
                .map_err(|_| GetLastError().0)
        }
    }

    fn free(&mut self, handle: Self::Handle) {
        unsafe {
            let _ = windows::Win32::Foundation::GlobalFree(handle);
        }
    }
}

#[cfg(target_os = "windows")]
pub fn save_clipboard() -> Result<ClipboardSnapshot, InjectError> {
    let snap = save_with(&mut WinClipboardApi)?;
    if !snap.skipped.is_empty() {
        // The skipped formats will NOT survive the restore — a real loss the
        // user can otherwise never explain (no silent failures). Kept to ids and a
        // count: the data itself may be the user's private content.
        crate::forensic::record(
            "inject",
            &format!(
                "clipboard snapshot skipped {} non-byte format(s) {:?} — restore cannot bring them back",
                snap.skipped.len(),
                snap.skipped
            ),
        );
    }
    Ok(snap)
}

#[cfg(target_os = "windows")]
pub fn write_clipboard_formats(formats: Vec<(u32, Vec<u8>)>) -> Result<(), InjectError> {
    replace_with(&mut WinClipboardApi, formats)
}

#[cfg(target_os = "windows")]
pub fn restore_clipboard(snapshot: ClipboardSnapshot) -> Result<(), InjectError> {
    write_clipboard_formats(snapshot.formats)
}

// ── macOS (MAC-05): the real save/restore ───────────────────────────────────
//
// The `ClipboardApi` trait above is a Win32 shape (open/empty/enumerate/HGLOBAL),
// so macOS does not implement it — NSPasteboard is a different machine and its
// three calls live in `inject/macos/pasteboard.rs`. What is IDENTICAL is the
// contract these two functions owe their caller, and that is the part that
// matters: save every readable type, name what could not be read, and put back
// exactly what was there.

#[cfg(target_os = "macos")]
pub fn save_clipboard() -> Result<ClipboardSnapshot, InjectError> {
    crate::inject::macos::pasteboard::save()
}

/// 🔴 NOT the macOS restore path, and the split is deliberate rather than an
/// omission. This function's signature takes WIN32 format ids — numbers with no
/// macOS meaning. Resolving one against the pasteboard type registry would
/// either fail or, worse, hit whatever UTI happened to be interned in that slot.
///
/// So: a NAMED refusal. This is byte-for-byte the behaviour macOS already had
/// (the old arm returned `Err(Win32(0))`); only the message changes, from a zero
/// with no call site to a sentence.
///
/// B3 (2026-08-11) did exactly what the previous version of this note asked
/// for: `shell/clipboard_copy.rs` grew a platform-neutral entry whose macOS
/// half calls `inject::macos::pasteboard::write_text`, so on macOS this
/// function now has NO caller outside the inject layer. The refusal stays as
/// the tripwire for any future caller that hands a Win32 id to this platform.
#[cfg(target_os = "macos")]
pub fn write_clipboard_formats(_: Vec<(u32, Vec<u8>)>) -> Result<(), InjectError> {
    Err(InjectError::Unsupported(
        "write_clipboard_formats takes WIN32 clipboard format ids, which have no meaning on \
         macOS. The restore path uses inject::macos::pasteboard::restore instead; a caller that \
         wants to put text on the macOS pasteboard needs a platform-neutral entry point",
    ))
}

#[cfg(target_os = "macos")]
pub fn restore_clipboard(snapshot: ClipboardSnapshot) -> Result<(), InjectError> {
    crate::inject::macos::pasteboard::restore(snapshot)
}

// ── every other host: FAIL, LOUDLY ──────────────────────────────────────────
//
// 🔴 `save_clipboard` USED TO RETURN `Ok(ClipboardSnapshot::default())` AND
// `restore_clipboard` `Ok(())`. Both are friendly empty implementations of the
// exact kind doc 13 §7 F1 ② forbids, and together with `paste_with_confirmation`'s
// `Ok(false)` they made a complete, silent, end-to-end lie:
// `ClipboardFallbackClient::paste_text` would run save → paste → restore, get
// three `Ok`s, and hand `pipeline::map_clipboard_outcome` a delivery. The user's
// clipboard was never read, never written and never restored, and the phone said
// injected.
//
// It could not be reached while focus tracking was a no-op on those hosts, which
// is exactly why it survived — an unreachable lie looks like a harmless stub. The
// macOS window made the same stub reachable for macOS, so the flip lands with the
// implementation (breakdown §0-2) and every remaining host now errors by name.
//
// ⚠️ `restore_clipboard` erroring is the SAFE direction: `clipboard_paste.rs`
// gives a restore failure priority over the paste result, so a host with no
// implementation reports INJECT_CLIPBOARD_FAIL instead of `injected`.

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
pub fn save_clipboard() -> Result<ClipboardSnapshot, InjectError> {
    Err(InjectError::Unsupported(
        "clipboard snapshot: this platform has no implementation. Returning an empty snapshot \
         here makes the restore that follows silently discard the user's clipboard",
    ))
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
pub fn write_clipboard_formats(_: Vec<(u32, Vec<u8>)>) -> Result<(), InjectError> {
    Err(InjectError::Unsupported(
        "clipboard write: this platform has no implementation",
    ))
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
pub fn restore_clipboard(_: ClipboardSnapshot) -> Result<(), InjectError> {
    Err(InjectError::Unsupported(
        "clipboard restore: this platform has no implementation. Returning Ok here claims the \
         user's clipboard was put back when nothing was ever saved",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    /// In-memory fake clipboard that records the open/empty/set call ordering
    /// so the round-trip (save → replace → restore) is provable headless.
    #[derive(Default)]
    struct FakeClip {
        store: HashMap<u32, Vec<u8>>,
        /// Formats that enumerate but refuse to be read — the GDI-handle class
        /// behind the Win32-error-6 failures (CF_BITMAP & friends).
        unreadable: HashSet<u32>,
        arena: Vec<Vec<u8>>,
        is_open: bool,
        log: Vec<String>,
    }

    impl ClipboardApi for FakeClip {
        type Handle = usize;

        fn open(&mut self) -> Result<(), u32> {
            self.is_open = true;
            self.log.push("open".into());
            Ok(())
        }
        fn close(&mut self) -> Result<(), u32> {
            self.is_open = false;
            self.log.push("close".into());
            Ok(())
        }
        fn empty(&mut self) -> Result<(), u32> {
            self.store.clear();
            self.log.push("empty".into());
            Ok(())
        }
        fn enum_next(&mut self, previous: u32) -> Result<Option<u32>, u32> {
            let mut keys: Vec<u32> = self.store.keys().chain(&self.unreadable).copied().collect();
            keys.sort_unstable();
            Ok(keys.into_iter().find(|&k| k > previous))
        }
        fn read(&mut self, format: u32) -> Result<Vec<u8>, u32> {
            if self.unreadable.contains(&format) {
                return Err(6); // ERROR_INVALID_HANDLE — the real failure signature
            }
            self.store.get(&format).cloned().ok_or(0)
        }
        fn allocate(&mut self, size: usize) -> Result<Self::Handle, u32> {
            self.arena.push(vec![0u8; size]);
            Ok(self.arena.len() - 1)
        }
        fn write(&mut self, handle: Self::Handle, bytes: &[u8]) -> Result<(), u32> {
            self.arena[handle] = bytes.to_vec();
            Ok(())
        }
        fn set(&mut self, format: u32, handle: Self::Handle) -> Result<(), u32> {
            let bytes = self.arena[handle].clone();
            self.store.insert(format, bytes);
            self.log.push(format!("set:{format}"));
            Ok(())
        }
        fn free(&mut self, _handle: Self::Handle) {}
    }

    #[test]
    fn an_unreadable_format_is_skipped_and_named_never_fatal() {
        // v0.2.10 (Win32 error: 6): a clipboard holding a GDI-handle format
        // (CF_BITMAP = 2) used to fail the WHOLE snapshot, and with it every
        // image paste, before the paste was even attempted.
        let mut clip = FakeClip::default();
        clip.store.insert(1, b"user text".to_vec());
        clip.unreadable.insert(2); // enumerates, then errors at read — the real signature
        clip.store.insert(13, vec![0xDE, 0xAD]);

        let snap = save_with(&mut clip).expect("an unreadable format must not fail the save");
        assert_eq!(snap.formats.len(), 2, "every readable format is still kept");
        assert_eq!(snap.skipped, vec![2], "the unreadable one is named, in order");

        // The restore brings back what was readable; the skipped format is
        // gone — the trade the module header states out loud.
        replace_with(&mut clip, snap.formats).expect("restore");
        assert_eq!(clip.store.get(&1).unwrap(), b"user text");
        assert_eq!(clip.store.get(&13).unwrap(), &vec![0xDE, 0xAD]);
    }

    #[test]
    fn save_then_restore_is_byte_identical() {
        let mut clip = FakeClip::default();
        clip.store.insert(1, b"user text".to_vec());
        clip.store.insert(13, vec![0xDE, 0xAD]);

        let snap = save_with(&mut clip).expect("save");
        assert_eq!(snap.formats.len(), 2);

        // Overwrite with something else, then restore the snapshot.
        replace_with(&mut clip, vec![(1, b"injected".to_vec())]).expect("replace");
        assert_eq!(clip.store.get(&1).unwrap(), b"injected");

        replace_with(&mut clip, snap.formats).expect("restore");
        assert_eq!(clip.store.get(&1).unwrap(), b"user text");
        assert_eq!(clip.store.get(&13).unwrap(), &vec![0xDE, 0xAD]);
    }

    /// RV-38: the memory-safety gate itself. `read` hands its argument to
    /// `GlobalSize`, and for a handle-typed format that call kills the process
    /// with STATUS_HEAP_CORRUPTION — so the ONLY thing standing between the
    /// user's clipboard and a silent process death is this predicate being
    /// right about which ids are HGLOBALs of bytes.
    ///
    /// It is a pure function on purpose: the crash it prevents is only
    /// reproducible when a picture happens to be on the real clipboard, and a
    /// guarantee that can only be tested when the weather is right is not a
    /// guarantee. Formats are spelled as literals here deliberately — restating
    /// the Winuser.h numbers is the point; importing the same constant the
    /// implementation uses would only prove it equals itself.
    #[cfg(target_os = "windows")]
    #[test]
    fn handle_typed_formats_never_reach_the_hglobal_api() {
        for gdi in [
            2u32,   // CF_BITMAP — the one that actually killed us
            3,      // CF_METAFILEPICT
            9,      // CF_PALETTE
            14,     // CF_ENHMETAFILE
            0x0080, // CF_OWNERDISPLAY
            0x0082, // CF_DSPBITMAP
            0x0083, // CF_DSPMETAFILEPICT
            0x008E, // CF_DSPENHMETAFILE
            0x0200, 0x0250, 0x02FF, // CF_PRIVATEFIRST..=CF_PRIVATELAST
            0x0300, 0x0350, 0x03FF, // CF_GDIOBJFIRST..=CF_GDIOBJLAST
        ] {
            assert!(
                !is_hglobal_bytes_format(gdi),
                "format {gdi:#06X} is handle-typed; GlobalSize on it can fail-fast the process"
            );
        }
        for bytes in [
            1u32,   // CF_TEXT
            4,      // CF_SYLK
            5,      // CF_DIF
            6,      // CF_TIFF
            7,      // CF_OEMTEXT
            8,      // CF_DIB — the format the image path itself writes
            10,     // CF_PENDATA
            11,     // CF_RIFF
            12,     // CF_WAVE
            13,     // CF_UNICODETEXT — the format the text path writes
            15,     // CF_HDROP
            16,     // CF_LOCALE
            17,     // CF_DIBV5
            0x0081, // CF_DSPTEXT
            0x01FF, // just below CF_PRIVATEFIRST
            0x0400, // just above CF_GDIOBJLAST
            0xC0F1, // a registered format (RegisterClipboardFormat range)
        ] {
            assert!(
                is_hglobal_bytes_format(bytes),
                "format {bytes:#06X} is an HGLOBAL of bytes and must still round-trip"
            );
        }
    }

    #[test]
    fn replace_empties_before_setting() {
        let mut clip = FakeClip::default();
        clip.store.insert(1, b"old".to_vec());
        replace_with(&mut clip, vec![(1, b"new".to_vec())]).expect("replace");
        let empty_idx = clip.log.iter().position(|s| s == "empty").unwrap();
        let set_idx = clip.log.iter().position(|s| s == "set:1").unwrap();
        assert!(empty_idx < set_idx, "EmptyClipboard must precede SetClipboardData");
    }
}
