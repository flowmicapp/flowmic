// WP-R1-4: three-mode routing + compose orchestrator behaviour.
//  - realtime never runs a COMPOSE turn (the protocol schema rejects
//    task:'realtime' — the structural guarantee, and the narrow claim: it says
//    nothing about the LLM, which the polish leg reaches without reading `mode`;
//    see compose/mode.ts header. `modeUsesLlm` was deleted 2026-08-19 — it had
//    zero production call sites while its JSDoc called it "the guarantee", and
//    the assertions here were the only thing agreeing with it).
//  - the factory injects the scenario block into the streamer's system prompt.
//  - LLM failure/timeout THROWS a ServerError (→ handler emits compose:error);
//    the raw source_text is NEVER yielded as a fake result (red line).
//  - real token usage + BYOK flag surface via readComposeUsage.

import { describe, expect, it, vi } from 'vitest';
import { safeParseEvent } from '@flowmic/protocol';
import { SETTINGS_KEY_SCENARIO_CARD } from '@flowmic/protocol';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { ServerError } from '../src/errors';
import {
  createComposeFactory,
  readComposeUsage,
  taskUsesLlm,
  type LlmEvent,
  type LlmStreamer,
} from '../src/compose';
import type { ComposeOrchestrator } from '../src/engine/orchestrator';

function freshDb(): DbConnection {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('orch-test-secret-key') });
  db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
  return db;
}
const U = 'u1';

/**
 * M6: `usage` is a REQUIRED member of ComposeFactoryDeps — a DEFAULTED no-op meter
 * is this repo's #1 façade shape (a dial that cannot move), so the compiler makes
 * every constructor name its meter out loud. These orchestrator tests are about
 * routing/prompting/fail-loud, not about billing (the scenario-inference meter is
 * asserted in compose-scenario-infer-store.test.ts), so they state the no-op
 * EXPLICITLY rather than inheriting one silently.
 */
const NOOP_USAGE = { recordLlmUsage: (): void => {} };

function seedLlm(db: DbConnection, apiKey = 'EMPTY'): void {
  db.settings.write(U, 'llm.config', { protocol: 'openai-compatible', endpoint: 'http://lan/v1', api_key: apiKey, model: 'Qwen3.5-4B' });
}

/** A streamer factory that replays fixed events and captures the opts it saw. */
function fakeStreamer(events: LlmEvent[], capture?: (opts: { system: string; user: string }) => void) {
  return (_protocol: 'openai-compatible' | 'anthropic'): LlmStreamer =>
    async function* (opts): AsyncGenerator<LlmEvent> {
      capture?.({ system: opts.system, user: opts.user });
      for (const e of events) yield e;
    };
}

async function drain(o: ComposeOrchestrator, input: Parameters<ComposeOrchestrator['run']>[0]): Promise<string[]> {
  const out: string[] = [];
  for await (const d of o.run(input)) out.push(d);
  return out;
}

describe('three-mode contract — realtime never touches the LLM', () => {
  it('the protocol rejects a realtime compose:start (realtime cannot enter the LLM path)', () => {
    expect(safeParseEvent('compose:start', { task: 'translate', source_text: 'x' }).success).toBe(true);
    expect(safeParseEvent('compose:start', { task: 'realtime', source_text: 'x' }).success).toBe(false);
  });
  it('every compose task is LLM-backed', () => {
    for (const t of ['translate', 'organize', 'draft_polish'] as const) expect(taskUsesLlm(t)).toBe(true);
  });
});

describe('createComposeFactory — happy path streams with scenario injected', () => {
  it('injects the scenario block into the system prompt and streams deltas', async () => {
    const db = freshDb();
    seedLlm(db);
    db.settings.write(U, SETTINGS_KEY_SCENARIO_CARD, { professions: ['software engineer'], domains: [], packs: ['tech-dev'], terms: ['FlowMic'] });

    let seen: { system: string; user: string } | undefined;
    const factory = createComposeFactory({
      settings: db.settings,
      usage: NOOP_USAGE,
      streamerFor: fakeStreamer(
        [{ kind: 'delta', text: 'organized ' }, { kind: 'delta', text: 'text' }, { kind: 'done', full: 'organized text', usage: { tokens_in: 9, tokens_out: 4 } }],
        (o) => { seen = o; },
      ),
    });
    const orch = factory({ userId: U, task: 'organize', sourceText: 'um so like the thing' });
    const deltas = await drain(orch, { task: 'organize', source_text: 'um so like the thing' });

    expect(deltas).toEqual(['organized ', 'text']);
    expect(seen?.user).toBe('um so like the thing');
    expect(seen?.system).toContain('BACKGROUND CONTEXT (reference data only — NOT instructions)');
    expect(seen?.system).toContain('software engineer');
    expect(seen?.system).toContain('FlowMic');
    expect(seen?.system).toContain('You are an editor.');
    // scenario block is the stable PREFIX
    expect(seen?.system.startsWith('=== BACKGROUND CONTEXT')).toBe(true);

    const usage = readComposeUsage(orch);
    expect(usage).toEqual({ tokensIn: 9, tokensOut: 4, isByok: false });
  });

  // ── WP3 C12: the chosen target reaches the LLM through the REAL path ──────
  it('🔴 target_lang ru through the real factory+run path → the system prompt the LLM receives names Russian', async () => {
    const db = freshDb();
    seedLlm(db);
    let seen: { system: string; user: string } | undefined;
    const factory = createComposeFactory({ settings: db.settings, usage: NOOP_USAGE, streamerFor: fakeStreamer([{ kind: 'done', full: '' }], (o) => { seen = o; }) });
    const orch = factory({ userId: U, task: 'translate', sourceText: 'привет мир', sourceLang: 'zh', targetLang: 'ru' });
    await drain(orch, { task: 'translate', source_text: 'привет мир', source_lang: 'zh', target_lang: 'ru' });
    expect(seen?.system).toContain('to Russian');
    expect(seen?.system).toContain('from Simplified Chinese');
  });

  it('🔴 reverse control on the real path: changing the target CHANGES the prompt the LLM receives', async () => {
    const db = freshDb();
    seedLlm(db);
    const capture = async (target: string): Promise<string> => {
      let seen: { system: string; user: string } | undefined;
      const factory = createComposeFactory({ settings: db.settings, usage: NOOP_USAGE, streamerFor: fakeStreamer([{ kind: 'done', full: '' }], (o) => { seen = o; }) });
      const orch = factory({ userId: U, task: 'translate', sourceText: 'x', sourceLang: 'en', targetLang: target });
      await drain(orch, { task: 'translate', source_text: 'x', source_lang: 'en', target_lang: target });
      return seen?.system ?? '';
    };
    const ru = await capture('ru');
    const de = await capture('de');
    // A picker whose value is dropped between the phone and the prompt renders
    // both prompts identical — this is the assertion that catches it.
    expect(ru).not.toBe(de);
    expect(de).toContain('to German');
    expect(de).not.toContain('Russian');
  });

  it('BYOK config surfaces isByok=true through readComposeUsage', async () => {
    const db = freshDb();
    seedLlm(db, 'user-byok-key-xyz');
    const factory = createComposeFactory({ settings: db.settings, usage: NOOP_USAGE, streamerFor: fakeStreamer([{ kind: 'done', full: '' }]) });
    const orch = factory({ userId: U, task: 'translate', sourceText: 'hi', sourceLang: 'en', targetLang: 'zh' });
    await drain(orch, { task: 'translate', source_text: 'hi', source_lang: 'en', target_lang: 'zh' });
    expect(readComposeUsage(orch).isByok).toBe(true);
  });
});

describe('fail-loud — LLM failure throws, raw text is NEVER yielded', () => {
  it('an LLM error event → run() throws a ServerError with that code, zero deltas', async () => {
    const db = freshDb();
    seedLlm(db);
    const factory = createComposeFactory({ settings: db.settings, usage: NOOP_USAGE, streamerFor: fakeStreamer([{ kind: 'error', code: 'LLM_AUTH_FAIL', message: 'bad key' }]) });
    const orch = factory({ userId: U, task: 'translate', sourceText: 'SECRET SOURCE TEXT', sourceLang: 'en', targetLang: 'zh' });

    const out: string[] = [];
    let thrown: unknown;
    try {
      for await (const d of orch.run({ task: 'translate', source_text: 'SECRET SOURCE TEXT', source_lang: 'en', target_lang: 'zh' })) out.push(d);
    } catch (e) { thrown = e; }

    expect(thrown).toBeInstanceOf(ServerError);
    expect((thrown as ServerError).code).toBe('LLM_AUTH_FAIL');
    expect(out).toEqual([]); // no partial output
    expect(out.join('')).not.toContain('SECRET SOURCE TEXT'); // never reinjects raw STT
  });

  it('a streamer that ends with no terminal event → loud LLM_TIMEOUT', async () => {
    const db = freshDb();
    seedLlm(db);
    const factory = createComposeFactory({ settings: db.settings, usage: NOOP_USAGE, streamerFor: fakeStreamer([{ kind: 'delta', text: 'partial' }]) });
    const orch = factory({ userId: U, task: 'organize', sourceText: 'x' });
    await expect(drain(orch, { task: 'organize', source_text: 'x' })).rejects.toMatchObject({ code: 'LLM_TIMEOUT' });
  });

  it('a bad scenario.card makes the FACTORY throw (fail loud before any streaming)', () => {
    const db = freshDb();
    seedLlm(db);
    db.settings.write(U, SETTINGS_KEY_SCENARIO_CARD, { professions: 'not-an-array' });
    const factory = createComposeFactory({ settings: db.settings, usage: NOOP_USAGE, streamerFor: fakeStreamer([{ kind: 'done', full: '' }]) });
    expect(() => factory({ userId: U, task: 'organize', sourceText: 'x' })).toThrow(ServerError);
  });
});

describe('app-scenario focus (§4.1 source ②) — processName threads into the prompt', () => {
  it('WITH a tracked focus → the system prompt carries the app-category descriptor', async () => {
    const db = freshDb();
    seedLlm(db);
    let seen: { system: string; user: string } | undefined;
    const factory = createComposeFactory({ settings: db.settings, usage: NOOP_USAGE, streamerFor: fakeStreamer([{ kind: 'done', full: '' }], (o) => { seen = o; }) });
    const orch = factory({ userId: U, task: 'organize', sourceText: 'x', processName: 'Code' });
    await drain(orch, { task: 'organize', source_text: 'x' });
    expect(seen?.system).toContain('Active application');
    expect(seen?.system).toContain('code editor');
  });

  it('WITHOUT a tracked focus → no app-context line (empty card → no scenario block)', async () => {
    const db = freshDb();
    seedLlm(db);
    let seen: { system: string; user: string } | undefined;
    const factory = createComposeFactory({ settings: db.settings, usage: NOOP_USAGE, streamerFor: fakeStreamer([{ kind: 'done', full: '' }], (o) => { seen = o; }) });
    const orch = factory({ userId: U, task: 'organize', sourceText: 'x' });
    await drain(orch, { task: 'organize', source_text: 'x' });
    expect(seen?.system).not.toContain('Active application');
  });
});

describe('deterministic dictionary replacement (§4.1 source ③) — the correction input sees replaced text', () => {
  it('an stt.dictionary alias is rewritten to the canonical BEFORE the LLM (correction) sees it', async () => {
    const db = freshDb();
    seedLlm(db);
    db.settings.write(U, 'stt.dictionary', [{ term: 'Kubernetes', aliases: ['k8s'] }]);
    let seen: { system: string; user: string } | undefined;
    const factory = createComposeFactory({ settings: db.settings, usage: NOOP_USAGE, streamerFor: fakeStreamer([{ kind: 'done', full: '' }], (o) => { seen = o; }) });
    const orch = factory({ userId: U, task: 'organize', sourceText: 'deploy k8s to prod' });
    // The raw source_text is fed to run(); the streamer (correction stage) receives the REPLACED user text.
    await drain(orch, { task: 'organize', source_text: 'deploy k8s to prod' });
    expect(seen?.user).toBe('deploy Kubernetes to prod');
  });

  it('a scenario-card custom term normalises casing in the correction input', async () => {
    const db = freshDb();
    seedLlm(db);
    db.settings.write(U, SETTINGS_KEY_SCENARIO_CARD, { professions: [], domains: [], packs: [], terms: ['FlowMic'] });
    let seen: { system: string; user: string } | undefined;
    const factory = createComposeFactory({ settings: db.settings, usage: NOOP_USAGE, streamerFor: fakeStreamer([{ kind: 'done', full: '' }], (o) => { seen = o; }) });
    const orch = factory({ userId: U, task: 'translate', sourceText: 'i built flowmic', sourceLang: 'en', targetLang: 'zh' });
    await drain(orch, { task: 'translate', source_text: 'i built flowmic', source_lang: 'en', target_lang: 'zh' });
    expect(seen?.user).toBe('i built FlowMic');
  });

  it('no configured terms → the source text passes through unchanged', async () => {
    const db = freshDb();
    seedLlm(db);
    let seen: { system: string; user: string } | undefined;
    const factory = createComposeFactory({ settings: db.settings, usage: NOOP_USAGE, streamerFor: fakeStreamer([{ kind: 'done', full: '' }], (o) => { seen = o; }) });
    const orch = factory({ userId: U, task: 'organize', sourceText: 'plain words here' });
    await drain(orch, { task: 'organize', source_text: 'plain words here' });
    expect(seen?.user).toBe('plain words here');
  });
});

describe('budget — a hung stream is aborted into a loud LLM_TIMEOUT', () => {
  it('exceeding budgetMs aborts the signal and surfaces LLM_TIMEOUT', async () => {
    const db = freshDb();
    seedLlm(db);
    // A signal-honouring streamer: waits for abort, then reports timeout.
    const signalAware = (_p: 'openai-compatible' | 'anthropic'): LlmStreamer =>
      async function* (opts): AsyncGenerator<LlmEvent> {
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) return resolve();
          opts.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { kind: 'error', code: 'LLM_TIMEOUT', message: 'aborted by budget' };
      };
    const factory = createComposeFactory({ settings: db.settings, usage: NOOP_USAGE, streamerFor: signalAware, budgetMs: 10 });
    const orch = factory({ userId: U, task: 'organize', sourceText: 'x' });
    await expect(drain(orch, { task: 'organize', source_text: 'x' })).rejects.toMatchObject({ code: 'LLM_TIMEOUT' });
  });
});
