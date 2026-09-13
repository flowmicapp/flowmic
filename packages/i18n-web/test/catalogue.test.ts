// What these cases are FOR.
//
// The generator already refuses to emit a broken catalogue, and
// `verify:lint i18n-generated-fresh` already refuses a stale one. Neither of
// those travels with the package: a consumer repo installs the tarball and gets
// `dist/`, not scripts/i18n/gen-i18n-web.mjs. So these assertions are the ones
// that hold at the point of USE — they read only what ships.
//
// They are deliberately RUNTIME assertions even where a type already says the
// same thing. `WebMessages` makes a missing key a compile error in this repo's
// tsconfig; it says nothing about the emitted JavaScript, and the emitted
// JavaScript is what a browser runs.
//
// REVERSE CONTROL [measured 2026-09-07, machine dev-pc-a]: `{count}` was
// removed from zh-CN's `outboxPendingNotice` in the generated catalogue — the
// exact shape of a translator dropping a value while leaving a grammatical
// sentence. Two cases went red ('every language interpolates exactly the declared
// placeholders' and 'substitutes a declared placeholder in every language') and
// the other seven stayed green. Restored from a backup outside the repo; the
// generator's own `--check` confirms the file is byte-identical again.

import { describe, expect, it } from 'vitest';
import {
  MESSAGES,
  MESSAGE_PARAMS,
  WEB_LOCALES,
  BASE_WEB_LOCALE,
  DEFAULT_WEB_LOCALE,
  formatMessage,
  isWebLocaleCode,
  type WebMessageKey,
} from '../src/index.js';

const KEYS = Object.keys(MESSAGE_PARAMS) as WebMessageKey[];
const CODES = WEB_LOCALES.map((row) => row.code);
const holes = (s: string) => [...s.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).sort();

describe('catalogue shape', () => {
  it('carries every registry language', () => {
    expect(Object.keys(MESSAGES).sort()).toEqual([...CODES].sort());
    expect(CODES).toContain(BASE_WEB_LOCALE);
    expect(CODES).toContain(DEFAULT_WEB_LOCALE);
  });

  it('carries every key in every language, non-empty', () => {
    expect(KEYS.length).toBeGreaterThan(0);
    for (const code of CODES) {
      const missing = KEYS.filter((k) => typeof MESSAGES[code][k] !== 'string' || MESSAGES[code][k] === '');
      expect(`${code}: ${missing.join(', ')}`).toBe(`${code}: `);
    }
  });

  // The failure this guards is silent: a translation that drops `$count` renders
  // a grammatical sentence with the number gone.
  it('every language interpolates exactly the declared placeholders', () => {
    for (const code of CODES) {
      for (const key of KEYS) {
        expect({ code, key, holes: holes(MESSAGES[code][key]) }).toEqual({
          code,
          key,
          holes: [...MESSAGE_PARAMS[key]].sort(),
        });
      }
    }
  });

  // Owner 2026-08-22 iron rule: no internal token reaches a user's screen. A
  // stray brace here would be one, and it would look like a placeholder.
  it('has no brace that is not a declared placeholder', () => {
    for (const code of CODES) {
      for (const key of KEYS) {
        const stripped = MESSAGES[code][key].replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, '');
        expect(`${code}#${key}: ${stripped.match(/[{}]/)?.[0] ?? ''}`).toBe(`${code}#${key}: `);
      }
    }
  });
});

describe('formatMessage', () => {
  it('substitutes a declared placeholder in every language', () => {
    for (const code of CODES) {
      const rendered = formatMessage(code, 'outboxPendingNotice', { count: 3 });
      expect(rendered).toContain('3');
      expect(rendered).not.toContain('{count}');
    }
  });

  it('returns hole-free sentences verbatim', () => {
    expect(formatMessage('en', 'statusInjected')).toBe(MESSAGES.en.statusInjected);
  });

  // GEN-1 USED TO LIVE HERE, pinned to `spokenLangNote` because English authors
  // it as two adjacent Dart literals and this was the one wrapped sentence the
  // subset shipped. Card M-1 dropped that key from the selection (the sentence
  // promises a local model on your own computer, and this client only ever
  // reaches a PC through the relay — design 2026-09-08 §1.4 / §9 F-8), and
  // measured on the same commit: NO selected key is a wrapped literal in any of
  // the nine locales. Re-pointing the case at another key would have been a
  // pin with no subject. The generator's own handling of wrapped literals is
  // still exercised — against en#spokenLangNote read straight out of
  // i18n/mobile/en.json, which is where it still lives — by
  // scripts/i18n-interpolation.test.mjs ('web convert() wrapped adjacent
  // literals'), in verify:scripts.
  //
  // What survives here is the assertion that holds at the point of USE for
  // every sentence rather than one: whatever the generator did to Dart source
  // text, none of that source text reached the browser. A half-decoded escape
  // or a literal glued in with its own quotes still renders and still compiles;
  // it just says something slightly different from what the phone says.
  it('ships rendered text, not Dart source', () => {
    for (const code of CODES) {
      for (const key of KEYS) {
        const s = MESSAGES[code][key];
        const artefact =
          (/^['"]|['"]$/.test(s) && 'wrapping quote kept from the literal') ||
          (s.includes("\\'") && "an escape the generator did not decode (\\')") ||
          (s.includes('\\"') && 'an escape the generator did not decode (\\")') ||
          (s.includes('\\$') && 'an escape the generator did not decode (\\$)') ||
          (s.includes("''") && "a literal seam ('')") ||
          '';
        expect(`${code}#${key}: ${artefact}`).toBe(`${code}#${key}: `);
      }
    }
  });

  // The point of the throw: the two silent alternatives (leave `{count}`, or
  // substitute '') both produce something that looks finished and is wrong.
  it('throws rather than rendering a placeholder a caller forgot', () => {
    const loose = formatMessage as (
      locale: (typeof CODES)[number],
      key: WebMessageKey,
      params?: Record<string, string | number>,
    ) => string;
    expect(() => loose('en', 'outboxPendingNotice', {})).toThrow(/needs \{count\}/);
  });

  it('falls back to the base language for a code that is not in the registry', () => {
    const loose = formatMessage as (locale: string, key: WebMessageKey) => string;
    expect(loose('xx-YY', 'statusInjected')).toBe(MESSAGES[BASE_WEB_LOCALE].statusInjected);
  });
});

describe('isWebLocaleCode', () => {
  it('accepts every registry code and rejects near misses', () => {
    for (const code of CODES) expect(isWebLocaleCode(code)).toBe(true);
    for (const near of ['zh', 'en-US', 'EN', '', null, undefined, 7]) {
      expect(isWebLocaleCode(near)).toBe(false);
    }
  });
});
