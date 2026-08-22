// Tests for `manifest.rs` — the client half of the update-manifest contract.
//
// The shape under test is the one `apps/server-core/src/http/update-routes.ts`
// produces, so the fixture below is a copy of the design's §1.2 example rather
// than something convenient invented here. A fixture written to suit the parser
// tests the parser against itself.

use super::*;
use serde_json::json;

/// The §1.2 example payload, with both Windows MSIs and the portable zip that
/// `scripts/build-update-manifest.mjs` started emitting on 2026-08-07.
fn good() -> Value {
    json!({
        "manifest_version": 1,
        "generated_at": "2026-08-02T12:00:00.000Z",
        "platforms": {
            "windows-x64": {
                "version": "0.2.60",
                "notes_url": "http://100.64.7.68/dl/flowmic/release/FlowMic-0.2.60-RELEASE_NOTES.md",
                "artifacts": [
                    { "kind": "msi", "locale": "zh-CN", "filename": "FlowMic_0.2.60_x64_zh-CN.msi",
                      "url": "http://100.64.7.68/dl/a.msi", "sha256": "a".repeat(64), "size": 12345678 },
                    { "kind": "msi", "locale": "en-US", "filename": "FlowMic_0.2.60_x64_en-US.msi",
                      "url": "http://100.64.7.68/dl/b.msi", "sha256": "b".repeat(64), "size": 12345679 },
                    { "kind": "portable-zip", "locale": null, "filename": "FlowMic-0.2.60-portable.zip",
                      "url": "http://100.64.7.68/dl/c.zip", "sha256": "c".repeat(64), "size": 40000000 }
                ]
            },
            "android": {
                "version": "0.2.60",
                "notes_url": null,
                "artifacts": [
                    { "kind": "apk", "locale": null, "filename": "FlowMic-0.2.60-release.apk",
                      "url": "https://example.invalid/x.apk", "sha256": "d".repeat(64), "size": 45678901 }
                ]
            }
        }
    })
}

/// Replace one artifact field of the first `windows-x64` artifact.
fn with_artifact_field(key: &str, v: Value) -> Value {
    let mut m = good();
    m["platforms"]["windows-x64"]["artifacts"][0][key] = v;
    m
}

#[test]
fn the_reference_payload_parses_and_keeps_every_field() {
    let m = parse_manifest(&good()).expect("the §1.2 reference payload must parse");
    assert_eq!(m.generated_at, "2026-08-02T12:00:00.000Z");
    assert_eq!(m.platform_keys(), vec!["android".to_string(), "windows-x64".to_string()]);

    let w = m.platform("windows-x64").expect("windows-x64 present");
    assert_eq!(w.version, Version::parse("0.2.60").unwrap());
    assert_eq!(w.artifacts.len(), 3);
    assert_eq!(w.kinds(), vec!["msi".to_string(), "portable-zip".to_string()]);
    assert_eq!(w.artifacts[0].locale.as_deref(), Some("zh-CN"));
    assert_eq!(w.artifacts[0].size, 12_345_678);

    // `null` notes_url is an ABSENT page, not a broken manifest.
    assert_eq!(m.platform("android").unwrap().notes_url, None);
    assert!(w.notes_url.is_some());
}

/// 🔴 THE REVERSE-CONTROL TARGET FOR THIS FILE. Every one of these is a shape
/// the endpoint refuses to serve; the client must refuse it too, because it
/// cannot know it is talking to the endpoint (module header, reason 1).
///
/// Loosening `is_sha256_hex` — the single most tempting "simplification" here,
/// since a `typeof x === 'string'` check looks equivalent — must turn the four
/// sha256 rows below red.
#[test]
fn a_manifest_is_refused_rather_than_repaired() {
    let cases: Vec<(&str, Value, &str)> = vec![
        // ── the hash gate ────────────────────────────────────────────────────
        ("empty sha256", with_artifact_field("sha256", json!("")), "bad_sha256"),
        ("short sha256", with_artifact_field("sha256", json!("abc123")), "bad_sha256"),
        ("UPPERCASE sha256", with_artifact_field("sha256", json!("A".repeat(64))), "bad_sha256"),
        ("non-hex sha256", with_artifact_field("sha256", json!("z".repeat(64))), "bad_sha256"),
        ("missing sha256", {
            let mut m = good();
            m["platforms"]["windows-x64"]["artifacts"][0]
                .as_object_mut()
                .unwrap()
                .remove("sha256");
            m
        }, "bad_sha256"),
        // ── the filename becomes a path on this machine ──────────────────────
        ("filename with /", with_artifact_field("filename", json!("a/b.msi")), "unsafe_filename"),
        ("filename with \\", with_artifact_field("filename", json!("a\\b.msi")), "unsafe_filename"),
        ("filename with ..", with_artifact_field("filename", json!("..evil.msi")), "unsafe_filename"),
        ("traversal", with_artifact_field("filename", json!("../../evil.msi")), "unsafe_filename"),
        ("empty filename", with_artifact_field("filename", json!("   ")), "bad_filename"),
        // ── the url decides what we fetch ────────────────────────────────────
        ("file: url", with_artifact_field("url", json!("file:///C:/evil.msi")), "bad_url"),
        ("relative url", with_artifact_field("url", json!("/dl/a.msi")), "bad_url"),
        ("scheme-only url", with_artifact_field("url", json!("https://")), "bad_url"),
        ("data: url", with_artifact_field("url", json!("data:application/octet-stream,AAAA")), "bad_url"),
        // ── size ─────────────────────────────────────────────────────────────
        ("zero size", with_artifact_field("size", json!(0)), "bad_size"),
        ("negative size", with_artifact_field("size", json!(-1)), "bad_size"),
        ("fractional size", with_artifact_field("size", json!(1.5)), "bad_size"),
        ("string size", with_artifact_field("size", json!("12345")), "bad_size"),
        // ── kind is an open set, but it still has to BE something ────────────
        ("empty kind", with_artifact_field("kind", json!("")), "bad_kind"),
        ("non-string kind", with_artifact_field("kind", json!(7)), "bad_kind"),
        // ── structure ────────────────────────────────────────────────────────
        ("not an object", json!([1, 2, 3]), "not_an_object"),
        ("manifest_version 2", {
            let mut m = good();
            m["manifest_version"] = json!(2);
            m
        }, "unsupported_manifest_version"),
        ("no platforms", json!({ "manifest_version": 1, "generated_at": "x" }), "missing_platforms"),
        ("empty platforms", {
            let mut m = good();
            m["platforms"] = json!({});
            m
        }, "empty_platforms"),
        ("empty artifacts", {
            let mut m = good();
            m["platforms"]["windows-x64"]["artifacts"] = json!([]);
            m
        }, "empty_artifacts"),
        ("bad version", {
            let mut m = good();
            m["platforms"]["windows-x64"]["version"] = json!("0.2");
            m
        }, "bad_version"),
        ("v-prefixed version", {
            let mut m = good();
            m["platforms"]["windows-x64"]["version"] = json!("v0.2.60");
            m
        }, "bad_version"),
        ("notes_url is a number", {
            let mut m = good();
            m["platforms"]["windows-x64"]["notes_url"] = json!(7);
            m
        }, "bad_notes_url"),
        ("notes_url is file:", {
            let mut m = good();
            m["platforms"]["windows-x64"]["notes_url"] = json!("file:///etc/passwd");
            m
        }, "bad_notes_url"),
    ];

    for (name, payload, expected_prefix) in cases {
        match parse_manifest(&payload) {
            Ok(_) => panic!("{name}: must be REFUSED, not repaired"),
            Err(reason) => assert!(
                reason.starts_with(expected_prefix),
                "{name}: expected a `{expected_prefix}…` reason, got `{reason}`",
            ),
        }
    }
}

/// 🔴 A reject reason is a diagnostic, and diagnostics get pasted into chat
/// windows. It must never carry the download URL — same rule `cloud.rs` states
/// for its forensic lines, and the same rule the TS validator states for its
/// `reason` (「绝不许含文件路径」("must never contain a file path"), RV-32).
#[test]
fn a_reject_reason_never_echoes_the_url() {
    let m = with_artifact_field("sha256", json!("nope"));
    let reason = parse_manifest(&m).unwrap_err();
    assert!(!reason.contains("100.64.7.68"), "reason leaked the host: {reason}");
    assert!(!reason.contains("http"), "reason leaked a URL: {reason}");
    // …while still saying enough to act on: which platform, which file.
    assert!(reason.contains("windows-x64"), "reason must name the platform: {reason}");
}

/// The one documented divergence from the TS validator (module header). Asserted
/// rather than left as prose, because an untested "we deliberately allow X" is
/// indistinguishable from having forgotten X.
#[test]
fn a_blank_generated_at_is_tolerated_because_we_never_act_on_it() {
    let mut m = good();
    m["generated_at"] = json!("");
    let parsed = parse_manifest(&m).expect(
        "a cosmetic display-only field must not cost this machine its ability to update",
    );
    assert_eq!(parsed.generated_at, "");
    // The fields that DO gate a download are still exactly as strict — this is
    // the asymmetry that makes the tolerance above defensible rather than sloppy.
    assert!(parse_manifest(&with_artifact_field("sha256", json!(""))).is_err());
}

/// Artifact selection. The caller says what it can install; this type says what
/// is on offer.
///
/// 🔴 RENAMED AND REWRITTEN 0.3.24, and the old name is kept in this sentence
/// because it is the evidence: `selection_prefers_an_exact_locale_then_a_neutral_
/// build_then_nothing`. That last clause — 「then nothing」 — was the defect, and
/// this test was what made the defect look like the specification. See
/// `manifest.rs::pick` for what it cost (in-app update was unreachable for every
/// MSI user whose UI language was not zh-CN, which includes the product default).
///
/// The assertion that did it read:
///
///     // A `find`-by-kind that ignored locale would have returned the zh-CN
///     // build to a Japanese user here.
///     assert!(w.pick(&["msi"], "ja-JP").is_none());
///
/// Every word of that comment is true. The conclusion drawn from it was wrong:
/// handing a Japanese user a zh-CN MSI is not a harm (it installs `/passive`,
/// same payload, and the app's own language is a FlowMic setting), while handing
/// them NOTHING is. CLAUDE.md already carries this exact shape from 0.2.52:
/// 「反向对照选错了方向，比没有反向对照更坏 —— 它不是漏掉一个缺陷，是把缺陷写成了
/// 验收标准」 ("a control assertion pointed the wrong way is worse than none — it
/// does not miss a defect, it writes the defect into the acceptance criteria").
/// The question that was never asked of it: **if this assertion is wrong, who
/// comes and tells me?** Nobody did, for as long as the release machine happened
/// to run the one install form the bug spares.
#[test]
fn selection_walks_exact_then_same_language_then_neutral_then_any_of_that_kind() {
    let m = parse_manifest(&good()).unwrap();
    let w = m.platform("windows-x64").unwrap();

    // ① Exact locale match wins.
    assert_eq!(w.pick(&["msi"], "en-US").unwrap().locale.as_deref(), Some("en-US"));
    assert_eq!(w.pick(&["msi"], "zh-CN").unwrap().locale.as_deref(), Some("zh-CN"));

    // ② 🔴 THE TIER WHOSE ABSENCE WAS THE BUG. `en` is the product's DEFAULT UI
    // locale tag and the manifest's MSI is tagged `en-US`; before 0.3.24 these
    // did not match, no neutral msi exists, and the user was told this release
    // had no package for their machine while two sat in the manifest.
    assert_eq!(w.pick(&["msi"], "en").unwrap().locale.as_deref(), Some("en-US"));
    assert_eq!(w.pick(&["msi"], "zh").unwrap().locale.as_deref(), Some("zh-CN"));

    // ④ A language with no build of its own still gets one, rather than getting
    // the feature taken away. Which one is unspecified on purpose — the tiers
    // above decide it, and pinning array order here would re-create exactly the
    // kind of assertion this test's header is about.
    for loc in ["ja", "ko", "ru", "fr", "es", "de", "zh-TW"] {
        assert_eq!(w.pick(&["msi"], loc).expect("every UI locale can install an msi").kind, "msi");
    }

    // ③ A locale-less kind serves everybody.
    for loc in ["zh-CN", "en-US", "ja-JP", "ko-KR"] {
        assert_eq!(w.pick(&["portable-zip"], loc).unwrap().kind, "portable-zip");
    }

    // Preference order is honoured, not array order: the zip is listed LAST in
    // the payload but wins when it is asked for first.
    assert_eq!(w.pick(&["portable-zip", "msi"], "zh-CN").unwrap().kind, "portable-zip");
    assert_eq!(w.pick(&["msi", "portable-zip"], "zh-CN").unwrap().kind, "msi");

    // 🔴 A kind we do not know is simply not selected — it is not an error here
    // and it must not become one. `UpdatePlan` turns「nothing selected」into
    //「有新版本，这是下载页」("there's a new version, here's the download
    // page"), never into a crash and never into「已是最新」("already up to date").
    assert!(w.pick(&["dmg"], "zh-CN").is_none());
    assert!(w.pick(&[], "zh-CN").is_none());
}

/// The open-set promise, stated as a test: a `kind` nobody has taught this build
/// about must survive parsing intact so the UI can name it.
#[test]
fn an_unknown_kind_parses_and_is_reported_verbatim() {
    let mut m = good();
    m["platforms"]["windows-x64"]["artifacts"] = json!([
        { "kind": "flatpak-from-the-future", "locale": null, "filename": "x.flatpak",
          "url": "https://example.invalid/x", "sha256": "e".repeat(64), "size": 1 }
    ]);
    let parsed = parse_manifest(&m).expect("an unknown kind is not a malformed manifest");
    let w = parsed.platform("windows-x64").unwrap();
    assert_eq!(w.kinds(), vec!["flatpak-from-the-future".to_string()]);
    assert!(w.pick(&["msi", "portable-zip"], "zh-CN").is_none());
}
