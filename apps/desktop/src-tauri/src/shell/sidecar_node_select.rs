// Cloud-relay node tracking + selection, split out of sidecar_ctl.rs (2026-09-02,
// file-size cap — same technique as sidecar_lan_poll.rs). A CHILD module of
// sidecar_ctl (not a sibling registered in shell/mod.rs) so `use super::*` below
// reaches the same imports (`chan`, `Channel`, `node_select`) this family always
// used — VERBATIM move, no visibility widened beyond what re-exporting requires.
//
// `current_node` / `current_node_id` are re-exported from sidecar_ctl.rs (`pub use
// sidecar_node_select::{current_node, current_node_id};`) because two OTHER files
// call them as `sidecar_ctl::current_node()` / `sidecar_ctl::current_node_id()`
// (shell/connection.rs, shell/node_latency.rs) — moving the body must not force
// either call site to learn a new path.

use super::*;

/// The node this process is currently dialing, if any. Process-global because
/// the choice has to survive a reconnect — without it every reconnect would be a
/// first choice, the stickiness margin would never apply, and two nodes a few
/// milliseconds apart would trade the socket back and forth forever.
static CURRENT_NODE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// The node this process is dialing, for the DEVICE PAGE to name it.
///
/// owner 2026-08-30 — 「PC 端的云端中继连接通道的信息卡片中也增加连接的节点信息」.
///
/// 🔴 `None` on a single-node deployment and on every LAN-only run, and the card
/// must then say nothing rather than 「unknown」: there is no node in either case,
/// so naming one would be inventing a fact about a path this connection does not
/// take. Same posture as the phone's badge (node_badge.dart).
pub fn current_node() -> Option<String> {
    // 🔴 THE OPERATOR'S LABEL OR NOTHING — never the node id. Owner
    // 2026-08-30: 「当前只有 asia/us 两个节点，不要显示其它文字」, and the
    // 2026-08-22 iron rule already forbade internal vocabulary in anything a
    // user can see. `srvjp` is our name for that machine, not theirs.
    //
    // An earlier version of this line fell back to the id. It was wrong for the
    // same reason on both clients, and the phone's node_badge.dart carries the
    // full argument — including why the 0.2.53 「print the raw error code」
    // precedent does NOT transfer (there the alternative was a fabricated
    // sentence; here it is silence, and silence is honest).
    //
    // The card must draw nothing on None: no node (LAN, single node) and no
    // label are both 「nothing to name」, and both deserve the same silence.
    let _ = CURRENT_NODE.lock().ok().and_then(|g| g.clone())?;
    CURRENT_NODE_LABEL
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .filter(|s| !s.trim().is_empty())
}

static CURRENT_NODE_LABEL: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// The URL last dialed for [CURRENT_NODE]. Needed so the next pick can fetch
/// `/api/node/list` from that node instead of always asking the canonical writer
/// (`socket/node_select.rs` `fetch_published`). An id without a URL cannot be
/// asked; a URL without an id cannot be checked for containment.
static CURRENT_NODE_URL: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// The node **id** this process is dialing, for the latency panel to mark
/// "in use". Distinct from [`current_node`], which returns the operator's
/// **label** (or nothing) because that value is painted on a card.
///
/// ⚠️ The panel is read-only: this is a stamp, not a setter. The only
/// writer remains `remember_node` in this file.
pub fn current_node_id() -> Option<String> {
    CURRENT_NODE
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .filter(|s| !s.trim().is_empty())
}

/// Remember the id, the operator label, and the dialed URL from the same
/// [node_select::Choice].
///
/// 🔴 One writer for three values that must never disagree: an id from this
/// round beside a label from the last one would name the wrong machine room
/// on a card whose whole job is to name it, and a list fetch to a URL that
/// is not that id's door would be asking a stranger for the directory.
pub(super) fn remember_node(node: Option<String>, label: Option<String>, url: String) {
    if let Ok(mut g) = CURRENT_NODE.lock() {
        *g = node;
    }
    if let Ok(mut g) = CURRENT_NODE_LABEL.lock() {
        *g = label;
    }
    if let Ok(mut g) = CURRENT_NODE_URL.lock() {
        *g = Some(url);
    }
}

/// 「这条连接会不会发 pc:register」("will this connection emit pc:register").
///
/// Read from the CLOUD credential file, which is the same thing socket/client.rs
/// consults to decide between `pc:register` and `pc:reconnect{token}` — see
/// [`Credentials::is_registered`], whose doc comment is explicit that this is the
/// right question in exactly one place. This is the second place, and it is the
/// SAME question: a connection that is about to register must land on the writer,
/// because registration writes seven rows including the pairing code and a
/// replica loses all of them at its next replication pull.
///
/// ⚠️ Absent or unreadable credentials mean 「no token」 ⇒ registration is due.
/// The safe failure: dialing the writer when we did not have to costs one round
/// trip, while dialing a replica when we had to costs the user's pairing code.
pub(super) fn cloud_registration_due() -> bool {
    !crate::socket::credentials::Credentials::load(&chan::credentials_path(Channel::Cloud))
        .map(|c| c.is_registered())
        .unwrap_or(false)
}

/// Pick a relay node for `endpoint`, or fall back to the endpoint itself.
///
/// ⚠️ EVERY FAILURE HERE FALLS BACK TO THE ENDPOINT, deliberately. Node selection
/// is an optimisation; a PC that cannot build an HTTP client, or reach the node
/// list, must still connect exactly the way it did before this feature existed.
/// The one thing it must never do is fail to dial at all.
pub(super) fn select_relay_node(endpoint: &str, must_register: bool) -> node_select::Choice {
    let Some(probe) = node_select::HttpProbe::new() else {
        return node_select::Choice {
            url: endpoint.to_string(),
            node: None,
            short: None,
            reason: node_select::Reason::NoneReachable,
        };
    };
    let current = CURRENT_NODE.lock().ok().and_then(|g| g.clone());
    let current_url = CURRENT_NODE_URL.lock().ok().and_then(|g| g.clone());
    node_select::choose(
        endpoint,
        current.as_deref(),
        current_url.as_deref(),
        must_register,
        &probe,
    )
}
