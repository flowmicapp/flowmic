// WP-R3.5 — relay parse-failure logging (legacy claim). A malformed mirror frame used
// to be a SILENT drop (13 §3 D1 — no silent failure). The hardening keeps the
// DROP (a bad frame never crosses the mirror) but now emits a forensic log.warn.
// This pins both halves: the frame is still not forwarded, AND the drop is logged
// with the offending event name — never the raw payload.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (mirror relay);
//           docs/strategy/R2-R3-TASK-CARDS.md WP-R3.5 (relay parse failure, add a log).

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Socket } from 'socket.io';
import { registerRelayHandlers } from '../src/socket/handlers/relay.handler';
import type { RoomStore } from '../src/room/store';
import type { AuthContext } from '../src/auth/middleware';
import { log } from '../src/log';

const ROOM = 'room-1';
/** The PC this fake phone's token binds it to. 0.2.33: an inject:request must
 *  name its destination (`target_pc_id`) or it is refused as
 *  INJECT_PC_UNSPECIFIED before it can ever be 「well-formed and forwarded」 —
 *  so a fixture about MALFORMED frames has to be correctly addressed, or every
 *  assertion below would be passing for the wrong reason. The refusal itself is
 *  pinned in relay-pc-target.test.ts, not here. */
const BOUND_PC = 'pc-device-1';

interface FakeSocket {
  id: string;
  data: { auth: AuthContext | null; roomUuid: string | null };
  on(event: string, fn: (payload: unknown) => void): void;
  fire(event: string, payload: unknown): void;
  /** 2026-07-29: a dropped frame is now ANSWERED (server-authored inject:result
   *  reject verdict — see inject-image-relay.test.ts for the dedicated pins);
   *  the fake needs somewhere for that answer to land. */
  emits: { event: string; payload: unknown }[];
  emit(event: string, payload: unknown): void;
}

function fakeSocket(id: string, kind: 'pc' | 'mobile'): FakeSocket {
  const handlers = new Map<string, (payload: unknown) => void>();
  const emits: { event: string; payload: unknown }[] = [];
  return {
    id,
    data: { auth: { userId: 'u1', kind, deviceId: BOUND_PC }, roomUuid: ROOM },
    on(event, fn) { handlers.set(event, fn); },
    fire(event, payload) { handlers.get(event)?.(payload); },
    emits,
    emit(event, payload) { emits.push({ event, payload }); },
  };
}

describe('relay drops malformed mirror frames — logged, never forwarded', () => {
  let pcEmits: { event: string; payload: unknown }[];
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let mobile: FakeSocket;

  beforeEach(() => {
    pcEmits = [];
    const pc = { id: 'pc', emit: (event: string, payload: unknown) => pcEmits.push({ event, payload }) };
    const store: RoomStore<Socket> = {
      getPc: (room: string) => (room === ROOM ? (pc as unknown as Socket) : null),
      getMobiles: () => [],
    } as unknown as RoomStore<Socket>;
    mobile = fakeSocket('m1', 'mobile');
    registerRelayHandlers(mobile as unknown as Socket, { store });
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
  });

  afterEach(() => warnSpy.mockRestore());

  it('a malformed inject:request is logged and NOT forwarded to the PC', () => {
    mobile.fire('inject:request', { text: 'hi', source: 'bogus-source' }); // source not in whitelist
    expect(pcEmits.some((e) => e.event === 'inject:request')).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const fields = warnSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fields.event).toBe('inject:request');
    // the raw payload text must NOT be in the log fields (may carry user content)
    expect(JSON.stringify(fields)).not.toContain('hi');
  });

  it('a malformed control:key is logged and NOT forwarded', () => {
    mobile.fire('control:key', { kind: 'escape' }); // kind outside the six-key whitelist
    expect(pcEmits.some((e) => e.event === 'control:key')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith('relay: dropped malformed frame', expect.objectContaining({ event: 'control:key' }));
  });

  it('a WELL-FORMED inject:request is forwarded and NOT logged', () => {
    mobile.fire('inject:request', { text: 'hello', source: 'stt', target_pc_id: BOUND_PC });
    expect(pcEmits.some((e) => e.event === 'inject:request')).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// 2026-07-30 (RCA-v3): the auth/room guard was the LAST silent drop on the
// relay path — and a REACHABLE one (a client-side reconnect flushes its send
// buffer BEFORE the app re-registers/rejoins, landing frames exactly there).
// These pin that the drop now ANSWERS (inject:request) or at least leaves a
// breadcrumb (control:key — it has no result event to answer with).
describe('relay answers frames arriving on a socket with no auth/room', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  function roomlessHarness(): { mobile: FakeSocket } {
    const store = {
      getPc: () => null,
      getMobiles: () => [],
    } as unknown as RoomStore<Socket>;
    const mobile = fakeSocket('m-roomless', 'mobile');
    mobile.data.roomUuid = null; // reconnected, not yet rejoined
    registerRelayHandlers(mobile as unknown as Socket, { store });
    return { mobile };
  }

  it('inject:request → answered INJECT_NOT_IN_ROOM with the correlation echo, and logged', () => {
    const { mobile } = roomlessHarness();
    mobile.fire('inject:request', { text: '', source: 'image', request_id: 'i9', entry_id: 'e9', image_b64: 'QUJD', image_mime: 'image/jpeg' });
    const answer = mobile.emits.find((e) => e.event === 'inject:result');
    expect(answer).toBeDefined();
    expect(answer!.payload).toMatchObject({ ok: false, error: 'INJECT_NOT_IN_ROOM', request_id: 'i9', entry_id: 'e9' });
    expect(warnSpy).toHaveBeenCalledWith('relay: inject:request on a socket with no auth/room', expect.objectContaining({ kind: 'mobile' }));
    // 0.2.27: what this used to assert — 「the row write-back must NOT be guessed
    // when there is no userId」 — is now structural (the relay holds no repo at
    // all). What still has to hold is asserted above: the VERDICT reached the
    // sender with BOTH correlation ids, because that echo is now the only way the
    // row's owner can move it off ⏳.
  });

  it('control:key → breadcrumb logged (no result event exists to answer with)', () => {
    const { mobile } = roomlessHarness();
    mobile.fire('control:key', { kind: 'enter' });
    expect(warnSpy).toHaveBeenCalledWith('relay: control:key on a socket with no auth/room', expect.anything());
    expect(mobile.emits).toHaveLength(0);
  });
});

// 2026-07-30: every parsed inject:result is offered to the http upload's
// pending bridge (a no-op when nobody waits — the socket path).
describe('relay feeds inject:result to the pending bridge', () => {
  it('resolves a waiting http upload with the PC\'s verdict', async () => {
    const { InjectPendingRegistry } = await import('../src/socket/inject-pending');
    const pending = new InjectPendingRegistry();
    const store = { getPc: () => null, getMobiles: () => [] } as unknown as RoomStore<Socket>;
    const pc = fakeSocket('pc-1', 'pc');
    registerRelayHandlers(pc as unknown as Socket, { store, pending });
    // RV-04: the claim is TAGGED — 'armed' is what licenses the route's emit.
    const attempt = pending.begin('i7', 1000);
    expect(attempt.kind).toBe('armed');
    if (attempt.kind !== 'armed') throw new Error('unreachable');
    pc.fire('inject:result', { ok: true, mode: 'clipboard', request_id: 'i7' });
    const got = await attempt.outcome;
    expect(got).toMatchObject({ kind: 'result', result: { ok: true, mode: 'clipboard', request_id: 'i7' } });
  });
});
