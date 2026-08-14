// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (pc:list-mobiles ack)
//   docs/rebuild/07-DESKTOP-SPEC.md §5 (device page), §6 (dual channels always resident)
//
// The 「已配对手机」("paired phones") read. Split out of shell/mod.rs for the 800-line cap.

use serde_json::Value;
use tauri::State;

use crate::socket::channel::CloudReadiness;
use crate::socket::Channel;

use super::{cloud, SocketState};

/// #6 (owner 2026-08-04): should a channel with NO live session be reported as
/// `unreachable` (「问不到」, "can't be reached") rather than silently omitted
/// (「没什么可问的」, "there's nothing to ask")?
///
/// The omission arm below was written for 「never configured」 — no cloud key, LAN
/// server not started. But an auth-dead cloud channel reaches it too: the shell
/// drops the cloud socket slot to `None` the moment the account is refused, so a
/// configured, paired channel took the 「nothing to report」 branch and its phones
/// vanished from the page with no trace. owner: 「保持显示配对实例，标记为离线/无法
/// 连接。不要因为鉴权过期就把配对历史藏起来」("Keep showing the paired instance,
/// mark it offline/unreachable. Don't hide the pairing history just because auth
/// expired.").
///
/// Scoped deliberately to the two AUTH-dead verdicts:
///   • `Rejected(code)` — the server refused this key (AUTH_TOKEN_*, PCS_LIMIT…);
///   • `KeyExpired`     — the local exp check says the key lapsed.
/// `NoKey` (a deliberate sign-out) and `NoEndpoint` (never configured) keep the
/// silent arm: those ARE 「没什么可问的」("nothing to ask"), and the frontend's cache purge on a
/// deliberate sign-out is a separate, intended behaviour (paired-mobiles.ts).
///
/// LAN returns false unchanged: a sidecar that never started is genuinely not
/// configured, and the failed-bring-up case has its own loud surface on the
/// device page. Making that one honest too is a separate card — not folded in
/// here, because it would change a second page's behaviour under one test.
pub fn absent_slot_is_unreachable(channel: Channel, cloud_readiness: &CloudReadiness) -> bool {
    match channel {
        Channel::Lan => false,
        Channel::Cloud => matches!(
            cloud_readiness,
            CloudReadiness::Rejected(_) | CloudReadiness::KeyExpired
        ),
    }
}

/// v0.2.1 — BOTH channels, with every row saying which one it came from.
///
/// owner 2026-07-28:「已配对手机清单中，要区分本地局域网和云端中继建立的连接，即
/// 同一个手机可以存在两条记录」("In the list of paired phones, distinguish between
/// connections established via local LAN vs. cloud relay — i.e. the same phone
/// can have two records"). That is not a display preference, it is the
/// truth: the two channels are two servers with two `mobile_pairings` tables, so
/// a phone paired over both genuinely IS two pairings — with different ids,
/// different disconnect/revoke (断开/撤销) consequences, and independent presence.
///
/// This used to ask `with_socket`, i.e. the PRIMARY channel only, so half the
/// user's pairings were invisible and which half depended on which channel
/// happened to be primary at the time.
///
/// `unreachable` is the honesty half. Silently omitting a channel we could not
/// ask would render as 「那条通道上没有手机」("there's no phone on that channel") —
/// the exact conflation of 「没有」("there is none") and 「问不到」("can't be reached")
/// that paired-mobiles.ts calls out as its first rule.
#[derive(serde::Serialize)]
pub struct PairedMobilesView {
    /// Every row from every channel that answered, each tagged with `channel`.
    rows: Vec<Value>,
    /// Channels that are resident but did not answer (socket down / ack timeout
    /// / server refusal). The page states these; it never pretends they are empty.
    unreachable: Vec<&'static str>,
}

#[tauri::command]
pub fn list_paired_mobiles(
    state: State<'_, SocketState>,
    cloud: State<'_, cloud::CloudState>,
) -> PairedMobilesView {
    let mut rows: Vec<Value> = Vec::new();
    let mut unreachable: Vec<&'static str> = Vec::new();
    // Read once, outside the loop: the verdict must not change between the two
    // channels of a single answer.
    let cloud_readiness = cloud
        .snapshot()
        .readiness(crate::socket::channel::now_secs());
    for channel in [crate::socket::Channel::Lan, crate::socket::Channel::Cloud] {
        let tag = channel.tag();
        let answered = {
            let guard = match state.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            guard
                .slot(channel)
                .map(|s| s.fetch_paired_mobiles(std::time::Duration::from_secs(5)))
        };
        match answered {
            // No live session on this channel. Two very different states share
            // this arm, so ask which one it is (#6, see
            // [`absent_slot_is_unreachable`]): a channel that is configured but
            // auth-dead is 「问不到」("can't be reached") and must be stated; a channel that was never
            // configured is genuinely nothing to report.
            None => {
                if absent_slot_is_unreachable(channel, &cloud_readiness) {
                    unreachable.push(tag);
                }
            }
            Some(None) => unreachable.push(tag),
            Some(Some(value)) => {
                let list = value.as_array().cloned().unwrap_or_default();
                for mut row in list {
                    if let Some(obj) = row.as_object_mut() {
                        // Stamped HERE rather than trusted from the ack: the
                        // server has no idea which of our two sockets asked it.
                        obj.insert("channel".to_string(), Value::String(tag.to_string()));
                    }
                    rows.push(row);
                }
            }
        }
    }
    PairedMobilesView { rows, unreachable }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_auth_dead_cloud_channel_is_reported_unreachable_not_omitted() {
        // THE owner-reported defect (#6): login expired / key refused ⇒ the
        // socket slot is dropped, and the page used to render as if the channel
        // had no pairings at all. `unreachable` is what keeps the rows on screen
        // as 状态未知 ("status unknown"; the frontend cache is preserved for a channel that did
        // not answer — paired-mobiles.ts mergeWithCache).
        assert!(absent_slot_is_unreachable(
            Channel::Cloud,
            &CloudReadiness::KeyExpired
        ));
        assert!(absent_slot_is_unreachable(
            Channel::Cloud,
            &CloudReadiness::Rejected("AUTH_TOKEN_EXPIRED".into())
        ));
        // Any refusal code, not just the auth pair — PCS_LIMIT_EXCEEDED and a
        // malformed key are equally 「配好了但连不上」("paired but can't connect").
        assert!(absent_slot_is_unreachable(
            Channel::Cloud,
            &CloudReadiness::Rejected("PCS_LIMIT_EXCEEDED".into())
        ));
    }

    #[test]
    fn a_never_configured_cloud_channel_stays_silent() {
        // THE REVERSE ASSERTION. Without this, every desktop that never signed
        // in to the cloud would grow a permanent 「云端问不到」("cloud unreachable") complaint about a
        // channel the user never asked for — fixing one dishonesty by inventing
        // another. NoKey is the deliberate sign-out state and keeps today's
        // behaviour on purpose (the frontend purge for it is intended).
        assert!(!absent_slot_is_unreachable(
            Channel::Cloud,
            &CloudReadiness::NoEndpoint
        ));
        assert!(!absent_slot_is_unreachable(
            Channel::Cloud,
            &CloudReadiness::NoKey
        ));
    }

    #[test]
    fn the_lan_channel_is_untouched_by_this_change() {
        // LAN has no account credential, so no cloud verdict may ever move it.
        for r in [
            CloudReadiness::Ready,
            CloudReadiness::KeyExpired,
            CloudReadiness::NoKey,
            CloudReadiness::NoEndpoint,
            CloudReadiness::Rejected("AUTH_TOKEN_EXPIRED".into()),
        ] {
            assert!(!absent_slot_is_unreachable(Channel::Lan, &r));
        }
    }

    #[test]
    fn a_ready_cloud_channel_with_no_slot_stays_silent() {
        // Ready-but-not-resident is the startup window before the first dial.
        // Complaining there would paint a fault during normal boot.
        assert!(!absent_slot_is_unreachable(
            Channel::Cloud,
            &CloudReadiness::Ready
        ));
    }
}
