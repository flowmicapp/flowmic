// Cross-process proof for the single-instance identity (card W5R-HARDEN-3).
//
// ── WHY THIS EXISTS AND WHY A UNIT TEST WAS NOT ENOUGH ──────────────────────
//
// The hardening replaced an APPDATA-derived lock FILE with a named mutex,
// because redirecting `APPDATA` minted a second "first instance" and the
// adoption probe then reclaimed the sidecar port with `taskkill /F /PID` — i.e.
// it could kill a user's running app. The unit tests around `acquire_instance`
// run inside ONE process, so what they demonstrate is that a second *call*
// is refused. The thing that must actually hold is that a second *process* is
// refused, and no in-process test can observe that: the claim was INFERRED.
//
// The failure direction is what makes the gap unacceptable rather than untidy.
// If the mutex does not in fact exclude across processes, two instances start,
// both want port 41879, and the loser reclaims it by killing the winner — which
// is precisely the incident this work is meant to prevent. A wrong answer here
// is not a missing feature, it is the bug re-armed.
//
// ── USAGE ──────────────────────────────────────────────────────────────────
//
//     cargo run --example instance_probe -- <hold_secs>
//
// Reads the same env the app does (FLOWMIC_INSTANCE_TAG / FLOWMIC_SIDECAR_PORT),
// resolves the scope through the SAME production functions, prints one parseable
// line, and then holds the lock so a second process can be launched against it.
//
// 🔴 It deliberately calls `scope_from_env` + `acquire_instance` rather than
// re-implementing the acquisition. A probe that built its own mutex name would
// prove something about the probe.

use std::time::Duration;

fn main() {
    let hold_secs: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(6);

    let port = flowmic_desktop_lib::sidecar::port::sidecar_port_checked();
    let port = match port {
        Ok(p) => p,
        Err(e) => {
            println!("RESULT=PORT_ERROR detail={e}");
            std::process::exit(3);
        }
    };

    let scope = match flowmic_desktop_lib::single_instance::scope_from_env(port) {
        Ok(s) => s,
        Err(e) => {
            println!("RESULT=SCOPE_ERROR detail={e:?}");
            std::process::exit(4);
        }
    };

    match flowmic_desktop_lib::single_instance::acquire_instance(&scope) {
        Some(lock) => {
            println!(
                "RESULT=HELD pid={} port={} mutex={} detail={}",
                std::process::id(),
                port,
                scope.mutex_name,
                lock.describe()
            );
            // Hold it open. The whole point is to still be holding when the
            // second process runs.
            std::thread::sleep(Duration::from_secs(hold_secs));
            drop(lock);
            println!("RESULT=RELEASED pid={}", std::process::id());
        }
        None => {
            println!(
                "RESULT=REFUSED pid={} port={} mutex={}",
                std::process::id(),
                port,
                scope.mutex_name
            );
            std::process::exit(1);
        }
    }
}
