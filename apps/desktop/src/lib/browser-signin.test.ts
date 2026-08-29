// The desktop half of the automatic browser sign-in (owner 2026-08-27, the UAT
// correction block in
// docs/decisions/2026-08-27-owner-no-password-login-on-clients.md).
//
// The DECISIONS Rust makes are tested in Rust (`src-tauri/src/cloud_signin.rs`,
// lean `cargo test --lib`). What is testable here is the boundary between the
// two languages, and it is the part with no compiler watching it:
//   ① the URL this side builds is the one the console's parser accepts;
//   ② every `SignInFailure` Rust can produce has a sentence — checked against
//      the RUST SOURCE, because a hand-written mirror is only as good as the
//      thing that re-reads it;
//   ③ an unrecognised reason never reaches a user as an identifier (0.2.53).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SIGN_IN_FAILURES, UNKNOWN_FAILURE, type SignInFailureCode } from './bridge-signin';
import { buildDesktopSignInUrl, signInFailureText, signInPageCopy, CONSOLE_SIGNIN_URL } from './cloud-signin';
import { S_BY_LOCALE } from './strings';
import { UI_LOCALES } from './strings/generated/locales.g';

const RUST = readFileSync(
  fileURLToPath(new URL('../../src-tauri/src/cloud_signin.rs', import.meta.url)),
  'utf8',
);

describe('the console URL this PC opens', () => {
  it('carries flow, port and state, on the one https sign-in address', () => {
    const url = buildDesktopSignInUrl(54321, 'abc123');
    expect(url.startsWith(`${CONSOLE_SIGNIN_URL}?`)).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('flow')).toBe('desktop');
    expect(q.get('port')).toBe('54321');
    expect(q.get('state')).toBe('abc123');
    // The door refuses anything that is not https, so a non-https value here
    // would be a button that silently does nothing.
    expect(url.startsWith('https://')).toBe(true);
  });

  it('🔴 the port is written the way the console is willing to read it', () => {
    // The console refuses anything that is not `^[0-9]{1,5}$` in 1024..65535
    // (signin-handoff.ts `readDesktopHandoff`). This asserts our side produces
    // exactly that — the two halves of a contract that no type connects.
    for (const port of [1024, 5000, 54321, 65535]) {
      const raw = new URL(buildDesktopSignInUrl(port, 's')).searchParams.get('port')!;
      expect(raw).toMatch(/^[0-9]{1,5}$/);
      expect(Number(raw)).toBe(port);
    }
  });

  it('escapes the state rather than trusting the generator to stay tame', () => {
    const url = buildDesktopSignInUrl(1024, 'a b&c=d');
    expect(url).toContain('state=a%20b%26c%3Dd');
    expect(new URL(url).searchParams.get('state')).toBe('a b&c=d');
    // A raw `&` would split the value in two and the desktop would then refuse
    // its own callback — which is indistinguishable from the attack the state
    // check exists to stop.
    expect(new URL(url).searchParams.get('flow')).toBe('desktop');
  });
});

describe('🔴 the Rust ↔ TS failure mirror', () => {
  it('every SignInFailure Rust can emit is named on this side, and vice versa', () => {
    // Read out of `SignInFailure::code()`'s match arms — the thing that actually
    // decides what crosses the boundary, not the enum declaration (which could
    // carry a variant that never reaches a caller).
    const block = RUST.split('pub fn code(self) -> &\'static str {')[1] ?? '';
    const fromRust = new Set([...block.matchAll(/=> "([A-Z_]+)"/g)].map((m) => m[1]!));
    expect(fromRust.size, 'no failure codes found in the Rust source — the reader is broken').toBeGreaterThan(0);
    expect([...fromRust].sort()).toEqual([...SIGN_IN_FAILURES].sort());
  });

  it('each one renders a real sentence in all nine languages', () => {
    for (const code of SIGN_IN_FAILURES) {
      for (const locale of UI_LOCALES) {
        const bag = S_BY_LOCALE[locale];
        // Routed through the same table the component uses, but read per
        // language: a sentence that exists in English and is blank in Korean is
        // the failure this loop is for.
        const key = KEY_FOR[code];
        const text = bag[key];
        expect(typeof text, `${code}/${locale}`).toBe('string');
        expect(text.trim().length, `${code}/${locale} is empty`).toBeGreaterThan(0);
        // 🔴 THE 0.2.53 ASSERTION: no identifier may reach a screen. Not a
        // proxy for it — the literal check that the sentence is not the name.
        expect(text).not.toContain(code);
        expect(text).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
      }
    }
  });
});

/** The mapping the component uses, restated here so this file can read each
 *  language rather than only the active one. Kept beside the loop that uses it;
 *  if it drifts from `cloud-signin.ts` the test above still catches a MISSING
 *  code, and the one below catches a wrong sentence. */
const KEY_FOR: Record<SignInFailureCode, keyof (typeof S_BY_LOCALE)['en']> = {
  TIMEOUT: 'cloud_signin_err_timeout',
  STATE_MISMATCH: 'cloud_signin_err_state',
  REFUSED: 'cloud_signin_err_refused',
  UNREACHABLE: 'cloud_signin_err_unreachable',
  LISTEN: 'cloud_signin_err_listen',
  BAD_ENDPOINT: 'cloud_signin_err_endpoint',
};

describe('signInFailureText', () => {
  it('gives each named failure its own sentence', () => {
    const seen = SIGN_IN_FAILURES.map((c) => signInFailureText(c));
    for (const s of seen) expect(s.trim().length).toBeGreaterThan(0);
    // Distinct, because the whole reason there are six names is that the
    // person's next move differs. Two identical sentences would mean one of the
    // names is not earning itself.
    const distinct = new Set(seen.filter((s) => s !== signInFailureText('REFUSED')));
    expect(distinct.size).toBe(SIGN_IN_FAILURES.length - 1);
  });

  it('🔴 never paints an identifier for something it does not recognise', () => {
    // 0.2.53 shipped `INJ…` to a user's screen. This is the door that shape
    // comes through, so it is asserted rather than assumed.
    for (const junk of [null, UNKNOWN_FAILURE, 'SOMETHING_NEW', 'GRANT_INVALID', '']) {
      const text = signInFailureText(junk);
      expect(text.trim().length).toBeGreaterThan(0);
      if (typeof junk === 'string' && junk !== '') expect(text).not.toContain(junk);
      expect(text).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
    }
  });
});

describe('the page copy handed to the listener', () => {
  it('is complete, so the browser can never land on a blank page', () => {
    const copy = signInPageCopy();
    for (const [k, v] of Object.entries(copy)) {
      expect(typeof v, k).toBe('string');
      expect(v.trim().length, `${k} is empty`).toBeGreaterThan(0);
    }
    // The lang attribute is a real UI locale, not a guess.
    expect(UI_LOCALES).toContain(copy.lang as (typeof UI_LOCALES)[number]);
  });

  it('the field names are the ones Rust deserializes', () => {
    // `PageCopy` in shell/cloud_signin.rs is a serde struct: a renamed field
    // here would make `begin` fail to deserialize at run time and nowhere else.
    const shell = readFileSync(
      fileURLToPath(new URL('../../src-tauri/src/shell/cloud_signin.rs', import.meta.url)),
      'utf8',
    );
    const block = shell.split('pub struct PageCopy {')[1]?.split('}')[0] ?? '';
    const fields = [...block.matchAll(/pub (\w+):/g)].map((m) => m[1]!).sort();
    expect(fields.length).toBeGreaterThan(0);
    expect(Object.keys(signInPageCopy()).sort()).toEqual(fields);
  });
});
