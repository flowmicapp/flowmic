// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §2 (handshake) — this file adds NO event,
//     NO field and NO error code; it only refuses or closes a transport.
//   apps/server-core/src/auth/middleware.ts — the reason this file exists: a
//     handshake with NO token is ACCEPTED (`data.auth = null; next()`), because
//     first-time `pc:register` and `mobile:pair` happen before any token is
//     minted.
//   apps/server-core/src/http/trusted-proxy.ts `clientIpFromHandshake` — the ONE
//     client-IP derivation; this file reuses it verbatim, never its own.
//   apps/server-core/src/billing/trial-ip-bucket.ts — `ipPrefix` (the counting
//     key) and `ipBucketOf` (the logged key).
//   *** HUMAN-AUDIT SENSITIVE (access control / connection admission) ***
//
// ── WHAT THIS GUARDS ──────────────────────────────────────────────────────
// Every other brake on this relay sits on the HTTP room-mint route (Origin
// allow-list, Turnstile, per-IP burst, daily caps, active-room cap). The
// socket.io handshake sits BELOW all of them: an unauthenticated socket is
// admitted by design, nothing caps how many one address may hold, and one that
// keeps answering pings holds its slot forever (socket.io's 20 s pingTimeout
// only reaps a client that stops answering). Two costs, two mechanisms:
//
//   · `ip_ceiling`  — how MANY sockets one network may hold at once;
//   · `unauth_ttl`  — how LONG a socket that never identified itself may hold one.
//
// Neither mechanism looks at content, and neither can refuse a socket that has
// identified itself: an authenticated socket is somebody's device and is
// governed by the plan limits, not by this file.
//
// ── 🔴 PER PROCESS, NOT PER DEPLOYMENT ────────────────────────────────────
// The counter lives in this process's heap. A socket exists on exactly ONE node
// (it is a TCP connection), so the count here is complete for the node that
// holds it and blind to its siblings: with two relay nodes behind one DNS name
// the effective ceiling for one address is N per node, not N in total. That is
// stated rather than fixed — a shared counter would put an access-control
// decision behind a network round trip, which turns a brake into an outage the
// first time the shared store is unreachable.
//
// ── 🔴 THIS IS A FLOOD BRAKE, NOT A FAIRNESS QUOTA ────────────────────────
// A carrier-grade NAT can put thousands of unrelated subscribers behind one
// address. If enough of them ever run FlowMic at once, this ceiling refuses
// people who did nothing wrong. It is chosen high enough that we have never
// observed such a population (see `DEFAULT_MAX_PER_IP`'s arithmetic), the knob
// is an env var, and the refusal log line carries the count — so the day it
// happens is a day somebody can read about, rather than guess at.

import { clientIpFromHandshake, type HandshakeLike } from '../http/trusted-proxy';
import { ipBucketOf, ipPrefix } from '../billing/trial-ip-bucket';
import { getAuth } from './wire';
import { log } from '../log';
import type { Socket } from 'socket.io';

/**
 * How many admitted sockets ONE network prefix may hold on ONE node.
 *
 * ── THE ARITHMETIC ────────────────────────────────────────────────────────
 * The largest legitimate population we can name behind a single address is an
 * office NAT. Per employee, steady state:
 *   · 1 desktop socket (the desktop keeps both channels up, but only the CLOUD
 *     one reaches this relay — the LAN one never leaves the building),
 *   · 1 phone socket,
 *   · 1 browser socket (the /go client or a `/target/` page).
 * ⇒ 3 sockets per person. A reconnect overlaps the old socket with the new one
 * for up to `PING_TIMEOUT_MS` (20 s, socket/server.ts), so the worst honest
 * instantaneous reading is DOUBLE the steady state ⇒ 6 per person.
 *
 *   80 people × 3 sockets × 2 (reconnect overlap) = 480  →  rounded to 512.
 *
 * 512 is therefore an eighty-person office all reconnecting at the same
 * instant. It is deliberately not tuned to the population we have: a ceiling
 * that bites a real customer is worse than no ceiling, because it will be read
 * as an outage and disabled, and then there is no ceiling either.
 */
export const DEFAULT_MAX_PER_IP = 512;

/**
 * How long an admitted socket may stay unidentified.
 *
 * ── WHY 60 s IS GENEROUS, MEASURED AGAINST THE TREE ───────────────────────
 * The window this bounds is `socket admitted → setAuth`, and NOT 「how long a
 * human takes to type a code」. The phone does the human part BEFORE it dials:
 * `apps/mobile/lib/src/ptt/ptt_pair.dart` calls `transport.connect(...)` and
 * then `emitWithAck('mobile:pair', …)` inside the same function, with no user
 * interaction between them — the 4-digit code / scanned payload is already in
 * hand at connect time. The PC's `pc:register` / `pc:reconnect` likewise goes
 * out on connect. So the real window is one round trip, plus (on a replica)
 * one writer read-through for a token this node has not replicated yet.
 *
 * 60 s is roughly three orders of magnitude of headroom over that, which is the
 * point: this cutoff must never be the thing that explains a failed pairing.
 */
export const DEFAULT_UNAUTH_TTL_MS = 60_000;

/**
 * The code a refused handshake carries.
 *
 * 🔴 REUSED, NOT INVENTED — and the reuse is argued rather than assumed,
 * because a code whose sentence lies about the cause is forbidden
 * (`packages/protocol/src/error-codes.ts` says so in a dozen places).
 * Its copy: 「Too many sign-ups from this network, please try again later.」 /
 * 「注册过于频繁，请稍后再试。」
 *
 * WHY THIS ONE. It is the only registered sentence scoped to THE NETWORK, which
 * is exactly the axis this ceiling counts on, and the one action it names —
 * wait, retry — is exactly the action that works here: a slot frees the moment
 * any socket behind that address closes.
 *
 * WHY NOT A NEIGHBOUR — every one of them points somewhere false:
 *   · `PAIR_RATE_LIMITED` — asserts the CALLER's behaviour ('too many pairing
 *     attempts'). A desktop that has been paired for months and is merely
 *     reconnecting never attempted to pair; the sentence would accuse it of
 *     something it did not do, and send its owner looking for a pairing screen;
 *   · `INJECT_SERVER_BUSY` — names deliveries in flight. This socket never got
 *     far enough to deliver anything; it names a subsystem the refusal never
 *     reached;
 *   · `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_UNVERIFIABLE` — both put a CREDENTIAL
 *     in doubt, and both phone and desktop key credential handling on those
 *     exact strings (see middleware.ts's A11/F2-a correction). A capacity
 *     refusal wearing one of them would read as a revoked pairing — the most
 *     expensive lie available in this table;
 *   · `PC_HANDSHAKE_PENDING` / `INJECT_NOT_IN_ROOM` — 「not ready yet」 promises
 *     that waiting a moment is enough, which is only true by accident here.
 *
 * ⚠️ WHAT IT STILL GETS WRONG, ON THE RECORD: the noun is 「sign-ups」/「注册」
 * and the true cause is 「connections」. A PC that is refused was indeed about
 * to call `pc:register`, so the noun is nearly right for that half; for a phone
 * it is off. That imprecision is the price of not adding a code, and adding one
 * is an owner gate (CLAUDE.md, 「加码归 owner 门」). If this guard ever fires in
 * production often enough for a human to read the sentence, the right follow-up
 * is a code of its own, not a re-reuse.
 */
export const IP_CEILING_REFUSAL_CODE = 'REGISTER_RATE_LIMITED';

/** The bits of a socket this guard touches. Structural so the tests drive it
 *  without a socket.io server — the same reason `HandshakeLike` is structural. */
export interface GuardableSocket {
  handshake?: HandshakeLike;
  data?: Record<string, unknown>;
  on(event: 'disconnect', listener: () => void): unknown;
  disconnect(close?: boolean): unknown;
}

type Next = (err?: Error) => void;

export interface ConnectionGuardOptions {
  /** Per-network ceiling; see {@link DEFAULT_MAX_PER_IP}. */
  maxPerIp: number;
  /** Unidentified-socket cutoff in ms; see {@link DEFAULT_UNAUTH_TTL_MS}. */
  unauthTtlMs: number;
  /** `FLOWMIC_TRIAL_IP_SALT`, already resolved once per process (bootstrap
   *  passes `webRoom.ipSalt`). Resolving a second one here would print the
   *  missing-secret warning twice, which bootstrap-web-room-deps.ts's header
   *  already names as the way to train the one reader of that log to ignore it. */
  ipSalt: string;
  /** This node's id, for the log lines only. Never gates anything. */
  nodeId?: string | null;
  /** Injectable timers (same convention as `AudioSessionRegistry`). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * `FLOWMIC_SOCKET_MAX_PER_IP`, or the contract default.
 *
 * Beside the constant it falls back to, so 「what happens to a malformed value」
 * is answerable in one place — the rule `resolveBudgetHeartbeatMs` states. A
 * NaN here would compare false against every count and SILENTLY DISABLE the
 * ceiling: a guard that is configured, believed, and does nothing.
 */
export function resolveSocketMaxPerIp(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.FLOWMIC_SOCKET_MAX_PER_IP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_PER_IP;
}

/** `FLOWMIC_SOCKET_UNAUTH_TTL_MS`, or the contract default. Same NaN rule: a
 *  NaN cutoff would arm a timer that fires immediately and drop every pairing
 *  handshake in flight, which is the opposite failure and a far louder one. */
export function resolveSocketUnauthTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const ms = Number(env.FLOWMIC_SOCKET_UNAUTH_TTL_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_UNAUTH_TTL_MS;
}

/**
 * The connection-layer guard for ONE process.
 *
 * ── WHERE IT SITS IN THE MIDDLEWARE CHAIN ─────────────────────────────────
 * AFTER `authMiddleware`, deliberately. The count must equal 「sockets this node
 * actually holds」, and the only sockets it holds are the ones every middleware
 * admitted; counting a socket a later middleware then refuses would leak a slot
 * per refusal (no `disconnect` fires for a handshake that never completed), and
 * a leaking counter walks up to the ceiling on its own and locks out a network
 * that did nothing. The cost of running last is that an over-ceiling handshake
 * still paid for one token lookup — a bounded, local cost, paid only by an
 * address already past its ceiling.
 */
export class SocketConnectionGuard {
  private readonly open = new Map<string, number>();
  private readonly opts: ConnectionGuardOptions;

  constructor(opts: ConnectionGuardOptions) {
    this.opts = opts;
  }

  /** Open sockets currently counted against `ip`'s network prefix. Test seam —
   *  nothing in production reads it. */
  openCountFor(ip: string): number {
    return this.open.get(ipPrefix(ip)) ?? 0;
  }

  /** The socket.io middleware. See the class doc for why it runs last. */
  middleware = (socketUnknown: unknown, next: Next): void => {
    const socket = socketUnknown as GuardableSocket;
    // 🔴 THE DERIVATION IS NOT OURS. `clientIpFromHandshake` is the single
    // author of 「who is this」 for every per-IP decision on this server: the
    // direct peer, UNLESS that peer is a configured trusted proxy
    // (FLOWMIC_TRUSTED_PROXIES), in which case the rightmost X-Forwarded-For hop
    // that is not itself one of our proxies. `CF-Connecting-IP` is NOT read —
    // not here and nowhere else in this tree (grep: zero hits) — because nginx
    // is the hop we configured and it APPENDS what it observed to XFF. Keying
    // this ceiling on anything Cloudflare-shaped that resolves to the EDGE would
    // cap the entire internet at one bucket: worse than no guard, because it
    // would look like one.
    const ip = clientIpFromHandshake(socket.handshake) || '';
    const key = ipPrefix(ip);
    const held = this.open.get(key) ?? 0;
    if (held >= this.opts.maxPerIp) {
      this.refuse('ip_ceiling', ip, held);
      next(new Error(IP_CEILING_REFUSAL_CODE));
      return;
    }
    this.open.set(key, held + 1);

    let released = false;
    let timer: unknown = null;
    const setTimeoutFn = this.opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimeoutFn = this.opts.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    const release = (): void => {
      // Idempotent on purpose: socket.io fires `disconnect` once, but this
      // object also closes sockets itself below, and a decrement that ran twice
      // would hand the network a free slot every time.
      if (released) return;
      released = true;
      const now = this.open.get(key) ?? 0;
      if (now <= 1) this.open.delete(key);
      else this.open.set(key, now - 1);
      if (timer !== null) clearTimeoutFn(timer);
    };
    socket.on('disconnect', release);

    timer = setTimeoutFn(() => {
      timer = null;
      // 🔴 THE CONDITION IS READ AT FIRE TIME, THROUGH `getAuth` — the SAME
      // accessor `pc:register` / `pc:reconnect` / `mobile:pair` /
      // `mobile:reconnect` write through (`setAuth`, socket/wire.ts) and the
      // same one the handshake fills for a device token or a declared web
      // client. One author for 「is this socket somebody」; a private copy of
      // that rule here would agree with the real one only until somebody edited
      // one of them.
      if (getAuth(socket as unknown as Socket) !== null) return;
      this.refuse('unauth_ttl', ip, this.open.get(key) ?? 0);
      // Close, then release: the close is what frees the slot in the real
      // world, and `release` is idempotent, so the `disconnect` this triggers
      // costs nothing.
      socket.disconnect(true);
      release();
    }, this.opts.unauthTtlMs);
    (timer as { unref?: () => void } | null)?.unref?.();

    next();
  };

  /** One structured line per refusal — the only way anybody will ever learn
   *  that this guard fired. The IP is HASHED (`ipBucketOf`, the same digest the
   *  site-demo ledger stores) and never logged raw: the privacy policy says the
   *  service does not keep visitor addresses, and a log line is keeping one. */
  private refuse(reason: 'ip_ceiling' | 'unauth_ttl', ip: string, held: number): void {
    log.warn('socket-guard: refused a connection', {
      reason,
      ip_bucket: ipBucketOf(ip, this.opts.ipSalt),
      held,
      max_per_ip: this.opts.maxPerIp,
      unauth_ttl_ms: this.opts.unauthTtlMs,
      node: this.opts.nodeId ?? 'unknown',
      ...(reason === 'ip_ceiling' ? { code: IP_CEILING_REFUSAL_CODE } : {}),
    });
  }
}
