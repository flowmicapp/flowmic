// SPEC-REF:
//   owner 2026-08-27 UAT ②:「手机上看不到自己用哪个账号登录的」— on a narrow
//     phone NO screen answered 「which account am I signed in with」, because the
//     one place that showed it (the 轻记录 / cloud card row) gave the address a
//     `Flexible` slot that collapses to nothing once the two links beside it take
//     the width.
//   owner, same day, generalising it:「所有显示账号的地方都要用星号遮盖」— EVERY
//     render site on the phone shows the masked form; no full address is painted
//     anywhere on this client.
//   owner, final adjustment (this is the rule below):「首三位 + 末一位，中间固定
//     星号」— three characters in front and one at the back, so two of the user's
//     own addresses can still be told apart at a glance.
//
// The ONE function that turns a signed-in account into something a phone may
// paint. Pure, synchronous, no imports: the whole point is that every render
// site calls it and none of them gets its own opinion.
//
// 🔴 THIS RULE CHOSE DISTINGUISHABILITY OVER SECRECY, ON PURPOSE.
// An earlier cut of this card showed one character (`b***@gmail.com`). It is
// more private and it fails the question the card exists to answer: a user with
// `bill@gmail.com` and `billing@gmail.com` reads the same line for both, so the
// screen still does not tell them which account they are signed in with. Three
// in front and one at the back is what makes those two lines different. Stated
// here because the tempting "improvement" is to hide more, and hiding more
// walks straight back into the defect.
//
// 🔴 WHY A FIXED-WIDTH `***` AND NOT ONE STAR PER HIDDEN CHARACTER.
// A mask that grows with the address leaks the address's LENGTH, and length is
// what makes a short account guessable from over a shoulder (`bit***a@…` vs
// `bit**********a@…`). Three stars, always. That also bounds the rendered width,
// which is what lets this line fit at 360dp without an ellipsis — the defect it
// was written for was an identity that could not fit on the screen at all.
//
// 🔴 THE DOMAIN IS SHOWN IN FULL, DELIBERATELY.
// The question is 「which of my accounts is this」, and for a person with a work
// address and a personal one the domain IS the answer. Hiding it would produce a
// line that is private and useless.
//
// 🔴🔴 THE TWO CALLS THAT MUST NEVER BE MASKED, NAMED HERE SO A LATER SWEEP
// DOES NOT 「FINISH THE JOB」 AND DESTROY DATA.
// `main.dart:469` and `main.dart:503` pass `_login.email` as `accountKey` into
// the blind-store key provisioner and cloud sync. That is not a render site —
// it is KDF INPUT. Masking it would derive a different key, and every record
// already sealed under the real address would stop opening. A grep for
// 「places that read the account email」 hits all of them the same way, which is
// exactly why the two that must not move are written down here rather than left
// to be recognised. The rule is 「every place that PAINTS it」, not 「every place
// that reads it」.
//
// ⚠️ WHAT THIS IS NOT. It is not anonymisation and must never be cited as such:
// anyone who already knows the address can confirm it from the mask, and with
// four characters plus a domain on screen it is not even close. It defends
// against a shoulder, a screenshot and a screen share — the three ways this
// string actually leaves the phone.

/// The hidden middle. Fixed width by rule (see the header); a caller that wants
/// a different one is a caller that wants a different rule.
const String _kMaskBody = '***';

/// The shortest local part that still gets the 「first three + last one」 face.
///
/// Five, and the number is the boundary rather than a preference: at four the
/// two rules would show `abc***d` for `abcd` — every character of the address,
/// with decoration. Below the boundary the mask degrades to one character, which
/// is the only honest thing left to show.
const int _kMinLocalForTail = 5;

/// `bitbalabala@gmail.com` → `bit***a@gmail.com`.
///
/// The rule, stated so a test can be written from this paragraph alone:
///   1. `null`, empty or all-whitespace in ⇒ empty out. There is no account, and
///      inventing `***@***` would paint an identity that does not exist.
///   2. The address splits at its LAST `@` — `a@b@example.com` is a local part
///      containing an `@`, and splitting at the first one would show more of it
///      than the rule allows.
///   3. A local part of [_kMinLocalForTail] characters or more keeps its FIRST
///      THREE and its LAST ONE, with [_kMaskBody] between them.
///   4. A shorter local part keeps its FIRST CHARACTER only, then [_kMaskBody].
///      `a@x.io` → `a***@x.io`: the mask cannot hide a character that is the
///      whole answer to 「which account」, and `***@x.io` would hide nothing an
///      observer could not already infer.
///   5. The domain, `@` included, is copied through verbatim.
///   6. A string with no `@` at all is treated as a bare local part
///      (`someone` → `som***e`). It is not a valid address, but it IS what the
///      server sent us, and rendering it verbatim would be the one case where
///      the mask silently stops masking.
///
/// ⚠️ Characters are counted as CODE POINTS, so an astral-plane letter is never
/// cut in half into a lone surrogate (which renders as `�`). A combining mark
/// counts as its own character — measured cost of not taking a grapheme
/// dependency for this, and harmless: the result is a slightly shorter or
/// longer visible half, never a broken glyph.
String maskAccountEmail(String? raw) {
  final String value = (raw ?? '').trim();
  if (value.isEmpty) return '';
  final int at = value.lastIndexOf('@');
  final String local = at < 0 ? value : value.substring(0, at);
  final String domain = at < 0 ? '' : value.substring(at);
  final List<int> cp = local.runes.toList();
  if (cp.length >= _kMinLocalForTail) {
    final String head = String.fromCharCodes(cp.take(3));
    final String tail = String.fromCharCode(cp.last);
    return '$head$_kMaskBody$tail$domain';
  }
  final String head = cp.isEmpty ? '' : String.fromCharCode(cp.first);
  return '$head$_kMaskBody$domain';
}
