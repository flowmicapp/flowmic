// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.2 (heartbeat{ts} — application-layer
//     liveness on top of the transport ping)
//   docs/rebuild/05-DATA-MODEL.md §1 (pc_devices.last_seen_at,
//     mobile_pairings.last_seen_at)
//   docs/strategy/2026-07-25-full-gap-audit/01-SERVER-PROTOCOL.md GA-07
//
// `heartbeat` had ZERO consumers: the desktop pump emitted it every tick and the
// server dropped it on the floor, which meant `last_seen_at` only ever moved at
// pair/reconnect time. The device page then showed a "recent activity" stuck at the
// moment of pairing while the phone was actively talking — a displayed value
// that was not a lie about presence (that column is fed by real RoomStore
// membership) but WAS a lie about activity.
//
// This is the consumer. One event, one effect: stamp last_seen_at on whichever
// row this socket's identity points at. It writes nothing else, answers nothing
// else, and an unidentified socket gets the honest refusal code rather than a
// silently swallowed frame.

import type { Socket } from 'socket.io';
import { safeParseEvent } from '@flowmic/protocol';
import type { PcRepo } from '../../db/repos/pc.repo';
import type { MobileRepo } from '../../db/repos/mobile.repo';
import { RateGate, type GuardLogger } from '../../error-handling';
import { log } from '../../log';
import { getAuth, safeAck } from '../wire';

/** D4: one log line per window for a failing last_seen_at write. Beats arrive
 *  every 5 s per client — a dead disk under N clients would otherwise write
 *  N lines / 5 s forever. The gate carries a suppressed-count on each line,
 *  so volume is reduced, never hidden. */
export const HEARTBEAT_WRITE_FAILURE_LOG_WINDOW_MS = 30_000;

/** ONE gate per process, shared across every socket's handler on purpose:
 *  a dead disk fails every socket at once, and per-socket gates would
 *  multiply the flood right back (same reasoning as error-handling.ts's
 *  shared per-event gates). */
const sharedWriteFailureGate = new RateGate(HEARTBEAT_WRITE_FAILURE_LOG_WINDOW_MS);

export interface HeartbeatHandlerDeps {
  pcs: PcRepo;
  mobiles: MobileRepo;
  /** Server clock. The payload's `ts` is the CLIENT's clock and is deliberately
   *  NOT trusted for a stored timestamp (a phone with a wrong clock would write
   *  a last_seen_at in 2031). Injected for deterministic tests. */
  now?: () => Date;
  /** D4 test seams. Defaults are the REAL logger and the REAL shared gate —
   *  never no-ops (DI-default rule). */
  logger?: GuardLogger;
  writeFailureGate?: RateGate;
}

export function registerHeartbeatHandler(socket: Socket, deps: HeartbeatHandlerDeps): void {
  const now = deps.now ?? ((): Date => new Date());
  const logger = deps.logger ?? log;
  const gate = deps.writeFailureGate ?? sharedWriteFailureGate;

  socket.on('heartbeat', (payload: unknown, ack: unknown) => {
    const parsed = safeParseEvent('heartbeat', payload);
    if (!parsed.success) return safeAck(ack, { error: 'PAIR_INVALID_PAYLOAD' });
    const auth = getAuth(socket);
    if (!auth) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    const when = now().toISOString();
    let touch: () => void;
    if (auth.kind === 'pc' && auth.deviceId) {
      const deviceId = auth.deviceId;
      touch = (): void => deps.pcs.touchLastSeen(deviceId, when);
    } else if (auth.kind === 'mobile' && auth.pairingId) {
      const pairingId = auth.pairingId;
      touch = (): void => deps.mobiles.touchLastSeen(pairingId, when);
    } else {
      // Authenticated but with no row to point at — that is a bug in whoever set
      // socket.data.auth, not a heartbeat to swallow.
      return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    }
    try {
      touch();
    } catch (err) {
      // D4 layer 3 — the DB write failed (disk full / EIO). Before this catch,
      // that throw rode socket.io's bare process.nextTick dispatch into an
      // uncaughtException: EVERY beat crashed the whole relay, 5 s apart,
      // forever (crash loop). Degraded behavior, stated honestly:
      //   · the process and the socket live on; presence itself is unharmed
      //     (pc_online / rosters are answered from the in-memory RoomStore,
      //     not from this column);
      //   · the failure is LOUD in the log (rate-gated with a suppressed
      //     count — reduced line volume, never hidden event volume);
      //   · the ack stays `ok:true` because `ok` is what the mobile's
      //     probeLink (timeline_sync.dart) reads as 「can a delivery go out on
      //     this socket right now」 — and it can: delivery is RoomStore relay,
      //     not this write. Acking an error here would tell every phone the
      //     link is down and stall manual sends over a bookkeeping column.
      //   · `last_seen_at` is `null` because the stamp did NOT land — echoing
      //     `when` would report undone as done (red line, both directions).
      //     One value answers one question: ok = the link, last_seen_at = the
      //     stamp. "recent activity" goes stale while the disk is broken, and the
      //     log says so; the next successful beat resumes stamping (nothing
      //     latches).
      const e = err instanceof Error ? err : new Error(String(err));
      const suppressed = gate.tryAcquire();
      if (suppressed !== null) {
        logger.error('heartbeat: last_seen_at write failed — presence stays in-memory, stamp skipped', {
          kind: auth.kind,
          error: e.message,
          suppressedSinceLastLine: suppressed,
        });
      }
      return safeAck(ack, { ok: true, last_seen_at: null });
    }
    safeAck(ack, { ok: true, last_seen_at: when });
  });
}
