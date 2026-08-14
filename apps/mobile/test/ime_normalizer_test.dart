// WP-R4-2 ⑥ — real-device IME hardening. A Chinese IME rewrites '.'/':'/digits
// to fullwidth codepoints that look identical but never parse; the pairing fields
// fold them back to ASCII live. The headline vector is the exact string a Chinese
// IME produced for the endpoint on the physical tablet (2026-07-24 finding).

import 'package:flutter/services.dart';
import 'package:flowmic/src/ui/ime_normalizer.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('normalizeFullwidthAscii', () {
    test('the real-device endpoint vector folds to a parseable address', () {
      // '１９２。１６８。１。７８：４１８７９' (fullwidth digits + ideographic stop +
      // fullwidth colon) → the ASCII the socket layer can actually dial.
      //
      // 🔴 The vector used to be the office LAN address this was first measured
      // on. That broke the day the open-source export started redacting network
      // ranges: a substitution can reach the ASCII expectation but NOT the
      // fullwidth input beside it, so half the pair moved and the test asserted
      // that the folder turns one address into a different one. Measured inside
      // an exported tree, 2026-08-14. The subject here is fullwidth folding, not
      // any particular network, so the vector is now an address no redaction has
      // a reason to touch.
      expect(
        normalizeFullwidthAscii('１９２。１６８。１。７８：４１８７９'),
        '192.168.1.78:41879',
      );
    });

    test('fullwidth colon and dot (U+FF0E/U+FF1A) also fold', () {
      expect(normalizeFullwidthAscii('１０．０．０．１：８０'), '10.0.0.1:80');
    });

    test('a 4-digit fullwidth code folds to ASCII digits', () {
      expect(normalizeFullwidthAscii('９４６２'), '9462');
    });

    test('ideographic space folds to ASCII space; plain ASCII is untouched', () {
      expect(normalizeFullwidthAscii('a　b'), 'a b');
      expect(normalizeFullwidthAscii('100.64.7.78:41879'), '100.64.7.78:41879');
    });

    test('non-ASCII text outside the fullwidth block passes through unchanged', () {
      expect(normalizeFullwidthAscii('电脑'), '电脑');
    });

    test('length is preserved (1:1 map — caret offsets stay valid)', () {
      const String src = '１７２。７７';
      expect(normalizeFullwidthAscii(src).length, src.length);
    });
  });

  group('FullwidthAsciiInputFormatter', () {
    const FullwidthAsciiInputFormatter fmt = FullwidthAsciiInputFormatter();

    TextEditingValue v(String t) =>
        TextEditingValue(text: t, selection: TextSelection.collapsed(offset: t.length));

    test('live edit rewrites fullwidth to halfwidth', () {
      final TextEditingValue out = fmt.formatEditUpdate(v(''), v('１７２。７７'));
      expect(out.text, '172.77');
    });

    test('an already-ASCII edit is returned unchanged (identity fast-path)', () {
      final TextEditingValue nv = v('172.77');
      final TextEditingValue out = fmt.formatEditUpdate(v('172.7'), nv);
      expect(out.text, '172.77');
      expect(identical(out, nv), isTrue);
    });
  });
}
