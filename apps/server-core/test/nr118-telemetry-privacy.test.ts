import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import type { LlmConfig } from '@flowmic/protocol';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { makeSttEmitter } from '../src/engine/stt-factory';
import type { SttEngine } from '../src/stt/engines/base';
import { createComposeRun } from '../src/compose/orchestrator';
import type { LlmStreamer } from '../src/compose/llm/types';
import { ComposeTiming } from '../src/obs/compose-timing';
import { observedPolishFinalText } from '../src/obs/terminal-polish-timing';
import { registerComposeHandlers } from '../src/socket/handlers/compose.handler';
import { __resetPolishCacheForTest } from '../src/stt/stt-polish';
import { markAudioStartMeta, markAudioStop, markInjectRequest, markInjectResult, __resetLatencyState } from '../src/obs/latency';
import { log } from '../src/log';

const marker = 'NR118_PRIVATE_SYNTHETIC_SENTINEL';
const cfg: LlmConfig = { protocol: 'openai-compatible', endpoint: 'https://private.invalid', model: marker, api_key: marker };
let lines: { msg: string; fields: Record<string, unknown> }[];
beforeEach(() => {
  __resetPolishCacheForTest(); __resetLatencyState(); lines = [];
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(log, level).mockImplementation((msg: string, fields?: Record<string, unknown>) => { lines.push({ msg, fields: fields ?? {} }); });
});
afterEach(() => vi.restoreAllMocks());

const keys: Record<string, string[]> = {
  'stt.polish.timing': 'tcorr outcome elapsed_ms ttfb_ms budget_ms chars_in chars_out strength lang llm_source model finish_reason'.split(' '),
  'stt.polish.guard': 'tcorr verdict family first_category d_numeral d_digit d_modal d_negation d_quantifier distance edit_bound length_ratio open_class_delta open_class_k strength lang v2_verdict v2_family v2_explained'.split(' '),
  'latency.segment': 'entry_id tcorr mode send_policy delivery continuous audio_ms uplink_lag_ms backlog_ms inj_source inj_origin stt_ms phone_turnaround_ms inject_ms server_total_ms dropped_so_far stt_to_flush_ms stt_from_flush_ms'.split(' '),
  'compose.timing': 'task outcome error_code elapsed_ms ttfb_ms chars_in chars_out llm_source model finish_reason'.split(' '),
};
const enums: Record<string, string[]> = {
  outcome: ['applied', 'cache_hit', 'guard_reject', 'timeout', 'llm_error', 'model_rejected', 'empty_input', 'empty_output', 'exception', 'done', 'rejected', 'error'],
  verdict: ['ok', 'reject'], family: ['closed_class', 'dict', 'edit', 'length', 'han', 'open_class', 'none'],
  first_category: ['numeral', 'digit', 'modal', 'negation', 'quantifier'], strength: ['strict', 'smooth'],
  llm_source: ['managed', 'user', 'seed'], mode: ['realtime', 'translate', 'organize'], task: ['translate', 'organize', 'draft_polish'],
  send_policy: ['direct', 'manual'], delivery: ['inject', 'none'], inj_source: ['stt', 'llm', 'manual', 'history', 'image'], inj_origin: ['live', 'deferred'],
  error_code: ['COMPOSE_OUTPUT_REJECTED', 'LLM_TIMEOUT'],
  finish_reason: ['stop', 'length', 'content_filter', 'none', 'other'],
};
function assertPrivate(msg: string, fields: Record<string, unknown>): void {
  expect(Object.keys(fields).filter(k => !keys[msg]!.includes(k))).toEqual([]);
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || typeof v === 'boolean') continue;
    if (k === 'v2_explained') { expect(Object.keys(v as object).sort()).toEqual(['r1', 'r2', 'r3']); for (const n of Object.values(v as object)) expect(Number.isInteger(n) && Number(n) >= 0).toBe(true); continue; }
    if (typeof v === 'number') { expect(Number.isFinite(v)).toBe(true); continue; }
    expect(typeof v).toBe('string');
    if (k === 'tcorr') expect(v).toMatch(/^[0-9a-f]{6}$/);
    else if (k === 'lang') expect(v).toMatch(/^[a-z]{2,3}$/);
    else if (k === 'model') expect(v).toBe(fields.llm_source === 'managed' ? 'managed-test-model' : 'byok');
    else expect(enums[k.replace(/^v2_/, '')], k).toContain(v);
  }
  expect(JSON.stringify(fields)).not.toContain(marker);
  expect(JSON.stringify(fields)).not.toContain('没');
}

it.each(['user', 'seed', 'managed-default'] as const)('real terminal bridge and compose handler emit only safe values (%s)', async source => {
  const transcript = `${marker}我没去。`;
  class Engine extends EventEmitter {
    id = 'custom-openai-compatible'; state = 'closed';
    async open(): Promise<void> { this.state = 'open'; }
    push(): void {}
    async close(): Promise<void> { this.state = 'closed'; }
    async flush(): Promise<void> { this.emit('final', { kind: 'final', text: transcript, confidence: 1, language: 'zh', duration_ms: 200 }); }
  }
  const engine = new Engine();
  const selected = { source, cfg: { ...cfg, model: source === 'managed-default' ? 'managed-test-model' : marker } };
  const emitter = makeSttEmitter({ resolveSocket: () => null, store: { getPc: () => undefined } as never, roomUuid: 'private-room', delivery: 'none' });
  const bridge = new SttSessionBridge({
    userId: 'private-user', mode: 'realtime', sourceLang: 'zh', onComplete: () => {}, emitter,
    build: session => ({ orchestrator: new SttEngineOrchestrator(session, () => engine as unknown as SttEngine, { engineFlushTimeoutMs: 100 }), isByok: false, gated: false }),
    polishDelivery: 'sync', polish: { llm: selected, deps: { language: 'zh-CN', streamerFor: () => async function* () { yield { kind: 'delta', text: `${marker}我去。` }; yield { kind: 'done', full: `${marker}我去。` }; } } },
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  markAudioStartMeta('private-room', { mode: 'realtime', send_policy: 'direct', delivery: 'none' });
  bridge.pushChunk(0, Buffer.alloc(6400, 12).toString('base64'), 0);
  markAudioStop('private-room', undefined, bridge.receivedAudioMs);
  await bridge.finish();
  await new Promise<void>(resolve => setImmediate(resolve));
  markInjectRequest('private-room', 'private-entry', undefined, { source: 'stt', origin: 'live' });
  markInjectResult('private-room', 'private-entry');
  bridge.dispose();
  const handlers = new Map<string, (payload: unknown, ack: unknown) => unknown>();
  const socket = { data: { auth: { userId: 'private-user' } }, on: (e: string, fn: (p: unknown, a: unknown) => unknown) => handlers.set(e, fn), emit: () => true } as unknown as Socket;
  registerComposeHandlers(socket, {
    io: {} as never, guard: { ensureQuota: () => {} } as never,
    usageTracker: { recordLlmUsage: () => {} } as never, store: {} as never,
    composeFactory: () => createComposeRun(selected.cfg, 'sys', source !== 'managed-default', { llmSource: source, streamerFor: () => async function* () { yield { kind: 'delta', text: transcript }; yield { kind: 'done', full: transcript }; } }),
  });
  await handlers.get('compose:start')!({ task: 'organize', source_text: transcript, source_lang: 'zh' }, undefined);
  const captured = lines.filter(l => keys[l.msg]);
  expect(new Set(captured.map(l => l.msg))).toEqual(new Set(Object.keys(keys)));
  expect(captured.find(l => l.msg === 'stt.polish.guard')!.fields.verdict).toBe('reject');
  expect(captured.find(l => l.msg === 'stt.polish.timing')!.fields.outcome).toBe('guard_reject');
  for (const line of captured) assertPrivate(line.msg, line.fields);
  for (const line of lines.filter(l => l.msg.startsWith('stt.polish'))) {
    expect(JSON.stringify(line)).not.toContain(marker);
    expect(JSON.stringify(line)).not.toContain('没');
  }
});

it('records finish_reason on both timing lines and keeps it inside its closed enum', async () => {
  const streamer: LlmStreamer = async function* () {
    yield { kind: 'delta', text: `${marker} partial` };
    yield { kind: 'error', code: 'COMPOSE_OUTPUT_REJECTED', message: 'incomplete', finish_reason: 'length' };
  };
  const run = createComposeRun(cfg, 'system', true, { llmSource: 'user', streamerFor: () => streamer });
  const timing = new ComposeTiming('organize', marker.length);
  try { for await (const delta of run.run({ task: 'organize', source_text: marker })) timing.chunk(delta); }
  catch (err) { timing.finish(run, 'rejected', (err as { code?: unknown }).code); }
  await observedPolishFinalText(marker, { cfg, source: 'user' }, { streamerFor: () => streamer });
  const timingLines = lines.filter(l => l.msg === 'compose.timing' || l.msg === 'stt.polish.timing');
  expect(timingLines.map(l => l.msg).sort()).toEqual(['compose.timing', 'stt.polish.timing']);
  for (const l of timingLines) { expect(l.fields.finish_reason).toBe('length'); assertPrivate(l.msg, l.fields); }
});
