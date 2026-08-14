// SPEC-REF:
//   owner 2026-07-29:「退出PC端时要强制杀掉这个进程，增强健壮性」("When exiting on
//     the PC side, this process must be force-killed, to strengthen robustness")— the orphan
//     sidecar that outlived its desktop and then got ADOPTED by a newer build
//     is how a stale server.js ends up answering a newer phone. RunEvent::Exit
//     covers only the GRACEFUL quit; a force-kill / crash never runs it.
//   docs/rebuild/07-DESKTOP-SPEC.md §5 (adopt-first exists *because* orphans
//     happen — this module is the other half: stop producing them)
//
// The Windows Job Object backstop: the spawned sidecar child is assigned to a
// job configured with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so the OS terminates
// it the moment the desktop process dies — graceful exit, force-kill, or
// crash, with no Rust code having to run. `kill_child` (exit / retry) stays as
// the deliberate path; the job is the guarantee behind it.
//
// One slot, process-wide, mirroring `SidecarState.child` (at most one spawned
// sidecar exists at a time). Dropping a ChildJob closes its handle — which,
// under KILL_ON_JOB_CLOSE, also terminates any member still running. That is
// the intended fail-safe on replacement, never an accident: a job whose child
// was already reaped closes as a no-op.
//
// Non-Windows builds keep the same call sites compiling as no-ops; the
// graceful kill_child path is the only teardown there.

use std::sync::Mutex;

use crate::forensic;

/// The live job holding the current child. `None` before the first spawn and
/// after `clear`.
static CURRENT: Mutex<Option<ChildJob>> = Mutex::new(None);

/// Owns the job handle. Closing it (Drop) terminates any assigned process
/// that is still alive — see the module header.
struct ChildJob(JobHandle);

#[cfg(windows)]
type JobHandle = windows::Win32::Foundation::HANDLE;

#[cfg(not(target_os = "windows"))]
type JobHandle = ();

// The raw handle is only ever touched under CURRENT's mutex (and by Drop,
// which runs after the mutex hands ownership out), so the usual
// raw-handle-is-!Send rule is satisfied by construction.
unsafe impl Send for ChildJob {}
unsafe impl Sync for ChildJob {}

impl Drop for ChildJob {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
        // Non-Windows: `JobHandle` is `()` (see the alias above), so there is
        // nothing to close and Drop is genuinely empty.
        //
        // 🔴 W3 2026-08-07 — this used to be `let _ = self.0;`, which reads as
        // 「acknowledge the field」 but is a let-binding of a unit value:
        // clippy's `let_unit_value`, an ERROR under `verify:clippy`'s
        // `-D warnings` and invisible on Windows where this arm is compiled out.
        // Removed rather than silenced: a statement whose only effect is to look
        // like it does something is the smallest version of this repo's façade
        // shape. If `JobHandle` ever becomes a real handle off Windows, the
        // compiler will demand a real Drop body here.
    }
}

#[cfg(windows)]
fn bind(child_pid: u32) -> Result<ChildJob, String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_BASIC_LIMIT_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    unsafe {
        let job = match CreateJobObjectW(None, None) {
            Ok(j) => j,
            Err(e) => return Err(format!("CreateJobObject: {e}")),
        };
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                ..Default::default()
            },
            ..Default::default()
        };
        if let Err(e) = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &raw mut info as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) {
            let _ = CloseHandle(job);
            return Err(format!("SetInformationJobObject: {e}"));
        }
        // AssignProcessToJobObject requires SET_QUOTA | TERMINATE on the
        // process handle. Our own child always grants that.
        let proc = match OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, child_pid) {
            Ok(p) => p,
            Err(e) => {
                let _ = CloseHandle(job);
                return Err(format!("OpenProcess(pid={child_pid}): {e}"));
            }
        };
        let assigned = AssignProcessToJobObject(job, proc);
        let _ = CloseHandle(proc);
        if let Err(e) = assigned {
            let _ = CloseHandle(job);
            return Err(format!("AssignProcessToJobObject: {e}"));
        }
        Ok(ChildJob(job))
    }
}

#[cfg(not(target_os = "windows"))]
fn bind(_child_pid: u32) -> Result<ChildJob, String> {
    Ok(ChildJob(()))
}

/// Bind the just-spawned sidecar child to a kill-on-close job, replacing any
/// previous slot (a retry spawns a new child; the old job — its child already
/// reaped — closes as a no-op). A bind FAILURE is recorded, never fatal: the
/// graceful `kill_child` path still covers exit and retry, so a weakened
/// backstop must not take the bring-up down with it (no silent failure, and no
/// observation-layer failure may backfire onto the main flow).
pub fn guard_child(child_pid: u32) {
    match bind(child_pid) {
        Ok(job) => {
            *CURRENT.lock().unwrap_or_else(|p| p.into_inner()) = Some(job);
            forensic::record(
                "sidecar",
                &format!("job: pid={child_pid} bound to kill-on-close job (crash/force-kill backstop)"),
            );
        }
        Err(detail) => {
            forensic::record(
                "sidecar",
                &format!("job: kill-on-close bind FAILED for pid={child_pid}: {detail}"),
            );
        }
    }
}

/// Drop the slot (exit / retry kill). The child is already reaped by the
/// caller, so the close is a no-op — the job exists for the case where nobody
/// gets to run this.
pub fn clear() {
    let _ = CURRENT.lock().unwrap_or_else(|p| p.into_inner()).take();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_without_a_spawn_is_a_noop_and_repeatable() {
        clear();
        clear();
    }

    #[cfg(windows)]
    #[test]
    fn binding_a_nonexistent_pid_fails_loud_never_panics() {
        // PID 0 is the System Idle Process — OpenProcess refuses it, which is
        // exactly the error path a real bind failure must take: Err with a
        // named step, no panic, no half-created job leaked into CURRENT.
        assert!(bind(0).is_err());
    }
}
