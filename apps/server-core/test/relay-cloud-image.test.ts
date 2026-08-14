// RV-87 — the cloud-relay image policy, **on the relay handler** (the policy object's own judgement is in
// cloud-image-policy.test.ts).
//
// owner 2026-08-01: "if it is the relay channel, the server uniformly intercepts the client; a picture over 1M is not allowed through, to stop
// the relay being used as a photo-sync tool" / "cap it at 200 pictures… but add a limit that rules out machines auto-sending".
//
// A policy object nobody calls is this repo's #1 façade shape, so everything here
// is about the WIRING, and every refusal is asserted in TWO halves — the named
// verdict AND the PC's silence. An implementation that answers "refused" and relays
// anyway passes a code-only test while doing the exact thing the card forbids
// (the G13 lesson, written down in CLAUDE.md as a rule for negative assertions).
//
// SPEC-REF: docs/decisions/2026-08-01-cloud-image-policy-size-cap-and-anti-sync.md;
//   src/socket/handlers/relay.handler.ts (the criterion order); CLAUDE.md red line: no silent failure.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { CLOUD_IMAGE_BYTES_MAX, CLOUD_IMAGE_QUOTA_MAX } from '@flowmic/protocol';
import { registerRelayHandlers } from '../src/socket/handlers/relay.handler';
import { makeCloudImagePolicy } from '../src/socket/cloud-image-policy';
import type { RoomStore } from '../src/room/store';
import type { AuthContext } from '../src/auth/middleware';
import { log } from '../src/log';

const PC_A = 'pc-device-aaa';
const PC_B = 'pc-device-bbb';
const ROOM_A = 'room-a';
const USER = 'u-cloud';

interface Frame { event: string; payload: unknown }

interface FakeMobile {
  id: string;
  data: { auth: AuthContext | null; roomUuid: string | null };
  on(event: string, fn: (payload: unknown) => void): void;
  fire(event: string, payload: unknown): void;
  emits: Frame[];
  emit(event: string, payload: unknown): void;
}

function mobileSocket(id: string, room: string, boundPcId: string, userId = USER): FakeMobile {
  const handlers = new Map<string, (payload: unknown) => void>();
  const emits: Frame[] = [];
  return {
    id,
    data: {
      auth: { userId, kind: 'mobile', pairingId: `pair-${id}`, deviceId: boundPcId },
      roomUuid: room,
    },
    on(event, fn) { handlers.set(event, fn); },
    fire(event, payload) { handlers.get(event)?.(payload); },
    emits,
    emit(event, payload) { emits.push({ event, payload }); },
  };
}

function storeOf(rooms: Record<string, Frame[]>): RoomStore<Socket> {
  return {
    getPc: (room: string): Socket | null => {
      const sink = rooms[room];
      if (!sink) return null;
      return {
        id: `pc-sock-${room}`,
        emit: (event: string, payload: unknown): void => { sink.push({ event, payload }); },
      } as unknown as Socket;
    },
    getMobiles: (): Socket[] => [],
  } as unknown as RoomStore<Socket>;
}

/** `n` decoded bytes as canonical base64 (what InjectImageBase64Schema admits). */
const b64OfBytes = (n: number): string => Buffer.alloc(n).toString('base64');

function imageFrame(bytes: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: '',
    source: 'image',
    request_id: 'req-img',
    entry_id: 'row-img',
    target_pc_id: PC_A,
    image_b64: b64OfBytes(bytes),
    image_mime: 'image/png',
    ...extra,
  };
}

describe('RV-87 — the relay actually asks the cloud image policy', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => { warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  /** saas relay + a mobile bound to PC_A, with PC_A present in the room. */
  function saasRig(opts: { quotaMax?: number } = {}): {
    mobile: FakeMobile; pcFrames: Frame[]; policy: ReturnType<typeof makeCloudImagePolicy>;
  } {
    const pcFrames: Frame[] = [];
    const mobile = mobileSocket('m-a', ROOM_A, PC_A);
    const policy = makeCloudImagePolicy({
      mode: 'saas',
      now: () => 1_000_000,
      ...(opts.quotaMax !== undefined ? { quotaMax: opts.quotaMax } : {}),
    });
    registerRelayHandlers(mobile as unknown as Socket, {
      store: storeOf({ [ROOM_A]: pcFrames }),
      cloudImages: policy,
    });
    return { mobile, pcFrames, policy };
  }

  it('① under the ceiling ⇒ relayed, untouched, and the server says nothing', () => {
    const { mobile, pcFrames } = saasRig();
    mobile.fire('inject:request', imageFrame(CLOUD_IMAGE_BYTES_MAX));
    expect(pcFrames.map((f) => f.event)).toEqual(['inject:request']);
    expect(pcFrames[0]!.payload).toMatchObject({ source: 'image', target_pc_id: PC_A });
    expect(mobile.emits, 'a delivered frame is answered by the PC, not by us').toHaveLength(0);
  });

  it('② over the ceiling ⇒ INJECT_CLOUD_IMAGE_TOO_LARGE **and the PC gets NOT ONE FRAME**', () => {
    const { mobile, pcFrames } = saasRig();
    mobile.fire('inject:request', imageFrame(CLOUD_IMAGE_BYTES_MAX + 1));
    // The half that matters more than the code: "answered with an error code but still forwarded" would pass a
    // code-only assertion and still put the picture on the relay.
    expect(pcFrames, 'the refused picture must not reach the PC').toHaveLength(0);
    expect(mobile.emits).toHaveLength(1);
    expect(mobile.emits[0]).toMatchObject({
      event: 'inject:result',
      payload: {
        ok: false,
        mode: 'cached',
        error: 'INJECT_CLOUD_IMAGE_TOO_LARGE',
        // BOTH echoes, or the phone knows a row was refused but not which one.
        request_id: 'req-img',
        entry_id: 'row-img',
      },
    });
  });

  it('③ 🔴 standalone relays the very same picture — the refusal\'s advice stays true', () => {
    // "connect to the same LAN and you can send it" is a sentence the LAN leg has to honour. This is the
    // POSITIVE CONTROL for ②: without it, ② would also pass on an implementation
    // that refuses every image everywhere.
    const pcFrames: Frame[] = [];
    const mobile = mobileSocket('m-lan', ROOM_A, PC_A);
    registerRelayHandlers(mobile as unknown as Socket, {
      store: storeOf({ [ROOM_A]: pcFrames }),
      cloudImages: makeCloudImagePolicy({ mode: 'standalone', now: () => 1_000_000 }),
    });
    mobile.fire('inject:request', imageFrame(CLOUD_IMAGE_BYTES_MAX + 1));
    expect(pcFrames.map((f) => f.event)).toEqual(['inject:request']);
    expect(mobile.emits).toHaveLength(0);
  });

  it('④ TEXT is never judged by the image policy, however long', () => {
    // The ceiling is about pictures on the relay. A long transcript rides the
    // wire cap (INJECT_TEXT_MAX_CHARS) and has nothing to do with this gate.
    const { mobile, pcFrames } = saasRig();
    mobile.fire('inject:request', {
      text: 'x'.repeat(90_000), source: 'stt', request_id: 'req-t', entry_id: 'row-t', target_pc_id: PC_A,
    });
    expect(pcFrames.map((f) => f.event)).toEqual(['inject:request']);
  });

  it('⑤ 🔴 the ID-mix-up red line still outranks the policy (mismatch wins over over-size)', () => {
    // A mis-addressed frame must be refused AS mis-addressed even when it is also
    // over the ceiling: the red line is the fact the user has to be told about.
    const { mobile, pcFrames } = saasRig();
    mobile.fire('inject:request', imageFrame(CLOUD_IMAGE_BYTES_MAX + 1, { target_pc_id: PC_B }));
    expect(pcFrames).toHaveLength(0);
    expect(mobile.emits[0]!.payload).toMatchObject({ error: 'INJECT_PC_MISMATCH' });
  });

  it('⑥ 🔴 an over-size image is refused BY SIZE even when no PC is in the room', () => {
    // Not INJECT_PC_OFFLINE («retry later») — retrying will be refused forever on
    // this channel, so "retry later" would be advice that cannot work. Same ordering
    // rule the mismatch branch above states for itself.
    const mobile = mobileSocket('m-empty', 'room-empty', PC_A);
    registerRelayHandlers(mobile as unknown as Socket, {
      store: storeOf({}), // no PC anywhere
      cloudImages: makeCloudImagePolicy({ mode: 'saas', now: () => 1_000_000 }),
    });
    mobile.fire('inject:request', imageFrame(CLOUD_IMAGE_BYTES_MAX + 1, { target_pc_id: PC_A }));
    expect(mobile.emits[0]!.payload).toMatchObject({ error: 'INJECT_CLOUD_IMAGE_TOO_LARGE' });
  });

  it('⑦ the count is spent at the EMIT — an offline PC costs the user nothing', () => {
    // judge/record are split for exactly this: a legal picture that finds an empty
    // room is answered INJECT_PC_OFFLINE and the phone will retry it. Charging a
    // slot for that would let a flaky PC eat someone's daily budget.
    const mobile = mobileSocket('m-empty2', 'room-empty', PC_A);
    const policy = makeCloudImagePolicy({ mode: 'saas', now: () => 1_000_000, quotaMax: 1 });
    registerRelayHandlers(mobile as unknown as Socket, { store: storeOf({}), cloudImages: policy });
    for (let i = 0; i < 5; i++) mobile.fire('inject:request', imageFrame(12));
    for (const e of mobile.emits) expect(e.payload).toMatchObject({ error: 'INJECT_PC_OFFLINE' });
    expect(policy.judge(USER, b64OfBytes(12)).admit, 'nothing was relayed, so nothing was counted').toBe(true);
  });

  it('⑧ the quota is enforced END TO END through the handler (relay N, refuse N+1)', () => {
    // The assertion that fails if `record` is ever dropped from the emit path:
    // the policy object's own unit test cannot see that, because it calls
    // `record` itself.
    const { mobile, pcFrames } = saasRig({ quotaMax: 3 });
    for (let i = 0; i < 3; i++) mobile.fire('inject:request', imageFrame(12, { request_id: `r${i}`, entry_id: `e${i}` }));
    expect(pcFrames, 'the first three crossed').toHaveLength(3);
    expect(mobile.emits, 'and drew no server verdict').toHaveLength(0);

    mobile.fire('inject:request', imageFrame(12, { request_id: 'r-over', entry_id: 'e-over' }));
    expect(pcFrames, 'the fourth must NOT reach the PC').toHaveLength(3);
    expect(mobile.emits[0]).toMatchObject({
      event: 'inject:result',
      payload: {
        ok: false,
        error: 'INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED',
        request_id: 'r-over',
        entry_id: 'e-over',
      },
    });
  });

  it('⑨ 🔴 NOT QUOTA_EXCEEDED — that code promises an upgrade would help', () => {
    const { mobile } = saasRig({ quotaMax: 1 });
    mobile.fire('inject:request', imageFrame(12));
    mobile.fire('inject:request', imageFrame(12, { request_id: 'r2', entry_id: 'e2' }));
    expect(mobile.emits[0]!.payload).not.toMatchObject({ error: 'QUOTA_EXCEEDED' });
    expect(mobile.emits[0]!.payload).toMatchObject({ error: 'INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED' });
  });

  it('⑩ two accounts on one relay do not share a budget', () => {
    const pcFrames: Frame[] = [];
    const store = storeOf({ [ROOM_A]: pcFrames });
    const policy = makeCloudImagePolicy({ mode: 'saas', now: () => 1_000_000, quotaMax: 1 });
    const mobA = mobileSocket('m-1', ROOM_A, PC_A, 'user-a');
    const mobB = mobileSocket('m-2', ROOM_A, PC_A, 'user-b');
    registerRelayHandlers(mobA as unknown as Socket, { store, cloudImages: policy });
    registerRelayHandlers(mobB as unknown as Socket, { store, cloudImages: policy });
    mobA.fire('inject:request', imageFrame(12));
    mobA.fire('inject:request', imageFrame(12, { request_id: 'r2' }));
    expect(mobA.emits[0]!.payload).toMatchObject({ error: 'INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED' });
    mobB.fire('inject:request', imageFrame(12, { request_id: 'r3' }));
    expect(mobB.emits, 'user-b has its own 200').toHaveLength(0);
    expect(pcFrames).toHaveLength(2);
  });

  it('⑪ the production ceiling really is the protocol constant, not a test seam', () => {
    // The rig above passes `quotaMax` for speed; this one takes the defaults, so a
    // policy wired with a different number in production would be visible here.
    const { mobile, pcFrames } = saasRig();
    for (let i = 0; i < CLOUD_IMAGE_QUOTA_MAX; i++) {
      mobile.fire('inject:request', imageFrame(12, { request_id: `p${i}`, entry_id: `q${i}` }));
    }
    expect(pcFrames).toHaveLength(CLOUD_IMAGE_QUOTA_MAX);
    expect(mobile.emits).toHaveLength(0);
    mobile.fire('inject:request', imageFrame(12, { request_id: 'p-last', entry_id: 'q-last' }));
    expect(pcFrames).toHaveLength(CLOUD_IMAGE_QUOTA_MAX);
    expect(mobile.emits[0]!.payload).toMatchObject({ error: 'INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED' });
  });
});
