// docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §9:
//   "§7 warning — the sentence before export **really renders** (widget/component test, non-empty positive probe)"
//
// Render path is the same as prefs-appearance.test.ts: vitest compiles the SFC
// into its SSR form, so vue/server-renderer's renderToString runs the actual
// template rather than grepping the source string — "the copy is in the
// catalogue" and "the copy is on screen" are two different questions, and
// this repo has already paid for that distinction once.
//
// ⚠️ onMounted does not run under SSR, so what is seen here is the **first
// frame**: exactly the screen the user sees before pressing export, and
// exactly where §7-1 requires that sentence to be.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import DataPortability from './components/DataPortability.vue';
import { PORTABLE_STRINGS } from '../lib/strings/portable';
import { S, setLocale, wireLocaleStore } from '../lib/strings';
import { UI_LOCALES } from '../lib/strings/locale';

function render(): Promise<string> {
  return renderToString(createSSRApp(DataPortability));
}

describe('Settings → Data (book 16 §7\'s warning obligation)', () => {
  it('🔴 the plaintext warning sentence really appears on the screen the export button is on', async () => {
    wireLocaleStore(null);
    setLocale('zh-CN');
    const html = await render();
    // Non-empty positive probe: first prove something was actually rendered.
    expect(html.length).toBeGreaterThan(200);
    expect(html).toContain(S.pd_export_title);
    // …and only then the sentence itself.
    expect(html).toContain(PORTABLE_STRINGS['zh-CN'].pd_plain_warning);
    expect(html).toContain('谁拿到都能看');
    // §7-2 "the destination is the user's choice": the 2026-08-02 rework
    // demoted it from a standing paragraph to **the export button's
    // tooltip** (mockup §1.4 — it describes the dialog that button opens, so
    // it hangs off that button). An empty store's first frame has no export
    // button ⇒ the render assertion switches to the source face: the binding
    // is really on the button.
    const src = readFileSync(
      fileURLToPath(new URL('./components/DataPortability.vue', import.meta.url)),
      'utf8',
    );
    expect(src).toMatch(/:title="S\.pd_pick_hint"[^>]*@click="doExport"/s);
  });

  it('switching to English changes the sentence\'s language too (not a hard-coded Chinese literal)', async () => {
    wireLocaleStore(null);
    setLocale('en');
    const html = await render();
    expect(html).toContain(PORTABLE_STRINGS.en.pd_plain_warning);
    expect(html).not.toContain(PORTABLE_STRINGS['zh-CN'].pd_plain_warning);
    setLocale('zh-CN');
  });

  it('the sentence is non-empty in all four UI languages', () => {
    // Rendering four times would be slow and unnecessary; what this guards is
    // "one language forgot to write it" — the locale-parity test guards the
    // key set, this one guards this sentence's content strength.
    for (const loc of UI_LOCALES) {
      const w = PORTABLE_STRINGS[loc].pd_plain_warning;
      expect(w.trim().length, loc).toBeGreaterThan(10);
      // ⛔ The kind of consequence-less phrasing §7-1 explicitly bans.
      expect(w, loc).not.toContain('妥善保管');
      expect(w.toLowerCase(), loc).not.toContain('keep it safe');
    }
  });

  it('the import report\'s wording distinguishes "complete" from "partially complete" — both sentences are really in the template', () => {
    // A component test can only reach the first frame (the report only
    // appears after the button is pressed), so this test uses a literal
    // anchor to guard the ternary's presence in the template (same culture as
    // mode-badge.test.ts); the behaviour itself is covered by
    // lib/portable/import.test.ts's isPartial cases.
    const src = readFileSync(
      fileURLToPath(new URL('./components/DataPortability.vue', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('partial ? S.pd_import_partial : S.pd_import_done');
    // A refused row's reason is rendered per-item, not as one blanket "format error."
    expect(src).toContain('refusalText(r.reason)');
  });
});
