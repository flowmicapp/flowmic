// F13 (2026-09-02 audit) — node/node-config.ts `readNodeConfig` TRIMS
// FLOWMIC_NODE_WRITER_URL before deciding what this process is; the HttpDeps
// composition that feeds http/router.ts's replica mutation gate used to read
// the SAME variable a second time, raw, straight off `process.env`.
//
// SPEC-REF: apps/server-core/src/bootstrap-http-deps.ts (`nodes.writerUrl`)
//           apps/server-core/src/node/node-config.ts (`trim`, the one author)
//           apps/server-core/src/http/router.ts (the mutation gate this feeds)
//
// A whitespace-only value for the variable is the case that pulls the two
// readings apart: `.trim()` empties it, so `readNodeConfig` throws NOTHING and
// resolves `role: 'single'` (no FLOWMIC_NODE_ROLE means "untouched deployment",
// and an empty writerUrl there is not the "URL set but role missing" error
// case). The RAW string is still non-empty, so a naive `process.env.X ? … : …`
// truthy check treated the deployment as a replica anyway — router.ts's
// mutation gate would then refuse every POST/PUT/DELETE on a box `nodeConfig`
// itself considers a perfectly ordinary single-node writer, with no relation to
// the variable's actual, intended value: unset.
//
// This is exactly the "one fact, two readers, two answers" shape CLAUDE.md
// names as this repo's most-repeated defect. It is boot-time environment
// hygiene, not a hypothetical: an env file or a shell export with trailing
// whitespace is an ordinary, easy-to-make mistake, and the OLD failure mode is
// silent — no error, no log line naming the cause, just every write refused.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';

let server: BootstrapHandle | null = null;
const ENV_KEYS = ['FLOWMIC_NODE_ID', 'FLOWMIC_NODE_WRITER_URL', 'FLOWMIC_NODE_ROLE'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

afterEach(async () => {
  if (server) await server.close();
  server = null;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function withNodeEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

async function saas(): Promise<string> {
  const config = loadConfig({ mode: 'saas', secret: 'node-writer-url-norm-32-bytes-xx', port: 0, dbPath: ':memory:', trustedProxies: [] });
  server = await startServer(config);
  return `http://127.0.0.1:${server.port}`;
}

describe('F13: FLOWMIC_NODE_WRITER_URL is trimmed the SAME way in both readers', () => {
  it('🔴 whitespace-only writerUrl must NOT turn a single-node deployment into a replica', async () => {
    // No FLOWMIC_NODE_ROLE at all: readNodeConfig's own "untouched deployment"
    // path, which requires a NULL (trimmed) writerUrl or it throws at boot.
    // Reaching a live server here is itself half the proof — the OLD raw read
    // did not change whether boot succeeded (readNodeConfig ran on the correct,
    // trimmed value); it only changed what the router's OWN copy believed.
    withNodeEnv({ FLOWMIC_NODE_ID: 'srvny', FLOWMIC_NODE_WRITER_URL: '   ' });
    const url = await saas();

    // A named, ordinary write. The refusal this test forbids would be 421
    // NODE_IS_REPLICA — a name any operator could grep straight to this file.
    const r = await fetch(`${url}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'f13@v.co', password: 'longenough1' }),
    });
    expect(r.status, 'a whitespace-only writer URL must not 421 an ordinary single-node write').not.toBe(421);
  });

  it('REVERSE CONTROL — a REAL writer URL on an explicit replica still gates writes', async () => {
    // The property above must not have been bought by disabling the gate
    // outright: a genuine replica configuration still refuses.
    withNodeEnv({
      FLOWMIC_NODE_ROLE: 'replica',
      FLOWMIC_NODE_ID: 'srvjp',
      FLOWMIC_NODE_WRITER_URL: 'https://srvny.flowmic.app',
    });
    process.env.FLOWMIC_NODE_SHARED_SECRET = 'node-writer-url-norm-shared-secret';
    const dir = mkdtempSync(join(tmpdir(), 'f13-'));
    process.env.FLOWMIC_NODE_OUTBOX_PATH = join(dir, 'o.jsonl');
    try {
      const url = await saas();
      const r = await fetch(`${url}/api/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'f13-replica@v.co', password: 'longenough1' }),
      });
      expect(r.status).toBe(421);
    } finally {
      delete process.env.FLOWMIC_NODE_SHARED_SECRET;
      delete process.env.FLOWMIC_NODE_OUTBOX_PATH;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
