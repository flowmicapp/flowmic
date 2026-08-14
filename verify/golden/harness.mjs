// verify/golden/harness.mjs — the ONE set of wire helpers every golden path uses.
//
// Split out of run-golden.mjs on 2026-07-31 (card G) for a boring reason with a
// sharp edge: run-golden.mjs stood at 797 of its 800-line cap (verify/lint/
// file-size.mjs, SRC_MAX), so the only two ways to add a path were (a) this
// split, or (b) a second copy of `connect` / `ack` / `once` inside the new file.
// (b) is this repo's #1 bug shape aimed at its own harness — two answers to
// "how to connect", and the copy nobody updates is always the one running when it
// matters. So: one definition, here, imported by both.
//
// Nothing below changed behaviour in the move. `recordAll` is the one addition
// and it is new code, not a moved helper (see its own comment for why a golden
// path needed something `neverWithin` cannot express).

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { connect as netConnect } from 'node:net';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const SERVER_CORE = path.join(ROOT, 'apps', 'server-core');
export const SERVER_DIST = path.join(SERVER_CORE, 'dist', 'index.js');

// socket.io-client resolves inside server-core (it is a devDependency there).
const scRequire = createRequire(path.join(SERVER_CORE, 'package.json'));
const { io: ioClient } = scRequire('socket.io-client');

// ── LAN engine reference endpoints (06 §7 presets; owner-network only) ──
export const LAN = {
  funasr: { host: '100.64.7.68', port: 10095, label: 'funasr (preset lan-funasr-ws)' },
  vllm: { host: '100.64.7.179', port: 8000, label: 'vLLM (preset lan-vllm-qwen35)' },
};

export function reachable({ host, port }, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = netConnect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(null));
    s.once('timeout', () => done('timeout'));
    s.once('error', (e) => done(e.code || e.message));
  });
}

// ── product deadlines, READ FROM THE PRODUCT'S OWN SOURCE ───────────────────
//
// Why this exists (2026-08-07). G2/G3/G10 each waited a hard-coded 2500ms for
// the terminal frame an unreachable engine produces, and CI (GitHub
// windows-latest, where NO LAN engine is reachable) reported all three as
// "silent failure" — G2 "drew NEITHER compose:done nor compose:error", G3
// "no terminal frame at all", G10 "the MOBILE was told nothing".
//
// Measured on dev-pc-a against an endpoint that ACCEPTS the TCP
// connection and then never answers (loopback, so this machine's TUN proxy is
// out of the picture), the server is not silent at all. It answers, on time, by
// its OWN clock:
//   compose:start → compose:error{LLM_TIMEOUT}      at 30_011ms  (cap 30_000)
//   audio:start   → stt:error{STT_NETWORK_DROP}     at  5_007ms  (cap  5_000)
// The window was simply shorter than the deadline the product promises — for
// G10, literally HALF of it (2500 vs 5000). Nothing was being swallowed; the
// test had stopped listening before the product had promised to speak.
//
// 🔴 So the number is no longer written here. It is READ from the constant the
// product actually obeys, and a re-tune or a rename moves the golden window with
// it. A literal copied into this file would be a second answer to "how long counts as a timeout",
// and the copy nobody updates is always the one running when it matters — this
// file's own header says exactly that about `connect`/`ack`/`once`.
//
// A miss THROWS. It must never fall back to a default: a golden window that
// quietly reverted to some safe-looking number is the same silent failure this
// helper exists to stop measuring wrong.
export function productDeadlineMs(relFile, name) {
  const abs = path.join(SERVER_CORE, relFile);
  const src = readFileSync(abs, 'utf8');
  // `30_000` and `5_000` both appear with numeric separators in the product.
  // The trailing `;` is load-bearing: without it, a constant later rewritten as
  // an expression (`= 30_000 * 2;`) would match its FIRST literal and hand back a
  // silently-too-short window — this defect, returning by the same door, in the
  // one helper that exists to close it. Anchored, that case throws instead.
  const m = new RegExp(`export const ${name}\\s*(?::\\s*number\\s*)?=\\s*([0-9_]+)\\s*;`).exec(src);
  if (!m) throw new Error(`harness: ${name} not found in ${relFile} — the golden window has lost its source of truth`);
  const ms = Number(m[1].replace(/_/g, ''));
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`harness: ${name} in ${relFile} parsed as '${m[1]}'`);
  return ms;
}

// Slack on top of the product's own deadline: socket delivery + timer
// scheduling, nothing more. Deliberately small — it is a margin on a measured
// bound, not a second budget. Measured overshoot above was 11ms and 7ms.
export const TERMINAL_FRAME_GRACE_MS = 2_000;

/** How long a golden path may wait for a terminal frame whose deadline the
 *  product declares in `relFile`'s `name`. Costs nothing on the happy path: the
 *  races below settle the moment the frame lands. */
export function terminalFrameWindowMs(relFile, name) {
  return productDeadlineMs(relFile, name) + TERMINAL_FRAME_GRACE_MS;
}

// ── real-server client helpers ──
export function connect(url, auth = {}) {
  const socket = ioClient(url, { transports: ['websocket'], auth, forceNew: true, reconnection: false });
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 3000);
  });
}
export function ack(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} ack timeout`)), 3000);
    socket.emit(event, payload, (r) => { clearTimeout(t); resolve(r); });
  });
}
export function once(socket, event, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} timeout`)), ms);
    socket.once(event, (d) => { clearTimeout(t); resolve(d); });
  });
}
export function neverWithin(socket, event, ms) {
  return new Promise((resolve) => {
    let fired = false;
    const h = () => { fired = true; };
    socket.once(event, h);
    setTimeout(() => { socket.off(event, h); resolve(!fired); }, ms);
  });
}

/** Record EVERY frame this socket receives, under ANY event name, from now on.
 *
 *  WHY THIS EXISTS (card G, 2026-07-31). A no-crosstalk assertion written as
 *  `neverWithin(pcB, 'inject:request', ms)` proves that ONE event name did not
 *  arrive at PC-B. The red line owner stated is "not one character may reach that computer" — so an
 *  implementation that refuses `inject:request` and then mirrors the same
 *  sentence out under some OTHER name would satisfy the narrow check and break
 *  the rule. The assertion therefore has to be written against the FRAMES rather
 *  than against a name: "nothing carrying this text reached that socket, whatever
 *  it was called".
 *
 *  `carrying(needle)` is a substring probe over the serialized frame (event name
 *  + args), which is why every caller uses a UNIQUE per-send marker string: a
 *  generic needle would match an unrelated frame and the negative would be
 *  quietly weaker than it reads.
 *
 *  ⚠️ A negative assertion is only worth what its probe can see. Every caller
 *  pairs `carrying()` on the wrong destination with the SAME `carrying()` on the
 *  right one — if the probe cannot see the frame that DID arrive, the silence it
 *  reports about the other socket means nothing.
 */
export function recordAll(socket) {
  const frames = [];
  const listener = (event, ...args) => frames.push({ event, args });
  socket.onAny(listener);
  return {
    frames,
    /** Frames whose event name or payload mentions `needle`. */
    carrying: (needle) => frames.filter((f) => {
      try {
        return JSON.stringify(f).includes(needle);
      } catch {
        // A frame that will not serialize cannot be cleared as "does not carry
        // it" — count it, so an unreadable frame FAILS loud instead of passing.
        return true;
      }
    }),
    stop: () => socket.offAny(listener),
  };
}

export async function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, shell: process.platform === 'win32', env: { ...process.env, ...opts.env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
    child.on('error', (e) => resolve({ code: -1, out: String(e) }));
  });
}

export function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: SERVER_CORE,
      env: { ...process.env, FLOWMIC_MODE: 'standalone', FLOWMIC_PORT: '0', FLOWMIC_SETTINGS_SECRET: 'golden-secret-32-bytes-minimum-xxx' },
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /^(\d+)/.exec(out.trim());
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
    setTimeout(() => reject(new Error('server start timeout')), 8000);
  });
}

// G9 (WP-R4-1): a dedicated saas instance — cloud-instance admission needs the
// account layer (REST + JWT handshake) that standalone does not mount. Hermetic:
// mock billing on, loopback bind, no LAN. FLOWMIC_JWT_SECRET is a throwaway.
//
// `extraEnv` (card D1-E, 2026-08-01) is merged LAST, so a caller can add to — or
// override — any of the defaults below. G17 needs a paddle-enabled instance
// (three env vars this default set knows nothing about) on a FILE database
// rather than `:memory:`, because two of the things it has to do have no HTTP
// surface at all: marking an account `permanent_free` and letting a billing
// period fall into the past. The alternative was a second `startSaasServer`
// copy, which is precisely the duplication this file's header exists to refuse:
// one definition of "how a saas instance is started", or the copy nobody
// updates is the one running when it matters.
export function startSaasServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: SERVER_CORE,
      env: {
        ...process.env,
        FLOWMIC_MODE: 'saas',
        FLOWMIC_PORT: '0',
        // GA-15: saas refuses to start without an explicit database path (a
        // production server silently on :memory: is how W2 lost real users).
        // A hermetic golden run WANTS ephemeral, so it says so out loud.
        FLOWMIC_DB_PATH: ':memory:',
        FLOWMIC_JWT_SECRET: 'golden-saas-secret-32-bytes-minimum-xx',
        // 🔴 card M5 (0.3.0) —— **this deliberately no longer sets `FLOWMIC_MOCK_BILLING`.**
        //
        // It used to be unconditionally set to '1'. M5 made saas mode **hard-refuse mock billing at mount time**
        // (`http/router.ts` `assertMockBillingMountable`) — the reason is that mock gateway
        // can grant pro with no payment and can also push the global billing clock, and its only geographic gate
        // `isLocalRequest` is a no-op behind nginx; **this combination was actually exposed in production once**
        // (turned off 2026-07-31). ⇒ saas + mock went from "held back by an env boolean" to "structurally impossible".
        //
        // The consequence is this line: the moment the guard landed, **8 of 20 golden paths immediately became
        // `saas server exited early (1)`** — a security-shaped refusal colliding with the only
        // fixture that actually starts a saas server, and that fixture was never in the changing party's field of view.
        // This repo's written rule is blunt: **"a gate that is already red on day one will be ignored by everyone on day two, which is the same as not adding it"**
        // (the original wording from when clippy was wired in at 0.2.24) ⇒ fix the fixture, do not loosen the guard.
        //
        // ⚠️ Cases that need the mock billing surface should use standalone (that path M5 deliberately kept),
        // or an explicit `extraEnv` — but passing it explicitly on saas will now be **loudly refused at startup by the server**,
        // and that is exactly the failure direction we want.
        //
        // 🔴 card fix-010 (0.3.0, 2026-08-10) —— **the same thing, the same function, the second time.**
        //
        // saas now also requires an **explicit declaration of proxy posture** (`config.ts`, standing alongside those two: JWT secret / DB path).
        // Reason: without a declaration `clientIpFrom` falls back to the direct peer, and behind nginx
        // every request's direct peer is `127.0.0.1` ⇒ **every per-IP rate limiter for register/login/password-reset/pairing
        // shares the same bucket**, and about 6 requests can lock the whole site's register/login for 10 minutes.
        // What it refuses is **silence**, not an empty list: `[]` is an answer; "nobody said anything" is not.
        //
        // ⇒ this line is that gate's answer on the fixture side. **What it declares is "there is no proxy in front of this fixture"** —
        // for a server that golden dials directly, that is **the truth**, not a waiver: it is not behind nginx,
        // its direct peer IS the client.
        // ⚠️ A downstream fact follows: once 127.0.0.1 is trusted, a golden request that carries
        // `X-Forwarded-For` is attributed to that hop, and `isLocalRequest`
        // judges "loopback + XFF" as non-local. No golden sends that way today; anyone who will, read this sentence first.
        //
        // 🔴 **What this line really has to carry forward is that "second time" above**: M5 was mock billing's mount-time
        // hard refuse; this time it is proxy posture's start-time hard refuse — **both times a correctly security-shaped refusal
        // colliding with the only fixture that actually starts a saas server, and that fixture was never in the changing party's field of view.**
        // ⇒ rule: **whenever you add a "startup must satisfy X" guard to saas, the same round must
        // grep `startSaasServer` and fill in X here.** This is not a reminder — both times it was
        // discovered by an executor running the full suite on a different card, not by the card that added the guard.
        FLOWMIC_TRUSTED_PROXIES: '127.0.0.1,::1',
        ...extraEnv,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /^(\d+)/.exec(out.trim());
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.on('exit', (code) => reject(new Error(`saas server exited early (${code})`)));
    setTimeout(() => reject(new Error('saas server start timeout')), 8000);
  });
}

export const PASS = (note) => ({ status: 'PASS', reason: note });
export const SKIP = (reason) => ({ status: 'SKIPPED', reason });
export const FAIL = (reason) => ({ status: 'FAIL', reason });

export async function registerAndPair(url) {
  const pc = await connect(url);
  const reg = await ack(pc, 'pc:register', { device_name: 'Golden PC', client_instance_id: 'inst-golden0123456789' });
  const mobile = await connect(url);
  const joinedP = once(pc, 'pc:mobile-joined');
  const pair = await ack(mobile, 'mobile:pair', { short_code: reg.short_code });
  await joinedP;
  return { pc, mobile, reg, pair };
}

/** register+login on a fresh saas instance → the handshake JWT the desktop's
 *  cloud channel carries (Cloud Key). Split out here (card B4-2) rather than left
 *  as a second copy inside g13-no-crosstalk.mjs — this file's own header
 *  explains why a second `connect`/`ack`/`once` would be this repo's #1 bug
 *  shape aimed at its own harness, and a second `saasJwt` is the same shape. */
/** VERIFY-1 (2026-08-11) — pass the console email-verification gate for a
 *  freshly registered account, through the REAL routes.
 *
 *  Requires the server to run with `FLOWMIC_INTERNAL_VERIFICATION_CODE_ECHO=1`
 *  (the M1 reset-token-echo precedent, extended to this feature for exactly
 *  this harness: a spawned dist server has no mail channel and no reachable DB
 *  handle, so the echo is the only way a golden can learn the code). ONE
 *  definition here rather than per golden — this file's own header says what a
 *  second copy of a wire helper becomes.
 *
 *  Throws (rather than returning a verdict) so a caller's FAIL carries the
 *  step that actually broke. */
export async function verifyRegisteredEmail(url, jwt) {
  const post = (p, body) => fetch(`${url}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  const send = await post('/api/auth/email-verification/send', {});
  if (send.status !== 200) throw new Error(`email-verification send status ${send.status}`);
  const { code } = await send.json();
  if (typeof code !== 'string') {
    throw new Error('email-verification send echoed no code — is FLOWMIC_INTERNAL_VERIFICATION_CODE_ECHO=1 on this server?');
  }
  const confirm = await post('/api/auth/email-verification/confirm', { code });
  if (confirm.status !== 200) throw new Error(`email-verification confirm status ${confirm.status}`);
}

/** @param email 0.2.66 — WHICH account. Defaulted to the historical constant so
 *  every existing caller is byte-identical; G21 passes two DIFFERENT addresses
 *  because it needs two TENANTS on one relay at once, and a shared address would
 *  quietly make them one account — which is precisely the situation the PCID
 *  feature is about, so it must not be faked by a fixture. */
export async function saasJwt(url, email = 'g-saas-jwt@flowmic.test') {
  const post = (p, body) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const reg = await post('/api/register', { email, password: 'longenough1', display_name: 'G-saas' });
  if (reg.status !== 201) throw new Error(`/api/register status ${reg.status}`);
  const login = await post('/api/login', { email, password: 'longenough1' });
  if (login.status !== 200) throw new Error(`/api/login status ${login.status}`);
  const jwt = (await login.json()).token;
  if (typeof jwt !== 'string' || jwt.length === 0) throw new Error('login returned no token');
  return jwt;
}
