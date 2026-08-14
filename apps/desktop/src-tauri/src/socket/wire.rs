// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1/§3.2/§3.5 (payload shapes)
//   packages/protocol/src/protocol-schemas-inject.ts (InjectRequestSchema,
//     InjectResultSchema — the A-58 entry_id/request_id exact echo)
//   packages/protocol/src/protocol-schemas-timeline.ts (InjectTargetSchema:
//     window_title, process_name NonEmpty, injected_at NonEmpty)
//   packages/protocol/src/protocol-schemas-focus.ts (FocusStateSchema)
//
// Pure JSON <-> value mapping for the desktop's socket payloads. Kept free of
// rust_socketio and Win32 so every shape is unit-provable. The connection
// logic (client.rs) parses incoming values with these and hands outgoing
// values straight to the socket. Every produced payload is built to satisfy
// the zod schema on the server boundary — an invalid inject:result would be
// silently dropped by the server's safeParseEvent (breaking the truth report).

use serde_json::{json, Value};

/// Parsed inject:request. `text` + `source` are the payload core; `request_id`
/// and `entry_id` are the A-58 correlation keys echoed VERBATIM on the result.
///
/// F-2350 (R6 T-4): `image_b64` + `image_mime` are the already-frozen image
/// field-add. The schema's superRefine binds them to `source:'image'` on the
/// server boundary; this parse mirrors that pairing so a half-formed frame
/// (bytes without a mime, or an `image` source with neither) is NOT mistaken
/// for a text inject — the biggest hazard here is `text:""` short-circuiting
/// `inject_text` to a silent ok=true, which [`Self::image`] exists to prevent.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct InjectRequest {
    pub text: String,
    pub source: String,
    pub request_id: Option<String>,
    pub entry_id: Option<String>,
    pub image_b64: Option<String>,
    pub image_mime: Option<String>,
    /// 🔴 L8 (owner 2026-08-02): WHY this delivery is on the wire — the user's current
    /// action (`Live`) vs an automatic deferred delivery (`Deferred`). `Deferred` is never typed, even with a live
    /// focused window; see [`crate::inject::InjectOrigin`] for the whole argument
    /// and for why an ABSENT field reads as `Live`.
    ///
    /// ⚠️ Two fields, because "what this frame said" and "whether this frame said anything" are two questions
    /// and only the second one can tell a pre-0.2.48 sender apart from a relay that
    /// stripped the key in flight. [`origin`] is what the decision uses;
    /// [`origin_stated`] is what the forensic line prints — and the ONLY reason a
    /// stale-relay deploy is diagnosable after the fact instead of looking like the
    /// feature simply not working.
    pub origin: crate::inject::InjectOrigin,
    pub origin_stated: bool,
}

impl InjectRequest {
    /// `Some((b64, mime))` when this frame is a well-formed image inject —
    /// `source:'image'` AND both fields present, exactly as InjectRequestSchema
    /// requires. Anything else is not an image frame.
    pub fn image(&self) -> Option<(&str, &str)> {
        if self.source != "image" {
            return None;
        }
        match (self.image_b64.as_deref(), self.image_mime.as_deref()) {
            (Some(b64), Some(mime)) => Some((b64, mime)),
            _ => None,
        }
    }

    /// True when the frame CLAIMS to be an image but is not well formed
    /// (`source:'image'` with a missing/empty field). Such a frame must fail
    /// loud rather than fall through to the text path, where an empty `text`
    /// would short-circuit to a fabricated ok=true.
    pub fn is_malformed_image(&self) -> bool {
        self.source == "image" && self.image().is_none()
    }
}

fn non_empty_str(v: Option<&Value>) -> Option<String> {
    match v.and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Some(s.to_string()),
        _ => None,
    }
}

/// Extract the first argument value from a socket.io EVENT text payload.
/// server-core emits each event with a single object arg → the transport
/// delivers `[obj]`, so the object is the first value.
pub fn first_arg(values: &[Value]) -> Option<&Value> {
    values.first()
}

/// GA-26: the `mobile_id` carried by pc:mobile-joined / pc:mobile-left. Both
/// frames have always carried it; the desktop used to discard it and count
/// anonymous events instead, which is why the same phone could be counted twice.
/// `None` (missing / non-string / empty) is a frame that cannot be attributed to
/// a phone — the caller records it rather than mutating presence on a guess.
pub fn parse_mobile_id(v: &Value) -> Option<String> {
    non_empty_str(v.get("mobile_id"))
}

/// GA-26: the `connectedMobiles` roster from a pc:reconnect ack — the server's
/// liveness-confirmed set of mobile_ids (GA-07 pings each one before including
/// it). Returns `(ids, dropped)`, where `dropped` counts entries that were not
/// usable strings so the caller can record the drift instead of silently
/// shrinking the roster.
pub fn parse_connected_mobiles(arr: &[Value]) -> (Vec<String>, usize) {
    let ids: Vec<String> = arr
        .iter()
        .filter_map(|v| match v.as_str() {
            Some(s) if !s.is_empty() => Some(s.to_string()),
            _ => None,
        })
        .collect();
    let dropped = arr.len() - ids.len();
    (ids, dropped)
}

/// Extract the ack OBJECT from a socket.io ACK text payload. Ack data arrives
/// one level deeper than an event: the whole ack args array is delivered as a
/// single value (`[ [obj] ]`), so we descend into that inner array. Falls back
/// to the plain first value for a non-nested shape.
pub fn unwrap_ack(values: &[Value]) -> Option<&Value> {
    match values.first() {
        Some(Value::Array(inner)) => inner.first(),
        other => other,
    }
}

/// Parse an inject:request object. `text` must be a string (may be empty — an
/// empty utterance is a real no-op, handled downstream); `source` defaults to
/// "stt" when absent.
pub fn parse_inject_request(v: &Value) -> Option<InjectRequest> {
    let text = v.get("text").and_then(Value::as_str)?.to_string();
    let source = v
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("stt")
        .to_string();
    // 🔴 L8. Read as TWO facts, deliberately: `origin_stated` records whether the
    // KEY was there at all, and `origin` records what it said. Collapsing them
    // ("no statement means live") would be correct for the DECISION and useless for the
    // diagnosis — "the deferred delivery got injected anyway" has two completely different causes (a
    // pre-0.2.48 phone, or a relay that stripped the key in flight) and exactly one
    // of them is fixed by a deploy. Same shape as `Stated` in row_transit.rs, and
    // for the same reason it was created (RV-75: a log that cannot tell "not sent" from
    // "sent empty" cannot answer the only question anyone asks it).
    let origin_raw = v.get("inject_origin").and_then(Value::as_str);
    Some(InjectRequest {
        text,
        source,
        request_id: non_empty_str(v.get("request_id")),
        entry_id: non_empty_str(v.get("entry_id")),
        image_b64: non_empty_str(v.get("image_b64")),
        image_mime: non_empty_str(v.get("image_mime")),
        origin: crate::inject::InjectOrigin::from_wire(origin_raw),
        origin_stated: origin_raw.is_some(),
    })
}

/// Extract the `kind` string from a control:key object (validity — whether it
/// is one of the six — is decided by `inject::key_sequence_for`, not here).
pub fn parse_control_kind(v: &Value) -> Option<String> {
    v.get("kind").and_then(Value::as_str).map(str::to_string)
}

/// REQ-12-13 — WHICH PHONE pressed the key (`control:key.device_label`, doc 04 F-3115).
///
/// Read here rather than guessed downstream: this desktop mints a timeline row per
/// remote key press (contract doc 15 §2.0-e) and the frame is the ONLY place a sender
/// identity can come from — the relay forwards `parsed.data` verbatim and adds no
/// `mobile_id`, exactly as `inject:request` already documents.
///
/// `None` for an absent, empty or non-string value: the row then says it cannot name
/// its phone, and [`crate::socket::control_row`] records that as a named gap. A relay
/// older than this round strips the key in flight, so absence is a real state and must
/// stay distinguishable rather than being filled in with a guess.
pub fn parse_device_label(v: &Value) -> Option<String> {
    match v.get("device_label").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Some(s.to_string()),
        _ => None,
    }
}

/// IJ-01 — WHAT THIS ATTEMPT OBSERVED, as opposed to where the text LANDED.
///
/// owner 2026-08-07 ruling ④ (docs/decisions/2026-08-07-owner-inject-status-wording-
/// evidence-and-window-title.md): a delivery that was NOT typed still has to be
/// able to say "which window it injected into / what status / what result". Until this existed the desktop
/// computed both facts on every injection and threw them away on every non-success.
///
/// 🔴 IT IS NOT `target`, AND THE TWO MUST NEVER BE MERGED. `target` answers
/// "where the characters landed" and therefore appears only on `ok:true` (04 §3.5 F-3112 — a
/// non-delivery makes no claim about where it landed). This answers "which
/// foreground window we observed during this attempt" and is true on every outcome that really did
/// look at a window. Widening the old key instead would have forced an
/// `injected_at` onto a result that never injected, which is a lie with a
/// timestamp on it.
///
/// A STRUCT rather than two more positional parameters: `build_inject_result`
/// already takes six, and `Option<(&str,&str)>` twice in a row is a call site
/// nobody can read — the two `None`s would be interchangeable at the call and not
/// interchangeable in meaning.
#[derive(Debug, Clone, Copy, Default)]
pub struct FocusObservation<'a> {
    /// `(window_title, process_name)` of the window this attempt was aimed at.
    /// `None` ⇒ NO WINDOW WAS EVER OBSERVED (channel-admission refusals, the RV-83
    /// disk-ledger replay) — never a placeholder, because "we never looked" and "we
    /// looked, and there was nothing there" are two facts.
    /// ⚠️ `window_title` may legitimately be `""` (a window with no title); the
    /// PROCESS name is the one that has to be non-empty, and it is the only half
    /// that is allowed to be persisted (owner ruling (c), see the writer below).
    pub window: Option<(&'a str, &'a str)>,
    /// Stage 1b's reading, already mapped to its wire token by
    /// `inject::target_probe::wire_evidence`. `None` ⇒ the probe never ran, and the
    /// key is then OMITTED — `unknown` means "we asked, but couldn't get an answer" and would be a
    /// fabricated measurement here (IJ-01 §A-4).
    pub evidence: Option<&'static str>,
}

/// Build an inject:result payload from the pipeline outcome, echoing the
/// request's correlation keys (A-58). `target` is `(hwnd, title, process_name)`
/// of the window actually written into, present only on a live success.
/// `injected_at` is a non-empty timestamp string (InjectTargetSchema).
/// `focus` is what the attempt OBSERVED — see [`FocusObservation`] for why that is
/// a different question from `target` and may not be folded into it.
///
/// 🔴 THE ONE PRODUCER of an `inject:result` on this machine. Every branch that
/// answers a phone goes through here (socket/inject_ops.rs ×3, socket/client.rs ×1),
/// which is what makes "which branches speak of a window" a question with a single grep.
pub fn build_inject_result(
    ok: bool,
    mode_wire: &str,
    error_code: Option<&str>,
    target: Option<(&str, &str)>, // (window_title, process_name)
    injected_at: &str,
    req: &InjectRequest,
    focus: FocusObservation<'_>,
) -> Value {
    let mut obj = json!({ "ok": ok, "mode": mode_wire });
    let map = obj.as_object_mut().expect("json object");

    if ok {
        if let Some((title, process_name)) = target {
            // target_window is NonEmpty on the wire — only set it for a titled
            // window. inject_target requires process_name + injected_at NonEmpty.
            if !title.is_empty() {
                map.insert("target_window".into(), json!(title));
            }
            if !process_name.is_empty() && !injected_at.is_empty() {
                map.insert(
                    "inject_target".into(),
                    json!({
                        "window_title": title,
                        "process_name": process_name,
                        "injected_at": injected_at,
                    }),
                );
            }
        }
    }
    // IJ-01 — the two observation keys, OUTSIDE the `if ok` above on purpose: they
    // are the whole point of the card. `focus_window` is written only when the
    // PROCESS name is non-empty (`window_title: z.string()` accepts "", but
    // `process_name` is NonEmpty on the boundary and is the half that ends up on a
    // row under owner ruling (c)); a nameless process is "we couldn't identify it" and gets no key
    // rather than an empty one.
    if let Some((title, process_name)) = focus.window {
        if !process_name.is_empty() {
            map.insert(
                "focus_window".into(),
                json!({ "window_title": title, "process_name": process_name }),
            );
        }
    }
    if let Some(evidence) = focus.evidence {
        map.insert("focus_evidence".into(), json!(evidence));
    }
    if let Some(code) = error_code {
        if !code.is_empty() {
            map.insert("error".into(), json!(code));
        }
    }
    // A-58: echo the correlation keys verbatim whenever the request carried
    // them, regardless of ok — the mobile's exact key for this delivery.
    if let Some(rid) = &req.request_id {
        map.insert("request_id".into(), json!(rid));
    }
    if let Some(eid) = &req.entry_id {
        map.insert("entry_id".into(), json!(eid));
    }
    obj
}

/// focus:state mirror payload (process_name carries the basename verbatim).
pub fn build_focus_state(window_title: &str, process_name: &str) -> Value {
    json!({ "window_title": window_title, "process_name": process_name })
}

/// pc:register payload.
///
/// v0.2.4 — `machine_uid` rides beside the instance id and is OMITTED when the
/// machine could not be identified (pc_name::machine_uid → None). Omitted, not
/// null and not empty: the server's lookup treats a blank uid as "no answer"
/// anyway, and sending one would put a value on the wire that means nothing.
pub fn build_pc_register(device_name: &str, client_instance_id: &str, machine_uid: Option<&str>) -> Value {
    let mut v = json!({ "device_name": device_name, "client_instance_id": client_instance_id });
    insert_machine_uid(&mut v, machine_uid);
    v
}

/// pc:reconnect payload.
pub fn build_pc_reconnect(token: &str, client_instance_id: &str, machine_uid: Option<&str>) -> Value {
    let mut v = json!({ "token": token, "client_instance_id": client_instance_id });
    insert_machine_uid(&mut v, machine_uid);
    v
}

fn insert_machine_uid(v: &mut Value, machine_uid: Option<&str>) {
    let Some(uid) = machine_uid.map(str::trim).filter(|u| !u.is_empty()) else {
        return;
    };
    if let Some(obj) = v.as_object_mut() {
        obj.insert("machine_uid".into(), json!(uid));
    }
}

/// pc:refresh-code payload (empty object per PcRefreshCodeSchema).
pub fn build_pc_refresh_code() -> Value {
    json!({})
}

/// pc:release-mobile payload (GA-08). `revoke` is emitted ONLY when true: the
/// disconnect meaning is the absence of the flag, so a disconnect frame is byte-for-byte
/// what every pre-GA-08 build sent, and a revoke frame is unmistakable on the wire
/// (no `revoke: false` to squint at in a log). The id is always named — this
/// builder has no "all phones" form, because revoke-all is not offered.
pub fn build_pc_release_mobile(mobile_id: &str, revoke: bool) -> Value {
    if revoke {
        json!({ "mobile_id": mobile_id, "revoke": true })
    } else {
        json!({ "mobile_id": mobile_id })
    }
}

/// GA-10 — the reserved `device.pc_name` write (04 §3.7 F-3101). It rides the
/// ordinary settings:update event (zero new event names) but the SERVER routes it
/// to `pc_devices.device_name` instead of the KV store, and refuses it outright
/// from a mobile: owner iron law "the naming on the PC side can only be controlled by the PC side".
pub fn build_pc_name_update(name: &str) -> Value {
    build_settings_update(crate::events::KEY_DEVICE_PC_NAME, json!({ "pc_name": name }))
}

/// GA-29: the "capsule already occupied by another phone" refusal, sent when a SECOND phone joins on
/// either channel. It is a `pc:release-mobile` with the additive `reason:'busy'`,
/// which the server reads as "a short-window refusal — don't treat it as the user pressing disconnect" — see
/// release-suppression.ts for why busy gets its own (much shorter) window. Never
/// a revoke: nothing about the pairing is wrong, the machine is just occupied.
pub fn build_pc_release_busy(mobile_id: &str) -> Value {
    json!({ "mobile_id": mobile_id, "reason": "busy" })
}

/// Read a pc:release-mobile ack. `true` only for an explicit `{ok:true}` — an
/// error ack, a missing field or a malformed frame all read `false` so the device
/// page can say the action did not happen instead of quietly refreshing a list
/// that never changed.
pub fn parse_release_mobile_ack(v: &Value, revoke: bool) -> bool {
    if v.get("ok").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    if !revoke {
        // disconnect: the phone may legitimately be offline, so `released: 0` is a
        // real success — the suppression window was still written.
        return true;
    }
    // revoke is a DELETION, and the server answers `{ok:true, revoked:0}` when it
    // owns no such row — which is exactly what happens when the frame is sent to
    // the wrong channel's server (owner 2026-07-29: "success was shown, but it's still there").
    // `ok` alone therefore says "the request was well-formed", not "the pairing
    // is gone". Only the count answers the question the button asked.
    v.get("revoked").and_then(Value::as_u64).unwrap_or(0) >= 1
}

/// GA-18: read the additive `expires_in_ms` out of a pc:register / pc:refresh-code
/// ack. `None` when the field is absent (a server older than GA-18) or not a
/// non-negative number — the modal then shows its static TTL line rather than
/// counting down from an invented deadline.
pub fn parse_expires_in_ms(v: &Value) -> Option<u64> {
    v.get("expires_in_ms").and_then(Value::as_u64)
}

/// sys:pong reply for a sys:ping{nonce}.
pub fn build_sys_pong(nonce: &str) -> Value {
    json!({ "nonce": nonce, "ok": true })
}

/// heartbeat payload.
pub fn build_heartbeat(ts_ms: i64) -> Value {
    json!({ "ts": ts_ms })
}

// ── WP-R2-2 outbound builders: settings + history verbs the main window drives
//    through the Rust socket. Values arriving from the frontend are already
//    serde_json::Value; each builder shapes the exact zod payload the server's
//    settings.handler / history.handler expects. ──────────────────────────────

/// settings:update{key, value}. `value` is the raw JSON the settings UI produced
/// (an LlmConfig / stt.routings array / ScenarioCard object) — passed verbatim.
pub fn build_settings_update(key: &str, value: Value) -> Value {
    json!({ "key": key, "value": value })
}

/// settings:list payload (empty object per SettingsListSchema — the whole
/// snapshot for the authed user is returned in the ack).
pub fn build_settings_list() -> Value {
    json!({})
}

/// pc:list-mobiles payload (empty object per PcListMobilesSchema — the server
/// scopes the answer to THIS socket's own PC row; there is nothing to address).
pub fn build_pc_list_mobiles() -> Value {
    json!({})
}

/// Read the `mobiles` array out of a pc:list-mobiles ack, keeping ONLY the five
/// public projection fields per row (R6 T-8). This is a second, client-side
/// narrowing on top of the server's projection: even if some future server were
/// to over-share, nothing beyond these five reaches the desktop frontend, and a
/// `mobile_token` can never be plumbed into the UI by accident.
/// `None` on an error / malformed ack so the page shows a loud unknown state
/// rather than an invented empty list.
pub fn parse_list_mobiles_ack(v: &Value) -> Option<Value> {
    let rows = v.get("mobiles")?.as_array()?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "pairing_id": r.get("pairing_id").and_then(Value::as_str).unwrap_or_default(),
                "mobile_name": r.get("mobile_name").and_then(Value::as_str).unwrap_or_default(),
                "paired_at": r.get("paired_at").and_then(Value::as_str).unwrap_or_default(),
                "last_seen_at": r.get("last_seen_at").and_then(Value::as_str),
                // Absent/malformed presence is reported as OFFLINE, never invented
                // as online ("must not fabricate online status").
                "online": r.get("online").and_then(Value::as_bool).unwrap_or(false),
                // v0.2.4 — the handset behind this row, so the table can say
                // "these two entries are the same phone". This projection is a WHITELIST: a field
                // that is not named here does not reach the UI at all, which is
                // deliberate (it is what keeps a token from ever riding along)
                // and is exactly why adding the field to the server, the schema
                // and the Vue template was not enough on its own.
                // `as_str` → absent/null/non-string all become JSON null, and
                // null groups with NOTHING (see derivePairedList).
                "device_uid": r.get("device_uid").and_then(Value::as_str),
            })
        })
        .collect();
    Some(Value::Array(out))
}

/// Read the `items` array (`[{key, value}]`) out of a settings:list ack object.
/// Returns the array Value only when present and actually an array; anything
/// else (error ack, malformed) yields None so the desktop keeps its local cache.
pub fn parse_settings_list_ack(v: &Value) -> Option<Value> {
    v.get("items").filter(|i| i.is_array()).cloned()
}

/// The reinject request a LOCAL re-inject runs — no wire frame, no server (owner
/// 2026-07-31 architecture ruling, docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md).
///
/// 0.2.27 retired `build_history_list` / `_update` / `_delete` / `_inject` with the
/// server's transcript store. `history:inject{id}` was the strangest of the four:
/// the PC emitted an id, the server read the row's text out of its table and sent it
/// straight back to THIS SAME PC as an `inject:request`. The PC is the injector and,
/// since 0.2.26, the OWNER of the row — the text was in hand the whole time — so the
/// round trip existed only because the text did not use to be.
///
/// This is byte-for-byte the request the retired server built
/// (`pc.emit('inject:request', { text, source: 'history', entry_id })`), which is the
/// point: `run_inject` is the ONE decision path, so `injected` keeps exactly one
/// meaning (owner 2026-07-30 ruling + the RV-45 hard constraint "the two delivery
/// paths must never let `injected` carry two meanings"). In particular `source: "history"` is load-bearing — it is
/// on the list `socket::dedup::skips_the_inj1_byte_window` reads, so a deliberate
/// re-send is never suppressed as an INJ-1 byte-window duplicate. (That predicate was
/// called `is_bypass_source` until the RV-29 fix, and it no longer bypasses INJ-3 —
/// which changes nothing HERE, because this builder mints no `request_id` for INJ-3
/// to key on. It does mean the sentence is now narrower than it used to read.)
///
/// No `request_id`: that key correlates a PHONE's utterance across a reconnect flap.
/// Nobody asked for this delivery, so minting one would put a correlation key on a
/// conversation that does not exist.
pub fn local_reinject_request(text: &str, entry_id: &str) -> InjectRequest {
    InjectRequest {
        text: text.to_string(),
        source: "history".to_string(),
        request_id: None,
        entry_id: Some(entry_id.to_string()),
        image_b64: None,
        image_mime: None,
        // 🔴 L8 — `Live`, and this is the case owner's ruling protects rather than
        // the case it refuses. There is no wire frame here at all: a human just
        // clicked reinject on a row of THIS PC's own timeline, which is the ruling's
        // second row verbatim ("a manual user action… the user pressed a key, and
        // was prepared" ⇒ injection is allowed).
        // ⚠️ Stamped explicitly rather than left to `Default`: this builder writes
        // out every field of the request it fabricates, and "whether to inject" is the one
        // field where an unstated default would be read as an oversight.
        origin: crate::inject::InjectOrigin::Live,
        // No frame said it — nothing was parsed. `false` keeps the forensic line
        // honest about that, and costs nothing: this path never runs the gate.
        origin_stated: false,
    }
}

/// Read a pc:register / pc:reconnect ack object into (token, pc_id, room_uuid).
pub fn parse_register_ack(v: &Value) -> (Option<String>, Option<String>, Option<String>) {
    (
        non_empty_str(v.get("token")),
        non_empty_str(v.get("pc_id")),
        non_empty_str(v.get("room_uuid")),
    )
}

/// How many decimal digits a PCID has on the wire. Stated once here because the
/// only other place this desktop could learn it is a picture of the number.
pub const PCID_DIGITS: usize = 9;

/// 0.2.66 — the relay's PUBLIC ADDRESSING id for this PC, off a `pc:register` /
/// `pc:reconnect` / `pc:refresh-code` ack (design
/// docs/strategy/2026-08-14-0266-cloud-pcid-pairing-design.md §4 / §5.5).
///
/// It is NOT the pairing code and NOT a secret: it says WHICH pc row a phone means,
/// while the 4-digit code stays the only thing that proves the phone may have it.
/// It is also not `pc_id` — that one is the relay's INTERNAL row key, never shown to
/// anyone; this one exists precisely to be read out loud.
///
/// THE SHAPE IS CHECKED HERE, and a value that fails it is DROPPED rather than
/// carried: this string is displayed to the user and appended to the cloud QR, and
/// the two failures are not symmetric. No pcid ⇒ the QR is byte-identical to an
/// old one and the desktop shows no PCID row at all, so the gap is visible. A
/// malformed pcid ⇒ the user reads out an addressing value the relay cannot resolve
/// and the desktop looks like it answered. "none" must not be dressed as an answer.
///
/// `None` for: an absent key (a relay older than this round, and every standalone
/// sidecar — LAN has no PCID at all), a non-string, or anything that is not exactly
/// [`PCID_DIGITS`] ASCII digits.
pub fn parse_pcid(v: &Value) -> Option<String> {
    let s = v.get("pcid").and_then(Value::as_str)?;
    // Byte length is the character count here BECAUSE of the digit check beside it:
    // any multi-byte char fails `is_ascii_digit` before the length can mislead.
    if s.len() == PCID_DIGITS && s.bytes().all(|b| b.is_ascii_digit()) {
        return Some(s.to_string());
    }
    None
}

#[cfg(test)]
mod machine_uid_wire_tests {
    use super::*;

    #[test]
    fn register_and_reconnect_carry_the_uid_when_there_is_one() {
        let r = build_pc_register("PC", "inst-0123456789abcdef", Some("pc-0011223344556677"));
        assert_eq!(r["machine_uid"], "pc-0011223344556677");
        let c = build_pc_reconnect("t".repeat(32).as_str(), "inst-0123456789abcdef", Some("pc-0011223344556677"));
        assert_eq!(c["machine_uid"], "pc-0011223344556677");
        // The pre-0.2.4 fields are untouched — this is an additive field, and
        // that has to be true of the FRAME, not only of the schema.
        assert_eq!(r["device_name"], "PC");
        assert_eq!(r["client_instance_id"], "inst-0123456789abcdef");
    }

    #[test]
    fn the_key_is_absent_when_the_machine_could_not_be_identified() {
        // Not null, not "": omitted. A frame from a machine that cannot name
        // itself must be byte-identical to what every pre-0.2.4 build sent.
        for uid in [None, Some(""), Some("   ")] {
            let r = build_pc_register("PC", "inst-0123456789abcdef", uid);
            assert!(r.get("machine_uid").is_none(), "uid={uid:?}");
            let c = build_pc_reconnect("t".repeat(32).as_str(), "inst-0123456789abcdef", uid);
            assert!(c.get("machine_uid").is_none(), "uid={uid:?}");
        }
    }
}

#[cfg(test)]
#[path = "wire_tests.rs"]
mod wire_tests;
