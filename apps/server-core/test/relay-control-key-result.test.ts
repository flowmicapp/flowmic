// Card MP-14 — the relay leg of `control:key-result`.
//
// Until this card `control:key` was one-way: the far end took a keypress and
// answered nothing, so 「this end cannot press that key」 could only be said by
// staying quiet. These cases pin the four decisions the routing was built on,
// and each one is a way the feature could be wired to look right and be wrong:
//
//   ① it is routed with `inject:result`'s rule — scoped by ROOM, fanned out to
//      EVERY mobile in it, never addressed by an id off the frame;
//   ② only the room's PC-role socket may author one. A phone that emits this
//      event must not have its "receipt" mirrored back into the room, because
//      then the answer to 「did the computer refuse this」 would have two authors;
//   ③ a malformed receipt is dropped and logged, never forwarded half-read —
//      the same posture every other mirrored frame takes;
//   ④ 🔴 when the far end is missing the relay leaves a BREADCRUMB and does not
//      invent a receipt. This is the one that looks like a missing feature: the
//      receipt carries no author field (by design — it has no error code), so a
//      relay-authored refusal would reach the phone wearing the computer's face.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.5 + F-3116.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { registerRelayHandlers } from '../src/socket/handlers/relay.handler';
import type { RoomStore } from '../src/room/store';
import type { AuthContext } from '../src/auth/middleware';
import { log } from '../src/log';

const ROOM = 'room-mp14';

interface Emitted { event: string; payload: unknown }

interface FakeSocket {
  id: string;
  data: { auth: AuthContext | null; roomUuid: string | null };
  on(event: string, fn: (payload: unknown) => void): void;
  fire(event: string, payload: unknown): void;
  emits: Emitted[];
  emit(event: string, payload: unknown): void;
}

function fakeSocket(id: string, kind: 'pc' | 'mobile'): FakeSocket {
  const handlers = new Map<string, (payload: unknown) => void>();
  const emits: Emitted[] = [];
  return {
    id,
    data: { auth: { userId: 'u1', kind, deviceId: 'pc-device-1' } as AuthContext, roomUuid: ROOM },
    on(event, fn) { handlers.set(event, fn); },
    fire(event, payload) { handlers.get(event)?.(payload); },
    emits,
    emit(event, payload) { emits.push({ event, payload }); },
  };
}

/** Two phones in one room. Today the admission path allows exactly one (owner's
 *  2026-08-11 iron rule), and that is precisely why the fan-out is asserted with
 *  TWO: a `getMobiles(room)[0]` implementation would encode that invariant a
 *  second time, here, where nothing would ever report it broken. */
function harness(): { pc: FakeSocket; phones: FakeSocket[] } {
  const phones = [fakeSocket('m1', 'mobile'), fakeSocket('m2', 'mobile')];
  const pc = fakeSocket('pc1', 'pc');
  const store = {
    getPc: (room: string) => (room === ROOM ? (pc as unknown as Socket) : null),
    getMobiles: (room: string) => (room === ROOM ? (phones as unknown as Socket[]) : []),
  } as unknown as RoomStore<Socket>;
  registerRelayHandlers(pc as unknown as Socket, { store });
  for (const p of phones) registerRelayHandlers(p as unknown as Socket, { store });
  return { pc, phones };
}

describe('control:key-result — far end → the speaker', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {}); });
  afterEach(() => warnSpy.mockRestore());

  // ① — verbatim, including the correlation echo. A receipt that loses
  // `request_id` still arrives, but it settles the wrong press (or none), which
  // is the failure `duration_ms` taught this repo to assert for.
  it.each(['unsupported_here', 'uncertain'])('a %s receipt reaches every mobile in the room, verbatim', (reason) => {
    const { pc, phones } = harness();
    const frame = { request_id: 'k-17', kind: 'tab', ok: false, reason };
    pc.fire('control:key-result', frame);
    for (const phone of phones) {
      const got = phone.emits.filter((e) => e.event === 'control:key-result');
      expect(got).toHaveLength(1);
      expect(got[0]!.payload).toEqual(frame);
    }
  });

  // `ok:true` is on the wire and must cross it. A relay that forwarded only
  // failures would make 「no news」 mean both 「it worked」 and 「the receipt was
  // dropped」 — the two-facts-one-face shape this card exists to remove.
  it('a success receipt crosses too — silence must not be the success face', () => {
    const { pc, phones } = harness();
    pc.fire('control:key-result', { request_id: 'k-18', kind: 'enter', ok: true });
    expect(phones[0]!.emits.filter((e) => e.event === 'control:key-result')).toHaveLength(1);
  });

  // A press with no `request_id` (older phone, or an older relay upstream that
  // stripped it) still gets an answerable receipt — the client then matches on
  // kind + recency. The relay must NOT synthesise an id to make that tidy.
  it('forwards a receipt that carries no request_id, and invents none', () => {
    const { pc, phones } = harness();
    pc.fire('control:key-result', { kind: 'undo', ok: false, reason: 'no_target' });
    const got = phones[0]!.emits.find((e) => e.event === 'control:key-result');
    expect(got?.payload).toEqual({ kind: 'undo', ok: false, reason: 'no_target' });
  });

  // ③
  it('drops and logs a receipt whose reason is outside the enum', () => {
    const { pc, phones } = harness();
    pc.fire('control:key-result', { kind: 'tab', ok: false, reason: 'busy' });
    expect(phones[0]!.emits.some((e) => e.event === 'control:key-result')).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      'relay: dropped malformed frame',
      expect.objectContaining({ event: 'control:key-result' }),
    );
  });

  // ② — 🔴 the authorship guard. A phone cannot answer its own keypress.
  it('a mobile-role socket cannot author one', () => {
    const { phones } = harness();
    phones[0]!.fire('control:key-result', { kind: 'enter', ok: false, reason: 'failed' });
    for (const phone of phones) {
      expect(phone.emits.some((e) => e.event === 'control:key-result')).toBe(false);
    }
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('control:key-result on a socket with no auth/room'),
      expect.anything(),
    );
  });

  // ④ — 🔴 the relay may not speak for a far end it never reached.
  it('a keypress that finds no room leaves a breadcrumb and NO receipt', () => {
    const store = { getPc: () => null, getMobiles: () => [] } as unknown as RoomStore<Socket>;
    const phone = fakeSocket('m-roomless', 'mobile');
    phone.data.roomUuid = null; // reconnected, not yet rejoined
    registerRelayHandlers(phone as unknown as Socket, { store });
    phone.fire('control:key', { kind: 'enter', request_id: 'k-19' });
    // Nothing at all comes back: not a receipt, not anything wearing another
    // name. Saying 「the computer could not apply it」 about a computer that was
    // never consulted is the lie this asserts against.
    expect(phone.emits).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      'relay: control:key on a socket with no auth/room',
      expect.anything(),
    );
  });
});
