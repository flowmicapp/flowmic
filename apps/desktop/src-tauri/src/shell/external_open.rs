// The one door from the WebView to the user's BROWSER.
//
// ── WHY THIS EXISTS: EVERY EXTERNAL LINK IN THIS APP WAS DEAD ───────────────
//
// [measured 2026-08-21, read off the crate sources this build links against]
// `wry-0.55.1/src/webview2/mod.rs` installs a `NewWindowRequested` handler
// unconditionally, and its else-branch is one line:
//
//     } else { args.SetHandled(true)?; }
//
// — i.e. when no `new_window_req_handler` was supplied, WebView2 is told the
// request IS handled, and nothing opens. `tauri-2.11.5/src/webview/mod.rs`
// defaults `new_window_handler: None` (both construction sites), and this crate
// never calls `on_new_window` (grep: zero hits outside this comment).
//
// ⇒ `window.open(...)` and every `<a target="_blank">` in the FlowMic WebView
// was SILENTLY SWALLOWED. Not slow, not an error — nothing at all. That is the
// façade shape this repo hunts, in its purest form: something that looks exactly
// like a link and is not one. It was reported from the product side first
// (owner 2026-08-21, in-app update on Windows 10: 「要连接下载页去下载，但又点不开」
// — "it tells you to go to the download page, and then the page won't open").
//
// 🔴 THE FIX IS NOT A SECOND `window.open`. Windows declared in tauri.conf.json
// (this app's `main` and `capsule`) cannot be handed an `on_new_window`
// callback — that is a builder-only API — so the door has to be a command. ONE
// door, called by every site that wants a browser: an anchor left on
// `target="_blank"` would look identical to a working one and be dead again.
//
// ── WHAT IT WILL AND WILL NOT HAND TO THE OS ────────────────────────────────
//
// 🔴 `https://` ONLY, checked here rather than trusted from the page. The caller
// is a WebView, and one of the URLs it passes (`notes_url`) arrives from a
// REMOTE manifest — so "open whatever you are given" would let a manifest name
// `file:///…`, a UNC path or an `ms-…:` handler and have this process
// ShellExecute it. A one-scheme allowlist cannot be wrong about the schemes it
// does not contain.
//
// ⚠️ An `http://` release page (a self-hosted relay could publish one) is
// REFUSED rather than upgraded to https. Refusing shows the user the address and
// lets them decide; rewriting somebody's URL would be this process guessing.

use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

/// The longest URL we will hand to the OS. Real ones here are ~70 bytes; the
/// bound exists so a malformed manifest cannot push a megabyte into
/// `ShellExecute`.
const MAX_URL_LEN: usize = 2048;

/// Is this something we are willing to hand to the system browser?
///
/// **Pure**, so every refusal below is unit-testable without a shell. Each
/// clause is a shape that has bitten somebody, not general tidiness:
///   · non-ASCII / control chars / quotes / spaces / backslash — the classic way
///     a "URL" smuggles a second argument past a naive launcher;
///   · a scheme that is not `https://` — see the header;
///   · an empty host (`https:///x`) — names nothing;
///   · userinfo (`https://evil.example@real.example/`) — reads as one host and
///     resolves as another. We SHOW users the URL when an open fails, so a URL
///     that reads as a lie must not get that far.
pub fn is_openable_https(url: &str) -> bool {
    if url.len() > MAX_URL_LEN || !url.is_ascii() {
        return false;
    }
    if url.chars().any(|c| {
        c.is_ascii_control() || c == ' ' || c == '"' || c == '\'' || c == '\\' || c == '`'
    }) {
        return false;
    }
    let Some(scheme) = url.get(..8) else { return false };
    if !scheme.eq_ignore_ascii_case("https://") {
        return false;
    }
    let after = &url[8..];
    let host = &after[..after.find(['/', '?', '#']).unwrap_or(after.len())];
    !host.is_empty() && !host.contains('@')
}

/// The host part, for the forensic line.
///
/// 🔴 The log gets the HOST, never the whole URL — `shell/cloud.rs` states the
/// standing rule and the reason (a full URL carries query strings nobody audited
/// into a file we ship around). The host answers the only question this line
/// exists for: did we hand it over, and to whom.
fn host_of(url: &str) -> &str {
    let after = url.get(8..).unwrap_or("");
    &after[..after.find(['/', '?', '#']).unwrap_or(after.len())]
}

/// Open `url` in the user's default browser.
///
/// 🔴 Returns `Result`, and the caller RENDERS the failure. `invokeSafe` would
/// fold it into a console.warn, and a click that silently does nothing is the
/// exact defect this file was written to remove — replacing it with a second,
/// rarer silence would be treating the symptom.
///
/// ⚠️ `Ok(())` means the OS ACCEPTED the request, not that a browser is now in
/// front of the user. Same distinction `open_accessibility_settings` measures and
/// states; it is why every caller keeps the address itself reachable on screen.
#[tauri::command]
pub fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    if !is_openable_https(&url) {
        crate::forensic::record("extopen", "refused a URL that is not a plain https:// address");
        return Err("refused: not a plain https:// URL".to_string());
    }
    // Shell::open is deprecated in favour of tauri-plugin-opener; the migration
    // note on `open_log_directory` applies verbatim (both land on
    // `open::that_detached`, i.e. ShellExecuteExW on Windows), so this stays on
    // the path already proven in this app until that migration lands.
    #[allow(deprecated)]
    match app.shell().open(&url, None) {
        Ok(()) => {
            crate::forensic::record("extopen", &format!("handed {} to the OS", host_of(&url)));
            Ok(())
        }
        Err(e) => {
            crate::forensic::record(
                "extopen",
                &format!("the OS refused to open {} — {e}", host_of(&url)),
            );
            Err(format!("shell_open:{e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The allowlist, stated as cases. The rejects are the point: each is a
    /// string a caller could plausibly pass, and none may reach `ShellExecute`.
    #[test]
    fn only_plain_https_urls_are_openable() {
        for ok in [
            "https://flowmic.app",
            "https://flowmic.app/legal/privacy",
            "https://github.com/flowmicapp/flowmic/releases/tag/v0.3.23",
            "HTTPS://flowmic.app/",
            "https://relay.example:8443/notes?v=1#top",
        ] {
            assert!(is_openable_https(ok), "{ok} must be openable");
        }
        for bad in [
            // Wrong scheme — the remote-manifest attack surface, one line each.
            "http://flowmic.app",
            "file:///C:/Windows/System32/cmd.exe",
            "ms-settings:privacy",
            "javascript:alert(1)",
            "\\\\server\\share\\payload.exe",
            // Structurally not a URL we can vouch for.
            "https://",
            "https:///nohost",
            "https://evil.example@flowmic.app/",
            "https://flowmic.app/\nsecond-line",
            "https://flowmic.app/a b",
            "https://flowmic.app/\"quoted\"",
            "",
        ] {
            assert!(!is_openable_https(bad), "{bad:?} must be refused");
        }
        // Bounded.
        let long = format!("https://flowmic.app/{}", "a".repeat(MAX_URL_LEN));
        assert!(!is_openable_https(&long));
    }

    #[test]
    fn the_forensic_line_names_the_host_and_nothing_else() {
        assert_eq!(host_of("https://github.com/flowmicapp/flowmic/releases/tag/v1"), "github.com");
        assert_eq!(host_of("https://flowmic.app"), "flowmic.app");
        assert_eq!(host_of("https://relay.example:8443/x?y=1"), "relay.example:8443");
    }
}
