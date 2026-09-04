// PIPELINE TRACE — end-to-end, through the production compose factory.
//
// This is the anti-façade half of src/trace/pipeline-trace.ts. That module could
// be unit-tested against itself all day and still be wired to nothing; what has
// to be true is that a REAL compose turn, built by the REAL factory the socket
// handler calls, leaves a readable chain on disk. So this test drives
// `createComposeFactory` with a settings repo carrying a real scenario card and
// a real personal dictionary, streams a turn through a fake vendor, and then
// reads the JSONL back and asserts what a human diagnosing "is my card doing
// anything?" would need to find there.
//
// THREE LEVELS, THREE DIFFERENT CONTRACTS, and each one is measured rather than
// asserted from the module's own documentation:
//   off  — the file is not created at all (reverse control: without this, every
//          other assertion below would also pass on a build that traced
//          unconditionally, and we would have shipped speech logging switched on)
//   meta — records exist, and NO transcript/prompt text appears in them
//   full — the text is there, and the dictionary substitution is visible in it

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { createComposeFactory } from '../src/compose';
import type { LlmEvent, LlmStreamOpts } from '../src/compose/llm';

const U = 'trace-user';
// The output guard is LIVE on this path (invented_latin_tokens etc.), so the
// fake vendor has to answer the way a real organize turn would — an English
// sentence in reply to Han input is refused, correctly, before it can be
// traced. Each test states the reply that fits its own input.
const ZH_INPUT = '这个跑在库伯上面';
const ZH_REPLY = '这个跑在 Kubernetes 上面。';
const EN_INPUT = 'nothing here matches the dictionary';
const EN_REPLY = 'Nothing here matches the dictionary.';
let reply = ZH_REPLY;

let dir: string;
let tracePath: string;
let db: DbConnection;
const savedEnv: Record<string, string | undefined> = {};

/** A vendor that answers instantly, so the assertions are about the trace and
 *  never about a network. It also RECORDS what it was handed, which is the
 *  control for the trace: if the file says one thing and the streamer saw
 *  another, the trace is the thing that is wrong. */
const seen: LlmStreamOpts[] = [];
async function* fakeStreamer(opts: LlmStreamOpts): AsyncGenerator<LlmEvent> {
  seen.push(opts);
  yield { kind: 'delta', text: reply };
  yield { kind: 'done', full: reply, usage: { tokens_in: 11, tokens_out: 7 } };
}

function setEnv(k: string, v: string | undefined): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

beforeEach(() => {
  seen.length = 0;
  reply = ZH_REPLY;
  dir = mkdtempSync(path.join(tmpdir(), 'flowmic-trace-'));
  tracePath = path.join(dir, 'pipeline-trace.jsonl');
  setEnv('FLOWMIC_TRACE_PATH', tracePath);
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('pipeline-trace-e2e-key') });
  db.users.insert({ id: U, display_name: 'Trace', plan: 'free' });
  db.settings.write(U, 'llm.config', {
    protocol: 'openai-compatible',
    endpoint: 'http://127.0.0.1:9/v1/chat/completions',
    model: 'test-model',
    api_key: 'EMPTY',
  });
  db.settings.write(U, 'scenario.card', {
    professions: ['眼科医生'],
    domains: ['医疗器械'],
    packs: [],
    // 2026-09-03 (owner Q1): the alias used to live on `stt.dictionary`; that
    // key is retired and the alias now rides the card term itself.
    terms: [{ term: 'Kubernetes', aliases: ['库伯'] }],
  });
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
  rmSync(dir, { recursive: true, force: true });
});

/** Run one real compose turn through the production factory. */
async function runTurn(sourceText: string): Promise<void> {
  const factory = createComposeFactory({
    settings: db.settings,
    usage: { recordLlmUsage: (): void => {} },
    streamerFor: () => fakeStreamer,
  });
  const run = factory({ userId: U, task: 'organize', sourceText });
  for await (const _chunk of run.run({ task: 'organize', source_text: sourceText })) {
    // drained: the handler concatenates these into compose:done
  }
}

function readRecords(): Record<string, unknown>[] {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('pipeline trace — off by default', () => {
  it('REVERSE CONTROL: with the switch unset nothing is written at all', async () => {
    setEnv('FLOWMIC_TRACE_PIPELINE', undefined);
    await runTurn(ZH_INPUT);
    // The turn itself must still have happened — a "no records" pass could
    // otherwise mean the compose factory silently did nothing.
    expect(seen).toHaveLength(1);
    expect(existsSync(tracePath)).toBe(false);
  });
});

describe('pipeline trace — meta level', () => {
  beforeEach(() => setEnv('FLOWMIC_TRACE_PIPELINE', 'meta'));

  it('emits the compose chain and joins it on one trace id', async () => {
    await runTurn(ZH_INPUT);
    const recs = readRecords();
    const stages = recs.map((r) => r.stage);
    expect(stages).toContain('compose.scenario');
    expect(stages).toContain('compose.request');
    expect(stages).toContain('compose.response');
    // One turn ⇒ one correlation id, or the records cannot be read as a chain.
    expect(new Set(recs.map((r) => r.trace_id)).size).toBe(1);
  });

  it('records the scenario card as COUNTS, and states that the block reached the prompt', async () => {
    await runTurn(ZH_INPUT);
    const scenario = readRecords().find((r) => r.stage === 'compose.scenario')!;
    expect(scenario.professions).toBe(1);
    expect(scenario.domains).toBe(1);
    expect(scenario.term_count).toBe(1);       // Kubernetes, from the card's terms
    expect(scenario.replacer_rule_count).toBeGreaterThan(0);
    expect(scenario.block_present).toBe(true);
  });

  it('shows the dictionary leg firing WITHOUT recording a word of the sentence', async () => {
    await runTurn(ZH_INPUT);
    const req = readRecords().find((r) => r.stage === 'compose.request')!;
    // The effect is visible as a boolean…
    expect(req.dict_replaced).toBe(true);
    // …and the control for that boolean is the streamer, which saw the real thing.
    expect(seen[0]?.user).toContain('Kubernetes');

    // PRIVACY CONTRACT: at this level not one traced string may carry text.
    const whole = readFileSync(tracePath, 'utf8');
    expect(whole).not.toContain('库伯');
    expect(whole).not.toContain('眼科医生');
    expect(whole).not.toContain(ZH_REPLY);
    for (const r of readRecords()) {
      for (const v of Object.values(r)) {
        if (v && typeof v === 'object' && 'sha8' in (v as object)) {
          expect(v).not.toHaveProperty('text');
        }
      }
    }
  });
});

describe('pipeline trace — full level', () => {
  beforeEach(() => setEnv('FLOWMIC_TRACE_PIPELINE', 'full'));

  it('carries the assembled prompt, the replaced input, and the model reply', async () => {
    await runTurn(ZH_INPUT);
    const recs = readRecords();
    const scenario = recs.find((r) => r.stage === 'compose.scenario')!;
    const req = recs.find((r) => r.stage === 'compose.request')!;
    const res = recs.find((r) => r.stage === 'compose.response')!;

    // The scenario card, in the bytes the model is given.
    expect((scenario.block as { text: string }).text).toContain('眼科医生');
    expect((scenario.block as { text: string }).text).toContain('医疗器械');
    // The system prompt the vendor received embeds that block.
    expect((req.system as { text: string }).text).toContain('眼科医生');
    expect((req.system as { text: string }).text).toBe(seen[0]?.system);
    // The user message is POST-replacement: this is the line that proves the
    // dictionary acted on what the model saw, not merely on a counter.
    expect((req.user as { text: string }).text).toContain('Kubernetes');
    expect((req.user as { text: string }).text).not.toContain('库伯');
    expect((req.user as { text: string }).text).toBe(seen[0]?.user);
    // And what came back, with the cost of getting it.
    expect((res.text as string)).toBe(ZH_REPLY);
    expect(res.tokens_in).toBe(11);
    expect(res.tokens_out).toBe(7);
  });

  it('digests let a reader tell "unchanged" from "changed" without the text', async () => {
    reply = EN_REPLY;
    await runTurn(EN_INPUT);
    const req = readRecords().find((r) => r.stage === 'compose.request')!;
    expect(req.dict_replaced).toBe(false);
    expect((req.user as { sha8: string }).sha8).toMatch(/^[0-9a-f]{8}$/);
  });
});
