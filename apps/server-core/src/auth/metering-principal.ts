// SPEC-REF:
//   docs/strategy/2026-09-09-w4-05-login-switches-metering-design.md §0/§1/§2
//     (the rule, its two exceptions, and the failure directions)
//   docs/decisions/2026-09-09-owner-stage4-site-demo-six-more-rulings.md §13
//   docs/legal/privacy-policy.md "Trying FlowMic on the website" item 4
//   apps/server-core/src/billing/budget-push.ts (WHOSE number a socket is told)
//   *** HUMAN-AUDIT SENSITIVE (auth admission + billing) — reviewable in isolation ***
//
// Card W4-05 — "a site-demo visitor who signs in on the phone is metered to
// their ACCOUNT from that moment on".

// 🔴🔴 REWRITTEN 2026-09-11 (card MP-0, owner ruling §9 / §9-1 — design
// docs/strategy/2026-09-11-metering-principal-matrix-design.md). READ
// `resolvePayer` BELOW FIRST: it is now the single ordered rule, and both of the
// two functions this file used to lead with are shapes of it.
//
// 🔴🔴 IN-PLACE CORRECTION, SAME DAY (card MP-6, owner ruling §11, design §10-1):
// THE SENTENCE BELOW IS NOW FALSE, AND IT IS KEPT BECAUSE IT WAS TRUE WHEN IT
// WAS WRITTEN. The far end no longer decides first. owner §11 opens with 「如果
// FLOWMIC-WEB 登录了就扣减当前登录用户即自己的额度」, so a VERIFIED SPEAKER OUTRANKS
// EVERY FAR END, and the far end is the answer only when nobody is signed in.
// The one cell where the two orders disagree is a signed-in FlowMic user
// speaking into a third-party host page: §9-1 billed the host, §11 bills the
// speaker. Everything the paragraph below says about D1 (a signed-in phone on
// somebody else's computer pays for itself) is UNCHANGED and is now step 1
// rather than step 3.
//
// What changed, in one sentence: THE FAR END DECIDES BEFORE THE SPEAKER DOES,
// and after that, whoever is speaking pays. Concretely (design D1) a phone
// signed into its OWN account, paired to somebody else's computer, used to be
// billed to THE COMPUTER'S OWNER — its own account was never asked, because the
// handshake account was allowed to override the paired row only on a web row or
// under an anonymous owner. It is asked now.
//
// 🔴🔴 IN-PLACE CORRECTION, SAME DAY AGAIN (card MP-10, owner ruling §11
// 再追认 2026-09-11 凌晨). EVERYTHING ABOVE FROM 「IN-PLACE CORRECTION, SAME
// DAY」 DOWN TO HERE IS NOW FALSE, AND IT IS KEPT BECAUSE IT WAS TRUE WHEN IT WAS
// WRITTEN. owner's last word is 「「已登录用户默认也是扣对端」也包括自家 PC」
// ⇒ **只要有对端，就扣对端；没有对端（手机轻记录）才扣自己。**
// So the D1 sentence in the paragraph above — 「a phone signed into its OWN
// account, paired to somebody else's computer, is billed to that phone」 — is
// EXACTLY BACKWARDS as of this card: the computer's owner pays, and the phone's
// account is asked only to decide whether the payer happens to BE the speaker.
// There is no longer a general speaker step at all; the site demo (W4-05) is the
// one far end a signed-in speaker still outranks. `resolvePayer`'s own header
// carries the ordered rule, what moved, and what deliberately did not.
//
// ⚠️ THE PARAGRAPH BELOW STANDS, and its MEASUREMENT (why nothing is written
// to `mobile_pairings.user_id`) is still the reason nothing is written there —
// which is easy to lose, and is why the paragraph is kept rather than trimmed.
//
// -- THE ONE RULE, AND WHY IT LIVES IN A FILE OF ITS OWN --------------------
//
// Three call sites need it and they are in two handlers: `mobile:pair` and
// `mobile:reconnect` stamp the identity (`setAuth`), `audio:start` gates on it
// (QTA-2) and the budget push addresses the room's other end with it. Those are
// three DIFFERENT questions about ONE fact, and this repo's #1 bug shape is one
// value quietly answering two of them. Written out three times in three files,
// the answers drift; written once here, a reader can check all three against
// each other in twenty lines.
//
// -- IT IS DECLARED BY THE HANDSHAKE, NOT WRITTEN TO A ROW ------------------
//
// The design register (2026-09-09 stage-4 design §5.4) sketched "set the pairing
// row's user_id to the account". That was rejected on a measurement: the write
// would make the demo pairing occupy a MOBILE SLOT on the signed-in account
// (`ensureMobileSlot(input.user_id ?? pc.user_id)` — registry.ts `pairMobile`)
// and would leave a foreign-account pairing row hanging off an anonymous PC that
// the 48-hour sweep then deletes underneath it. So the principal is derived per
// admission from the socket's verified handshake account and nothing is stored.
// `mobile_pairings.user_id` is not written by this card, in either handler.
//
// ⚠️ CARD R-1 (2026-09-10) DOES STORE SOMETHING, AND IT IS NOT THAT COLUMN.
// An unsigned web pairing's TRIAL identity is persisted, to
// `mobile_pairings.trial_user_id` — a second, nullable column whose delete rule
// is `SET NULL` where `user_id`'s is `CASCADE`. The paragraph above is the
// reason it had to be a second column: writing an identity into `user_id` would
// spend a mobile slot on the account and would let the 48-hour anonymous sweep
// delete the pairing itself. The rule below therefore reads a stored value on
// ONE branch (`trialUserId`) and derives everything else per admission, exactly
// as before.
//
// -- FAILURE DIRECTIONS (design §2): EVERY ONE OF THEM LANDS ON "STILL TRIAL" -
//
// ⚠️ READ AS 「ON THE SITE-DEMO PAGE」. Card MP-6 replaced the trial identity as
// a PAYER everywhere (it survives as a CAP on the demo branch), and card MP-10
// took the general speaker step away, so on a FlowMic PC / target far end the
// listed failures now land on THE ROOM OWNER rather than on a trial — which is
// the same direction the list is making its point about (never 「unlimited」,
// never 「nobody」) and is stated here rather than by editing four lines whose
// original subject was the demo card.
//
//   · an older relay has no rule here          ⇒ the demo identity, mode 'trial'
//   · the JWT is expired/invalid               ⇒ `getAccount` is null ⇒ trial
//     (auth/middleware.ts `resolveHandshakeJwt` records the code and NEVER
//     refuses the connection, so the socket arrives with no account)
//   · the page never redials with the jwt      ⇒ trial
//   · `anonymous` is unwired (`reader` absent) ⇒ trial
//
// None of them lands on "unlimited". Unlimited has exactly one author in this
// server — `QuotaGuard.remainingSttMs` answering `Infinity` on a standalone
// deployment — and nothing in this file can reach it.
//
// -- THE DESIGN'S TWO OPEN QUESTIONS, AS DECIDED ---------------------------
//
// Q1 「a visitor who is ALREADY signed in when they scan」: metered to the
// account FROM THE FIRST SENTENCE. It falls out of the rule rather than being a
// case beside it — the JWT is on the handshake before `mobile:pair` runs, so the
// first admission already sees an account. The alternative (spend the demo's two
// minutes first) would need a second way to declare who you are, which is the
// shape §0 rejected.
//
// Q3 「the account's own allowance is exhausted」: the ordinary exhausted frame
// and the ordinary QUOTA_EXCEEDED refusal — no demo-flavoured variant and no new
// code. The card then shows the regular exhausted face with the download call to
// action only; that is a page decision, and the server's part is precisely that
// it says nothing special. Pinned by golden G26-b section 16.

import { INTEGRATOR_ROOM_KIND, WEB_ROOM_KIND, isKnownRoomKind } from '../room/registry-shared';

/**
 * Is this users row an anonymous site-demo identity (`users.anonymous = 1`)?
 *
 * A row this process cannot find is NOT anonymous, which is the same fail-safe
 * direction `budgetReaderFrom.modeFor` takes for the same column: the miss must
 * never turn a real account's admission into a demo one.
 */
export type AnonymousRowReader = (userId: string) => boolean;

/** The production reader. One author for the column read, two call sites
 *  (bootstrap wires it into the mobile and audio handlers). */
export function anonymousRowReader(
  users: { findById(id: string): { anonymous: boolean } | null },
): AnonymousRowReader {
  return (userId) => users.findById(userId)?.anonymous === true;
}

export interface MeteringPrincipalInput {
  /** The verified handshake account on this socket, or null. Production value:
   *  `getAccount(socket)` (socket/wire.ts), which is set only by
   *  `resolveHandshakeJwt` after `verifyJwt` succeeded. */
  account: { userId: string } | null;
  /** The room owner — `pc_devices.user_id`. */
  pcUserId: string;
  /** The pairing row's own account, when it has one. */
  mobileUserId?: string | null;
  /** card MP-0 — the FAR END's kind, as {@link roomKindOf} resolved it from
   *  `pc_devices.room_kind` plus `users.anonymous`. `null` means 「this build
   *  does not understand the value stored on that row」 and the admission must
   *  be refused rather than billed to a guess (design §5). */
  roomKind: RoomKind | null;
  /** card R-1 — the anonymous trial identity this unsigned web pairing spends,
   *  as resolved by `auth/web-trial-identity.ts`, or null.
   *
   *  🔴 CARD MP-6 CHANGED WHAT IT IS FOR, not where it comes from. It is no
   *  longer a PAYER on any branch; it is the site demo's per-browser CAP
   *  (`PayerDecision.capUserId`), and `web-trial-identity.ts` now mints one for
   *  demo rooms only. */
  trialUserId?: string | null;
  /** card MP-6 — the BROWSER/DEVICE identity behind this admission
   *  (`mobile_pairings.device_uid`), used as {@link MeteringPrincipal.speakerRef}
   *  when nobody is signed in. Never an email and never an account id. */
  deviceUid?: string | null;
  /** card MP-6 — `FLOWMIC_DEMO_PAYER_USER_ID`, or null when the deployment has
   *  not configured one. Null makes a DEMO room unbillable and therefore
   *  refused; it never falls back to anything. */
  demoPayerUserId?: string | null;
  /** card MP-1 — the publishable key that minted this room
   *  (`integrator_rooms.key_id`), or null. Only ever non-null on an
   *  `'integrator'` far end; the caller reads it from the room row it already
   *  holds, so nothing here has to look it up a second time. */
  integratorKeyId?: string | null;
  reader?: AnonymousRowReader | undefined;
}

export interface MeteringPrincipal {
  /** The account `setAuth` stamps, and therefore the ledger `commitSttUsage`
   *  writes to (`audio.handler.ts`). */
  userId: string;
  /**
   * True only when this admission moved the meter OFF the demo identity.
   *
   * The ONE trigger for the `billing:budget{reason:'refreshed'}` frame the
   * room's target end gets: the card is watching a meter it can no longer read
   * from its own ledger, and the refusal path emits no budget frame at all
   * (`audio-start-quota.ts` answers `stt:error` and nothing else), so without
   * that frame the card's only remaining source is a recording that may never
   * start.
   */
  switched: boolean;
  /** card MP-6 — WHICH BRANCH of {@link resolvePayer} chose {@link userId}. It
   *  is stamped onto the socket and written to `usage_events.payer_reason`, so
   *  「why did these seconds land on this account」 is answerable months later
   *  from the ledger rather than re-derived from ids that no longer say. */
  reason: PayerReason;
  /** card MP-6 — the site demo's per-browser ceiling, or null. See
   *  {@link PayerDecision.capUserId}. */
  capUserId: string | null;
  /** card MP-1 — the integrator key whose sub-quota these seconds also spend, or
   *  null. See {@link PayerDecision.integratorKeyId}. */
  integratorKeyId: string | null;
  /** card MP-6 — WHO SPOKE: the account id when signed in, otherwise the
   *  browser/device uid. `usage_events.speaker_ref`. Null when this admission
   *  declared neither. */
  speakerRef: string | null;
  /** card MP-10 — was there a verified account at the microphone. See
   *  {@link PayerDecision.speakerSignedIn}: NOT derivable from `speakerRef`,
   *  which is a user id or a device uid and cannot be told apart by shape. */
  speakerSignedIn: boolean;
}

/**
 * The four far ends the payer matrix has a column for
 * (docs/strategy/2026-09-11-metering-principal-matrix-design.md §1).
 *
 * 🔴 IT IS NOT ONE STORED STRING, AND THE SPLIT IS DELIBERATE. Three of the four
 * are `pc_devices.room_kind` — a SERVER-MINTED column no client frame can reach
 * (its DDL says why that matters). The fourth, `'demo'`, is NOT stored and must
 * not become stored: 「is this a site-demo room」 already has exactly one author
 * in this server — `users.anonymous` on the row that OWNS the room — and it is
 * the author `budget-push.modeFor`, `pcOwnerQuotaGate` and `webTrialDecision`
 * all read. A second, stored answer could disagree with it, and the two would be
 * consulted by different layers, which is this repo's #1 bug shape bought for
 * nothing. (`http/web-room-routes.ts` `handleAnonymous` argues the same thing
 * from the other side: it mints demo rooms as `room_kind:'web'` ON PURPOSE.)
 *
 * ⚠️ AND IT WOULD HAVE BROKEN TWO THINGS THAT READ THE LITERAL. A partial UNIQUE
 * index (`connection.ts` `idx_pc_devices_web_room_owner ... WHERE
 * room_kind='web'`) and the trial ledger's own query (`trial-ledger.repo.ts`)
 * both mean to cover demo rooms. Storing `'demo'` would have taken demo rooms
 * out of a uniqueness constraint without a single test going red.
 */
export const ROOM_KINDS = ['app', 'web', 'demo', 'integrator'] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

/**
 * WHICH FAR END this room is — the first question the payer matrix asks, and the
 * one that outranks who is speaking (§1: 「对端种类先于说话者身份」).
 *
 * `null` means 「a `room_kind` this build does not understand」, i.e. a row
 * written by a NEWER build. Every caller must fail CLOSED on it: an unknown far
 * end may be a third-party host, and billing a guess there charges FlowMic (or
 * a desktop owner) for an integrator's visitors — the exact outcome owner's
 * §9-1 exists to prevent. It is unreachable on a same-version deployment
 * (`node/token-rows.ts` `parsePc` drops such a row before it can be served, and
 * nothing local writes one), which is why no new error code is spent on it in
 * this card; MP-1 owns that code and that owner gate.
 */
export function roomKindOf(input: {
  /** `pc_devices.room_kind` — NULL on every ordinary desktop row. */
  roomKind: string | null | undefined;
  /** `pc_devices.user_id` — the account that owns the room. */
  ownerUserId: string;
  /** `users.anonymous`. Absent ⇒ a demo room reads as `'web'`, which is the
   *  pre-card behaviour and changes no payer: every rule below treats the two
   *  alike, and the difference is only which owner id comes back. */
  reader?: AnonymousRowReader | undefined;
}): RoomKind | null {
  const kind = input.roomKind ?? null;
  if (!isKnownRoomKind(kind)) return null;
  if (kind === INTEGRATOR_ROOM_KIND) return 'integrator';
  if (kind === WEB_ROOM_KIND) return input.reader?.(input.ownerUserId) === true ? 'demo' : 'web';
  return 'app';
}

/**
 * WHY this account is the payer — carried out of {@link resolvePayer} so a log
 * line, a test, a budget frame and a `usage_events` row can all name the same
 * branch instead of re-deriving it from the ids.
 *
 * 🔴 THESE FOUR STRINGS ARE THE STORED VALUES of `usage_events.payer_reason`
 * (db/schema.ts `-- 14. usage_events`), and that is why card MP-6 replaced the
 * previous four-name union (`speaker_account` / `integrator_owner` /
 * `trial_identity` / `room_owner`) instead of mapping onto it. Two vocabularies
 * for one branch is how a column and the rule that fills it start disagreeing:
 * the mapping would have exactly one author today and two the first time
 * somebody added a branch to either side.
 *
 * ⚠️ `trial_identity` HAS NO SUCCESSOR HERE, and its absence is the card. An
 * anonymous trial grant is no longer a payer on any branch — owner 2026-09-11
 * §11 asks that every second of recognition name an account somebody can look
 * up. The grant survives as a CAP ({@link PayerDecision.capUserId}).
 */
export type PayerReason =
  /**
   * The account paying is the one SPEAKING.
   *
   * 🔴 CARD MP-10 NARROWED WHAT REACHES THIS WITHOUT CHANGING WHAT IT MEANS.
   * Under 「谁说扣谁」 it was every signed-in speaker anywhere; under
   * 「只要有对端，就扣对端」 it is the two shapes where the speaker IS
   * the far end's owner: a phone or page signed into the account that owns the
   * room (including the light-record cloud instance, which is a room a phone
   * owns by itself), and a signed-in visitor on FlowMic's site demo (W4-05,
   * which MP-10 leaves standing — see `resolvePayer` step 3).
   */
  | 'self'
  /**
   * The far end's OWNER pays for whoever is holding the microphone.
   *
   * 🔴 CARD MP-10 WIDENED THIS ONE, AND THAT IS THE CARD. It used to mean
   * 「nobody was signed in」; it now means 「the speaker is not the owner」,
   * signed in or not. `speaker_ref` on the ledger row is what still tells the
   * two apart months later — an account id or a browser/device uid — which is
   * why widening the reason costs no information. An App phone on a deployment
   * with no account layer lands here too, and for the same reason.
   */
  | 'peer'
  /** §10-1 step 2 — the far end is a third-party host page, so its OWNER pays
   *  for its unsigned visitors (owner §9-1). */
  | 'host'
  /** §10-1 step 3 — the far end is FlowMic's own site demo, so FlowMic's DEMO
   *  ACCOUNT pays and the spend is visible under one real users row. */
  | 'demo';

export interface PayerRoom {
  /** {@link roomKindOf}'s answer. `'integrator'` has no producer until MP-1. */
  kind: RoomKind;
  /**
   * `pc_devices.user_id` — the room owner.
   *
   * On an `'integrator'` room this IS the integrator T: MP-1 mints that row for
   * T's own account, so the design's `integrator_user_id` needs no second column
   * and cannot drift from the row it would have described.
   */
  pcUserId: string;
  /** The pairing row's own account, when it has one. */
  mobileUserId?: string | null;
  /**
   * card MP-1 — WHICH publishable key minted this room (`integrator_rooms`), on
   * an `'integrator'` room, else null.
   *
   * 🔴 IT IS NOT A SECOND PAYER AND IT IS NOT AN OWNER. T is `pcUserId` and
   * stays so; this names the SUB-QUOTA the same seconds must also stay under.
   * Two ids because they answer two questions — 「whose bill」 and 「against which
   * of that account's ceilings」 — and folding them would make revoking one key
   * indistinguishable from suspending the integrator.
   */
  integratorKeyId?: string | null;
}

export interface PayerSpeaker {
  /** The VERIFIED handshake account on this socket, or null (`getAccount`). */
  account: { userId: string } | null;
  /** The anonymous trial identity this unsigned web pairing spends (R-1). */
  trialUserId?: string | null;
  reader?: AnonymousRowReader | undefined;
}

export interface PayerDecision {
  userId: string;
  reason: PayerReason;
  /**
   * card MP-6 — a SECOND ceiling this admission must also stay under, or null.
   *
   * 🔴 IT IS NOT A SECOND PAYER AND NO SECOND BILL HANGS ON IT. Produced on the
   * `'demo'` branch only, where it is the visitor's own anonymous grant
   * (`trial_ledger`, 120 s per browser for life). Owner §11 wants the site
   * demo's spend to land on ONE account an operator can look up, and §10-4 wants
   * one visitor to be unable to drink the whole month: those are two questions,
   * so they are two ids. The seconds are metered to {@link userId}; this one is
   * a gate and a cap on the number a page is shown.
   *
   * Null on every other branch, and that is what makes 「`mode:'trial'` only in
   * the demo branch」 (design §10-1) a property of the data rather than of a
   * comment.
   *
   * 🔴 IT IS ENFORCED, IN THREE PLACES, AND THEY ARE ONE ARITHMETIC. Said out
   * loud because the plausible reading of 「cap」 is a number on a screen, and
   * that is what the first draft of this card shipped:
   *   · the frame a page counts down (`billing/budget-push.ts` `view()`);
   *   · the hard stop a recording is cut off at, and its refresher
   *     (`engine/stt-factory.ts` `quotaBudgetMs` / `setQuotaRefresher`);
   *   · the admission gate that refuses a press before it starts
   *     (`socket/handlers/audio.handler.ts`, gate `'trial_cap'`).
   * All three go through `billing/capped-remaining.ts`, because a countdown that
   * reaches zero while the session runs on is R11 with a plausible number in it.
   *
   * 🔴 AND THE NUMBER IT CAPS WITH MOVES, which took a second write to arrange.
   * The visitor's remaining is `trialLimitsFrom(120 s)` minus `usage_records`
   * FOR THE ANONYMOUS IDENTITY. Until this card those seconds were metered to
   * that identity, so the subtraction moved for free; owner §11 metered them to
   * the demo account instead, which would have left the counter with no writer
   * and the grant frozen at its full value — a fresh two minutes on every
   * reload. `billing/usage-tracker.ts` now debits this identity alongside the
   * payer, and that file carries the argument for why one recording still moves
   * only one BILL.
   *
   * ⚠️ SO THE CEILING IS PER BROWSER AND FOR LIFE, not per session: a visitor who
   * reloads continues on what is left. The site-wide ceiling (the demo account's
   * own monthly plan) is unchanged and still applies underneath it — §10-4 asks
   * for both, and both are real.
   */
  capUserId: string | null;
  /** card MP-1 — the publishable key whose sub-quota this admission also spends,
   *  or null. Produced by the `'host'` branch alone, which is what makes 「a key
   *  ceiling only exists on an integrator room」 a property of the data. */
  integratorKeyId: string | null;
  /** True only when this admission moved the meter OFF an identity the room's
   *  TARGET end was reading — see {@link MeteringPrincipal.switched}. */
  switched: boolean;
  /**
   * card MP-10 — WAS THERE A VERIFIED ACCOUNT AT THE MICROPHONE.
   *
   * 🔴 IT IS NOT DERIVABLE FROM ANYTHING ELSE ON THIS OBJECT, and that is why
   * it is a field. Since MP-10 a `'peer'` decision covers BOTH an unsigned guest
   * and another signed-in account, and both leave the payer equal to the room
   * owner; the only other trace is `speakerRef`, which is a user id in one case
   * and a browser/device uid in the other — two id spaces a reader would have to
   * tell apart BY SHAPE. Guessing about money from the shape of a string is
   * exactly what this repo's 「一个值只回答一个问题」 line forbids.
   *
   * Its one consumer is the sentence the room owner is told
   * (`billing/budget-push.ts` `payerHintFor`: `guest_speaker` when false,
   * `signed_in_speaker` when true).
   */
  speakerSignedIn: boolean;
}

/** What the deployment tells {@link resolvePayer} about itself. One field today;
 *  an object rather than a bare string so a second one does not re-order a
 *  positional argument list that three call sites already pass. */
export interface PayerConfig {
  /** `FLOWMIC_DEMO_PAYER_USER_ID`. Null / absent ⇒ site-demo rooms are refused. */
  demoPayerUserId?: string | null;
}

/**
 * WHOSE ALLOWANCE THIS ROOM'S RECORDINGS SPEND -- the single ordered rule, and
 * the one place it is written down.
 *
 * 🔴🔴 REWRITTEN THREE TIMES ON 2026-09-11. Card MP-0 read owner's §9
 * 「谁说扣谁」 as putting the SPEAKER first. Card MP-1 restored the third-party
 * host above the speaker on owner's 追认 that night. Card MP-10 is owner's own
 * last word (2026-09-11 凌晨, decisions/2026-09-10-owner-web-client-identity-qr
 * -demo-and-polish.md §11 再追认): 「「已登录用户默认也是扣对端」也包括自家 PC」
 * ⇒ **只要有对端，就扣对端；没有对端（手机轻记录）才扣自己。**
 *
 *   1. the far end is a third-party host    => the host's owner        'host'
 *   2. the far end is a FlowMic PC / target => the room's owner        'peer'
 *                                              ...unless the speaker IS that
 *                                              owner, and then         'self'
 *   3. the far end is FlowMic's site demo,
 *      and the speaker is signed in         => that account            'self'
 *   4. the far end is FlowMic's site demo   => the DEMO ACCOUNT        'demo'
 *                                              + the browser's grant as a CAP
 *                                              + no demo account configured => REFUSE
 *   5. anything else                        => REFUSE
 *
 * -- WHAT MP-10 MOVED, AND WHAT IT DID NOT ----------------------------------
 *
 * 🔴 THE SPEAKER'S OWN ACCOUNT NO LONGER OUTRANKS A FLOWMIC FAR END. Until this
 * card a `speaker.account` check sat above steps 2 and 4 and answered `'self'`
 * for every far end but the integrator's; a phone signed into B, paired to A's
 * computer, spent B's month. owner's 再追认 says A pays. So step 2 is now reached
 * by signed-in and unsigned speakers alike, and 「is the speaker signed in」
 * decides only TWO things here: whether the payer happens to be the speaker
 * (`'self'`) or somebody else (`'peer'`), and which sentence the owner's budget
 * frame carries ({@link PayerDecision.speakerSignedIn}).
 *
 * 🔴 THE LIGHT RECORD NEEDS NO BRANCH OF ITS OWN, AND THAT IS A MEASUREMENT
 * RATHER THAN A CONVENIENCE. 「A phone recording with no far end」 is the
 * cloud-instance admission (`mobile.handler.ts`'s `cloud_instance` payload ->
 * `registry.admitCloudInstance`), which mints a virtual `pc_devices` row OWNED
 * BY THE SPEAKER'S OWN ACCOUNT. So it arrives here as an `'app'` far end whose
 * owner IS the speaker, step 2 answers `'self'`, and owner's 「没有对端才扣自己」
 * falls out of the same expression rather than out of a second one that would
 * have to be kept in agreement with it. (That path stamps `'self'` directly
 * today and never calls this function; the point is that if it did, it would get
 * the same answer.) An UNSIGNED phone cannot reach it at all -- `resolveActingUser`
 * refuses the admission before any row is minted.
 *
 * ⚠️ THE SITE DEMO KEEPS ITS SPEAKER RULE (step 3), and that is a scope
 * statement rather than an oversight. owner's 再追认 names three far ends --
 * 自家 PC / 自家网页目标页, 第三方宿主页, 官网体验页 -- and moves exactly one of
 * them (the first). W4-05's shipped behaviour 「a site-demo visitor who signs in
 * is metered to their ACCOUNT from that moment on」 is a separate owner ruling
 * (2026-09-09 §13) with a golden of its own (G26's `refreshed` switch frame),
 * and no line of the 再追认 revisits it. If owner wants 「扣对端」 to swallow the
 * demo page too, step 3 is the one line to delete -- and G26's switch section,
 * W4-05 and {@link MeteringPrincipal.switched} all fall with it.
 *
 * -- WHY IT MAY ANSWER "NOBODY" ----------------------------------------------
 *
 * `null` is the point of steps 4 and 5. owner §11 asked for 「向额度的消耗有迹
 * 可寻」 -- every second of recognition charged to an account a human can name.
 * The two ways that could fail are a site demo on a deployment that never
 * configured its demo account, and a far end this build cannot classify at all;
 * both used to land on somebody's real allowance by fall-through. They refuse
 * instead. The refusal is the EXISTING one -- the admission handlers already
 * turn `meteringPrincipal() === null` into an ack -- so this card spends no
 * error code and moves neither the registry count nor the event whitelist.
 *
 * 🔴 NEVER `Infinity`, on any branch, including the refusing ones. Unlimited has
 * exactly one author in this server (`QuotaGuard.remainingSttMs` on a standalone
 * deployment) and nothing here can reach it.
 *
 * -- WHAT DID NOT CHANGE -----------------------------------------------------
 *
 * 🔴 `mobile_pairings.user_id` IS STILL NOT WRITTEN BY ANY OF THIS. The register
 * proposed stamping the account onto the row; it was rejected on a measurement
 * (the write would spend a MOBILE SLOT on the signed-in account, and would hang
 * a foreign-account row off a PC the 48-hour anonymous sweep then deletes). The
 * principal is derived per admission and nothing is stored.
 *
 * 🔴 QTA-2's SECOND LEDGER ({@link pcOwnerQuotaGate}) NO LONGER HAS ANYTHING TO
 * ASK ON A FLOWMIC FAR END, and that is a consequence of this rule rather than a
 * second decision: owner 2026-08-15 「两边有一方不满足都不能继续」 asked the room
 * owner's allowance as a SECOND gate because the SPEAKER's was the one being
 * spent. Under 「对端付」 the room owner's allowance IS the one being spent, so
 * asking it again would judge one recording against one ledger twice -- and the
 * speaker's own plan is not a constraint of this recording at all. Read
 * `pcOwnerQuotaGate` for the branch and for what that leaves unreachable.
 */
export function resolvePayer(
  room: PayerRoom,
  speaker: PayerSpeaker,
  config: PayerConfig = {},
): PayerDecision | null {
  const paired = pairedAccountId(room.pcUserId, room.mobileUserId);
  const speakerSignedIn = speaker.account !== null;
  // 1. THE FAR END IS A THIRD-PARTY HOST PAGE => ITS OWNER PAYS, AND THE
  //    SPEAKER IS NOT CONSULTED AT ALL.
  //
  // 🔴 WHY THE PRODUCT NEEDS IT THAT WAY, said plainly because 「谁说扣谁」 reads
  // like the fairer rule: an integration brings N strangers to one page, and the
  // page's owner is the only party who chose to put a microphone there. If
  // signing in moved the bill, the integrator's cost would depend on how many of
  // their visitors happened to have FlowMic accounts -- a number they cannot see,
  // cannot influence, and cannot budget for. Worse, it would give a visitor a
  // way to spend THEIR OWN minutes on somebody else's site without being asked.
  //
  // ⚠️ SO THE COPY MAY NOT OFFER A SIGN-IN (`INTEGRATOR_QUOTA_EXCEEDED` states
  // this at the registry): on this branch signing in changes nothing, and an
  // invitation to an action that changes nothing is a control with nothing
  // behind it.
  //
  //    On an `'integrator'` room `pc_devices.user_id` IS that owner, so there is
  //    no second column to drift from it.
  if (room.kind === 'integrator') {
    return {
      userId: room.pcUserId,
      reason: 'host',
      capUserId: null,
      // card MP-1 -- the key's own sub-quota rides out with the decision. Null
      // when the room has no key edge, which on a same-version deployment means
      // the row was minted before this card; `integrator-quota.ts` `remainingMs`
      // is where an UNREADABLE key becomes a refusal, and an absent one here is
      // simply 「no second ceiling」.
      integratorKeyId: room.integratorKeyId ?? null,
      switched: false,
      speakerSignedIn,
    };
  }
  // 2. A FlowMic desktop or web target page => ITS OWNER PAYS, whoever is
  //    holding the microphone (card MP-10, owner 2026-09-11 再追认).
  //
  // 🔴 THE SPEAKER'S ACCOUNT IS NOT CONSULTED FOR *WHO PAYS* HERE, ONLY FOR
  // *WHETHER THE PAYER HAPPENS TO BE THEM*. `paired` (`mobile.user_id ??
  // pc.user_id`) is the answer in both arms; the comparison below picks the
  // WORD, and the word is what `usage_events.payer_reason` stores and what the
  // owner's budget frame renders. A branch that returned `speaker.account.userId`
  // here would be MP-0's rule, which is the defect this card closes.
  //
  // 🔴 `'self'` HERE IS ALSO THE LIGHT RECORD. A cloud-instance room is owned by
  // the phone's own account, so 「no far end」 arrives as 「a far end that is me」
  // and needs no fifth branch. See this function's header for why that is worth
  // saying out loud.
  //
  // ⚠️ `pairedAccountId` RATHER THAN `room.pcUserId`, unchanged from before this
  // card: a pairing row that DOES carry an account keeps being honoured exactly
  // as it was. No production path mints one today.
  if (room.kind === 'app' || room.kind === 'web') {
    const isOwner = speaker.account !== null && speaker.account.userId === paired;
    return {
      userId: paired,
      reason: isOwner ? 'self' : 'peer',
      capUserId: null,
      integratorKeyId: null,
      switched: false,
      speakerSignedIn,
    };
  }
  // 3. THE SITE DEMO, WITH SOMEBODY SIGNED IN => THEIR OWN ACCOUNT (W4-05,
  //    owner 2026-09-09 §13: sign in on the demo page and the demo stops paying
  //    for you).
  //
  // ⚠️ THIS IS THE ONE PLACE A SPEAKER STILL OUTRANKS A FAR END, and the header
  // carries the argument for why MP-10 left it standing. It is deliberately
  // written AFTER step 2 rather than as a general speaker check above it: a
  // general check is what MP-10 removed, and reinstating one that merely happens
  // to be reachable from a single kind would invite the next reader to widen it
  // back.
  //
  // 🔴 `switched` STAYS NARROW: it means "the meter moved off an identity the
  // room's TARGET end was reading", and that is what arms the one admission-time
  // frame a target ever gets (`budget-frames.ts` `pushMeteringSwitchBudget`). The
  // demo room's owner IS that anonymous identity, which is why this branch is now
  // the ONLY producer of `true` -- and why golden G10's count of frames reaching
  // a real PC in a record-only session is untouched by construction rather than
  // by a gate somebody has to remember.
  if (room.kind === 'demo' && speaker.account !== null) {
    const switched = speaker.reader?.(paired) === true && speaker.account.userId !== paired;
    return {
      userId: speaker.account.userId,
      reason: 'self',
      capUserId: null,
      integratorKeyId: null,
      switched,
      speakerSignedIn,
    };
  }
  // 4. FlowMic's own site demo, with nobody signed in. The spend lands on ONE
  //    REAL ACCOUNT so an operator can answer "how much did the site demo burn
  //    this month" from that account's own `/api/me`, and the visitor's own
  //    120 s grant rides along as a CAP so one browser cannot drink the month.
  //
  //    🔴 UNCONFIGURED => REFUSE, and never a fall-back. The two fall-backs a
  //    reader might reach for are exactly the two owner §11 rules out: the trial
  //    identity (a cost nobody can look up -- the model §11 replaced) and the
  //    room's anonymous owner (the same thing wearing the room's hat). A demo
  //    room that cannot be billed does not open.
  if (room.kind === 'demo') {
    const demo = (config.demoPayerUserId ?? '').trim();
    if (demo === '') return null;
    return {
      userId: demo,
      reason: 'demo',
      capUserId: speaker.trialUserId ?? null,
      integratorKeyId: null,
      switched: false,
      speakerSignedIn,
    };
  }
  // 5. Unreachable while `RoomKind` has four members -- and written as a refusal
  //    rather than as an `assertNever` for the direction it fails in: the day a
  //    fifth kind is added, an admission nobody has decided the money for must
  //    stop, not land on the room owner because that was the last branch.
  return null;
}

/**
 * The account a pairing would be billed to WITHOUT any of the rules above —
 * `mobile.user_id ?? pc.user_id`, straight off the rows.
 *
 * Exported because card R-1's mint decision has to ask the same question one
 * step earlier (「is the account that would otherwise be billed a real one, or a
 * site-demo identity?」) and a second `??` written out at that call site is a
 * second author for one fact. One expression, two readers.
 */
export function pairedAccountId(pcUserId: string, mobileUserId?: string | null): string {
  return mobileUserId ?? pcUserId;
}

/**
 * The admission handlers' shape of {@link resolvePayer} — 「which account does
 * `setAuth` stamp on this socket」.
 *
 * `null` ⇒ the far end is a kind this build does not understand, and the caller
 * must refuse the admission (design §5: never fall back to FlowMic's grant and
 * never to the PC owner).
 */
export function meteringPrincipal(input: MeteringPrincipalInput): MeteringPrincipal | null {
  if (input.roomKind === null) return null;
  const decision = resolvePayer(
    {
      kind: input.roomKind, pcUserId: input.pcUserId, mobileUserId: input.mobileUserId,
      integratorKeyId: input.integratorKeyId ?? null,
    },
    {
      account: input.account,
      trialUserId: input.trialUserId ?? null,
      ...(input.reader ? { reader: input.reader } : {}),
    },
    { demoPayerUserId: input.demoPayerUserId ?? null },
  );
  // card MP-6 -- `resolvePayer` may now answer 「nobody」 (a site demo on a
  // deployment with no demo account). It arrives here as the SAME `null` an
  // unreadable room kind produces, on purpose: both mean 「this build cannot say
  // who pays」 and both must take the caller's one refusal path. Two nulls with
  // two meanings would invite a caller to handle one of them.
  if (decision === null) return null;
  return {
    userId: decision.userId,
    switched: decision.switched,
    reason: decision.reason,
    capUserId: decision.capUserId,
    integratorKeyId: decision.integratorKeyId,
    // WHO SPOKE. The account when there is one -- and that is the same id as
    // `userId` on the `'self'` branch, which is not redundancy: on every other
    // branch they are two different things, and a column that only sometimes
    // repeats another is still answering its own question.
    speakerRef: input.account?.userId ?? input.deviceUid ?? null,
    // card MP-10 -- and WHETHER THAT WAS AN ACCOUNT. Read off the decision
    // rather than recomputed from `speakerRef` above: the two ids live in
    // different spaces (a users id / a `wb-...` browser uid) and telling them
    // apart by shape is a guess about money.
    speakerSignedIn: decision.speakerSignedIn,
  };
}

/**
 * Card QTA-2's SECOND ledger — WHICH other account's quota must also admit this
 * session, or null for「only the acting account's」.
 *
 * 🔴🔴 CARD MP-10 TOOK ITS LAST LIVE FAR END AWAY, AND SAYING SO IS THE POINT OF
 * THIS PARAGRAPH. QTA-2 (owner 2026-08-15「两边有一方不满足都不能继续」) asked the
 * PC owner's allowance as a SECOND gate because the SPEAKER's allowance was the
 * one being spent — two parties, two ledgers, either may refuse. Under owner's
 * 2026-09-11 再追认 (「只要有对端，就扣对端」) the room owner IS the payer on every
 * FlowMic far end, so their allowance is already the FIRST gate
 * (`audio.handler.ts` `guard.ensureQuota(auth.userId, 'stt')`) and asking it
 * again would judge one recording against one ledger twice. The speaker's own
 * plan is not a constraint of this recording at all.
 *
 * ⇒ every kind now answers `null`:
 *   · `'app'` / `'web'`  — the owner is the payer (MP-10, the branch below);
 *   · `'integrator'`     — the host is the payer (MP-1);
 *   · `'demo'`           — the owner is an anonymous identity, whose allowance
 *                          stops applying the moment a visitor signs in (W4-05,
 *                          the `reader` line at the bottom).
 *
 * ⚠️ SO `judged_account:'pc_owner'` IS NOW UNREACHABLE IN PRODUCTION, and with
 * it the phone's 「PC 主人额度不足」 copy (`audio-start-quota.ts` gate
 * `'pc_owner'`; `apps/mobile/lib/src/settings/strings/recording_strings.dart`).
 * That is a real consequence of the ruling and it is LEFT STANDING here on
 * purpose: MP-10 may not touch a user-visible sentence, and deleting the wire
 * field would be a protocol subtraction — the expensive direction (老客户端发来
 * 的旧事件会被静默丢弃). It is registered for the follow-up card that owns the
 * copy. What this function must NOT become meanwhile is a gate that quietly
 * fires again: the `'app'`/`'web'` branch below is written out rather than left
 * to fall out of `owner === actingUserId`, so the day something starts writing
 * `mobile_pairings.user_id` the second ledger does not come back to life on a
 * shape nobody decided.
 *
 * ⚠️ THE ACTING ACCOUNT'S OWN CHECK IS UNTOUCHED by this and must stay that way:
 * it is the ledger the seconds are actually written to (`audio.handler.ts`
 * `commitSttUsage(auth.userId, …)`).
 */
export function pcOwnerQuotaGate(input: {
  pcUserId: string | null;
  actingUserId: string;
  /**
   * card MP-0 — the far end, as {@link roomKindOf} resolved it.
   *
   * 🔴 `'integrator'` IS NOT ASKED, and it is not an exception bolted on: on
   * that far end the room owner IS the payer (§2 step 1), so asking it a second
   * time would judge one recording against one ledger twice and could refuse a
   * visitor for a ceiling the very same seconds are already being written to.
   * `null` (a kind this build cannot read) never reaches here — the admission
   * was refused before any recording could start.
   *
   * 🔴 CARD MP-10 — `'app'` / `'web'` ARE NOT ASKED EITHER, FOR THE SAME
   * SENTENCE. owner's 2026-09-11 再追认 makes the room owner the PAYER on a
   * FlowMic far end, signed-in speaker or not, so their allowance is already the
   * FIRST gate and a second ask would judge one recording against one ledger
   * twice. This supersedes design §8 Q1 (甲: 「A's allowance stays a second gate
   * when B speaks to A's computer」), which was answered while B was the payer.
   *
   * ⚠️ WHICH LEAVES `'demo'` AS THE ONLY KIND THAT REACHES THE LINES BELOW, and
   * a demo room's owner is an anonymous identity — so the `reader` check answers
   * `null` too, in production, where that reader is always wired
   * (`bootstrap-connection-handlers.ts`). The gate is therefore unreachable, and
   * the function's header says what that costs and who owns it.
   */
  roomKind: RoomKind | null;
  reader?: AnonymousRowReader | undefined;
}): string | null {
  if (input.roomKind === 'integrator') return null;
  if (input.roomKind === 'app' || input.roomKind === 'web') return null;
  const owner = input.pcUserId;
  if (owner === null || owner === input.actingUserId) return null;
  return input.reader?.(owner) === true ? null : owner;
}

/**
 * WHOSE remaining minutes the room's TARGET end is shown.
 *
 * budget-push.ts's header states the rule this refines: a socket is told about
 * the account it is metered under. The target end of a demo room is an
 * anonymous identity whose ledger stops moving the instant the phone signs in —
 * so a card left reading it would show a frozen number beside a recording that
 * is spending someone else's minutes, which is R11 (a claim rendered by a layer
 * that does not hold the fact it is about) with a plausible number in it.
 *
 * Everywhere else this is unchanged: a desktop signed into another real account
 * still gets its OWN reading, because those minutes really are a different
 * ledger from the phone's.
 */
export function meteringPeerUserId(input: {
  pcOwnerUserId: string | null;
  actingUserId: string;
  reader?: AnonymousRowReader | undefined;
}): string | null {
  const owner = input.pcOwnerUserId ?? input.actingUserId;
  if (owner === input.actingUserId) return owner;
  return input.reader?.(owner) === true ? input.actingUserId : owner;
}
