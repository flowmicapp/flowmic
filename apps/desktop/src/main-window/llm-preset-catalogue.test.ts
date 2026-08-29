// owner 2026-08-28 — the vendor catalogue on screen (contract 06 §7.1 ⑤ ⑥).
//
// ── WHAT THE OWNER MET ──────────────────────────────────────────────────────
// Two defects on the same dropdown, and they are opposites of each other:
//   ① a machine that had chosen NOTHING displayed a vendor, because a `<select>`
//      whose value matches no `<option>` renders the FIRST one;
//   ② a machine whose fields had been hand-edited displayed the vendor that was
//      last CLICKED, because `preset_id` kept naming it.
// Both are the same failure underneath: the control answers 「which row did I
// click」 while the user reads it as 「what is this PC configured with」. One
// value, two questions — this repo's #1 shape.
//
// ── 🔴 THE RENDER ASSERTIONS READ renderToString'S OUTPUT ───────────────────
// 0.2.53's law. 「Does the dropdown show a vendor nobody chose」 is a question
// about pixels, and a test that asserted `model.llm.preset_id === ''` would be
// green for exactly the screen the owner reported: the model held `''` the whole
// time — that WAS the bug's starting condition, not its absence.
//
// ⚠️ KNOW YOUR RULER (inherited from stt-language-select.test.ts): SSR output
// contains the template's HTML COMMENTS, and this template's comments quote both
// vendor names and the word 「custom」. So no assertion below is a bare
// `toContain` on a string that could appear in prose — every one of them parses
// the `<option>`/`<optgroup>` tags out of the rendered `<select>` first.
//
// ── 🔴 REVERSE CONTROL — MEASURED RED, THEN RESTORED ────────────────────────
// Deleting the one line that implements defect ②'s fix
// (`model.llm.preset_id = CUSTOM_PRESET_ID;` in settings-model.ts
// `updateLlmField`) and re-running THIS FILE produced, verbatim
// [measured 2026-08-28, machine dev-pc-a]:
//
//   FAIL  src/main-window/llm-preset-catalogue.test.ts > the dropdown cannot
//         keep naming a vendor whose values have been edited away > editing ANY
//         config field moves the dropdown to `custom`
//   AssertionError: expected 'cloud-openai' to be 'custom' // Object.is equality
//   Expected: "custom"
//   Received: "cloud-openai"
//   (the stack frame vitest printed here pointed at this file; its line:col is
//    deliberately NOT quoted — a pasted coordinate rots the moment this header
//    grows, which is precisely what `verify:lint coordinate-anchors` caught on
//    the first run of this very block)
//   FAIL  … > field protocol is not exempt
//   FAIL  … > field endpoint is not exempt
//   FAIL  … > field model is not exempt
//   FAIL  … > field api_key is not exempt
//   AssertionError: expected 'cloud-groq' to be 'custom' // Object.is equality
//   FAIL  … > …and the jump is PERSISTED, not merely displayed
//   FAIL  … > …and the rendered menu follows the fields, not the last click
//
//   Test Files  1 failed (1)
//        Tests  7 failed | 7 passed (14)
//
// The line was restored and the file is green again (14/14).
//
// ⚠️ WHAT THE SHAPE OF THAT RED TELLS US, and it is the reason to write the
// numbers down rather than just 「it went red」: SEVEN cases fell, and the
// remaining seven — every defect-① case and every sectioning case — stayed
// GREEN. That is the correct split. Defect ① and defect ② are independent
// mechanisms, and a reverse control that took the whole file down with it would
// have proved the cases are entangled, not that this one is load-bearing.
// The last of the seven is the one that would survive a refactor: it is the only
// one asserting on what is DRAWN, so it still catches this if the jump is later
// moved into the component and then dropped there.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { CUSTOM_PRESET_ID, LLM_PRESETS } from '@flowmic/protocol';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

import LlmSettings from './components/LlmSettings.vue';
import { model, setLlmPreset, updateLlmField } from './settings-model';
import { S } from '../lib/strings';

/** The preset `<select>`, isolated from the other three on the page.
 *
 *  Keyed off the label text rather than a position or a CSS class: this page has
 *  a second `<select>` (protocol) immediately below, and 「the first select」
 *  would silently start measuring that one the day the layout changes. */
function presetSelect(html: string): string {
  const marker = html.indexOf(S.llm_preset);
  expect(marker, 'the preset field label is on the page').toBeGreaterThan(-1);
  const open = html.indexOf('<select', marker);
  const close = html.indexOf('</select>', open);
  expect(open, 'a select follows that label').toBeGreaterThan(-1);
  return html.slice(open, close);
}

/** Every `value="…"` an `<option>` in this select offers, in order. */
function optionValues(selectHtml: string): string[] {
  return [...selectHtml.matchAll(/<option[^>]*\bvalue="([^"]*)"/g)].map((m) => m[1]!);
}
/** Every `<optgroup label="…">` heading, in order. */
function groupLabels(selectHtml: string): string[] {
  return [...selectHtml.matchAll(/<optgroup[^>]*\blabel="([^"]*)"/g)].map((m) => m[1]!);
}

async function render(): Promise<string> {
  return renderToString(createSSRApp(LlmSettings));
}

beforeEach(() => {
  model.llm = { preset_id: '', protocol: 'openai-compatible', endpoint: '', api_key: '', model: '' };
});

describe('the dropdown cannot claim a preset nobody chose (defect ①)', () => {
  it('an unconfigured PC offers an option matching its stored value — so nothing else is displayed', async () => {
    const sel = presetSelect(await render());
    // 🔴 THE ACTUAL INVARIANT, stated the way the browser resolves it: a select
    // renders the option whose value equals its own, and falls back to the FIRST
    // option when none matches. So 「is the placeholder drawn」 is not the
    // question — 「does SOME option carry the stored value」 is.
    expect(optionValues(sel)).toContain(model.llm.preset_id);
    expect(sel).toContain(S.preset_choose);
    // …and it cannot be chosen, only shown.
    expect(sel).toMatch(/<option[^>]*\bdisabled/);
  });

  it('a preset_id from a build that no longer has that row gets the same treatment', async () => {
    // Not a hypothetical: a downgrade, a hand-edited cache, or a preset removed
    // from the catalogue all land here, and `''` alone would not cover them.
    model.llm.preset_id = 'lan-some-preset-that-was-retired';
    const sel = presetSelect(await render());
    expect(optionValues(sel)).toContain('lan-some-preset-that-was-retired');
    expect(sel).toContain(S.preset_choose);
  });

  it('NOTHING IS REWRITTEN ON RENDER — the stored value survives being displayed', async () => {
    // The same rule the STT language cell keeps: a settings screen that quietly
    // corrects a value leaves the user unable to see what their machine holds.
    model.llm.preset_id = 'lan-some-preset-that-was-retired';
    await render();
    expect(model.llm.preset_id).toBe('lan-some-preset-that-was-retired');
  });

  it('a RESOLVED preset gets no placeholder — the row exists only while it is needed', async () => {
    setLlmPreset('cloud-deepseek');
    const sel = presetSelect(await render());
    expect(sel).not.toContain(S.preset_choose);
    expect(optionValues(sel)).toContain('cloud-deepseek');
  });
});

describe('the dropdown cannot keep naming a vendor whose values have been edited away', () => {
  it('editing ANY config field moves the dropdown to `custom`', () => {
    setLlmPreset('cloud-openai');
    expect(model.llm.preset_id).toBe('cloud-openai');
    updateLlmField('endpoint', 'https://gateway.internal.example/v1');
    expect(model.llm.preset_id).toBe(CUSTOM_PRESET_ID);
    // The edit itself still landed — the jump is in addition to the write, not
    // instead of it.
    expect(model.llm.endpoint).toBe('https://gateway.internal.example/v1');
  });

  it.each(['protocol', 'endpoint', 'model', 'api_key'] as const)(
    'field %s is not exempt',
    (field) => {
      // Written as a table over the REAL field list rather than one example:
      // the defect is 「some field forgot to do this」, and one example proves
      // nothing about the other three.
      setLlmPreset('cloud-groq');
      updateLlmField(field, 'x');
      expect(model.llm.preset_id).toBe(CUSTOM_PRESET_ID);
    },
  );

  it('…and the jump is PERSISTED, not merely displayed', () => {
    // `pushLlm` writes the whole `model.llm`, preset_id included. A jump that
    // lived only in the DOM would come back naming the old vendor after a
    // restart — the same lie, delayed.
    setLlmPreset('cloud-openai');
    updateLlmField('model', 'some-other-model');
    expect(model.llm.preset_id).toBe(CUSTOM_PRESET_ID);
    // The custom row is a REAL catalogue entry, so the persisted id resolves —
    // it does not become the unknown-preset case above.
    expect(LLM_PRESETS.some((p) => p.id === model.llm.preset_id)).toBe(true);
  });

  it('…and the rendered menu follows the fields, not the last click', async () => {
    setLlmPreset('cloud-openai');
    updateLlmField('endpoint', 'https://gateway.internal.example/v1');
    const sel = presetSelect(await render());
    // The option the browser will display is the custom one, and no placeholder
    // appears — `custom` is a resolved preset, not an absence.
    expect(model.llm.preset_id).toBe(CUSTOM_PRESET_ID);
    expect(optionValues(sel)).toContain(CUSTOM_PRESET_ID);
    expect(sel).not.toContain(S.preset_choose);
  });
});

describe('the menu is sectioned, and the sections come from the catalogue', () => {
  it('renders one optgroup per non-empty group, in catalogue order', async () => {
    const sel = presetSelect(await render());
    expect(groupLabels(sel)).toEqual([
      S.preset_group_cloud, S.preset_group_local, S.preset_group_custom,
    ]);
  });

  it('every catalogue preset reaches the menu — none is stranded by its group', async () => {
    // The failure this catches is silent: a preset whose group is not in the
    // GROUPS array simply never gets a section, so it vanishes from the dropdown
    // while every type still checks.
    const sel = presetSelect(await render());
    const values = optionValues(sel);
    for (const p of LLM_PRESETS) expect(values, p.id).toContain(p.id);
  });

  it('the protocol select shows human labels but keeps the wire values', async () => {
    const html = await render();
    const open = html.indexOf('<select', html.indexOf(S.llm_protocol));
    const proto = html.slice(open, html.indexOf('</select>', open));
    expect(optionValues(proto)).toEqual(['openai-compatible', 'anthropic']);
    expect(proto).toContain(S.llm_protocol_openai);
    expect(proto).toContain(S.llm_protocol_anthropic);
  });
});
