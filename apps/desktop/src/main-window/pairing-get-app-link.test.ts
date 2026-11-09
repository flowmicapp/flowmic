// FR-D1 (first-run walk on a fresh 0.3.120, 2026-11-06): the pairing dialog told
// a new user "you will need the FlowMic app on your phone" and gave them no way
// to get it. The link's destination was an empty constant, so it never rendered.
//
// The deliverable is "what clicking does" (CLAUDE.md D-40, law L-1), so these
// cases MOUNT the real link component with a client renderer, click it, and read
// what reached the single external-link door and what the tree says afterwards.
// PairingModal itself is a <template> SFC, which vitest compiles to its SSR form
// and which no click can reach (see prefs-appearance.test.ts's header), so the
// modal's half is asserted on its rendered HTML: the link is on both tabs, in
// every shipped language.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, createSSRApp, h, nextTick, ssrContextKey, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import GetAppLink from './components/GetAppLink.vue';
import PairingModal from './components/PairingModal.vue';
import { EMPTY_CLOUD_STATUS } from '../lib/channel';
import { S, UI_LOCALES, setLocale } from '../lib/strings';
import { downloadUrl } from '../lib/site-guide';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

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

function mount(comp: Component): TestEl {
  const root = newEl('root');
  const app = renderer.createApp({ render: () => h(comp) });
  app.provide(ssrContextKey, {});
  app.mount(root);
  return root;
}
const textOf = (el: TestEl): string => el.text + el.children.map(textOf).join('');
function find(el: TestEl, tag: string): TestEl | null {
  if (el.tag === tag) return el;
  for (const c of el.children) {
    const hit = find(c, tag);
    if (hit) return hit;
  }
  return null;
}
async function press(link: TestEl): Promise<void> {
  void (link.props.onClick as (e: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} });
  await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
  await nextTick();
  await nextTick();
}

beforeEach(() => {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  invokeMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLocale('zh-CN');
});

describe('"Get the app": what clicking does', () => {
  it('hands the download page, in the interface language, to the one external-link door', async () => {
    invokeMock.mockResolvedValue(true);
    setLocale('en');
    const link = find(mount(GetAppLink), 'a')!;
    expect(textOf(link)).toBe(S.pair_get_app);
    await press(link);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'open_external_url')).toEqual([
      ['open_external_url', { url: 'https://flowmic.app/download' }],
    ]);
  });

  it('a language switch while the dialog is open moves the destination with it', async () => {
    invokeMock.mockResolvedValue(true);
    setLocale('en');
    const link = find(mount(GetAppLink), 'a')!;
    setLocale('de');
    await nextTick();
    await press(link);
    expect(invokeMock).toHaveBeenCalledWith('open_external_url', { url: 'https://flowmic.app/de/download' });
  });

  it('when the browser cannot be opened the reader gets the address on screen', async () => {
    invokeMock.mockRejectedValue('no handler');
    setLocale('en');
    const tree = mount(GetAppLink);
    expect(textOf(tree), 'no failure line before the click').not.toContain(S.ext_open_failed);
    await press(find(tree, 'a')!);
    await vi.waitFor(() => expect(textOf(tree)).toContain(S.ext_open_failed));
    expect(textOf(tree)).toContain('https://flowmic.app/download');
  });
});

describe('the address follows the website routing', () => {
  it('English has no prefix, every other shipped language has its lowercase one', () => {
    expect(downloadUrl('en')).toBe('https://flowmic.app/download');
    expect(downloadUrl('zh-CN')).toBe('https://flowmic.app/zh-cn/download');
    expect(downloadUrl('zh-TW')).toBe('https://flowmic.app/zh-tw/download');
    expect(downloadUrl('ru')).toBe('https://flowmic.app/ru/download');
  });
});

describe('PairingModal carries the link', () => {
  const INFO = {
    short_code: '1234',
    endpoint: 'http://192.168.1.5:41879',
    pc_name: 'DESKTOP-MAIN',
    connected: true,
    mobiles: 0,
    expires_in_ms: null,
  } as const;

  for (const channel of ['lan', 'cloud'] as const) {
    it(`on the ${channel} tab, in every shipped language`, async () => {
      for (const code of UI_LOCALES) {
        setLocale(code);
        const html = await renderToString(createSSRApp(PairingModal, {
          open: true,
          info: { ...INFO, channel },
          channel,
          cloud: { ...EMPTY_CLOUD_STATUS },
        }));
        const href = downloadUrl(code).replace(/[/.]/g, '\\$&');
        expect(html, `${code}: no link to the download page`).toMatch(new RegExp(`<a[^>]*href="${href}"[^>]*>`));
        expect(html, `${code}: link label missing`).toContain(S.pair_get_app.replace(/'/g, '&#39;'));
      }
    });
  }
});
