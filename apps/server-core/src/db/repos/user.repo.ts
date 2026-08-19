// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §1 (users table), §7 (Cloud KEY / plan)
//   Ported mechanism from legacy apps/server/src/db/connection-factories.ts
//   (email NOCASE normalize, UNIQUE→typed constraint error). Contract (types,
//   plan values) is from @flowmic/protocol per the legacy-source-reference policy.

import type { DatabaseSync } from 'node:sqlite';
import { isPlan, type Locale, type Plan } from '@flowmic/protocol';
// A2-4 — the ONE `restricted_at` → verdict conversion, borrowed rather than
// re-derived for `toOpsUser` below. A repo reaching into auth/ has a precedent
// in this same directory (settings.repo.ts imports auth/crypto's envelope), and
// the alternative here is strictly worse: a second `!== null` written for the
// operator's view is a second answer to "is this account restricted", which is the one
// question auth/account-restriction.ts exists to answer exactly once.
import { isAccountRestricted } from '../../auth/account-restriction';

export interface UserRecord {
  id: string;
  email: string | null;
  password_hash: string | null;
  display_name: string;
  plan: Plan;
  locale: Locale;
  is_admin: boolean;
  /** Window D1 §3.1 — owner's private-domain exemption bit (`users.permanent_free`, INTEGER 0/1).
   *  It answers ONLY "is this account permanently exempted". It is NOT a plan and NOT a source:
   *  BillingService is the single place that turns it into a PlanView
   *  (`source:'permanent_free'`, D1 §6.1). Nothing else may read it to decide a
   *  tier. */
  permanent_free: boolean;
  /** VERIFY-1 — ms-since-epoch when the console verification gate opened for
   *  this account; null = unverified. Carried RAW (not as a boolean) because
   *  the one NULL/number → verdict conversion is auth/email-verification.ts
   *  `isEmailVerified`, and a boolean here would be a second conversion site.
   *  ⚠️ For a grandfathered account this is the MIGRATION stamp, never a
   *  verification moment — db/schema.ts owns that argument. */
  email_verified_at: number | null;
  /** A2-3 — ms-since-epoch when an operator restricted this account; null = not
   *  restricted. Carried RAW (not as a boolean) for the reason its sibling above
   *  is: the one NULL/number → verdict conversion is auth/account-restriction.ts
   *  `isAccountRestricted`, and a boolean here would be a second conversion site.
   *  ⚠️ It answers ONLY "is this account restricted from use" — never "which tier" (plan),
   *  "is it exempted" (permanent_free) or "has the email been verified" (email_verified_at). db/schema.ts
   *  owns the argument for each of those three refusals. */
  restricted_at: number | null;
  /** Q2 — WHICH publishable reason this account was restricted for: a key from
   *  `RESTRICTION_REASONS` (@flowmic/protocol), or null.
   *
   *  🔴 IT IS NEVER THE OPERATOR'S FREE TEXT. That string lives in
   *  `ops_audit_log.detail` and answers "why we internally did this"; this answers "what
   *  we're going to tell this person", and the Terms promise only the second. db/schema.ts owns the
   *  full argument.
   *
   *  Typed `string | null` and NOT `RestrictionReason | null`, deliberately: it
   *  is a free-text SQLite column, so narrowing it here would be an unchecked
   *  claim about bytes on disk (book 13 §7 F1 ⑤ — the same trap `plan` fell into).
   *  The membership test happens at the WRITE route, where an untrusted value
   *  actually arrives; a value that predates the enum reads back as itself and
   *  a client that does not recognise it renders nothing. */
  restriction_reason: string | null;
  /** LOGIN-1 — ms-since-epoch of the most recent SIGN-IN recorded for this
   *  account; null = none recorded.
   *
   *  🔴 IT IS NOT `last_seen_at` AND IT IS NOT ACTIVITY. It moves only when a
   *  credential was presented and a session was minted — the enumerated list of
   *  those moments is auth/auth-service.ts `recordSignIn`, which is also the
   *  only writer. Token verification, which happens on nearly every request,
   *  deliberately does NOT move it; db/schema.ts owns that argument.
   *
   *  ⚠️ null has TWO causes and this field cannot tell them apart: nobody has
   *  signed in since recording began, or recording was never on
   *  (`FLOWMIC_LOGIN_RECORD_ENABLED` defaults OFF). Anything that DISPLAYS this
   *  value has to carry the switch state beside it, which is why
   *  {@link OpsUserView} has two fields where the record has one. */
  last_login_at: number | null;
  created_at: string;
}

export interface UserInsertInput {
  id: string;
  email?: string | null;
  password_hash?: string | null;
  display_name?: string;
  plan?: Plan;
  locale?: Locale;
  is_admin?: boolean;
}

export class UserConstraintError extends Error {
  constructor(public readonly field: 'email' | 'id', message: string) {
    super(message);
    this.name = 'UserConstraintError';
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A2-4 — default page size for {@link UserRepo.listPage}. */
export const OPS_USER_PAGE_DEFAULT = 50;

/**
 * A2-4 — hard cap on {@link UserRepo.listPage}.
 *
 * A SEPARATE pair from `USAGE_PAGE_DEFAULT`/`USAGE_PAGE_MAX` even though the two
 * numbers agree today, on the precedent `AUDIT_RECENT_MAX` already set in
 * ops-routes.ts: those bound a per-month usage page, these bound the account
 * table itself. Two questions that happen to share an answer are still two
 * questions, and sharing the constant would make raising one raise the other by
 * accident.
 */
export const OPS_USER_PAGE_MAX = 200;

/** Keyset page request for {@link UserRepo.listPage}. */
export interface UserPageRequest {
  /** Rows per page. Defaults to {@link OPS_USER_PAGE_DEFAULT}, hard-capped at
   *  {@link OPS_USER_PAGE_MAX}. A non-integer or <= 0 THROWS (it cannot mean
   *  anything); a too-large value is clamped HERE as defence in depth, while the
   *  HTTP boundary refuses it outright — see ops-user-routes.ts `parseLimit`. */
  limit?: number;
  /** Cursor: the `next_after_user_id` of the previous page. Omit for page 1. */
  after_user_id?: string;
  /** Case-insensitive CONTAINS match over `email` and `display_name`. Omit for
   *  no filter; `''` is not a value this repo accepts as 「everything」 (the
   *  route refuses it before it gets here). */
  q?: string;
}

/** One page of account rows. */
export interface UserPage {
  /**
   * FULL records, `password_hash` included — this is a repo, and every other
   * read here returns the same shape.
   *
   * 🔴 THAT IS WHY THE PROJECTION IS A SEPARATE, EXPORTED FUNCTION
   * ({@link toOpsUser}) AND NOT A NARROWER RETURN TYPE HERE. `findById` also
   * hands out a whole record and the ops detail route needs it, so a repo that
   * projected only on this one method would leave TWO shapes for "an account row
   * shown to the ops surface" and only one of them safe. One row shape out of the repo, one
   * projection into the response, and a test that asserts on the serialized body.
   */
  rows: UserRecord[];
  /**
   * Cursor for the next page, or `null` when this page is provably the last.
   *
   * Computed by fetching `limit + 1` and trimming — NOT by `rows.length < limit`,
   * which is wrong exactly when the final page is exactly full and fails in the
   * direction that hands out a cursor forever. Same probe-row technique, and the
   * same "must not count rows" rule, as `UsageRepo.listUsersForMonth`.
   */
  next_after_user_id: string | null;
}

export interface UserRepo {
  insert(input: UserInsertInput): UserRecord;
  findByEmail(email: string): UserRecord | null;
  findById(id: string): UserRecord | null;
  setPlan(id: string, plan: Plan): UserRecord | null;
  /** Overwrite the password hash (R5-WEB WP-W1 console reset). Additive method,
   *  writes the EXISTING password_hash column only — no schema migration. The
   *  new hash takes effect on the very next verifyCredentials read, so the old
   *  password is dead immediately (already-issued stateless JWTs still ride out
   *  their 7-day TTL — 0.1.0 internal ruling: no jti denylist). */
  setPassword(id: string, password_hash: string): UserRecord | null;
  /**
   * Window D1 §3.4 — mark/unmark the permanent-free exemption (owner's private-domain account).
   *
   * Deliberately does NOT touch `users.plan`: the two answer different questions
   * ("is this account exempted" vs "what tier did this account buy") and mirroring one into the
   * other is how a revoked exemption would leave a fake 'pro' behind. The
   * effective tier is computed, in one place, by BillingService (D1 §6.1).
   */
  setPermanentFree(userId: string, value: boolean): void;
  /**
   * A2-3 — set (a ms-epoch) or clear (null) the "restricted from use" state.
   *
   * A PLAIN SETTER, deliberately: it does not decide whether the write should
   * happen. Idempotency ("once restricted, restricting again must not overwrite the first timestamp" — the design's §3.2)
   * is a ROUTE decision, because only the route knows the current row it just
   * read and what it is about to tell the operator. A repo that silently
   * declined to overwrite would make "I wrote it" and "the value changed" two different facts
   * with one return value, and this method returns nothing to tell them apart.
   *
   * 🔴 IT TOUCHES ONE COLUMN. `plan`, `permanent_free` and `is_admin` are not in
   * the statement and must never join it: a restriction that also moved a tier
   * would hand the billing face a change nobody made (the same argument
   * `setPermanentFree` above makes about `plan`, in the other direction).
   */
  setRestricted(userId: string, restrictedAt: number | null, reason: string | null): void;
  /**
   * LOGIN-1 — stamp `users.last_login_at` for one account.
   *
   * 🔴 THIS METHOD DOES NOT KNOW ABOUT THE SWITCH, DELIBERATELY. The
   * `FLOWMIC_LOGIN_RECORD_ENABLED` test lives in auth/auth-service.ts
   * `recordSignIn`, one layer up, for the reason db/repos/usage-events.repo.ts
   * states about its own: a repo that silently no-ops when a flag is off is a
   * write method that sometimes does not write, and every future caller would
   * have to already know that. Here the method always writes; the ONE place that
   * decides whether writing is allowed is the ONE place that calls it.
   *
   * 🔴 ONE COLUMN IN THE SET LIST, like `setRestricted` above and for the same
   * reason: a reviewer must be able to see that recording a sign-in cannot move
   * a tier, an exemption, an admin bit or a restriction. It is also why this is
   * not folded into some `touchUser` — a method that stamps "activity" would be
   * the very blur this column was created to avoid.
   *
   * 🔴 NOT IDEMPOTENT AND NOT FIRST-WRITER-WINS — the OPPOSITE of
   * `setRestricted`, whose whole point is that restricting twice keeps the first
   * timestamp. "Last login" means the LATEST one, so every sign-in overwrites.
   * The two are adjacent and behave in opposite directions on purpose.
   */
  stampLastLogin(userId: string, at: number): void;
  /**
   * 0.3.0 P4 — DESTROY the account row. Irreversible, and it takes the account's
   * whole child graph with it.
   *
   * 🔴 THE DELETION IS THE `users` ROW AND NOTHING ELSE, ON PURPOSE. Every table
   * that holds this account's data declares `REFERENCES users(id) ON DELETE
   * CASCADE` (db/schema.ts), and the connection opens with
   * `enableForeignKeyConstraints: true`, so SQLite removes pc_devices /
   * mobile_pairings / user_settings / usage_records / timeline_blobs /
   * paddle_subscriptions itself — including the chained case (a pairing whose
   * `user_id` is NULL dies with its owning pc_devices row). Hand-writing six
   * DELETEs beside this one would be a SECOND answer to "which tables must be
   * deleted to delete an account", and the
   * copy that forgets tomorrow's seventh table is the one that would silently
   * leave data behind. The single-source list, with its per-table verdict, is
   * `USER_CASCADING_TABLES` in http/account-lifecycle.ts, and
   * test/account-lifecycle.test.ts re-derives it from `PRAGMA foreign_key_list`
   * so the constant cannot drift away from the schema.
   *
   * ⚠️ TWO TABLES DO NOT CASCADE AND THAT IS DELIBERATE, NOT AN OVERSIGHT:
   * `billing_events` (its DDL argues why it carries no FK — an unclaimable event
   * must still leave a trace) and `ops_audit_log` ("an audit record that can be
   * deleted is not an audit record"). They are named in `USER_RETAINED_TABLES` and reported on the delete
   * response, so what survives is stated rather than discovered.
   *
   * Returns whether a row was actually removed — an already-deleted account is a
   * truthful `false`, never a thrown error and never a fake `true`.
   */
  remove(id: string): boolean;
  listAll(): UserRecord[];
  /**
   * A2-4 — "which accounts exist on the platform", one keyset page at a time, optionally filtered.
   *
   * Ordered by `id ASC`: it is the PRIMARY KEY's own order (so the keyset
   * `id > ?` seeks instead of scanning) and it is stable while accounts are being
   * created underneath a paging operator. Deliberately NOT `created_at` order,
   * which `listAll` uses — that column is a TEXT timestamp with no uniqueness
   * guarantee, so two accounts minted in the same millisecond would give the
   * cursor an ambiguous position and silently skip or repeat a row.
   *
   * 🔴 IT EXISTS BECAUSE `listAll()` CANNOT BE THE OPS LIST. `listAll` loads
   * every account row into memory at once (fine for the boot-time settings
   * backfill that calls it, a cliff with no warning as the table grows) and it
   * cannot filter. Reusing it for a paged, searchable console surface would mean
   * paging in JavaScript over a full table read, i.e. a page size that bounds the
   * RESPONSE and nothing else.
   */
  listPage(page?: UserPageRequest): UserPage;
}

/**
 * "Is this the platform's own account" — the owner's private account and anyone holding the
 * operations bit.
 *
 * 🔴 THIS IS NOT AN ADMIN GATE, and the difference is the reason it is written
 * here rather than anywhere near one. THE admin gate is
 * `http/account-auth.ts adminFromBearer`, it answers "is this an admin", and it decides
 * who may READ across accounts. This predicate decides nothing and opens nothing:
 * both its consumers make a DESTRUCTIVE OR IRREVERSIBLE-LOOKING action harder on
 * a `true` — the account-deletion guard requires an extra explicit
 * acknowledgement, and A2-3's restriction route (http/account-restriction-
 * routes.ts) refuses outright. It deliberately ORs in `permanent_free` precisely
 * so it can never be mistaken for the admin decision — the two have different
 * answers for an exempt non-admin, and one value must not carry both questions.
 *
 * ⚠️ A2-3 USES IT INSTEAD OF READING `is_admin` DIRECTLY, and that is a
 * deliberate deviation from the superseded ban design's §3.3-C2 ("C2 judges
 * using `is_admin` alone"), for two measured reasons:
 *   ① `test/console-admin-gate-coverage.test.ts` asserts that exactly THREE
 *      files in src/ contain `is_admin` (this one, the DDL, and the gate). A
 *      fourth reader turns that red BY DESIGN — the instrument cannot tell a
 *      target guard from a second admin gate, and the honest move is to not
 *      become a fourth reader rather than to widen the list;
 *   ② this function's own paragraph above says a predicate over these two
 *      columns written anywhere else would be a second reading of the same
 *      storage. Restriction is the second consumer that paragraph anticipated.
 * 🔴 THE BEHAVIOURAL COST, STATED: because of the OR, an account that is
 * `permanent_free=1, is_admin=0` also cannot be restricted from the console.
 * That is STRICTLY conservative (it refuses an action, never permits one) and it
 * is reversible out-of-band by whoever has the VPS, exactly like granting
 * `is_admin`. If owner ever wants exempt-but-not-admin accounts restrictable,
 * that is a ruling and a separate predicate — not a quiet widening of this one.
 *
 * It lives beside `toRecord` because that is the ONE place these two INTEGER
 * columns become booleans; a predicate over them written anywhere else would be
 * a second reading of the same storage.
 *
 * ⚠️ owner's account is `permanent_free=1, is_admin=1` (D1: 41 accounts, exactly
 * one). Deleting it would take the platform's own devices, settings and usage
 * with it, and nothing in this product could put it back.
 */
export function isPlatformAccount(user: Pick<UserRecord, 'is_admin' | 'permanent_free'>): boolean {
  return user.is_admin || user.permanent_free;
}

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

function toRecord(r: Record<string, unknown>): UserRecord {
  return {
    id: r.id as string,
    email: (r.email as string | null) ?? null,
    password_hash: (r.password_hash as string | null) ?? null,
    display_name: r.display_name as string,
    // Primary-owner human review 2026-08-01 (D1): was `r.plan as Plan` — an unchecked cast on a
    // free-text SQLite column, i.e. a claim the compiler cannot check (book 13 §7
    // F1 ⑤). It was survivable while `Plan` had two members and only this code
    // ever wrote the column; it stops being survivable the moment the tier set
    // widens, because a row carrying a tier this build does not know would be
    // handed out as a valid `Plan` and reach the quota table as a missing key.
    // Falling back to 'free' is the fail-CLOSED direction: an unreadable tier
    // must never resolve to a paid one.
    plan: isPlan(r.plan) ? r.plan : 'free',
    locale: r.locale as Locale,
    is_admin: Number(r.is_admin ?? 0) === 1,
    // 🔴 THE one INTEGER→boolean conversion for this column, in the one function
    // every UserRecord in the process comes out of (insert/findById/findByEmail/
    // setPlan/setPassword/listAll all return through here). A second conversion
    // site is how `'0'`/`0`/`false` start disagreeing across call sites — and the
    // column is INTEGER precisely so that this line is `=== 1` and not a bare
    // truthiness test. See ADDITIVE_INT_COLUMNS in ../schema.ts.
    permanent_free: Number(r.permanent_free ?? 0) === 1,
    // VERIFY-1 — raw column, no verdict here (see the field's own doc above).
    email_verified_at: typeof r.email_verified_at === 'number' ? r.email_verified_at : null,
    // A2-3 — raw column, same discipline: the verdict is
    // auth/account-restriction.ts `isAccountRestricted` and nowhere else. The
    // `typeof === 'number'` test (rather than `?? null`) is what makes a row
    // from a database that predates the column read as NOT restricted — the
    // fail-OPEN direction here is the correct one, because the alternative is
    // restricting an account nobody restricted.
    restricted_at: typeof r.restricted_at === 'number' ? r.restricted_at : null,
    // Q2 — raw column, same discipline as the two above: no verdict here, and no
    // narrowing to the enum (see the field's own doc). `typeof === 'string'`
    // rather than `?? null` so a legacy row, or a row whose column predates this
    // change, reads as "no reason recorded" instead of some coerced value.
    restriction_reason: typeof r.restriction_reason === 'string' ? r.restriction_reason : null,
    // LOGIN-1 — raw column, no verdict here, same discipline as the three above.
    // `typeof === 'number'` rather than `?? null` so a row from a database that
    // predates the column reads as "no sign-in recorded" instead of coercing
    // some other value into a date — and note that here there is no fail-open /
    // fail-closed direction to pick, because the honest answer and the safe
    // answer are the same one: we did not record it.
    last_login_at: typeof r.last_login_at === 'number' ? r.last_login_at : null,
    created_at: r.created_at as string,
  };
}

/**
 * A2-4 — an operator's search term as a LIKE pattern, with the pattern
 * metacharacters in it neutralised.
 *
 * 🔴 THE ESCAPE IS THE POINT, NOT THE `%…%` WRAPPING. `%` and `_` are wildcards
 * to SQLite and ordinary characters to the person typing: an unescaped `%`
 * turns 「find the account whose name contains a percent sign」 into 「return every
 * account」, and the result is indistinguishable on screen from a search that
 * worked. `\` is escaped first and by the same pass, so the escape character
 * itself cannot be smuggled in to disarm the next one.
 */
function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function makeUserRepo(db: DatabaseSync): UserRepo {
  const ins = db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, plan, locale, is_admin)
     VALUES (?,?,?,?,?,?,?)`,
  );
  const byEmail = db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE');
  const byId = db.prepare('SELECT * FROM users WHERE id=?');
  const updPlan = db.prepare('UPDATE users SET plan=? WHERE id=?');
  const updPassword = db.prepare('UPDATE users SET password_hash=? WHERE id=?');
  const updPermanentFree = db.prepare('UPDATE users SET permanent_free=? WHERE id=?');
  // A2-3. ONE column in the SET list, and that is load-bearing rather than
  // tidy: this statement is the entire write face of "restrict usage", so a reviewer
  // reading it can see that restricting an account cannot move its tier, its
  // exemption or its admin bit. `test/account-restriction.test.ts` asserts the
  // other three columns are byte-identical after the route runs.
  // Q2 — TWO columns now, and they move TOGETHER in one statement on purpose:
  // "is it restricted" and "on what grounds" must never be settable apart, or a release
  // could leave a stale reason behind that a later restriction would then be
  // reported under. Still no `plan`, no `permanent_free`, no `is_admin` — the
  // property `test/account-restriction.test.ts` asserts is unchanged.
  const updRestricted = db.prepare('UPDATE users SET restricted_at=?, restriction_reason=? WHERE id=?');
  // LOGIN-1. ONE column in the SET list, same load-bearing reason as the
  // statement above: this is the entire write face of「record a sign-in」, and a
  // reviewer reading it can see that a login cannot move a tier, an exemption,
  // an admin bit or a restriction. `test/last-login-record.test.ts` asserts the
  // other columns are byte-identical after a sign-in runs.
  const updLastLogin = db.prepare('UPDATE users SET last_login_at=? WHERE id=?');
  // 0.3.0 P4. The ONE statement that destroys an account. It touches exactly one
  // table; the FK cascade does the rest (see UserRepo.remove above for why there
  // are deliberately no sibling DELETEs here).
  const delUser = db.prepare('DELETE FROM users WHERE id=?');
  const allUsers = db.prepare('SELECT * FROM users ORDER BY created_at ASC');
  // A2-4 — the ops list, as FOUR statements rather than one string built per
  // call. Two axes (first page / after a cursor) × (unfiltered / `q`), each
  // prepared once at construction like every other statement in this file. A
  // concatenated WHERE clause would put caller-influenced text in the SQL even
  // when the value itself is bound, and the reader would have to prove it did
  // not; four literals cost four lines and prove it by having no seam.
  //
  // 🔴 `id ASC` in all four, and the `LIMIT ?` is always the caller's limit PLUS
  // ONE — that extra row is the probe whose presence is the only honest evidence
  // that another page exists (see UserPage.next_after_user_id).
  const pageFirst = db.prepare('SELECT * FROM users ORDER BY id ASC LIMIT ?');
  const pageAfter = db.prepare('SELECT * FROM users WHERE id > ? ORDER BY id ASC LIMIT ?');
  // 🔴 `COLLATE NOCASE` ON BOTH SIDES OF THE OR, and it is not decoration.
  // `findByEmail` matches `email=? COLLATE NOCASE`, so an operator who types
  // `Owner@Example.com` finds the account through THAT path; a search that folded
  // case differently would answer "not found" for an account this same repo can find
  // — and on a console screen "we couldn't find it" and "it doesn't exist" are the same picture with
  // opposite next actions. SQLite's LIKE is already ASCII-case-insensitive by
  // default, but that default is a PRAGMA away from changing and it is not the
  // property being relied on; naming the collation makes the intent greppable and
  // ties it to `findByEmail`'s.
  // ⚠️ Both fold ASCII only. A search for 「ÉLODIE」 will not match 「élodie」, and
  // that is a stated limit of the collation, not a bug in this query.
  const SEARCH = "(COALESCE(email,'') LIKE ? ESCAPE '\\' COLLATE NOCASE"
    + " OR display_name LIKE ? ESCAPE '\\' COLLATE NOCASE)";
  const pageFirstQ = db.prepare(`SELECT * FROM users WHERE ${SEARCH} ORDER BY id ASC LIMIT ?`);
  const pageAfterQ = db.prepare(`SELECT * FROM users WHERE id > ? AND ${SEARCH} ORDER BY id ASC LIMIT ?`);

  return {
    insert(input): UserRecord {
      const email = input.email == null ? null : normalizeEmail(input.email);
      try {
        ins.run(
          input.id,
          email,
          input.password_hash ?? null,
          input.display_name ?? 'User',
          input.plan ?? 'free',
          input.locale ?? 'zh-CN',
          input.is_admin ? 1 : 0,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/users\.email/i.test(msg)) throw new UserConstraintError('email', `email already exists: ${email ?? ''}`);
        if (/users\.id/i.test(msg)) throw new UserConstraintError('id', `id already exists: ${input.id}`);
        throw err;
      }
      return toRecord(byId.get(input.id) as Record<string, unknown>);
    },
    findByEmail(email): UserRecord | null {
      const r = byEmail.get(normalizeEmail(email)) as Record<string, unknown> | undefined;
      return r ? toRecord(r) : null;
    },
    findById(id): UserRecord | null {
      const r = byId.get(id) as Record<string, unknown> | undefined;
      return r ? toRecord(r) : null;
    },
    setPlan(id, plan): UserRecord | null {
      updPlan.run(plan, id);
      const r = byId.get(id) as Record<string, unknown> | undefined;
      return r ? toRecord(r) : null;
    },
    setPassword(id, password_hash): UserRecord | null {
      updPassword.run(password_hash, id);
      const r = byId.get(id) as Record<string, unknown> | undefined;
      return r ? toRecord(r) : null;
    },
    setPermanentFree(userId, value): void {
      updPermanentFree.run(value ? 1 : 0, userId);
    },
    stampLastLogin(userId, at): void {
      updLastLogin.run(at, userId);
    },
    setRestricted(userId, restrictedAt, reason): void {
      updRestricted.run(restrictedAt, reason, userId);
    },
    remove(id): boolean {
      return Number(delUser.run(id).changes) > 0;
    },
    listAll(): UserRecord[] {
      return (allUsers.all() as Record<string, unknown>[]).map(toRecord);
    },
    listPage(page = {}): UserPage {
      const asked = page.limit ?? OPS_USER_PAGE_DEFAULT;
      if (!Number.isInteger(asked) || asked <= 0) {
        throw new RangeError(`users.listPage: limit must be a positive integer, got ${String(page.limit)}`);
      }
      const limit = Math.min(asked, OPS_USER_PAGE_MAX);
      const probe = limit + 1;
      const like = page.q === undefined ? null : likeContains(page.q);
      const raw = (
        like === null
          ? page.after_user_id === undefined
            ? (pageFirst.all(probe) as Record<string, unknown>[])
            : (pageAfter.all(page.after_user_id, probe) as Record<string, unknown>[])
          : page.after_user_id === undefined
            ? (pageFirstQ.all(like, like, probe) as Record<string, unknown>[])
            : (pageAfterQ.all(page.after_user_id, like, like, probe) as Record<string, unknown>[])
      ).map(toRecord);
      if (raw.length <= limit) return { rows: raw, next_after_user_id: null };
      const rows = raw.slice(0, limit);
      const last = rows[rows.length - 1];
      return { rows, next_after_user_id: last ? last.id : null };
    },
  };
}
