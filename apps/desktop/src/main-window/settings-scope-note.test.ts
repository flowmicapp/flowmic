// E6 (2026-09-02) — `S.settings_scope_lan` said, verbatim, that the settings on
// its page "have no effect on the cloud relay." That was true for every one of
// its three renderers (LlmSettings.vue / llm.config, ScenarioInference.vue /
// scenario.inference, SttSettings.vue / stt.routings) until owner 2026-08-24
// moved three of SttSettings.vue's OTHER controls — dictionary/polish/refine —
// onto BOTH legs (settings_route.rs PREFERENCE_SETTING_KEYS). SttSettings.vue
// kept showing the universal "no effect" sentence above all four of its
// sections, which became false for three of them: a cloud-relay user's
// dictionary/polish/refine edits DO reach the relay, and the page told them
// otherwise.
//
// This file pins BOTH halves of the fix: SttSettings.vue now renders the new,
// accurate `stt_settings_scope_note` (and not the old universal claim), while
// the two single-topic pages keep `settings_scope_lan` unchanged because it is
// still true for them. It also reads settings_route.rs's own source so the
// claim about which keys are which cannot drift silently a second time.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

import SttSettings from './components/SttSettings.vue';
import LlmSettings from './components/LlmSettings.vue';
import ScenarioInference from './components/ScenarioInference.vue';
import { model } from './settings-model';
import { resetModelStoreForTest } from '../lib/model-client';
import { setLocale } from '../lib/strings';

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

beforeEach(() => {
  setLocale('en');
  model.routings = [];
  resetModelStoreForTest();
});

describe('E6 — the scope note tells the truth about which legs a control reaches', () => {
  // ⚠️ Substrings below deliberately avoid `"` / `'` — SSR HTML-escapes both
  // (to `&quot;` / `&#39;`), so a raw `toContain(S.some_key)` comparison against
  // rendered output fails on the escaping alone, not on the copy (0.2.53's
  // "know your ruler" lesson, one character class over).
  it('SttSettings.vue shows the mixed-scope note, not the universal "no effect" claim', async () => {
    const html = await renderToString(createSSRApp(SttSettings));
    expect(html).toContain('configures only the');
    expect(html).toContain('Local LAN');
    expect(html).toContain('apply to both channels');
    // The universal claim SttSettings.vue used to render — false since 08-24
    // for the dictionary/polish/refine sections on this same page.
    expect(html).not.toContain('have no effect on the cloud relay');
  });

  it('LlmSettings.vue keeps settings_scope_lan — llm.config really is still LAN-only', async () => {
    const html = await renderToString(createSSRApp(LlmSettings));
    expect(html).toContain('have no effect on the cloud relay');
  });

  it('ScenarioInference.vue keeps settings_scope_lan — scenario.inference really is still LAN-only', async () => {
    const html = await renderToString(createSSRApp(ScenarioInference));
    expect(html).toContain('have no effect on the cloud relay');
  });

  // Anchor: if a future change adds/removes a key from PREFERENCE_SETTING_KEYS,
  // this is the tripwire that says the two scope notes above need a re-read —
  // grep-able per CLAUDE.md's rule for comments that assert behaviour elsewhere.
  it('settings_route.rs still routes exactly stt.dictionary/stt.polish/stt.refine/scenario.card to both legs', () => {
    const rs = src('../../src-tauri/src/shell/settings_route.rs');
    const prefBlock = rs.slice(
      rs.indexOf('const PREFERENCE_SETTING_KEYS'),
      rs.indexOf('];', rs.indexOf('const PREFERENCE_SETTING_KEYS')),
    );
    for (const key of ['"stt.dictionary"', '"stt.polish"', '"stt.refine"', '"scenario.card"']) {
      expect(prefBlock, `${key} should still be in PREFERENCE_SETTING_KEYS`).toContain(key);
    }
    // The two keys the "still LAN-only" tests above depend on must NOT be in
    // that list — if either moves to both legs, settings_scope_lan on
    // LlmSettings.vue / ScenarioInference.vue becomes the next stale claim.
    for (const key of ['"llm.config"', '"scenario.inference"']) {
      expect(prefBlock, `${key} must stay OUT of PREFERENCE_SETTING_KEYS for the LAN-only tests above to hold`)
        .not.toContain(key);
    }
  });
});
