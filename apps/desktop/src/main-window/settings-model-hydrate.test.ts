// WP-R3.5 — settings:list bridge consumer (R2-2 deferred refinement). Proves the
// desktop ADOPTS a server-authoritative settings snapshot into its reactive
// display model (the observable end of the bridge — anti-façade: a capability
// with a real consumer). Node env: localStorage is absent so `save` no-ops, but
// the reactive `model` (what the UI renders) is the assertion surface.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  applyServerSettings,
  model,
  scheduleServerSettingsPull,
  setServerSettingsPuller,
} from './settings-model';

describe('applyServerSettings adopts a server settings:list snapshot into the model', () => {
  beforeEach(() => {
    // Reset the model to a known baseline before each case.
    model.routings = [{ language: 'zh-CN', engine_id: 'funasr' }];
    model.dictionary = [];
    model.polishEnabled = false;
    model.llm = { preset_id: 'lan-vllm-qwen35', protocol: 'openai-compatible', endpoint: '', api_key: '', model: '' };
    model.card = { professions: [], domains: [], packs: [], terms: [] };
  });

  it('maps the five owned keys (routings / dictionary / polish / llm.config / scenario.card)', () => {
    applyServerSettings([
      { key: 'stt.routings', value: [{ language: 'en', engine_id: 'funasr', endpoint: 'ws://srv:10095' }] },
      { key: 'stt.dictionary', value: [{ term: 'Kubernetes' }] },
      { key: 'stt.polish', value: { enabled: true } },
      { key: 'llm.config', value: { protocol: 'openai-compatible', endpoint: 'http://llm:8000/v1', api_key: 'sk-x', model: 'qwen' } },
      { key: 'scenario.card', value: { professions: ['法律'], domains: [], packs: ['legal'], terms: ['FlowMic'] } },
    ]);
    expect(model.routings).toEqual([{ language: 'en', engine_id: 'funasr', endpoint: 'ws://srv:10095' }]);
    expect(model.dictionary).toEqual([{ term: 'Kubernetes' }]);
    expect(model.polishEnabled).toBe(true);
    expect(model.llm.endpoint).toBe('http://llm:8000/v1');
    expect(model.llm.model).toBe('qwen');
    expect(model.llm.preset_id).toBe('lan-vllm-qwen35'); // server value has no preset_id — UI's is kept
    expect(model.card.professions).toEqual(['法律']);
    expect(model.card.terms).toEqual(['FlowMic']);
  });

  it('ignores unknown keys and malformed values (never throws, never clobbers)', () => {
    applyServerSettings([
      { key: 'device.pc_name', value: 'Some PC' }, // not owned by this model
      { key: 'stt.routings', value: 'not-an-array' }, // malformed → skip
      { key: 'stt.polish', value: true }, // legacy boolean shape → skip (must be {enabled})
      { key: 'scenario.card', value: 42 }, // malformed → skip
    ]);
    expect(model.routings).toEqual([{ language: 'zh-CN', engine_id: 'funasr' }]); // unchanged
    expect(model.polishEnabled).toBe(false); // unchanged
    expect(model.card.professions).toEqual([]); // unchanged
  });

  it('llm.config partial value fills only present fields, keeps the rest', () => {
    model.llm = { preset_id: 'custom', protocol: 'openai-compatible', endpoint: 'http://old', api_key: 'keep', model: 'old' };
    applyServerSettings([{ key: 'llm.config', value: { endpoint: 'http://new', model: 'new-model' } }]);
    expect(model.llm.endpoint).toBe('http://new');
    expect(model.llm.model).toBe('new-model');
    expect(model.llm.api_key).toBe('keep'); // absent field preserved
  });
});

// RV-22 — `settings:updated` was forwarded by Rust (socket/client.rs) and declared
// in lib/bridge.ts with ZERO listeners in the desktop frontend: a dead forward, so
// a setting changed from the phone left this page stale for the whole session. It is
// now wired (settings-model.watchServerSettingsUpdates, registered by App.vue), and
// N frames from one server-side batch must cost ONE settings:list pull, not N.
describe('RV-22 settings:updated coalesces into one settings:list pull', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('three frames inside the debounce window → exactly one pull', () => {
    const pulls = vi.fn(async () => {});
    setServerSettingsPuller(pulls);
    scheduleServerSettingsPull();
    scheduleServerSettingsPull();
    scheduleServerSettingsPull();
    expect(pulls).not.toHaveBeenCalled(); // nothing fires before the window closes
    vi.advanceTimersByTime(200);
    expect(pulls).toHaveBeenCalledTimes(1);
  });

  it('a later frame, after the window closed, pulls again (not a one-shot)', () => {
    const pulls = vi.fn(async () => {});
    setServerSettingsPuller(pulls);
    scheduleServerSettingsPull();
    vi.advanceTimersByTime(200);
    scheduleServerSettingsPull();
    vi.advanceTimersByTime(200);
    expect(pulls).toHaveBeenCalledTimes(2);
  });
});
