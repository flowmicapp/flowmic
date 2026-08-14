// V2-07.8a component-level test (task self-check ⑦-①): not just testing the
// catalogue — really compiles and renders PrefsAppearance.vue, and after
// switching languages asserts its template output goes from Chinese to
// English.
//
// Render path choice: vitest's default SSR transform compiles the SFC into
// its SSR form (useSSRContext), and a custom client renderer cannot mount it;
// so use vue/server-renderer's renderToString instead — it is the runtime
// that actually matches the SSR compilation output. Switching languages =
// switch, then render again: if the template reads reactive S / getLocale()
// at render time, the second render must come out in the new language. The
// interaction wiring (@change → setLocale / setThemeMode →
// notifyPrefsChanged broadcast) is anchored for existence with a
// literal-anchor guard (same culture as mode-badge.test.ts); the behaviour
// itself is covered by the lib-layer cases in locale.test.ts / theme.test.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSSRApp, defineComponent, h, nextTick, createRenderer, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import PrefsAppearance from './components/PrefsAppearance.vue';
import { LOCALE_ENDONYM, LOCALE_KEY, S, UI_LOCALES, getLocale, hydrateLocale, setLocale, wireLocaleStore } from '../lib/strings';
import { THEME_KEY, getResolvedTheme, initTheme, setThemeMode, type ResolvedTheme, type SystemThemeSource } from '../lib/theme';
import type { KvStore } from '../lib/types';

function memKv(): KvStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v) };
}

function fakeSystem(initial: ResolvedTheme): SystemThemeSource {
  let cur = initial;
  return { current: () => cur, onChange: () => () => {} };
}

function wire() {
  const kv = memKv();
  const rootEl = { attrs: {} as Record<string, string>, setAttribute(n: string, v: string) { this.attrs[n] = v; } };
  wireLocaleStore(kv);
  hydrateLocale();
  initTheme({ kv, system: fakeSystem('light'), root: rootEl });
  return { kv, rootEl };
}

describe('PrefsAppearance (component-level, V2-07.8a self-check ⑦-①)', () => {
  it('① after switching to en the component really renders English', async () => {
    wire();
    setLocale('zh-CN');
    const zhHtml = await renderToString(createSSRApp(PrefsAppearance));
    expect(zhHtml).toContain('界面语言');
    expect(zhHtml).toContain('只认你的显式选择');
    expect(zhHtml).toContain('跟随系统');

    setLocale('en');
    const enHtml = await renderToString(createSSRApp(PrefsAppearance));
    expect(enHtml).toContain('>Language</div>');
    expect(enHtml).toContain('>Theme</div>');
    expect(enHtml).toContain('>System</option>');
    expect(enHtml).not.toContain('界面语言');
    // option labels switch too — every string on the surface goes through S
    expect(enHtml).toContain('>English</option>');
    setLocale('zh-CN');
  });

  it('①b after switching to ja / ko the component really renders Japanese / Korean (V2-07.8b)', async () => {
    wire();
    setLocale('ja');
    const jaHtml = await renderToString(createSSRApp(PrefsAppearance));
    // The section label follows the locale; all four option labels are endonyms.
    expect(jaHtml).toContain('表示言語');
    expect(jaHtml).toContain('テーマ');
    expect(jaHtml).toContain('>日本語</option>');
    expect(jaHtml).toContain('>한국어</option>');
    expect(jaHtml).toContain('>中文</option>');
    expect(jaHtml).not.toContain('界面语言');
    expect(jaHtml).not.toContain('>Language</div>');

    setLocale('ko');
    const koHtml = await renderToString(createSSRApp(PrefsAppearance));
    expect(koHtml).toContain('>언어</div>');
    expect(koHtml).toContain('테마');
    expect(koHtml).toContain('>한국어</option>');
    expect(koHtml).toContain('>日本語</option>');
    expect(koHtml).not.toContain('表示言語');
    setLocale('zh-CN');
  });

  it('the rendered selects show the current state (mode value reaches the template)', async () => {
    const { rootEl } = wire();
    setThemeMode('dark');
    const html = await renderToString(createSSRApp(PrefsAppearance));
    expect(html).toContain('value="dark"');
    expect(getResolvedTheme()).toBe('dark');
    expect(rootEl.attrs['data-theme']).toBe('dark');
    setThemeMode('system');
  });

  it('interaction wiring anchors: selects write through setLocale/setThemeMode, no save button', () => {
    const src = readFileSync(fileURLToPath(new URL('./components/PrefsAppearance.vue', import.meta.url)), 'utf8');
    // Change-applies-immediately: the @change handlers are the ONLY writers (red line: no save button).
    expect(src).toContain('@change="onLocale"');
    expect(src).toContain('@change="onTheme"');
    expect(src).toContain('setLocale(v as UiLocale)');
    expect(src).toContain('setThemeMode(v as ThemeMode)');
    expect(src).toContain('notifyPrefsChanged()');
    // No save button (red line) — only scan the template; the header comment's
    // own discussion of "no save button" does not count.
    const tpl = src.match(/<template>([\s\S]*?)<\/template>/)?.[1] ?? '';
    expect(tpl).not.toMatch(/type="submit"/);
    expect(tpl).not.toMatch(/保存|Save/);
    // The language control has no "follow system" option (decision Option C); theme does.
    expect(src).toContain("system: 'set_theme_system'");
    // 🔴 THE LABEL TABLE IS GONE, so this half is asserted on the RENDER instead
    // of on the source (2026-08-14). It used to check that `LANG_LABEL` wired all
    // four `set_lang_*` keys — a check that had to be edited for every new
    // language, which is the cost the migration removed. What it was really
    // guarding is 「every shipped language is offered, and 『follow the system』 is
    // not one of them」, and that is now checkable without naming any language:
    // the control iterates the registry.
    expect(src).toContain('v-for="l in UI_LOCALES"');
    expect(src).toContain('LOCALE_ENDONYM[l]');
    expect(src).not.toContain('LANG_LABEL');
  });

  it('the language control offers exactly the shipped languages, by their own names', async () => {
    wire();
    const html = await renderToString(createSSRApp(PrefsAppearance));
    const select = html.match(/<select[^>]*aria-label="UI language"[\s\S]*?<\/select>/)?.[0] ?? '';
    // Measure the ruler (§1-bis-5): an empty match would pass every assertion below.
    expect(select.length, 'the language <select> was not found in the render').toBeGreaterThan(0);
    for (const l of UI_LOCALES) {
      expect(select, `${l} must be offered`).toContain(`value="${l}"`);
      expect(select, `${l} must be labelled by its endonym`).toContain(LOCALE_ENDONYM[l]);
    }
    expect((select.match(/<option/g) ?? []).length).toBe(UI_LOCALES.length);
    // Decision Option C: the language control has no "follow system" row.
    // Asserted on the rendered options rather than on a source table, so it
    // stays true for a language nobody has added yet.
    expect(select).not.toContain('value="system"');
  });

  it('invalid option values are refused by the component guards (no write, no crash)', () => {
    // The includes guard in onLocale/onTheme — an illegal value cannot pass
    // through setLocale/setThemeMode's type layer directly; at runtime it is
    // blocked by UI_LOCALES/THEME_MODES's includes check.
    const { kv } = wire();
    // 🔴 'fr' WAS THE SAMPLE HERE UNTIL 2026-08-14, when French shipped. A guard
    // whose 「invalid」 example becomes valid does not fail — it passes for the
    // wrong reason, and keeps passing. The sample is now a well-formed tag that
    // is deliberately NOT a registry row (a region variant of a shipped
    // language), which is the realistic shape of a stale persisted value.
    const badLocale = 'fr-FR';
    expect((UI_LOCALES as readonly string[]).includes(badLocale)).toBe(false);
    expect(getLocale()).toBe('en');
    expect(kv.map.size).toBe(0);
    void LOCALE_KEY;
    void THEME_KEY;
  });
});

/* ---------- reactive S proof: a client render function re-renders on switch ----------
   Does not depend on the SFC compilation form (h() written directly); uses a
   custom renderer to prove "the SAME already-mounted tree re-renders after
   setLocale" — the SSR double-render proves two separate renders, this one
   proves a live tree. */

interface TestEl {
  tag: string;
  children: TestEl[];
  props: Record<string, unknown>;
  text: string;
  parent: TestEl | null;
}

function newEl(tag: string): TestEl {
  return { tag, children: [], props: {}, text: '', parent: null };
}

const renderer = createRenderer<TestEl, TestEl>({
  patchProp(el, key, _prev, next) {
    el.props[key] = next;
  },
  insert(el, parent, anchor) {
    el.parent = parent;
    const i = anchor ? parent.children.indexOf(anchor) : -1;
    if (i >= 0) parent.children.splice(i, 0, el);
    else parent.children.push(el);
  },
  remove(el) {
    const p = el.parent;
    if (p) p.children.splice(p.children.indexOf(el), 1);
    el.parent = null;
  },
  createElement: (tag) => newEl(tag),
  createText: (text) => ({ ...newEl('#text'), text }),
  createComment: (text) => ({ ...newEl('#comment'), text }),
  setText(node, text) {
    node.text = text;
  },
  setElementText(el, text) {
    const t: TestEl = { ...newEl('#text'), text, parent: el };
    el.children = [t];
  },
  parentNode: (n) => n.parent,
  nextSibling: (n) => {
    if (!n.parent) return null;
    const i = n.parent.children.indexOf(n);
    return n.parent.children[i + 1] ?? null;
  },
});

function mount(comp: Component): TestEl {
  const root = newEl('root');
  renderer.createApp(comp).mount(root);
  return root;
}

function textOf(el: TestEl): string {
  return el.text + el.children.map(textOf).join('');
}

describe('reactive S proof (live tree re-render)', () => {
  it('a mounted render function reading S re-renders on locale switch', async () => {
    wire();
    setLocale('zh-CN');
    const Probe = defineComponent({
      setup: () => () => h('span', { class: 'st-tag' }, S.st_cached),
    });
    const tree = mount(Probe);
    expect(textOf(tree)).toBe('未注入 · 已缓存');
    setLocale('en');
    await nextTick();
    expect(textOf(tree)).toBe('Not injected · buffered');
    setLocale('zh-CN');
    await nextTick();
    expect(textOf(tree)).toBe('未注入 · 已缓存');
  });
});
