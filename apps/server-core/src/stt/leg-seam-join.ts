// SPEC-REF:
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md NR-244 (layer 1, SEAM-1)
//   docs/archive/strategy/2026-08-08-030-unified-plan-and-ledger.md card RT-2 (silence >= 3 s hangs up,
//     voice redials — the rule that makes a pause a leg seam; NOT changed here)
//
// card SEAM-1 — HOW TWO LEGS' TEXT IS JOINED WHERE ONE LEG ENDED AND THE NEXT BEGAN.
//
// A leg is one vendor connection. Soniox's tokens carry their own leading space INSIDE a connection
// ("We| sho|uld| dep|lo|y"), so concatenation is right there; the FIRST token of a new connection has
// none ("And", "To", "Anthropic"). And the end-of-stream finalize of the leg that was hung up closes
// its text with "." or "—". So a plain `bank + text` printed, measured through a local relay
// (EVAL-2, midpause4, 6/6 English items, polish off):
//   "Kubernetes.And pointed", "users.To 12,000", "the—Anthropic", "should—Uh,".
//
// THE RULE, by the two characters that meet (review of 2026-10-13 narrowed the first version):
//   · either side already whitespace, or either side empty ⇒ plain concatenation (nothing to fix);
//   · a spaceless script on either side (Han, kana, Thai, Lao, Khmer, Myanmar, CJK punctuation and
//     full-width forms), also when it sits just before the left side's trailing marks ("你好——") ⇒
//     plain concatenation, byte-identical to the join before this card. Nothing is dropped there:
//     "——" and "……" are real CJK punctuation. That is also what one uninterrupted Soniox leg does at
//     a Han|Latin boundary often enough to be the safe answer: Latin→Han 0 of 43 spaced, Han→Latin
//     21 of 50 (EVAL-1 `base-stt-hints.jsonl`, the 50 zh/mixed items), and `final-text-normalizer.ts`
//     `compactWhitespace` neither inserts nor removes a space there. Hangul is NOT spaceless;
//   · a trailing em dash U+2014 — and ONLY that mark, the one measured — before a letter or digit is
//     dropped: it is the forced finalize's "cut mid-phrase" mark and the speaker went on with the
//     phrase ("the—Anthropic", "should—Uh,"). It is KEPT after a digit ("5—10" is a range). Case is
//     no signal — Soniox capitalizes the first token of every connection — so a real interruption
//     ("I was going to—" / "Anyway") also loses its dash: stated, not hidden. ASCII "-", "–", "…"
//     and "..." are never dropped: they carry content ("is -5", "COVID-19", "--verbose");
//   · the left ends with a hyphen, an en/em dash that was kept, or an opening bracket, or the right
//     opens with closing punctuation, or "<digit>." meets a digit ("3." + "14") ⇒ nothing;
//   · otherwise (two spaced-script characters touching, e.g. "Kubernetes." + "And") ⇒ one space.
//     A "." / "!" / "?" is KEPT (a 3 s pause is often a real sentence end).

/** Scripts written without spaces between words, plus CJK punctuation (U+3000–303F) and
 *  half/full-width forms (U+FF00–FFEF, which holds "，" "！" "？" "："). */
const SPACELESS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}　-〿＀-￯]/u;
/** The one mark a forced finalize was measured to leave at a cut mid-phrase. */
const EM_DASH = '—';
/** Marks stripped only to find the character in front of them (the CJK test). */
const TRAILING_MARKS = /[—–\-….]+$/u;
const STARTS_WORD = /^[\p{L}\p{N}]/u;
const NO_SPACE_BEFORE = /^[.,!?;:%)\]}…]/u;
const NO_SPACE_AFTER = /[([{\-–—]$/u;
const DIGIT = /\p{N}/u;

function lastChar(s: string): string { const cs = Array.from(s); return cs[cs.length - 1] ?? ''; }
function firstChar(s: string): string { return Array.from(s)[0] ?? ''; }

/** card SEAM-1 — join the text banked from earlier legs ([left]) with the first text of a new leg
 *  ([right]). Only for a LEG SEAM: inside one leg the engine's own spacing is already right. */
export function joinAtLegSeam(left: string, right: string): string {
  if (left === '') return right;
  if (right === '') return left;
  if (/\s$/u.test(left) || /^\s/u.test(right)) return left + right;
  const b = firstChar(right);
  if (SPACELESS.test(b) || SPACELESS.test(lastChar(left)) || SPACELESS.test(lastChar(left.replace(TRAILING_MARKS, '')))) return left + right;
  let l = left;
  if (l.endsWith(EM_DASH) && STARTS_WORD.test(right) && !DIGIT.test(lastChar(l.slice(0, -1)))) {
    l = l.slice(0, -1);
    if (l === '' || /\s$/u.test(l)) return l + right;
  }
  const a = lastChar(l);
  if (NO_SPACE_BEFORE.test(right) || NO_SPACE_AFTER.test(a)) return l + right;
  if (a === '.' && DIGIT.test(lastChar(l.slice(0, -1))) && DIGIT.test(b)) return l + right;
  return `${l} ${right}`;
}
