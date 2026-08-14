// WP-R1-3 engine contract tests (mock-endpoint replay). Covers the funasr WS
// 2pass frame protocol, the whisper/custom-openai batch WAV header + empty-key
// handling, deepgram/openai-realtime ws contracts, and funspeech-http status
// mapping. No real network — every engine's transport is injected.

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { FunasrEngine } from '../src/stt/engines/funasr';
import { DeepgramEngine } from '../src/stt/engines/deepgram';
import { OpenAiRealtimeEngine } from '../src/stt/engines/openai-realtime';
import { OpenAiWhisperEngine } from '../src/stt/engines/openai-whisper';
import { CustomOpenAiCompatibleEngine } from '../src/stt/engines/custom-openai-compatible';
import { FunspeechHttpEngine } from '../src/stt/engines/funspeech-http';
import { SttEngineError, requireEndpoint, type SttEngineConfig } from '../src/stt/engines/base';

/** A fake `ws` socket: EventEmitter + send/close spies + a header capture. */
class FakeWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  constructor(public url: string, public options?: { headers?: Record<string, string> }) { super(); }
  send(data: string | Buffer): void { this.sent.push(data); }
  close(): void { this.closed = true; this.emit('close'); }
  /** Simulate a successful handshake. */
  openIt(): void { this.emit('open'); }
  /** Simulate a server frame. */
  frame(obj: unknown): void { this.emit('message', Buffer.from(JSON.stringify(obj))); }
  jsonSent(): unknown[] { return this.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s as string)); }
}

const cfg = (over: Partial<SttEngineConfig> = {}): SttEngineConfig => ({
  id: 'funasr', language: 'zh-CN', sample_rate: 16_000, ...over,
});

function wav16bytes(pcmBytes: number): Buffer {
  return Buffer.alloc(pcmBytes); // silence PCM
}

describe('FunasrEngine — WS 2pass frame protocol', () => {
  it('sends the 2pass open frame and maps online→interim / offline→final', async () => {
    let ws!: FakeWs;
    const engine = new FunasrEngine(cfg({ endpoint: 'ws://fake:10095' }), {
      connect: (url) => { ws = new FakeWs(url); return ws as never; },
    });
    const interims: string[] = []; const finals: string[] = [];
    engine.on('interim', (e) => interims.push(e.text));
    engine.on('final', (e) => finals.push(e.text));

    const opened = engine.open();
    ws.openIt();
    await opened;

    // Open frame contract (06 §3).
    const open = ws.jsonSent()[0] as Record<string, unknown>;
    expect(open).toMatchObject({ mode: '2pass', wav_name: 'h5', audio_fs: 16_000, is_speaking: true, itn: true });
    expect(open.chunk_size).toEqual([5, 10, 5]);
    expect(open.chunk_interval).toBe(10);
    expect('hotwords' in open).toBe(false); // omitted when dictionary empty

    engine.push(Buffer.alloc(6400));
    expect(ws.sent.some((s) => Buffer.isBuffer(s))).toBe(true); // binary PCM frame

    ws.frame({ mode: '2pass-online', text: '大家' });
    ws.frame({ mode: '2pass-offline', text: '大家好' });
    expect(interims).toEqual(['大家']);
    expect(finals).toEqual(['大家好']);

    const flushed = engine.flush();
    expect(ws.jsonSent().some((f) => (f as Record<string, unknown>).is_speaking === false)).toBe(true);
    ws.frame({ mode: '2pass-offline', text: '大家好', is_final: true });
    await flushed;
  });

  it('adds the hotwords field only when the dictionary is non-empty', async () => {
    let ws!: FakeWs;
    const engine = new FunasrEngine(cfg({ hotwords: '{"FlowMic":20}', endpoint: 'ws://fake:10095' }), {
      connect: (url) => { ws = new FakeWs(url); return ws as never; },
    });
    const opened = engine.open(); ws.openIt(); await opened;
    const open = ws.jsonSent()[0] as Record<string, unknown>;
    expect(open.hotwords).toBe('{"FlowMic":20}');
  });

  it('rejects open() on a connect error and does not crash on a late ws error', async () => {
    let ws!: FakeWs;
    const engine = new FunasrEngine(cfg({ endpoint: 'ws://fake:10095' }), { connect: (url) => { ws = new FakeWs(url); return ws as never; } });
    const opened = engine.open();
    ws.emit('error', new Error('ECONNREFUSED'));
    await expect(opened).rejects.toThrow(/ECONNREFUSED/);
    await engine.close();
    // A late ws error after close must be swallowed (no uncaught throw).
    expect(() => ws.emit('error', new Error('closed before established'))).not.toThrow();
  });
});

describe('OpenAiWhisperEngine — batch WAV header + auth', () => {
  async function runFlush(apiKey: string | undefined): Promise<{ header: Buffer; headers: Record<string, string> }> {
    let capturedHeader = Buffer.alloc(0);
    let capturedHeaders: Record<string, string> = {};
    const fakeFetch = vi.fn(async (_url: string, init: { body: FormData; headers: Record<string, string> }) => {
      const file = init.body.get('file') as Blob;
      capturedHeader = Buffer.from(await file.arrayBuffer()).subarray(0, 44);
      capturedHeaders = init.headers;
      return { ok: true, status: 200, json: async () => ({ text: 'hello world' }) } as unknown as Response;
    });
    const engine = new OpenAiWhisperEngine(
      cfg({ id: 'openai-whisper', language: 'en', endpoint: 'http://fake:8200/v1', ...(apiKey !== undefined ? { api_key: apiKey } : {}) }),
      { fetch: fakeFetch as unknown as typeof fetch },
    );
    const finals: string[] = [];
    engine.on('final', (e) => finals.push(e.text));
    await engine.open();
    engine.push(wav16bytes(3200));
    await engine.flush();
    expect(finals).toEqual(['hello world']);
    return { header: capturedHeader, headers: capturedHeaders };
  }

  it('POSTs a canonical 44-byte 16kHz-mono WAV header and emits a final', async () => {
    const { header } = await runFlush('');
    expect(header.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(header.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(header.subarray(12, 16).toString('ascii')).toBe('fmt ');
    expect(header.readUInt16LE(20)).toBe(1);       // PCM
    expect(header.readUInt16LE(22)).toBe(1);       // mono
    expect(header.readUInt32LE(24)).toBe(16_000);  // sample rate
    expect(header.readUInt16LE(34)).toBe(16);      // bits/sample
    expect(header.subarray(36, 40).toString('ascii')).toBe('data');
  });

  it('omits Authorization for an empty key, sends Bearer for a real key', async () => {
    const empty = await runFlush('');
    expect(empty.headers.Authorization).toBeUndefined();
    const keyed = await runFlush('sk-test-key');
    expect(keyed.headers.Authorization).toBe('Bearer sk-test-key');
  });

  it('maps HTTP 401 → STT_ENGINE_AUTH_FAIL (non-retryable)', async () => {
    const engine = new OpenAiWhisperEngine(cfg({ id: 'openai-whisper', language: 'en', endpoint: 'http://fake:8200/v1' }), {
      fetch: (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch,
    });
    const errs: SttEngineError[] = [];
    engine.on('error', (e) => errs.push(e));
    await engine.open();
    engine.push(wav16bytes(3200));
    await engine.flush();
    expect(errs[0]?.code).toBe('STT_ENGINE_AUTH_FAIL');
    expect(errs[0]?.retryable).toBe(false);
  });
});

describe('CustomOpenAiCompatibleEngine — SenseVoice batch, empty key legal', () => {
  it('accepts an empty api_key (no Authorization) and emits the transcript', async () => {
    let headers: Record<string, string> = {};
    const engine = new CustomOpenAiCompatibleEngine(
      cfg({ id: 'custom-openai-compatible', language: '*', model: 'SenseVoiceSmall', api_key: '', endpoint: 'http://fake:50000/v1' }),
      { fetch: (async (_u: string, init: { headers: Record<string, string> }) => {
        headers = init.headers;
        return { ok: true, status: 200, json: async () => ({ text: '开放时间早上9点' }) } as unknown as Response;
      }) as unknown as typeof fetch },
    );
    const finals: string[] = [];
    engine.on('final', (e) => finals.push(e.text));
    await engine.open();
    engine.push(wav16bytes(6400));
    await engine.flush();
    expect(headers.Authorization).toBeUndefined();
    expect(finals).toEqual(['开放时间早上9点']);
  });
});

describe('DeepgramEngine — WS streaming contract', () => {
  it('carries Token auth + linear16 URL params, maps is_final and flushes via CloseStream', async () => {
    let ws!: FakeWs;
    const engine = new DeepgramEngine(cfg({ id: 'deepgram', language: 'en-US', api_key: 'dg-key' }), {
      connect: (url, options) => { ws = new FakeWs(url, options); return ws as never; },
    });
    const finals: string[] = []; const interims: string[] = [];
    engine.on('final', (e) => finals.push(e.text)); engine.on('interim', (e) => interims.push(e.text));
    const opened = engine.open(); ws.openIt(); await opened;
    expect(ws.url).toContain('encoding=linear16');
    expect(ws.url).toContain('language=en');
    expect(ws.options?.headers?.Authorization).toBe('Token dg-key');
    ws.frame({ channel: { alternatives: [{ transcript: 'hello', confidence: 0.9 }] }, is_final: false });
    ws.frame({ channel: { alternatives: [{ transcript: 'hello world', confidence: 0.95 }] }, is_final: true });
    expect(interims).toEqual(['hello']);
    expect(finals).toEqual(['hello world']);
    const flushed = engine.flush();
    expect(ws.jsonSent().some((f) => (f as Record<string, unknown>).type === 'CloseStream')).toBe(true);
    ws.frame({ channel: { alternatives: [{ transcript: 'hello world', confidence: 0.95 }] }, is_final: true });
    await flushed;
  });
});

describe('OpenAiRealtimeEngine — session.update + append/commit', () => {
  it('sends pcm16 session.update on open and commits on flush', async () => {
    let ws!: FakeWs;
    const engine = new OpenAiRealtimeEngine(cfg({ id: 'openai-realtime', language: 'en', api_key: 'sk-x' }), {
      connect: (url, options) => { ws = new FakeWs(url, options); return ws as never; },
    });
    const finals: string[] = [];
    engine.on('final', (e) => finals.push(e.text));
    const opened = engine.open(); ws.openIt(); await opened;
    const upd = ws.jsonSent()[0] as { type: string; session: Record<string, unknown> };
    expect(upd.type).toBe('session.update');
    expect(upd.session.input_audio_format).toBe('pcm16');
    engine.push(Buffer.alloc(6400));
    expect(ws.jsonSent().some((f) => (f as Record<string, unknown>).type === 'input_audio_buffer.append')).toBe(true);
    const flushed = engine.flush();
    expect(ws.jsonSent().some((f) => (f as Record<string, unknown>).type === 'input_audio_buffer.commit')).toBe(true);
    ws.frame({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'done' });
    await flushed;
    expect(finals).toEqual(['done']);
  });
});

describe('FunspeechHttpEngine — status mapping', () => {
  it('maps {status:20000000,result} → final and octet-stream POST', async () => {
    let contentType = '';
    const engine = new FunspeechHttpEngine(cfg({ id: 'funspeech-http', language: 'zh-CN', endpoint: 'http://fake:9000' }), {
      fetch: (async (_u: string, init: { headers: Record<string, string> }) => {
        contentType = init.headers['Content-Type'] ?? '';
        return { ok: true, status: 200, json: async () => ({ status: 20000000, result: '你好世界' }) } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const finals: string[] = [];
    engine.on('final', (e) => finals.push(e.text));
    await engine.open();
    engine.push(wav16bytes(6400));
    await engine.flush();
    expect(contentType).toBe('application/octet-stream');
    expect(finals).toEqual(['你好世界']);
  });

  it('emits an error for a non-2000-0000 status (no silent success)', async () => {
    const engine = new FunspeechHttpEngine(cfg({ id: 'funspeech-http', language: 'zh-CN', endpoint: 'http://fake:9000' }), {
      fetch: (async () => ({ ok: true, status: 200, json: async () => ({ status: 40000000, message: 'bad' }) })) as unknown as typeof fetch,
    });
    const errs: SttEngineError[] = [];
    engine.on('error', (e) => errs.push(e));
    await engine.open();
    engine.push(wav16bytes(6400));
    await engine.flush();
    expect(errs).toHaveLength(1);
    expect(errs[0]?.code).toBe('STT_ENGINE_TIMEOUT');
  });
});

// 🔴 OSS-DEFAULTS (0.3.0) — A MISSING ENDPOINT IS A NAMED REFUSAL, NOT AN ADDRESS.
//
// Until this card each of these four engines carried
// `const DEFAULT_ENDPOINT = '…100.64.7.68…'` and dialled it whenever the routing
// carried no endpoint. Two things were wrong at once: the owner's office LAN was
// compiled into a shipped artifact, and 「this route has no address configured」 was answered by a
// connection attempt to somebody else's machine — which fails, eventually, as a
// NETWORK error, sending the operator to look at their router instead of at their
// configuration.
//
// What is asserted here is the pair that makes the answer actionable: the engine
// id (WHICH engine) and the config key (WHICH setting is empty). A test that only
// asserted「it throws」would stay green if the message degraded to 'error'.
//
// ⚠️ NOT asserted: that no request was made. `fetch`/`connect` are injected here,
// so a spy proving 「zero requests」 would be proving something about this harness. The
// binding claim is the absence of the constant — grep `DEFAULT_ENDPOINT` under
// src/stt/engines/, which is now zero.
describe('OSS-DEFAULTS — an unconfigured network engine refuses by name', () => {
  const noEndpoint = (id: SttEngineConfig['id']): SttEngineConfig =>
    ({ id, language: 'zh-CN', sample_rate: 16_000 });

  it('funasr rejects open() with STT_CONFIG_MISSING naming the engine and the key', async () => {
    const engine = new FunasrEngine(noEndpoint('funasr'), {
      connect: () => { throw new Error('connect must never be reached'); },
    });
    await expect(engine.open()).rejects.toMatchObject({
      code: 'STT_CONFIG_MISSING',
      retryable: false,
    });
    await expect(engine.open()).rejects.toThrow(/funasr/);
    await expect(engine.open()).rejects.toThrow(/stt\.routings\[\]\.endpoint/);
  });

  for (const [label, make] of [
    ['openai-whisper', (c: SttEngineConfig) => new OpenAiWhisperEngine(c, {
      fetch: (() => { throw new Error('fetch must never be reached'); }) as unknown as typeof fetch,
    })],
    ['custom-openai-compatible', (c: SttEngineConfig) => new CustomOpenAiCompatibleEngine(c, {
      fetch: (() => { throw new Error('fetch must never be reached'); }) as unknown as typeof fetch,
    })],
    ['funspeech-http', (c: SttEngineConfig) => new FunspeechHttpEngine(c, {
      fetch: (() => { throw new Error('fetch must never be reached'); }) as unknown as typeof fetch,
    })],
  ] as const) {
    it(`${label} emits STT_CONFIG_MISSING naming the engine and the key`, async () => {
      const engine = make(noEndpoint(label));
      const errs: SttEngineError[] = [];
      engine.on('error', (e) => errs.push(e));
      await engine.open?.();
      engine.push(wav16bytes(3200));
      await engine.flush();
      expect(errs).toHaveLength(1);
      expect(errs[0]?.code).toBe('STT_CONFIG_MISSING');
      expect(errs[0]?.retryable).toBe(false);
      expect(errs[0]?.message).toContain(label);
      expect(errs[0]?.message).toContain('stt.routings[].endpoint');
    });
  }

  it("an EMPTY STRING endpoint is refused too — '' is an address to `new URL`, not an absence", () => {
    // The shape that would otherwise slip past a `?? ` guard and be resolved as
    // a relative URL against whatever origin happened to be around.
    expect(() => requireEndpoint('funasr', '')).toThrow(/STT engine 'funasr' has no endpoint/);
    expect(() => requireEndpoint('funasr', undefined)).toThrow(/no endpoint/);
    expect(requireEndpoint('funasr', 'ws://real:10095')).toBe('ws://real:10095');
  });
});
