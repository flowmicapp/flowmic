// Tests for `pc_name.rs` — what this machine is called and how it is told apart.
//
// Split out of pc_name.rs in 0.3.28 purely for the 800-line source cap (the
// macOS class table pushed it over). Same `#[path]` shape `update/form.rs`
// already uses; not one assertion changed in the move.

use super::*;

// ── v0.2.4 machine uid ────────────────────────────────────────────────

#[test]
fn the_same_machine_yields_the_same_uid_every_time() {
    // The entire feature rests on this: the LAN channel and the cloud
    // channel each call machine_uid() independently, and they must agree
    // with nothing shared between them but the machine itself.
    let a = compose_machine_uid("GUID-1234", "owner").expect("uid");
    let b = compose_machine_uid("GUID-1234", "owner").expect("uid");
    assert_eq!(a, b);
    assert!(a.starts_with("pc-"), "prefix keeps it distinct from a phone's mb-");
    assert_eq!(a.len(), 3 + 16, "pc- + 8 bytes of digest");
    assert!(a[3..].chars().all(|c| c.is_ascii_hexdigit()));
}

#[test]
fn the_uid_matches_the_protocol_shape() {
    // protocol-primitives.ts DeviceUid: /^[a-z]{2}-[0-9a-f]{16,48}$/. A uid
    // that fails it is DROPPED at the server boundary (.catch(undefined)),
    // which would be silent — so the shape is asserted on this side too.
    let uid = compose_machine_uid("GUID-1234", "owner").expect("uid");
    let (prefix, hex) = uid.split_at(3);
    assert_eq!(prefix, "pc-");
    assert!((16..=48).contains(&hex.len()));
    assert!(hex.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
}

#[test]
fn two_windows_users_on_one_machine_do_not_collide() {
    // The ping-pong this prevents: registry.registerPc resolves a returning
    // machine by uid when the instance id misses, so two Windows accounts
    // sharing a uid would take turns stealing each other's row and rotating
    // each other's token, forever. See the module note.
    let a = compose_machine_uid("GUID-1234", "alice").expect("uid");
    let b = compose_machine_uid("GUID-1234", "bob").expect("uid");
    assert_ne!(a, b);
}

#[test]
fn two_machines_do_not_collide() {
    let a = compose_machine_uid("GUID-1111", "owner").expect("uid");
    let b = compose_machine_uid("GUID-2222", "owner").expect("uid");
    assert_ne!(a, b);
}

#[test]
fn no_machine_id_means_no_claim_at_all() {
    // NOT a placeholder. A constant fallback would be the same string on
    // every machine that also could not read its id, and the server would
    // then merge two strangers into one PC row.
    assert_eq!(compose_machine_uid("", "owner"), None);
    assert_eq!(compose_machine_uid("   ", "owner"), None);
}

#[test]
fn a_machine_with_no_readable_user_still_gets_a_uid() {
    // Degraded but usable: the machine id alone still separates machines.
    // Only the two-Windows-users case loses its guard, and that is strictly
    // better than claiming nothing.
    let uid = compose_machine_uid("GUID-1234", "").expect("uid");
    assert!(uid.starts_with("pc-"));
    assert_ne!(uid, compose_machine_uid("GUID-1234", "owner").expect("uid"));
}

#[test]
fn the_raw_machine_id_never_appears_in_the_uid() {
    // The privacy claim, asserted rather than asserted-in-a-comment.
    let uid = compose_machine_uid("4c4c4544-0037-5210-8044-b4c04f434finstance", "owner").expect("uid");
    assert!(!uid.contains("4c4c4544"));
    assert!(!uid.contains("owner"));
}

#[test]
fn sha256_matches_the_known_vectors() {
    // Without this the digest could be quietly wrong and the suffix would
    // still "look fine" — four hex characters reveal nothing by eye.
    let empty = sha256(b"");
    assert_eq!(
        hex(&empty),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        hex(&sha256(b"abc")),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn the_default_name_is_readable_and_disambiguated() {
    let a = compose_default_name("STUDIO-PC", "guid-aaaa");
    assert!(a.starts_with("FlowMic-STUDIO-PC-"), "{a}");
    assert_eq!(a.chars().count(), "FlowMic-STUDIO-PC-".len() + 4);
}

// ── 0.3.28: the macOS class table ───────────────────────────────────────
//
// 🔴 These run on Windows and that is the point. `read_hw_model` is behind
// `cfg(target_os = "macos")` and this gate cannot compile it, let alone run
// it — so the platform call is kept to ONE line and every rule worth
// getting wrong lives in this pure function, where a Windows gate has full
// proving power. What still needs the Mac is only "does sysctl answer at
// all", which `scripts/mac-verify.sh` covers.

#[test]
fn apple_silicon_generic_identifiers_resolve_rather_than_falling_through() {
    // 🔴 THE ARM THAT MATTERS MOST, and the one a prefix table written from
    // memory omits: Apple Silicon reports no class word. Mac Studio is
    // `Mac13,1`, the M2 mini `Mac14,3`. A `None` here would send the caller
    // back to the drifting hostname on most machines Apple sells.
    for model in ["Mac13,1", "Mac14,3", "Mac14,12", "Mac15,4", "Mac16,10"] {
        assert_eq!(mac_hardware_class(model), Some("Mac"), "{model}");
    }
}

#[test]
fn longer_prefixes_win_over_the_shorter_ones_they_contain() {
    // `MacBookPro18,3` starts with `MacBook`; `iMacPro1,1` starts with
    // `iMac`; every classic identifier starts with `Mac`. Get the order
    // wrong and each of these silently returns the shorter name — a wrong
    // machine name, with nothing to report it.
    assert_eq!(mac_hardware_class("MacBookPro18,3"), Some("MacBook Pro"));
    assert_eq!(mac_hardware_class("MacBookAir10,1"), Some("MacBook Air"));
    assert_eq!(mac_hardware_class("MacBook10,1"), Some("MacBook"));
    assert_eq!(mac_hardware_class("iMacPro1,1"), Some("iMac Pro"));
    assert_eq!(mac_hardware_class("iMac21,1"), Some("iMac"));
    assert_eq!(mac_hardware_class("Macmini9,1"), Some("Mac mini"));
    assert_eq!(mac_hardware_class("MacPro7,1"), Some("Mac Pro"));
    assert_eq!(mac_hardware_class("VirtualMac2,1"), Some("Mac"));
}

/// 🔴 The one assertion in this file that a Windows gate cannot make, and the
/// only one that would have caught the ACTUAL defect: before 0.3.28 the macOS
/// name half was `hostname()`, and on the one Mac this project owns that answers
/// `172-77-77-142.adr01.atmr.al.ip.frontiernet.net` — the ISP's reverse-DNS
/// record for the current address, not a machine name at all.
///
/// Written against the LADDER rather than against that literal: pinning the
/// measured string would make this a test about one Mac on one network, and it
/// would go red the next time the lease changes — which is the very property
/// being complained about.
#[cfg(target_os = "macos")]
#[test]
fn the_name_half_prefers_the_users_own_name_over_the_network_hostname() {
    let half = super::read_name_half_uncached();
    assert!(!half.trim().is_empty(), "a Mac must never propose an empty name half");
    if let Some(computer_name) = super::read_scutil("ComputerName") {
        assert_eq!(
            half, computer_name,
            "ComputerName was readable and the name half is something else — \
             that is the pre-0.3.28 behaviour (it used hostname())",
        );
    } else if let Some(class) = super::read_hw_model().as_deref().and_then(super::mac_hardware_class) {
        assert_eq!(half, class, "no ComputerName, so the machine CLASS must have won");
    }
}

#[test]
fn a_string_that_names_no_mac_is_none_not_a_guess() {
    // The caller falls back to the hostname on None. Answering "Mac" for
    // anything at all would make that fallback unreachable and would put
    // the word "Mac" on machines this function knows nothing about.
    assert_eq!(mac_hardware_class(""), None);
    assert_eq!(mac_hardware_class("   "), None);
    assert_eq!(mac_hardware_class("x86_64"), None);
    assert_eq!(mac_hardware_class("arm64"), None);
}

#[test]
fn a_mac_class_composes_into_a_readable_default_name() {
    // End to end through the same composer Windows uses: the shape does not
    // fork per platform, only the half that feeds it.
    let n = compose_default_name(mac_hardware_class("Macmini9,1").unwrap(), "io-platform-uuid");
    assert!(n.starts_with("FlowMic-Mac mini-"), "{n}");
    assert_eq!(n.chars().count(), "FlowMic-Mac mini-".len() + 4);
    // Two Mac minis are still told apart by the suffix, exactly as two
    // Windows boxes with one hostname are.
    let m = compose_default_name(mac_hardware_class("Macmini9,1").unwrap(), "another-uuid");
    assert_ne!(n, m);
}

#[test]
fn two_machines_that_share_a_hostname_still_differ() {
    // The whole reason the suffix exists: a cloned/reimaged box keeps its name.
    let a = compose_default_name("PC", "machine-guid-one");
    let b = compose_default_name("PC", "machine-guid-two");
    assert_ne!(a, b);
}

#[test]
fn the_suffix_is_stable_across_launches() {
    // A name that changed every start would be worse than a duplicate.
    assert_eq!(short_digest("machine-guid-one"), short_digest("machine-guid-one"));
    assert_eq!(short_digest("").len(), 4, "unknown id → stable placeholder");
    assert_eq!(short_digest(""), "0000");
}

#[test]
fn the_raw_machine_id_never_appears_in_the_name() {
    let id = "9f8e7d6c-5b4a-3210-fedc-ba9876543210";
    let name = compose_default_name("PC", id);
    assert!(!name.contains(id));
    assert!(!name.contains("9f8e7d6c"));
}

#[test]
fn a_missing_hostname_still_yields_a_usable_name() {
    let n = compose_default_name("   ", "guid");
    assert!(n.starts_with("FlowMic-"));
    assert_eq!(n.chars().count(), "FlowMic-".len() + 4);
}

#[test]
fn the_default_always_fits_the_protocol_cap() {
    let long = "H".repeat(300);
    let n = compose_default_name(&long, "guid");
    assert!(n.chars().count() <= PC_NAME_MAX_CHARS, "{}", n.chars().count());
    assert!(sanitize_pc_name(&n).is_some());
}

#[test]
fn sanitize_refuses_rather_than_truncates() {
    assert_eq!(sanitize_pc_name("  书房台式机  ").as_deref(), Some("书房台式机"));
    assert_eq!(sanitize_pc_name("   "), None);
    assert_eq!(sanitize_pc_name(""), None);
    // 81 chars — refused, NOT silently cut down to 80.
    assert_eq!(sanitize_pc_name(&"x".repeat(PC_NAME_MAX_CHARS + 1)), None);
    assert!(sanitize_pc_name(&"x".repeat(PC_NAME_MAX_CHARS)).is_some());
}

// ── v0.2.1: ONE name per machine ────────────────────────────────────────
//
// The case that produced these: a real smoke run of the 0.2.1 build logged
//   re-asserted pc name on connect: "FlowMic PC"        (cloud)
//   re-asserted pc name on connect: "office-pc-windows" (lan)
// Two channels, two credential files, two names. Every unit test agreed with
// itself; only a live launch showed it.

#[test]
fn a_user_chosen_name_beats_the_legacy_default_whichever_side_holds_it() {
    assert_eq!(
        reconcile_machine_name(Some("office-pc-windows"), Some(LEGACY_DEFAULT_PC_NAME), "fb"),
        ("office-pc-windows".to_string(), false),
        "the exact split observed on owner's machine"
    );
    // …and symmetrically, so the fix does not depend on WHICH file drifted.
    assert_eq!(
        reconcile_machine_name(Some(LEGACY_DEFAULT_PC_NAME), Some("书房台式机"), "fb"),
        ("书房台式机".to_string(), false),
    );
}

#[test]
fn an_empty_or_missing_slot_never_wins() {
    assert_eq!(reconcile_machine_name(None, Some("书房"), "fb").0, "书房");
    assert_eq!(reconcile_machine_name(Some("   "), Some("书房"), "fb").0, "书房");
    assert_eq!(reconcile_machine_name(Some(""), None, "fb").0, "fb");
}

#[test]
fn two_leftover_defaults_fall_back_to_the_per_machine_name() {
    // Neither side was ever renamed ⇒ neither is a choice, so the unique
    // per-machine default is the right answer rather than the ancient literal
    // that made two machines look identical (GA-10 iron rule ④).
    let (name, conflicted) = reconcile_machine_name(
        Some(LEGACY_DEFAULT_PC_NAME),
        Some(LEGACY_DEFAULT_PC_NAME),
        "FlowMic-STUDIO-3f7a",
    );
    assert_eq!(name, "FlowMic-STUDIO-3f7a");
    assert!(!conflicted, "two leftovers are not a user conflict");
}

#[test]
// `REPORTED` IS SHOUTED ON PURPOSE — do not snake_case it (DOC-HYG, 2026-08-09).
// The name's whole content is the contrast `REPORTED … not_a_silent_pick`: LAN
// wins by precedence either way, so what this test pins is not WHICH name is
// chosen but that the loser's disappearance is REPORTABLE. Flattened to
// lowercase the two halves read as one bland phrase and the contrast — the
// thing that would be silently lost if `conflicted` ever stopped being
// returned — stops being visible in the failure line. Narrowest scope on
// purpose: an accidentally camelCased name elsewhere must still go red.
#[allow(non_snake_case)]
fn two_different_user_names_are_a_REPORTED_conflict_not_a_silent_pick() {
    // LAN wins by precedence, but the caller must be able to say WHY the
    // other one disappeared — a rename that silently reverts is the thing
    // this whole area exists to stop.
    let (name, conflicted) = reconcile_machine_name(Some("书房"), Some("客厅"), "fb");
    assert_eq!(name, "书房");
    assert!(conflicted);
}

#[test]
fn identical_names_are_never_a_conflict_and_never_rewritten() {
    let (name, conflicted) = reconcile_machine_name(Some("书房"), Some(" 书房 "), "fb");
    assert_eq!(name, "书房", "trimmed comparison, trimmed result");
    assert!(!conflicted);
}
