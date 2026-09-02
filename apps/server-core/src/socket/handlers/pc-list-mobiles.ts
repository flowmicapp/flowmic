// SPEC-REF: apps/server-core/src/socket/handlers/pc.handler.ts (the ONE
//   caller — registerPcHandlers calls this at the end of its own body).
//
// MOVED OUT OF pc.handler.ts VERBATIM (2026-09-02, WP-6) for the 800-line
// `file-size` lint, the same cap `mobile.handler.ts`/`bootstrap-http-deps.ts`
// keep bumping against — no behaviour moved with the code.

import type { Socket } from 'socket.io';
import { safeParseEvent } from '@flowmic/protocol';
import type { Registry } from '../../room/registry';
import type { RoomStore } from '../../room/store';
import { getAuth, safeAck } from '../wire';

// R6 T-8 — "paired phones" table for the desktop device page.
//
// OWNERSHIP (three gates, all of them structural rather than trusting input):
//   1. the socket must be an authenticated PC (auth.kind === 'pc' + deviceId);
//   2. the pc_devices row is resolved from that OWN deviceId — the payload is
//      `{}` and carries no addressable id, so there is nothing to spoof;
//   3. the row's user_id must equal the socket's userId (defence in depth for
//      the saas multi-tenant case; standalone collapses to 'default').
//   Rows are then read by pc_device_id, so a mobile paired to ANOTHER PC — of
//   this user or any other — is not reachable from this query at all.
//
// PROJECTION: five public fields, spelled out one by one. `mobile_token` is a
// bearer secret (05 §7) and NEVER crosses this wire — the raw record is read
// into `m` and only named fields leave it (same rule as the REST
// /api/cloud/devices projection).
//
// `online` is REAL presence: the live RoomStore membership of THIS PC's room,
// keyed by the same pairing id the mobile joined under (mobile.handler
// store.joinMobile(room, mobile.id, socket)) — never the persisted
// last_seen_at replayed as if it were live.
export function registerPcListMobilesHandler(
  socket: Socket,
  deps: { registry: Registry; store: RoomStore<Socket> },
): void {
  const { registry, store } = deps;
  socket.on('pc:list-mobiles', (payload: unknown, ack: unknown) => {
    const parsed = safeParseEvent('pc:list-mobiles', payload);
    if (!parsed.success) return safeAck(ack, { error: 'PAIR_INVALID_PAYLOAD' });
    const auth = getAuth(socket);
    // 🔴 TWO REFUSALS, TWO QUESTIONS — this used to be one code answering both,
    // and it cost users their cloud login (2026-09-01).
    //
    // `!auth` means this connection has not had its `pc:register` /
    // `pc:reconnect` ack land YET. Nothing is wrong with anything: the desktop
    // dials, opens, and its handshake is in flight. Measured on dev-pc-a
    // (four occurrences 2026-08-30 → 2026-09-01), the ack landed 56–335 ms AFTER
    // this refusal every time — so answering AUTH_TOKEN_INVALID here published
    // 「令牌无效，请重新配对」 about a token the very next frame accepted, and the
    // desktop's account-verdict routing deleted the user's Cloud Key over it.
    // A code that says 「ask again in a moment」 is the only true one, and retry
    // is advice that actually works here (unlike PAIR_RATE_LIMITED's 「later」).
    if (!auth) return safeAck(ack, { error: 'PC_HANDSHAKE_PENDING' });
    // The remaining three keep AUTH_TOKEN_INVALID, and that is deliberate: an
    // authenticated socket that is not a PC, or a PC token naming a row this
    // account does not own, IS a credential this relay will not serve — the
    // registered sentence (「令牌无效，请重新配对」) is true of all three.
    if (auth.kind !== 'pc' || !auth.deviceId) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    const pc = registry.findPc(auth.deviceId);
    if (!pc || pc.user_id !== auth.userId) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    const mobiles = registry.listMobilesForPc(pc.id).map((m) => ({
      pairing_id: m.id,
      mobile_name: m.mobile_name,
      paired_at: m.paired_at,
      last_seen_at: m.last_seen_at,
      // v0.2.4 — which physical handset this row belongs to, so the desktop can
      // say "these two rows are the same phone" across the LAN and relay lists instead of
      // showing two identical rows. Null (pre-0.2.4 pairing) groups with NOTHING.
      device_uid: m.device_uid,
      // the lead's ruling (GA-04 ↔ GA-07 crossover): the ROSTER answers "is this phone's
      // socket up right now」, which a slot in mobile-drop grace is NOT. The
      // grace exists to keep the audio SESSION alive and to debounce the
      // presence announcement — it is not a claim that the phone is online,
      // and reporting it here would be exactly the fabricated status G12
      // guards against. Two different questions, two different answers.
      online: store.getMobile(pc.room_uuid, m.id)?.connected === true,
    }));
    safeAck(ack, { mobiles });
  });
}
