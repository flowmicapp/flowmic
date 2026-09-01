// SPEC-REF:
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §4-4
//   apps/server-core/src/http/node-routes.ts   (POST /api/node/resolve-token)
//   apps/server-core/src/node/writer-client.ts (resolveToken)
//   apps/server-core/src/node/token-read-through.ts (the replica's caller)
//   *** HUMAN-AUDIT SENSITIVE (auth) — reviewable in isolation ***
//
// 「Which rows does this connection token stand for?」 — asked on the writer,
// answered over the node channel, landed in a replica's local database.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A WHOLE ROW CROSSES THE WIRE, AND NOT JUST AN AuthContext
//
// The handshake only needs three strings (user, device, pairing). Everything
// AFTER the handshake does not: `mobile:reconnect` → `registry.reconnectMobile`
// → `findPairingByToken` reads `mobile_pairings` and then `pc_devices` FROM THE
// LOCAL DATABASE (room/registry.ts). A replica that admitted the socket on a
// remote answer and then could not find those rows would produce a phone that
// connects and is immediately refused AUTH_TOKEN_INVALID by the first event it
// sends — a worse failure than the one this closes, because it looks like a
// working connection.
//
// So the unit of the answer is ROWS, and for a mobile token it is TWO rows: the
// pairing and the PC it points at. `mobile_pairings.pc_device_id REFERENCES
// pc_devices(id)` means they cannot even be inserted in the other order.
//
// ── S1b: AND THE ACCOUNT, BECAUSE THE FOREIGN KEYS GO ONE STEP FURTHER ───────
//
// `pc_devices.user_id` and `mobile_pairings.user_id` both REFERENCE `users(id)`,
// and `users` is replicated by the SAME 30-second pull. So the first version of
// this closed the pairing-row window and left the ONBOARDING one wide open: a
// person signs up on the writer, pairs within thirty seconds, the phone hops to
// its PC's node — and the row will not land, because the account it hangs from
// is not here either. The refusal that follows is the one the phone DELETES the
// fresh pairing on. Measured as a test before it was fixed
// (「rows that will not land are refused」), which is why it is closed here rather
// than discovered in production.
//
// The answer therefore carries the owning `users` row(s) too, applied FIRST.
// Plural because `pc.user_id` and `mobile.user_id` are separate columns that are
// allowed to differ; in practice it is one row.
//
// ⚠️ ON EXPOSURE. This body carries `device_token` / `mobile_token` and now a
// whole `users` row including `password_hash` — real credentials. It is not a
// new exposure: the SAME channel already serves `/api/node/snapshot`, which is
// the entire user database — every one of those tokens and every password hash.
// One row over a channel that already carries all of them adds nothing an
// attacker who has the shared secret did not already have. That argument is the
// reason this is allowed to exist, and it stops holding the moment anything but
// the node channel can reach it — which is why the route is secret-gated with no
// 「optional in dev」 escape.
//
// 🔴 AND IT FOLLOWS THE REPO'S OWN PRECEDENT ON `password_hash` RATHER THAN
// CONTRADICTING IT. `db/repos/user.repo.ts` states the rule twice and in the
// same direction: `UserPage.rows` is 「FULL records, password_hash included —
// this is a repo」, and the structural exclusion lives in the PROJECTION
// (`OpsUserView`, 「ABSENT BY CONSTRUCTION, NOT BY DISCIPLINE」) because THAT
// surface shows a row to a PERSON. This one hands a row to another FlowMic
// node's sqlite file. Different boundary, and the exclusion was never a rule
// about the column — it is a rule about who is on the other side.
//
// ⚠️ OMITTING IT WOULD BE WORSE, NOT SAFER, AND THIS IS MEASURABLE RATHER THAN
// arguable: `password_hash` is NULLABLE (db/schema.ts), so an INSERT without it
// SUCCEEDS and lands NULL. That is an account that cannot sign in on this node
// until the next pull, and a NULL hash is a value the login path would then have
// to be trusted to read correctly — inventing a security-shaped state to avoid
// shipping a byte the same channel already ships in bulk.
// ─────────────────────────────────────────────────────────────────────────────

import type { DbConnection } from '../db/connection';
import type { MobileRecord, MobileRepo } from '../db/repos/mobile.repo';
import type { PcRecord, PcRepo } from '../db/repos/pc.repo';
import type { UserRecord, UserRepo } from '../db/repos/user.repo';

/**
 * What a token stands for. Two members rather than one optional field, because
 * a caller acts differently on each: a PC token lands one row, a mobile token
 * lands two, and 「mobile with no pc」 must not be representable at all.
 */
export type TokenResolution =
  | { kind: 'pc'; users: UserRecord[]; pc: PcRecord }
  | { kind: 'mobile'; users: UserRecord[]; pc: PcRecord; mobile: MobileRecord };

/**
 * The WRITER's half: which rows, if any, this token stands for HERE.
 *
 * Ordered PC-first for one reason and it is not style: `authMiddleware` checks
 * the PC table first, so a token that somehow existed in both would resolve to
 * the same kind on both sides of the wire. (`device_token` and `mobile_token`
 * are separately UNIQUE and independently minted from 32 random bytes, so this
 * is a coincidence that cannot happen — the point is that the two lookups agree
 * by construction rather than because nobody made them disagree.)
 *
 * Returns null for 「no such token here」, and the writer IS the authority, so
 * that null is a fact. The transport failure that must never be confused with
 * it is a throw on the caller's side, never this value.
 */
export function resolveTokenRows(
  repos: {
    pcs: Pick<PcRepo, 'findByToken' | 'findById'>;
    mobiles: Pick<MobileRepo, 'findByToken'>;
    users: Pick<UserRepo, 'findById'>;
  },
  token: string,
): TokenResolution | null {
  const pc = repos.pcs.findByToken(token);
  if (pc) {
    const users = ownersOf(repos, pc.user_id, null);
    if (!users) return null;
    return { kind: 'pc', users, pc };
  }
  const mobile = repos.mobiles.findByToken(token);
  if (!mobile) return null;
  const owner = repos.pcs.findById(mobile.pc_device_id);
  // A pairing whose PC row is gone is not an answer we can give: the replica
  // could not insert it (FK), and the handshake it would admit would be refused
  // by the very next event. `null` here says 「nothing usable」, which is exactly
  // what the caller needs to hear.
  if (!owner) return null;
  const users = ownersOf(repos, owner.user_id, mobile.user_id);
  if (!users) return null;
  return { kind: 'mobile', users, pc: owner, mobile };
}

/** The distinct account rows the two `user_id` columns point at, or null when
 *  any of them is missing HERE.
 *
 *  🔴 The same rule as the missing-PC branch above, one table further out: an
 *  answer whose foreign keys cannot be satisfied is not a partial answer, it is
 *  no answer. Returning the rows we do have would hand the replica a set that
 *  fails halfway through its transaction — a refusal either way, arrived at
 *  three layers later.
 *
 *  ⚠️ `mobile.user_id` is NULLABLE and a null is not a missing row: a pairing
 *  minted before accounts existed genuinely has no owner of its own, and it
 *  inherits the PC's. Skipped, never looked up, never reported as absent. */
function ownersOf(
  repos: { users: Pick<UserRepo, 'findById'> },
  pcUserId: string,
  mobileUserId: string | null,
): UserRecord[] | null {
  const wanted = mobileUserId !== null && mobileUserId !== pcUserId ? [pcUserId, mobileUserId] : [pcUserId];
  const out: UserRecord[] = [];
  for (const id of wanted) {
    const row = repos.users.findById(id);
    if (!row) return null;
    out.push(row);
  }
  return out;
}

// ── the wire, read defensively ──────────────────────────────────────────────
//
// 🔴 HAND-WRITTEN NARROWING IS AN ASSERTION THE COMPILER DOES NOT CHECK
// (anti-façade ⑤ — `asPairingInfo`'s `c is string` filter that tested
// `typeof c === 'object'` and left every machine with an empty array). So these
// build the object FIELD BY FIELD and return null on the first thing that is not
// there, rather than casting a parsed body and hoping. A field this misses does
// not become undefined at the far end — it becomes a NOT NULL violation when the
// row is inserted, which is a loud failure but three layers from its cause.

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function strOrNull(v: unknown): { ok: true; value: string | null } | null {
  if (v === null || v === undefined) return { ok: true, value: null };
  return typeof v === 'string' ? { ok: true, value: v } : null;
}

function parsePc(v: unknown): PcRecord | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  const user_id = str(o.user_id);
  const device_name = str(o.device_name);
  const device_token = str(o.device_token);
  const room_uuid = str(o.room_uuid);
  const short_code = str(o.short_code);
  const created_at = str(o.created_at);
  const client_instance_id = strOrNull(o.client_instance_id);
  const machine_uid = strOrNull(o.machine_uid);
  const pcid = strOrNull(o.pcid);
  const home_node = strOrNull(o.home_node);
  const last_seen_at = strOrNull(o.last_seen_at);
  if (
    id === null || user_id === null || device_name === null || device_token === null
    || room_uuid === null || short_code === null || created_at === null
    || client_instance_id === null || machine_uid === null || pcid === null
    || home_node === null || last_seen_at === null
  ) return null;
  return {
    id,
    user_id,
    device_name,
    client_instance_id: client_instance_id.value,
    machine_uid: machine_uid.value,
    pcid: pcid.value,
    home_node: home_node.value,
    device_token,
    room_uuid,
    short_code,
    // The column is INTEGER NOT NULL; anything that is not exactly 1 is 0, the
    // same collapse `pc.repo.ts` `toRecord` does when reading it back.
    is_online: o.is_online === 1 ? 1 : 0,
    last_seen_at: last_seen_at.value,
    created_at,
  };
}

function parseUser(v: unknown): UserRecord | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  const display_name = str(o.display_name);
  const plan = str(o.plan);
  const locale = str(o.locale);
  const created_at = str(o.created_at);
  const email = strOrNull(o.email);
  const password_hash = strOrNull(o.password_hash);
  const restriction_reason = strOrNull(o.restriction_reason);
  const google_sub = strOrNull(o.google_sub);
  if (
    id === null || display_name === null || plan === null || locale === null || created_at === null
    || email === null || password_hash === null || restriction_reason === null || google_sub === null
  ) return null;
  return {
    id,
    email: email.value,
    password_hash: password_hash.value,
    display_name,
    // 🔴 NOT re-validated against `isPlan` here, and that is deliberate: the ONE
    // place a stored tier becomes a `Plan` is `user.repo.ts` `toRecord`, which
    // already ran on the writer and already applied its fail-closed fallback.
    // A second narrowing site is how two answers to 「what tier is this」 are
    // born (book 13 §7 F1 ⑤). The value goes into the local row unchanged and
    // comes back out through that same one conversion when anything reads it.
    plan: plan as UserRecord['plan'],
    locale: locale as UserRecord['locale'],
    // Booleans on the wire, INTEGERs in the column — the repo owns that round
    // trip. `=== true` rather than truthiness, so a stray string cannot restrict
    // or promote an account.
    is_admin: o.is_admin === true,
    permanent_free: o.permanent_free === true,
    email_verified_at: typeof o.email_verified_at === 'number' ? o.email_verified_at : null,
    restricted_at: typeof o.restricted_at === 'number' ? o.restricted_at : null,
    restriction_reason: restriction_reason.value,
    last_login_at: typeof o.last_login_at === 'number' ? o.last_login_at : null,
    google_sub: google_sub.value,
    created_at,
  };
}

function parseMobile(v: unknown): MobileRecord | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  const pc_device_id = str(o.pc_device_id);
  const mobile_token = str(o.mobile_token);
  const mobile_name = str(o.mobile_name);
  const paired_at = str(o.paired_at);
  const user_id = strOrNull(o.user_id);
  const device_uid = strOrNull(o.device_uid);
  const last_seen_at = strOrNull(o.last_seen_at);
  if (
    id === null || pc_device_id === null || mobile_token === null || mobile_name === null
    || paired_at === null || user_id === null || device_uid === null || last_seen_at === null
  ) return null;
  return {
    id,
    user_id: user_id.value,
    pc_device_id,
    mobile_token,
    mobile_name,
    device_uid: device_uid.value,
    paired_at,
    last_seen_at: last_seen_at.value,
  };
}

/**
 * The REPLICA's half: a 200 body, turned into rows or into null.
 *
 * null means 「this writer answered something I cannot use」 and the caller must
 * treat it as a TRANSPORT failure, never as 「the token does not exist」 — the
 * negative answer has its own status code (404) and never comes through here.
 */
export function parseTokenResolution(body: unknown): TokenResolution | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const pc = parsePc(o.pc);
  if (!pc) return null;
  if (!Array.isArray(o.users)) return null;
  const users: UserRecord[] = [];
  for (const u of o.users) {
    const row = parseUser(u);
    if (!row) return null;
    users.push(row);
  }
  // 🔴 The answer must CARRY the account it depends on, and this is checked here
  // rather than left to the INSERT. A response whose `users` array does not
  // cover `pc.user_id` cannot land — the foreign key sees to that — but it would
  // fail inside a transaction three layers down, reported as 「could not land the
  // rows」 when the truth is 「the writer sent an incomplete answer」. Two
  // different bugs, and only one of them is ours to fix.
  const have = new Set(users.map((u) => u.id));
  if (!have.has(pc.user_id)) return null;
  if (o.kind === 'pc') return { kind: 'pc', users, pc };
  if (o.kind !== 'mobile') return null;
  const mobile = parseMobile(o.mobile);
  if (!mobile) return null;
  // Null is legal (a pairing with no account of its own inherits the PC's) and
  // is not a missing row — the same distinction `ownersOf` draws on the writer.
  if (mobile.user_id !== null && !have.has(mobile.user_id)) return null;
  // 🔴 The one cross-field check, and it is the wrong-target red line in
  // miniature (CLAUDE.md: a delivery id and its target PC id must correspond,
  // 100%): a pairing must be handed back with ITS OWN PC, never with some other
  // row that happened to be in the same response. If they disagree the answer is
  // unusable, not repairable.
  if (mobile.pc_device_id !== pc.id) return null;
  return { kind: 'mobile', users, pc, mobile };
}

/**
 * Land the rows in the LOCAL database, so every later read — `findByToken`,
 * `findPairingByToken`, the presence routes — sees them exactly as a replication
 * pull would have delivered them.
 *
 * 🔴 ONE TRANSACTION, IN FOREIGN-KEY ORDER: accounts, then the PC, then the
 * pairing. Rows landing separately can leave a pairing pointing at a PC that is
 * not there, or a PC written for an account that is not there, or an account
 * created for a pairing that then failed — half-identities nobody designed.
 * `node:sqlite` is synchronous, so nothing can interleave between BEGIN and
 * COMMIT here; the whole block is one tick.
 *
 * ⚠️ Idempotent against the 30-second replication pull that will overwrite these
 * rows later: the pull's `DELETE`+`INSERT` of the whole table is the authority,
 * and this only ever writes what the writer already holds, so the two agree.
 * Re-running it on rows that are already present is a no-op.
 *
 * ⚠️ THE THREE UPSERTS ARE NOT THE SAME UPSERT, and the difference is stated on
 * each repo method: `pcs`/`mobiles` are DO UPDATE (they ARE what was asked
 * about, so a stale copy gets corrected), `users` is DO NOTHING (it is a
 * dependency dragged in for a foreign key, and nothing here asked to rewrite
 * somebody's account row).
 *
 * THROWS if any row will not land (UNIQUE on a token or an email, FK on a
 * missing reference). It must: the caller's whole contract is 「landed ⇒
 * proceed, otherwise refuse」, and a swallowed failure here would admit a socket
 * whose rows are not actually there.
 */
export function applyTokenResolution(
  db: Pick<DbConnection, 'raw' | 'pcs' | 'mobiles' | 'users'>,
  r: TokenResolution,
): void {
  db.raw.exec('BEGIN IMMEDIATE');
  try {
    for (const u of r.users) db.users.upsertReplicated(u);
    db.pcs.upsertReplicated(r.pc);
    if (r.kind === 'mobile') db.mobiles.upsertReplicated(r.mobile);
    db.raw.exec('COMMIT');
  } catch (err) {
    try {
      db.raw.exec('ROLLBACK');
    } catch {
      /* already unwound; the original error is the one that matters */
    }
    throw err;
  }
}
