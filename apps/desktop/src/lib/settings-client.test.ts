import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhonePrefsSchema } from '@flowmic/protocol';
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
  it('the anchor key constants match the server read keys', () => {
    expect(SETTINGS_ANCHOR_KEYS.llmConfig).toBe('llm.config');
    expect(SETTINGS_ANCHOR_KEYS.sttRoutings).toBe('stt.routings');
  });

  it('each anchor method writes exactly its key (literal == constant, live)', async () => {
    const t = new RecordingTransport();
    const c = new SettingsClient(t, new MemStore(), 200);
    c.setLlmConfig({ model: 'qwen' });
    c.setSttRoutings([{ language: 'zh-CN', engine_id: 'funasr' }]);
    await vi.advanceTimersByTimeAsync(200);
    const keys = t.calls.map((x) => x.key);
    expect(keys).toContain(SETTINGS_ANCHOR_KEYS.llmConfig);
    expect(keys).toContain(SETTINGS_ANCHOR_KEYS.sttRoutings);
    expect(t.calls.find((x) => x.key === 'stt.routings')?.value).toEqual([
      { language: 'zh-CN', engine_id: 'funasr' },
    ]);
  });

  // 🔴 THE PHONE-OWNED KEYS HAVE NO WRITER HERE, AND THAT IS THE POINT
  // (owner 2026-09-03). `scenario.card` / `stt.polish` / `stt.refine` are still
  // READ by the server; their literal SET anchors moved to
  // apps/mobile/lib/src/settings/settings_client.dart. `verify:lint
  // settings-key-drift` scans apps/desktop AND apps/mobile as one UI side, so
  // deleting the mobile literal for one of them turns that lint red with
  // 'get-only' — which is exactly what a desktop stub invented to 'keep the lint
  // happy' would hide, while writing frames this server refuses from a PC.
  //
  // 🔴 REVERSE CONTROL, RUN 2026-09-03 ON THIS BRANCH (machine: dev-pc-a).
  // With the three desktop anchors already deleted, the mobile literal for
  // `stt.polish` was replaced by its constant (`FlowMicSettingsKeys.sttPolish`)
  // — the exact edit that would leave the key with no literal writer anywhere —
  // and `verify/lint/settings-key-drift.mjs` went red, verbatim:
  //
  //     FAIL settings-key-drift 1 drift: get-only 'stt.polish'
  //       @ apps/server-core/src/db/repos/settings.repo.ts:17
  //
  // Restored immediately; the lint reads PASS 5 set / 5 get again and
  // `git diff apps/mobile/` is empty. What this proves is the half a desktop-only
  // suite cannot: the pairing survived the deletion because the PHONE holds those
  // anchors now, not because the lint stopped looking.
  it('🔴 has no writer for a key the phone owns', () => {
    for (const gone of ['setScenarioCard', 'setSttPolish', 'setSttRefine']) {
      expect(gone in SettingsClient.prototype, `${gone} came back`).toBe(false);
    }
    expect(Object.keys(SETTINGS_ANCHOR_KEYS).sort()).toEqual(['llmConfig', 'sttRoutings']);
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
    c.setSttRoutings([{ language: 'en', engine_id: 'funasr' }]);
    await vi.advanceTimersByTimeAsync(200);
    expect(c.pending).toBe(true);
    expect(c.isKeyPending('stt.routings')).toBe(true);
    // Durable: the queue is persisted so the edit survives a restart.
    expect(store.get('flowmic.settings.queue')).toContain('stt.routings');

    // Reconnect → flush → cleared.
    t.online = true;
    await c.flushPending();
    expect(c.pending).toBe(false);
    expect(t.calls.some((x) => x.key === 'stt.routings')).toBe(true);
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

// ── E4 (2026-09-02): isKeyPending must cover the debounce + in-flight window ──
//
// `isKeyPending` used to answer ONLY `dirty.has(key)` — "did the last flush
// attempt fail". `applyServerSettings` (settings-model.ts) calls it to decide
// whether an incoming server snapshot may overwrite a key: for the whole
// 200ms debounce window AND for the whole of the in-flight network await, a
// key the user had JUST edited was neither debounce-armed-and-checked nor
// dirty, so `isKeyPending` said false and a same-tick server pull (triggered
// by an UNRELATED key changing, since settings:list is a full snapshot) wrote
// the pre-edit value straight back over the user's edit.
describe('E4 — isKeyPending covers the debounce window and the in-flight flush', () => {
  it('is true the instant an edit is made, before the 200ms debounce fires', () => {
    const t = new RecordingTransport();
    const c = new SettingsClient(t, new MemStore(), 200);
    expect(c.isKeyPending('llm.config')).toBe(false); // nothing happened yet
    c.setLlmConfig({ model: 'a' });
    // REVERSE CONTROL for this line: reading only `dirty.has(key)` (the old
    // body) returns false here — the debounce timer is armed, the flush has
    // not even started, so `dirty` has never heard of this key.
    expect(c.isKeyPending('llm.config')).toBe(true);
  });

  it('stays true for the entire in-flight network await, not just until dirty is set', async () => {
    let resolveFlush: ((ok: boolean) => void) | null = null;
    const t: SettingsTransport = {
      settingsUpdate: () =>
        new Promise<boolean>((resolve) => {
          resolveFlush = resolve;
        }),
    };
    const c = new SettingsClient(t, new MemStore(), 200);
    c.setLlmConfig({ model: 'a' });
    await vi.advanceTimersByTimeAsync(200); // debounce fires, flushKey() starts and awaits
    expect(resolveFlush).not.toBeNull(); // sanity: the transport call is actually in flight
    // The debounce timer is gone (flushKey already started) and `dirty` has not
    // been touched yet (the await has not settled) — this is exactly the gap
    // `inFlight` exists to cover.
    expect(c.isKeyPending('llm.config')).toBe(true);
    resolveFlush!(true);
    await Promise.resolve(); // let flushKey's continuation run
    expect(c.isKeyPending('llm.config')).toBe(false); // settled + succeeded
  });

  it('a settings:list pull inside the debounce window must not revert the edit (end-to-end shape)', () => {
    // This is the actual defect, expressed the way applyServerSettings uses the
    // flag: "is there a local edit that should win over this server value".
    const t = new RecordingTransport();
    const c = new SettingsClient(t, new MemStore(), 200);
    c.setLlmConfig({ model: 'user-just-typed-this' });
    const serverSnapshotIsStale = c.isKeyPending('llm.config');
    expect(serverSnapshotIsStale).toBe(true); // ⇒ settings-model.ts must SKIP adopting the pull
  });
});

// ── C3: the desktop must stamp its writes ────────────────────────────────────
//
// Before this card the desktop sent no `updated_at` at all. The consequence was
// not symmetry with another writer but a one-directional guard: with nothing to
// compare, the server's regress check can never fire against a desktop write, so
// a stale offline edit replayed on reconnect overwrites whatever is there and
// the user is never told.
//
// 🔴 THE ORIGINAL SECOND WRITER WAS THE PHONE, ON `scenario.card`, and that key
// is the phone's ALONE since owner 2026-09-03 — so these cases were re-pointed at
// `stt.routings`, which this end still writes. The mechanism under test did not
// change and neither did the danger: the durable queue can replay a week-old
// routing edit onto a server that has since been configured from a second PC on
// the same account, and it is the stamp that makes the server refuse it.
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
    c.setSttRoutings([{ language: 'en', engine_id: 'funasr', endpoint: 'ws://edited-at-noon' }]);
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
    c.setSttRoutings([{ language: 'en', engine_id: 'funasr', endpoint: 'ws://desktop-offline' }]);
    await vi.advanceTimersByTimeAsync(200);
    expect(c.isKeyPending('stt.routings')).toBe(true);

    // 12:30 — the same key is written elsewhere and the server stores that.
    const otherEdit = '2026-08-17T12:30:00.000Z';

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

    const routingCalls = t.calls.filter((x) => x.key === 'stt.routings');
    expect(routingCalls).toHaveLength(1);
    const replay = routingCalls[0]!;
    expect(replay.updatedAt).toBe('2026-08-17T12:00:00.000Z');
    expect(serverRefuses(otherEdit, replay.updatedAt)).toBe(true);

    // The control that makes the assertion mean something: had the drain
    // re-stamped (or, as before this card, sent nothing at all), the same replay
    // would have won and the newer configuration would be gone.
    expect(serverRefuses(otherEdit, '2026-08-17T13:00:00.000Z')).toBe(false);
    expect(serverRefuses(otherEdit, undefined)).toBe(false);
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
    // the server refuses it, hands back the stored row, and the user's routing
    // table reverts with no explanation.
    now = Date.parse('2026-08-17T11:01:00.000Z');
    c.setSttRoutings([{ language: 'en', engine_id: 'funasr', endpoint: 'ws://before' }]);
    await vi.advanceTimersByTimeAsync(200);
    expect(serverRefuses('2026-08-17T12:00:00.000Z', t.calls[0]!.updatedAt)).toBe(true);

    // The snapshot pull (applyServerSettings) feeds every row's stamp in.
    c.observeStamp('2026-08-17T12:00:00.000Z');
    expect(c.stampCorrectionMs).toBeGreaterThan(0);

    now = Date.parse('2026-08-17T11:02:00.000Z'); // true 12:02
    c.setSttRoutings([{ language: 'en', engine_id: 'funasr', endpoint: 'ws://after' }]);
    await vi.advanceTimersByTimeAsync(200);
    const last = t.calls[t.calls.length - 1]!;
    expect(serverRefuses('2026-08-17T12:00:00.000Z', last.updatedAt)).toBe(false);
    expect((last.value as Array<{ endpoint: string }>)[0]!.endpoint).toBe('ws://after');
  });
});

// ── 2026-09-04 (F-2): the durable queue replayed keys the server now refuses ──
//
// `latest` survives restarts, and `flushPending` runs on every LAN `connected`
// rising edge (main-window/store.ts). A queue written by a build <= 0.3.59 —
// which still had desktop panes for the phone-owned keys — therefore re-sent
// `stt.polish` & friends forever; the server answered SETTINGS_SCHEMA_INVALID
// ("key is phone-owned"), `flushPending` marked the key dirty, and `pending`
// latched the 「已存本地」 notice for a value no desktop screen shows.
// Real-device evidence: the LAN sidecar's server.log, seconds after every
// desktop launch:
//   WARN settings:update refused — key is phone-owned … {"key":"stt.polish",
//        "kind":"pc","userId":"default"}
//
// 🔴 REVERSE CONTROL, RUN 2026-09-04 (machine: dev-pc-a). With
// `isRetiredPhoneOwnedKey` forced to `return false` (the whole prune disabled,
// i.e. the pre-fix build), four of the five below went red, verbatim:
//
//     AssertionError: expected [ { key: 'stt.polish', …(2) }, …(1) ] to have a
//       length of 1 but got 2
//     AssertionError: expected '{"latest":{"stt.polish":{"strength":"…' not to
//       contain 'stt.polish'
//     AssertionError: expected [ …(2) ] to have a length of +0 but got 2
//     AssertionError: expected { 'scenario.card': 1, …(4) } to deeply equal {}
//
// The fifth (the flowmic.ui.* cache) stayed green on purpose: it asserts what
// this change must NOT do, so it is green in both directions by design.
// Restored immediately; `grep REVERSE-CONTROL settings-client.ts` = 0.
describe('F-2 — a hydrated queue never replays a phone-owned / retired key', () => {
  const STALE_QUEUE = JSON.stringify({
    latest: { 'stt.polish': { strength: 'smooth' }, 'llm.config': { model: 'qwen' } },
    dirty: ['stt.polish', 'llm.config'],
    stamps: {
      'stt.polish': '2026-09-01T10:00:00.000Z',
      'llm.config': '2026-09-01T10:00:00.000Z',
    },
  });

  it('flushPending sends ONLY the key the desktop still owns', async () => {
    const store = new MemStore();
    store.set('flowmic.settings.queue', STALE_QUEUE);
    const t = new RecordingTransport();
    const c = new SettingsClient(t, store, 200);

    await c.flushPending();

    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.key).toBe('llm.config');
    // …and the refusal-driven latch is gone: nothing is left pending.
    expect(c.pending).toBe(false);
    expect(c.isKeyPending('stt.polish')).toBe(false);
  });

  it('hydrate performs a ONE-TIME cache migration: the pruned snapshot is persisted', () => {
    const store = new MemStore();
    store.set('flowmic.settings.queue', STALE_QUEUE);
    new SettingsClient(new RecordingTransport(), store, 200);

    const persisted = store.get('flowmic.settings.queue')!;
    expect(persisted).not.toContain('stt.polish');
    expect(persisted).toContain('llm.config');
    const snap = JSON.parse(persisted) as {
      latest: Record<string, unknown>; dirty: string[]; stamps: Record<string, string>;
    };
    expect(Object.keys(snap.latest)).toEqual(['llm.config']);
    expect(snap.dirty).toEqual(['llm.config']);
    expect(Object.keys(snap.stamps)).toEqual(['llm.config']);
  });

  it('updateSetting refuses a retired key instead of queueing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new MemStore();
    const t = new RecordingTransport();
    const c = new SettingsClient(t, store, 200);

    // The keys go through a variable, not a literal argument: a literal here
    // would register as a SET anchor for `verify:lint settings-key-drift` and
    // turn it red with `set-only 'stt.dictionary'` — a desktop writer for a key
    // whose whole point is that this end has none.
    for (const dead of ['stt.dictionary', 'scenario.card']) c.updateSetting(dead, {});
    await vi.advanceTimersByTimeAsync(200);

    expect(t.calls).toHaveLength(0);
    expect(c.pending).toBe(false);
    expect(store.get('flowmic.settings.queue')).toBeNull(); // nothing persisted
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('the retired list is a superset of the wire bundle protocol declares', () => {
    // Pins the local literal list against the protocol package's own statement
    // of the phone-owned keys, so the two cannot drift apart silently. The
    // extra member is `stt.dictionary`, retired outright (Q1) and therefore
    // absent from a bundle schema that only carries live preferences.
    const wireKeys = Object.keys(PhonePrefsSchema.shape).sort();
    expect(wireKeys).toEqual(['scenario.card', 'scenario.inference', 'stt.polish', 'stt.refine']);
    const store = new MemStore();
    store.set(
      'flowmic.settings.queue',
      JSON.stringify({ latest: Object.fromEntries([...wireKeys, 'stt.dictionary'].map((k) => [k, 1])) }),
    );
    const c = new SettingsClient(new RecordingTransport(), store, 200);
    expect(JSON.parse(store.get('flowmic.settings.queue')!).latest).toEqual({});
    expect(c.pending).toBe(false);
  });

  it('leaves the flowmic.ui.* display caches alone', () => {
    const store = new MemStore();
    store.set('flowmic.ui.stt.polish', '{"strength":"smooth"}');
    store.set('flowmic.settings.queue', STALE_QUEUE);
    new SettingsClient(new RecordingTransport(), store, 200);
    expect(store.get('flowmic.ui.stt.polish')).toBe('{"strength":"smooth"}');
  });
});
