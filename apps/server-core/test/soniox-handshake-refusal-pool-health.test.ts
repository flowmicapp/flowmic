// NR-178 follow-up — a Soniox key refused AT THE HANDSHAKE (HTTP 401/403 on the
// upgrade) must reach the pool's health verdict as a FATAL STT_ENGINE_AUTH_FAIL,
// the same verdict the in-band error frame already yields; any other handshake
// failure (5xx, network) stays the non-fatal STT_ENGINE_TIMEOUT it was.
//
// Before the fix `open()` rejected with the plain `Error` from `ws`, and
// `probeRouteLiveness`'s catch maps every non-`SttEngineError` to
// `STT_ENGINE_TIMEOUT` (fatal:false) ⇒ the route stayed available and every
// session re-dialled a key the vendor had already refused.
//
// No test double on the engine side: the private package is loaded through the
// production loader (`requireCloudEngine`, via FLOWMIC_STT_CLOUD_MODULE pointed
// at its built dist) and talks real `ws` to a loopback server that refuses the
// upgrade. The dist is what production loads, so it must be fresh — the lane
// gate rebuilds it (`scripts/refresh-derived.mjs`).

import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultEngineFactory } from '../src/stt/engine-factory';
import type { EngineFactory } from '../src/stt/engine-router';
import { probeRouteLiveness } from '../src/stt/pool-health';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_DIST = path.resolve(HERE, '../../../packages/stt-cloud/dist/index.cjs');
const ENV_KEY = 'FLOWMIC_STT_CLOUD_MODULE';
afterEach(() => { delete process.env[ENV_KEY]; });

async function refusingServer(status: number) {
  const srv = http.createServer();
  srv.on('upgrade', (_req, socket) => {
    socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  return { url: `ws://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

async function probeAgainst(status: number) {
  process.env[ENV_KEY] = CLOUD_DIST;
  const srv = await refusingServer(status);
  try {
    const factory: EngineFactory = defaultEngineFactory;
    return await probeRouteLiveness(
      factory,
      { language: '*', engine_id: 'soniox', endpoint: srv.url, api_key: 'nr178-handshake-key' },
      'zh',
      { settleMs: 0, openTimeoutMs: 3_000 },
    );
  } finally {
    await srv.close();
  }
}

describe('pool-health × Soniox handshake refusal (real adapter, real ws)', () => {
  for (const status of [401, 403]) {
    it(`HTTP ${status} on the upgrade ⇒ fatal STT_ENGINE_AUTH_FAIL (route evicted, not retried)`, async () => {
      const v = await probeAgainst(status);
      expect(v.ok).toBe(false);
      expect(v.code).toBe('STT_ENGINE_AUTH_FAIL');
      expect(v.fatal).toBe(true);
      expect(v.message).toContain(`HTTP ${status}`);
    });
  }

  it('HTTP 503 on the upgrade stays a non-fatal STT_ENGINE_TIMEOUT (a retry may help)', async () => {
    const v = await probeAgainst(503);
    expect(v.ok).toBe(false);
    expect(v.code).toBe('STT_ENGINE_TIMEOUT');
    expect(v.fatal).toBe(false);
    // Positive control: the verdict carries the vendor's real refusal, so the
    // non-fatal answer is about THIS failure, not a blind probe.
    expect(v.message).toContain('503');
  });
});
