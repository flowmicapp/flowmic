// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3 (protocol whitelist — canonical 56)
//   packages/protocol/src/events.ts (the SINGLE source of truth for wire
//     event names; this module is a Rust mirror of the subset the desktop
//     speaks)
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D3 (manual-mirror drift — a hand-mirrored
//     event list that drifts a release behind the SSOT is a real past bug)
//
// Every socket event NAME the desktop emits/handles MUST come from a constant
// here, never a bare string literal at the call site — that keeps the
// protocol-whitelist lint's Rust scan clean and forces any wire change through
// one reviewed place. The `guard` test below reads packages/protocol/src/
// events.ts at test time and fails if any constant value is not in that
// canonical list, so this mirror cannot silently drift from the SSOT.

// ─── §3.1 authentication / pairing ────────────────────────────────────
pub const PC_REGISTER: &str = "pc:register";
pub const PC_RECONNECT: &str = "pc:reconnect";
/// PC → server: mint a fresh 4-digit short code (WP-R23-1 device page — the
/// "Add Phone" (添加手机) modal refreshes an expired/absent code before showing it). Ack is
/// `{ short_code }`.
pub const PC_REFRESH_CODE: &str = "pc:refresh-code";
/// PC → server: list the phones PAIRED to this PC (R6 T-8 device page 「Paired
/// Phones (已配对手机)」 table). Empty payload — the socket's own identity is the scope. Ack is
/// `{ mobiles: [{pairing_id, mobile_name, paired_at, last_seen_at, online}] }`;
/// `mobile_token` is NOT in that projection and must never be read from it.
pub const PC_LIST_MOBILES: &str = "pc:list-mobiles";
/// PC → server: end a paired phone's access (GA-08 device page 「Disconnect｜Revoke
/// (断开｜撤销)」).
/// Payload `{ mobile_id?, revoke? }` — the additive `revoke` flag is the whole
/// difference between the two buttons: absent/false ends THIS session (the
/// server also holds a 60 s reconnect-suppression window on the pairing), while
/// `true` DELETES the mobile_pairings row, which is what actually kills the
/// phone's token. Ack is `{ ok, released, revoked, suppressed_ms }`.
/// Until GA-08 this event had no desktop emitter at all — not even a constant.
pub const PC_RELEASE_MOBILE: &str = "pc:release-mobile";
/// GA-10 — the RESERVED settings key (04 §3.7 F-3101). A settings KEY, not an
/// event name, so it is deliberately absent from the whitelist below: the wire
/// event is the ordinary `settings:update`.
pub const KEY_DEVICE_PC_NAME: &str = "device.pc_name";

pub const PC_MOBILE_JOINED: &str = "pc:mobile-joined";
pub const PC_MOBILE_LEFT: &str = "pc:mobile-left";
/// Server → PC when the pairing/session token is no longer valid; the desktop
/// clears its stored token and re-registers rather than reconnect-looping a
/// dead token.
pub const AUTH_EXPIRED: &str = "auth:expired";

// ─── §3.2 heartbeat / liveness ────────────────────────────────────────
pub const HEARTBEAT: &str = "heartbeat";
pub const SYS_PING: &str = "sys:ping";
pub const SYS_PONG: &str = "sys:pong";

// ─── §3.3 audio / STT ─────────────────────────────────────────────────
// WP-R2-1b: the desktop SUBSCRIBES to these two as an S→PC fan-out (F-2375).
// They are mobile→server events in the canonical whitelist; the server
// additively re-emits them to the paired PC (audio.handler) so the desktop can
// drive the SPEAKING lock (audio:start → lock the live foreground; audio:stop →
// speak-ended, lock retained until the inject path / watchdog releases it).
// No new event name, no whitelist/count-guard change (04 §3.3 doc rev only).
pub const AUDIO_START: &str = "audio:start";
pub const AUDIO_STOP: &str = "audio:stop";
// card F1: the desktop ALSO subscribes to the phone's lifecycle pause/resume, which
// the server mirrors to the paired PC on the same S→PC leg (audio.handler). Both
// names were already in the canonical whitelist and both schemas already existed —
// what was missing was any listener at all on this side, so a phone that went to
// background could tell the PC nothing. Whitelist unchanged (still 54).
// owner ruling ①: pause ≠ leave. These two drive the CAPSULE ONLY — they never
// touch the SPEAKING lock (an utterance paused mid-air still owns its target
// window) and never touch admission/presence.
pub const AUDIO_PAUSE: &str = "audio:pause";
pub const AUDIO_RESUME: &str = "audio:resume";
// WP-R2-2: the desktop SUBSCRIBES to the STT fan-out the server re-emits to the
// paired PC (bootstrap fan-out is in the audio/STT bridge). These drive the
// capsule HUD only (amplitude meter / interim & final preview) — they NEVER
// touch the SPEAKING lock or the inject pipeline, which key off audio:start/stop.
pub const STT_INTERIM: &str = "stt:interim";
pub const STT_FINAL: &str = "stt:final";
pub const STT_LEVEL: &str = "stt:level";
// WP-R6-R2: the desktop SUBSCRIBES to the server's engine-health event (the
// server fans it to the paired PC via the same emitter as stt:interim/final).
// Forwarded to the capsule diagnostic (honest engine status). HUD-only — never
// touches the SPEAKING lock or inject pipeline.
pub const STT_ENGINE_STATUS: &str = "stt:engine-status";

// ─── §3.5 inject / control ────────────────────────────────────────────
pub const INJECT_REQUEST: &str = "inject:request";
pub const INJECT_RESULT: &str = "inject:result";
pub const CONTROL_KEY: &str = "control:key";
pub const FOCUS_STATE: &str = "focus:state";

// ─── §3.6 history sync / §3.7 settings sync (WP-R2-2 timeline + settings UI) ──
// The desktop main window drives these through the Rust socket: it EMITS the
// outbound settings verbs and forwards the inbound results/broadcasts to the Vue
// frontend as Tauri events.
//
// ⚠️ 0.2.27 — FIVE history names were REMOVED from this mirror, and the reason is not
// a rename: the desktop no longer emits or receives them (owner architecture ruling,
// docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md).
//   · `history:list` / `history:update` / `history:delete` / `history:inject` — the
//     four OUTBOUND timeline verbs. The server stores no transcripts, so there is
//     nothing to list, edit, delete, or look up; the PC owns its rows (0.2.26) and
//     edits/deletes them locally, and deferred re-delivery (补投) is a local act
//     (`DesktopSocket::reinject_locally`).
//   · `history:list-result` — the answer to the pull that no longer happens.
// The two that REMAIN below have no producer either (`history.handler.ts` broadcasts
// nothing now); they are kept because a frame arriving would still be applied
// correctly and because their frontend handlers are the repo's only implementation of
// 「inbound row → timeline row」. ⚠️ Do not read that as「the timeline will not gain
// any more rows」: the IPC CHANNEL that
// shares this name (`bridge::channel::HISTORY_UPDATED`) has a LOCAL producer since the
// row-transit round — `socket::row_transit::mint_row`, off each delivery frame.
// The NAMES stay in packages/protocol/src/events.ts regardless
// (rule 8: deleting an event name turns an old client's frame into a silent drop) — this
// list is only「which names this crate references」, and its guard test is a SUBSET check.
pub const SETTINGS_UPDATE: &str = "settings:update";
pub const SETTINGS_UPDATED: &str = "settings:updated";
/// PC → server: pull the server-authoritative settings snapshot on the connected
/// rising edge (WP-R3.5 — desktop adopts server settings into its local display
/// cache at startup; 07 §8). Ack is `{ items: [{key, value}] }`; for a PC the
/// values are unredacted at-rest-decrypted plaintext (settings.handler §3.7).
pub const SETTINGS_LIST: &str = "settings:list";
pub const HISTORY_UPDATED: &str = "history:updated";
pub const HISTORY_DELETED: &str = "history:deleted";

/// Every event name this crate references — used by the cross-source guard
/// test and available to callers that want to assert membership.
pub const DESKTOP_EVENTS: &[&str] = &[
    PC_REGISTER,
    PC_RECONNECT,
    PC_REFRESH_CODE,
    PC_LIST_MOBILES,
    PC_RELEASE_MOBILE,
    PC_MOBILE_JOINED,
    PC_MOBILE_LEFT,
    AUTH_EXPIRED,
    HEARTBEAT,
    SYS_PING,
    SYS_PONG,
    AUDIO_START,
    AUDIO_STOP,
    AUDIO_PAUSE,
    AUDIO_RESUME,
    STT_INTERIM,
    STT_FINAL,
    STT_LEVEL,
    STT_ENGINE_STATUS,
    INJECT_REQUEST,
    INJECT_RESULT,
    CONTROL_KEY,
    FOCUS_STATE,
    SETTINGS_UPDATE,
    SETTINGS_UPDATED,
    SETTINGS_LIST,
    HISTORY_UPDATED,
    HISTORY_DELETED,
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Locate packages/protocol/src/events.ts from CARGO_MANIFEST_DIR
    /// (apps/desktop/src-tauri) — four hops up to the repo root.
    fn events_ts_path() -> PathBuf {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest
            .join("..")
            .join("..")
            .join("..")
            .join("packages")
            .join("protocol")
            .join("src")
            .join("events.ts")
    }

    /// Cross-source contract guard (13-LESSONS §3 D3): every Rust event
    /// constant must be a name present in the canonical events.ts whitelist.
    /// If the SSOT file is unreadable (e.g. a packaged build without the repo
    /// tree) the test degrades to a local self-consistency check rather than a
    /// false failure.
    #[test]
    fn desktop_events_are_a_subset_of_the_protocol_whitelist() {
        let path = events_ts_path();
        let ts = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => {
                // SSOT not on disk in this build context — still assert the
                // mirror is internally well-formed (each is an `x:y` name).
                for ev in DESKTOP_EVENTS {
                    assert!(
                        ev.contains(':') && !ev.is_empty(),
                        "event constant {ev:?} is malformed",
                    );
                }
                return;
            }
        };
        for ev in DESKTOP_EVENTS {
            let needle = format!("'{ev}'");
            assert!(
                ts.contains(&needle),
                "event constant {ev:?} is NOT in packages/protocol/src/events.ts \
                 (drift from the SSOT whitelist — {})",
                path.display(),
            );
        }
    }

    #[test]
    fn desktop_events_have_no_duplicates() {
        let mut seen = std::collections::HashSet::new();
        for ev in DESKTOP_EVENTS {
            assert!(seen.insert(*ev), "duplicate event constant {ev:?}");
        }
    }
}
