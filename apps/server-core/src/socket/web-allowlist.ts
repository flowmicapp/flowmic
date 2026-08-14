// SPEC-REF:
//   docs/rebuild/09-WEB-SPEC.md §5 (web JWT socket may emit ONLY
//     timeline:grant-request + timeline:pull; everything else →
//     WEB_EVENT_NOT_ALLOWED, default-deny)
//   docs/strategy/2026-08-11-design-e-grant-web-preview.md §3.3 (the allowlist
//     answers "what may this class of client say" (这类客户端能说什么); the
//     read-only codes answer a different
//     question and live in timeline.handler.ts — two gates on purpose)
//   CLAUDE.md human-audit four sensitive paths: pairing/auth (admission) —
//     line-by-line human review
//   *** HUMAN-AUDIT SENSITIVE (auth: web-session containment) ***
//
// Default-deny for kind:'web' sockets. A browser session is the least-trusted
// client this relay admits — it runs in a context we do not control next to
// code we did not ship — so it gets a POSITIVE allowlist: the two events its
// one feature needs, and nothing else. Every other frame is refused BY NAME
// before any handler can hear it.
//
// THE SEAM: `socket.use` (socket.io's per-socket inbound-packet middleware),
// not `onAny` — measured against socket.io 4.8.3's dispatch order in
// socket.js: `onevent` pushes the ack into the args array, runs the onAny
// listeners, and only THEN dispatches through the middleware chain
// (`dispatch` → `run`). An onAny listener therefore observes frames but
// cannot stop them; a middleware that never calls next() is the only seam
// where the frame provably never reaches its handler. docs/rebuild vol. 09's
// "onAny defaults to deny" (onAny 默认拒)
// names the intent (default-deny at a central seam), and this is the seam
// that can actually enforce it.
//
// COEXISTENCE with wrapSocketHandlers (error-handling.ts): that layer patches
// `socket.on`, i.e. the HANDLER side; this installs on the middleware side.
// The two never touch the same function, so handlers registered after
// wrapSocketHandlers stay contained exactly as before — and because socket.io
// runs `socket.use` middlewares with NO try/catch of its own (error-handling's
// header documents the bare process.nextTick dispatch), the middleware below
// wraps its whole body, refusing the frame rather than throwing into the
// engine when something inside it breaks (fail closed, out loud).

import type { Socket } from 'socket.io';
import { RateGate } from '../error-handling';
import { log } from '../log';
import { getAuth, safeAck } from './wire';

/** The POSITIVE allowlist — docs/rebuild vol. 09 §5 verbatim: the grant handshake's request
 *  and the (grant-gated) pull. NOT exported for extension: adding a name here
 *  is a product decision on the admission face, not a convenience. */
const WEB_ALLOWED_EVENTS: ReadonlySet<string> = new Set(['timeline:grant-request', 'timeline:pull']);

/** One rate gate for the no-ack refusal log line, module-shared across sockets
 *  for the same reason error-handling.ts shares its handler gates: a hostile
 *  page spams from many sockets at once, and per-socket gates would multiply
 *  the flood right back. */
const refusalLogGate = new RateGate(5_000);

/**
 * Install the default-deny middleware on this socket. Installed on EVERY
 * connection (bootstrap) and self-gating per frame: a socket whose AuthContext
 * is not kind:'web' passes through untouched — pc/mobile dispatch is
 * byte-identical on the wire, which the identity regression pin holds.
 *
 * For a refused frame that carried an ack, the ack gets the named refusal
 * ({error: WEB_EVENT_NOT_ALLOWED}) — the caller learns, by code, that the
 * refusal is about what a web session may say, not about its (valid) JWT. A
 * refused frame with NO ack has nowhere to answer, so the refusal goes to the
 * log instead (rate-gated), never silently nowhere.
 */
export function installWebAllowlist(socket: Socket): void {
  socket.use((packet, next) => {
    try {
      if (getAuth(socket)?.kind !== 'web') {
        next();
        return;
      }
      const eventName = packet[0];
      if (typeof eventName === 'string' && WEB_ALLOWED_EVENTS.has(eventName)) {
        next();
        return;
      }
      // Refused: next() is deliberately NOT called — the frame never reaches a
      // handler (that property, not the ack, is what the frame-level probe in
      // the tests asserts).
      const maybeAck = packet[packet.length - 1];
      if (typeof maybeAck === 'function') {
        safeAck(maybeAck, { error: 'WEB_EVENT_NOT_ALLOWED' });
      } else {
        const suppressed = refusalLogGate.tryAcquire();
        if (suppressed !== null) {
          // Event name + socket id only — NEVER the payload (it could carry
          // anything a hostile page put there; the privacy rule is
          // error-handling.ts's, applied to the same kind of line).
          log.warn('web allowlist: refused an ack-less event from a web socket', {
            event: typeof eventName === 'string' ? eventName : typeof eventName,
            socketId: socket.id,
            suppressedSinceLastLine: suppressed,
          });
        }
      }
    } catch (err) {
      // A broken gate must fail CLOSED (frame dropped, logged), never throw
      // into socket.io's uncaught dispatch path and never fail open.
      log.error('web allowlist: middleware failed — frame refused', {
        socketId: socket.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
