// WP-R3.5 — settings:list bridge consumer (R2-2 deferred refinement). Proves the
// desktop ADOPTS a server-authoritative settings snapshot into its reactive
// display model (the observable end of the bridge — anti-façade: a capability
// with a real consumer). Node env: localStorage is absent so `save` no-ops, but
// the reactive `model` (what the UI renders) is the assertion surface.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  applyServerSettings,
  model,
  scheduleServerSettingsPull,
  setServerSettingsPuller,
} from './settings-model';
import { SETTINGS_ANCHOR_KEYS } from '../lib/settings-client';

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('applyServerSettings adopts a server settings:list snapshot into the model', () => {
  beforeEach(() => {
    // Reset the model to a known baseline before each case.
    model.routings = [{ language: 'zh-CN', engine_id: 'funasr' }];
    model.llm = { preset_id: 'lan-vllm-qwen35', protocol: 'openai-compatible', endpoint: '', api_key: '', model: '' };
    model.llmCapabilityUsable = true;
  });

  it('maps the keys this PC owns (routings / llm.config) plus the read-only capability fact', () => {
    applyServerSettings([
      { key: 'stt.routings', value: [{ language: 'en', engine_id: 'funasr', endpoint: 'ws://srv:10095' }] },
      { key: 'llm.config', value: { protocol: 'openai-compatible', endpoint: 'http://llm:8000/v1', api_key: 'sk-x', model: 'qwen' } },
      { key: 'capability.llm', value: { usable: false } },
    ]);
    expect(model.routings).toEqual([{ language: 'en', engine_id: 'funasr', endpoint: 'ws://srv:10095' }]);
    expect(model.llm.endpoint).toBe('http://llm:8000/v1');
    expect(model.llm.model).toBe('qwen');
    expect(model.llm.preset_id).toBe('lan-vllm-qwen35'); // server value has no preset_id — UI's is kept
    expect(model.llmCapabilityUsable).toBe(false);
  });

  // 🔴 THE PHONE-OWNED KEYS ARE NOT ADOPTED, AND THAT IS THE ASSERTION (owner
  // 2026-09-03). A relay or a LAN server may still hold rows for them — deleting
  // the legacy cloud rows is a separate, owner-gated act — and an older build of
  // this page would have written them into a display cache for screens that no
  // longer exist. The positive control lives in the SAME call: `stt.routings` is
  // adopted from it, so a green here cannot be 'applyServerSettings did nothing'.
  it('🔴 the phone-owned keys are ignored even when the server still holds rows for them', () => {
    applyServerSettings([
      { key: 'scenario.card', value: { professions: ['law'], domains: [], packs: ['legal'], terms: ['FlowMic'] } },
      { key: 'stt.polish', value: { enabled: true, strength: 'smooth' } },
      { key: 'stt.refine', value: { enabled: true } },
      { key: 'stt.dictionary', value: [{ term: 'Kubernetes' }] },
      { key: 'scenario.inference', value: { granted: true, granted_for: 'local' } },
      { key: 'stt.routings', value: [{ language: 'en', engine_id: 'funasr' }] }, // positive control
    ]);
    expect(model.routings).toEqual([{ language: 'en', engine_id: 'funasr' }]);
    // Nothing on the model answers for the five above — not a stale value, not a
    // fresh one. The shape of the model itself is the guard.
    for (const gone of ['card', 'polishEnabled', 'polishStrength', 'refineEnabled', 'dictionary', 'inferenceConsent']) {
      expect(gone in model, `model.${gone} came back — this end has no screen for it`).toBe(false);
    }
  });

  it('ignores unknown keys and malformed values (never throws, never clobbers)', () => {
    applyServerSettings([
      { key: 'device.pc_name', value: 'Some PC' }, // not owned by this model
      { key: 'stt.routings', value: 'not-an-array' }, // malformed → skip
      { key: 'llm.config', value: 42 }, // malformed → skip
      { key: 'capability.llm', value: { usable: 'yes' } }, // unparseable → keep the last answer
    ]);
    expect(model.routings).toEqual([{ language: 'zh-CN', engine_id: 'funasr' }]); // unchanged
    expect(model.llm.endpoint).toBe(''); // unchanged
    expect(model.llmCapabilityUsable).toBe(true); // unchanged
  });

  it('llm.config partial value fills only present fields, keeps the rest', () => {
    model.llm = { preset_id: 'custom', protocol: 'openai-compatible', endpoint: 'http://old', api_key: 'keep', model: 'old' };
    applyServerSettings([{ key: 'llm.config', value: { endpoint: 'http://new', model: 'new-model' } }]);
    expect(model.llm.endpoint).toBe('http://new');
    expect(model.llm.model).toBe('new-model');
    expect(model.llm.api_key).toBe('keep'); // absent field preserved
  });

  // E3 (2026-09-02) exhaustiveness pin — this is the mechanism that would have
  // caught `stt.refine` missing a case BEFORE a real server push exposed it. A
  // switch on a plain `string` (ServerSettingItem.key comes over the wire, so it
  // cannot be a closed union) gets no compiler exhaustiveness check, so the check
  // has to read the SOURCE: every literal in `SETTINGS_ANCHOR_KEYS` — the "keys
  // with a real server reader" registry that file's own header names — must
  // appear as a `case SETTINGS_ANCHOR_KEYS.<name>:` in applyServerSettings.
  // Reverse control: comment out the `stt.routings` case in settings-model.ts and
  // this test fails (`sttRoutings` is missing).
  // ⚠️ 2026-09-03: the registry shrank to TWO entries when the phone took the
  // preference keys, and shrinking it is how this pin keeps meaning what it says.
  // The alternative — leaving `scenario.card` / `stt.polish` / `stt.refine` in
  // `SETTINGS_ANCHOR_KEYS` for old times' sake — would have made this test demand
  // a desktop `case` for a value no desktop screen shows, and the cheapest way to
  // satisfy it would have been to write one.
  it('every SETTINGS_ANCHOR_KEYS entry has a case in applyServerSettings', () => {
    const source = src('./settings-model.ts');
    const switchBody = source.slice(
      source.indexOf('export function applyServerSettings'),
      source.indexOf('/** Pull + adopt the server settings snapshot.'),
    );
    for (const anchorName of Object.keys(SETTINGS_ANCHOR_KEYS) as (keyof typeof SETTINGS_ANCHOR_KEYS)[]) {
      expect(switchBody, `SETTINGS_ANCHOR_KEYS.${anchorName} ('${SETTINGS_ANCHOR_KEYS[anchorName]}') needs a case in applyServerSettings`)
        .toContain(`case SETTINGS_ANCHOR_KEYS.${anchorName}:`);
    }
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
