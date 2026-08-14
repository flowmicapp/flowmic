// GA-12 — the STT/LLM "test connection" four-dimension probe.
//
// The card's three hard requirements are each pinned here:
//   • a LIVE endpoint returns all four dimensions (ok / latency_ms /
//     sample_output≤80 / model_echoed) — proven against real in-process HTTP
//     servers, so nothing depends on the owner's LAN being reachable;
//   • a DEAD endpoint returns ok:false + a NAMED protocol code at HTTP 200 —
//     never a 500;
//   • a probe BILLS NOTHING and PERSISTS NOTHING — asserted behaviourally (a
//     spy BillingService sees zero calls) and structurally (probe-routes.ts
//     imports no billing / db / settings module at all).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SttEngineId } from '@flowmic/protocol';
import { makeHttpHandler } from '../src/http/router';
import { makeResolveUserId } from '../src/http/account-auth';
import {
  clampSample,
  parseLlmProbeBody,
  parseSttProbeBody,
  probeKindFor,
  probeLlm,
  probeStt,
  SAMPLE_OUTPUT_MAX,
  type ProbeFail,
  type ProbeOk,
  type ProbeResult,
} from '../src/http/probe-routes';
import { loadConfig } from '../src/config';
import type { LlmEvent, LlmStreamer } from '../src/compose/llm';
import type { EngineState, SttEngine, SttEngineConfig } from '../src/stt/engines/base';
import { SttEngineError } from '../src/stt/engines/base';

// ── harness ──────────────────────────────────────────────────────────────────

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const addr = s.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

/** An in-process FlowMic http surface (the router under test, nothing else). */
async function flowmicServer(
  overrides: Partial<Parameters<typeof makeHttpHandler>[0]> = {},
  mode: 'standalone' | 'saas' = 'standalone',
): Promise<string> {
  // fix-010: declared proxy posture — an in-process server has nothing in front
  // of it, so its direct peer IS the client (config.ts §trustedProxies).
  const config = loadConfig({ mode, secret: 'probe-routes-secret-32-bytes-minimum!!', port: 0, dbPath: ':memory:', trustedProxies: [] });
  const handler = makeHttpHandler({
    config,
    billing: billingSpy() as never,
    version: '0.1.0',
    // The REAL resolver (standalone branch) — see http-user-identity.test.ts for
    // the saas branch. A hand-rolled `() => 'default'` here would keep passing
    // even if production stopped resolving anyone at all.
    resolveUserId: makeResolveUserId({ mode: 'standalone', standaloneUserId: 'default' }),
    ...overrides,
  });
  return listen((req, res) => {
    if (!handler(req, res)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not_found"}');
    }
  });
}

/** Every BillingService method a probe route could reach, spied. */
function billingSpy(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    getPlan: vi.fn(), getQuota: vi.fn(), effectivePlan: vi.fn(), advanceClock: vi.fn(),
    mockCheckout: vi.fn(), mockConfirm: vi.fn(), mockCancel: vi.fn(), mockRenew: vi.fn(), mockExpire: vi.fn(),
  };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: ProbeResult }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as ProbeResult };
}

function ok(r: ProbeResult): ProbeOk {
  expect(r.ok, `expected ok, got ${JSON.stringify(r)}`).toBe(true);
  return r as ProbeOk;
}
function bad(r: ProbeResult): ProbeFail {
  expect(r.ok, `expected failure, got ${JSON.stringify(r)}`).toBe(false);
  return r as ProbeFail;
}

function streamerOf(events: LlmEvent[]): () => LlmStreamer {
  return () =>
    async function* (): AsyncGenerator<LlmEvent> {
      for (const e of events) yield e;
    };
}

/** An openai-compatible SSE endpoint, live and local. */
function sseChatCompletions(model: string, chunks: string[]): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (!(req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const c of chunks) {
      res.write(`data: ${JSON.stringify({ model, choices: [{ delta: { content: c } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  };
}

class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  constructor(
    readonly id: SttEngineId,
    readonly cfg: SttEngineConfig,
    private readonly script: {
      openError?: Error;
      finalText?: string;
      flushError?: SttEngineError;
      onOpen?: (cfg: SttEngineConfig) => void;
    },
  ) {
    super();
  }
  get state(): EngineState { return this._state; }
  open(): Promise<void> {
    this.script.onOpen?.(this.cfg);
    if (this.script.openError) return Promise.reject(this.script.openError);
    this._state = 'open';
    return Promise.resolve();
  }
  push(): void { /* buffered by the real adapters; irrelevant to the probe */ }
  flush(): Promise<void> {
    if (this.script.flushError) this.emit('error', this.script.flushError);
    else if (this.script.finalText !== undefined) {
      this.emit('final', { kind: 'final', text: this.script.finalText, confidence: 1, language: this.cfg.language, duration_ms: 200 });
    }
    return Promise.resolve();
  }
  close(): Promise<void> { this._state = 'closed'; return Promise.resolve(); }
}

// ── ① LLM probe: the four dimensions ─────────────────────────────────────────

describe('GA-12 LLM probe — four dimensions', () => {
  it('a live endpoint answers all four dimensions, model_echoed from the SERVER', async () => {
    const base = await listen(sseChatCompletions('qwen3.5-4b-served', ['O', 'K']));
    const r = ok(await probeLlm({ protocol: 'openai-compatible', endpoint: `${base}/v1`, api_key: 'EMPTY', model: 'qwen3.5-4b' }));
    expect(r.sample_output).toBe('OK');
    // The dimension is worth having only because it can DISAGREE with the config.
    expect(r.model_echoed).toBe('qwen3.5-4b-served');
    expect(r.probe_kind).toBe('completion');
    expect(r.latency_ms).toBeGreaterThanOrEqual(0);
    expect(r.byok).toBe(false); // 'EMPTY' = platform sentinel (06 §4), not BYOK
  });

  it('a user-supplied key is judged BYOK with the engine layer rule', async () => {
    const base = await listen(sseChatCompletions('m', ['hi']));
    expect(ok(await probeLlm({ protocol: 'openai-compatible', endpoint: `${base}/v1`, api_key: 'sk-real', model: 'm' })).byok).toBe(true);
  });

  it('caps sample_output at 80 chars and collapses whitespace', async () => {
    const long = 'x'.repeat(200);
    const r = ok(await probeLlm({ protocol: 'openai-compatible', endpoint: 'http://x/v1', api_key: '', model: 'm' }, {
      streamerFor: streamerOf([{ kind: 'done', full: `  a\n\nb  ${long}` }]),
    }));
    expect(r.sample_output.length).toBe(SAMPLE_OUTPUT_MAX);
    expect(r.sample_output.startsWith('a b x')).toBe(true);
    expect(clampSample(' a \n b ')).toBe('a b');
  });

  it('model_echoed is null (→ UI "not provided") when the provider says nothing', async () => {
    const r = ok(await probeLlm({ protocol: 'openai-compatible', endpoint: 'http://x/v1', api_key: '', model: 'm' }, {
      streamerFor: streamerOf([{ kind: 'done', full: 'OK' }]),
    }));
    expect(r.model_echoed).toBeNull();
  });

  it('resolves a preset_id body the same way the settings reader does', () => {
    const cfg = parseLlmProbeBody({ preset_id: 'lan-vllm-qwen35', model: 'override-model' });
    expect(cfg.model).toBe('override-model');
    expect(cfg.endpoint.length).toBeGreaterThan(0);
  });
});

describe('GA-12 LLM probe — failures are named, never 500', () => {
  it('an unreachable endpoint → ok:false LLM_PROBE_FAIL with the raw reason', async () => {
    const r = bad(await probeLlm({ protocol: 'openai-compatible', endpoint: 'http://127.0.0.1:1/v1', api_key: '', model: 'm' }));
    expect(r.code).toBe('LLM_PROBE_FAIL');
    expect(r.message.length).toBeGreaterThan(0); // the collapsible raw error
  });

  it('keeps the DIAGNOSING codes (auth / rate limit) instead of flattening them', async () => {
    const auth = bad(await probeLlm({ protocol: 'openai-compatible', endpoint: 'http://x/v1', api_key: 'bad', model: 'm' }, {
      streamerFor: streamerOf([{ kind: 'error', code: 'LLM_AUTH_FAIL', message: 'http 401' }]),
    }));
    expect(auth.code).toBe('LLM_AUTH_FAIL');
    const rate = bad(await probeLlm({ protocol: 'openai-compatible', endpoint: 'http://x/v1', api_key: 'k', model: 'm' }, {
      streamerFor: streamerOf([{ kind: 'error', code: 'LLM_RATE_LIMITED', message: 'http 429' }]),
    }));
    expect(rate.code).toBe('LLM_RATE_LIMITED');
  });

  it('an HTTP 500 from the provider is a probe failure, not a server fault', async () => {
    const base = await listen((_req, res) => { res.writeHead(500).end(); });
    const r = bad(await probeLlm({ protocol: 'openai-compatible', endpoint: `${base}/v1`, api_key: '', model: 'm' }));
    expect(r.code).toBe('LLM_PROBE_FAIL');
  });

  it('a hanging endpoint trips the deadline → LLM_TIMEOUT', async () => {
    const base = await listen(() => { /* never answers */ });
    const r = bad(await probeLlm({ protocol: 'openai-compatible', endpoint: `${base}/v1`, api_key: '', model: 'm' }, { timeoutMs: 120 }));
    expect(r.code).toBe('LLM_TIMEOUT');
  });

  it('a malformed body fails loud before anything is dialled', async () => {
    expect(bad(await probeLlm({})).code).toBe('LLM_INVALID_MODEL');
    expect(bad(await probeLlm({ protocol: 'telepathy', endpoint: 'http://x', model: 'm' })).code).toBe('LLM_INVALID_MODEL');
    expect(bad(await probeLlm({ preset_id: 'no-such-preset' })).code).toBe('LLM_INVALID_MODEL');
  });
});

// ── ② STT probe: graded by engine capability ─────────────────────────────────

describe('GA-12 STT probe — capability grading', () => {
  it('grades every bundled engine id', () => {
    expect(probeKindFor('funasr')).toBe('handshake');
    expect(probeKindFor('deepgram')).toBe('handshake');
    expect(probeKindFor('openai-realtime')).toBe('handshake');
    expect(probeKindFor('openai-whisper')).toBe('transcribe');
    expect(probeKindFor('custom-openai-compatible')).toBe('transcribe');
    expect(probeKindFor('funspeech-http')).toBe('transcribe');
    expect(probeKindFor('sherpa-local')).toBe('local-model');
  });

  it('a ws engine reports the handshake HONESTLY — empty sample, never a fake transcript', async () => {
    const r = ok(await probeStt(
      { routings: [{ language: 'zh-CN', engine_id: 'funasr', endpoint: 'ws://10.0.0.1:10095' }], language: 'zh-CN' },
      { engineFactory: (id, cfg) => new FakeEngine(id, cfg, {}) },
    ));
    expect(r.probe_kind).toBe('handshake');
    expect(r.sample_output).toBe('');
    expect(r.model_echoed).toBeNull();
  });

  it('an http batch engine does a REAL POST and returns what came back', async () => {
    const r = ok(await probeStt(
      { routing: { language: 'zh-CN', engine_id: 'custom-openai-compatible', endpoint: 'http://10.0.0.1:50000/v1' } },
      { engineFactory: (id, cfg) => new FakeEngine(id, cfg, { finalText: '  探针 样例  ' }) },
    ));
    expect(r.probe_kind).toBe('transcribe');
    expect(r.sample_output).toBe('探针 样例');
  });

  it('a live openai-compatible ASR endpoint answers end to end (no LAN needed)', async () => {
    const base = await listen((req, res) => {
      if (!(req.url ?? '').endsWith('/audio/transcriptions')) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'probe ok' }));
    });
    const r = ok(await probeStt({ routing: { language: 'zh-CN', engine_id: 'custom-openai-compatible', endpoint: `${base}/v1` } }));
    expect(r.sample_output).toBe('probe ok');
    expect(r.probe_kind).toBe('transcribe');
  });

  it('an empty transcript from a live endpoint is still ok (silence in → nothing out)', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"text":""}');
    });
    const r = ok(await probeStt({ routing: { language: 'zh-CN', engine_id: 'custom-openai-compatible', endpoint: `${base}/v1` } }));
    expect(r.sample_output).toBe('');
  });

  it('the built-in engine checks the MODEL FILES and never starts a download', async () => {
    const factory = vi.fn();
    const ready = ok(await probeStt({ routing: { language: '*', engine_id: 'sherpa-local' } }, {
      sherpaModelReady: () => Promise.resolve(true),
      engineFactory: factory as never,
    }));
    expect(ready.probe_kind).toBe('local-model');
    expect(ready.model_echoed).toContain('sense-voice');
    expect(factory).not.toHaveBeenCalled(); // no engine → no ensureSherpaModel → no 228 MB fetch

    const missing = bad(await probeStt({ routing: { language: '*', engine_id: 'sherpa-local' } }, {
      sherpaModelReady: () => Promise.resolve(false),
    }));
    expect(missing.code).toBe('STT_CONFIG_MISSING');
  });
});

describe('GA-12 STT probe — failures', () => {
  it('a dead ws endpoint → STT_PROBE_FAIL', async () => {
    const r = bad(await probeStt({ routing: { language: 'zh-CN', engine_id: 'funasr', endpoint: 'ws://10.0.0.1:10095' } }, {
      engineFactory: (id, cfg) => new FakeEngine(id, cfg, { openError: new Error('connect ECONNREFUSED') }),
    }));
    expect(r.code).toBe('STT_PROBE_FAIL');
    expect(r.probe_kind).toBe('handshake');
    expect(r.message).toContain('ECONNREFUSED');
  });

  it('wss:// dead but ws:// alive → STT_PROBE_SCHEME_MISMATCH (the actionable code)', async () => {
    const r = bad(await probeStt({ routing: { language: 'zh-CN', engine_id: 'funasr', endpoint: 'wss://10.0.0.1:10095' } }, {
      engineFactory: (id, cfg) => new FakeEngine(id, cfg, {
        ...(cfg.endpoint?.startsWith('wss://') ? { openError: new Error('TLS handshake failed') } : {}),
      }),
    }));
    expect(r.code).toBe('STT_PROBE_SCHEME_MISMATCH');
  });

  it('an engine error code that DIAGNOSES survives (auth), otherwise STT_PROBE_FAIL', async () => {
    const r = bad(await probeStt({ routing: { language: 'zh-CN', engine_id: 'openai-whisper', endpoint: 'http://x/v1' } }, {
      engineFactory: (id, cfg) => new FakeEngine(id, cfg, { flushError: new SttEngineError('STT_ENGINE_AUTH_FAIL', 'whisper http 401', false) }),
    }));
    expect(r.code).toBe('STT_ENGINE_AUTH_FAIL');
  });

  it('no routing for the language → STT_CONFIG_MISSING (no implicit fallback)', async () => {
    const r = bad(await probeStt({ routings: [{ language: 'en-US', engine_id: 'funasr' }], language: 'ja-JP' }));
    expect(r.code).toBe('STT_CONFIG_MISSING');
    expect(r.probe_kind).toBeUndefined();
  });

  it('resolves the routing with the production §4 algorithm (exact → wildcard)', () => {
    const routings = [
      { language: 'zh-CN', engine_id: 'funasr' as SttEngineId },
      { language: '*', engine_id: 'sherpa-local' as SttEngineId },
    ];
    expect(parseSttProbeBody({ routings, language: 'zh-CN' }).routing?.engine_id).toBe('funasr');
    expect(parseSttProbeBody({ routings, language: 'ko-KR' }).routing?.engine_id).toBe('sherpa-local');
  });
});

// ── ③ the REST surface: 200-with-code, CORS, mode gating ─────────────────────

describe('GA-12 probe REST', () => {
  it('a dead endpoint answers HTTP 200 with ok:false + a named code (NOT 500)', async () => {
    const url = await flowmicServer();
    const r = await post(`${url}/api/probe/llm`, { protocol: 'openai-compatible', endpoint: 'http://127.0.0.1:1/v1', api_key: '', model: 'm' });
    expect(r.status).toBe(200);
    expect(bad(r.json).code).toBe('LLM_PROBE_FAIL');

    const s = await post(`${url}/api/probe/stt`, { routings: [] });
    expect(s.status).toBe(200);
    expect(bad(s.json).code).toBe('STT_CONFIG_MISSING');
  });

  it('serves a live probe end to end through the router', async () => {
    const base = await listen(sseChatCompletions('served-model', ['OK']));
    const url = await flowmicServer();
    const r = await post(`${url}/api/probe/llm`, { protocol: 'openai-compatible', endpoint: `${base}/v1`, api_key: '', model: 'm' });
    const body = ok(r.json);
    expect(body.sample_output).toBe('OK');
    expect(body.model_echoed).toBe('served-model');
  });

  it('answers the desktop WebView preflight and NO other origin', async () => {
    const url = await flowmicServer();
    const allowed = await fetch(`${url}/api/probe/llm`, { method: 'OPTIONS', headers: { origin: 'http://tauri.localhost' } });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost');
    const evil = await fetch(`${url}/api/probe/llm`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('is standalone-only — saas does not mount it (no SSRF pivot)', async () => {
    const url = await flowmicServer({}, 'saas');
    const r = await fetch(`${url}/api/probe/llm`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(404);
  });

  it('GET is not a probe (404) — the config only ever travels in a POST body', async () => {
    const url = await flowmicServer();
    expect((await fetch(`${url}/api/probe/stt`)).status).toBe(404);
  });
});

// ── ④ a probe bills nothing and persists nothing ─────────────────────────────

describe('GA-12 probe is free and side-effect-free', () => {
  it('touches NO BillingService method (ensureQuota / record*Usage never reached)', async () => {
    const spy = billingSpy();
    const url = await flowmicServer({ billing: spy as never });
    await post(`${url}/api/probe/llm`, { protocol: 'openai-compatible', endpoint: 'http://127.0.0.1:1/v1', api_key: '', model: 'm' });
    await post(`${url}/api/probe/stt`, { routing: { language: 'zh-CN', engine_id: 'openai-whisper', endpoint: 'http://127.0.0.1:1/v1' } });
    for (const [name, fn] of Object.entries(spy)) {
      expect(fn, `billing.${name} must never be reached from a probe`).not.toHaveBeenCalled();
    }
  });

  it('cannot write a setting or a usage row — it imports nothing that could', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/http/probe-routes.ts', import.meta.url)), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1] as string);
    for (const spec of imports) {
      expect(/\/db\/|\/billing\/|settings\.repo|usage\.repo/.test(spec), `probe-routes must not import ${spec}`).toBe(false);
    }
    // …and names none of the metering seams either (the exactly-one call-site rule).
    for (const seam of ['ensureQuota', 'recordSttUsage', 'recordLlmUsage']) {
      expect(src.includes(`${seam}(`), `probe-routes must not call ${seam}`).toBe(false);
    }
  });
});
