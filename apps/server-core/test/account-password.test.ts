// Signed-in POST /api/account/password — not the forgot/reset pair.
//
// SPEC-REF: src/http/account-password-routes.ts
// *** HUMAN-AUDIT SENSITIVE (auth: password change) ***

import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';

const SECRET = 'account-password-secret-32-bytes-xx';
const OLD = 'longenough1';
const NEXT = 'brandnewpass1';

let server: BootstrapHandle | null = null;

async function saas(): Promise<string> {
  const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', trustedProxies: [] });
  server = await startServer(config, {});
  return `http://127.0.0.1:${server.port}`;
}

afterEach(async () => {
  if (server) await server.close();
  server = null;
});

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, json };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function register(url: string, email: string): Promise<{ token: string; id: string }> {
  const r = await post(`${url}/api/register`, { email, password: OLD, display_name: 'C' });
  expect(r.status).toBe(201);
  return { token: r.json!.token as string, id: (r.json!.user as { id: string }).id };
}

describe('POST /api/account/password', () => {
  it('requires Bearer; wrong current password is AUTH_LOGIN_FAILED; right one rotates', async () => {
    const url = await saas();
    expect((await post(`${url}/api/account/password`, { current_password: OLD, new_password: NEXT })).status).toBe(401);

    const { token } = await register(url, 'pw@b.co');
    const wrong = await post(
      `${url}/api/account/password`,
      { current_password: 'not-the-password-1', new_password: NEXT },
      bearer(token),
    );
    expect(wrong.status).toBe(401);
    expect(wrong.json?.error).toBe('AUTH_LOGIN_FAILED');
    expect((await post(`${url}/api/login`, { email: 'pw@b.co', password: OLD })).status).toBe(200);

    const ok = await post(
      `${url}/api/account/password`,
      { current_password: OLD, new_password: NEXT },
      bearer(token),
    );
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ ok: true });
    expect((await post(`${url}/api/login`, { email: 'pw@b.co', password: OLD })).status).toBe(401);
    expect((await post(`${url}/api/login`, { email: 'pw@b.co', password: NEXT })).status).toBe(200);
  });

  it('refuses a between-the-limits new password itself (A4-3: no unhandled throw)', async () => {
    const url = await saas();
    const { token } = await register(url, 'pol@b.co');
    const refused = await post(
      `${url}/api/account/password`,
      { current_password: OLD, new_password: 'between9x' },
      bearer(token),
    );
    expect(refused.status).toBe(400);
    expect(refused.json?.error).toBe('SETTINGS_SCHEMA_INVALID');
    expect(String(refused.json?.message)).toContain('at least 10');
    expect((await post(`${url}/api/login`, { email: 'pol@b.co', password: OLD })).status).toBe(200);
  });

  it('does not echo a reset_token and does not write account.password_reset', async () => {
    const url = await saas();
    const { token, id } = await register(url, 'noecho@b.co');
    const r = await post(
      `${url}/api/account/password`,
      { current_password: OLD, new_password: NEXT },
      bearer(token),
    );
    expect(r.status).toBe(200);
    expect(r.json).not.toHaveProperty('reset_token');
    expect(server!.db.settings.read(id, 'account.password_reset')).toBeNull();
  });
});
