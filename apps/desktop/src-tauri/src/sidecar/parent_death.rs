//! NR-136: the desktop owns the write end of the child's stdin until teardown.
//! EOF covers Linux/macOS crashes; Linux also arms the kernel before exec.
use std::process::{Child, Command, Stdio};

pub fn spawn(mut cmd: Command) -> std::io::Result<Child> {
    #[cfg(target_os = "linux")]
    {
        // PDEATHSIG follows the spawning THREAD, not just the process. Tauri's
        // bring-up worker returns after the handshake. Keep the actual creator
        // alive until child exit; WNOWAIT leaves reaping to the Child owner.
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        std::thread::Builder::new().name("sidecar-parent".into()).spawn(move || {
            let result = cmd.spawn();
            let pid = result.as_ref().ok().map(Child::id);
            if let Err(send) = tx.send(result) {
                if let Ok(mut child) = send.0 { let _ = child.kill(); let _ = child.wait(); }
                return;
            }
            if let Some(pid) = pid {
                loop {
                    // SAFETY: valid zero-initialized output, own child PID.
                    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                    let result = unsafe { libc::waitid(libc::P_PID, pid, &mut info,
                        libc::WEXITED | libc::WNOWAIT) };
                    if result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) { break; }
                }
            }
        })?;
        rx.recv().map_err(|_| std::io::Error::other("sidecar spawn worker disconnected"))?
    }
    #[cfg(not(target_os = "linux"))]
    { cmd.spawn() }
}

pub fn configure(cmd: &mut Command) {
    // macOS uses pipe EOF as its crash backstop (no kqueue): the Child owns
    // the only persistent write end, and process death closes it even on SIGKILL.
    // Node's standalone watchdog exits on EOF before async boot can retain it.
    // sidecar-parent-death-test.py pipe-only proves survival then SIGKILL exit.
    cmd.env("FLOWMIC_DESKTOP_PID", std::process::id().to_string());
    // ChildStdin stays inside Child: do not take/drop it after the handshake.
    cmd.stdin(Stdio::piped()).env("FLOWMIC_PARENT_PIPE", "1");
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let parent = std::process::id() as libc::pid_t;
        // SAFETY: only async-signal-safe syscalls in the post-fork child.
        unsafe {
            cmd.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // Close the fork→prctl race: a dead parent cannot produce a child.
                if libc::getppid() != parent {
                    return Err(std::io::Error::from_raw_os_error(libc::ECHILD));
                }
                Ok(())
            });
        }
    }
}

pub fn description() -> &'static str {
    #[cfg(target_os = "linux")]
    { "Linux PDEATHSIG=SIGTERM + stdin EOF watchdog" }
    #[cfg(target_os = "macos")]
    { "macOS stdin EOF watchdog" }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    { "stdin EOF watchdog" }
}
