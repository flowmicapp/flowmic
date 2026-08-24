// THE SETTINGS ROUTE — which server(s) a settings write is addressed to.
//
// MOVED OUT OF `shell/mod.rs` VERBATIM (2026-08-24) for the 800-line `file-size`
// lint, the same cap that already split `tray` and the session layer out of this
// module. No behaviour moved with the code. It earns its own file for a second
// reason though: this is now the ONE place that answers 「is this key a
// preference or a server configuration」, and that question has a test below
// rather than only a comment.

use serde_json::Value;
use tauri::State;

use super::{with_lan_socket, DesktopSocket, SocketState};
/// Change-immediately-persist-immediately settings write (07 §8). Returns whether the frame reached the wire;
/// `false` → the frontend holds it pending and re-flushes on reconnect.
///
/// `stamp` is the frontend's `updated_at` — WHEN THE USER MADE THE EDIT (04 §3.7-a,
/// card C3), minted in `apps/desktop/src/lib/settings-client.ts` and persisted with
/// the durable queue, so a replayed offline edit carries its own moment rather than
/// the reconnect's. Passed through untouched and omitted from the frame when
/// `None`: absent means UNKNOWN, which is exactly the pre-C3 behaviour.
///
/// ⚠️ The IPC argument is one word on purpose. `apps/desktop/src/lib/bridge.ts`
/// states that this boundary uses single-word argument names so that
/// camelCase↔snake_case never has to be reasoned about; `stamp` honours that,
/// while the WIRE field stays `updated_at`. The two names answer to two layers.
/// PREFERENCE keys — the ones that describe the USER, not a server.
///
/// 🔴 owner 2026-08-24 ruled that the settings page must configure BOTH legs.
/// This list is the narrowing, and the narrowing is on purpose: owner ⑤'s
/// original reason (see `with_lan_socket`) was that "the cloud relay's STT
/// routing and model live in the web console", and that reason is still correct
/// for the keys it was actually about. `stt.routings` / `llm.config` say WHICH
/// ENGINE A SERVER SHALL USE — pushing them at the relay would let any desktop
/// repoint our managed engine at an arbitrary endpoint, which is a different
/// feature (BYOK, which has its own audited route) wearing a settings-sync
/// costume.
///
/// The four below say nothing about a server. They say what this person's
/// vocabulary is, whether they want their transcript corrected, and how far.
/// They were swept into the LAN-only rule with the others, and the measured
/// consequence was that a personal dictionary, AI polish and two-pass refine
/// were INERT on the cloud relay — i.e. on the only leg that carries the user
/// when they are away from home (audit:
/// docs/strategy/2026-08-24-settings-pipeline-effectiveness-audit.md §2-3/§2-6).
///
/// ⚠️ Literals, not the frontend's `SETTINGS_ANCHOR_KEYS` constants: this side
/// of the IPC boundary has no access to them, and the pairing between the two
/// is what `settings_key_routing` in the tests below pins.
const PREFERENCE_SETTING_KEYS: &[&str] = &[
    "stt.dictionary",
    "stt.polish",
    "stt.refine",
    "scenario.card",
];

/// Is this key a user preference (both legs) rather than server config (LAN)?
pub(crate) fn is_preference_setting(key: &str) -> bool {
    PREFERENCE_SETTING_KEYS.contains(&key)
}

/// Emit on EVERY live channel. Returns `true` when at least one socket existed
/// and every socket that existed accepted the frame.
///
/// 🔴 THE RETURN VALUE ANSWERS ONE QUESTION AND IT IS NOT "did both legs get
/// it". A channel with no socket is not a failure — the user may simply not be
/// signed in to the relay — so an absent slot cannot make this `false`, or every
/// LAN-only user would sit permanently in the 「saved locally」 state with nothing
/// wrong. What covers the absent leg instead is the REPLAY: `flushPending`
/// re-sends every remembered key on a channel's connected rising edge, and the
/// desktop store watches BOTH edges for exactly this reason. A key that could
/// not reach the cloud today reaches it the moment the cloud connects, carrying
/// its own original `updated_at` so the server's regress guard still arbitrates.
fn with_every_socket(state: &State<'_, SocketState>, f: impl Fn(&DesktopSocket) -> bool) -> bool {
    let guard = match state.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    let mut seen = false;
    let mut all_ok = true;
    for channel in [crate::socket::Channel::Lan, crate::socket::Channel::Cloud] {
        if let Some(sock) = guard.slot(channel) {
            seen = true;
            if !f(sock) {
                all_ok = false;
            }
        }
    }
    seen && all_ok
}

#[tauri::command]
pub fn settings_update(state: State<'_, SocketState>, key: String, value: Value, stamp: Option<String>) -> bool {
    // owner ⑤ (server config) vs owner 2026-08-24 (user preferences) — see
    // PREFERENCE_SETTING_KEYS for why one rule became two.
    if is_preference_setting(&key) {
        return with_every_socket(&state, |s| s.emit_settings_update(&key, value.clone(), stamp.as_deref()));
    }
    with_lan_socket(&state, |s| s.emit_settings_update(&key, value, stamp.as_deref()), false)
}

/// settings:list snapshot pull (WP-R3.5; 07 §8). Unlike history_list this AWAITS
/// the ack and RETURNS the `items` array (`[{key,value}]`) directly, so the
/// frontend can adopt the server-authoritative settings into its local display
/// cache on the connected rising edge. `None` when the socket is down / the ack
/// times out — the frontend then keeps its local cache (never a blank overwrite).
#[tauri::command]
pub fn settings_list(state: State<'_, SocketState>) -> Option<Value> {
    // owner ⑤: hydrate from the LAN server — the one this page configures.
    with_lan_socket(&state, |s| s.fetch_settings_list(std::time::Duration::from_secs(5)), None)
}

#[cfg(test)]
mod tests {
    use super::is_preference_setting;

    /// The split, stated as a table rather than as prose.
    ///
    /// 🔴 The REVERSE half is the one that matters. Adding a key to
    /// `PREFERENCE_SETTING_KEYS` is how "the desktop can now configure the
    /// relay's engine" would arrive — silently, in a commit that looked like it
    /// was about a dictionary. These two assertions are what make that arrival
    /// loud, so do not delete the `false` rows to "simplify" the test: they are
    /// the test.
    #[test]
    fn preference_keys_travel_on_both_legs_and_server_config_does_not() {
        for key in ["stt.dictionary", "stt.polish", "stt.refine", "scenario.card"] {
            assert!(is_preference_setting(key), "{key} is a user preference and must reach both legs");
        }
        for key in ["stt.routings", "llm.config"] {
            assert!(
                !is_preference_setting(key),
                "{key} tells a SERVER which engine to use — pushing it at the relay is BYOK wearing a settings-sync costume (owner ⑤)",
            );
        }
    }

    /// An unknown key must default to the CONSERVATIVE leg. A typo'd or
    /// future key that silently gained relay reach would be the same defect in a
    /// different costume.
    #[test]
    fn an_unrecognised_key_stays_lan_only() {
        assert!(!is_preference_setting("stt.polishh"));
        assert!(!is_preference_setting("device.pc_name"));
        assert!(!is_preference_setting(""));
    }
}
