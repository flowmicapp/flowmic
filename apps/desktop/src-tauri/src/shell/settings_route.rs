// THE SETTINGS ROUTE — which server(s) a settings write is addressed to.
//
// MOVED OUT OF `shell/mod.rs` VERBATIM (2026-08-24) for the 800-line `file-size`
// lint, the same cap that already split `tray` and the session layer out of this
// module. It keeps its own file because this is the ONE place that answers
// 「which socket does a settings write go to」, and that question has a test
// below rather than only a comment.
//
// 🔴 THE ANSWER IS AGAIN 「the LAN one, always」 (owner 2026-09-03, phone-owned
// preferences). Between 2026-08-24 and this change there were TWO answers: four
// PREFERENCE keys (`stt.dictionary` / `stt.polish` / `stt.refine` /
// `scenario.card`) were emitted on every live socket, because the desktop owned
// those switches and a relay user's dictionary was otherwise inert. The owner's
// ruling removed the premise rather than the mechanism: those preferences now
// live on the PHONE, travel with each transcription request, and are never
// stored by any server — so the desktop has no screen that writes them and this
// side has nothing to fan out. The server refuses them from a PC outright
// (apps/server-core settings.handler.ts), so keeping the fan-out would only
// mean writing frames that come back refused.
//
// What is LEFT is what owner ⑤ was always about: `stt.routings` / `llm.config` /
// `device.pc_name` say WHICH ENGINE A SERVER SHALL USE, or name this machine.
// Pushing those at the relay would let any desktop repoint our managed engine at
// an arbitrary endpoint — a different feature (BYOK, which has its own audited
// route) wearing a settings-sync costume.

use serde_json::Value;
use tauri::State;
use crate::socket::blocking::run_blocking;

use super::{with_lan_socket, SocketState};
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
#[tauri::command]
pub fn settings_update(state: State<'_, SocketState>, key: String, value: Value, stamp: Option<String>) -> bool {
    // owner ⑤, restored whole (owner 2026-09-03): there is no per-key branch any
    // more, so there is no list to quietly grow either.
    with_lan_socket(&state, |s| s.emit_settings_update(&key, value, stamp.as_deref()), false)
}

/// settings:list snapshot pull (WP-R3.5; 07 §8). Unlike history_list this AWAITS
/// the ack and RETURNS the `items` array (`[{key,value}]`) directly, so the
/// frontend can adopt the server-authoritative settings into its local display
/// cache on the connected rising edge. `None` when the socket is down / the ack
/// times out — the frontend then keeps its local cache (never a blank overwrite).
#[tauri::command(async)]
pub fn settings_list(state: State<'_, SocketState>) -> Option<Value> {
    // P0 2026-09-03 — `#[tauri::command(async)]` puts this on a tokio
    // worker, and the body blocks on an ack wait (up to 5.5 s). See `socket::blocking`.
    run_blocking(|| {
        // owner ⑤: hydrate from the LAN server — the one this page configures.
        with_lan_socket(&state, |s| s.fetch_settings_list(std::time::Duration::from_secs(5)), None)
    })
}

#[cfg(test)]
mod tests {
    /// 🔴 THE RULE IS NOW 「EVERY KEY IS LAN-ONLY」, AND THAT IS WHAT IS ASSERTED —
    /// by reading this module's own source, because there is no longer a
    /// predicate to call. `is_preference_setting` / `PREFERENCE_SETTING_KEYS` /
    /// `with_every_socket` were deleted with the desktop screens that wrote the
    /// four preference keys (owner 2026-09-03), and a test asserting `false` for
    /// a function that no longer exists would not compile — while a test that
    /// merely stopped existing would leave the REVERSE half unguarded.
    ///
    /// The reverse half is the whole point and it has not changed shape: a
    /// per-key branch is how 「the desktop can now configure the relay's engine」
    /// would arrive — silently, in a commit that looked like it was about a
    /// dictionary. So the assertion is that `settings_update` has exactly one
    /// emit site and it is the LAN one.
    #[test]
    fn every_settings_key_is_lan_only() {
        let src = include_str!("settings_route.rs");
        let body = src
            .split_once("pub fn settings_update(")
            .expect("settings_update is still this module's write door")
            .1
            .split_once("#[tauri::command(async)]")
            .expect("settings_list still follows it")
            .0;
        assert!(
            body.contains("with_lan_socket"),
            "settings_update no longer targets the LAN socket (owner ⑤)",
        );
        assert_eq!(
            body.matches("with_lan_socket").count(),
            1,
            "settings_update grew a second emit path — one key, one socket",
        );
        assert!(
            !body.contains("with_every_socket"),
            "a settings key is being fanned out to the relay again; the phone owns the preferences \
             now and the server refuses these keys from a PC (owner 2026-09-03)",
        );
    }
}
