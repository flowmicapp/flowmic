// SPEC-REF:
//   docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §1.3 (the
//     four push points) and §1.5 (the `budget` field on a reconnect ack)
//   apps/server-core/src/billing/budget-push.ts (WHOSE number this is, and why
//     that question has a non-obvious answer — read that header first)
//   packages/protocol/src/protocol-schemas-billing.ts (the shape, and why this
//     event is not a second refusal)
//
// Card S2-02 — the per-socket `billing:budget` push points, lifted out of the
// three handlers that use them.
//
// WHY A MODULE AND NOT THREE COPIES: the four push points are one behaviour
// spread over three files (`pc:register` / `mobile:pair` build the room,
// `audio:start` and `audio:chunk` run the recording), and the interesting parts
// — which account, which clock, which number — are identical at all four. Three
// copies of that would be three places for the answer to "whose ledger is this"
// to drift, which is the shape budget-push.ts's header exists to prevent. The
// handlers keep only the call.
//
// ⚠️ It also keeps three files under the 800-line cap (verify/lint/file-size),
// and that is a real reason but not the argument above — the split would be
// right at 400 lines too.

import type { Socket } from 'socket.io';
import type { BudgetAckFields, BillingBudgetReason } from '@flowmic/protocol';
import type { SttOrchestrator } from '../../engine/orchestrator';
import { DEFAULT_BUDGET_HEARTBEAT_MS, type BudgetPusher, type BudgetViewOpts } from '../../billing/budget-push';
import { getAuth } from '../wire';

/**
 * The one dependency the two room-building handlers (`pc.handler` /
 * `mobile.handler`) grow for this card, declared once and mixed in rather than
 * copied into both `*HandlerDeps` interfaces — two copies of a doc comment is
 * two places for it to rot.
 *
 * Absent ⇒ that handler pushes no budget frame and omits the `budget` field
 * from its reconnect ack, i.e. exactly the pre-card behaviour. Never defaulted
 * to a no-op pusher: an absent dependency is a wiring fact a test can drive,
 * and anti-façade ② forbids the friendly empty implementation.
 */
export interface BudgetHandlerDeps {
  budget?: BudgetPusher;
}

/**
 * Push point 1 of 4 — "room join / build" (addendum §1.3), for `pc:register`
 * and `mobile:pair`.
 *
 * 🔴 THE JOINING SOCKET ONLY, and this is the one push point that does NOT
 * also address the room's other end. It briefly did, so that a target page
 * sitting open would get a fresh reading the moment a microphone paired in —
 * and golden G10 went red: `a delivery:'none' utterance put 1 frame(s) on the
 * PC socket: billing:budget`. G10 guards owner's 「仅记录】条目无条件不同步 PC」
 * line by counting EVERY frame that reaches the PC across a record-only
 * session, and the honest response to a red privacy gate is to withdraw the
 * frame, not to teach the gate about it.
 * The target is not left in the dark: it gets its own reading on `pc:register`
 * / `pc:reconnect`, and one at every `audio:start` bound for it — which is the
 * moment its minutes bar actually needs to move.
 *
 * 🔴 CALL IT AFTER THE ACK, never before. The ack is what tells the client which
 * room it is in; a budget frame that overtook it would arrive about a session
 * the client does not yet believe it has.
 *
 * `getAuth(socket).userId` is read at call time rather than passed in, so this
 * cannot drift from the identity `setAuth` has just stamped on the socket — the
 * account named here is exactly the one the next `audio:start` will bill.
 *
 * A socket with no pusher wired, or no identity yet, emits nothing. That is the
 * pre-card behaviour, and an absent frame is a wiring fact a test can drive —
 * never a friendly no-op pretending to have sent something.
 */
export function pushJoinBudget(socket: Socket, budget?: BudgetPusher): void {
  const userId = getAuth(socket)?.userId;
  // 🔴 CARD MP-6 — THE CAP TRAVELS, THE PAYER DOES NOT, and the asymmetry is the
  // whole reason `BudgetViewOpts` has two fields. A site-demo visitor's FIRST
  // frame is this one, and without the cap it would quote the demo ACCOUNT's
  // monthly remaining at `mode:'plan'` — a subscription's face and a
  // subscription's number handed to somebody who has two minutes. The payer
  // stays absent because no recording exists yet: a join frame that claimed one
  // would be a claim about an utterance nobody has started, and `payerHintFor`'s
  // own contract is that absence means 「this relay did not say」.
  const capUserId = getAuth(socket)?.capUserId ?? null;
  // card MP-1 — and the KEY travels for the same reason the cap does: without it
  // a visitor's FIRST frame on an integrator page would read `mode:'plan'` with
  // the integrator's whole month in it — the wrong face and a number that is not
  // theirs, on the one frame a page renders before anybody speaks.
  const integratorKeyId = getAuth(socket)?.integratorKeyId ?? null;
  if (budget && userId) budget.push(socket, userId, 'granted', { capUserId, integratorKeyId });
}

/**
 * Card W4-05 — the ONE frame the room's TARGET end gets outside the three
 * `audio:*` push points, and the only push point that addresses the target at
 * admission time.
 *
 * 🔴 IT FIRES ONLY WHEN THE METER CHANGED HANDS (`meteringPrincipalSwitched`),
 * never on an ordinary pair or reconnect, and that condition is the whole reason
 * this does not re-open the hole `pushJoinBudget`'s header describes: golden G10
 * counts EVERY frame reaching a PC across a record-only session, and a frame on
 * every admission is exactly what was withdrawn there. A switch requires an
 * ANONYMOUS room owner plus a verified handshake account on the microphone —
 * two conditions no paired-desktop session can meet — so the record-only red
 * line is untouched by construction rather than by a gate somebody has to
 * remember.
 *
 * 🔴 AND IT IS NOT OPTIONAL POLISH. The card is watching a number it can no
 * longer read from its own ledger, and the next thing that would have told it —
 * an `audio:start` — may be refused instead (`audio-start-quota.ts` answers
 * `stt:error` and emits no budget frame). Without this frame a signed-in
 * visitor whose account is already spent sees a demo meter with minutes still
 * on it, forever.
 *
 * `null` peer ⇒ nothing to tell, silently: same shape as every other
 * PC-directed frame here.
 */
export function pushMeteringSwitchBudget(peer: BudgetTarget | null, budget?: BudgetPusher): void {
  pushPeerBudget(peer, budget, 'refreshed');
}

/** `store.getPc(room)` answers `Socket | null`; a {@link BudgetTarget} pairs
 *  that socket with the account it is metered under. Here rather than inline at
 *  the call site so "no PC in the room" keeps meaning exactly what it means for
 *  every other PC-directed frame: nothing is emitted, silently. */
export function withTarget(socket: Socket | null, userId: string): BudgetTarget | null {
  return socket === null ? null : { socket, userId };
}

/**
 * The `budget` field for a reconnect ack (addendum §1.5, option B — adopted
 * over a `billing:budget-request` event precisely so the reconnect resync costs
 * no second event name and no second round trip).
 *
 * `userId` is passed explicitly, and both call sites pass the SAME value they
 * just handed `setAuth` — not a re-read — so the number on the ack and the
 * ledger the next session bills cannot be two different accounts.
 *
 * OMITTED, never null, when nothing is wired: absence means "this server does
 * not send it" (an older relay), which is what the optional field means in the
 * schema.
 */
export function budgetAckFields(
  userId: string,
  budget?: BudgetPusher,
  /** card MP-6 — the site demo's per-browser ceiling for the socket this ack is
   *  going to, or null. Same reason `pushJoinBudget` carries it: a reconnect ack
   *  is a demo visitor's first reading after a reload, and the demo account's
   *  month is not the number they are spending. */
  capUserId: string | null = null,
  /** card MP-1 — the publishable key this socket's room was minted with, or
   *  null. Same reason as `capUserId` beside it: a reconnect ack is the first
   *  reading a page gets back, and on an integrator room the integrator's plan
   *  face is not the one to show. */
  integratorKeyId: string | null = null,
): BudgetAckFields {
  return budget ? { budget: budget.view(userId, undefined, { capUserId, integratorKeyId }) } : {};
}

/**
 * The OTHER end of the room — the target (PC / web page) that is going to show
 * this utterance, and the account IT is metered under.
 *
 * 🔴 TWO FIELDS, NOT ONE SOCKET, and that is the whole reason this type exists.
 * budget-push.ts's header says a socket is told about the account it is metered
 * under; the target's account is `pc_devices.user_id`, which is the SAME as the
 * microphone's in every web room and in most paired ones, and a different one
 * whenever the desktop is signed into another account (card QTA-2 exists
 * because that happens). Sending the phone's remaining minutes to that desktop
 * would put a number on its meter that its own ledger never moves.
 */
export interface BudgetTarget {
  socket: Pick<Socket, 'emit'>;
  /**
   * The account the TARGET end is metered under — resolved by
   * `auth/metering-principal.ts` `meteringPeerUserId`, which is `pc_devices
   * .user_id` in every case but one: an ANONYMOUS site-demo owner follows the
   * microphone's account instead, because a demo identity's ledger stops moving
   * the moment the visitor signs in (card W4-05). Never simply "the
   * microphone's".
   */
  userId: string;
}

/**
 * Push one reading to the room's target end.
 *
 * `null` ⇒ there is no target to tell, and nothing is emitted. Silent on
 * purpose: that is the shape every other PC-directed frame in this handler
 * already has (`mirrorToPc` is `const pc = store.getPc(room); if (pc) …`), and
 * a target that is offline is not a failure of this frame.
 *
 * ⚠️ `liveRemainingMs` is passed through ONLY by callers that have established
 * the two ends share an account — see {@link makeAudioBudgetPushes}. When they
 * do not, the target gets its own ledger read, which is the honest answer: its
 * minutes are not the ones being spent.
 */
export function pushPeerBudget(
  peer: BudgetTarget | null,
  budget: BudgetPusher | undefined,
  reason: BillingBudgetReason,
  opts?: { liveRemainingMs?: number; exhausted?: boolean } & BudgetViewOpts,
): void {
  if (!budget || peer === null) return;
  budget.push(peer.socket, peer.userId, reason, opts);
}

/** The `audio:*` push points, bound to one socket. */
export interface AudioBudgetPushes {
  /** Push point 2 of 4 — every `audio:start`, immediately after admission. */
  started(): void;
  /** Push point 3 of 4 — the throttled while-streaming tick, on `audio:chunk`. */
  tick(orchestrator: SttOrchestrator | null): void;
  /** Push point 4 of 4 — the exhaustion frame, triggered by the auto-stop. */
  exhausted(): void;
  /**
   * Card MP-11 / gap G-17 — THE ADMISSION REFUSAL'S FRAME, TO THE TARGET ONLY.
   *
   * 🔴 THE GAP IT CLOSES: when the key is ALREADY at zero, the recording never
   * starts, so push point 4 never fires — the auto-stop it hangs off is a thing
   * that only happens to a session that exists. `audio:start` answered
   * `stt:error INTEGRATOR_QUOTA_EXCEEDED` to the SPEAKER and the host page got
   * NOTHING: MP-2 measured a site whose own interface did not move while the
   * phone showed the sentence. The host page is the one end that can act on
   * this (it is the integrator's page, on the integrator's key), and it was the
   * one end not told.
   *
   * 🔴 IT IS THE SAME PRODUCER, not a second one. It goes through the same
   * `push` body, the same `payerHintFor`, the same `pushPeerBudget` — a budget
   * frame is composed in exactly one place in this file, and this push point
   * differs from {@link exhausted} in TWO named ways and no others: the
   * audience is the target alone (the speaker already has its verdict, and a
   * budget frame there would be a second answer to 「why did that fail」), and
   * the target is resolved WITHOUT the in-flight gate, because at this instant
   * there is no recording in flight for that gate to be about.
   */
  refusedExhausted(): void;
}

export function makeAudioBudgetPushes(
  socket: Socket,
  deps: {
    budget?: BudgetPusher;
    heartbeatMs?: number;
    now?: () => number;
    /**
     * The room's TARGET end for the utterance in flight, or null.
     *
     * 🔴 IT IS A RESOLVER, NOT A SOCKET, for two reasons that are both about
     * correctness rather than convenience. The PC can join or leave mid
     * recording, so a socket captured at audio:start would be emitted into a
     * dead transport (the same GA-04 argument the stt emitter makes about the
     * MOBILE leg). And the resolver is where the caller applies the GA-02
     * gate: a record-only utterance answers null, because a PC that was never
     * told this recording BEGAN must not be handed a meter that ticks in step
     * with it. 「At this point the content never went to the PC at all」 covers
     * the fact that there is content.
     */
    peer?: () => BudgetTarget | null;
    /**
     * Card MP-11 / gap G-17 — the room's target end, WITHOUT the in-flight gate
     * `peer` applies.
     *
     * 🔴 IT IS NOT A SECOND ANSWER TO 「who is the target」. The caller defines
     * `peer` in terms of THIS (audio.handler.ts), so there is one lookup and
     * `peer` is visibly 「that, plus GA-02」. Two independently written
     * resolvers is what this repo pays for constantly, and it is avoidable here
     * for the price of one named function.
     *
     * ⚠️ THE GA-02 LINE IS NOT BENT BY ITS EXISTENCE, and the reason is that
     * the two gates are about different facts. `fannedOut` answers 「was the PC
     * told this recording BEGAN」, and its whole point is that a record-only
     * utterance must not hand the PC a meter ticking in step with speech it
     * never saw. The only caller of this resolver fires on an admission that
     * was REFUSED: no audio was captured, no session exists, nothing began, and
     * the frame says one thing — this key's own allowance is at zero — about a
     * ceiling the target end set on its own page. Any future caller that has a
     * live utterance behind it wants `peer`, not this.
     */
    roomTarget?: () => BudgetTarget | null;
  },
): AudioBudgetPushes {
  const clock = deps.now ?? Date.now;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_BUDGET_HEARTBEAT_MS;
  /** When this socket last emitted a budget frame — the heartbeat floor's only
   *  state. Per-socket rather than per-session on purpose: a socket has one live
   *  session at a time, and a reconnect that adopts a surviving session gets a
   *  fresh tick on its first chunk, which is the resync §1.5 asks for anyway. */
  let lastPushAt = 0;

  /**
   * Emit to BOTH ends of the room: the microphone socket this was built for,
   * and the target that is going to show the words.
   *
   * 🔴 THE TARGET NEEDS THE HEARTBEAT AS MUCH AS THE MICROPHONE DOES, and for
   * stage two it needs it more: the minutes bar lives on the TARGET page, so a
   * tick that reached only the microphone would leave that bar frozen for the
   * whole time somebody is speaking into it — the exact thing this event exists
   * to fix, missing on the one screen that shows it.
   *
   * 🔴 THE LIVE NUMBER CROSSES ONLY WHEN THE TWO ENDS SHARE AN ACCOUNT. The
   * session deadline is about the microphone's ledger; handing it to a desktop
   * signed into another account would show that desktop a countdown of somebody
   * else's minutes. Different account ⇒ the target gets its OWN ledger read,
   * which does not move during this recording, and that is the truth (its
   * minutes are not the ones being spent).
   */
  function push(
    reason: 'started' | 'heartbeat' | 'exhausted',
    opts?: { liveRemainingMs?: number; exhausted?: boolean },
    // Card MP-11 / gap G-17 — WHO HEARS THIS ONE. `'both'` is every push point
    // that existed before that card and is the default so none of them had to
    // change. `'target-only'` is the refused-admission frame: the speaker
    // already holds the verdict (`stt:error`), and a budget frame beside it
    // would be a second author for 「why did that fail」.
    audience: 'both' | 'target-only' = 'both',
  ): void {
    const userId = getAuth(socket)?.userId;
    if (!deps.budget || !userId) return;
    // 🔴 Card MP-0 — THE PAYER IS THIS SOCKET'S OWN METERED ACCOUNT, and that is
    // not a simplification: `audio.handler.ts` writes the seconds with
    // `commitSttUsage(auth.userId, …)`, so the ledger that moves is by
    // construction the one `getAuth(socket).userId` names. Passing it to BOTH
    // emits is what lets the two ends say different, true things about one
    // recording — `'self'` to the microphone, `'far_end'` to a desktop whose own
    // meter is about to sit still (design D5).
    // 🔴 Card MP-6 — THE SAME PAYER, TOLD TWICE, WITH THE ROLE THE ONLY
    // DIFFERENCE. Everything but `toldRole` is one fact read off one admission
    // (`getAuth(socket)`), which is what keeps the two ends from disagreeing
    // about one recording; the role is what lets them say different TRUE things
    // about it (`payerHintFor`). Before this card the two frames were separated
    // by an id comparison, and on the branch where an unsigned guest is metered
    // under the room owner that comparison answers the same thing for both.
    const auth = getAuth(socket);
    // card MP-10 — and WHETHER THE MICROPHONE IS AN ACCOUNT, spread rather than
    // defaulted: on an admission that never recorded it the OWNER's frame must
    // carry neither sibling flag. `?? false` here would tell a desktop 「a guest
    // is speaking」 about a room this relay knows nothing about.
    const payerBase = {
      userId,
      reason: auth?.payerReason ?? 'self',
      ...(auth?.speakerSignedIn !== undefined ? { speakerSignedIn: auth.speakerSignedIn } : {}),
    } as const;
    const capUserId = auth?.capUserId ?? null;
    const integratorKeyId = auth?.integratorKeyId ?? null;
    if (audience === 'both') {
      // The heartbeat floor is a property of THIS SOCKET's stream of frames, so
      // it moves only when this socket was actually written to. A target-only
      // frame that bumped it would silence the speaker's next tick on the
      // strength of a frame the speaker never received.
      lastPushAt = clock();
      deps.budget.push(socket, userId, reason, {
        ...opts, capUserId, integratorKeyId, payer: { ...payerBase, toldRole: 'speaker' },
      });
    }
    // `roomTarget` for the refusal, `peer` for everything else — see the two
    // resolvers' own docs in the deps block above for why both exist and why
    // they are one lookup.
    const peer = (audience === 'target-only' ? deps.roomTarget?.() : deps.peer?.()) ?? null;
    if (peer === null) return;
    // ⚠️ THE CAP DOES NOT CROSS TO THE TARGET END, and that is the same rule this
    // function already applies to `liveRemainingMs`: a ceiling belongs to the
    // ledger the socket is told about. The microphone's grant says nothing about
    // the target's own month, and quoting it there would put a two-minute
    // countdown on a desktop that has one.
    pushPeerBudget(peer, deps.budget, reason, peer.userId === userId
      // 🔴 card MP-1 — THE KEY DOES CROSS TO THE TARGET, WHERE THE CAP DOES NOT,
      // and the difference is not an inconsistency. The cap belongs to the
      // MICROPHONE's browser; the key belongs to the ROOM, and on an integrator
      // room the target end IS that room — quoting the integrator's whole plan
      // to their own page while the sub-quota is what cuts the recording off
      // would put the two ends' meters on two different numbers for one
      // ceiling. Only on the branch where both ends are the same account, which
      // on an integrator room they always are.
      ? { ...opts, capUserId, integratorKeyId, payer: { ...payerBase, toldRole: 'target' } }
      // Same reason word, its own number: `exhausted` still travels, because
      // "this recording just ended for money" is true on the target's screen
      // too, but the REMAINING is the target's own.
      : {
        ...(opts?.exhausted ? { exhausted: true } : {}),
        payer: { ...payerBase, toldRole: 'target' },
      });
  }

  return {
    started: (): void => push('started'),

    /**
     * 🔴 THE NUMBER COMES OFF THE SESSION, NOT OFF THE ACCOUNT.
     *
     * The account read deliberately EXCLUDES the running session (usage is
     * written at settle), so mid-recording it answers "what did OTHER sessions
     * leave me" — a number that does not move while the user is spending it.
     * `quotaDeadlineAt` is the very deadline the hard-limit timer is armed on
     * (stt/audio/session.ts), so the meter reaches zero at the instant the
     * recording is actually ended rather than at some other instant that also
     * looked plausible.
     *
     * ⚠️ NO DEADLINE FALLS BACK TO THE ACCOUNT READ, and the two causes are
     * deliberately NOT told apart here. `undefined` means the seam does not
     * answer (a fake orchestrator); `null` means this session was never given a
     * quota ceiling. Both are "I have no better number than the ledger", and the
     * ledger already knows how to say "there is no quota concept" — it answers
     * `Infinity`, which budget-push turns into `remaining_ms: null`. Mapping a
     * missing session ceiling straight to `null` would say "this deployment does
     * not meter" about an account that is very much metered.
     *
     * 🔴 CARD G-8 DELIBERATELY DID NOT TOUCH THIS LINE, and the next person to
     * read it will want to. Since G-8 there is a SECOND deadline on the same
     * timer — the payer's `continuous_minutes` sitting ceiling
     * (`stt/audio/session.ts`, origin `session_cap`) — and when it is the nearer
     * one the recording ends while this meter still shows minutes. That looks
     * like the R11 defect the paragraph above is about, and it is not: this
     * frame answers 「how much MONEY is left」, and the money really is still
     * there. Folding the sitting ceiling in would make a free account with 20
     * minutes of month watch its MONTHLY gauge reach zero after 10 — which is
     * the one thing `billing/plans.ts` and `http/console-routes.ts` both name,
     * in those words, as forbidden for this pair.
     * ⇒ The sitting ceiling has its own face: the phone's own countdown, armed
     * from the SAME `continuous_minutes` off `/api/cloud/summary`
     * (`continuous_cap_timer.dart`). Two questions, two numbers — owner
     * 2026-08-29: 「最多 X 分钟，还剩 X 分钟」.
     * ⚠️ And a session ended by that ceiling carries NO `exhausted:true` budget
     * frame: the exhausted push is keyed on `reason === 'quota_exhausted'`
     * (`engine/stt-factory.ts`), which is exactly what stops it firing for a
     * month that is not spent.
     */
    tick(orchestrator: SttOrchestrator | null): void {
      if (!deps.budget) return;
      if (clock() - lastPushAt < heartbeatMs) return;
      const deadline = orchestrator?.quotaDeadlineAt;
      if (deadline === undefined || deadline === null) { push('heartbeat'); return; }
      push('heartbeat', { liveRemainingMs: Math.max(0, deadline - clock()) });
    },

    /**
     * 🔴 TRIGGERED BY THE AUTO-STOP, NOT BY A SECOND CLOCK OF ITS OWN.
     *
     * `engine/stt-factory.ts`'s emitter calls this the moment it is about to
     * send `audio:auto-stopped{reason:'quota_exhausted'}` — the shipped verdict
     * that a recording ended because the account ran out (card W8-4). Deriving
     * "exhausted" from anything else would give "why did this recording end" a
     * second author, which is this repo's #1 bug shape and is warned about by
     * name in `engine/stt-session-autostop.ts`.
     *
     * ⇒ ORDER: budget first, then the auto-stop. A meter that reaches zero after
     * the recording has already been reported as over explains nothing.
     */
    exhausted: (): void => push('exhausted', { liveRemainingMs: 0, exhausted: true }),

    /**
     * 🔴 SAME REASON WORD AS THE AUTO-STOP, AND THAT IS DELIBERATE. `exhausted`
     * already means 「this ended because the allowance is at zero」 on the
     * target's screen, and that is exactly what happened; minting a sixth
     * reason for 「…and it ended before it started」 would ask every reader of
     * the frame to learn a distinction that changes nothing they do. The
     * `reason` vocabulary is `BillingBudgetReasonSchema`'s five values and this
     * card adds none.
     *
     * 🔴 `liveRemainingMs: 0` TRAVELS FOR THE SAME REASON IT DOES ABOVE, and
     * it is not the only thing that makes the number zero: on an integrator
     * room the ledger read is capped by the KEY's own sub-quota
     * (`budget-push.ts` `cappedRemainingSttMs`), which is at zero — which is
     * why this refusal was issued at all. The two agree, which is the point;
     * they are not two sources.
     */
    refusedExhausted: (): void => push('exhausted', { liveRemainingMs: 0, exhausted: true }, 'target-only'),
  };
}
