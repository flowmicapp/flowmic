// 2026-11-10 — the two lines that still kept a FINISHED sentence in a ref, the
// shape FR-D2 fixed for the sign-in failure line (sign-in-failure-line.test.ts):
// Settings' autostart failure line (`autostartError`) and the timeline's batch-copy
// result line (`batchMsg`). A sentence built at failure / copy time stays in that
// moment's language after the user switches the interface language.
//
// Behaviour: each line is rendered with a client renderer through the same function
// the page uses, and the language is switched under it. The pages themselves are
// <template> SFCs that vitest compiles for SSR, so their wiring (keep the failure /
// the plan, build the sentence in a computed) is pinned by source anchors below,
// the same split sign-in-failure-line.test.ts uses.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { computed, createRenderer, h, nextTick, ref, ssrContextKey, type Component } from 'vue';
import { autostartFailureText, type AutostartFailure } from '../lib/autostart-reason';
import { S_BY_LOCALE, setLocale } from '../lib/strings';
import { TL_BATCH_MSG_CATALOGUES } from '../lib/strings/timeline';
import { resultMessage, type BatchCopyPlan } from './batch-copy';

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

/** A line component built the way each page builds its line: state in a ref, the
 *  sentence in a computed, the computed rendered. */
function lineOf<T>(state: T, toText: (s: T) => string): Component {
  return {
    setup() {
      const kept = ref(state);
      const line = computed(() => toText(kept.value as T));
      return () => h('div', line.value);
    },
  };
}

afterEach(() => setLocale('zh-CN'));

describe('the autostart failure line follows a language switch made after the failure', () => {
  for (const step of ['read', 'write'] as const) {
    it(`${step} failure`, async () => {
      setLocale('zh-CN');
      const failure: AutostartFailure = { step, reason: 'autostart_set_unrecognised_shape' };
      const tree = mount(lineOf(failure, autostartFailureText));
      const zh = S_BY_LOCALE['zh-CN'];
      const en = S_BY_LOCALE.en;
      const prefix = (s: typeof en) => (step === 'read' ? s.set_prefs_autostart_read_failed : s.set_prefs_autostart_failed);
      expect(textOf(tree)).toBe(`${prefix(zh)}${zh.set_prefs_autostart_unrecognised_shape}`);
      setLocale('en');
      await nextTick();
      expect(textOf(tree)).toBe(`${prefix(en)}${en.set_prefs_autostart_unrecognised_shape}`);
      expect(textOf(tree)).not.toMatch(/[一-鿿]/);
    });
  }

  it('a free-form bridge reason stays verbatim behind the switched prefix', async () => {
    setLocale('zh-CN');
    const tree = mount(lineOf<AutostartFailure>({ step: 'write', reason: 'os error 5' }, autostartFailureText));
    setLocale('en');
    await nextTick();
    expect(textOf(tree)).toBe(`${S_BY_LOCALE.en.set_prefs_autostart_failed}os error 5`);
  });
});

describe('the batch-copy result line follows a language switch made after the copy', () => {
  const plans: Array<[string, BatchCopyPlan, (c: (typeof TL_BATCH_MSG_CATALOGUES)['en']) => string]> = [
    ['copied', { text: 'a\nb', copied: 2, skippedImages: 0, selected: 2 } as BatchCopyPlan, (c) => c.copied(2)],
    ['copied with pictures skipped', { text: 'a', copied: 1, skippedImages: 1, selected: 2 } as BatchCopyPlan, (c) => c.copiedWithSkip(1, 1)],
    ['nothing to copy', { text: '', copied: 0, skippedImages: 2, selected: 2 } as BatchCopyPlan, (c) => c.nothingToCopy(2)],
  ];
  for (const [name, plan, expected] of plans) {
    it(name, async () => {
      setLocale('zh-CN');
      const tree = mount(lineOf(plan, resultMessage));
      expect(textOf(tree)).toBe(expected(TL_BATCH_MSG_CATALOGUES['zh-CN']));
      setLocale('en');
      await nextTick();
      expect(textOf(tree)).toBe(expected(TL_BATCH_MSG_CATALOGUES.en));
      expect(textOf(tree)).not.toBe(expected(TL_BATCH_MSG_CATALOGUES['zh-CN']));
    });
  }
});

describe('the pages keep the failure and the plan, not the sentence', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('SettingsPage builds autostartError in a computed from autostartFailure', () => {
    const src = read('./SettingsPage.vue');
    expect(src).toMatch(/const autostartError = computed\(/);
    expect(src).toContain('autostartFailureText(autostartFailure.value)');
    expect(src).toContain("autostartFailure.value = { step: 'read', reason: r.reason };");
    expect(src).toContain("autostartFailure.value = { step: 'write', reason: r.reason };");
    expect(src).not.toMatch(/autostartError\.value\s*=/);
  });

  it('TimelinePage builds batchMsg in a computed from batchResult', () => {
    const src = read('./TimelinePage.vue');
    expect(src).toMatch(/const batchMsg = computed\(/);
    expect(src).toContain('resultMessage(batchResult.value)');
    expect(src).not.toMatch(/batchMsg\.value\s*=/);
  });
});
