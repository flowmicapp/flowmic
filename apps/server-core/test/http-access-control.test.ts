// RV-32 / D10 — WHO IS ALLOWED TO CALL THE STANDALONE HTTP SURFACE.
//
// standalone binds every interface (a phone with no token has to be able to
// pair), so 「mounted standalone-only」 was never 「reachable by the owner only」.
// These tests pin the routes' access decisions in BOTH directions, because a
// test that only proves the allowed caller still works proves nothing about a
// gate — it passes just as happily when there is no gate at all.
//
// Every case here is 「the same request from two different peers」: same url, same
// body, only remoteAddress differs.

import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { makeHttpHandler, MOCK_BILLING_IN_SAAS_ERROR } from '../src/http/router';
import { makeResolveUserId, type AccountVerifier } from '../src/http/account-auth';
import { MAX_DIAG_BYTES } from '../src/http/diag-routes';
import { isLoopbackAddress, LOCAL_ONLY_ERROR } from '../src/http/local-only';
import type { Registry } from '../src/room/registry';

const LAN_PEER = '10.0.0.44';

function request(method: string, url: string, peer: string, body?: string): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')]);
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  (req as { headers: Record<string, string> }).headers = {};
  (req as { socket: { remoteAddress: string } }).socket = { remoteAddress: peer };
  return req;
}

function response(): { res: ServerResponse; done: Promise<{ status: number; body: Record<string, unknown> }> } {
  let settle: (v: { status: number; body: Record<string, unknown> }) => void;
  const done = new Promise<{ status: number; body: Record<string, unknown> }>((r) => (settle = r));
  let status = 0;
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(payload?: string) {
      settle({ status, body: payload ? (JSON.parse(payload) as Record<string, unknown>) : {} });
    },
    once() {
      return res;
    },
  } as unknown as ServerResponse;
  return { res, done };
}

function billingSpy(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    getPlan: vi.fn(() => ({ tier: 'free' })),
    getQuota: vi.fn(() => ({ stt: { limit_min: 60 } })),
    effectivePlan: vi.fn(() => 'free'),
    advanceClock: vi.fn(),
    mockCheckout: vi.fn(() => ({})),
    mockConfirm: vi.fn(() => ({})),
    mockCancel: vi.fn(() => ({})),
    mockRenew: vi.fn(() => ({})),
    mockExpire: vi.fn(() => ({})),
  };
}

interface HandlerOpts {
  mode?: 'standalone' | 'saas';
  mockBilling?: boolean;
  billing?: Record<string, ReturnType<typeof vi.fn>>;
  scriptPath?: string;
  probe?: Parameters<typeof makeHttpHandler>[0]['probe'];
  diag?: Parameters<typeof makeHttpHandler>[0]['diag'];
  /** D6: the pairing registry the diag route judges its Bearer against. ONE dep,
   *  wired by bootstrap in both modes — not borrowed from `inject`/`presence`. */
  pairing?: Parameters<typeof makeHttpHandler>[0]['pairing'];
  presence?: Parameters<typeof makeHttpHandler>[0]['presence'];
  /** D3: the health DB probe seam. */
  dbProbe?: () => void;
  /** saas only: the account verifier the Bearer is judged against. The saas cases
   *  in THIS file are about /api/health and /api/network (no identity involved),
   *  so they get one that knows nobody — the identity surface itself is pinned in
   *  http-user-identity.test.ts. */
  account?: AccountVerifier;
}

/** An account layer with no accounts in it: every token is refused. */
const NO_ACCOUNTS: AccountVerifier = {
  verifyToken: () => ({ ok: false, error: 'AUTH_TOKEN_INVALID' }),
  getUser: () => null,
};

/** The router under test, with a 404 fallback exactly like bootstrap's. */
function handlerFor(opts: HandlerOpts = {}): (req: IncomingMessage, res: ServerResponse) => boolean {
  const mode = opts.mode ?? 'standalone';
  return makeHttpHandler({
    config: {
      mode,
      port: 41879,
      // M5: saas + mock billing refuses to MOUNT (assertMockBillingMountable
      // throws), so a blanket `?? true` here would kill every saas case in this
      // file at construction. The default keeps standalone's historical `true`
      // and gives saas the only value it can mount with; the M5 describe below
      // passes `true` explicitly to pin the refusal itself.
      mockBilling: opts.mockBilling ?? mode === 'standalone',
    } as never,
    billing: (opts.billing ?? billingSpy()) as never,
    version: '0.2.23',
    // The REAL resolver, wired the way bootstrap wires it.
    resolveUserId: makeResolveUserId({
      mode,
      standaloneUserId: 'default',
      ...(mode === 'saas' ? { account: opts.account ?? NO_ACCOUNTS } : {}),
    }),
    scriptPath: opts.scriptPath ?? 'C:\\Users\\owner\\AppData\\Local\\FlowMic\\resources\\server.js',
    ...(opts.probe ? { probe: opts.probe } : {}),
    ...(opts.diag ? { diag: opts.diag } : {}),
    ...(opts.pairing ? { pairing: opts.pairing } : {}),
    ...(opts.presence ? { presence: opts.presence } : {}),
    ...(opts.dbProbe ? { dbProbe: opts.dbProbe } : {}),
  });
}

function call(
  handler: (req: IncomingMessage, res: ServerResponse) => boolean,
  method: string,
  url: string,
  peer: string,
  body?: string,
): { handled: boolean; done: Promise<{ status: number; body: Record<string, unknown> }> } {
  const { res, done } = response();
  const handled = handler(request(method, url, peer, body), res);
  return { handled, done };
}

// ── the predicate itself ─────────────────────────────────────────────────────

describe('isLoopbackAddress — what counts as 「this machine」', () => {
  it('accepts every shape Node actually hands back for a local peer', () => {
    for (const a of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackAddress(a), a).toBe(true);
    }
  });

  it('rejects LAN, public and UNKNOWN peers — a gate that opens when it cannot tell is not a gate', () => {
    for (const a of ['10.0.0.44', '100.64.7.78', '10.8.0.2', '93.184.216.34', '::ffff:192.168.1.9', '']) {
      expect(isLoopbackAddress(a), a || '(empty)').toBe(false);
    }
  });
});

// ── /api/probe/* — the SSRF pivot (RV-32 head defect) ────────────────────────

describe('POST /api/probe/* — only this machine may make the server dial', () => {
  /** A probe dep bag whose every dialer is a spy: if the route ever gets past the
   *  gate, one of these fires and the test can see it. */
  function probeSpies(): { deps: NonNullable<HandlerOpts['probe']>; streamerFor: ReturnType<typeof vi.fn>; engineFactory: ReturnType<typeof vi.fn> } {
    const streamerFor = vi.fn(() => async function* (): AsyncGenerator<never> {});
    const engineFactory = vi.fn(() => {
      throw new Error('engine must never be constructed for a refused probe');
    });
    return {
      deps: { llm: { streamerFor: streamerFor as never }, stt: { engineFactory: engineFactory as never } },
      streamerFor,
      engineFactory,
    };
  }

  const LLM_BODY = JSON.stringify({ protocol: 'openai-compatible', endpoint: 'http://100.64.7.1:22/v1', api_key: '', model: 'm' });

  it('LAN peer: refused 403 LOCAL_ONLY — and NOTHING was dialed', async () => {
    const p = probeSpies();
    const h = handlerFor({ probe: p.deps });
    const { handled, done } = call(h, 'POST', '/api/probe/llm', LAN_PEER, LLM_BODY);
    expect(handled, 'the route must own the request so it can refuse it out loud').toBe(true);
    const out = await done;
    expect(out.status).toBe(403);
    expect(out.body.error).toBe(LOCAL_ONLY_ERROR);
    expect(typeof out.body.message).toBe('string');
    // The whole point: no outbound connection was attempted on the caller's behalf.
    expect(p.streamerFor, 'a refused probe must not reach the LLM transport').not.toHaveBeenCalled();
    expect(p.engineFactory, 'a refused probe must not construct an STT engine').not.toHaveBeenCalled();
  });

  it('LAN peer: /api/probe/stt is refused the same way', async () => {
    const p = probeSpies();
    const h = handlerFor({ probe: p.deps });
    const { done } = call(h, 'POST', '/api/probe/stt', LAN_PEER, JSON.stringify({ routing: { language: 'zh-CN', engine_id: 'funasr', endpoint: 'ws://100.64.7.9:10095' } }));
    expect((await done).body.error).toBe(LOCAL_ONLY_ERROR);
    expect(p.engineFactory).not.toHaveBeenCalled();
  });

  it('LAN peer: not even a CORS preflight succeeds (a 204 would promise a POST that will be refused)', async () => {
    const h = handlerFor({ probe: probeSpies().deps });
    const { done } = call(h, 'OPTIONS', '/api/probe/llm', LAN_PEER);
    const out = await done;
    expect(out.status).toBe(403);
    expect(out.body.error).toBe(LOCAL_ONLY_ERROR);
  });

  it('loopback peer: the probe runs exactly as before (the desktop dials 127.0.0.1)', async () => {
    const p = probeSpies();
    const h = handlerFor({ probe: p.deps });
    const { done } = call(h, 'POST', '/api/probe/llm', '127.0.0.1', LLM_BODY);
    const out = await done;
    expect(out.status).toBe(200);
    expect(p.streamerFor, 'the allowed caller still reaches the transport').toHaveBeenCalled();
  });
});

// ── /api/network — the NIC inventory ─────────────────────────────────────────

describe('GET /api/network — the desktop asking ITSELF which addresses it has', () => {
  it('LAN peer: refused 403 LOCAL_ONLY, and no address list in the body', async () => {
    const { done } = call(handlerFor(), 'GET', '/api/network', LAN_PEER);
    const out = await done;
    expect(out.status).toBe(403);
    expect(out.body.error).toBe(LOCAL_ONLY_ERROR);
    expect(out.body.lan_ipv4).toBeUndefined();
    expect(out.body.candidates).toBeUndefined();
  });

  it('loopback peer: the full candidate list, unchanged (owner: list every listening IP)', async () => {
    const { done } = call(handlerFor(), 'GET', '/api/network', '127.0.0.1');
    const out = await done;
    expect(out.status).toBe(200);
    expect(Array.isArray(out.body.lan_ipv4)).toBe(true);
    expect(Array.isArray(out.body.candidates)).toBe(true);
    expect(out.body.port).toBe(41879);
  });

  it('saas: not mounted at all (09 §「standalone-only」) — the handler declines it', () => {
    // Even from loopback, because behind nginx every public request IS loopback.
    const { handled } = call(handlerFor({ mode: 'saas' }), 'GET', '/api/network', '127.0.0.1');
    expect(handled, 'declining → bootstrap answers 404, the same as auth/console/probe in the wrong mode').toBe(false);
  });
});

// ── /api/health — public by necessity, minus the one field that leaks ────────

describe('GET /api/health — reachable by an unpaired phone, without publishing the install path', () => {
  const SCRIPT = 'C:\\Users\\owner\\AppData\\Local\\FlowMic\\resources\\server.js';

  it('loopback + standalone: the exact script path (the adopt probe compares it verbatim)', async () => {
    const { done } = call(handlerFor({ scriptPath: SCRIPT }), 'GET', '/api/health', '127.0.0.1');
    const out = await done;
    expect(out.status).toBe(200);
    expect(out.body.script).toBe(SCRIPT);
  });

  it('LAN peer: still 200 and still answers the pairing questions — pairing must not break', async () => {
    const { done } = call(handlerFor({ scriptPath: SCRIPT }), 'GET', '/api/health', LAN_PEER);
    const out = await done;
    expect(out.status).toBe(200);
    // instance_probe.dart reads ok + mode; the console reads version.
    expect(out.body).toMatchObject({ ok: true, mode: 'standalone', port: 41879, version: '0.2.23' });
  });

  it('LAN peer: `script` is present but null — withheld, never a plausible wrong answer', async () => {
    const { done } = call(handlerFor({ scriptPath: SCRIPT }), 'GET', '/api/health', LAN_PEER);
    const out = await done;
    expect('script' in out.body, 'the field is never removed — an absent one reads as 「old build」').toBe(true);
    expect(out.body.script).toBeNull();
    // Not the basename either: every build's is `server.js`, so it would answer
    // 「same build」 for two different builds.
    expect(JSON.stringify(out.body)).not.toContain('server.js');
    expect(JSON.stringify(out.body)).not.toContain('owner');
  });

  it('saas: withheld even on loopback (nginx makes every public request look local)', async () => {
    const { done } = call(handlerFor({ mode: 'saas', scriptPath: SCRIPT }), 'GET', '/api/health', '127.0.0.1');
    const out = await done;
    expect(out.body.script).toBeNull();
    expect(out.body).toMatchObject({ ok: true, mode: 'saas', version: '0.2.23' });
  });

  // ── D3 — health answers about the DATABASE, not just about the socket ──────
  //
  // /api/health used to be an unconditional `{ok:true}`: a full disk or a dead
  // SQLite handle still reported healthy to the desktop supervisor and the
  // phone's instance list. The probe is a dep (bootstrap wires `SELECT 1` over
  // the real handle); the response stays ADDITIVE — every pre-D3 key survives
  // in every branch, because the desktop adopt probe greps `"ok":true`, the
  // phone reads `ok`+`mode`, and cloud-chain reads `version`.

  it('D3: no probe wired ⇒ the pre-D3 shape byte-for-byte — no db key, never a guessed 「ok」', async () => {
    const { done } = call(handlerFor(), 'GET', '/api/health', LAN_PEER);
    const out = await done;
    expect(out.status).toBe(200);
    expect('db' in out.body, 'a measurement that never ran must vanish, not read as healthy').toBe(false);
  });

  it('D3: probe passes ⇒ 200 with db:"ok", existing keys untouched', async () => {
    const probe = vi.fn();
    const { done } = call(handlerFor({ dbProbe: probe }), 'GET', '/api/health', LAN_PEER);
    const out = await done;
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, mode: 'standalone', port: 41879, version: '0.2.23', db: 'ok' });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('D3 reverse control: a FAILING db probe ⇒ 503 + ok:false + db:"error" — and version/mode survive', async () => {
    const { done } = call(
      handlerFor({ dbProbe: () => { throw new Error('SQLITE_IOERR: disk I/O error'); } }),
      'GET', '/api/health', LAN_PEER,
    );
    const out = await done;
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ ok: false, db: 'error', mode: 'standalone', version: '0.2.23' });
    // The desktop adopt probe greps for the LITERAL `"ok":true` — an unhealthy
    // body must not contain it anywhere.
    expect(JSON.stringify(out.body)).not.toContain('"ok":true');
  });
});

// ── /api/billing/* — the mock gateway MUTATES ────────────────────────────────

describe('/api/billing/* — a LAN caller cannot move the owner\'s plan or clock', () => {
  it('LAN peer: read is refused by name, and billing is never consulted', async () => {
    const billing = billingSpy();
    const { done } = call(handlerFor({ billing }), 'GET', '/api/billing/quota', LAN_PEER);
    const out = await done;
    expect(out.status).toBe(403);
    expect(out.body.error).toBe(LOCAL_ONLY_ERROR);
    expect(billing.getQuota).not.toHaveBeenCalled();
  });

  it('LAN peer: advance-clock is refused and the clock does not move', async () => {
    const billing = billingSpy();
    const { done } = call(handlerFor({ billing }), 'POST', '/api/billing/advance-clock', LAN_PEER, JSON.stringify({ offsetMs: 999_000 }));
    expect((await done).status).toBe(403);
    expect(billing.advanceClock, 'the mock clock is process-wide state').not.toHaveBeenCalled();
  });

  it('LAN peer: cancel/expire are refused before the state machine is touched', async () => {
    const billing = billingSpy();
    const h = handlerFor({ billing });
    for (const path of ['/api/billing/cancel', '/api/billing/expire', '/api/billing/checkout']) {
      const { done } = call(h, 'POST', path, LAN_PEER, JSON.stringify({ cycle: 'monthly' }));
      expect((await done).body.error, path).toBe(LOCAL_ONLY_ERROR);
    }
    expect(billing.mockCancel).not.toHaveBeenCalled();
    expect(billing.mockExpire).not.toHaveBeenCalled();
    expect(billing.mockCheckout).not.toHaveBeenCalled();
  });

  it('LAN peer: the refusal does not disclose whether the mock gateway is even enabled', async () => {
    const off = call(handlerFor({ mockBilling: false }), 'GET', '/api/billing/quota', LAN_PEER);
    const on = call(handlerFor({ mockBilling: true }), 'GET', '/api/billing/quota', LAN_PEER);
    expect(await off.done).toEqual(await on.done);
  });

  it('loopback peer: the gateway answers exactly as before (golden G9 dials it over loopback)', async () => {
    const billing = billingSpy();
    const { done } = call(handlerFor({ billing }), 'GET', '/api/billing/quota', '127.0.0.1');
    const out = await done;
    expect(out.status).toBe(200);
    expect(billing.getQuota).toHaveBeenCalledWith('default');
  });
});

// ── M5 — saas + mock billing is structurally impossible, not merely gated ────
//
// The 2026-07-31 production exposure: FLOWMIC_MOCK_BILLING=1 on the VPS meant
// any self-registered Bearer could grant itself pro (`mockConfirm`) and move
// the process-wide billing clock. The only request-time guard, isLocalRequest,
// is a no-op behind nginx (every public caller looks loopback). The fix is a
// MOUNT-time refusal: the combination cannot serve a single request.
describe('M5 — saas refuses to MOUNT with the mock billing gateway enabled', () => {
  it('saas + flag ⇒ makeHttpHandler throws the named error before any request can be served', () => {
    expect(() => handlerFor({ mode: 'saas', mockBilling: true }))
      .toThrow(new RegExp(MOCK_BILLING_IN_SAAS_ERROR));
  });

  it('saas without the flag still mounts, and a VERIFIED caller gets the honest 404 (unchanged)', async () => {
    const account: AccountVerifier = {
      verifyToken: () => ({ ok: true, sub: 'u-9' }) as never,
      getUser: () => ({ id: 'u-9' }) as never,
    };
    const h = handlerFor({ mode: 'saas', mockBilling: false, account });
    const { res, done } = response();
    const req = request('GET', '/api/billing/quota', '127.0.0.1');
    (req as { headers: Record<string, string> }).headers = { authorization: 'Bearer any-verified' };
    expect(h(req, res)).toBe(true);
    const out = await done;
    expect(out.status).toBe(404);
    expect(String(out.body.message)).toContain('mock billing gateway disabled');
  });

  it('standalone + flag: the dev mock keeps working — deleting it is owner-gated, not this card', async () => {
    const billing = billingSpy();
    const { done } = call(handlerFor({ mode: 'standalone', mockBilling: true, billing }), 'GET', '/api/billing/quota', '127.0.0.1');
    expect((await done).status).toBe(200);
    expect(billing.getQuota).toHaveBeenCalledWith('default');
  });
});

// ── /api/diag/mobile — RV-13 provenance + rate window, wired through the router ─

describe('POST /api/diag/mobile — the forensic log records WHO wrote each block', () => {
  const registry = {
    reconnectMobile: (token: string) =>
      token === 'good-token' ? { mobile: { id: 'pair-1', user_id: 'u' }, pc: { id: 'pc-1', user_id: 'u', room_uuid: 'r' } } : null,
  } as unknown as Registry;

  function post(h: ReturnType<typeof handlerFor>, peer: string, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const { res, done } = response();
    const req = request('POST', '/api/diag/mobile', peer, JSON.stringify({ device: 'HUAWEI PLA-AL10', lines: ['edge: connected'] }));
    if (token !== undefined) (req as { headers: Record<string, string> }).headers = { authorization: `Bearer ${token}` };
    expect(h(req, res)).toBe(true);
    return done;
  }

  it('WITH a live pairing token: marked as the phone (and the router really does thread the registry)', async () => {
    const append = vi.fn();
    const h = handlerFor({ diag: { logPath: 'C:/tmp/server.log', append }, pairing: registry });
    const out = await post(h, LAN_PEER, 'good-token');
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, lines: 1, authenticated: true });
    const text = append.mock.calls[0]![1] as string;
    expect(text).toContain('origin=pairing:pair-1');
    expect(text).toContain('[phone] edge: connected');
  });

  it('WITHOUT a token: accepted (the phone cannot send one yet) but marked UNVERIFIED, never as the phone', async () => {
    const append = vi.fn();
    const h = handlerFor({ diag: { logPath: 'C:/tmp/server.log', append }, pairing: registry });
    const out = await post(h, LAN_PEER);
    expect(out.status).toBe(200);
    expect(out.body.authenticated, 'the response says which of the two it was judged to be').toBe(false);
    const text = append.mock.calls[0]![1] as string;
    expect(text).toContain(`origin=UNVERIFIED peer=${LAN_PEER}`);
    expect(text).toContain('[phone-unverified] edge: connected');
    expect(text, 'a line an anonymous caller wrote must never carry the trusted marker').not.toContain('[phone] ');
  });

  it('with a token no pairing owns: judged exactly like no token at all', async () => {
    const append = vi.fn();
    const h = handlerFor({ diag: { logPath: 'C:/tmp/server.log', append }, pairing: registry });
    const out = await post(h, LAN_PEER, 'stolen-or-revoked');
    expect(out.body.authenticated).toBe(false);
    expect(append.mock.calls[0]![1] as string).toContain('origin=UNVERIFIED');
  });

  it('the rate window is ONE per server, not one per request (a per-request limiter limits nothing)', async () => {
    const append = vi.fn();
    const h = handlerFor({ diag: { logPath: 'C:/tmp/server.log', append }, pairing: registry });
    for (let i = 0; i < 10; i += 1) expect((await post(h, LAN_PEER)).status).toBe(200);
    const refused = await post(h, LAN_PEER);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe('DIAG_RATE_LIMITED');
    expect(typeof refused.body.retry_after_ms).toBe('number');
    expect(append, 'the over-rate upload is not written').toHaveBeenCalledTimes(10);
  });

  it('one flooding peer does not spend another uploader\'s budget', async () => {
    const append = vi.fn();
    const h = handlerFor({ diag: { logPath: 'C:/tmp/server.log', append }, pairing: registry });
    for (let i = 0; i < 11; i += 1) await post(h, LAN_PEER);
    expect((await post(h, '10.0.0.99')).status).toBe(200);
  });
});

// ── D6 — the diag upload is mounted on the CLOUD leg too, guards intact ──────
//
// It was standalone-only, so the cloud leg — the only leg a public user has —
// answered 404 to "upload diagnostics". The pairing registry the Bearer is judged against
// is `HttpDeps.pairing`, wired by bootstrap in BOTH modes — the first attempt
// borrowed it from `presence`, which does not type-check and should not:
// presence is narrowed to the side-effect-free lookup on purpose. Peer is
// 127.0.0.1 throughout: behind nginx that is what every public caller looks
// like, which is exactly why the saas leg REQUIRES the Bearer instead of
// marking its absence.
describe('POST /api/diag/mobile — saas mount (D6)', () => {
  const registry = {
    reconnectMobile: (token: string) =>
      token === 'good-token' ? { mobile: { id: 'pair-1', user_id: 'u' }, pc: { id: 'pc-1', user_id: 'u', room_uuid: 'r' } } : null,
  } as unknown as Registry;

  function saasHandler(append: ReturnType<typeof vi.fn>): ReturnType<typeof handlerFor> {
    return handlerFor({
      mode: 'saas',
      diag: { logPath: '/var/lib/flowmic/server.log', append },
      pairing: registry,
    });
  }

  function post(h: ReturnType<typeof handlerFor>, token?: string, body?: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const { res, done } = response();
    const req = request('POST', '/api/diag/mobile', '127.0.0.1',
      body ?? JSON.stringify({ device: 'PLA-AL10', lines: ['cloud edge: connected'] }));
    if (token !== undefined) (req as { headers: Record<string, string> }).headers = { authorization: `Bearer ${token}` };
    expect(h(req, res)).toBe(true);
    return done;
  }

  it('a live pairing token ⇒ 200 [phone] — and the router really does thread `deps.pairing`', async () => {
    const append = vi.fn();
    const out = await post(saasHandler(append), 'good-token');
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, authenticated: true });
    const text = append.mock.calls[0]![1] as string;
    expect(text).toContain('origin=pairing:pair-1');
    expect(text).toContain('[phone] cloud edge: connected');
  });

  it('no token ⇒ 401 DIAG_UNVERIFIED, nothing written — the public leg never accepts an anonymous write', async () => {
    const append = vi.fn();
    const out = await post(saasHandler(append));
    expect(out.status).toBe(401);
    expect(out.body).toMatchObject({ ok: false, error: 'DIAG_UNVERIFIED' });
    expect(append).not.toHaveBeenCalled();
  });

  it('the rate window still binds the VERIFIED uploader (per-pairing bucket, not per-peer)', async () => {
    const append = vi.fn();
    const h = saasHandler(append);
    for (let i = 0; i < 10; i += 1) expect((await post(h, 'good-token')).status).toBe(200);
    const refused = await post(h, 'good-token');
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe('DIAG_RATE_LIMITED');
    expect(append).toHaveBeenCalledTimes(10);
  });

  it('the size cap still binds on the cloud leg', async () => {
    const append = vi.fn();
    const out = await post(saasHandler(append), 'good-token', 'x'.repeat(MAX_DIAG_BYTES + 1024));
    expect(out.status).toBe(413);
    expect(out.body).toMatchObject({ ok: false, error: 'DIAG_TOO_LARGE' });
    expect(append).not.toHaveBeenCalled();
  });
});
