// WP-R4-1 ⑦ — FLOWMIC_HOST bind-host seam. Explicit override of the bind host in
// BOTH modes; default behavior unchanged (standalone all-interfaces=undefined,
// saas loopback); a set-but-empty value fails loud at boot.

import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CORS_ORIGIN, loadConfig, SAAS_LISTEN_HOST } from '../src/config';

const SECRET = 'host-seam-secret-32-bytes-minimum-xxx';
const savedHost = process.env.FLOWMIC_HOST;

afterEach(() => {
  if (savedHost === undefined) delete process.env.FLOWMIC_HOST;
  else process.env.FLOWMIC_HOST = savedHost;
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

  it('CORS: defaults to production, env-overridable, blank env fails loud', () => {
    delete process.env.FLOWMIC_CORS_ORIGIN;
    expect(loadConfig({ ...SAAS, dbPath: ':memory:' }).corsOrigins).toEqual([DEFAULT_CORS_ORIGIN]);
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
});
