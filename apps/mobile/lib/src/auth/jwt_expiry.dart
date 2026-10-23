// SPEC-REF:
//   docs/rebuild/18-CONNECTION-STATES-THREE-ENDS.md §2.6 (card E-M, P-1 ③:
//     the launch check of the stored account credential)
//   docs/strategy/2026-10-10-login-renewal-design.md §3 card E-M
//   apps/server-core/src/auth/jwt.ts (claims {sub, plan, iat, exp}; iat/exp
//     are SECONDS since the epoch)
//   apps/desktop/src-tauri/src/socket/channel.rs `CLOCK_SKEW_SECS` (the same
//     300 s tolerance on the desktop's launch check)
//
// Reads ONE claim, `exp`, out of the stored account JWT. The phone has no
// secret and verifies nothing: this is a local clock reading, not an
// authentication decision. The relay stays the judge of every credential it
// is shown; this only stops the phone from presenting itself as signed in on a
// credential that has already run out.

import 'dart:convert';

/// The tolerance before a lapsed `exp` counts as expired here. The same number
/// as the desktop's `CLOCK_SKEW_SECS` so the two ends call the same credential
/// dead at the same moment. Cost, stated on purpose: a phone clock more than
/// this far FAST, on a credential close to its end, signs out once early.
const int kStoredCredentialSkewSecs = 300;

/// The credential's `exp` in seconds since the epoch, or null when it cannot be
/// read (not a three-part token, not base64url JSON, no integer `exp`). Null
/// means 「cannot tell」 — never 「expired」.
int? jwtExpSeconds(String jwt) {
  final List<String> parts = jwt.split('.');
  if (parts.length != 3) return null;
  try {
    final String seg = parts[1];
    final String padded = seg.padRight(seg.length + (4 - seg.length % 4) % 4, '=');
    final Object? claims = jsonDecode(utf8.decode(base64Url.decode(padded)));
    final Object? exp = claims is Map ? claims['exp'] : null;
    return exp is int ? exp : (exp is double && exp.isFinite ? exp.floor() : null);
  } on Object {
    return null;
  }
}

/// True only when [jwt] carries a readable `exp` that is more than
/// [kStoredCredentialSkewSecs] in the past at [now].
bool storedCredentialExpired(String jwt, DateTime now) {
  final int? exp = jwtExpSeconds(jwt);
  if (exp == null) return false;
  final int nowSec = now.millisecondsSinceEpoch ~/ 1000;
  return nowSec > exp + kStoredCredentialSkewSecs;
}
