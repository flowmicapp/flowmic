// SPEC-REF:
//   docs/strategy/2026-09-11-metering-principal-matrix-design.md §2 / §10-6
//   docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md §9-1
//   ./web-room.ts (the account's ONE browser target room — the shape this is NOT)
//   ../db/schema-integrator.ts (why the key edge is its own table)
//   *** HUMAN-AUDIT SENSITIVE (row minting + a paid dimension) ***
//
// Card MP-1 — mint a room for a third-party host page.
//
// ── 🔴 WHY THIS IS NOT `ensureWebRoom` WITH A DIFFERENT `room_kind` ────────
//
// `ensureWebRoom` is IDEMPOTENT PER ACCOUNT: one account, one browser target
// room, re-used and re-stamped on every call, guarded by the partial unique
// index `idx_pc_devices_web_room_owner ... WHERE room_kind='web'`. That is right
// for a person opening the web client, and it is exactly wrong here.
//
// An integrator serves MANY visitors AT ONCE. Every page load needs its own
// room, its own pairing code and its own microphone — an integration where the
// second visitor takes over the first visitor's room would be one microphone for
// the whole website. So this ALWAYS MINTS, never reuses, and it does not go near
// that unique index (whose predicate names `'web'` and therefore does not cover
// these rows — which is also why widening `isWebRoom` was rejected; see
// `registry-shared.ts` `isBrowserMintedRoom`).
//
// ⚠️ SO THE TTL IS THE ONLY THING THAT BOUNDS THE ROW COUNT, and nothing sweeps
// it today: `ensureWebRoom` reaps an expired room only when the SAME account
// asks for one again, and this function never asks. Named rather than hidden —
// the rows are small, the pairing code is released back to the governor on its
// own clock, and a sweep is a follow-up (registered in MP-1's own handover)
// rather than something invented here on the way past.
//
// ✅ card MP-11 / gap G-5 (2026-09-11) — THAT FOLLOW-UP LANDED. `db/reaper.ts`
// now sweeps `room_kind='integrator'` rows past their `room_expires_at` on its
// existing daily tick (no new timer), through the same `pcs.remove` the
// same-account path above uses, so both roads delete the same thing the same
// way. The paragraph above is kept, not rewritten: everything it says about
// WHY this function never asks is still true, and「the TTL is the only thing
// that bounds the row count」is the sentence that stopped being true.
//
// ⚠️ TTL TEN MINUTES, SWEEP ONCE A DAY, and the two are about different facts:
// the TTL bounds how long this room WORKS (this file's job), the sweep bounds
// how long the ROW SITS THERE (that file's). A room is dead to every reader the
// instant it expires whether or not anything has collected it yet.

import { randomUUID } from 'node:crypto';
import type { PcRecord } from '../db/repos/pc.repo';
import type { PcRepo } from '../db/repos/pc.repo';
import { newToken } from '../auth/token';
import { INTEGRATOR_ROOM_KIND } from './registry-shared';

/** How long an integrator room lives without being asked for again.
 *
 *  TEN minutes, the site demo's number rather than the web client's thirty: a
 *  host page's visitor is somebody who landed on somebody else's website, and a
 *  tab they closed should not hold a room (or a 4-digit code out of a
 *  10 000-wide space) for half an hour. */
export const INTEGRATOR_ROOM_TTL_MS = 10 * 60_000;

/**
 * What an integrator room is called when its key has no name — the fallback,
 * since card MP-13, rather than the answer.
 *
 * 🔴🔴 CORRECTION (card MP-13, owner 2026-09-11 §11 追认 item 6). This constant's
 * note used to end: 「Deliberately NOT the integrator's own site name: we would
 * be putting a third party's brand on our users' screens from a value they
 * control.」 Kept here because it names a real cost and that cost is now PAID ON
 * PURPOSE — the owner ruled the other way, and the reason is the visitor's:
 * somebody who taps a microphone on `acme.example` and then looks at their
 * phone should see 「Acme Docs」, not a FlowMic product name that tells them
 * nothing about where their words are going. 「A value they control」 is answered
 * by making the name REQUIRED and validated at creation
 * (`console-integrator-routes.ts`), not by refusing to show it.
 *
 * What the rest of the old note said is still true and still the reason this
 * constant exists at all: the string reaches a phone's top bar, the server has
 * no locale for that end, and so it is NEVER localized. A site's name is its
 * own name in every language.
 */
export const INTEGRATOR_ROOM_PC_NAME = 'FlowMic Web';

/**
 * card MP-13 — the room name for a key, from that key's label.
 *
 * 🔴 IT DOES NOT TRUNCATE, and that is a measurement rather than an oversight:
 * `console-integrator-routes.ts` caps a new label at `MAX_LABEL_CHARS` (64),
 * which sits INSIDE the 80 that `settings.handler.ts` `PC_NAME_MAX` already
 * allows any PC to be renamed to — so every value that can reach here already
 * fits the budget `pc_devices.device_name` and the phone's top bar are used to.
 * The relationship between those two numbers is pinned by
 * `test/console-integrator-routes.test.ts` rather than by an import, because an
 * import would run from `room/` into `socket/handlers/` for one integer.
 * (A silent truncation would also be 「the quiet kind of lie」 `parsePcName`'s own
 * note refuses to tell.)
 *
 * ⚠️ IT DOES STRIP CONTROL CHARACTERS, and only for rows written BEFORE that
 * validation existed — a label created under MP-1 was accepted as any string at
 * all. This is not a second author for the create-time rule: new labels can
 * never reach this branch, and a newline in a name on somebody's phone is not
 * worth leaving to chance for the ones that can.
 *
 * `null` / whitespace-only ⇒ the fallback above: an unnamed key is a real state
 * (every key minted before this card), and 「」 on a phone's top bar answers
 * nothing.
 */
export function integratorRoomName(label: string | null | undefined): string {
  // C0 plus DEL, replaced by a space rather than deleted: a name written as
  // two words separated by a newline should stay two words.
  const clean = (label ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return clean === '' ? INTEGRATOR_ROOM_PC_NAME : clean;
}

export interface IntegratorRoomDeps {
  pcs: Pick<PcRepo, 'insert' | 'findById'>;
  /** `Registry.allocateCode` — a free 4-digit code, reserved for `ownerId`. */
  allocateCode(ownerId?: string): string;
  /** `ShortCodeGovernor.stamp` — this code is now live for this row. */
  stampCode(pcId: string, code: string): void;
  /** `Registry.stampPcid` — mint the row's public PCID if it has none. */
  stampPcid(pc: PcRecord): void;
  /** `IntegratorKeyRepo.bindRoom` — record WHICH key minted this room. */
  bindRoom(pcDeviceId: string, keyId: string, createdAt: number): void;
  now(): number;
}

export interface IntegratorRoomOutcome {
  pc: PcRecord;
  token: string;
  code: string;
  expiresAtMs: number;
}

/**
 * A fresh room owned by the integrator `user_id`, marked with `key_id`.
 *
 * Pure over the deps — no HTTP, no authentication, no opinion about whether the
 * key was valid. The route owns all of that, and keeping it out of here is what
 * lets a unit test drive real rows.
 */
export function mintIntegratorRoom(
  deps: IntegratorRoomDeps,
  user_id: string,
  key_id: string,
  /** `deviceName` — card MP-13, the site's own name, already derived by
   *  {@link integratorRoomName}. Optional because the fallback it produces is a
   *  real answer for an unnamed key, NOT because a caller may skip thinking
   *  about it: the ONE production caller (`http/web-room-routes.ts`
   *  `handleIntegrator`) always passes it, and G31 asserts the name that comes
   *  out the other end equals the key's label. */
  opts?: { ttlMs?: number; deviceName?: string },
): IntegratorRoomOutcome {
  const nowMs = deps.now();
  const expiresAtMs = nowMs + (opts?.ttlMs ?? INTEGRATOR_ROOM_TTL_MS);
  const id = randomUUID();
  const token = newToken();
  const code = deps.allocateCode();
  const pc = deps.pcs.insert({
    id,
    user_id,
    device_name: opts?.deviceName ?? INTEGRATOR_ROOM_PC_NAME,
    // NOT set, for `ensureWebRoom`'s reason: `client_instance_id` / `machine_uid`
    // / `client` are the FAR END's own declarations and this row has no far end
    // until the host page connects to it.
    room_kind: INTEGRATOR_ROOM_KIND,
    room_expires_at: new Date(expiresAtMs).toISOString(),
    device_token: token,
    room_uuid: randomUUID(),
    short_code: code,
  });
  deps.stampCode(pc.id, pc.short_code);
  // 🔴 THE KEY EDGE IS WRITTEN AFTER THE ROW AND BEFORE ANYTHING IS RETURNED,
  // and the order matters in one direction only: a room that exists without its
  // edge would resolve to `integratorKeyId: null`, i.e. a room billed to T with
  // NO sub-quota ceiling — the one failure mode the sub-quota exists to prevent.
  // A row that failed to insert never reaches this line, so the edge cannot
  // outlive a room that does not exist. (Both are in the same process and the
  // same request; a transaction across them would need the repo layer to expose
  // one, which no other mint site here does either.)
  deps.bindRoom(pc.id, key_id, nowMs);
  // 🔴 DELIBERATELY NOT `setOnline(true)` — `ensureWebRoom` states it: nothing is
  // connected at this instant, and a row claiming to be online is read as 「that
  // end is here right now」 by the console's presence projection.
  deps.stampPcid(pc);
  return { pc: deps.pcs.findById(pc.id) ?? pc, token, code, expiresAtMs };
}
