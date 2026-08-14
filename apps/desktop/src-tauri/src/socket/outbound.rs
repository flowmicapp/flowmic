// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §8 (settings save instantly on change, no save button),
//     §9 (timeline four ops + incremental refresh)
//   docs/strategy/R2-R3-TASK-CARDS.md WP-R2-2 (main window drives settings +
//     timeline through the Rust socket)
//
// WP-R2-2 OUTBOUND verbs the main window drives (settings:*, pairing/device-page
// reads), split out of client.rs so the audited inject/auth core stays under the
// file-size cap. Every event NAME comes from the events constants — never an inline
// literal.
//
// RV-01 — WHAT `false` MEANS HERE. This header used to describe the history verbs as
// "all fire-and-forget … the frontend re-flushes on reconnect … never a per-op ack".
// Two of those three clauses were false: nothing anywhere re-flushed the queue, and
// "never a per-op ack" was a design claim that threw away the answer the server was
// already sending. Those four verbs moved to `socket::timeline_ops`, which read the
// ack — and were RETIRED OUTRIGHT in 0.2.27, along with that module, when the server
// stopped storing transcripts (owner architecture ruling). What is left HERE is genuinely
// one-way, and always was: `settings:update`'s
// `false` means only "this frame failed to go out", which the frontend holds pending and REALLY
// re-flushes now (settings-client.flushPending).

use std::sync::mpsc;
use std::time::Duration;

use rust_socketio::Payload;
use serde_json::Value;

use crate::events;
use crate::socket::client::DesktopSocket;
use crate::socket::pairing::ShortCodeState;
use crate::socket::wire;

impl DesktopSocket {
    /// GA-18: milliseconds until the cached pairing code expires, or `None` when
    /// there is no code / the server sent no TTL. Lives beside the refresh verb
    /// that fills it (client.rs is at the file-size cap and this serves the same
    /// device-page surface).
    pub fn short_code_expires_in_ms(&self) -> Option<u64> {
        self.short_code
            .lock()
            .ok()
            .and_then(|s| s.as_ref().and_then(ShortCodeState::remaining_ms))
    }

    /// 0.2.66 — the relay's PUBLIC ADDRESSING id for this PC on THIS channel
    /// (`socket::pairing::SharedPcid`), as the device page's PULL. Lives here for
    /// the same reason `short_code_expires_in_ms` above does: client.rs is at the
    /// file-size cap and this serves the same device-page surface.
    ///
    /// `None` is a real and expected answer, not a failure: the LAN channel never
    /// has one (a standalone sidecar mints none — owner 2026-08-14 "the local
    /// LAN … has no PCID"), and neither does a relay older than this round. Both must read
    /// as "none" all the way to the QR builder, which then emits the pre-0.2.66
    /// payload byte for byte.
    pub fn pcid(&self) -> Option<String> {
        self.pairing.pcid.lock().ok().and_then(|g| g.as_ref().cloned())
    }

    /// pc:release-mobile (GA-08) — end ONE paired phone's access. `revoke=false`
    /// is "disconnect" (this session + the server's 60 s reconnect-suppression window);
    /// `revoke=true` is "revoke" (the pairing row is deleted — the phone must pair
    /// again). AWAITS the ack like the other device-page verbs: the page refreshes
    /// its table only after a genuine `{ok:true}`, so a failed action is never painted
    /// as a successful one.
    pub fn release_mobile(&self, mobile_id: &str, revoke: bool, timeout: Duration) -> bool {
        let (tx, rx) = mpsc::channel::<bool>();
        let emit = self.client.emit_with_ack(
            events::PC_RELEASE_MOBILE,
            wire::build_pc_release_mobile(mobile_id, revoke),
            timeout,
            move |ack, _s| {
                let ok = if let Payload::Text(vals) = ack {
                    wire::unwrap_ack(&vals)
                        .map(|o| wire::parse_release_mobile_ack(o, revoke))
                        .unwrap_or(false)
                } else {
                    false
                };
                let _ = tx.send(ok);
            },
        );
        if emit.is_err() {
            return false;
        }
        rx.recv_timeout(timeout + Duration::from_millis(500)).unwrap_or(false)
    }

    /// GA-10 — rename THIS PC (04 §3.7 reserved key), awaiting the ack.
    ///
    /// On success the new name is also written into the LOCAL credential. That
    /// second write is the part that is easy to miss: `device_name` is what a
    /// fresh `pc:register` sends, so a desktop that renamed only on the server
    /// would silently restore the old label the first time its token died and it
    /// re-registered — a rename that quietly undoes itself weeks later.
    pub fn rename_pc(&self, name: &str, creds_path: &std::path::Path, timeout: Duration) -> bool {
        let (tx, rx) = mpsc::channel::<bool>();
        let emit = self.client.emit_with_ack(
            events::SETTINGS_UPDATE,
            wire::build_pc_name_update(name),
            timeout,
            move |ack, _s| {
                let ok = if let Payload::Text(vals) = ack {
                    wire::unwrap_ack(&vals)
                        .map(|v| v.get("ok").and_then(serde_json::Value::as_bool).unwrap_or(false))
                        .unwrap_or(false)
                } else {
                    false
                };
                let _ = tx.send(ok);
            },
        );
        if emit.is_err() {
            return false;
        }
        let ok = rx
            .recv_timeout(timeout + Duration::from_millis(500))
            .unwrap_or(false);
        if ok {
            if let Ok(mut c) = self.creds.lock() {
                c.device_name = name.to_string();
                let _ = c.save(creds_path);
            }
        }
        ok
    }

    /// Mint a FRESH 4-digit short code via pc:refresh-code and return it. The
    /// device page's "add phone" modal calls this so it never shows a code that has
    /// already aged past the 5-min TTL (a stale code would fail the phone loudly
    /// with PAIR_INVALID_CODE — honest, but a poor first-run). Blocks up to
    /// `timeout` for the ack; `None` if the socket is down or the ack times out.
    /// Unlike the fire-and-forget verbs below, this one AWAITS an ack (the code).
    pub fn refresh_pairing_code(&self, timeout: Duration) -> Option<String> {
        let (tx, rx) = mpsc::channel::<Option<String>>();
        let sc = self.short_code.clone();
        // 🔴 0.2.66 — NO PCID IS READ HERE, and that is a decision rather than an
        // omission. The design (§5.5) listed this ack among the three that carry one;
        // the server deliberately narrowed it to two — `apps/server-core/src/socket/
        // handlers/pc.handler.ts`, the `pc:refresh-code` handler, states why: this
        // event mints a new SECRET, the ADDRESS cannot change (`stampPcid` never
        // rotates an existing pcid), and echoing it would put a second source for one
        // value on the wire. A reader for a key nobody sends is the repo's #1 defect
        // shape wearing a hat, so there is none: the PCID this session shows comes
        // from the register / reconnect ack that opened it.
        let emit = self.client.emit_with_ack(
            events::PC_REFRESH_CODE,
            wire::build_pc_refresh_code(),
            timeout,
            move |ack, _s| {
                let parsed = if let Payload::Text(vals) = ack {
                    wire::unwrap_ack(&vals).and_then(|o| {
                        o.get("short_code")
                            .and_then(Value::as_str)
                            // GA-18: the ack that mints the code also says how long
                            // it lives; both are cached together so the device page
                            // can count down without a second source of truth.
                            .map(|s| ShortCodeState::new(s.to_string(), wire::parse_expires_in_ms(o)))
                    })
                } else {
                    None
                };
                let code = parsed.as_ref().map(|p| p.code.clone());
                if let Some(state) = parsed {
                    if let Ok(mut g) = sc.lock() {
                        *g = Some(state);
                    }
                }
                let _ = tx.send(code);
            },
        );
        if emit.is_err() {
            return None;
        }
        // Give the ack callback a beat beyond its own timeout to land.
        rx.recv_timeout(timeout + Duration::from_millis(500)).ok().flatten()
    }

    /// pc:list-mobiles — the phones PAIRED to this PC (R6 T-8 device page). Like
    /// refresh_pairing_code / fetch_settings_list this AWAITS the ack; the ack's
    /// `mobiles` array is narrowed to the five public fields by
    /// `wire::parse_list_mobiles_ack` before it leaves this layer (no token can
    /// reach the frontend). `None` on a down socket / ack timeout / error ack —
    /// the page then says so instead of rendering a confident empty table.
    pub fn fetch_paired_mobiles(&self, timeout: Duration) -> Option<Value> {
        let (tx, rx) = mpsc::channel::<Option<Value>>();
        let emit = self.client.emit_with_ack(
            events::PC_LIST_MOBILES,
            wire::build_pc_list_mobiles(),
            timeout,
            move |ack, _s| {
                let rows = if let Payload::Text(vals) = ack {
                    wire::unwrap_ack(&vals).and_then(wire::parse_list_mobiles_ack)
                } else {
                    None
                };
                let _ = tx.send(rows);
            },
        );
        if emit.is_err() {
            return None;
        }
        rx.recv_timeout(timeout + Duration::from_millis(500)).ok().flatten()
    }

    /// settings:update{key, value} — save instantly on change (07 §8). Returns whether the frame
    /// reached the transport (false → the frontend keeps the edit pending).
    pub fn emit_settings_update(&self, key: &str, value: Value) -> bool {
        self.client
            .emit(events::SETTINGS_UPDATE, wire::build_settings_update(key, value))
            .is_ok()
    }

    /// settings:list — pull the server-authoritative settings snapshot (WP-R3.5;
    /// 07 §8). Unlike the fire-and-forget verbs above this AWAITS the ack (like
    /// refresh_pairing_code): the ack carries `{ items: [{key,value}] }` and we
    /// return the `items` array Value for the frontend to adopt into its local
    /// display cache. `None` on a down socket / ack timeout / malformed ack — the
    /// frontend then simply keeps its local cache (never a fabricated snapshot).
    pub fn fetch_settings_list(&self, timeout: Duration) -> Option<Value> {
        let (tx, rx) = mpsc::channel::<Option<Value>>();
        let emit = self.client.emit_with_ack(
            events::SETTINGS_LIST,
            wire::build_settings_list(),
            timeout,
            move |ack, _s| {
                let items = if let Payload::Text(vals) = ack {
                    wire::unwrap_ack(&vals).and_then(wire::parse_settings_list_ack)
                } else {
                    None
                };
                let _ = tx.send(items);
            },
        );
        if emit.is_err() {
            return None;
        }
        rx.recv_timeout(timeout + Duration::from_millis(500)).ok().flatten()
    }

    // 0.2.27: the four TIMELINE verbs (history:list / update / delete / inject) are
    // GONE — with the server's transcript store, there is nothing for them to address
    // (owner architecture ruling). `settings:update` above is now the only one-way outbound verb
    // whose failure is held in a durable queue; the timeline has no queue any more
    // because it has no uplink.
}
