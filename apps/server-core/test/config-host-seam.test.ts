// WP-R4-1 ⑦ — FLOWMIC_HOST bind-host seam. Explicit override of the bind host in
// BOTH modes; default behavior unchanged (standalone all-interfaces=undefined,
// saas loopback); a set-but-empty value fails loud at boot.

import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CORS_ORIGIN, loadConfig, SAAS_LISTEN_HOST, socketCorsOrigin } from '../src/config';

const SECRET = 'host-seam-secret-32-bytes-minimum-xxx';
const savedHost = process.env.FLOWMIC_HOST;
const savedCors = process.env.FLOWMIC_CORS_ORIGIN;

afterEach(() => {
  if (savedHost === undefined) delete process.env.FLOWMIC_HOST;
  else process.env.FLOWMIC_HOST = savedHost;
  if (savedCors === undefined) delete process.env.FLOWMIC_CORS_ORIGIN;
  else process.env.FLOWMIC_CORS_ORIGIN = savedCors;
});

describe('FLOWMIC_HOST seam', () => {
  it('default: standalone binds all interfaces (host undefined), saas binds loopback', () => {
    delete process.env.FLOWMIC_HOST;
    expect(loadConfig({ mode: 'standalone', secret: SECRET }).host).toBeUndefined();
    // fix-010 `trustedProxies: []` — declared posture of an in-process resolution.
    expect(loadConfig({ mode: 'saas', secret: SECRET, dbPath: ':memory:', trustedProxies: [] }).host).toBe(SAAS_LISTEN_HOST);
  });

  it('FLOWMIC_HOST overrides the bind host in both modes', () => {
    process.env.FLOWMIC_HOST = '0.0.0.0';
    expect(loadConfig({ mode: 'standalone', secret: SECRET }).host).toBe('0.0.0.0');
    process.env.FLOWMIC_HOST = '192.168.1.5';
    expect(loadConfig({ mode: 'saas', secret: SECRET, dbPath: ':memory:', trustedProxies: [] }).host).toBe('192.168.1.5'); // overrides loopback default
  });

  it('trims surrounding whitespace', () => {
    process.env.FLOWMIC_HOST = '  10.0.0.9  ';
    expect(loadConfig({ mode: 'standalone', secret: SECRET }).host).toBe('10.0.0.9');
  });

  it('set-but-empty (or whitespace-only) FLOWMIC_HOST fails loud at boot', () => {
    process.env.FLOWMIC_HOST = '';
    expect(() => loadConfig({ mode: 'standalone', secret: SECRET })).toThrow(/FLOWMIC_HOST/);
    process.env.FLOWMIC_HOST = '   ';
    expect(() => loadConfig({ mode: 'standalone', secret: SECRET })).toThrow(/FLOWMIC_HOST/);
  });

  it('explicit override arg wins over the env var', () => {
    process.env.FLOWMIC_HOST = '10.0.0.1';
    expect(loadConfig({ mode: 'standalone', secret: SECRET, host: '127.0.0.5' }).host).toBe('127.0.0.5');
  });
});

// GA-15 — deployment hardening. Two production hazards that were one-liners:
// a saas server silently running on an in-memory database (W2 lost registered
// users to exactly that), and a CORS origin hardcoded so the flowmic.app
// reverse proxy would need a code change.
describe('GA-15 saas deployment guards', () => {
  // fix-010 `trustedProxies: []` — the declared proxy posture, so that each
  // assertion below still lands on the guard it names. The DB-path requirement
  // is resolved BEFORE this one, so the refusal test one line down is unchanged.
  const SAAS = { mode: 'saas' as const, secret: SECRET, trustedProxies: [] };

  it('refuses to start saas without an explicit FLOWMIC_DB_PATH', () => {
    delete process.env.FLOWMIC_DB_PATH;
    expect(() => loadConfig(SAAS)).toThrow(/FLOWMIC_DB_PATH/);
  });

  it('accepts an EXPLICIT :memory: — the hazard is silence, not the value', () => {
    // Naming :memory: is a deliberate choice (tests, ephemeral hosts). Leaving
    // it unset is the accident.
    expect(loadConfig({ ...SAAS, dbPath: ':memory:' }).dbPath).toBe(':memory:');
    process.env.FLOWMIC_DB_PATH = '/srv/flowmic/flowmic.db';
    expect(loadConfig(SAAS).dbPath).toBe('/srv/flowmic/flowmic.db');
    delete process.env.FLOWMIC_DB_PATH;
  });

  it('standalone keeps the convenient in-memory default', () => {
    expect(loadConfig({ mode: 'standalone', secret: SECRET }).dbPath).toBe(':memory:');
  });

  it('CORS: defaults to production + web-client hosts, env-overridable, blank env fails loud', () => {
    delete process.env.FLOWMIC_CORS_ORIGIN;
    expect(loadConfig({ ...SAAS, dbPath: ':memory:' }).corsOrigins).toEqual([
      DEFAULT_CORS_ORIGIN,
      'https://web.flowmic.app',
      'https://cdn.flowmic.app',
    ]);
    process.env.FLOWMIC_CORS_ORIGIN = 'https://flowmic.app, https://flowmic.app';
    expect(loadConfig({ ...SAAS, dbPath: ':memory:' }).corsOrigins).toEqual([
      'https://flowmic.app',
      'https://flowmic.app',
    ]);
    // Set-but-empty is a misconfiguration, not "allow nothing" — allowing
    // nothing would silently break every browser call.
    process.env.FLOWMIC_CORS_ORIGIN = '  ,  ';
    expect(() => loadConfig({ ...SAAS, dbPath: ':memory:' })).toThrow(/lists no origin/);
    delete process.env.FLOWMIC_CORS_ORIGIN;
  });

  // S1-03 — web-client hosts on the built-in saas list. The origin
  // strings are written as literals here on purpose: importing
  // DEFAULT_SAAS_CORS_ORIGINS and asserting equality against itself would
  // stay green after a list edit. Reverse-control is "delete one host from
  // the default, this file goes red".
  it('S1-03: each web-client origin is on the saas default allow-list', () => {
    delete process.env.FLOWMIC_CORS_ORIGIN;
    const origins = loadConfig({ ...SAAS, dbPath: ':memory:' }).corsOrigins;
    // DOM-1: the mic client is served from the marketing origin itself
    // (`https://flowmic.app/go/`), so ITS origin is DEFAULT_CORS_ORIGIN. There
    // is no `go.` host to allow, and asserting one would pin a dead name.
    expect(origins).toContain(DEFAULT_CORS_ORIGIN);
    expect(origins).not.toContain('https://go.flowmic.app');
    expect(origins).toContain('https://web.flowmic.app');
    expect(origins).toContain('https://cdn.flowmic.app');
    expect(socketCorsOrigin('saas', origins)).toEqual(origins);
  });

  it('S1-03: a random third-party origin is not on the saas default list', () => {
    delete process.env.FLOWMIC_CORS_ORIGIN;
    const origins = loadConfig({ ...SAAS, dbPath: ':memory:' }).corsOrigins;
    expect(origins).not.toContain('https://evil.example');
    const applied = socketCorsOrigin('saas', origins);
    expect(applied).not.toBe('*');
    expect(Array.isArray(applied) && applied.includes('https://evil.example')).toBe(false);
  });

  it('S1-03: standalone still applies * — the saas list does not constrain LAN', () => {
    delete process.env.FLOWMIC_CORS_ORIGIN;
    const cfg = loadConfig({ mode: 'standalone', secret: SECRET });
    expect(socketCorsOrigin(cfg.mode, cfg.corsOrigins)).toBe('*');
  });

  it('S1-03: explicit FLOWMIC_CORS_ORIGIN fully overrides, it does not merge', () => {
    process.env.FLOWMIC_CORS_ORIGIN = 'https://staging.example';
    const origins = loadConfig({ ...SAAS, dbPath: ':memory:' }).corsOrigins;
    expect(origins).toEqual(['https://staging.example']);
    expect(origins).not.toContain('https://web.flowmic.app');
    expect(origins).not.toContain('https://cdn.flowmic.app');
    expect(origins).not.toContain(DEFAULT_CORS_ORIGIN);
    delete process.env.FLOWMIC_CORS_ORIGIN;
  });
});
