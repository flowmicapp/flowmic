// WP2 Card 1 — on-demand relay-node latency, read-only.
//
// The numbers live in `socket::node_probe_surface` so `cargo test --lib`
// covers the hot/cold split and the both-paths shape without the WebView
// toolchain. This file only binds that function to the cloud endpoint and
// the node this process is already dialing.
//
// 🔴 NO SELECTION. The command never writes `CURRENT_NODE`, never dials a
// socket, and never invents a URL. A control that changed nothing would be
// worse than no control.

use tauri::AppHandle;

use crate::forensic;
use crate::socket::node_probe_surface::{self, RelayLatencyDto, SurfaceHttp};

use super::{cloud, sidecar_ctl};

#[tauri::command(async)]
pub fn relay_latency_check(app: AppHandle) -> RelayLatencyDto {
    let endpoint = cloud::snapshot(&app).endpoint;
    let current = sidecar_ctl::current_node_id();
    let dto = match SurfaceHttp::new() {
        Some(http) => node_probe_surface::check_live(&http, &endpoint, current.as_deref()),
        None => RelayLatencyDto { nodes: Vec::new() },
    };
    forensic::record(
        "relay",
        &format!("latency check: {} node(s)", dto.nodes.len()),
    );
    dto
}
