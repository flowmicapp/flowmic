// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.8 (timeline:push / pull / pull-result /
//     tombstone)
//   docs/rebuild/05-DATA-MODEL.md §2 (E2EE blind store; e2e:v1: write-path guard
//     — TIMELINE_BLOB_REJECTED; NEVER coerced to enc:v1:), §4 (timeline:* is the
//     cross-session cloud link, independent of the plaintext history:* link)
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D4 (push idempotent by id+ciphertext;
//     tombstone carries a wire `deleted` flag)
//
// The server is BLIND here: it stores/returns ciphertext verbatim and enforces
// exactly one thing — the e2e:v1: prefix. The timeline:grant-request / grant
// web-preview handshake lives in its sibling grant.handler.ts since GRANT-1
// (2026-08-11); what THIS file gained from that card is the kind:'web' gates:
//
//   · timeline:pull from kind:'web' is admitted ONLY on a live grant row
//     (grants.liveGrantFor — not revoked, not expired, judged per call), else
//     TIMELINE_GRANT_REQUIRED. Fail-closed: expiry needs no sweeper, the row
//     simply stops matching. The pc/mobile pull path is byte-identical to
//     pre-GRANT-1 (the new branch is entered by kind:'web' only — pinned by
//     test/web-readonly-gate.test.ts).
//   · timeline:push / timeline:tombstone from kind:'web' answer
//     TIMELINE_WEB_READ_ONLY. In production the web allowlist
//     (socket/web-allowlist.ts) refuses these frames FIRST with
//     WEB_EVENT_NOT_ALLOWED — the two gates answer two different questions
//     (design §3.3): the allowlist answers "what can this class of client
//     say", this code answers "is this action legal for this class of
//     client", and it exists for the day the
//     allowlist is loosened. It is therefore pinned by a test that BYPASSES
//     the allowlist (drives this handler directly), because production
//     traffic can never reach it while the outer gate stands.

import type { Socket } from 'socket.io';
import { safeParseEvent } from '@flowmic/protocol';
import type { TimelineRepo } from '../../db/repos/timeline.repo';
import type { TimelineGrantsRepo } from '../../db/repos/timeline-grants.repo';
import { EMAIL_NOT_VERIFIED, isEmailVerified, type EmailVerifiedReader } from '../../auth/email-verification';
import { ServerError } from '../../errors';
import { getAuth, safeAck } from '../wire';

export interface TimelineHandlerDeps {
  repo: TimelineRepo;
  /** GRANT-1 — the authorization ledger the kind:'web' pull gate reads. Only
   *  `liveGrantFor` is needed; the narrow slice keeps this handler unable to
   *  create or revoke authorizations as a side effect of serving reads. */
  grants: Pick<TimelineGrantsRepo, 'liveGrantFor'>;
  /** VERIFY-1 D3 — the verified-email gate's reader, consulted ONLY on the
   *  kind:'web' pull branch below. REQUIRED (doc 13 §7 F1 ②). Phone/PC pulls
   *  and pushes never touch it — every device surface is exempt by the
   *  owner's own wording ("the console"), pinned by the exemption tests. */
  verifiedEmail: EmailVerifiedReader;
  /** ms clock for the expiry judgement; injectable for tests. */
  now?: () => number;
}

export function registerTimelineHandlers(socket: Socket, deps: TimelineHandlerDeps): void {
  const { repo, grants } = deps;
  const now = deps.now ?? Date.now;

  socket.on('timeline:push', (payload: unknown, ack: unknown) => {
    const auth = getAuth(socket);
    if (!auth) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    // GRANT-1 §3.3 — the second (read-only) gate; see the header for why it
    // exists although the allowlist already refused this frame in production.
    if (auth.kind === 'web') return safeAck(ack, { error: 'TIMELINE_WEB_READ_ONLY' });
    const parsed = safeParseEvent('timeline:push', payload);
    if (!parsed.success) return safeAck(ack, { error: 'TIMELINE_BLOB_REJECTED' });
    try {
      const assigned = repo.push(
        auth.userId,
        parsed.data.entries.map((e) => ({ id: e.id, ciphertext: e.ciphertext, created_at: e.created_at, schema_ver: e.schema_ver })),
      );
      safeAck(ack, { ok: true, assigned });
    } catch (err) {
      // e2e:v1: prefix violation is a hard fail-loud reject (never coerced).
      if (err instanceof ServerError) return safeAck(ack, { error: err.code, message: err.message });
      safeAck(ack, { error: 'TIMELINE_BLOB_REJECTED' });
    }
  });

  socket.on('timeline:pull', (payload: unknown, ack: unknown) => {
    const auth = getAuth(socket);
    if (!auth) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    // VERIFY-1 D3 — an unverified web session must not pull blobs, grant or no
    // grant (a pre-gate grant row must not outrank the gate). Same ack-local
    // EMAIL_NOT_VERIFIED string as the grant-request gate, under the same
    // doctrine (grant.handler.ts carries it in full: web console is the only
    // possible reader, acks are not schema-gated, a protocol code is
    // owner-gated — the phone ever needing this string is the day to ask).
    // BEFORE the grant check: 「verify first」 is the truthful next action, and
    // TIMELINE_GRANT_REQUIRED would send the user to re-run a handshake the
    // grant-request gate above would then refuse anyway.
    if (auth.kind === 'web' && !isEmailVerified(deps.verifiedEmail.emailVerifiedAt(auth.userId))) {
      return safeAck(ack, { error: EMAIL_NOT_VERIFIED });
    }
    // GRANT-1 §2-4 — a web session reads ONLY under a live grant. Judged here,
    // on every pull, against the durable row (never against anything the web
    // sent): expiry and revocation take effect on the next pull with nothing
    // to sweep and nothing to push. Phone/PC sockets never enter this branch.
    if (auth.kind === 'web' && grants.liveGrantFor(auth.userId, now()) === null) {
      return safeAck(ack, { error: 'TIMELINE_GRANT_REQUIRED' });
    }
    const parsed = safeParseEvent('timeline:pull', payload);
    if (!parsed.success) return safeAck(ack, { error: 'TIMELINE_BLOB_REJECTED' });
    const since = parsed.data.since_seq ?? 0;
    const limit = parsed.data.limit ?? 500;
    const { blobs, next_seq } = repo.pull(auth.userId, since, limit);
    const result = {
      blobs: blobs.map((b) => ({
        id: b.id,
        seq: b.seq,
        ciphertext: b.ciphertext,
        created_at: Date.parse(b.created_at),
        schema_ver: b.schema_ver,
        ...(b.deleted ? { deleted: true } : {}),
      })),
      next_seq,
    };
    safeAck(ack, result);
    socket.emit('timeline:pull-result', result);
  });

  socket.on('timeline:tombstone', (payload: unknown, ack: unknown) => {
    const auth = getAuth(socket);
    if (!auth) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    // GRANT-1 §3.3 — a tombstone is a WRITE (it destroys stored bytes); same
    // second gate as push above.
    if (auth.kind === 'web') return safeAck(ack, { error: 'TIMELINE_WEB_READ_ONLY' });
    const parsed = safeParseEvent('timeline:tombstone', payload);
    if (!parsed.success) return safeAck(ack, { error: 'TIMELINE_BLOB_REJECTED' });
    const n = repo.tombstone(auth.userId, parsed.data.ids);
    safeAck(ack, { ok: true, tombstoned: n });
  });
}
