// verify/golden/g26-site-demo-fixtures.mjs
//
// G26's module-level fixtures, moved out of `g26-site-demo.mjs` VERBATIM on
// 2026-09-12 — not one character of the block below changed, only the `export`
// keywords and this header are new. Same shape and same reason as
// `recovery_leg_wire.dart`'s split from its mother file: g26 stood at 798 of
// the 800-line source cap, so the next card to touch it had to split it first,
// and this card is that card (it made every wait in the scenario event-driven).
//
// WHY THIS SEAM. Everything here answers 「what is this scenario made of」 — the
// seeded numbers and why each one is the number it is, the two accounts, the
// browser identity, and the local stand-in for Cloudflare's siteverify. Nothing
// here decides anything about the product; the scenario itself, which does, is
// still one file. Each constant keeps the paragraph that justifies it, because
// those paragraphs are the evidence that the figures were measured, not picked.

import { createServer } from 'node:http';

/**
 * How much of the visitor's 120 s grant is left after seeding — the CAP.
 *
 * 🔴 IT IS NO LONGER THE THING THAT ENDS THE RECORDING, and that is card MP-6.
 * Before it, this number was the session's whole ceiling (the anonymous identity
 * was the payer). Now it bounds the number a page may render a clock for
 * (`budget-push.ts` `view` takes the lower of the two reads) while the DEMO
 * ACCOUNT's allowance is what the session deadline is armed on — so the two
 * ceilings are seeded separately and each is asserted where it shows.
 *
 * 4 000 rather than a round 120 000/2: `msUsedByUser` stores minutes and rounds
 * back to ms, and 116 000 ms is exactly 1.933… minutes, so the read comes back
 * at 4 000 with no float dust to hide a real drift in.
 */
export const CAP_REMAINING_MS = 4_000;
/** The seeded head-room on the DEMO ACCOUNT — the ceiling that really stops the
 *  recording. The same trick and the same reason as G24: small enough to run in
 *  seconds, large enough for the heartbeat to fire inside it. Deliberately a
 *  DIFFERENT number from the cap: an assertion that would pass on either ledger
 *  is not an assertion about which ledger was spent. */
export const SEEDED_BUDGET_MS = 1_500;
/** Leg G26-b: the same trick on the SIGNED-IN account's own allowance, so that
 *  half of the run also reaches its ceiling in seconds. A third distinct number,
 *  for the third distinct ledger. */
export const ACCOUNT_BUDGET_MS = 2_100;
export const ACCOUNT_EMAIL = 'g26b-account@flowmic.test';
/** FlowMic's own account, the one owner §11 asks the site demo's spend to land
 *  on. A real registered users row, not a marker: `resolvePayer` step 3 meters
 *  to it and `QuotaGuard` reads its plan. */
export const DEMO_PAYER_EMAIL = 'g26-flowmic-demo@flowmic.test';
export const HEARTBEAT_MS = 300;
export const SITE_ORIGIN = 'http://localhost:5173';

/**
 * Card NR-31 — the FREE plan's monthly minutes, pushed onto this server through
 * the production override path (`FLOWMIC_PLAN_LIMITS`).
 *
 * 🔴 DELIBERATELY NOT 20. The default table says 20, so a fixture using it would
 * pass just as happily against a relay answering from a compiled-in literal —
 * the exact defect the field exists to remove from the web client. A number no
 * source file contains can only have come from the effective table.
 *
 * 🔴 IT IS ALSO THE POSITIVE CONTROL FOR THE CAP (section 8): the demo account
 * holds 43 minutes, the browser's cap is four seconds, so a `view()` that forgot
 * to take the lower of the two answers 2 580 000 rather than 4 000.
 *
 * ⚠️ THESE ASSERTIONS MOVED HERE FROM G29, which MP-6 retired: `mode:'trial'`
 * now exists in one room kind, so the site demo is the only surface that can
 * carry `free_plan_minutes` at all.
 */
export const FREE_PLAN_MINUTES = 43;
export const PLAN_MS = FREE_PLAN_MINUTES * 60_000;

/**
 * The browser's own uid and the instance id it derives, computed the way the
 * product computes it — see G25's note on why this is derived and not pasted.
 *
 * 🔴 ONE UID FOR BOTH ENDS OF THE DEMO, the product's shape rather than a
 * shortcut: the visitor's browser is what asked for the identity over HTTP and
 * what holds the microphone. `trial-ledger.claim` keys on it, so the pairing
 * REUSES that identity instead of writing a second one — which is what keeps
 * 「exactly one anonymous row」 meaningful all the way down.
 */
export const BROWSER_UID = 'wb-fedcba9876543210';
export const BROWSER_INSTANCE_ID = `web-${BROWSER_UID.replace(/^[a-z]{2}-/, '').slice(0, 8)}`;

export const POOL = JSON.stringify([{
  id: 'g26-unreachable', provider: 'custom-openai-compatible', model: 'g26',
  api: 'http://127.0.0.1:9/v1', api_key: 'g26', enabled: true, priority: 1,
}]);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const budgets = (rec) => rec.frames.filter((f) => f.event === 'billing:budget').map((f) => f.args[0]);


/** Cloudflare's siteverify, locally. The REAL verifier posts to it. */
export function startSiteverifyStub() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        // `success` follows the token, so the negative control below exercises
        // the SAME code path a real failed solve does.
        res.end(JSON.stringify({ success: !body.includes('response=bad') }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
