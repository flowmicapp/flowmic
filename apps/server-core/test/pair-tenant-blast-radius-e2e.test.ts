// IT-39-a — the per-code failure budget must not be a CROSS-TENANT weapon, on a
// REAL server (in-process bootstrap + real socket.io clients over a real port).
//
// THE BUG this pins the fix for: `recordFailedGuess` used to charge EVERY live
// issuance on every miss (short-code.ts). On a single-machine deployment that is
// fine — one user, one set of codes. On the MULTI-TENANT relay it is an
// availability attack: one attacker spraying wrong guesses burns the budget of
// EVERY PC that is showing its pairing dialog right then, across every tenant.
// The fix charges ONE live issuance per guess (the most-exposed one), so a burst
// of SHORT_CODE_FAILURE_BUDGET guesses burns at most ONE code and leaves every
// other PC's budget intact.
//
// WHY REAL SOCKETS AND A FRESH SERVER. Same reason as pair-brute-force-e2e.ts:
// the claim is about what the SERVER lets a client do — through socketIp(), the
// handler ordering, and the registry — not about the governor in isolation. And
// a FRESH server (its own beforeAll, not the shared one in pair-brute-force-e2e)
// so the ONLY live issuances during the spray are the two PCs this test
// registers; a walk that shares a server with other suites would hit their codes
// and its "oldest live issuance" would be some other test's PC.
//
// THE REVERSE CONTROL is not in this file: per the card it is run by hand —
// revert `recordFailedGuess` to charge every live issuance, run this test, watch
// code B get starved (RED), revert the revert. The assertions below are written
// so that that revert flips exactly the B-side assertion.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { PAIR_SOCKET_FREE_ATTEMPTS } from '../src/room/pair-rate-limit';
import { SHORT_CODE_FAILURE_BUDGET, SHORT_CODE_SPACE } from '../src/room/short-code';

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

/** Register a PC and return its live pairing code (asserted present, not cast —
 *  a refusal carries `error` instead, and spraying the string "undefined" would
 *  measure nothing while still printing numbers). */
async function registerPc(name: string): Promise<{ code: string; socket: ClientSocket }> {
  const socket = await connect();
  const reg = await ack<{ short_code?: string; error?: string }>(socket, 'pc:register', {
    device_name: name,
    // ClientInstanceId is z.string().min(16); pad so a short device name cannot
    // trip the schema (which would answer PAIR_INVALID_PAYLOAD, not register).
    client_instance_id: `inst-${name}-0123456789abcdef`,
  });
  expect(reg.error).toBeUndefined();
  const code = reg.short_code;
  if (typeof code !== 'string') throw new Error(`pc:register returned no short_code: ${JSON.stringify(reg)}`);
  expect(code).toMatch(/^\d{4}$/);
  return { code, socket };
}

/** A source of 4-digit strings that are never in `avoid` — a real space walk,
 *  minus the two live codes, so every guess is a genuine miss (PAIR_INVALID_CODE)
 *  and none of them accidentally PAIRS to A or B. */
function wrongCodesAvoiding(avoid: readonly string[]): () => string {
  const skip = new Set(avoid);
  let n = 0;
  return () => {
    for (;;) {
      const s = String(n++ % SHORT_CODE_SPACE).padStart(4, '0');
      if (!skip.has(s)) return s;
    }
  };
}

/** Fire `attempts` wrong guesses from one source address, rotating the socket
 *  every PAIR_SOCKET_FREE_ATTEMPTS so the per-SOCKET courtesy layer never fires.
 *  Every landed guess is asserted PAIR_INVALID_CODE, so a silently-changed
 *  refusal cannot be miscounted as a probe. Callers keep `attempts` at or below
 *  PAIR_IP_MAX_FAILURES so nothing here is turned away by the per-IP window —
 *  whatever burns a code after this spray is the per-code budget, not a limiter. */
async function sprayFrom(ip: string, attempts: number, nextGuess: () => string): Promise<void> {
  let socket: ClientSocket | null = null;
  for (let i = 0; i < attempts; i++) {
    if (i % PAIR_SOCKET_FREE_ATTEMPTS === 0) {
      socket?.disconnect();
      socket = await connect(ip);
    }
    if (socket === null) throw new Error('unreachable: iteration 0 always connects');
    const res = await ack<{ error?: string }>(socket, 'mobile:pair', { short_code: nextGuess() });
    expect(res.error).toBe('PAIR_INVALID_CODE');
  }
  socket?.disconnect();
}

beforeAll(async () => {
  envBefore = process.env.FLOWMIC_TRUSTED_PROXIES;
  process.env.FLOWMIC_TRUSTED_PROXIES = '127.0.0.1,::1';
  const config = loadConfig({ port: 0, dbPath: ':memory:', secret: 'integration-test-secret-32-bytes-long' });
  server = await startServer(config);
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (envBefore === undefined) delete process.env.FLOWMIC_TRUSTED_PROXIES;
  else process.env.FLOWMIC_TRUSTED_PROXIES = envBefore;
  await server.close();
});

describe('IT-39-a — a spray against one code does not starve a different PC pairing at the same time', () => {
  it(
    'burns exactly the attacked code (A); a legitimate phone still pairs on the untouched code (B)',
    async () => {
      // A is registered FIRST, so it is the oldest live issuance and therefore
      // the one the fix concentrates the charge on (mostExposedLiveIssuance ties
      // break to oldest). B is a DIFFERENT PC, pairing at the same time.
      const a = await registerPc('tenant-A');
      const b = await registerPc('tenant-B');
      expect(a.code).not.toBe(b.code);

      // Spray exactly the budget's worth of misses, spread over four addresses
      // (five each — inside PAIR_IP_MAX_FAILURES and inside the per-socket free
      // budget, so no pre-existing limiter turns any of them away), and never
      // guessing A's or B's real code, so every guess is a clean miss.
      const guesses = wrongCodesAvoiding([a.code, b.code]);
      for (let i = 0; i < 4; i++) {
        await sprayFrom(`198.51.100.${i}`, SHORT_CODE_FAILURE_BUDGET / 4, guesses);
      }

      // POSITIVE CONTROL — the spray really did land somewhere: the attacked code
      // A is now burned. Without this, "B still pairs" would also pass if the
      // spray had quietly done nothing at all.
      const atA = await connect('198.51.100.200');
      const hitA = await ack<{ error?: string; pairing_id?: string }>(atA, 'mobile:pair', { short_code: a.code });
      expect(hitA.pairing_id).toBeUndefined();
      expect(hitA.error).toBe('PAIR_EXPIRED_CODE');
      atA.disconnect();

      // THE POINT — code B belongs to a different PC and was pairing the whole
      // time. Its budget must be untouched: a legitimate phone pairs on it right
      // now. This is the assertion the reverse control flips: revert
      // recordFailedGuess to charge every live issuance and B is burned here too,
      // so this pairing is refused with PAIR_EXPIRED_CODE (RED).
      const phone = await connect('203.0.113.7');
      const okB = await ack<{ error?: string; pairing_id?: string }>(phone, 'mobile:pair', { short_code: b.code });
      expect(okB.error).toBeUndefined();
      expect(okB.pairing_id).toBeTruthy();
      phone.disconnect();

      // eslint-disable-next-line no-console
      console.log(
        `[IT-39-a measured] budget=${SHORT_CODE_FAILURE_BUDGET} misses against neither A nor B -> ` +
          `attacked code A answered "${hitA.error}" (burned) | bystander code B paired ok=${okB.pairing_id != null}`,
      );

      a.socket.disconnect();
      b.socket.disconnect();
    },
    120_000,
  );
});
