// SPEC-REF:
//   docs/strategy/R4-PRIVATE-TASK-CARDS.md WP-R4-2 ⑥ (real-device IME finding:
//     Chinese IMEs rewrite '.'/':'/digits to fullwidth '。'/'：'/'１'… so the raw
//     endpoint/code value fails to parse; normalize fullwidth ASCII U+FF01-FF5E →
//     U+0021-007E and ideographic '。' → '.')
//
// Input hardening for the pairing fields. A Chinese IME silently substitutes
// fullwidth punctuation/digits that look identical but are different codepoints,
// so `172。77：41879` never parsed. [normalizeFullwidthAscii] maps every
// fullwidth ASCII variant back to its halfwidth form (a 1:1 BMP codepoint map,
// so text length + caret offsets are preserved), and the [TextInputFormatter]
// applies it live as the user types.

import 'package:flutter/services.dart';

/// Fold fullwidth ASCII (U+FF01-FF5E, e.g. '．'/'：'/'１') to halfwidth
/// (U+0021-007E) and the ideographic full stop '。' (U+3002) + ideographic space
/// (U+3000) to their ASCII equivalents. Every other rune passes through. The map
/// is 1:1 over the BMP, so the returned string has the same UTF-16 length.
String normalizeFullwidthAscii(String input) {
  if (input.isEmpty) return input;
  final StringBuffer out = StringBuffer();
  for (final int rune in input.runes) {
    if (rune >= 0xFF01 && rune <= 0xFF5E) {
      out.writeCharCode(rune - 0xFEE0); // FF01→0021 … FF5E→007E
    } else if (rune == 0x3002) {
      out.write('.'); // 。 ideographic full stop
    } else if (rune == 0x3000) {
      out.write(' '); // ideographic space
    } else {
      out.writeCharCode(rune);
    }
  }
  return out.toString();
}

/// Live formatter: rewrites fullwidth ASCII to halfwidth on every edit so the
/// controller value is always parseable. Length is preserved by
/// [normalizeFullwidthAscii], so the incoming selection stays valid.
class FullwidthAsciiInputFormatter extends TextInputFormatter {
  const FullwidthAsciiInputFormatter();

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final String normalized = normalizeFullwidthAscii(newValue.text);
    if (normalized == newValue.text) return newValue;
    return TextEditingValue(
      text: normalized,
      selection: newValue.selection,
      composing: TextRange.empty,
    );
  }
}
