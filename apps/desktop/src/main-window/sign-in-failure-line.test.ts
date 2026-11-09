// FR-D2 (D-MKT-7): an English Devices page showed the Chinese sentence 登录已超时
// in its red line. The sign-in had failed while the interface was in Chinese, and
// the guide kept the finished sentence in a ref, so switching the language left it
// behind until FlowMic restarted.
//
// Mounts the real line with a client renderer and switches the language under it.
// The guide's own wiring is a <template> SFC that vitest compiles for SSR, so that
// half is pinned by source anchors at the bottom (signin-waiting.test.ts, same split).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createRenderer, h, nextTick, ssrContextKey, type Component } from 'vue';
import SignInFailureLine from './components/SignInFailureLine.vue';
import { S_BY_LOCALE, setLocale } from '../lib/strings';

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
  app.provide(ssrContextKey, {});
  app.mount(root);
  return root;
}
const textOf = (el: TestEl): string => el.text + el.children.map(textOf).join('');

afterEach(() => setLocale('zh-CN'));

describe('the red line under a failed sign-in', () => {
  it('follows a language switch made after the failure', async () => {
    setLocale('zh-CN');
    const tree = mount(SignInFailureLine, { failure: { reason: 'TIMEOUT' } });
    expect(textOf(tree)).toBe(S_BY_LOCALE['zh-CN'].cloud_signin_err_timeout);
    setLocale('en');
    await nextTick();
    expect(textOf(tree)).toBe(S_BY_LOCALE.en.cloud_signin_err_timeout);
    expect(textOf(tree)).not.toContain('登录');
  });

  it('renders nothing when nothing failed', () => {
    setLocale('en');
    expect(textOf(mount(SignInFailureLine, { failure: null }))).toBe('');
  });
});

describe('the guide keeps the code, not the sentence', () => {
  const GUIDE = readFileSync(
    fileURLToPath(new URL('./components/CloudSignInGuide.vue', import.meta.url)),
    'utf8',
  );

  it('renders the line from the failure it holds', () => {
    expect(GUIDE).toContain('<SignInFailureLine :failure="signInFailure"');
  });

  it('nothing in it turns a code into a sentence ahead of the render', () => {
    // Positive control: the two writers of the fact are still there.
    expect(GUIDE.match(/signInFailure\.value = \{ reason: /g)).toHaveLength(2);
    expect(GUIDE).not.toContain('signInFailureText(');
  });
});
