// 🔴 Card S — never mix up ids, on the socket ingress; plus the row fields that have to
// survive the crossing.
//
// owner 2026-07-31, original words 「a life-or-death line, must not be crossed」:「every message has a 『delivery id』 and a 『target
// PC id』, and the two must correspond; they must not be mixed」. Two independent things are pinned here
// and they fail in opposite directions, which is why neither one alone is enough:
//
//   1. ADDRESSING — a frame whose address is WRONG is refused (INJECT_PC_MISMATCH)
//      and, since 0.2.33 (Window B3), a frame with NO address is refused too
//      (INJECT_PC_UNSPECIFIED — two different wrong answers, two sentences that
//      send the user to two different places). In both cases the PC receives ZERO
//      frames: asserting the refusal without asserting the silence would pass on an
//      implementation that answers 「refused」 to the phone and delivers anyway.
//   2. CARRIAGE — the seven row fields cross VERBATIM. zod objects strip
//      unknown keys, so a relay running a pre-Card P protocol build does not refuse
//      the new frame: it quietly delivers one with the row fields cut out, and the
//      PC renders a row that lost its timestamp and its original text with nobody
//      reporting a loss. A silent subtraction is exactly what this repo's red line
//      forbids, and only a byte-level assertion catches it.
//
// SPEC-REF: docs/decisions/2026-07-31-owner-two-channels-transit-not-storage.md
//   (Card P protocol shape / Card S check points); packages/protocol/src/error-codes.ts
//   INJECT_PC_MISMATCH; CLAUDE.md red line 「never mix up ids」「no silent failure」.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { registerRelayHandlers } from '../src/socket/handlers/relay.handler';
import type { RoomStore } from '../src/room/store';
import type { AuthContext } from '../src/auth/middleware';
import { log } from '../src/log';

/** Two phones, two PCs, two rooms — the shape the red line is about. */
const PC_A = 'pc-device-aaa';
const PC_B = 'pc-device-bbb';
const ROOM_A = 'room-a';
const ROOM_B = 'room-b';

interface Frame { event: string; payload: unknown }

interface FakeMobile {
  id: string;
  data: { auth: AuthContext | null; roomUuid: string | null };
  on(event: string, fn: (payload: unknown) => void): void;
  fire(event: string, payload: unknown): void;
  /** What the SERVER sent back down this socket (reject verdicts). */
  emits: Frame[];
  emit(event: string, payload: unknown): void;
}

/** A mobile socket bound — as the auth middleware / mobile handlers bind it — to
 *  `boundPcId`, i.e. `pc_devices.id` resolved from this phone's own token. */
function mobileSocket(id: string, room: string, boundPcId: string | undefined): FakeMobile {
  const handlers = new Map<string, (payload: unknown) => void>();
  const emits: Frame[] = [];
  return {
    id,
    data: {
      auth: { userId: 'u1', kind: 'mobile', pairingId: `pair-${id}`, ...(boundPcId ? { deviceId: boundPcId } : {}) },
      roomUuid: room,
    },
    on(event, fn) { handlers.set(event, fn); },
    fire(event, payload) { handlers.get(event)?.(payload); },
    emits,
    emit(event, payload) { emits.push({ event, payload }); },
  };
}

/** Rooms that currently have a PC connected. A room absent from the map has no
 *  PC — the INJECT_PC_OFFLINE case. */
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

function textFrame(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { text: 'hello', source: 'stt', request_id: 'req-1', entry_id: 'row-1', ...extra };
}

describe('🔴 Card S — inject:request is refused when it names another PC', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('① MATCHING target_pc_id ⇒ forwarded, address and all', () => {
    const pcA: Frame[] = [];
    const mobile = mobileSocket('m-a', ROOM_A, PC_A);
    registerRelayHandlers(mobile as unknown as Socket, { store: storeOf({ [ROOM_A]: pcA }) });

    mobile.fire('inject:request', textFrame({ target_pc_id: PC_A }));

    expect(pcA.map((f) => f.event)).toEqual(['inject:request']);
    expect(pcA[0]!.payload).toMatchObject({ text: 'hello', target_pc_id: PC_A });
    // A delivered frame is answered by the PC, not by the server.
    expect(mobile.emits).toHaveLength(0);
  });

  it('② MISMATCHED target_pc_id ⇒ refused, and the PC receives NOT ONE FRAME', () => {
    const pcA: Frame[] = [];
    const mobile = mobileSocket('m-a', ROOM_A, PC_A);
    registerRelayHandlers(mobile as unknown as Socket, { store: storeOf({ [ROOM_A]: pcA }) });

    // The phone is bound to PC_A but addresses PC_B — a tampered/stale queue item.
    mobile.fire('inject:request', textFrame({ target_pc_id: PC_B }));

    // THE HALF THAT MATTERS MOST: zero frames on the wire to the PC. Not
    // 「delivered but marked」, not re-routed — nothing left this server.
    expect(pcA).toHaveLength(0);
    // …and the verdict travelled (no silent failure), with BOTH correlation ids so the
    // phone can move THAT row off ⏳ rather than guessing which one was refused.
    expect(mobile.emits).toHaveLength(1);
    expect(mobile.emits[0]!.event).toBe('inject:result');
    expect(mobile.emits[0]!.payload).toEqual({
      ok: false,
      mode: 'cached',
      error: 'INJECT_PC_MISMATCH',
      request_id: 'req-1',
      entry_id: 'row-1',
    });
    // The log has to answer 「who it wanted to send to / who it is actually bound to」 — one id alone is
    // undiagnosable.
    expect(warnSpy).toHaveBeenCalledWith(
      'relay: inject:request addressed to another PC — REFUSED',
      expect.objectContaining({ target_pc_id: PC_B, bound_pc_id: PC_A, room_uuid: ROOM_A }),
    );
  });

  it('③ the mismatch is decided BEFORE the room lookup — an empty room still says MISMATCH', () => {
    // Otherwise a mis-addressed frame arriving while the room is empty would be
    // answered INJECT_PC_OFFLINE — 「retry later」 about a frame that must NEVER be
    // delivered here. Two different questions, and the addressing one comes first.
    const mobile = mobileSocket('m-a', ROOM_A, PC_A);
    registerRelayHandlers(mobile as unknown as Socket, { store: storeOf({}) });

    mobile.fire('inject:request', textFrame({ target_pc_id: PC_B }));

    expect(mobile.emits[0]!.payload).toMatchObject({ error: 'INJECT_PC_MISMATCH' });
  });

  // ── 0.2.33 (Window B3): ④ USED TO ASSERT THE OPPOSITE, and that is the point ────
  //
  // Until this round these two pinned the informed-compat gap: an address-less frame was
  // FORWARDED with a once-per-connection breadcrumb, because a 0.2.28 phone could
  // not stamp the field. The tolerance named its own closing condition and the
  // condition was met (0.2.32 stamps it on all four emission paths), so the gap is
  // now a NAMED refusal. The old assertions are replaced rather than deleted: a
  // reader who greps for 「absent ⇒ forwarded」 has to land on why it stopped.
  it('④ ABSENT target_pc_id ⇒ REFUSED by name, and the PC receives NOT ONE FRAME', () => {
    const pcA: Frame[] = [];
    const mobile = mobileSocket('m-a', ROOM_A, PC_A);
    registerRelayHandlers(mobile as unknown as Socket, { store: storeOf({ [ROOM_A]: pcA }) });

    mobile.fire('inject:request', textFrame());

    // Same half that matters as ②: nothing left this server. An unaddressed frame
    // cannot be checked against anything, so 「forward it anyway」 is a branch where
    // the red line does not apply.
    expect(pcA).toHaveLength(0);
    // …and the verdict travelled, with BOTH echoes, so the phone can move THAT row
    // off ⏳ instead of waiting out a 20 s watchdog (no silent failure).
    expect(mobile.emits).toHaveLength(1);
    expect(mobile.emits[0]!.event).toBe('inject:result');
    expect(mobile.emits[0]!.payload).toEqual({
      ok: false,
      mode: 'cached',
      error: 'INJECT_PC_UNSPECIFIED',
      request_id: 'req-1',
      entry_id: 'row-1',
    });
    // 🔴 The code is not INJECT_PC_MISMATCH, and this is the assertion that keeps
    // the distinction alive: that one says 「the PC you want to send to is not this one」 about a sender
    // that HAS an address, this one says 「you did not say which PC to send to」 and its whole copy is
    // the imperative (update the phone). Folding them would claim a target the
    // frame never named.
    expect((mobile.emits[0]!.payload as { error: string }).error).not.toBe('INJECT_PC_MISMATCH');
    expect(warnSpy).toHaveBeenCalledWith(
      'relay: inject:request carries no target_pc_id — REFUSED',
      expect.objectContaining({ bound_pc_id: PC_A, room_uuid: ROOM_A }),
    );
    // The retired breadcrumb was an `info`; nothing may still be emitting it.
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('④b the refusal is decided BEFORE the room lookup — an empty room still says UNSPECIFIED', () => {
    // Same ordering rule as ③ and for the same reason: an unaddressed frame
    // arriving while the room is empty must not be told INJECT_PC_OFFLINE
    // (「retry later」), because retrying it changes nothing — the sender is the thing
    // that has to change.
    const mobile = mobileSocket('m-a', ROOM_A, PC_A);
    registerRelayHandlers(mobile as unknown as Socket, { store: storeOf({}) });

    mobile.fire('inject:request', textFrame());

    expect(mobile.emits[0]!.payload).toMatchObject({ error: 'INJECT_PC_UNSPECIFIED' });
  });

  it('④c EVERY unaddressed frame is refused and logged — no once-per-connection collapse', () => {
    // The breadcrumb used to be once-per-connection so a repeating harmless fact
    // could not bury the log. It is not a harmless fact any more: each line is a
    // delivery the user lost, and collapsing ten losses into one line would hide
    // how much was lost.
    const pcA: Frame[] = [];
    const mobile = mobileSocket('m-a', ROOM_A, PC_A);
    registerRelayHandlers(mobile as unknown as Socket, { store: storeOf({ [ROOM_A]: pcA }) });

    for (let i = 0; i < 5; i++) mobile.fire('inject:request', textFrame({ request_id: `req-${i}` }));

    expect(pcA).toHaveLength(0); // not one of the five was delivered
    expect(mobile.emits).toHaveLength(5); // …and all five were answered
    expect(warnSpy).toHaveBeenCalledTimes(5);
    // POSITIVE CONTROL for the five zeros: the same connection, one ADDRESSED frame,
    // is delivered. Without it 「zero forwarded」 could equally mean the fixture
    // stopped wiring frames at all.
    mobile.fire('inject:request', textFrame({ request_id: 'req-ok', target_pc_id: PC_A }));
    expect(pcA).toHaveLength(1);
    expect((pcA[0]!.payload as { request_id: string }).request_id).toBe('req-ok');
  });

  it('⑤ fails CLOSED: a connection with no bound PC id cannot satisfy an address', () => {
    // Unreachable in production (all four mobile auth sites stamp deviceId), but
    // the direction of the failure is the point: an unprovable address must not
    // be typed into somebody's machine.
    const pcA: Frame[] = [];
    const mobile = mobileSocket('m-unbound', ROOM_A, undefined);
    registerRelayHandlers(mobile as unknown as Socket, { store: storeOf({ [ROOM_A]: pcA }) });

    mobile.fire('inject:request', textFrame({ target_pc_id: PC_A }));

    expect(pcA).toHaveLength(0);
    expect(mobile.emits[0]!.payload).toMatchObject({ error: 'INJECT_PC_MISMATCH' });
    expect(warnSpy).toHaveBeenCalledWith(
      'relay: inject:request addressed to another PC — REFUSED',
      expect.objectContaining({ bound_pc_id: null }),
    );
  });

  it('⑥ mixed-id regression — two phones × two PCs: each frame lands ONLY on its own destination', () => {
    const pcA: Frame[] = [];
    const pcB: Frame[] = [];
    // One store, both rooms live at once — the situation a queue drains into.
    const store = storeOf({ [ROOM_A]: pcA, [ROOM_B]: pcB });
    const phoneA = mobileSocket('m-a', ROOM_A, PC_A);
    const phoneB = mobileSocket('m-b', ROOM_B, PC_B);
    registerRelayHandlers(phoneA as unknown as Socket, { store });
    registerRelayHandlers(phoneB as unknown as Socket, { store });

    phoneA.fire('inject:request', textFrame({ text: 'for A', target_pc_id: PC_A }));
    phoneB.fire('inject:request', textFrame({ text: 'for B', target_pc_id: PC_B }));
    // …and now the crossed pair, which is the failure this red line exists for.
    phoneA.fire('inject:request', textFrame({ text: 'A→B', target_pc_id: PC_B }));
    phoneB.fire('inject:request', textFrame({ text: 'B→A', target_pc_id: PC_A }));

    expect(pcA.map((f) => (f.payload as { text: string }).text)).toEqual(['for A']);
    expect(pcB.map((f) => (f.payload as { text: string }).text)).toEqual(['for B']);
    expect(phoneA.emits[0]!.payload).toMatchObject({ error: 'INJECT_PC_MISMATCH' });
    expect(phoneB.emits[0]!.payload).toMatchObject({ error: 'INJECT_PC_MISMATCH' });
  });

  it('⑦ the address is checked against the TOKEN BINDING, never against who is in the room', () => {
    // The whole reason `auth.deviceId` is the evidence. Here the room holds a PC
    // and the frame addresses PC_B; a check written as 「is there a PC in the
    // room」 or 「does the room's PC accept it」 passes this frame, because the
    // room says nothing about WHO the phone meant. Only the token binding can
    // disagree with the address — owner: 「never invent the destination from 『who is current』 at drain time」.
    const pcSink: Frame[] = [];
    const mobile = mobileSocket('m-a', ROOM_A, PC_A);
    // Deliberately: the room is ROOM_A and it is occupied. Nothing about the room
    // reveals the mis-addressing.
    registerRelayHandlers(mobile as unknown as Socket, { store: storeOf({ [ROOM_A]: pcSink }) });

    mobile.fire('inject:request', textFrame({ target_pc_id: PC_B }));

    expect(pcSink).toHaveLength(0);
  });
});

describe('🔴 Card S — the row fields cross the relay VERBATIM (handoff)', () => {
  it('all seven arrive on the PC byte-for-byte, because a zod strip is silent', () => {
    const pcA: Frame[] = [];
    const mobile = mobileSocket('m-a', ROOM_A, PC_A);
    registerRelayHandlers(mobile as unknown as Socket, { store: storeOf({ [ROOM_A]: pcA }) });

    // A real image row: everything the PC needs to render one line of timeline,
    // carried by the ONE delivery frame (owner architecture ruling: handoff is not storage — the row is
    // created BY this frame, so anything missing here is unrecoverable).
    const sent = {
      text: '',
      source: 'image',
      request_id: 'req-img-1',
      entry_id: 'row-img-1',
      mode: 'organize',
      created_at: '2026-07-31T01:02:03.456Z',
      source_text: '原文：这是一段被整理前的话',
      entry_type: 'image',
      thumb_b64: 'QUJDRA==',
      // RV-68 (0.2.33): the seventh field. An image frame's `text` is '' by
      // design, so if THIS is what gets stripped the PC renders a row with a
      // thumbnail and not one character — the exact bug this round fixes, and it
      // would come back silently.
      entry_caption: '🖼 JPEG · 214 KB',
      device_label: 'HUAWEI Mate 60 Pro',
      target_pc_id: PC_A,
      image_b64: 'QUJD',
      image_mime: 'image/jpeg',
    };
    mobile.fire('inject:request', sent);

    expect(pcA).toHaveLength(1);
    const got = pcA[0]!.payload as Record<string, unknown>;
    // Field by field, values compared — not 「is it defined」. A stripped field and
    // a wrong field fail here for the same reason: the PC cannot render what did
    // not arrive, and nothing anywhere would report the loss.
    expect(got.created_at).toBe(sent.created_at);
    expect(got.source_text).toBe(sent.source_text);
    expect(got.entry_type).toBe(sent.entry_type);
    expect(got.thumb_b64).toBe(sent.thumb_b64);
    expect(got.entry_caption).toBe(sent.entry_caption);
    expect(got.device_label).toBe(sent.device_label);
    expect(got.target_pc_id).toBe(sent.target_pc_id);
    // And nothing else was dropped or invented on the way across.
    expect(got).toEqual(sent);
  });

  it('`mode` on the REQUEST is the production mode — a Card P widening, still relayed', () => {
    // F-2361 used to confine `mode` to source:'manual'. Card P removed that clause
    // (the server records no row, so the two-answers-to-one-question it guarded
    // cannot exist), and the row transit NEEDS realtime frames to carry it. This
    // pins that a realtime frame with a mode is relayed rather than dropped at the
    // boundary. ⚠️ Not to be confused with `inject:result.mode`
    // (sendinput/clipboard/cached) — same name, different question.
    const pcA: Frame[] = [];
    const mobile = mobileSocket('m-a', ROOM_A, PC_A);
    registerRelayHandlers(mobile as unknown as Socket, { store: storeOf({ [ROOM_A]: pcA }) });

    mobile.fire('inject:request', textFrame({ mode: 'translate', target_pc_id: PC_A }));

    expect(pcA).toHaveLength(1);
    expect((pcA[0]!.payload as { mode: string }).mode).toBe('translate');
  });
});
