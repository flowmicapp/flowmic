// SPEC-REF:
//   docs/decisions/2026-08-27-owner-no-password-login-on-clients.md (card
//     NR-2b, PC half)
//
// What the signed-out cloud block SHOWS, and how its one external link is
// wired.
//
// ── WHY THIS FILE IS PART RENDER AND PART SOURCE ANCHOR ─────────────────────
// vitest runs this suite in `node` and SFCs compile to their SSR form, so a
// click cannot be simulated here (pairing-modal.test.ts states the same split).
// So the work is divided the way this repo already divides it:
//   · what a rendered tree SHOWS — asserted below through renderToString, in
//     every shipped language, because a string that exists and is never mounted
//     is a façade this repo has caught more than once;
//   · what the button DOES — `openConsoleSignIn` in lib/cloud-signin.test.ts,
//     driven with a fake door, including the refused-open branch;
//   · that there is no OTHER route out — the source anchors at the bottom, plus
//     `verify:lint external-link-door` across the whole webview tree.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

import CloudSignInGuide from './components/CloudSignInGuide.vue';
import { S_BY_LOCALE, setLocale } from '../lib/strings';
import { UI_LOCALES, type UiLocale } from '../lib/strings/generated/locales.g';

const SRC = readFileSync(
  fileURLToPath(new URL('./components/CloudSignInGuide.vue', import.meta.url)),
  'utf8',
);

/** Vue's SSR text escaping — catalogue strings with apostrophes (fr) or the
 *  German quote pair come out entity-escaped in the markup, so asserting a raw
 *  catalogue string would fail for exactly the languages this covers. */
function ssrEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function renderIn(loc: UiLocale): Promise<string> {
  setLocale(loc);
  const html = await renderToString(
    createSSRApp(CloudSignInGuide, { endpoint: 'https://flowmic.app' }),
  );
  setLocale('zh-CN');
  return html;
}

describe('the signed-out cloud block', () => {
  it('offers the browser sign-in ABOVE the Cloud Key field', async () => {
    const html = await renderIn('en');
    const button = html.indexOf(ssrEscape(S_BY_LOCALE.en.cloud_signin_browser));
    const keyLabel = html.indexOf(ssrEscape(S_BY_LOCALE.en.cloud_key_label));
    expect(button).toBeGreaterThanOrEqual(0);
    expect(keyLabel).toBeGreaterThanOrEqual(0);
    // 🔴 Order is the point, not decoration: the route to GETTING a key has to
    // be read before the field that asks for one, or the screen still opens on
    // a demand with no answer.
    expect(button).toBeLessThan(keyLabel);
  });

  it('states the whole route on the same screen, in every shipped language', async () => {
    for (const loc of UI_LOCALES) {
      const html = await renderIn(loc);
      const s = S_BY_LOCALE[loc];
      expect(html, `${loc} button`).toContain(ssrEscape(s.cloud_signin_browser));
      // The hint is what answers 「and then what」. Without it the button says
      // where to go and leaves the user in a browser tab not knowing what they
      // came for.
      expect(html, `${loc} hint`).toContain(ssrEscape(s.cloud_signin_browser_hint));
    }
  });

  it('keeps the paste form: endpoint, key, save', async () => {
    const html = await renderIn('en');
    const s = S_BY_LOCALE.en;
    // owner ruling: the Cloud Key paste is KEPT and polished, not replaced.
    expect(html).toContain(ssrEscape(s.cloud_endpoint_label));
    expect(html).toContain(ssrEscape(s.cloud_key_label));
    expect(html).toContain(ssrEscape(s.cloud_key_save));
    expect(html).toContain('type="password"');
  });

  it('the failure sentence is NOT rendered until something fails', async () => {
    const html = await renderIn('en');
    expect(html).not.toContain(ssrEscape(S_BY_LOCALE.en.cloud_signin_browser_failed));
    // ...and it exists, so the check above is an absence and not a typo.
    expect(S_BY_LOCALE.en.cloud_signin_browser_failed.trim().length).toBeGreaterThan(0);
  });

  it('the malformed-key complaint is NOT rendered before a paste', async () => {
    const html = await renderIn('en');
    expect(html).not.toContain(ssrEscape(S_BY_LOCALE.en.cloud_err_malformed));
  });

  it('both buttons carry a real skin (an unskinned .btn is invisible)', async () => {
    const html = await renderIn('en');
    // 0.3.33's scar: `.btn` alone is layout only; `button{border:none;
    // background:none}` removes what the browser would have drawn.
    expect(html.match(/class="btn pri sm"/g)?.length).toBe(2);
  });
});

describe('the one door out', () => {
  it('🔴 goes through openExternalUrl and names no other route', () => {
    expect(SRC).toContain("from '../../lib/bridge-os'");
    // ⚠️ THE COMMA IS PART OF THE ASSERTION NOW. This read
    // `openConsoleSignIn(openExternalUrl)` until 2026-08-27, when the browser
    // route gained a second argument (the console URL, which now carries the
    // loopback port and the state). Matching the open paren plus the door and
    // stopping there keeps the claim this test makes — 「the ONE door is the one
    // used」 — without pinning an argument list that is not what it is about.
    expect(SRC).toContain('openConsoleSignIn(openExternalUrl,');
    // ⚠️ NO ABSENCE ASSERTIONS HERE, DELIBERATELY. The two dead forms (a
    // blank-target anchor, a scripted new window) are fenced tree-wide by
    // `verify:lint external-link-door`, which is strictly stronger than a
    // per-file check. Writing them here would also mean adding this file to
    // that gate's allowlist — an allowlist its own header calls 「a gate with a
    // hole shaped like the next defect」 and keeps to files that have no other
    // way to assert. This file has one: assert the door IS used.
  });

  it('🔴 the paste really is wired to the paste-time check', () => {
    // The DECISION is proven in lib/cloud-signin.test.ts; this is the wire.
    // Without it that logic would be a tested function nobody calls — this
    // repo's number-one historical defect class.
    expect(SRC).toContain('@paste="onKeyPaste"');
    expect(SRC).toContain('pasteLooksMalformed(');
    expect(SRC).toContain('valueAfterPaste(');
  });

  it('🔴 the save path still re-checks — the paste check did not replace it', () => {
    // A field can be edited by hand after a paste, so the check that runs once
    // is the weaker of the two and must not become the only one.
    expect(SRC).toContain('keyShapeError.value = !isJwtShaped(key);');
    expect(SRC).toContain('if (keyShapeError.value) return;');
  });
});
