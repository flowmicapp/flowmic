// R6 T-4 (image path) — the image inject:request really crosses the relay, and the
// transport ceiling really sits ABOVE the schema ceiling.
//
// Two independent things are pinned here, because between them lies the one way
// this feature could fail silently end-to-end:
//
//   1. relay.handler forwards `inject:request{source:'image', image_b64,
//      image_mime}` to the PC unchanged, and still DROPS a half-formed image
//      frame (the superRefine pairing) with a log rather than passing it on.
//   2. the socket.io engine's maxHttpBufferSize is larger than the protocol's
//      own `image_b64` cap. With socket.io's 1 MB default, a legal 5.5 MB
//      payload is destroyed by the ENGINE — the connection closes and no
//      handler, no zod schema and no error code is ever reached. The phone
//      would see a link drop with no reason: a silent failure by construction.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (inject:request, F-2350
//   image field-add); docs/strategy/R6-BACKLOG-AND-PLAN.md wave 2 T-4;
//   CLAUDE.md red line "no silent failure".

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Socket } from 'socket.io';
import { EVENT_SCHEMAS } from '@flowmic/protocol';
import { registerRelayHandlers } from '../src/socket/handlers/relay.handler';
import { MAX_HTTP_BUFFER_BYTES } from '../src/socket/server';
import type { RoomStore } from '../src/room/store';
import type { AuthContext } from '../src/auth/middleware';
import { log } from '../src/log';

const ROOM = 'room-1';
/** The PC this fake phone's token binds it to. 0.2.33: an inject:request with no
 *  `target_pc_id` is refused (INJECT_PC_UNSPECIFIED) before the room is even
 *  looked up, so every frame here that is meant to be judged on its IMAGE fields
 *  has to be correctly addressed first — otherwise these assertions would pass
 *  for a reason that has nothing to do with images. The refusal is pinned in
 *  relay-pc-target.test.ts. */
const BOUND_PC = 'pc-device-1';
/** A real 2×2 RGBA PNG (the same bytes the desktop's WIC test decodes). */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwwZGP6DQAMASUkJeJw9PL4AAAAASUVORK5CYII=';

interface FakeSocket {
  id: string;
  data: { auth: AuthContext | null; roomUuid: string | null };
  on(event: string, fn: (payload: unknown) => void): void;
  fire(event: string, payload: unknown): void;
  /** Frames the SERVER sent back to this socket (the reject-verdict mirror). */
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

describe('R6 T-4 — image inject:request across the relay', () => {
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

  it('a well-formed image frame reaches the PC with its bytes intact', () => {
    mobile.fire('inject:request', {
      text: '',
      source: 'image',
      request_id: 'img-1',
      entry_id: 'loc_dev_img-1',
      target_pc_id: BOUND_PC,
      image_b64: PNG_B64,
      image_mime: 'image/png',
    });
    const forwarded = pcEmits.find((e) => e.event === 'inject:request');
    expect(forwarded, 'the image frame must cross the mirror').toBeTruthy();
    const payload = forwarded!.payload as Record<string, unknown>;
    expect(payload.source).toBe('image');
    expect(payload.image_b64).toBe(PNG_B64);
    expect(payload.image_mime).toBe('image/png');
    expect(payload.entry_id).toBe('loc_dev_img-1');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a half-formed image frame is dropped and logged, never forwarded', () => {
    // source:'image' with no bytes — the superRefine pairing rule.
    mobile.fire('inject:request', { text: '', source: 'image' });
    // bytes without the image source — the mirror-image rule.
    mobile.fire('inject:request', { text: 'hi', source: 'stt', image_b64: PNG_B64, image_mime: 'image/png' });
    // a mime outside the three-value enum.
    mobile.fire('inject:request', { text: '', source: 'image', image_b64: PNG_B64, image_mime: 'image/gif' });
    expect(pcEmits.filter((e) => e.event === 'inject:request')).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it('non-canonical base64 is rejected at the zod boundary, not passed through', () => {
    for (const bad of ['QUJD QQ==', 'QUJD\nQQ==', 'data:image/png;base64,QUJDRA==', 'Pz8_Pw==']) {
      mobile.fire('inject:request', { text: '', source: 'image', image_b64: bad, image_mime: 'image/png' });
    }
    expect(pcEmits.filter((e) => e.event === 'inject:request')).toHaveLength(0);
  });
});

// 2026-07-29 (owner live repro): a dropped inject:request was answered with
// NOTHING — the phone sat out its 20 s watchdog and said "the PC did not respond". Every
// drop is a verdict, and every verdict must travel back to the sender as a
// server-authored inject:result (red line: no silent failure, both directions).
describe('server-authored reject verdicts', () => {
  let pcEmits: { event: string; payload: unknown }[];
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let mobile: FakeSocket;

  function wire(withPc: boolean): void {
    pcEmits = [];
    const pc = { id: 'pc', emit: (event: string, payload: unknown) => pcEmits.push({ event, payload }) };
    const store: RoomStore<Socket> = {
      getPc: (room: string) => (withPc && room === ROOM ? (pc as unknown as Socket) : null),
      getMobiles: () => [],
    } as unknown as RoomStore<Socket>;
    mobile = fakeSocket('m1', 'mobile');
    registerRelayHandlers(mobile as unknown as Socket, { store });
  }

  beforeEach(() => {
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
  });

  afterEach(() => warnSpy.mockRestore());

  it('an over-cap image frame is answered INJECT_FRAME_TOO_LARGE with both echoes', () => {
    wire(true);
    mobile.fire('inject:request', {
      text: '',
      source: 'image',
      request_id: 'i9-123',
      entry_id: 'loc_dev_i9-123',
      image_b64: 'A'.repeat(5_500_004),
      image_mime: 'image/jpeg',
    });
    expect(pcEmits).toHaveLength(0);
    expect(mobile.emits).toHaveLength(1);
    const verdict = mobile.emits[0]!;
    expect(verdict.event).toBe('inject:result');
    expect(verdict.payload).toMatchObject({
      ok: false,
      error: 'INJECT_FRAME_TOO_LARGE',
      request_id: 'i9-123',
      entry_id: 'loc_dev_i9-123',
    });
    // 0.2.27: the server-side `failed` stamp that used to be asserted here went
    // with `transcript_history`. The requirement it served — "that row must not stay hung on ⏳" —
    // is now met by the echo asserted just above: `entry_id` comes back on the
    // verdict, and the END that owns the row settles it. What must never regress is
    // the echo, so that is what this test guards.
    expect(warnSpy).toHaveBeenCalled();
  });

  it('any other malformed frame is answered INJECT_FRAME_INVALID (echoes only when sane strings)', () => {
    wire(true);
    mobile.fire('inject:request', { text: '', source: 'image', request_id: 'i1-1' });
    expect(mobile.emits).toHaveLength(1);
    expect(mobile.emits[0]!.payload).toMatchObject({ ok: false, error: 'INJECT_FRAME_INVALID', request_id: 'i1-1' });
    // A non-string echo is never parroted back.
    mobile.emits.length = 0;
    mobile.fire('inject:request', { text: '', source: 'image', request_id: 42 });
    expect(mobile.emits[0]!.payload).not.toHaveProperty('request_id');
  });

  it('a VALID frame relayed into a PC-less room is answered INJECT_PC_OFFLINE and logged', () => {
    wire(false);
    mobile.fire('inject:request', {
      text: '',
      source: 'image',
      request_id: 'i2-1',
      entry_id: 'loc_dev_i2-1',
      target_pc_id: BOUND_PC,
      image_b64: PNG_B64,
      image_mime: 'image/png',
    });
    expect(pcEmits).toHaveLength(0);
    expect(mobile.emits[0]!.payload).toMatchObject({
      ok: false,
      error: 'INJECT_PC_OFFLINE',
      request_id: 'i2-1',
      entry_id: 'loc_dev_i2-1',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('every reject verdict is itself a schema-legal inject:result', () => {
    const schema = EVENT_SCHEMAS['inject:result'];
    wire(false);
    mobile.fire('inject:request', { text: '', source: 'image', request_id: 'i3-1', image_b64: PNG_B64, image_mime: 'image/png' });
    expect(schema.safeParse(mobile.emits[0]!.payload).success).toBe(true);
    wire(true);
    mobile.fire('inject:request', { text: '', source: 'image' });
    expect(schema.safeParse(mobile.emits[0]!.payload).success).toBe(true);
  });
});

describe('R6 T-4 — the transport ceiling sits above the schema ceiling', () => {
  it('maxHttpBufferSize exceeds the largest legal inject:request', () => {
    // The schema's own cap, read from the SSOT rather than restated here.
    const schema = EVENT_SCHEMAS['inject:request'];
    const atCap = 'A'.repeat(5_500_000);
    expect(
      schema.safeParse({ text: '', source: 'image', image_b64: atCap, image_mime: 'image/png' }).success,
      'a 5.5M-char image_b64 is a LEGAL payload',
    ).toBe(true);
    expect(
      schema.safeParse({ text: '', source: 'image', image_b64: `${atCap}AAAA`, image_mime: 'image/png' }).success,
      'one quad over the cap is rejected by zod (a readable error, not a dropped socket)',
    ).toBe(false);

    // The engine must be able to carry the legal one, with room for the JSON
    // envelope and socket.io framing around it.
    expect(MAX_HTTP_BUFFER_BYTES).toBeGreaterThan(atCap.length);
    expect(
      MAX_HTTP_BUFFER_BYTES,
      'socket.io default is 1e6 — leaving it there would silently shred legal frames',
    ).toBeGreaterThan(1_000_000);
  });
});
