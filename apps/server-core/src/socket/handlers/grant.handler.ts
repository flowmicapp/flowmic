// SPEC-REF:
//   docs/strategy/2026-08-11-design-e-grant-web-preview.md §2 (the four-step
//     flow: web requests → phone confirms with a chosen duration → server
//     stores the authorization row and BLINDLY forwards the wrap → web unwraps
//     in a Worker), §3.1 (absent gid/origin/expires_at_ms = malformed AT THE
//     HANDLER — the zod fields stay optional/additive), §3.2 (wrap never
//     stored, pending state in memory)
//   docs/rebuild/05-DATA-MODEL.md §2 (X25519/HKDF wrap shape — opaque here;
//     QR TTL 90 s is "how long this code stays valid before it voids", NOT the grant duration)
//   auth/qr-grant.ts — the in-memory short-TTL store precedent this follows
//     (sub-minute state does not warrant a schema change; single-use redeem
//     deletes BEFORE it judges, so a replay finds nothing and nothing can be
//     probed twice)
//   CLAUDE.md human-audit-required sensitive paths (four classes): pairing/auth
//     + adjacent to cryptography (key transit) — line-by-line human audit
//   *** HUMAN-AUDIT SENSITIVE (auth / key transit) ***
//
// The server half of the web-preview grant handshake.
//
// 🔴 THE SERVER IS A BLIND COURIER FOR THE WRAP. The wrapped master key enters
// on `timeline:grant`, is forwarded VERBATIM to the one web socket whose
// pending request it answers, and is gone — never persisted, never parsed
// beyond the protocol schema's e2e:v1: family-prefix refine, never logged
// (a log line carrying it would be a key-material leak with a timestamp).
// What IS durable is the AUTHORIZATION row (db/repos/timeline-grants.repo.ts);
// "the wrap is blind, the authorization is in the clear, the two layers are
// kept separate" (design §3.1).
//
// REFUSAL CODES, and one imperfect fit stated out loud:
//   · TIMELINE_RATE_LIMITED   — the per-account grant-request budget.
//   · TIMELINE_GRANT_REQUIRED — every way a `timeline:grant` can fail to match
//     a live pending request (unknown gid, expired pending, another account's
//     pending, a non-mobile granter, the web page already gone). ONE collapsed
//     outcome on purpose, the qr-grant.ts no-oracle discipline: a caller must
//     not learn whether a gid it does not own ever existed. Its copy ("the
//     phone needs to re-authorize before the cloud timeline can be previewed") is the true user-facing consequence of
//     every branch: the flow must be re-run.
//   · TIMELINE_BLOB_REJECTED  — malformed grant-family frames (zod failure,
//     absent gid/origin/expires_at_ms, out-of-range expiry) AND the wrong-kind
//     grant-request. The in-tree precedent is timeline.handler.ts, which
//     already answers it for a malformed timeline:pull — a READ — so the code
//     is the timeline family's established 「this frame is refused」 answer,
//     not only a write-rejection. ⚠️ For the wrong-kind grant-request the fit
//     is imperfect (the frame may be well-formed; the SPEAKER is wrong) and no
//     existing code says 「this verb belongs to web preview sessions」. Minting
//     one is owner-gated and this card deliberately mints nothing, so the
//     imperfect reuse is chosen, recorded here and in the card report. No
//     production client emits it (the phone gains its emitter in GRANT-2, for
//     `timeline:grant` only), so the copy has no real screen to mislead.

import type { Server, Socket } from 'socket.io';
import { safeParseEvent } from '@flowmic/protocol';
import type { TimelineGrantsRepo } from '../../db/repos/timeline-grants.repo';
import { EMAIL_NOT_VERIFIED, isEmailVerified, type EmailVerifiedReader } from '../../auth/email-verification';
import { getAuth, safeAck } from '../wire';

/** How long a pending grant-request stays answerable — the QR's own lifetime
 *  (doc 05: QR-scan TTL 90 s). Distinct from the GRANT duration, which the user
 *  chooses on the phone and rides `expires_at_ms`. */
export const GRANT_PENDING_TTL_MS = 90_000;
/** Grant-request budget: ≤5 per account per rolling minute (design §2-1). */
export const GRANT_REQUEST_WINDOW_MS = 60_000;
export const GRANT_REQUEST_MAX_PER_WINDOW = 5;
/** Hard cap on simultaneously-pending requests across ALL accounts, so a
 *  credential-holding flood cannot grow the map without bound (qr-grant.ts
 *  MAX_LIVE_GRANTS precedent; oldest-first eviction). */
const MAX_PENDING = 1_000;
/** The phone may not choose an expiry further out than this — the server
 *  「only rejects nonsense」 (design ruling: the duration is the USER's choice;
 *  presets top out at 24 h, and 7 days bounds even a hand-built client). */
export const GRANT_MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingGrantRequest {
  userId: string;
  webPubkey: string;
  sessionFingerprint: string;
  origin: string;
  /** The requesting web socket — where (and only where) the wrap may go. */
  socketId: string;
  expiresAt: number;
}

/**
 * The in-memory pending-request table (design §2-1). IN MEMORY ON PURPOSE — a
 * pending request lives ≤90 s and is worthless across a restart (the web page
 * that minted it holds an ephemeral X25519 secret that dies with the page);
 * the DURABLE artefact is the grants row, which is written only when a phone
 * actually grants. Same trade qr-grant.ts argues for its 60-second nonces.
 *
 * `take` is SINGLE-USE and deletes before it judges (the qr-grant redeem
 * shape): an expired entry is consumed by the probe that found it, so nothing
 * lingers to be probed twice, and two concurrent grants for one gid cannot
 * both win.
 *
 * gid is caller-chosen (a web-minted uuid). `put` overwrites an existing gid:
 * the only writer who KNOWS a gid is the page that minted it (128-bit uuid,
 * not guessable), so an overwrite is that page retrying — and a hostile
 * overwrite by someone who somehow learned the gid buys only a denial (the
 * user-match check in the grant handler refuses the cross-account result;
 * the wrap is sealed to the epk in the QR, which the server never controls).
 */
export class GrantPendingStore {
  private readonly entries = new Map<string, PendingGrantRequest>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = GRANT_PENDING_TTL_MS,
  ) {}

  put(gid: string, entry: Omit<PendingGrantRequest, 'expiresAt'>): void {
    this.prune();
    if (this.entries.size >= MAX_PENDING && !this.entries.has(gid)) {
      const oldest = this.entries.keys().next(); // Map iteration is insertion-ordered
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(gid, { ...entry, expiresAt: this.now() + this.ttlMs });
  }

  /** Consume the pending request for `gid` ONCE. Null for unknown AND expired
   *  alike — and an expired entry is deleted by this very probe. */
  take(gid: string): PendingGrantRequest | null {
    const e = this.entries.get(gid);
    if (e === undefined) return null;
    this.entries.delete(gid);
    if (e.expiresAt <= this.now()) return null;
    return e;
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [gid, e] of this.entries) {
      if (e.expiresAt <= t) this.entries.delete(gid);
    }
  }
}

/**
 * Per-account sliding-window budget for `timeline:grant-request` (≤5/min).
 * In-memory and account-keyed — the caller is authenticated (kind:'web'
 * requires a verified JWT), so the honest bucket key is the account, not the
 * peer address nginx folds to loopback anyway (the trusted-proxy lesson).
 */
export class GrantRequestRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = GRANT_REQUEST_WINDOW_MS,
    private readonly maxPerWindow: number = GRANT_REQUEST_MAX_PER_WINDOW,
  ) {}

  /** True = admitted (and counted). False = over budget, nothing counted —
   *  a refused request must not extend its own punishment window. */
  check(userId: string): boolean {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const list = (this.hits.get(userId) ?? []).filter((ts) => ts > cutoff);
    if (list.length >= this.maxPerWindow) {
      // Write the pruned list back even on refusal — otherwise a spammer's
      // stale timestamps accumulate forever and the map only ever grows.
      this.hits.set(userId, list);
      return false;
    }
    list.push(t);
    this.hits.set(userId, list);
    return true;
  }
}

export interface GrantHandlerDeps {
  io: Server;
  grants: TimelineGrantsRepo;
  pending: GrantPendingStore;
  limiter: GrantRequestRateLimiter;
  /** VERIFY-1 D3 — the verified-email gate's reader, for the kind:'web'
   *  grant-request gate below. REQUIRED (doc 13 §7 F1 ②): an optional reader
   *  would let an unverified web session mint grants with nothing red to
   *  notice. The PHONE's `timeline:grant` deliberately never consults it —
   *  every device surface is exempt by the owner's own wording ("the console"). */
  verifiedEmail: EmailVerifiedReader;
  /** ms clock; injectable for tests, same shape as everything bootstrap wires. */
  now?: () => number;
}

export function registerGrantHandlers(socket: Socket, deps: GrantHandlerDeps): void {
  const now = deps.now ?? Date.now;

  // ── timeline:grant-request — the WEB side opens the handshake ─────────────
  socket.on('timeline:grant-request', (payload: unknown, ack: unknown) => {
    const auth = getAuth(socket);
    if (!auth) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    if (auth.kind !== 'web') {
      // Wrong speaker, not (necessarily) a wrong frame — see the header's
      // stated imperfect-fit note before touching this code.
      return safeAck(ack, {
        error: 'TIMELINE_BLOB_REJECTED',
        message: 'timeline:grant-request is only accepted from a declared web preview session',
      });
    }
    // VERIFY-1 D3 — an unverified web session must not be able to MINT a
    // grant (the wrap it would receive outlives the gate). The refusal string
    // is the HTTP-local EMAIL_NOT_VERIFIED, in an ack, and that is deliberate
    // doctrine rather than a shortcut: the ONLY client that can ever receive
    // it is the repo-owned web console (kind:'web' exists solely for the
    // GRANT-1 preview session), acks are not schema-gated, and minting a
    // protocol code is owner-gated — if this string ever needs to reach the
    // PHONE, that is the day to ask the owner for a code, not the day to
    // widen this one. Placed BEFORE the rate limiter so a gated session
    // cannot spend budget it could never use.
    if (!isEmailVerified(deps.verifiedEmail.emailVerifiedAt(auth.userId))) {
      return safeAck(ack, { error: EMAIL_NOT_VERIFIED });
    }
    const parsed = safeParseEvent('timeline:grant-request', payload);
    if (!parsed.success) return safeAck(ack, { error: 'TIMELINE_BLOB_REJECTED' });
    const { web_pubkey, session_fingerprint, gid, origin } = parsed.data;
    // Absence = malformed AT THE HANDLER (design §3.1): the fields are
    // zod-optional purely to keep the schema additive; this event has never
    // had a producer, so there is no old frame to be lenient toward.
    if (gid === undefined || origin === undefined) {
      return safeAck(ack, { error: 'TIMELINE_BLOB_REJECTED', message: 'gid and origin are required' });
    }
    // Budget AFTER validation: only an admissible request spends it, so
    // 「≤5/min」 counts requests that could actually pend.
    if (!deps.limiter.check(auth.userId)) {
      return safeAck(ack, { error: 'TIMELINE_RATE_LIMITED', retryable: true });
    }
    deps.pending.put(gid, {
      userId: auth.userId,
      webPubkey: web_pubkey,
      sessionFingerprint: session_fingerprint,
      origin,
      socketId: socket.id,
    });
    // expires_in_ms is the PENDING window (how long the QR stays answerable),
    // never the grant duration — that number does not exist yet, the user has
    // not chosen it.
    safeAck(ack, { ok: true, gid, expires_in_ms: GRANT_PENDING_TTL_MS });
  });

  // ── timeline:grant — the PHONE answers with the wrap + chosen duration ────
  socket.on('timeline:grant', (payload: unknown, ack: unknown) => {
    const auth = getAuth(socket);
    if (!auth) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    if (auth.kind !== 'mobile') {
      // Collapsed with every other mismatch below (no oracle) — and checked
      // BEFORE the pending table is touched, so a wrong-kind probe cannot
      // consume (= destroy) a legitimate pending request.
      return safeAck(ack, { error: 'TIMELINE_GRANT_REQUIRED' });
    }
    const parsed = safeParseEvent('timeline:grant', payload);
    if (!parsed.success) return safeAck(ack, { error: 'TIMELINE_BLOB_REJECTED' });
    const { wrap, gid, expires_at_ms } = parsed.data;
    if (gid === undefined || expires_at_ms === undefined) {
      return safeAck(ack, { error: 'TIMELINE_BLOB_REJECTED', message: 'gid and expires_at_ms are required' });
    }
    // Sanity only — the DURATION is the user's choice on the phone (default
    // 1 h, design §1); the server rejects nonsense: an expiry already in the
    // past, or one further out than any client we ship can express. Checked
    // before the pending is consumed so a malformed grant is retryable.
    const t = now();
    if (expires_at_ms <= t || expires_at_ms > t + GRANT_MAX_DURATION_MS) {
      return safeAck(ack, { error: 'TIMELINE_BLOB_REJECTED', message: 'expires_at_ms out of range' });
    }
    const pending = deps.pending.take(gid);
    if (!pending) return safeAck(ack, { error: 'TIMELINE_GRANT_REQUIRED' });
    if (pending.userId !== auth.userId) {
      // Another account's pending. The take() above already consumed it
      // (single-use — the qr-grant redeem discipline), so the legitimate
      // phone now also re-runs the flow; that is the deliberate price of
      // 「a loser sees exactly what a stranger sees」.
      return safeAck(ack, { error: 'TIMELINE_GRANT_REQUIRED' });
    }
    const webSocket = deps.io.sockets.sockets.get(pending.socketId);
    if (!webSocket || !webSocket.connected) {
      // The page that asked is gone, and its ephemeral X25519 secret died
      // with it — a grant row now would be a standing authorization nobody
      // can ever use. No row, named refusal, user re-runs the flow.
      return safeAck(ack, { error: 'TIMELINE_GRANT_REQUIRED' });
    }
    try {
      deps.grants.create({ gid, user_id: auth.userId, origin: pending.origin, expires_at: expires_at_ms });
    } catch {
      // The one reachable cause is a gid colliding with an existing grants row
      // (PRIMARY KEY) — a replayed/duplicated gid must not resurrect or
      // overwrite an authorization (the repo refuses by throw; see its
      // header). Collapsed refusal; the flow re-runs with a fresh gid.
      return safeAck(ack, { error: 'TIMELINE_GRANT_REQUIRED' });
    }
    // 🔴 The blind forward: wrap VERBATIM, to exactly the socket that asked,
    // and to nobody else. Not logged, not stored, not inspected. If this emit
    // is lost to a disconnect race the row still stands — an authorization
    // with no key holder, inert (the web cannot pull plaintext without the
    // wrap, and cannot decrypt pulls without the key) and superseded by the
    // next grant or revocable from the REST list.
    webSocket.emit('timeline:grant', { wrap, gid, expires_at_ms });
    safeAck(ack, { ok: true, gid, expires_at_ms });
  });
}
