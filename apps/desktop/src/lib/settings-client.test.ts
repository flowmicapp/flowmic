import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_KEY_SCENARIO_CARD } from '@flowmic/protocol';
import { SETTINGS_ANCHOR_KEYS, SettingsClient } from './settings-client';
import type { KvStore, SettingsTransport } from './types';

class RecordingTransport implements SettingsTransport {
  calls: Array<{ key: string; value: unknown; updatedAt?: string }> = [];
  online = true;
  async settingsUpdate(key: string, value: unknown, updatedAt?: string): Promise<boolean> {
    this.calls.push({ key, value, updatedAt });
    return this.online;
  }
}

class MemStore implements KvStore {
  m = new Map<string, string>();
  get(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  set(k: string, v: string): void {
    this.m.set(k, v);
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('settings-key-drift SET anchors', () => {
  it('the anchor key constants match the SSOT / server read keys', () => {
    expect(SETTINGS_ANCHOR_KEYS.scenarioCard).toBe(SETTINGS_KEY_SCENARIO_CARD);
    expect(SETTINGS_ANCHOR_KEYS.scenarioCard).toBe('scenario.card');
    expect(SETTINGS_ANCHOR_KEYS.llmConfig).toBe('llm.config');
    expect(SETTINGS_ANCHOR_KEYS.sttRoutings).toBe('stt.routings');
    expect(SETTINGS_ANCHOR_KEYS.sttPolish).toBe('stt.polish');
  });

  it('each anchor method writes exactly its SSOT key (literal == constant, live)', async () => {
    const t = new RecordingTransport();
    const c = new SettingsClient(t, new MemStore(), 200);
    c.setLlmConfig({ model: 'qwen' });
    c.setSttRoutings([{ language: 'zh-CN', engine_id: 'funasr' }]);
    c.setScenarioCard({ professions: [], domains: [], packs: [], terms: [] });
    c.setSttPolish({ enabled: true });
    await vi.advanceTimersByTimeAsync(200);
    const keys = t.calls.map((x) => x.key);
    expect(keys).toContain(SETTINGS_ANCHOR_KEYS.llmConfig);
    expect(keys).toContain(SETTINGS_ANCHOR_KEYS.sttRoutings);
    expect(keys).toContain(SETTINGS_ANCHOR_KEYS.scenarioCard);
    expect(keys).toContain(SETTINGS_ANCHOR_KEYS.sttPolish);
    expect(t.calls.find((x) => x.key === 'stt.polish')?.value).toEqual({ enabled: true });
  });
});

describe('SettingsClient — 即改即存 200ms debounce + durable + fail-loud', () => {
  it('debounces rapid edits to one wire push with the latest value', async () => {
    const t = new RecordingTransport();
    const c = new SettingsClient(t, new MemStore(), 200);
    c.setLlmConfig({ model: 'a' });
    c.setLlmConfig({ model: 'b' });
    c.setLlmConfig({ model: 'c' });
    expect(t.calls).toHaveLength(0); // nothing before the debounce elapses
    await vi.advanceTimersByTimeAsync(200);
    const llmCalls = t.calls.filter((x) => x.key === 'llm.config');
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]!.value).toEqual({ model: 'c' });
    expect(c.pending).toBe(false); // online → synced, not pending
  });

  it('offline edit is pending (「已存本地」) and re-flushes on reconnect', async () => {
    const t = new RecordingTransport();
    t.online = false;
    const store = new MemStore();
    const c = new SettingsClient(t, store, 200);
    c.setScenarioCard({ professions: ['x'], domains: [], packs: [], terms: [] });
    await vi.advanceTimersByTimeAsync(200);
    expect(c.pending).toBe(true);
    expect(c.isKeyPending('scenario.card')).toBe(true);
    // Durable: the queue is persisted so the edit survives a restart.
    expect(store.get('flowmic.settings.queue')).toContain('scenario.card');

    // Reconnect → flush → cleared.
    t.online = true;
    await c.flushPending();
    expect(c.pending).toBe(false);
    expect(t.calls.some((x) => x.key === 'scenario.card')).toBe(true);
  });

  it('hydrates a pending key from a prior (offline) session', () => {
    const store = new MemStore();
    store.set(
      'flowmic.settings.queue',
      JSON.stringify({ latest: { 'stt.routings': [] }, dirty: ['stt.routings'] }),
    );
    const c = new SettingsClient(new RecordingTransport(), store, 200);
    expect(c.pending).toBe(true);
    expect(c.isKeyPending('stt.routings')).toBe(true);
  });
});

// ── C3: this client is the SECOND writer of scenario.card, so it must stamp ───
//
// Before this card the desktop sent no `updated_at` at all. The consequence was
// not symmetry with the phone but a one-directional guard: with nothing to
// compare, the server's regress check can never fire against a desktop write, so
// a stale offline edit replayed on reconnect overwrites a card the phone edited
// minutes ago and the user is never told.
//
// `serverRefuses` mirrors the `existingMs > incomingMs` guard in
// apps/server-core/src/socket/handlers/settings.handler.ts so these cases can say
// "the server would refuse this" rather than compare two strings. Its authority
// is that citation — the wire-level proof belongs to the server's own suite.
//
// WHERE THESE ASSERTIONS STOP, stated so nobody reads them as end-to-end. They
// pin what this client hands the transport. The next two hops are pinned by
// `socket::wire::wire_tests` on the Rust side
// (`settings_update_carries_the_edit_moment_when_the_frontend_knows_it` and
// `settings_update_omits_the_key_entirely_when_the_moment_is_unknown`), and the
// server's behaviour on receipt by the server package's own suite. Three
// separate files, because no one of them can see the whole path — and a test
// that reads as end-to-end while stopping one layer short is how a façade
// acquires a green light.
//
// ── REVERSE CONTROL (executed 2026-08-17) ────────────────────────────────────
// Break: `flushPending` sends `this.clock.nowIso()` instead of the key's stored
// edit moment — i.e. the queue re-stamps on drain, which is the behaviour that
// makes a stale replay win.
// OBSERVED: `Tests 3 failed | 7 passed (10)` — ACCEPTANCE (b), the restart case
// and the pre-C3-queue case, with
// `Expected: "2026-08-17T12:00:00.000Z" / Received: "2026-08-18T09:00:00.000Z"`.
// CONTROL-ON-CONTROL: the debounce, anchor-key, offline-pending and
// stamp-at-the-edit cases stayed GREEN, and so did ACCEPTANCE (a) — the break is
// specific to the drain.
// 🔴 AND THE CONTROL EARNED ITS KEEP THE FIRST TIME IT RAN: ACCEPTANCE (b)
// stayed green under this break, because it read `t.calls.find(...)` and picked
// up the FAILED OFFLINE ATTEMPT rather than the replay. The test was asserting a
// frame that the break could not touch. Fixed (see the `t.calls.length = 0`
// note inside it) and re-run — a reverse control that goes green is not a
// passing grade, it is a report that the test was measuring the wrong thing.
function serverRefuses(storedIso: string | undefined, incomingIso: string | undefined): boolean {
  const stored = storedIso === undefined ? NaN : Date.parse(storedIso);
  const incoming = incomingIso === undefined ? NaN : Date.parse(incomingIso);
  if (Number.isNaN(stored) || Number.isNaN(incoming)) return false; // unknown ⇒ write it
  return stored > incoming;
}

describe('SettingsClient — C3 `updated_at` is the EDIT moment, not the drain moment', () => {
  it('stamps at the edit, not when the debounce fires', async () => {
    const t = new RecordingTransport();
    let now = Date.parse('2026-08-17T12:00:00.000Z');
    const c = new SettingsClient(t, new MemStore(), 200, () => now);
    c.setScenarioCard({ professions: [], domains: [], packs: [], terms: ['edited at noon'] });
    now += 200; // the debounce elapses at 12:00:00.200
    await vi.advanceTimersByTimeAsync(200);
    expect(t.calls[0]!.updatedAt).toBe('2026-08-17T12:00:00.000Z');
  });

  it('ACCEPTANCE (b): a STALE OFFLINE EDIT REPLAYED AN HOUR LATER LOSES', async () => {
    // 12:00 — the user edits on this desktop while it is offline. The edit is
    // durable and pending ("saved locally"), exactly as before this card.
    const t = new RecordingTransport();
    t.online = false;
    const store = new MemStore();
    let now = Date.parse('2026-08-17T12:00:00.000Z');
    const c = new SettingsClient(t, store, 200, () => now);
    c.setScenarioCard({ professions: [], domains: [], packs: [], terms: ['desktop, offline'] });
    await vi.advanceTimersByTimeAsync(200);
    expect(c.isKeyPending('scenario.card')).toBe(true);

    // 12:30 — the phone edits the same card and the server stores that.
    const phoneEdit = '2026-08-17T12:30:00.000Z';

    // 13:00 — this desktop reconnects and the queue drains.
    // 🔴 The recorder is cleared first, and that is not tidiness: the failed
    // offline attempt at 12:00 is also in `t.calls`, and a `find` over the whole
    // list would read THAT one and stay green no matter what the drain sent.
    // Caught by this case's own reverse control, which it survived while it was
    // asserting the wrong frame.
    t.calls.length = 0;
    now = Date.parse('2026-08-17T13:00:00.000Z');
    t.online = true;
    await c.flushPending();

    const cardCalls = t.calls.filter((x) => x.key === 'scenario.card');
    expect(cardCalls).toHaveLength(1);
    const replay = cardCalls[0]!;
    expect(replay.updatedAt).toBe('2026-08-17T12:00:00.000Z');
    expect(serverRefuses(phoneEdit, replay.updatedAt)).toBe(true);

    // The control that makes the assertion mean something: had the drain
    // re-stamped (or, as before this card, sent nothing at all), the same replay
    // would have won and the phone's newer card would be gone.
    expect(serverRefuses(phoneEdit, '2026-08-17T13:00:00.000Z')).toBe(false);
    expect(serverRefuses(phoneEdit, undefined)).toBe(false);
  });

  it('the edit moment survives a RESTART inside the durable queue', async () => {
    const store = new MemStore();
    const t1 = new RecordingTransport();
    t1.online = false;
    let now = Date.parse('2026-08-17T12:00:00.000Z');
    const c1 = new SettingsClient(t1, store, 200, () => now);
    c1.setSttRoutings([{ language: 'zh-CN', engine_id: 'funasr' }]);
    await vi.advanceTimersByTimeAsync(200);

    // Reboot: a fresh client over the SAME store, a day later.
    now = Date.parse('2026-08-18T09:00:00.000Z');
    const t2 = new RecordingTransport();
    const c2 = new SettingsClient(t2, store, 200, () => now);
    expect(c2.isKeyPending('stt.routings')).toBe(true);
    await c2.flushPending();
    expect(t2.calls[0]!.updatedAt).toBe('2026-08-17T12:00:00.000Z');
  });

  it('a queue written by a PRE-C3 build replays with NO stamp (unknown stays '
    + 'unknown, and unknown is exactly today\'s behaviour)', async () => {
    // The deployment-safety case, on this side of the wire: a stored queue from
    // a build that never recorded edit moments must not have one invented for it
    // on hydrate. A fabricated stamp would be compared against a real one.
    const store = new MemStore();
    store.set(
      'flowmic.settings.queue',
      JSON.stringify({ latest: { 'stt.routings': [] }, dirty: ['stt.routings'] }),
    );
    const t = new RecordingTransport();
    const c = new SettingsClient(t, store, 200, () => Date.parse('2026-08-17T12:00:00.000Z'));
    await c.flushPending();
    expect(t.calls[0]!.updatedAt).toBeUndefined();
    expect(serverRefuses('2026-08-17T12:30:00.000Z', t.calls[0]!.updatedAt)).toBe(false);
  });

  it('ACCEPTANCE (a, desktop half): a machine whose clock LAGS still wins with a '
    + 'genuinely newer edit, once it has seen one server stamp', async () => {
    const t = new RecordingTransport();
    // True time is 12:00; this machine reads 11:00.
    let now = Date.parse('2026-08-17T11:00:00.000Z');
    const c = new SettingsClient(t, new MemStore(), 200, () => now);

    // Uncorrected: the edit the user makes at true 12:01 is stamped 11:01 and
    // the server refuses it, hands back the phone's card, and the user's terms
    // revert with no explanation.
    now = Date.parse('2026-08-17T11:01:00.000Z');
    c.setScenarioCard({ professions: [], domains: [], packs: [], terms: ['before'] });
    await vi.advanceTimersByTimeAsync(200);
    expect(serverRefuses('2026-08-17T12:00:00.000Z', t.calls[0]!.updatedAt)).toBe(true);

    // The snapshot pull (applyServerSettings) feeds every row's stamp in.
    c.observeStamp('2026-08-17T12:00:00.000Z');
    expect(c.stampCorrectionMs).toBeGreaterThan(0);

    now = Date.parse('2026-08-17T11:02:00.000Z'); // true 12:02
    c.setScenarioCard({ professions: [], domains: [], packs: [], terms: ['after'] });
    await vi.advanceTimersByTimeAsync(200);
    const last = t.calls[t.calls.length - 1]!;
    expect(serverRefuses('2026-08-17T12:00:00.000Z', last.updatedAt)).toBe(false);
    expect((last.value as { terms: string[] }).terms).toEqual(['after']);
  });
});
