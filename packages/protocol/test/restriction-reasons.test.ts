// Q2 — the enumerated restriction reasons, and the four rules their copy has to
// obey.
//
// SPEC-REF: packages/protocol/src/restriction-reasons.ts (the table)
//           docs/strategy/2026-08-12-a2-3-restricted-use-design.md §6.1 (the
//             three hard copy constraints, owner ①③⑤)
//           docs/decisions/2026-08-12-owner-needle-closure-and-default-
//             authority.md §Stamp Q2
//
// 🔴 WHY THIS FILE EXISTS RATHER THAN A LINT. `verify/lint/i18n-error-keys.mjs`
// parses `error-codes.ts` and asserts zh_CN + en. This table is not that table
// and needs a STRICTER rule — FOUR languages, because owner asked for Chinese,
// English, Japanese and Korean and
// because a reason with a missing language would render as a bare identifier on
// exactly the screen where a person is being told something about themselves.
// The lint is not widened to cover both: that parser exists to answer one
// question about one file, and giving it a second file to know about is how a
// gate starts being wrong about which thing it is checking.

import { describe, expect, it } from 'vitest';
import {
  RESTRICTION_REASONS,
  RESTRICTION_REASON_KEYS,
  isRestrictionReason,
  type RestrictionReason,
} from '../src/restriction-reasons';

const LANGS = ['zh_CN', 'en', 'ja', 'ko'] as const;

describe('restriction reasons', () => {
  it('every reason carries all FOUR languages, non-empty', () => {
    // The probe must not be blind: a table that somehow parsed to zero entries
    // would make every assertion below vacuously true.
    expect(RESTRICTION_REASON_KEYS.length).toBeGreaterThanOrEqual(5);
    for (const key of RESTRICTION_REASON_KEYS) {
      const copy = RESTRICTION_REASONS[key] as Record<string, string>;
      for (const lang of LANGS) {
        expect(copy[lang], `${key} is missing ${lang}`).toBeTypeOf('string');
        expect((copy[lang] ?? '').trim(), `${key}.${lang} is empty`).not.toBe('');
      }
      // …and nothing BUT those four. A fifth key here would be a language no
      // client has a column for, i.e. copy nobody can render.
      expect(Object.keys(copy).sort()).toEqual([...LANGS].sort());
    }
  });

  it('🔴 owner ① — no reason reads as 「封禁 / ban / suspend」 in any language', () => {
    // The whole rename. owner: 「封禁这个词太权威，改为限制使用」("the word 封禁/ban is
    // too authoritative, change it to 限制使用/restricted use"), and a reason line
    // that says 「已封禁」("already banned") under a header that says 「限制使用」
    // ("restricted use") puts the rejected word back on the same screen.
    const banned = [/封禁/, /封停/, /\bban(ned)?\b/i, /\bsuspend(ed)?\b/i, /停止使用/, /정지/, /凍結/, /凍結/];
    for (const key of RESTRICTION_REASON_KEYS) {
      for (const lang of LANGS) {
        const text = (RESTRICTION_REASONS[key] as Record<string, string>)[lang] ?? '';
        for (const re of banned) {
          expect(re.test(text), `${key}.${lang} uses a forbidden word: ${text}`).toBe(false);
        }
      }
    }
  });

  it('🔴 owner ⑤ — no reason promises that anyone will reply', () => {
    // 「不提供申诉通道」("no appeals channel is provided"). A sentence like
    // 「如有疑问请联系我们」("if you have questions, please contact us") would be a
    // promise with no mechanism behind it — the same red line as 「待投递」
    // ("pending delivery") without a queue.
    const promises = [/联系我们/, /申诉/, /contact us/i, /get in touch/i, /we will respond/i, /reply/i, /お問い合わせ/, /문의/];
    for (const key of RESTRICTION_REASON_KEYS) {
      for (const lang of LANGS) {
        const text = (RESTRICTION_REASONS[key] as Record<string, string>)[lang] ?? '';
        for (const re of promises) {
          expect(re.test(text), `${key}.${lang} promises a response: ${text}`).toBe(false);
        }
      }
    }
  });

  it('the membership test is a real test, not a cast', () => {
    // 13 册 §7 F1 ⑤: a hand-written predicate is an assertion the compiler does
    // not check. This one is checked here, in both directions.
    expect(isRestrictionReason('terms_violation')).toBe(true);
    expect(isRestrictionReason('other')).toBe(true);
    expect(isRestrictionReason('TERMS_VIOLATION')).toBe(false);
    expect(isRestrictionReason('')).toBe(false);
    expect(isRestrictionReason(null)).toBe(false);
    expect(isRestrictionReason(undefined)).toBe(false);
    expect(isRestrictionReason(42)).toBe(false);
    // 🔴 Prototype keys are not reasons. `hasOwnProperty` rather than `in` is
    // what makes this true — with `in`, 'toString' would pass and a restriction
    // could be stamped with a reason no client has copy for.
    expect(isRestrictionReason('toString')).toBe(false);
    expect(isRestrictionReason('constructor')).toBe(false);
  });

  it('the key array and the table cannot drift apart', () => {
    expect([...RESTRICTION_REASON_KEYS].sort()).toEqual(Object.keys(RESTRICTION_REASONS).sort());
    // Every key is usable as the type, which is the whole point of deriving one
    // from the other.
    const typed: RestrictionReason[] = RESTRICTION_REASON_KEYS;
    expect(typed).toContain('other');
  });
});
