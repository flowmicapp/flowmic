// UP-3b — component-level checks for the update block.
//
// 🔴 WHY RENDER AND NOT JUST THE VIEW MODEL. `update-view.test.ts` proves the
// RULES; this proves the SENTENCES reach the output. 0.2.53 is the standing
// lesson: `cloud_image_error_copy_test.dart` asserted `Text.data` while the user
// saw three letters, and 1259 tests were green. The desktop's failure mode is
// different (no ellipsis budget here) but the discipline is the same — assert on
// what rendering produced, not on what was passed in.
//
// Rendering goes through `vue/server-renderer`, which is the runtime that matches
// vitest's default SSR transform for SFCs — the precedent and the reasoning are
// in `prefs-appearance.test.ts`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { beforeEach, describe, expect, it } from 'vitest';
import type { UpdateStateDto } from '../lib/update-view';

import UpdateBlock from './components/UpdateBlock.vue';
import { S, hydrateLocale, setLocale, wireLocaleStore } from '../lib/strings';
import { UI_LOCALES } from '../lib/strings/locale';
import type { KvStore } from '../lib/types';

function memKv(): KvStore {
  const map = new Map<string, string>();
  return { get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v) };
}

function state(over: Partial<UpdateStateDto> = {}): UpdateStateDto {
  return {
    current_version: '0.2.59',
    form: 'portable',
    auto_check: true,
    last_success_check: null,
    checking: false,
    plan: null,
    latest: null,
    notes_url: null,
    manual_reason: null,
    failure: null,
    download: { active: false, received: 0, total: 0 },
    verified_filename: null,
    verified_sha256: null,
    verified_size: null,
    can_swap_in_place: null,
    pending: null,
    ...over,
  };
}

/**
 * Render the presentational half directly, driven by props.
 *
 * 🔴 This is why `UpdateBlock` exists apart from `UpdateCard`. SSR does not run
 * `onMounted`, so a component that fetches its own state renders its INITIAL
 * value forever in this harness — the first version of this file did exactly
 * that and 11 assertions failed against `<!---->`. The fix was not a test-only
 * hook in the component; it was noticing that "a component a render test cannot
 * drive" is a design signal. `UpdateCard` keeps the IO, this keeps the words.
 */
async function render(s: UpdateStateDto): Promise<string> {
  const html = await renderToString(createSSRApp(UpdateBlock, { s }));
  // 🔴 HTML COMMENTS ARE STRIPPED, AND THIS IS NOT TIDYING.
  //
  // Vue's SSR renderer emits template comments verbatim into the output, and
  // `UpdateBlock.vue` carries a comment reading "only the up_to_date branch
  // may say 'up to date'" right above the branch it describes. So the negative
  // assertions below — `not.toContain('已是最新')` — matched MY OWN COMMENT and
  // failed on correct code.
  //
  // ⚠️ This is the SECOND time in this card, in a second language: the Rust
  // ordering guard (`apply_arg_tests.rs`) hit exactly the same thing, where a
  // comment explaining "the intercept must precede the lock" was found by a
  // search for the lock. Both times the fooling comment was the one written to
  // explain the very rule being guarded.
  //
  // ⇒ A test asserting what a user can READ must look at rendered TEXT, not at
  // markup. Comments are not rendered text, and neither are the `<!---->`
  // placeholders Vue emits for a false `v-if`.
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

const SHA = 'b'.repeat(64);

beforeEach(() => {
  wireLocaleStore(memKv());
  hydrateLocale();
  setLocale('zh-CN');
});

describe('UpdateBlock (rendered)', () => {
  /**
   * 🔴 Design §5.0's named silent failure, asserted where the user reads it.
   *
   * A client that has never once reached the server must not look like one that
   * just checked. Both of these render the line — one with a date, one with
   * "never succeeded" (从未成功) — and neither may omit it.
   */
  it('🔴 always renders the last-successful-check line, with or without a value', async () => {
    const never = await render(state({ plan: 'up_to_date' }));
    expect(never).toContain(S.upd_last_check);
    expect(never).toContain(S.upd_last_check_never);

    const checked = await render(
      state({ plan: 'up_to_date', last_success_check: '2026-08-08T09:12:00Z' }),
    );
    expect(checked).toContain(S.upd_last_check);
    expect(checked).not.toContain(S.upd_last_check_never);
    // "Up to date" and its evidence appear TOGETHER — that is the whole rule.
    expect(checked).toContain(S.upd_up_to_date);
  });

  /** A dev build renders nothing at all — not even "unknown." */
  it('a dev build renders no update block', async () => {
    const html = await render(state({ form: 'dev' }));
    expect(html).not.toContain(S.upd_section);
    expect(html).not.toContain(S.upd_up_to_date);
  });

  /**
   * 🔴 "unknown" ≠ "up to date," at the rendering layer this time: a failed
   * check must never put those words on screen.
   */
  it('🔴 a failed check never renders “up to date”', async () => {
    const html = await render(
      state({
        plan: 'up_to_date', //  a stale verdict from an earlier check…
        failure: { tag: 'unreachable', detail: 'unreachable (timeout)', blocking: false },
      }),
    );
    expect(html).not.toContain(S.upd_up_to_date);
    // …and the specific sentence IS there, not a generic one.
    expect(html).toContain(S.upd_fail_unreachable);
  });

  it('renders the specific sentence for each failure, not one merged message', async () => {
    const a = await render(state({ failure: { tag: 'hash_mismatch', detail: 'x', blocking: true } }));
    expect(a).toContain(S.upd_fail_hash_mismatch);
    const b = await render(
      state({ failure: { tag: 'location_not_updatable', detail: 'y', blocking: true } }),
    );
    expect(b).toContain(S.upd_fail_location_not_updatable);
    expect(b).not.toContain(S.upd_fail_hash_mismatch);
  });

  /**
   * 🔴 An unregistered tag prints the identifier and does NOT invent a sentence.
   *
   * Ugly on purpose — see `FAILURE_KEYS`. A fluent "update failed" that explains
   * nothing is worse, because the user cannot tell it from a real explanation.
   */
  it('🔴 an unknown failure tag renders the tag, never an invented sentence', async () => {
    const html = await render(
      state({ failure: { tag: 'something_from_the_future', detail: 'z', blocking: false } }),
    );
    expect(html).toContain('something_from_the_future');
  });

  it('announces a new version with its number', async () => {
    const html = await render(state({ plan: 'available', latest: '0.2.60' }));
    expect(html).toContain(S.upd_available);
    expect(html).toContain('0.2.60');
    expect(html).toContain(S.upd_download);
  });

  /**
   * 🔴 No install button until the hash gate has passed, and the evidence line
   * appears with it (design §5.2's "✓ integrity verified (SHA256)").
   */
  it('🔴 offers no install button before verification, and both after', async () => {
    const before = await render(state({ plan: 'available', latest: '0.2.60', form: 'portable' }));
    expect(before).not.toContain(S.upd_install_portable);
    expect(before).not.toContain(S.upd_verified);

    const after = await render(
      state({
        plan: 'available',
        latest: '0.2.60',
        form: 'portable',
        verified_sha256: SHA,
        can_swap_in_place: true,
      }),
    );
    expect(after).toContain(S.upd_install_portable);
    expect(after).toContain(S.upd_verified);
  });

  /**
   * 🔴 The MSI hint must be on screen with the MSI button, and it must still
   * name a route the user can walk themselves.
   *
   * ⚠️ 0.3.8: the literal used to be 「请重新打开」, from the era when the chain
   * did not relaunch anything. It does now (update/msi.rs), so the literal is
   * 「开始菜单」 — the fallback for the case where the relaunch fails, which is
   * the half of the old rule that was actually protecting anyone. The assertion
   * stays a LITERAL rather than only `S.upd_msi_hint`, because
   * `toContain(S.upd_msi_hint)` is satisfied by any string at all: it compares
   * the rendered output against whatever the catalogue currently says, so it
   * cannot notice the day the sentence stops carrying an exit.
   */
  it('🔴 the MSI button carries the hint, which still names the manual route', async () => {
    const html = await render(
      state({ plan: 'available', latest: '0.2.60', form: 'msi', verified_sha256: SHA }),
    );
    expect(html).toContain(S.upd_install_msi);
    expect(html).toContain(S.upd_msi_hint);
    expect(html).toContain('开始菜单');
  });

  /** A location the preflight already refused shows the page link, not a button. */
  it('🔴 an unwritable location gets the download page, not an install button', async () => {
    const html = await render(
      state({
        plan: 'available',
        latest: '0.2.60',
        form: 'portable',
        verified_sha256: SHA,
        can_swap_in_place: false,
      }),
    );
    expect(html).not.toContain(S.upd_install_portable);
    expect(html).toContain(S.upd_open_page);
  });

  /** §3 row 8: turning it off must say so, not fall silent. */
  it('🔴 auto-check off renders the “off is not up to date” note', async () => {
    const html = await render(state({ auto_check: false }));
    expect(html).toContain(S.upd_auto_off_note);
    expect(html).not.toContain(S.upd_up_to_date);
    // …and the manual button is still reachable.
    expect(html).toContain(S.upd_check_now);
  });

  it('reports the last attempt, and only claims a rollback when there was one', async () => {
    const rolled = await render(
      state({
        pending: { outcome: 'not_completed', from: '0.2.59', to: '0.2.60', detail: 'rolled_back:x' },
      }),
    );
    expect(rolled).toContain(S.upd_pending_failed);
    expect(rolled).toContain(S.upd_pending_rolled_back);

    const notRolled = await render(
      state({
        pending: {
          outcome: 'not_completed',
          from: '0.2.59',
          to: '0.2.60',
          detail: 'nothing_moved:timeout_waiting_for_lock',
        },
      }),
    );
    expect(notRolled).toContain(S.upd_pending_failed);
    expect(notRolled).not.toContain(S.upd_pending_rolled_back);
  });

  /**
   * Four locales really render. Not a catalogue lookup — the component is
   * compiled and rendered once per language, which is what
   * `prefs-appearance.test.ts` established as the bar for a locale claim.
   */
  it('renders in all four locales', async () => {
    for (const loc of UI_LOCALES) {
      setLocale(loc);
      const html = await render(state({ plan: 'up_to_date' }));
      expect(html, `${loc} did not render its own section title`).toContain(S.upd_section);
      expect(html, `${loc} did not render its own verdict`).toContain(S.upd_up_to_date);
      expect(html, `${loc} dropped the evidence line`).toContain(S.upd_last_check);
    }
  });
});

/**
 * 🔴 WHICH COMPONENT DOES THE APP ACTUALLY RENDER?
 *
 * Two files named `Update*.vue` sit side by side, and a reader has no way to
 * tell a deliberate split from a half-finished rename — a peer window raised
 * exactly that this afternoon, and it was a fair question. So the answer is
 * mechanical rather than a comment in either file:
 *
 *     SettingsPage.vue → UpdateCard.vue (IO) → UpdateBlock.vue (words)
 *
 * Read as DATA, so that deleting either link, or adding a THIRD `Update*.vue`
 * that nothing renders, turns this red. A comment asserting the same thing would
 * be an anti-façade ④ claim about somebody else's file: true when written, and
 * silently false the moment they move.
 */
describe('the update block’s render chain', () => {
  const readRaw = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  /**
   * 🔴 Source with its COMMENTS REMOVED — and this helper exists because the
   * mistake it prevents has now happened THREE times inside this one card:
   *
   *   1. `apply_arg_tests.rs` searched `lib.rs` for `single_instance::acquire`
   *      and found the comment explaining that the mover must precede it.
   *   2. The render assertions below searched SSR output for "up to date" and
   *      found the template comment saying only one branch may print it.
   *   3. This very test searched `UpdateCard.vue` for `CloudConfig` and found
   *      the header explaining that the base must NOT come from `CloudConfig`.
   *
   * Every time, the text that fooled the guard was the comment written to
   * explain the rule the guard enforces — which is not a coincidence: that
   * comment is the one place the forbidden string is guaranteed to appear.
   *
   * ⇒ A guard that reads source must read CODE. Strips `<!-- -->`, `//…` and
   * block comments.
   */
  const read = (rel: string) =>
    readRaw(rel)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');

  it('🔴 SettingsPage renders UpdateCard, and only UpdateCard renders UpdateBlock', () => {
    const settings = read('./SettingsPage.vue');
    expect(settings, 'the About section must mount the container').toContain(
      "from './components/UpdateCard.vue'",
    );
    expect(settings, 'the settings page must not reach past the container').not.toContain(
      'UpdateBlock',
    );

    const card = read('./components/UpdateCard.vue');
    expect(card, 'the container must render the presentational half').toContain(
      "from './UpdateBlock.vue'",
    );

    // …and the presentational half owns no IO of its own: if it ever invoked a
    // command, the split would have quietly stopped being a split.
    const block = read('./components/UpdateBlock.vue');
    expect(block, 'UpdateBlock must not talk to Rust').not.toContain('invokeSafe');
    expect(block, 'UpdateBlock must not subscribe to events').not.toContain('@tauri-apps/api/event');
  });

  /**
   * The container passes the PROTOCOL constant as the manifest base.
   *
   * 🔴 An anti-façade check with a real target: if `update_check` were ever
   * called without a base — or with one derived from the cloud config — the
   * update chain would silently start asking the paired relay 「what is the
   * latest FlowMic」, which is a different question (design §1.1).
   */
  it('🔴 the check is issued against UPDATE_MANIFEST_BASE, not a cloud endpoint', () => {
    const card = read('./components/UpdateCard.vue');
    expect(card).toContain("pull('update_check', { base: UPDATE_MANIFEST_BASE })");
    expect(card).not.toContain('CloudConfig');
    expect(card).not.toContain('cloud_status');
  });
});
