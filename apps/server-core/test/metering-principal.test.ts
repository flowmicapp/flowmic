// SPEC-REF:
//   docs/strategy/2026-09-11-metering-principal-matrix-design.md §1 (the matrix),
//     §2 (the single ordered rule), §3 (D1/D3), §6 (the reverse controls)
//   docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md
//     §9 (「谁说扣谁」) and §9-1 (a third-party page's owner pays, FREE tier included)
//   docs/strategy/2026-09-09-w4-05-login-switches-metering-design.md §0/§1/§2
//   apps/server-core/src/auth/metering-principal.ts (the rule itself)
//
// -- WHY THE MATRIX IS DRIVEN AS A TABLE ------------------------------------
//
// The rule is ORDERED, and the interesting failures are all orderings rather
// than individual answers: a step that runs one place too early answers most
// cells correctly and one cell expensively. Written as a table, the cell that
// pays for a mistake is visible beside the fifteen that do not.
//
// ⚠️ EVERY CELL BELOW IS A CELL OF THE PUBLISHED MATRIX (design §1), not a shape
// invented here. Where the matrix says 「不成立」 the row is absent rather than
// asserted — a test for a combination the server cannot produce is a claim about
// nothing, and it would have to be maintained by whoever later makes it
// producible.

import { describe, expect, it } from 'vitest';
import {
  meteringPeerUserId,
  meteringPrincipal,
  pcOwnerQuotaGate,
  resolvePayer,
  roomKindOf,
  ROOM_KINDS,
  type AnonymousRowReader,
  type PayerReason,
  type RoomKind,
} from '../src/auth/metering-principal';

/** The site-demo owner: an anonymous identity minted by card M4-01. */
const DEMO = 'user-demo-anon';
/** A real desktop owner — 「A」 in the design's prose. */
const OWNER_A = 'user-desktop-owner';
/** The speaker's own signed-in account — 「B」. */
const ACCOUNT_B = 'user-signed-in';
/** The integrator whose page embedded FlowMic — 「T」. */
const OWNER_T = 'user-integrator-T';
/** An anonymous grant a browser is spending — card R-1, and since MP-6 a CAP
 *  rather than a payer. */
const TRIAL = 'anon-7';
/** `FLOWMIC_DEMO_PAYER_USER_ID` — FlowMic's own account, which pays for the
 *  public site demo since card MP-6. A REAL users row, deliberately: the
 *  whole point of owner §11 is that the demo's spend is lookup-able. */
const DEMO_PAYER = 'user-flowmic-demo';
const CONFIG = { demoPayerUserId: DEMO_PAYER } as const;

/** Only the demo identity is anonymous. Written as a set rather than `() => true`
 *  so a rule that consults the WRONG id fails here instead of passing by luck. */
const anonymous: AnonymousRowReader = (id) => id === DEMO;

describe('roomKindOf — WHICH far end, and it is two columns not one', () => {
  it('an ordinary desktop row (room_kind NULL) is an App far end', () => {
    expect(roomKindOf({ roomKind: null, ownerUserId: OWNER_A, reader: anonymous })).toBe('app');
    expect(roomKindOf({ roomKind: undefined, ownerUserId: OWNER_A, reader: anonymous })).toBe('app');
  });

  it("a browser room owned by a REAL account is 'web'; owned by an ANONYMOUS one it is 'demo'", () => {
    // 🔴 The two are ONE stored value ('web') split by `users.anonymous`, which
    // is the single author of 「is this a demo」 everywhere else in this server.
    // Storing 'demo' would have made a second author — and would have dropped
    // demo rooms out of `idx_pc_devices_web_room_owner`, a partial UNIQUE index
    // whose predicate is the literal `room_kind='web'`.
    expect(roomKindOf({ roomKind: 'web', ownerUserId: OWNER_A, reader: anonymous })).toBe('web');
    expect(roomKindOf({ roomKind: 'web', ownerUserId: DEMO, reader: anonymous })).toBe('demo');
  });

  it('an unwired reader reads a demo room as a plain web room — and no payer moves', () => {
    // The pre-card degradation. It is safe HERE because every rule downstream
    // treats 'web' and 'demo' alike; what differs is only which owner id the
    // room happens to have, and that comes off the row either way.
    expect(roomKindOf({ roomKind: 'web', ownerUserId: DEMO })).toBe('web');
  });

  it("'integrator' is understood, with no writer anywhere in this build", () => {
    expect(roomKindOf({ roomKind: 'integrator', ownerUserId: OWNER_T, reader: anonymous }))
      .toBe('integrator');
  });

  it('🔴 a value this build does not understand is NULL — never a guess', () => {
    // Design §5. A row written by a NEWER build may be a third-party host, and
    // every available guess bills the wrong party: FlowMic's free grant, or a
    // desktop owner's month, for an integrator's visitors.
    expect(roomKindOf({ roomKind: 'kiosk', ownerUserId: OWNER_A, reader: anonymous })).toBeNull();
    expect(roomKindOf({ roomKind: '', ownerUserId: OWNER_A, reader: anonymous })).toBeNull();
  });
});

describe('resolvePayer — the published matrix, cell by cell (design §10-2)', () => {
  type Cell = {
    /** The design's row label, verbatim enough to find. */
    speaker: string;
    /** The design's column. */
    kind: RoomKind;
    /** `pc_devices.user_id` for that column. */
    owner: string;
    account: string | null;
    trial: string | null;
    payer: string;
    reason: PayerReason;
    /** The site demo's per-browser ceiling, when this cell has one. */
    cap?: string;
  };

  const CELLS: readonly Cell[] = [
    // ── row 1 · A SIGNED-IN SPEAKER ON SOMEBODY ELSE'S FLOWMIC FAR END ───────
    // 🔴🔴 THE CELLS CARD MP-10 TURNED OVER, AND THEY ARE THE CARD. MP-0 read
    // owner's §9 「谁说扣谁」 as billing the SPEAKER wherever they were, so these
    // two answered ACCOUNT_B. owner's 2026-09-11 凌晨 再追认 —
    // 「「已登录用户默认也是扣对端」也包括自家 PC」 — says the computer's owner pays.
    // The speaker's account is still read here, and it decides exactly one
    // thing: the WORD ('peer' rather than 'self'), plus `speakerSignedIn`, which
    // is what the owner's budget frame turns into a sentence.
    { speaker: 'signed-in phone B', kind: 'app', owner: OWNER_A, account: ACCOUNT_B, trial: null, payer: OWNER_A, reason: 'peer' },
    { speaker: 'signed-in web B', kind: 'web', owner: OWNER_A, account: ACCOUNT_B, trial: null, payer: OWNER_A, reason: 'peer' },
    // 🔴 THE INTEGRATOR CELL IS UNMOVED BY MP-10, and it is worth one line to
    // say why a card that put the far end first everywhere changed nothing
    // here: this far end was ALREADY first (card MP-1, owner's earlier 追认).
    { speaker: 'signed-in phone B', kind: 'integrator', owner: OWNER_T, account: ACCOUNT_B, trial: null, payer: OWNER_T, reason: 'host' },
    // …and the SITE DEMO cell, which MP-10 deliberately did NOT move: W4-05
    // (owner 2026-09-09 §13) is 「sign in on the demo page and the demo stops
    // paying for you」, a separate ruling the 再追认 does not revisit. This is the
    // one far end a signed-in speaker still outranks.
    { speaker: 'signed-in phone B', kind: 'demo', owner: DEMO, account: ACCOUNT_B, trial: TRIAL, payer: ACCOUNT_B, reason: 'self' },

    // ── row 2 · THE SPEAKER *IS* THE ROOM'S OWNER ⇒ the same payer, the other
    //           word. This is the ordinary product — your own phone on your own
    //           computer — and it is ALSO the light record (a cloud-instance
    //           room is minted under the speaker's own account), which is why
    //           owner's 「没有对端（手机轻记录）才扣自己」 needs no branch of its own.
    { speaker: 'signed-in phone A, on A own PC', kind: 'app', owner: OWNER_A, account: OWNER_A, trial: null, payer: OWNER_A, reason: 'self' },
    { speaker: 'signed-in web B, on B own target page', kind: 'web', owner: ACCOUNT_B, account: ACCOUNT_B, trial: null, payer: ACCOUNT_B, reason: 'self' },

    // ── row 3 · unsigned, on a FlowMic far end ⇒ the ROOM OWNER pays ─────────
    // Unchanged by MP-10 — these were already 'peer' after MP-6. What changed is
    // that they are no longer the ONLY way to reach that word.
    { speaker: 'unsigned web', kind: 'app', owner: OWNER_A, account: null, trial: TRIAL, payer: OWNER_A, reason: 'peer' },
    { speaker: 'unsigned web', kind: 'web', owner: OWNER_A, account: null, trial: TRIAL, payer: OWNER_A, reason: 'peer' },
    // 🔴 THE D3 CELL, unchanged: FlowMic never funds a third party's visitors.
    { speaker: 'unsigned web', kind: 'integrator', owner: OWNER_T, account: null, trial: TRIAL, payer: OWNER_T, reason: 'host' },

    // ── row 4 · 站点体验访客 ⇒ FlowMic's DEMO ACCOUNT pays, capped per browser ─
    { speaker: 'site-demo visitor', kind: 'demo', owner: DEMO, account: null, trial: TRIAL, payer: DEMO_PAYER, reason: 'demo', cap: TRIAL },
    // A demo visitor whose browser declared no uid gets no cap id — and STILL
    // does not fall back to the anonymous room owner. The account is the same.
    { speaker: 'site-demo visitor, no browser uid', kind: 'demo', owner: DEMO, account: null, trial: null, payer: DEMO_PAYER, reason: 'demo' },

    // ── the deployment with no account layer at all (LAN / standalone) ───────
    { speaker: 'App phone, no account layer', kind: 'app', owner: OWNER_A, account: null, trial: null, payer: OWNER_A, reason: 'peer' },
  ];

  const decide = (c: Cell): ReturnType<typeof resolvePayer> => resolvePayer(
    { kind: c.kind, pcUserId: c.owner, mobileUserId: c.owner },
    {
      account: c.account === null ? null : { userId: c.account },
      trialUserId: c.trial,
      reader: anonymous,
    },
    CONFIG,
  );

  for (const c of CELLS) {
    it(`${c.speaker} → ${c.kind} far end ⇒ ${c.reason}`, () => {
      expect(decide(c)).toEqual({
        userId: c.payer,
        reason: c.reason,
        capUserId: c.cap ?? null,
        // card MP-1 — null on every cell here because none of them declares a
        // key; the cells that DO are driven separately below, so this stays an
        // assertion that a key cannot appear out of nowhere.
        integratorKeyId: null,
        switched: expect.any(Boolean),
        // card MP-10 — asserted on EVERY cell rather than only on the two that
        // read it, because it is the field the owner's sentence hangs on: a
        // branch that forgot to carry it would leave a desktop unable to tell a
        // colleague from a stranger, with every other assertion here green.
        speakerSignedIn: c.account !== null,
      });
    });
  }

  it('🔴 MP-10 — the two `peer` shapes differ ONLY in `speakerSignedIn`, and that is why the field exists', () => {
    // The payer is the same account and the reason is the same word, so nothing
    // else on the decision separates 「a stranger's browser is on your machine」
    // from 「a colleague is on your machine」. `speakerRef` is not a separator:
    // it is a users id in one case and a `wb-…` browser uid in the other, and
    // telling those apart by the SHAPE of a string is a guess about money.
    const signedIn = resolvePayer(
      { kind: 'app', pcUserId: OWNER_A, mobileUserId: OWNER_A },
      { account: { userId: ACCOUNT_B }, trialUserId: null, reader: anonymous },
      CONFIG,
    );
    const unsigned = resolvePayer(
      { kind: 'app', pcUserId: OWNER_A, mobileUserId: OWNER_A },
      { account: null, trialUserId: TRIAL, reader: anonymous },
      CONFIG,
    );
    expect(signedIn).toEqual({ ...unsigned, speakerSignedIn: true });
    expect(unsigned?.speakerSignedIn).toBe(false);
  });

  it('🔴 MP-10 — the LIGHT RECORD falls out of the same expression (owner 「没有对端才扣自己」)', () => {
    // 「A phone recording with no far end」 is `mobile:pair`'s `cloud_instance`
    // payload, and `registry.admitCloudInstance` mints the virtual `pc_devices`
    // row under the SPEAKER'S OWN account. So it reaches this rule as an 'app'
    // far end whose owner is the speaker, and 'self' is what comes back — no
    // fifth branch, and nothing to keep in agreement with a second one.
    //
    // ⚠️ THE HANDLER STAMPS `'self'` DIRECTLY AND NEVER CALLS THIS FUNCTION
    // (`mobile.handler.ts`, the cloud-instance arm). This case is here so that
    // the two answers cannot silently disagree the day it does.
    expect(resolvePayer(
      { kind: 'app', pcUserId: ACCOUNT_B, mobileUserId: ACCOUNT_B },
      { account: { userId: ACCOUNT_B }, trialUserId: null, reader: anonymous },
      CONFIG,
    )).toEqual({
      userId: ACCOUNT_B, reason: 'self', capUserId: null, integratorKeyId: null,
      switched: false, speakerSignedIn: true,
    });
  });

  it('🔴 the invariant: nobody records a second without an account that can be named', () => {
    // owner §11's own sentence — 「向额度的消耗有迹可寻」 — as a property over the
    // whole table rather than re-read cell by cell. It is the assertion that
    // catches a future branch quietly reintroducing an unbilled payer.
    //
    // ⚠️ THE ANONYMOUS GRANT IS THE THING BEING EXCLUDED, and it is excluded as a
    // PAYER only: the demo cell still carries it, in `capUserId`, where it is a
    // ceiling rather than a cost. A test that forbade the id outright would go
    // red on the correct implementation.
    for (const c of CELLS) {
      const d = decide(c);
      expect(d).not.toBeNull();
      expect(d?.userId).not.toBe(TRIAL);
      expect(anonymous(d?.userId ?? '')).toBe(false);
    }
    // …and the positive control for that zero: the cap really is produced, so
    // 「no anonymous payer」 is not the silence of a table that never had one.
    expect(CELLS.filter((c) => decide(c)?.capUserId === TRIAL)).toHaveLength(1);
  });

  it('🔴 an UNSIGNED visitor on a third-party page is still T, whatever else is true', () => {
    // Design §10-2: the host column's answer for an unsigned speaker does not
    // depend on anything else about them. Driven as a loop so a future speaker
    // shape cannot be added and quietly get its own answer here.
    for (const trialUserId of [TRIAL, null]) {
      expect(resolvePayer({ kind: 'integrator', pcUserId: OWNER_T }, { account: null, trialUserId, reader: anonymous }, CONFIG))
        .toEqual({ userId: OWNER_T, reason: 'host', capUserId: null, integratorKeyId: null, switched: false, speakerSignedIn: false });
    }
  });

  it('🔴 card MP-1 — a SIGNED-IN speaker on a third-party page is T too, and the key rides out with the decision', () => {
    // The 追认 (owner §11, 2026-09-11 00:30) as its own case rather than only as
    // a row in the table above, because it is the one cell in the whole matrix
    // whose answer was reversed and then restored — and a table row can be
    // edited by somebody who does not know that.
    expect(resolvePayer(
      { kind: 'integrator', pcUserId: OWNER_T, integratorKeyId: 'ik-1' },
      { account: { userId: ACCOUNT_B }, trialUserId: null, reader: anonymous },
      CONFIG,
    )).toEqual({ userId: OWNER_T, reason: 'host', capUserId: null, integratorKeyId: 'ik-1', switched: false, speakerSignedIn: true });
  });

  it('🔴 card MP-1 — the key is produced by the host branch ALONE', () => {
    // 「a key ceiling only exists on an integrator room」 asserted as a property of
    // the data rather than left as a sentence in a doc comment: every other kind
    // is handed the same `integratorKeyId` and must drop it, because a ceiling
    // that survived onto an ordinary room would silently cut a paying customer's
    // recording short.
    for (const kind of ['app', 'web', 'demo'] as const) {
      const owner = kind === 'demo' ? DEMO : OWNER_A;
      expect(resolvePayer(
        { kind, pcUserId: owner, integratorKeyId: 'ik-1' },
        { account: null, trialUserId: TRIAL, reader: anonymous },
        CONFIG,
      )?.integratorKeyId, `${kind} kept an integrator key`).toBeNull();
    }
  });

  it('🔴🔴 a site demo with NO demo account configured is REFUSED, not billed to a fallback', () => {
    // owner §11 / design §10-1 step 3. The two fallbacks a reader would reach
    // for are exactly the two the ruling rules out, so both are asserted
    // NEGATIVELY here — a null answer proves neither on its own.
    for (const config of [{}, { demoPayerUserId: null }, { demoPayerUserId: '  ' }]) {
      const d = resolvePayer(
        { kind: 'demo', pcUserId: DEMO, mobileUserId: DEMO },
        { account: null, trialUserId: TRIAL, reader: anonymous },
        config,
      );
      expect(d).toBeNull();
    }
    // The POSITIVE control for that null: the very same room, with the account
    // configured, opens. Without this the assertion above would pass against an
    // implementation that refused every demo room for any reason at all.
    expect(resolvePayer(
      { kind: 'demo', pcUserId: DEMO, mobileUserId: DEMO },
      { account: null, trialUserId: TRIAL, reader: anonymous },
      CONFIG,
    )).toEqual({ userId: DEMO_PAYER, reason: 'demo', capUserId: TRIAL, integratorKeyId: null, switched: false, speakerSignedIn: false });
  });

  it('🔴 ORDER: every FlowMic far end outranks the speaker, and the site demo is the one that does not', () => {
    // ⚠️ REWRITTEN BY CARD MP-10 (2026-09-11), and this case has now been
    // rewritten three times in one day — which is exactly why it is a case of
    // its own rather than four table rows. MP-0 read it as 「the speaker is asked
    // BEFORE the far end, on every far end there is」; MP-1 carved out the
    // integrator; MP-10 inverted the rest. If it is ever rewritten a fourth
    // time, the thing to check is not the loop but which owner ruling the loop
    // is quoting.
    for (const kind of ['app', 'web', 'integrator'] as const) {
      const owner = kind === 'integrator' ? OWNER_T : OWNER_A;
      expect(resolvePayer(
        { kind, pcUserId: owner, mobileUserId: owner },
        { account: { userId: ACCOUNT_B }, trialUserId: TRIAL, reader: anonymous },
        CONFIG,
      ), `${kind} billed the speaker`).toMatchObject({ userId: owner });
    }
    // …and the one that goes the other way, so 「three of four」 is stated rather
    // than left as the absence of a fourth iteration.
    expect(resolvePayer(
      { kind: 'demo', pcUserId: DEMO, mobileUserId: DEMO },
      { account: { userId: ACCOUNT_B }, trialUserId: TRIAL, reader: anonymous },
      CONFIG,
    )).toMatchObject({ userId: ACCOUNT_B, reason: 'self' });
  });

  it('a pairing row that names its OWN account is still the fallback, not the rule', () => {
    // `mobile.user_id ?? pc.user_id` survives as the FlowMic-far-end step. No
    // production path mints such a row today (`PairInput.user_id` has no
    // caller), so this pins the phrasing rather than a shipped behaviour.
    expect(resolvePayer(
      { kind: 'app', pcUserId: OWNER_A, mobileUserId: 'user-phone-own' },
      { account: null, reader: anonymous },
      CONFIG,
    )).toEqual({
      userId: 'user-phone-own', reason: 'peer', capUserId: null, integratorKeyId: null,
      switched: false, speakerSignedIn: false,
    });
  });
});

describe('meteringPrincipal — the admission handlers’ shape of that rule', () => {
  it('a signed-in socket in an ANONYMOUS demo room is metered to the account, and reports the switch', () => {
    expect(meteringPrincipal({
      account: { userId: ACCOUNT_B }, pcUserId: DEMO, mobileUserId: DEMO, roomKind: 'demo', reader: anonymous,
    })).toEqual({
      userId: ACCOUNT_B, switched: true, reason: 'self', capUserId: null, integratorKeyId: null,
      speakerRef: ACCOUNT_B, speakerSignedIn: true,
    });
  });

  it('🔴 no account on the socket ⇒ FlowMic’s DEMO ACCOUNT, never the anonymous room owner', () => {
    // 🔴 THIS ASSERTION FLIPPED WITH CARD MP-6 and the flip is owner §11. It used
    // to expect DEMO — the anonymous identity that owns the room — on the
    // reasoning that a demo visitor's minutes are FlowMic's to give. They still
    // are; what changed is that they now come off an account somebody can look
    // up, and the anonymous identity is demoted to a CAP.
    expect(meteringPrincipal({
      account: null, pcUserId: DEMO, mobileUserId: DEMO, roomKind: 'demo', reader: anonymous,
      trialUserId: TRIAL, deviceUid: 'wb-abc', demoPayerUserId: DEMO_PAYER,
    })).toEqual({
      userId: DEMO_PAYER, switched: false, reason: 'demo', capUserId: TRIAL, integratorKeyId: null,
      speakerRef: 'wb-abc', speakerSignedIn: false,
    });
  });

  it('🔴 …and with no demo account configured there is NO principal, so the caller refuses', () => {
    expect(meteringPrincipal({
      account: null, pcUserId: DEMO, mobileUserId: DEMO, roomKind: 'demo', reader: anonymous,
      trialUserId: TRIAL, deviceUid: 'wb-abc',
    })).toBeNull();
  });

  it('🔴 speakerRef is the ACCOUNT when there is one and the DEVICE when there is not', () => {
    // Two questions, one column: `usage_events.speaker_ref` answers 「who spoke」,
    // which is only sometimes the same as 「whose ledger moved」. It is never an
    // email — the value is whatever opaque id the admission already held.
    expect(meteringPrincipal({
      account: { userId: ACCOUNT_B }, pcUserId: OWNER_A, mobileUserId: null, roomKind: 'app',
      deviceUid: 'wb-abc', reader: anonymous,
    })?.speakerRef).toBe(ACCOUNT_B);
    expect(meteringPrincipal({
      account: null, pcUserId: OWNER_A, mobileUserId: null, roomKind: 'app',
      deviceUid: 'wb-abc', reader: anonymous,
    })?.speakerRef).toBe('wb-abc');
    // Neither declared ⇒ null, and null means 「this admission did not record
    // it」. It is not filled in with the payer: that would make the column agree
    // with `user_id` by construction and stop answering its own question.
    expect(meteringPrincipal({
      account: null, pcUserId: OWNER_A, mobileUserId: null, roomKind: 'app', reader: anonymous,
    })?.speakerRef).toBeNull();
  });

  it('🔴 an UNWIRED reader still bills the ACCOUNT, and reports NO switch', () => {
    // 🔴 THIS ASSERTION FLIPPED WITH CARD MP-0 and the flip is the point. It used
    // to expect the demo identity, on the reasoning that every failure must land
    // on 「still trial」 and none on 「unlimited」. The second half is untouched
    // (nothing here can reach `Infinity`); the first half was only ever true
    // because the account was allowed to displace the row's default under an
    // anonymous owner, and D1 removes that condition. Billing a signed-in
    // speaker's own account is not a failure direction — it is the rule.
    //
    // `switched` still needs the reader, and without it the answer is NO: the
    // frame it arms tells a card its meter moved, and a process that cannot read
    // `users.anonymous` cannot know that it did.
    expect(meteringPrincipal({
      account: { userId: ACCOUNT_B }, pcUserId: DEMO, mobileUserId: DEMO, roomKind: 'demo',
    })).toEqual({
      userId: ACCOUNT_B, switched: false, reason: 'self', capUserId: null, integratorKeyId: null,
      speakerRef: ACCOUNT_B, speakerSignedIn: true,
    });
  });

  it('🔴🔴 MP-10 — a REAL desktop owner is NOT displaced by the speaker’s verified account', () => {
    // 🔴 THIS ASSERTION IS THE INVERSE OF THE ONE IT REPLACES, AND BOTH WERE
    // WRITTEN ON 2026-09-11. Card MP-0's version was titled 「D1 — a REAL desktop
    // owner IS displaced by the speaker's verified account」 and expected
    // ACCOUNT_B. owner's 再追认 that night (「「已登录用户默认也是扣对端」
    // 也包括自家 PC」) makes the desktop's owner the payer. The speaker's
    // account survives in TWO places and neither of them is the bill: the WORD
    // ('peer', which `usage_events.payer_reason` stores) and `speakerRef` (who
    // spoke), plus `speakerSignedIn` for the owner's own frame.
    expect(meteringPrincipal({
      account: { userId: ACCOUNT_B }, pcUserId: OWNER_A, mobileUserId: null, roomKind: 'app', reader: anonymous,
    })).toEqual({
      userId: OWNER_A, switched: false, reason: 'peer', capUserId: null, integratorKeyId: null,
      speakerRef: ACCOUNT_B, speakerSignedIn: true,
    });
  });

  it('🔴 switched stays NARROW: displacing a REAL owner emits no admission frame', () => {
    // budget-frames.ts `pushMeteringSwitchBudget` is armed by this flag, and
    // golden G10 counts EVERY frame that reaches a PC across a record-only
    // session. D1 creates a second case in which the desktop's meter stops
    // moving; that one is answered per utterance by `billing:budget.payer`, not
    // by a frame at admission time.
    expect(meteringPrincipal({
      account: { userId: ACCOUNT_B }, pcUserId: OWNER_A, mobileUserId: null, roomKind: 'app', reader: anonymous,
    })?.switched).toBe(false);
  });

  it('an account that IS the room owner is not a switch (nothing to tell the card)', () => {
    expect(meteringPrincipal({
      account: { userId: DEMO }, pcUserId: DEMO, mobileUserId: DEMO, roomKind: 'demo', reader: anonymous,
    })).toEqual({
      userId: DEMO, switched: false, reason: 'self', capUserId: null, integratorKeyId: null,
      speakerRef: DEMO, speakerSignedIn: true,
    });
  });

  it('🔴 a far end this build cannot classify has NO principal — the caller must refuse', () => {
    // Design §5: never fall back to FlowMic's grant and never to the PC owner.
    // `mobile.handler.ts` / `mobile-reconnect.ts` turn this null into a
    // retryable refusal that leaves the phone's token intact.
    expect(meteringPrincipal({
      account: { userId: ACCOUNT_B }, pcUserId: OWNER_A, mobileUserId: null, roomKind: null, reader: anonymous,
    })).toBeNull();
  });
});

describe('pcOwnerQuotaGate — QTA-2s second ledger, and what MP-10 left of it', () => {
  it('🔴🔴 MP-10 — a DIFFERENT real desktop owner is NOT asked any more', () => {
    // 🔴 THIS ASSERTION IS THE INVERSE OF THE ONE IT REPLACES. Card MP-0's
    // version was titled 「a DIFFERENT real desktop owner is still asked — owner
    // §8 Q1, answered 甲」 and expected OWNER_A, on the reasoning that owner
    // 2026-08-15 「两边有一方不满足都不能继续」 is about whether a session may RUN
    // rather than about who pays for it. That reasoning had a premise: the
    // SPEAKER's ledger was the one being spent, so the desktop's was a genuine
    // SECOND one. owner's 2026-09-11 再追认 removes the premise — on a FlowMic
    // far end the desktop's owner IS the payer, so their allowance is already
    // the FIRST gate (`audio.handler.ts` `guard.ensureQuota(auth.userId)`) and
    // asking it again would judge one recording against one ledger twice.
    //
    // ⚠️ AND IN PRODUCTION THIS INPUT SHAPE CANNOT ARISE AT ALL SINCE MP-10:
    // `secondLedgerFor` passes the PAYER as `actingUserId`, and on an 'app' /
    // 'web' room the payer IS `pc_devices.user_id`. The branch is written out
    // in the function anyway, and this case pins it, so that the day something
    // starts writing `mobile_pairings.user_id` the second ledger does not come
    // back to life on a shape nobody decided.
    expect(pcOwnerQuotaGate({
      pcUserId: OWNER_A, actingUserId: ACCOUNT_B, roomKind: 'app', reader: anonymous,
    })).toBeNull();
    expect(pcOwnerQuotaGate({
      pcUserId: OWNER_A, actingUserId: ACCOUNT_B, roomKind: 'web', reader: anonymous,
    })).toBeNull();
  });

  it('🔴 an ANONYMOUS room owner is NOT asked', () => {
    // Without this the visitor who signs in is refused on the demo's spent
    // minutes for every sentence — the ruling says that clock stops applying.
    expect(pcOwnerQuotaGate({ pcUserId: DEMO, actingUserId: ACCOUNT_B, roomKind: 'demo', reader: anonymous }))
      .toBeNull();
  });

  it('🔴 a third-party host room is NOT asked — its owner is already the payer', () => {
    // Step 1 of the rule made T the payer; asking T again would judge one
    // recording against one ledger twice, and could refuse a visitor citing a
    // ceiling those very seconds are being written to.
    expect(pcOwnerQuotaGate({
      pcUserId: OWNER_T, actingUserId: OWNER_T, roomKind: 'integrator', reader: anonymous,
    })).toBeNull();
    // …and not merely because the two ids match: a signed-in visitor makes them
    // differ, and the answer must still be null.
    expect(pcOwnerQuotaGate({
      pcUserId: OWNER_T, actingUserId: ACCOUNT_B, roomKind: 'integrator', reader: anonymous,
    })).toBeNull();
  });

  it('the same owner, or none at all, was never a second ledger', () => {
    expect(pcOwnerQuotaGate({ pcUserId: ACCOUNT_B, actingUserId: ACCOUNT_B, roomKind: 'app', reader: anonymous })).toBeNull();
    expect(pcOwnerQuotaGate({ pcUserId: null, actingUserId: ACCOUNT_B, roomKind: 'app', reader: anonymous })).toBeNull();
  });

  it('🔴 the ONE input shape that still answers non-null — and nothing can produce it', () => {
    // A demo room whose `users.anonymous` reader is UNWIRED. It is the last
    // arrangement of arguments that reaches the bottom of the function, and it
    // is here as a MEASUREMENT rather than as a promise: `secondLedgerFor` can
    // only classify a room as 'demo' BY consulting that reader, so it cannot
    // hand this function these two facts together, and production always wires
    // the reader (`bootstrap-connection-handlers.ts`).
    //
    // ⇒ QTA-2's second ledger is unreachable, and with it the phone's
    // 「PC 主人额度不足」 copy (`judged_account:'pc_owner'`). MP-10 may not touch a
    // user-visible sentence and a protocol subtraction is the expensive
    // direction, so both are LEFT STANDING and registered for the follow-up
    // card that owns the copy. What this case exists to prevent is somebody
    // reading 「no test covers it」 as 「delete it」 while the wire field lives on.
    expect(pcOwnerQuotaGate({ pcUserId: DEMO, actingUserId: ACCOUNT_B, roomKind: 'demo' })).toBe(DEMO);
  });
});

describe('meteringPeerUserId — whose minutes the room target is shown', () => {
  it('🔴 an ANONYMOUS owner follows the microphones ledger', () => {
    expect(meteringPeerUserId({
      pcOwnerUserId: DEMO, actingUserId: ACCOUNT_B, reader: anonymous,
    })).toBe(ACCOUNT_B);
  });

  it('🔴 a real desktop signed into another account still reads its OWN ledger', () => {
    // Untouched by D1 ON PURPOSE, and this is the pair to the `payer` hint: A's
    // number is A's, it does NOT move while B speaks, and the frame says so in a
    // separate field rather than by handing A somebody else's balance.
    expect(meteringPeerUserId({
      pcOwnerUserId: OWNER_A, actingUserId: ACCOUNT_B, reader: anonymous,
    })).toBe(OWNER_A);
  });

  it('no owner resolved ⇒ the acting account, exactly as before this card', () => {
    expect(meteringPeerUserId({ pcOwnerUserId: null, actingUserId: ACCOUNT_B, reader: anonymous })).toBe(ACCOUNT_B);
  });

  it('an unwired reader keeps the pre-card answer (the demo owner)', () => {
    expect(meteringPeerUserId({ pcOwnerUserId: DEMO, actingUserId: ACCOUNT_B })).toBe(DEMO);
  });
});
