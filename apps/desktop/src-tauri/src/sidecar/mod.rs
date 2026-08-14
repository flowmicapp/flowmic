// SPEC-REF: docs/rebuild/07-DESKTOP-SPEC.md §5 (Sidecar standalone self-hosted service).
//
// The self-hosted sidecar: a pure lifecycle + port-remediation FSM (state), the
// std-only spawn/probe/kill IO that drives it (io), and the LAN-IP decision core
// for the pairing endpoint (network). This module is tauri-free so `cargo test`
// and `cargo run --example sidecar_spawn` exercise it without WebView2; the app
// shell (lib.rs, `app` feature) supplies the MSI resource-dir resolve candidate
// and wires the terminal endpoint into `socket::connect`.

/// The adopt-vs-reclaim policy for a listener already on :41879, including the
/// build-identity check that keeps a stale orphan from another build from being
/// adopted (owner 2026-07-27).
pub mod adopt;
pub mod io;
pub mod job;
pub mod network;
/// Which host Node to run `server.js` on, and whether it is new enough to run it
/// at all (`node:sqlite` sets a hard floor). The MSI ships no Node of its own.
pub mod node_runtime;
/// Which TCP port the local server is on, and `FLOWMIC_SIDECAR_PORT` — the named
/// way to move it. Its own module because a silent fallback to the fixed port is
/// what puts two copies on one port, and `portclear` below is what happens next.
pub mod port;
pub mod portclear;
pub mod state;

pub use io::{
    bring_up, sidecar_port, BringUp, BringUpOptions, ProbeVerdict, SIDECAR_HOST,
    SIDECAR_PORT_DEFAULT,
};
pub use state::{Action, Event, FailReason, Phase, SidecarMachine};
