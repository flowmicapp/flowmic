// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §7 (Cloud KEY JWT expiry → auth:expired
//     watchdog, F-2093)
//   docs/strategy/R4-PRIVATE-TASK-CARDS.md WP-R4-1 ③ (sockets whose identity
//     rests on a JWT get a timer at exp → emit auth:expired + disconnect;
//     pairing-token sockets are exempt)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (auth:expired is a whitelisted S→C
//     event with an empty {} payload — no new socket event, EVENT_NAMES=55)
//   docs/rebuild/18-CONNECTION-STATES-THREE-ENDS.md §7.3 (write site ①: the
//     kick records the ABSENCE REASON presence then answers with)
//   *** HUMAN-AUDIT SENSITIVE (auth) — reviewable in isolation ***
//
// A per-socket JWT-expiry watchdog for saas. Armed for a socket whose identity
// rests on a JWT (a verified handshake JWT, or an in-session mobile:login mint).
// A single timer fires at the token's `exp`: emit auth:expired {}, drop the
// account, disconnect — so the mobile clears its stored JWT and re-authenticates
// (fail-loud, never a silently-dead session). Sockets that authenticate with an
// opaque pairing token (mobile:pair / mobile:reconnect) never call this and are
// exempt. The timer is cleared on disconnect so a days-out `exp` never leaves a
// pending timer holding a dead socket reference.
//
// The fire ALSO records why that PC's room is about to be empty (book 18 §7.3,
// owner ruling ⑧) so `GET /api/pc/presence` can answer "its cloud login
// expired" instead of a bare "not here" — the fact this kick has always known
// and never told anyone. That is a write into presence state, not a protocol
// change: no new event, no new error code.

import type { Socket } from 'socket.io';
import { pcAbsenceReasons } from '../../room/pc-absence';
import { getAuth, getRoomUuid, setAccount } from '../wire';

export interface AuthExpiryClock {
  /** ms-since-epoch clock; defaults to Date.now. Injectable for tests. */
  nowMs?: () => number;
  /** Injectable scheduler for deterministic tests (defaults to global timers). */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Node's timer delay is stored in a SIGNED 32-BIT INT. A delay above this
 * overflows: Node emits `TimeoutOverflowWarning` and re-schedules the timer
 * with a delay of **1 ms** — i.e. it fires AT ONCE, which is the exact opposite
 * of what the caller asked for.
 *
 * 🔴 This is not a theoretical limit here. Since the 2026-08-27 owner ruling
 * (docs/decisions/2026-08-27-owner-persistent-login-and-routing-order.md §R1)
 * `DEFAULT_TTL_MS` is 100 YEARS, so EVERY freshly minted token's `exp` is far
 * past this line. Without the guard below, arming the watchdog for a normally
 * signed-in socket would kick it inside the same tick — persistent login would
 * have shipped as "you can never stay connected". Reverse control:
 * `test/auth-expiry-clamp.test.ts` (run against the unguarded version it fails
 * with `expected true to be false` on `socket.disconnected`).
 */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Arm the auth:expired disconnect at `expEpochSec`. Idempotent-per-fire (fires
 *  at most once). An `exp` already in the past schedules a 0ms fire.
 *
 *  An `exp` further out than [MAX_TIMEOUT_MS] arms NOTHING — no timer, and no
 *  `disconnect` cleanup listener for a timer that does not exist.
 *
 *  🔴 WHY NOT A RE-ARMING CHAIN (the obvious alternative: sleep 24 days, wake,
 *  sleep again). Two reasons, and the second is the real one:
 *   · a chain is a long-lived object holding a socket reference across dozens of
 *     wake-ups, i.e. more machinery than the thing it guards;
 *   · a 100-year expiry is not an event. This watchdog exists so a session
 *     cannot sit there silently dead after its credential lapses — a credential
 *     that lapses after the user's lifetime never produces that situation. The
 *     honest statement is "there is nothing to watch for", and arming nothing is
 *     how you say that.
 *  Legacy 7-day tokens still in the wild are far inside the limit, so their
 *  behaviour here is byte-identical to before. */
export function armAuthExpiry(socket: Socket, expEpochSec: number, clock: AuthExpiryClock = {}): void {
  const nowMs = clock.nowMs ?? Date.now;
  const setT = clock.setTimeoutFn ?? setTimeout;
  const clearT = clock.clearTimeoutFn ?? clearTimeout;
  const delayMs = expEpochSec * 1000 - nowMs();
  if (!Number.isFinite(delayMs) || delayMs > MAX_TIMEOUT_MS) return;
  let fired = false;
  const handle = setT(() => {
    if (fired) return;
    fired = true;
    socket.emit('auth:expired', {});
    // book 18 §7.3 write site ① — record WHY this room is about to be empty,
    // BEFORE the disconnect that empties it, so there is never an instant where
    // /api/pc/presence answers "not here" with the reason still missing.
    //
    // Guarded on "a PC that is in a room" rather than fired blindly: this
    // watchdog is also armed for MOBILE sockets whose identity rests on a JWT
    // (an in-session mobile:login, auth.handler), and a phone's expiry says
    // nothing about any PC's presence. `roomUuid` + `kind === 'pc'` are stamped
    // together by pc:register/pc:reconnect, so the pair is the same fact.
    const auth = getAuth(socket);
    const roomUuid = getRoomUuid(socket);
    if (auth?.kind === 'pc' && roomUuid !== null) {
      pcAbsenceReasons.noteByRoom(roomUuid, 'auth_expired');
    }
    setAccount(socket, null);
    socket.disconnect(true);
  }, Math.max(0, delayMs));
  socket.on('disconnect', () => clearT(handle));
}
