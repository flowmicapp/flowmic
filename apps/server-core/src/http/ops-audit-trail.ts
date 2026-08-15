// SPEC-REF:
//   docs/strategy/2026-08-02-o2-usage-route-contract.md §1.3 (audit-trail conventions)
//   src/db/schema.ts `-- 10. ops_audit_log` (the DDL argues every column)
//   src/db/repos/ops-audit.repo.ts (append-only store; fail-loud on a blank row)
//   src/http/account-auth.ts `adminFromBearer` (THE admin gate — the DECISION)
//   CLAUDE.md red line: no silent failure / one value answers only one question / anti-façade
//   *** HUMAN-AUDIT SENSITIVE (auth + operator accountability) ***
//
// THE ADMIN GATE'S TRAIL — 0.2.48, the FIRST production writer of `ops_audit_log`.
//
// Until this file, `OpsAuditRepo.append` had zero production callers: the table,
// the DDL, the repo and its tests all existed and nothing ever wrote a row
// (0.2.47's handoff report §1 listed it as [NOT WIRED], and its own file header said so out
// loud). This module is what closes that — and the honest way to check that claim
// later is the same grep that header names: `opsAudit`/`audit.append` outside
// tests must come back NON-empty, and `test/ops-audit-wiring.test.ts` asserts it
// from the source tree so nobody has to remember to run it.
//
// ── WHY THE RECORDING LIVES HERE AND NOT IN account-auth.ts ─────────────────
// `adminFromBearer` answers ONE question: "is this Bearer an admin?". Writing a row
// is not part of answering it — a decision function that also has a database is a
// decision function you cannot call twice, cannot call from a test, and cannot
// read without wondering which half you are looking at. So the decision stays
// pure over there, and this module is the ONE place that turns a verdict into a
// row. (It also keeps `is_admin` confined to the three files
// test/console-admin-gate-coverage.test.ts allows: this file never reads it.)
//
// ── WHAT A ROW SAYS, AND WHAT IT CAN NEVER SAY ─────────────────────────────
// The gate knows exactly two things: WHO the Bearer proved, and WHICH ROUTE was
// being asked for. So a gate row says exactly that and no more:
//   action     'ops.admin.granted' | 'ops.admin.denied'
//   target     ('route', '<METHOD> <path>')
// It deliberately does NOT invent a business-level action like
// "billing.orphans.read": the gate does not know what a route MEANS, and a value
// that guesses is this repo's #1 shape (one value answering two questions). A route that wants to
// record "I changed this account's tier" appends its OWN row, in addition to this one.
//
// 🔴 NOT ONE BYTE THE CALLER SUPPLIED ENTERS THIS TABLE. `route` is typed as a
// member of ADMIN_GATED_ROUTES (below), so a query string, a body field or a raw
// `req.url` is not merely discouraged — it does not typecheck. This is deliberate
// belt-and-braces on the DDL's own rule ("detail only ever holds a sentence we
// wrote ourselves, and must never hold the raw request body"), and it matters here because the admin-gated route family sits
// next to /api/password/reset, whose body is a plaintext password.
//
// ── 🔴 401 LEAVES NO ROW, AND THAT ABSENCE MUST NOT BE READ AS EVIDENCE ─────
// `ops_audit_log.actor_user_id` is NOT NULL and its definition is "the users.id
// already **PROVEN** by the Bearer". An anonymous caller has no proven identity, so writing
// 'anonymous' (or the peer address, or '') into that column would be INVENTING an
// actor — precisely what the NOT NULL exists to prevent. The audit table answers
// "what did our own people do"; "someone is knocking at the door" is a different question and has a different
// home. So a 401 gets a WARN log line and no row.
//
// 🔴 THE COST OF THAT CHOICE, STATED SO NOBODY HAS TO DISCOVER IT:
// somebody hammering the ops routes with an invalid token IS INVISIBLE IN THIS
// TABLE. A future reader who queries `ops_audit_log`, finds nothing, and concludes
// "nobody ever knocked" has turned an ABSENCE INTO EVIDENCE — and "no silent failure" covers that
// case too. To see unauthenticated knocking, read the WARN lines
// `http: refused an unidentified admin caller` in the server log (server.log /
// FLOWMIC_LOG_PATH), NOT this table. If that ever needs to be queryable, it needs
// its OWN table with a nullable actor — not a fake row in this one.

import type { IncomingMessage } from 'node:http';
import type { OpsAuditInput } from '../db/repos/ops-audit.repo';
import { log } from '../log';
import { adminFromBearer, type AccountVerifier, type AdminVerdict } from './account-auth';
import { peerAddress } from './local-only';

/**
 * The WRITE side of `ops_audit_log`, as the one method this module needs.
 *
 * Structurally satisfied by `OpsAuditRepo` (db/connection.ts hands the real one
 * in). Typed as a slice rather than importing the repo interface for the same
 * reason presence-routes.ts slices `Registry`: this module must not be able to
 * reach `listRecent`, because a gate that can READ the trail is one refactor away
 * from being a gate that can decide things from it.
 */
export interface OpsAuditSink {
  append(input: OpsAuditInput): number;
}

/** `<domain>.<object>.<verb>` per the DDL. Two values, because the gate has two
 *  outcomes it can record. Exported so a reader (and a test) can name them
 *  without re-typing a string that would then be free to drift. */
export const ADMIN_GATE_GRANTED = 'ops.admin.granted';
export const ADMIN_GATE_DENIED = 'ops.admin.denied';
/** `target_kind` for both. The DDL keeps kind and id in TWO columns so that
 *  "list all actions against a route" is an equality match and not a LIKE prefix. */
export const ADMIN_GATE_TARGET_KIND = 'route';

/**
 * Every route that is allowed through {@link adminGate}, as literals we own.
 *
 * 🔴 THIS IS A TYPE FENCE, NOT A REGISTRY TO ADMIRE. Its job is to make "a caller
 * puts `req.url` (or a query string, or a body field) into `target_id`" a COMPILE
 * ERROR rather than a code-review question. That is the same technique T7 used
 * when it changed `resolveByok`'s parameter type instead of its logic: the defect
 * is made unrepresentable, not merely fixed.
 *
 * ⚠️ It can rot in exactly one direction — someone adds an admin route and forgets
 * to list it here — and that direction is CLOSED by the compiler (the `adminGate`
 * call will not typecheck). The other direction (a stale entry for a deleted
 * route) is closed by `test/console-admin-gate-coverage.test.ts`, which asserts
 * this array equals the set of routes its source-derived REGISTRY declares
 * `'admin'`. Two lists, maintained by different means, forced to agree.
 *
 * 🔴 EVERY ENTRY WAS A `GET` UNTIL 2026-08-12 (card A2-3), and that fact was
 * load-bearing for the failure policy in {@link recordGateOutcome}. It is no
 * longer true: `POST /api/ops/users/restrict` mutates. The sentence is kept
 * rather than deleted because it was TRUE when written and because the policy
 * paragraph below is what had to change in response — see it for the re-argued
 * version. `test/ops-audit-wiring.test.ts` still asserts the split (every entry
 * except the one named mutator is a GET), so a SECOND mutating admin route
 * cannot arrive without somebody re-reading that argument.
 */
export const ADMIN_GATED_ROUTES = [
  'GET /api/cloud/billing/orphans',
  'GET /api/ops/audit/recent',
  'GET /api/ops/usage/months',
  'GET /api/ops/usage/summary',
  'GET /api/ops/usage/users',
  // A2-4 — the cross-account account LIST and its single-account read. Both are
  // GETs, so both keep this module's serve-but-shout policy (the paragraph below
  // is argued for exactly this case). The detail route is a QUERY PARAMETER
  // rather than O-3's original `/:id` precisely so that these stay literals —
  // see http/ops-user-routes.ts §PATH SHAPE.
  'GET /api/ops/users',
  'GET /api/ops/users/detail',
  // A2-5 / REQ-12-08 — the ops-side twin of GET /api/cloud/usage/events. A GET,
  // so it keeps this module's serve-but-shout policy. 🔴 THE ACCOUNT ID IS A
  // QUERY PARAMETER (`?user_id=`) precisely so that this entry can stay a
  // literal — see http/ops-usage-events-routes.ts §PATH SHAPE. And note what the
  // ordering of this card taught: the literal could not be added on its own,
  // because until the route existed `test/console-admin-gate-coverage.test.ts`
  // would have killed it as a fence entry for a route nobody serves.
  'GET /api/ops/usage/events',
  // 2026-08-15 — first-party public-site aggregate reads (VPN ops console).
  'GET /api/ops/site/summary',
  'GET /api/ops/site/breakdown',
  // 🔴 A2-3 — THE FIRST MUTATING ENTRY. It does not rely on this module's
  // serve-but-shout policy: it writes its OWN business row first and refuses to
  // touch the account if that write fails (http/account-restriction-routes.ts).
  'POST /api/ops/users/restrict',
] as const;

/** The admin-gated routes that CHANGE something. Exported so the failure-policy
 *  assertion in `test/ops-audit-wiring.test.ts` can name them instead of
 *  hard-coding a second copy, and so this module's own policy paragraph has a
 *  greppable referent rather than a claim about another file. */
export const MUTATING_ADMIN_GATED_ROUTES: readonly AdminGatedRoute[] = ['POST /api/ops/users/restrict'];

/** `'<METHOD> <path>'` for one of the routes above. Nothing else is expressible. */
export type AdminGatedRoute = (typeof ADMIN_GATED_ROUTES)[number];

/**
 * Append one gate row — and NEVER let the append take the request down with it.
 *
 * 🔴 THE CHOICE, AND WHY IT IS THIS ONE. Two honest options existed: (a) fail the
 * request when the trail cannot be written, (b) serve the request and shout about
 * the failure. This is (b), and the argument is bounded by a fact that is checked
 * rather than asserted:
 *
 *   every route whose GATE ROW this function writes is a `GET`, EXCEPT the one
 *   named in {@link MUTATING_ADMIN_GATED_ROUTES} — and
 *   `test/ops-audit-wiring.test.ts` fails if that stops being true.
 *
 * For a read-only surface, (a) converts "the audit table is unwritable" into "the
 * ops console is down": an operator loses the ability to LOOK at the platform at
 * exactly the moment something is wrong with the database. That trade is bad, and
 * the thing (a) would protect — an unrecorded action — did not change anything.
 *
 * 🔴 THE MOMENT AN ADMIN-GATED ROUTE MUTATES, THIS POLICY MUST BE RE-ARGUED, and
 * the argument above is what expires: an unrecorded *change* is a different animal
 * from an unrecorded *read*.
 *
 * ✅ THAT MOMENT ARRIVED ON 2026-08-12 (card A2-3, `POST /api/ops/users/restrict`),
 * AND THE RE-ARGUMENT LANDED — but NOT here, and the placement is the whole point.
 * This function keeps (b), because the five reads it also serves still deserve it
 * and this paragraph must not silently take that away from them. The mutating
 * route instead writes its OWN business row, BEFORE the write, in the (a) shape:
 * if that append throws, the account is left untouched and the operator gets a
 * 503 (http/account-restriction-routes.ts, whose header carries the full
 * argument and the residual risk). So "a change goes unrecorded" is impossible, and
 * "the ops console won't open" is still avoided — two policies because there are two questions.
 * ⚠️ CONSEQUENCE, STATED: a mutating route CAN lose its route-level GATE row
 * (this function swallowed that) while its business row lands. The trail then
 * says WHAT changed but not that the gate admitted it. That is the cheaper half
 * to lose, and it is a stated cost rather than an accident.
 * ⚠️ The 0.2.47-era sentence "there is no mutating ops route today because owner
 * ruled 'changing an account's tier from the ops side is not being done for now'"
 * (docs/decisions/2026-08-02-owner-stt-pool-groups-and-
 * ops-phase1-scope.md §1) is kept as history: it was true, and changing an account's tier is STILL not
 * done. Restriction is a different ruling (owner-web-rulings/latest.md:71), not
 * a widening of that one.
 *
 * 🔴 IT IS NOT SILENT (CLAUDE.md red line: no silent failure, BOTH directions). The failure
 * goes out at ERROR with the actor, the route and the driver's own message, and
 * `test/ops-audit-wiring.test.ts` proves the shout happens by making the sink
 * throw — with a positive control that the same route logs nothing when the sink
 * works, so a spy that sees "one error" cannot be a spy that sees everything.
 */
function recordGateOutcome(audit: OpsAuditSink, input: OpsAuditInput, route: AdminGatedRoute): void {
  try {
    audit.append(input);
  } catch (err) {
    log.error('ops_audit_log: append FAILED — the request was served but NOT recorded', {
      route,
      action: input.action,
      actor: input.actor_user_id,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * THE admin gate WITH its trail — what every admin-gated route calls.
 *
 * The verdict is `adminFromBearer`'s, verbatim and unmodified: this function adds
 * a row, never a condition. If it ever grows one, there are two admin gates, and
 * two gates is how one of them starts admitting what the other rejects.
 *
 * ⚠️ Call this, not `adminFromBearer`, from a route. A route that calls the bare
 * decision is correctly gated and silently untraceable — which is worse than an
 * ungated route, because it LOOKS right. `test/ops-audit-wiring.test.ts` asserts
 * that `adminFromBearer`'s only callers in src/ are this file (and that this file
 * has at least one route caller), so that mistake cannot land quietly.
 */
export function adminGate(
  req: IncomingMessage,
  verifier: AccountVerifier,
  audit: OpsAuditSink,
  route: AdminGatedRoute,
): AdminVerdict {
  const verdict = adminFromBearer(req, verifier);

  if (verdict.ok) {
    recordGateOutcome(
      audit,
      {
        actor_user_id: verdict.userId,
        action: ADMIN_GATE_GRANTED,
        target_kind: ADMIN_GATE_TARGET_KIND,
        target_id: route,
      },
      route,
    );
    return verdict;
  }

  if (verdict.status === 403) {
    // The actor IS proven here — this caller authenticated fine and simply is not
    // an admin. That the 403 branch of `AdminVerdict` carries `userId` while the
    // 401 branch does not is not a convenience: it is the type saying which of the
    // two refusals HAS an actor, so this function cannot ask for one that does not
    // exist (see account-auth.ts's note on that union).
    recordGateOutcome(
      audit,
      {
        actor_user_id: verdict.userId,
        action: ADMIN_GATE_DENIED,
        target_kind: ADMIN_GATE_TARGET_KIND,
        target_id: route,
      },
      route,
    );
    return verdict;
  }

  // 401 — no proven actor, so NO ROW (file header explains why inventing one would
  // defeat the column's NOT NULL). The log line is the whole record of this event,
  // and it is the ONLY place unauthenticated knocking on the ops surface is
  // visible. Same shape as `refuseUnidentified`'s line, deliberately with a
  // DIFFERENT message so "who is knocking on the ops surface" can be grepped apart from "who is knocking on the billing gateway".
  log.warn('http: refused an unidentified admin caller', {
    route,
    reason: verdict.error,
    peer: peerAddress(req) || 'unknown',
  });
  return verdict;
}
