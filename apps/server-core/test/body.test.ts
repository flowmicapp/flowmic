// RV-03 — readBounded must settle on every path. The old impl destroyed the
// request on oversize then waited for 'end'/'error'; Node v22 emits neither,
// so the Promise hung, the 413 branch was dead, and the phone retried a reset.

import { describe, it, expect } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import { readBounded, sendJson } from '../src/http/body';

function fakeReq(): IncomingMessage {
  const ee = new EventEmitter() as IncomingMessage & EventEmitter;
  // readBounded calls resume() after oversize so backpressure cannot stall
  // the 413; a bare EventEmitter has no resume — stub it.
  ee.resume = (() => ee) as IncomingMessage['resume'];
  return ee;
}

describe('readBounded', () => {
  it('under cap resolves the full UTF-8 body', async () => {
    const req = fakeReq();
    const p = readBounded(req, 64);
    req.emit('data', Buffer.from('hello', 'utf8'));
    req.emit('data', Buffer.from(' world', 'utf8'));
    req.emit('end');
    await expect(p).resolves.toBe('hello world');
  });

  it('over cap settles TOO_LARGE without waiting for end', async () => {
    const req = fakeReq();
    const p = readBounded(req, 4);
    // One oversize chunk, no 'end' — this is the hang proof for the old code.
    req.emit('data', Buffer.from('12345', 'utf8'));
    await expect(p).resolves.toBe('TOO_LARGE');
  });

  it('close before settle rejects with a named error', async () => {
    const req = fakeReq();
    const p = readBounded(req, 64);
    req.emit('close');
    await expect(p).rejects.toThrow('body read aborted');
  });

  it('late close/error after settle neither re-settles nor unhandled-rejects', async () => {
    const req = fakeReq();
    const p = readBounded(req, 64);
    req.emit('data', Buffer.from('ok', 'utf8'));
    req.emit('end');
    await expect(p).resolves.toBe('ok');

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      req.emit('close');
      req.emit('error', new Error('late socket error'));
      await new Promise<void>((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('readBounded real HTTP', () => {
  it('oversize body yields a real 413 (not reset / not timeout)', async () => {
    const server = createServer((req, res) => {
      void (async () => {
        const body = await readBounded(req, 1024).catch(() => null);
        if (body === 'TOO_LARGE') {
          sendJson(res, 413, { ok: false, error: 'TOO_LARGE', max_bytes: 1024 });
          return;
        }
        if (body === null) {
          sendJson(res, 400, { ok: false, error: 'BODY_UNREADABLE' });
          return;
        }
        sendJson(res, 200, { ok: true, len: body.length });
      })();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') {
      server.close();
      throw new Error('expected TCP listen address');
    }
    const url = `http://127.0.0.1:${addr.port}/`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'x'.repeat(2048),
        // Hard ceiling: a hang here is the bug this card exists to kill.
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(413);
      await expect(res.json()).resolves.toMatchObject({ ok: false, error: 'TOO_LARGE' });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
