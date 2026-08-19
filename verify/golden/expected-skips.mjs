// verify/golden/expected-skips.mjs
// The golden suite's DECLARED skip budget — data only, consumed by
// run-golden.mjs (same shape discipline as verify/lint/coordinate-anchors-
// baseline.mjs: a baseline the runner reads, never a module that runs).
//
// ── WHY A BUDGET EXISTS (2026-08-19, lane L4) ───────────────────────────────
// Until this date the runner's exit line was `FAIL > 0 ? 1 : 0`: SKIPPED was
// acceptable unconditionally, in any count, for any reason. So "the LAN engine
// is down" and "someone broke the reachability probe" printed the SAME green
// summary, while the right responses are opposite (wait vs go fix the probe).
// scripts/run-script-tests.mjs had already closed its own version of this hole
// (all-skipped ⇒ FAIL, and a skip without a printed reason ⇒ FAIL); golden had
// neither, and golden is where a silently-widening skip costs the most — each G
// is a named product promise.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
// A skip is fine iff it is DECLARED here: the G's id plus a regex its printed
// reason must match. An undeclared skip — a new G starting to skip, or a
// declared G skipping with a reason shaped differently than the one measured —
// FAILS the run, naming the case and what it was supposed to prove.
//
// WHAT THIS CANNOT TELL APART, stated so nobody reads more into it: a declared
// reason produced honestly ("engine unreachable" because the LAN is down) and
// the same words produced by a broken probe look identical here. The budget
// catches the skip SET and SHAPE drifting, not a lie inside a matching reason.
//
// ── SEEDED FROM MEASUREMENT, NOT ASSUMPTION ─────────────────────────────────
// Baseline run 2026-08-19 on the LAN box: PASS=20 SKIPPED=2 FAIL=0 (G2 "wire
// leg OK …; LAN vLLM errored mid-turn", G4 always). G3 passed here because the
// vLLM host answered its reachability probe, but its unreachable arm is the
// same owner-network dependency as G2's (declared in the runner's own header
// rules since WP-R3.5), so it is seeded alongside.
//
// ── REVERSE CONTROL (2026-08-19, LAN box, recorded verbatim) ────────────────
// With G4's entry below deleted, the same tree printed
//     UNDECLARED SKIP  G4  5min long audio (5-min long audio)
//        └─ reason: 5-min real-audio run is owner realenv; hard-limit auto-stop
//           path unit-tested (no headless 5-min fixture)
// and exited 1; the entry restored by hand, the run went back to exit 0 with
// both of that day's skips declared. So the budget can go red, and a declared
// skip still passes — both directions observed.

/** id: the G whose skip is expected; reason: a regex the PRINTED skip reason
 *  must match; why: what makes this skip genuinely environment-bound rather
 *  than a defect being tolerated. */
export const EXPECTED_SKIPS = [
  {
    id: 'G2',
    reason: /LAN model turn skipped — .* unreachable|LAN vLLM errored mid-turn/,
    why: 'the real translate/organize model turn needs the owner-network vLLM '
      + '(100.64.7.179) — off that network, or when the engine dies mid-turn, '
      + 'only the model leg is unproven; the wire leg has already run.',
  },
  {
    id: 'G3',
    reason: /LAN model turn skipped — .* unreachable/,
    why: 'same owner-network engine as G2; the organize wire leg (zero server '
      + 'injection) has already run when this skip is printed.',
  },
  {
    id: 'G4',
    reason: /^5-min real-audio run is owner realenv/,
    why: 'a 5-minute real-mic session cannot exist headless; the hard-limit '
      + 'auto-stop path is unit-tested. This G skips on EVERY machine today — '
      + 'it is the one unconditional entry, kept declared rather than special-'
      + 'cased so the day it grows a headless fixture this row must be deleted.',
  },
];
