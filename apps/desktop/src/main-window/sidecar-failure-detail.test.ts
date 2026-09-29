// NR-120 — the failed local service must not hand the user the developer's
// sentence. `SidecarStatus.detail` (`spawn failed: …`, an old host Node's
// complaint) is English-only text written for the forensic log; the owner met it
// verbatim on the LAN card on Ubuntu (screenshot 2026-09-28).
//
// The deliverable is 「what the user sees on that card」, so these cases MOUNT the
// real component the card renders (SidecarFailureDetail.vue), click its real
// toggle, and read the rendered tree — not a hand-built stand-in and not the
// component's props. Why a custom renderer rather than renderToString: an SSR
// pass cannot click, and `not.toContain(raw)` on a collapsed <details> is void
// anyway (its body is in the HTML, merely not painted). The component is a
// render-function SFC so it compiles identically for both renderers; see its
// header and prefs-appearance.test.ts.
//
// ── 🔴 REVERSE CONTROL, ACTUALLY RUN (file-scoped, name in the command) ─────
//   `render the raw text inline again`: in SidecarFailureDetail.vue the body
//   guard `open.value ? h('div', …) : null` was replaced with `true ? h('div', …) : null`
//   and only this file re-run:
//     (cd apps/desktop) pnpm exec vitest run src/main-window/sidecar-failure-detail.test.ts
//   RED: 2 failed | 2 passed — `expected 'Technical detail▾spawn failed: node: …' not to contain
//   'spawn failed: node: /lib/x86_64-linux…'` on the collapsed and the fold-again cases;
//   restored ⇒ same command 4 passed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ssrContextKey, type Component } from 'vue';
import SidecarFailureDetail from './components/SidecarFailureDetail.vue';
import { S, setLocale } from '../lib/strings';

const RAW = 'spawn failed: node: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38\' not found';

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

afterEach(() => { vi.unstubAllGlobals(); });

describe('NR-120 — the failed local service folds the developer text', () => {
  it('collapsed (the default): the raw developer text is nowhere in the rendered tree', () => {
    setLocale('en');
    const tree = mount(SidecarFailureDetail, { detail: RAW });
    // positive control: the toggle IS rendered, so an empty tree cannot pass this
    expect(textOf(tree)).toContain(S.model_detail);
    expect(toggle(tree).props['aria-expanded']).toBe('false');
    expect(textOf(tree)).not.toContain(RAW);
    expect(textOf(tree)).not.toContain('GLIBC');
    expect(buttons(tree)).toHaveLength(1); // no copy button either while folded
  });

  it('expanding shows the raw text and a copy button; folding again removes it', async () => {
    setLocale('en');
    const tree = mount(SidecarFailureDetail, { detail: RAW });
    click(toggle(tree));
    await nextTick();
    expect(toggle(tree).props['aria-expanded']).toBe('true');
    expect(textOf(tree)).toContain(RAW);
    expect(buttons(tree).map(textOf)).toContain(S.op_copy);
    click(toggle(tree));
    await nextTick();
    expect(textOf(tree)).not.toContain(RAW);
  });

  it('the copy button puts the RAW text on the clipboard and says so; a refusal is said too', async () => {
    setLocale('en');
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const tree = mount(SidecarFailureDetail, { detail: RAW });
    click(toggle(tree));
    await nextTick();
    const copy = buttons(tree).find((b) => textOf(b) === S.op_copy)!;
    click(copy);
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
    expect(writeText).toHaveBeenCalledWith(RAW);
    expect(textOf(tree)).toContain(S.model_copied);

    const fail = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText: fail } });
    const tree2 = mount(SidecarFailureDetail, { detail: RAW });
    click(toggle(tree2));
    await nextTick();
    click(buttons(tree2).find((b) => textOf(b) === S.op_copy)!);
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
    expect(textOf(tree2)).toContain(S.op_copy_failed);
    expect(textOf(tree2)).not.toContain(S.model_copied);
  });
});

describe('NR-120 — the LAN card renders it only through the fold', () => {
  // DevicesPage.vue is driven by onMounted bridge pulls and is not rendered by any
  // test here (devices-info-panel.test.ts explains why), so the wiring is pinned
  // on the source the way that file pins its neighbours.
  const SRC = readFileSync(fileURLToPath(new URL('./DevicesPage.vue', import.meta.url)), 'utf8');
  it('mounts SidecarFailureDetail with the detail and never prints sidecar.detail itself', () => {
    expect(SRC).toContain('<SidecarFailureDetail v-if="sidecarFailed && sidecar?.detail" :detail="sidecar.detail" />');
    expect(SRC).not.toContain('{{ sidecar.detail }}');
    expect(SRC).not.toMatch(/\{\{[^}]*sidecar\??\.detail[^}]*\}\}/);
  });
});
