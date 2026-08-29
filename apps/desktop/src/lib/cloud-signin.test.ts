// SPEC-REF:
//   docs/decisions/2026-08-27-owner-no-password-login-on-clients.md (card
//     NR-2b, PC half: 「粘贴即校验、错误具名提示」 — validate on paste, name the
//     error — plus the guided browser sign-in)
//
// The two decisions behind the PC's signed-out block. Both are pure, so they
// are asserted here; what the component RENDERS is asserted in
// main-window/cloud-signin-guide.test.ts, and that split is the repo's standing
// one (vitest runs this suite in `node`, with no DOM to click in).

import { describe, expect, it } from 'vitest';

import {
  CONSOLE_SIGNIN_URL,
  openConsoleSignIn,
  pasteLooksMalformed,
  valueAfterPaste,
} from './cloud-signin';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2ln';

describe('CONSOLE_SIGNIN_URL', () => {
  it('is an https address on the product domain', () => {
    // 🔴 `shell/external_open.rs` refuses anything that is not https://, so an
    // http:// value here would be a button that silently does nothing — the
    // exact failure the external-link door exists to prevent, reintroduced by
    // a constant rather than by a `target=_blank`.
    expect(CONSOLE_SIGNIN_URL.startsWith('https://')).toBe(true);
    expect(new URL(CONSOLE_SIGNIN_URL).host).toBe('flowmic.app');
    expect(new URL(CONSOLE_SIGNIN_URL).pathname).toBe('/signin');
  });
});

describe('openConsoleSignIn', () => {
  it('🔴 hands the address to the door it was given, and to nothing else', () => {
    // The door is `openExternalUrl` → `shell/external_open.rs`. In this WebView
    // `target=_blank` / `window.open` open NOTHING, so a second route would be
    // a control that looks like it works — which is why this takes an opener
    // rather than reaching for one, and why `verify:lint external-link-door`
    // fences the whole tree.
    const seen: string[] = [];
    void openConsoleSignIn(async (url) => {
      seen.push(url);
      return { ok: true } as const;
    });
    expect(seen).toEqual([CONSOLE_SIGNIN_URL]);
  });

  it('reports a refused open rather than pretending it worked', async () => {
    expect(
      await openConsoleSignIn(async () => ({ ok: false, reason: 'no handler' })),
    ).toBe(false);
    expect(await openConsoleSignIn(async () => ({ ok: true }))).toBe(true);
  });
});

describe('valueAfterPaste', () => {
  it('into an empty field is just the pasted text', () => {
    expect(valueAfterPaste('', JWT, 0, 0)).toBe(JWT);
  });

  it('🔴 replaces the SELECTION — pasting over a wrong key is a correct paste', () => {
    // Without this, the ordinary correction gesture (select all, paste) would
    // be judged as "old value + new value" and called malformed.
    expect(valueAfterPaste('garbage', JWT, 0, 'garbage'.length)).toBe(JWT);
  });

  it('inserts at the caret when nothing is selected', () => {
    expect(valueAfterPaste('ac', 'b', 1, 1)).toBe('abc');
  });

  it('appends when the selection is unknown (a null caret)', () => {
    expect(valueAfterPaste('ab', 'c', null, null)).toBe('abc');
  });

  it('clamps a caret that is out of range instead of producing undefined', () => {
    expect(valueAfterPaste('ab', 'X', 99, 99)).toBe('abX');
    expect(valueAfterPaste('ab', 'X', -5, -5)).toBe('Xab');
  });

  it('handles a backwards selection (anchor after focus)', () => {
    expect(valueAfterPaste('abcd', 'X', 3, 1)).toBe('aXd');
  });
});

describe('pasteLooksMalformed', () => {
  it('accepts a JWT-shaped value', () => {
    expect(pasteLooksMalformed(JWT)).toBe(false);
    expect(pasteLooksMalformed(`  ${JWT}  `)).toBe(false);
  });

  it('names the obviously-wrong pastes this check exists for', () => {
    expect(pasteLooksMalformed('hunter2')).toBe(true);
    expect(pasteLooksMalformed('https://flowmic.app/console')).toBe(true);
    expect(pasteLooksMalformed('eyJh.eyJz')).toBe(true); // half a token
  });

  it('🔴 EMPTY IS NOT MALFORMED — nothing was given to judge', () => {
    // Shouting at a user who has pasted nothing is how an inline error becomes
    // noise people stop reading.
    expect(pasteLooksMalformed('')).toBe(false);
    expect(pasteLooksMalformed('   ')).toBe(false);
  });

  it('does not claim the key is VALID — only that its shape is possible', () => {
    // A structurally fine string can still be expired, revoked, or another
    // account's. That answer comes from the relay (cloud_err_expired /
    // cloud_err_refused), which is why the save path is unchanged.
    expect(pasteLooksMalformed('aaa.bbb.ccc')).toBe(false);
  });
});
