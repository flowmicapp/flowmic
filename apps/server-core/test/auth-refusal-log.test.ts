// OPS-1 (2026-09-02 production investigation) — the socket-level auth refusal
// path (auth/middleware.ts, socket/handlers/{pc,mobile}.handler.ts) had ZERO
// log calls, so a phone's rejected handshake or reconnect left no server-side
// trace at all. This file pins the shared helper those call sites now use:
//   ① a refusal writes exactly one WARN line, with a redacted token prefix and
//      NEVER the raw token/JWT;
//   ② a repeat of the SAME (token-prefix, code) pair within the 60 s
//      suppression window writes nothing;
//   ③ once the window has elapsed, the next refusal logs again;
//   ④ a different code, or a different token, is its own suppression bucket.
//
// REVERSE CONTROL (seen red): commenting out the `log.warn(...)` call inside
// `AuthRefusalLog.refuse()` (src/auth/refusal-log.ts) turns test ① red
// (`expect(warnSpy).toHaveBeenCalledTimes(1)` becomes 0 calls) while `wrote`
// still reports `true` — i.e. the suppression bookkeeping was never the part
// that was broken, the missing log line was. Restored afterward; the source
// file's `log.warn` call is unchanged from what shipped.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { log } from '../src/log';
import { AuthRefusalLog, authRefusalLog, logAuthRefusal, redactToken } from '../src/auth/refusal-log';

describe('redactToken', () => {
  it('keeps only the first 3 characters of a real token', () => {
    expect(redactToken('fm_' + 'a'.repeat(64))).toBe('fm_');
  });

  it('never returns more than 3 characters even for a short string', () => {
    expect(redactToken('ab')).toBe('ab');
  });

  it('answers a fixed placeholder when there is no credential at all', () => {
    expect(redactToken(null)).toBe('(none)');
    expect(redactToken(undefined)).toBe('(none)');
    expect(redactToken('')).toBe('(none)');
  });
});

describe('AuthRefusalLog.refuse', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('writes exactly one WARN line, with the redacted prefix and never the raw token', () => {
    const refLog = new AuthRefusalLog(() => 1_000);
    const wrote = refLog.refuse({
      code: 'AUTH_TOKEN_INVALID',
      where: 'handshake-token',
      kind: 'pc',
      node: 'srvny',
      token: 'fm_topsecretcredentialvalue',
    });
    expect(wrote).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg, fields] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe('auth: refused');
    expect(fields).toMatchObject({
      code: 'AUTH_TOKEN_INVALID',
      where: 'handshake-token',
      kind: 'pc',
      node: 'srvny',
      token_prefix: 'fm_',
    });
    // The redaction is the whole point of this file — assert the raw secret
    // never made it into the fields object at all, not merely under a
    // different key.
    expect(JSON.stringify(fields)).not.toContain('topsecretcredentialvalue');
  });

  it('carries userId when the caller has one, and omits it when absent', () => {
    const refLog = new AuthRefusalLog(() => 1_000);
    refLog.refuse({ code: 'ACCOUNT_RESTRICTED', where: 'mobile:restricted', kind: 'mobile', userId: 'user-42' });
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({ user_id: 'user-42' });

    warnSpy.mockClear();
    const refLog2 = new AuthRefusalLog(() => 2_000);
    refLog2.refuse({ code: 'AUTH_TOKEN_INVALID', where: 'handshake-token' });
    expect(warnSpy.mock.calls[0]?.[1]).not.toHaveProperty('user_id');
  });

  it('answers "(none)" for a refusal with no token at all (e.g. a handshake JWT check before any device token exists)', () => {
    const refLog = new AuthRefusalLog(() => 1_000);
    refLog.refuse({ code: 'AUTH_TOKEN_EXPIRED', where: 'handshake-jwt' });
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({ token_prefix: '(none)', kind: null, node: null });
  });

  it('suppresses a repeat of the SAME token-prefix+code within the 60 s window', () => {
    let now = 0;
    const refLog = new AuthRefusalLog(() => now);
    expect(refLog.refuse({ code: 'AUTH_TOKEN_INVALID', where: 'pc:reconnect', token: 'fm_aaa000' })).toBe(true);
    now += 59_000;
    expect(refLog.refuse({ code: 'AUTH_TOKEN_INVALID', where: 'pc:reconnect', token: 'fm_aaa000' })).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('logs again once the suppression window has fully elapsed', () => {
    let now = 0;
    const refLog = new AuthRefusalLog(() => now);
    refLog.refuse({ code: 'AUTH_TOKEN_INVALID', where: 'pc:reconnect', token: 'fm_bbb000' });
    now += 60_000;
    const wrote = refLog.refuse({ code: 'AUTH_TOKEN_INVALID', where: 'pc:reconnect', token: 'fm_bbb000' });
    expect(wrote).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('a DIFFERENT code for the same token is its own suppression bucket', () => {
    let now = 0;
    const refLog = new AuthRefusalLog(() => now);
    refLog.refuse({ code: 'AUTH_TOKEN_INVALID', where: 'pc:reconnect', token: 'fm_ccc000' });
    const wrote = refLog.refuse({ code: 'AUTH_TOKEN_UNVERIFIABLE', where: 'pc:reconnect', token: 'fm_ccc000' });
    expect(wrote).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('a DIFFERENT token with the same code is its own suppression bucket', () => {
    // Suppression keys on the first 3 characters (redactToken), so these two
    // tokens must differ THERE, not just later in the string, or the test
    // would be asserting the wrong thing.
    let now = 0;
    const refLog = new AuthRefusalLog(() => now);
    refLog.refuse({ code: 'AUTH_TOKEN_INVALID', where: 'pc:reconnect', token: 'ddd-000' });
    const wrote = refLog.refuse({ code: 'AUTH_TOKEN_INVALID', where: 'pc:reconnect', token: 'eee-000' });
    expect(wrote).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

describe('logAuthRefusal — the shared singleton', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    authRefusalLog.resetForTests();
  });
  afterEach(() => warnSpy.mockRestore());

  it('routes through the ONE process-wide instance every production call site imports', () => {
    const refuseSpy = vi.spyOn(authRefusalLog, 'refuse');
    logAuthRefusal({ code: 'AUTH_TOKEN_INVALID', where: 'handshake-token', token: 'fm_shared000' });
    expect(refuseSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    refuseSpy.mockRestore();
  });
});
