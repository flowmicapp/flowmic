// A6-3 / O-5 — the POOL SELECTION ALGORITHM'S PRODUCTION WIRING.
//
// SPEC-REF:
//   docs/strategy/2026-08-02-m2-window-handoff-report.md §5 M2-2
//     (🔴 O-5 route-selection algorithm [unwired] — zero production consumers)
//   docs/strategy/2026-08-02-h6-soniox-streaming-adapter-card.md
//     §-0b (with ONE provider the candidate set is a singleton, so「smart routing」can
//           be built, pass, and report success while never having chosen
//           anything — the most painful delivery shape in this repo),
//     §-0e (🔴 the group comes from the SERVER'S credential, never from a field
//           the client asserts), §4a (STREAMING_ENGINES drives the VAD gate)
//   docs/decisions/2026-08-02-owner-stt-pool-groups-and-ops-phase1-scope.md ③
//
// 🔴 WHAT THIS FILE PROVES AND WHAT IT DOES NOT.
//   PROVES: that `selectRoute` is reached from the production factory with no
//   test-only injection of `managedDefault`; that failover fires and is stated;
//   that a capability downgrade is stated separately; that the group cannot come
//   off the wire.
//   DOES NOT PROVE: that any provider is reachable. That is a network fact and
//   lives in the live drill, not here.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SttEngineId } from '@flowmic/protocol';
import { makeSttOrchestratorFactory, isStreamingEngine } from '../src/stt/engine-factory';
import type { EngineFactory } from '../src/stt/engine-router';
import type { SttEngine, SttEngineConfig } from '../src/stt/engines/base';
import type { SettingRow, SettingsRepo } from '../src/db/repos/settings.repo';
import { AudioSession } from '../src/stt/audio/session';
import { VadGate } from '../src/stt/vad-gate';
import { loadPool, POOL_ENV, MANAGED_DEFAULT_ROUTE_ID } from '../src/stt/pool-config';
import { REGION_ANY } from '../src/pool/select-route';
import { makePoolManagedDefault, resolvePoolRouting } from '../src/stt/pool-routing';
import { ROUTE_FATAL_CODES, probeRouteLiveness, makeRouteHealthRegistry } from '../src/stt/pool-health';
import { SttEngineError } from '../src/stt/engines/base';
import { log } from '../src/log';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

/* ── fixtures ─────────────────────────────────────────────────────────────── */

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

/** Records every engine id the factory is asked to build. */
function recordingFactory(): { factory: EngineFactory; built: SttEngineId[] } {
  const built: SttEngineId[] = [];
  const factory: EngineFactory = (id, cfg) => {
    built.push(id);
    return new StubEngine(id, cfg) as unknown as SttEngine;
  };
  return { factory, built };
}

// 🔴 EVERY ROUTE BELOW LISTS ITS LANGUAGES EXPLICITLY, AND THAT IS NOT
// COSMETIC — see the「wildcard trap」describe block at the bottom of this file.
// A route configured `languages:['*']` sits in a STRICTLY LOWER candidate tier
// than one that names the language, so it loses to it no matter what `priority`
// says. Writing these fixtures the obvious way (Soniox = all languages, per owner's
// initial-config ruling) is what surfaced it.
const CLOUD_PRIMARY = {
  id: 'cloud-primary', provider: 'soniox', model: 'stt-rt-v5',
  api: 'wss://example.invalid/rt', region: '*', languages: ['zh', 'en'],
  role: 'primary', enabled: true, priority: 0, api_key: 'platform-key',
};
const LOCAL_BACKUP = {
  id: 'local-backup', provider: 'funasr', model: '', api: 'ws://10.0.0.9:10095',
  region: '*', languages: ['zh', 'en'], role: 'backup', enabled: true, priority: 10,
};
/** A backup with NO streaming — failing over onto it LOSES interim results. */
const BATCH_BACKUP = {
  id: 'batch-backup', provider: 'openai-whisper', model: 'whisper-1',
  api: 'https://example.invalid/v1', region: '*', languages: ['zh', 'en'],
  role: 'backup', enabled: true, priority: 20,
};

const ENV_SNAPSHOT = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ENV_SNAPSHOT)) delete process.env[k];
  Object.assign(process.env, ENV_SNAPSHOT);
  vi.restoreAllMocks();
});

function poolEnv(rows: unknown[]): NodeJS.ProcessEnv {
  return { [POOL_ENV]: JSON.stringify(rows) } as unknown as NodeJS.ProcessEnv;
}

/* ── ① the production consumer really exists ──────────────────────────────── */

describe('O-5 is wired: selectRoute runs on the real managed path', () => {
  it('🔴 makeSttOrchestratorFactory resolves through the POOL with NO managedDefault injected', () => {
    // The whole point of M2-2: before this the algorithm had 31 green tests and
    // zero callers. This test injects NO `managedDefault` — it sets the same env
    // a VPS would and lets the production default do the work.
    process.env[POOL_ENV] = JSON.stringify([CLOUD_PRIMARY, LOCAL_BACKUP]);
    const lines: [string, unknown][] = [];
    vi.spyOn(log, 'info').mockImplementation((m, f) => { lines.push([m, f]); });

    const { factory, built } = recordingFactory();
    const out = makeSttOrchestratorFactory({
      settings: settingsWith(), mode: 'saas', engineFactory: factory,
    })(new AudioSession(), 'zh', 'u1', new VadGate());

    // ① the pool really resolved this session — this line only exists in
    //    pool-routing.ts, so its presence IS the wiring proof.
    const sel = lines.find(([m]) => m === 'stt.pool selected a route');
    expect(sel, 'no pool selection line ⇒ selectRoute was never reached').toBeDefined();
    expect(sel?.[1]).toMatchObject({
      route_id: 'cloud-primary', provider: 'soniox', model: 'stt-rt-v5',
      pool_source: 'pool-env', language: 'zh', candidates: 2,
    });
    // ② and the session it produced is the managed one (T7 provenance intact).
    expect(out.isByok).toBe(false);
    // ③ every route in the pool got a liveness probe kicked — the probes build
    //    real engines through the SAME factory, which is why both ids show up.
    expect([...built].sort()).toEqual(['funasr', 'soniox']);
  });

  it('the VAD billing gate really closes on a pool-selected soniox session (§4a, effective value)', () => {
    // D1 rule: assert the value that actually costs money, not the membership.
    process.env[POOL_ENV] = JSON.stringify([CLOUD_PRIMARY]);
    const { factory } = recordingFactory();
    const built = makeSttOrchestratorFactory({
      settings: settingsWith(), mode: 'saas', engineFactory: factory,
    })(new AudioSession(), 'zh', 'u1', new VadGate());
    expect(isStreamingEngine('soniox')).toBe(true);
    expect(built.isByok).toBe(false);   // platform key is NOT the user's (T7)
    expect(built.gated).toBe(true);     // ⇐ the value silence-billing depends on
  });

  it('no pool configured ⇒ the lone managed default is WRAPPED as a one-route pool', () => {
    // This is what makes the consumer unconditional instead of opt-in — and it
    // makes the degenerate case VISIBLE (candidates === 1) instead of invisible.
    const env = {
      FLOWMIC_MANAGED_STT_ENABLED: '1',
      FLOWMIC_MANAGED_STT_ENGINE: 'soniox',
      FLOWMIC_MANAGED_STT_MODEL: 'stt-rt-v5',
      FLOWMIC_MANAGED_STT_API_KEY: 'platform-key',
    } as unknown as NodeJS.ProcessEnv;
    const pool = loadPool(env);
    expect(pool.source).toBe('managed-default');
    expect(pool.pool.map((r) => r.id)).toEqual([MANAGED_DEFAULT_ROUTE_ID]);
    const { selection } = resolvePoolRouting(pool, 'zh');
    expect(selection.outcome).toBe('selected');
    if (selection.outcome !== 'selected') throw new Error('unreachable');
    // 🔴 card §-0b: one candidate means nothing was ever chosen. It must be
    // reported, not hidden.
    expect(selection.ranked_route_ids).toHaveLength(1);
    expect(pool.routingOf(MANAGED_DEFAULT_ROUTE_ID)?.api_key).toBe('platform-key');
  });

  it('nothing configured at all ⇒ null, exactly as before (no behaviour invented)', () => {
    const pool = loadPool({} as NodeJS.ProcessEnv);
    expect(pool.source).toBe('none');
    expect(makePoolManagedDefault({ pool }).resolve('zh')).toBeNull();
  });
});

/* ── ② failover, and it is never silent ───────────────────────────────────── */

describe('failover: real choice, stated out loud (A6 §3-3)', () => {
  it('picks the primary while it is available', () => {
    const md = makePoolManagedDefault({
      env: poolEnv([CLOUD_PRIMARY, LOCAL_BACKUP]),
      health: { isAvailable: () => true, record: () => {}, refresh: () => {}, snapshot: () => ({}) },
    });
    expect(md.resolve('zh')?.engine_id).toBe('soniox');
  });

  it('🔴 kills the primary ⇒ lands on the backup AND logs the failover at error level', () => {
    const errs: [string, unknown][] = [];
    // Capture the forensic line rather than trusting that one exists — a
    // failover nobody can see is the silent downgrade the red line forbids.
    vi.spyOn(log, 'error').mockImplementation((m, f) => { errs.push([m, f]); });

    const dead = new Set(['cloud-primary']);
    const md = makePoolManagedDefault({
      env: poolEnv([CLOUD_PRIMARY, LOCAL_BACKUP]),
      health: {
        isAvailable: (r) => !dead.has(r.id),
        record: () => {}, refresh: () => {}, snapshot: () => ({}),
      },
    });
    const r = md.resolve('zh');
    expect(r?.engine_id).toBe('funasr');
    const line = errs.find(([m]) => m.includes('FAILED OVER'));
    expect(line, 'a failover with no log line is a SILENT downgrade').toBeDefined();
    expect(line?.[1]).toMatchObject({
      intended_route_id: 'cloud-primary',
      intended_provider: 'soniox',
      chosen_route_id: 'local-backup',
      chosen_provider: 'funasr',
    });
  });

  it('🔴 a failover that LOSES streaming is reported as a downgrade, separately', () => {
    const errs: string[] = [];
    vi.spyOn(log, 'error').mockImplementation((m) => { errs.push(m); });

    const md = makePoolManagedDefault({
      env: poolEnv([CLOUD_PRIMARY, BATCH_BACKUP]),
      health: {
        isAvailable: (r) => r.id !== 'cloud-primary',
        record: () => {}, refresh: () => {}, snapshot: () => ({}),
      },
    });
    expect(md.resolve('zh')?.engine_id).toBe('openai-whisper');
    expect(errs.some((m) => m.includes('CAPABILITY DOWNGRADE'))).toBe(true);
  });

  it('positive control: an EQUALLY capable failover is NOT called a downgrade', () => {
    // The other half of「no silent failure」— a false alarm is its own failure.
    const errs: string[] = [];
    vi.spyOn(log, 'error').mockImplementation((m) => { errs.push(m); });
    makePoolManagedDefault({
      env: poolEnv([CLOUD_PRIMARY, LOCAL_BACKUP]),   // funasr streams too
      health: {
        isAvailable: (r) => r.id !== 'cloud-primary',
        record: () => {}, refresh: () => {}, snapshot: () => ({}),
      },
    }).resolve('zh');
    expect(errs.some((m) => m.includes('FAILED OVER'))).toBe(true);
    expect(errs.some((m) => m.includes('CAPABILITY DOWNGRADE'))).toBe(false);
  });

  it('every route dead ⇒ still runs the configured intent, loudly — never a false「not configured」', () => {
    const errs: string[] = [];
    vi.spyOn(log, 'error').mockImplementation((m) => { errs.push(m); });
    const r = makePoolManagedDefault({
      env: poolEnv([CLOUD_PRIMARY, LOCAL_BACKUP]),
      health: { isAvailable: () => false, record: () => {}, refresh: () => {}, snapshot: () => ({}) },
    }).resolve('zh');
    // Returning null here would surface STT_CONFIG_MISSING「该语言尚未配置识别
    // 引擎」— false, and it would hide the provider's own words.
    expect(r?.engine_id).toBe('soniox');
    expect(errs.some((m) => m.includes('every route failed liveness'))).toBe(true);
  });

  it('a configured pool with no way to measure health FAILS LOUD at construction', () => {
    // A pool that can never fail over looks identical to one that works.
    expect(() => makePoolManagedDefault({ env: poolEnv([CLOUD_PRIMARY]) }))
      .toThrow(/liveness could never be measured/);
  });
});

/* ── ③ the group iron law ─────────────────────────────────────────────────── */

describe('§-0e the group comes from the credential, never from the client', () => {
  it('the selected group is the credential default', () => {
    const pool = loadPool({
      ...poolEnv([CLOUD_PRIMARY]),
      FLOWMIC_STT_POOL_DEFAULT_GROUP: 'production-primary',
    } as unknown as NodeJS.ProcessEnv);
    const { selection } = resolvePoolRouting(pool, 'zh');
    if (selection.outcome !== 'selected') throw new Error('expected a selection');
    expect(selection.group_id).toBe('production-primary');
  });

  it('🔴 NOTHING in pool-routing.ts assigns requested_group_id — the entry point is ABSENT', () => {
    // owner ruled that a client MAY request a group *and* that the server must
    // check entitlement and refuse by name. That needs an additive protocol
    // field (owner gate), so this lane built NEITHER half. This assertion is the
    // guard against someone later adding the convenient half — reading a group
    // off a frame and passing it through — which would delete the security
    // requirement while looking like progress.
    const src = readFileSync(new URL('../src/stt/pool-routing.ts', import.meta.url), 'utf8');
    const assignments = src
      .split('\n')
      .filter((l) => l.includes('requested_group_id'))
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
    expect(assignments, `requested_group_id must appear only in comments; found: ${assignments.join(' | ')}`)
      .toEqual([]);
  });
});

/* ── ④ pool config is fail-loud ───────────────────────────────────────────── */

describe('pool config parses fail-loud (a wrong pool must not look like a working one)', () => {
  it('rejects an unknown provider by name instead of casting it', () => {
    expect(() => loadPool(poolEnv([{ ...CLOUD_PRIMARY, provider: 'sonix' }])))
      .toThrow(/not a known SttEngineId/);
  });
  it('rejects malformed JSON', () => {
    expect(() => loadPool({ [POOL_ENV]: '{not json' } as unknown as NodeJS.ProcessEnv)).toThrow(/not valid JSON/);
  });
  it('rejects duplicate route ids (ids address health and forensic)', () => {
    expect(() => loadPool(poolEnv([CLOUD_PRIMARY, CLOUD_PRIMARY]))).toThrow(/duplicate/);
  });
  it('rejects a languages array that filters down to nothing', () => {
    expect(() => loadPool(poolEnv([{ ...CLOUD_PRIMARY, languages: [1, 2] }]))).toThrow(/no usable string/);
  });
  // ── SSOT `2026-08-02-o5-pool-schema-final.md` §2-S1/S2/S3 ──────────────────
  it("🔴 rejects `region: null` BY NAME — it is not a spelling of 「unrestricted」", () => {
    // tierOf compares with ===, so null matches neither the request nor
    // REGION_ANY: the ops table says 「serves everyone」 and the router excludes the
    // route entirely. Coercing it to '*' would be kinder and worse — both
    // spellings would survive, which is what the SSOT exists to prevent.
    expect(() => loadPool(poolEnv([{ ...CLOUD_PRIMARY, region: null }]))).toThrow(/silently unselectable/);
  });

  it('rejects an UPPERCASE region — 「CN」 and 「cn」 both look legal to a human', () => {
    expect(() => loadPool(poolEnv([{ ...CLOUD_PRIMARY, region: 'CN' }]))).toThrow(/LOWERCASE/);
  });

  it('🔴 rejects a CONCRETE region: it could never be selected today, and a dead route parses like a live one', () => {
    expect(() => loadPool(poolEnv([{ ...CLOUD_PRIMARY, region: 'cn' }]))).toThrow(/can never be selected/);
  });

  it("REVERSE CONTROL for the above: if a concrete region DID get in, tierOf excludes it outright", () => {
    // The SSOT asks for this pin explicitly (§2-S3):「if it gets selected instead, I misread it」.
    // Built by hand, bypassing the parser, so the ALGORITHM is what is measured.
    const dead = { ...loadPool(poolEnv([CLOUD_PRIMARY])).pool[0]!, region: 'cn' };
    const pool = {
      pool: [dead], routingOf: () => null,
      defaultGroupId: 'default', region: REGION_ANY, source: 'pool-env' as const,
    };
    const { selection } = resolvePoolRouting(pool, 'zh');
    expect(selection.outcome).toBe('refused');
    if (selection.outcome !== 'refused') throw new Error('unreachable');
    // Excluded from the CANDIDATE SET, not ranked last.
    expect(selection.code).toBe('POOL_NO_CANDIDATE');
  });

  it("🔴 rejects `zh-CN` in languages — the wire key is BARE `source_lang`", () => {
    // 🔴 This is where the SSOT §2-S5 is WRONG and it is deliberately not
    // followed: it pins the whitelist to engine-presets' `language_hint`
    // ('zh-CN'), but `language_hint` has zero runtime consumers and the phone
    // only ever sends kSpokenLangs = ['zh','en','ja','ko']. A 'zh-CN' row would
    // be unselectable in exactly the silent way §2-S1 warns about for region.
    expect(() => loadPool(poolEnv([{ ...CLOUD_PRIMARY, languages: ['zh-CN'] }])))
      .toThrow(/BARE ISO 639-1/);
    // positive control: the vocabulary the phone actually sends is accepted.
    expect(() => loadPool(poolEnv([{ ...CLOUD_PRIMARY, languages: ['zh', 'en', 'ja', 'ko'] }]))).not.toThrow();
  });

  it('derives `streaming` from the ONE definition, not a second table', () => {
    const pool = loadPool(poolEnv([CLOUD_PRIMARY, BATCH_BACKUP]));
    expect(pool.pool.find((r) => r.id === 'cloud-primary')?.streaming).toBe(true);
    expect(pool.pool.find((r) => r.id === 'batch-backup')?.streaming).toBe(false);
  });
});

/* ── ⑤ liveness: the settle window is the whole point ─────────────────────── */

describe('pool-health: an in-band refusal must not read as a healthy handshake', () => {
  /** An engine that opens cleanly and only THEN says no — exactly what the live
   *  Soniox service does (open() resolves, refusal lands ~285 ms later). */
  class LateRefuser extends EventEmitter {
    readonly id = 'soniox' as const;
    state = 'closed' as const;
    constructor(private readonly delayMs: number, private readonly err: SttEngineError) { super(); }
    async open(): Promise<void> {
      setTimeout(() => this.emit('error', this.err), this.delayMs);
    }
    push(): void {}
    async flush(): Promise<void> {}
    async close(): Promise<void> {}
  }

  it('🔴 catches a refusal that arrives AFTER open() resolves', async () => {
    const factory: EngineFactory = () =>
      new LateRefuser(60, new SttEngineError('STT_ENGINE_AUTH_FAIL', '[organization_balance_exhausted] no funds', false)) as unknown as SttEngine;
    const v = await probeRouteLiveness(factory, { language: '*', engine_id: 'soniox' }, 'zh', { settleMs: 500 });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('STT_ENGINE_AUTH_FAIL');
    expect(v.fatal).toBe(true);
    expect(v.message).toContain('organization_balance_exhausted');
  });

  it('REVERSE CONTROL: with settleMs=0 the very same route probes GREEN', async () => {
    // This is the `http/probe-routes.ts` handshake behaviour, reproduced. It is
    // why that probe cannot be reused as a Soniox health signal — REPORTED to
    // the lane that owns that file, not edited here.
    const factory: EngineFactory = () =>
      new LateRefuser(60, new SttEngineError('STT_ENGINE_AUTH_FAIL', 'no funds', false)) as unknown as SttEngine;
    const v = await probeRouteLiveness(factory, { language: '*', engine_id: 'soniox' }, 'zh', { settleMs: 0 });
    expect(v.ok, 'a handshake-only probe reports OK for an account that cannot transcribe a word').toBe(true);
  });

  it('a 429 does NOT evict the route — only fatal codes do', async () => {
    const factory: EngineFactory = () =>
      new LateRefuser(20, new SttEngineError('STT_ENGINE_RATE_LIMITED', 'rpm', true)) as unknown as SttEngine;
    const v = await probeRouteLiveness(factory, { language: '*', engine_id: 'soniox' }, 'zh', { settleMs: 300 });
    expect(v.ok).toBe(false);
    expect(v.fatal).toBe(false);
    expect(ROUTE_FATAL_CODES.has('STT_ENGINE_RATE_LIMITED')).toBe(false);

    const reg = makeRouteHealthRegistry({ factory });
    reg.record('cloud-primary', v);
    expect(reg.isAvailable({ id: 'cloud-primary' } as never)).toBe(true);
  });

  it('a fatal verdict evicts the route and says so', async () => {
    const reg = makeRouteHealthRegistry({ factory: (() => { throw new Error('unused'); }) as EngineFactory });
    reg.record('cloud-primary', { ok: false, code: 'STT_ENGINE_AUTH_FAIL', message: 'x', fatal: true, elapsed_ms: 1 });
    expect(reg.isAvailable({ id: 'cloud-primary' } as never)).toBe(false);
    reg.record('cloud-primary', { ok: true, code: null, message: '', fatal: false, elapsed_ms: 1 });
    expect(reg.isAvailable({ id: 'cloud-primary' } as never)).toBe(true);
  });

  it('an unmeasured route is available — 「unmeasured」is not「broken」', () => {
    const reg = makeRouteHealthRegistry({ factory: (() => { throw new Error('unused'); }) as EngineFactory });
    expect(reg.isAvailable({ id: 'never-probed' } as never)).toBe(true);
  });
});

/* ── ⑥ 🔴 THE WILDCARD TRAP — found by wiring, not by reading ─────────────── */

describe('🔴 「all languages」 loses to any route that names the language — priority cannot save it', () => {
  // TWO RULES THAT ARE EACH CORRECT AND TOGETHER PRODUCE A SURPRISE:
  //   · owner ⑧ (2026-08-02): production MUST prefer SONIOX; the backup switches only when it cannot be used.
  //   · owner ② (2026-08-02): first Soniox route initial config = all regions + all languages.
  //   · select-route.ts Q4 (MANDATORY): an exact language match BEATS the
  //     wildcard, implemented as tier STRATIFICATION — the wildcard tier is only
  //     consulted after the exact tier is exhausted, so a wildcard route with the
  //     best priority and lowest price STILL cannot outrank an exact match.
  // ⇒ Configure Soniox as 「all languages」 and give the FunASR backup an explicit
  //    `['zh', ...]`, and every Chinese session goes to the BACKUP. Forever.
  //    Not as a failover — as the intended route. `failover` is null, nothing is
  //    logged as unusual, and the platform quietly never uses the vendor it pays
  //    for. That is a silent outcome produced by two rules that are both right.
  //
  // NOT A BUG IN `select-route.ts` — Q4 is owner's mandatory rule and it exists
  // for a good reason (one lazily-configured universal route otherwise swallows
  // the whole table). It is a CONFIGURATION hazard, and this test exists so the
  // ops console's route form is written knowing about it.
  // 📌 Registered for the ops/pool lane: the Soniox route should carry its REAL
  //    language list (the live `/v1/models` response for `stt-rt-v5` lists 60
  //    codes, zh and en among them), not the wildcard.

  it('demonstrates it: wildcard primary + exact backup ⇒ the BACKUP is the intended route', () => {
    const pool = loadPool(poolEnv([
      { ...CLOUD_PRIMARY, languages: ['*'], priority: 0 },   // 「all languages」, best priority
      { ...LOCAL_BACKUP, languages: ['zh'], priority: 999 }, // explicit, worst priority
    ]));
    const { selection } = resolvePoolRouting(pool, 'zh');
    if (selection.outcome !== 'selected') throw new Error('expected a selection');
    expect(selection.route.id).toBe('local-backup');
    expect(selection.tier).toBe('language-exact/region-exact');
    // 🔴 And it is NOT reported as a failover — because it is not one. Nothing
    // in the logs would ever say the paid vendor is being skipped.
    expect(selection.failover).toBeNull();
  });

  it('the fix is configuration: give the paid route its real language list', () => {
    const pool = loadPool(poolEnv([
      { ...CLOUD_PRIMARY, languages: ['zh', 'en'], priority: 0 },
      { ...LOCAL_BACKUP, languages: ['zh'], priority: 999 },
    ]));
    const { selection } = resolvePoolRouting(pool, 'zh');
    if (selection.outcome !== 'selected') throw new Error('expected a selection');
    expect(selection.route.id).toBe('cloud-primary');   // same tier ⇒ priority decides
    expect(selection.ranked_route_ids).toEqual(['cloud-primary', 'local-backup']);
  });

  it('a language NOT on the paid route still falls to the wildcard tier, as designed', () => {
    const pool = loadPool(poolEnv([
      { ...CLOUD_PRIMARY, languages: ['zh', 'en'], priority: 0 },
      { ...LOCAL_BACKUP, languages: ['*'], priority: 999 },
    ]));
    const { selection } = resolvePoolRouting(pool, 'ja');
    if (selection.outcome !== 'selected') throw new Error('expected a selection');
    expect(selection.route.id).toBe('local-backup');
    expect(selection.tier).toBe('language-any/region-exact');
  });
});
