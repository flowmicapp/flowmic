import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LlmConfig } from '@flowmic/protocol';
import { createComposeRun } from '../src/compose/orchestrator';
import { streamAnthropic } from '../src/compose/llm/anthropic';
import { streamOpenAiCompatible } from '../src/compose/llm/openai-compatible';
import { __resetPolishCacheForTest, polishFinalText } from '../src/stt/stt-polish';
import { observedPolishFinalText } from '../src/obs/terminal-polish-timing';
import { ComposeTiming } from '../src/obs/compose-timing';
import { log } from '../src/log';

const OPENAI_CFG: LlmConfig = { protocol: 'openai-compatible', endpoint: 'https://llm.invalid/v1', model: 'test-model', api_key: 'EMPTY' };
const ANTHROPIC_CFG: LlmConfig = { protocol: 'anthropic', endpoint: 'https://llm.invalid', model: 'proxy-model', api_key: 'EMPTY' };
const SENTENCE = 'The quick brown fox jumps over the lazy dog.';

function responseFor(protocol: LlmConfig['protocol'], reason: 'stop' | 'length' = 'stop'): Response {
  const frames = protocol === 'openai-compatible'
    ? [
        { choices: [{ delta: { content: reason === 'stop' ? SENTENCE : 'The quick brown fox' } }] },
        { choices: [{ finish_reason: reason }] },
        '[DONE]',
      ]
    : [
        { type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 0 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: reason === 'stop' ? SENTENCE : 'The quick brown fox' } },
        { type: 'message_delta', delta: { stop_reason: reason === 'stop' ? 'end_turn' : 'max_tokens' } },
        { type: 'message_stop' },
      ];
  const data = frames.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('');
  return new Response(data, { headers: { 'content-type': 'text/event-stream' } });
}

function captureFetch(protocol: LlmConfig['protocol'], reason: 'stop' | 'length' = 'stop') {
  let body = '';
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    body = String(init?.body ?? '');
    return responseFor(protocol, reason);
  };
  return { fetch, requestBody: () => JSON.parse(body) as Record<string, unknown> };
}

async function collectCompose(protocol: LlmConfig['protocol'], task: 'organize' | 'translate', fetch: typeof globalThis.fetch, cfg = protocol === 'anthropic' ? ANTHROPIC_CFG : OPENAI_CFG): Promise<void> {
  const streamer = protocol === 'anthropic' ? streamAnthropic : streamOpenAiCompatible;
  const streamerFor = () => streamer;
  const run = createComposeRun(cfg, 'system', false, { streamerFor, fetch });
  for await (const _delta of run.run({ task, source_text: SENTENCE, source_lang: 'en', target_lang: 'en' })) { /* consume */ }
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => __resetPolishCacheForTest());

it.each([
  ['openai-compatible', 'organize'],
  ['openai-compatible', 'translate'],
  ['anthropic', 'organize'],
  ['anthropic', 'translate'],
] as const)('%s %s compose request has an explicit output budget', async (protocol, task) => {
  const captured = captureFetch(protocol);
  await collectCompose(protocol, task, captured.fetch);
  expect(captured.requestBody().max_tokens).toBe(8192);
});

it('STT polish request does not inherit the compose output budget', async () => {
  const captured = captureFetch('openai-compatible');
  await polishFinalText(SENTENCE, OPENAI_CFG, { streamerFor: () => streamOpenAiCompatible, fetch: captured.fetch });
  expect(captured.requestBody()).not.toHaveProperty('max_tokens');
});

it('records length on compose and polish timing lines', async () => {
  const lines: { msg: string; fields: Record<string, unknown> }[] = [];
  vi.spyOn(log, 'info').mockImplementation((msg, fields) => { lines.push({ msg, fields: fields ?? {} }); });

  // The timing lines are emitted by ComposeTiming (compose.handler's call site) and
  // observedPolishFinalText (the STT bridge's call site), not by the runs themselves.
  const composeTimed = async (protocol: LlmConfig['protocol'], fetch: typeof globalThis.fetch): Promise<void> => {
    const streamer = protocol === 'anthropic' ? streamAnthropic : streamOpenAiCompatible;
    const run = createComposeRun(protocol === 'anthropic' ? ANTHROPIC_CFG : OPENAI_CFG, 'system', false, { streamerFor: () => streamer, fetch });
    const timing = new ComposeTiming('organize', SENTENCE.length);
    try {
      for await (const delta of run.run({ task: 'organize', source_text: SENTENCE, source_lang: 'en', target_lang: 'en' })) timing.chunk(delta);
      timing.finish(run, 'done');
    } catch (err) {
      timing.finish(run, 'rejected', (err as { code?: unknown }).code);
    }
  };
  await composeTimed('openai-compatible', captureFetch('openai-compatible', 'length').fetch);
  await composeTimed('anthropic', captureFetch('anthropic', 'length').fetch);

  const polish = captureFetch('openai-compatible', 'length');
  await observedPolishFinalText(SENTENCE, { cfg: OPENAI_CFG, source: 'user' }, { streamerFor: () => streamOpenAiCompatible, fetch: polish.fetch });

  expect(lines.filter(line => line.msg === 'compose.timing').map(line => line.fields.finish_reason)).toEqual(['length', 'length']);
  expect(lines.find(line => line.msg === 'stt.polish.timing')?.fields.finish_reason).toBe('length');
});
