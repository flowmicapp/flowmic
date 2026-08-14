// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §6 (connection layer — dual channels always
//     resident;
//     pairing token goes through DPAPI user-scoped wrapping)
//   docs/decisions/2026-07-26-dual-channel-spec-misref.md (GA-28 misref fix)
//   docs/rebuild/05-DATA-MODEL.md §7 (Cloud KEY = account JWT, HS256 {sub, plan},
//     7-day TTL; expired → auth:expired watchdog F-2093)
//   docs/rebuild/04-PROTOCOL-SPEC.md §2 (handshake `auth:{jwt}`; the negotiation
//     result never causes a connection refusal —— so a dead Cloud Key never
//     fails the handshake, it surfaces on the pc:register ack as
//     AUTH_TOKEN_EXPIRED/INVALID)
//   docs/strategy/R6-BACKLOG-AND-PLAN.md T-2 (dual channels: local LAN / cloud relay)
//   *** HUMAN-AUDIT SENSITIVE (pairing/auth) ***
//
// The two-channel model and the cloud channel's at-rest state.
//
// CREDENTIAL SLOT ISOLATION (T-2 architecture point ①, the thing that must not be got wrong):
// the device_token issued by `pc:register` is scoped to the server that issued
// it. A LAN sidecar's token is meaningless to the cloud relay and vice versa, so
// presenting the wrong one produces a `pc:reconnect` rejection and a dirty
// clear-then-reregister recovery. The two channels therefore keep PHYSICALLY
// SEPARATE credential files (`credentials.bin` = LAN, unchanged and byte
// compatible with every existing install; `credentials-cloud.bin` = cloud), so
// no code path can hand one server the other's token — the slot is chosen by the
// channel at connect time, not by a field a stale reference might read.
//
// The Cloud Key (the account JWT the user pastes from the console) NEVER touches
// either credential file: it lives in its own DPAPI-wrapped `cloud.bin` alongside
// the endpoint, so a cloud logout cannot orphan a pairing token and a LAN-only
// install never carries an account secret at all.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::socket::credentials::{dpapi_protect, dpapi_unprotect, Credentials};

/// Cloud pairing-credential file — a SIBLING of the LAN one, never the same file.
const CLOUD_CREDENTIALS_FILE: &str = "credentials-cloud.bin";
/// Cloud channel config (endpoint + Cloud Key), DPAPI-wrapped like the tokens.
const CLOUD_CONFIG_FILE: &str = "cloud.bin";
/// RV-83 (window B4-3) + **G-13 (window B4-16)**: the on-disk "already typed" ledger —
/// a SIBLING of the credential files, but deliberately **NOT** under their
/// per-channel isolation rule. There is exactly ONE of these per machine and
/// BOTH resident channel sessions read and write it.
///
/// WHY THE CREDENTIAL IS PER CHANNEL AND THIS IS NOT — the two files answer
/// different questions, so they get different scopes. A `device_token` answers
/// 「这台服务器认不认我」("does this server recognize me"): it is minted BY a
/// server and is meaningless to the
/// other one (§ above), so mixing the slots is a category error. A `request_id`
/// answers 「这一次投递」("this particular delivery"): it is minted by the PHONE, once per delivery, BEFORE
/// any channel is chosen, and the phone's outbox drains over whichever link is
/// up — 「目的地是一台机器，`pc_id` 只是它在某条通道上的别名」("the destination
/// is a machine; `pc_id` is only its alias on a particular channel")
/// (docs/decisions/2026-07-31-queue-destination-is-a-machine-not-a-connection.md).
/// So the same id legitimately arrives on LAN and later on cloud, and the only
/// scope at which 「这条打过了吗」("has this one already been typed") has a correct answer is THIS MACHINE.
///
/// ⚠️ Historical note (史注) — this WAS two files, one per channel, and that was a deliberate
/// choice, not an oversight: RV-83 mirrored `socket::client::connect`'s
/// then-shape (one `InjectDeduper` per channel session) rather than widening a
/// human-audit-sensitive scope unasked, and flagged the cross-channel hole it
/// left as vol. 15 **G-13** instead of silently fixing or silently ignoring it.
/// The hole was real (a queue drain that switched links typed the sentence a
/// second time, no restart required); owner authorised closing it in window B4-16.
///
/// The file NAME is unchanged from the old LAN one on purpose: every shipped
/// install's LAN facts already live in it, so they carry over with NO migration
/// at all. The retired CLOUD file is merged in once and then deleted — see
/// [`crate::socket::dedup::InjectDeduper::load_machine_ledger`]. Still plaintext
/// JSON, still no secret in it (dedup.rs's RV-83 block says why).
const MACHINE_TYPED_LEDGER_FILE: &str = "typed-ledger.json";
/// The pre-G-13 cloud-channel ledger. It survives as a constant for exactly one
/// reason — the migration has to be able to FIND it. Nothing writes it any more,
/// and after a successful merge nothing reads it either (the file is gone).
const LEGACY_CLOUD_TYPED_LEDGER_FILE: &str = "typed-ledger-cloud.json";

/// Tolerated clock skew when judging a Cloud Key's `exp` LOCALLY (seconds). The
/// server is the authority; this margin only keeps a slightly-fast local clock
/// from locking a user out of a key that is in fact still valid.
pub const CLOCK_SKEW_SECS: i64 = 300;

/// Local rejection code recorded when a pasted Cloud Key is not even JWT-shaped.
/// Shares the `auth_error` slot with the server's rejection codes because the UI
/// treatment is identical: one loud「这把钥匙不能用」("this key cannot be used") reason, never a silent drop.
pub const KEY_MALFORMED: &str = "KEY_MALFORMED";

/// The delivery channel. 07 §6 keeps BOTH resident (primary + presence); since
/// GA-28 this enum names WHICH session a thing belongs to, not which one exists.
/// The device-page selection is a PREFERENCE (where the capsule and the outbound verbs
/// go while no phone is speaking), no longer a switch that tears one down.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Channel {
    /// The local sidecar over the LAN (the 0.1.0 default).
    #[default]
    Lan,
    /// The cloud relay (flowmic.app or a self-hosted override).
    Cloud,
}

impl Channel {
    /// The stable machine tag crossing the Tauri IPC boundary (never a UI label —
    /// the zh labels live in the frontend strings module).
    pub fn tag(self) -> &'static str {
        match self {
            Channel::Lan => "lan",
            Channel::Cloud => "cloud",
        }
    }

    /// Parse a tag from the frontend. Unknown → `None` so the command fails loud
    /// instead of silently defaulting to a channel the user did not pick.
    pub fn from_tag(tag: &str) -> Option<Self> {
        match tag {
            "lan" => Some(Channel::Lan),
            "cloud" => Some(Channel::Cloud),
            _ => None,
        }
    }
}

/// RV-27 — the pairing DESTINATION for the device page's「添加手机」("add phone") flow:
/// the channel the phone is being told to dial, and that channel's address.
///
/// BOTH halves come out of one call on purpose. Before this, the endpoint on screen
/// was picked from the channel PREFERENCE while the 4-digit code beside it was read
/// through `Sessions::primary` — and primary follows whichever phone owns the capsule
/// (admission.rs), not the preference. With LAN preferred and a phone already on the
/// relay the two disagreed: the modal printed this machine's LAN address next to a
/// code only the RELAY had minted, so the phone dialled the sidecar with a code that
/// server never issued and got a (loud, but wrong) `PAIR_INVALID_CODE`.
///
/// The ENDPOINT side wins the tie. Pairing answers「手机要连哪台服务器」("which
/// server should the phone connect to"), so the code
/// has to be the one THAT server issued; a code from the other channel is not a
/// fallback, it is a wrong answer the phone will act on. Callers therefore read the
/// code from the `Channel` returned here — never from `primary` — and show no code
/// at all when that channel has no live session (the modal already offers a refresh, 刷新).
///
/// `lan_fallback` is lazy because it is only the pre-bring-up default (the dialed
/// loopback / env URL) and resolving it costs an env + path read.
pub fn pairing_destination(
    destination: Channel,
    cloud_endpoint: String,
    lan_endpoint: Option<String>,
    lan_fallback: impl FnOnce() -> String,
) -> (Channel, String) {
    match destination {
        // On the cloud channel a local NIC is not a pairing destination at all —
        // the phone must reach the relay (R6 T-2).
        Channel::Cloud => (Channel::Cloud, cloud_endpoint),
        Channel::Lan => (Channel::Lan, lan_endpoint.unwrap_or_else(lan_fallback)),
    }
}

/// The pairing-credential file for `channel`, derived from the LAN default path.
pub fn credentials_path(channel: Channel) -> PathBuf {
    credentials_path_beside(&Credentials::default_path(), channel)
}

/// Pure form of [`credentials_path`] (testable without touching LOCALAPPDATA):
/// LAN keeps the historical file verbatim, cloud gets a sibling.
pub fn credentials_path_beside(lan_path: &Path, channel: Channel) -> PathBuf {
    match channel {
        Channel::Lan => lan_path.to_path_buf(),
        Channel::Cloud => lan_path.with_file_name(CLOUD_CREDENTIALS_FILE),
    }
}

/// The cloud config file, a sibling of the credential files.
pub fn cloud_config_path() -> PathBuf {
    Credentials::default_path().with_file_name(CLOUD_CONFIG_FILE)
}

/// THE typed-request-id ledger for this machine (G-13), derived from the LAN
/// credentials path exactly like [`credentials_path`] — but taking NO channel,
/// because there is nothing to choose: one machine, one table (see the const's
/// block above for why this scope differs from the credential slots').
pub fn typed_ledger_path() -> PathBuf {
    typed_ledger_path_beside(&Credentials::default_path())
}

/// Pure form of [`typed_ledger_path`] (testable without touching LOCALAPPDATA).
pub fn typed_ledger_path_beside(lan_credentials_path: &Path) -> PathBuf {
    lan_credentials_path.with_file_name(MACHINE_TYPED_LEDGER_FILE)
}

/// Ledger files written by a PRE-G-13 build that this machine must carry
/// forward once and then retire. Never the live path — merging a file into
/// itself would be a no-op at best and a self-inflicted eviction at worst.
///
/// A `Vec` rather than a single path because the caller's contract is 「把所有
/// 旧账本都并进来」("merge in ALL the old ledgers"), not 「并进来那个云端的」
/// ("merge in the cloud one"): if a future build ever retires
/// another ledger file, this list is the one place that has to learn about it,
/// and `load_machine_ledger` needs no change at all.
pub fn legacy_typed_ledger_paths() -> Vec<PathBuf> {
    legacy_typed_ledger_paths_beside(&Credentials::default_path())
}

/// Pure form of [`legacy_typed_ledger_paths`].
pub fn legacy_typed_ledger_paths_beside(lan_credentials_path: &Path) -> Vec<PathBuf> {
    vec![lan_credentials_path.with_file_name(LEGACY_CLOUD_TYPED_LEDGER_FILE)]
}

/// Why the cloud channel can (not) be dialed right now. Every non-`Ready` variant
/// is a LOUD state the device page must render — the red line is that a broken
/// cloud channel never silently degrades into a LAN connection pretending to work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudReadiness {
    Ready,
    /// The server (or a local paste check) refused the key — carries the code.
    Rejected(String),
    NoEndpoint,
    NoKey,
    KeyExpired,
}

impl CloudReadiness {
    /// Machine tag for the device-page DTO.
    pub fn tag(&self) -> &'static str {
        match self {
            CloudReadiness::Ready => "ready",
            CloudReadiness::Rejected(_) => "rejected",
            CloudReadiness::NoEndpoint => "no_endpoint",
            CloudReadiness::NoKey => "no_key",
            CloudReadiness::KeyExpired => "key_expired",
        }
    }
    pub fn is_ready(&self) -> bool {
        matches!(self, CloudReadiness::Ready)
    }
}

/// The cloud channel's persisted state. DPAPI-wrapped as a whole (the `jwt` field
/// is the user's account bearer — it MUST NOT hit the disk in the clear), exactly
/// like the pairing credential file.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudConfig {
    /// The relay base URL. Empty until the user saves one — the DEFAULT comes from
    /// the protocol package (`DEFAULT_SAAS_ENDPOINT`) on the frontend and is passed
    /// in on save, so no endpoint literal is hardcoded anywhere in this crate.
    #[serde(default)]
    pub endpoint: String,
    /// The Cloud Key (account JWT). `None` = logged out.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub jwt: Option<String>,
    // RV-新B — there used to be an `active: bool` here (「用户选的主通道是云端吗」,
    // "is the user-selected primary channel cloud").
    // owner 2026-07-30 ② deleted the setting that wrote it, and a field with no writer
    // is a CONSTANT: every reader was asking「当前是哪条通道」("which channel is
    // current") and being handed `false`
    // forever. 「当前通道」("current channel") is now DERIVED from which phone is admitted
    // (socket::admission), and it is answered in exactly one place — the CONNECTION
    // snapshot / frame, which is also the only thing that gets pushed when it changes.
    // Deleted rather than left unwritten on purpose: an unread `false` in a persisted
    // struct is an invitation for the next reader to believe it.
    //
    // Old configs on disk simply have the key ignored (serde drops unknown fields), so
    // nothing has to migrate.
    /// Loud latch for the last key rejection (server `AUTH_TOKEN_EXPIRED` /
    /// `AUTH_TOKEN_INVALID`, or local `KEY_MALFORMED`). Cleared when a new key is
    /// saved. Present ⇒ the device page shows「请重新粘贴 Cloud Key」("please re-paste the Cloud Key").
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub auth_error: Option<String>,
}

impl CloudConfig {
    /// Store a freshly pasted Cloud Key + endpoint. Clears the rejection latch —
    /// the new key deserves a fresh verdict from the server.
    pub fn set_key(&mut self, jwt: impl Into<String>, endpoint: impl Into<String>) {
        self.jwt = Some(jwt.into());
        self.endpoint = endpoint.into();
        self.auth_error = None;
    }

    /// Forget the Cloud Key, recording WHY (a rejection code, or `None` for a
    /// deliberate user sign-out). The ENDPOINT survives, and the rejection latch keeps
    /// the cloud card loud — 「静默退回 LAN 假装正常」("silently falling back to
    /// LAN pretending it's fine") is the forbidden behavior. (Until
    /// RV-新B there was also a channel selection to preserve here; 「当前通道」
    /// ("current channel") is now
    /// derived from admission, so a lapsed key cannot move it either way.)
    pub fn clear_key(&mut self, reason: Option<&str>) {
        self.jwt = None;
        self.auth_error = reason.map(str::to_string);
    }

    /// First 6 chars of the key — deliberately the JWT HEAD (`eyJhbG…`, the
    /// base64 of the fixed `{"alg":"HS256"…}` header), which carries NO secret
    /// material. It exists so a forensic line / the UI can say "a key-shaped value
    /// is present" without ever transporting the key itself.
    pub fn key_head(&self) -> Option<String> {
        self.jwt.as_ref().map(|j| j.chars().take(6).collect())
    }

    /// The key's self-asserted claims. DISPLAY ONLY — this is an unverified read
    /// of the token's payload segment (the desktop holds no signing secret and
    /// makes NO authorization decision from it). The server remains the sole
    /// authority on whether a key is good.
    pub fn claims(&self) -> Option<CloudClaims> {
        self.jwt.as_deref().and_then(decode_claims)
    }

    /// The fail-loud verdict for `now` (unix seconds). Checked in priority order:
    /// an explicit rejection outranks everything, then configuration gaps, then
    /// the locally-visible expiry.
    pub fn readiness(&self, now_secs: i64) -> CloudReadiness {
        if let Some(code) = &self.auth_error {
            return CloudReadiness::Rejected(code.clone());
        }
        if self.endpoint.trim().is_empty() {
            return CloudReadiness::NoEndpoint;
        }
        let Some(jwt) = self.jwt.as_deref() else {
            return CloudReadiness::NoKey;
        };
        if is_expired(decode_claims(jwt).and_then(|c| c.exp), now_secs, CLOCK_SKEW_SECS) {
            return CloudReadiness::KeyExpired;
        }
        CloudReadiness::Ready
    }

    /// Load + DPAPI-unprotect, or the default (logged-out, no endpoint) config when
    /// absent / unreadable / written by another Windows user. Never a crash loop.
    ///
    /// This is `serde_json`, i.e. NAMED fields, which is why RV-新B could delete
    /// `active` outright: an existing file's `"active": true` is simply an unknown key
    /// now and is ignored, so no key or endpoint is lost on upgrade. (With a positional
    /// codec this deletion would have silently emptied every user's Cloud Key.)
    ///
    /// On unix, a successful read is followed by
    /// [`crate::socket::credentials::ensure_user_only`] — same upgrade gap as
    /// [`Credentials::load`], and for the same reason a tighten failure does
    /// NOT change what this returns. `Self::default()` means "no cloud has ever
    /// been configured", so mapping a chmod error onto it would make the Cloud
    /// Key and endpoint vanish from the UI over a permission bit. Logged, not
    /// swallowed.
    pub fn load(path: &Path) -> Self {
        (|| -> Option<Self> {
            let protected = std::fs::read(path).ok()?;
            #[cfg(unix)]
            if let Err(e) = crate::socket::credentials::ensure_user_only(path) {
                crate::forensic::record(
                    "cloud",
                    &format!("config mode tighten failed (file stays as-is, config still loaded): {e}"),
                );
            }
            let plain = dpapi_unprotect(&protected).ok()?;
            serde_json::from_slice(&plain).ok()
        })()
        .unwrap_or_default()
    }

    /// DPAPI-protect + persist, creating the parent directory. The Cloud Key is
    /// inside this blob, so this is the ONLY place it may reach the filesystem.
    ///
    /// ⚠️ MAC-08: on unix the file is 0600, and off Windows that is the only
    /// at-rest protection the Cloud Key gets (`dpapi_protect` is identity
    /// there). Shares one implementation with the pairing credential —
    /// see `credentials::write_user_only`.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let json = serde_json::to_vec(self).map_err(std::io::Error::other)?;
        let protected = dpapi_protect(&json).map_err(std::io::Error::other)?;
        crate::socket::credentials::write_user_only(path, &protected)
    }
}

/// A Cloud Key's self-asserted claims (05 §7: HS256 `{sub, plan, iat, exp}`).
/// `subject` is the account's user id, NOT the email — the email only exists
/// behind `/api/me`, which this build does not call, so the UI must not pretend
/// to know it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CloudClaims {
    pub subject: Option<String>,
    pub plan: Option<String>,
    pub exp: Option<i64>,
}

/// Longest claim string surfaced to the UI — a pasted value is untrusted input,
/// so a pathological payload can never become a giant DTO field.
const CLAIM_MAX_CHARS: usize = 64;

/// Decode the payload segment of a JWT. UNVERIFIED and DISPLAY-ONLY (see
/// [`CloudConfig::claims`]). Returns `None` for anything that is not a
/// three-segment token with a decodable JSON payload.
pub fn decode_claims(jwt: &str) -> Option<CloudClaims> {
    let mut parts = jwt.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let _signature = parts.next()?;
    if parts.next().is_some() {
        return None; // more than three segments — not a JWT
    }
    let plain = b64url_decode(payload)?;
    let v: serde_json::Value = serde_json::from_slice(&plain).ok()?;
    let s = |key: &str| {
        v.get(key)
            .and_then(serde_json::Value::as_str)
            .map(|raw| raw.chars().take(CLAIM_MAX_CHARS).collect::<String>())
    };
    Some(CloudClaims {
        subject: s("sub"),
        plan: s("plan"),
        exp: v.get("exp").and_then(serde_json::Value::as_i64),
    })
}

/// Whether a JWT-shaped string is well formed enough to be worth storing. Purely
/// structural (three non-empty base64url segments) — it proves nothing about
/// validity, it only stops an obviously-wrong paste (a password, a URL, a partial
/// copy) from being persisted and dialed.
pub fn is_jwt_shaped(raw: &str) -> bool {
    let parts: Vec<&str> = raw.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'=')
        })
}

/// Expiry judgement with a skew allowance. An absent `exp` is NOT treated as
/// expired — the server decides; we only act on an expiry the key itself states.
pub fn is_expired(exp: Option<i64>, now_secs: i64, skew_secs: i64) -> bool {
    match exp {
        Some(e) => now_secs - skew_secs > e,
        None => false,
    }
}

/// Unix seconds now (0 if the clock is before the epoch — never panics).
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Minimal base64url decoder (RFC 4648 §5, padding tolerated). Hand-rolled to
/// avoid pulling a dependency in for one display-only decode.
fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::with_capacity(s.len() * 3 / 4 + 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for ch in s.bytes() {
        let six: u32 = match ch {
            b'A'..=b'Z' => u32::from(ch - b'A'),
            b'a'..=b'z' => u32::from(ch - b'a') + 26,
            b'0'..=b'9' => u32::from(ch - b'0') + 52,
            b'-' => 62,
            b'_' => 63,
            b'=' => continue,
            _ => return None,
        };
        acc = (acc << 6) | six;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RELAY: &str = "https://flowmic.app";
    const LAN: &str = "http://10.0.0.78:41879";
    const DIALED: &str = "http://127.0.0.1:41879";

    #[test]
    fn the_pairing_code_and_the_pairing_endpoint_can_only_come_from_one_channel() {
        // RV-27. The single property this function exists to guarantee: the channel
        // handed back IS the channel the returned address belongs to, so a caller
        // cannot show one server's endpoint next to another server's 4-digit code.
        let (ch, ep) = pairing_destination(
            Channel::Cloud,
            RELAY.to_string(),
            Some(LAN.to_string()),
            || DIALED.to_string(),
        );
        assert_eq!(ch, Channel::Cloud);
        assert_eq!(ep, RELAY, "the phone must be sent to the relay, not to a local NIC");

        let (ch, ep) = pairing_destination(
            Channel::Lan,
            RELAY.to_string(),
            Some(LAN.to_string()),
            || DIALED.to_string(),
        );
        assert_eq!(ch, Channel::Lan);
        assert_eq!(ep, LAN, "the LAN destination is this machine's resolved address");

        // Stated as an invariant over both channels, not just the two cases above.
        for destination in [Channel::Lan, Channel::Cloud] {
            let (ch, ep) = pairing_destination(
                destination,
                "CLOUD".to_string(),
                Some("LAN".to_string()),
                || "FALLBACK".to_string(),
            );
            assert_eq!(ch, destination, "the destination is never silently swapped");
            assert_eq!(ep, if destination == Channel::Cloud { "CLOUD" } else { "LAN" });
        }
    }

    #[test]
    fn an_unresolved_lan_address_falls_back_without_changing_channel() {
        // Before /api/network answers there is no LAN address yet. The dialed /env
        // default stands in (the QR builder suppresses a loopback one — F-2346), but
        // the destination CHANNEL must not drift to cloud because of it: the code
        // would then be read off the relay session.
        let (ch, ep) = pairing_destination(Channel::Lan, RELAY.to_string(), None, || DIALED.to_string());
        assert_eq!(ch, Channel::Lan);
        assert_eq!(ep, DIALED);
    }

    #[test]
    fn the_lan_fallback_is_not_resolved_when_it_is_not_needed() {
        // It reads env + LOCALAPPDATA; the cloud path has no business paying for it.
        let mut called = false;
        let (_ch, ep) = pairing_destination(Channel::Cloud, RELAY.to_string(), None, || {
            called = true;
            DIALED.to_string()
        });
        assert_eq!(ep, RELAY);
        assert!(!called, "the cloud destination must not resolve a LAN default");
    }

    fn jwt_with_payload(payload_json: &str) -> String {
        // base64url(no padding) of the payload; header/signature are opaque here
        // because decode_claims only reads the middle segment.
        let mut out = String::new();
        let bytes = payload_json.as_bytes();
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut acc: u32 = 0;
        let mut bits: u32 = 0;
        for b in bytes {
            acc = (acc << 8) | u32::from(*b);
            bits += 8;
            while bits >= 6 {
                bits -= 6;
                out.push(ALPHABET[((acc >> bits) & 0x3F) as usize] as char);
            }
        }
        if bits > 0 {
            out.push(ALPHABET[((acc << (6 - bits)) & 0x3F) as usize] as char);
        }
        format!("eyJhbGciOiJIUzI1NiJ9.{out}.c2ln")
    }

    // ── ① credential slot isolation ────────────────────────────────────────
    #[test]
    fn lan_and_cloud_credentials_are_different_files_in_the_same_dir() {
        let lan = PathBuf::from("C:\\x\\FlowMic\\credentials.bin");
        let cloud = credentials_path_beside(&lan, Channel::Cloud);
        assert_eq!(credentials_path_beside(&lan, Channel::Lan), lan, "LAN path is untouched");
        assert_ne!(cloud, lan, "the cloud token must never share the LAN file");
        assert_eq!(cloud.parent(), lan.parent());
        assert_eq!(cloud.file_name().unwrap(), CLOUD_CREDENTIALS_FILE);
    }

    #[test]
    fn default_paths_keep_the_lan_file_name_unchanged() {
        // Byte-compatibility guard: existing installs must keep pairing on LAN.
        assert_eq!(credentials_path(Channel::Lan), Credentials::default_path());
        assert_ne!(credentials_path(Channel::Cloud), Credentials::default_path());
        assert_ne!(cloud_config_path(), credentials_path(Channel::Cloud));
    }

    // ── RV-83 + G-13: ONE ledger per machine, a sibling of the credentials ───
    #[test]
    fn the_typed_ledger_is_one_file_per_machine_never_the_credentials_file() {
        // G-13. The property is stated as「无论问哪条通道，答案都是同一个文件」
        // ("no matter which channel you ask, the answer is the same file"),
        // which is only expressible because the function takes no channel at
        // all — a signature that CANNOT return two paths is a stronger guard
        // than any assertion about the two it used to return.
        let lan_creds = PathBuf::from("C:\\x\\FlowMic\\credentials.bin");
        let ledger = typed_ledger_path_beside(&lan_creds);
        assert_eq!(ledger.parent(), lan_creds.parent(), "still a sibling of the credentials");
        assert_ne!(ledger, lan_creds, "the ledger must never share the credentials file");
        assert_eq!(ledger.file_name().unwrap(), MACHINE_TYPED_LEDGER_FILE);
        // …and it is BYTE-IDENTICAL to the file the pre-G-13 LAN channel wrote,
        // which is the whole migration story for the LAN half: nothing moves.
        assert_eq!(ledger.file_name().unwrap(), "typed-ledger.json");
        for channel in [Channel::Lan, Channel::Cloud] {
            assert_ne!(
                ledger,
                credentials_path_beside(&lan_creds, channel),
                "the ledger is never any channel's credential slot"
            );
        }
    }

    #[test]
    fn the_retired_cloud_ledger_is_listed_for_migration_and_is_not_the_live_file() {
        let lan_creds = PathBuf::from("C:\\x\\FlowMic\\credentials.bin");
        let live = typed_ledger_path_beside(&lan_creds);
        let legacy = legacy_typed_ledger_paths_beside(&lan_creds);
        assert_eq!(legacy.len(), 1, "one retired ledger to carry forward: the cloud one");
        assert_eq!(legacy[0].file_name().unwrap(), LEGACY_CLOUD_TYPED_LEDGER_FILE);
        assert_eq!(legacy[0].parent(), lan_creds.parent());
        // The live file must never appear in the retirement list: the migration
        // deletes what it merged, and deleting the live ledger would throw away
        // every 「打过了」("already typed") this machine knows.
        assert!(!legacy.contains(&live), "the live ledger must never be scheduled for deletion");
        assert_ne!(legacy[0], credentials_path_beside(&lan_creds, Channel::Cloud));
    }

    #[test]
    fn typed_ledger_default_paths_sit_beside_the_default_credentials_path() {
        assert_eq!(typed_ledger_path().parent(), Credentials::default_path().parent());
        assert_ne!(typed_ledger_path(), credentials_path(Channel::Lan));
        assert_ne!(typed_ledger_path(), credentials_path(Channel::Cloud));
        assert!(!legacy_typed_ledger_paths().contains(&typed_ledger_path()));
    }

    #[test]
    fn channel_tags_round_trip_and_unknown_fails_loud() {
        assert_eq!(Channel::from_tag(Channel::Lan.tag()), Some(Channel::Lan));
        assert_eq!(Channel::from_tag(Channel::Cloud.tag()), Some(Channel::Cloud));
        assert_eq!(Channel::from_tag("saas"), None);
        assert_eq!(Channel::from_tag(""), None);
        assert_eq!(Channel::default(), Channel::Lan);
    }

    // ── ② Cloud Key at rest ────────────────────────────────────────────────
    #[test]
    fn cloud_config_round_trips_and_the_key_is_never_plaintext_at_rest() {
        let dir = std::env::temp_dir().join(format!("flowmic-cloud-{}", uuid::Uuid::new_v4()));
        let path = dir.join("cloud.bin");

        let mut cfg = CloudConfig::default();
        cfg.set_key("eyJhbGciOiJIUzI1NiJ9.ZmFrZQ.s3cr3tsignature", "https://relay.example");
        cfg.save(&path).expect("save");

        #[cfg(windows)]
        {
            let raw = std::fs::read(&path).expect("read raw");
            let hay = String::from_utf8_lossy(&raw);
            assert!(!hay.contains("s3cr3tsignature"), "the Cloud Key must not be plaintext at rest");
        }

        let loaded = CloudConfig::load(&path);
        assert_eq!(loaded, cfg);
        assert!(loaded.jwt.is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_cloud_config_loads_as_the_logged_out_default() {
        let missing = std::env::temp_dir().join("flowmic-no-cloud-here.bin");
        let cfg = CloudConfig::load(&missing);
        assert!(cfg.jwt.is_none());
        assert_eq!(cfg.endpoint, "");
        assert_eq!(cfg.auth_error, None);
    }

    #[test]
    fn an_old_configs_active_flag_is_ignored_without_losing_the_key() {
        // RV-新B — the upgrade path for the deleted field. Every shipped build wrote
        // `"active"` into this file; deleting the field must not cost the user their
        // Cloud Key, which is exactly what a positional codec would have done.
        let dir = std::env::temp_dir().join(format!("flowmic-cloud-old-{}", uuid::Uuid::new_v4()));
        let path = dir.join("cloud.bin");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let legacy = br#"{"endpoint":"https://relay.example","jwt":"eyJhbGciOiJIUzI1NiJ9.ZmFrZQ.sig","active":true}"#;
        let protected = dpapi_protect(legacy).expect("protect");
        std::fs::write(&path, protected).expect("write");

        let cfg = CloudConfig::load(&path);
        assert_eq!(cfg.endpoint, "https://relay.example", "the endpoint survived");
        assert!(cfg.jwt.is_some(), "the Cloud Key survived the field deletion");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn key_head_is_six_chars_and_not_the_key() {
        let mut cfg = CloudConfig::default();
        cfg.set_key("eyJhbGciOiJIUzI1NiJ9.payload.signature", "https://relay.example");
        let head = cfg.key_head().expect("head");
        assert_eq!(head.chars().count(), 6);
        assert_eq!(head, "eyJhbG");
        assert!(!cfg.jwt.as_deref().unwrap().starts_with(&format!("{head}{head}")));
    }

    // ── claims (display-only) ──────────────────────────────────────────────
    #[test]
    fn decode_claims_reads_plan_sub_and_exp() {
        let jwt = jwt_with_payload(r#"{"sub":"user-42","plan":"pro","iat":1,"exp":1893456000}"#);
        let c = decode_claims(&jwt).expect("claims");
        assert_eq!(c.subject.as_deref(), Some("user-42"));
        assert_eq!(c.plan.as_deref(), Some("pro"));
        assert_eq!(c.exp, Some(1_893_456_000));
    }

    #[test]
    fn decode_claims_rejects_non_jwt_input() {
        assert_eq!(decode_claims("not-a-token"), None);
        assert_eq!(decode_claims("a.b"), None);
        assert_eq!(decode_claims("a.b.c.d"), None);
        assert_eq!(decode_claims("eyJhbGciOiJIUzI1NiJ9.!!!.sig"), None);
    }

    #[test]
    fn claim_strings_are_length_capped() {
        let long = "x".repeat(500);
        let jwt = jwt_with_payload(&format!(r#"{{"sub":"{long}"}}"#));
        let c = decode_claims(&jwt).expect("claims");
        assert_eq!(c.subject.unwrap().chars().count(), CLAIM_MAX_CHARS);
    }

    #[test]
    fn jwt_shape_check_rejects_obvious_mispastes() {
        assert!(is_jwt_shaped("eyJhbGciOiJIUzI1NiJ9.ZmFrZQ.sig"));
        assert!(!is_jwt_shaped(""));
        assert!(!is_jwt_shaped("hunter2"));
        assert!(!is_jwt_shaped("https://flowmic.app/console"));
        assert!(!is_jwt_shaped("eyJhbGciOiJIUzI1NiJ9..sig"), "empty segment");
        assert!(!is_jwt_shaped("eyJ.a b.sig"), "whitespace is not base64url");
    }

    // ── ⑤ expiry / readiness (fail-loud) ───────────────────────────────────
    #[test]
    fn expiry_honours_skew_and_an_absent_exp_is_not_expired() {
        assert!(!is_expired(Some(1_000), 1_000, CLOCK_SKEW_SECS));
        assert!(!is_expired(Some(1_000), 1_200, CLOCK_SKEW_SECS), "within skew");
        assert!(is_expired(Some(1_000), 1_400, CLOCK_SKEW_SECS), "past skew ⇒ expired");
        assert!(!is_expired(None, i64::MAX / 2, CLOCK_SKEW_SECS), "no exp ⇒ server decides");
    }

    #[test]
    fn readiness_covers_every_loud_state() {
        let now = 1_000_000;
        let live = jwt_with_payload(&format!(r#"{{"plan":"free","exp":{}}}"#, now + 86_400));
        let dead = jwt_with_payload(&format!(r#"{{"plan":"free","exp":{}}}"#, now - 86_400));

        let mut cfg = CloudConfig::default();
        assert_eq!(cfg.readiness(now), CloudReadiness::NoEndpoint);

        cfg.endpoint = "https://relay.example".into();
        assert_eq!(cfg.readiness(now), CloudReadiness::NoKey);

        cfg.set_key(&dead, "https://relay.example");
        assert_eq!(cfg.readiness(now), CloudReadiness::KeyExpired);

        cfg.set_key(&live, "https://relay.example");
        assert_eq!(cfg.readiness(now), CloudReadiness::Ready);
        assert!(cfg.readiness(now).is_ready());

        // A server rejection outranks everything and survives until a new paste.
        cfg.clear_key(Some("AUTH_TOKEN_EXPIRED"));
        assert_eq!(
            cfg.readiness(now),
            CloudReadiness::Rejected("AUTH_TOKEN_EXPIRED".into())
        );
        assert_eq!(cfg.readiness(now).tag(), "rejected");
        cfg.set_key(&live, "https://relay.example");
        assert_eq!(cfg.readiness(now), CloudReadiness::Ready, "a fresh key clears the latch");
    }

    #[test]
    fn clearing_the_key_keeps_the_endpoint_but_drops_the_secret() {
        let mut cfg = CloudConfig::default();
        cfg.set_key("eyJhbGciOiJIUzI1NiJ9.ZmFrZQ.sig", "https://relay.example");
        cfg.clear_key(Some("AUTH_TOKEN_EXPIRED"));
        assert_eq!(cfg.jwt, None, "the secret is gone");
        assert_eq!(cfg.endpoint, "https://relay.example");
        assert_eq!(cfg.auth_error.as_deref(), Some("AUTH_TOKEN_EXPIRED"));
        assert_eq!(cfg.key_head(), None);
    }
}
