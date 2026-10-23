// The auto-stop ending of a recording: the `audio:auto-stopped` frame, then the
// terminal flush, then settle. One caller: `stt-session.ts` `onAutoStopped`, a
// one-line wrapper that keeps the SAME name, so every [[onAutoStopped]] reference
// in the class comments still resolves.
//
// ⚠️ THE SPLIT FROM `stt-session.ts` WAS FORCED BY THE 800-LINE CAP
// (verify/lint/file-size.mjs SRC_MAX), not by an architectural claim — the bridge
// was at 782 lines and card INC-1f (design
// docs/strategy/2026-10-13-realtime-polish-while-speaking-design.md §6, §9) adds
// to it. Same reading as `stt-session-polish.ts` and `stt-session-refine.ts`.
//
// 🔴 WHAT MOVED AND WHAT CHANGED — every comment and statement below is
// byte-for-byte what it was inside `SttSessionBridge`, with these mechanical
// edits and no others:
//   (1) de-indented by two spaces (class member → module scope);
//   (2) `private async onAutoStopped(limitOrigin: unknown)` → `export async
//       function onAutoStopped(host: AutoStoppedHost, limitOrigin: unknown)`;
//   (3) `this.receipt` / `this.deps` / `this.orchestrator` / `this.outbox` /
//       `this.vad` → `host.` of the same name; `await this.pendingFinal` →
//       `await host.pendingFinal()` (a THUNK: the field is set inside the
//       terminal final handler, AFTER this function started waiting);
//       `this.settle()` → `host.settle()`.
// **Any other difference is a bug.**

import { log } from '../log';
import type { SttEngineOrchestrator } from '../stt/orchestrator-core';
import type { VadGate } from '../stt/vad-gate';
import { autoStopReasonFor, NAMEABLE_AUTO_STOP_ORIGINS } from './stt-session-autostop';
import type { SttSessionDeps } from './stt-session-deps';
import type { OrderedOutbox } from './stt-session-outbox';
import type { CoverageReceiptTally } from './stt-session-receipt';

/** ADDED BY THE SPLIT: what [[onAutoStopped]] used to read off `this`. */
export interface AutoStoppedHost {
  receipt: CoverageReceiptTally;
  deps: SttSessionDeps;
  orchestrator: SttEngineOrchestrator;
  /** Read AFTER `waitForTerminal()` — see edit (3) above. */
  pendingFinal: () => Promise<void> | null;
  outbox: OrderedOutbox;
  vad: VadGate;
  settle: () => void;
}

/**
 * 🔴 W8-4 — the recording ended without the user releasing the button, and the
 * frame that says so now carries WHY (see [[AUTO_STOP_REASON_BY_ORIGIN]]).
 *
 * THE EMIT STAYS FIRST, ahead of `waitForTerminal()`. `handleAutoStop` flushes
 * a TERMINAL `stt:final` right behind this frame, and the phone's FSM only
 * accepts a terminal final from PROCESSING — `audio:auto-stopped` is what moves
 * it there (`apps/mobile/lib/src/ptt/ptt_inbound.dart`, the `fsm.onPttUp()`
 * beside the `_autoStoppedCtl.add`). Ordering these the other way round would
 * get the final refused and strand the session in RECORDING, which is the exact
 * bug that comment records having already been fixed once.
 *
 * ⚠️ AN UNNAMEABLE ORIGIN EMITS NOTHING, and the cost of that is written down
 * rather than hidden: the phone releases RECORDING off THIS frame, so a
 * withheld frame leaves the FSM stuck and PTT dead until the app restarts.
 * That is a bad outcome and it is still the better one — the alternative is
 * telling the user a specific thing that is not true, which is the defect this
 * method exists to remove, and the closed `z.enum` has no value meaning 「stopped,
 * cause unknown」 to fall back to (`stt:error` cannot stand in either: the phone
 * acts on it only from PROCESSING). The branch is unreachable by construction —
 * `limitOrigin` is typed, total, and stamped by the single producer — so it is a
 * tripwire for OUR wiring breaking, not a product state. It is loud where an
 * operator looks, and it never lies to the user. Registered as a fork for the
 * supervisor rather than decided quietly here.
 */
export async function onAutoStopped(host: AutoStoppedHost, limitOrigin: unknown): Promise<void> {
  host.receipt.noteAutoStop(); // card CV-1 — BEFORE the terminal flush below, or the flag would describe the next recording
  const reason = autoStopReasonFor(limitOrigin);
  if (reason === null) {
    log.error('audio:auto-stopped WITHHELD — the auto-stop carried no nameable limit_origin', {
      user_id: host.deps.userId,
      limit_origin: typeof limitOrigin === 'string' ? limitOrigin : typeof limitOrigin,
      known_origins: NAMEABLE_AUTO_STOP_ORIGINS,
      consequence: 'the phone was told nothing and its FSM stays in RECORDING',
    });
  } else {
    host.deps.emitter.emit('audio:auto-stopped', { reason });
  }
  await host.orchestrator.waitForTerminal();
  // WP-R4-6: let an in-flight polished terminal-final finish emitting before we
  // bill + settle (billing is idempotent via `billed`; awaiting cannot double
  // it). null under `'detached'` / polish-off — nothing to wait for there.
  await host.pendingFinal();
  await host.outbox.drained(); // card SEG-1 — every held segment final is out before billing/settle
  host.vad.finish();
  host.settle();
}
