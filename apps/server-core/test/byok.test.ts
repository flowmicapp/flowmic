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
  it('accepts public http(s)/ws(s) and refuses loopback / metadata / junk', () => {
    expect(byokProbeEndpointAllowed('https://asr.example.com/v1').ok).toBe(true);
    expect(byokProbeEndpointAllowed('wss://asr.example.com/ws').ok).toBe(true);
    expect(byokProbeEndpointAllowed('http://10.0.0.68:10095').ok).toBe(true);
    expect(byokProbeEndpointAllowed('http://127.0.0.1:9/v1').ok).toBe(false);
    expect(byokProbeEndpointAllowed('http://localhost/v1').ok).toBe(false);
    expect(byokProbeEndpointAllowed('http://169.254.169.254/latest').ok).toBe(false);
    expect(byokProbeEndpointAllowed('file:///etc/passwd').ok).toBe(false);
    expect(byokProbeEndpointAllowed('not-a-url').ok).toBe(false);
    expect(byokProbeEndpointAllowed('').ok).toBe(false);
  });
});
