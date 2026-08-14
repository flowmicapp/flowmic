// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (funspeech-http HTTP batch custom: WAV
//     octet-stream POST + query (punctuation/ITN); {status:20000000,result})
//   Ported from legacy stt/engines/funspeech-http.ts (mechanism kept as-is, F-403/F-3071).
//
// FunSpeech (Paraformer) HTTP-batch STT adapter. Accumulates PCM, builds a WAV
// on flush(), POSTs the binary payload to `/stream/v1/asr`. The
// {"status":20000000,"result":"..."} response → a single FinalResult. No
// interim events — the upstream service is batch-only.

import { EventEmitter } from 'node:events';
import type { EngineState, FinalResult, SttEngine, SttEngineConfig } from './base';
import { SttEngineError, requireEndpoint } from './base';
import { funspeechItnFromEnv, funspeechPuncFromEnv } from '../tuning-env';
import { buildWav } from './wav';

const ASR_PATH = '/stream/v1/asr';

/** Baseline query (both flags true). Env overrides via buildAsrQuery. */
export function buildAsrQuery(env: NodeJS.ProcessEnv = process.env): string {
  const punc = funspeechPuncFromEnv(env);
  const itn = funspeechItnFromEnv(env);
  return (
    `format=wav&sample_rate=16000&enable_punctuation_prediction=${punc}` +
    `&enable_inverse_text_normalization=${itn}`
  );
}

interface FunspeechResponse {
  status?: number;
  result?: string;
  message?: string;
}

export interface FunspeechHttpDeps {
  fetch?: typeof fetch;
}

export class FunspeechHttpEngine extends EventEmitter implements SttEngine {
  readonly id = 'funspeech-http';
  private _state: EngineState = 'closed';
  private chunks: Buffer[] = [];
  private byteLength = 0;

  constructor(private cfg: SttEngineConfig, private deps: FunspeechHttpDeps = {}) {
    super();
  }

  get state(): EngineState {
    return this._state;
  }

  open(): Promise<void> {
    if (this._state !== 'closed') {
      return Promise.reject(new Error(`FunspeechHttpEngine.open: illegal in state ${this._state}`));
    }
    this.chunks = [];
    this.byteLength = 0;
    this.transition('open');
    return Promise.resolve();
  }

  push(chunk: Buffer): void {
    if (this._state !== 'open') {
      throw new SttEngineError('STT_ENGINE_TIMEOUT', `FunspeechHttpEngine.push: not open (${this._state})`, true);
    }
    this.chunks.push(chunk);
    this.byteLength += chunk.length;
  }

  async flush(): Promise<void> {
    if (this._state !== 'open') return;
    if (this.byteLength === 0) return;

    const pcm = Buffer.concat(this.chunks, this.byteLength);
    const wav = buildWav(pcm, this.cfg.sample_rate);
    // OSS-DEFAULTS: no endpoint ⇒ a named refusal on the 'error' channel, never
    // a guessed address. Emitted rather than thrown because every other failure
    // in this flush() reaches the orchestrator that way.
    let base: string;
    try {
      base = requireEndpoint(this.id, this.cfg.endpoint);
    } catch (err) {
      this.emit('error', err);
      return;
    }
    const url = buildUrl(base);
    const doFetch = this.deps.fetch ?? globalThis.fetch;

    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: wav,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'fetch failed';
      this.emit('error', new SttEngineError('STT_ENGINE_TIMEOUT', `FunSpeech fetch failed: ${msg}`, true));
      return;
    }

    if (!response.ok) {
      const code = response.status === 429 ? 'STT_ENGINE_RATE_LIMITED' : 'STT_ENGINE_TIMEOUT';
      this.emit('error', new SttEngineError(code, `FunSpeech HTTP ${response.status}`, response.status >= 500));
      return;
    }

    let body: FunspeechResponse;
    try {
      body = (await response.json()) as FunspeechResponse;
    } catch {
      this.emit('error', new SttEngineError('STT_ENGINE_TIMEOUT', 'FunSpeech invalid JSON response', true));
      return;
    }

    if (body.status !== 20000000) {
      this.emit('error', new SttEngineError('STT_ENGINE_TIMEOUT', `FunSpeech bad status ${body.status ?? 'undefined'}: ${body.message ?? ''}`.trim(), true));
      return;
    }

    const ev: FinalResult = {
      kind: 'final',
      text: body.result ?? '',
      confidence: 1,
      language: this.cfg.language,
      duration_ms: Math.round((this.byteLength / (this.cfg.sample_rate * 2)) * 1000),
    };
    this.emit('final', ev);

    this.chunks = [];
    this.byteLength = 0;
  }

  async close(): Promise<void> {
    this.chunks = [];
    this.byteLength = 0;
    this.transition('closed');
    this.removeAllListeners();
  }

  private transition(next: EngineState): void {
    this._state = next;
    this.emit('state', next);
  }
}

/**
 * Normalize an endpoint URL to the canonical FunSpeech ASR URL. Accepts either
 * `http://host:port` (root) or `http://host:port/stream/v1/asr`. Output is
 * exactly `{base}/stream/v1/asr?<canonical query>`.
 */
function buildUrl(endpoint: string): string {
  let base = endpoint.split('?')[0]!;
  while (base.endsWith('/')) base = base.slice(0, -1);
  if (base.toLowerCase().endsWith(ASR_PATH)) {
    base = base.slice(0, -ASR_PATH.length);
  }
  while (base.endsWith('/')) base = base.slice(0, -1);
  return `${base}${ASR_PATH}?${buildAsrQuery()}`;
}
