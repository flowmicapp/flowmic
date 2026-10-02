//! Reclaim only an orphaned listener running this resolved sidecar script.
//! Never infer ownership from a port number, an HTTP reply, or a Node name alone.
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Eq)]
struct Identity {
    parent: u32,
    owner: u32,
    birth: String,
    command: String,
    executable: String,
}

fn output(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

pub fn listener_pid(port: u16) -> Option<u32> {
    #[cfg(target_os = "linux")]
    let pids: Vec<u32> = output("ss", &["-H", "-ltnp", &format!("sport = :{port}")])?
        .split("pid=").skip(1)
        .filter_map(|s| s.split(',').next()?.parse().ok()).collect();
    #[cfg(not(target_os = "linux"))]
    let pids: Vec<u32> = output("lsof", &["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])?
        .lines().filter_map(|s| s.parse().ok()).collect();
    let first = *pids.first()?;
    (first > 1 && pids.iter().all(|pid| *pid == first)).then_some(first)
}

fn identity(pid: u32) -> Option<Identity> {
    let pid = pid.to_string();
    let parent = output("ps", &["-p", &pid, "-o", "ppid="])?.parse().ok()?;
    let birth = output("ps", &["-p", &pid, "-o", "lstart="])?;
    let command = output("ps", &["-ww", "-p", &pid, "-o", "command="])?;
    if birth.is_empty() || command.is_empty() { return None; }
    // New sidecars record their desktop owner; legacy sidecars use their current
    // parent. A session subreaper (systemd --user) is never a desktop owner.
    let environment = output("ps", &["eww", "-p", &pid, "-o", "command="])?;
    let owner = environment.split_whitespace()
        .find_map(|word| word.strip_prefix("FLOWMIC_DESKTOP_PID="))
        .map(str::parse).transpose().ok()?.unwrap_or(parent);
    let executable = if cfg!(target_os = "linux") {
        // /proc preserves argv boundaries: a script argument named after the
        // desktop must not turn an unrelated interpreter into a live owner.
        let argv = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        String::from_utf8(argv.split(|byte| *byte == 0).next()?.to_vec()).ok()?
    } else {
        output("ps", &["-ww", "-p", &pid, "-o", "comm="])?
    };
    Some(Identity { parent, owner, birth, command, executable })
}

fn matches_sidecar(id: &Identity, script: &Path, port: u16) -> bool {
    // This exact suffix includes every product spawn argument. The executable
    // prefix may contain spaces (e.g. macOS Application Support), but must be node.
    let suffix = format!(" {} --mode standalone --port {port}", script.display());
    let Some(exe) = id.command.strip_suffix(&suffix) else { return false; };
    exe == id.executable && Path::new(exe).file_name().is_some_and(|n| n == "node")
}

fn is_desktop(command: &str, executable: &str) -> bool {
    let name_matches = Path::new(executable).file_name().is_some_and(|name|
        name == "flowmic-desktop" || name == "FlowMic");
    name_matches && command.strip_prefix(executable)
        .is_some_and(|args| args.is_empty() || args.starts_with(' '))
}

fn stale_owner(id: &Identity) -> bool {
    identity(id.owner).is_none_or(|owner| !is_desktop(&owner.command, &owner.executable))
}

pub fn is_orphan_listener(port: u16, script: &Path) -> bool {
    listener_pid(port).and_then(identity).is_some_and(|id| matches_sidecar(&id, script, port) && stale_owner(&id))
}

pub fn clear(port: u16, script: &Path) -> Result<(), String> {
    let pid = listener_pid(port).ok_or_else(|| format!("no verifiable listener PID on :{port}"))?;
    #[cfg(target_os = "linux")]
    let pidfd = {
        use std::os::fd::{FromRawFd, OwnedFd};
        // Pin the process before inspecting it: a recycled PID cannot be killed.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        if fd < 0 { return Err(format!("pidfd_open pid={pid}: {}", std::io::Error::last_os_error())); }
        unsafe { OwnedFd::from_raw_fd(fd as i32) }
    };
    let id = identity(pid).ok_or_else(|| format!("cannot verify pid={pid}"))?;
    if !matches_sidecar(&id, script, port) || !stale_owner(&id) {
        return Err(format!("refusing to kill pid={pid}: not an orphan of this sidecar"));
    }
    // Recheck PID, birth, parent and full command immediately before signaling.
    if listener_pid(port) != Some(pid) || identity(pid).as_ref() != Some(&id) || !stale_owner(&id) {
        return Err(format!("listener identity changed on :{port}; refusing kill"));
    }
    crate::forensic::record("sidecar", &format!(
        "[KILL] stale orphan pid={pid} parent={} owner={} script={} port={port} command verified", id.parent, id.owner, script.display()));
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let result = unsafe { libc::syscall(libc::SYS_pidfd_send_signal, pidfd.as_raw_fd(),
            libc::SIGKILL, std::ptr::null::<libc::siginfo_t>(), 0) };
        if result != 0 { return Err(format!("signal pid={pid}: {}", std::io::Error::last_os_error())); }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let status = Command::new("kill").args(["-KILL", &pid.to_string()]).status()
            .map_err(|e| format!("kill pid={pid}: {e}"))?;
        if !status.success() { return Err(format!("kill pid={pid} failed")); }
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
        if Instant::now() >= deadline { return Err(format!(":{port} still listening after orphan cleanup")); }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_requires_orphan_exact_script_node_and_port() {
        let script = Path::new("/Applications/Flow Mic/resources/server.js");
        let mut id = Identity { parent: 1, owner: 1, birth: "birth".into(), executable: "/Applications/Flow Mic/resources/node".into(),
            command: format!("/Applications/Flow Mic/resources/node {} --mode standalone --port 41990", script.display()) };
        assert!(matches_sidecar(&id, script, 41990));
        assert!(!matches_sidecar(&id, script, 41879));
        assert!(!matches_sidecar(&id, Path::new("/other/server.js"), 41990));
        id.parent = 100;
        assert!(matches_sidecar(&id, script, 41990));
        assert!(stale_owner(&id)); // reaper identity does not determine ownership
        assert!(is_desktop("/opt/Flow Mic/flowmic-desktop", "/opt/Flow Mic/flowmic-desktop"));
        assert!(is_desktop("/Applications/FlowMic.app/Contents/MacOS/FlowMic --test", "/Applications/FlowMic.app/Contents/MacOS/FlowMic"));
        assert!(!is_desktop("/usr/bin/systemd --user", "/usr/bin/systemd"));
        assert!(!is_desktop("/usr/bin/python /tmp/flowmic-desktop", "/usr/bin/python"));
        assert!(!is_desktop("/usr/bin/flowmic-desktop-foreign", "/usr/bin/flowmic-desktop-foreign"));
        id.owner = std::process::id();
        assert!(stale_owner(&id)); // this unit-test executable is not the desktop
        id.parent = 1;
        id.command = id.command.replacen("resources/node", "resources/python", 1);
        assert!(!matches_sidecar(&id, script, 41990));
        id.command = format!("/usr/bin/python /tmp/node {} --mode standalone --port 41990", script.display());
        assert!(!matches_sidecar(&id, script, 41990)); // argument basename cannot impersonate Node
        id.command = format!("node {} --mode standalone --port 41990 --foreign", script.display());
        assert!(!matches_sidecar(&id, script, 41990));
    }
}
