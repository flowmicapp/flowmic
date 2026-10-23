// Card E-M (docs/rebuild/18 §2.6) — the REAL server half of
// test/auth_expiry_real_server_test.dart (D-23: the behaviour under test lives
// in the response body, so the body must come from the product, not a double).
//
// Starts a real saas server-core through the golden harness (`:memory:` DB,
// the harness's own throwaway secret), registers a real account, and mints two
// more tokens in the server's own shape (auth/jwt.ts: the real token's header
// segment, {sub, plan, iat, exp}, HS256 over the same secret): one already
// expired, one still live. The live re-signed one is the control that proves a
// self-signed token is accepted at all, so a 401 on the expired one is about
// `exp` and nothing else (the same control the design's probe used, §1).
//
// Prints ONE JSON line {base, valid, resigned, expired} and stays up until its
// stdin closes; the Dart side kills it by PID in tearDownAll.

import crypto from 'node:crypto';
import { startSaasServer, saasJwt } from '../../../../verify/golden/harness.mjs';

const SECRET = 'golden-saas-secret-32-bytes-minimum-xx'; // = harness FLOWMIC_JWT_SECRET

const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

const { child, port } = await startSaasServer();
const base = `http://127.0.0.1:${port}`;
const valid = await saasJwt(base, 'e-m-expiry@flowmic.test');
const [headerB64, payloadB64] = valid.split('.');
const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
const now = Math.floor(Date.now() / 1000);
const sign = (iat, exp) => {
  const p = b64url(JSON.stringify({ sub: claims.sub, plan: claims.plan, iat, exp }));
  const input = `${headerB64}.${p}`;
  return `${input}.${b64url(crypto.createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(input).digest())}`;
};
const expired = sign(now - 7200, now - 3600);
const resigned = sign(now - 60, now + 3600);

process.stdout.write(`${JSON.stringify({ base, valid, resigned, expired })}\n`);

const stop = () => {
  try { child.kill(); } catch { /* already gone */ }
  process.exit(0);
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.on('SIGTERM', stop);
process.stdin.resume();
