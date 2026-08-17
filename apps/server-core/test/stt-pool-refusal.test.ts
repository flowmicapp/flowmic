// Card C1 (2026-08-17) — A POOL REFUSAL MUST NOT BE REPORTED AS 「你没配引擎」.
//
// SPEC-REF:
//   packages/protocol/src/error-codes.ts  STT_POOL_NO_ROUTE (the argument for the code)
//   apps/server-core/src/stt/pool-routing.ts  the refusal site + `noRouteFor`
//   apps/server-core/src/stt/engine-factory.ts  the throw site that names the failure
//   docs/strategy/2026-08-16-lan-fable-settings-efficacy-report.md §5-4 (the finding)
//
// 🔴 WHAT THIS FILE PROVES.
//   · a CONFIGURED pool that refuses a language ends in STT_POOL_NO_ROUTE, and the
//     old false sentence's code is gone from that path;
//   · a deployment with NO pool still ends in STT_CONFIG_MISSING — the positive
//     control, without which "the new code appears" is indistinguishable from
//     "the old code was renamed everywhere";
//   · the two are reached through the PRODUCTION wiring: no `managedDefault` is
//     injected anywhere below, so the pool loader is the one under test. An
//     injected resolver would have proved a resolver we wrote for the test.
//
// ⚠️ WHAT IT DOES NOT PROVE. That a phone renders either sentence — that is the
// mobile mirror's half (apps/mobile/test/banner_queue_test.dart), and the two
// halves are only bound by hand (the open account in CLAUDE.md).

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { SttEngineId } from '@flowmic/protocol';
import { makeSttOrchestratorFactory } from '../src/stt/engine-factory';
import { SttConfigMissingError, type EngineFactory } from '../src/stt/engine-router';
import type { SttEngine, SttEngineConfig } from '../src/stt/engines/base';
import type { SettingRow, SettingsRepo } from '../src/db/repos/settings.repo';
import { AudioSession } from '../src/stt/audio/session';
import { loadPool, POOL_ENV } from '../src/stt/pool-config';
import { makePoolManagedDefault } from '../src/stt/pool-routing';
import { log } from '../src/log';

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/** A settings repo holding exactly the rows it is given. `{}` ⇒ the account has
 *  NO `stt.routings` at all: neither a user row nor a seeded one, which is the
 *  only state in which selection can reach the throw site. */
function settingsWith(rows: Record<string, unknown> = {}): SettingsRepo {
  return {
    readAll: (): SettingRow[] => [],
    read: (_u, key): SettingRow | null =>
      key in rows ? ({ key, value: rows[key], updated_at: '' } as unknown as SettingRow) : null,
    write: (): SettingRow => { throw new Error('unused'); },
    remove: (): boolean => false,
  };
}

class StubEngine implements SttEngine {
  state = 'closed' as const;
  constructor(public readonly id: SttEngineId, public cfg: SttEngineConfig) {}
  push(): void {}
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
  on(): this { return this; }
}

const stubFactory: EngineFactory = (id, cfg) => new StubEngine(id, cfg) as unknown as SttEngine;

/** A pool that serves Chinese and English and nothing else. Languages are listed
 *  explicitly — a `['*']` route would match every language and there would be no
 *  refusal to test. */
const ZH_EN_ONLY = {
  id: 'cloud-primary', provider: 'soniox', model: 'stt-rt-v5',
  api: 'wss://example.invalid/rt', region: '*', languages: ['zh', 'en'],
  role: 'primary', enabled: true, priority: 0, api_key: 'platform-key',
};

const ENV_SNAPSHOT = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ENV_SNAPSHOT)) delete process.env[k];
  Object.assign(process.env, ENV_SNAPSHOT);
  vi.restoreAllMocks();
});

/** Build through the production factory and return whatever it threw. */
function refusalFor(language: string, settings: SettingsRepo = settingsWith()): unknown {
  // Silence the pool's refusal line — this suite asserts the CODE, and a stderr
  // wall would make a real failure harder to read. The line itself is asserted
  // in its own case below rather than merely muted.
  vi.spyOn(log, 'error').mockImplementation(() => {});
  try {
    makeSttOrchestratorFactory({
      settings, mode: 'saas', engineFactory: stubFactory,
    })(new AudioSession(), language, 'u1');
    return null;
  } catch (err) {
    return err;
  }
}

/* ── ① the refusal, named ──────────────────────────────────────────────────── */

describe('C1: a configured pool that has no route says so', () => {
  it('🔴 pool serves zh/en, the request is ko ⇒ STT_POOL_NO_ROUTE', () => {
    process.env[POOL_ENV] = JSON.stringify([ZH_EN_ONLY]);
    const err = refusalFor('ko');
    expect(err, 'nothing was thrown — selection found a routing it should not have')
      .toBeInstanceOf(SttConfigMissingError);
    expect((err as SttConfigMissingError).code).toBe('STT_POOL_NO_ROUTE');
  });

  it('🔴 the OLD FALSE SENTENCE is gone from this path', () => {
    // Stated as its own assertion rather than folded into the one above: the
    // deliverable is not "a new code exists", it is "the false one no longer
    // reaches this user". Both the code and the diagnostic message are checked —
    // the message rides `stt:error.message` into the diagnostic upload, so a code
    // that was fixed while the message still said 「no STT engine configured」
    // would put the false sentence straight back into every support log.
    process.env[POOL_ENV] = JSON.stringify([ZH_EN_ONLY]);
    const err = refusalFor('ko') as SttConfigMissingError;
    expect(err.code).not.toBe('STT_CONFIG_MISSING');
    expect(err.message).not.toMatch(/No STT engine configured/);
    expect(err.message).toMatch(/pool had no route/);
  });

  it('the refusal is still stated out loud (the forensic line survived the change)', () => {
    process.env[POOL_ENV] = JSON.stringify([ZH_EN_ONLY]);
    const errs: string[] = [];
    vi.spyOn(log, 'error').mockImplementation((m) => { errs.push(m); });
    try {
      makeSttOrchestratorFactory({
        settings: settingsWith(), mode: 'saas', engineFactory: stubFactory,
      })(new AudioSession(), 'ko', 'u1');
    } catch { /* asserted above */ }
    expect(errs.some((m) => m.includes('stt.pool refused to select a route'))).toBe(true);
  });
});

/* ── ② the positive control ───────────────────────────────────────────────── */

describe('C1 positive control: nothing configured still says nothing is configured', () => {
  it('no pool, no routings ⇒ STT_CONFIG_MISSING, byte-identical to before', () => {
    // 🔴 WITHOUT THIS, THE SUITE ABOVE IS ALSO GREEN FOR A GLOBAL RENAME. The
    // whole point of two codes is that the OTHER sentence is still reachable and
    // still true: on a build with no managed STT at all, "no STT engine is
    // configured for this language" is exactly what happened.
    delete process.env[POOL_ENV];
    delete process.env['FLOWMIC_MANAGED_STT_ENABLED'];
    const err = refusalFor('ko');
    expect(err).toBeInstanceOf(SttConfigMissingError);
    expect((err as SttConfigMissingError).code).toBe('STT_CONFIG_MISSING');
    expect((err as SttConfigMissingError).message).toMatch(/No STT engine configured/);
  });

  it('a language the pool DOES serve resolves normally — no refusal invented', () => {
    process.env[POOL_ENV] = JSON.stringify([ZH_EN_ONLY]);
    const built = makeSttOrchestratorFactory({
      settings: settingsWith(), mode: 'saas', engineFactory: stubFactory,
    })(new AudioSession(), 'zh', 'u1');
    expect(built.isByok).toBe(false);
  });

  it('a SEEDED row still wins over the refusal — precedence is unchanged', () => {
    // The refusal names the failure; it does not create one. `resolve()` returns
    // null rather than throwing precisely so steps 4–5 of selectRoutingWithSource
    // (the platform's own seeded fallback line) still run. If this ever goes red,
    // a pool refusal has started deleting the seed tier.
    process.env[POOL_ENV] = JSON.stringify([ZH_EN_ONLY]);
    const seeded = settingsWith({
      'stt.routings': [
        { language: '*', engine_id: 'funasr', endpoint: 'ws://example.invalid:10095', provenance: 'seed' },
      ],
    });
    const err = refusalFor('ko', seeded);
    expect(err, 'a pool refusal must not skip the seeded fallback').toBeNull();
  });
});

/* ── ③ `noRouteFor` answers only its own question ─────────────────────────── */

describe('C1: noRouteFor is a refusal test, not a null test', () => {
  it('an EMPTY pool is not a refusal (that is the honest STT_CONFIG_MISSING case)', () => {
    const pool = loadPool({} as NodeJS.ProcessEnv);
    expect(pool.source).toBe('none');
    const md = makePoolManagedDefault({ pool });
    expect(md.resolve('ko')).toBeNull();      // …null, and yet…
    expect(md.noRouteFor('ko')).toBe(false);  // …not a refusal. Two questions.
  });

  it('a configured pool refuses an unserved language and serves a served one', () => {
    vi.spyOn(log, 'error').mockImplementation(() => {});
    const md = makePoolManagedDefault({
      env: { [POOL_ENV]: JSON.stringify([ZH_EN_ONLY]) } as unknown as NodeJS.ProcessEnv,
      health: { isAvailable: () => true, record: () => {}, refresh: () => {}, snapshot: () => ({}) },
    });
    expect(md.noRouteFor('ko')).toBe(true);
    expect(md.noRouteFor('zh')).toBe(false);
  });

  it('every route DEAD is not a refusal either — the intent still resolves', () => {
    // The liveness arm re-resolves without the probe and returns the configured
    // intent, so `resolve()` never returns null for it. `noRouteFor` is probe-free
    // for exactly that reason, and this pins the two staying in step.
    vi.spyOn(log, 'error').mockImplementation(() => {});
    const md = makePoolManagedDefault({
      env: { [POOL_ENV]: JSON.stringify([ZH_EN_ONLY]) } as unknown as NodeJS.ProcessEnv,
      health: { isAvailable: () => false, record: () => {}, refresh: () => {}, snapshot: () => ({}) },
    });
    expect(md.resolve('zh')).not.toBeNull();
    expect(md.noRouteFor('zh')).toBe(false);
  });
});
