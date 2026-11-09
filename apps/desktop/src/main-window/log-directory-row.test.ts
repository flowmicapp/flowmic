// FR-D2 (first-run walk on a fresh 0.3.120, 2026-11-06): Settings > About on Linux
// showed %LOCALAPPDATA%\FlowMic\ as the folder holding the logs. That was a catalogue
// string, the same in every language and on every platform. And when the folder
// could not be opened, the reason printed under the failure line was a Chinese
// sentence from Rust, whatever the interface language.
//
// Mounts the real row and presses the real button.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ssrContextKey, type Component } from 'vue';
import LogDirectoryRow from './components/LogDirectoryRow.vue';
import { S, S_BY_LOCALE, UI_LOCALES, setLocale } from '../lib/strings';

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
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await nextTick();
};

const LINUX_DIR = '/home/reader/.local/state/FlowMic';

beforeEach(() => {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  invokeMock.mockReset();
  setLocale('en');
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLocale('zh-CN');
});

describe('the logs row in Settings > About', () => {
  it('shows the folder the running app answers with', async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === 'log_directory_path' ? LINUX_DIR : undefined));
    const tree = mount(LogDirectoryRow);
    await settle();
    expect(textOf(tree)).toContain(LINUX_DIR);
    expect(textOf(tree)).not.toContain('LOCALAPPDATA');
    expect(textOf(find(tree, 'button')!)).toBe(S.set_about_log_open);
  });

  it('shows no address when the app cannot answer, and the button still works', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'log_directory_path') throw new Error('no such command');
      return true;
    });
    const tree = mount(LogDirectoryRow);
    await settle();
    expect(textOf(tree)).toBe(S.set_about_log_open);
    void (find(tree, 'button')!.props.onClick as () => Promise<void>)();
    await settle();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === 'open_log_directory')).toBe(true);
    expect(textOf(tree)).not.toContain(S.set_about_log_open_failed);
  });

  it('a failed open shows the failure line and the address, never the developer reason', async () => {
    const REASON = 'log directory missing: raw developer text';
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'log_directory_path') return LINUX_DIR;
      if (cmd === 'open_log_directory') throw new Error(REASON);
      return undefined;
    });
    const tree = mount(LogDirectoryRow);
    await settle();
    void (find(tree, 'button')!.props.onClick as () => Promise<void>)();
    await settle();
    const seen = textOf(tree);
    expect(seen).toContain(S.set_about_log_open_failed);
    expect(seen.split(LINUX_DIR).length, 'on the row and on the failure line').toBe(3);
    expect(seen).not.toContain(REASON);
    expect(
      invokeMock.mock.calls.some(([cmd, a]) => cmd === 'append_forensic' && JSON.stringify(a).includes(REASON)),
      'the reason goes to the forensic log instead',
    ).toBe(true);
  });
});

describe('nothing else can spell the Windows folder', () => {
  it('no language carries a log path string any more', () => {
    for (const code of UI_LOCALES) {
      expect(JSON.stringify(S_BY_LOCALE[code]), code).not.toContain('LOCALAPPDATA');
    }
  });

  it('the errors Rust gives for a failed open are not in Chinese', () => {
    const rust = readFileSync(
      fileURLToPath(new URL('../../src-tauri/src/shell/log_dir.rs', import.meta.url)),
      'utf8',
    );
    expect(rust).toContain('fn open_log_directory'); // control
    const code = rust.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/[㐀-鿿]/);
  });

  it('SettingsPage renders this row', () => {
    const page = readFileSync(fileURLToPath(new URL('./SettingsPage.vue', import.meta.url)), 'utf8');
    expect(page).toContain('<LogDirectoryRow />');
  });
});
