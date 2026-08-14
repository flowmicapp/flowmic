// Tests for `mod.rs` — the plan that falls out of (manifest × install form).
//
// This is the layer where the §3 failure table becomes behaviour, so the cases
// below are named after its rows rather than after the functions they call.

use super::*;
use serde_json::json;

/// A manifest offering `version` for THIS machine's platform key, with whatever
/// artifacts are passed in. Built around `platform_key()` rather than a literal
/// `"windows-x64"` so the suite means the same thing on the Mac mini.
fn manifest_for(version: &str, artifacts: serde_json::Value) -> UpdateManifest {
    let raw = json!({
        "manifest_version": 1,
        "generated_at": "2026-08-08T00:00:00.000Z",
        "platforms": {
            platform_key(): {
                "version": version,
                "notes_url": "https://example.invalid/notes",
                "artifacts": artifacts,
            }
        }
    });
    parse_manifest(&raw).expect("fixture must be a valid manifest")
}

fn msi_artifacts() -> serde_json::Value {
    json!([
        { "kind": "msi", "locale": "zh-CN", "filename": "z.msi", "url": "http://d/z.msi",
          "sha256": "a".repeat(64), "size": 100 },
        { "kind": "msi", "locale": "en-US", "filename": "e.msi", "url": "http://d/e.msi",
          "sha256": "b".repeat(64), "size": 101 },
        { "kind": "portable-zip", "locale": null, "filename": "p.zip", "url": "http://d/p.zip",
          "sha256": "c".repeat(64), "size": 102 }
    ])
}

fn msi_form() -> InstallForm {
    InstallForm::MsiInstalled { install_dir: std::path::PathBuf::from("C:\\Program Files\\FlowMic") }
}

/// A version guaranteed to be higher than whatever this build is.
fn newer() -> String {
    let c = Version::current().unwrap();
    format!("{}.{}.{}", c.major, c.minor, c.patch + 1)
}

fn older() -> String {
    let c = Version::current().unwrap();
    // patch 0 cannot go lower, so drop a minor instead.
    if c.patch > 0 {
        format!("{}.{}.{}", c.major, c.minor, c.patch - 1)
    } else {
        format!("{}.{}.{}", c.major, c.minor.saturating_sub(1), 99)
    }
}

/// §3 row 7 — the ONE branch allowed to say 「已是最新」("already up to date"), and it needs both the
/// equal and the lower case.
#[test]
fn only_an_equal_or_older_manifest_is_up_to_date() {
    let mine = Version::current().unwrap();
    for v in [mine.to_string(), older()] {
        let m = manifest_for(&v, msi_artifacts());
        assert_eq!(
            plan_from_manifest(&m, &msi_form(), "zh-CN").unwrap(),
            UpdatePlan::UpToDate { current: mine },
            "{v} must be up-to-date, never an update",
        );
    }
}

/// The happy path: a newer version with an artifact we can fetch.
#[test]
fn a_newer_version_with_an_installable_artifact_is_available() {
    let m = manifest_for(&newer(), msi_artifacts());
    let plan = plan_from_manifest(&m, &msi_form(), "zh-CN").unwrap();
    match plan {
        UpdatePlan::Available { ref artifact, latest, current, ref notes_url, .. } => {
            assert_eq!(current, Version::current().unwrap());
            assert_eq!(latest.to_string(), newer());
            assert_eq!(artifact.kind, "msi");
            // The UI language decides which MSI — NOT the OS locale (red line).
            assert_eq!(artifact.locale.as_deref(), Some("zh-CN"));
            assert_eq!(notes_url.as_deref(), Some("https://example.invalid/notes"));
        }
        other => panic!("expected Available, got {}", other.tag()),
    }
    // Same manifest, different UI language ⇒ different package.
    match plan_from_manifest(&m, &msi_form(), "en-US").unwrap() {
        UpdatePlan::Available { artifact, .. } => assert_eq!(artifact.locale.as_deref(), Some("en-US")),
        other => panic!("expected Available, got {}", other.tag()),
    }
}

/// A portable copy gets the portable artifact, not the MSI.
///
/// 🔴 REWRITTEN IN UP-3b, AND THE REWRITE IS THE POINT. This test used to accept
/// EITHER `Available` OR `ManualOnly { PortableForm }` — the second arm carried a
/// comment calling §4.5 an open owner question, which it was when the test was
/// written. The consequence was that it stayed green no matter which way the code
/// went, and so it never noticed that `ManualReason::PortableForm` had no
/// producer at all (`fetchable_kinds(Portable)` is never empty).
///
/// ⇒ **A test that admits both answers pins neither.** Now that owner 2026-08-04
/// ② has ruled — the portable edition really upgrades in place — there is exactly
/// one correct plan for this input, and this asserts that one.
#[test]
fn a_portable_copy_is_offered_the_portable_bundle_and_never_the_installer() {
    let m = manifest_for(&newer(), msi_artifacts());
    match plan_from_manifest(&m, &InstallForm::Portable, "zh-CN").unwrap() {
        UpdatePlan::Available { artifact, form, .. } => {
            assert_eq!(artifact.kind, "portable-zip");
            assert_eq!(form, InstallForm::Portable);
        }
        other => panic!(
            "a portable copy with a portable-zip in the manifest must be `available`, got `{}`",
            other.tag(),
        ),
    }
}

/// 🔴 THE OPEN-SET DEGRADATION — the whole reason `kind` is a `String`.
///
/// A manifest built by a newer release chain, offering only kinds this binary
/// has never heard of. It must produce a state the user can act on and leave.
/// If `kind` were an enum, this manifest would not have parsed at all.
#[test]
fn an_all_unknown_manifest_degrades_to_here_is_the_page_and_never_to_up_to_date() {
    let m = manifest_for(
        &newer(),
        json!([
            { "kind": "dmg", "locale": null, "filename": "x.dmg", "url": "http://d/x.dmg",
              "sha256": "a".repeat(64), "size": 1 },
            { "kind": "appimage-from-2029", "locale": null, "filename": "y.AppImage",
              "url": "http://d/y", "sha256": "b".repeat(64), "size": 2 }
        ]),
    );
    let plan = plan_from_manifest(&m, &msi_form(), "zh-CN").unwrap();
    assert_ne!(plan.tag(), "up_to_date");
    match plan {
        UpdatePlan::ManualOnly { reason, latest, notes_url, .. } => {
            assert_eq!(
                reason,
                ManualReason::NoFetchableKind {
                    offered: vec!["appimage-from-2029".to_string(), "dmg".to_string()],
                },
            );
            // 🔴 The degradation must still say WHICH version and WHERE to get
            // it. Dropping these would leave 「有更新但我不能告诉你是什么」
            // ("there's an update but I can't tell you what it is") —
            // a state the user can neither act on nor leave.
            assert_eq!(latest.to_string(), newer());
            assert!(notes_url.is_some());
        }
        other => panic!("an unknown kind must degrade to ManualOnly, got {}", other.tag()),
    }
}

/// 🔴 Ordering: the version check runs BEFORE artifact selection.
///
/// Reversed, a machine already on the latest version whose platform happens to
/// ship only an unrecognised kind would be told 「有新版本，去下载页」
/// ("there's a new version, go to the download page") about the
/// version it is already running.
#[test]
fn an_unknown_kind_on_a_version_we_already_have_is_still_up_to_date() {
    let m = manifest_for(
        &Version::current().unwrap().to_string(),
        json!([{ "kind": "dmg", "locale": null, "filename": "x.dmg", "url": "http://d/x",
                 "sha256": "a".repeat(64), "size": 1 }]),
    );
    assert_eq!(
        plan_from_manifest(&m, &msi_form(), "zh-CN").unwrap(),
        UpdatePlan::UpToDate { current: Version::current().unwrap() },
    );
}

/// §4.2 — a dev build checks nothing, and 「没看」("haven't looked") is not 「最新」("latest").
#[test]
fn a_dev_build_concludes_nothing_and_that_is_not_up_to_date() {
    let m = manifest_for(&newer(), msi_artifacts());
    let plan = plan_from_manifest(&m, &InstallForm::Dev, "zh-CN").unwrap();
    assert_eq!(plan, UpdatePlan::NotChecked { form: InstallForm::Dev });
    assert_ne!(plan.tag(), "up_to_date");

    // …and `check()` must short-circuit BEFORE the network. The base below is
    // unroutable, so any real request would fail rather than return NotChecked.
    let out = check("http://127.0.0.1:9", &InstallForm::Dev, "zh-CN").unwrap();
    assert_eq!(out, UpdatePlan::NotChecked { form: InstallForm::Dev });
}

/// §3 row 4 — the manifest is valid and has no entry for us.
#[test]
fn a_manifest_without_our_platform_names_what_it_did_have() {
    let raw = json!({
        "manifest_version": 1,
        "generated_at": "x",
        "platforms": {
            "android": { "version": "9.9.9", "notes_url": null, "artifacts": [
                { "kind": "apk", "locale": null, "filename": "a.apk", "url": "http://d/a.apk",
                  "sha256": "a".repeat(64), "size": 1 }
            ]}
        }
    });
    let m = parse_manifest(&raw).unwrap();
    let err = plan_from_manifest(&m, &msi_form(), "zh-CN").unwrap_err();
    assert_eq!(
        err,
        UpdateFailure::NoBuildForThisPlatform {
            platform: platform_key(),
            available: vec!["android".to_string()],
        },
    );
    // 🔴 Not 「已是最新」("already up to date") — we have no idea whether we are.
    assert_ne!(err.tag(), "up_to_date");
}

/// Forms with no fetchable kind each give their OWN reason. Collapsing them
/// would tell an unknown copy it is portable, which is R11's failure — a status
/// word whose evidence does not support it.
#[test]
fn each_non_installable_form_gives_its_own_reason() {
    let m = manifest_for(&newer(), msi_artifacts());
    for (form, expected) in [
        (InstallForm::Unknown, ManualReason::UnknownForm),
        (InstallForm::UnsupportedPlatform, ManualReason::UnsupportedPlatform),
    ] {
        match plan_from_manifest(&m, &form, "zh-CN").unwrap() {
            UpdatePlan::ManualOnly { reason, form: got, .. } => {
                assert_eq!(reason, expected);
                assert_eq!(got, form);
            }
            other => panic!("{} should be ManualOnly, got {}", form.tag(), other.tag()),
        }
    }
}

/// Every plan has its own tag — UP-3b's string-table keys.
#[test]
fn every_plan_has_its_own_tag() {
    let mine = Version::current().unwrap();
    let plans = [
        UpdatePlan::NotChecked { form: InstallForm::Dev },
        UpdatePlan::UpToDate { current: mine },
        UpdatePlan::Available {
            form: InstallForm::Portable,
            current: mine,
            latest: mine,
            artifact: UpdateArtifact {
                kind: "msi".into(), locale: None, filename: "a".into(),
                url: "http://d/a".into(), sha256: "a".repeat(64), size: 1,
            },
            notes_url: None,
        },
        UpdatePlan::ManualOnly {
            form: InstallForm::Portable,
            current: mine,
            latest: mine,
            notes_url: None,
            reason: ManualReason::UnknownForm,
        },
    ];
    let mut tags: Vec<&str> = plans.iter().map(UpdatePlan::tag).collect();
    let n = tags.len();
    tags.sort_unstable();
    tags.dedup();
    assert_eq!(tags.len(), n);
}

/// 🔴 The platform key is a CROSS-LANGUAGE contract with no mechanism binding
/// its two halves — Rust computes it, `scripts/pack-portable.mjs` declares it.
/// Drift means this machine asks a manifest for a key nothing ever publishes,
/// and every check would answer 「本平台无更新」("no update for this platform") forever, with no gate going red.
///
/// So the declaration is read as DATA, the same technique
/// `node_runtime.rs::the_bundled_runtime_name_matches_the_pin_declaration` uses.
#[test]
fn this_machines_platform_key_is_one_the_release_chain_publishes() {
    let decl = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..").join("..").join("..")
        .join("scripts").join("pack-portable.mjs");
    let text = std::fs::read_to_string(&decl)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", decl.display()));
    let list = text
        .split("PORTABLE_PLATFORMS")
        .nth(1)
        .and_then(|s| s.split('[').nth(1))
        .and_then(|s| s.split(']').next())
        .unwrap_or_else(|| {
            panic!(
                "could not read PORTABLE_PLATFORMS out of {} — if it moved, re-point this \
                 test rather than deleting it: nothing else relates the Rust spelling of a \
                 platform to the release chain's",
                decl.display(),
            )
        });
    let key = platform_key();
    assert!(
        list.contains(&format!("'{key}'")),
        "this machine computes the platform key `{key}`, which is not in the release \
         chain's whitelist ({list}) — every update check here would answer \
         「本平台无更新」 forever",
    );
}
