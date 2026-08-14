// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §4 (capsule state consumes stt:level /
//     interim / final + inject:result), §9 (timeline four ops + refresh triggers)
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R2-2 deliverable C (stt:*/inject:result
//     forwarded to the frontend via Tauri emit)
//
// The seam between the AUDITED, tauri-free socket core (client.rs) and the Tauri
// window shell (lib.rs). client.rs must not depend on wry/webview2 — it is
// exercised by `cargo test` + the golden-path example without the app feature —
// so instead of calling `app.emit()` directly it pushes frontend-bound events
// through a `BridgeSink` closure. Under the `app` feature lib.rs installs a sink
// that maps `(channel, payload)` onto `AppHandle::emit`; under test/example there
// is simply no sink and the socket core runs unchanged.
//
// The channel names are `flowmic://…` (a URL-scheme shape, NOT a `word:word`
// socket-event name) so the protocol-whitelist lint's Rust scan never mistakes
// them for wire events — they are Tauri-local IPC channels, not socket.io events.

use serde_json::Value;
use std::sync::Arc;

/// A closure that delivers a frontend-bound `(channel, payload)` to the Tauri
/// shell. `Arc<dyn Fn>` so each socket handler can cheaply clone its own handle.
pub type BridgeSink = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// Tauri IPC channel names shared with the Vue frontend (see
/// apps/desktop/src/lib/bridge.ts, which listens on the exact same strings).
pub mod channel {
    // Capsule HUD data sources (07 §4).
    pub const STT_INTERIM: &str = "flowmic://stt-interim";
    pub const STT_FINAL: &str = "flowmic://stt-final";
    pub const STT_LEVEL: &str = "flowmic://stt-level";
    /// Real STT engine health forwarded from the server's `stt:engine-status`
    /// (R6-R2). Drives the capsule diagnostic's honest STT row (provider +
    /// ready|reconnecting|failed) instead of a hard-coded green「就绪」("ready").
    pub const STT_ENGINE_STATUS: &str = "flowmic://stt-engine-status";
    pub const AUDIO_START: &str = "flowmic://audio-start";
    pub const AUDIO_STOP: &str = "flowmic://audio-stop";
    /// Card F1 — the phone left / re-entered the foreground. owner ruling ①:
    /// 「电脑应该认为手机是『暂停』（还在配对，只是胶囊收起）」("The PC should
    /// consider the phone 'paused' — still paired, just with the capsule
    /// collapsed") ⇒ the capsule
    /// collapses on PAUSE and comes back on RESUME, and NOTHING else moves:
    /// the admission latch, the room membership and the device page's
    /// 「已配对手机」("paired phones") are all untouched (that is the whole ruling — a paused phone
    /// has NOT left). Consumer = apps/desktop/src/capsule/controller.ts
    /// `onAudioPause` / `onAudioResume`.
    pub const AUDIO_PAUSE: &str = "flowmic://audio-pause";
    pub const AUDIO_RESUME: &str = "flowmic://audio-resume";
    /// The truthful delivery outcome — drives the capsule just_injected morph and
    /// the timeline status reconcile.
    pub const INJECT_RESULT: &str = "flowmic://inject-result";
    /// A row for the PC timeline (07 §9). ⚠️ ITS PRODUCER IS LOCAL, NOT THE SERVER:
    /// `socket::row_transit::mint_row` builds a row from each `inject:request` this
    /// machine handles and forwards it here (owner architecture ruling transit-not-storage —
    /// the server stores no transcripts and broadcasts nothing). The `history:updated`
    /// socket forward in client.rs is kept only for an un-redeployed relay; the name
    /// and envelope are shared so the frontend keeps ONE「入站行 → 时间线行」
    /// ("inbound row → timeline row") path.
    pub const HISTORY_UPDATED: &str = "flowmic://history-updated";
    /// ⚠️ NO PRODUCER — a delete has no delivery frame to ride, and owner ⑦ is explicit
    /// that a PC-side delete does not travel and a phone cannot delete a PC row. The
    /// frontend handler survives for the LOCAL cross-window notice only.
    pub const HISTORY_DELETED: &str = "flowmic://history-deleted";
    // Settings peer broadcast (a peer PC changed a setting).
    pub const SETTINGS_UPDATED: &str = "flowmic://settings-updated";
    /// Connection / presence transitions — the frontend derives its reconnect
    /// re-flush and history refresh triggers (07 §9: connected rising edge /
    /// pc:mobile-joined) from these.
    pub const CONNECTION: &str = "flowmic://connection";
    /// Tray surface state (07 §7 / redesign §5.4). Rust-internal: the pump
    /// computes the three currently derivable states (disconnected /
    /// connected-idle / recording) into `{state, tooltip, status}`; the `app`
    /// shell listens here to drive TrayIcon::set_tooltip / set_icon and the
    /// disabled menu status row's set_text. A Tauri IPC channel, not a wire
    /// event (the `flowmic://` shape keeps the protocol-whitelist lint from
    /// mistaking it for a socket event).
    pub const TRAY_STATE: &str = "flowmic://tray-state";
    /// Sidecar lifecycle status (07 §5, WP-R2-4). The `app` shell emits the
    /// serialized `sidecar::Phase` here on bring-up / retry; the device page shows
    /// the status + a Retry button. A Tauri IPC channel, not a wire event.
    pub const SIDECAR_STATE: &str = "flowmic://sidecar-state";
    /// Cloud-relay channel state (R6 T-2). The `app` shell emits the serialized
    /// cloud status here whenever the active channel / Cloud Key / readiness
    /// changes; the device page renders the cloud relay (云端中继) card off it and the CAPSULE
    /// takes its channel label from it (previously a hardcoded「本地局域网」("local LAN")).
    /// A Tauri IPC channel, not a wire event.
    pub const CLOUD_STATE: &str = "flowmic://cloud-state";
    /// Foreground focus changed (GA-25). The pump pushes `{window_title,
    /// process_name}` here on the SAME change-only sample that feeds the wire
    /// `focus:state` mirror — one foreground tracking path, two sinks. The
    /// capsule takes its live「注入目标」("injection target") from it (before GA-25 the capsule showed
    /// the target of the LAST injection, never the current focus).
    ///
    /// DELIBERATELY NOT mobile-gated. The F-3113 gate on `focus:state` is a
    /// PRIVACY gate — the window title must not go on the WIRE with no phone to
    /// receive it. This channel never leaves the machine (Tauri IPC to our own
    /// WebView) so it has no privacy face, and the capsule is hidden anyway when
    /// no phone is present. Do not "fix" the missing gate here.
    pub const FOCUS_CHANGED: &str = "flowmic://focus-changed";
    /// Tray user-gesture summon (R6-C2). The tray double-click / 「显示胶囊」("Show
    /// Capsule") path
    /// emits this to the capsule window so the Vue visibility FSM re-syncs to
    /// persistent (previously the tray only moved the native window, leaving the
    /// frontend FSM out of step). A Tauri IPC channel, not a wire event.
    pub const TRAY_SUMMON: &str = "flowmic://tray-summon";
    /// U6 — the Rust-side UI locale changed (`shell::locale_sync::ui_locale_set`,
    /// invoked by the frontend's `reportUiLocale`). Rust-internal: the ONE
    /// listener is shell/tray.rs, which re-renders the tray menu items in the
    /// new language (status/tooltip re-render via the pump's next TRAY_STATE
    /// tick — the command clears the change-only memo). A Tauri IPC channel,
    /// not a wire event.
    pub const UI_LOCALE_CHANGED: &str = "flowmic://ui-locale-changed";
}

/// Convenience: forward a raw server payload on a fixed channel if a sink exists.
pub fn forward(sink: &Option<BridgeSink>, channel: &str, payload: Value) {
    if let Some(s) = sink {
        s(channel, payload);
    }
}

/// RV-01 — stamp the SOURCE CHANNEL onto a frontend-bound TIMELINE frame.
///
/// A timeline row's only address is (channel, id): the two resident channels are two
/// servers, and the frames that put rows into the frontend timeline
/// (`history:updated` / `history:deleted`; `history:list-result` until 0.2.27) carried
/// no channel at all, so the store was an UNTAGGED UNION of two servers' rows — and
/// every later edit / delete / re-inject then had to guess which server owned the row
/// it was addressing. It guessed `primary`, which answers a different question, and
/// that guess is the whole of RV-01. The stamp still matters after 0.2.27, when no
/// verb travels to a server any more: `(channel, id)` is how `inject:result` and the
/// page itself address a row, because both channels' rows live in one list.
///
/// Stamped HERE rather than trusted from the payload, for the same reason
/// `shell::paired` stamps its rows: the server has no idea which of our two sockets
/// received this frame, so any `channel` it happened to send is not an answer to
/// this question — it is overwritten.
///
/// `None` for a non-object payload: the caller records it and forwards NOTHING,
/// because a row that reaches the cache untagged is a row no verb can address.
pub fn tag_channel(payload: &Value, channel: &str) -> Option<Value> {
    let mut obj = payload.as_object()?.clone();
    obj.insert("channel".to_string(), Value::String(channel.to_string()));
    Some(Value::Object(obj))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_timeline_frame_is_forwarded_carrying_the_channel_that_received_it() {
        let frame = json!({ "item": { "id": "h1", "output_text": "hi" } });
        let tagged = tag_channel(&frame, "cloud").expect("an object is taggable");
        assert_eq!(tagged["channel"], json!("cloud"));
        // Everything else survives byte for byte — this is a stamp, not a rewrite.
        assert_eq!(tagged["item"], frame["item"]);
    }

    #[test]
    fn the_stamp_wins_over_anything_the_server_claimed() {
        // The server cannot know which of our two sockets it is answering, so a
        // `channel` in the payload is not an answer to this question.
        let frame = json!({ "id": "h1", "channel": "lan" });
        assert_eq!(tag_channel(&frame, "cloud").unwrap()["channel"], json!("cloud"));
    }

    #[test]
    fn a_frame_that_cannot_be_stamped_yields_none_so_the_caller_can_say_so() {
        assert!(tag_channel(&json!([1, 2]), "lan").is_none());
        assert!(tag_channel(&json!("nope"), "lan").is_none());
        assert!(tag_channel(&Value::Null, "lan").is_none());
    }
}
