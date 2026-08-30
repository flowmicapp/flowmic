// SPEC-REF:
//   apps/server-core/src/auth/middleware.ts (the two refusal families this file
//     tells apart — read them, they are twelve lines apart and answer different
//     questions)
//   docs/decisions/2026-08-27 §R1 (the account JWT's TTL is 100 years)
//   apps/mobile/lib/src/session/connections_controller.dart (`enterCloud`, the
//     admission this predicate authorises a second run of)
//
// ── 🔴 THE DEFECT THIS EXISTS FOR (owner, 2026-08-30) ───────────────────────
//
// Tapping the light-record (轻记录) row in the connections list answered
// 「电脑上已取消这台手机的配对，请重新配对连接」("the PC has cancelled this
// phone's pairing — pair again to connect"). owner: 「这个卡片点击只可能有登录
// 失效的问题，不存在有配对的问题」("tapping this card can only ever have a
// login problem; there is no pairing involved at all") — and that is exactly
// right. A cloud instance has no PC, no pairing code and no 「撤销配对」 button
// anywhere in the product. The sentence named an act nobody could have
// performed, and pointed at a screen (re-pair) that cannot fix it.
//
// HOW IT GOT THERE, in one line: a cloud instance is remembered as an ordinary
// `MobileSession` row (`channel == 'saas'`), so tapping it walks
// `connectTo → resumePairing → handshakeRefusal`, and that funnel's copy table
// is `AppStrings.pairError`, whose `AUTH_TOKEN_INVALID` arm is about a PC.
// One code, two questions — this repo's headline shape, arriving through a
// shared funnel rather than a shared variable.
//
// ── 🔴 AND THE REFUSAL IS NOT ABOUT THE LOGIN EITHER ────────────────────────
//
// The second half of owner's report is 「按前面已做完的功能，这个登录是永久的，
// 不应该失效」("per what was already built, this login is permanent and should
// not expire"). That is also right, and the server's own middleware proves the
// refusal was never about the account:
//
//   · a JWT that is expired or unreadable NEVER refuses the connection
//     (`resolveHandshakeJwt`: 「NEVER rejects the connection … leaves the socket
//     unauthenticated and an identity-required op fails loud later」). The JWT's
//     TTL is 100 years anyway (owner 2026-08-27 §R1);
//   · a connection-level `AUTH_TOKEN_INVALID` comes from the OTHER branch —
//     `lookup.findMobileByToken(rawToken)` found no row. That is the DEVICE
//     credential minted by `mobile:pair`, and it can genuinely go missing (the
//     row was cleaned, the relay was rebuilt, the device re-registered
//     elsewhere).
//
// ⇒ On a saas row, a refused HANDSHAKE means 「this device's cloud registration
// is gone」 and says NOTHING about the account. The login really is intact, and
// the user signing out and back in — which is what they had to do — worked only
// because signing back in runs `enterCloud()`, which mints a new registration.
//
// ⇒ So do that, instead of asking them to. That is the whole fix: not a better
// sentence for a dead end, but removing the dead end.
//
// ── WHY THIS IS A FILE AND NOT AN `if` ──────────────────────────────────────
//
// Because it is a decision with four conditions, three of which are about
// somebody else's code, and because it authorises a RETRY — the one shape that
// turns a wrong predicate into a loop. It is pure, so its whole behaviour is
// reachable from a test rather than from a phone with a broken registration.

/// 🔴 The device-credential refusal, as the socket handshake reports it.
///
/// Matched as a literal, and deliberately not imported from anywhere: the
/// string is minted by `middleware.ts` (`next(new Error('AUTH_TOKEN_INVALID'))`)
/// and read back off `SocketTransport.lastConnectError` by `handshakeRefusal`.
/// Neither end has a shared constant to reach for; inventing one here would
/// create a spelling this repo has to keep in step with a Node file by hand.
const String kHandshakeTokenInvalid = 'AUTH_TOKEN_INVALID';

/// The saas channel marker. Same value `ConnectionsController` keys every other
/// cloud-instance branch on (`activePairingIsCloudInstance`), spelled once here
/// so this predicate cannot drift away from those.
const String kCloudChannel = 'saas';

/// May this refusal be healed by silently re-admitting the cloud instance?
///
/// Every conjunct pays for a clause of 「the account is fine and we can fix this
/// without the user」, and none of them is decoration:
///
///   · [channel] is `saas` — a LAN or relay-paired PC row has a real pairing
///     that a real person really can revoke, and re-admitting one would mean
///     re-pairing a PC behind the user's back. The cloud instance is the only
///     row in this product created with no user input at all (`enterCloud`
///     needs a JWT and nothing else), which is exactly what makes re-creating
///     it silently honest rather than presumptuous;
///   · [refusalCode] is [kHandshakeTokenInvalid] — see the header: at the
///     CONNECTION level this can only be the device credential. `PAIR_RELEASED`
///     / `PC_BUSY` / a timeout / a pin mismatch must all fall through, and the
///     first two cannot even occur on a row with no PC;
///   · [loggedIn] — with no account there is nothing to re-admit WITH, and the
///     honest answer is the sign-in sentence `cloudError` already has.
///
/// 🔴 [alreadyTried] IS THE TERMINATION ARGUMENT AND IT IS LOAD-BEARING. The
/// re-admission dials the same relay and can be refused by the same middleware
/// for the same reason (a registration that will not stick, a relay refusing
/// this device). Without this the retry is a loop with a network call in it,
/// and the failure mode is a phone that dials forever behind a spinner. ONE
/// attempt, then the user is told — the same posture `pairError`'s default arm
/// takes: say the honest thing rather than keep trying quietly.
bool shouldReadmitCloudRow({
  required String? channel,
  required String? refusalCode,
  required bool loggedIn,
  required bool alreadyTried,
}) {
  if (alreadyTried) return false;
  if (channel != kCloudChannel) return false;
  if (!loggedIn) return false;
  return refusalCode == kHandshakeTokenInvalid;
}
