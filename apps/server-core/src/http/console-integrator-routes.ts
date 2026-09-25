// SPEC-REF:
//   docs/archive/strategy/2026-09-11-metering-principal-matrix-design.md §2
//     (「每 key 的硬上限（控制台可设，缺省＝档位全量）」)
//   docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md §9-1
//   ../billing/integrator-quota.ts (what a key IS, and why the Origin header is
//     not a security boundary)
//   ../db/repos/integrator-key.repo.ts (the store)
//   ./console-routes.ts (where this family is mounted, and the delegation rule)
//   *** HUMAN-AUDIT SENSITIVE (auth + a paid dimension) — reviewable in isolation ***
//
// Card MP-1 — an integrator manages their own publishable keys.
//
// ── WHAT THIS SURFACE IS FOR, AND WHAT IT IS NOT ───────────────────────────
//
// It is what card MP-2 and the console UI call. THE CONSOLE UI IS NOT IN THIS
// CARD — that is a site-repo card — so nothing here renders anything, and the
// shapes below are a contract another codebase will be written against rather
// than a convenience for one page.
//
// ── 🔴 THE KEY STRING IS RETURNED IN FULL, ON CREATE **AND** ON LIST ────────
//
// The reflex from every other credential surface in this repo is 「show it once,
// never again」. That reflex is wrong here and following it would break the
// product: a publishable key's entire job is to sit in a page's JavaScript where
// every visitor can read it (billing/integrator-quota.ts's header argues this at
// length), so 「I lost my key」 must be answerable by looking, not by rotating.
// Hiding it would add a rotation dance that protects nothing.
//
// ── WRITER-ONLY IS NOT SPELLED HERE, AND THAT IS ON PURPOSE ────────────────
//
// `http/router.ts` answers 421 `NODE_IS_REPLICA` to every non-GET `/api/*` on a
// replica, before any route family is consulted. So POST create and POST revoke
// are writer-only by construction and GET list is served everywhere — the same
// division every other console write already lives under. A guard repeated here
// would be a second author for 「may this node write」.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AuthService } from '../auth/auth-service';
import type { BillingService } from '../billing/billing-service';
import type { IntegratorKeyRepo } from '../db/repos/integrator-key.repo';
import type { UsageEventsRepo } from '../db/repos/usage-events.repo';
import { accountFromBearer } from './account-auth';
import { readJsonBody, sendJson, str } from './console-http';
import { newPublishableKey, normalizeOrigin } from '../billing/integrator-quota';
import { log } from '../log';

const LIST_PATH = '/api/cloud/integrator/keys';
const REVOKE_PATH = '/api/cloud/integrator/keys/revoke';

/** How many origins one key may allow, and how long one may be.
 *
 *  🔴 A CAP RATHER THAN 「as many as you like」, because this list is read on
 *  EVERY room build: an unbounded array is an unbounded loop on a hot path that
 *  the caller chooses the length of. Sixteen is comfortably past what a real
 *  site needs (an integrator with more subdomains than that has an architecture
 *  question, not a FlowMic one) and small enough that the walk is free. */
const MAX_ORIGINS = 16;
/** Per key, per account. The same reasoning: an account that can mint keys
 *  without limit can grow this table without limit. */
const MAX_KEYS_PER_ACCOUNT = 32;
/**
 * What an integrator calls a key — and, since card MP-13, what a VISITOR'S PHONE
 * shows as the room's name.
 *
 * 🔴🔴 CORRECTION (card MP-13, owner 2026-09-11 §11 追认 item 6). This note used
 * to read 「Never rendered to a visitor and never parsed」. The second half is
 * still true. The first is not: `room/integrator-room.ts` `integratorRoomName`
 * turns it into `pc_devices.device_name`, which is what a phone puts in its top
 * bar and in its PC list. That is why the field became REQUIRED on create.
 *
 * 🔴 SIXTY-FOUR, DOWN FROM EIGHTY, and the number is not taste: it has to stay
 * at or below `settings.handler.ts` `PC_NAME_MAX` (80), the cap any PC's name is
 * already allowed to reach, so that nothing downstream has to truncate a site's
 * name — and truncating one silently is 「the quiet kind of lie」 `parsePcName`
 * refuses to tell. The relationship is asserted by
 * `test/console-integrator-routes.test.ts`; an import from `http/` into
 * `socket/handlers/` for one integer is not worth the edge.
 *
 * ⚠️ KEYS CREATED BEFORE THIS CARD ARE UNTOUCHED, including the ones whose label
 * is 65-80 characters or empty. Validation is on CREATE only: an integrator
 * whose page is serving today must not have it stop because a rule they never
 * saw arrived. An empty legacy label falls back to `INTEGRATOR_ROOM_PC_NAME`.
 */
const MAX_LABEL_CHARS = 64;

/**
 * The `label` field, validated — card MP-13. Returns the name to store, or
 * `'invalid'`.
 *
 * REQUIRED, unlike `quota_minutes` beside it, and the asymmetry is the ruling:
 * an absent sub-quota is a real choice (「this key adds no ceiling」), while an
 * absent name is a room on somebody's phone with nothing identifying it. Owner
 * §11 追认 item 6.
 *
 * Trimmed BEFORE the emptiness test so `'   '` is refused rather than stored and
 * then silently falling back; control characters are refused rather than
 * stripped, because at creation there is somebody to tell.
 */
function readLabel(value: unknown): string | 'invalid' {
  if (typeof value !== 'string') return 'invalid';
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_LABEL_CHARS) return 'invalid';
  // C0 plus DEL. `integratorRoomName` strips these for rows written before this
  // function existed; here they are an answer, not a repair.
  if (/[\u0000-\u001F\u007F]/.test(name)) return 'invalid';
  return name;
}

export interface ConsoleIntegratorRoutesDeps {
  auth: AuthService;
  /**
   * card MP-12 — the account's metering cycle, for `refused_count`'s window.
   *
   * REQUIRED, no `?` and no local fallback (book 13 §7 F1 ②). A default here —
   * the calendar month, say — would be this route counting refusals over a
   * window the meter does not use, which is the 2026-09-05 ruling's own defect
   * reintroduced on a read surface: the number would disagree with `used_ms`
   * beside it in the same JSON, and nothing would go red.
   */
  billing: BillingService;
  /** Absent on a deployment that serves no integrations. The routes then answer
   *  404 by not claiming the request at all, which is what 「this deployment does
   *  not have this feature」 looks like on an HTTP surface — never an empty list,
   *  which would say 「you have no keys」 to somebody who has some elsewhere. */
  integratorKeys?: IntegratorKeyRepo;
  /**
   * card MP-12 — where refusals were recorded, sliced to the ONE aggregate this
   * file may ask for.
   *
   * 🔴 THE SLICE IS THE POINT. `UsageEventRow`'s header records why this log's
   * rows may not be read back to an account (`speaker_ref` can be a visitor's
   * browser uid), so this dep is typed as the counting method alone — a console
   * route holding the whole repo could grow a row read without anyone deciding
   * to allow one.
   *
   * Optional, and 「absent」 is NOT a silent zero: `refused_count` is then
   * OMITTED from the key view rather than reported as 0, because 「no presses
   * were refused」 and 「this deployment does not count」 are two facts and a
   * console rendering the second as the first would be inventing a measurement.
   */
  usageEvents?: Pick<UsageEventsRepo, 'countRefusalsByKey'>;
  now?: () => number;
}

/** The wire shape of one key. Assembled here rather than returning the row so a
 *  column added to the table later does not silently join the API.
 *
 *  `refusedCount` — card MP-12. `undefined` means 「this deployment does not
 *  count refusals」 and the field is left OFF the object; a number, including 0,
 *  is a measurement. See the dep's comment for why those must not be one value. */
function keyView(row: {
  id: string; publishable_key: string; origins: readonly string[];
  quota_minutes: number | null; used_ms: number; used_period: string | null;
  label: string | null; revoked_at: number | null; created_at: number;
}, refusedCount?: number): Record<string, unknown> {
  return {
    // card MP-12 — ADDITIVE, and last in the object for the same reason it is
    // optional: a console written against MP-1's shape keeps working, and one
    // written against this shape can tell 「zero refusals」 from 「not counted」.
    ...(refusedCount === undefined ? {} : { refused_count: refusedCount }),
    id: row.id,
    publishable_key: row.publishable_key,
    origins: [...row.origins],
    // `null` travels as null and is NOT rendered as a number: it means 「this key
    // adds no ceiling of its own」, and substituting the account's plan minutes
    // here would be a COPY of a figure the plan table owns — stale the day the
    // integrator upgrades, and a second author for the default.
    quota_minutes: row.quota_minutes,
    used_ms: row.used_ms,
    used_period: row.used_period,
    label: row.label,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
  };
}

/** The `origins` field, validated. Returns null when the caller sent something
 *  this surface will not store. */
function readOrigins(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ORIGINS) return null;
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') return null;
    // 🔴 NORMALISED ON THE WAY IN, not only on the way out. Storing what the
    // caller typed and normalising at comparison time would work, and it would
    // also mean the console shows a list that does not look like what the check
    // actually does — 「why is my origin refused」 answered by a string the
    // integrator cannot see. One form, stored once.
    const norm = normalizeOrigin(raw);
    if (norm === null) return null;
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

/** The optional `quota_minutes` field. `undefined`/`null` ⇒ no sub-quota, which
 *  IS the design's default (see the column comment). A malformed value is a
 *  refusal rather than a silent fallback to 「no ceiling」: guessing there
 *  would hand an integrator an unlimited key because they mistyped a number. */
function readQuotaMinutes(value: unknown): number | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return 'invalid';
  return value;
}

/** Returns true iff this request belonged to this file. */
export function tryHandleConsoleIntegratorRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleIntegratorRoutesDeps,
): boolean {
  const path = (req.url ?? '/').split('?')[0];
  const method = req.method ?? 'GET';
  const mine = (path === LIST_PATH && (method === 'GET' || method === 'POST'))
    || (path === REVOKE_PATH && method === 'POST');
  if (!mine) return false;
  const keys = deps.integratorKeys;
  if (!keys) return false;

  const who = accountFromBearer(req, deps.auth);
  if (!who.ok) {
    sendJson(res, 401, { error: who.error });
    return true;
  }
  const userId = who.userId;
  const now = (deps.now ?? Date.now)();

  if (path === LIST_PATH && method === 'GET') {
    // ── card MP-12 — HOW THE PERIOD IS SCOPED ────────────────────────────────
    //
    // The window is T's OWN metering cycle, `[startMs, endMs)`, from
    // `BillingService.usagePeriod` — the same function `usagePeriodKey` is built
    // on and therefore the same cycle `integrator_keys.used_period` stamps and
    // the sub-quota rolls over on (billing/usage-period.ts, owner 2026-09-05
    // option 乙: one cycle per account, anchored to the day it began).
    //
    // 🔴 NOT THE CALENDAR MONTH, and not a 30-day look-back. `used_ms` sits in
    // the same JSON object and resets on this boundary; a refusal count scoped
    // to a different window would put two numbers about 「this period」 side by
    // side that answer two different periods — and neither label would be wrong
    // enough for anyone to notice.
    //
    // ⚠️ ONE QUERY FOR ALL OF THIS ACCOUNT'S KEYS, not one per key: an account
    // may hold 32 of them (MAX_KEYS_PER_ACCOUNT) and a per-key round trip would
    // make a console list's cost grow with the number of keys.
    const refusals = deps.usageEvents === undefined
      ? undefined
      : (() => {
        const period = deps.billing.usagePeriod(userId, now);
        return deps.usageEvents.countRefusalsByKey(userId, period.startMs, period.endMs);
      })();
    sendJson(res, 200, {
      keys: keys.listByUser(userId).map(
        (row) => keyView(row, refusals === undefined ? undefined : (refusals.get(row.id) ?? 0)),
      ),
    });
    return true;
  }

  void (async (): Promise<void> => {
    const body = await readJsonBody(req);
    if (path === REVOKE_PATH) {
      const id = str(body.id);
      // 🔴 OWNERSHIP IS THE REPO'S ANSWER, IN THE SAME STATEMENT THAT WRITES
      // (`revoke(user_id, id, at)`). A read-then-write here would be a check
      // and a write that can disagree, on a surface where disagreeing means
      // one account revoking another's key.
      //
      // ⚠️ A key that does not exist and one that belongs to somebody else are
      // ONE answer, deliberately: telling them apart would turn this endpoint
      // into an oracle for 「does this key id exist」 across all accounts.
      if (id === '' || !keys.revoke(userId, id, now)) {
        sendJson(res, 404, { error: 'PAIR_NOT_FOUND', message: 'no such key on this account' });
        return;
      }
      // The rooms this key already minted are NOT torn down here, and that is a
      // decision rather than an omission: they expire on their own TTL (ten
      // minutes), and every recording they still admit is checked against
      // `remainingMs`, which answers 0 for a revoked key — so a revoked key
      // stops COSTING money immediately even though a page that is already open
      // keeps its room until it lapses. Evicting live sockets is a different
      // capability with a different blast radius (console-device-routes.ts is
      // the one surface allowed to do it) and it is not what revoking a key
      // means.
      log.info('integrator key revoked', { user_id: userId, key_id: id });
      sendJson(res, 200, { ok: true, revoked_at: now });
      return;
    }

    // ── create ───────────────────────────────────────────────────────────────
    const origins = readOrigins(body.origins);
    if (origins === null) {
      sendJson(res, 400, {
        error: 'SETTINGS_SCHEMA_INVALID',
        message: `origins must be 1-${MAX_ORIGINS} absolute http(s) origins`,
      });
      return;
    }
    const quota = readQuotaMinutes(body.quota_minutes);
    if (quota === 'invalid') {
      sendJson(res, 400, {
        error: 'SETTINGS_SCHEMA_INVALID',
        message: 'quota_minutes must be a non-negative whole number of minutes, or null',
      });
      return;
    }
    const live = keys.listByUser(userId).filter((k) => k.revoked_at === null);
    if (live.length >= MAX_KEYS_PER_ACCOUNT) {
      // 🔴 `PLAN_UPGRADE_REQUIRED` IS NOT THE CODE HERE, and the difference is
      // the one `INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED` already had to make: this
      // ceiling is an anti-abuse cap that NO plan raises, so a code whose whole
      // meaning is 「paying lifts this」 would send an integrator to a checkout
      // that changes nothing. Revoking a key they no longer use is the action.
      sendJson(res, 409, {
        error: 'SETTINGS_SCHEMA_INVALID',
        message: `this account already holds ${MAX_KEYS_PER_ACCOUNT} live keys; revoke one first`,
      });
      return;
    }
    const label = readLabel(body.label);
    if (label === 'invalid') {
      // ONE message for all four ways to get it wrong (missing, blank, too long,
      // control characters), on purpose: the console maps this into 「give this
      // key a name」 beside the field, and four sentences would be four things to
      // translate for one control. The rules are all named so a developer
      // reading the raw response can see which one they broke.
      sendJson(res, 400, {
        error: 'SETTINGS_SCHEMA_INVALID',
        message: `label is required: a site name of 1-${MAX_LABEL_CHARS} characters after trimming, with no control characters`,
      });
      return;
    }
    const row = keys.insert({
      id: `ik_${randomUUID().replace(/-/g, '')}`,
      user_id: userId,
      publishable_key: newPublishableKey(),
      origins,
      quota_minutes: quota,
      label,
      created_at: now,
    });
    // The id and the origins, never the key string — a log is not a place to
    // accumulate other people's credentials, publishable or not.
    log.info('integrator key created', {
      user_id: userId, key_id: row.id, origins: row.origins.length, quota_minutes: row.quota_minutes,
    });
    // card MP-12 — 0 rather than a query: a key that has existed for zero
    // milliseconds has refused nothing, and that is a measurement, not a guess.
    // `undefined` still when this deployment does not count at all.
    sendJson(res, 200, { key: keyView(row, deps.usageEvents === undefined ? undefined : 0) });
  })().catch((err: unknown) => {
    // The same reason `web-room-routes.ts` catches its own detached promise: an
    // unanswered request is the silent-failure red line in its worst form — the
    // console spins forever with no status to render.
    log.error('integrator key route failed', { error: err instanceof Error ? err.message : String(err) });
    sendJson(res, 500, { error: 'SETTINGS_SYNC_FAIL', message: 'internal error' });
  });
  return true;
}
