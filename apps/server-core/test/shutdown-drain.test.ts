// COST BUDGET: 5.0 s because the stuck connection never drains, so close() waits out the product's own SHUTDOWN_GRACE_MS (5 s, src/shutdown.ts symbol SHUTDOWN_GRACE_MS) before forcing it — measured 2026-09-13 dev-pc-a: startServer 22 ms, the graced close 5,008 ms.
//
// RV-65 — "the server said it was shutting down, and then it did not".
//
// Node's http.Server.close() (v18.2+, confirmed present in both the v22.11.0
// production runtime and the local v22.22.3 one via httpServerPreClose in
// lib/_http_server.js) already auto-releases GENUINELY IDLE keep-alive
// sockets as part of close() itself — verified empirically while writing this
// test (a bare `agent.freeSockets` idle connection closes in ~2ms with no
// fix). That is NOT the gap this card exists to close.
//
// The gap is a connection that is NOT idle by Node's own bookkeeping: one
// with a request in flight whose response the server has not finished
// (`_httpMessage.finished === false`, or — as reproduced below — a request
// whose HEADERS have not even finished arriving, so no `_httpMessage` exists
// yet at all). Node's automatic idle-sweep explicitly SKIPS these
// (`closeIdleConnections()`'s own `!socket._httpMessage.finished` guard), and
// nothing else in a stock `httpServer.close()` ever forces them — the
// documented contract is literally "closes existing connections... the
// server is finally closed when all connections are ended." A slow/partial
// proxy connection (nginx, `proxy_http_version 1.1`) sitting on an
// unfinished request/response — matching the card's production evidence: one
// `shutting down` log line, then 20s of nothing, then SIGKILL — reproduces
// exactly this shape. This test recreates it directly with a raw socket
// (no dependency on any particular route's timing) so it does not depend on
// which endpoint happened to be mid-flight in production.
//
// Starts and closes its OWN server per test (not the shared golden-path
// instance) because it needs to observe close() itself.

import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';

let server: BootstrapHandle | undefined;
let stuckSocket: net.Socket | undefined;

afterEach(async () => {
  stuckSocket?.destroy();
  stuckSocket = undefined;
  // Best-effort: a test that fails before closing must not leak a listening
  // server (and its port) into whatever runs next.
  if (server) {
    await server.close().catch(() => {});
    server = undefined;
  }
});

/** Opens a raw TCP connection and writes an HTTP/1.1 request line + headers
 *  WITHOUT the terminating blank line, then leaves the socket open. The
 *  server's parser never dispatches a 'request' event, so this connection
 *  never becomes idle and Node's own automatic idle-sweep (inside close())
 *  never touches it — the exact class of connection a stock close() waits on
 *  forever. Resolves once the bytes are flushed (not once anything answers —
 *  nothing will). */
function openStuckConnection(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n', (err) => {
        if (err) reject(err);
        else resolve(sock);
      });
    });
    sock.on('error', reject);
  });
}

describe('RV-65: close() must not wait forever on a connection with a request in flight', () => {
  it('resolves close() within a bound well under systemd TimeoutStopSec=20s, with one stuck in-flight connection open', async () => {
    const config = loadConfig({ port: 0, dbPath: ':memory:', secret: 'shutdown-drain-test-secret-32-bytes-long' });
    server = await startServer(config);
    // WAIT FOR THE BYTES, DO NOT SLEEP FOR THEM (2026-09-13). This used to be
    // `setTimeout(r, 100)`, and the direction that sleep can fail in is the one
    // this file's header warns about: too early and the server-side connection
    // is still IDLE, Node's own idle-sweep closes it, close() returns at once —
    // and the test passes ON UNFIXED CODE. A sleep that is only ever a little
    // too short produces a green, not a red, so nothing would report it.
    // The server socket's first 'data' is the fact the sleep was estimating
    // (measured on this box: bytesRead=67 by then), so wait for that instead.
    // Armed BEFORE connecting — the event cannot be caught after it fires.
    // 🔴 REVERSE CONTROL for the swap, measured red 2026-09-13 (marker
    // REVERSE-CONTROL-F): shutdown.ts reduced to the pre-RV-65 stock close()
    // (no closeIdleConnections, no grace timer, no closeAllConnections) ⇒ this
    // case FAILED with `expected false to be true` at 18 s, the production
    // shape. Restored; `grep -rn "REVERSE-CONTROL-F" apps/server-core/src` = 0.
    const handle = server;
    const bytesLanded = new Promise<void>((resolve) => {
      handle.httpServer.once('connection', (sock) => sock.once('data', () => resolve()));
    });
    stuckSocket = await openStuckConnection(server.port);
    await bytesLanded;

    // The number a passing test has to beat, not a tuning knob — chosen well
    // under deploy/flowmic-app.service's TimeoutStopSec=20s so a pass here
    // actually means "systemd would not have had to SIGKILL this".
    const BOUND_MS = 8_000;
    const startedAt = Date.now();
    let resolved = false;
    const closed = server.close().then(() => {
      resolved = true;
    });
    const timedOut = new Promise<void>((resolve) => setTimeout(resolve, BOUND_MS));
    await Promise.race([closed, timedOut]);

    // false here IS the production bug: close() hung past the bound exactly
    // like it hangs past systemd's 20s in the field.
    expect(resolved).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(BOUND_MS);

    server = undefined; // already closing/closed — afterEach must not double-close
    await closed; // don't leak the pending close into the next test
  }, 15_000);
});
