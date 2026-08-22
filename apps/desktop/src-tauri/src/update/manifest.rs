// SPEC-REF:
//   docs/strategy/2026-08-02-l4-in-app-update-design.md §1.2 (the payload) / §2.2 (the three gates)
//   apps/server-core/src/http/update-routes.ts — `validateUpdateManifest`, the
//     TypeScript half of this same contract. THAT FILE IS THE CONTRACT; this one
//     mirrors it.
//
// The client-side manifest reader. It REJECTS, it does not REPAIR — for the same
// reason stated in the TS validator's header: a manifest that has been quietly
// patched up with defaults arrives at the caller looking normal, and every
// judgement downstream is then made on a value nobody chose.
//
// ── WHY VALIDATE AGAIN, WHEN THE ENDPOINT ALREADY DID ────────────────────────
//
// The card asked this and it deserves a real answer rather than "defence in
// depth", which is the phrase people use when they have not got one.
//
//   1. 🔴 **We cannot know we are talking to our endpoint.** Every argument for
//      trusting this JSON is an argument about the SERVER, and the client has no
//      way to establish which server answered: a captive portal, a corporate
//      middlebox, a self-hosted relay someone pointed this build at, or simply a
//      server-core older or newer than this desktop build, all produce a 200
//      with a body. The endpoint's validator protects「我们不会发出一份没法验的
//      清单」("we will never issue a manifest that cannot be verified"). It
//      cannot protect「我收到的这份被验过」("the copy I received has been
//      verified") — that claim is only
//      available to whoever holds the bytes, which is us.
//
//   2. 🔴 **`sha256` is the field where trusting an unvalidated string means
//      writing an unverifiable file to disk.** Design §2.1: until stage-2 code
//      signing exists, this hash is the ONLY integrity guarantee on a plain-HTTP
//      download. If an empty or short `sha256` reached `download.rs`, the
//      comparison would be against a value that cannot match anything — and the
//      tempting "fix" for that symptom is to skip the comparison when the hash
//      looks unusable, which is literally 「验不过就当没校验」("treating a
//      failed verification as if no verification happened"). Refusing the
//      manifest at this boundary makes that repair unreachable.
//
//   3. **`filename` becomes a path on this machine.** `..` or a separator would
//      let a manifest choose where we write. Boundary refusal beats every call
//      site remembering to be careful.
//
//   4. **`url` scheme** — a `file:` URL would make "download" read a local file
//      and hand it to the installer.
//
// ── WHERE THIS DELIBERATELY DIVERGES FROM THE TS VALIDATOR ───────────────────
//
// One check is genuinely redundant here and is therefore NOT reproduced, rather
// than added for symmetry:
//
//   ⚠️ **`generated_at` is parsed but never rejected for being empty.** The TS
//   side refuses a blank one, and it is right to — it is telling operations that
//   their generator is broken. This side has a different job. We never act on
//   that timestamp; it is display-only. Rejecting an entire manifest over a
//   cosmetic field would convert a server-side blemish into 「this machine can
//   never update again」, and that trade is bad in exactly the direction that
//   matters: the field cannot cause an unverifiable byte to be written.
//
// Note the ASYMMETRY that makes this safe to say: on `sha256` / `url` /
// `filename` / `size` / `manifest_version` this file is exactly as strict as the
// endpoint. It is more permissive ONLY on a field it does not use.

use std::collections::BTreeMap;

use serde_json::Value;

use super::version::Version;

/// One downloadable file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateArtifact {
    /// 🔴 **AN OPEN SET.** `msi`, `apk`, `portable-zip` today [measured 2026-08-08:
    /// those are the three `scripts/build-update-manifest.mjs` emits], `dmg` and
    /// whatever else tomorrow. It is a `String` and not an enum ON PURPOSE, and
    /// the reason is a P0 this repo has now shipped twice: a closed set in the
    /// consumer position turns「a value I have not been taught」into「a value that
    /// does not exist」. In 0.2.48 that made the phone say 「待投递」("still to
    /// be delivered") forever, and
    /// it was re-created a second time this month with the two unregistered
    /// inject codes. An unknown `kind` here MUST degrade to 「有新版本，这是下载
    /// 页」("there's a new version, here's the download page") — see
    /// `UpdatePlan::ManualOnly` — never to a crash, never to 「已是最
    /// 新」("already up to date"), and never to a state the user cannot leave.
    pub kind: String,
    /// `Some("zh-CN")` when a platform ships one build per language (Windows has
    /// two MSIs), `None` when it ships one for everybody.
    pub locale: Option<String>,
    /// The name we will write on disk. Validated to contain no separator and no
    /// `..` — see the header.
    pub filename: String,
    /// Absolute `http(s)`. Plain HTTP is ALLOWED and that is not an oversight:
    /// the download centre is HTTP-only, which is the entire reason `sha256`
    /// exists (design §2.1).
    pub url: String,
    /// 64 lowercase hex. The gate.
    pub sha256: String,
    /// Bytes. Positive.
    pub size: u64,
}

/// One platform's latest release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdatePlatform {
    /// Parsed at the boundary rather than carried as a string, so no caller can
    /// end up comparing versions as text (`version.rs` header).
    pub version: Version,
    pub notes_url: Option<String>,
    pub artifacts: Vec<UpdateArtifact>,
}

impl UpdatePlatform {
    /// Pick the artifact this build should install.
    ///
    /// `wanted_kinds` is in PREFERENCE order and is supplied by the caller
    /// (which knows its install form), not decided here: this type describes
    /// what the server offers, and「我们能装哪一种」("which kind can we
    /// install") is a fact about the running
    /// copy. Two questions, two owners.
    ///
    /// `locale` matches when the artifact declares one; an artifact with
    /// `locale: None` serves every language and so matches unconditionally.
    /// 🔴 A locale-less artifact is a WEAKER match than an exact one, so exact
    /// matches are taken first — otherwise a platform that ships both a neutral
    /// and a per-language build would hand a zh-CN user the neutral one purely
    /// because of array order.
    ///
    /// ── 🔴 WHY THERE ARE FOUR TIERS AND NOT TWO (0.3.24) ────────────────────
    ///
    /// The two-tier version (exact, then locale-less) shipped a defect that made
    /// in-app update **unusable for almost every MSI user**, and it was reported
    /// from a real machine before it was understood here (owner 2026-08-21,
    /// Windows 10 on 0.3.5: 「提示有新版但无法下载，要连接下载页去下载」 — "it says
    /// there's a new version but cannot download it, it sends you to the download
    /// page").
    ///
    /// [measured, live manifest 2026-08-21] `windows-x64` offers
    /// `msi/en-US`, `msi/zh-CN`, `portable-zip/(none)`. `fetchable_kinds` gives
    /// an MSI install exactly `["msi"]`. The desktop's UI-locale tags are the
    /// registry's — `en`, `zh-CN`, `zh-TW`, `fr`, `es`, `de`, `ja`, `ko`, `ru` —
    /// and **`DEFAULT_LOCALE` is `En`, whose tag is `en`, not `en-US`**.
    ///
    /// ⇒ exact match failed for every language except `zh-CN`, there is no
    /// locale-less msi, `pick` returned `None`, and `plan_from_manifest` turned
    /// that into `ManualOnly { NoFetchableKind }`. The sentence the user got
    /// (「这一版没有本机能自动安装的安装包」/ "this release has no package this
    /// machine can install automatically") was FALSE: two installable packages
    /// were sitting right there in the manifest. The portable form was unaffected
    /// (its artifact declares no locale), which is exactly why this survived —
    /// the machine that publishes releases runs the portable copy.
    ///
    /// The tiers, weakest-match-last:
    ///   ① exact tag (`zh-CN` ⇒ `zh-CN`);
    ///   ② same primary language (`en` ⇒ `en-US`, `pt` ⇒ `pt-BR`) — the tier
    ///      whose absence caused the defect;
    ///   ③ locale-less (serves everyone by declaration);
    ///   ④ 🔴 ANY artifact of that kind.
    ///
    /// ④ looks like giving up on the user's language and is not, because of what
    /// the locale on an MSI actually controls: [measured] the two Windows
    /// installers differ by 4 KiB out of 48 MiB — the same payload with a
    /// different WiX UI string table — and `msi.rs` runs them `/passive`, which
    /// shows a progress bar and asks nothing. The app's own UI language is a
    /// FlowMic setting and is not touched by which MSI installed it. So tier ④
    /// costs a user nothing they can see, while its absence costs them the entire
    /// feature. 「一句话说得对不对」 is decided by what the user can observe, not by
    /// what a field is named.
    pub fn pick(&self, wanted_kinds: &[&str], locale: &str) -> Option<&UpdateArtifact> {
        let lang = primary_language(locale);
        for kind in wanted_kinds {
            let kind: &str = kind;
            let of_kind = |a: &&UpdateArtifact| a.kind == kind;
            if let Some(a) = self
                .artifacts
                .iter()
                .find(|a| of_kind(a) && a.locale.as_deref() == Some(locale))
            {
                return Some(a);
            }
            if let Some(a) = self.artifacts.iter().find(|a| {
                of_kind(a)
                    && a.locale
                        .as_deref()
                        .is_some_and(|l| primary_language(l).eq_ignore_ascii_case(lang))
            }) {
                return Some(a);
            }
            if let Some(a) = self.artifacts.iter().find(|a| of_kind(a) && a.locale.is_none()) {
                return Some(a);
            }
            if let Some(a) = self.artifacts.iter().find(of_kind) {
                return Some(a);
            }
        }
        None
    }

    /// Every distinct `kind` this platform offers, for the「我们一种都不认识」
    /// ("we don't recognize any of these kinds")
    /// message. Sorted so the sentence is stable between runs.
    pub fn kinds(&self) -> Vec<String> {
        let mut k: Vec<String> = self.artifacts.iter().map(|a| a.kind.clone()).collect();
        k.sort();
        k.dedup();
        k
    }
}

/// A validated manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateManifest {
    /// Display-only; see the header for why it is not a gate on this side.
    pub generated_at: String,
    /// `BTreeMap` rather than `HashMap` so iteration order is deterministic —
    /// a diagnostic that lists platforms should read the same twice in a row.
    pub platforms: BTreeMap<String, UpdatePlatform>,
}

impl UpdateManifest {
    /// The entry for a platform key (`windows-x64`, `macos-arm64`, …).
    pub fn platform(&self, key: &str) -> Option<&UpdatePlatform> {
        self.platforms.get(key)
    }

    /// Every platform key present, for the「这份清单里没有你这个平台」
    /// ("this manifest has nothing for your platform") message.
    pub fn platform_keys(&self) -> Vec<String> {
        self.platforms.keys().cloned().collect()
    }
}

/// The primary language subtag — everything before the first `-` or `_`.
///
/// Deliberately NOT a BCP-47 parser. The only question `pick` asks is 「这两个标签
/// 是不是同一种语言」 ("are these two tags the same language"), and the whole set of
/// values either side can hold is small and known: our own UI-locale registry on
/// one side, the locale suffix the release pipeline puts in an MSI filename on
/// the other. A real parser here would be a second, richer answer to a question
/// that has never needed one.
fn primary_language(tag: &str) -> &str {
    tag.split(['-', '_']).next().unwrap_or(tag)
}

/// Is this 64 lowercase hex? The one shape a SHA-256 may take.
///
/// Uppercase is refused even though it denotes the same digest. That looks
/// pedantic and is not: the TS validator refuses it, so accepting it here would
/// mean the two halves of one contract disagree about what a valid manifest is —
/// and the direction of that disagreement is "the client accepts manifests the
/// endpoint would never serve", i.e. the client is quietly running on a contract
/// nobody wrote down. `download.rs` also lowercases what IT computes, so the
/// comparison stays a comparison of two normalised values rather than a guess.
fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Absolute `http`/`https`, checked without pulling in a URL parser.
///
/// ⚠️ This is deliberately a SCHEME check and not a full URL validation. The
/// thing that must be impossible is `file:` / `data:` / a relative path reaching
/// the downloader; whether the host part is well-formed is reqwest's question
/// and it will answer it by failing the request, which is a nameable outcome
/// (`UpdateFailure::DownloadFailed`). Writing a second URL parser here to
/// pre-empt that would be a second authority on what a URL is.
fn is_http_url(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    (lower.starts_with("http://") && s.len() > 7) || (lower.starts_with("https://") && s.len() > 8)
}

fn as_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)?.as_str()
}

/// Parse and validate. `Err` carries a short machine-readable reason.
///
/// The reason vocabulary deliberately MIRRORS the TS validator's `reason`
/// strings (`bad_sha256:<platform>:<filename>`, `empty_artifacts:<platform>`, …)
/// so that a forensic line from this side and a 503 `detail` from the endpoint
/// can be read against each other without a translation table. It is a `String`
/// rather than an enum because it interpolates which platform and which file —
/// and because it is a DIAGNOSTIC, not a user-facing branch. The closed,
/// exhaustive set lives one level up in `UpdateFailure`, which is what the UI
/// switches on.
///
/// 🔴 Reasons never contain the URL. Same rule as `cloud.rs`: a diagnostic that
/// echoes a URL back is how endpoints and account names end up in logs users
/// paste into chat windows.
pub fn parse_manifest(raw: &Value) -> Result<UpdateManifest, String> {
    if !raw.is_object() {
        return Err("not_an_object".into());
    }
    // 🔴 An unknown `manifest_version` is refused rather than best-effort read.
    // This is the one place where a CLOSED set is right, and it is worth being
    // explicit about why, given how loudly `kind` above argues the opposite:
    // `manifest_version` exists precisely to say「the meaning of these fields has
    // changed」. Guessing at a v2 body would be reading fields whose semantics we
    // have been told, in the payload itself, that we do not know. `kind` is a
    // value WITHIN a contract we understand; `manifest_version` IS the contract.
    if raw.get("manifest_version").and_then(Value::as_u64) != Some(1) {
        return Err("unsupported_manifest_version".into());
    }
    // Display-only — see the header for why a blank one is not fatal here.
    let generated_at = as_str(raw, "generated_at").unwrap_or_default().to_string();

    let Some(platforms_obj) = raw.get("platforms").and_then(Value::as_object) else {
        return Err("missing_platforms".into());
    };
    // An empty map is the most dangerous kind of「valid」: it reads as「no
    // platform has an update」, which is not something we know. What we know is
    // that this manifest has no content. (Same sentence as the TS validator's.)
    if platforms_obj.is_empty() {
        return Err("empty_platforms".into());
    }

    let mut platforms = BTreeMap::new();
    for (key, p) in platforms_obj {
        let Some(version) = as_str(p, "version").and_then(Version::parse) else {
            return Err(format!("bad_version:{key}"));
        };
        // Absent and `null` both mean「no notes page」. A present non-string, or a
        // string that is not an http(s) URL, is a broken manifest rather than an
        // absent field — we would put that value in front of the user as a link.
        let notes_url = match p.get("notes_url") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if is_http_url(s) => Some(s.clone()),
            Some(_) => return Err(format!("bad_notes_url:{key}")),
        };
        let Some(arr) = p.get("artifacts").and_then(Value::as_array) else {
            return Err(format!("empty_artifacts:{key}"));
        };
        if arr.is_empty() {
            return Err(format!("empty_artifacts:{key}"));
        }

        let mut artifacts = Vec::with_capacity(arr.len());
        for a in arr {
            let kind = match as_str(a, "kind") {
                Some(k) if !k.trim().is_empty() => k.to_string(),
                _ => return Err(format!("bad_kind:{key}")),
            };
            let locale = match a.get("locale") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => Some(s.clone()),
                Some(_) => return Err(format!("bad_locale:{key}")),
            };
            let filename = match as_str(a, "filename") {
                Some(f) if !f.trim().is_empty() => f.to_string(),
                _ => return Err(format!("bad_filename:{key}")),
            };
            // 🔴 This name becomes a path under our downloads directory. Both
            // separators are refused on every platform, not just the host's:
            // the manifest is written on one machine and read on others, and a
            // Windows client that only refused `\` would happily accept `a/b`.
            if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
                return Err(format!("unsafe_filename:{key}"));
            }
            let sha256 = match as_str(a, "sha256") {
                Some(h) if is_sha256_hex(h) => h.to_string(),
                _ => return Err(format!("bad_sha256:{key}:{filename}")),
            };
            let url = match as_str(a, "url") {
                Some(u) if is_http_url(u) => u.to_string(),
                _ => return Err(format!("bad_url:{key}:{filename}")),
            };
            // `as_u64` alone already excludes negatives and non-integers (serde
            // parses `-1` as i64 and `1.5` as f64, and both return None here),
            // so the only extra thing to refuse is a declared size of zero.
            let size = match a.get("size").and_then(Value::as_u64) {
                Some(n) if n > 0 => n,
                _ => return Err(format!("bad_size:{key}:{filename}")),
            };
            artifacts.push(UpdateArtifact { kind, locale, filename, url, sha256, size });
        }
        platforms.insert(key.clone(), UpdatePlatform { version, notes_url, artifacts });
    }
    Ok(UpdateManifest { generated_at, platforms })
}

#[cfg(test)]
#[path = "manifest_tests.rs"]
mod tests;
