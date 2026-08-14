// W2-2 — the output guard is WIRED, and the refusal reaches the wire.
//
// 🔴 WHY THIS FILE EXISTS SEPARATELY FROM compose-output-guard.test.ts. That file
// proves the guard's RULES are right. It proves nothing about whether anything
// calls them. "Capability defined, nobody calls it" is CLAUDE.md's #1 historical
// bug class, and the previous window shipped exactly that INSIDE the gate meant
// to catch it: the merge replay imported the fixed fold and drove it directly,
// so reverting the production call site left the gate fully green
// (docs/strategy/2026-08-06-w2-transcription-quality-ledger.md §6 item 4,
// logged there as A-8 — 🔴 disambiguated 2026-08-07: "ledger §6-4" named
// neither a file nor a real section number; the account it points to does
// exist, just not at that address).
//
// So everything below goes through a production entry point:
//   • the orchestrator seam — `createComposeRun(...).run()`, the same object
//     bootstrap's factory returns;
//   • the socket handler — `registerComposeHandlers`, driven by a real
//     `compose:start` payload, asserting on what the SOCKET RECEIVED.
//
// 🔴 And the assertions are about MECHANISM, never about prose.
//
// 🔴 CORRECTED (2026-08-07): the sentence above used to continue "The interim
// wire code is an unregistered identifier that currently reaches the user as
// a bare token; asserting that a user can read or understand it would write a
// known defect into the acceptance criteria and go red on the day the fix
// lands." That was true when written and is stale now: `COMPOSE_OUTPUT_REJECTED`
// was registered as error code 62 the same day (owner approved,
// `docs/decisions/2026-08-07-owner-grants-error-code-62-compose-output-
// rejected.md`), with real zh_CN/en and four-language copy on both
// user-facing faces. The tests below still assert MECHANISM only, never
// prose — that discipline outlives the registration state, which is why
// nothing below needed to change.

import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { safeParseEvent } from '@flowmic/protocol';
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

/** A streamer that emits the given text as deltas, then a clean `done`. The
 *  vendor behaved perfectly — the question under test is what WE do with what it
 *  said. */
function streamerOf(text: string, chunks = 3): LlmStreamer {
  return async function* (): AsyncGenerator<LlmEvent> {
    const size = Math.max(1, Math.ceil(text.length / chunks));
    for (let i = 0; i < text.length; i += size) yield { kind: 'delta', text: text.slice(i, i + size) };
    yield { kind: 'done', full: text, usage: { tokens_in: 10, tokens_out: 20 } };
  } as LlmStreamer;
}

async function drain(run: ReturnType<typeof createComposeRun>, input: Parameters<ReturnType<typeof createComposeRun>['run']>[0]): Promise<{ deltas: string[]; error: unknown }> {
  const deltas: string[] = [];
  try {
    for await (const d of run.run(input)) deltas.push(d);
    return { deltas, error: null };
  } catch (e) {
    return { deltas, error: e };
  }
}

// The English source a Chinese translation must not simply echo back.
const SOURCE_EN = 'The quarterly report is due on Friday morning.';

describe('W2-2 — the guard runs on the orchestrator seam', () => {
  it('throws when the completed output fails the guard, and never yields the source', async () => {
    const run = createComposeRun(CFG, 'sys', false, { streamerFor: () => streamerOf(SOURCE_EN) });
    const { deltas, error } = await drain(run, {
      task: 'translate',
      source_text: SOURCE_EN,
      source_lang: 'en',
      target_lang: 'zh-CN',
    });
    expect(error).toBeInstanceOf(ComposeOutputRejectedError);
    expect((error as ComposeOutputRejectedError).rule).toBe('target_script_absent');
    // 🔴 red line: `an LLM failure must not silently fall back to injecting the raw STT text`. The run failed, so there is
    // no result — and in particular the source text was NOT produced as one.
    // (The deltas the vendor sent happen to equal the source here, which is the
    // failure itself; what matters is that the run ENDED IN A THROW, so the
    // handler never emits compose:done and no output_text exists.)
    expect(deltas.join('')).toBe(SOURCE_EN);
  });

  it('accepts a real translation and completes normally', async () => {
    const run = createComposeRun(CFG, 'sys', false, { streamerFor: () => streamerOf('季度报告周五上午到期。') });
    const { error } = await drain(run, {
      task: 'translate',
      source_text: SOURCE_EN,
      source_lang: 'en',
      target_lang: 'zh-CN',
    });
    expect(error).toBeNull();
  });

  it('leaves draft_polish alone — that path already has three gates of its own', async () => {
    // A fourth opinion here would give one question two answers. The SAME text
    // that is rejected as a translation must pass as a polish.
    const run = createComposeRun(CFG, 'sys', false, { streamerFor: () => streamerOf(SOURCE_EN) });
    const { error } = await drain(run, {
      task: 'draft_polish',
      source_text: SOURCE_EN,
      source_lang: 'en',
      target_lang: 'zh-CN',
    });
    expect(error).toBeNull();
  });
});

// ─── the handler half ───────────────────────────────────────────────────────

interface Emitted { event: string; payload: Record<string, unknown> }

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

function depsWith(streamText: string): Parameters<typeof registerComposeHandlers>[1] {
  return {
    io: {} as never,
    guard: { ensureQuota: (): void => {} } as never,
    usageTracker: { recordLlmUsage: (): void => {} } as never,
    store: { getFocusProcess: (): undefined => undefined } as never,
    composeFactory: () => createComposeRun(CFG, 'sys', false, { streamerFor: () => streamerOf(streamText) }),
  };
}

describe('W2-2 — a guard rejection reaches the phone as compose:error', () => {
  it('emits compose:error with the interim code, and never compose:done', async () => {
    const { socket, emitted, fire } = fakeSocket();
    registerComposeHandlers(socket, depsWith(SOURCE_EN));
    await fire({
      request_id: 'req-1',
      entry_id: 'entry-1',
      task: 'translate',
      source_text: SOURCE_EN,
      source_lang: 'en',
      target_lang: 'zh-CN',
    });

    const errors = emitted.filter((e) => e.event === 'compose:error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.payload['code']).toBe(COMPOSE_OUTPUT_REJECTED_CODE);

    // 🔴 no silent failure, both directions. The refusal must be VISIBLE (the frame
    // went out), and nothing may be reported as done that was not done.
    expect(emitted.filter((e) => e.event === 'compose:done')).toHaveLength(0);

    // 🔴 red line: the source text is never substituted for the result. No frame
    // carries it as an output_text.
    for (const e of emitted) {
      expect(e.payload['output_text']).toBeUndefined();
    }

    // The echo has to survive, or the phone drops the frame at
    // `e.requestId != _requestId` and falls through to its 45 s watchdog —
    // naming the wrong wall for a run the server refused deliberately.
    expect(errors[0]!.payload['request_id']).toBe('req-1');
    expect(errors[0]!.payload['entry_id']).toBe('entry-1');
  });

  it('the emitted frame satisfies the real protocol schema', async () => {
    // 🔴 ComposeErrorSchema types `message` as NonEmpty. An empty message makes
    // the frame fail the phone's own parse — a silent failure dressed as a send —
    // so this asserts against the PRODUCTION schema rather than eyeballing the
    // object. This is a mechanism assertion, not a claim about readability.
    const { socket, emitted, fire } = fakeSocket();
    registerComposeHandlers(socket, depsWith(SOURCE_EN));
    await fire({
      request_id: 'req-2',
      task: 'translate',
      source_text: SOURCE_EN,
      source_lang: 'en',
      target_lang: 'zh-CN',
    });
    const frame = emitted.find((e) => e.event === 'compose:error');
    expect(frame).toBeDefined();
    const parsed = safeParseEvent('compose:error', frame!.payload);
    expect(parsed.success).toBe(true);
    expect(String(frame!.payload['message']).length).toBeGreaterThan(0);
    // The rule that fired is named, so a deployment holding only the log can
    // answer 「why this one was refused」.
    expect(String(frame!.payload['message'])).toContain('target_script_absent');
  });

  it('a stripped wrapper actually lands on output_text', async () => {
    // 🔴 Pins a claim a comment makes, because the first draft made that claim
    // falsely: the guard computed the unwrapped text, judged it, and threw it
    // away, so a fenced-but-correct translation was "repaired" and still reached
    // the user wearing its ``` marks. A repair that does not change what is
    // delivered is a façade. The chunks still carry the fence (they were already
    // on the wire) — output_text is what both phone consumers take verbatim.
    const { socket, emitted, fire } = fakeSocket();
    registerComposeHandlers(socket, depsWith('```\n季度报告周五上午到期。\n```'));
    await fire({
      request_id: 'req-4',
      task: 'translate',
      source_text: SOURCE_EN,
      source_lang: 'en',
      target_lang: 'zh-CN',
    });
    const done = emitted.find((e) => e.event === 'compose:done');
    expect(done).toBeDefined();
    expect(done!.payload['output_text']).toBe('季度报告周五上午到期。');
  });

  it('a good output still completes — the handler was not simply broken', async () => {
    // The positive control. Without it, "no compose:done was emitted" above is
    // equally consistent with the handler being dead.
    const { socket, emitted, fire } = fakeSocket();
    registerComposeHandlers(socket, depsWith('季度报告周五上午到期。'));
    await fire({
      request_id: 'req-3',
      task: 'translate',
      source_text: SOURCE_EN,
      source_lang: 'en',
      target_lang: 'zh-CN',
    });
    expect(emitted.filter((e) => e.event === 'compose:error')).toHaveLength(0);
    const done = emitted.find((e) => e.event === 'compose:done');
    expect(done).toBeDefined();
    expect(done!.payload['output_text']).toBe('季度报告周五上午到期。');
    expect(emitted.filter((e) => e.event === 'compose:chunk').length).toBeGreaterThan(0);
  });
});
