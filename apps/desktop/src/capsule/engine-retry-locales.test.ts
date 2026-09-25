// NR-96-C copy landing (2026-09-24) — the capsule's engine cell with the LANDED
// counted sentence, in every UI locale, through the real SFC.
//
// `engine-status-loading.test.ts` pins the wiring in the default locale only.
// This file switches the UI locale the way the settings page does
// (`setLocale`) and reads the rendered cell, so a locale whose sentence lost a
// placeholder, or whose catalogue row did not reach the cell, goes red here.
//
// What it cannot answer: whether the cell's text fits. SSR has no layout, so
// "does the German string fit the row" is a real-browser question. The cell's
// value span (`.diag .drow .v`, src/styles/capsule.css) carries no nowrap, no
// ellipsis and no overflow rule, so it wraps rather than clips; the card report
// records the one-off WebView2-engine measurement of all nine locales.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import CapsuleApp from './CapsuleApp.vue';
import { fireRealAudioStartForTest, onEngineStatus, state } from './controller';
import { S } from '../lib/strings';
import { DEFAULT_LOCALE, UI_LOCALES, setLocale } from '../lib/strings/locale';

/** The locale's catalogue row, read from the i18n source file rather than
 *  through S, so a locale switch that never reached S cannot agree with itself. */
function catalogue(locale: string, key: string): string {
  const file = new URL(`../../../../i18n/desktop/${locale}.json`, import.meta.url);
  const raw = (JSON.parse(readFileSync(file, 'utf8')) as { strings: Record<string, string> }).strings[key]!;
  return raw.slice(1, -1).replace(/\\'/g, "'");
}

async function engineValue(): Promise<string> {
  state.diagOpen = true;
  const html = await renderToString(createSSRApp(CapsuleApp));
  const row = html.split('<div class="drow"').find((chunk) => chunk.includes(S.cap_stt_label));
  if (row === undefined) throw new Error('engine diagnostic row not rendered');
  const value = /<span class="v"[^>]*>([\s\S]*?)<\/span>/.exec(row);
  if (!value) throw new Error(`engine row shape changed; row was:\n${row}`);
  return value[1]!.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

beforeEach(() => {
  state.engineProvider = '';
  state.engineStatus = '';
  state.engineKnown = false;
  state.engineRetry = null;
  state.engineSilent = false;
  state.diagOpen = false;
  fireRealAudioStartForTest({ mode: 'realtime' });
});

afterEach(() => {
  setLocale(DEFAULT_LOCALE);
});

describe('capsule engine cell — the counted sentence in every locale', () => {
  for (const locale of UI_LOCALES) {
    it(`${locale}: both counted forms render whole, numbers filled`, async () => {
      setLocale(locale);
      onEngineStatus({ provider: 'soniox', status: 'reconnecting', retry_count: 2, retry_max: 5, retry_in_ms: 2_000, attempt_timeout_ms: 5_000 });
      const bounded = await engineValue();
      expect(bounded).toBe(catalogue(locale, 'cap_stt_reconnecting_n_of').replace('{n}', '2').replace('{max}', '5'));
      onEngineStatus({ provider: 'soniox', status: 'reconnecting', retry_count: 3, retry_in_ms: 2_000, attempt_timeout_ms: 5_000 });
      const open = await engineValue();
      expect(open).toBe(catalogue(locale, 'cap_stt_reconnecting_n').replace('{n}', '3'));
      for (const v of [bounded, open]) {
        expect(v, `${locale}: a placeholder reached the screen`).not.toMatch(/\{n\}|\{max\}/);
        expect(v, `${locale}: the DEV placeholder is still in the catalogue`).not.toContain('DEV:');
      }
      expect(bounded).toContain('2');
      expect(bounded).toContain('5');
      expect(open).toContain('3');
    });
  }
});
