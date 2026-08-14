// IT-39 — the END-TO-END brute-force experiment, both directions, on a REAL
// server (in-process bootstrap + real socket.io clients over a real port).
//
// WHY IT HAD TO BE END-TO-END. The whole card exists because a NUMBER was
// asserted from constants: "an ordinary /24 (256 addresses) can try
// 12,800 times in 5 minutes combined" (docs/strategy/2026-08-06-it39-pairing-bruteforce-proposal.md),
// with that same document admitting "the numbers above are measured constants + arithmetic; no end-to-end
// blast experiment was run; do not read this as 'proven to punch through'". A unit test over PairRateLimiter cannot close
// that: it measures the limiter, and the claim is about what the SERVER lets a
// client do — through socketIp(), through the handler's ordering, through the
// registry. So this file drives mobile:pair on the wire.
//
// HOW DISTINCT SOURCE ADDRESSES ARE OBTAINED without 256 real NICs: the server
// derives the limiter key through the ONE production derivation
// (http/trusted-proxy.ts) — behind a TRUSTED proxy it reads the rightmost
// untrusted X-Forwarded-For hop. The test trusts loopback (exactly the VPS
// config, `FLOWMIC_TRUSTED_PROXIES=127.0.0.1,::1`) and sends a different
// forwarded client per connection. That is not a shortcut around the defence:
// it is the same code path a real attacker behind our real edge would be keyed
// by, and it is checked rather than assumed — DIRECTION 1's CONTROL sprays with
// ONE address and gets a different number.
//
// 🔴 WHAT IS MEASURED VS WHAT IS EXTRAPOLATED — stated up front so nobody
// promotes the second into the first. A full /24 × 5-minute walk is 5 sixty-
// second windows of wall clock and cannot be run here; the server's limiter has
// no injectable clock through bootstrap. So DIRECTION 1 measures the MULTIPLIER
// (attempts a fresh source buys, and that it scales linearly with sources) and
// the /24 total is arithmetic over that measured constant. DIRECTION 2 is
// measured whole: nothing is extrapolated in it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { PAIR_IP_MAX_FAILURES, PAIR_SOCKET_FREE_ATTEMPTS, PAIR_IP_WINDOW_MS } from '../src/room/pair-rate-limit';
import { SHORT_CODE_FAILURE_BUDGET, SHORT_CODE_SPACE } from '../src/room/short-code';

const SHORT_CODE_TTL_MS = 5 * 60_000; // ShortCodeGovernor's production default

let server: BootstrapHandle;
let url: string;
let envBefore: string | undefined;

/** One client. `forwardedFor` becomes the address every per-IP limiter keys on,
 *  via the production derivation (loopback is trusted for this run). */
function connect(forwardedFor?: string): Promise<ClientSocket> {
  const socket = ioClient(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    ...(forwardedFor ? { extraHeaders: { 'x-forwarded-for': forwardedFor } } : {}),
  });
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function ack<T = Record<string, unknown>>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), 5000);
    socket.emit(event, payload, (res: T) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

/** Register a PC and return its live pairing code. */
async function registerPc(name: string): Promise<{ code: string; socket: ClientSocket }> {
  const socket = await connect();
  const reg = await ack<{ short_code?: string; error?: string }>(socket, 'pc:register', {
    device_name: name,
    client_instance_id: `inst-${name}`,
  });
  // The code is genuinely optional on this ack (a refusal carries `error`
  // instead), so it is ASSERTED rather than cast: a run that silently continued
  // with `undefined` would spray the string "undefined" at the code space and
  // measure nothing at all, while still printing numbers.
  expect(reg.error).toBeUndefined();
  const code = reg.short_code;
  if (typeof code !== 'string') throw new Error(`pc:register returned no short_code: ${JSON.stringify(reg)}`);
  expect(code).toMatch(/^\d{4}$/);
  return { code, socket };
}

/** A source of 4-digit strings that are never `avoid` — a real space walk, minus
 *  the hit. A closure rather than a generator so the caller gets a plain
 *  `string` with no cast standing between the walk and the assertions. */
function wrongCodes(avoid: string): () => string {
  let n = 0;
  return () => {
    for (;;) {
      const s = String(n++ % SHORT_CODE_SPACE).padStart(4, '0');
      if (s !== avoid) return s;
    }
  };
}

interface SprayResult {
  /** Guesses that actually probed the code space (answered by the registry). */
  landed: number;
  /** Guesses turned away by a rate limiter before reaching the code space. */
  refused: number;
}

/** Fire `attempts` wrong guesses from one source address, rotating the socket
 *  every PAIR_SOCKET_FREE_ATTEMPTS so the per-SOCKET courtesy layer never fires
 *  and every refusal we count is the per-IP bound (exactly what a real attacker
 *  does — a reconnect resets that layer for free; pair-rate-limit.ts axis 1). */
async function sprayFrom(ip: string, attempts: number, nextGuess: () => string): Promise<SprayResult> {
  const out: SprayResult = { landed: 0, refused: 0 };
  let socket: ClientSocket | null = null;
  for (let i = 0; i < attempts; i++) {
    if (i % PAIR_SOCKET_FREE_ATTEMPTS === 0) {
      socket?.disconnect();
      socket = await connect(ip);
    }
    if (socket === null) throw new Error('unreachable: iteration 0 always connects');
    const res = await ack<{ error?: string }>(socket, 'mobile:pair', {
      short_code: nextGuess(),
    });
    if (res.error === 'PAIR_RATE_LIMITED') out.refused++;
    else {
      // Anything else means the guess reached resolvePcForPair. A wrong string
      // answers PAIR_INVALID_CODE; assert it, so a silently-changed refusal
      // cannot be counted as a successful probe.
      expect(res.error).toBe('PAIR_INVALID_CODE');
      out.landed++;
    }
  }
  socket?.disconnect();
  return out;
}

beforeAll(async () => {
  envBefore = process.env.FLOWMIC_TRUSTED_PROXIES;
  process.env.FLOWMIC_TRUSTED_PROXIES = '127.0.0.1,::1';
  const config = loadConfig({ port: 0, dbPath: ':memory:', secret: 'integration-test-secret-32-bytes-long' });
  server = await startServer(config);
  // 127.0.0.1 rather than localhost: the peer must be the loopback we trusted,
  // deterministically, not whatever the resolver picks today.
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (envBefore === undefined) delete process.env.FLOWMIC_TRUSTED_PROXIES;
  else process.env.FLOWMIC_TRUSTED_PROXIES = envBefore;
  await server.close();
});

describe('IT-39 DIRECTION 1 — the threat is real: per-IP limiting alone does not bound the attempts against a code', () => {
  it(
    'a fresh source address buys exactly PAIR_IP_MAX_FAILURES probes, and sources add up linearly',
    async () => {
      const { code, socket: pcSocket } = await registerPc('direction-1');
      const guesses = wrongCodes(code);

      // CONTROL — one address, sprayed past its budget. This is the bound that
      // exists today, measured on the wire rather than read off a constant.
      const single = await sprayFrom('198.51.100.1', PAIR_IP_MAX_FAILURES + 5, guesses);
      expect(single.landed).toBe(PAIR_IP_MAX_FAILURES);
      expect(single.refused).toBe(5);

      // MEASUREMENT — the same spray from a slice of one /24. If the per-IP
      // window were the real bound, this would still total PAIR_IP_MAX_FAILURES.
      const SOURCES = 16;
      let landed = 0;
      let refused = 0;
      for (let i = 0; i < SOURCES; i++) {
        const r = await sprayFrom(`203.0.113.${i}`, PAIR_IP_MAX_FAILURES + 1, guesses);
        expect(r.landed).toBe(PAIR_IP_MAX_FAILURES); // every source starts clean
        expect(r.refused).toBe(1);
        landed += r.landed;
        refused += r.refused;
      }
      expect(landed).toBe(SOURCES * PAIR_IP_MAX_FAILURES);

      // The arithmetic the card asked for, computed from the MEASURED constant
      // above and labelled as the extrapolation it is.
      const perSourcePerWindow = landed / SOURCES; // measured: 10
      const windowsPerCodeLife = SHORT_CODE_TTL_MS / PAIR_IP_WINDOW_MS; // 5
      const slash24 = 256 * perSourcePerWindow * windowsPerCodeLife;
      // eslint-disable-next-line no-console
      console.log(
        `[IT-39 DIRECTION 1 measured] sources=${SOURCES} landed=${landed} refused=${refused} ` +
          `per_source_per_window=${perSourcePerWindow} | extrapolated /24 over one code life=${slash24} ` +
          `vs code space=${SHORT_CODE_SPACE}`,
      );
      expect(slash24).toBeGreaterThan(SHORT_CODE_SPACE); // 12 800 > 10 000

      pcSocket.disconnect();
    },
    120_000,
  );
});

describe('IT-39 DIRECTION 2 — the fix works: the code burns before the space can be walked', () => {
  it(
    'after SHORT_CODE_FAILURE_BUDGET misses from many sources, the CORRECT code no longer pairs',
    async () => {
      const { code, socket: pcSocket } = await registerPc('direction-2');
      const guesses = wrongCodes(code);

      // Spread the budget across four addresses, five guesses each: every one is
      // well inside PAIR_IP_MAX_FAILURES and inside the per-socket free budget,
      // so nothing here is refused by the pre-existing limiters. Whatever stops
      // the walk after this cannot be them.
      let landed = 0;
      for (let i = 0; i < 4; i++) {
        const r = await sprayFrom(`192.0.2.${i}`, SHORT_CODE_FAILURE_BUDGET / 4, guesses);
        expect(r.refused).toBe(0);
        landed += r.landed;
      }
      expect(landed).toBe(SHORT_CODE_FAILURE_BUDGET);

      // The attacker now reaches the right string — from a brand-new address, so
      // no limiter of the old kind has anything on them.
      const attacker = await connect('192.0.2.200');
      const hit = await ack<{ error?: string; pairing_id?: string }>(attacker, 'mobile:pair', { short_code: code });
      expect(hit.pairing_id).toBeUndefined();
      expect(hit.error).toBe('PAIR_EXPIRED_CODE');
      attacker.disconnect();

      // POSITIVE CONTROL — the server still pairs. Without this, 「the correct
      // code was refused」 is equally consistent with a broken pairing path, and
      // the two have opposite fixes.
      const fresh = await registerPc('direction-2-control');
      const phone = await connect('192.0.2.201');
      const ok = await ack<{ error?: string; pairing_id?: string }>(phone, 'mobile:pair', {
        short_code: fresh.code,
      });
      expect(ok.error).toBeUndefined();
      expect(ok.pairing_id).toBeTruthy();
      // eslint-disable-next-line no-console
      console.log(
        `[IT-39 DIRECTION 2 measured] budget=${SHORT_CODE_FAILURE_BUDGET} misses landed=${landed} refused=0 ` +
          `-> correct code answered "${hit.error}" | control pairing on a fresh code: ok`,
      );
      phone.disconnect();
      fresh.socket.disconnect();
      pcSocket.disconnect();
    },
    120_000,
  );
});
