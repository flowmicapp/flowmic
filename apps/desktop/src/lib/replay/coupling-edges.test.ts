// WP-R3.5 — the SIX cross-FSM coupling edges (11 §1: single-point FSM tests can't
// catch these). Each edge is a deterministic replay (JSONL trace round-trips) over
// a World that binds the REAL desktop FSMs — CapsuleVisibility (07 §4 visibility
// FSM) + SpeakingWatchdog (07 §3 SPEAKING latch) — plus the auth/session/delivery
// glue the desktop event layer wires between them. The World's `dispatch` IS the
// coupling contract under test; the FSM transitions it calls are production code.
//
// Edge catalogue (proposal for supervisor ruling — see the WP-R3.5 report):
//   CE-1  AUTH expiry drains PAIRING + SESSION (the canonical 11 §1 example)
//   CE-2  link drop mid-utterance → SPEAKING latch never wedges (6s watchdog)
//   CE-3  room/session-key change → visibility resets to persistent + latch disarm
//   CE-4  Dismiss 3s suppression vs audio:start surface race (F-2359 ↔ F-2375)
//   CE-5  utterance settle vs manual_pending — INV-4 (manual_pending is NOT settled)
//   CE-6  delivery:'none' record-only → PC never surfaces / never arms the latch
// CE-1 (server drain half) + CE-6 (server fan-out half) also have REAL-server
// coverage in apps/server-core/test/coupling-replay.test.ts.

import { describe, it, expect } from 'vitest';
import { CapsuleVisibility } from '../capsule-visibility';
import { SpeakingWatchdog } from '../speaking-watchdog';
import { replay, toJsonl, fromJsonl, type Trace, type World } from './harness';

/** The desktop coupling World: real FSMs + the cross-FSM wiring the event layer
 *  performs (auth:expired → drain; audio:start fan-out → arm+surface unless the
 *  server suppressed it for record-only; terminal → settle+disarm). */
class DesktopWorld implements World {
  vis = new CapsuleVisibility();
  watchdog = new SpeakingWatchdog();
  authValid = false;
  sessionActive = false;
  latchTripped = false;
  private lastArg: Record<string, unknown> = {};

  readonly checks: Record<string, () => boolean> = {
    'session.drained': () => !this.sessionActive,
    'pairing.dropped': () => !this.authValid,
    'latch.armed': () => this.watchdog.isArmed(),
    'latch.disarmed': () => !this.watchdog.isArmed(),
    'latch.tripped': () => this.latchTripped,
    'vis.persistent': () => this.vis.mode === 'persistent',
    'vis.talk': () => this.vis.mode === 'talk_triggered',
    'vis.visible': () => this.vis.visible,
    'vis.hidden': () => !this.vis.visible,
  };

  dispatch(signal: string, arg: unknown, now: number): void {
    const a = (arg ?? {}) as Record<string, unknown>;
    this.lastArg = a;
    switch (signal) {
      case 'connect':
        // A CONNECTION bridge edge — real visibility FSM decides reset-vs-keep.
        this.authValid = true;
        this.sessionActive = true;
        this.vis.onConnection(true, (a.room as string) ?? null);
        break;
      case 'auth-expired':
        // CE-1 coupling: auth loss DRAINS pairing + session, resets the capsule to
        // a clean persistent+hidden baseline (room→null) and DISARMS the latch so a
        // half-open utterance cannot wedge past the identity it belonged to.
        this.authValid = false;
        this.sessionActive = false;
        this.vis.onConnection(false, null);
        this.watchdog.stop();
        break;
      case 'audio-start':
        // CE-6 coupling: the server fans audio:start to the PC ONLY for a
        // deliverable utterance (audio.handler: fannedOut = delivery !== 'none').
        // Record-only never reaches the desktop → no surface, no latch arm.
        if (a.delivery !== 'none') {
          this.watchdog.start(now);
          this.vis.onAudioStart(now);
        }
        break;
      case 'signal': // stt:interim / stt:level / stt:final — a sustaining heartbeat
        this.watchdog.signal(now);
        break;
      case 'inject-result':
        // A settled terminal (injected|cached|inject_failed — INV-4): retreat + disarm.
        this.vis.onSettled();
        this.watchdog.stop();
        break;
      case 'settle-manual-pending':
        // INV-4: manual_pending is NOT a settle — visibility must NOT retreat and
        // the latch stays as-is (the utterance is still in flight for the user).
        break;
      case 'dismiss':
        this.vis.onDismiss(now);
        break;
      case 'tray-summon':
        this.vis.onTraySummon();
        break;
    }
  }

  tick(now: number): void {
    // Poll the SPEAKING latch watchdog (real FSM). A trip force-clears the latch
    // (morph reset) — the anti-wedge backstop (07 §3 "SPEAKING never wedges").
    if (this.watchdog.check(now)) this.latchTripped = true;
  }
}

/** Replay a trace; also assert the JSONL round-trip is deterministic (same digest
 *  from the parsed-from-disk trace as from the in-memory one — content-addressed). */
function runDeterministic(trace: Trace): ReturnType<typeof replay> {
  const r1 = replay(trace, new DesktopWorld());
  const r2 = replay(fromJsonl(toJsonl(trace)), new DesktopWorld());
  expect(r2.digest).toBe(r1.digest);
  return r1;
}

describe('WP-R3.5 cross-FSM coupling-edge replay (real desktop FSMs)', () => {
  it('CE-1: AUTH expiry drains PAIRING + SESSION and cannot leave a wedged latch', () => {
    const trace: Trace = [
      { kind: 'signal', name: 'connect', arg: { room: 'room-A' } },
      { kind: 'signal', name: 'audio-start', arg: { delivery: 'inject' } },
      { kind: 'signal', name: 'signal' }, // an interim arrives — latch armed & live
      { kind: 'fsm-edge', edge: 'CE-1.pre', expect: 'latch.armed' },
      { kind: 'signal', name: 'auth-expired' },
      // The coupling: one auth:expired drains BOTH adjacent FSMs at once.
      { kind: 'fsm-edge', edge: 'CE-1.session', expect: 'session.drained' },
      { kind: 'fsm-edge', edge: 'CE-1.pairing', expect: 'pairing.dropped' },
      { kind: 'fsm-edge', edge: 'CE-1.latch', expect: 'latch.disarmed' },
      { kind: 'assert', label: 'vis.persistent' },
      { kind: 'assert', label: 'vis.hidden' },
    ];
    const r = runDeterministic(trace);
    expect(r.edges.map((e) => e.edge)).toEqual(['CE-1.pre', 'CE-1.session', 'CE-1.pairing', 'CE-1.latch']);
  });

  it('CE-2: link drop mid-utterance → SPEAKING latch trips at ~6s (never wedges)', () => {
    const trace: Trace = [
      { kind: 'signal', name: 'connect', arg: { room: 'room-A' } },
      { kind: 'signal', name: 'audio-start', arg: { delivery: 'inject' } },
      { kind: 'signal', name: 'signal' }, // last real signal at t=0
      { kind: 'advance', ms: 5960 }, // just shy of the 6s deadline
      { kind: 'assert', label: 'latch.armed' }, // still armed — not yet tripped
      { kind: 'advance', ms: 60 }, // cross 6000ms
      // Timed edge: the anti-wedge watchdog must have tripped within 6000±50ms.
      { kind: 'fsm-edge', edge: 'CE-2.watchdog', expect: 'latch.tripped', deadlineMs: 6000 },
      { kind: 'fsm-edge', edge: 'CE-2.disarmed', expect: 'latch.disarmed' },
    ];
    const r = runDeterministic(trace);
    const wd = r.edges.find((e) => e.edge === 'CE-2.watchdog');
    expect(wd?.withinTolerance).toBe(true);
    expect(r.firstTrue['latch.tripped']).toBe(6020); // deterministic virtual time, within ±50 of 6000
  });

  it('CE-2b: a level heartbeat keeps the latch alive past 6s (no false trip)', () => {
    const trace: Trace = [
      { kind: 'signal', name: 'audio-start', arg: { delivery: 'inject' } },
      { kind: 'advance', ms: 4000 },
      { kind: 'signal', name: 'signal' }, // heartbeat refreshes the deadline at t=4000
      { kind: 'advance', ms: 4000 }, // t=8000, but only 4000 since the last signal
      { kind: 'assert', label: 'latch.armed' }, // still alive — heartbeat kept it
    ];
    const r = runDeterministic(trace);
    expect(r.firstTrue['latch.tripped']).toBeNull();
  });

  it('CE-3: room/session-key change resets visibility to persistent + surfaced', () => {
    const trace: Trace = [
      { kind: 'signal', name: 'connect', arg: { room: 'room-A' } },
      { kind: 'signal', name: 'dismiss' }, // → talk_triggered + hidden
      { kind: 'assert', label: 'vis.talk' },
      { kind: 'signal', name: 'connect', arg: { room: 'room-B' } }, // NEW session key
      // The coupling: a new roomUuid wipes the stale talk_triggered intent.
      { kind: 'fsm-edge', edge: 'CE-3.reset', expect: 'vis.persistent' },
      { kind: 'fsm-edge', edge: 'CE-3.surface', expect: 'vis.visible' },
    ];
    const r = runDeterministic(trace);
    expect(r.edges.map((e) => e.edge)).toContain('CE-3.reset');
  });

  it('CE-4: audio:start OUTRANKS the Dismiss suppression (owner 2026-07-27)', () => {
    // This edge used to assert the opposite — inside the 3 s window an
    // audio:start did NOT re-pop (F-2359 beat F-2375). owner overruled it:
    // 「按下说话按钮后…要强制显示」("after the speak button is pressed…it must be force-shown"). The window was there to swallow a TRAILING
    // event; a fresh press is the user speaking, and a PC that is silently
    // typing someone's words with no capsule up is the state to avoid.
    const trace: Trace = [
      { kind: 'signal', name: 'connect', arg: { room: 'room-A' } },
      { kind: 'signal', name: 'dismiss' },
      { kind: 'advance', ms: 1000 }, // still well inside the old 3 s window
      { kind: 'signal', name: 'audio-start', arg: { delivery: 'inject' } },
      { kind: 'fsm-edge', edge: 'CE-4.forced', expect: 'vis.visible' },
    ];
    const r = runDeterministic(trace);
    expect(r.edges.map((e) => e.edge)).toEqual(['CE-4.forced']);
  });

  it('CE-5: manual_pending is NOT a settle (INV-4) — capsule holds until a real settle', () => {
    const trace: Trace = [
      { kind: 'signal', name: 'connect', arg: { room: 'room-A' } },
      { kind: 'signal', name: 'dismiss' }, // talk_triggered
      { kind: 'advance', ms: 3100 }, // clear the suppression window
      { kind: 'signal', name: 'audio-start', arg: { delivery: 'inject' } }, // surfaces for the utterance
      { kind: 'assert', label: 'vis.visible' },
      { kind: 'signal', name: 'settle-manual-pending' }, // NOT a settle (INV-4)
      { kind: 'fsm-edge', edge: 'CE-5.holds', expect: 'vis.visible' }, // still up
      { kind: 'signal', name: 'inject-result' }, // a real terminal settles it
      { kind: 'fsm-edge', edge: 'CE-5.retreats', expect: 'vis.hidden' },
    ];
    const r = runDeterministic(trace);
    expect(r.edges.map((e) => e.edge)).toEqual(['CE-5.holds', 'CE-5.retreats']);
  });

  it('CE-6: delivery:none record-only never surfaces the PC capsule / arms the latch', () => {
    const trace: Trace = [
      { kind: 'signal', name: 'connect', arg: { room: 'room-A' } },
      { kind: 'signal', name: 'dismiss' }, // hide to tray so a surface would be observable
      { kind: 'advance', ms: 3100 },
      { kind: 'signal', name: 'audio-start', arg: { delivery: 'none' } }, // record-only
      // The coupling (server suppresses fan-out): the desktop stays hidden + idle.
      { kind: 'fsm-edge', edge: 'CE-6.no-surface', expect: 'vis.hidden' },
      { kind: 'fsm-edge', edge: 'CE-6.no-latch', expect: 'latch.disarmed' },
    ];
    const r = runDeterministic(trace);
    expect(r.firstTrue['latch.armed']).toBeNull(); // never armed for a record-only utterance
  });
});
