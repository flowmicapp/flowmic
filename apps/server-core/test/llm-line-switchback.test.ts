// FB-11 (LLM half) — THE SWITCHBACK (switch-back): the LLM equivalent of the STT side's
// FLOWMIC_MANAGED_STT_ENABLED 0/1 proven in BOTH directions.
//
// The W1 ledger (docs/strategy/2026-08-06-w1-engine-switch-ledger.md §10-E-1)
// records the LLM line as "only switched over, never switched back" — the switch TO the managed line was
// proven, the switch BACK to the backup line was not. The forward+back+user cases
// are already unit-covered in settings-provenance.test.ts; what this file adds is a
// FOCUSED, isolated pin of the switch-back direction with a WATCHED reverse control, since
// that file's own reverse-control note (its tail) is about the STT re-ranking, not
// the LLM fall-through.
//
// Isolated over a minimal fake SettingsRepo (resolveLlmConfigWithSource only calls
// `read`), so the switch logic is under test without a DB and the reverse control is
// crisp. The managed↔backup switch itself is the env gate FLOWMIC_MANAGED_LLM_ENABLED
// 0/1 that llm-config.ts's managedLlmConfig implements — production has NO LLM pool
// (§5 / the DeepSeek-lineup decision §2: "do not pre-build a full pool model for two lines"), so this env
// gate + the resolver's fall-through IS the whole main/backup mechanism.
//
// ── THE REVERSE CONTROL, watched (CLAUDE.md "a reverse control only counts if it has actually been seen red") ────────
// Watched go red on 2026-08-09 (dev-pc-b): in src/compose/llm-config.ts
// resolveLlmConfigWithSource, changing the fall-through guard
//     if (row === null) throw new ServerError('LLM_INVALID_MODEL', …);
// to
//     if (row === null || seeded) throw new ServerError('LLM_INVALID_MODEL', …);
// (i.e. deleting the "switch-back to the seeded backup line when the managed default is
// off" path) turns the "managed OFF ⇒ falls back to seed" case below RED — it throws
// instead of resolving the backup line — while the "managed ON ⇒ managed-default"
// case stays green (proving the assertion distinguishes the two directions). A
// second, independent break — `const seeded = false` — reds the "managed ON ⇒
// managed-default" case instead. Both restored; residue grep = 0.

import { describe, expect, it } from 'vitest';
import { resolveLlmConfigWithSource, resolveByokLlm, managedLlmConfig } from '../src/compose/llm-config';
import { PROVENANCE_FIELD, SEED_PROVENANCE } from '../src/settings/provenance';
import type { SettingRow, SettingsRepo } from '../src/db/repos/settings.repo';
import { ServerError } from '../src/errors';

const U = 'u1';

/** A repo that answers `read(_, 'llm.config')` with one fixed row (or null).
 *  resolveLlmConfigWithSource touches only `read`; the rest is never reached. */
function repoWith(value: unknown | null): SettingsRepo {
  const row: SettingRow | null = value === null
    ? null
    : { user_id: U, key: 'llm.config', value, updated_at: '2026-08-09T00:00:00.000Z' };
  return { read: () => row } as unknown as SettingsRepo;
}

/** The seeded backup line (lan-vllm-qwen35 shape), marked as the platform seeder
 *  would mark it — so it defers to the managed default but wins when it is off. */
const SEED_BACKUP = {
  protocol: 'openai-compatible',
  endpoint: 'http://100.64.7.179:8000/v1',
  api_key: 'EMPTY',
  model: 'Qwen3.5-4B',
  [PROVENANCE_FIELD]: SEED_PROVENANCE,
};

/** The managed DeepSeek line env (mirrors settings-provenance.test.ts). */
const MANAGED_LLM_ENV = {
  FLOWMIC_MANAGED_LLM_ENABLED: '1',
  FLOWMIC_MANAGED_LLM_PROTOCOL: 'openai-compatible',
  FLOWMIC_MANAGED_LLM_ENDPOINT: 'https://api.deepseek.com/v1',
  FLOWMIC_MANAGED_LLM_MODEL: 'deepseek-chat',
  FLOWMIC_MANAGED_LLM_API_KEY: 'sk-platform-account-key-0123456789',
} as NodeJS.ProcessEnv;

const managedOn = (): ReturnType<typeof managedLlmConfig> => managedLlmConfig(MANAGED_LLM_ENV);
const managedOff = (): ReturnType<typeof managedLlmConfig> => managedLlmConfig({} as NodeJS.ProcessEnv);

describe('FB-11 · managed LLM line switch (switch-back), both directions', () => {
  it('SWITCH TO — managed ON ⇒ the seeded backup defers to the DeepSeek line', () => {
    const sel = resolveLlmConfigWithSource(repoWith(SEED_BACKUP), U, managedOn);
    expect(sel.source).toBe('managed-default');
    expect(sel.cfg.endpoint).toBe('https://api.deepseek.com/v1');
    expect(sel.cfg.model).toBe('deepseek-chat');
    // Positive control: the seeded backup really is present and really would have
    // answered — so "managed won" cannot secretly mean "the row failed to load".
    expect(resolveLlmConfigWithSource(repoWith(SEED_BACKUP), U, managedOff).source).toBe('seed');
  });

  it('SWITCH BACK (switch-back) — managed OFF ⇒ falls back to the seeded backup line, still usable', () => {
    const sel = resolveLlmConfigWithSource(repoWith(SEED_BACKUP), U, managedOff);
    expect(sel.source).toBe('seed');
    expect(sel.cfg.endpoint).toBe('http://100.64.7.179:8000/v1');
    expect(sel.cfg.model).toBe('Qwen3.5-4B');
    // The marker never leaks into the outbound config (validate rebuilds 4 fields).
    expect(Object.keys(sel.cfg).sort()).toEqual(['api_key', 'endpoint', 'model', 'protocol']);
    // A backup line on the platform's own preset is NOT billed as the user's key.
    expect(resolveByokLlm(sel)).toBe(false);
  });

  it('a REAL user row beats BOTH — the switch never overrides a choice somebody made', () => {
    const userRow = { protocol: 'openai-compatible', endpoint: 'https://mine/v1', api_key: 'sk-mine', model: 'm' };
    const sel = resolveLlmConfigWithSource(repoWith(userRow), U, managedOn);
    expect(sel.source).toBe('user');
    expect(sel.cfg.endpoint).toBe('https://mine/v1');
    expect(resolveByokLlm(sel)).toBe(true);
  });

  it('no row at all + managed OFF ⇒ fail loud (no silent default endpoint)', () => {
    expect(() => resolveLlmConfigWithSource(repoWith(null), U, managedOff)).toThrow(ServerError);
  });

  it('no row at all + managed ON ⇒ the managed line (a fresh account before its seed)', () => {
    const sel = resolveLlmConfigWithSource(repoWith(null), U, managedOn);
    expect(sel.source).toBe('managed-default');
    expect(sel.cfg.endpoint).toBe('https://api.deepseek.com/v1');
  });
});
