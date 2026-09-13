// SPEC-REF:
//   docs/strategy/2026-09-10-web-room-release-and-unsigned-limit-design.md §2.1
//     (what is true today and why it is wrong), §2.2 (this mechanism), §2.3
//     (the failure directions and the reverse controls)
//   docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md §6
//     item 4 (owner's words: an unsigned web transcription page says so and
//     shows a two-minute countdown)
//   docs/decisions/2026-09-09-owner-stage4-site-demo-six-more-rulings.md §13
//     (「体验不占账号额度」 — the sentence this file is the server half of)
//   docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md §10
//     (owner 2026-09-11 — one lifetime 120 s per BROWSER IDENTITY, remembered
//     until the browser's storage is cleared; SUPERSEDES the per-network daily
//     sequence this file was written against)
//   ../billing/trial-ledger.ts (the ONE allowance: `TRIAL_LIFETIME_GRANT_MS`,
//     claimed by `device_uid` — this file invents no number and no key)
//   ./metering-principal.ts (WHICH account the seconds come off, once this file
//     has said whether there is a trial identity to come off at all)
//   *** HUMAN-AUDIT SENSITIVE (auth admission + billing) — reviewable in isolation ***
//
// Card R-1 — 「an unsigned browser paired to somebody's real PC spends WHOSE
// minutes?」
//
// -- WHAT IT WAS, AND WHY THAT IS THE DEFECT ------------------------------
//
// `registry.pairMobile` writes `input.user_id ?? pc.user_id` and its only caller
// passes no `user_id`, so EVERY pairing row — App or browser, signed in or not —
// carries the PC owner's account. For an App phone that is right: the handset
// belongs to the person whose computer it is. For a browser that scanned a QR
// code it is a DEFAULT that nobody declared, and it had one visible consequence:
// every second an unsigned visitor spoke came off the desktop owner's monthly
// allowance, the budget frames said `mode:'plan'`, and the page therefore had no
// clock, no limit and no reason to offer a sign-in. Owner's ruling asks for the
// opposite of all four.
//
// -- THE RULE, AS A CONJUNCTION -------------------------------------------
//
// 🔴🔴 REWRITTEN 2026-09-11 (card MP-6, owner §11 / design §10-4). THE THIRD
// BULLET BELOW IS NOW EXACTLY BACKWARDS AND IS KEPT BECAUSE IT WAS TRUE WHEN IT
// WAS WRITTEN: minting happens INSIDE demo rooms and nowhere else. Its argument
// («a demo room's owner is already an anonymous identity with its own grant»)
// died with the model it described — under §11 the demo room's spend is billed
// to a REAL demo account, so the anonymous identity is no longer anybody's
// allowance and there is no second answer to ration against. The first two
// bullets are unchanged and still hold.
//
// A trial identity is minted for exactly one shape, and each of the three parts
// excludes a different mistake:
//   · the pairing row says `client === 'web'`  — an App phone is not this card;
//   · the socket carries NO verified account   — a signed-in visitor is metered
//     to their account, which is W4-05's rule and not a new one here;
//   · the account it would otherwise be billed to is a REAL one — a site-demo
//     room's owner is ALREADY an anonymous identity with its own grant
//     (card M4-01), and minting a second one inside it would ration one visit
//     twice and give 「how long may this person speak」 two answers.
//
// -- ONE IDENTITY PER BROWSER, NOT PER PAIRING AND NOT PER PAGE LOAD ------
//
// 🔴 THE KEY IS `device_uid`, THE `wb-…` VALUE THE BROWSER KEEPS IN
// localStorage (owner §10). `mobile_pairings.trial_user_id` is still written and
// still read first, but it is now a SHORTCUT to the row the uid would find
// anyway, not the key itself. The difference is the whole of this card's
// revision, and it shows up in exactly one situation: a browser whose PAIRING
// went away (the owner revoked it, the 60-day pairing sweep took it, the visitor
// scanned a different computer) but whose BROWSER did not. Keyed on the pairing,
// that visitor collected a fresh 120 s; keyed on the uid, they continue on what
// they had. owner asked for the second one in as many words —
// 「只要不清空浏览器缓存就要记住」.
//
// A visitor who reloads, re-pairs or reconnects therefore CONTINUES on the
// minutes they have left. An in-memory table was rejected for the reason it is
// always rejected here: a relay restart would hand everybody a fresh allowance,
// and nothing would say so.
//
// 🔴 THERE IS NO DAILY RESET AND NO PER-NETWORK DECAY. The sequence this file
// was written against (120 / 60 / 30 / 0 per IP bucket per UTC day) is gone;
// the site demo's IP and site-wide caps remain, as ABUSE ceilings that decide
// whether a request is served at all and never how many seconds it is worth.
// 「Clear the site data and scan again」 does buy another two minutes, and owner
// accepted that cost explicitly — billing/trial-ledger.ts states it in full
// rather than leaving a comment that implies otherwise.
//
// -- FAILURE DIRECTIONS (design §2.3) -------------------------------------
//
//   · no minter wired (an older relay, or a test that omits it) ⇒ no identity ⇒
//     metered exactly as it is today. Never 「unlimited」: unlimited has one
//     author in this server (`QuotaGuard.remainingSttMs` answering `Infinity` on
//     a standalone deployment) and nothing here can reach it;
//   · the ledger write fails ⇒ the SAME, plus a log line at error. Refusing the
//     pairing was considered and rejected: a visitor who cannot pair learns
//     nothing, and the failure we are guarding against is a billing one;
//   · this browser's two minutes are already spent ⇒ the SAME identity is
//     returned, with nothing left on it. That is deliberate, and it is the whole
//     of owner §10's second half: a real identity at zero gives the page a
//     refusal it can render (`QUOTA_EXCEEDED`) and a sign-in it can offer, where
//     a missing identity would silently go back to spending the desktop owner's
//     minutes;
//   · the browser declared no `device_uid` (an older web build) ⇒ an identity is
//     minted per pairing, exactly as it was before this revision. It is stated
//     rather than guarded against: refusing would take the product away from a
//     client that has done nothing wrong.

import { clientOriginOf } from '@flowmic/protocol';
import type { RoomKind } from './metering-principal';
import type { TrialLedger } from '../billing/trial-ledger';
import type { MobileRepo } from '../db/repos/mobile.repo';
import { ipBucketOf } from '../billing/trial-ip-bucket';
import { log } from '../log';

/**
 * Is this pairing row a BROWSER end?
 *
 * 🔴 THROUGH `clientOriginOf` AND NEVER `client === 'web'`, because the
 * interesting case is the NULL: a row paired before that column existed reads as
 * `'app'`, and the protocol says in as many words that the absent-value default
 * has exactly one author and that callers go through this function rather than
 * spelling it. Spelling it here would make this the second author of 「what is a
 * row that says nothing」 — and this reader would then be handing an anonymous
 * trial identity to every pre-column pairing on the platform.
 *
 * It is compared against the COLUMN, never against a URL, an Origin header or a
 * room kind: what paired is a fact the pairing frame declared, not something to
 * be inferred later from the neighbourhood.
 */
export function isWebPairing(client: string | null): boolean {
  return clientOriginOf(client) === 'web';
}

/** What {@link webTrialDecision} is shown. Every field is a fact already
 *  resolved by the admission that is calling it — nothing here re-reads a row. */
export interface WebTrialDecisionInput {
  /** `mobile_pairings.client` — 'web' for a browser end, 'app' for the handset,
   *  NULL for a row paired before the column existed. */
  client: string | null;
  /**
   * card MP-0 — the FAR END this browser paired to (`roomKindOf`).
   *
   * 🔴 CARD MP-6 MADE IT THE WHOLE CONDITION, not a refusal beside the others:
   * a grant is minted for `'demo'` and for nothing else. The paragraph below is
   * kept because its argument still holds and is now enforced by a stricter
   * test — an integrator room fails `!== 'demo'` before anything else is asked.
   *
   * 🔴 THE ONE THING IT WAS ORIGINALLY READ FOR WAS A REFUSAL: on a third-party host room
   * (`'integrator'`) FlowMic does not put a single free minute on the table —
   * the page's owner pays for every visitor, signed in or not (owner §9-1). The
   * mint conjunction below would otherwise say YES to exactly that visitor, and
   * for a reason that reads as correct: an integrator IS a real account, so
   * 「the account that would otherwise be billed is real」 holds. That is design
   * D3, and it is the half of D2/D3 that has to land BEFORE the third-party
   * path exists rather than with it — the day `publishable_key` starts minting
   * rooms, this file would already be handing their visitors our minutes.
   *
   * `null` (a kind this build cannot read) also refuses, for the same reason it
   * refuses everywhere else in this card: an unknown far end may be a host page.
   */
  roomKind: RoomKind | null;
  /** The VERIFIED handshake account on this socket, or null. Production value:
   *  `getAccount(socket)`. */
  account: { userId: string } | null;
  /** `mobile_pairings.trial_user_id` as it stands on the row right now. */
  trialUserId: string | null;
  // 🔴 `pairedUserId` AND `reader` WERE HERE UNTIL CARD MP-6, and they are gone
  // rather than kept-but-unread. Both existed to answer one question — 「is the
  // account this pairing would otherwise be billed to an anonymous site-demo
  // identity?」 — and `roomKind === 'demo'` is now that same answer, computed
  // once per admission by `roomKindOf` and shared with the payer rule. Leaving
  // a field nobody reads is this repo's façade shape: the next reader would
  // wire it, believing it decided something.
  /**
   * May this admission WRITE?
   *
   * 🔴 FALSE ON A REPLICA, and it is not a performance decision. Minting is two
   * INSERTs (`users` + `trial_ledger`) and a replica's tables are replaced
   * wholesale every 30 seconds by the writer's snapshot — so an identity minted
   * there would vanish mid-session, taking the pairing's reference with it, and
   * the visitor would be handed a fresh 120 s on the next admission. `mobile:pair`
   * is writer-only already; `mobile:reconnect` is the leg that can land anywhere,
   * and it REUSES what the writer minted rather than minting its own.
   */
  mayMint: boolean;
}

export type WebTrialDecision =
  /** Not this card's shape — metering is unchanged (`meteringPrincipal`'s
   *  pre-R-1 answer). */
  | { kind: 'none' }
  /** The row already names a live trial identity; spend that one. */
  | { kind: 'reuse'; userId: string }
  /** An unsigned web instance with no identity yet, on a node that may write. */
  | { kind: 'mint' };

/**
 * The rule, with nothing around it — no database, no clock, no ledger.
 *
 * 🔴 IT IS PURE SO THAT THE REVERSE CONTROLS CAN BE CHEAP. Design §2.3 asks for
 * 「remove the web branch ⇒ the ack still says 'plan' and the PC owner's
 * usage_records grow」; that is a golden, and it costs a real server and a real
 * recording. Everything else about the rule — which of the three conditions was
 * the one that failed — is answered here in microseconds, so the golden can be
 * about the one thing only a golden can prove.
 */
export function webTrialDecision(input: WebTrialDecisionInput): WebTrialDecision {
  // 🔴🔴 CARD MP-6 INVERTED THIS LINE, and it is the single most consequential
  // edit in the file. It used to read 「not an integrator and not an unreadable
  // kind」 and then, four lines down, 「and NOT a demo room」. It now says: DEMO
  // ROOMS AND NOTHING ELSE.
  //
  // Why the flip is the same rule read from the other end. A trial grant is no
  // longer WHO PAYS on any branch (auth/metering-principal.ts `resolvePayer`,
  // owner §11) — it is the site demo's per-browser CAP. So the question this
  // function answers changed from 「should FlowMic hand this visitor free
  // minutes」 to 「is this the one room whose visitors are capped per browser」,
  // and there is exactly one such room kind.
  //
  // What it takes away: an unsigned browser paired to somebody's real desktop no
  // longer mints or spends a grant. That visitor is now billed to the room's
  // owner (`resolvePayer` step 4), which is what owner §11 asks for — the
  // owner's account is a thing an operator can look up, and the owner can revoke
  // the pairing whenever they like. The two minutes and the countdown stay on
  // the marketing demo, which is the only place §10 ever put them.
  //
  // An integrator room and an unreadable kind still answer 'none', now by
  // falling out of the same condition rather than by naming themselves.
  if (input.roomKind !== 'demo') return { kind: 'none' };
  // 🔴 AND NO CLIENT CHECK. `isWebPairing(input.client)` stood here until the
  // same pass that inverted the line above, and dropping it is design §10-1
  // step 3 read literally: that step is about the ROOM, and it says nothing
  // about what is holding the microphone. An App handset CAN pair into a demo
  // room — golden G26 does exactly that — and without a cap it would be billed
  // to FlowMic's demo account with no per-device ceiling at all, which is the
  // one shape §10-4 exists to prevent. The grant is keyed on `device_uid`, so a
  // handset gets its own two minutes the same way a browser does.
  //
  // ⚠️ `isWebPairing` IS STILL EXPORTED AND STILL READ — by `occupiesMobileSlot`
  // (room/registry-shared.ts), which asks a different question: not 「does this
  // speaker get a grant」 but 「is this a device on somebody's account」.
  // A verified account outranks a trial identity — and outranks minting one. The
  // page redials with its JWT the moment somebody signs in (W4-05), and from
  // that admission the seconds are the account's.
  if (input.account) return { kind: 'none' };
  // 🔴 THE REUSE BRANCH DOES NOT ASK THE READER, and that is a claim about the
  // column rather than laziness: the only writer of `trial_user_id` is this
  // module (which writes an id it has just minted), and the foreign key's
  // `ON DELETE SET NULL` empties it the instant the 48-hour sweep takes the
  // identity. So a non-null value IS a live anonymous row. Asking the reader
  // would ALSO be wrong on a replica that has the pairing but not yet the
  // account row — it would answer 「not anonymous」 and quietly re-mint.
  if (input.trialUserId !== null) return { kind: 'reuse', userId: input.trialUserId };
  return input.mayMint ? { kind: 'mint' } : { kind: 'none' };
}

/** What an admission handler asks. One method, so the handler cannot accidentally
 *  learn about buckets, salts or ledgers. */
export interface WebTrialIdentities {
  /**
   * The anonymous identity this admission should be metered under, or null for
   * 「not this card's shape — meter it the way you would have」.
   *
   * Writes at most one row-pair, and only on the `mint` branch.
   */
  resolve(input: WebTrialResolveInput): string | null;
  // ⚠️ `willMint` STOOD HERE (card NR-29) AND IS GONE (card MP-6). It answered
  // 「would this admission mint a grant」 one step earlier than `resolve`, because
  // the handset-slot exemption was read off `trial_user_id` — a column written a
  // moment AFTER `registry.pairMobile` checked the ceiling. That exemption now
  // reads `client`, which the insert writes itself, so the question had no
  // remaining asker. `room/registry.ts` carries the argument at the line that
  // used to consult it.
}

export interface WebTrialResolveInput extends Omit<WebTrialDecisionInput, 'trialUserId'> {
  /** The pairing row being admitted. `device_uid` is the browser identity owner
   *  §10 keys the allowance on; null on a row paired before that column existed
   *  or by a client that declared none. */
  mobile: { id: string; trial_user_id: string | null; device_uid: string | null };
  /** The client address behind this socket — `clientIpFromHandshake`, the SAME
   *  derivation the pair limiter buckets on. Hashed here, never stored raw. */
  ip: string;
}

export interface WebTrialDeps {
  trials: Pick<TrialLedger, 'claim'>;
  mobiles: Pick<MobileRepo, 'setTrialUser'>;
  /** `FLOWMIC_TRIAL_IP_SALT`, resolved once at boot (`resolveIpBucketSalt`). */
  ipSalt: string;
  /** The token TTL the ledger row is stamped with. See `mint` below for why a
   *  token is minted at all on a path that never hands one out. */
  tokenTtlMs: number;
  newId(): string;
  newToken(): string;
  now?: () => number;
}

export function makeWebTrialIdentities(deps: WebTrialDeps): WebTrialIdentities {
  const clock = deps.now ?? Date.now;
  return {
    resolve(input): string | null {
      const decision = webTrialDecision({ ...input, trialUserId: input.mobile.trial_user_id });
      if (decision.kind === 'none') return null;
      if (decision.kind === 'reuse') return decision.userId;
      try {
        // 🔴 THE SAME LEDGER AND THE SAME KEY AS THE MARKETING SITE, ON PURPOSE
        // (owner §10: 「同一套身份」). A visitor who spent 90 seconds on the
        // marketing demo and then scanned somebody's desktop has 30 left, not
        // 120 — a second book, or the same book with a second key, would answer
        // 「how much of their two minutes is gone」 twice.
        //
        // 🔴 `claim`, NOT `mint`: this may find the identity the browser
        // already has. A pairing revoked and remade lands right back on it.
        //
        // ⚠️ A TOKEN IS WRITTEN AND NEVER HANDED OUT. `TrialLedger.claim` mints
        // or rotates one because the HTTP arm's caller needs a credential; this
        // arm's caller is already authenticated by its pairing token, so the
        // value is written, never sent, and expires unused. Left alone rather
        // than made optional: a nullable `anon_token` would weaken a UNIQUE
        // column for the convenience of one caller.
        const claimed = deps.trials.claim({
          deviceUid: input.mobile.device_uid,
          ipBucket: ipBucketOf(input.ip, deps.ipSalt),
          nowMs: clock(),
          tokenTtlMs: deps.tokenTtlMs,
          newId: deps.newId,
          newToken: deps.newToken,
        });
        deps.mobiles.setTrialUser(input.mobile.id, claimed.userId);
        log.info(
          claimed.reused
            ? 'web trial identity REUSED for an unsigned web pairing (owner §10 — this browser already had one)'
            : 'web trial identity minted for an unsigned web pairing',
          {
            pairing_id: input.mobile.id,
            anon_id: claimed.userId,
            reused: claimed.reused,
            granted_ms: claimed.grantedMs,
            remaining_ms: claimed.remainingMs,
            grants_used_today: claimed.grantsUsedToday,
          },
        );
        return claimed.userId;
      } catch (err) {
        // Loud, and then TODAY'S behaviour. See the header: the alternative —
        // refusing the pairing — turns a billing fault into an outage for the
        // visitor, and this is the one branch nobody would otherwise see.
        log.error('web trial identity could not be minted — this session falls back to the PC owner\'s allowance', {
          pairing_id: input.mobile.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
  };
}
