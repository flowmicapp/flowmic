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
use crate::socket::pairing::{Pairing, ShortCodeState};
use crate::socket::refusal::is_account_auth_failure;
use crate::socket::wire;

/// 🔴 A SECOND, WIDER QUESTION THAN `pairing::is_account_auth_failure` — and
/// deliberately NOT folded into it.
///
/// That predicate answers 「should the Cloud Key be dropped」, and its two codes
/// are frozen (pairing_tests `account_auth_failures_are_exactly_the_two_frozen_
/// codes`). This one answers 「is this refusal a verdict about the ACCOUNT, or
/// about the one verb that asked」.
///
/// `ACCOUNT_RESTRICTED` is in this set and must never join that one: a restricted
/// account's key is perfectly valid, so clearing it would send the user to sign
/// in again — an action that succeeds and changes nothing, the dead-end button
/// this repo has ruled against twice.
///
/// (It lives here rather than beside its sibling because pairing.rs is at the
/// 800-line cap. Its only caller is [`DesktopSocket::note_account_refusal`]
/// below.)
pub fn is_account_validity_refusal(code: &str) -> bool {
    is_account_auth_failure(code) || code == "ACCOUNT_RESTRICTED"
}

/// The BODY of `DesktopSocket::note_account_refusal`, pulled out to a free
/// function that takes `&Pairing` instead of `&self`.
///
/// WHY (2026-09-02, WP-6): `emit_settings_update` below is the one ack-bearing
/// verb whose caller must NOT block waiting for the ack — 07 §8's "save
/// instantly on change" is a real latency budget on a path a slider can hit
/// many times a second, and blocking it for `timeout + 500ms` (every other verb
/// in this file's own pattern) would reintroduce exactly the lag that design
/// line forbids. So its ack callback runs the refusal report ASYNCHRONOUSLY, on
/// whichever thread `rust_socketio` invokes it, after `emit_settings_update`
/// has already returned — which means it cannot go through `&self` (not
/// `'static`) and must instead close over `Arc<Pairing>`, the SAME instance
/// every synchronous caller already reaches through `self.pairing`.
fn note_account_refusal_on(pairing: &Pairing, ctx: &str, code: Option<&str>) {
    if let Some(code) = code {
        if is_account_validity_refusal(code) {
            pairing.report_verb_refusal(ctx, code);
        } else {
            // Not an account verdict, so it must not reach the cloud card —
            // but it must not vanish either. `refresh_pairing_code` below
            // pays for this lesson at length: the relay said exactly what
            // was wrong, this layer dropped the sentence, and the machine
            // holding the answer could not answer from its own log. Applies
            // in particular to `PC_HANDSHAKE_PENDING`, which is the whole
            // trace a cold-start race leaves behind now that it no longer
            // costs the user their Cloud Key. `refresh_pairing_code` keeps
            // its own richer block (it also names the no-ack case), so that
            // one verb logs twice — deliberately, rather than by editing a
            // line another card argued for at length.
            crate::forensic::record(
                "socket",
                &format!("{ctx} refused: {code} (not an account verdict — reported, not acted on)"),
            );
        }
    }
}

impl DesktopSocket {
    /// 🔴 THE ONE PLACE A DEVICE-PAGE VERB HANDS AN ACCOUNT VERDICT TO THE SCREEN.
    ///
    /// Owner ruling 2026-08-27 §R1 追加
    /// (docs/decisions/2026-08-27-owner-persistent-login-and-routing-order.md):
    /// 「signed in locally」 and 「the service is available right now」 are two
    /// questions, and every refusal the relay sends must reach the screen. Since
    /// the credential stopped expiring on a clock, the relay's per-call verdict is
    /// the ONLY thing that can still tell a user their account stopped being served
    /// — so throwing it away is no longer merely untidy.
    ///
    /// WHAT WAS WRONG. Each verb below reduced its ack to `bool`/`Option` inside
    /// the socket callback. A relay answering `AUTH_TOKEN_INVALID` (which is also
    /// how a DELETED account arrives) came out as plain `false`, and the device
    /// page said 「the operation did not take effect (not connected or refused by
    /// the server) — please retry」 / 「… cannot be reached right now」: a network
    /// sentence for an auth verdict, a retry that can never work, and the Cloud Key
    /// left in place so the app went on looking signed in and fine. Meanwhile
    /// `pc:register` / `pc:reconnect` had carried exactly this verdict to exactly
    /// this surface since 0.2.x — the machinery existed, these five verbs simply
    /// never called it.
    ///
    /// WHAT THIS DOES NOT DO. It does not touch what the VERB reports. 「the rename
    /// did not take effect」 is still true and still shown; the account verdict is a
    /// SECOND fact with a second home (the red line on the cloud card), and folding
    /// them into one string is the shape this repo keeps paying for.
    ///
    /// Only [`is_account_validity_refusal`] codes are routed. A `PAIR_RATE_LIMITED`
    /// or a registry error is the verb's own business; painting it as an identity
    /// refusal would be the same defect pointing the other way.
    ///
    /// ⚠️ On the LAN channel this is a no-op beyond forensic: `auth_failure` is
    /// installed for the cloud channel only (pairing.rs `AuthFailureHook`), and a
    /// standalone sidecar has no accounts to refuse.
    ///
    /// 🔴 AND IT REPORTS WITHOUT DECIDING (2026-09-01). This used to call
    /// `report_refusal`, the same door `pc:register` / `pc:reconnect` use, which
    /// handed five verbs the authority to DELETE the Cloud Key. `pc:list-mobiles`
    /// racing a cold start's handshake then signed the user out of a session the
    /// relay accepted milliseconds later — four times on one machine in three
    /// days. A verb never observes the handshake, so `AUTH_TOKEN_INVALID` on a
    /// verb cannot distinguish 「the key was refused」 from 「the key has not been
    /// presented yet」, and the honest move for a layer that cannot tell two
    /// things apart is to say what it saw and decide nothing. The screen still
    /// gets the red line; the credential is now the handshake's business alone.
    fn note_account_refusal(&self, ctx: &str, code: Option<&str>) {
        note_account_refusal_on(&self.pairing, ctx, code);
    }

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
        let (tx, rx) = mpsc::channel::<(bool, Option<String>)>();
        let emit = self.client.emit_with_ack(
            events::PC_RELEASE_MOBILE,
            wire::build_pc_release_mobile(mobile_id, revoke),
            timeout,
            move |ack, _s| {
                let out = if let Payload::Text(vals) = ack {
                    let ok = wire::unwrap_ack(&vals)
                        .map(|o| wire::parse_release_mobile_ack(o, revoke))
                        .unwrap_or(false);
                    (ok, wire::ack_error_code(&vals))
                } else {
                    (false, None)
                };
                let _ = tx.send(out);
            },
        );
        if emit.is_err() {
            return false;
        }
        let (ok, refusal) = rx
            .recv_timeout(timeout + Duration::from_millis(500))
            .unwrap_or((false, None));
        self.note_account_refusal(events::PC_RELEASE_MOBILE, refusal.as_deref());
        ok
    }

    /// GA-10 — rename THIS PC (04 §3.7 reserved key), awaiting the ack.
    ///
    /// On success the new name is also written into the LOCAL credential. That
    /// second write is the part that is easy to miss: `device_name` is what a
    /// fresh `pc:register` sends, so a desktop that renamed only on the server
    /// would silently restore the old label the first time its token died and it
    /// re-registered — a rename that quietly undoes itself weeks later.
    pub fn rename_pc(&self, name: &str, creds_path: &std::path::Path, timeout: Duration) -> bool {
        let (tx, rx) = mpsc::channel::<(bool, Option<String>)>();
        let emit = self.client.emit_with_ack(
            events::SETTINGS_UPDATE,
            wire::build_pc_name_update(name),
            timeout,
            move |ack, _s| {
                let out = if let Payload::Text(vals) = ack {
                    let ok = wire::unwrap_ack(&vals)
                        .map(|v| v.get("ok").and_then(serde_json::Value::as_bool).unwrap_or(false))
                        .unwrap_or(false);
                    (ok, wire::ack_error_code(&vals))
                } else {
                    (false, None)
                };
                let _ = tx.send(out);
            },
        );
        if emit.is_err() {
            return false;
        }
        let (ok, refusal) = rx
            .recv_timeout(timeout + Duration::from_millis(500))
            .unwrap_or((false, None));
        self.note_account_refusal(events::SETTINGS_UPDATE, refusal.as_deref());
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
        let (tx, rx) = mpsc::channel::<(Option<String>, Option<String>)>();
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
                let refusal = if let Payload::Text(vals) = &ack { wire::ack_error_code(vals) } else { None };
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
                let _ = tx.send((code, refusal));
            },
        );
        if emit.is_err() {
            // 🔴 2026-08-31 — see the forensic block below: this early return used
            // to be the quietest of the three failures. Nothing was written
            // anywhere, and the modal said 「refresh failed, try again later」.
            crate::forensic::record(
                "pair",
                "refresh-code: could not emit (socket down) — no code minted",
            );
            return None;
        }
        // Give the ack callback a beat beyond its own timeout to land.
        let (code, refusal) = rx
            .recv_timeout(timeout + Duration::from_millis(500))
            .unwrap_or((None, None));
        self.note_account_refusal(events::PC_REFRESH_CODE, refusal.as_deref());
        // ── 🔴 WHY THIS LINE EXISTS (2026-08-31, and it cost a day) ────────────
        //
        // `note_account_refusal` above forwards ONLY `is_account_validity_refusal`
        // codes — auth failures and ACCOUNT_RESTRICTED. That is correct: a node
        // refusal is not an account fact, and painting it as one would put a red
        // 「your account」 line on a session that is working perfectly.
        //
        // But the code was then DROPPED ENTIRELY. When the relay answered
        // `NODE_IS_REPLICA` (a PC that had landed on the Tokyo replica could not
        // mint a code at all), the whole chain went: server says exactly what is
        // wrong and who can fix it → this layer throws the sentence away → the
        // modal shows 「refresh failed, try again later」 → the forensic log
        // contains NOT ONE WORD about it. The machine holding the answer could
        // not answer 「why can I not add a phone」 from its own log, and the
        // diagnosis had to be rebuilt from the outside against production.
        //
        // That is R11 in the diagnostic surface: the layer that has to make the
        // judgement must be given the fact. So every outcome of a mint is now
        // recorded, refusal code VERBATIM. It is forensic, not user copy — the
        // screen keeps its plain sentence (owner 2026-08-22: no internal
        // vocabulary in front of a user), and the log keeps the identifier.
        match (&code, &refusal) {
            (Some(_), _) => crate::forensic::record("pair", "refresh-code: minted"),
            (None, Some(err)) => crate::forensic::record(
                "pair",
                &format!("refresh-code: REFUSED by the server — {err}"),
            ),
            (None, None) => crate::forensic::record(
                "pair",
                "refresh-code: no ack within the timeout — no code minted",
            ),
        }
        code
    }

    /// pc:list-mobiles — the phones PAIRED to this PC (R6 T-8 device page). Like
    /// refresh_pairing_code / fetch_settings_list this AWAITS the ack; the ack's
    /// `mobiles` array is narrowed to the five public fields by
    /// `wire::parse_list_mobiles_ack` before it leaves this layer (no token can
    /// reach the frontend). `None` on a down socket / ack timeout / error ack —
    /// the page then says so instead of rendering a confident empty table.
    pub fn fetch_paired_mobiles(&self, timeout: Duration) -> Option<Value> {
        let (tx, rx) = mpsc::channel::<(Option<Value>, Option<String>)>();
        let emit = self.client.emit_with_ack(
            events::PC_LIST_MOBILES,
            wire::build_pc_list_mobiles(),
            timeout,
            move |ack, _s| {
                let out = if let Payload::Text(vals) = ack {
                    (
                        wire::unwrap_ack(&vals).and_then(wire::parse_list_mobiles_ack),
                        wire::ack_error_code(&vals),
                    )
                } else {
                    (None, None)
                };
                let _ = tx.send(out);
            },
        );
        if emit.is_err() {
            return None;
        }
        let (rows, refusal) = rx
            .recv_timeout(timeout + Duration::from_millis(500))
            .unwrap_or((None, None));
        self.note_account_refusal(events::PC_LIST_MOBILES, refusal.as_deref());
        rows
    }

    /// settings:update{key, value, updated_at?} — save instantly on change (07 §8).
    /// Returns whether the frame reached the transport (false → the frontend keeps
    /// the edit pending).
    ///
    /// `updated_at` is the frontend's own edit moment (card C3) and is passed
    /// straight through: this layer neither mints nor re-stamps it, because the
    /// frame may be a replay of an edit made a week ago and re-stamping is exactly
    /// what would let that replay overwrite a newer card on the phone.
    ///
    /// 🔴 2026-09-02 (WP-6) — READS THE ACK, but does not BLOCK on it: 07 §8's
    /// "instant" is a real budget on a path a settings slider can hit many times
    /// a second, and this is the one ack-bearing verb in this file whose caller
    /// must return before the ack could possibly have arrived (contrast
    /// `rename_pc` two verbs up, which blocks for exactly this event name — but
    /// for a deliberate one-off action, not a hot path). The refusal is still
    /// surfaced: forensic always, and the account-verdict codes (AUTH_TOKEN_*,
    /// ACCOUNT_RESTRICTED) reach the cloud card via `note_account_refusal_on`,
    /// same as every other verb — the callback runs on whichever thread
    /// `rust_socketio` invokes it, asynchronously, which is why it closes over
    /// a CLONED `Arc<Pairing>` rather than reaching through `&self`.
    ///
    /// Return value UNCHANGED from before this fix (RV-01's own words: "this
    /// frame failed to go out", never "the server refused it") — widening it to
    /// mean "and the server accepted it" would turn a NODE_IS_REPLICA refusal
    /// (routinely fixed by the generic handoff a moment later, WP-6) into a
    /// permanently-pending edit the retry queue can never clear.
    pub fn emit_settings_update(&self, key: &str, value: Value, updated_at: Option<&str>) -> bool {
        let pairing = self.pairing.clone();
        self.client
            .emit_with_ack(
                events::SETTINGS_UPDATE,
                wire::build_settings_update(key, value, updated_at),
                Duration::from_secs(5),
                move |ack, _s| {
                    let refusal = if let Payload::Text(vals) = &ack { wire::ack_error_code(vals) } else { None };
                    note_account_refusal_on(&pairing, events::SETTINGS_UPDATE, refusal.as_deref());
                },
            )
            .is_ok()
    }

    /// settings:list — pull the server-authoritative settings snapshot (WP-R3.5;
    /// 07 §8). Unlike the fire-and-forget verbs above this AWAITS the ack (like
    /// refresh_pairing_code): the ack carries `{ items: [{key,value}] }` and we
    /// return the `items` array Value for the frontend to adopt into its local
    /// display cache. `None` on a down socket / ack timeout / malformed ack — the
    /// frontend then simply keeps its local cache (never a fabricated snapshot).
    pub fn fetch_settings_list(&self, timeout: Duration) -> Option<Value> {
        let (tx, rx) = mpsc::channel::<(Option<Value>, Option<String>)>();
        let emit = self.client.emit_with_ack(
            events::SETTINGS_LIST,
            wire::build_settings_list(),
            timeout,
            move |ack, _s| {
                let out = if let Payload::Text(vals) = ack {
                    (
                        wire::unwrap_ack(&vals).and_then(wire::parse_settings_list_ack),
                        wire::ack_error_code(&vals),
                    )
                } else {
                    (None, None)
                };
                let _ = tx.send(out);
            },
        );
        if emit.is_err() {
            return None;
        }
        let (items, refusal) = rx
            .recv_timeout(timeout + Duration::from_millis(500))
            .unwrap_or((None, None));
        self.note_account_refusal(events::SETTINGS_LIST, refusal.as_deref());
        items
    }

    // 0.2.27: the four TIMELINE verbs (history:list / update / delete / inject) are
    // GONE — with the server's transcript store, there is nothing for them to address
    // (owner architecture ruling). `settings:update` above is now the only one-way outbound verb
    // whose failure is held in a durable queue; the timeline has no queue any more
    // because it has no uplink.
}

#[cfg(test)]
#[path = "outbound_tests.rs"]
mod outbound_tests;
