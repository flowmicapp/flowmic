// WP-R1-4: three-source scenario resolution + app-category map + llm.config
// resolution. This file is scenario.card's FIRST production reader (anti-façade)
// and exercises the fail-loud contract (bad card throws, not silently skipped).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// 🔴 OSS-DEFAULTS (0.3.0): a STOCK install seeds `builtin-sherpa-local` and NO
// `llm.config` at all, so the assertions below — which are about LLM config PRECEDENCE (who wrote the row) and not
// about what ships as the default — name the presets they need, exactly the way
// a deployment does in `/etc/flowmic-app/env`. The values are the pre-card
// defaults verbatim, so what these tests measure is unchanged.
const OSS_DEFAULTS_PRESET_ENVS: Record<string, string> = {
  FLOWMIC_DEFAULT_STT_ZH_PRESET: 'lan-funasr-ws',
  FLOWMIC_DEFAULT_STT_WILDCARD_PRESET: 'lan-sensevoice',
  FLOWMIC_DEFAULT_LLM_PRESET: 'lan-vllm-qwen35',
};
const ossDefaultsSaved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [k, v] of Object.entries(OSS_DEFAULTS_PRESET_ENVS)) {
    ossDefaultsSaved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterEach(() => {
  for (const k of Object.keys(OSS_DEFAULTS_PRESET_ENVS)) {
    if (ossDefaultsSaved[k] === undefined) delete process.env[k];
    else process.env[k] = ossDefaultsSaved[k];
  }
});

import { composeDictionary, SETTINGS_KEY_SCENARIO_CARD } from '@flowmic/protocol';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { ServerError } from '../src/errors';
import { seedDefaultSettings } from '../src/settings/defaults';
import {
  resolveScenarioContext,
  buildScenarioBlock,
  resolveLlmConfigWithSource,
  resolveByokLlm,
  managedLlmConfig,
  isByokLlm,
  appCategoryFor,
  appCategoryDescriptor,
  type LlmConfigSource,
} from '../src/compose';

function freshDb(): DbConnection {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('scenario-test-secret-key') });
  db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
  return db;
}
const U = 'u1';

describe('app-category map (scenario source ②) — app NAME only, unmapped → undefined', () => {
  it('maps editors / terminals → coding', () => {
    for (const p of ['Code', 'code - insiders', 'cursor', 'WindowsTerminal', 'pwsh', 'devenv']) {
      expect(appCategoryFor(p)).toBe('coding');
    }
  });
  it('maps Outlook → email, WeChat / Slack → chat', () => {
    expect(appCategoryFor('OUTLOOK')).toBe('email');
    expect(appCategoryFor('WeChat')).toBe('chat');
    expect(appCategoryFor('Slack')).toBe('chat');
  });
  it('unmapped / absent → undefined (no guess)', () => {
    expect(appCategoryFor('explorer')).toBeUndefined();
    expect(appCategoryFor('chrome')).toBeUndefined();
    expect(appCategoryFor(undefined)).toBeUndefined();
    expect(appCategoryDescriptor('explorer')).toBeUndefined();
    expect(appCategoryDescriptor('Code')).toContain('code editor');
  });
});

describe('settings-key-drift anchor pin', () => {
  it('the scenario.card SSOT constant equals the literal used at both drift anchors', () => {
    // scenario-context.ts reads via readSetting('scenario.card') and the mobile
    // writes via updateSetting('scenario.card'); this pins that literal == the
    // SSOT constant so the two lint anchors can never silently drift apart.
    expect(SETTINGS_KEY_SCENARIO_CARD).toBe('scenario.card');
  });
});

describe('resolveScenarioContext — merges the three sources', () => {
  it('absent card → empty context (valid, yields no block)', () => {
    const db = freshDb();
    const ctx = resolveScenarioContext(db.settings, U);
    expect(ctx).toEqual({ professions: [], domains: [], terms: [] });
    expect(buildScenarioBlock(ctx)).toBe('');
  });

  it('card fields + packs + stt.dictionary all flow into terms (deduped)', () => {
    const db = freshDb();
    db.settings.write(U, SETTINGS_KEY_SCENARIO_CARD, {
      professions: ['software engineer'],
      domains: ['databases'],
      packs: ['tech-dev'],
      terms: ['FlowMic', 'API'], // 'API' also in tech-dev → dedupe proof
    });
    db.settings.write(U, 'stt.dictionary', [{ term: 'gRPC', weight: 25 }, { term: 'FlowMic' }]);

    // Source ② now arrives as an already-resolved descriptor (V2-08/F2): the
    // override>builtin>inferred decision moved to ScenarioInferenceStore, and
    // this function takes the verdict as data. The end-to-end proof that the
    // store really feeds it lives in compose-orchestrator / compose-scenario-
    // infer-store.
    const ctx = resolveScenarioContext(db.settings, U, {
      descriptor: appCategoryDescriptor('Code') as string,
      source: 'builtin',
    });
    expect(ctx.professions).toEqual(['software engineer']);
    expect(ctx.domains).toEqual(['databases']);
    expect(ctx.appContext).toContain('code editor');
    // packs expanded via composeDictionary
    for (const e of composeDictionary(['tech-dev'])) expect(ctx.terms).toContain(e.term);
    expect(ctx.terms).toContain('FlowMic');
    expect(ctx.terms).toContain('gRPC');
    // dedupe: 'FlowMic' and 'API' appear once each
    expect(ctx.terms.filter((t) => t === 'FlowMic')).toHaveLength(1);
    expect(ctx.terms.filter((t) => t === 'API')).toHaveLength(1);
  });

  it('present-but-malformed card FAILS LOUD (not silently skipped)', () => {
    const db = freshDb();
    // professions must be an array of strings — a number is invalid.
    db.settings.write(U, SETTINGS_KEY_SCENARIO_CARD, { professions: [42], domains: [], packs: [], terms: [] });
    let thrown: unknown;
    try { resolveScenarioContext(db.settings, U); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ServerError);
    expect((thrown as ServerError).code).toBe('SETTINGS_SCHEMA_INVALID');
  });

  it('stt.dictionary of the wrong shape contributes no terms (hint source, not a schema gate)', () => {
    const db = freshDb();
    db.settings.write(U, 'stt.dictionary', 'not-an-array');
    const ctx = resolveScenarioContext(db.settings, U);
    expect(ctx.terms).toEqual([]);
  });
});

describe('resolveLlmConfigWithSource — inline, preset overlay, byok, fail-loud', () => {
  it('reads a full inline config and decrypts the api_key on the way (repo path)', () => {
    const db = freshDb();
    db.settings.write(U, 'llm.config', { protocol: 'openai-compatible', endpoint: 'http://100.64.7.179:8000/v1', api_key: 'EMPTY', model: 'Qwen3.5-4B' });
    const selected = resolveLlmConfigWithSource(db.settings, U);
    expect(selected.cfg).toEqual({ protocol: 'openai-compatible', endpoint: 'http://100.64.7.179:8000/v1', api_key: 'EMPTY', model: 'Qwen3.5-4B' });
    expect(selected.source).toBe('user');
    expect(resolveByokLlm(selected)).toBe(false); // 'EMPTY' is the platform sentinel
  });

  it('resolves a preset_id via engine-presets and overlays explicit fields', () => {
    const db = freshDb();
    db.settings.write(U, 'llm.config', { preset_id: 'lan-ollama-gemma3', model: 'gemma3:27b' });
    const cfg = resolveLlmConfigWithSource(db.settings, U).cfg;
    expect(cfg.protocol).toBe('openai-compatible');
    expect(cfg.endpoint).toBe('http://100.64.7.68:11434/v1');
    expect(cfg.model).toBe('gemma3:27b'); // explicit override wins
  });

  it('a user-supplied key is BYOK (never metered)', () => {
    const db = freshDb();
    db.settings.write(U, 'llm.config', { protocol: 'anthropic', endpoint: 'https://api.anthropic.com', api_key: 'user-byok-secret-123', model: 'claude-sonnet-4-5' });
    expect(resolveByokLlm(resolveLlmConfigWithSource(db.settings, U))).toBe(true);
  });

  it('missing llm.config fails loud with a whitelisted code', () => {
    const db = freshDb();
    let thrown: unknown;
    try { resolveLlmConfigWithSource(db.settings, U); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ServerError);
    expect((thrown as ServerError).code).toBe('LLM_INVALID_MODEL');
  });

  it('a malformed config (unknown protocol) fails loud', () => {
    const db = freshDb();
    db.settings.write(U, 'llm.config', { protocol: 'grok-native', endpoint: 'http://x', api_key: '', model: 'm' });
    expect(() => resolveLlmConfigWithSource(db.settings, U)).toThrow(ServerError);
  });
});

// ── M4: the BYOK judgement is by PROVENANCE, not by key shape ────────────────
//
// Card M4 (0.3.0). The judgement used to ask 「is there a key」 (isByokLlm on a bare
// LlmConfig). A platform key is non-empty and is not the 'EMPTY' sentinel, so the
// moment the platform's own DeepSeek key reached an LLM call the platform's own
// traffic was classified BYOK ⇒ recordLlmUsage early-returned ⇒ no usage_records
// row was ever written ⇒ the quota valve read used=0 forever = unmetered spend.
//
// The STT side had already closed this exact hole by PROVENANCE
// (stt/engine-factory.ts resolveByok: `selected.source !== 'user'`); these pin the
// mirrored shape on the LLM side so it cannot regress to a key-shape test.

describe('M4 — a platform managed-default LLM key is NEVER BYOK', () => {
  const MANAGED_ENV = {
    FLOWMIC_MANAGED_LLM_ENABLED: '1',
    FLOWMIC_MANAGED_LLM_PROTOCOL: 'openai-compatible',
    FLOWMIC_MANAGED_LLM_ENDPOINT: 'https://api.deepseek.com/v1',
    FLOWMIC_MANAGED_LLM_MODEL: 'deepseek-chat',
    // A real-looking PLATFORM key: long, non-empty, and not the sentinel — i.e.
    // indistinguishable from a user key BY SHAPE. That is the whole point.
    FLOWMIC_MANAGED_LLM_API_KEY: 'sk-platform-account-key-0123456789',
  } as NodeJS.ProcessEnv;

  it('precondition: the managed default really does carry a NON-EMPTY, non-sentinel key', () => {
    const managed = managedLlmConfig(MANAGED_ENV);
    expect(managed).not.toBeNull();
    expect(managed!.api_key.length).toBeGreaterThan(0);
    expect(managed!.api_key).not.toBe('EMPTY');
    // 🔴 The negative control that names the bug: the OLD shape-only judgement
    // calls this platform key BYOK. If this ever flips to false the bug fixed
    // itself for a different reason and the test below stops proving anything.
    expect(isByokLlm(managed!)).toBe(true);
  });

  it('a config selected from the managed default is NOT BYOK (source beats shape)', () => {
    const db = freshDb(); // no llm.config row at all → the managed default answers
    const selected = resolveLlmConfigWithSource(db.settings, U, () => managedLlmConfig(MANAGED_ENV));
    expect(selected.source).toBe('managed-default');
    expect(selected.cfg.endpoint).toBe('https://api.deepseek.com/v1');
    expect(resolveByokLlm(selected)).toBe(false); // ⇒ metered, quota-counted
  });

  it('positive control: the SAME key shape supplied by the USER is still BYOK', () => {
    // Without this the test above could pass by an implementation that returns
    // false for everything — 「nothing is ever BYOK」 would waive nobody's own key.
    const db = freshDb();
    db.settings.write(U, 'llm.config', { protocol: 'openai-compatible', endpoint: 'https://api.deepseek.com/v1', api_key: 'sk-platform-account-key-0123456789', model: 'deepseek-chat' });
    const selected = resolveLlmConfigWithSource(db.settings, U, () => managedLlmConfig(MANAGED_ENV));
    expect(selected.source).toBe('user');
    expect(resolveByokLlm(selected)).toBe(true);
  });

  it('a corrupt USER row still fails loud — the managed default never covers for it', () => {
    // Silently substituting the platform engine for a corrupt user config would
    // mask the corruption AND move the user's traffic onto our account.
    // ⚠️ 0.3.0 W1 widened WHEN the managed default is consulted (absent row OR a
    // seeded one), but not this: an unmarked row is the user's own, and a broken
    // one throws. The row below carries no provenance marker, which is what makes
    // it a user row — see settings/provenance.ts on why absence means `user`.
    const db = freshDb();
    db.settings.write(U, 'llm.config', { protocol: 'grok-native', endpoint: 'http://x', api_key: '', model: 'm' });
    expect(() => resolveLlmConfigWithSource(db.settings, U, () => managedLlmConfig(MANAGED_ENV))).toThrow(ServerError);
  });

  it('managedLlmConfig is OFF unless explicitly enabled, and an enabled-but-invalid config throws', () => {
    expect(managedLlmConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(managedLlmConfig({ FLOWMIC_MANAGED_LLM_ENABLED: '0' } as NodeJS.ProcessEnv)).toBeNull();
    // Enabled but unusable ⇒ fail loud, never a silent skip (red line: no silent failure).
    expect(() => managedLlmConfig({ FLOWMIC_MANAGED_LLM_ENABLED: '1' } as NodeJS.ProcessEnv)).toThrow();
    expect(() => managedLlmConfig({ ...MANAGED_ENV, FLOWMIC_MANAGED_LLM_MODEL: undefined } as NodeJS.ProcessEnv)).toThrow();
  });

  it('every source value has a decided BYOK answer (no third state, no default-true)', () => {
    // 🔴 This list is the exhaustiveness check for LlmConfigSource, so a value added
    // to the union without a decided BYOK answer shows up HERE. `'seed'` was added
    // 2026-08-06 and answers false: a seeded row's key came from a preset, never
    // from the user. Note that all three answers are pinned, not just the new one —
    // a list that only grows at the end stops being a control.
    const sources: LlmConfigSource[] = ['user', 'seed', 'managed-default'];
    const cfg = { protocol: 'openai-compatible', endpoint: 'http://x/v1', api_key: 'sk-real-looking-key', model: 'm' } as const;
    expect(sources.map((source) => resolveByokLlm({ cfg, source }))).toEqual([true, false, false]);
  });

  // 🔴 THIS TEST USED TO ASSERT THE OPPOSITE, AND IT WAS RIGHT AT THE TIME.
  //
  // Until 2026-08-06 it read「REACHABILITY: a seeded account resolves to `user`
  // even with the managed default enabled」and it pinned the honest limit of M4:
  // every account is born with a seeded `llm.config` row, that row was
  // indistinguishable from one the user had authored, so this resolver always
  // answered 'user' and the managed-default arm never ran for anybody. Its own
  // comment said it was「deliberately written to FAIL the day someone changes the
  // seeding or the precedence」— and that is exactly how it behaved: it was the one
  // red test when the provenance marker landed. It did its job.
  //
  // What changed is the precedence, and 0.3.0 W1 is the day it was meant to catch.
  // Seeded rows now carry a marker and rank BELOW the managed default, so the arm
  // is reachable. Rewritten rather than deleted: the failure this file exists to
  // prevent (a platform key billed as the user's own) is unchanged, and the pair
  // below is what keeps it pinned in BOTH directions.
  it('REACHABILITY: a seeded account now resolves to the managed default when one is enabled', () => {
    const db = freshDb();
    const keys = seedDefaultSettings(db.settings, U);
    expect(keys).toContain('llm.config'); // positive control: seeding really wrote it

    const selected = resolveLlmConfigWithSource(db.settings, U, () => managedLlmConfig(MANAGED_ENV));
    expect(selected.source).toBe('managed-default');
    expect(selected.cfg.endpoint).toBe('https://api.deepseek.com/v1');
    // The money property is the same one this describe block has always asserted:
    // our key is never the user's key, however real it looks.
    expect(resolveByokLlm(selected)).toBe(false);
  });

  it('…and falls back to the SEEDED row when no managed default is configured', () => {
    // The other half, without which the test above is satisfied by「managed default
    // always wins」— which would break every self-hosted build and every deployment
    // that has not enabled it. The seeded LAN engine must still answer.
    const db = freshDb();
    seedDefaultSettings(db.settings, U);

    const selected = resolveLlmConfigWithSource(db.settings, U, () => managedLlmConfig({} as NodeJS.ProcessEnv));
    expect(selected.source).toBe('seed');
    expect(selected.cfg.endpoint).not.toBe('https://api.deepseek.com/v1');
    expect(selected.cfg.model).toBe('/mnt/nvme-data/vllm-work/models/Qwen3.5-4B');
    // Today's seeded preset carries the 'EMPTY' sentinel, so it was already metered
    // before provenance existed. It is now metered for the RIGHT reason (whose row
    // it is), which is what keeps it false if the seed ever gains a real key.
    expect(selected.cfg.api_key).toBe('EMPTY');
    expect(resolveByokLlm(selected)).toBe(false);
  });
});
