// SPEC-REF:
//   docs/decisions/2026-07-27-owner-0.2.0-request-batch.md requirement ⑥ (overall transcription latency)
//   docs/strategy/R7-V2-TASK-CARDS.md V2-05 (clock design)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §3.2 (on-screen latency timer +
//     a reproducible benchmark script), §3.4 (the external promise "LAN ≤300ms, reproducible")
//
// THE RULER THAT WAS NEVER BUILT.
//
// Requirement ⑥ opened with owner saying latency "feels kind of long", and the audit found the
// real problem underneath: there is no end-to-end measurement anywhere in this
// repo. `stt-session.ts`'s `durationMs` is AUDIO LENGTH, not latency. Meanwhile
// master-plan §3.4 already promises "LAN ≤300ms, reproducible" to the outside world.
// The promise was made and the ruler was never built — this module is the ruler.
//
// ── Why every timestamp here is taken on ONE clock ──────────────────────────
//
// The user-visible span is "release the button → text lands on the PC", which crosses a phone and a PC.
// The obvious implementation — timestamp on the phone, timestamp on the PC,
// subtract — is WRONG, and wrong in the way this repo has already been burned
// by: wall clocks on two devices do not agree, users move their system clock
// (requirement ③ pitfall 4 had to clamp negative ages to "just now" for exactly this reason), and
// subtracting across them manufactures precise-looking numbers that are lies.
// A fabricated measurement is worse than no measurement: it ends the
// investigation with a wrong answer instead of an open question.
//
// So this module measures ONLY on the server clock. It turns out that is nearly
// the whole chain, because all four boundaries are server-side events:
//
//   t0  audio:stop      received from the phone
//   t1  stt:final       emitted by the engine
//   t2  inject:request  received from the phone   (the phone is the emitter —
//                        this leg contains the phone's own round trip)
//   t3  inject:result   received from the PC      (contains the real injection)
//
// Segments = t1-t0 (STT), t2-t1 (phone turnaround), t3-t2 (inject). Same clock,
// so they are subtractable and they add up. What is NOT covered is the phone's
// own "release button → audio:stop uplink" head and the "inject:result → user sees it" tail;
// those need the PHONE clock and are measured separately on the phone, start and
// end both local. The difference between the two totals is reported as a
// remainder and deliberately NOT broken down further — breaking it down is
// precisely the cross-device subtraction that would start inventing numbers.
//
// ── Correlation ────────────────────────────────────────────────────────────
//
// t2/t3 carry `entry_id`. t0/t1 carry no utterance id (`stt:final`'s payload is
// confidence/language/segment_idx/duration_ms — 57 events are locked, and a new
// id field would be a protocol change this card is not allowed to make). They
// are therefore correlated BY ROOM: one phone speaks at a time in a room, so the
// pending audio leg is the one this room just finished.
//
// That assumption is stated, not hidden: if a second utterance's audio:stop
// lands before the first one's inject:request, the older pending leg is DROPPED
// and counted in `dropped`, never merged into the wrong utterance. An honest
// gap beats a plausible mis-attribution — mis-attributed provenance is the exact
// defect book 13 §3 D4 records.

import { log } from '../log.js';

/** How long a half-finished measurement may wait before it is abandoned. Longer
 *  than any plausible utterance turnaround, short enough that a stuck entry does
 *  not sit in memory for the life of the process. */
const PENDING_TTL_MS = 120_000;
/** Hard cap on rooms tracked concurrently. An observation layer must never be
 *  the thing that runs the server out of memory. */
const MAX_PENDING = 256;

interface PendingLeg {
  /** t0 — audio:stop received. */
  audioStopAt: number;
  /** t1 — stt:final emitted. null until the engine produces it. */
  sttFinalAt: number | null;
  /** t2 — inject:request received, keyed on by entry_id from here on. */
  injectRequestAt: number | null;
  entryId: string | null;
}

const pending = new Map<string, PendingLeg>();
/** entry_id → the leg it was promoted to at t2, so t3 can close it. */
const byEntry = new Map<string, PendingLeg>();
let dropped = 0;

/** Injectable so tests do not depend on the wall clock. */
export type Now = () => number;
const defaultNow: Now = () => Date.now();

function sweep(now: number): void {
  for (const [room, leg] of pending) {
    if (now - leg.audioStopAt > PENDING_TTL_MS) {
      pending.delete(room);
      if (leg.entryId !== null) byEntry.delete(leg.entryId);
      dropped += 1;
    }
  }
}

/** t0. A new utterance leg starts; any leg still pending for this room is
 *  abandoned rather than merged (see the correlation note above). */
export function markAudioStop(room: string, now: Now = defaultNow): void {
  const t = now();
  sweep(t);
  const stale = pending.get(room);
  if (stale !== undefined) {
    dropped += 1;
    if (stale.entryId !== null) byEntry.delete(stale.entryId);
  }
  if (pending.size >= MAX_PENDING && stale === undefined) {
    dropped += 1;
    return; // refuse to grow without bound; the miss is counted, not hidden
  }
  pending.set(room, { audioStopAt: t, sttFinalAt: null, injectRequestAt: null, entryId: null });
}

/** t1. */
export function markSttFinal(room: string, now: Now = defaultNow): void {
  const leg = pending.get(room);
  // Soft-segment finals arrive before audio:stop; only the leg opened by an
  // audio:stop is timed, and only its FIRST final counts.
  if (leg === undefined || leg.sttFinalAt !== null) return;
  leg.sttFinalAt = now();
}

/** t2. From here the leg is addressed by entry_id, which the PC echoes back. */
export function markInjectRequest(room: string, entryId: string | null, now: Now = defaultNow): void {
  const leg = pending.get(room);
  if (leg === undefined || leg.injectRequestAt !== null) return;
  leg.injectRequestAt = now();
  if (entryId !== null && entryId !== '') {
    leg.entryId = entryId;
    byEntry.set(entryId, leg);
  }
}

/** t3 — closes the measurement and emits the one log line the analysis script
 *  reads. Anything incomplete is reported with the missing segments as null,
 *  never as zero: a zero would read as "this segment took no time at all", which is a lie.
 *
 *  ⚠️ SCOPE NOTE (D10 audit, 2026-08-05) — the sentence above is TRUE. The
 *  analysis script is `scripts/latency-report.mjs`: it greps `latency.segment`
 *  out of a server log and prints p50/p95 per segment. What is NOT true is that
 *  production can run it. The script reads a FILE, and log.ts only writes a file
 *  when `FLOWMIC_LOG_PATH` is set (log.ts:27). The only thing that sets it is the
 *  desktop sidecar (apps/desktop/src-tauri/src/sidecar/io.rs, symbol
 *  `spawn_and_await_handshake`). The VPS unit
 *  sets `StandardOutput=journal` and no `FLOWMIC_LOG_PATH` at all
 *  (the private deployment repo's systemd unit) — so on the relay these
 *  lines go to journald and the reader has no file to open. Reading them there
 *  means dumping journald to a file by hand first, which nothing documents and
 *  nothing schedules.
 *
 *  So: the metric has a reader on the DESKTOP leg and no reader on the
 *  PRODUCTION leg — and no alerting on either. That gap is card D10; full audit
 *  in docs/strategy/2026-08-05-d10-monitoring-and-alerting-cn.md §1.3.
 *
 *  ⚠️ Related gap, same audit: `dropped` below is published ONLY inside the line
 *  this SUCCESS path emits. If no utterance ever completes — precisely the
 *  incident the counter exists to describe — the count is never printed at all.
 *  See docs/strategy/2026-08-05-d10-monitoring-and-alerting-cn.md §4.2 ①-c. */
export function markInjectResult(room: string, entryId: string | null, now: Now = defaultNow): void {
  const t = now();
  const leg = (entryId !== null && entryId !== '' ? byEntry.get(entryId) : undefined) ?? pending.get(room);
  if (leg === undefined) return;

  pending.delete(room);
  if (leg.entryId !== null) byEntry.delete(leg.entryId);

  const stt = leg.sttFinalAt === null ? null : leg.sttFinalAt - leg.audioStopAt;
  const turnaround = leg.sttFinalAt === null || leg.injectRequestAt === null
    ? null
    : leg.injectRequestAt - leg.sttFinalAt;
  const inject = leg.injectRequestAt === null ? null : t - leg.injectRequestAt;

  log.info('latency.segment', {
    entry_id: leg.entryId,
    // ms, server clock, all four boundaries local. See the header for why no
    // phone timestamp appears anywhere in this line.
    stt_ms: stt,
    phone_turnaround_ms: turnaround,
    inject_ms: inject,
    server_total_ms: t - leg.audioStopAt,
    dropped_so_far: dropped,
  });
}

/** Test seam: reset module state between cases. */
export function __resetLatencyState(): void {
  pending.clear();
  byEntry.clear();
  dropped = 0;
}

/** Test seam: how many legs were abandoned rather than mis-attributed. */
export function __droppedCount(): number {
  return dropped;
}
