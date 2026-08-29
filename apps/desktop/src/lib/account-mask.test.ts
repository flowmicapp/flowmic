// The account-identity mask (owner 2026-08-27:「所有显示账号的地方都要用星号
// 遮盖」, final rule「首三位 + 末一位，中间固定星号」).
//
// 🔴 THE VECTOR TABLE IS THE PHONE'S. Every case below is copied from
// `apps/mobile/test/account_mask_test.dart`, because the owner's rule is 「the
// same on both clients」 and the only way two hand-written implementations stay
// the same is if they are measured against ONE table. A vector added on one side
// and not the other is how 「byte-identical」 quietly stops being true.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { maskAccountEmail } from './account-mask';

/** [input, expected] — the shared table. See the header for where it comes from. */
const VECTORS: ReadonlyArray<readonly [string | null | undefined, string]> = [
  // The owner's own example.
  ['bitbalabala@gmail.com', 'bit***a@gmail.com'],

  // 🔴 THE PAIR THE RULE EXISTS FOR. These two must not render the same line —
  // that was the defect the one-character mask reintroduced, and it is why the
  // rule keeps three characters rather than one.
  ['billing@gmail.com', 'bil***g@gmail.com'],
  ['bill@gmail.com', 'b***@gmail.com'],

  // The boundary, from both sides. At 5 the tail appears; at 4 it must not,
  // because `abc***d` for `abcd` shows every character of the address.
  ['abcde@x.io', 'abc***e@x.io'],
  ['abcd@x.io', 'a***@x.io'],
  ['abc@x.io', 'a***@x.io'],
  ['ab@x.io', 'a***@x.io'],
  ['a@x.io', 'a***@x.io'],

  // No account ⇒ no line. Never `***@***`, which paints an identity that does
  // not exist.
  [null, ''],
  [undefined, ''],
  ['', ''],
  ['   ', ''],
  ['  bitbalabala@gmail.com  ', 'bit***a@gmail.com'],

  // Not an address, but it IS what the server sent. Rendering it verbatim would
  // be the one case where the mask silently stops masking.
  ['someone', 'som***e'],
  ['bob', 'b***'],

  // Split at the LAST `@`: a local part containing an `@` must not have more of
  // itself revealed by a first-`@` split.
  ['a@b@example.com', 'a***@example.com'],
  ['quoted@name@example.com', 'quo***e@example.com'],
  ['@example.com', '***@example.com'],

  // Code points, not UTF-16 units.
  ['用户名字姓@example.com', '用户名***姓@example.com'],
  ['用户@example.com', '用***@example.com'],
  // 🔴 The astral case is the one `.slice(0,3)` gets wrong: it would cut a
  // surrogate pair in half and paint `�`.
  ['😀😀@x.io', '😀***@x.io'],
];

describe('maskAccountEmail', () => {
  it('matches the shared vector table', () => {
    // A blind loop over an empty table would pass. Pin the size first.
    expect(VECTORS.length).toBeGreaterThan(15);
    for (const [input, expected] of VECTORS) {
      expect(maskAccountEmail(input), `input ${JSON.stringify(input)}`).toBe(expected);
    }
  });

  it('is idempotent — masking a masked address changes nothing', () => {
    // Not a curiosity: a render site that masks a value some other layer already
    // masked must not produce `bit***@gmail.com`. It is also the cheapest proof
    // that the function reads its input rather than counting on it being raw.
    const once = maskAccountEmail('bitbalabala@gmail.com');
    expect(once).toBe('bit***a@gmail.com');
    expect(maskAccountEmail(once)).toBe(once);
  });

  it('🔴 never returns the address it was given', () => {
    // The property the whole card is about, asserted directly rather than
    // inferred from the vectors above.
    for (const raw of [
      'bitbalabala@gmail.com',
      'bill@gmail.com',
      'a@x.io',
      'someone',
      '用户名字姓@example.com',
    ]) {
      expect(maskAccountEmail(raw)).not.toBe(raw);
      expect(maskAccountEmail(raw)).toContain('***');
    }
  });

  it('keeps the domain whole and hides a fixed width, never the length', () => {
    // Two separate claims, both load-bearing:
    //   · the domain answers 「which of my accounts」 and is shown in full;
    //   · the mask is three stars regardless of how much it hides, because a
    //     mask that grows with the address leaks the address's length.
    expect(maskAccountEmail('a-very-long-local-part-indeed@example.co.uk')).toBe(
      'a-v***d@example.co.uk',
    );
    expect(maskAccountEmail('abcdef@example.co.uk')).toBe('abc***f@example.co.uk');
    for (const local of ['abcde', 'abcdefghij', 'abcdefghijklmnopqrst']) {
      const out = maskAccountEmail(`${local}@x.io`);
      expect(out.match(/\*/g)?.length, `${local} leaked its length`).toBe(3);
      expect(out.endsWith('@x.io')).toBe(true);
    }
  });
});

describe('🔴 the two clients may not drift', () => {
  it('the phone spells the same rule with the same two numbers', () => {
    // The rule is two constants: how wide the mask is, and the shortest local
    // part that still shows a tail. Both are written out in Dart and in TS, and
    // nothing but this test connects them.
    //
    // ⚠️ TOLERANT OF THE FILE BEING ABSENT, AND STRICT WHEN IT IS THERE. The
    // desktop's correctness does not depend on the phone shipping — the claim
    // being checked is「if both exist, they agree」. An absent file means the
    // phone's half of this card has not landed, which is not a desktop defect
    // and must not be reported as one. What it may NOT do is pass blindly, so
    // the parse itself is asserted before the comparison.
    const path = fileURLToPath(
      new URL('../../../mobile/lib/src/auth/account_mask.dart', import.meta.url),
    );
    let dart: string;
    try {
      dart = readFileSync(path, 'utf8');
    } catch {
      return; // the phone's half is not in this tree yet
    }
    const body = dart.match(/_kMaskBody\s*=\s*'([^']*)'/)?.[1];
    const min = dart.match(/_kMinLocalForTail\s*=\s*(\d+)/)?.[1];
    expect(body, 'could not read _kMaskBody — this test has gone blind').toBeDefined();
    expect(min, 'could not read _kMinLocalForTail — this test has gone blind').toBeDefined();

    // Read back out of OUR implementation the same way, so neither side is a
    // number typed into a test.
    const ts = readFileSync(fileURLToPath(new URL('./account-mask.ts', import.meta.url)), 'utf8');
    expect(ts.match(/MASK_BODY\s*=\s*'([^']*)'/)?.[1]).toBe(body);
    expect(ts.match(/MIN_LOCAL_FOR_TAIL\s*=\s*(\d+)/)?.[1]).toBe(min);
  });
});
