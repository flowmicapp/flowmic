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
    stuckSocket = await openStuckConnection(server.port);
    // Let the bytes actually land server-side before racing close() against it.
    await new Promise((r) => setTimeout(r, 100));

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
