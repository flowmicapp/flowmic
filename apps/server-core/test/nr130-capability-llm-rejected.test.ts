// NR-130 — `capability.llm.rejected`: the desktop's devices-page line for "the
// model set up on this computer was refused by its provider" reads this fact,
// and the fact must (a) be reported only for the config that was refused,
// (b) reach the desktop without a reconnect, and (c) follow a model edit.
// NR-129 rides along: an edit of `llm.config` tells the WRITING desktop to
// re-read `capability.llm`, or its "no model" line would outlive the fix.
//
// Harness: the same captured-socket shape as settings-phone-owned.test.ts — a
// real in-memory repo, the real handler, an io map with a peer PC and a peer
// phone, and the production push wiring (`wireLlmCapabilityPush`).
//
// REVERSE CONTROLS (2026-09-29, run with
// `npx vitest run test/nr130-capability-llm-rejected.test.ts`, each restored):
//   · the `llm.config` notify in settings:update disabled ⇒ 2 red (the two
//     "tells the writing desktop" cases), 4 green;
//   · `llmCapabilityFact` forced to `rejected:false` ⇒ 3 red (the read, the push,
//     the after-unwire fact), 3 green.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { SETTINGS_KEY_CAPABILITY_LLM } from '@flowmic/protocol';
import { NODE_CAN_WRITE } from '../src/node/writer-only';
import { registerSettingsHandlers, wireLlmCapabilityPush } from '../src/socket/handlers/settings.handler';
import { __resetLlmRejectLatchForTest, observePolishSignal } from '../src/stt/llm-reject-latch';
import { resolveLlmConfigWithSource } from '../src/compose/llm-config';
import type { AuthContext } from '../src/auth/middleware';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';

const U = 'u-nr130';
const LAN_MODEL = { protocol: 'openai-compatible', endpoint: 'http://192.168.1.20:8000/v1', api_key: 'sk-wrong', model: 'qwen' };

type Frame = { event: string; payload: unknown };

function harness() {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('nr130-capability-secret-32-bytes') });
  db.users.insert({ id: U, display_name: 'Owner', plan: 'free' });
  const toOrigin: Frame[] = [];
  const toPeerPc: Frame[] = [];
  const toPeerPhone: Frame[] = [];
  const peerPc = { id: 'peer-pc', data: { auth: { userId: U, kind: 'pc' } as AuthContext }, emit: (event: string, payload: unknown) => { toPeerPc.push({ event, payload }); } };
  const peerPhone = { id: 'peer-phone', data: { auth: { userId: U, kind: 'mobile' } as AuthContext }, emit: (event: string, payload: unknown) => { toPeerPhone.push({ event, payload }); } };
  const handlers = new Map<string, (p: unknown, ack: unknown) => void>();
  const origin = {
    id: 'origin',
    data: { auth: { userId: U, kind: 'pc', deviceId: 'pc-1' } as AuthContext },
    on(event: string, fn: (p: unknown, ack: unknown) => void) { handlers.set(event, fn); return this; },
    emit: (event: string, payload: unknown) => { toOrigin.push({ event, payload }); },
  };
  const io = { sockets: { sockets: new Map<string, unknown>([['origin', origin], ['peer-pc', peerPc], ['peer-phone', peerPhone]]) } } as unknown as Server;
  registerSettingsHandlers(origin as unknown as Socket, { writerOnly: NODE_CAN_WRITE, io, repo: db.settings });
  const unwire = wireLlmCapabilityPush(io, db.settings);
  const update = (payload: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve) => { handlers.get('settings:update')!(payload, resolve as unknown); });
  const capability = async (): Promise<unknown> => {
    const r = await new Promise<{ items: { key: string; value: unknown }[] }>((resolve) => { handlers.get('settings:list')!({}, resolve as unknown); });
    return r.items.find((i) => i.key === SETTINGS_KEY_CAPABILITY_LLM)?.value;
  };
  const refuse = (): void => {
    observePolishSignal(U, resolveLlmConfigWithSource(db.settings, U).cfg, { polish: 'skipped', polish_reason: 'model_rejected' });
  };
  const capFrames = (frames: Frame[]): Frame[] =>
    frames.filter((f) => f.event === 'settings:updated' && (f.payload as { key?: string }).key === SETTINGS_KEY_CAPABILITY_LLM);
  return { db, update, capability, refuse, toOrigin, toPeerPc, toPeerPhone, capFrames, unwire };
}

beforeEach(() => __resetLlmRejectLatchForTest());
afterEach(() => __resetLlmRejectLatchForTest());

describe('NR-130 — capability.llm.rejected', () => {
  it('a working model reads {usable:true, rejected:false}; a refused one reads rejected:true', async () => {
    const h = harness();
    h.db.settings.write(U, 'llm.config', LAN_MODEL);
    expect(await h.capability()).toEqual({ usable: true, rejected: false }); // positive control
    h.refuse();
    expect(await h.capability()).toEqual({ usable: true, rejected: true });
  });

  it('the refusal is pushed to this user\'s PCs (no reconnect needed), never to the phone', async () => {
    const h = harness();
    h.db.settings.write(U, 'llm.config', LAN_MODEL);
    h.refuse();
    const pushed = h.capFrames(h.toPeerPc);
    expect(pushed).toHaveLength(1);
    expect((pushed[0]!.payload as { value: unknown }).value).toEqual({ usable: true, rejected: true });
    expect(h.capFrames(h.toOrigin)).toHaveLength(1);
    expect(h.capFrames(h.toPeerPhone)).toEqual([]);
    // A second identical refusal changes nothing, so nothing is pushed again.
    h.refuse();
    expect(h.capFrames(h.toPeerPc)).toHaveLength(1);
  });

  it('a model edit ends the fact AND tells the writing desktop to re-read it', async () => {
    const h = harness();
    h.db.settings.write(U, 'llm.config', LAN_MODEL);
    h.refuse();
    h.toOrigin.length = 0;
    const ack = await h.update({ key: 'llm.config', value: { ...LAN_MODEL, api_key: 'sk-fixed' } });
    expect(ack).toEqual({ ok: true });
    expect(await h.capability()).toEqual({ usable: true, rejected: false });
    const told = h.capFrames(h.toOrigin);
    expect(told).toHaveLength(1);
    expect((told[0]!.payload as { value: unknown }).value).toEqual({ usable: true, rejected: false });
  });

  it('NR-129: filling in the key after picking a cloud vendor clears "no model" on the writing desktop', async () => {
    const h = harness();
    const openai = { protocol: 'openai-compatible', endpoint: 'https://api.openai.com/v1', api_key: '', model: 'gpt-4o' };
    expect(await h.update({ key: 'llm.config', value: openai })).toEqual({ ok: true });
    expect(await h.capability()).toEqual({ usable: false, rejected: false });
    expect((h.capFrames(h.toOrigin).at(-1)!.payload as { value: unknown }).value).toEqual({ usable: false, rejected: false });
    expect(await h.update({ key: 'llm.config', value: { ...openai, api_key: 'sk-real-looking' } })).toEqual({ ok: true });
    expect((h.capFrames(h.toOrigin).at(-1)!.payload as { value: unknown }).value).toEqual({ usable: true, rejected: false });
  });

  it('a key that is not llm.config does not push the capability (the push is not a broadcast of everything)', async () => {
    const h = harness();
    h.db.settings.write(U, 'llm.config', LAN_MODEL);
    expect(await h.update({ key: 'stt.routings', value: [] })).toEqual({ ok: true });
    expect(h.capFrames(h.toOrigin)).toEqual([]);
    expect(h.toPeerPc.length).toBeGreaterThan(0); // positive control: the peer did hear the routings write
  });

  it('after unwire, a refusal pushes nothing (server close does not leak a listener)', async () => {
    const h = harness();
    h.db.settings.write(U, 'llm.config', LAN_MODEL);
    h.unwire();
    h.refuse();
    expect(h.capFrames(h.toPeerPc)).toEqual([]);
    expect(await h.capability()).toEqual({ usable: true, rejected: true }); // the fact itself is still recorded
  });
});
