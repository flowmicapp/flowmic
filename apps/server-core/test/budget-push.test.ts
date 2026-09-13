// SPEC-REF:
//   apps/server-core/src/billing/budget-push.ts (the unit under test)
//   docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §1.3
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// Card S2-02 — the three answers `budget-push` gives that the golden path
// (verify/golden/g24-billing-budget.mjs) structurally cannot reach.
//
// G24 runs a real saas relay, so every frame it reads comes from a METERED
// account with a live session. The cases below are the other side of each of
// those conditions: an unmetered deployment, a ledger that throws, and a
// session that has no ceiling of its own. Deliberately NOT a re-assertion of
// what G24 already proves — a unit test agreeing with a golden about the same
// path is two tests with one subject.

import { describe, it, expect, afterEach } from 'vitest';
import { makeBudgetPusher, budgetReaderFrom, payerHintFor, serverBudgetModeFor } from '../src/billing/budget-push';
import { installPlanLimits, planLimits, resetPlanLimits, resolvePlanLimits } from '../src/billing/plans';

interface Sent { e: string; p: unknown }
/** `emit` returns `boolean` because socket.io's does, and the pusher is typed
 *  against `Pick<Socket,'emit'>` on purpose — a spy that could not stand in for
 *  the real thing would be testing a different function. */
function socketSpy(): { emit: (e: string, p: unknown) => boolean; sent: Sent[] } {
  const sent: Sent[] = [];
  return { emit: (e, p) => { sent.push({ e, p }); return true; }, sent };
}
/** Non-null read of the one frame a case expects, so `noUncheckedIndexedAccess`
 *  does not turn every assertion into a `?.` that would pass on an empty array. */
function only(sent: Sent[]): Sent {
  expect(sent).toHaveLength(1);
  return sent[0] as Sent;
}

describe('billing:budget — the reading', () => {
  it('says "there is no quota concept" as null, never as a large number', () => {
    // 🔴 THE ONE MAPPING THAT MATTERS ON A SELF-HOSTED RELAY. `remainingSttMs`
    // answers Infinity in standalone (its own contract), and a client renders NO
    // meter for null — quota_gauge.dart's rule that an end it cannot read is an
    // end it does not draw. Clamping Infinity to some big number instead would
    // paint a meter that is simply false about an install with no billing at all,
    // and `resets_at` would invite a countdown to a date that does not exist.
    const pusher = makeBudgetPusher({
      remainingSttMs: () => Number.POSITIVE_INFINITY,
      periodEndMs: () => 1_800_000_000_000, modeFor: () => 'plan' as const, freePlanMinutes: () => 20, integratorKeyRemainingMs: () => Number.POSITIVE_INFINITY,
    });
    expect(pusher.view('u1')).toEqual({ remaining_ms: null, mode: 'plan', resets_at: null });
  });

  it('only ever produces mode "plan" (trial / integrator are stage three, with no producer)', () => {
    // The enum has three values because that is the contract the new-repo
    // clients are written against; this relay now emits TWO of them, and which
    // one is a property of the ROW (card M4-01). Asserted on the exported
    // mapping AND on real frames, so the day somebody adds a third producer they
    // have to come here and say so.
    expect(serverBudgetModeFor(false)).toBe('plan');
    expect(serverBudgetModeFor(true)).toBe('trial');
    const pusher = makeBudgetPusher({ remainingSttMs: () => 60_000, periodEndMs: () => null, modeFor: () => 'plan' as const, freePlanMinutes: () => 20, integratorKeyRemainingMs: () => Number.POSITIVE_INFINITY, });
    expect(pusher.view('u1').mode).toBe('plan');
    const demo = makeBudgetPusher({ remainingSttMs: () => 120_000, periodEndMs: () => null, modeFor: () => 'trial' as const, freePlanMinutes: () => 20, integratorKeyRemainingMs: () => Number.POSITIVE_INFINITY, });
    expect(demo.view('u1').mode).toBe('trial');
  });

  it('prefers the live session number over the account read, and rounds to whole ms', () => {
    // The account read excludes the running session (usage is written at settle),
    // so during a recording it answers a different question. G24 proves the
    // consequence end to end — that the pushed number FALLS while somebody
    // speaks; this pins the precedence itself.
    const pusher = makeBudgetPusher({ remainingSttMs: () => 1_200_000, periodEndMs: () => null , modeFor: () => 'plan' as const, freePlanMinutes: () => 20, integratorKeyRemainingMs: () => Number.POSITIVE_INFINITY,});
    expect(pusher.view('u1', 4_321.6).remaining_ms).toBe(4_322);
    expect(pusher.view('u1').remaining_ms).toBe(1_200_000);
  });

  it('never returns a negative remainder', () => {
    const pusher = makeBudgetPusher({ remainingSttMs: () => 0, periodEndMs: () => null , modeFor: () => 'plan' as const, freePlanMinutes: () => 20, integratorKeyRemainingMs: () => Number.POSITIVE_INFINITY,});
    expect(pusher.view('u1', -5_000).remaining_ms).toBe(0);
  });
});

describe('billing:budget — the push', () => {
  it('emits the whitelisted name with the reason, and marks exhaustion explicitly', () => {
    const pusher = makeBudgetPusher({ remainingSttMs: () => 0, periodEndMs: () => 1_800_000_000_000 , modeFor: () => 'plan' as const, freePlanMinutes: () => 20, integratorKeyRemainingMs: () => Number.POSITIVE_INFINITY,});
    const s = socketSpy();
    pusher.push(s, 'u1', 'exhausted', { liveRemainingMs: 0, exhausted: true });
    const frame = only(s.sent);
    expect(frame.e).toBe('billing:budget');
    expect(frame.p).toEqual({
      remaining_ms: 0, mode: 'plan', resets_at: 1_800_000_000_000,
      reason: 'exhausted', exhausted: true,
    });
  });

  it('omits `exhausted` entirely on every other reason rather than sending false', () => {
    // Absence and `false` are the same fact here, and one of them is a key every
    // client has to learn to ignore. The schema makes it optional; this keeps the
    // producer honest about it.
    const pusher = makeBudgetPusher({ remainingSttMs: () => 60_000, periodEndMs: () => null , modeFor: () => 'plan' as const, freePlanMinutes: () => 20, integratorKeyRemainingMs: () => Number.POSITIVE_INFINITY,});
    const s = socketSpy();
    pusher.push(s, 'u1', 'heartbeat');
    expect(only(s.sent).p).not.toHaveProperty('exhausted');
  });

  it('🔴 withholds the frame instead of throwing when the ledger cannot be read', () => {
    // A PROGRESS READING MUST NEVER TAKE DOWN THE PATH IT RIDES ON. Two of the
    // four push points sit inside `audio:start` and `audio:chunk`, and
    // `remainingSttMs` reaches `effectiveLimits`, which reaches the database and
    // can throw (a deleted account, SQLITE_BUSY). Letting that abort either
    // handler would trade a missing number for a lost recording.
    //
    // REVERSE CONTROL, and it is the point of the assertion pair below: with the
    // try/catch removed this case throws instead of asserting an empty `sent`,
    // i.e. the failure is the exception itself rather than a wrong value.
    const pusher = makeBudgetPusher({
      remainingSttMs: () => { throw new Error('SQLITE_BUSY'); },
      periodEndMs: () => null,
      modeFor: () => 'plan' as const, freePlanMinutes: () => 20, integratorKeyRemainingMs: () => Number.POSITIVE_INFINITY,
    });
    const s = socketSpy();
    expect(() => pusher.push(s, 'u1', 'started')).not.toThrow();
    expect(s.sent).toHaveLength(0);
  });

  it('lets `view` throw, because its callers build an ACK and must fail loud', () => {
    // The asymmetry is deliberate. `push` rides a live recording and degrades to
    // silence; `view` fills a field on a pairing ack, where the surrounding
    // handler already has a fail-loud catch that turns a throw into a named
    // refusal. Swallowing there would hand the client an ack that silently lost
    // a field it was told to expect.
    const pusher = makeBudgetPusher({
      remainingSttMs: () => { throw new Error('SQLITE_BUSY'); },
      periodEndMs: () => null,
      modeFor: () => 'plan' as const, freePlanMinutes: () => 20, integratorKeyRemainingMs: () => Number.POSITIVE_INFINITY,
    });
    expect(() => pusher.view('u1')).toThrow(/SQLITE_BUSY/);
  });
});

describe("billing:budget — the FREE plan's monthly ceiling (card NR-31)", () => {
  // WHAT THIS FIELD IS FOR. A page whose anonymous trial has just run out wants
  // to say 「sign in for a free plan with N minutes every month」. N is a server
  // number — `plans.ts`, overridable per deployment by `FLOWMIC_PLAN_LIMITS` —
  // and until this card it was not on the wire at all, so W-2 shipped with the
  // sentence suppressed rather than hardcode a copy of a configurable value.

  afterEach(() => { resetPlanLimits(); });

  /** The production reader, with the two ACCOUNT reads faked and the plan-table
   *  read left REAL. That split is the test: the field must come out of the same
   *  resolver `quota-guard` and the billing page ask, not out of a literal. */
  const productionReader = (opts: { anonymous: boolean }) => budgetReaderFrom({
    quota: { remainingSttMs: () => 120_000 },
    billing: { usagePeriod: () => ({ endMs: null }) },
    users: { findById: () => ({ anonymous: opts.anonymous }) },
  });

  it('a trial view carries exactly what the effective plan table answers for free', () => {
    const view = makeBudgetPusher(productionReader({ anonymous: true })).view('anon-1');
    expect(view.mode).toBe('trial');
    // 🔴 ASSERTED AGAINST THE RESOLVER, NOT AGAINST 20. Writing the literal here
    // would make this test a second copy of the number — the very thing the card
    // exists to stop the web client from being — and it would go green on a
    // deployment whose table says something else.
    expect(view.free_plan_minutes).toBe(planLimits('free').stt_minutes);
    expect(view.free_plan_minutes).toBeGreaterThan(0);
  });

  it('FLOWMIC_PLAN_LIMITS moves it — a deployment that raises its free tier says so', () => {
    // The production path in two lines: config.ts does exactly this with the
    // parsed env JSON (`installPlanLimits(resolvePlanLimits(envJson(...)))`).
    installPlanLimits(resolvePlanLimits(JSON.parse('{"free":{"stt_minutes":45}}')));
    expect(makeBudgetPusher(productionReader({ anonymous: true })).view('anon-1').free_plan_minutes).toBe(45);
  });

  it('a PLAN view does not carry it — an account is told about its own ceiling and nothing else', () => {
    // Not tidiness: `remaining_ms` and `resets_at` already answer what governs
    // this row, and a second, smaller number of minutes beside them is a value
    // answering a question nobody on that screen asked.
    const view = makeBudgetPusher(productionReader({ anonymous: false })).view('u1');
    expect(view.mode).toBe('plan');
    expect(view).not.toHaveProperty('free_plan_minutes');
  });

  it('omits it when the effective free tier is zero minutes, rather than sending 0', () => {
    // A deployment MAY configure `free.stt_minutes: 0` (config.ts accepts any
    // non-negative integer). 「A free plan with 0 minutes every month」 is an
    // invitation to nothing, and the client's rule for absence — leave the
    // sentence out — is the only honest rendering available.
    installPlanLimits(resolvePlanLimits(JSON.parse('{"free":{"stt_minutes":0}}')));
    expect(makeBudgetPusher(productionReader({ anonymous: true })).view('anon-1'))
      .not.toHaveProperty('free_plan_minutes');
  });

  it('omits it rather than taking the frame down when the plan table read throws', () => {
    // The asymmetry against `view`'s fail-loud rule three tests up is deliberate
    // and narrow: the ACCOUNT reads are what the ack is about, and losing one
    // silently would hand a client a number about nobody. This field is about
    // no account at all, so a missing sentence is the proportionate degradation.
    const pusher = makeBudgetPusher({
      remainingSttMs: () => 120_000, periodEndMs: () => null,
      modeFor: () => 'trial' as const,
      freePlanMinutes: () => { throw new Error('table not installed'); }, integratorKeyRemainingMs: () => Number.POSITIVE_INFINITY,
    });
    expect(() => pusher.view('anon-1')).not.toThrow();
    expect(pusher.view('anon-1')).not.toHaveProperty('free_plan_minutes');
  });

  it('rides the push as well as the ack — one producer, every frame', () => {
    const s = socketSpy();
    makeBudgetPusher(productionReader({ anonymous: true })).push(s, 'anon-1', 'granted');
    expect(only(s.sent).p).toMatchObject({ mode: 'trial', free_plan_minutes: planLimits('free').stt_minutes });
  });
});

describe('card MP-0 / MP-6 — `payer` + `guest_speaker`: whose number is this, and who is spending it', () => {
  /** A speaker frame for a payer who is the recipient. The three fields travel
   *  together in production (one `AuthContext`), so the helper does too. */
  const hint = (
    userId: string, reason: 'self' | 'peer' | 'host' | 'demo', toldRole: 'speaker' | 'target',
    /** card MP-10 — was the microphone held by a verified account. `undefined`
     *  is the third state and it is not a shorthand for false: an admission that
     *  did not record it must produce NEITHER sibling flag. */
    speakerSignedIn?: boolean,
  ): {
    userId: string; reason: 'self' | 'peer' | 'host' | 'demo';
    toldRole: 'speaker' | 'target'; speakerSignedIn?: boolean;
  } => ({ userId, reason, toldRole, ...(speakerSignedIn === undefined ? {} : { speakerSignedIn }) });

  it('omitted when the caller holds no payer — absence is 「this relay did not say」', () => {
    // 🔴 IT MUST NOT DEFAULT TO 'self'. A room-join reading is sent before any
    // recording exists, so there is no payer yet; a cheerful 'self' there would
    // be a claim about a recording nobody has started, and an older relay sends
    // nothing at all — the two must look the same to a client.
    expect(payerHintFor('u1', 'plan')).toEqual({});
    expect(payerHintFor('u1', 'plan', undefined)).toEqual({});
  });

  it("the recipient's own account is paying ⇒ 'self'", () => {
    expect(payerHintFor('u1', 'plan', hint('u1', 'self', 'speaker'))).toEqual({ payer: 'self' });
  });

  it("🔴 the ROOM'S OTHER END is paying ⇒ 'far_end' — design D5", () => {
    // The desktop A whose computer a signed-in phone B is speaking into. A is
    // told A's OWN remaining minutes (that rule is untouched), and those minutes
    // will not move for this recording. Without this field A's screen shows a
    // frozen meter beside a running recording and nothing explains it — R11 with
    // a plausible number in it.
    expect(payerHintFor('user-A', 'plan', hint('user-B', 'self', 'target'))).toEqual({ payer: 'far_end' });
    // …and it wins over the mode: a trial identity at the far end is still 「not
    // your meter」 to this recipient, and the amount is deliberately not sent.
    expect(payerHintFor('user-A', 'trial', hint('anon-7', 'self', 'target'))).toEqual({ payer: 'far_end' });
  });

  it("🔴 'trial' is DERIVED from mode, so the two can never disagree", () => {
    // A second read of `users.anonymous` here would give one question two
    // authors that a stale row could split — a frame saying `mode:'plan'` and
    // `payer:'trial'` describes an account that does not exist.
    expect(payerHintFor('anon-7', 'trial', hint('anon-7', 'demo', 'speaker'))).toEqual({ payer: 'trial' });
  });

  it('🔴🔴 MP-6 — the two frames that name the SAME account and mean opposite things', () => {
    // An unsigned guest speaking into A's computer is metered under A. Both
    // sockets are therefore told the id `user-A`, and an id comparison — which
    // is all this function had before MP-6 — cannot tell them apart.
    expect(payerHintFor('user-A', 'plan', hint('user-A', 'peer', 'target', false)))
      .toEqual({ payer: 'self', guest_speaker: true });
    expect(payerHintFor('user-A', 'plan', hint('user-A', 'peer', 'speaker', false)))
      .toEqual({ payer: 'far_end' });
  });

  it('🔴🔴 MP-10 — a SIGNED-IN speaker on A\'s machine gets its own word, not the guest one', () => {
    // 🔴 THE CASE THAT DID NOT EXIST BEFORE THIS CARD, because the branch
    // could not be reached: `'peer'` used to mean 「nobody signed in」. owner's
    // 2026-09-11 凌晨 再追认 bills A for a signed-in visitor too, so A's
    // frame must be able to say WHICH kind of somebody-else is spending it —
    // the two point at different remedies (unpair a browser / talk to a
    // colleague), and one flag for both would put a false sentence on A's
    // screen the first time a teammate signs in.
    expect(payerHintFor('user-A', 'plan', hint('user-A', 'peer', 'target', true)))
      .toEqual({ payer: 'self', signed_in_speaker: true });
    // The SPEAKER's own frame is unchanged and carries neither flag: it already
    // answers this situation with 'far_end', and one fact wearing two names on
    // two frames is how the ends start disagreeing about one recording.
    expect(payerHintFor('user-A', 'plan', hint('user-A', 'peer', 'speaker', true)))
      .toEqual({ payer: 'far_end' });
  });

  it('🔴 MP-10 — an admission that did not record it carries NEITHER flag', () => {
    // Absence is 「this relay did not say」 on both fields. A default of
    // `guest_speaker` would be a claim about who is standing in a room, made by
    // a layer that does not hold the fact — and it would fire on every socket
    // stamped by the token middleware rather than by the payer rule.
    expect(payerHintFor('user-A', 'plan', hint('user-A', 'peer', 'target')))
      .toEqual({ payer: 'self' });
  });

  it('🔴 MP-10 — the two sibling flags are mutually exclusive, on every input', () => {
    // Asserted as a property rather than read off the two cases above, because
    // 「a frame that says both」 is the failure a future branch would introduce
    // and it is the one a client cannot recover from: it would have to pick.
    for (const toldRole of ['speaker', 'target'] as const) {
      for (const signedIn of [true, false, undefined]) {
        for (const reason of ['self', 'peer', 'host', 'demo'] as const) {
          const out = payerHintFor('user-A', 'plan', hint('user-A', reason, toldRole, signedIn));
          expect(Boolean(out.guest_speaker) && Boolean(out.signed_in_speaker), JSON.stringify({ reason, toldRole, signedIn })).toBe(false);
        }
      }
    }
    // …and the positive control for that zero: both flags really are produced
    // somewhere, so 「never both」 is not the silence of two fields nobody sets.
    expect(payerHintFor('user-A', 'plan', hint('user-A', 'peer', 'target', false)).guest_speaker).toBe(true);
    expect(payerHintFor('user-A', 'plan', hint('user-A', 'peer', 'target', true)).signed_in_speaker).toBe(true);
  });

  it('🔴 `guest_speaker` appears on NOTHING else — it is not 「somebody else is here」', () => {
    // The desktop's own phone, the site demo, an integrator's page: none of them
    // is a guest spending an owner's allowance, and a flag that crept onto them
    // would put a sentence about somebody else's usage on a screen where it is
    // false.
    for (const reason of ['self', 'host', 'demo'] as const) {
      for (const signedIn of [true, false, undefined]) {
        expect(payerHintFor('user-A', 'plan', hint('user-A', reason, 'target', signedIn)))
          .not.toHaveProperty('guest_speaker');
        // card MP-10 — and its sibling is held to the same rule, for the same
        // reason: it is 「somebody else is spending YOUR minutes」, not 「somebody
        // else is here」.
        expect(payerHintFor('user-A', 'plan', hint('user-A', reason, 'target', signedIn)))
          .not.toHaveProperty('signed_in_speaker');
      }
    }
    // …and not on the far-end frame either, where the recipient is not the payer.
    for (const signedIn of [true, false, undefined]) {
      expect(payerHintFor('user-A', 'plan', hint('user-B', 'peer', 'target', signedIn)))
        .not.toHaveProperty('guest_speaker');
      expect(payerHintFor('user-A', 'plan', hint('user-B', 'peer', 'target', signedIn)))
        .not.toHaveProperty('signed_in_speaker');
    }
  });

  it('rides the frame, and the frame only says it when it was told', () => {
    const reader = {
      remainingSttMs: () => 120_000, periodEndMs: () => null,
      modeFor: () => 'plan' as const, freePlanMinutes: () => 20, integratorKeyRemainingMs: () => Number.POSITIVE_INFINITY,
    };
    const withPayer = socketSpy();
    makeBudgetPusher(reader).push(withPayer, 'user-A', 'started', { payer: hint('user-B', 'self', 'target') });
    expect(only(withPayer.sent).p).toMatchObject({ payer: 'far_end' });

    const without = socketSpy();
    makeBudgetPusher(reader).push(without, 'user-A', 'granted');
    expect(only(without.sent).p).not.toHaveProperty('payer');
  });

  it('🔴 MP-6 — a demo CAP makes the view a trial view and takes the LOWER of the two reads', () => {
    // The site demo is two ceilings: the demo ACCOUNT's month (a real plan, so
    // `modeFor` answers 'plan') and THIS BROWSER's lifetime grant. What a page
    // may render a clock for is the smaller one, and the face it wears is the
    // trial's — a subscription's face over a two-minute allowance is R11 with a
    // plausible number in it.
    const reader = {
      remainingSttMs: (id: string) => (id === 'anon-7' ? 30_000 : 900_000),
      periodEndMs: () => 1_900_000_000_000,
      modeFor: () => 'plan' as const,
      freePlanMinutes: () => 20, integratorKeyRemainingMs: () => Number.POSITIVE_INFINITY,
    };
    const s = socketSpy();
    makeBudgetPusher(reader).push(s, 'user-flowmic-demo', 'started', {
      capUserId: 'anon-7', payer: hint('user-flowmic-demo', 'demo', 'speaker'),
    });
    expect(only(s.sent).p).toMatchObject({
      mode: 'trial', remaining_ms: 30_000, payer: 'trial',
      // A trial view carries no reset date and DOES carry the free tier's size —
      // both are existing rules, asserted here because the mode that triggers
      // them is now decided by the cap rather than by the row.
      resets_at: null, free_plan_minutes: 20,
    });

    // The POSITIVE CONTROL for that 30_000: without the cap the same reader and
    // the same account produce the account's own month and a plan face. Without
    // it, 「the cap won」 and 「this reader always answers 30 s」 look identical.
    const uncapped = socketSpy();
    makeBudgetPusher(reader).push(uncapped, 'user-flowmic-demo', 'started', {
      payer: hint('user-flowmic-demo', 'demo', 'speaker'),
    });
    expect(only(uncapped.sent).p).toMatchObject({ mode: 'plan', remaining_ms: 900_000, payer: 'self' });
  });

  it('🔴 MP-6 — a CAP alone (no payer) is the JOIN frame: trial face, capped number, no payer field', () => {
    // `pushJoinBudget` carries the cap and never a payer, and this is why the two
    // are separate fields. Before that split a demo visitor's FIRST frame quoted
    // the demo account's month at mode:'plan' — a subscription's face handed to
    // somebody with two minutes.
    const reader = {
      remainingSttMs: (id: string) => (id === 'anon-7' ? 30_000 : 900_000),
      periodEndMs: () => 1_900_000_000_000,
      modeFor: () => 'plan' as const,
      freePlanMinutes: () => 20, integratorKeyRemainingMs: () => Number.POSITIVE_INFINITY,
    };
    const s = socketSpy();
    makeBudgetPusher(reader).push(s, 'user-flowmic-demo', 'granted', { capUserId: 'anon-7' });
    expect(only(s.sent).p).toMatchObject({ mode: 'trial', remaining_ms: 30_000, resets_at: null });
    expect(only(s.sent).p).not.toHaveProperty('payer');
  });

  it('🔴 MP-6 — an unmetered deployment stays unmetered through the cap', () => {
    // `Infinity` is 「no quota concept」 and must survive as `null` all the way to
    // the client. `Math.min(Infinity, Infinity)` is the one arithmetic this card
    // adds on that path, and clamping it to a large number would render a meter
    // that is simply false about a standalone install.
    const reader = {
      remainingSttMs: () => Infinity, periodEndMs: () => null,
      modeFor: () => 'plan' as const, freePlanMinutes: () => 20, integratorKeyRemainingMs: () => Number.POSITIVE_INFINITY,
    };
    const s = socketSpy();
    makeBudgetPusher(reader).push(s, 'user-flowmic-demo', 'started', {
      capUserId: 'anon-7', payer: hint('user-flowmic-demo', 'demo', 'speaker'),
    });
    expect(only(s.sent).p).toMatchObject({ remaining_ms: null });
  });
});

