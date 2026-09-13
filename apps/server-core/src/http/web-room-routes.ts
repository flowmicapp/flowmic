// SPEC-REF:
//   docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §2.1
//     (`POST /api/web/rooms`: request, response, error codes, rate limits, and
//     the 09-07 ordering note — branch on identity FIRST, no shared IP gate)
//   docs/strategy/2026-09-08-web-client-target-and-self-pairing-state-machine.md
//     §4.2 / §5.1 (what the page does with each status) / §5.3 (the code's two
//     clocks) / §13 Q-3 (the cascade question this card answers)
//   docs/strategy/2026-09-05-web-client-subproject-design.md §3 / §5 item 2
//   ../room/web-room.ts (everything about the row itself)
//   ../http/account-auth.ts (WHO the caller is — one definition for this surface)
//   *** HUMAN-AUDIT SENSITIVE (auth + row minting + a paid dimension) —
//       reviewable in isolation ***
//
// `POST /api/web/rooms` — a signed-in account asks for its browser target room.
//
// ── THE CASCADE ANSWER, STATED WHERE A READER LANDS FIRST ──────────────────
// The addendum left「does releasing a web room take its pairings with it」open
// and the state machine register hands the ruling to this card. IT DOES: a
// released web room takes its own `mobile_pairings` rows and NOTHING ELSE —
// the same `ON DELETE CASCADE` path the console's remove-pc route already uses
// for a computer. It never touches another room, another account, or a
// transcript (the relay stores none at all: owner ruling
// 2026-07-31-no-cloud-sync-for-phone-pc.md). The one place that release happens
// is a repeat build call finding an EXPIRED room; room/web-room.ts holds the
// argument and what it deliberately does NOT do (evict a live socket).
//
// ── WHAT THIS ROUTE IS NOT ─────────────────────────────────────────────────
// ⚠️ 2026-09-09, card M4-01 — this paragraph used to say the anonymous arm was
// stage three and its two error codes were unregistered. ⚠️ AND 「The
// publishable-key arm is still a refusal that names the door」 stood here until
// card MP-1 (2026-09-11) served it. ALL THREE ARMS ARE NOW SERVED:
// `account_jwt`, `anon_token` (the site demo) and `publishable_key` (a
// third-party host page, billed to the key's owner — owner ruling §9-1).
//
// 🔴 THE TWO ARMS DO NOT SHARE A GATE, AND THAT IS THE 09-07 NOTE'S WHOLE
// POINT. The account arm has no Origin check (a desktop console is not a page,
// and requiring one would refuse it), and the anonymous arm has no account
// lookup (there is no account). Each gate sits INSIDE the arm it belongs to, so
// no future edit can move one to the entrance and charge the other identity for
// it. The Origin predicate itself is imported from web-anon-routes.ts rather
// than re-typed, because 「which pages may run a demo」 must have one answer
// across both demo endpoints.
//
// 🔴 THE SHAPE OF THE IDENTITY SWITCH IS THE DELIVERABLE, not just the account
// arm. The addendum's 09-07 note (learned from `79ef64d0`) is explicit: branch
// on `auth.kind` FIRST, and never put one gate at the entrance that charges all
// three identities. So the switch below is written with all three arms visible
// and two of them refusing out loud, rather than as an `if (jwt)` that a later
// card would have to unpick. An unknown kind gets a refusal that says the kind
// is not served here — NOT a 401, which would tell a caller holding a perfectly
// good anonymous token that their credential is bad.
//
// ── THE CREDENTIAL COMES FROM THE HEADER, AND ONLY FROM THERE ──────────────
// The addendum sketches `{auth:{kind}, auth_value}` in the body. `auth_value` is
// NOT read here, and the deviation is written back into the addendum in the same
// round (its own rule: change the contract document first). Reason:
// `account-auth.ts` is 「WHO IS THE HTTP CALLER? — one definition, for the whole
// http surface」, and it reads `Authorization`. A second intake would make this
// the one route on the server where identity can arrive somewhere else, i.e. a
// second author for the answer this repo has already paid to have exactly one of.
// `auth.kind` is still read from the body: that says WHICH DOOR, not who.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_SAAS_ENDPOINT, DEMO_PAIR_HTTPS_PATH, PAIR_HTTPS_HOST, PAIR_HTTPS_PATH } from '@flowmic/protocol';
import type { AuthService } from '../auth/auth-service';
import type { RegisterRateLimiter } from '../auth/register-rate-limit';
import type { BudgetPusher } from '../billing/budget-push';
import type { WebRoomOutcome } from '../room/web-room';
import { restrictionRefusalBody, restrictionVerdict } from '../auth/account-restriction';
import { accountFromBearer } from './account-auth';
import { readJsonBody, sendJson, str } from './console-http';
import { ServerError } from '../errors';
import { isTrustedProxy, trustedProxiesFromEnv } from './trusted-proxy';
import { demoOriginOf } from './web-anon-routes';
import { applyReflectedOrigin, handleReflectedOriginPreflight } from './web-cors';
import type { TrialLedger } from '../billing/trial-ledger';
import type { IntegratorKeyGuard } from '../billing/integrator-quota';
import { integratorRoomName, type IntegratorRoomOutcome } from '../room/integrator-room';
import { log } from '../log';

/** The identity kinds the addendum defines for this endpoint. All three are
 *  served since card MP-1; the list survives because an UNKNOWN kind still has
 *  to be told apart from a known one in the refusal below. */
const KNOWN_AUTH_KINDS = ['account_jwt', 'anon_token', 'publishable_key'] as const;
type AuthKind = (typeof KNOWN_AUTH_KINDS)[number];

/** Defaulted rather than required: the state machine's own sequence diagram
 *  writes `POST /api/web/rooms {auth:account_jwt, mode}`, and a page that omits
 *  the envelope is asking for the only door that is open. */
const DEFAULT_AUTH_KIND: AuthKind = 'account_jwt';

export interface WebRoomRoutesDeps {
  auth: AuthService;
  /**
   * The room minter. Typed as the one method rather than as `Registry` so this
   * file cannot reach pairing, the device ceilings or the cross-account reaper —
   * the same narrowing `console-device-routes.ts` applies to the room store.
   *
   * ASYNC (card S2-04b): `Registry.ensureWebRoom` chains through a per-account
   * lock so two repeat calls for the SAME account can never both observe「no
   * room yet」and each insert one — see that method's own header for why the
   * lock is in-process and per-account rather than global or cross-node.
   */
  rooms: { ensureWebRoom(user_id: string, opts?: { ttlMs?: number }): Promise<WebRoomOutcome> };
  /**
   * The account's remaining transcription budget, from the ONE module that
   * produces `billing:budget` (billing/budget-push.ts).
   *
   * REQUIRED, no `?` and no local fallback (book 13 §7 F1 ②). A default here
   * would be a number about somebody's money computed by a route — and the
   * addendum puts this field in the response precisely so the page's meter and
   * the relay's meter are one fact.
   */
  budget: BudgetPusher;
  limiter: RegisterRateLimiter;
  /**
   * Card M4-01 — the site-demo arm's wiring, or absent on a deployment that does
   * not serve demos.
   *
   * ABSENT IS A REFUSAL, NOT A FALLBACK: `handleAnonymous` answers 503
   * WEB_DEMO_UNAVAILABLE when this is missing, exactly as it does when the
   * master switch is off, rather than dropping through to the account arm.
   */
  anon?: {
    /** The master switch, resolved once at the wiring root
     *  (`web-anon-routes.ts` `anonDialsFromEnv`) so both demo endpoints read one
     *  value rather than each parsing the env. */
    enabled: boolean;
    trials: TrialLedger;
    allowLocalhost?: boolean;
    /** Design §2.3: TEN minutes, not the 30 an account room gets. A demo room is
     *  「we are holding a room for a visitor who just asked for one」, and a
     *  visitor who has closed the tab should not keep it. */
    ttlMs: number;
    now?: () => number;
  };
  /**
   * Card MP-1 — the third-party host arm's wiring, or absent on a deployment
   * that serves no integrations.
   *
   * ABSENT IS A REFUSAL, NOT A FALLBACK, exactly as `anon` above is: a key this
   * process cannot check must not fall through to another arm, because every
   * other arm bills somebody else.
   */
  integrator?: {
    keys: IntegratorKeyGuard;
    /** `Registry.mintIntegratorRoom`. Typed as the one method for the reason
     *  `rooms` above is: this file cannot reach pairing or the ceilings. */
    mint(user_id: string, key_id: string, opts?: { ttlMs?: number; deviceName?: string }): IntegratorRoomOutcome;
    /** Overridable so a test does not have to wait ten minutes to see a TTL. */
    ttlMs?: number;
  };
  /** Overridable so a test does not have to wait 30 minutes to see a TTL. */
  ttlMs?: number;
  /** Trusted reverse proxies, for reading `x-forwarded-proto`. Defaults to the
   *  same env list `clientIpFrom` uses — one declaration, two readers. */
  trustedProxies?: readonly string[];
}

/**
 * Where the browser should dial this relay, as a `ws(s)://` origin.
 *
 * 🔴 IT IS THE HOST THE CALLER ALREADY REACHED, not a configured constant, and
 * that is the same rule `home_node = NULL` states elsewhere in this server:
 * 「dial the host you already have」. A hard-coded canonical host would be wrong
 * on every internal preview and on every test fixture, which is where this
 * endpoint gets exercised before it is ever exercised in production.
 *
 * ⚠️ THE SCHEME CANNOT COME FROM THE SOCKET. Behind nginx the socket is
 * plaintext, so `req.socket.encrypted` says http for a request that arrived over
 * https, and a page served over https cannot open a `ws://` — the browser blocks
 * it as mixed content, with no server-side trace. So `x-forwarded-proto` is
 * consulted, and ONLY when the direct peer is a declared trusted proxy: the same
 * condition `clientIpFrom` puts on `x-forwarded-for`, because it is the same
 * question (may this hop tell us about the hop before it).
 *
 * `Host` is caller-controlled, so it is shape-checked and otherwise falls back
 * to the product's canonical endpoint. The blast radius of a forged one is the
 * forger's own response — but it is also copied into `pair_url`, and a QR is a
 * thing a second device scans, so it does not get to be an arbitrary string.
 */
export function relayWsOrigin(req: IncomingMessage, trusted: readonly string[]): string {
  const host = str(req.headers?.host);
  const wellFormed = /^[A-Za-z0-9.\-]+(:\d{1,5})?$/.test(host);
  if (!wellFormed) return DEFAULT_SAAS_ENDPOINT.replace(/^http/, 'ws');
  const peer = req.socket?.remoteAddress ?? '';
  const forwarded = isTrustedProxy(peer, trusted) ? str(req.headers?.['x-forwarded-proto']).split(',')[0] : '';
  const secure = forwarded === 'https' || (forwarded === '' && (req.socket as { encrypted?: boolean })?.encrypted === true);
  return `${secure ? 'wss' : 'ws'}://${host}`;
}

/**
 * The pairing link for this room.
 *
 * The key set and their ORDER are the desktop's (`apps/desktop/src/lib/pairing.ts`
 * `buildHttpsQrPayload`) and the BNF is the addendum's §3; host and path come
 * from the protocol package so this is not a fourth hand-typed copy of them.
 * `alt`/`fp` are absent because they are LAN facts a browser room does not have,
 * and `lang` because this server has no locale for the page.
 *
 * ⚠️ The page RE-COMPUTES this by replacing `code=` when it refreshes its code
 * (state machine §5.3), so the exact spelling here is a contract, not a
 * convenience.
 *
 * `path` — card M4-01b. Defaults to `PAIR_HTTPS_PATH` (the one declared to
 * Android/iOS as an App Link); `handleAnonymous` below is the ONE caller that
 * passes `DEMO_PAIR_HTTPS_PATH` instead, so a phone with FlowMic installed that
 * scans the site's demo QR still opens a browser (owner ruling 6) rather than
 * being pulled into the app. The query keys and their order are unchanged
 * either way — only the path swaps.
 */
export function webRoomPairUrl(wsOrigin: string, code: string, pcid: string | null, path: string = PAIR_HTTPS_PATH): string {
  const pcidPart = pcid === null ? '' : `&pcid=${pcid}`;
  return (
    `https://${PAIR_HTTPS_HOST}${path}?endpoint=${encodeURIComponent(wsOrigin)}` +
    `&code=${code}&channel=saas${pcidPart}&v=1`
  );
}

function readAuthKind(body: Record<string, unknown>): string {
  const envelope = body.auth;
  if (envelope !== null && typeof envelope === 'object' && 'kind' in envelope) {
    return str((envelope as { kind?: unknown }).kind) || DEFAULT_AUTH_KIND;
  }
  return DEFAULT_AUTH_KIND;
}

/** Returns true iff this request belonged to this file. */
export function tryHandleWebRoomRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebRoomRoutesDeps,
): boolean {
  const path = (req.url ?? '/').split('?')[0];
  if (path !== '/api/web/rooms') return false;
  // ── Card MP-11 / gap G-16 — THE PREFLIGHT, ANSWERED BEFORE THE METHOD GATE ──
  //
  // A third-party host page's call to this route is cross-origin by definition
  // and carries `Authorization` + a JSON body, so a browser ALWAYS sends an
  // OPTIONS first and never sends the POST unless that OPTIONS is granted.
  // Until this card, nothing here had heard of OPTIONS: the line above bailed on
  // `method !== 'POST'`, the request fell through to the router's 404, and the
  // publishable-key arm MP-1 built was unreachable from the only kind of page it
  // exists for. MP-2 measured exactly that (web `7d0481d`).
  //
  // 🔴 THE GRANT REFLECTS ANY ORIGIN, AND IT HAS TO — see web-cors.ts's second
  // header for the full argument. The short version: a preflight carries no
  // `Authorization` header, so at this moment there is no key to ask 「is this
  // origin on YOUR allow-list?」. That question is answered by `handleIntegrator`
  // below, out loud, as `WEB_ROOM_ORIGIN_NOT_ALLOWED` — this card does not move
  // it, weaken it, or duplicate it. No credentials are allowed, so the reflected
  // grant confers no ambient authority on anybody.
  //
  // ⚠️ Placed ahead of the method check rather than inside a `switch`, the same
  // shape presence-routes.ts uses, so no later edit to the method gate can
  // re-hide the preflight behind it.
  if (handleReflectedOriginPreflight(req, res)) return true;
  if (req.method !== 'POST') return false;

  void handle(req, res, deps).catch((err: unknown) => {
    // 🔴 A THROW IN HERE WOULD OTHERWISE BE A HANG, NOT AN ERROR. The body of
    // this route is a detached promise (the shape every route family on this
    // surface uses), so nothing above it can catch — and an unanswered request
    // is the silent-failure red line in its worst form: the page's `building`
    // state never resolves and there is no status to render. It CAN throw: the
    // short-code governor refuses when the 4-digit space has no free value, and
    // a database write can fail.
    //
    // The two arms are `makeHttpHandler`'s own (router.ts's catch), spelled the
    // same way on purpose rather than invented here: a `ServerError` is a named
    // domain refusal and travels with its code, anything else is ours and says
    // so without inventing a code for it.
    if (err instanceof ServerError) {
      sendJson(res, 409, { error: err.code, message: err.message });
      return;
    }
    log.error('web room build failed', { error: err instanceof Error ? err.message : String(err) });
    sendJson(res, 500, { error: 'SETTINGS_SYNC_FAIL', message: 'internal error' });
  });
  return true;
}

/**
 * The `anon_token` arm — card M4-01, the site demo.
 *
 * It is the SAME room this file's account arm builds (`room_kind:'web'`, same
 * mint, same response shape); the design register's §2.1 argues at length why a
 * `room_kind:'demo'` would be a lie — the server treats the two identically, and
 * a kind that exists only to look good in a log makes the next reader believe
 * there are rules it cannot find.
 *
 * WHAT MAKES IT A DEMO IS THE ROW THAT OWNS IT: `users.anonymous`, which is what
 * `budget.mode` is derived from (billing/budget-push.ts). Both ends learn they
 * are in a demo from that one field, on frames that already existed.
 */
async function handleAnonymous(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebRoomRoutesDeps,
): Promise<void> {
  const anon = deps.anon;
  // Absent wiring and a switched-off deployment are ONE answer here, for the
  // reason web-anon-routes.ts gives for folding four causes into this code: from
  // the page's side they are the same fact, and the log line is where they part.
  if (!anon || !anon.enabled) {
    log.warn('trial refused', { reason: 'disabled', route: '/api/web/rooms', wired: Boolean(anon) });
    sendJson(res, 503, { error: 'WEB_DEMO_UNAVAILABLE' });
    return;
  }
  // Checked BEFORE the token, and the order is the point: a token stolen from a
  // real visitor must not build a room for a page we do not serve. The predicate
  // is web-anon-routes.ts's, imported rather than re-typed.
  const origin = demoOriginOf(req, anon.allowLocalhost === true);
  if (origin === null) {
    log.warn('trial refused', { reason: 'origin', route: '/api/web/rooms', origin: str(req.headers?.origin) || '(none)' });
    sendJson(res, 403, { error: 'WEB_ROOM_ORIGIN_NOT_ALLOWED' });
    return;
  }
  const now = (anon.now ?? Date.now)();
  // The credential comes from the header and only from there — the same rule the
  // account arm follows two functions down, for the same reason.
  const bearer = str(req.headers?.authorization).replace(/^Bearer\s+/i, '');
  const identity = anon.trials.resolveToken(bearer, now);
  if (identity === null) {
    // 401 and the EXISTING code: this is a credential answer, and an unknown
    // token and an expired one are deliberately indistinguishable on the wire
    // (billing/trial-ledger.ts `resolveToken` states why). No demo code here —
    // the demo is available, this caller's hour is simply up.
    sendJson(res, 401, { error: 'AUTH_TOKEN_INVALID' });
    return;
  }

  const room = await deps.rooms.ensureWebRoom(identity.userId, { ttlMs: anon.ttlMs });
  const wsOrigin = relayWsOrigin(req, deps.trustedProxies ?? trustedProxiesFromEnv());
  if (room.created) {
    // §3.2 line 2 — the SAME line the account arm writes, with one more key.
    // A separate line for demo rooms would mean 「where did these rows come
    // from」 has two places to look, and the answer would be wrong in whichever
    // one the reader picked.
    log.info('web room minted', {
      user_id: identity.userId,
      pc_id: room.pc.id,
      replaced_expired: room.replacedExpired,
      released_pairings: room.releasedPairings.length,
      anonymous: true,
    });
  }
  sendJson(res, 200, {
    room_token: room.token,
    pcid: room.pc.pcid,
    code: room.code,
    // DEMO_PAIR_HTTPS_PATH, not PAIR_HTTPS_PATH — see `webRoomPairUrl`'s doc
    // comment and owner ruling 6: this is the one call site allowed to pass it.
    pair_url: webRoomPairUrl(wsOrigin, room.code, room.pc.pcid, DEMO_PAIR_HTTPS_PATH),
    endpoint: wsOrigin,
    expires_at: room.expiresAtMs,
    // The SAME producer the account arm uses. It answers `mode:'trial'` here
    // because the row it is asked about is anonymous — this route does not pass
    // a mode, and could not: 「what kind of allowance」 has one author.
    budget: deps.budget.view(identity.userId),
  });
}

/**
 * The `publishable_key` arm — card MP-1, a third-party host page.
 *
 * 🔴 THE ROOM IT BUILDS IS `room_kind:'integrator'`, AND THIS IS THE ONE PLACE
 * IN THIS REPO THAT WRITES THAT VALUE. Everything downstream reads it: the payer
 * rule bills the room's owner and never the speaker (`resolvePayer` step 1), the
 * trial minter refuses to hand out a FlowMic grant on it
 * (`auth/web-trial-identity.ts`), and the PC-slot ceiling does not count it
 * (`isBrowserMintedRoom`). None of those three could be right until this
 * existed, which is why all three were written before it and each of them fails
 * toward money.
 *
 * 🔴 A FRESH ROOM EVERY TIME, unlike both arms beside it. An integration serves
 * many visitors at once and each needs their own microphone;
 * `room/integrator-room.ts` carries that argument and the TTL it implies.
 *
 * 🔴 NO TRIAL, NO DEMO, NO FALLBACK. owner §9-1: FlowMic does not put a single
 * free minute on a third party's page. So a key that cannot be used is a
 * REFUSAL — never a downgrade to the anonymous arm, which is what the retired
 * ruling W-6 (「no key or no quota ⇒ fall back to the anonymous trial」) asked
 * for and what §9-1 overturned.
 */
async function handleIntegrator(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebRoomRoutesDeps,
): Promise<void> {
  // 🔴 Card MP-11 / gap G-16 — THE GRANT ON THE REAL RESPONSE, WITHOUT WHICH
  // THE PREFLIGHT BUYS NOTHING. A browser that was told「you may POST here」 and
  // then gets an answer with no `access-control-allow-origin` on it discards
  // that answer unread: to the host page, a perfectly good 200 full of room
  // credentials and a 401 look identical (both are「TypeError: Failed to
  // fetch」). So it is applied ONCE, here, before any of this arm's exits —
  // refusals included, because「your key is not allowed from this origin」 is
  // the one sentence a developer wiring the SDK most needs to actually read.
  //
  // ⚠️ THIS ARM ONLY. The account arm and the demo arm are not touched: both
  // are called from a page on an origin nginx already serves the API from, so
  // their responses carry no CORS header today and must carry none after this
  // card — a header appearing on the demo's answer would be this card changing
  // a surface it has no business on. `web-room-cors.test.ts` asserts that
  // absence rather than trusting this comment.
  applyReflectedOrigin(req, res);
  const integrator = deps.integrator;
  if (!integrator) {
    // The SAME shape the demo arm uses for an unwired deployment, and the same
    // reason: from the page's side 「this relay does not serve integrations」 and
    // 「your key was refused」 are different facts and must not share an answer.
    // 503 rather than 401, because nothing was wrong with the credential.
    log.warn('integrator room refused', { reason: 'unwired', route: '/api/web/rooms' });
    sendJson(res, 503, { error: 'WEB_DEMO_UNAVAILABLE' });
    return;
  }
  // The credential comes from the header and only from there — the rule this
  // file states at the top, applied to a third kind of credential.
  const presented = str(req.headers?.authorization).replace(/^Bearer\s+/i, '');
  const verdict = integrator.keys.admit(presented, str(req.headers?.origin) || null);
  if (!verdict.ok) {
    // 🔴 TWO REFUSALS, NOT THREE, AND NO NEW ERROR CODE. `unknown` and `revoked`
    // are ONE answer (401 `AUTH_TOKEN_INVALID`) for the reason the demo arm
    // folds unknown and expired into one: they are the same fact from the
    // caller's side — 「this credential is not usable」 — and separating them
    // would tell somebody holding a guessed string whether it ever existed.
    // `origin` is the OTHER answer (403 `WEB_ROOM_ORIGIN_NOT_ALLOWED`) because
    // its remedy is a different one: the integrator adds this origin in their
    // console, and nothing about the key itself needs to change.
    //
    // `WEB_ROOM_ORIGIN_NOT_ALLOWED`'s copy is context-neutral (card MP-4):
    // it names neither the demo nor a third-party page, so this refusal and
    // the demo arm's can share the one code honestly. The sentence itself
    // lives in packages/protocol/src/error-codes.ts, zh_CN + en only — the
    // registry never carried the other seven UI locales for it.
    const status = verdict.reason === 'origin' ? 403 : 401;
    const error = verdict.reason === 'origin' ? 'WEB_ROOM_ORIGIN_NOT_ALLOWED' : 'AUTH_TOKEN_INVALID';
    // The log line is where the three ARE told apart — the same division the
    // demo arm makes, and the reason `WEB_DEMO_UNAVAILABLE` can fold four causes
    // into one sentence at all.
    log.warn('integrator room refused', {
      reason: verdict.reason,
      route: '/api/web/rooms',
      origin: str(req.headers?.origin) || '(none)',
    });
    sendJson(res, status, { error });
    return;
  }
  const key = verdict.key;
  const restricted = restrictionVerdict(deps.auth, key.user_id);
  if (restricted !== null) {
    // THE INTEGRATOR's account is restricted — refused before a room is minted
    // against it, the same order the account arm uses. The visitor is not the
    // subject of this refusal and can do nothing about it, which is why the body
    // is the account arm's rather than a new sentence: card MP-2 renders 「this
    // site's voice input is unavailable」 from any non-200 on this route.
    sendJson(res, 403, restrictionRefusalBody(restricted.reason));
    return;
  }
  // Keyed on the KEY's OWNER, and only after the key is established — the
  // addendum's 09-07 note: no gate at the entrance charging an identity nobody
  // has established yet. One integrator hammering this endpoint must not spend
  // another integrator's budget.
  const rate = deps.limiter.check(key.user_id);
  if (!rate.allowed) {
    sendJson(res, 429, { error: 'WEB_ROOM_RATE_LIMITED', retry_after_ms: rate.retryAfterMs });
    return;
  }
  deps.limiter.record(key.user_id);

  // 🔴 card MP-13 (owner §11 追认 item 6) — THE ROOM IS CALLED WHAT THE SITE IS
  // CALLED. `device_name` is what a phone puts in its top bar and in its PC
  // list, so a visitor who tapped a microphone on somebody's website sees that
  // website's name there instead of a FlowMic product string that tells them
  // nothing about where their words are going. Never localized — a site's name
  // is its own name in every language (`integratorRoomName`'s note).
  //
  // ⚠️ THE LABEL IS THE KEY'S, READ OFF THE ROW `admit` JUST RETURNED. Not
  // re-fetched, not passed in by the page: the page is the party whose name this
  // is, and letting it send one would make the top bar caller-controlled text.
  const room = integrator.mint(
    key.user_id,
    key.id,
    {
      ...(integrator.ttlMs === undefined ? {} : { ttlMs: integrator.ttlMs }),
      deviceName: integratorRoomName(key.label),
    },
  );
  const wsOrigin = relayWsOrigin(req, deps.trustedProxies ?? trustedProxiesFromEnv());
  // One line per MINT, like both arms beside it, so 「where did these rows come
  // from」 has one place to look. `key_id` and never the key STRING: the string
  // is publishable, but a log is not a place to accumulate other people's
  // credentials, and the id is what the console and `usage_events` both join on.
  log.info('integrator room minted', { user_id: key.user_id, pc_id: room.pc.id, key_id: key.id });
  sendJson(res, 200, {
    room_token: room.token,
    pcid: room.pc.pcid,
    code: room.code,
    // `PAIR_HTTPS_PATH`, not the demo path: a visitor who HAS FlowMic installed
    // may use it here. Owner ruling 6's exception is about FlowMic's OWN
    // marketing page pulling people into the app, which is not this story.
    pair_url: webRoomPairUrl(wsOrigin, room.code, room.pc.pcid),
    endpoint: wsOrigin,
    expires_at: room.expiresAtMs,
    // 🔴 THROUGH THE SAME PRODUCER, WITH THE KEY — so this first response
    // already reads `mode:'integrator'` and carries the SUB-QUOTA's remaining
    // rather than the integrator's whole month. `budget-push.view` is what makes
    // that ONE decision instead of two, and what keeps `resets_at` and the plan
    // tier off a page full of strangers (design §4).
    budget: deps.budget.view(key.user_id, undefined, { integratorKeyId: key.id }),
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebRoomRoutesDeps,
): Promise<void> {
  {
    const body = await readJsonBody(req);
    const kind = readAuthKind(body);

    // ── ① WHICH DOOR ────────────────────────────────────────────────────────
    if (kind === 'anon_token') {
      await handleAnonymous(req, res, deps);
      return;
    }
    if (kind === 'publishable_key') {
      await handleIntegrator(req, res, deps);
      return;
    }
    if (kind !== 'account_jwt') {
      // A 400 and a sentence, not a 401 and not a silent fallback to a served
      // arm. Still `SETTINGS_SCHEMA_INVALID` rather than one of the demo codes:
      // this says the KIND is not served, which is a statement about the request
      // envelope, and a demo code here would tell an integrator their key was
      // rejected when it was never looked at.
      const served = KNOWN_AUTH_KINDS.includes(kind as AuthKind);
      sendJson(res, 400, {
        error: 'SETTINGS_SCHEMA_INVALID',
        message: served
          ? `auth.kind '${kind}' is not served by this deployment yet`
          : `auth.kind '${kind}' is not a known identity kind`,
      });
      return;
    }

    // ── ② WHO ───────────────────────────────────────────────────────────────
    const who = accountFromBearer(req, deps.auth);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return;
    }
    const restricted = restrictionVerdict(deps.auth, who.userId);
    if (restricted !== null) {
      // Same order the console's write routes use: a restricted account is
      // refused before anything is minted on its behalf.
      sendJson(res, 403, restrictionRefusalBody(restricted.reason));
      return;
    }
    // ⚠️ DELIBERATELY NO EMAIL-VERIFICATION GATE, unlike the console's device
    // writes. `audio:start` already owns that decision and gives new accounts a
    // three-day grace window (owner ruling 2026-08-27, EMAIL_VERIFY_GRACE_EXPIRED);
    // refusing a room here would deny the page to somebody the recording path
    // would have admitted, i.e. two answers to one question with the stricter one
    // in the place that cannot explain itself.

    // ── ③ HOW OFTEN ─────────────────────────────────────────────────────────
    // Keyed on the ACCOUNT, and only reached after ②, which is what the
    // addendum's 09-07 note requires: no gate at the entrance charging an
    // identity we have not established yet.
    const verdict = deps.limiter.check(who.userId);
    if (!verdict.allowed) {
      sendJson(res, 429, { error: 'WEB_ROOM_RATE_LIMITED', retry_after_ms: verdict.retryAfterMs });
      return;
    }
    deps.limiter.record(who.userId);

    // ── ④ THE ROOM ──────────────────────────────────────────────────────────
    const room = await deps.rooms.ensureWebRoom(who.userId, deps.ttlMs === undefined ? undefined : { ttlMs: deps.ttlMs });
    const wsOrigin = relayWsOrigin(req, deps.trustedProxies ?? trustedProxiesFromEnv());

    if (room.created) {
      // One line per MINT, none per idempotent hit: the question this log has to
      // answer is「where did these rows come from」, and a line on every reload
      // would bury it. `released` is on the same line because a replacement
      // DELETED rows, which is the half an operator needs to find.
      log.info('web room minted', {
        user_id: who.userId,
        pc_id: room.pc.id,
        replaced_expired: room.replacedExpired,
        released_pairings: room.releasedPairings.length,
      });
    }

    sendJson(res, 200, {
      room_token: room.token,
      // NULL is possible and must travel as null: `stampPcid` is saas-only, so a
      // standalone build of this route would have no PCID to give. The page then
      // renders a code-only QR — `buildHttpsQrPayload` omits the key for the same
      // reason. Never a placeholder: a made-up PCID is an address that resolves
      // to nothing.
      pcid: room.pc.pcid,
      code: room.code,
      pair_url: webRoomPairUrl(wsOrigin, room.code, room.pc.pcid),
      endpoint: wsOrigin,
      expires_at: room.expiresAtMs,
      budget: deps.budget.view(who.userId),
    });
  }
}
