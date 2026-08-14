// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (openai-whisper HTTP batch: PCM accumulation → 44
//     -byte WAV header → multipart /audio/transcriptions; final only, no interim)
//   Ported from legacy stt/engines/openai-whisper.ts (mechanism unchanged from the legacy line, F-403/F-3071).
//
// OpenAI Whisper HTTP-batch adapter. push() accumulates PCM; flush() wraps them
// in a 16-kHz mono s16le WAV (44-byte canonical header) and POSTs as
// multipart/form-data to `{endpoint}/audio/transcriptions`. The single response
// is emitted as a `final` event. No interim events — batch protocol.

import { EventEmitter } from 'node:events';
import type { EngineState, FinalResult, SttEngine, SttEngineConfig } from './base';
import { SttEngineError, requireEndpoint } from './base';
import { whisperTemperatureFromEnv } from '../tuning-env';
import { buildWav16kMono, stripTrailingSlash, toShortLang, SAMPLE_RATE, BYTES_PER_SAMPLE } from './wav';

const DEFAULT_MODEL = 'whisper-large-v3-turbo';

export interface OpenAiWhisperEngineDeps {
  fetch?: typeof fetch;
}

interface WhisperResponseBody { text?: string }

export class OpenAiWhisperEngine extends EventEmitter implements SttEngine {
  readonly id = 'openai-whisper';
  private _state: EngineState = 'closed';
  private chunks: Buffer[] = [];
  private byteLength = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(private cfg: SttEngineConfig, deps: OpenAiWhisperEngineDeps = {}) {
    super();
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
  }

  get state(): EngineState { return this._state; }

  open(): Promise<void> {
    if (this._state !== 'closed') {
      return Promise.reject(new Error(`OpenAiWhisperEngine.open: illegal in state ${this._state}`));
    }
    this.chunks = [];
    this.byteLength = 0;
    this.transition('open');
    return Promise.resolve();
  }

  push(chunk: Buffer): void {
    if (this._state !== 'open') {
      throw new SttEngineError('STT_ENGINE_TIMEOUT', `OpenAiWhisperEngine.push: not open (${this._state})`, true);
    }
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.byteLength += chunk.length;
  }

  async flush(): Promise<void> {
    if (this._state !== 'open' || this.byteLength === 0) return;

    const pcm = Buffer.concat(this.chunks, this.byteLength);
    const wav = buildWav16kMono(pcm);
    this.chunks = [];
    this.byteLength = 0;

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
    const url = `${stripTrailingSlash(base)}/audio/transcriptions`;
    const form = new FormData();
    form.set('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.set('model', this.cfg.model ?? DEFAULT_MODEL);
    form.set('language', toShortLang(this.cfg.language));
    form.set('response_format', 'json');
    const temperature = whisperTemperatureFromEnv();
    if (temperature !== undefined) form.set('temperature', String(temperature));

    const headers: Record<string, string> = {};
    if (this.cfg.api_key && this.cfg.api_key.length > 0) {
      headers['Authorization'] = `Bearer ${this.cfg.api_key}`;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'POST', body: form, headers });
    } catch (err) {
      this.emit('error', wrapTimeout(err, 'whisper fetch failed'));
      return;
    }

    if (!res.ok) {
      this.emit('error', mapHttpError(res.status));
      return;
    }

    let body: WhisperResponseBody;
    try {
      body = (await res.json()) as WhisperResponseBody;
    } catch (err) {
      this.emit('error', wrapTimeout(err, 'invalid whisper json'));
      return;
    }

    const ev: FinalResult = {
      kind: 'final',
      text: typeof body.text === 'string' ? body.text : '',
      confidence: 1,
      language: this.cfg.language,
      duration_ms: Math.round((pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000),
    };
    this.emit('final', ev);
  }

  close(): Promise<void> {
    this.chunks = [];
    this.byteLength = 0;
    this.transition('closed');
    this.removeAllListeners();
    return Promise.resolve();
  }

  private transition(next: EngineState): void {
    this._state = next;
    this.emit('state', next);
  }
}

function wrapTimeout(err: unknown, fallback: string): SttEngineError {
  const msg = (err as Error)?.message ?? fallback;
  return new SttEngineError('STT_ENGINE_TIMEOUT', msg, true);
}

function mapHttpError(status: number): SttEngineError {
  if (status === 401 || status === 403) {
    return new SttEngineError('STT_ENGINE_AUTH_FAIL', `whisper http ${status}`, false);
  }
  if (status === 429) {
    return new SttEngineError('STT_ENGINE_RATE_LIMITED', `whisper http ${status}`, true);
  }
  return new SttEngineError('STT_ENGINE_TIMEOUT', `whisper http ${status}`, true);
}
