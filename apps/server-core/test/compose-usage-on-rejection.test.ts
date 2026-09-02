// AUD-2 P1 — a rejected compose turn must still bill for the tokens the vendor
// already produced.
//
// `apps/server-core/src/compose/orchestrator.ts` `run()` records real
// `tokensIn`/`tokensOut` into `ComposeRunImpl._usage` the moment a `done` event
// carries `usage` — BEFORE `assertOutputDeliverable` runs and can throw
// `ComposeOutputRejectedError` (orchestrator.ts documents this is a
// systematically reproducible outcome, not a corner case: any dictionary-
// replaced CJK utterance that introduces a Latin token hits
// `invented_latin_tokens`). Before this fix, `compose.handler.ts` called
// `commitLlmUsage` from exactly one place — the line right after the happy-path
// `for await` loop — so the `ComposeOutputRejectedError` branch and the generic
// catch never committed usage: the vendor answered, tokens were spent, and they
// vanished from both `usage_records` (the month quota) and `usage_events` (the
// `llm_tokens` safety valve this repo relies on to catch a run-away vendor
// bill).
//
// Every assertion here goes through the production handler
// (`registerComposeHandlers`) with a fake `usageTracker.recordLlmUsage` that
// records its calls — the same seam `compose-output-guard-wiring.test.ts` uses,
// widened here to also watch the billing call rather than only the wire frame.

import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { createComposeRun, ComposeOutputRejectedError, COMPOSE_OUTPUT_REJECTED_CODE } from '../src/compose';
import type { LlmEvent, LlmStreamer } from '../src/compose';
import type { LlmConfig } from '@flowmic/protocol';
import { registerComposeHandlers } from '../src/socket/handlers/compose.handler';

const CFG: LlmConfig = {
  protocol: 'openai-compatible',
  endpoint: 'http://127.0.0.1:1/v1',
  model: 'test-model',
  api_key: 'k',
};

// The English source a Chinese translation must not simply echo back — echoing
// it is exactly what trips the guard's `target_script_absent` rule, giving a
// deterministic rejection to test against.
const SOURCE_EN = 'The quarterly report is due on Friday morning.';

const TOKENS_IN = 37;
const TOKENS_OUT = 41;

/** A streamer that answers with `text`, reporting real vendor usage on its
 *  `done` event — the vendor was billed regardless of what we do with the text. */
function streamerOf(text: string, usage: { tokens_in: number; tokens_out: number } | undefined = { tokens_in: TOKENS_IN, tokens_out: TOKENS_OUT }): LlmStreamer {
  return async function* (): AsyncGenerator<LlmEvent> {
    yield { kind: 'delta', text };
    yield { kind: 'done', full: text, ...(usage ? { usage } : {}) };
  } as LlmStreamer;
}

interface Emitted { event: string; payload: Record<string, unknown> }
interface RecordedUsage { userId: string; tokensIn: number; tokensOut: number; isByok: boolean }

function fakeSocket(): { socket: Socket; emitted: Emitted[]; fire: (payload: unknown) => Promise<void> } {
  const emitted: Emitted[] = [];
  const handlers = new Map<string, (p: unknown, a: unknown) => unknown>();
  const socket = {
    data: { auth: { userId: 'u1' }, roomUuid: 'room-1' },
    on(event: string, fn: (p: unknown, a: unknown) => unknown) { handlers.set(event, fn); },
    emit(event: string, payload: Record<string, unknown>) { emitted.push({ event, payload }); return true; },
  } as unknown as Socket;
  return {
    socket,
    emitted,
    fire: async (payload: unknown) => { await handlers.get('compose:start')?.(payload, undefined); },
  };
}

/** Same shape as compose-output-guard-wiring.test.ts's `depsWith`, widened to
 *  capture `recordLlmUsage` calls instead of discarding them. */
function depsWith(streamText: string, usage?: { tokens_in: number; tokens_out: number }): { deps: Parameters<typeof registerComposeHandlers>[1]; recorded: RecordedUsage[]; ensureQuota: () => void } {
  const recorded: RecordedUsage[] = [];
  const ensureQuota = (): void => {};
  const deps: Parameters<typeof registerComposeHandlers>[1] = {
    io: {} as never,
    guard: { ensureQuota } as never,
    usageTracker: {
      recordLlmUsage(userId: string, _engine: unknown, tokensIn: number, tokensOut: number): void {
        recorded.push({ userId, tokensIn, tokensOut, isByok: (_engine as { is_byok: boolean }).is_byok });
      },
      recordQuotaRefusal: (): void => {},
    } as never,
    store: { getFocusProcess: (): undefined => undefined } as never,
    composeFactory: () => createComposeRun(CFG, 'sys', false, { streamerFor: () => streamerOf(streamText, usage) }),
  };
  return { deps, recorded, ensureQuota };
}

const FIRE_PAYLOAD = {
  request_id: 'req-usage-1',
  entry_id: 'entry-usage-1',
  task: 'translate' as const,
  source_text: SOURCE_EN,
  source_lang: 'en',
  target_lang: 'zh-CN',
};

describe('AUD-2 P1 — commitLlmUsage fires on every path the vendor answered', () => {
  it('a guard REJECTION still bills the real tokens the vendor reported', async () => {
    const { socket, emitted, fire } = fakeSocket();
    const { deps, recorded } = depsWith(SOURCE_EN); // echoing the English source trips target_script_absent
    registerComposeHandlers(socket, deps);
    await fire(FIRE_PAYLOAD);

    // Positive control that the turn really was rejected (not silently accepted) —
    // otherwise this test would prove nothing about the rejection path.
    const errors = emitted.filter((e) => e.event === 'compose:error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.payload['code']).toBe(COMPOSE_OUTPUT_REJECTED_CODE);
    expect(emitted.filter((e) => e.event === 'compose:done')).toHaveLength(0);

    // The measurement under test: the vendor answered (usage was on the `done`
    // event), so the tokens must be committed even though the output was refused.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({ userId: 'u1', tokensIn: TOKENS_IN, tokensOut: TOKENS_OUT, isByok: false });
  });

  it('a SUCCESSFUL turn still bills exactly once (no double-count from the new catch-path commit)', async () => {
    const { socket, emitted, fire } = fakeSocket();
    const { deps, recorded } = depsWith('季度报告周五上午到期。');
    registerComposeHandlers(socket, deps);
    await fire(FIRE_PAYLOAD);

    expect(emitted.filter((e) => e.event === 'compose:error')).toHaveLength(0);
    expect(emitted.filter((e) => e.event === 'compose:done')).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({ userId: 'u1', tokensIn: TOKENS_IN, tokensOut: TOKENS_OUT, isByok: false });
  });

  it('a run that never reaches the vendor (EngineNotWiredError) commits NOTHING', async () => {
    const { socket, emitted, fire } = fakeSocket();
    const recorded: RecordedUsage[] = [];
    const deps: Parameters<typeof registerComposeHandlers>[1] = {
      io: {} as never,
      guard: { ensureQuota: (): void => {} } as never,
      usageTracker: {
        recordLlmUsage(userId: string, _engine: unknown, tokensIn: number, tokensOut: number): void {
          recorded.push({ userId, tokensIn, tokensOut, isByok: (_engine as { is_byok: boolean }).is_byok });
        },
        recordQuotaRefusal: (): void => {},
      } as never,
      store: { getFocusProcess: (): undefined => undefined } as never,
      // composeFactory intentionally absent — EngineNotWiredError fires before
      // any orchestrator exists, exactly the case the fix must not touch.
    };
    registerComposeHandlers(socket, deps);
    await fire(FIRE_PAYLOAD);

    expect(emitted.filter((e) => e.event === 'compose:error')).toHaveLength(1);
    expect(recorded).toHaveLength(0);
  });

  it('a run that reaches the vendor but never gets a `done` (mid-stream error) reports zero usage, never fabricated tokens', async () => {
    const { socket, emitted, fire } = fakeSocket();
    const streamer: LlmStreamer = async function* (): AsyncGenerator<LlmEvent> {
      yield { kind: 'delta', text: 'partial' };
      yield { kind: 'error', code: 'LLM_TIMEOUT', message: 'vendor never answered' };
    } as LlmStreamer;
    const recorded: RecordedUsage[] = [];
    const deps: Parameters<typeof registerComposeHandlers>[1] = {
      io: {} as never,
      guard: { ensureQuota: (): void => {} } as never,
      usageTracker: {
        recordLlmUsage(userId: string, _engine: unknown, tokensIn: number, tokensOut: number): void {
          recorded.push({ userId, tokensIn, tokensOut, isByok: (_engine as { is_byok: boolean }).is_byok });
        },
        recordQuotaRefusal: (): void => {},
      } as never,
      store: { getFocusProcess: (): undefined => undefined } as never,
      composeFactory: () => createComposeRun(CFG, 'sys', false, { streamerFor: () => streamer }),
    };
    registerComposeHandlers(socket, deps);
    await fire(FIRE_PAYLOAD);

    expect(emitted.filter((e) => e.event === 'compose:error')).toHaveLength(1);
    // orchestrator exists (the vendor WAS called), but no `done` event ever
    // carried a usage report, so readComposeUsage()'s default (0/0/false) is
    // what the catch-path commit passes along — never a fabricated non-zero
    // count. (The PRODUCTION usage tracker additionally early-returns on an
    // all-zero report — usage-tracker.ts `recordLlmUsage` — so no row is
    // actually written downstream; this fake, unlike that one, records every
    // call it receives so the handler's own behaviour is what is being pinned.)
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({ userId: 'u1', tokensIn: 0, tokensOut: 0, isByok: false });
  });
});
