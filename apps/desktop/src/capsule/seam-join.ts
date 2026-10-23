// The PC capsule copy of the row-seam rule: the text between two rows of one press
// read as one passage. Book 08 §3 correction (2026-10-14, POL-3 review): the REFERENCE
// is what the PC types, apps/desktop/src-tauri/src/inject/delivery_spacing.rs
// `should_append_delivery_space`; this is its char-class core plus two
// display-only rules. Four copies must agree — the Rust reference, the phone
// (apps/mobile/lib/src/stt/segment_buffer.dart `SegmentBuffer.joinerBetween`), the
// relay (apps/server-core/src/engine/stt-seam-join.ts, the same code) and this
// one — and all four suites read verify/fixtures/seam-join-cases.json.
//
// What is NOT taken from the Rust function: its "no space at INJECT_TEXT_MAX_CHARS"
// guard, which is about one injected payload's length, not about display.
// The two range tables below were generated from that file's
// `is_no_space_script` / `is_unspaced_script_or_cjk_form` (same order); edit
// them only together with it.

const NO_SPACE_SCRIPT: readonly (readonly [number, number])[] = [
  [0x2E80, 0x2FDF], [0x3005, 0x3005], [0x3007, 0x3007], [0x3021, 0x3029], [0x3038, 0x303B],
  [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xF900, 0xFAFF], [0x20000, 0x323AF], [0x3040, 0x309F],
  [0x1B001, 0x1B11F], [0x30A0, 0x30FF], [0x31F0, 0x31FF], [0xFF66, 0xFF9F], [0x1B000, 0x1B000],
  [0x1B120, 0x1B16F], [0x3100, 0x312F], [0x31A0, 0x31BF], [0xA000, 0xA4CF], [0x17000, 0x18AFF],
  [0x18D00, 0x18D8F], [0xE00, 0xE7F], [0xE80, 0xEFF], [0x1780, 0x17FF], [0x19E0, 0x19FF],
  [0x1000, 0x109F], [0xA9E0, 0xA9FF], [0xAA60, 0xAA7F],
];

const UNSPACED_SCRIPT_OR_CJK_FORM: readonly (readonly [number, number])[] = [
  [0xE00, 0xEFF], [0xF00, 0xFFF], [0x1000, 0x109F], [0x1780, 0x17FF], [0x1950, 0x19FF],
  [0x1A20, 0x1AAF], [0x2E80, 0x2EFF], [0x2F00, 0x2FDF], [0x3000, 0x30FF], [0x31C0, 0x31FF],
  [0x32D0, 0x3357], [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xA9E0, 0xA9FF], [0xAA60, 0xAA7F],
  [0xAA80, 0xAADF], [0xF900, 0xFAFF], [0xFE10, 0xFE1F], [0xFE30, 0xFE4F], [0xFE50, 0xFE6F],
  [0xFF01, 0xFF9F], [0xFFE0, 0xFFEE], [0x116D0, 0x116E3], [0x16FE2, 0x16FE3], [0x16FF0, 0x16FF6],
  [0x1AFF0, 0x1AFFF], [0x1B000, 0x1B16F], [0x1E6C0, 0x1E6FF], [0x1F200, 0x1F200],
  [0x20000, 0x2A6DF], [0x2A700, 0x2B81D], [0x2B820, 0x2CEAD], [0x2CEB0, 0x2EBE0],
  [0x2EBF0, 0x2EE5D], [0x2F800, 0x2FA1D], [0x30000, 0x3134A], [0x31350, 0x33479],
];

const LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u;
const WHITE_SPACE = /^\p{White_Space}$/u;

function inRanges(cp: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const [a, b] of ranges) if (cp >= a && cp <= b) return true;
  return false;
}

/** The code point ending at UTF-16 offset `end` and where it starts. */
function codePointBefore(s: string, end: number): [number, number] {
  const lo = s.charCodeAt(end - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && end >= 2) {
    const hi = s.charCodeAt(end - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return [((hi - 0xd800) << 10) + (lo - 0xdc00) + 0x10000, end - 2];
  }
  return [lo, end - 1];
}

/** The reference's answer for `left`: would the PC type a space after it? The
 *  last letter or number (Unicode L or N; punctuation, symbols, combining marks
 *  and joiners are skipped) picks the script; with none, the last character
 *  falls back to the CJK-form table; trailing whitespace never takes one. */
export function seamTakesSpace(left: string): boolean {
  if (left.length === 0) return false;
  const [last] = codePointBefore(left, left.length);
  if (WHITE_SPACE.test(String.fromCodePoint(last))) return false;
  for (let end = left.length; end > 0;) {
    const [cp, start] = codePointBefore(left, end);
    if (LETTER_OR_NUMBER.test(String.fromCodePoint(cp))) return !inRanges(cp, NO_SPACE_SCRIPT);
    end = start;
  }
  return !inRanges(last, UNSPACED_SCRIPT_OR_CJK_FORM);
}

/** The display joiner: [[seamTakesSpace]] plus two display-only rules — a newline
 *  after 。！？ (the live view breaks the line there) and no second space before a
 *  row that already starts with whitespace. */
export function joinerBetween(left: string, right: string): string {
  if (left.length === 0 || right.length === 0) return '';
  const [last] = codePointBefore(left, left.length);
  if (last === 0x3002 || last === 0xff01 || last === 0xff1f) return '\n';
  if (WHITE_SPACE.test(String.fromCodePoint(right.codePointAt(0)!))) return '';
  return seamTakesSpace(left) ? ' ' : '';
}
