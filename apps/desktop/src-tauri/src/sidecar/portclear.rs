// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §5 (sidecar bring-up: adopt probe → port clear)
//
// The :41879 port-clear helpers, split out of sidecar/io.rs for the 800-line cap.
// Behaviour is byte-for-byte what lived there — the ONE kill lead-controller
// ruling #1 step 2, and the post-kill verification that the port is genuinely
// free (a lingering handle would otherwise loop bring-up forever).
//
// v0.2.4: all three spawns here carry CREATE_NO_WINDOW. The node child had it
// since the portable was built; these did not, and each flashed its own console
// on the startup path (owner 2026-07-29:「启动时闪了 N 次黑屏」("flashed N black
// screens on startup")).

// Both of these are used only by the Windows arm of `clear_port` (the kill, its
// settle-sleep and its audit line), so they carry the same gate as `Command`
// right below — otherwise they are dead imports on every other target, which
// `-D warnings` treats as an error.
#[cfg(windows)]
use std::time::Duration;

#[cfg(windows)]
use std::process::Command;

#[cfg(windows)]
use crate::forensic;

/// Suppress the child's console window. Same constant as `io.rs` uses for the
/// node spawn; duplicated rather than re-exported so this module has no reason
/// to reach back into the one it was split out of.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── port clear (lead-controller ruling #1 step 2 — the SINGLE kill) ─────────────────────────

/// Locate the PID LISTENING on `:port` via `netstat -ano` (Windows). Returns the
/// first LISTENING owner's PID. `None` if none / non-Windows.
pub fn locate_listener_pid(port: u16) -> Option<u32> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW like the node spawn above. owner 2026-07-29:
        // 「启动时闪了 N 次黑屏」("flashed N black screens on startup") — the node child was suppressed back when the
        // portable was built, but these three helpers on the SAME bring-up path
        // never were, and each one flashes its own console. A censused fix:
        // every `Command::new` in this crate now carries the flag.
        let out = Command::new("netstat")
            .arg("-ano")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let needle = format!(":{port}");
        for line in text.lines() {
            let l = line.trim();
            if !l.contains(&needle) || !l.to_uppercase().contains("LISTENING") {
                continue;
            }
            // "  TCP    0.0.0.0:41879   0.0.0.0:0   LISTENING   1234"
            // ensure the local-address column (col 1) is the one bearing :port.
            let cols: Vec<&str> = l.split_whitespace().collect();
            if cols.len() >= 5 && cols[1].ends_with(&needle) {
                if let Ok(pid) = cols[cols.len() - 1].parse::<u32>() {
                    return Some(pid);
                }
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        let _ = port;
        None
    }
}

/// Best-effort process image name for a PID (`tasklist`), for the forensic record.
pub fn process_name(pid: u32) -> Option<String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        // "\"node.exe\",\"1234\",\"Console\",\"1\",\"12,345 K\""
        let first = text.lines().next()?.trim();
        let name = first.split('"').nth(1)?.to_string();
        if name.is_empty() || name.contains("No tasks") {
            None
        } else {
            Some(name)
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

/// Kill exactly the `:port` LISTENING owner — ONCE. The FSM guarantees this is
/// only ever called after an adopt probe returned `ForeignOrDead` and at most once
/// per bring-up. Forensic-records the PID + process name BEFORE the kill (lead-controller
/// ruling #1: forensic-record PID+process name before the kill (杀前 forensic 记录 PID+进程名)). `Ok(())` iff the listener is gone afterward.
pub fn clear_port(port: u16) -> Result<(), String> {
    // 🔴 MAC-D4 / W3 2026-08-07 — the Windows-only refusal moved UP HERE from the
    // middle of the function. It used to sit after the kill block as
    // `#[cfg(not(windows))] { return Err(…) }`, which made every following
    // statement unreachable on this target — clippy's `unreachable_statement`,
    // an ERROR under `verify:clippy`'s `-D warnings`, and invisible on Windows
    // where those statements do compile. Stating it as a PRECONDITION instead of
    // a mid-body return says the same thing and leaves no dead tail.
    //
    // ⚠️ The refusal itself is unchanged and still honest: there is no macOS
    // implementation of「杀掉占着这个端口的陌生进程」("kill the stranger process
    // occupying this port"). Writing one is card MAC-D4
    // (an `lsof`-based version); until then this fails BY NAME rather than
    // pretending the port was cleared. The cost is bounded and stated in the
    // breakdown §B: a stranger holding :41879 makes bring-up fail without
    // self-healing — our own orphans go through `adopt`, which is unaffected.
    // Tail-expression form (the same shape `locate_listener_pid` above already
    // uses): exactly one of these two blocks survives cfg, and it is then the
    // function's tail — so no `return` is needed, and `clippy::needless_return`
    // stays quiet.
    #[cfg(not(windows))]
    {
        let _ = port;
        Err("port clear is Windows-only".to_string())
    }
    #[cfg(windows)]
    {
    let pid = locate_listener_pid(port).ok_or_else(|| format!("no LISTENING pid on :{port}"))?;
    let name = process_name(pid).unwrap_or_else(|| "<unknown>".to_string());
    // The audited line: record WHO we are about to kill, before doing it.
    forensic::record(
        "sidecar",
        &format!("[KILL] clearing :{port} LISTENING owner pid={pid} name={name} (adopt probe said foreign)"),
    );
    use std::os::windows::process::CommandExt;
    let out = Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("taskkill spawn: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("taskkill /F /PID {pid} failed: {}", stderr.trim()));
    }
    // Verify the port is actually free now (a lingering handle would loop us).
    std::thread::sleep(Duration::from_millis(300));
    if locate_listener_pid(port).is_some() {
        return Err(format!("port :{port} still held after taskkill pid={pid}"));
    }
    forensic::record("sidecar", &format!("[KILL] :{port} cleared (killed pid={pid} {name})"));
    Ok(())
    }
}
