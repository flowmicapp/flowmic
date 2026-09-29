//! NR-117: reproduce the installed /usr/bin/node collision, including damage.
use super::node_runtime::{bundled_node_beside, linux_installed_resources};
use super::io::{bring_up, BringUpOptions};
use super::state::{FailReason, Phase};
use crate::ui_i18n::{self, Msg};

#[test]
fn linux_installed_runtime_ignores_host_node_and_reports_missing_payload() {
    let root = std::env::temp_dir().join(format!("nr117-runtime-{}", std::process::id()));
    let bin = root.join("usr/bin");
    let resources = root.join("usr/lib/FlowMic/resources");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&resources).unwrap();
    std::fs::write(bin.join("node"), b"host Node must never win").unwrap();
    std::fs::write(resources.join("node"), b"bundled Node").unwrap();
    std::fs::write(resources.join("server.js"), b"bundled server").unwrap();
    assert_eq!(linux_installed_resources(&bin), Some(resources.clone()));
    assert_eq!(bundled_node_beside(&bin), Some(resources.join("node")));

    // Even a broken install stays bound to its own runtime, never PATH.
    for missing in ["node", "server.js"] {
        std::fs::remove_file(resources.join(missing)).unwrap();
        let node = bundled_node_beside(&bin).unwrap();
        assert_eq!(node, resources.join("node"));
        let opts = BringUpOptions {
            node_exe: node.to_string_lossy().into_owned(),
            candidate_dirs: vec![resources.clone()],
            ..Default::default()
        };
        let up = bring_up(&opts);
        let expected = ui_i18n::tr_with(Msg::SidecarBundledFileMissing,
            &[("path", &resources.join(missing).to_string_lossy())]);
        assert_eq!(up.phase, Phase::Failed { reason: FailReason::SpawnFailed { detail: expected } });
        assert!(up.child.is_none());
        std::fs::write(resources.join(missing), b"restored").unwrap();
    }
    // The portable sibling contract is unchanged, even with a distro installed.
    let portable = root.join("portable");
    std::fs::create_dir_all(&portable).unwrap();
    std::fs::write(portable.join("node"), b"portable Node").unwrap();
    assert_eq!(linux_installed_resources(&portable), None);
    assert_eq!(bundled_node_beside(&portable), Some(portable.join("node")));
    std::fs::remove_dir_all(root).unwrap();
}
