// NR-138, MAIN extension 2026-10-01 — "is this relay shutting down?", one process-wide fact.
// *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.10 item 4 and its "MAIN extension" paragraph
//   docs/decisions/2026-10-01-owner-engine-failure-no-charge.md ("MAIN 扩展")
//
// WRITTEN ONCE, by the first action of the one shutdown sequence (`makeShutdownSequence` in `../shutdown.ts`), which
// SIGTERM, SIGINT and the fatal-error guard all reach through the same memoized close (`index.ts` `closeOnce`).
// READ by `SttSessionBridge.dispose()` (`stt-session.ts`): a session torn down while it is set was cut off by the relay
// itself, and settles with the `relay_shutdown` fact.
//
// ⚠️ WHY A MODULE-LEVEL FLAG AND NOT A DEPENDENCY. The relay shutting down is a property of the PROCESS, and the
// sessions it cuts reach their teardown along four different call chains (the handler's `disconnect` branch for an
// unpaired session, `audioRegistry.stopAll()` for a paired one, a grace timer, a supersede). Threading a dependency
// through each of them is how one gets missed; one flag that every teardown reads cannot be. It is never reset in
// production: a relay that started shutting down does not come back.

let shuttingDown = false;

/** The shutdown sequence has begun. Idempotent. */
export function markRelayShuttingDown(): void {
  shuttingDown = true;
}

export function relayIsShuttingDown(): boolean {
  return shuttingDown;
}

/** Tests only: a test file that ran a shutdown sequence puts the process back. */
export function resetRelayLifecycleForTests(): void {
  shuttingDown = false;
}
