// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.7 (reserved key `device.pc_name`, F-3101)
//   docs/strategy/2026-07-25-full-gap-audit/05-WAVE-F-OWNER-ROUND.md GA-10
//
// THIS PC'S NAME, as a command. Split out of shell/mod.rs for the 800-line cap;
// the reasoning below is the whole reason the file exists, so it moves intact.

use std::path::Path;

use tauri::State;

use super::SocketState;
use crate::socket::Credentials;

/// Persist the machine name into a channel's credentials file even when that
/// channel is not resident. Creates a fresh identity file when absent so a later
/// `connect_socket` cannot mint `Credentials::fresh` with the factory default
/// (C-1). Returns whether the write landed — a failed write MUST count as a
/// failed rename attempt, never a silent skip that lets `pc_rename` return true.
pub(crate) fn persist_pc_name_on_disk(path: &Path, name: &str) -> bool {
    let mut creds = Credentials::load(path).unwrap_or_else(|| Credentials::fresh(name));
    creds.device_name = name.to_string();
    creds.save(path).is_ok()
}

/// GA-10 — rename THIS PC (04 §3.7 reserved key `device.pc_name`).
///
/// owner 2026-07-26 iron rule: the name is the PC's to set. There is deliberately no
/// mobile-facing counterpart to this command — the phone renames only its OWN
/// local alias, which never leaves the device, and the server refuses a
/// mobile-originated write of this key outright.
///
/// Returns whether EVERY channel this machine owns accepted the name. `false`
/// (socket down / refused / timeout / disk write failed) makes the page say the
/// rename did not happen rather than showing the new label over an unchanged
/// row. The name is validated HERE first, so an empty or over-long value never
/// reaches the wire — and is never silently truncated.
///
/// ── v0.2.1: the rename now goes to BOTH channels ────────────────────────────
///
/// owner 2026-07-28: 「PC 这端的名称应该说它是唯一的。不管通过本地局域网或者云端
/// 中继建立链接，它其实都能够获取同一个名称」("The name on the PC side should be
/// considered singular. Regardless of whether the connection is made via local
/// LAN or cloud relay, it should in fact resolve to the same name.").
///
/// It could not, and this function is why. It used to write only the PRIMARY
/// channel — but GA-28 keeps BOTH resident, and each talks to a DIFFERENT server
/// with its OWN `pc_devices` row. Rename while LAN happened to be primary and the
/// relay's row kept the factory default; a phone pairing through the relay then
/// got that default back from `mobile:pair`'s ack. owner saw exactly that:
/// renamed on the PC, still 「FlowMic-…」 on the phone. Nothing was "not saved" —
/// it was saved in one of two places.
///
/// The name is this machine's identity, not a per-connection property, so it is
/// written everywhere this machine is (or will be) registered. Each channel has
/// its OWN credentials file.
///
/// ── C-1: a non-resident channel is NOT a free pass ──────────────────────────
///
/// Skipping a down channel (`None => {}`) meant: rename with only LAN up returned
/// `true`, while the cloud credentials file (absent, or still holding the factory
/// default) was never touched. The next cloud `connect_socket` then registered as
/// `FlowMic-xxxx`. Choice here: WRITE THE DISK for the dormant channel (create
/// or update), so later connect / reassert carries the user-chosen name. That
/// keeps `true` honest — the machine identity was committed on every channel
/// slot — rather than degrading the return and forcing a UI copy change for the
/// common "LAN only, cloud not configured yet" case.
///
/// Result semantics — deliberately strict: `true` only when EVERY channel slot
/// (resident wire rename OR dormant disk persist) succeeded. A partial rename is
/// precisely the state that produced the bug, so it must not report success.
#[tauri::command]
pub fn pc_rename(state: State<'_, SocketState>, name: String) -> bool {
    let Some(clean) = crate::pc_name::sanitize_pc_name(&name) else {
        return false;
    };
    let channels = [crate::socket::Channel::Lan, crate::socket::Channel::Cloud];
    let mut attempted = 0usize;
    let mut succeeded = 0usize;
    for channel in channels {
        let path = crate::socket::channel::credentials_path(channel);
        let outcome = {
            let guard = match state.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            guard
                .slot(channel)
                .map(|s| s.rename_pc(&clean, &path, std::time::Duration::from_secs(5)))
        };
        match outcome {
            Some(ok) => {
                attempted += 1;
                if ok {
                    succeeded += 1;
                }
            }
            // Not resident: still persist the machine name on disk so a later
            // connect_socket / reassert_pc_name carries it. Skipping here was C-1
            // — `attempted` stayed at 1, success returned true, cloud stayed wrong.
            None => {
                attempted += 1;
                if persist_pc_name_on_disk(&path, &clean) {
                    succeeded += 1;
                }
            }
        }
    }
    crate::forensic::record(
        "rename",
        &format!("pc_rename → {succeeded}/{attempted} channel slot(s) accepted"),
    );
    attempted > 0 && succeeded == attempted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pc_name::reconcile_machine_name;
    use crate::socket::channel::{credentials_path_beside, Channel};
    use crate::socket::Credentials;

    /// C-1: rename while only LAN has a credentials file → cloud slot is seeded
    /// on disk → a later cloud connect resolves to the user-chosen name, never
    /// the factory default that `Credentials::fresh(&env)` would have stamped.
    #[test]
    fn lan_only_rename_then_cloud_connect_carries_the_new_name() {
        let dir = std::env::temp_dir().join(format!("flowmic-c1-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("tmpdir");
        let lan_path = dir.join("credentials.bin");
        let cloud_path = credentials_path_beside(&lan_path, Channel::Cloud);

        // Precondition: only the LAN slot exists (cloud channel not resident yet).
        Credentials::fresh("FlowMic-factory")
            .save(&lan_path)
            .expect("seed lan");
        assert!(Credentials::load(&cloud_path).is_none());

        // pc_rename halves: resident LAN would call rename_pc (disk write inside);
        // non-resident cloud takes the persist path. Both end on disk here.
        assert!(persist_pc_name_on_disk(&lan_path, "书房台式机"));
        assert!(persist_pc_name_on_disk(&cloud_path, "书房台式机"));

        // connect_socket half: reconcile + cfg.device_name (see sidecar_ctl).
        let lan = Credentials::load(&lan_path);
        let cloud = Credentials::load(&cloud_path);
        let (name, _) = reconcile_machine_name(
            lan.as_ref().map(|c| c.device_name.as_str()),
            cloud.as_ref().map(|c| c.device_name.as_str()),
            "FlowMic-factory",
        );
        assert_eq!(name, "书房台式机");
        assert_eq!(
            cloud.expect("cloud file must exist after persist").device_name,
            "书房台式机",
            "cloud credentials must carry the rename, not a later factory fresh()"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
