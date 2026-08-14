// The host Node runtime the sidecar runs ON: which executable to use, and whether
// it is new enough to be used at all. Split out of io.rs when that file hit the
// 800-line cap (io_tests.rs precedent); io.rs still owns spawn/handshake/probe/kill.
//
// WHY THIS IS A MODULE AND NOT THREE LINES (2026-08-03):
//   The MSI does NOT ship a Node — only the portable bundle does (publish.mjs
//   copies node.exe beside FlowMic.exe). So an installed copy runs against
//   whatever Node the host happens to have, and「whatever the host has」turned
//   out to be a real product surface: on a second machine the device page showed
//   「本地服务启动失败」("local service failed to start") / child exited (code 1)」 while the cloud relay worked
//   fine, because the cloud channel never touches this child.
//
// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §5 (Node probe: PATH→Program Files→LOCALAPPDATA)

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::forensic;

#[cfg(windows)]
use crate::sidecar::io::CREATE_NO_WINDOW;

/// Put the host Node's verdict in FRONT of whatever the child said, when — and
/// only when — that Node is too old to run the sidecar at all.
///
/// This runs on the failure path only, so the extra `node -p` costs nothing that
/// matters. It exists because the child's own stderr, honest as it is, names a
/// symptom the user cannot act on: `No such built-in module: node:sqlite` does not
/// tell anybody to install a newer Node or switch to the portable bundle. The rule
/// it serves is R11 — a status has to answer 「凭什么这么说」("what grounds are there to say so"), and here the answer
/// is a version number we can go and read.
pub fn annotate_node_version(node_exe: &str, tail: String) -> String {
    let Some(version) = probe_node_version(node_exe) else { return tail };
    if node_version_ok(&version) {
        return tail;
    }
    format!(
        "host Node v{version} at `{node_exe}` is too old — the local service needs \
         Node ≥ {}.{} (node:sqlite), or use the portable bundle which carries its own. \
         Child said: {tail}",
        MIN_NODE.0, MIN_NODE.1,
    )
}

/// Find the Node runtime we shipped, given the directory the exe lives in.
///
/// Two layouts, because the two installers place resources differently and both
/// are ours: the PORTABLE bundle puts `node.exe` beside `FlowMic.exe`, while the
/// MSI puts every declared Tauri resource under `<install>\resources\`. Missing
/// the second one would mean shipping 83 MB of Node in the installer and then
/// walking straight past it to the host's — the same bug with a bigger download.
///
/// Split out of `resolve_node_exe` so it can be tested against a fabricated
/// directory: the thing worth asserting is「我们找不找得到自己带的那一份」
/// ("whether we can find the copy we bundled ourselves"), and
/// that question cannot be asked of a function that only ever looks at the real
/// `current_exe()`.
/// MAC-03 — the file name the staged runtime carries on THIS platform.
///
/// 🔴 This is the Rust half of a name that is declared once in
/// `scripts/vendor/bundled-node.mjs` (`stagedNodeFileName()`), which writes the
/// file. Rust cannot import that module, so the two are pinned together by
/// `the_bundled_runtime_name_matches_the_pin_declaration` below instead of by
/// hope. Until MAC-03 macOS staged a Mach-O under the name `node.exe`: it ran, so
/// nothing objected, which is exactly how it survived to become a trap for the
/// signing pass.
pub const BUNDLED_NODE_NAME: &str = if cfg!(windows) { "node.exe" } else { "node" };

/// Find the Node runtime we shipped, given the directory the exe lives in.
///
/// Layouts, because each installer places resources differently and all are ours:
///   • PORTABLE (all platforms): the runtime sits beside the executable.
///   • MSI (Windows): every declared Tauri resource lands in `<install>\resources\`.
///   • macOS `.app`: the executable is in `Contents/MacOS/`, and Tauri puts the
///     declared resources in `Contents/Resources/resources/` — i.e. **not**
///     under the exe's directory at all, but a sibling of it.
///
/// 🔴 That last one is measured, not assumed [measured 2026-08-07, Mac mini]: the
/// 0.2.55 bundle really contains
/// `FlowMic.app/Contents/Resources/resources/node.exe` while the binary is at
/// `FlowMic.app/Contents/MacOS/flowmic-desktop`. None of the three original
/// candidates could reach across that boundary, so on macOS this function
/// returned `None` for a bundle that was carrying a perfectly good 113 MB Node
/// — ship the runtime, then walk straight past it. That is the same defect
/// CLAUDE.md records for the MSI (「少一行就会带着 83MB 的 Node 然后径直走过去
/// 用宿主的」, "skip one line and it'll carry 83MB of Node and then walk
/// straight past it to use the host's"), reproduced on a second platform, and it is worse here: a
/// GUI-launched `.app` gets a minimal PATH, so there is usually no host Node to
/// fall back TO.
///
/// Split out of `resolve_node_exe` so it can be tested against a fabricated
/// directory: the thing worth asserting is「我们找不找得到自己带的那一份」
/// ("whether we can find the copy we bundled ourselves"), and
/// that question cannot be asked of a function that only ever looks at the real
/// `current_exe()`.
pub fn bundled_node_beside(dir: &Path) -> Option<PathBuf> {
    let name = BUNDLED_NODE_NAME;
    let mut candidates = vec![
        dir.join(name),
        dir.join("runtime").join(name),
        dir.join("resources").join(name),
    ];
    if cfg!(target_os = "macos") {
        // `Contents/MacOS/..` → `Contents/`, then the bundle's Resources dir.
        candidates.push(dir.join("..").join("Resources").join("resources").join(name));
        candidates.push(dir.join("..").join("Resources").join(name));
    }
    candidates.into_iter().find(|c| c.is_file())
}

/// The oldest host Node the sidecar can actually run on, as `(major, minor)`.
///
/// It is `node:sqlite` that sets this floor, not taste: `db/connection.ts` does a
/// top-level `require('node:sqlite')`, and that builtin was behind
/// `--experimental-sqlite` until **v22.13.0** (and v23.4.0 on the 23 line) —
/// nodejs.org/docs/latest-v22.x/api/sqlite.html, "SQLite is no longer behind
/// --experimental-sqlite". On anything older the sidecar throws before it opens a
/// socket and exits 1.
const MIN_NODE: (u32, u32) = (22, 13);

/// Parse `major.minor` out of a `process.versions.node` string (`"22.22.3"`).
fn parse_node_version(v: &str) -> Option<(u32, u32)> {
    let v = v.trim().trim_start_matches('v');
    let mut it = v.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    Some((major, minor))
}

/// Is this `major.minor` new enough to load `node:sqlite` unflagged? The 23 line
/// got the backport one minor later (23.4), so a bare `>= (22,13)` compare would
/// wave through 23.0–23.3, which cannot run the sidecar.
pub fn node_version_ok(v: &str) -> bool {
    match parse_node_version(v) {
        Some((23, minor)) => minor >= 4,
        Some((major, minor)) => (major, minor) >= MIN_NODE,
        None => false,
    }
}

/// Ask a candidate what version it is. `None` when it is not runnable at all
/// (missing from PATH, blocked, not actually Node).
pub fn probe_node_version(exe: &str) -> Option<String> {
    let mut cmd = Command::new(exe);
    cmd.arg("-p").arg("process.versions.node").stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// Locate a usable `node` executable (07 §5: PATH → Program Files → LOCALAPPDATA).
///
/// The candidates are not merely *found*, they are **asked their version**, and the
/// first one new enough for `MIN_NODE` wins. Ordering alone cannot get this right:
/// a machine can have a current Node on PATH and an ancient one in Program Files
/// (or the reverse), and whichever we pick blind is a coin flip that shows up as
/// 「本地服务启动失败」("local service failed to start") / child exited (code 1)」. The previous code took the first
/// well-known path that existed and left PATH for last — while the comment above it
/// claimed the opposite ("Prefer PATH"), which is the anti-façade ④ (反-façade ④) shape: a comment
/// asserting behaviour that the code under it contradicts. Asking beats ordering,
/// so neither order is load-bearing any more.
///
/// Cost is at most a couple of `node -p` spawns (~30 ms each, CREATE_NO_WINDOW) at
/// bring-up, and none at all for the portable bundle.
pub fn resolve_node_exe() -> String {
    #[cfg(windows)]
    {
        // owner 2026-07-27 (one-click-run edition, 一键运行版): a PORTABLE bundle ships its own node.exe
        // beside the app, and it must win over anything the host happens to have
        // installed — the whole point of that bundle is that it runs on a machine
        // with no Node at all, and running against a stranger's Node version is
        // how a "portable" build stops being self-contained. Checked first, and
        // only when the file is actually there, so an installed (MSI) copy with
        // no sibling node.exe behaves exactly as before. Not version-probed: we
        // chose it at publish time, and demoting our own runtime in favour of a
        // stranger's would defeat the bundle.
        if let Ok(exe) = std::env::current_exe() {
            if let Some(cand) = exe.parent().and_then(bundled_node_beside) {
                forensic::record("sidecar", &format!("node: bundled runtime at {}", cand.display()));
                return cand.to_string_lossy().into_owned();
            }
        }
        // PATH first (it is what a developer or a `winget install` leaves behind),
        // then the well-known install locations — but see the doc comment: the
        // pick is decided by the answers below, not by this order.
        let mut candidates: Vec<String> = vec!["node".to_string()];
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Ok(pf) = std::env::var(var) {
                let p = PathBuf::from(pf).join("nodejs").join("node.exe");
                if p.is_file() {
                    candidates.push(p.to_string_lossy().into_owned());
                }
            }
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            for p in [
                PathBuf::from(&local).join("Programs").join("nodejs").join("node.exe"),
                // fnm / volta shims commonly live here too.
                PathBuf::from(&local).join("fnm_multishells").join("node.exe"),
            ] {
                if p.is_file() {
                    candidates.push(p.to_string_lossy().into_owned());
                }
            }
        }
        candidates.dedup();

        let mut first_answering: Option<(String, String)> = None;
        for cand in candidates {
            let Some(version) = probe_node_version(&cand) else { continue };
            if node_version_ok(&version) {
                forensic::record("sidecar", &format!("node: picked {cand} (v{version})"));
                return cand;
            }
            forensic::record(
                "sidecar",
                &format!("node: {cand} is v{version} — too old (needs ≥ {}.{})", MIN_NODE.0, MIN_NODE.1),
            );
            first_answering.get_or_insert((cand, version));
        }
        // Nothing new enough. Hand back the oldest-but-real one anyway rather than
        // refusing here: letting it spawn produces the child's own stderr, which
        // now reaches the device page (HandshakeOutcome::Exited carries it), and a
        // real error message beats a synthesised one. `spawn_and_await_handshake`
        // prefixes the version verdict so the card names the actual fix.
        if let Some((cand, version)) = first_answering {
            forensic::record("sidecar", &format!("node: NO usable runtime; falling back to {cand} (v{version})"));
            return cand;
        }
        // Nothing answered at all → let the spawn syscall fail into SpawnFailed,
        // which already says「node missing」in a way the card can show.
        "node".to_string()
    }
    #[cfg(not(windows))]
    {
        // 🔴 In-place correction (原地更正, MAC-03, 2026-08-07) — this whole
        // branch used to be `"node".to_string()`,
        // a single string constant. **Kept as-is in the fallback below**,
        // because as the answer for 「running from a terminal on a dev
        // machine」("开发机上从终端跑") it was always correct; what was wrong
        // was that at the time it was the **only** answer.
        //
        // Two things make it not hold on the macOS product:
        //   ① the `.app` **carries** a copy of Node (before MAC-03 it was even
        //      named `node.exe`), and this branch
        //      **never went looking for it** ⇒ carrying it was the same as not
        //      carrying it;
        //   ② a GUI process launched from Finder/Dock gets a **minimal PATH**
        //      (it does not go through the user's
        //      shell rc), and `/usr/local/bin` and `/opt/homebrew/bin` are
        //      usually not in it
        //      ⇒ a bare `node` will most likely **not resolve at all**.
        // Put together: the Windows half has a real fallback of 「host Node as
        // a backstop」, macOS essentially does not
        // ⇒ **on mac, 「finding the bundled copy」is not an optimization, it is
        // the only path that actually works.**
        if let Ok(exe) = std::env::current_exe() {
            if let Some(cand) = exe.parent().and_then(bundled_node_beside) {
                forensic::record("sidecar", &format!("node: bundled runtime at {}", cand.display()));
                return cand.to_string_lossy().into_owned();
            }
        }
        // No bundled copy (a dev tree, or a build that failed to stage one). Ask
        // the same question the Windows branch asks — 「你是哪个版本」("which
        // version are you") rather than
        // 「你排第几」("what's your rank in the order") — over PATH plus the two locations a GUI process's minimal
        // PATH omits. Same rule, same reason: ordering alone is a coin flip.
        let mut first_answering: Option<(String, String)> = None;
        for cand in ["node", "/usr/local/bin/node", "/opt/homebrew/bin/node"] {
            let Some(version) = probe_node_version(cand) else { continue };
            if node_version_ok(&version) {
                forensic::record("sidecar", &format!("node: picked {cand} (v{version})"));
                return cand.to_string();
            }
            forensic::record(
                "sidecar",
                &format!("node: {cand} is v{version} — too old (needs ≥ {}.{})", MIN_NODE.0, MIN_NODE.1),
            );
            first_answering.get_or_insert((cand.to_string(), version));
        }
        if let Some((cand, version)) = first_answering {
            forensic::record("sidecar", &format!("node: NO usable runtime; falling back to {cand} (v{version})"));
            return cand;
        }
        // Nothing answered at all → let the spawn syscall fail into SpawnFailed,
        // which already says「node missing」in a way the card can show. This is the
        // original one-line body, kept as the last resort it was always right to be.
        "node".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The host-Node floor (2026-08-03). `db/connection.ts` requires `node:sqlite`
    /// at module top level, and that builtin was flag-gated until v22.13.0 —
    /// **and until v23.4.0 on the 23 line**, which is the whole reason this is not
    /// a one-line `>= (22, 13)` compare.
    #[test]
    fn node_version_gate_knows_the_two_backport_lines() {
        // Too old — every one of these exits 1 on `require('node:sqlite')`.
        for v in ["18.20.4", "20.11.0", "22.5.0", "22.12.1", "v22.12.1"] {
            assert!(!node_version_ok(v), "{v} must be refused");
        }
        // The 23 line got the backport one minor LATER than 22 did. A naive
        // `(major, minor) >= (22, 13)` waves 23.0–23.3 through, and they cannot
        // run the sidecar — this is the case that compare would get wrong.
        for v in ["23.0.0", "23.3.0"] {
            assert!(!node_version_ok(v), "{v} predates the 23-line backport (23.4)");
        }
        for v in ["22.13.0", "22.22.3", "23.4.0", "24.0.0", "v24.3.1"] {
            assert!(node_version_ok(v), "{v} must be accepted");
        }
        // Unparseable is refused, never optimistically accepted: guessing "new
        // enough" turns a nameable failure back into 「child exited (code 1)」.
        for v in ["", "node", "22", "vX.Y.Z"] {
            assert!(!node_version_ok(v), "{v:?} is not a version");
        }
    }

    /// The picked runtime must be able to run the sidecar — asserted against the
    /// real machine rather than a fixture, because the thing that broke was a
    /// property of the HOST, not of our logic.
    #[test]
    fn the_resolved_node_is_new_enough_to_run_the_sidecar() {
        let exe = resolve_node_exe();
        let Some(version) = probe_node_version(&exe) else {
            // No Node at all on this machine: resolve_node_exe hands back "node"
            // so the spawn fails into SpawnFailed, which is the honest path.
            assert_eq!(exe, "node");
            return;
        };
        assert!(
            node_version_ok(&version),
            "resolve_node_exe picked {exe} (v{version}), which cannot load node:sqlite"
        );
    }

    /// owner 2026-08-03 ruled the MSI carries its own Node. Tauri drops declared
    /// resources into `<install>\resources\`, NOT beside the exe — so if this
    /// lookup only knew the portable layout, the installer would ship 83 MB of
    /// runtime and then ignore it. Both shapes are asserted, plus the negative.
    ///
    /// MAC-03 adds the `.app` shape and switches the literal `node.exe` to
    /// `BUNDLED_NODE_NAME` — the hard-coded name was itself Windows-shaped, so on
    /// macOS this test asserted a filename the build no longer stages.
    #[test]
    fn both_installer_layouts_find_the_runtime_we_shipped() {
        let root = std::env::temp_dir().join(format!("fm-node-layout-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let name = BUNDLED_NODE_NAME;

        // Nothing staged ⇒ no bundled runtime (this is the MSI-before-the-ruling
        // and the dev-tree case; resolve_node_exe then goes hunting for a host).
        let bare = root.join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        assert_eq!(bundled_node_beside(&bare), None);

        // Portable: the runtime beside the app executable.
        let portable = root.join("portable");
        std::fs::create_dir_all(&portable).unwrap();
        std::fs::write(portable.join(name), b"stub").unwrap();
        assert_eq!(bundled_node_beside(&portable), Some(portable.join(name)));

        // MSI: under `resources\`, which is where tauri.conf.json's
        // `bundle.resources` entry lands.
        let msi = root.join("msi");
        std::fs::create_dir_all(msi.join("resources")).unwrap();
        std::fs::write(msi.join("resources").join(name), b"stub").unwrap();
        assert_eq!(bundled_node_beside(&msi), Some(msi.join("resources").join(name)));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// MAC-03 — the macOS `.app` layout, which is the one none of the three
    /// original candidates could reach.
    ///
    /// 🔴 The directory shape here is COPIED FROM A REAL BUNDLE, not imagined
    /// [measured 2026-08-07, Mac mini]: `FlowMic.app/Contents/MacOS/flowmic-desktop`
    /// with the runtime at `FlowMic.app/Contents/Resources/resources/`. The
    /// lookup is handed the exe's parent (`Contents/MacOS`), exactly as
    /// `resolve_node_exe` hands it `current_exe().parent()`, so the test asks the
    /// question production asks rather than a friendlier one.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_macos_app_bundle_layout_finds_the_runtime_we_shipped() {
        let root = std::env::temp_dir().join(format!("fm-node-app-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let contents = root.join("FlowMic.app").join("Contents");
        let macos_dir = contents.join("MacOS");
        let res_dir = contents.join("Resources").join("resources");
        std::fs::create_dir_all(&macos_dir).unwrap();
        std::fs::create_dir_all(&res_dir).unwrap();
        std::fs::write(macos_dir.join("flowmic-desktop"), b"stub-exe").unwrap();
        std::fs::write(res_dir.join(BUNDLED_NODE_NAME), b"stub").unwrap();

        let found = bundled_node_beside(&macos_dir).expect(
            "the .app layout must be found — otherwise the bundle carries ~113 MB of Node \
             and then reaches for a host Node that a GUI-launched .app usually cannot see",
        );
        assert!(found.is_file());
        // Compare canonically: the candidate is built with a `..` segment.
        assert_eq!(
            found.canonicalize().unwrap(),
            res_dir.join(BUNDLED_NODE_NAME).canonicalize().unwrap()
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 🔴 The Rust name and the JS declaration are two spellings of ONE fact, and
    /// nothing in the compiler relates them: `scripts/vendor/bundled-node.mjs`
    /// WRITES the staged file, this crate LOOKS FOR it. Drift means the build
    /// stages a runtime the app cannot find and then silently uses a host Node —
    /// which on macOS usually means no Node at all.
    ///
    /// So the declaration is read as data and asserted against, rather than
    /// duplicated in a comment saying「两边保持一致」("both sides stay in sync") (that comment would be a
    /// façade-④ claim about somebody else's file).
    #[test]
    fn the_bundled_runtime_name_matches_the_pin_declaration() {
        let decl = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("scripts")
            .join("vendor")
            .join("bundled-node.mjs");
        let text = std::fs::read_to_string(&decl)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", decl.display()));

        // The key this platform would look itself up by, matching hostPlatformKey().
        let key = format!("{}-{}", os_key(), arch_key());
        let Some(entry) = text.split(&format!("'{key}'")).nth(1) else {
            panic!(
                "no bundled-Node pin for '{key}' in {} — build-sidecar.mjs refuses to build here, \
                 so this crate must not pretend it knows what name to look for",
                decl.display()
            );
        };
        let staged = entry
            .split("stagedPath:")
            .nth(1)
            .and_then(|s| s.split('\'').nth(1))
            .expect("the pin entry must declare a stagedPath");
        let declared_name = staged.rsplit('/').next().unwrap();
        assert_eq!(
            declared_name, BUNDLED_NODE_NAME,
            "bundled-node.mjs stages '{declared_name}' for {key} but this crate looks for \
             '{BUNDLED_NODE_NAME}' — the build would ship a runtime the app walks past"
        );
    }

    /// Rust and Node spell the same platform differently, on BOTH halves of the
    /// key — Rust says `windows`/`macos`/`aarch64`/`x86_64`, Node says
    /// `win32`/`darwin`/`arm64`/`x64`. One translation, here.
    ///
    /// 🔴 Worth the words: the first version of this helper translated only the
    /// ARCH half and left `std::env::consts::OS` alone, so it built the key
    /// `windows-x64` — which is in no declaration — and the test above failed
    /// with 「no bundled-Node pin for 'windows-x64'」 on a machine whose pin was
    /// present and correct. The test was right to fail and the criterion was
    /// wrong, which is the cheap direction for this mistake to run: had the
    /// lookup been lenient (e.g. "no entry ⇒ skip"), a genuinely missing pin
    /// would have been reported as a pass. Check your ruler first (先核你的尺子).
    #[cfg(test)]
    fn os_key() -> &'static str {
        match std::env::consts::OS {
            "windows" => "win32",
            "macos" => "darwin",
            other => other, // "linux" is spelled the same on both sides.
        }
    }

    #[cfg(test)]
    fn arch_key() -> &'static str {
        match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            other => other,
        }
    }

    /// The annotation must fire ONLY when the runtime really is too old — a
    /// version banner bolted onto every failure would be the same 「过期的真话」
    /// ("a stale truth") shape this whole change is undoing.
    #[test]
    fn the_version_banner_stays_off_when_the_runtime_is_fine() {
        let exe = resolve_node_exe();
        let Some(version) = probe_node_version(&exe) else { return };
        if !node_version_ok(&version) {
            return; // can't assert the negative on a machine that IS too old
        }
        let tail = "EACCES: permission denied";
        assert_eq!(
            annotate_node_version(&exe, tail.to_string()),
            tail,
            "a usable Node must not have its version blamed for an unrelated failure"
        );
        // …and an executable that is not Node at all must not be guessed about.
        assert_eq!(
            annotate_node_version("definitely-not-a-real-binary-xyz", tail.to_string()),
            tail
        );
    }
}
