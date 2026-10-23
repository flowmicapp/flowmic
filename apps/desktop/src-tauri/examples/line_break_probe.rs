// Real-target probe for NR-253: what a typed or pasted line break does in the
// window that is in front RIGHT NOW.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// The unit tests in `inject/sendinput.rs` and `inject/text_route.rs` prove what
// we hand to Win32 and which keystroke each app name gets. Whether Shift+Enter
// is a new line and not a send in a given app is a claim about that app, and
// only a real window can answer it (docs/strategy/2026-10-14-nr253-safe-line-breaks.md).
//
// ── USAGE ────────────────────────────────────────────────────────────────────
//
//     cargo run --example line_break_probe -- <expected_hwnd> type|paste <text>
//
// `<text>` may carry the two-character escape `\n` for a line break.
//
// 🔴 CLAUDE.md D-8: it re-reads the foreground window immediately before acting
// and ABORTS (exit 3) unless it is `<expected_hwnd>`. Open your own test window,
// pass its handle, and never point this at a window you did not open.
//
// It calls the production pieces, not copies of them: the app name comes from
// `focus::current_app_name` (what the inject pipeline passes as `app_id`), and
// the delivery from `SendInputClient::type_text_for_app` — the same call
// `text_dispatch.rs::run_sendinput` makes, which picks the line-break keystroke —
// or `ClipboardFallbackClient::paste_text`. What it does NOT exercise is the
// route decision and fallback around them (`type_or_paste_with`).

use flowmic_desktop_lib::focus::{current_app_name, current_foreground_hwnd};
use flowmic_desktop_lib::inject::text_route::line_break_key_for;
use flowmic_desktop_lib::inject::{ClipboardFallbackClient, SendInputClient};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(hwnd), Some(mode), Some(text)) = (args.first(), args.get(1), args.get(2)) else {
        eprintln!("usage: line_break_probe <expected_hwnd> type|paste <text>");
        std::process::exit(2);
    };
    let Ok(expected) = hwnd.parse::<u64>() else {
        eprintln!("expected_hwnd must be a decimal window handle");
        std::process::exit(2);
    };
    let text = text.replace("\\n", "\n");

    let foreground = current_foreground_hwnd();
    if foreground != expected {
        eprintln!("ABORT: foreground {foreground} is not the expected window {expected}");
        std::process::exit(3);
    }
    let app_id = current_app_name(foreground);
    let key = line_break_key_for(Some(&app_id));
    println!("app_id={app_id} line_break_key={key:?} mode={mode}");

    match mode.as_str() {
        "type" => match SendInputClient::new().type_text_for_app(&text, Some(&app_id)) {
            Ok(n) => println!("typed units={n}"),
            Err(e) => {
                println!("type failed: {e}");
                std::process::exit(1);
            }
        },
        "paste" => match ClipboardFallbackClient::new().paste_text(&text) {
            // NR-254: this used to print `{out:?}`, and its `confirmed: true` was
            // read as 「the text landed」. It is the render receipt (somebody fetched
            // our format); `landing` is the landing evidence (inject/clipboard_paste.rs
            // `PasteOutcome`). Read the box itself to know what landed.
            Ok(out) => println!(
                "pasted: render_receipt={} (NOT landing evidence) landing={:?} held_ms={}",
                out.confirmed, out.landing, out.held_ms
            ),
            Err(e) => {
                println!("paste failed: {e}");
                std::process::exit(1);
            }
        },
        other => {
            eprintln!("unknown mode {other}");
            std::process::exit(2);
        }
    }
}
