import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_KEY_SCENARIO_CARD } from '@flowmic/protocol';
import { SETTINGS_ANCHOR_KEYS, SettingsClient } from './settings-client';
import type { KvStore, SettingsTransport } from './types';

class RecordingTransport implements SettingsTransport {
  calls: Array<{ key: string; value: unknown }> = [];
  online = true;
  async settingsUpdate(key: string, value: unknown): Promise<boolean> {
    this.calls.push({ key, value });
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
