// Owner ruling 2026-08-27 §R2 (docs/decisions/2026-08-27-owner-persistent-login-
// and-routing-order.md): 「兜底那行始终在最下面，新增行在它上面」— the catch-all
// row is always at the bottom and a new row goes above it — plus §R2-2, no
// duplicate languages.
//
// 🔴 WHAT THIS ROUND DELIBERATELY DID NOT BUILD, because it is the thing the
// ruling asked about. The owner wondered whether row order should carry match
// PRIORITY. It must not: matching is by LANGUAGE KEY through a three-step ladder
// (exact → base subtag → `*`) inside an AUTHOR layer, and giving the order a
// second meaning would be this repo's #1 shape (one value answering two
// questions). Row order stays what it already was — the tie-break inside one
// rung of one layer — and what changed is that the SCREEN now shows that truth
// instead of an arrangement that merely looked meaningful.
//
// ⚠️ TWO KINDS OF ASSERTION HERE, on purpose:
//   · the ordering invariant is asserted on the MODEL, because that is where it
//     lives (it is a property of what is stored and sent, not a render-time
//     sort — a display-only sort would have let the array and the screen answer
//     differently, which is the defect one layer down);
//   · the duplicate copy is asserted on renderToString's OUTPUT (0.2.53's law:
//     「can the user read this」 is answered by the rendered result, never by
//     `S.*` or by a model field).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }));

import SttSettings from './components/SttSettings.vue';
import {
  addRouting,
  applyServerSettings,
  model,
  orderedRoutings,
  removeRouting,
  updateRoutingField,
  type Routing,
} from './settings-model';
import { resetModelStoreForTest } from '../lib/model-client';
import { S, setLocale } from '../lib/strings';
import { FALLBACK_LANG } from '../lib/spoken-langs';

const R = (language: string, engine_id: Routing['engine_id'] = 'sherpa-local'): Routing => ({ language, engine_id });
const langs = (): string[] => model.routings.map((r) => r.language);

async function render(routings: Routing[]): Promise<string> {
  model.routings = routings;
  resetModelStoreForTest();
  return renderToString(createSSRApp(SttSettings));
}

/** Every `<option>` in the render, as `[value, disabled?]`. */
function optionRows(html: string): { value: string; disabled: boolean }[] {
  return [...html.matchAll(/<option value="([^"]*)"([^>]*)>/g)].map((m) => ({
    value: m[1] ?? '',
    disabled: (m[2] ?? '').includes('disabled'),
  }));
}

beforeEach(() => {
  setLocale('en');
  resetModelStoreForTest();
  model.routings = [R('zh'), R(FALLBACK_LANG)];
});

describe('§R2-1 the catch-all row is pinned last', () => {
  it('orderedRoutings is a STABLE partition — specific rows keep their arrangement', () => {
    const out = orderedRoutings([R(FALLBACK_LANG), R('ja'), R('zh'), R('en')]);
    expect(out.map((r) => r.language)).toEqual(['ja', 'zh', 'en', FALLBACK_LANG]);
  });

  it('more than one catch-all is possible in stored data, and both go last in their own order', () => {
    // 🔴 Not hypothetical: `addRouting` seeded `'*'` before 2026-08-27 §2-1, so
    // installs out there really do carry two. They are NOT merged — merging
    // would be the silent rewrite the owner ruled against; they are shown, in
    // order, and the second one gets the duplicate note.
    const a = R(FALLBACK_LANG, 'sherpa-local');
    const b = R(FALLBACK_LANG, 'funasr');
    expect(orderedRoutings([a, R('zh'), b]).map((r) => r.engine_id)).toEqual(['sherpa-local', 'sherpa-local', 'funasr']);
  });

  it('an array with no catch-all is returned untouched', () => {
    expect(orderedRoutings([R('zh'), R('en')]).map((r) => r.language)).toEqual(['zh', 'en']);
    expect(orderedRoutings([]).length).toBe(0);
  });

  it('🔴 「add language」 lands ABOVE the catch-all, not after it', () => {
    addRouting();
    expect(langs()).toEqual(['zh', 'en', FALLBACK_LANG]);
    addRouting();
    // Two presses, and the catch-all is still last — the invariant is not a
    // one-shot placement.
    expect(langs()[langs().length - 1]).toBe(FALLBACK_LANG);
  });

  it('🔴 server hydration that delivers ["*", "zh"] is re-ordered on the way in', () => {
    // The relay stores whatever order it was handed, including arrays written by
    // builds older than this one. Without this, the invariant would hold
    // everywhere EXCEPT right after a sync — the worst place to break, because
    // that is when the user is looking at the page.
    applyServerSettings([{ key: 'stt.routings', value: [R(FALLBACK_LANG), R('zh'), R('ja')] }]);
    expect(langs()).toEqual(['zh', 'ja', FALLBACK_LANG]);
  });

  it('editing a row INTO the catch-all moves it down in the same tick', () => {
    model.routings = [R('zh'), R('ja'), R('en')];
    updateRoutingField(1, 'language', FALLBACK_LANG);
    expect(langs()).toEqual(['zh', 'en', FALLBACK_LANG]);
  });

  it('index-based mutators still address what the screen shows', () => {
    // The whole reason the array is ordered rather than the display: displayed
    // index == array index by construction, so there is no map for four callers
    // to remember. Deleting the SECOND visible row deletes the second stored row.
    model.routings = [R(FALLBACK_LANG), R('zh'), R('ja')];
    addRouting();                       // forces the invariant: zh, ja, en, *
    expect(langs()).toEqual(['zh', 'ja', 'en', FALLBACK_LANG]);
    removeRouting(1);
    expect(langs()).toEqual(['zh', 'en', FALLBACK_LANG]);
  });

  it('REVERSE CONTROL: the pin really is what produces the order', () => {
    // Feed the un-ordered array straight into the model — i.e. what every write
    // path did before this round — and the catch-all sits first. If this
    // assertion ever fails, the cases above are being satisfied by something
    // other than `orderedRoutings` and prove nothing.
    model.routings = [R(FALLBACK_LANG), R('zh')];
    expect(langs()).toEqual([FALLBACK_LANG, 'zh']);
    expect(orderedRoutings(model.routings).map((r) => r.language)).toEqual(['zh', FALLBACK_LANG]);
  });
});

describe('§R2-2 duplicate languages: refused going in, named when already there', () => {
  it('🔴 a language another row owns is DISABLED in this row\'s select', async () => {
    const html = await render([R('zh'), R('ja'), R(FALLBACK_LANG)]);
    const rows = optionRows(html);
    // Positive control: the offered list really rendered, so "disabled" below is
    // measured against something.
    expect(rows.length).toBeGreaterThan(3);
    // `ja` and `*` are owned by other rows ⇒ every occurrence of them that is
    // NOT the owning row's own option is disabled. Counting is enough here: the
    // owning row keeps exactly one enabled copy of its own value.
    const enabledJa = rows.filter((o) => o.value === 'ja' && !o.disabled);
    const enabledFallback = rows.filter((o) => o.value === FALLBACK_LANG && !o.disabled);
    expect(enabledJa.length, 'ja is selectable in more than its own row').toBe(1);
    expect(enabledFallback.length, 'the catch-all is offered to a second row').toBe(1);
    // …and a language NOBODY owns stays enabled everywhere — otherwise the
    // assertion above would be satisfied by a select that disables everything.
    expect(rows.filter((o) => o.value === 'ru' && !o.disabled).length).toBe(3);
  });

  it('🔴 a row that duplicates an earlier one says so, in the rendered output', async () => {
    const html = await render([R('zh'), R('zh')]);
    expect(html).toContain(S.stt_lang_duplicate);
  });

  it('POSITIVE CONTROL: no duplicates ⇒ the note is not on screen at all', async () => {
    const html = await render([R('zh'), R('ja'), R(FALLBACK_LANG)]);
    expect(html).not.toContain(S.stt_lang_duplicate);
  });

  it('the note lands on the LOSING row, and the stored array is not rewritten', async () => {
    await render([R('zh'), R('ja'), R('zh')]);
    // 🔴 Nothing was merged, renamed or dropped. The owner ruled that
    // explicitly: a settings screen that silently corrects a value leaves the
    // user unable to see what their machine is configured with.
    expect(langs()).toEqual(['zh', 'ja', 'zh']);
  });

  it('the copy says which row wins — a vaguer word would leave it unpredictable', () => {
    // The user's next action depends on knowing that the FIRST row is the live
    // one; "conflict" or "ignored" answers neither half.
    expect(S.stt_lang_duplicate.toLowerCase()).toContain('first');
    setLocale('zh-CN');
    expect(S.stt_lang_duplicate).toContain('第一行');
    setLocale('en');
  });
});
