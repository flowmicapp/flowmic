// SPEC-REF:
//   docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §2.1
//     (`POST /api/web/rooms` — the request, the response, the TTL)
//   docs/strategy/2026-09-08-web-client-target-and-self-pairing-state-machine.md
//     §5.1 (the page holds the token and enters with `pc:reconnect`, never
//     `pc:register`) / §5.2 (whose clock the TTL is) / §5.3 (two clocks, one
//     author for the code) / §9.4 (what the phone sees when the room is gone)
//   docs/strategy/2026-09-05-web-client-subproject-design.md §3 (a browser
//     target is a `pc` kind row, and W-3: it must not eat a paid PC slot)
//   ./registry.ts (the seam — `Registry.ensureWebRoom`), ./registry-shared.ts
//     (`isWebRoom`, and why the marker is a server-minted column)
//   *** HUMAN-AUDIT SENSITIVE (row minting + pairing deletion) — reviewable in
//       isolation ***
//
// THE BROWSER TARGET'S ROOM: find it, or mint it.
//
// ── WHY THIS IS NOT A THIRD BRANCH INSIDE `registerPc` ─────────────────────
// `registerPc` answers「a machine just presented itself on a socket」: it rotates
// the token AND the short code every time, sets the row online, adopts whatever
// `client_instance_id` the frame carried, and spends a plan slot on a new row.
// Every one of those is wrong here:
//   · the row is minted over HTTP with no socket in sight, so setting it online
//     would publish a presence nobody has (`pcPresence` is read by the console
//     and by the remove-pc guard);
//   · the token must SURVIVE a repeat call — it is the idempotency of this
//     endpoint, and rotating it would disconnect a page that is working;
//   · the caller has no `client_instance_id` yet; the browser claims one on its
//     first `pc:reconnect` (state machine §5.1);
//   · owner ruling W-3 says this row must not spend a PC slot at all.
// Folding four inversions into the registration path as flags would have made
// one function answer two questions, which is this repo's headline defect shape.
//
// ── THE ONE ROOM PER ACCOUNT RULE, AND ITS COST ────────────────────────────
// 🔴 IDEMPOTENCY IS KEYED ON THE ACCOUNT AND NOTHING ELSE, because the request
// carries nothing else: the addendum's body is `{auth, auth_value, mode}` with
// no browser identity in it, and inventing one would be an interface change made
// in an implementation card. So a second call from the SAME ACCOUNT — a reload,
// a second tab, a second computer — is handed back the SAME room rather than a
// second one.
// ⚠️ WHAT THAT COSTS, STATED RATHER THAN DISCOVERED LATER: two browsers on one
// account share one room, and a room holds one target socket (`store.getPc`), so
// the second page's `pc:reconnect` supersedes the first. That is the same
// single-target rule the desktop already lives under, and it bounds the table to
// one row per account — but if the product ever wants two simultaneous web
// targets on one account, the request needs a browser id and this key has to
// grow with it. It is not something a caller can work around today.
//
// ── WHAT EXPIRY DOES AND DOES NOT DO ───────────────────────────────────────
// `room_expires_at` is enforced HERE and only here: a repeat call that finds an
// expired room RELEASES it (its pairings go with it, see below) and mints a
// fresh one. Nothing sweeps on a 30-minute clock, so an abandoned room outlives
// its own stamp until either that happens or db/reaper.ts takes it at 90 days as
// an ordinary stale offline row. The failure direction is the safe one — a room
// that lasts longer than advertised degrades to what a desktop row already does,
// while a room deleted under a live page would end a session mid-sentence — but
// it is a half, and the missing half is the socket leg: a page holding the token
// of an expired room still reconnects into it. schema.ts says the same thing at
// the column, because that is where the next reader will assume otherwise.
//
// ── CASCADE (card S2-04's open question, and the answer it was given) ──────
// The addendum left「does deleting a web room delete its pairings」 open and the
// state machine register hands the decision to this card (§13 Q-3, 「write it
// down and pin it with a test」). THE ANSWER: releasing a web room releases its
// pairings and NOTHING ELSE — it is `mobile_pairings.pc_device_id REFERENCES
// pc_devices(id) ON DELETE CASCADE` doing exactly what the console's own
// remove-pc route already relies on, so a browser room retires by the same path
// a computer does. It never touches another room of the same account, and there
// are no transcripts to touch: the relay stores none (owner ruling
// 2026-07-31-no-cloud-sync-for-phone-pc.md), so「never deletes transcripts」is a
// property of the schema here, not a promise this code keeps.
// ⚠️ NO SOCKET IS EVICTED. A phone that is still connected when its room is
// released keeps its socket until it next reconnects, and then gets
// `AUTH_TOKEN_INVALID` — which is the behaviour the state machine register
// already writes down as acceptable (§9.4:「含糊但真」). Until then it can still
// open a recording, and its injections answer `INJECT_PC_OFFLINE` because the
// room has no target. It cannot reach anyone else's room: the new room gets a
// fresh `room_uuid`. Eviction is what the console's remove-pc route does with
// the room store, and this module deliberately holds no store — adding one would
// put「close somebody's socket」into the row-minting path for a race that has no
// observer today.

import { randomUUID } from 'node:crypto';
import { newToken } from '../auth/token';
import { parseUtcStamp } from '../db/utc-stamp';
import type { PcRecord, PcRepo } from '../db/repos/pc.repo';
import type { MobileRepo } from '../db/repos/mobile.repo';
import { WEB_ROOM_KIND, isWebRoom } from './registry-shared';

/**
 * How long a web room lives without being asked for again — addendum §2.1's
 * 「30 分钟无连接清理」.
 *
 * ⚠️ IT IS NOT A CODE TTL. The 4-digit pairing code expires on the short-code
 * governor's own clock (room/short-code.ts, ~5 minutes) and is re-minted by this
 * module when it has lapsed. Two clocks, and the state machine register (§5.3)
 * is explicit that they answer different questions: this one says how long the
 * ROOM is worth keeping, that one how long the SECRET is worth accepting.
 */
export const WEB_ROOM_TTL_MS = 30 * 60_000;

/**
 * The device name a browser room is born with.
 *
 * Shaped after `CLOUD_INSTANCE_PC_NAME` ('FlowMic Cloud') for the same reason:
 * a row the server mints on a user's behalf still shows up as a name on a
 * phone's top bar, and the server has no locale for that end. A product name is
 * the one string that is honest in every language — owner's rule that every
 * word a user can see is finished copy, never an internal token, is what rules
 * out the obvious alternatives ('web-room', a uuid).
 * The page can rename it afterwards through the existing rename verb; nothing
 * here depends on the value.
 */
export const WEB_ROOM_PC_NAME = 'FlowMic Web';

/** Everything this module is allowed to touch. Narrower than the repos on
 *  purpose: the four closures are the registry's private code governor and PCID
 *  minting, handed over as capabilities rather than as the whole `Registry`, so
 *  a reader of this file can see the complete list of things it can do. */
export interface WebRoomDeps {
  pcs: Pick<PcRepo, 'listByUser' | 'findById' | 'insert' | 'setShortCode' | 'setRoomExpiry' | 'remove'>;
  mobiles: Pick<MobileRepo, 'listByPc'>;
  /** `Registry.allocateCode` — a free 4-digit code, reserved for `ownerId`. */
  allocateCode(ownerId?: string): string;
  /** `ShortCodeGovernor.stamp` — this code is now live for this row. */
  stampCode(pcId: string, code: string): void;
  /** `ShortCodeGovernor.isActive` — is this row's code still live? */
  codeIsActive(pcId: string): boolean;
  /** `Registry.stampPcid` — mint the row's public PCID if it has none. */
  stampPcid(pc: PcRecord): void;
  now(): number;
}

export interface WebRoomOutcome {
  pc: PcRecord;
  /** The room's `device_token`. STABLE across repeat calls for the same room —
   *  that stability IS this endpoint's idempotency. */
  token: string;
  /** A code that is live NOW, which is not always the one already on the row. */
  code: string;
  expiresAtMs: number;
  /** True when this call minted the row. */
  created: boolean;
  /** True when this call found an EXPIRED room and replaced it. Implies
   *  `created`. Reported so the route can log a replacement (it deleted rows)
   *  rather than have it look like an ordinary first build. */
  replacedExpired: boolean;
  /** Pairing ids that went with the released room, read BEFORE the delete —
   *  after it there is nothing left to enumerate (the cascade already ran). */
  releasedPairings: string[];
}

/** Has this room passed its stamp? A row with no stamp never expires — that is
 *  the NULL contract at the column, not a lenient default invented here. */
function expired(pc: PcRecord, nowMs: number): boolean {
  if (pc.room_expires_at === null) return false;
  const at = parseUtcStamp(pc.room_expires_at);
  // 🔴 An UNPARSEABLE stamp is treated as NOT expired, and the direction is
  // chosen rather than accidental: the two outcomes are「keep a room a little
  // too long」and「delete a working session because a string surprised us」. Only
  // one of those is recoverable by waiting.
  if (!Number.isFinite(at)) return false;
  return at <= nowMs;
}

/**
 * The account's web room: the existing one if it is still alive, otherwise a
 * fresh one.
 *
 * Pure over the deps — no HTTP, no socket, no policy about WHO may call it.
 * Authentication and rate limiting belong to the route, and keeping them out of
 * here is what lets the route's unit tests drive real rows.
 */
export function ensureWebRoom(
  deps: WebRoomDeps,
  user_id: string,
  opts?: { ttlMs?: number },
): WebRoomOutcome {
  const nowMs = deps.now();
  const ttlMs = opts?.ttlMs ?? WEB_ROOM_TTL_MS;
  const expiresAtMs = nowMs + ttlMs;
  const stamp = new Date(expiresAtMs).toISOString();

  // `listByUser` is `created_at ASC`, so the LAST web room is the newest. There
  // should only ever be one — this function is its only mint site and it
  // replaces rather than adds — but reading the newest means a database that
  // somehow holds two does not hand out the older one forever.
  const rooms = deps.pcs.listByUser(user_id).filter(isWebRoom);
  const existing = rooms[rooms.length - 1] ?? null;

  if (existing !== null && !expired(existing, nowMs)) {
    // ── The idempotent path ────────────────────────────────────────────────
    // Same row, same token, same PCID. Only two things move, and both move
    // FORWARD: the TTL (the account just proved a page is there) and, when the
    // governor has let it lapse, the code.
    //
    // 🔴 THE CODE IS RE-MINTED ONLY WHEN IT IS DEAD, never on every call.
    // Rotating a live code would invalidate a QR the user is looking at while
    // they scan it, and it would burn a code out of the 10 000-wide space on
    // every reload. `codeIsActive` is the governor's own answer to「would
    // `mobile:pair` accept this string right now」, so the code this response
    // carries is exactly the one that works.
    const code = deps.codeIsActive(existing.id)
      ? existing.short_code
      : mintCodeFor(deps, existing.id);
    deps.pcs.setRoomExpiry(existing.id, stamp);
    // Backfills a PCID onto a room minted before the column, and is a no-op on
    // every room this module ever made. Same lazy shape as `registerPc`'s.
    deps.stampPcid(existing);
    const fresh = deps.pcs.findById(existing.id) ?? existing;
    return {
      pc: fresh,
      token: fresh.device_token,
      code,
      expiresAtMs,
      created: false,
      replacedExpired: false,
      releasedPairings: [],
    };
  }

  // ── Expired: release it, then mint ───────────────────────────────────────
  let releasedPairings: string[] = [];
  if (existing !== null) {
    // BEFORE the delete: the cascade takes the pairing rows with the room, so
    // this is the last moment they can be enumerated (the console's remove-pc
    // route states the same ordering at its own delete).
    releasedPairings = deps.mobiles.listByPc(existing.id).map((m) => m.id);
    deps.pcs.remove(existing.id);
  }

  const id = randomUUID();
  const token = newToken();
  // No owner id yet — the row does not exist, so nothing can be reserved
  // against it. `stampCode` below binds the code to the row the moment it does.
  const code = deps.allocateCode();
  let pc: PcRecord;
  try {
    pc = deps.pcs.insert({
      id,
      user_id,
      device_name: WEB_ROOM_PC_NAME,
      // NOT set here: `client_instance_id` and `machine_uid`. The browser claims
      // both on its first `pc:reconnect` (state machine §5.1), and a value
      // invented here would be a second author for an identity the page owns.
      // `client` likewise: it is the far end's own declaration (card S2-01), and
      // this row has no far end until somebody connects to it.
      room_kind: WEB_ROOM_KIND,
      room_expires_at: stamp,
      device_token: token,
      room_uuid: randomUUID(),
      short_code: code,
    });
  } catch (err) {
    // 🔴 card S2-04b — THE DB BACKSTOP. `ensureWebRoom` is pure over its deps and
    // does its own read-then-write with no lock of its own (see this file's own
    // header) — the ONE caller allowed to serialize concurrent builds for the
    // same account is `Registry.ensureWebRoom` (registry.ts), an IN-PROCESS
    // promise chain that is enough for the one writer node this route runs on.
    // This catch is what happens if that assumption is ever wrong — a second
    // process, a future async DB driver, a caller that bypasses the registry —
    // and two readers genuinely raced past the `existing === null` check above
    // before either had written: the partial unique index
    // `idx_pc_devices_web_room_owner` (connection.ts, `WHERE room_kind='web'`)
    // turns the LOSING insert into this catch instead of into a second row, and
    // the correct answer for the loser is not to throw — it is to hand back the
    // row that won, which is exactly what a repeat call finds normally. Same
    // division of labour `admitCloudInstance` two tables up already documents
    // for the cloud-instance row: "the partial unique index ... is the DB
    // backstop; the find-first-then-insert here is the fast path".
    if (!isWebRoomUniqueViolation(err)) throw err;
    const winner = deps.pcs.listByUser(user_id).filter(isWebRoom)[0];
    // The constraint fired for THIS account and THIS predicate, so a winning
    // row must exist — re-throw rather than fabricate a result if it somehow
    // does not (a stale read of our own, not the race this catch exists for).
    if (!winner) throw err;
    deps.stampPcid(winner);
    const freshWinner = deps.pcs.findById(winner.id) ?? winner;
    return {
      pc: freshWinner,
      token: freshWinner.device_token,
      code: deps.codeIsActive(freshWinner.id) ? freshWinner.short_code : mintCodeFor(deps, freshWinner.id),
      expiresAtMs,
      created: false,
      replacedExpired: false,
      releasedPairings: [],
    };
  }
  deps.stampCode(pc.id, pc.short_code);
  // 🔴 DELIBERATELY NOT `setOnline(true)`. `registerPc` does that because a
  // socket is connected at that instant; here nothing is connected yet, and a
  // row that claims to be online is read by the console's presence projection
  // and by remove-pc's guard as「that computer is here right now」.
  deps.stampPcid(pc);
  return {
    pc: deps.pcs.findById(pc.id) ?? pc,
    token,
    code,
    expiresAtMs,
    created: true,
    replacedExpired: existing !== null,
    releasedPairings,
  };
}

/** Allocate a fresh live code for an EXISTING row and store it on both sides of
 *  the answer — the durable column and the in-memory governor. Both, always:
 *  `resolvePcForPair` requires the row AND `isActive`, so a code written to only
 *  one of them is a string the user can read and the server will refuse. */
function mintCodeFor(deps: WebRoomDeps, pcId: string): string {
  const code = deps.allocateCode(pcId);
  deps.pcs.setShortCode(pcId, code);
  deps.stampCode(pcId, code);
  return code;
}

/** Is this the ONE constraint `insert` above can legitimately race into —
 *  `idx_pc_devices_web_room_owner` (connection.ts, `ON pc_devices(user_id)
 *  WHERE room_kind='web'`) — rather than some OTHER failure (a full disk, a
 *  corrupt index, `device_token`/`room_uuid`'s own UNIQUE columns) that this
 *  function must not silently swallow.
 *
 *  🔴 `node:sqlite`'s DatabaseSync throws a plain `Error` with
 *  `code:'ERR_SQLITE_ERROR'` and the SQLite engine's own message text — there
 *  is no structured field naming WHICH index fired (unlike, say, a Postgres
 *  driver's `error.constraint`), so the message is read for the one string
 *  SQLite always includes: the table and column the index covers. Matched
 *  against `pc_devices.user_id` specifically — not just "UNIQUE constraint
 *  failed" — so a violation of `device_token`/`room_uuid`'s own UNIQUE columns
 *  (a real randomUUID/newToken collision, or a genuine bug) is NOT read as
 *  "someone else already built this account's room" and is not swallowed. */
function isWebRoomUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error
    && (err as { code?: unknown }).code === 'ERR_SQLITE_ERROR'
    && /UNIQUE constraint failed: pc_devices\.user_id/.test(err.message)
  );
}
