// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §6 (connect layer — both channels resident)
//   docs/decisions/2026-07-26-dual-channel-spec-misref.md (GA-28 misref fix)
//   docs/rebuild/05-DATA-MODEL.md §7 (Cloud KEY = account JWT, 7-day TTL)
//   docs/ui-design/REDESIGN-PLAN.md §5.2 (device page dual channel cards: local LAN / cloud relay)
//   docs/strategy/R6-BACKLOG-AND-PLAN.md T-2
//   *** HUMAN-AUDIT SENSITIVE (pairing/auth) ***
//
// The `app`-feature control layer for the CLOUD RELAY channel: the managed
// CloudConfig (endpoint + Cloud Key + which channel is active), the device-page
// commands, and the fail-loud teardown that runs when the relay refuses our key.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE:
//   1. The Cloud Key never leaves the Rust side in the clear. `CloudStatusDto`
//      carries only `key_set` + a 6-char HEAD (the JWT's fixed algorithm-header
//      prefix) — never the key, and no forensic line ever prints more than that.
//   2. A refused / expired key is LOUD: the key is dropped, the channel stays
//      selected in a logged-out state, and the device page says 「云端登录已过期，
//      请重新粘贴 Cloud Key」 ("cloud login has expired, please paste the Cloud Key again"). It never silently reverts to the LAN channel and
//      pretends everything is fine.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::forensic;
use crate::socket::bridge;
use crate::socket::channel::{self, Channel, CloudConfig, KEY_MALFORMED};
use crate::socket::cloud_endpoint::{self, EndpointMigration};
use crate::socket::pairing::{is_account_auth_failure, AuthFailureHook};

use super::sidecar_ctl;

/// Managed cloud-channel state (one per desktop process).
pub struct CloudState {
    path: PathBuf,
    cfg: Mutex<CloudConfig>,
}

impl Default for CloudState {
    fn default() -> Self {
        Self::load()
    }
}

impl CloudState {
    /// Read the persisted config (DPAPI). A missing / unreadable file loads as the
    /// default = LAN active, no key — never a crash, never a half state.
    pub fn load() -> Self {
        let path = channel::cloud_config_path();
        let cfg = CloudConfig::load(&path);
        Self { path, cfg: Mutex::new(cfg) }
    }

    pub fn snapshot(&self) -> CloudConfig {
        self.cfg.lock().map(|c| c.clone()).unwrap_or_default()
    }

    // RV-新B — `active_channel()` used to live here and it is GONE. It read
    // `CloudConfig.active`, a flag whose only writer (the device page's 「set as
    // primary channel」)
    // owner's 2026-07-30 ruling ② deleted, so it had become a constant `false` that every caller
    // was reading as 「which channel is current」. That question belongs to `socket::admission`
    // (「which phone was admitted」⇒「which channel carries runtime traffic」) and is now asked there — see
    // `shell::current_channel`. This file answers only 「can this cloud key be used」.

    /// Mutate + persist under one lock, returning the new snapshot. A save failure
    /// is recorded (the in-memory state still moves — the user's action took
    /// effect for this session and the log says the disk write did not).
    fn update(&self, f: impl FnOnce(&mut CloudConfig)) -> CloudConfig {
        let mut g = self.cfg.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut g);
        if let Err(e) = g.save(&self.path) {
            forensic::record("cloud", &format!("config save FAILED: {e}"));
        }
        g.clone()
    }

    /// C7 — retire a stored relay address that this product no longer hands out.
    /// `Some(_)` = the config was rewritten and persisted; `None` = untouched,
    /// which is the answer on every read after the first (and on every read of an
    /// endpoint that is anything other than a listed retired value).
    ///
    /// Deliberately NOT written on top of `update`: that helper saves
    /// unconditionally, and `cloud_status` is called on every page mount. Decide
    /// and write under ONE lock so two windows reading at once cannot both migrate
    /// and log the same rewrite twice.
    fn migrate_endpoint(&self, canonical: &str, legacy: &[String]) -> Option<EndpointMigration> {
        let mut g = self.cfg.lock().unwrap_or_else(|p| p.into_inner());
        let migration = cloud_endpoint::migrate(&mut g, canonical, legacy)?;
        if let Err(e) = g.save(&self.path) {
            // The value moved in memory for this session and the disk did not:
            // say so, exactly like `update` does. The next launch will simply see
            // the retired address again and re-run this.
            forensic::record("cloud", &format!("config save FAILED after endpoint migration: {e}"));
        }
        Some(migration)
    }
}

/// The device-page / capsule DTO. Field names are snake_case on the wire, the
/// same convention as `PairingInfo` / `SidecarStatusDto`.
#[derive(serde::Serialize, Clone)]
pub struct CloudStatusDto {
    // RV-新B — there used to be a `channel` here ("the active channel tag"), fed by
    // `CloudConfig.active`. It is gone, and deliberately NOT re-fed from admission:
    // this DTO is pushed only when the cloud CONFIG changes, while 「the current
    // channel」 moves
    // when a phone joins or leaves. Answering it from here would have been a value
    // that goes stale on the very edge it describes. The frontend reads the
    // CONNECTION frame's own `channel`/`primary` instead — the one payload that IS
    // pushed on that edge and can also be pulled (`connection_snapshot`).
    /// The configured relay endpoint (`""` until the user saves one — the DEFAULT
    /// lives in @flowmic/protocol on the frontend, never as a literal in Rust).
    pub endpoint: String,
    /// Whether a Cloud Key is stored. The key itself NEVER crosses this boundary.
    pub key_set: bool,
    /// First 6 chars of the key (its `{"alg":"HS256"…}` header prefix) — a
    /// presence marker, not key material.
    pub key_head: Option<String>,
    /// The plan the key asserts (display-only, unverified claim).
    pub plan: Option<String>,
    /// The account id the key asserts. NOT the email — the email only exists
    /// behind `/api/me`, which this build does not call, so the UI must not
    /// pretend to know it.
    pub subject: Option<String>,
    /// The key's `exp` claim (unix seconds), when it states one.
    pub expires_at: Option<i64>,
    /// Fail-loud verdict: `ready|rejected|no_endpoint|no_key|key_expired`.
    pub readiness: String,
    /// The rejection code behind a `rejected` verdict (server `AUTH_TOKEN_*`, or
    /// the local `KEY_MALFORMED`).
    pub auth_error: Option<String>,
}

fn dto(cfg: &CloudConfig) -> CloudStatusDto {
    let claims = cfg.claims().unwrap_or_default();
    let readiness = cfg.readiness(channel::now_secs());
    CloudStatusDto {
        endpoint: cfg.endpoint.clone(),
        key_set: cfg.jwt.is_some(),
        key_head: cfg.key_head(),
        plan: claims.plan,
        subject: claims.subject,
        expires_at: claims.exp,
        readiness: readiness.tag().to_string(),
        auth_error: cfg.auth_error.clone(),
    }
}

/// The current config, for the sidecar control layer's channel decisions.
pub fn snapshot(app: &AppHandle) -> CloudConfig {
    let state: State<CloudState> = app.state();
    state.snapshot()
}

/// Broadcast the cloud status to BOTH windows (device page card + capsule channel
/// label). A global emit, same mechanism as the sidecar-state channel.
pub fn emit_state(app: &AppHandle) {
    let cfg = snapshot(app);
    if let Ok(v) = serde_json::to_value(dto(&cfg)) {
        let _ = app.emit(bridge::channel::CLOUD_STATE, v);
    }
}

/// The auth-failure hook handed to a CLOUD socket session (T-2 ⑤).
///
/// Runs on a socket.io callback thread, so the teardown is moved onto a fresh
/// thread: dropping the `DesktopSocket` disconnects the client and JOINS its pump,
/// which must never happen from inside that client's own event handler.
///
/// An account-level refusal (`AUTH_TOKEN_EXPIRED` / `AUTH_TOKEN_INVALID` /
/// `auth:expired`) DROPS the Cloud Key so the next start cannot re-dial a dead
/// key; any other register refusal is recorded loudly but keeps the key (a
/// malformed payload or a registry error is not the user's key going bad). The
/// cloud PAIRING credential is deliberately left alone in both cases — it belongs
/// to the relay's room, and wiping it would force every paired phone to re-pair
/// just because a 7-day key lapsed.
pub fn auth_failure_hook(app: &AppHandle) -> AuthFailureHook {
    let app = app.clone();
    Arc::new(move |code: &str| {
        let app = app.clone();
        let code = code.to_string();
        std::thread::spawn(move || {
            let account_level = is_account_auth_failure(&code) || code == "auth:expired";
            forensic::record(
                "cloud",
                &format!("relay refused identity ({code}) — account_level={account_level}"),
            );
            eprintln!("[flowmic] cloud relay refused identity: {code}");
            {
                let state: State<CloudState> = app.state();
                state.update(|c| {
                    if account_level {
                        // Drop the key, keep the channel + endpoint: logged out, LOUDLY.
                        c.clear_key(Some(&code));
                    } else {
                        c.auth_error = Some(code.clone());
                    }
                });
            }
            // Tear the dead session down so nothing pretends to be connected.
            sidecar_ctl::drop_socket(&app);
            emit_state(&app);
        });
    })
}

// ── commands ─────────────────────────────────────────────────────────────────

/// Read the cloud-channel status for the device page / capsule.
///
/// 🔴 THIS READ CARRIES THE ENDPOINT SSOT INWARD AND CAN THEREFORE WRITE ONCE.
/// `canonical` + `legacy` are `DEFAULT_SAAS_ENDPOINT` and `LEGACY_SAAS_ENDPOINTS`
/// from `@flowmic/protocol`, packed by `lib/channel.ts` `cloudEndpointSsot()`.
/// They come in on the READ rather than on a command of their own because:
///   · the migration must run for a user who never re-saves — the stored endpoint
///     is otherwise permanent, and only an EMPTY one falls back to the default;
///   · the Cloud Key never crosses back to the frontend, so the frontend cannot
///     re-save the config itself — the write has to happen on this side;
///   · `channel.rs` forbids an endpoint literal in this crate, so the values have
///     to arrive from the frontend;
///   · `fetchCloudStatus` is the ONE funnel through which the frontend can learn
///     the endpoint, so no call site can forget to bring them, and the DTO that
///     goes back is post-migration by construction.
/// A separate command would have been a call someone can drop — and a status read
/// that answered with the value we had just decided to replace.
///
/// The write is bounded: value equality against a listed retired address, once
/// (the rewrite removes its own trigger), never for a self-hosted endpoint, and
/// never silently — see `socket::cloud_endpoint`.
#[tauri::command]
pub fn cloud_status(
    app: AppHandle,
    state: State<'_, CloudState>,
    canonical: String,
    legacy: Vec<String>,
) -> CloudStatusDto {
    if let Some(m) = state.migrate_endpoint(&canonical, &legacy) {
        forensic::record("cloud", &m.forensic_line());
        // The other window is holding the old address in its own copy of this DTO.
        // Push, or the capsule keeps showing a value that is no longer stored.
        emit_state(&app);
    }
    // ⚠️ NOT a redial, and that is the one bounded gap in this fix. `CloudState`
    // is loaded and `sidecar_ctl::start` dials BEFORE any window's first status
    // read, so the session that is already up on an upgrade launch was dialed at
    // the retired address. It stays there: both hosts are the same box (card C7's
    // measurement), so tearing a live relay session down to re-dial an equivalent
    // address would cost a reconnect to buy nothing. The stored value is corrected
    // within that first read, and the NEXT launch dials the corrected one.
    dto(&state.snapshot())
}

/// Save a pasted Cloud Key + endpoint (the 「paste Cloud Key」 form).
///
/// A value that is not even JWT-shaped is REFUSED and never stored — the status
/// comes back with a `KEY_MALFORMED` rejection so the form says so, rather than
/// storing garbage and failing mysteriously at connect time. A good key re-dials
/// immediately.
#[tauri::command]
pub fn cloud_save_key(app: AppHandle, key: String, endpoint: String) -> CloudStatusDto {
    let key = key.trim().to_string();
    let endpoint = endpoint.trim().to_string();
    let state: State<CloudState> = app.state();
    let cfg = if !channel::is_jwt_shaped(&key) || endpoint.is_empty() {
        forensic::record("cloud", "Cloud Key rejected locally (not JWT-shaped / no endpoint)");
        state.update(|c| {
            if !endpoint.is_empty() {
                c.endpoint = endpoint.clone();
            }
            c.auth_error = Some(KEY_MALFORMED.to_string());
        })
    } else {
        let head: String = key.chars().take(6).collect();
        forensic::record("cloud", &format!("Cloud Key saved (head={head}) endpoint={endpoint}"));
        state.update(|c| c.set_key(&key, &endpoint))
    };
    // owner 2026-07-30 ②: the dial no longer waits for `cfg.active`. That flag was
    // moved by the device page's channel select, and with the select gone a key
    // pasted while the flag said 'lan' would have been stored and never dialed until
    // the next restart — a silent nothing-happened on the one button whose entire
    // purpose is to bring the relay up. Both channels are resident (GA-28), so the
    // honest rule is the one that has no third input: a usable key ⇒ dial it.
    let redial = cfg.readiness(channel::now_secs()).is_ready();
    let out = dto(&cfg);
    emit_state(&app);
    if redial {
        sidecar_ctl::ensure_dialed(&app, Channel::Cloud);
    }
    out
}

// ── L3 account card: the LIVE account read ─────────────────────────────────────────
//
// Design doc: docs/strategy/2026-08-02-l3-account-card-design.md §3.
//
// Everything the account card used to show (plan / expiry / account id) came out
// of `dto()` above — i.e. out of the JWT's own claims, frozen at the moment the
// key was issued. That made 「套餐」 ("plan/tier") answer 「你签发这把钥匙时是哪一档」
// ("which tier were you on when you issued this key") and made
// 「有效期至」 ("valid until") answer 「这把钥匙什么时候失效」 ("when does this key
// expire") while sitting under a 「套餐」 ("plan/tier") label.
// This command is the other half: it ASKS THE SERVER.
//
// 🔴 It exists in Rust, not in the frontend, for the reason stated at the top of
// this file: the Cloud Key never leaves the Rust side in the clear. The key is
// used here as a Bearer header and is never returned, never logged, never put in
// the DTO — only the two response BODIES cross back.
//
// Zero protocol change: `/api/me` and `/api/cloud/summary` are plain
// Bearer-authenticated HTTP routes that already exist on the relay (server-core
// http/auth-routes.ts + http/console-routes.ts). No socket event was added.
//
// The bodies come back as raw `serde_json::Value` ON PURPOSE. Every judgement
// about what they MEAN (which tier, is the quota exempt, is there a subscription
// expiry at all) lives in one place — `apps/desktop/src/lib/cloud-account.ts` —
// where it is unit-tested against the real payload shapes. A second interpreter
// here would be a second answer to 「which tier is this account」, which is exactly what D1
// created `PlanView` to prevent.

/// How long a single account read may take before it counts as 「could not be reached」.
/// Short on purpose: this is a card refresh, not a transfer — a user who has to
/// wait 30 s to learn we could not reach the server has been told nothing twice.
const ACCOUNT_HTTP_TIMEOUT: Duration = Duration::from_secs(6);

/// The live-account read-out. `outcome` is the ONE field that says what happened,
/// and its values are deliberately NOT collapsed into a bool:
///
///   `ok`            — both reads answered; `me` + `summary` are present.
///   `no_key`        — signed out. Nothing to ask with. Not a failure.
///   `no_endpoint`   — no relay address saved. Also not a failure.
///   `unauthorized`  — the server said 401. **Actionable**: sign in again.
///   `unreachable`   — the network/relay did not answer. **Wait and retry**.
///   `bad_response`  — it answered, and we could not read what it said. That is
///                     OUR bug surface, not the user's, and folding it into
///                     `unreachable` would send someone to check their wifi over
///                     a JSON shape change.
///
/// `unauthorized` vs `unreachable` is the same split `cloudLoudReason` already
/// makes for the socket path (an expired key and a refused registration produce
/// different copy because they need different actions).
#[derive(serde::Serialize, Clone)]
pub struct CloudAccountDto {
    pub outcome: String,
    /// Unix seconds at which `ok` was produced — the frontend stamps 「updated at
    /// X」
    /// with it, and it is the ONLY thing that lets a stale reading say how old it
    /// is. `None` for every non-ok outcome (an outcome that failed has no
    /// as-of time, and inventing one would make 「could not be reached」 look answered).
    pub fetched_at: Option<i64>,
    /// Machine-readable extra for a non-ok outcome (an HTTP status, a transport
    /// error class). Never contains the key or any header.
    pub detail: Option<String>,
    /// `GET /api/me` body: `{ user: { id, email, display_name, plan } }`.
    pub me: Option<serde_json::Value>,
    /// `GET /api/cloud/summary` body: `{ plan: PlanView, quota, devices }`.
    pub summary: Option<serde_json::Value>,
}

impl CloudAccountDto {
    fn failed(outcome: &str, detail: Option<String>) -> Self {
        Self {
            outcome: outcome.to_string(),
            fetched_at: None,
            detail,
            me: None,
            summary: None,
        }
    }
}

/// Classify one transport error WITHOUT letting its Display text (which can carry
/// the full URL) reach the DTO verbatim.
fn transport_detail(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "timeout".to_string()
    } else if e.is_connect() {
        "connect".to_string()
    } else if e.is_decode() {
        "decode".to_string()
    } else {
        "transport".to_string()
    }
}

/// One authenticated GET. `Ok(Some(v))` = 200 with a JSON body; the error side
/// carries the OUTCOME name so the caller does not re-derive it.
fn get_json(
    client: &reqwest::blocking::Client,
    base: &str,
    path: &str,
    key: &str,
) -> Result<serde_json::Value, (String, Option<String>)> {
    let url = format!("{base}{path}");
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {key}"))
        .send()
        .map_err(|e| ("unreachable".to_string(), Some(transport_detail(&e))))?;
    let status = resp.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(("unauthorized".to_string(), Some(format!("http {}", status.as_u16()))));
    }
    if !status.is_success() {
        return Err(("bad_response".to_string(), Some(format!("http {}", status.as_u16()))));
    }
    resp.json::<serde_json::Value>()
        .map_err(|_| ("bad_response".to_string(), Some("body is not json".to_string())))
}

/// The blocking half. Runs on a thread of its own (see the command below).
fn fetch_account_blocking(base: String, key: String) -> CloudAccountDto {
    let client = match reqwest::blocking::Client::builder()
        .timeout(ACCOUNT_HTTP_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(e) => return CloudAccountDto::failed("bad_response", Some(transport_detail(&e))),
    };
    let me = match get_json(&client, &base, "/api/me", &key) {
        Ok(v) => v,
        Err((outcome, detail)) => return CloudAccountDto::failed(&outcome, detail),
    };
    let summary = match get_json(&client, &base, "/api/cloud/summary", &key) {
        Ok(v) => v,
        Err((outcome, detail)) => return CloudAccountDto::failed(&outcome, detail),
    };
    CloudAccountDto {
        outcome: "ok".to_string(),
        fetched_at: Some(channel::now_secs()),
        detail: None,
        me: Some(me),
        summary: Some(summary),
    }
}

/// Read the LIVE account (plan / quota / subscription) from the relay.
///
/// Returns a DTO in every case — it never throws — so the frontend's one
/// `undefined` branch keeps meaning exactly one thing (「the bridge is not
/// there」, i.e. running
/// outside Tauri) rather than doubling as 「the server did not answer」.
#[tauri::command]
pub fn cloud_account_fetch(state: State<'_, CloudState>) -> CloudAccountDto {
    let cfg = state.snapshot();
    let base = cfg.endpoint.trim_end_matches('/').to_string();
    if base.is_empty() {
        return CloudAccountDto::failed("no_endpoint", None);
    }
    let Some(key) = cfg.jwt.clone() else {
        return CloudAccountDto::failed("no_key", None);
    };
    // 🔴 The blocking client runs on a thread WE own, never on whatever thread
    // Tauri handed this command: `reqwest::blocking` panics when it is driven
    // from inside an async runtime context, and that would turn a card refresh
    // into a process-level fault. Joining here is bounded by ACCOUNT_HTTP_TIMEOUT.
    let handle = std::thread::spawn(move || fetch_account_blocking(base, key));
    let out = match handle.join() {
        Ok(dto) => dto,
        Err(_) => CloudAccountDto::failed("bad_response", Some("worker panicked".to_string())),
    };
    // Forensics record the VERDICT only — no key, no header, no URL.
    forensic::record(
        "cloud",
        &format!(
            "account read → {}{}",
            out.outcome,
            out.detail.as_ref().map(|d| format!(" ({d})")).unwrap_or_default()
        ),
    );
    out
}

/// Sign out of the cloud relay (deliberate user action — no rejection latch).
#[tauri::command]
pub fn cloud_clear_key(app: AppHandle) -> CloudStatusDto {
    let state: State<CloudState> = app.state();
    let cfg = state.update(|c| c.clear_key(None));
    forensic::record("cloud", "Cloud Key cleared (user sign-out)");
    // No key ⇒ nothing dialable, whatever any stored flag says. Drop the session
    // rather than leave a socket running on a credential this PC no longer holds —
    // this used to be conditional on `cfg.active`, which since owner 2026-07-30 ②
    // nothing can move, so a signed-out relay could have stayed connected.
    //
    // RV-58 — this line used to say 「the credential the user just revoked」. It was not revoked and cannot
    // be: a Cloud Key is a stateless JWT and there is no server-side revocation yet
    // (W4-4), so signing out DELETES THE LOCAL COPY and the key stays valid until its
    // own `exp` — which is exactly what the confirm copy promises the user
    // (「delete the local one, paste it again and it comes back」). The comment was quietly claiming a security
    // property this build does not have, and a comment is an assertion like any other.
    sidecar_ctl::drop_socket(&app);
    let out = dto(&cfg);
    emit_state(&app);
    out
}
