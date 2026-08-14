// D4 layer 3 — a failing last_seen_at write must not crash the beat.
//
// heartbeat.handler.ts writes the DB on EVERY beat (5 s per client) with —
// before this card — zero error handling, and socket.io dispatches handlers
// in a bare process.nextTick (no try/catch): a full disk turned every beat
// into an uncaughtException, i.e. a whole-relay crash loop with all online
// users dropped together.
//
// Degraded contract pinned here, honestly:
//   · no throw escapes the handler;
//   · the failure is LOUD in the log, rate-gated with a suppressed count
//     (reduced line volume, never hidden event volume);
//   · the ack stays `ok:true` (the mobile's probeLink reads `ok` as 「can a
//     delivery go out on this socket right now」 — it can: delivery is
//     in-memory RoomStore relay, not this column) but `last_seen_at` is null
//     — the stamp did NOT land, and echoing `when` would report undone as
//     done (red line, both directions);
//   · nothing latches: the next successful write stamps again.
//
// REVERSE CONTROL (run and watched red, then restored): strip the try/catch
// in heartbeat.handler.ts back to the bare `deps.pcs.touchLastSeen(...)` ⇒
// the first two cases below die red with `SQLITE_FULL` escaping the handler.

import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { RateGate } from '../src/error-handling';
import {
  HEARTBEAT_WRITE_FAILURE_LOG_WINDOW_MS,
  registerHeartbeatHandler,
} from '../src/socket/handlers/heartbeat.handler';
import type { AuthContext } from '../src/auth/middleware';
import type { PcRepo } from '../src/db/repos/pc.repo';
import type { MobileRepo } from '../src/db/repos/mobile.repo';

/** Just enough socket for the handler: on() captures, invoke() drives + acks. */
class FakeSocket {
  private readonly handlers = new Map<string, ((payload: unknown, ack: unknown) => void)[]>();
  constructor(
    readonly id: string,
    public data: { auth: AuthContext | null } = { auth: null },
  ) {}

  on(event: string, fn: (payload: unknown, ack: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }

  /** Drives the event SYNCHRONOUSLY — a handler throw escapes to the caller,
   *  which is exactly what the reverse control needs to see. */
  invoke(event: string, payload: unknown): Record<string, unknown> {
    let acked: Record<string, unknown> = { __no_ack: true };
    for (const fn of this.handlers.get(event) ?? []) {
      fn(payload, (r: unknown) => { acked = (r ?? {}) as Record<string, unknown>; });
    }
    return acked;
  }
}

interface LogLine {
  msg: string;
  fields: Record<string, unknown>;
}

function capture(): { logger: { error(msg: string, fields?: Record<string, unknown>): void }; lines: LogLine[] } {
  const lines: LogLine[] = [];
  return { lines, logger: { error: (msg, fields): void => { lines.push({ msg, fields: fields ?? {} }); } } };
}

const T = new Date('2026-08-04T09:00:00.000Z');
const PC_AUTH: AuthContext = { userId: 'default', deviceId: 'pc-1', kind: 'pc' } as AuthContext;
const MOBILE_AUTH: AuthContext = { userId: 'default', deviceId: 'pc-1', pairingId: 'pairing-1', kind: 'mobile' } as AuthContext;

function failingRepos(err: () => Error): { pcs: PcRepo; mobiles: MobileRepo; calls: { pc: number; mobile: number } } {
  const calls = { pc: 0, mobile: 0 };
  return {
    calls,
    pcs: { touchLastSeen: (): void => { calls.pc += 1; throw err(); } } as unknown as PcRepo,
    mobiles: { touchLastSeen: (): void => { calls.mobile += 1; throw err(); } } as unknown as MobileRepo,
  };
}

function wire(opts: {
  auth: AuthContext;
  pcs: PcRepo;
  mobiles: MobileRepo;
  gate?: RateGate;
}): { sock: FakeSocket; lines: LogLine[] } {
  const sock = new FakeSocket('s-hb', { auth: opts.auth });
  const { logger, lines } = capture();
  registerHeartbeatHandler(sock as unknown as Socket, {
    pcs: opts.pcs,
    mobiles: opts.mobiles,
    now: () => T,
    logger,
    writeFailureGate: opts.gate ?? new RateGate(0),
  });
  return { sock, lines };
}

describe('D4 — heartbeat survives a failing DB write', () => {
  it('PC beat: SQLITE_FULL does not escape; honest degraded ack {ok:true,last_seen_at:null}; loud log', () => {
    const repos = failingRepos(() => new Error('SQLITE_FULL: database or disk is full'));
    const { sock, lines } = wire({ auth: PC_AUTH, pcs: repos.pcs, mobiles: repos.mobiles });

    let ackResult: Record<string, unknown> | null = null;
    // The load-bearing assertion: before the fix this invoke() THROWS.
    expect(() => { ackResult = sock.invoke('heartbeat', { ts: 1 }); }).not.toThrow();

    expect(repos.calls.pc).toBe(1); // the write was attempted, not skipped
    // ok answers the link (true — relay still works); last_seen_at answers the
    // stamp (null — it did NOT land). Never {ok:true,last_seen_at:when}: that
    // would report undone as done.
    expect(ackResult).toEqual({ ok: true, last_seen_at: null });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.msg).toContain('last_seen_at write failed');
    expect(lines[0]!.fields.kind).toBe('pc');
    expect(lines[0]!.fields.error).toContain('SQLITE_FULL');
  });

  it('mobile beat: same containment on the pairing branch', () => {
    const repos = failingRepos(() => new Error('disk I/O error'));
    const { sock, lines } = wire({ auth: MOBILE_AUTH, pcs: repos.pcs, mobiles: repos.mobiles });

    let ackResult: Record<string, unknown> | null = null;
    expect(() => { ackResult = sock.invoke('heartbeat', { ts: 2 }); }).not.toThrow();

    expect(repos.calls.mobile).toBe(1);
    expect(ackResult).toEqual({ ok: true, last_seen_at: null });
    expect(lines[0]!.fields.kind).toBe('mobile');
  });

  it('a dead disk does not flood the log: one line per window, suppressed count on the next', () => {
    let t = 0;
    const gate = new RateGate(HEARTBEAT_WRITE_FAILURE_LOG_WINDOW_MS, () => t);
    const repos = failingRepos(() => new Error('SQLITE_FULL'));
    const { sock, lines } = wire({ auth: PC_AUTH, pcs: repos.pcs, mobiles: repos.mobiles, gate });

    // Six beats inside one 30 s window (≈ what one client produces): one line.
    for (let i = 0; i < 6; i += 1) sock.invoke('heartbeat', { ts: i });
    expect(repos.calls.pc).toBe(6); // every beat still TRIED (no silent latch-off)
    expect(lines).toHaveLength(1);

    // The next window's line says how many it stood for — never silent forever.
    t += HEARTBEAT_WRITE_FAILURE_LOG_WINDOW_MS;
    sock.invoke('heartbeat', { ts: 99 });
    expect(lines).toHaveLength(2);
    expect(lines[1]!.fields.suppressedSinceLastLine).toBe(5);
  });

  it('nothing latches: the write recovering resumes real stamping on the SAME registration', () => {
    let broken = true;
    const stamped: string[] = [];
    const pcs = {
      touchLastSeen: (_id: string, when: string): void => {
        if (broken) throw new Error('SQLITE_FULL');
        stamped.push(when);
      },
    } as unknown as PcRepo;
    const { sock } = wire({ auth: PC_AUTH, pcs, mobiles: failingRepos(() => new Error('unused')).mobiles });

    expect(sock.invoke('heartbeat', { ts: 1 })).toEqual({ ok: true, last_seen_at: null });
    broken = false; // disk freed
    expect(sock.invoke('heartbeat', { ts: 2 })).toEqual({ ok: true, last_seen_at: T.toISOString() });
    expect(stamped).toEqual([T.toISOString()]);
  });

  it('positive control — the healthy path is byte-identical to the frozen contract', () => {
    const stamped: [string, string][] = [];
    const pcs = { touchLastSeen: (id: string, when: string): void => { stamped.push([id, when]); } } as unknown as PcRepo;
    const { sock, lines } = wire({ auth: PC_AUTH, pcs, mobiles: {} as MobileRepo });

    expect(sock.invoke('heartbeat', { ts: 3 })).toEqual({ ok: true, last_seen_at: T.toISOString() });
    expect(stamped).toEqual([['pc-1', T.toISOString()]]);
    expect(lines).toHaveLength(0); // a healthy write logs nothing

    // …and the refusal branches are untouched (presence-liveness pins them too).
    const anon = new FakeSocket('s-anon');
    registerHeartbeatHandler(anon as unknown as Socket, { pcs, mobiles: {} as MobileRepo });
    expect(anon.invoke('heartbeat', { ts: 1 })).toEqual({ error: 'AUTH_TOKEN_INVALID' });
    expect(anon.invoke('heartbeat', { nope: true })).toEqual({ error: 'PAIR_INVALID_PAYLOAD' });
  });
});
