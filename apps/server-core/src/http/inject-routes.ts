// SPEC-REF:
//   docs/decisions/2026-07-30-image-http-upload-and-socket-hardening.md
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (inject:request/result semantics —
//     REUSED verbatim: this route validates with the same zod schemas and
//     relays the same frame; it is an alternative INGRESS, not a second
//     protocol)
//   docs/rebuild/05-DATA-MODEL.md §1 (row-first D10: the timeline row exists
//     before the inject; status carries delivery truth via inject:result)
//   docs/decisions/2026-07-31-owner-two-channels-transit-not-storage.md (Card S:
//     this ingress carries the same 🔴 target_pc_id check as the socket leg —
//     a red line with one entrance guarded is not a red line)
//   CLAUDE.md red line: no silent failures · never let IDs get crossed
//   *** HUMAN-AUDIT SENSITIVE (injection path) — reviewable in isolation ***
//
// POST /api/inject/image — the phone delivers a picture over a FRESH http
// request instead of the long-lived room socket.
//
// WHY (RCA-v3, 2026-07-30): every image send necessarily rides through the
// system photo picker, which backgrounds the app; aggressive OS power policy
// (owner's EMUI handset) severs the TCP link in the background WITHOUT the
// Dart client noticing for up to pingInterval+pingTimeout. A frame emitted in
// that dead-but-undetected window vanishes into a dead pipe — no receipt, no
// log, a 20 s watchdog mystery. An http POST makes a NEW connection per
// attempt, so a dead link is an immediate visible error instead of a silent
// swallow, and the response carries the PC's REAL verdict (owner 2026-07-30:
// "upload the image to the PC first, save it into the data directory, and
// then copy it -> CTRL+V").
//
// STANDALONE ONLY for now (router gates it): on the LAN the phone talks to the
// PC's own sidecar, so "save it to the data directory" lands on the owner's machine. The
// cloud channel keeps the hardened socket path — mounting this on the public
// relay would make the relay persist user images at rest, which is a data
// policy decision (the blind-store boundary) the socket pass-through does not raise.
//
// ⚠️ RV-87 (2026-08-01) — WHY THE CLOUD IMAGE POLICY IS NOT ALSO ENFORCED HERE,
// written down so the next audit of 「did they guard both entrances?」 finds an
// answer instead of a hole. The 1 MiB / 200-per-24h ceilings apply to the RELAY,
// and this ingress does not exist on the relay: `http/router.ts` mounts it under
// `config.mode === 'standalone' && deps.inject && tryHandleInjectRoutes(...)`, so
// in saas the path falls through to the router's 404 — the same 「not mounted in
// this mode」 answer /api/network and the probe routes give. Adding the check here
// would therefore guard a door that is bricked up, and would ALSO be wrong the
// day it is unbricked for a different reason, because the policy object NOOPs on
// `mode`. Unlike Card S's target check — which had to be duplicated because BOTH
// ingresses are live on the LAN — there is nothing to duplicate. If this route is
// ever mounted in saas, the policy comes with it: `socket/cloud-image-policy.ts`
// is already a plain decision object with no socket in it.
//
// Flow: bearer token → pairing (same registry the socket reconnect uses) →
// zod-validate the inject frame (SAME InjectRequestSchema) → 🔴 target_pc_id: it
// must be PRESENT (0.2.33, INJECT_PC_UNSPECIFIED) and must be THIS PC
// (INJECT_PC_MISMATCH) — the same two-verdict gate relay.handler applies →
// request_id idempotency (RV-04) → suppression gate (RV-05) → save the image file
// (best-effort, said honestly either way) → claim the request_id → relay
// inject:request to the room's PC → WAIT for the PC's inject:result (bounded)
// → answer with the real verdict, and REMEMBER that answer.
//
// 0.2.27 (owner's architecture ruling, docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md):
// the two steps this route used to take on `transcript_history` — upsert the
// timeline row with the same stamping/idempotency as history:create, and stamp
// `failed` when no PC was in the room — are GONE with the table. The picture's
// delivery is unchanged; what changed is that the ROW's owner is the phone, and
// the phone learns this delivery's outcome from THIS RESPONSE (every branch
// echoes request_id/entry_id, RV-05) instead of from a server row it no longer
// has. `parsedBody.item` is now ignored: a 0.2.26 phone still sends it, and
// refusing the delivery over a field the server has no use for would be a new
// failure invented out of a retirement.
//
// RV-04 (2026-07-30): the phone auto-retries when a response is lost, and the
// dead-TCP window this ingress exists for is precisely where responses get
// lost. Image deliberately bypasses the desktop's dedup ("the user might
// genuinely want to paste the same picture twice"), so a retry pasted the
// picture a SECOND time. The missing distinction is "the same picture again"
// (allowed, new request_id) vs "a retry of the same request"
// (must be idempotent, same request_id) — so a request_id that already
// has a conclusion is served that conclusion and nothing is relayed again.
//
// RV-05 (2026-07-30): the hold-out refusal below now ECHOES request_id/entry_id.
// It did not, so the phone could not tell WHICH delivery was refused, fell
// through to its "this is the PC's verdict" branch, and marked a row synced that this
// route returns before ever creating — the row then lived on the phone alone,
// unreachable by reflush. A refusal must be legible as a refusal.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'socket.io';
import { safeParseEvent } from '@flowmic/protocol';
import type { Registry } from '../room/registry';
import type { RoomStore } from '../room/store';
import type { ReleaseSuppression } from '../room/release-suppression';
import type { InjectPendingRegistry } from '../socket/inject-pending';
import { markInjectRequest } from '../obs/latency';
import { log } from '../log';
import { readBounded, sendJson } from './body';
import { verifyPairedMobile } from './pairing-auth';

/** Body cap — parity with the socket engine's MAX_HTTP_BUFFER_BYTES: the same
 *  largest-legal inject frame must fit through either ingress. */
export const MAX_INJECT_UPLOAD_BYTES = 8_000_000;

/** How long the route waits for the PC's inject:result before answering
 *  honestly that no verdict arrived. Below the phone's 20 s watchdog so the
 *  HTTP answer always lands first, and above the PC pipeline's real worst case
 *  (foreground switch + clipboard settle + read-back + paste-lock queue). */
export const INJECT_RESULT_WAIT_MS = 15_000;

/** Newest files kept in the images inbox. Pruned on every write so the dir is
 *  bounded without a sweeper. */
export const IMAGE_INBOX_KEEP = 100;

export interface InjectRoutesDeps {
  registry: Registry;
  store: RoomStore<Socket>;
  pending: InjectPendingRegistry;
  suppression?: ReleaseSuppression;
  /** Where uploaded images are persisted (owner: "save it to the data directory"). Absent →
   *  persistence is skipped and the response says saved:false — never a silent
   *  half-success. */
  imagesDir?: string;
  /** Seam for tests: persist [bytes] under [name] inside imagesDir, pruning to
   *  IMAGE_INBOX_KEEP. Returns the absolute path, or null when it could not be
   *  written (said in the response, logged, never fatal to the delivery). */
  persist?: (name: string, bytes: Buffer) => string | null;
  resultWaitMs?: number;
  now?: () => string;
}

function defaultPersist(imagesDir: string, name: string, bytes: Buffer): string | null {
  try {
    mkdirSync(imagesDir, { recursive: true });
    const path = join(imagesDir, name);
    writeFileSync(path, bytes);
    // Bounded inbox: drop the oldest beyond the keep-count. Name order is
    // chronological (ISO stamp prefix), so a lexical sort is a time sort.
    const entries = readdirSync(imagesDir).sort();
    for (const stale of entries.slice(0, Math.max(0, entries.length - IMAGE_INBOX_KEEP))) {
      try {
        unlinkSync(join(imagesDir, stale));
      } catch {
        // A stale file that cannot be removed is a pruning miss, not a delivery
        // problem; the next write retries it.
      }
    }
    return path;
  } catch (e) {
    log.warn('inject upload: image could not be persisted', { error: String(e) });
    return null;
  }
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export function tryHandleInjectRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InjectRoutesDeps,
): boolean {
  const url = (req.url ?? '').split('?')[0];
  if (url !== '/api/inject/image') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  const now = deps.now ?? ((): string => new Date().toISOString());

  void (async () => {
    // ── auth BEFORE body: an invalid token must not cost an 8 MB read ──────
    // The Bearer→pairing lookup itself lives in http/pairing-auth.ts (ONE
    // definition, shared with the diag ingress); the refusal shape stays here
    // because it is this route's protocol.
    // Refused before the body is read (an invalid token must not cost an 8 MB
    // read); the socket is torn down only after the 401 has flushed.
    const identity = verifyPairedMobile(req, deps.registry);
    if (!identity) {
      res.once('finish', () => req.destroy());
      sendJson(res, 401, { ok: false, error: 'AUTH_TOKEN_INVALID' });
      return;
    }
    const { mobile, pc } = identity;
    // (0.2.27) the acting `userId` this line used to resolve is no longer read:
    // it existed to stamp / scope the `transcript_history` row. The tenant
    // boundary it served is now carried entirely by `verifyPairedMobile` above —
    // the pairing IS the authorisation, and everything below addresses a ROOM
    // (pc.room_uuid), never a row id.

    // The body is read BEFORE the hold-out gate on purpose (RV-05): a
    // suppressed phone is an AUTHENTICATED phone, and its refusal has to name
    // the request_id/entry_id it asked about or the phone cannot tell "the server
    // refused it" from "the PC ruled it a failure". Auth still gates the read, so an unknown
    // token never costs an 8 MB read, and MAX_INJECT_UPLOAD_BYTES bounds this
    // one — an honest refusal is worth the bounded read.
    const body = await readBounded(req, MAX_INJECT_UPLOAD_BYTES).catch(() => null);
    if (body === null) {
      sendJson(res, 400, { ok: false, error: 'INJECT_FRAME_INVALID', detail: 'body unreadable' });
      return;
    }
    if (body === 'TOO_LARGE') {
      sendJson(res, 413, { ok: false, error: 'INJECT_FRAME_TOO_LARGE', max_bytes: MAX_INJECT_UPLOAD_BYTES });
      return;
    }
    // `item` is still ACCEPTED in the body (0.2.26 phones send it) and no longer
    // read — see the 0.2.27 note in the header. Not named in this type any more,
    // so nothing downstream can start depending on it again by accident.
    let parsedBody: { request?: unknown };
    try {
      parsedBody = JSON.parse(body) as { request?: unknown };
    } catch {
      sendJson(res, 400, { ok: false, error: 'INJECT_FRAME_INVALID', detail: 'body not JSON' });
      return;
    }

    // ── the inject frame: the SAME schema the socket boundary enforces ─────
    const request = safeParseEvent('inject:request', parsedBody.request);
    if (!request.success) {
      const first = request.error.issues[0];
      const reason = first ? `${first.path.join('.') || '(root)'}: ${first.code}` : 'invalid';
      log.warn('inject upload: rejected frame', { reason, issues: request.error.issues.length });
      const tooLarge = first !== undefined && first.path.join('.') === 'image_b64' && first.code === 'too_big';
      sendJson(res, tooLarge ? 413 : 400, {
        ok: false,
        error: tooLarge ? 'INJECT_FRAME_TOO_LARGE' : 'INJECT_FRAME_INVALID',
        detail: reason,
      });
      return;
    }
    if (request.data.source !== 'image' || !request.data.image_b64 || !request.data.image_mime) {
      sendJson(res, 400, { ok: false, error: 'INJECT_FRAME_INVALID', detail: 'this route carries source=image only' });
      return;
    }

    // ── 🔴 Card S · never let IDs get crossed — THE SAME GATE THE SOCKET INGRESS APPLIES ─────────
    //
    // "HTTP is another entrance, not a second contract": if the red line held only on the socket
    // leg, this route would be its back door. Same rule, same evidence, same
    // verdict — refuse, never re-route.
    //
    // THE EVIDENCE: `pc` here is `verifyPairedMobile` → `registry.reconnectMobile`
    // → `findPairingByToken` → `pcs.findById(mobile.pc_device_id)`
    // (room/registry.ts `RoomRegistry.findPairingByToken`, the pure lookup that
    // `reconnectMobile` delegates to), i.e. the PC row resolved FROM THE PHONE'S
    // OWN TOKEN. `pc.id` is therefore the very same `pc_devices.id` that the
    // socket leg compares as `auth.deviceId` (auth/middleware.ts, the
    // `kind: 'mobile'` branch that sets `deviceId: mobileRow.pc_device_id`) and
    // that the phone was handed as `pc_id` in its pairing ack. Not an
    // approximation of the socket leg's identity — the same column, reached by
    // the same lookup.
    //
    // ⚠️ NOT `pc.room_uuid`'s current occupant (`deps.store.getPc`, used further
    // down to actually deliver). That answers "who is connected right now"; this answers
    // "who this delivery is addressed to". The room is the destination, the token is the address, and
    // only comparing the address against the binding can catch a crossed id.
    //
    // WHY 409 AND NOT 200 + ok:false — grep'd, not guessed (mobile
    // session/image_upload.dart, symbol `uploadImageInject`): the phone
    // treats ANY 200 whose body is
    // neither INJECT_PC_OFFLINE / INJECT_RESULT_TIMEOUT nor `retryable:true` as
    // `ImageUploadStatus.verdict` — "this is the PC's verdict" — and would settle the row
    // from a SERVER refusal, which is precisely the RV-05 lie. `retryable:true` is
    // equally false: retrying this exact frame here can only be refused again.
    // A non-200 lands in `ImageUploadStatus.refused` ("the server refused it, retrying is no use",
    // with `detail` carrying these words) — the only one of the phone's five
    // outcomes that is true of a mis-addressed frame. 409 Conflict because the
    // frame is well-formed and authenticated and simply conflicts with WHO this
    // endpoint is.
    //
    // Refused here — before the request_id gate, the idempotency ledger, the
    // hold-out gate, the file write and the relay — so a frame for another PC
    // costs nothing and leaves nothing behind.
    if (request.data.target_pc_id !== undefined && request.data.target_pc_id !== pc.id) {
      log.warn('inject upload: frame addressed to another PC — REFUSED', {
        target_pc_id: request.data.target_pc_id,
        bound_pc_id: pc.id,
        mobile_id: mobile.id,
      });
      sendJson(res, 409, {
        ok: false,
        error: 'INJECT_PC_MISMATCH',
        ...(request.data.request_id !== undefined ? { request_id: request.data.request_id } : {}),
        ...(request.data.entry_id !== undefined ? { entry_id: request.data.entry_id } : {}),
      });
      return;
    }
    if (request.data.target_pc_id === undefined) {
      // ── 0.2.33 (Window B3): THE COMPAT GAP IS CLOSED ON THIS INGRESS TOO ─────────
      //
      // It used to ACCEPT and merely log, for the reason written there: a 0.2.28
      // phone sends no address and refusing would have broken every handset. That
      // condition lapsed (0.2.32 stamps it on all four emission paths, this route's
      // own caller included — image_send_controller.dart:467), so absence is a
      // protocol violation, and a red line with one entrance still tolerant is a
      // red line with a back door. Same rule, same round, same code as the socket
      // leg.
      //
      // WHY 400 AND NOT 409, when the mismatch beside it is 409 — the frame is not
      // in CONFLICT with anything about this endpoint; it is missing a field the
      // protocol requires, which is the same verdict this route already gives an
      // absent `request_id` below. What matters equally is what they share: both
      // are NON-200, and non-200 is what lands in the phone's
      // `ImageUploadStatus.refused` "the server refused it, retrying is no use" branch (mobile
      // session/image_upload.dart, symbol `uploadImageInject`, grep'd — the
      // same read the 409 note above rests on). A 200 here would be settled as "this is the PC's verdict" about a
      // picture no PC ever saw, and `retryable:true` would be false: retrying this
      // exact frame can only be refused again — the sender has to be upgraded.
      //
      // Refused in the same place as the mismatch — before the request_id gate, the
      // idempotency ledger, the hold-out gate, the file write and the relay — so an
      // unaddressed frame costs nothing and leaves nothing behind.
      log.warn('inject upload: frame carries no target_pc_id — REFUSED', {
        bound_pc_id: pc.id,
        mobile_id: mobile.id,
      });
      sendJson(res, 400, {
        ok: false,
        error: 'INJECT_PC_UNSPECIFIED',
        ...(request.data.request_id !== undefined ? { request_id: request.data.request_id } : {}),
        ...(request.data.entry_id !== undefined ? { entry_id: request.data.entry_id } : {}),
      });
      return;
    }

    const requestId = request.data.request_id;
    if (!requestId) {
      // Without a request_id no verdict can be correlated back — refuse rather
      // than relay a frame whose outcome this route could never report. Checked
      // here (before any row/file work) because it is pure frame validation, and
      // because everything below is keyed by this id.
      sendJson(res, 400, { ok: false, error: 'INJECT_FRAME_INVALID', detail: 'request_id required on the http ingress' });
      return;
    }
    /** entry_id echo, present only when the frame carried one (additive). */
    const entryEcho = request.data.entry_id !== undefined ? { entry_id: request.data.entry_id } : {};

    // ── RV-04 idempotency, asked FIRST and cheaply ──────────────────────────
    // A request_id that already has a conclusion is a RETRY of ONE delivery,
    // not a second delivery. Answering with that first conclusion here means no
    // second row work, no second file written, and above all NO SECOND PASTE.
    // Ahead of the hold-out gate deliberately: the gate decides whether a NEW
    // delivery may start, and telling the phone "the server refused it" about a picture the
    // PC has already pasted would be a fresh lie.
    const alreadyAnswered = deps.pending.answerFor(requestId);
    if (alreadyAnswered !== undefined) {
      log.info('inject upload: replaying the answer this request_id already had', { request_id: requestId });
      sendJson(res, 200, { ...alreadyAnswered, replayed: true });
      return;
    }

    // ── the hold-out gate (same one mobile:reconnect uses) ──────────────────
    // A phone the PC just released, or that lost the capsule to another phone,
    // must not deliver. RV-05: the echo fields are what make this readable as a
    // SERVER refusal — the row was never created here, so the phone must keep it
    // unsynced and reflushable rather than settling it as a PC verdict.
    const suppressedFor = deps.suppression?.remainingMs(mobile.id) ?? 0;
    if (suppressedFor > 0) {
      const busy = deps.suppression?.reasonFor(mobile.id) === 'busy';
      log.warn('inject upload: refused by the hold-out window', {
        request_id: requestId,
        reason: busy ? 'busy' : 'manual',
        retry_after_ms: suppressedFor,
      });
      // Deliberately NOT recorded as this request_id's answer: the window
      // expires on its own and the very same delivery must then be able to go
      // through. A refusal is not a conclusion.
      sendJson(res, 200, {
        ok: false,
        error: busy ? 'PC_BUSY' : 'PAIR_RELEASED',
        retryable: true,
        retry_after_ms: suppressedFor,
        request_id: requestId,
        ...entryEcho,
      });
      return;
    }

    // ── (0.2.27) the timeline-row step that stood here is GONE ──────────────
    //
    // It created/upserted a `transcript_history` row (row-first D10) and fanned a
    // `history:updated` out to the room so the PC's timeline learned it. The table
    // is dropped and each end owns its own timeline, so the row is the PHONE's and
    // the PC's row comes from the delivery it is about to receive — a server copy
    // would be a third owner of the same fact.
    //
    // Two guards died with it and neither is missed: the `findById` cross-user
    // check (no row to own) and the create-failure 500 (no write to fail). What
    // remains load-bearing is exactly what already ran ABOVE this point: token →
    // pairing (tenant boundary), request_id idempotency (RV-04, no second paste),
    // and the hold-out gate (RV-05).

    // ── persist to the data dir (owner's ruling). Honest either way. ───────
    let savedPath: string | null = null;
    const stamp = now().replace(/[:.]/g, '-');
    const ext = EXT_BY_MIME[request.data.image_mime] ?? 'bin';
    const fileName = `${stamp}-${requestId.replace(/[^A-Za-z0-9_-]/g, '_')}.${ext}`;
    const persist = deps.persist
      ?? (deps.imagesDir !== undefined
        ? (name: string, bytes: Buffer): string | null => defaultPersist(deps.imagesDir as string, name, bytes)
        : null);
    if (persist) {
      savedPath = persist(fileName, Buffer.from(request.data.image_b64, 'base64'));
    }

    // ── relay to the PC and wait for the real verdict ───────────────────────
    const pcSocket = deps.store.getPc(pc.room_uuid);
    if (!pcSocket) {
      log.warn('inject upload: no PC in room', { room: pc.room_uuid });
      // 0.2.27: the `failed` status stamp that stood here went with the table. The
      // verdict still travels — in the echoed response below — and the phone,
      // which owns the row, is the one that writes it down.
      // Echoed like every other refusal (RV-05): a response the phone cannot tie
      // back to a delivery is a response it has to guess about. Not recorded as
      // this request_id's answer — the PC coming back must let the retry through.
      sendJson(res, 200, {
        ok: false,
        error: 'INJECT_PC_OFFLINE',
        request_id: requestId,
        ...entryEcho,
        saved: savedPath !== null,
      });
      return;
    }
    // ── claim the request_id, and only THEN relay ───────────────────────────
    // RV-04 (A): a claim that fails must not emit. The old code armed a waiter,
    // emitted unconditionally, and read the waiter's `null` as a timeout — so a
    // refused claim answered `INJECT_RESULT_TIMEOUT` 0 ms after arriving while a
    // frame it could never report on was already on its way to the PC. Every
    // branch below is now a named fact, and exactly one of them emits.
    const wait = deps.resultWaitMs ?? INJECT_RESULT_WAIT_MS;
    const attempt = deps.pending.begin(requestId, wait);
    if (attempt.kind === 'replay') {
      // Raced: the first attempt concluded between the early check and here.
      log.info('inject upload: replaying a concluded request_id (raced)', { request_id: requestId });
      sendJson(res, 200, { ...attempt.answer, replayed: true });
      return;
    }
    if (attempt.kind === 'overloaded') {
      // Too many injects in flight to promise this one a verdict. Said as a
      // retryable SERVER refusal — never as a timeout that never ran.
      //
      // Its OWN code, not PC_BUSY: the phone renders PC_BUSY as "this PC is
      // currently occupied by another phone, please exit the transcription
      // page on that phone first", which here would be false in both
      // halves — no other phone is involved and there is nothing on another phone
      // to leave. A refusal the user cannot act on truthfully is still a lie, even
      // when the path is rare (this needs 64 concurrent uploads).
      log.warn('inject upload: waiter table full — not relayed', { request_id: requestId });
      sendJson(res, 200, {
        ok: false,
        error: 'INJECT_SERVER_BUSY',
        retryable: true,
        retry_after_ms: wait,
        request_id: requestId,
        ...entryEcho,
        saved: savedPath !== null,
      });
      return;
    }
    if (attempt.kind === 'armed') {
      // First sight of this request_id: this is the ONE emit it ever gets.
      markInjectRequest(pc.room_uuid, request.data.entry_id ?? null);
      pcSocket.emit('inject:request', request.data);
    } else {
      // `joined`: an identical request_id is already at the PC. A second frame
      // would paste the same picture twice (image bypasses desktop dedup), so
      // this attempt only listens in and reports the SAME verdict.
      log.info('inject upload: joined an in-flight request_id — not relayed again', { request_id: requestId });
    }
    const outcome = await attempt.outcome;
    if (outcome.kind === 'timeout') {
      // No verdict inside the window. Deliberately NOT written as failed: the
      // PC may still answer late, and relay.handler's write-back will record
      // the truth then — same shape the socket path has always had.
      log.warn('inject upload: no inject:result inside the wait window', { request_id: requestId });
      const answer: Record<string, unknown> = {
        ok: false,
        error: 'INJECT_RESULT_TIMEOUT',
        relayed: true,
        request_id: requestId,
        saved: savedPath !== null,
      };
      // Remembered so the phone's retry hears "already handed off, still no receipt" instead
      // of relaying the same picture a second time: the PC may simply have been
      // slow, and an image frame bypasses its dedup by ruling.
      deps.pending.recordAnswer(requestId, answer);
      sendJson(res, 200, answer);
      return;
    }
    const result = outcome.result;
    log.info('inject upload: delivered with verdict', {
      request_id: requestId,
      ok: result.ok,
      mode: result.mode,
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
    const answer: Record<string, unknown> = {
      ok: result.ok,
      mode: result.mode,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.inject_target !== undefined ? { inject_target: result.inject_target } : {}),
      ...(result.entry_id !== undefined ? { entry_id: result.entry_id } : {}),
      request_id: requestId,
      saved: savedPath !== null,
    };
    deps.pending.recordAnswer(requestId, answer);
    sendJson(res, 200, answer);
  })().catch((e) => {
    // A route that dies mid-flight must still answer (no silent failure).
    log.warn('inject upload: route failed', { error: String(e) });
    try {
      sendJson(res, 500, { ok: false, error: 'SETTINGS_SYNC_FAIL' });
    } catch {
      /* headers already sent — nothing more truthful is possible */
    }
  });

  return true;
}
