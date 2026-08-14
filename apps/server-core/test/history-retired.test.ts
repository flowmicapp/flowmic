// 0.2.27 — the plaintext room-sync history link is RETIRED, and this file is the
// guard on the ONE behaviour that replaced it: every `history:*` frame is REFUSED
// OUT LOUD with `HISTORY_SYNC_RETIRED`.
//
// It replaces test/history-auth.test.ts (and test/history-conflict.test.ts,
// test/history-pc-scope-search.test.ts), whose subjects — cross-tenant ownership
// on id-addressed ops, GA-09 create idempotency, GA-04 identity stamping, GA-13
// origin:machine, C5 conflict verdicts, LIKE search — were all properties of a
// SERVER-SIDE transcript store. owner architecture ruling
// (docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md) removed the store, so
// those judgements have no object; keeping their tests would keep proving that a
// deleted flow behaves correctly.
//
// Why the refusal itself needs tests at all — two field facts:
//   ① a 0.2.26 client is still in the field and will keep sending these frames.
//      An UNREGISTERED socket.io event name is silently discarded, and silence is
//      the red line; so the names must stay registered and must ANSWER.
//   ② the code must not be `SETTINGS_SYNC_FAIL`: the phone hard-codes that ack
//      into "the other side deleted this row" and PHYSICALLY DELETES its local row
//      (timeline_sync.dart → timeline_store.dart). Reusing it would have turned a
//      retirement into user-data destruction at a 100% hit rate. That is asserted
//      here, not just written in a comment.
//
// SPEC-REF: docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md;
//           docs/strategy/2026-07-30-task-package-v1.md §W-A card A2 item 5.

import { describe, it, expect, beforeEach } from 'vitest';
import type { Socket } from 'socket.io';
import { ERROR_CODES } from '@flowmic/protocol';
import { registerHistoryHandlers } from '../src/socket/handlers/history.handler';
import { setCloudSession } from '../src/socket/wire';
import type { AuthContext } from '../src/auth/middleware';

/** Every `history:*` name a client can SEND. The three server→client names
 *  (list-result / updated / deleted) never had an `.on()` and now have no
 *  producer either. */
const CLIENT_SENT = ['history:list', 'history:create', 'history:update', 'history:delete', 'history:inject'] as const;

interface FakeSocket {
  id: string;
  data: { auth: AuthContext | null; roomUuid: string | null };
  emitted: { event: string; payload: unknown }[];
  on(event: string, fn: (payload: unknown, ack: unknown) => void): void;
  emit(event: string, payload: unknown): void;
  /** Send a frame WITH an ack callback; resolves to the ack payload (undefined
   *  when the handler never acked — which would itself be a silent failure). */
  invoke(event: string, payload: unknown): Promise<Record<string, unknown> | undefined>;
  /** Send a frame with NO ack — the phone emits history:create fire-and-forget. */
  fire(event: string, payload: unknown): void;
  has(event: string): boolean;
}

function fakeSocket(userId: string | null = 'user-1'): FakeSocket {
  const handlers = new Map<string, (payload: unknown, ack: unknown) => void>();
  const auth: AuthContext | null = userId ? { userId, kind: 'mobile', pairingId: 'pair-1' } : null;
  return {
    id: 'sock-1',
    data: { auth, roomUuid: userId ? 'room-1' : null },
    emitted: [],
    on(event, fn) { handlers.set(event, fn); },
    emit(event, payload) { this.emitted.push({ event, payload }); },
    invoke(event, payload) {
      return new Promise((resolve) => {
        const fn = handlers.get(event);
        if (!fn) return resolve(undefined);
        let acked = false;
        fn(payload, (res: unknown) => { acked = true; resolve(res as Record<string, unknown>); });
        queueMicrotask(() => { if (!acked) resolve(undefined); });
      });
    },
    fire(event, payload) { handlers.get(event)?.(payload, undefined); },
    has(event) { return handlers.has(event); },
  };
}

/** A well-formed frame per name, so a refusal cannot be mistaken for a parse
 *  failure. (The malformed direction gets its own case below.) */
const VALID: Record<(typeof CLIENT_SENT)[number], unknown> = {
  'history:list': { limit: 50 },
  'history:create': {
    item: {
      id: 'h1', pairing_id: null, pc_device_id: 'pc-1', user_id: 'user-1', mobile_id: null,
      mode: 'realtime', source_text: 's', source_lang: null, output_text: 'o', output_lang: null,
      duration_ms: null, segments_count: 0, status: 'noted',
      created_at: '2026-07-31T00:00:00.000Z', updated_at: '2026-07-31T00:00:00.000Z',
    },
  },
  'history:update': { id: 'h1', output_text: 'edited' },
  'history:delete': { id: 'h1' },
  'history:inject': { id: 'h1' },
};

describe('history:* is retired and refuses OUT LOUD (0.2.27)', () => {
  let sock: FakeSocket;

  beforeEach(() => {
    sock = fakeSocket();
    registerHistoryHandlers(sock as unknown as Socket);
  });

  it('all five client-sent names are still REGISTERED (an unregistered name is a silent discard)', () => {
    for (const name of CLIENT_SENT) expect(sock.has(name), name).toBe(true);
  });

  it('each one answers HISTORY_SYNC_RETIRED — never an empty ack, never no ack', async () => {
    for (const name of CLIENT_SENT) {
      const ack = await sock.invoke(name, VALID[name]);
      expect(ack, name).toBeDefined();
      expect(ack?.error, name).toBe('HISTORY_SYNC_RETIRED');
    }
  });

  it('never answers SETTINGS_SYNC_FAIL — that code makes the phone DELETE the row', async () => {
    // The phone reads SETTINGS_SYNC_FAIL/'no such entry' as "the other side deleted this row" and
    // hard-deletes locally. After a table DROP that ack would be given for EVERY
    // pre-existing row, so this is not a style preference: it is the difference
    // between a retirement and destroying the user's own timeline.
    for (const name of CLIENT_SENT) {
      const ack = await sock.invoke(name, VALID[name]);
      expect(ack?.error, name).not.toBe('SETTINGS_SYNC_FAIL');
      expect(ack?.message, name).toBeUndefined();
    }
  });

  it('never answers CLOUD_SESSION_NO_HISTORY — its sentence blames the session type', async () => {
    // It used to be the honest answer for a cloud-instance solo session. Now that
    // NO session stores history, "cloud sessions do not keep history on the server" is half-false for a
    // paired LAN session — the 0.2.18 PC_BUSY mistake in a new costume.
    const cloud = fakeSocket();
    setCloudSession(cloud as unknown as Socket);
    registerHistoryHandlers(cloud as unknown as Socket);
    const ack = await cloud.invoke('history:create', VALID['history:create']);
    expect(ack?.error).toBe('HISTORY_SYNC_RETIRED');
    expect(ack?.error).not.toBe('CLOUD_SESSION_NO_HISTORY');
  });

  it('a MALFORMED frame gets the same answer — the flow, not the shape, is the reason', async () => {
    // Answering SETTINGS_SCHEMA_INVALID here would tell a client its payload was
    // the problem and invite it to retry with a "better" frame forever.
    for (const [name, bad] of [
      ['history:list', { limit: -1 }],
      ['history:create', { item: {} }],
      ['history:update', { id: '' }],
      ['history:delete', {}],
      ['history:inject', { id: 42 }],
    ] as const) {
      const ack = await sock.invoke(name, bad);
      expect(ack?.error, name).toBe('HISTORY_SYNC_RETIRED');
    }
  });

  it('a fire-and-forget frame (no ack callback) is handled without throwing', () => {
    // timeline_sync.dart emits history:create with no ack. safeAck must swallow the
    // missing callback rather than throw inside the socket handler.
    for (const name of CLIENT_SENT) expect(() => sock.fire(name, VALID[name])).not.toThrow();
  });

  it('an unauthenticated socket gets the SAME refusal (the flow is gone for everyone)', async () => {
    const anon = fakeSocket(null);
    registerHistoryHandlers(anon as unknown as Socket);
    const ack = await anon.invoke('history:list', { limit: 10 });
    expect(ack?.error).toBe('HISTORY_SYNC_RETIRED');
  });

  it('nothing is broadcast: a refused frame produces no history:updated / -deleted', async () => {
    for (const name of CLIENT_SENT) await sock.invoke(name, VALID[name]);
    expect(sock.emitted).toEqual([]);
  });

  it('the code is a real whitelisted error code with both locales', () => {
    // Anti-façade: an ack carrying a code no client can render is a silent failure
    // wearing an error's clothes.
    const msg = ERROR_CODES.HISTORY_SYNC_RETIRED;
    expect(msg.zh_CN.length).toBeGreaterThan(0);
    expect(msg.en.length).toBeGreaterThan(0);
  });
});
