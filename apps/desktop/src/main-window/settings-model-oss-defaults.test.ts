// 🔴 OSS-DEFAULTS (0.3.0) — WHAT A STRANGER'S DESKTOP SHOWS BEFORE IT SYNCS.
//
// THE DEFECT THIS PINS. `settings-model.ts`'s section header says "no hard-coded
// IP … goes through the presets package, hard-coding an IP is forbidden," and
// that sentence was true of the FILE and false of
// the VALUE: the defaults were `routingFromPreset('lan-funasr-ws')` and
// `llmFromPreset('lan-vllm-qwen35')`, so the reactive model every fresh install
// rendered held `ws://100.64.7.68:10095` and `http://100.64.7.179:8000/v1` —
// the owner's office LAN, resolved out of the compiled-in preset catalogue.
//
// A SEPARATE FILE, and that is the whole reason this exists rather than a case
// added to settings-model-hydrate.test.ts. `model` is a module singleton, and
// that file's `beforeEach` OVERWRITES `model.routings` / `model.llm` with a test
// baseline before its first assertion runs. Any check for "what the model starts
// as" written there would be measuring the harness. Vitest isolates modules per
// FILE, so this file sees the pristine module-init value and nothing else can
// reach it first.
//
// ⚠️ SCOPE. This is the PRE-FIRST-SYNC display state. The server owns the real
// value and overwrites it on the connected rising edge (`applyServerSettings`),
// which the hydrate file covers. It still matters twice over: it is what the user
// sees before that lands, and on a machine that never connects to a self-hosted
// server it is the entire answer.

import { describe, it, expect } from 'vitest';
import { model } from './settings-model';

describe('the desktop settings-store defaults are neutral', () => {
  it('starts on the BUILT-IN offline engine, with no endpoint at all', () => {
    expect(model.routings).toHaveLength(1);
    const r = model.routings[0]!;
    expect(r.engine_id).toBe('sherpa-local');
    // 🔴 The KEY IS ABSENT, not empty. `''` is an address as far as `new URL` and
    // `fetch` are concerned — it resolves against whatever origin is nearby —
    // which is the shape server-core's `requireEndpoint` refuses by name.
    expect(r).not.toHaveProperty('endpoint');
  });

  it('starts with NO LLM configured — a named absence, not an address', () => {
    // `preset_id: ''` is the same "the user has not chosen a preset" value
    // `asLlmConfig` produces for a stored row with no preset, so the
    // unconfigured state has ONE spelling
    // rather than two that would have to be kept in agreement.
    expect(model.llm.preset_id).toBe('');
    expect(model.llm.endpoint).toBe('');
    expect(model.llm.model).toBe('');
    expect(model.llm.api_key).toBe('');
  });

  it("THE ACCEPTANCE CRITERION: the whole default model holds neither private range", () => {
    // Asserted over the SERIALIZED model rather than field by field. A field list
    // only catches the fields somebody remembered to look at, and the failure
    // being guarded against is the one nobody thought of — a preset gaining a new
    // endpoint-bearing key, say. This is the desktop half of the same assertion
    // apps/server-core/test/settings-defaults.test.ts ⓪ makes about the seeds.
    const blob = JSON.stringify(model);
    expect(blob).not.toMatch(/172\.77\.77\./);
    expect(blob).not.toMatch(/192\.168\.188\./);
  });
});
