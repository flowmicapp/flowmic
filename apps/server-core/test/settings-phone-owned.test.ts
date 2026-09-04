// settings.handler.ts — phone-owned keys are REFUSED on `settings:update`, and
// the mobile arm of `settings:list` answers capability.llm only (owner rulings
// 2026-09-03; follow-up ruling the same day: the bundle rides `audio:start` /
// `compose:start`, never a settings push — see test/phone-prefs-carrier.test.ts
// for that half).
//
// THE CONTRACT, in the handler's own terms:
//   · ANY socket + phone-owned key ⇒ SETTINGS_SCHEMA_INVALID with a message
//     naming the key as phone-owned, one log line, nothing stored, nothing kept
//     on the socket, nothing broadcast. Mobile and PC get the SAME answer: an
//     older APK that still pushes these keys must not store a copy nobody reads;
//   · anyone + the retired `stt.dictionary` ⇒ refused by name;
//   · MOBILE `settings:list` ⇒ `capability.llm` and nothing else.
//
// Every negative assertion here has a positive control in the same case: the
// probe that reports "no row / no broadcast" is shown to see a row / a
// broadcast when a STORED key goes through the same harness.
//
// REVERSE CONTROL (executed 2026-09-03, this tree; restored byte-identical,
// sha256 compared) — the whole `if (isPhoneOwnedKey(key)) { … }` refusal
// deleted, so a phone-owned write fell through to the storage path → 3 red / 3 green:
//     FAIL  🔴 a MOBILE write of a phone-owned key is REFUSED by name: nothing stored, nothing on the socket, nothing broadcast
//     FAIL  🔴 a PC write of a phone-owned key is REFUSED by name: nothing stored, nothing on the socket, nothing broadcast
//       AssertionError: expected { ok: true } to deeply equal { …(2) }
//     FAIL  a malformed value is refused with the same named code — the value is never even looked at
//       AssertionError: expected undefined to be 'SETTINGS_SCHEMA_INVALID' // Object.is equality
//   The third line is the storage path accepting a malformed card with `{ok:true}`
//   (it validates nothing until audio:start) — a stored copy the phone would
//   believe was honoured. The stt.dictionary and settings:list cases stayed
//   green (their code is elsewhere). Restored; all green.

import { describe, expect, it } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { NODE_CAN_WRITE } from '../src/node/writer-only';
import { registerSettingsHandlers } from '../src/socket/handlers/settings.handler';
import { getSessionPrefs } from '../src/socket/wire';
import { PHONE_OWNED_SETTING_KEYS } from '../src/settings/session-overlay';
import type { AuthContext } from '../src/auth/middleware';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';

const U = 'u-phone';

/** Same shape as settings-updated-at.test.ts's harness: a captured origin socket,
 *  one peer PC on the io map, a real in-memory repo. */
function harness(kind: AuthContext['kind']) {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('phone-owned-secret-32-bytes-xxxx') });
  db.users.insert({ id: U, display_name: 'Phone', plan: 'free' });
  const emittedToOrigin: { event: string; payload: unknown }[] = [];
  const broadcastToPeer: { event: string; payload: unknown }[] = [];
  const peer = {
    id: 'peer',
    data: { auth: { userId: U, kind: 'pc' } as AuthContext },
    emit: (event: string, payload: unknown) => { broadcastToPeer.push({ event, payload }); },
  };
  const io = { sockets: { sockets: new Map<string, unknown>([['peer', peer]]) } } as unknown as Server;
  const handlers = new Map<string, (p: unknown, ack: unknown) => void>();
  const origin = {
    id: 'origin',
    data: { auth: { userId: U, kind, ...(kind === 'pc' ? { deviceId: 'pc-1' } : { pairingId: 'p-1' }) } as AuthContext },
    on(event: string, fn: (p: unknown, ack: unknown) => void) { handlers.set(event, fn); return this; },
    emit: (event: string, payload: unknown) => { emittedToOrigin.push({ event, payload }); },
  };
  registerSettingsHandlers(origin as unknown as Socket, { writerOnly: NODE_CAN_WRITE, io, repo: db.settings });
  const update = (payload: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve) => { handlers.get('settings:update')!(payload, resolve as unknown); });
  const list = (): Promise<{ items: { key: string; value: unknown; updated_at?: string }[] }> =>
    new Promise((resolve) => { handlers.get('settings:list')!({}, resolve as unknown); });
  return { db, origin: origin as unknown as Socket, update, list, emittedToOrigin, broadcastToPeer };
}

const CARD = { professions: ['eye surgeon'], domains: ['devices'], packs: [], terms: [{ term: 'Kubernetes', aliases: ['k8s'] }] };
const VALID: Record<(typeof PHONE_OWNED_SETTING_KEYS)[number], unknown> = {
  'scenario.card': CARD,
  'stt.polish': { enabled: true, strength: 'smooth' },
  'stt.refine': { enabled: true, min_utterance_ms: 15_000 },
  'scenario.inference': { granted: true, granted_for: 'local' },
};

describe('settings:update — phone-owned keys are refused, whoever sends them', () => {
  for (const kind of ['mobile', 'pc'] as const) {
    it(`🔴 a ${kind.toUpperCase()} write of a phone-owned key is REFUSED by name: nothing stored, nothing on the socket, nothing broadcast`, async () => {
      const h = harness(kind);
      for (const key of PHONE_OWNED_SETTING_KEYS) {
        const ack = await h.update({ key, value: VALID[key] });
        expect(ack).toEqual({
          error: 'SETTINGS_SCHEMA_INVALID',
          message: `${key} is a phone-owned preference; it is set from the phone and never stored on the server`,
        });
      }
      expect(h.db.settings.readAll(U)).toEqual([]);
      expect(getSessionPrefs(h.origin)).toBeNull(); // a settings push never becomes a session bundle
      expect(h.broadcastToPeer).toEqual([]);
      expect(h.emittedToOrigin).toEqual([]);
      // Positive control for the zeros above: a STORED key through the same
      // harness does land and does broadcast, so the probes are not blind.
      expect(await h.update({ key: 'scenario.inference.overrides', value: { chrome: 'browsing' } })).toEqual({ ok: true });
      expect(h.db.settings.read(U, 'scenario.inference.overrides')?.value).toEqual({ chrome: 'browsing' });
      expect(h.broadcastToPeer).toHaveLength(1);
      expect(h.db.settings.read(U, 'scenario.card')).toBeNull(); // still nothing
    });
  }

  it('a malformed value is refused with the same named code — the value is never even looked at', async () => {
    const h = harness('mobile');
    const ack = await h.update({ key: 'scenario.card', value: { professions: [42] } });
    expect(ack.error).toBe('SETTINGS_SCHEMA_INVALID');
    expect(String(ack.message)).toContain('phone-owned');
    expect(h.db.settings.readAll(U)).toEqual([]);
  });

  it('the retired stt.dictionary is refused for BOTH kinds — never stored as a row nothing reads', async () => {
    for (const kind of ['mobile', 'pc'] as const) {
      const h = harness(kind);
      const ack = await h.update({ key: 'stt.dictionary', value: [{ term: 'Kubernetes' }] });
      expect(ack.error).toBe('SETTINGS_SCHEMA_INVALID');
      expect(String(ack.message)).toContain('retired');
      expect(h.db.settings.read(U, 'stt.dictionary')).toBeNull();
    }
  });
});

describe('settings:list — the mobile arm', () => {
  it('🔴 answers capability.llm and NOTHING else, even when the table still holds phone-owned rows (D11 leftovers)', async () => {
    const h = harness('mobile');
    // Rows an older client stored before this contract — the phone must not be
    // handed them back as if the server still held its preferences.
    h.db.settings.write(U, 'scenario.card', CARD);
    h.db.settings.write(U, 'stt.polish', { enabled: false });
    h.db.settings.write(U, 'stt.routings', []);
    const listed = await h.list();
    expect(listed.items).toEqual([{ key: 'capability.llm', value: { usable: expect.any(Boolean) } }]);
  });

  it('the PC arm is unchanged: stored rows plus the synthesised stt.polish default plus capability.llm', async () => {
    const h = harness('pc');
    h.db.settings.write(U, 'stt.routings', []);
    const keys = (await h.list()).items.map((i) => i.key).sort();
    expect(keys).toEqual(['capability.llm', 'stt.polish', 'stt.routings']);
  });
});
