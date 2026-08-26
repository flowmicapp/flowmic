// 「注入与输入」 — the standing clipboard disclosure (2026-08-26).
//
// Owner's requirement, verbatim: 「在界面上要提醒用户，在合适的地方要提醒用户说：
// 当前的应用可能会清空你原有剪贴板的内容 …… 不要影响它的正常的使用」. So the
// assertions here are not style checks: before this card there was no sentence
// anywhere in the product that told the user injection touches their clipboard.
//
// Three of them are shaped by mistakes this repo has already paid for:
//
//  · 【rendered result】 the copy is asserted through `renderToString`, not by
//    reading the catalogue. A string that exists and is never mounted is the
//    façade this repo has caught more than once — and it is why this section is
//    its own component rather than markup buried in SettingsPage.vue.
//  · 【all nine locales, from the registry】 hardcoding four locales is how the
//    2026-08-14 languages ran for a day with every guard silently not covering
//    them (see data-flow-disclosure.test.ts).
//  · 【the anchor must not rot】 this copy describes a MECHANISM that lives in
//    Rust. If the clipboard ever stops being the default road, every sentence
//    here becomes a lie the same day, and nothing in TypeScript would notice.
//    So the last test reads `inject/text_route.rs` and pins the default arm.
//    Anti-façade ④: a comment asserting behaviour elsewhere needs an anchor
//    that can be grepped, or a test. This is the test.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import InjectDisclosure from './components/InjectDisclosure.vue';
import { setLocale } from '../lib/strings';
import { UI_LOCALES, type UiLocale } from '../lib/strings/generated/locales.g';

const repo = (rel: string) => fileURLToPath(new URL('../../../../' + rel, import.meta.url));

async function renderIn(loc: UiLocale): Promise<string> {
  setLocale(loc);
  const html = await renderToString(createSSRApp(InjectDisclosure));
  setLocale('zh-CN');
  return html;
}

/** One phrase per locale that only the intended sentences can satisfy. Tables
 *  rather than 「contains the English word」 because a half-translated catalogue
 *  is exactly what nine-language copy is supposed to prevent. */
const MARKERS: Record<UiLocale, readonly string[]> = {
  'zh-CN': ['剪贴板', 'Ctrl+V', '放回去', '重要内容'],
  'zh-TW': ['剪貼簿', 'Ctrl+V', '放回去', '重要內容'],
  en: ['clipboard', 'Ctrl+V', 'straight back', 'Save anything important'],
  ja: ['クリップボード', 'Ctrl+V', '戻します', '大切な内容'],
  ko: ['클립보드', 'Ctrl+V', '되돌려', '중요한 내용'],
  fr: ['presse-papiers', 'Ctrl+V', 'aussitôt', 'important'],
  es: ['portapapeles', 'Ctrl+V', 'devuelve enseguida', 'importante'],
  de: ['Zwischenablage', 'Strg+V', 'wieder her', 'Wichtiges'],
  ru: ['буфер обмена', 'Ctrl+V', 'возвращает', 'Важное'],
};

describe('the standing clipboard disclosure', () => {
  it('🔴 says all three things in every shipped language, in the RENDERED markup', async () => {
    expect(UI_LOCALES.length).toBe(9);
    for (const loc of UI_LOCALES) {
      const html = await renderIn(loc);
      for (const marker of MARKERS[loc]) {
        expect(html, `${loc} is missing 「${marker}」`).toContain(marker);
      }
      // All three sentences must be present — a heading alone would be a
      // section that promises an explanation and gives none.
      expect(html.match(/<p class="hint"/g)?.length, `${loc} lost a paragraph`).toBe(2);
    }
  });

  it('names what can go wrong AND what to do about it, not just the mechanism', async () => {
    // The mechanism sentence on its own is a technical note. Owner's ruling was
    // that the user must be able to ACT — so the second paragraph has to admit
    // that restoration can fail and say to save a copy first. Asserted in the
    // two languages this session can actually proof-read.
    for (const [loc, must] of [
      ['zh-CN', ['无法完整恢复', '请先另存一份']],
      ['en', ['may not be fully restored', 'Save anything important']],
    ] as const) {
      const html = await renderIn(loc);
      for (const phrase of must) expect(html, `${loc}: ${phrase}`).toContain(phrase);
    }
  });

  it('is reachable: the section is registered in the page, not just written', () => {
    // 「a component was written but nobody mounts it」 is this repo's #1
    // historical bug class, and a settings section nobody can navigate to is
    // the same thing with a nicer shape.
    const page = readFileSync(repo('apps/desktop/src/main-window/SettingsPage.vue'), 'utf8');
    expect(page).toContain('<InjectDisclosure />');
    // The section ANCHOR lives in the page, not in the component. That is not a
    // style choice: timeline-data-group.test.ts proves 「every nav item has a
    // section and SECS order matches DOM order」 by reading this file's source,
    // and an id that moved into a child would be invisible to it (it went red
    // exactly that way while this card was being written).
    expect(page).toContain('id="set-inject"');
    expect(page).toMatch(/\{ id: 'inject', label: S\.set_nav_inject \}/);
    expect(page).toMatch(/type Sec =[^;]*'inject'/);
    // …and the heading the nav lands on is rendered from the same key the nav
    // item uses, so a half-added section (nav item, no heading) cannot pass.
    expect(page).toContain('{{ S.set_inject_title }}');
  });

  it('🔴 the mechanism it describes is still the default — pinned in Rust', () => {
    // If `route_text`'s last arm stops being a paste, this whole section is
    // false. Nothing in the TypeScript build could tell, so this reads the
    // decision itself.
    const route = readFileSync(repo('apps/desktop/src-tauri/src/inject/text_route.rs'), 'utf8');
    const body = route.slice(route.indexOf('pub fn route_text('));
    expect(body, 'route_text not found — the anchor moved').not.toBe('');
    const fallThrough = body.slice(0, body.indexOf('\n}'));
    expect(
      fallThrough.trimEnd().endsWith('TextRoute::Paste(PasteReason::DefaultPath)'),
      'the default inject route is no longer the clipboard — this settings copy is now a lie',
    ).toBe(true);

    // Ruler check: prove the scanner is looking at something real rather than
    // passing on an empty string. If `route_text` were renamed, `body` would be
    // the whole file and this would fail loudly instead of silently.
    expect(fallThrough).toContain('needs_ime_immune_path');
    expect(fallThrough).toContain('is_console_target');
    expect(fallThrough.length).toBeLessThan(1200);
  });
});
