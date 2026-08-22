// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §2 (Stage 3 clipboard fallback — snapshot →
//     write → paste → unconditionally restore the original clipboard)
//   docs/strategy/2026-08-06-mac-usable-work-breakdown.md §A MAC-05 / MAC-06
//   master-plan §4 / CLAUDE.md red line: no silent failures / status only records
//     the delivery truth
//   *** HUMAN-AUDIT SENSITIVE (injection path) ***
//
// The macOS clipboard main path. On Windows the clipboard is a FALLBACK behind
// SendInput; here it is the only path V1 ships (the CGEvent typing path is
// deliberately deferred — breakdown §C), and the sequence is the same one the Win32
// side runs:
//
//   1. save()    — snapshot the user's pasteboard
//   2. paste()   — declare our type(s), write the bytes, ⌘V
//   3. restore() — put the user's pasteboard back (ALWAYS — clipboard_paste.rs
//                  owns that guarantee and this module must not duplicate it)
//
// ── 🔴 THE RECEIPT DOES NOT EXIST HERE, AND THAT IS STRUCTURAL ───────────────
//
// Windows offers DELAYED RENDERING: we announce a format with a NULL handle and
// the OS sends WM_RENDERFORMAT the moment a target actually reads it, which is a
// real receipt. **NSPasteboard has no equivalent that fits this design.** Its
// lazy-provider mechanism (`declareTypes:owner:` + `-pasteboard:provideDataForType:`)
// would need a live ObjC owner object and a run loop to be messaged on, and the
// MAC-05 card rules it explicitly out of scope: 「Do not invent a promised-data
// mechanism」.
//
// So [`ConfirmOutcome::confirmed`] returned from here is ALWAYS `false`, and it is
// false STRUCTURALLY — it means 「this platform has no receipt to give」, not 「the
// target refused」 and not 「nothing was observed in time」. Two consequences, both
// written down rather than discovered:
//
//   · `pipeline::receipt_phrase` has a macOS arm so the forensic line does not
//     claim we waited for a WM_RENDERFORMAT that cannot exist here;
//   · `clipboard_paste::paste_image`'s 「a CONFIRMED paste outranks a failed
//     restore」 branch is UNREACHABLE on macOS. A picture that really did land,
//     followed by a restore failure, is therefore reported as
//     INJECT_CLIPBOARD_FAIL — the F-4 shape from the 2026-08-03 M5 findings. The
//     only honest way to close that is a real receipt, and there is not one. It
//     is a named residual risk, not an oversight.
//
// ── The race the fixed delay is buying off ──────────────────────────────────
//
// ⌘V is posted asynchronously; the target reads the pasteboard when it processes
// the key event. Restore too early and the target pastes the user's ORIGINAL
// clipboard instead of our text — the exact lie the Win32 module's header opens
// with ("reporting `injected` falsely AND leaking the user's prior clipboard into
// the target"). With no receipt to wait for, V1 waits a fixed budget instead.
//
// 🔴 THE BUDGET IS THE CALLER'S `timeout`, AND THE REINTERPRETATION IS DELIBERATE.
// On Windows that parameter means 「how long we WATCH for a receipt」; here it means
// 「how long we HOLD the user's pasteboard before putting it back」. Those are two
// different questions, so borrowing one value for both needs a reason rather than
// a shrug: `PASTE_HOLD`'s own doc already states both halves — 「Ctrl+V
// processing is a few ms; 500ms comfortably covers a busy target without leaving
// the user's clipboard clobbered for long」 — and the second half IS the macOS
// meaning, unchanged. Inventing a second constant would give the same promise to
// the user's clipboard two numbers that could drift apart.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use objc2::rc::{autoreleasepool, Retained};
use objc2_app_kit::{NSPasteboard, NSPasteboardType, NSPasteboardTypeString};
use objc2_foundation::{NSArray, NSData, NSString};

use crate::inject::clipboard_confirm::{ConfirmOutcome, CLIPBOARD_SETTLE};
use crate::inject::clipboard_snapshot::ClipboardSnapshot;
use crate::inject::macos::event_post;
use crate::inject::sendinput::InjectError;

// ── The type registry: a UTI string behind the platform-neutral `u32` ────────
//
// The whole clipboard layer above this file speaks `(u32, Vec<u8>)` because that
// is what a Win32 clipboard format IS. macOS names its types with UTI STRINGS
// ("public.png"), which do not fit in a u32 — so they are INTERNED, exactly the
// way Win32's own `RegisterClipboardFormatW` interns a format NAME into an id.
// This is not a workaround bolted onto a Windows shape; it is the same mechanism
// the Windows shape came from, which is why `ClipboardSnapshot` needs no macOS
// field and `save`/`restore`/`paste` need no macOS signature.
//
// 🔴 THE BASE IS FAR ABOVE EVERY WIN32 FORMAT ID ON PURPOSE. Win32 ids run
// 1..=0x03FF for the built-ins and 0xC000..=0xFFFF for registered names, so an id
// from this registry can never be confused with one of those. That matters
// because `clipboard_snapshot::write_clipboard_formats` has a caller OUTSIDE the
// inject layer (`shell/clipboard_copy.rs`, which passes the literal
// `CF_UNICODETEXT`), and 「a Windows format id arriving here」 must be a NAMED
// refusal rather than an accidental match on whatever was interned first.

/// First id handed out by [`type_id`]. See the note above for why it is here.
pub const FIRST_TYPE_ID: u32 = 0x1000_0000;

static TYPES: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

fn registry() -> &'static Mutex<Vec<String>> {
    TYPES.get_or_init(|| Mutex::new(Vec::new()))
}

/// Intern a pasteboard UTI and return its stable process-wide id. Idempotent.
pub fn type_id(uti: &str) -> u32 {
    let mut list = match registry().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    if let Some(i) = list.iter().position(|s| s == uti) {
        return FIRST_TYPE_ID + i as u32;
    }
    list.push(uti.to_string());
    FIRST_TYPE_ID + (list.len() - 1) as u32
}

/// The UTI behind an id, or `None` when the id was not minted by [`type_id`].
///
/// `None` is the answer that keeps a Win32 format id from being pasted as
/// whatever UTI happened to land in that slot.
pub fn type_uti(id: u32) -> Option<String> {
    let i = id.checked_sub(FIRST_TYPE_ID)? as usize;
    let list = match registry().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    list.get(i).cloned()
}

/// `public.png` — the UTI MAC-06 writes the ORIGINAL PNG bytes under.
pub fn png_type_id() -> u32 {
    type_id("public.png")
}

/// `public.jpeg`.
pub fn jpeg_type_id() -> u32 {
    type_id("public.jpeg")
}

/// `org.webmproject.webp` — the UTI macOS itself uses for WebP.
pub fn webp_type_id() -> u32 {
    type_id("org.webmproject.webp")
}

/// The id for `NSPasteboardTypeString` (i.e. `public.utf8-plain-text`), read from
/// AppKit rather than spelled as a literal so it cannot drift from what
/// `setString:forType:` consumers actually look for.
pub fn string_type_id() -> u32 {
    // SAFETY: reading an AppKit `NSString *` global constant.
    let uti = unsafe { NSPasteboardTypeString }.to_string();
    type_id(&uti)
}

// ── The NSPasteboard calls ───────────────────────────────────────────────────
//
// 🔴 THREADING NOTE — read from the objc2 crate source ON THE MAC MINI, 2026-08-07,
// not from memory and not from folklore:
//   · `NSPasteboard`, `NSWorkspace` and `NSRunningApplication` are **NOT**
//     `MainThreadOnly` in objc2-app-kit 0.3.2 — none of the three carries the
//     marker, so none of their methods takes a `MainThreadMarker` and none of this
//     needs main-thread plumbing. The injection path runs on the socket thread and
//     may call them directly.
//   · The NSWorkspace activation observer (`focus/macos.rs`) likewise needs NO
//     `define_class!` delegate: `addObserverForName:object:queue:usingBlock:` takes
//     a `block2::DynBlock`, so `RcBlock::new` is the whole of it.
// Both are stated here because the folk rule 「every macOS UI class needs the main
// thread」 is what a future reader will reach for otherwise, and acting on it would
// add a pile of `MainThreadMarker` plumbing that buys nothing.
//
// Every entry point below is wrapped in an `autoreleasepool`. The socket thread is
// long-lived and has no pool of its own, so without one the autoreleased
// temporaries AppKit hands back would pile up for the life of the process.

fn general() -> Retained<NSPasteboard> {
    NSPasteboard::generalPasteboard()
}

/// Snapshot every readable type on the general pasteboard.
///
/// A type that enumerates but hands back no data is SKIPPED and named on
/// `ClipboardSnapshot::skipped` — byte-for-byte the policy the Win32 side settled
/// on for GDI-handle formats (v0.2.10): one unreadable type must not veto the
/// whole snapshot, and what will not survive the restore is said out loud.
///
/// ── 🔴 MEASURED ON THE MAC MINI, 2026-08-07: macOS SYNTHESIZES COMPANIONS ────
/// Writing TWO types (`public.utf8-plain-text` + `public.png`) and immediately
/// reading `types()` back gave SIX:
///
/// ```text
///     public.utf8-plain-text (16 B)   NSStringPboardType (16 B)
///     public.png (10 B)               Apple PNG pasteboard type (10 B)
///     public.tiff (0 B)               NeXT TIFF v4.0 pasteboard type (0 B)
/// ```
///
/// Three facts fall out of that, and none of them was obvious beforehand:
///   ① AppKit adds legacy aliases and CONVERTED representations on its own. A
///      round-trip through save/restore is therefore not 「the same two types」 —
///      it is all six, re-declared explicitly. The two real payloads came back
///      byte-identical, which is the guarantee that matters, and it was verified
///      rather than assumed.
///   ② The synthesized `public.tiff` came back with ZERO bytes for that sample (a
///      10-byte fake PNG that no decoder would accept). So a converted type can be
///      present-but-empty. It is recorded in `formats`, not `skipped`, because
///      `dataForType` ANSWERED — 「it gave us nothing」 and 「it refused」 are two
///      different facts and this file must not merge them.
///   ③ ⚠️ It does NOT prove macOS will hand a real target a usable TIFF for a real
///      PNG — the sample was not decodable. So this is not evidence that MAC-06's
///      declined TIFF companion (see `image::clipboard_formats`) is unnecessary.
///      It is only evidence that the pasteboard is doing more than we asked, which
///      is worth knowing before someone reads a 6-type snapshot as a bug.
pub fn save() -> Result<ClipboardSnapshot, InjectError> {
    autoreleasepool(|_pool| {
        let pb = general();
        let Some(types) = pb.types() else {
            // No types at all = an empty pasteboard. Not a failure.
            return Ok(ClipboardSnapshot::default());
        };
        let mut formats: Vec<(u32, Vec<u8>)> = Vec::new();
        let mut skipped: Vec<u32> = Vec::new();
        for t in types.to_vec() {
            let id = type_id(&t.to_string());
            match pb.dataForType(&t) {
                Some(data) => formats.push((id, data.to_vec())),
                None => skipped.push(id),
            }
        }
        if !skipped.is_empty() {
            let names: Vec<String> = skipped.iter().filter_map(|id| type_uti(*id)).collect();
            crate::forensic::record(
                "inject",
                &format!(
                    "pasteboard snapshot skipped {} unreadable type(s) {names:?} — the restore \
                     cannot bring them back",
                    skipped.len()
                ),
            );
        }
        Ok(ClipboardSnapshot { formats, skipped })
    })
}

/// Put a saved snapshot back on the general pasteboard.
///
/// An empty snapshot restores an EMPTY pasteboard (`clearContents`), which is the
/// truthful inverse of 「there was nothing there when we looked」 — leaving our
/// injected text behind because the user's clipboard happened to be empty would be
/// the leak this whole sequence exists to prevent.
pub fn restore(snapshot: ClipboardSnapshot) -> Result<(), InjectError> {
    let mut items: Vec<(String, Vec<u8>)> = Vec::with_capacity(snapshot.formats.len());
    for (id, bytes) in snapshot.formats {
        match type_uti(id) {
            Some(uti) => items.push((uti, bytes)),
            // Unreachable for a snapshot this module produced (every id came from
            // `type_id`), and a NAMED failure rather than a silent skip if it ever
            // happens: silently dropping a type here would delete a piece of the
            // user's clipboard and report success.
            None => {
                return Err(InjectError::Win32Step("restore: unknown pasteboard type id", id))
            }
        }
    }
    autoreleasepool(|_pool| write_items(&items))
}

/// Declare `items`' types and write their bytes, replacing the pasteboard.
///
/// `declareTypes:owner:` (rather than `clearContents` + `setData:forType:`) because
/// AppKit requires a type to be declared before `setData:forType:` will accept it,
/// and `declareTypes:` clears the pasteboard as part of declaring — one call, one
/// change count, no window in which the pasteboard is half ours.
fn write_items(items: &[(String, Vec<u8>)]) -> Result<(), InjectError> {
    let pb = general();
    if items.is_empty() {
        pb.clearContents();
        return Ok(());
    }
    let types: Vec<Retained<NSString>> = items
        .iter()
        .map(|(uti, _)| NSString::from_str(uti))
        .collect();
    let refs: Vec<&NSPasteboardType> = types.iter().map(|t| &**t).collect();
    let array = NSArray::from_slice(&refs);
    // SAFETY: `new_owner` is null (we promise no lazily-rendered data — see the
    // module header on why the promised-data mechanism is out of scope), and the
    // array holds `NSString`s, which is what `NSPasteboardType` is.
    unsafe { pb.declareTypes_owner(&array, None) };
    for ((uti, bytes), t) in items.iter().zip(types.iter()) {
        let data = NSData::with_bytes(bytes);
        if !pb.setData_forType(Some(&data), t) {
            // AppKit returns NO with no error object. The type is named so the
            // failure is actionable instead of being a bare false.
            crate::forensic::record(
                "inject",
                &format!("pasteboard setData:forType: refused {uti:?} ({} bytes)", bytes.len()),
            );
            return Err(InjectError::Win32Step("NSPasteboard setData:forType:", 0));
        }
    }
    Ok(())
}

/// B3 (2026-08-11, findings §3-1): the capsule row's copy button — a one-shot
/// FORWARD write of plain text. This is the macOS half behind
/// `shell/clipboard_copy.rs`'s platform-neutral entry (`copy_text_native`).
///
/// Same payload shape as [`paste_with_confirmation`]'s text half (UTF-8 bytes
/// under `NSPasteboardTypeString`), but NO ⌘V, NO snapshot and NO restore: a
/// copy button REPLACING the previous pasteboard content is exactly what
/// 「copy」 means on macOS, the same as the Win32 caller's header argues for
/// Windows. It is not part of an injection, so it must never touch the
/// save→paste→restore sequence above or its timing budget.
///
/// Failure is LOUD, not silent: `write_items` already names a refused type in
/// forensic and returns an error, which the shell command surfaces to the
/// capsule's ✗ state (no silent failures).
///
/// 🔴 PREPARED ONLY — written on the Windows lead box, where nothing in this
/// module compiles, so no gate on that machine can prove it even parses.
/// Until `./scripts/mac-verify.sh` has run on the Mac AND a real capsule copy
/// has been pasted into TextEdit there, this function's status is 「written」,
/// not 「working」.
pub fn write_text(text: &str) -> Result<(), InjectError> {
    let uti = {
        // SAFETY: reading an AppKit `NSString *` global constant.
        unsafe { NSPasteboardTypeString }.to_string()
    };
    let items = [(uti, text.as_bytes().to_vec())];
    autoreleasepool(|_pool| write_items(&items))
}

/// Write `items`, then ⌘V, then hold the pasteboard for `timeout` so the target
/// has a chance to read it before the caller restores.
///
/// See the module header for what `confirmed:false` means here (structural, not a
/// measurement) and why `timeout` is spent WAITING rather than WATCHING.
fn paste_items(items: &[(String, Vec<u8>)], timeout: Duration) -> Result<ConfirmOutcome, InjectError> {
    if items.is_empty() {
        return Ok(ConfirmOutcome::default());
    }
    autoreleasepool(|_pool| write_items(items))?;

    // The same settle the Win32 path pays before Ctrl+V, for the same reason: a
    // target that enumerates types the instant before our write lands sees the
    // OLD pasteboard and pastes it. 80ms on a path that is already asynchronous is
    // not a latency the user can feel.
    std::thread::sleep(CLIPBOARD_SETTLE);

    let posted = event_post::post_command_v();
    if !posted {
        // The window server would not even allocate the events. This is the ONE
        // failure this path can observe, and it is reported rather than folded
        // into 「the target did not take it」.
        return Err(InjectError::Win32Step("CGEventCreateKeyboardEvent(⌘V)", 0));
    }

    // Hold the pasteboard while the target processes the keystroke. THE CALLER
    // RESTORES IMMEDIATELY AFTER THIS RETURNS (clipboard_paste.rs), so this sleep
    // is the entire protection against 「the user's old clipboard got pasted
    // instead」. It is a fixed budget, not a confirmation.
    std::thread::sleep(timeout);

    let names: Vec<&str> = items.iter().map(|(uti, _)| uti.as_str()).collect();
    crate::forensic::record(
        "inject",
        &format!(
            "pasteboard paste PERFORMED types={names:?} — ⌘V posted, pasteboard held {}ms before \
             restore. NO read receipt exists on macOS (NSPasteboard has no WM_RENDERFORMAT \
             equivalent), so this line reports an ACT, never a landing.",
            timeout.as_millis()
        ),
    );
    Ok(ConfirmOutcome {
        confirmed: false,
        requested_format: None,
        // Structurally false on macOS: there is no delayed-rendering announcement to
        // withdraw here, so nothing can be dropped unrendered (F-4). The macOS
        // analogue of that shape is a restore failure — see the module header.
        dropped_unrendered: false,
        // 🔴 Structurally `Unavailable` TODAY, and that is a gap rather than a
        // platform fact: `inject/readback.rs` is UIA-only, so the read-back that
        // lets Windows stop holding early (and that tells it whether the text
        // landed at all) has no AX-API counterpart yet. Until it does, macOS pays
        // the full fixed hold on every paste and its `injected` rests on the act
        // alone — which is what it already rested on, so nothing regressed here;
        // it simply did not gain what Windows gained.
        landing: crate::inject::readback::LandingEvidence::Unavailable,
        held_ms: timeout.as_millis() as u32,
    })
}

/// The macOS `paste_with_confirmation` — the TEXT half.
///
/// Returns a [`ConfirmOutcome`] whose `confirmed` is structurally false on this
/// platform and whose `landing` is structurally `Unavailable`. Neither is 「the
/// paste failed」: `map_clipboard_outcome` reads `Ok(..)` as the delivery and both
/// flags only as forensic evidence (design §3, 2026-07-30).
///
/// ⚠️ SIGNATURE CHANGED 2026-08-22 (was `Result<bool, _>`) so both platforms hand
/// the caller the same record. The text is now passed down on Windows because
/// read-back compares against it; here it is still only the payload.
pub fn paste_with_confirmation(text: &str, timeout: Duration) -> Result<ConfirmOutcome, InjectError> {
    let uti = {
        // SAFETY: reading an AppKit `NSString *` global constant.
        unsafe { NSPasteboardTypeString }.to_string()
    };
    let items = [(uti, text.as_bytes().to_vec())];
    paste_items(&items, timeout)
}

/// The macOS `paste_formats_with_confirmation` — the IMAGE half (MAC-06).
///
/// Every id must have been minted by [`type_id`]; a foreign id is a NAMED refusal
/// rather than a paste of the wrong type.
pub fn paste_formats_with_confirmation(
    formats: &[(u32, Vec<u8>)],
    timeout: Duration,
) -> Result<ConfirmOutcome, InjectError> {
    let mut items: Vec<(String, Vec<u8>)> = Vec::with_capacity(formats.len());
    for (id, bytes) in formats {
        match type_uti(*id) {
            Some(uti) => items.push((uti, bytes.clone())),
            None => {
                return Err(InjectError::Win32Step(
                    "paste: clipboard format id has no macOS pasteboard type",
                    *id,
                ))
            }
        }
    }
    paste_items(&items, timeout)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The registry is the thing that lets a `u32`-shaped clipboard layer speak a
    /// string-shaped platform, so its two directions have to agree.
    #[test]
    fn interning_a_uti_is_idempotent_and_round_trips() {
        let a = type_id("public.png");
        let b = type_id("public.png");
        assert_eq!(a, b, "the same UTI must always intern to the same id");
        assert_eq!(type_uti(a).as_deref(), Some("public.png"));

        let other = type_id("public.jpeg");
        assert_ne!(a, other, "two UTIs must never collapse onto one id");
        assert_eq!(type_uti(other).as_deref(), Some("public.jpeg"));
    }

    /// 🔴 The guard that keeps `shell/clipboard_copy.rs`'s `CF_UNICODETEXT` (13)
    /// from being pasted as whatever UTI happens to sit in slot 13. Without the
    /// high base, a Win32 format id would silently ADDRESS a macOS type — the
    /// picture pasted as text, or the user's clipboard restored as the wrong type.
    #[test]
    fn a_win32_format_id_never_resolves_to_a_macos_type() {
        // Populate the registry first, so this is not passing because it is empty.
        let _ = png_type_id();
        let _ = jpeg_type_id();
        let _ = string_type_id();
        for win32_id in [
            1u32,    // CF_TEXT
            2,       // CF_BITMAP
            8,       // CF_DIB
            13,      // CF_UNICODETEXT — the one shell/clipboard_copy.rs passes
            0x03FF,  // top of the Win32 built-in range
            0xC000,  // bottom of the RegisterClipboardFormat range
            0xFFFF,  // top of it
        ] {
            assert_eq!(
                type_uti(win32_id),
                None,
                "Win32 format id {win32_id:#x} must not address a macOS pasteboard type"
            );
        }
        assert!(FIRST_TYPE_ID > 0xFFFF, "the base must clear every Win32 id");
    }

    /// A foreign id must be REFUSED by name rather than pasted as something else
    /// or silently dropped. This is the same rule the restore path applies, proved
    /// on the path a caller outside this module can actually reach.
    #[test]
    fn pasting_an_unknown_format_id_is_a_named_refusal() {
        let err = paste_formats_with_confirmation(&[(13, vec![0u8; 4])], Duration::from_millis(1))
            .expect_err("a Win32 format id has no macOS meaning");
        let text = err.to_string();
        assert!(
            text.contains("no macOS pasteboard type"),
            "the refusal must say WHAT was wrong, got {text:?}"
        );
    }

    /// …and the same for the restore direction. A snapshot carrying an id we
    /// cannot resolve must not be 「restored」 minus that piece.
    #[test]
    fn restoring_an_unknown_format_id_is_a_named_refusal_not_a_silent_drop() {
        let snap = ClipboardSnapshot {
            formats: vec![(13, b"user text".to_vec())],
            skipped: vec![],
        };
        let err = restore(snap).expect_err("an unresolvable id is not restorable");
        assert!(err.to_string().contains("unknown pasteboard type id"));
    }

    /// An empty format table is not a paste. Guarded here rather than upstream so
    /// the ⌘V cannot be posted with nothing on the pasteboard — which would paste
    /// whatever the user last copied INTO their app, in our name.
    #[test]
    fn an_empty_table_never_posts_a_keystroke() {
        let out = paste_items(&[], Duration::from_millis(1)).expect("no work is not a failure");
        assert!(!out.confirmed);
        assert_eq!(out.requested_format, None);
    }

    /// `confirmed` is false BY CONSTRUCTION on this platform, and that has to be
    /// an assertion rather than a comment: the day someone makes it true without a
    /// real receipt, `injected` starts claiming a landing macOS never reported.
    #[test]
    fn this_platform_can_never_manufacture_a_receipt() {
        let out = paste_items(&[], Duration::from_millis(1)).unwrap();
        assert!(
            !out.confirmed,
            "there is no WM_RENDERFORMAT equivalent here — a `true` could only be invented"
        );
    }
}
