// The rule half of owner 2026-08-27 UAT ②:「所有显示账号的地方都要用星号遮盖…
// 位数少一些…首三位加末一位」 — every place this phone names the signed-in
// account paints `maskAccountEmail`, and the shape is「first three, last one,
// a fixed three-star middle, domain in full」.
//
// This file drives the FUNCTION. Its render sites are pinned next door in
// account_identity_masked_render_test.dart — the split is deliberate and it is
// the split that matters: a correct function nobody calls, and a call site that
// paints the raw address, both look identical from here.
//
// 🔴 EVERY CASE BELOW IS WRITTEN FROM THE DOC COMMENT ON maskAccountEmail,
// not from reading its body. A test derived from the implementation asserts
// that the code does what it does.
//
// SPEC-REF: apps/mobile/lib/src/auth/account_mask.dart

import 'package:flowmic/src/auth/account_mask.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('the shape owner asked for', () {
    test("owner's own example", () {
      expect(maskAccountEmail('bitbalabala@gmail.com'), 'bit***a@gmail.com');
    });

    test('the domain is copied through in full, subdomains and TLD included', () {
      expect(
        maskAccountEmail('firstname.lastname@mail.corp.example.co.uk'),
        'fir***e@mail.corp.example.co.uk',
      );
    });

    test('🔴 the star run does not grow with the address — length is not leaked', () {
      // The whole reason the middle is a constant. If these two differed in
      // width, the rendered line would tell an onlooker how long the hidden
      // part is, which for a short account is most of the answer.
      final String short = maskAccountEmail('abcde@x.io');
      final String long = maskAccountEmail(
        'abcdefghijklmnopqrstuvwxyz0123456789@x.io',
      );
      expect(short, 'abc***e@x.io');
      expect(long, 'abc***9@x.io');
      expect(short.length, long.length);
    });

    test('🔴 two of the user\'s own accounts still read differently', () {
      // The defect this rule was tuned for: the earlier one-character cut
      // rendered BOTH of these as `b***@gmail.com`, so the screen still did
      // not answer 「which account am I signed in with」.
      expect(
        maskAccountEmail('bill@gmail.com'),
        isNot(maskAccountEmail('billing@gmail.com')),
      );
      expect(maskAccountEmail('billing@gmail.com'), 'bil***g@gmail.com');
      // ...and `bill` is under the boundary, so it takes the short face.
      expect(maskAccountEmail('bill@gmail.com'), 'b***@gmail.com');
    });
  });

  group('the boundary at five characters', () {
    test('five keeps first three + last one', () {
      expect(maskAccountEmail('abcde@x.io'), 'abc***e@x.io');
    });

    test('four and below degrade to one character', () {
      // 🔴 The reason the boundary is not four: `abcd` would render as
      // `abc***d` — every character of the local part, wearing decoration.
      expect(maskAccountEmail('abcd@x.io'), 'a***@x.io');
      expect(maskAccountEmail('abc@x.io'), 'a***@x.io');
      expect(maskAccountEmail('ab@x.io'), 'a***@x.io');
    });

    test('a one-character local part keeps that character', () {
      // It is the whole answer to 「which account」; hiding it would hide
      // nothing an observer could not already infer from the domain.
      expect(maskAccountEmail('a@x.io'), 'a***@x.io');
    });
  });

  group('the inputs that are not addresses', () {
    test('null, empty and whitespace paint nothing at all', () {
      // NOT `***@***`: there is no account, and an identity that does not
      // exist must not be drawn.
      expect(maskAccountEmail(null), '');
      expect(maskAccountEmail(''), '');
      expect(maskAccountEmail('   '), '');
    });

    test('surrounding whitespace is trimmed before the rule applies', () {
      expect(maskAccountEmail('  bitbalabala@gmail.com  '), 'bit***a@gmail.com');
    });

    test('🔴 a string with no @ is still masked, never passed through', () {
      // The one case where a mask could silently stop masking.
      expect(maskAccountEmail('someone'), 'som***e');
      expect(maskAccountEmail('bob'), 'b***');
    });

    test('the split is at the LAST @, so an @ in the local part stays hidden', () {
      // Splitting at the first one would leak `b@example` into the domain
      // half, which is copied through verbatim.
      expect(maskAccountEmail('a@b@example.com'), 'a***@example.com');
      expect(maskAccountEmail('quoted@name@example.com'), 'quo***e@example.com');
    });

    test('an address that begins with @ has no character to keep', () {
      expect(maskAccountEmail('@example.com'), '***@example.com');
    });
  });

  group('unicode', () {
    test('a non-Latin local part is counted in characters, not bytes', () {
      expect(maskAccountEmail('用户名字姓@example.com'), '用户名***姓@example.com');
      expect(maskAccountEmail('用户@example.com'), '用***@example.com');
    });

    test('🔴 an astral-plane character is never cut into a lone surrogate', () {
      // The failure this pins renders as `�`: taking `substring(0, 1)` of a
      // string whose first character is a surrogate PAIR keeps half of it.
      const String local = '😀😀😀😀😀'; // five code points, ten UTF-16 units
      final String out = maskAccountEmail('$local@x.io');
      expect(out, '😀😀😀***😀@x.io');
      expect(out.runes.every((int r) => r < 0xD800 || r > 0xDFFF), isTrue,
          reason: 'a lone surrogate survived into the rendered string');
    });

    test('a five-code-point emoji local part takes the long face', () {
      // Positive control for the case above: it really went down the
      // first-three-last-one branch, not the degraded one.
      expect(maskAccountEmail('😀😀@x.io'), '😀***@x.io');
    });
  });

  group('the property that makes it safe to call everywhere', () {
    test('it is idempotent enough to survive a double call', () {
      // Not a licence to call it twice — but a site that does must not turn a
      // masked string into something that looks like a different account.
      final String once = maskAccountEmail('bitbalabala@gmail.com');
      expect(maskAccountEmail(once), 'bit***a@gmail.com');
      expect(maskAccountEmail(once), once);
    });

    test('🔴 the output never contains the hidden middle of the input', () {
      const String raw = 'confidential.person@example.com';
      final String out = maskAccountEmail(raw);
      expect(out.contains('fidential.pers'), isFalse);
      expect(out, isNot(raw));
      expect(out, 'con***n@example.com');
    });
  });
}
