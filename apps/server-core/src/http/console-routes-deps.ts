// SPEC-REF:
//   ./console-routes.ts (the routes this describes the wiring for, and the file
//     this interface was lifted VERBATIM out of)
//   ./router-deps.ts (the SAME split, made on 2026-08-12 for the same reason —
//     its own header carries the argument, and usage-events-census.test.ts
//     records why a census narrowed to one file after a split stops covering
//     what it was built for)
//
// Card MP-12 (2026-09-11) — `ConsoleRoutesDeps`, and nothing else.
//
// ── WHY IT MOVED ───────────────────────────────────────────────────────────
//
// `console-routes.ts` stood at 796 of the 800-line cap (verify/lint `file-size`)
// and this card adds ONE dep to it. The interface is the largest thing in that
// file that is not a route: 112 lines of types and of the arguments for why each
// dep is required rather than optional. Nothing else came with it — the guards,
// the gates and every handler stayed exactly where they were.
//
// 🔴 NO BEHAVIOUR MOVED, AND NOTHING RUNS HERE. This file is types only, so the
// import back from `console-routes.ts` is erased at compile time and there is no
// runtime cycle to reason about.
//
// ⚠️ `console-routes.ts` RE-EXPORTS IT, so every existing
// `import { type ConsoleRoutesDeps } from './console-routes'` — a dozen tests,
// `router-deps.ts`, `bootstrap-http-deps.ts` — keeps working unchanged. That is
// the point of doing it this way rather than rewriting the importers: a split
// made to buy line budget must not also be a rename.

import type { AuthService } from '../auth/auth-service';
import type { RegisterRateLimiter } from '../auth/register-rate-limit';
import type { BillingService } from '../billing/billing-service';
import type { BillingRepo } from '../db/repos/billing.repo';
import type { UsageEventsRepo } from '../db/repos/usage-events.repo';
import type { PcRepo } from '../db/repos/pc.repo';
import type { MobileRepo } from '../db/repos/mobile.repo';
import type { SettingsRepo } from '../db/repos/settings.repo';
import type { UsageRepo } from '../db/repos/usage.repo';
import type { UserRepo } from '../db/repos/user.repo';
import type { IntegratorKeyRepo } from '../db/repos/integrator-key.repo';
import type { RoomLookup } from './console-device-routes';
import type { OpsAuditSink } from './ops-audit-trail';
import type { EmailVerifiedReader } from '../auth/email-verification';
import type { PasswordResetMailer } from '../mail';

export interface ConsoleRoutesDeps {
  auth: AuthService;
  billing: BillingService;
  /** D1 §6.2 — the `billing_events` ledger behind GET /api/cloud/billing/events.
   *
   *  A SEPARATE dep from `billing` above even though both are "billing": that one
   *  is the SERVICE that decides "what tier is this user on", this one is the STORE that
   *  remembers "which webhooks we've received". Folding the read into BillingService
   *  would put a second responsibility on the file whose whole point is to answer
   *  exactly one question. Required, not optional — an absent ledger would make
   *  the reconciliation page render "no events yet" for an account that has plenty,
   *  which is a lie the compiler can prevent. */
  billingLedger: BillingRepo;
  /**
   * 0.2.48 — where the admin gate's trail goes (`ops_audit_log`).
   *
   * REQUIRED, with no `?` and no default, and that is the whole point: book 13 §7
   * F1 ② (a DI default is the real thing or a throw, never a friendly empty). An
   * optional sink would mean a bootstrap missing one line still serves
   * /billing/orphans perfectly — just with nobody able to say who read it — and
   * there would be no new symbol to grep and nothing red to notice. Making it
   * required turns that omission into a compile error.
   *
   * Typed as the WRITE slice (`OpsAuditSink`), not the repo: nothing in this file
   * has any business reading the trail back.
   */
  opsAudit: OpsAuditSink;
  pcs: PcRepo;
  mobiles: MobileRepo;
  /** card MP-1 — the integrator's publishable keys, for the delegated key
   *  routes. Absent on a deployment that serves no integrations, in which case
   *  those routes decline the request rather than answering an empty list. */
  integratorKeys?: IntegratorKeyRepo;
  /** card MP-12 — the per-event log, for the ONE aggregate the delegated key
   *  routes read from it (`refused_count`). Declared here because this file
   *  hands its whole deps object to `tryHandleConsoleIntegratorRoutes`: that
   *  file states what the slice is for and why it is a slice. Absent ⇒ the
   *  field is omitted, never reported as 0. */
  usageEvents?: Pick<UsageEventsRepo, 'countRefusalsByKey'>;
  /**
   * 2026-08-28 (owner §5-1) — live room membership, for the ONE question
   * `pc_devices.is_online` must not be asked: "is this computer here right now".
   * The SAME store the socket handlers hold, so the console cannot grow a second
   * definition of presence; the judgement itself is `pcPresence()` in
   * room/pc-presence.ts and this file only calls it.
   *
   * REQUIRED (book 13 §7 F1 ②): optional would mean a bootstrap missing one line
   * still serves the device list, just with every row silently reading absent —
   * and "absent" is the state that ENABLES removal, so the failure would hand
   * users a working remove button for computers that are running.
   */
  store: RoomLookup;
  /** This node's own id — see ConsoleDeviceRoutesDeps.nodeId. Absent = single node. */
  nodeId?: string | null;
  settings: SettingsRepo;
  /**
   * 0.3.0 P4 — the account row itself, for the ONE route that destroys it
   * (POST /api/account/delete → `users.remove`).
   *
   * REQUIRED, with no `?` and no default (book 13 §7 F1 ②). An optional repo would
   * mean a bootstrap missing one line still MOUNTS the deletion route, which
   * would then throw per request — a GDPR obligation that answers 500 while the
   * console shows a button. Making it required turns that omission into a compile
   * error at the one object literal that has to change.
   */
  users: UserRepo;
  /** 0.3.0 P4 — the account's monthly usage rows for GET /api/account/export
   *  (`usage.listByUser`). The privacy policy names 「monthly usage totals」 among
   *  the things a user may have back; `billing.getQuota` answers only "this month",
   *  which is a different question and a shorter answer. Required for the same
   *  reason as `users` above. */
  usage: UsageRepo;
  /** Per-IP throttle for the password reset surface — same discipline as the
   *  register/login limiter (5 / 10-min), a SEPARATE bucket so a legitimate
   *  reset never starves the login budget (and vice-versa). */
  passwordLimiter: RegisterRateLimiter;
  /**
   * 🔴 MAIL-1 — the channel that carries a reset token to the human.
   *
   * REQUIRED, with no `?` and no default, for the reason `opsAudit` above is:
   * an optional mailer would let a bootstrap missing one line still mount
   * `/api/password/forgot`, which would mint a token, persist it, answer 200 and
   * deliver nothing — with no new symbol to grep and nothing red to notice.
   *
   * Declared here (and not only on `PasswordResetRoutesDeps`) because this file
   * hands its whole deps object to `tryHandlePasswordResetRoutes`: the subset
   * interface is what the routes READ, this is where the composition root has to
   * SUPPLY it. See http/password-reset-routes.ts for the full argument, and
   * mail/unconfigured.ts for what a deployment without mail env actually gets.
   */
  mail: PasswordResetMailer;
  /**
   * VERIFY-1 D3 — the verified-email gate's reader (owner 2026-08-11: the first
   * console sign-in offers nothing but verification; the SERVER holds the door,
   * the UI only paints it).
   *
   * REQUIRED, with no `?` and no default (book 13 §7 F1 ② — the same argument as
   * `opsAudit`/`mail` above): an optional reader would let a bootstrap missing
   * one line serve every console feature to unverified accounts, with no new
   * symbol to grep and nothing red to notice. bootstrap wires
   * `db.emailVerification` — the SAME instance the confirm route writes
   * through, so the gate cannot disagree with the confirm that opens it.
   */
  verifiedEmail: EmailVerifiedReader;
  /** WP-W1b: fan a console REST settings write out to the user's online sockets
   *  (bootstrap wires this to settings.handler broadcastUpdated with no origin
   *  socket) — keeps save-on-change peer sync semantics identical across channels.
   *  Absent (unit tests) → no fan-out, write still lands. */
  broadcastSettingsUpdated?: (userId: string, payload: { key: string; value: unknown }) => void;
  /** ms-since-epoch clock; defaults to Date.now. Injectable for TTL tests. */
  now?: () => number;
}
