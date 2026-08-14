// SPEC-REF:
//   docs/strategy/2026-08-08-design-d2lan-light-encryption.md §3-2 (loopback must
//     stay plain — the desktop's own sidecar client is hand-rolled HTTP over
//     TcpStream and its header says "never TLS"), §4-2, §4 compatibility and
//     ordering (the transition period must accept plain AND TLS at once or every
//     0.2.x phone is locked out), §6-3 ("is this connection encrypted" must be
//     answerable per connection, from the connection itself, never from a
//     global setting)
//
// ONE listening port that serves plain HTTP/ws and TLS/wss, decided per
// connection by its first byte.
//
// 🔴 WHY NOT TWO LISTENERS (which is what the design originally assumed). The
// pairing QR carries exactly one endpoint with exactly one port, the desktop's
// sidecar client is hard-wired to `http://127.0.0.1:41879`
// (apps/desktop/src-tauri/src/sidecar/io.rs, symbol `probe_health`), and the
// phone inherits scheme and port for every alternate host from that single
// endpoint (apps/mobile/lib/src/session/endpoint_candidates.dart, symbol
// `expandCandidates`). A second port would have had to appear in all three. One
// port sniffing its first byte makes the transition period fall out for free and
// costs the desktop nothing at all.
//
// 🔴 WHY THE TLS SOCKET IS HANDED TO THE SAME http.Server. The alternative —
// a separate `https.createServer` — would need socket.io attached to it as well,
// and socket.io's `attach()` REPLACES its engine rather than adding one, so two
// attachments give two answers to "which engine gets this connection". Terminating TLS
// here and emitting the decrypted duplex onto the existing server means there is
// exactly one http server, one socket.io instance, one handler registration path,
// and every route and event works over both schemes without knowing this file
// exists. Measured, not assumed: plain HTTP, TLS HTTP, ws and wss socket.io all
// round-trip through this seam (test/lan-tls-dual-listener.test.ts).
//
// 🔴 THE CAVEAT THAT COMES WITH SNIFFING. Accepting both means plain is still
// accepted FROM THE LAN, so "the server has TLS on" says nothing about any
// individual connection. The per-connection answer is `req.socket.encrypted`
// (`socket.conn.request.socket.encrypted` on the socket.io side) — a property of
// the connection itself, which is exactly what §6-3 demands and what a global
// config flag could never be. Nothing here caches or summarises it, deliberately:
// a summary is precisely the value that would end up answering a question it
// cannot see.

import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { createSecureContext, TLSSocket, type SecureContext } from 'node:tls';
import type { Server as HttpServer } from 'node:http';

/** TLS record ContentType 22 (handshake). A ClientHello's first byte, and not a
 *  byte any HTTP method can start with — every HTTP verb begins with an ASCII
 *  letter (0x41–0x5a), and 0x16 is a control character. The discrimination is
 *  total, not heuristic. */
const TLS_HANDSHAKE_FIRST_BYTE = 0x16;

/** How long a connection may stay silent before we decide it is not going to
 *  tell us what it is. Without this, a peer that connects and says nothing holds
 *  a socket (and a file descriptor) open forever — the sniff is a read, and a
 *  read with no deadline is a leak. Every real client here sends immediately: an
 *  HTTP request line, a ClientHello, or a websocket upgrade. */
const SNIFF_TIMEOUT_MS = 15_000;

export interface DualProtocolFront {
  /** The listening socket. This is what `listen()` is called on and what holds
   *  the port — the http server itself is never told to listen. */
  server: TcpServer;
  close(): Promise<void>;
}

/**
 * Front `httpServer` with a TCP listener that terminates TLS for peers that ask
 * for it and passes everyone else through untouched.
 *
 * The http server MUST NOT be listening itself: this takes over the port.
 */
export function createDualProtocolFront(opts: { httpServer: HttpServer; certPem: string; keyPem: string }): DualProtocolFront {
  const secureContext: SecureContext = createSecureContext({ cert: opts.certPem, key: opts.keyPem });
  const server = createTcpServer((raw: Socket) => dispatch(raw, opts.httpServer, secureContext));
  return {
    server,
    close: async (): Promise<void> => {
      // 🔴 Stops ACCEPTING, and deliberately does not wait for what was already
      // accepted. `net.Server.close(cb)` calls back only once every connection it
      // accepted has ended — with no deadline — so awaiting that callback would
      // make shutdown hostage to the slowest idle keep-alive socket. MEASURED:
      // one idle keep-alive connection from a plain probe added ~4 s per teardown
      // before this was split. That is precisely the unbounded wait RV-65 fixed
      // (see shutdown.ts, SHUTDOWN_GRACE_MS) and it must not come back in through
      // a second listener.
      //
      // The listening handle IS released synchronously inside close(), so the
      // port is free the moment this returns; only the 'close' EVENT waits. The
      // connections themselves are the http server's to drain, on its bounded
      // budget — including the TLS ones, because a terminated TLS socket reached
      // it through the same 'connection' event as a plain one and is tracked
      // identically, and destroying it destroys the raw socket underneath.
      server.close();
    },
  };
}

function dispatch(raw: Socket, httpServer: HttpServer, secureContext: SecureContext): void {
  // 🔴 An unhandled 'error' on a socket is an uncaught exception, i.e. the whole
  // sidecar. A LAN listener meets port scanners, half-open probes and phones
  // walking out of wifi range; every one of those is an error on this socket
  // BEFORE any server owns it. This listener is the only thing between that and
  // a crash, and it must be attached before anything can fail.
  raw.on('error', () => raw.destroy());
  const onSniffTimeout = (): void => {
    raw.destroy();
  };
  raw.setTimeout(SNIFF_TIMEOUT_MS, onSniffTimeout);

  raw.once('data', (first: Buffer) => {
    // Hand the timeout policy back to whoever owns the connection now: the http
    // server has its own (`headersTimeout`/`requestTimeout`), and a 15 s cap
    // applied to an established websocket would kill every idle phone.
    //
    // 🔴 Both halves are needed. `setTimeout(0)` disarms OUR deadline, but the
    // listener would stay registered on the 'timeout' event — so if anything
    // downstream ever re-armed a timeout on this socket (http.Server does set
    // `server.timeout` when it is non-zero), OUR destroy would fire on THEIR
    // policy, from a module that no longer owns the connection. Removing the
    // listener is what actually ends this file's involvement.
    raw.setTimeout(0);
    raw.off('timeout', onSniffTimeout);

    const isTls = first.length > 0 && first.readUInt8(0) === TLS_HANDSHAKE_FIRST_BYTE;

    // Put the bytes back and stop reading until the new owner is listening —
    // without the pause/resume the remainder of the ClientHello can arrive
    // before the TLSSocket has attached its own 'data' handler.
    raw.pause();
    raw.unshift(first);

    if (isTls) {
      const secured = new TLSSocket(raw, { isServer: true, secureContext });
      // Same reasoning as `raw.on('error')` above, one layer up: a peer that
      // rejects our certificate (the pin mismatch this whole card exists to make
      // possible) aborts the handshake, and that surfaces here. It is a NORMAL
      // outcome, not an incident — the phone refusing an impostor is the feature
      // working — so it is not logged as an error and it must never be fatal.
      secured.on('error', () => secured.destroy());
      httpServer.emit('connection', secured);
    } else {
      httpServer.emit('connection', raw);
    }

    // Resume on the next tick so the new owner's listeners are installed first.
    process.nextTick(() => raw.resume());
  });
}
