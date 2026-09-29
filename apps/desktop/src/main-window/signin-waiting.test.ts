// NR-112 (2026-09-26) — what the PC shows WHILE it waits for the browser
// sign-in, now that the wait is fifteen minutes instead of 180 s.
//
// ── WHY THIS FILE MOUNTS A CHILD ─────────────────────────────────────────────
// The waiting row only exists after a click, and vitest here renders SFCs
// through their SSR compile in `node`, where no click can happen
// (cloud-signin-guide.test.ts states the same split). So the row lives in
// SignInWaiting.vue — the exact markup CloudSignInGuide.vue renders under
// `v-else` of the sign-in button — and it is mounted here in every shipped
// language. The wiring from the guide to it (which prop, which handler) is
// pinned by source anchors at the bottom; what cancel DOES to the listener is
// pinned in Rust on a real socket (`nr112_*` in src-tauri/src/cloud_signin_tests.rs).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';

import SignInWaiting from './components/SignInWaiting.vue';
import { S_BY_LOCALE, setLocale } from '../lib/strings';
import { UI_LOCALES, type UiLocale } from '../lib/strings/generated/locales.g';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const GUIDE = read('./components/CloudSignInGuide.vue');
const RUST = read('../../src-tauri/src/cloud_signin.rs');

/** The minutes the listener really waits, read off the Rust declaration — the
 *  number the waiting row must show is not ours to type. */
function rustWindowMinutes(): number {
  const m = /^pub const SIGNIN_WINDOW_MS: u64 = ([\d_]+);$/m.exec(RUST);
  expect(m, 'SIGNIN_WINDOW_MS declaration not found in cloud_signin.rs').not.toBeNull();
  return Number(m![1]!.replace(/_/g, '')) / 60_000;
}

function ssrEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function renderIn(loc: UiLocale, minutes: number): Promise<string> {
  setLocale(loc);
  const html = await renderToString(createSSRApp({ render: () => h(SignInWaiting, { minutes }) }));
  setLocale('zh-CN');
  return html;
}

describe('the waiting row (NR-112)', () => {
  it('the listener waits fifteen minutes', () => {
    expect(rustWindowMinutes()).toBe(15);
  });

  it('says it is waiting, offers a visible Cancel, and names the window — in every shipped language', async () => {
    const minutes = rustWindowMinutes();
    for (const loc of UI_LOCALES) {
      const s = S_BY_LOCALE[loc];
      const html = await renderIn(loc, minutes);
      expect(html, `${loc} waiting`).toContain(ssrEscape(s.cloud_signin_waiting));
      // A skinned button (button-skin-door.test.ts): an unskinned one draws
      // nothing, and a wait with no visible way out is the defect this row is for.
      expect(html, `${loc} cancel`).toMatch(
        new RegExp(`<button class="btn ghost sm"[^>]*data-action="signin-cancel"[^>]*>\\s*${ssrEscape(s.cloud_signin_cancel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</button>`),
      );
      expect(html, `${loc} hint`).toContain(
        ssrEscape(s.cloud_signin_waiting_hint.replace('{min}', String(minutes))),
      );
    }
  });

  it('every installed hint carries the {min} slot, so the number on screen is the listener\'s', () => {
    for (const loc of UI_LOCALES) {
      const text = S_BY_LOCALE[loc].cloud_signin_waiting_hint;
      if (text.startsWith('DEV:')) continue; // placeholder until the AGY copy lands
      expect(text, `${loc} has no {min}`).toContain('{min}');
    }
  });
});

describe('the guide renders THIS row while waiting, wired to the real cancel (source anchors)', () => {
  it('replaces the sign-in button with <SignInWaiting>, not a second control beside it', () => {
    expect(GUIDE).toMatch(/<SignInWaiting v-else :minutes="windowMinutes" @cancel="cancelSignIn" \/>/);
    expect(GUIDE).not.toMatch(/class="signin-wait"/);
  });

  it('the minutes come from the Rust window handed back by begin', () => {
    expect(GUIDE).toMatch(/windowMinutes\.value = Math\.round\(begun\.data\.window_ms \/ 60_000\);/);
  });

  it('Cancel stops polling and closes the listener', () => {
    const body = /async function cancelSignIn\(\): Promise<void> \{([\s\S]*?)\n\}/.exec(GUIDE)?.[1] ?? '';
    expect(body).toContain('stopPolling();');
    expect(body).toContain('await cancelBrowserSignIn();');
  });
});
