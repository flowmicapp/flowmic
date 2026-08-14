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
      endpoint: DEFAULT_RESEND_ENDPOINT,
    });
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
