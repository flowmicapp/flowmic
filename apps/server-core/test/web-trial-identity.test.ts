// Card R-1 — the rule, and the thing the rule stores.
//
// SPEC-REF:
//   docs/strategy/2026-09-10-web-room-release-and-unsigned-limit-design.md
//     §2.2 (mechanism) / §2.3 (failure directions and reverse controls ①②)
//   src/auth/web-trial-identity.ts · src/auth/metering-principal.ts
//
// ── WHAT THIS FILE PROVES AND WHAT IT DELIBERATELY DOES NOT ────────────────
// It proves the DECISION (which of the three conditions decided this admission)
// and the REUSE (a second unsigned admission spends what the first minted,
// rather than collecting a second grant). Both are answerable without a server.
//
// It does NOT prove that a page therefore sees `mode:'trial'` and runs out of
// minutes — that spans five layers, and asserting it here would be asserting the
// fake. Golden G28 does it against a real relay, and its reverse controls are
// the ones design §2.3 asks for.

// ── 🔴 REVERSE CONTROL, MEASURED RED (2026-09-11, card R-1b) ──────────────
// Marker `REVERSE-CONTROL-B`: `resolve` handed the ledger `deviceUid: null`
// instead of `input.mobile.device_uid` — i.e. the identity keyed on the PAIRING
// ROW, which is what card R-1 shipped and what owner §10 corrects.
//   RED here (2 of 24): 「🔴 THE BROWSER IS THE KEY: a NEW pairing row with the
//   SAME uid gets the SAME identity」 and 「hands the ledger the BROWSER uid, not
//   the pairing id」.
//   RED in the site-demo golden too, which is the one that says what a visitor sees:
//   「the SAME browser …, on a NEW pairing row, was told 120000 ms remain — want 0」.
// Restored; `grep -rn REVERSE-CONTROL-B apps/server-core/src` = 0, all green.

import { describe, it, expect } from 'vitest';
import {
  webTrialDecision,
  makeWebTrialIdentities,
  isWebPairing,
} from '../src/auth/web-trial-identity';
import { meteringPrincipal } from '../src/auth/metering-principal';

/** The literal the protocol's `client` column carries for a browser end. Spelled
 *  once here — the production side never spells it (see `isWebPairing`). */
const WEB = 'web';

const REAL_OWNER = 'user-real-owner';
const DEMO_OWNER = 'anon-demo-owner';
const ACCOUNT = 'user-signed-in';

/** `users.anonymous` for this fixture: one demo identity, everything else real. */
const reader = (id: string): boolean => id.startsWith('anon-');

const base = {
  client: WEB,
  account: null,
  trialUserId: null,
  mayMint: true,
  // 🔴 CARD MP-6 CHANGED THIS ONE LINE FROM 'app' TO 'demo', AND THAT IS THE
  // CARD. R-1's shape was 「an unsigned browser paired to somebody's REAL
  // desktop」; under owner §11 that visitor spends the desktop owner's allowance
  // and no grant is minted at all. The one room a grant still belongs to is
  // FlowMic's own site demo, where it is a per-browser CAP on an account
  // FlowMic pays for. The browser-ness still lives on `client`, a different
  // column answering a different question (who paired), and keeping those two
  // apart is still the point.
  roomKind: 'demo' as const,
};

describe('isWebPairing — a row that says nothing is an APP row', () => {
  it("reads the column through the protocol's one author of the default", () => {
    expect(isWebPairing(WEB)).toBe(true);
    expect(isWebPairing('app')).toBe(false);
    // 🔴 THE CASE THAT MATTERS: every pairing minted before the `client` column
    // existed is NULL, and reading NULL as a browser would hand a two-minute
    // trial identity to every one of them.
    expect(isWebPairing(null)).toBe(false);
    // A kind a newer end names is not this one either.
    expect(isWebPairing('kiosk')).toBe(false);
  });
});

describe('webTrialDecision — the three conditions, one at a time', () => {
  it('mints for an unsigned WEB pairing in a real account\'s room', () => {
    expect(webTrialDecision(base)).toEqual({ kind: 'mint' });
  });

  it('🔴🔴 MP-6 — an APP handset in a DEMO room gets a cap too: the ROOM decides, not the client', () => {
    // 🔴 THE INVERSE OF WHAT THIS TEST ASSERTED, and it is design §10-1 step 3
    // read literally: that step is about the far end and says nothing about what
    // is holding the microphone. An App phone really can pair into a demo room
    // (golden G26 does exactly that), and without a cap it would be billed to
    // FlowMic's demo account with no per-device ceiling at all — the one shape
    // §10-4 exists to prevent.
    expect(webTrialDecision({ ...base, client: 'app' })).toEqual({ kind: 'mint' });
    // A row paired before the `client` column existed is 'app' by the protocol's
    // one author of that default — and lands on the same answer, for the same
    // reason. The column no longer decides anything here.
    expect(webTrialDecision({ ...base, client: null })).toEqual({ kind: 'mint' });
    // …and the ROOM still does: the very same handset outside a demo room gets
    // nothing. Without this line the two assertions above would be equally true
    // of a rule that had simply stopped checking.
    expect(webTrialDecision({ ...base, client: 'app', roomKind: 'app' })).toEqual({ kind: 'none' });
  });

  it('does nothing when the socket carries a verified account (W4-05 owns that case)', () => {
    expect(webTrialDecision({ ...base, account: { userId: ACCOUNT } })).toEqual({ kind: 'none' });
    // …including when the row already has an identity: signing in outranks it,
    // and the identity stays on the row for a later unsigned visit.
    expect(webTrialDecision({ ...base, account: { userId: ACCOUNT }, trialUserId: 'anon-1' }))
      .toEqual({ kind: 'none' });
  });

  it('🔴🔴 MP-6 — a real desktop room mints NOTHING; the room owner pays for the guest', () => {
    // 🔴 THIS ASSERTION IS THE EXACT INVERSE OF THE ONE IT REPLACED, which read
    // 「does nothing inside a SITE-DEMO room — that visitor already has a grant」
    // and passed `pairedUserId: DEMO_OWNER`. Its argument (card M4-01 already
    // rationed that visitor, so a second identity would ration one visit twice)
    // was true of the model owner §11 replaced. Under §11 the demo room's spend
    // is billed to a REAL account, so the anonymous identity is not anybody's
    // allowance any more and there is no second answer to collide with.
    //
    // What the flip takes away, asserted as the thing it is: an unsigned browser
    // on somebody's own computer gets no FlowMic minutes at all.
    expect(webTrialDecision({ ...base, roomKind: 'app' })).toEqual({ kind: 'none' });
    expect(webTrialDecision({ ...base, roomKind: 'web' })).toEqual({ kind: 'none' });
  });

  it('reuses the identity the row already names', () => {
    // 🔴 NO READER IS CONSULTED, AND SINCE MP-6 THERE IS NO READER TO CONSULT.
    // The column can only ever hold a live anonymous id (one writer; ON DELETE
    // SET NULL empties it when the sweep takes the identity), and 「is this a
    // demo room」 is now answered once per admission by `roomKindOf` and shared
    // with the payer rule instead of being re-derived here.
    expect(webTrialDecision({ ...base, trialUserId: 'anon-7' }))
      .toEqual({ kind: 'reuse', userId: 'anon-7' });
  });

  it('🔴 a far end this build cannot classify mints nothing', () => {
    // `null` is a `room_kind` written by a NEWER build, and it may be a host
    // page. It falls out of the same `!== 'demo'` condition as every other
    // non-demo far end rather than naming itself — one condition, one answer.
    expect(webTrialDecision({ ...base, roomKind: null })).toEqual({ kind: 'none' });
  });

  it('never mints on a leg that may not write (the reconnect leg / a replica)', () => {
    expect(webTrialDecision({ ...base, mayMint: false })).toEqual({ kind: 'none' });
    // …but it still SPENDS one the writer minted.
    expect(webTrialDecision({ ...base, mayMint: false, trialUserId: 'anon-7' }))
      .toEqual({ kind: 'reuse', userId: 'anon-7' });
  });
});

/**
 * A ledger keyed the way owner §10 keys the real one — BY BROWSER IDENTITY — so
 * the assertions below can tell 「found the identity this browser already had」
 * from 「minted a second one」.
 *
 * ⚠️ IT IS A FAKE, AND IT PROVES NOTHING ABOUT THE ARITHMETIC. What the number
 * is, and that no day re-opens it, is pinned in trial-ledger.test.ts against the
 * real repos and a real sqlite file; what a page is actually told is pinned in
 * the site-demo golden. This one exists to answer one question: WHICH KEY did this module hand
 * the ledger. A fake keyed on the pairing id would have made the per-uid
 * assertion below pass against a per-pairing implementation.
 */
function fakeLedger() {
  const byUid = new Map<string, { userId: string; grantedMs: number }>();
  const minted: { userId: string; ipBucket: string; grantedMs: number; deviceUid: string | null }[] = [];
  const reuses: string[] = [];
  return {
    minted,
    reuses,
    claim(input: {
      deviceUid: string | null; ipBucket: string; nowMs: number; tokenTtlMs: number;
      newId(): string; newToken(): string;
    }) {
      const uid = input.deviceUid?.trim() ?? '';
      const existing = uid === '' ? undefined : byUid.get(uid);
      if (existing) {
        reuses.push(existing.userId);
        return {
          ...existing, token: input.newToken(), usedMs: 0, remainingMs: existing.grantedMs,
          grantsUsedToday: 0, expiresAtMs: input.nowMs + input.tokenTtlMs, reused: true,
        };
      }
      const out = {
        userId: input.newId(),
        token: input.newToken(),
        grantedMs: 120_000,
        usedMs: 0,
        remainingMs: 120_000,
        grantsUsedToday: 0,
        expiresAtMs: input.nowMs + input.tokenTtlMs,
        reused: false,
      };
      if (uid !== '') byUid.set(uid, { userId: out.userId, grantedMs: out.grantedMs });
      minted.push({
        userId: out.userId, ipBucket: input.ipBucket, grantedMs: out.grantedMs,
        deviceUid: input.deviceUid,
      });
      return out;
    },
    grantedMsFor: () => 0,
  };
}

function harness() {
  const ledger = fakeLedger();
  const rows = new Map<string, string | null>();
  let n = 0;
  const identities = makeWebTrialIdentities({
    trials: ledger,
    mobiles: { setTrialUser: (id, trial) => { rows.set(id, trial); } },
    ipSalt: 'test-salt',
    tokenTtlMs: 3_600_000,
    newId: () => `anon-minted-${(n += 1)}`,
    newToken: () => `fm_${n}`,
    now: () => 1_757_000_000_000,
  });
  return { ledger, rows, identities };
}

describe('makeWebTrialIdentities — ONE identity per browser (owner §10)', () => {
  const admission = (over: Partial<Parameters<ReturnType<typeof harness>['identities']['resolve']>[0]> = {}) => ({
    client: WEB,
    account: null,
    mayMint: true,
    // card MP-6 — a grant belongs to the SITE DEMO's room and to no other.
    roomKind: 'demo' as const,
    mobile: {
      id: 'pairing-a',
      trial_user_id: null as string | null,
      device_uid: 'wb-aaaa' as string | null,
    },
    ip: '203.0.113.7',
    ...over,
  });

  it('mints once and persists it to the pairing row', () => {
    const { rows, identities, ledger } = harness();
    expect(identities.resolve(admission())).toBe('anon-minted-1');
    expect(rows.get('pairing-a')).toBe('anon-minted-1');
    expect(ledger.minted).toHaveLength(1);
    expect(ledger.minted[0]?.grantedMs).toBe(120_000);
  });

  it('🔴 a SECOND admission of the same instance reuses it — it does not collect a second grant', () => {
    // This is design §2.3 reverse control ②, as a unit: drop the persistence and
    // every unsigned admission is a fresh 120 s, which is an unbounded demo
    // wearing a two-minute label. The golden asserts the same fact through
    // `remaining_ms`, which is what the visitor actually sees.
    const { identities, ledger } = harness();
    const first = identities.resolve(admission());
    const again = identities.resolve(admission({
      mobile: { id: 'pairing-a', trial_user_id: first, device_uid: 'wb-aaaa' },
    }));
    expect(again).toBe(first);
    expect(ledger.minted).toHaveLength(1);
  });

  it('🔴 THE BROWSER IS THE KEY: a NEW pairing row with the SAME uid gets the SAME identity', () => {
    // owner §10 — 「只要不清空浏览器缓存就要记住」. This is the case the pre-ruling
    // implementation got wrong and NOTHING else caught: revoke the pairing (the
    // owner presses 「断开」, the sweep takes it, the visitor scans a second
    // computer) and the browser used to collect a fresh two minutes, because the
    // reuse key was `mobile_pairings.trial_user_id` and that row was gone.
    const { identities, ledger } = harness();
    const first = identities.resolve(admission());
    const afterRepair = identities.resolve(admission({
      mobile: { id: 'pairing-REPAIRED', trial_user_id: null, device_uid: 'wb-aaaa' },
    }));
    expect(afterRepair).toBe(first);
    expect(ledger.minted).toHaveLength(1);
    expect(ledger.reuses).toEqual([first]);
  });

  it('hands the ledger the BROWSER uid, not the pairing id — the key is falsifiable', () => {
    // Positive control for the case above: 「same identity」 could also come from
    // a fake that ignores its input entirely, so assert WHAT was passed.
    const { identities, ledger } = harness();
    identities.resolve(admission());
    expect(ledger.minted[0]?.deviceUid).toBe('wb-aaaa');
  });

  it('a DIFFERENT browser is a different visitor, with its own two minutes', () => {
    const { identities, ledger } = harness();
    identities.resolve(admission());
    identities.resolve(admission({
      mobile: { id: 'pairing-b', trial_user_id: null, device_uid: 'wb-bbbb' },
    }));
    expect(ledger.minted.map((m) => m.grantedMs)).toEqual([120_000, 120_000]);
    expect(ledger.reuses).toEqual([]);
  });

  it('still buckets by network, because the ABUSE caps read that and nothing else does', () => {
    // The bucket no longer prices anybody's grant (owner §10). It is still
    // derived and still passed, and the caps in http/web-anon-routes.ts are why:
    // a hash per admission would make every visitor their own network.
    const { identities, ledger } = harness();
    identities.resolve(admission());
    identities.resolve(admission({
      mobile: { id: 'pairing-b', trial_user_id: null, device_uid: 'wb-bbbb' },
    }));
    expect(new Set(ledger.minted.map((m) => m.ipBucket)).size).toBe(1);
    identities.resolve(admission({
      mobile: { id: 'pairing-c', trial_user_id: null, device_uid: 'wb-cccc' },
      ip: '198.51.100.9',
    }));
    expect(new Set(ledger.minted.map((m) => m.ipBucket)).size).toBe(2);
  });

  it('a row that declares no browser uid still gets an identity (an older web build)', () => {
    const { identities, ledger } = harness();
    expect(identities.resolve(admission({
      mobile: { id: 'pairing-old', trial_user_id: null, device_uid: null },
    }))).toBe('anon-minted-1');
    expect(ledger.minted[0]?.deviceUid).toBeNull();
  });

  it('a ledger that throws falls back to TODAY, loudly — never to unlimited', () => {
    const identities = makeWebTrialIdentities({
      trials: { claim: () => { throw new Error('writer unreachable'); } },
      mobiles: { setTrialUser: () => { throw new Error('must not be reached'); } },
      ipSalt: 's', tokenTtlMs: 1, newId: () => 'x', newToken: () => 'y',
    });
    expect(identities.resolve(admission())).toBeNull();
  });
});

describe('meteringPrincipal — which account an unsigned web pairing spends', () => {
  const web = { pcUserId: REAL_OWNER, mobileUserId: REAL_OWNER, roomKind: 'app' as const, reader };
  const DEMO_PAYER = 'user-flowmic-demo';

  it('🔴🔴 MP-6 — an unsigned web pairing on a REAL desktop spends the DESKTOP OWNER, not a grant', () => {
    // 🔴 THE INVERSE OF WHAT THIS TEST ASSERTED YESTERDAY, which expected
    // `anon-7` and called billing the PC owner 「every second of an unsigned
    // visit billed to somebody who did not press anything」. That was R-1's
    // ruling; owner §11 overrides it, and the reason it gives is that the grant
    // was a cost nobody could look up. The owner CAN be looked up, and is told
    // (`billing:budget.guest_speaker`) — which is the half that makes the new
    // answer defensible rather than merely cheaper.
    //
    // 🔴 THE STALE IDENTITY IS PASSED IN ON PURPOSE: a row minted before this
    // card still carries one, and it must not decide anything.
    expect(meteringPrincipal({ ...web, account: null, trialUserId: 'anon-7' }))
      .toEqual({
        userId: REAL_OWNER, switched: false, reason: 'peer', integratorKeyId: null, capUserId: null,
        speakerRef: null, speakerSignedIn: false,
      });
  });

  it('the same answer when there is no identity at all', () => {
    expect(meteringPrincipal({ ...web, account: null, trialUserId: null }))
      .toEqual({
        userId: REAL_OWNER, switched: false, reason: 'peer', integratorKeyId: null, capUserId: null,
        speakerRef: null, speakerSignedIn: false,
      });
  });

  it('🔴🔴 MP-10 — a verified account does NOT outrank a FlowMic far end; it only changes the word', () => {
    // 🔴 THIS CASE WAS TITLED 「a verified account outranks everything, from
    // that admission on」 AND EXPECTED `ACCOUNT`. owner's 2026-09-11 凌晨 再追认
    // (「「已登录用户默认也是扣对端」也包括自家 PC」) bills the desktop's owner
    // whether or not the visitor signed in. What signing in still buys is on the
    // decision, not on the bill: `reason` stays 'peer' rather than becoming
    // 'self', `speakerRef` names the ACCOUNT rather than a browser uid, and
    // `speakerSignedIn` is what the owner's frame turns into a sentence.
    //
    // `switched` stays FALSE: the target end is a real desktop and is always told
    // about its OWN account, so nothing on its screen moved — and a frame here
    // would be counted by golden G10.
    expect(meteringPrincipal({ ...web, account: { userId: ACCOUNT }, trialUserId: 'anon-7' }))
      .toEqual({
        userId: REAL_OWNER, switched: false, reason: 'peer', integratorKeyId: null, capUserId: null,
        speakerRef: ACCOUNT, speakerSignedIn: true,
      });
  });

  it('W4-05 is untouched: a signed-in phone in a DEMO room still switches the meter', () => {
    expect(meteringPrincipal({
      pcUserId: DEMO_OWNER, mobileUserId: DEMO_OWNER, roomKind: 'demo', reader,
      account: { userId: ACCOUNT }, trialUserId: null, demoPayerUserId: DEMO_PAYER,
    })).toEqual({
      userId: ACCOUNT, switched: true, reason: 'self', integratorKeyId: null, capUserId: null,
      speakerRef: ACCOUNT, speakerSignedIn: true,
    });
  });

  it('🔴 MP-6 — an UNSIGNED site-demo visitor spends the DEMO ACCOUNT, capped by their own grant', () => {
    expect(meteringPrincipal({
      pcUserId: DEMO_OWNER, mobileUserId: DEMO_OWNER, roomKind: 'demo', reader,
      account: null, trialUserId: 'anon-7', deviceUid: 'wb-1234', demoPayerUserId: DEMO_PAYER,
    })).toEqual({
      userId: DEMO_PAYER, switched: false, reason: 'demo', integratorKeyId: null, capUserId: 'anon-7',
      speakerRef: 'wb-1234', speakerSignedIn: false,
    });
  });

  it('🔴🔴 THE APP-PAIRING CELL, WHICH HAS NOW BEEN ASSERTED THREE WAYS IN TWO DAYS', () => {
    // Kept as one case with its whole history, because the history is the
    // interesting part and each rewrite was a RULING rather than a bug fix:
    //
    //   · before MP-0 — expected REAL_OWNER, with a comment arguing that on an
    //     App row `mobile.user_id` is a declaration a handshake JWT must not
    //     redirect. The premise was true and the conclusion was wrong, because NO
    //     CALLER EVER SETS `PairInput.user_id`: what it protected was 「bill the
    //     computer's owner for whatever a signed-in guest says into their
    //     machine」, written down as the spec. (0.2.52's law, third sighting.)
    //   · MP-0 — expected ACCOUNT, on owner §9 「谁说扣谁」.
    //   · MP-10 — expects REAL_OWNER AGAIN, on owner's 2026-09-11 凌晨 再追认
    //     「「已登录用户默认也是扣对端」也包括自家 PC」.
    //
    // ⚠️ THE FIRST AND THE THIRD NAME THE SAME ACCOUNT AND ARE NOT THE SAME
    // ASSERTION, and mistaking them for one would undo this card by 「reverting a
    // flip-flop」. The old one billed A because the speaker's JWT was never
    // consulted — `reason` was 'self' and `speakerRef` was null, so the ledger
    // could not say who had spoken. This one bills A because owner says the far
    // end pays, and the row records BOTH facts: `reason:'peer'` and the
    // speaker's own account in `speakerRef`.
    expect(meteringPrincipal({
      pcUserId: REAL_OWNER, mobileUserId: REAL_OWNER, roomKind: 'app', reader,
      account: { userId: ACCOUNT }, trialUserId: 'anon-7',
    })).toEqual({
      userId: REAL_OWNER, switched: false, reason: 'peer', integratorKeyId: null, capUserId: null,
      speakerRef: ACCOUNT, speakerSignedIn: true,
    });
  });

  it('🔴 card MP-0 / D3 — a third-party host room mints NOTHING and bills its owner for a GUEST', () => {
    // Two halves of one ruling (§9-1), and each is a separate way to give away
    // money if it is missing. ⚠️ THE SECOND HALF NARROWED WITH MP-6: it is the
    // host's UNSIGNED visitors it pays for. A signed-in FlowMic user on the same
    // page now pays for themselves (owner §11), which the matrix test pins.
    expect(webTrialDecision({ ...base, roomKind: 'integrator' })).toEqual({ kind: 'none' });
    expect(meteringPrincipal({
      pcUserId: 'user-integrator-T', mobileUserId: 'user-integrator-T', roomKind: 'integrator', reader,
      account: null, trialUserId: 'anon-7',
    })).toEqual({
      userId: 'user-integrator-T', switched: false, reason: 'host', integratorKeyId: null, capUserId: null,
      speakerRef: null, speakerSignedIn: false,
    });
  });
});

// ⚠️ `describe('card NR-29 — willMint …')` STOOD HERE AND IS GONE (card MP-6).
// It drove a seam that no longer exists: the handset-slot exemption used to be
// read off `trial_user_id`, a column written a moment AFTER the ceiling was
// checked, so the rule had to be asked one step early and without writing.
// MP-6 moved the exemption onto `client`, which `registry.pairMobile` writes
// itself — there is nothing left to ask early, and the predicate is now covered
// where it lives (`test/device-limits.test.ts` 「web pairings take NO mobile
// slot」) plus end-to-end in `verify/golden/g26-site-demo.mjs`.

