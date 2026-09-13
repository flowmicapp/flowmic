// SPEC-REF:
//   docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §1.3 / §1.5
//   docs/strategy/2026-09-07-web-client-crosscheck-after-audio-durability.md §4.1
//     (`resets_at`, owner 2026-09-07 ruling (1))
//   docs/strategy/2026-09-05-web-client-subproject-design.md §3 (billing hangs
//     on the room owner) and §5 item 4 as corrected there
//   packages/protocol/src/protocol-schemas-billing.ts (the shape, and the long
//     argument for why this is not a second refusal)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// The ONE place `billing:budget` leaves this server, and the ONE place the
// `budget` field on a reconnect ack is built.
//
// -- WHOSE NUMBER IS IT? THE ACCOUNT THIS SOCKET IS METERED UNDER -----------
//
// This is the only judgement in the file and it is worth stating plainly,
// because the obvious alternative reading is wrong in a way nothing downstream
// could see (the number would still look like a plausible number of minutes).
//
// The design register says "billing and quota always hang on the room owner's
// user_id" (design §3). That sentence was written about the WEB shape, where
// the microphone end is a free-floating device holding nothing but a short
// pairing credential — and in that shape it is EXACTLY what
// `getAuth(socket).userId` already evaluates to, because `mobile.user_id ??
// pc.user_id` (mobile.handler.ts) falls through to the room owner whenever the
// microphone has no account of its own.
//
// It is NOT what the room owner means for the shape that ships today. A phone
// signed into its own cloud account is metered to THAT account
// (`audio.handler.ts` bills `auth.userId`; card QTA-2 checks the PC owner as a
// GATE and never bills it — "one recording must not decrement two ledgers for
// the same seconds"). Pushing the desktop owner's remaining minutes to such a
// phone would put a number on its meter that its own ledger will never move,
// which is the status-truth red line (R11) in its purest form: the layer
// rendering the claim would not hold the fact the claim is about.
//
// So the rule here is per-recipient and it is one line: A SOCKET IS TOLD ABOUT
// THE ACCOUNT IT IS METERED UNDER, which callers pass as
// `getAuth(socket).userId`. For a `pc` socket that IS the room owner
// (auth/middleware.ts stamps `pcRow.user_id`); for an App phone with its own
// account it is that account. Both readings are true of the socket that
// receives them, and no two ends are ever handed the same number about
// different ledgers.
//
// ⚠️ REWRITTEN 2026-09-10 (card R-1). The sentence that stood here said 「for a
// WEB microphone it is the room owner too, by the `??` above」. That was a
// correct reading of the code the day it was written and it is now false in the
// case that matters most: an unsigned browser paired to a real person's PC is
// metered under an ANONYMOUS TRIAL IDENTITY of its own
// (`auth/web-trial-identity.ts` mints it, `auth/metering-principal.ts` chooses
// it), so what such a socket is told is that identity's remaining seconds and
// `mode:'trial'` — never the desktop owner's month. The rule this file states
// is unchanged; what changed is which account the web arm is metered under.
// This is anti-façade ④ twice on one file: a comment asserting behaviour
// elsewhere is an assertion, and its truth moves when the other file does.
//
// -- MODE IS PER ROW, AND THE ONLY QUESTION IT ANSWERS IS THE SAME ONE ------
//
// Until card M4-01 this was one constant, `'plan'`, because nothing could
// produce anything else. `'trial'` now has a producer: an ANONYMOUS site-demo
// identity (users.anonymous, docs/strategy/2026-09-09-web-client-stage4-site-
// demo-design.md §2.1). ⚠️ 「`'integrator'` still has none — publishable keys are
// a later card」 stood here until card MP-1 (2026-09-11) shipped that card; it
// now has one, and it is `view()`'s `opts.integratorKeyId` rather than
// `serverBudgetModeFor`, for the reason that function's own note gives.
//
// 🔴 THE JUDGEMENT IS THE SAME ONE THE FILE ALREADY MAKES, NOT A SECOND ONE.
// This module's rule is 「a socket is told about the account it is metered
// under」; `mode` answers 「WHAT KIND of allowance is that account's」. So the
// input is the very row `userId` names — not the room kind, not the URL the
// page came from, not whether an Origin was on the request.
//
// ⚠️ REWRITTEN 2026-09-09 (card W4-05). The sentence that stood here said 「a
// demo identity paired with a signed-in phone is still metered to the demo
// identity (the `??` in mobile.handler.ts), and both ends are correctly told
// 'trial'」. It was true of every relay that had shipped when it was written and
// is false of this one: a phone that redials carrying a verified handshake
// account takes the meter off the demo row from that admission onward
// (`auth/metering-principal.ts` `meteringPrincipal`, the only producer of that
// switch), and BOTH ends are then correctly told 'plan' — the target end
// through `meteringPeerUserId`. The rule this file states is unchanged: a
// socket is still told about the account it is metered under; what changed is
// which account that is. (anti-façade ④ — a comment asserting behaviour
// elsewhere is an assertion, and its truth moves when the other file does.)
//
// ⚠️ IT IS READ PER PUSH, off the users row, rather than captured once when the
// socket connected: an identity cannot stop being anonymous, so the read is
// stable — but a captured value would have to be invalidated by something, and
// there is nothing here that could.

import type { Socket } from 'socket.io';
import type { BillingBudgetMode, BillingBudgetReason, BudgetView } from '@flowmic/protocol';
import { log } from '../log';
import { planLimits } from './plans';
import { cappedRemainingSttMs } from './capped-remaining';
import type { PayerReason } from '../auth/metering-principal';

/**
 * The mode for one metered row. THE WHOLE SET OF THIS RELAY'S PRODUCERS is this
 * function, so 「what does this relay actually emit」 stays answerable by reading
 * one place rather than by trusting a comment — the property the constant this
 * replaced was written for.
 *
 * ⚠️ 「`'integrator'` is deliberately unreachable: it belongs to publishable
 * keys, which have no identity on this server yet」 STOOD HERE until card MP-1
 * (2026-09-11) gave those keys an identity. The sentence is kept because it was
 * true when it was written, and this correction is what an assertion about
 * another file looks like when it expires (anti-façade ④).
 *
 * 🔴 IT IS STILL UNREACHABLE **FROM HERE**, AND THAT HALF DID NOT CHANGE. This
 * function answers 「what kind of allowance does this ROW hold」 and a `users`
 * row cannot be an integrator key. `'integrator'` is chosen one layer out, in
 * `view()`, off a fact about the SOCKET (`opts.integratorKeyId`) — because the
 * question 「is this session spending a key's sub-quota」 is not a question about
 * the payer's account at all, and answering it here would have needed a second
 * input this function has no business holding.
 */
export function serverBudgetModeFor(anonymous: boolean): BillingBudgetMode {
  return anonymous ? 'trial' : 'plan';
}

/**
 * The floor between two while-streaming `billing:budget` frames — addendum
 * §1.3's "every 10 s while streaming".
 *
 * Overridable per process by `FLOWMIC_BUDGET_HEARTBEAT_MS`, which exists so the
 * golden path can drive a real relay through several ticks and an exhaustion
 * inside a few seconds instead of a few minutes. NOT a product knob: the
 * default is the contract, and a deployment that changes it changes how often a
 * meter on somebody's screen moves.
 */
export const DEFAULT_BUDGET_HEARTBEAT_MS = 10_000;

/** The two account reads this module needs, named so a test can drive them
 *  without a database. Both are satisfied in production by objects that already
 *  exist: `QuotaGuard.remainingSttMs` and `BillingService.usagePeriod`. */
export interface BudgetReader {
  /** Remaining STT budget in ms. `Infinity` means "this deployment has no quota
   *  concept" (standalone / unmetered) — that is `remainingSttMs`'s own
   *  contract, not an invention here. */
  remainingSttMs(userId: string): number;
  /** UTC instant this account's metering cycle ends (`UsagePeriod.endMs`), or
   *  null when the account has no cycle to speak of. */
  periodEndMs(userId: string): number | null;
  /**
   * WHAT KIND of allowance this row holds — card M4-01.
   *
   * REQUIRED, no `?` and no local fallback, for the reason `budget` is required
   * on the web-room route: a default of `'plan'` would tell a site-demo page it
   * is metered against a subscription nobody bought, and 'plan' is exactly the
   * value a forgotten wiring would produce (book 13 §7 F1 ②).
   */
  modeFor(userId: string): BillingBudgetMode;
  /**
   * The FREE plan's monthly managed-STT ceiling, in whole minutes -- card
   * NR-31. Not about `userId` at all, which is why it takes no argument: it is
   * what an account WOULD get, for a socket that has none.
   *
   * REQUIRED, for the reason `modeFor` is: a `?` here would let a forgotten
   * wiring produce a view with the field silently missing, and the client's
   * only honest reading of missing is 「say nothing」 -- so the sentence would
   * disappear from the sign-in prompt with every gate in this repo green. The
   * WIRE field stays optional (old relays really do not send it); the internal
   * read does not, so the compiler names anybody who forgets.
   */
  freePlanMinutes(): number;
  /**
   * card MP-1 — how much of the integrator's month THIS PUBLISHABLE KEY may
   * still spend, in ms (`billing/integrator-quota.ts` `remainingMs`).
   *
   * REQUIRED, for the reason `modeFor` and `freePlanMinutes` are: an optional
   * method is how a forgotten wiring would show a visitor a countdown against
   * the integrator's WHOLE plan while a smaller per-key ceiling did the cutting
   * off — a meter and a wall in two places, which is the defect
   * `capped-remaining.ts` was extracted to prevent.
   *
   * 🔴 A KEY IT CANNOT READ ANSWERS 0, never Infinity — the refusal direction
   * design §5 asks for. That decision belongs to `integrator-quota.ts`, which is
   * why this is a pass-through and not a `try`/`catch` with a default here.
   */
  integratorKeyRemainingMs(keyId: string): number;
}

/**
 * The production `BudgetReader`, assembled from the two objects that already
 * own its two numbers.
 *
 * A FACTORY HERE RATHER THAN AN OBJECT LITERAL AT THE WIRING ROOT, and the
 * reason is the argument two paragraphs up: 「a socket is told about the account
 * it is metered under」 only holds if the remaining-ms read is the SAME guard
 * `audio:start` is gated on and the cycle read is the SAME one the meter writes
 * into. Keeping the three reads beside that paragraph is what lets a reader
 * check the claim; spread across bootstrap they were three lines nobody read
 * together. (Extracted 2026-09-09, card M4-01 — bootstrap.ts stands at the
 * 800-line cap, so the wiring root can no longer hold a growing literal.)
 */
/**
 * `FLOWMIC_BUDGET_HEARTBEAT_MS`, or the contract default.
 *
 * Beside the constant it falls back to, so 「what happens to a malformed value」
 * is answerable in one place: it falls back rather than becoming NaN, and a NaN
 * floor would make EVERY audio chunk push a frame. (Extracted from bootstrap.ts
 * 2026-09-09, card M4-01, for the 800-line cap; behaviour unchanged.)
 */
export function resolveBudgetHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const ms = Number(env.FLOWMIC_BUDGET_HEARTBEAT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_BUDGET_HEARTBEAT_MS;
}

export function budgetReaderFrom(deps: {
  quota: { remainingSttMs(userId: string): number };
  billing: { usagePeriod(userId: string): { endMs: number | null } };
  users: { findById(id: string): { anonymous: boolean } | null };
  /** card MP-1 — `billing/integrator-quota.ts`. Absent on a deployment with no
   *  integrator arm, which makes every key unreadable and therefore refusing. */
  integratorKeys?: { remainingMs(keyId: string, at: number): number };
}): BudgetReader {
  return {
    remainingSttMs: (userId) => deps.quota.remainingSttMs(userId),
    periodEndMs: (userId) => deps.billing.usagePeriod(userId).endMs,
    // Straight off the row, through `serverBudgetModeFor` so the mapping has one
    // author. A row this process cannot find is NOT anonymous: the fail-safe
    // direction is the one that never labels a real account's meter 'trial'.
    modeFor: (userId) => serverBudgetModeFor(deps.users.findById(userId)?.anonymous === true),
    // 🔴 THROUGH `planLimits`, WHICH IS THE EFFECTIVE TABLE, never through the
    // `PLAN_LIMITS` literal beside it. `loadConfig()` installs the resolved
    // table (defaults + `FLOWMIC_PLAN_LIMITS`), so a deployment that raises its
    // free tier moves this number too. Reading the literal would ship a page a
    // figure this very process does not enforce -- 「configured but had no
    // effect」 wearing a helpful face, which is what plans.ts's own header calls
    // this repo's #1 bug shape.
    //
    // READ PER PUSH rather than captured once: the table is installed before any
    // socket exists, so a capture would be correct today, but nothing here could
    // invalidate one if that order ever changed.
    freePlanMinutes: () => planLimits('free').stt_minutes,
    // card MP-1 — straight through to the guard that owns the arithmetic and the
    // failure direction. Absent wiring answers 0 rather than Infinity for the
    // reason stated at the interface: an unreadable ceiling must refuse, not
    // vanish. `Infinity` here would let a deployment with no integrator arm
    // serve an integrator room with no ceiling at all.
    integratorKeyRemainingMs: (keyId) => deps.integratorKeys?.remainingMs(keyId, Date.now()) ?? 0,
  };
}

/**
 * card MP-6 — everything a frame needs to say about WHO PAYS, gathered into one
 * object because the four facts are only ever true together.
 *
 * 🔴 IT REPLACED A BARE `payerUserId`, and the replacement is the card's second
 * defect fix. Comparing ids was enough while a far-end payer was always a
 * DIFFERENT account from the socket being told. It stopped being enough the
 * moment an unsigned guest became metered under the room owner's account: the
 * guest's socket and the owner's socket are now told the SAME id, so 「is the
 * number in this frame the one being spent」 has two different answers for two
 * frames that are byte-identical on that field. The role and the reason are what
 * separate them.
 */
export interface PayerHint {
  /** The account whose ledger this recording actually moves. */
  userId: string;
  // ⚠️ THE CAP IS NOT IN HERE, and it was until the join frame needed it. A cap
  // is true of a SOCKET from the moment it is admitted; a payer is true of a
  // RECORDING. Bundling them made `pushJoinBudget` unable to carry one without
  // asserting the other, and a join frame that claimed a payer would be a claim
  // about a recording nobody has started. See {@link BudgetPusher.push}'s
  // `opts.capUserId`.
  /** WHICH BRANCH of `resolvePayer` chose it. */
  reason: PayerReason;
  /**
   * Is the socket being told the one HOLDING THE MICROPHONE, or the room's
   * TARGET end?
   *
   * 🔴 REQUIRED, and not defaulted. A default would be silently wrong on
   * whichever of the two call sites forgot it, and 「wrong」 here means a desktop
   * owner is never told a guest is spending their minutes — a missing sentence
   * with every gate green, which is this repo's number-one historical failure.
   */
  toldRole: 'speaker' | 'target';
  /**
   * card MP-10 — was the microphone held by a VERIFIED ACCOUNT.
   *
   * Read only on the `'peer'` branch, and only for the frame going to the room
   * OWNER, where it picks which of two sibling flags that frame carries. Absent
   * ⇒ neither flag: an admission that did not record it must not have one
   * guessed for it, because 「a guest is speaking」 and 「another account is
   * speaking」 point at different remedies.
   */
  speakerSignedIn?: boolean;
}

/**
 * The two things a caller may know about WHOSE allowance a frame is about, and
 * they are deliberately separate fields.
 *
 * 🔴 `capUserId` IS TRUE OF THE SOCKET; `payer` IS TRUE OF A RECORDING. Every
 * frame this socket ever gets is capped (the visitor's grant does not appear
 * and disappear between frames), while only the frames pushed around an actual
 * utterance can say who is being charged for it. A join frame carries the first
 * and not the second — see `budget-frames.ts` `pushJoinBudget`.
 */
export interface BudgetViewOpts {
  /** card MP-6 — the site demo's per-browser ceiling for this socket, or null.
   *  Present ⇒ this frame's `remaining_ms` is the LOWER of the two ledgers and
   *  its `mode` is `'trial'`. `resolvePayer`'s `'demo'` branch is its only
   *  producer. */
  capUserId?: string | null;
  /**
   * card MP-1 — the publishable key this socket's room was minted with, or null.
   *
   * 🔴 TRUE OF THE SOCKET, like `capUserId` and unlike `payer`: a room does not
   * change key between frames, so the join frame carries it too and a page in an
   * integrator room is never once told `mode:'plan'`.
   */
  integratorKeyId?: string | null;
  /** card MP-0 — who is being charged for the recording in flight, when the
   *  caller holds that fact. Absent ⇒ the frame says nothing about a payer. */
  payer?: PayerHint;
}

export interface BudgetPusher {
  /**
   * The reading for `userId`.
   *
   * `liveRemainingMs` overrides the account read while a recording is in
   * flight. It exists because the account read deliberately EXCLUDES the
   * running session (usage is written at settle), so during a recording it is
   * the answer to "what did other sessions leave me", not to "how much longer
   * may I talk" — and the second question is the one a meter on screen is
   * asking. Its one production source is `AudioSession.quotaDeadlineAt` via the
   * orchestrator seam: the same deadline the hard-limit timer is armed on, so
   * the meter and the wall are one fact.
   *
   * ⚠️ ABSENT means "no better number than the ledger", and the caller must
   * NEVER pass `null` to mean "there is no ceiling". "No quota concept" has
   * exactly one author — `remainingSttMs` answering `Infinity` — and a second
   * way to say it would let a merely-unmeasured session claim an unmetered
   * deployment. `budget-frames.ts`'s `tick` documents the same rule from the
   * caller's side.
   */
  view(userId: string, liveRemainingMs?: number, opts?: BudgetViewOpts): BudgetView;
  /**
   * Emit one `billing:budget` frame to this socket.
   *
   * `opts.payer` / `opts.capUserId` — see {@link BudgetViewOpts}. An absent
   * payer means 「this frame does not say」, which is what the optional wire
   * fields mean and what every relay before these cards sent.
   */
  push(
    socket: Pick<Socket, 'emit'>,
    userId: string,
    reason: BillingBudgetReason,
    opts?: { liveRemainingMs?: number; exhausted?: boolean } & BudgetViewOpts,
  ): void;
}

/**
 * `{ free_plan_minutes }` or `{}` -- card NR-31's one decision, extracted so the
 * two conditions that suppress it (not a trial / not a usable number) sit
 * together instead of inside a spread nobody can read.
 *
 * It swallows a throwing reader deliberately: this is the ONE field on the view
 * that is not about the recipient, and letting a plan-table read take down a
 * meter frame would trade a missing sentence for a missing number. `push` logs
 * and withholds the whole frame when the ACCOUNT reads throw, which is the
 * right severity for those; this one is not that.
 */
function freePlanMinutesField(
  mode: BillingBudgetMode,
  read: Pick<BudgetReader, 'freePlanMinutes'>,
): { free_plan_minutes?: number } {
  if (mode !== 'trial') return {};
  let minutes: number;
  try {
    minutes = read.freePlanMinutes();
  } catch {
    return {};
  }
  return Number.isInteger(minutes) && minutes > 0 ? { free_plan_minutes: minutes } : {};
}

/**
 * WHO PAYS, from the point of view of the socket being told — card MP-0
 * (design §4, D5).
 *
 * 🔴 IT IS DERIVED FROM `mode`, NOT FROM A SECOND READ OF THE USERS ROW, and
 * that is the whole reason it is a function beside `view` rather than three
 * lines inside it. 「Is the payer a trial grant」 and 「is the account this frame
 * is about a trial grant」 are the same question whenever the payer IS the
 * recipient's account, and asking `users.anonymous` a second time here would
 * give that one question two authors that a stale read could split.
 *
 * `undefined` ⇒ the caller does not hold a payer for this frame (a room-join
 * reading, an older call site), and the field is omitted. Absence never means
 * `'self'`: a client that was not told renders nothing extra.
 */
export function payerHintFor(
  toldUserId: string,
  mode: BillingBudgetMode,
  payer?: PayerHint,
): { payer?: 'self' | 'far_end' | 'trial'; guest_speaker?: true; signed_in_speaker?: true } {
  if (payer === undefined) return {};
  // The room's OTHER end is paying ⇒ the number in this frame is not the one
  // being spent, and saying so is the whole point of the field (design D5: a
  // desktop whose meter does not move while a recording runs in front of it).
  if (payer.userId !== toldUserId) return { payer: 'far_end' };
  // card MP-6 — THE TWO FRAMES THAT NAME THE SAME ACCOUNT AND MEAN OPPOSITE
  // THINGS. On the `'peer'` branch the speaker is metered under the room owner,
  // so BOTH sockets are told that one id:
  //   · to the OWNER  — 'self' (these minutes really are yours, and they really
  //     are moving) PLUS one of the two sibling flags, which are the only thing
  //     on the wire that says the recording is not theirs. The desktop cannot
  //     derive it; see the fields' own contracts in the protocol package.
  //   · to the SPEAKER — 'far_end'. The account in that frame is the far end's,
  //     which is exactly what the word means from where the speaker is standing,
  //     and it is what stops a page rendering somebody else's month as 「your」
  //     remaining time.
  //
  // 🔴 CARD MP-10 — WHICH FLAG, AND WHY IT IS TWO RATHER THAN ONE WIDENED. This
  // branch used to be reachable only when NOBODY was signed in, so `'peer'` and
  // 「a guest is speaking」 were the same sentence. Since MP-10 the far end pays
  // for a signed-in visitor too, and the two situations want different remedies:
  // an unsigned guest is a browser somebody scanned a code with (unpair it); a
  // signed-in account is a person the owner can name. Reusing `guest_speaker`
  // for both would give one word two meanings — this repo's #1 bug shape — and
  // would put a false sentence on the owner's screen the first time a colleague
  // signs in.
  //
  // ⚠️ AN UNRECORDED `speakerSignedIn` CARRIES NEITHER FLAG. Absence is 「this
  // relay did not say」 on both fields, and a default of `guest_speaker` here
  // would be a claim about who is in the room, made by a layer that does not
  // hold the fact.
  if (payer.reason === 'peer') {
    if (payer.toldRole !== 'target') return { payer: 'far_end' };
    if (payer.speakerSignedIn === true) return { payer: 'self', signed_in_speaker: true };
    if (payer.speakerSignedIn === false) return { payer: 'self', guest_speaker: true };
    return { payer: 'self' };
  }
  // card MP-1 — THE SECOND BRANCH WHERE ONE ACCOUNT IS TOLD TO TWO ENDS, and it
  // is here for exactly the reason the `'peer'` arm above is. On an integrator
  // room the payer is T and BOTH sockets are told T's id, so the id comparison
  // at the top of this function cannot separate them:
  //   · to the HOST PAGE (T's own room) — 'self'. These minutes are T's and they
  //     really are moving.
  //   · to the SPEAKER — 'far_end', whether or not that speaker is signed in.
  //     Owner §11 追认 item 1 puts the host ahead of the speaker's own account,
  //     so 'self' here would tell a signed-in visitor that their month is being
  //     spent when it is untouched — a plausible number about the wrong ledger,
  //     which is R11 in its purest form.
  //
  // ⚠️ NO `guest_speaker`, deliberately, and it is not an oversight: that flag
  // exists so a DESKTOP OWNER learns a stranger is on their machine. An
  // integrator page is a machine full of strangers by construction — that is
  // what the key bought — so a per-recording 「a guest is speaking」 would be the
  // alarm that fires every time, the one nobody reads.
  if (payer.reason === 'host') {
    return payer.toldRole === 'target' ? { payer: 'self' } : { payer: 'far_end' };
  }
  return { payer: mode === 'trial' ? 'trial' : 'self' };
}

export function makeBudgetPusher(read: BudgetReader): BudgetPusher {
  function view(userId: string, liveRemainingMs?: number, opts?: BudgetViewOpts): BudgetView {
    const capUserId = opts?.capUserId ?? null;
    const integratorKeyId = opts?.integratorKeyId ?? null;
    const payer = opts?.payer;
    // 🔴 Card MP-6 — THE SITE DEMO IS TWO CEILINGS AND THE SMALLER ONE WINS: the
    // demo ACCOUNT's month (owner §11 — one real users row an operator can look
    // up) and THIS BROWSER's lifetime grant (§10-4 — one visitor must not drink
    // the month). Through `cappedRemainingSttMs` because the recording's hard
    // stop asks the same question (`stt-factory`) and the two must not disagree:
    // a clock that reaches zero while the session runs on is R11 with a
    // plausible number in it.
    // card MP-1 — AND AN INTEGRATOR ROOM IS TWO CEILINGS TOO: the integrator T's
    // own month and the per-key sub-quota they set on this page. Same function,
    // same reason — the recording's hard stop (`stt-factory`) and the admission
    // gate (`audio.handler`) ask it as well, and a countdown that disagrees with
    // the wall is a number with nothing behind it.
    const account = cappedRemainingSttMs(
      read, userId, capUserId,
      integratorKeyId === null ? undefined : read.integratorKeyRemainingMs(integratorKeyId),
    );
    // 🔴 `Infinity` is "no quota concept", and it must survive as `null` all the
    // way to the client rather than being clamped to some large number. A client
    // renders NO meter for null (quota_gauge.dart's rule: an end we could not
    // read is an end we do not draw); a big number would render a meter that is
    // simply false about a standalone install.
    const unmetered = !Number.isFinite(account);
    const remaining_ms = unmetered
      ? null
      : Math.max(0, Math.round(liveRemainingMs ?? account));
    // 🔴 A CAP MAKES IT A TRIAL VIEW, whatever the payer's own row says. Since
    // MP-6 the site demo's payer is a REAL account, so `modeFor` would answer
    // 'plan' and the page would show a subscription's face over a two-minute
    // allowance — R11 with a plausible number in it. `capUserId` is produced by
    // exactly one branch of `resolvePayer` (`'demo'`), which is what makes
    // 「`mode:'trial'` only in the demo branch」 (design §10-1) a property of the
    // data rather than of a comment.
    // card MP-1 — AN INTEGRATOR KEY DECIDES THE MODE BEFORE THE CAP DOES, and
    // the order costs nothing today because `resolvePayer` never produces both
    // (a `'host'` decision carries no `capUserId`). It is written as an ordered
    // choice rather than as an assertion for the direction it fails in: if the
    // two ever did meet, 'integrator' is the mode whose copy does not offer the
    // reader a sign-in that would change nothing.
    const mode: BillingBudgetMode = integratorKeyId ? 'integrator' : capUserId ? 'trial' : read.modeFor(userId);
    return {
      remaining_ms,
      mode,
      // Tied to the same condition on purpose: "there is no quota" and "there is
      // a date it comes back" cannot both be true, and sending a reset date next
      // to a null budget would invite a client to render a countdown to nothing.
      //
      // 🔴 A TRIAL IS THE SECOND CASE OF THAT SAME RULE (card M4-01, design
      // §2.3 「试用一律 null」). An anonymous identity DOES have a metering cycle
      // on paper — it is a users row and `usagePeriod` will happily answer a
      // date a month out — but that date is about nothing: the identity is swept
      // within 48 hours and its allowance never renews. Sending it would put a
      // countdown on the demo card to a moment at which nothing happens, which
      // is the status-truth red line (R11) with a real number in it. Caught by
      // G26, which asserted `resets_at === null` before this line existed.
      // 🔴 AND AN INTEGRATOR FRAME IS THE THIRD CASE (card MP-1, design §4:
      // 「只带 remaining_ms 与 mode，不带 resets_at、不带档位名」). Here the reason
      // is not that the date is meaningless — T's cycle is perfectly real — it
      // is that the date is NOT THE READER'S. The speaker is a visitor on
      // somebody else's page; when T's month rolls over is T's commercial fact,
      // and putting it on a stranger's screen would both disclose it and invite
      // them to wait for a reset they have no standing in.
      resets_at: unmetered || mode === 'trial' || mode === 'integrator' ? null : read.periodEndMs(userId),
      // Card NR-31 -- the number behind 「sign in for a free plan with N minutes
      // every month」, which the page could otherwise only hardcode.
      //
      // 🔴 TRIAL ONLY, and that is the same judgement this file already makes
      // rather than a second one: a socket is told about the account it is
      // metered under, and a `'plan'` row IS an account -- it is told its own
      // ceiling through `remaining_ms` / `resets_at` and has no use for the free
      // tier's. Sending it there would put a second, smaller number of minutes
      // beside the one that governs.
      //
      // ⚠️ OMITTED, never zero and never a fallback constant, when the effective
      // free tier is not a positive whole number of minutes. A deployment MAY
      // configure `free.stt_minutes: 0` (config.ts accepts any non-negative
      // integer), and 「sign in for a free plan with 0 minutes every month」 is
      // an invitation to nothing. Absence has exactly one meaning on this field
      // and the client already honours it: leave the sentence out.
      ...freePlanMinutesField(mode, read),
      // Card MP-0 / MP-6 — whose allowance this room's recordings actually spend,
      // and (on the owner's frame only) that a guest is the one spending it.
      ...payerHintFor(userId, mode, payer),
    };
  }

  return {
    view,
    push(socket, userId, reason, opts): void {
      let payload;
      try {
        payload = {
          ...view(userId, opts?.liveRemainingMs, opts),
          reason,
          ...(opts?.exhausted ? { exhausted: true } : {}),
        };
      } catch (err) {
        // 🔴 A PROGRESS READING MUST NEVER TAKE DOWN THE PATH IT RIDES ON.
        // `remainingSttMs` reaches `effectiveLimits`, which reaches the database
        // and can throw (a deleted account, SQLITE_BUSY). Two of the four push
        // points sit inside `audio:start` and `audio:chunk`; letting a meter
        // read abort either of those would trade a missing number for a lost
        // recording. Logged rather than swallowed — the absence of the frame is
        // then explainable, which is the difference between degraded and silent.
        log.warn('billing:budget withheld — could not read the account budget', {
          user_id: userId,
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      // Card M4-01, §3.2 log line 3 of 5. HERE and not in the demo route,
      // because this is the only layer that holds both facts at the moment they
      // become true: WHICH identity, and that its allowance just hit zero. An
      // operator asking 「is the demo being farmed」 needs one line per spent
      // identity; the route can only report the ones it handed out.
      //
      // ⚠️ NO `ms_used` FIELD, and the design register (§3.2) sketches one. This
      // layer does not hold the grant — it holds what is LEFT, which is zero by
      // definition on this line — so any number here would be inferred rather
      // than read. The amount granted is on the `web anon minted` line for the
      // same `anon_id`, and the two join on it.
      if (opts?.exhausted === true && payload.mode === 'trial') {
        log.info('trial exhausted', { anon_id: userId, reason });
      }
      // Card MP-0 — THE SERVER-SIDE READER OF `payer`, and it is here rather
      // than at the push point because this is the only layer that holds both
      // ids at the moment the frame is built.
      //
      // 🔴 ON `started` ONLY. The heartbeat carries the same hint every ten
      // seconds for the whole of a recording, and a line per tick would be the
      // alarm that fires every time — the one nobody reads (0.3.26's
      // `dropped_unrendered`, 36/36). One line per recording is what answers the
      // question an operator actually asks: 「this desktop's minutes did not move
      // while somebody was speaking into it — who paid?」
      if (payload.payer === 'far_end' && reason === 'started') {
        log.info('billing.payer — this recording is charged to the room\'s other end', {
          told_user_id: userId, payer_user_id: opts?.payer?.userId, payer_reason: opts?.payer?.reason,
        });
      }
      socket.emit('billing:budget', payload);
    },
  };
}
