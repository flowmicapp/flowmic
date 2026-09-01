// SPEC-REF:
//   docs/decisions/2026-08-28-owner-web-rulings-console-device-management.md
//     §5-1 (presence must NOT be answered from the persisted `is_online` flag)
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §10-9
//   apps/server-core/src/node/node-runtime.ts (`stampPresence` — the producer
//     half of the forwarded timestamp this function reads)
//   apps/server-core/test/cross-node-presence.test.ts (the reverse controls)
//
// "IS THIS COMPUTER HERE RIGHT NOW" — the whole answer, for every surface.
//
// ── WHY IT IS ITS OWN FILE ─────────────────────────────────────────────────
// It was born inside http/console-device-routes.ts, under a header that said it
// "has exactly two callers", both of them in that file. That stopped being true
// the day the phone-facing surfaces needed the same answer, and a presence rule
// living inside the console's WRITE surface would have to be imported by socket
// handlers that have no business reaching into http/. Moved VERBATIM (the body,
// both constants and every comment travelled unchanged) to sit beside its
// siblings — room/pc-absence.ts answers "why is it not here", this one answers
// "is it here", and room/machine-reassigned.ts answers "is that machine
// somewhere else now".
//
// ── 🔴 THE ONE THING THAT MUST NOT DRIFT ───────────────────────────────────
// EVERY "is this PC here right now" answer goes through this one function. Not
// a style preference: two expressions are two answers, and they are read by the
// same person about the same computer within seconds of each other. The
// surfaces, named so a reader can check the claim rather than believe it (grep
// `pcPresence(`):
//   · http/console-routes.ts        — the console GET projection (`is_present`,
//                                     which decides whether the browser draws
//                                     the remove button)
//   · http/console-device-routes.ts — the remove route, which decides whether to
//                                     honour the click
//   · http/presence-routes.ts       — GET /api/pc/presence, which is what the
//                                     phone's resting instance list polls every
//                                     10 s
//   · socket/handlers/mobile.handler.ts — `pc_online` on the mobile:pair ack and
//                                     on the mobile:reconnect ack
// If any of them ever computes presence separately they will disagree, and the
// user gets a computer that is online on one screen and offline on the next —
// or, before 2026-09-01, a computer that the console called present and the
// phone that owns it called absent, because the phone-facing three still read
// `store.getPc(room) !== null` and rooms are per-process.

import { AUDIO_DEFAULTS } from '@flowmic/protocol';
import { DRAIN_INTERVAL_MS } from '../node/outbox-drainer';
import { PULL_INTERVAL_MS } from '../node/replica-puller';

/**
 * How stale `last_seen_at` may get before a room membership stops counting as
 * presence. NOT a number chosen here: it is the protocol's own heartbeat
 * timeout (15 s), and the desktop pump emits a beat every 5 s for as long as its
 * handshake is acked — IDLE INCLUDED (socket/pump.rs gates the beat on `acked`,
 * not on an audio session, so a connected computer nobody is talking to still
 * stamps `last_seen_at`). Three beats missed is the same threshold the audio
 * side already treats as "this peer stopped talking to us".
 *
 * Read through the protocol constant rather than restated, so moving the
 * protocol's number moves this one. A literal here would be a second copy that
 * drifts in silence.
 */
const PRESENCE_STALE_MS = AUDIO_DEFAULTS.heartbeat_timeout_ms;

/**
 * Extra staleness allowed for a PC whose heartbeat reaches this node through the
 * replica outbox rather than through its own socket.
 *
 * IMPORTED, not typed as a number: it IS one outbox drain, and if that interval
 * ever changes this window has to change with it. A literal `5000` here would be
 * the second copy that drifts in silence — the same reason `PRESENCE_STALE_MS`
 * above reads the protocol constant instead of spelling 15000.
 */
const REMOTE_PRESENCE_SLACK_MS = DRAIN_INTERVAL_MS;

/**
 * Still more staleness, for a node that did not receive the forwarded stamp
 * itself but read it out of a snapshot.
 *
 * IMPORTED for the same reason the other two are — it IS one replication pull,
 * and `PULL_INTERVAL_MS` moving has to move this. See `PcPresenceOptions`
 * below for WHEN it applies; it is deliberately not part of
 * `REMOTE_PRESENCE_SLACK_MS`, because on the writer this delay does not exist.
 */
const REPLICA_PULL_SLACK_MS = PULL_INTERVAL_MS;

/**
 * The READ-ONLY room lookup this answer needs, and nothing more.
 *
 * One method, and its return type is `object | null` because the only thing
 * asked of the value is whether there IS one. Return-position only, so the
 * production `RoomStore<Socket>` and the console's `RoomLookup` both satisfy it
 * structurally with no cast — and a test can hand over a store of fake sockets
 * without one either, which matters more than it looks: a cast is where a test
 * stops proving things about the type production code actually gets.
 */
export interface PcPresenceStore {
  getPc(room_uuid: string): object | null;
}

/**
 * The three columns this answer reads, named structurally rather than typed as
 * `PcRecord`.
 *
 * That keeps this module free of any import from db/ or http/ (it is called
 * from socket handlers too), and it states the contract at the same time: a
 * caller that has these three fields can ask, and nothing else about a PC row
 * takes part in the decision. `is_online` is conspicuously NOT here — see the
 * function's own note on why that column may not answer this question.
 */
export interface PcPresenceRow {
  room_uuid: string;
  home_node?: string | null;
  last_seen_at?: string | null;
}

/**
 * Everything about the ASKING NODE that changes the answer. One optional
 * object, and its ABSENCE is the writer / single-node deployment — i.e. the
 * behaviour this function had before the option existed, byte for byte.
 */
export interface PcPresenceOptions {
  /**
   * True when THIS node's `pc_devices` rows arrive via the replication pull —
   * that is, when its role is 'replica' (node/node-config.ts).
   *
   * 🔴 WHY IT WIDENS THE REMOTE WINDOW, in arithmetic rather than adjectives.
   * A remote PC's `last_seen_at` reaches a reader over a chain, and the reader
   * sits at a different point on it depending on who it is:
   *
   *   PC heartbeat (5 s)  →  its own node writes the row
   *                       →  replica outbox drain (DRAIN_INTERVAL_MS, 5 s)
   *                       →  THE WRITER's row is current            ← writer reads here
   *                       →  replication pull (PULL_INTERVAL_MS, 30 s)
   *                       →  a replica's copy is current            ← replica reads here
   *
   * The writer receives forwarded stamps every drain, so `PRESENCE_STALE_MS +
   * REMOTE_PRESENCE_SLACK_MS` (20 s) is the right window there and stays the
   * window there. A replica's copy of somebody else's row only advances at the
   * pull, so under a 20 s window a perfectly healthy remote PC would read
   * ONLINE right after a pull and OFFLINE ten seconds later, flapping with the
   * pull period — the phone's instance list would blink its computer in and out
   * every thirty seconds while nothing at all was wrong.
   *
   * ⚠️ It widens the REMOTE branch only. A PC whose home node is this one is
   * still judged on live room membership plus the narrow window: this node
   * writes that row itself on every beat, so the pull is not in its chain.
   *
   * ⚠️ THE COST, stated rather than discovered: on a replica a remote PC that
   * really did go away is reported present for up to 50 s. That is the price of
   * not lying about the healthy case, and it is the direction this repo's
   * phone-facing rule requires — never a false "your computer is offline".
   */
  rowsFromReplicationPull?: boolean;
}

/**
 * Is this computer in its room RIGHT NOW — the present tense, for one row.
 *
 * 🔴 `pc_devices.is_online` IS NOT CONSULTED, and that is the whole point of
 * this function existing (owner ruling 2026-08-28 §5-1). That column is a
 * PERSISTED FLAG: a relay restart drops every room and leaves a whole fleet of
 * rows still saying `is_online = 1`. Answering the present tense with it is how
 * a computer that has been powered off for a week reads as "online" — and with
 * removal refused for a present computer, a lying flag would make that row
 * permanently undeletable. That is the dead end this whole surface exists to
 * remove, wearing a different hat. The column keeps being what it is; it simply
 * does not answer this question.
 *
 * TWO conditions, because each covers a gap the other leaves:
 *   ① room membership — `store.getPc(room_uuid) !== null`, the SAME expression
 *      `pc_online` and GET /api/pc/presence already answer with. Survives the
 *      stale-flag problem entirely: a restarted relay has empty rooms.
 *   ② heartbeat freshness — socket.io keeps a force-killed peer in the room for
 *      up to its ~20 s pingTimeout, so membership alone has a ghost window. The
 *      pump's 5 s beat closes it at `heartbeat_timeout_ms`.
 *
 * ⚠️ FAILURE DIRECTION, stated rather than left to be discovered: if the
 * `last_seen_at` write is failing (a full disk — heartbeat.handler.ts logs it
 * and carries on), a genuinely present PC goes stale and reads as absent. That
 * makes it REMOVABLE, and removing it costs the user nothing they cannot undo:
 * the machine re-registers on its next connection. The opposite bias — treating
 * a stale row as present — would restore the undeletable-row dead end. Fail
 * toward the recoverable side.
 *
 * ⚠️ A row that has NEVER connected has `last_seen_at === null`. That is absent,
 * not present: `Date.parse(null as never)` is NaN and every comparison against
 * NaN is false, so the explicit null check below is not defensive noise — it is
 * the difference between "absent" and an accidental "present".
 */
export function pcPresence(
  store: PcPresenceStore,
  pc: PcPresenceRow,
  now: number,
  thisNode?: string | null,
  opts?: PcPresenceOptions,
): boolean {
  // ── 2026-08-30, multi-node ────────────────────────────────────────────────
  // 🔴 CONDITION ① IS UNANSWERABLE FOR A PC ON ANOTHER NODE, and asking it
  // anyway is not a conservative default — it is a wrong answer with a
  // consequence. Rooms are per-process (`room/store.ts`: "Live socket presence
  // ONLY"), the console always talks to the WRITER, so a perfectly healthy
  // computer on a replica can never be in the writer's RoomStore. It would read
  // absent — and by this function's own failure-direction note that also makes
  // its row REMOVABLE.
  //
  // The honest substitute is the freshness of a `last_seen_at` written BY THE
  // NODE THAT HOLDS THE SOCKET and forwarded here (node-runtime `stampPresence`
  // → the writer's `setPresence`). That is not the persisted `is_online` flag
  // owner ruled out in §5-1: that column is sticky and survives a restart, while
  // this is a timestamp that stops advancing the moment the heartbeat stops.
  //
  // ⚠️ THE WINDOW IS WIDER FOR A REMOTE PC, and the number is derived rather
  // than picked: the local path sees a heartbeat every 5 s, the forwarded path
  // adds one outbox drain (5 s) plus a cross-ocean RTT. 15 s would leave about
  // 5 s of margin and turn one late drain into "your computer is offline".
  // `+ DRAIN_INTERVAL_MS` states where the extra came from, so anyone who
  // changes the drain interval finds this.
  //
  // ⚠️ `thisNode` ABSENT means single-node, which is every deployment that is
  // not the relay: `home_node` is null there, the first branch never runs, and
  // the behaviour is byte-for-byte what it was.
  const remote = typeof pc.home_node === 'string'
    && pc.home_node.length > 0
    && typeof thisNode === 'string'
    && pc.home_node !== thisNode;
  if (!remote && store.getPc(pc.room_uuid) === null) return false;
  if (pc.last_seen_at === null || pc.last_seen_at === undefined) return false;
  const seen = Date.parse(pc.last_seen_at);
  if (!Number.isFinite(seen)) return false;
  if (!remote) return now - seen < PRESENCE_STALE_MS;
  // One more drain if this node read the stamp out of a snapshot instead of
  // receiving it — see PcPresenceOptions for the chain and for why the writer
  // must NOT get this term.
  const pull = opts?.rowsFromReplicationPull === true ? REPLICA_PULL_SLACK_MS : 0;
  return now - seen < PRESENCE_STALE_MS + REMOTE_PRESENCE_SLACK_MS + pull;
}
