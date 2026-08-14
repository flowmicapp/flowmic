// Shared plumbing for the plain node:http routes: a JSON responder and a
// size-bounded body reader. Extracted from diag-routes.ts (2026-07-30) the
// moment a second consumer (inject-routes) appeared — two hand-rolled bounded
// readers is exactly how one of them ends up unbounded.

import type { IncomingMessage, ServerResponse } from 'node:http';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/** Read a bounded UTF-8 body. Over the cap, the connection is answered (not
 *  silently dropped) so the client can say WHY its upload did not land. */
export function readBounded(req: IncomingMessage, cap: number): Promise<string | 'TOO_LARGE'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    // Exactly-once settle: Node v22 can skip 'end'/'error' after destroy, and
    // 'close' always fires after a normal end — either way the Promise must
    // never hang and must never resolve/reject twice.
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    req.on('data', (c: Buffer) => {
      // Already over: keep the stream flowing (see resume below) but do not
      // buffer — that would re-pin the memory we just freed.
      if (over) return;
      size += c.length;
      if (size > cap) {
        over = true;
        // Free what we already held; outcome is decided, bytes are useless.
        chunks.length = 0;
        // Do NOT req.destroy() here. Destroying before the route writes 413 is
        // what made the old TOO_LARGE branch dead code (Promise never settled,
        // client saw a reset and retried). Drain instead so backpressure cannot
        // stall the response the route is about to send.
        req.resume();
        settle(() => resolve('TOO_LARGE'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      settle(() => resolve(over ? 'TOO_LARGE' : Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', () => {
      settle(() => (over ? resolve('TOO_LARGE') : reject(new Error('body read failed'))));
    });
    // Peer abort / socket close with no 'end': without this the Promise hangs
    // forever (RV-03 shape). Named so route .catch can tell it from other fails.
    const onAbort = (): void => {
      settle(() => reject(new Error('body read aborted')));
    };
    req.on('close', onAbort);
    req.on('aborted', onAbort);
  });
}
