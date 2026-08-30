import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { injectProvenanceTooltip } from './inject-provenance';
import { S, S_BY_LOCALE } from './strings';
import { UI_LOCALES, type UiLocale } from './strings/locale';

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// zh-CN template kept byte-identical to what this function hardcoded before
// the 2026-08-30 localization fix — see that file's header.
const ZH_TEMPLATE = '注入到 {title} · {when}';

describe('injectProvenanceTooltip (T-7)', () => {
  it('returns null when status is not injected', () => {
    expect(
      injectProvenanceTooltip(
        'cached',
        {
          window_title: 'WeChat',
          process_name: 'WeChat',
          injected_at: '2026-07-25T10:00:00.000Z',
        },
        ZH_TEMPLATE,
      ),
    ).toBeNull();
  });

  it('returns null when target or injected_at is missing (never fabricates)', () => {
    expect(injectProvenanceTooltip('injected', null, ZH_TEMPLATE)).toBeNull();
    expect(
      injectProvenanceTooltip(
        'injected',
        {
          window_title: 'WeChat',
          process_name: 'WeChat',
        },
        ZH_TEMPLATE,
      ),
    ).toBeNull();
    expect(
      injectProvenanceTooltip(
        'injected',
        {
          window_title: 'WeChat',
          process_name: 'WeChat',
          injected_at: '',
        },
        ZH_TEMPLATE,
      ),
    ).toBeNull();
    expect(
      injectProvenanceTooltip(
        'injected',
        {
          window_title: '',
          process_name: '',
          injected_at: '2026-07-25T10:00:00.000Z',
        },
        ZH_TEMPLATE,
      ),
    ).toBeNull();
  });

  it('formats "Injected into {title} · {time}" (注入到 {title} · {time}) from real fields', () => {
    const tip = injectProvenanceTooltip(
      'injected',
      {
        window_title: 'Outlook',
        process_name: 'OUTLOOK',
        injected_at: '2026-07-25T10:00:00.000Z',
      },
      ZH_TEMPLATE,
    );
    expect(tip).toMatch(/^注入到 Outlook · /);
  });

  it('falls back to process_name when window_title is empty', () => {
    const tip = injectProvenanceTooltip(
      'injected',
      {
        window_title: '',
        process_name: 'WeChat',
        injected_at: '2026-07-25T10:00:00.000Z',
      },
      ZH_TEMPLATE,
    );
    expect(tip).toMatch(/^注入到 WeChat · /);
  });
});

// ── 2026-08-30 owner defect sweep ────────────────────────────────────────────
// Before this fix, `injectProvenanceTooltip` hardcoded the Chinese template
// (`` `注入到 ${title} · ${when}` ``) regardless of UI locale — the TimelinePage
// hover tooltip on every 「injected」 row was Chinese under every non-zh-CN UI
// language. The fix moved the template to the S catalogue (`S.injected_into`,
// lib/strings/timeline.ts) and TimelinePage.vue now passes it in
// (`injectProvenanceTooltip(e.status, e.target, S.injected_into)`).
const CJK = /[㐀-鿿]/;
const TARGET = {
  window_title: 'Outlook',
  process_name: 'OUTLOOK',
  injected_at: '2026-07-25T10:00:00.000Z',
};

describe('injectProvenanceTooltip localizes with the UI locale template (owner 2026-08-30)', () => {
  it('en template: tooltip contains no CJK characters and reads in English', () => {
    const tip = injectProvenanceTooltip('injected', TARGET, S_BY_LOCALE.en.injected_into);
    expect(tip, 'en tooltip must not contain any CJK character').not.toMatch(CJK);
    expect(tip).toContain('Injected into Outlook');
  });

  it('🔴 positive control: the SAME probe against the zh-CN template DOES find CJK — proves the regex is not blind', () => {
    const tip = injectProvenanceTooltip('injected', TARGET, S_BY_LOCALE['zh-CN'].injected_into);
    expect(tip, 'zh-CN tooltip should still contain CJK').toMatch(CJK);
    expect(tip).toContain('注入到 Outlook');
  });

  it('every one of the nine UI locales’ template renders its own words with {title}/{when} filled in, not a bare placeholder', () => {
    for (const loc of UI_LOCALES as readonly UiLocale[]) {
      const template = S_BY_LOCALE[loc].injected_into;
      const tip = injectProvenanceTooltip('injected', TARGET, template);
      expect(tip, `${loc}: tooltip must be non-null`).not.toBeNull();
      expect(tip, `${loc}: {title} was not substituted`).not.toContain('{title}');
      expect(tip, `${loc}: {when} was not substituted`).not.toContain('{when}');
      expect(tip, `${loc}: window title missing from tooltip`).toContain('Outlook');
    }
  });

  it('TimelinePage really passes S.injected_into, not a hardcoded template (grep, not a snapshot of intent)', () => {
    const page = src('../main-window/TimelinePage.vue');
    expect(page).toContain('injectProvenanceTooltip(e.status, e.target, S.injected_into)');
  });

  it('S (the live reactive catalogue) exposes injected_into — the same key TimelinePage reads', () => {
    expect(typeof S.injected_into).toBe('string');
    expect(S.injected_into.length).toBeGreaterThan(0);
  });
});
