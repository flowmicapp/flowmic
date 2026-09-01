// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §1 (users table)
//   apps/server-core/src/http/ops-user-routes.ts (the ONE consumer)
//   apps/server-core/src/db/repos/user.repo.ts (`UserRecord`, and the note on
//     `UserPage.rows` that argues why this projection is a separate function)
//
// ── A VERBATIM MOVE (2026-08-31), NOT A REWRITE ─────────────────────────────
// `user.repo.ts` crossed the 800-line cap verify/lint/file-size.mjs enforces.
// This family — 「what the cross-account OPERATIONS surface is allowed to see of
// an account」 — came out whole: the doc block, `OpsUserView` and `toOpsUser`,
// character for character. Nothing was reworded and nothing was dropped; the
// arguments in that block are the evidence for why each column is present or
// ABSENT, and paraphrasing them would be deleting them slowly.
//
// It also earns its own file rather than merely fitting in one. The block it
// carries says in as many words that this projection exists BECAUSE the repo
// hands out whole records, and that the exclusion has to live somewhere a
// reviewer can see the full key list at a glance. A file boundary is the
// strongest version of that argument: `password_hash` is now absent from a
// module that never imports it, instead of absent from a function three hundred
// lines below one that does.
//
// ⚠️ The import goes ONE WAY (this file → user.repo.ts) and must stay that way,
// or verify:lint circular will say so. The consumer imports `toOpsUser` from
// here directly; `user.repo.ts` does not re-export it.

import { isAccountRestricted } from '../../auth/account-restriction';
import type { UserRecord } from './user.repo';

/**
 * A2-4 — what the cross-account OPERATIONS surface is allowed to see of an
 * account row. The whitelist is the object literal in {@link toOpsUser}; there is
 * no second copy of it anywhere.
 *
 * 🔴 WHY THIS LIVES IN THE REPO AND NOT IN THE ROUTE THAT SERVES IT.
 * `test/console-admin-gate-coverage.test.ts` asserts that exactly THREE files
 * under src/ mention `is_admin` — this one, the DDL, and the admin gate — so that
 * a fourth reader has to be argued for rather than merely typed. A projection
 * written in http/ops-user-routes.ts would be that fourth file, and the
 * instrument cannot tell 「a second admin gate was born」 from 「a console shows the
 * column」. A2-3 hit the same wall and made the same call (see
 * {@link isPlatformAccount}'s note on why it reads the column instead of the
 * route doing it). It also puts the projection beside `toRecord`, which is
 * already the ONE place these INTEGER columns become booleans.
 *
 * 🔴 `password_hash` IS ABSENT BY CONSTRUCTION, NOT BY DISCIPLINE — this is an
 * explicit key list, so a column added to `users` tomorrow cannot appear here on
 * its own. That is the whole of M2-7's remedy on a surface that, unlike
 * http/ops-routes.ts, genuinely holds `UserRecord`s.
 *
 * 🔴 `plan` IS ABSENT AND THAT IS M2-8, NOT AN OVERSIGHT. The stored column is a
 * MIRROR that is eventually consistent by construction (BillingService owns the
 * effective tier), so publishing it would answer "what tier is this account" with a value
 * nothing enforces on — and asking the authority instead means calling
 * `getPlan`, which WRITES (`getPlan → resolve → mirrorPlanColumn → setPlan`). A
 * list is a loop, so a list with a tier in it is a read-only page that rewrites a
 * column for every account it displays.
 */
export interface OpsUserView {
  /** The account's id — the only handle the rest of the ops surface speaks in
   *  (`ops_audit_log.target_id` carries it, and the restriction route takes it as
   *  `user_id`). */
  id: string;
  /** The operator's only human-readable identifier. NULLABLE and left that way:
   *  QR-minted accounts have no address, and '' would make "no email" look like a
   *  row that failed to load. */
  email: string | null;
  /** What the account calls itself. */
  display_name: string;
  /** Whether this account holds the operations bit. It is here because it
   *  CHANGES WHAT AN OPERATOR MAY DO to the row: the restriction route refuses a
   *  platform account, and without this field that refusal arrives as a surprise
   *  409 with no visible cause. */
  is_admin: boolean;
  /** The permanent exemption. Same reason as `is_admin` above — it is the OTHER
   *  half of `isPlatformAccount`, so "why can't this account be restricted" is answerable from
   *  the row rather than by trying it. It answers ONLY "is it exempted" and is never
   *  a tier (D1's standing rule). */
  permanent_free: boolean;
  /** "Is this account currently restricted from use" — computed by the ONE conversion function, so the
   *  operator's screen and the server's refusals cannot disagree about what a
   *  timestamp means. Mirrors what `publicUser` projects for the account holder. */
  restricted: boolean;
  /** "When was it restricted" — ms-since-epoch, or null. The RAW value, and it is here
   *  for the OPERATOR only: whether the account holder ever sees a start time is
   *  an open owner question, which is why `publicUser` projects the boolean above
   *  and not this number. */
  restricted_at: number | null;
  /** Q2 — the ENUMERATED reason the account holder is shown, or null. Here so an
   *  operator can see "which sentence this person was told" without opening the audit trail.
   *  🔴 The operator's own free text is deliberately NOT on this view either: it
   *  lives in `ops_audit_log.detail`, and a list screen is not an audit trail. */
  restriction_reason: string | null;
  /**
   * LOGIN-1 — "is THIS DEPLOYMENT recording sign-ins at all"
   * (这台部署到底记不记登录), i.e. the state of
   * `FLOWMIC_LOGIN_RECORD_ENABLED` (config.ts `loginRecordEnabled`).
   *
   * 🔴 IT IS A SECOND FIELD BECAUSE THERE ARE THREE STATES AND ONE NULLABLE
   * NUMBER ONLY ENCODES TWO. The operator acts differently on each:
   *   · `{login_recording:false, last_login_at:null}` → "we are not recording"
   *     (我们没在记) — the operator's next move is to ask owner for the switch,
   *     and NOTHING about this account can be concluded from the blank;
   *   · `{login_recording:true,  last_login_at:null}` → "recording, and this
   *     account has not signed in since it began" (在记，这个账号还没登录过) —
   *     a fact ABOUT THE ACCOUNT, and an actionable one;
   *   · `{login_recording:true,  last_login_at:<ms>}` → the observation.
   * Collapsing the first two onto one blank would show a dormant-looking account
   * on every deployment that simply never turned collection on — a blank
   * rendered as a finding.
   *
   * ⚠️ THE SWITCH STATE IS PUBLISHED HERE AND NOWHERE ELSE ON THE WIRE. The
   * account holder's own surfaces do not carry it (http/usage-events-routes.ts
   * makes the same call about its own switch: "that is a deployment fact an end
   * user is not owed"). An OPERATOR is owed it, because it is the difference
   * between a fact and an artefact on the screen they act from.
   */
  login_recording: boolean;
  /**
   * LOGIN-1 — "when did we last observe this account signing in", ms-since-epoch,
   * or null. The RAW value, like `restricted_at` above.
   *
   * 🔴 IT IS `null` WHENEVER `login_recording` IS FALSE, EVEN IF THE COLUMN HOLDS
   * A NUMBER. A deployment that recorded for a while and then had the switch
   * turned off still has stamps on disk, and publishing one under the words
   * "last login" would put an ARBITRARILY STALE date in front of an operator with
   * nothing on the screen to say the clock stopped. Withholding it is not hiding
   * a fact — it is refusing to answer a question this deployment can no longer
   * answer. {@link toOpsUser} is where that is enforced, so it cannot be
   * forgotten at a second response point.
   *
   * ⚠️ It is NOT device activity. `pc_devices.last_seen_at` /
   * `mobile_pairings.last_seen_at` answer "has that device been active", and a
   * PC that stays connected refreshes one of them daily for an account nobody
   * has signed into for months. Those two are still absent from this view.
   */
  last_login_at: number | null;
  /** When the account was created (the row's own TEXT timestamp, unmodified). */
  created_at: string;
}

/**
 * {@link OpsUserView} — THE whitelist, as the only place it is written down.
 *
 * 🔴 `loginRecording` IS A REQUIRED SECOND PARAMETER AND NOT AN OPTION WITH A
 * DEFAULT. A default would pick one of the three states for whoever forgot to
 * pass it, and the only safe default (`false`) would silently withhold a value
 * the deployment IS collecting — a response that under-reports while looking
 * complete. Required means a new response point cannot be added without deciding
 * where the switch state comes from, which is a compile error rather than a
 * review comment (book 13 §7 F1 ② — a DI default must be the real thing or a
 * throw, never a friendly empty).
 */
export function toOpsUser(u: UserRecord, loginRecording: boolean): OpsUserView {
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    is_admin: u.is_admin,
    permanent_free: u.permanent_free,
    restricted: isAccountRestricted(u.restricted_at),
    restricted_at: u.restricted_at,
    restriction_reason: u.restriction_reason,
    login_recording: loginRecording,
    // 🔴 THE WITHHOLDING IS HERE, at the one projection, and not at the two call
    // sites — the same argument this file's header makes about the whitelist
    // itself: two copies of the rule is how one of them keeps publishing a stale
    // stamp after collection stopped. See the field's doc for why a stale date is
    // worse than no date on this particular screen.
    last_login_at: loginRecording ? u.last_login_at : null,
    created_at: u.created_at,
  };
}
