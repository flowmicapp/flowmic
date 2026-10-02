import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, createSSRApp, h, nextTick, ssrContextKey, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import SettingsPage from './SettingsPage.vue';
import OpenSourceLicenses from './components/OpenSourceLicenses.vue';
import { S, setLocale } from '../lib/strings';

interface TestEl {
  tag: string;
  children: TestEl[];
  props: Record<string, unknown>;
  text: string;
  parent: TestEl | null;
}
const newEl = (tag: string): TestEl => ({ tag, children: [], props: {}, text: '', parent: null });

const renderer = createRenderer<TestEl, TestEl>({
  patchProp(el, key, _prev, next) { el.props[key] = next; },
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
  setText(node, text) { node.text = text; },
  setElementText(el, text) { el.children = [{ ...newEl('#text'), text, parent: el }]; },
  parentNode: (n) => n.parent,
  nextSibling: (n) => {
    if (!n.parent) return null;
    return n.parent.children[n.parent.children.indexOf(n) + 1] ?? null;
  },
});

function mount(comp: Component, props: Record<string, unknown>): TestEl {
  const root = newEl('root');
  const app = renderer.createApp({ render: () => h(comp, props) });
  // vitest's node environment transforms .vue in SSR mode, and vite-plugin-vue's SSR
  // output registers every component's module into `useSSRContext()` from its
  // setup (`ssrContext.modules`), which is undefined on a client renderer and
  // throws. Providing the key is the whole shim; nothing else in the tree is faked.
  app.provide(ssrContextKey, {});
  app.mount(root);
  return root;
}
const textOf = (el: TestEl): string => el.text + el.children.map(textOf).join('');
function findAll(el: TestEl, pred: (e: TestEl) => boolean, out: TestEl[] = []): TestEl[] {
  if (pred(el)) out.push(el);
  for (const c of el.children) findAll(c, pred, out);
  return out;
}
const buttons = (tree: TestEl): TestEl[] => findAll(tree, (e) => e.tag === 'button');
const toggle = (tree: TestEl): TestEl => buttons(tree)[0]!;
const click = (el: TestEl): void => (el.props.onClick as () => void)();


afterEach(() => { vi.unstubAllGlobals(); setLocale('zh-CN'); });

describe('Settings About bundled NOTICE', () => {
  it('places the license entry beside the real version in Settings', async () => {
    const html = await renderToString(createSSRApp(SettingsPage));
    const about = html.slice(html.indexOf('id="set-about"'), html.indexOf('id="set-privacy"'));
    expect(about).toContain(S.set_about_version);
    expect(about).toContain(S.openSourceLicenses);
    expect(about).toContain('id="licenses-toggle"');
  });

  it('clicking the entry opens the complete bundled NOTICE without a request and closes it again', async () => {
    setLocale('en');
    const fetch = vi.fn(() => { throw new Error('Unexpected network request'); });
    vi.stubGlobal('fetch', fetch);
    const tree = mount(OpenSourceLicenses, {});
    expect(textOf(tree)).toContain(S.openSourceLicenses);
    expect(findAll(tree, e => e.tag === 'pre')).toHaveLength(0);
    expect(toggle(tree).props['aria-expanded']).toBe('false');
    click(toggle(tree));
    await nextTick();
    const view = findAll(tree, e => e.tag === 'pre')[0]!;
    expect(view).toBeDefined();
    expect(textOf(view)).toContain('socket.io');
    expect(textOf(view)).toBe(readFileSync(new URL('../../../../NOTICE', import.meta.url), 'utf8'));
    expect(view.props.tabindex).toBe(0);
    expect(toggle(tree).props['aria-expanded']).toBe('true');
    expect(fetch).not.toHaveBeenCalled();
    click(toggle(tree));
    await nextTick();
    expect(findAll(tree, e => e.tag === 'pre')).toHaveLength(0);
  });
});
