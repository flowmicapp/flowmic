// Console BYOK policy: empty-on-register, enable switch, probe URL guard.
import { describe, expect, it } from 'vitest';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { seedDefaultSettings } from '../src/settings/defaults';
import {
  authoredRoutings,
  BYOK_ENABLED_KEY,
  byokProbeEndpointAllowed,
  consoleByokEnabled,
  isByokEnabled,
  seedSaasByokEmpty,
} from '../src/settings/byok';
import { loadRoutings } from '../src/stt/engine-factory';
import { SEED_PROVENANCE } from '../src/settings/provenance';

function db() {
  return createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('byok-test-secret-32-bytes-min!!') });
}

function dbWithUser(id = 'u1') {
  const handle = db();
  handle.users.insert({ id, email: `${id}@byok.test`, display_name: id });
  return handle;
}

describe('seedSaasByokEmpty', () => {
  it('writes empty routings + enabled:false, and seedDefaultSettings does not overwrite them', () => {
    const handle = dbWithUser('u1');
    expect(seedSaasByokEmpty(handle.settings, 'u1').sort()).toEqual(['stt.byok_enabled', 'stt.routings']);
    expect(handle.settings.read('u1', 'stt.routings')!.value).toEqual([]);
    expect(handle.settings.read('u1', BYOK_ENABLED_KEY)!.value).toBe(false);
    // Second call is a no-op — never clobber a row that exists.
    expect(seedSaasByokEmpty(handle.settings, 'u1')).toEqual([]);
    seedDefaultSettings(handle.settings, 'u1');
    expect(handle.settings.read('u1', 'stt.routings')!.value).toEqual([]);
  });
});

describe('isByokEnabled vs consoleByokEnabled', () => {
  it('absent key: routing stays on (standalone / grandfather); console infers from authored rows', () => {
    const handle = db();
    expect(isByokEnabled(handle.settings, 'u')).toBe(true);
    expect(consoleByokEnabled(handle.settings, 'u', [])).toBe(false);
    expect(consoleByokEnabled(handle.settings, 'u', [{ language: 'en' }])).toBe(true);
  });

  it('explicit false is OFF for both; explicit true is ON for both', () => {
    const handle = dbWithUser('u');
    handle.settings.write('u', BYOK_ENABLED_KEY, false);
    expect(isByokEnabled(handle.settings, 'u')).toBe(false);
    expect(consoleByokEnabled(handle.settings, 'u', [{ language: 'en' }])).toBe(false);
    handle.settings.write('u', BYOK_ENABLED_KEY, true);
    expect(isByokEnabled(handle.settings, 'u')).toBe(true);
    expect(consoleByokEnabled(handle.settings, 'u', [])).toBe(true);
  });
});

describe('authoredRoutings', () => {
  it('drops seed-marked rows and keeps unmarked ones', () => {
    expect(authoredRoutings([
      { language: 'zh', provenance: SEED_PROVENANCE },
      { language: 'en', engine_id: 'deepgram' },
    ])).toEqual([{ language: 'en', engine_id: 'deepgram' }]);
    expect(authoredRoutings(null)).toEqual([]);
  });
});

describe('loadRoutings honors the switch', () => {
  it('explicit false drops user rows and keeps seed rows', () => {
    const handle = dbWithUser('u');
    handle.settings.write('u', 'stt.routings', [
      { language: 'zh', engine_id: 'funasr', provenance: SEED_PROVENANCE },
      { language: 'en', engine_id: 'deepgram', api_key: 'sk' },
    ]);
    handle.settings.write('u', BYOK_ENABLED_KEY, false);
    expect(loadRoutings(handle.settings, 'u')).toEqual([
      { language: 'zh', engine_id: 'funasr', provenance: SEED_PROVENANCE },
    ]);
  });

  it('absent key returns every row (reverse control: the filter is the switch)', () => {
    const handle = dbWithUser('u');
    const rows = [
      { language: 'zh', engine_id: 'funasr', provenance: SEED_PROVENANCE },
      { language: 'en', engine_id: 'deepgram', api_key: 'sk' },
    ];
    handle.settings.write('u', 'stt.routings', rows);
    expect(loadRoutings(handle.settings, 'u')).toEqual(rows);
  });
});

describe('byokProbeEndpointAllowed', () => {
  // A hostname that is not one of the literal-string refusals resolves through
  // `deps.resolveHost` in every case below — no real DNS lookup happens in this
  // suite, so it stays deterministic offline and cannot flake on network access.
  const resolvesTo = (...addresses: string[]) => ({ resolveHost: async () => addresses });

  it('accepts public http(s)/ws(s) and refuses loopback / metadata / junk (literal-string layer)', async () => {
    expect((await byokProbeEndpointAllowed('https://asr.example.com/v1', resolvesTo('93.184.216.34'))).ok).toBe(true);
    expect((await byokProbeEndpointAllowed('wss://asr.example.com/ws', resolvesTo('93.184.216.34'))).ok).toBe(true);
    expect((await byokProbeEndpointAllowed('http://10.0.0.68:10095')).ok).toBe(true); // literal IP: no DNS involved
    expect((await byokProbeEndpointAllowed('http://127.0.0.1:9/v1')).ok).toBe(false);
    expect((await byokProbeEndpointAllowed('http://localhost/v1')).ok).toBe(false);
    expect((await byokProbeEndpointAllowed('http://169.254.169.254/latest')).ok).toBe(false);
    expect((await byokProbeEndpointAllowed('file:///etc/passwd')).ok).toBe(false);
    expect((await byokProbeEndpointAllowed('not-a-url')).ok).toBe(false);
    expect((await byokProbeEndpointAllowed('')).ok).toBe(false);
  });

  it('REVERSE CONTROL: a hostname is judged by what it resolves to, not by its spelling', async () => {
    // The literal-string layer alone (the code before this fix) lets this
    // through: 'asr.attacker.example' is not 'localhost' and not
    // '169.254.169.254'. Only the resolve-then-check layer catches it.
    const result = await byokProbeEndpointAllowed('http://asr.attacker.example/v1', resolvesTo('169.254.169.254'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a valid engine endpoint/);
  });

  it('refuses when ANY resolved address is dangerous, not just the first', async () => {
    const result = await byokProbeEndpointAllowed('http://asr.example.com/v1', resolvesTo('93.184.216.34', '169.254.169.254'));
    expect(result.ok).toBe(false);
  });

  it('accepts a hostname that resolves only to a public / RFC1918 address', async () => {
    expect((await byokProbeEndpointAllowed('http://asr.example.com/v1', resolvesTo('93.184.216.34'))).ok).toBe(true);
    expect((await byokProbeEndpointAllowed('http://engine.lan/v1', resolvesTo('10.0.0.68'))).ok).toBe(true);
  });

  it('refuses a literal IPv4-mapped IPv6 spelling of a blocked address', async () => {
    expect((await byokProbeEndpointAllowed('http://[::ffff:169.254.169.254]/v1')).ok).toBe(false);
    expect((await byokProbeEndpointAllowed('http://asr.example.com/v1', resolvesTo('::ffff:169.254.169.254'))).ok).toBe(false);
  });

  it('refuses fe80::/10 (IPv6 link-local) and accepts a public IPv6 literal', async () => {
    expect((await byokProbeEndpointAllowed('http://asr.example.com/v1', resolvesTo('fe80::1'))).ok).toBe(false);
    expect((await byokProbeEndpointAllowed('http://asr.example.com/v1', resolvesTo('2001:db8::1'))).ok).toBe(true);
  });

  it('refuses a hostname that fails to resolve, rather than probing an unknown address', async () => {
    const result = await byokProbeEndpointAllowed('http://nowhere.example/v1', {
      resolveHost: async () => { throw new Error('ENOTFOUND nowhere.example'); },
    });
    expect(result.ok).toBe(false);
  });
});
