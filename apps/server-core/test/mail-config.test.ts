// MAIL-1 — the FLOWMIC_MAIL_* env block.
//
// SPEC-REF: src/mail/config.ts (the parser, modelled clause-for-clause on
//           src/stt/managed-default.ts)
//           docs/rebuild/10-OPS-DEPLOY.md §4.1
//
// The property under test is an ASYMMETRY, and it is the whole reason this
// parser is shaped the way it is:
//   · 「mail is off」  → null, quietly, because that is a real supported state;
//   · 「mail is on but wrong」 → THROW, loudly, at boot, naming the key.
// A parser that folded the second into the first would hand an operator a
// running server they believe can send email. Every case below exists to keep
// those two answers apart.
//
// ⚠️ No key in this file is real, and none of them may be. The shapes below are
// deliberately NOT vendor-shaped: several vendor prefixes are outright
// fingerprints in `verify/lint/no-cloud-keys.mjs`, and this file avoids writing
// any of them even inside a comment — a rule that holds only in code is a rule
// that breaks the day somebody tightens the regex. The deeper reason is that a
// placeholder which LOOKS like a credential is how a real one eventually gets
// pasted over it without anybody noticing the diff.

import { describe, expect, it } from 'vitest';
import { DEFAULT_RESEND_ENDPOINT, mailConfigFromEnv } from '../src/mail/config';

const FAKE_KEY = 'mail-api-key-for-tests-only';

/** A complete, valid block. Cases below take this and break ONE thing, so a
 *  failure names the field that broke rather than 「something in here」. */
function goodEnv(): NodeJS.ProcessEnv {
  return {
    FLOWMIC_MAIL_ENABLED: '1',
    FLOWMIC_MAIL_PROVIDER: 'resend',
    FLOWMIC_MAIL_API_KEY: FAKE_KEY,
    FLOWMIC_MAIL_FROM: 'FlowMic <noreply@flowmic.app>',
    FLOWMIC_MAIL_RESET_BASE_URL: 'https://flowmic.app/reset-password',
  };
}

describe('mail config: the OFF state is a state, not a failure', () => {
  it('unset → null', () => {
    expect(mailConfigFromEnv({})).toBeNull();
  });

  // The strict-'1' gate, driven with the values a real env file actually grows.
  // Every one of these is a human meaning 「on」 — and every one of them is read
  // as OFF, on purpose, because the alternative (guessing) fails toward a server
  // that thinks it can send mail.
  it.each(['0', 'TRUE', 'True', 'yes', 'on', ' 1', ''])('%o → null (strict gate)', (v) => {
    expect(mailConfigFromEnv({ ...goodEnv(), FLOWMIC_MAIL_ENABLED: v })).toBeNull();
  });

  it("'true' is accepted alongside '1' — same as FLOWMIC_MANAGED_STT_ENABLED", () => {
    expect(mailConfigFromEnv({ ...goodEnv(), FLOWMIC_MAIL_ENABLED: 'true' })?.provider).toBe('resend');
  });

  it('a broken block with the gate OFF does not throw — nothing is being claimed', () => {
    // An operator half-way through writing the block, or one who turned mail off
    // and left the keys behind, must still be able to boot.
    expect(mailConfigFromEnv({ FLOWMIC_MAIL_ENABLED: '0', FLOWMIC_MAIL_PROVIDER: 'nonsense' })).toBeNull();
  });
});

describe('mail config: ON and complete', () => {
  it('parses every field and defaults the endpoint to the vendor', () => {
    const c = mailConfigFromEnv(goodEnv());
    expect(c).toEqual({
      provider: 'resend',
      apiKey: FAKE_KEY,
      from: 'FlowMic <noreply@flowmic.app>',
      resetBaseUrl: 'https://flowmic.app/reset-password',
      // NR-2a — DERIVED, not required: same origin as the reset page, `/verify`.
      verifyBaseUrl: 'https://flowmic.app/verify',
      endpoint: DEFAULT_RESEND_ENDPOINT,
      // 2026-09-02 — non-null only for the `file` provider (mail/file.ts).
      fileDir: null,
    });
  });

  // ── NR-2a — the verification link base ──────────────────────────────────────
  it('derives the verify base from the reset base ORIGIN, not from its path', () => {
    // A reset base on a deep path must not produce `/console/deep/verify`. The
    // derivation is origin + '/verify', and this is the assertion that says so
    // rather than trusting that the production value happens to be flat.
    const c = mailConfigFromEnv({
      ...goodEnv(),
      FLOWMIC_MAIL_RESET_BASE_URL: 'https://flowmic.app/console/deep/reset-password',
    });
    expect(c?.verifyBaseUrl).toBe('https://flowmic.app/verify');
  });

  it('FLOWMIC_MAIL_VERIFY_BASE_URL overrides the derivation (a console on another host)', () => {
    const c = mailConfigFromEnv({ ...goodEnv(), FLOWMIC_MAIL_VERIFY_BASE_URL: 'https://console.example.com/v' });
    expect(c?.verifyBaseUrl).toBe('https://console.example.com/v');
    // …and the reset base is untouched by the override: two links, two answers.
    expect(c?.resetBaseUrl).toBe('https://flowmic.app/reset-password');
  });

  it('🔴 a BAD verify override is a NAMED boot failure, never a quiet fall back to the derived value', () => {
    // The whole reason mail/config.ts refuses to boot on a bad value: "I did not
    // configure it" and "I configured it wrong" must not produce the same server.
    expect(() => mailConfigFromEnv({ ...goodEnv(), FLOWMIC_MAIL_VERIFY_BASE_URL: 'not a url' })).toThrow(
      /FLOWMIC_MAIL_VERIFY_BASE_URL/,
    );
    expect(() => mailConfigFromEnv({ ...goodEnv(), FLOWMIC_MAIL_VERIFY_BASE_URL: 'mailto:a@b.co' })).toThrow(
      /FLOWMIC_MAIL_VERIFY_BASE_URL must be http/,
    );
  });

  it('FLOWMIC_MAIL_ENDPOINT overrides the vendor endpoint (staging / a local sink)', () => {
    const c = mailConfigFromEnv({ ...goodEnv(), FLOWMIC_MAIL_ENDPOINT: 'http://127.0.0.1:9/emails' });
    expect(c?.endpoint).toBe('http://127.0.0.1:9/emails');
  });

  it('http is allowed for the reset link (a LAN / staging console is a real deployment)', () => {
    // ⚠️ A GENERIC RFC-1918 address on purpose, not the owner's office range.
    // `verify/lint/no-lan-ip.mjs` excludes test files by name, so an address
    // from 100.64.7.* here would be debt the gate cannot see — and invisible
    // debt is the kind that gets copied. 192.168.1.x is what that lint's own
    // header names as the legitimate documentation shape.
    const c = mailConfigFromEnv({ ...goodEnv(), FLOWMIC_MAIL_RESET_BASE_URL: 'http://192.168.1.50/reset' });
    expect(c?.resetBaseUrl).toBe('http://192.168.1.50/reset');
  });
});

describe('mail config: ON and wrong → FAIL LOUD, and the message names the key', () => {
  // The assertion is on the KEY NAME in the message, not just 「it threw」: the
  // whole value of failing at boot is that the operator is told which line of
  // /etc/flowmic-app/env to look at. A throw with a vague message costs them the
  // same hour a silent null would.
  it('an unknown provider names FLOWMIC_MAIL_PROVIDER and lists what is supported', () => {
    expect(() => mailConfigFromEnv({ ...goodEnv(), FLOWMIC_MAIL_PROVIDER: 'sendgrid' }))
      .toThrow(/FLOWMIC_MAIL_PROVIDER is invalid: "sendgrid".*supported: resend/s);
  });

  it('a missing provider throws too — absent is not 「pick a default for me」', () => {
    const env = goodEnv();
    delete env.FLOWMIC_MAIL_PROVIDER;
    expect(() => mailConfigFromEnv(env)).toThrow(/FLOWMIC_MAIL_PROVIDER is invalid/);
  });

  it.each(['FLOWMIC_MAIL_API_KEY', 'FLOWMIC_MAIL_FROM', 'FLOWMIC_MAIL_RESET_BASE_URL'])(
    'missing %s throws by name',
    (key) => {
      const env = goodEnv();
      delete env[key];
      expect(() => mailConfigFromEnv(env)).toThrow(new RegExp(`${key} is missing or empty`));
    },
  );

  it.each(['FLOWMIC_MAIL_API_KEY', 'FLOWMIC_MAIL_FROM', 'FLOWMIC_MAIL_RESET_BASE_URL'])(
    'BLANK %s throws by name — a blank value is a broken deploy script, not a request',
    (key) => {
      // Same rule config.ts envSecretString makes for every other secret-shaped
      // var: present-but-empty is the shape a `KEY=$UNSET_VAR` line produces.
      expect(() => mailConfigFromEnv({ ...goodEnv(), [key]: '   ' })).toThrow(
        new RegExp(`${key} is missing or empty`),
      );
    },
  );

  it('a reset base URL that is not a URL throws', () => {
    expect(() => mailConfigFromEnv({ ...goodEnv(), FLOWMIC_MAIL_RESET_BASE_URL: 'flowmic.app/reset' }))
      .toThrow(/FLOWMIC_MAIL_RESET_BASE_URL is not a URL/);
  });

  it('a reset base URL that parses but is not http(s) throws', () => {
    // `new URL('mailto:x@y.co')` succeeds. Parsing alone is not the check — the
    // link has to be one a mail client will open.
    expect(() => mailConfigFromEnv({ ...goodEnv(), FLOWMIC_MAIL_RESET_BASE_URL: 'mailto:ops@flowmic.app' }))
      .toThrow(/must be http\(s\)/);
  });
});

// 🔴 2026-09-02 — the `file` provider (mail/file.ts), added to retire
// FLOWMIC_INTERNAL_RESET_TOKEN_ECHO / FLOWMIC_INTERNAL_VERIFICATION_CODE_ECHO
// (owner-ordered deletion — docs/decisions/2026-09-02-owner-plain-language-
// lan-ci-and-two-security-questions.md §3, problem 1). It is a TEST FIXTURE,
// not a second production transport: see mail/config.ts's `VALID_MAIL_PROVIDERS`
// doc for why that distinction is load-bearing.
describe('mail config: the `file` provider (test fixture, not a second transport)', () => {
  function fileEnv(over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      FLOWMIC_MAIL_ENABLED: '1',
      FLOWMIC_MAIL_PROVIDER: 'file',
      // The bench declaration this describe block's own tests are pinning
      // below — every OTHER test in this file wants a working fixture, not a
      // demonstration of the gate, so it is on by default here and turned off
      // explicitly where the gate itself is under test.
      FLOWMIC_TEST_BENCH: '1',
      FLOWMIC_MAIL_FROM: 'FlowMic <noreply@flowmic.app>',
      FLOWMIC_MAIL_RESET_BASE_URL: 'https://flowmic.app/reset-password',
      FLOWMIC_MAIL_FILE_DIR: '/tmp/flowmic-mail-fixture',
      ...over,
    };
  }

  // 🔴 REVERSE CONTROL — this is the whole point of the bench gate. A copied
  // `.env` carries the mail lines without necessarily carrying this second,
  // unrelated flag; before this fix `mailConfigFromEnv` had no opinion about
  // that at all, so it built a working file-provider config regardless.
  it('REFUSES provider:file at boot when FLOWMIC_TEST_BENCH is not set — by name, not a fallback to resend', () => {
    const env = fileEnv();
    delete env.FLOWMIC_TEST_BENCH;
    expect(() => mailConfigFromEnv(env)).toThrow(/FLOWMIC_TEST_BENCH/);
  });

  it('also refuses when FLOWMIC_TEST_BENCH is set to something other than the literal "1"', () => {
    expect(() => mailConfigFromEnv(fileEnv({ FLOWMIC_TEST_BENCH: 'true' }))).toThrow(/FLOWMIC_TEST_BENCH/);
    expect(() => mailConfigFromEnv(fileEnv({ FLOWMIC_TEST_BENCH: '0' }))).toThrow(/FLOWMIC_TEST_BENCH/);
  });

  it('builds the fixture once FLOWMIC_TEST_BENCH=1 is declared', () => {
    expect(() => mailConfigFromEnv(fileEnv())).not.toThrow();
    expect(mailConfigFromEnv(fileEnv())?.provider).toBe('file');
  });

  it('parses with apiKey/endpoint left empty (no vendor, no meaning for either)', () => {
    const c = mailConfigFromEnv(fileEnv());
    expect(c).toEqual({
      provider: 'file',
      apiKey: '',
      from: 'FlowMic <noreply@flowmic.app>',
      resetBaseUrl: 'https://flowmic.app/reset-password',
      verifyBaseUrl: 'https://flowmic.app/verify',
      endpoint: '',
      fileDir: '/tmp/flowmic-mail-fixture',
    });
  });

  it('does NOT require FLOWMIC_MAIL_API_KEY — a directory write has no vendor to authenticate to', () => {
    const env = fileEnv();
    delete env.FLOWMIC_MAIL_API_KEY; // never set in fileEnv(), asserted explicitly for the reader
    expect(() => mailConfigFromEnv(env)).not.toThrow();
  });

  it('missing FLOWMIC_MAIL_FILE_DIR throws by name — this provider is worthless without it', () => {
    const env = fileEnv();
    delete env.FLOWMIC_MAIL_FILE_DIR;
    expect(() => mailConfigFromEnv(env)).toThrow(/FLOWMIC_MAIL_FILE_DIR is missing or empty/);
  });

  it('still requires FLOWMIC_MAIL_FROM and FLOWMIC_MAIL_RESET_BASE_URL — the mailer builds real text from them', () => {
    const noFrom = fileEnv();
    delete noFrom.FLOWMIC_MAIL_FROM;
    expect(() => mailConfigFromEnv(noFrom)).toThrow(/FLOWMIC_MAIL_FROM is missing or empty/);
    const noReset = fileEnv();
    delete noReset.FLOWMIC_MAIL_RESET_BASE_URL;
    expect(() => mailConfigFromEnv(noReset)).toThrow(/FLOWMIC_MAIL_RESET_BASE_URL is missing or empty/);
  });
});
