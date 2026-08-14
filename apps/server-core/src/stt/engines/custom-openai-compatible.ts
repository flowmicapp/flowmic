// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (custom-openai-compatible HTTP batch:
//     OpenAI-compatible /audio/transcriptions; an empty api_key is legal; covers
//     vLLM/self-hosted ASR; SenseVoiceSmall LAN defaults to the '*' wildcard)
//   Ported from legacy stt/engines/custom-openai-compatible.ts (mechanism carried over unchanged).
//
// Generic OpenAI-compatible /audio/transcriptions adapter — self-hosted
// SenseVoice + any BYOK Whisper-compatible service. push() accumulates PCM;
// flush() POSTs a 16-kHz mono WAV; the single response → a `final` event. No
// interim events. `Authorization: Bearer …` is sent ONLY when api_key is
// present and non-empty (the LAN SenseVoice preset takes an empty key).

import { EventEmitter } from 'node:events';
import type { EngineState, FinalResult, SttEngine, SttEngineConfig } from './base';
import { SttEngineError, requireEndpoint } from './base';
import { buildWav16kMono, stripTrailingSlash, toShortLang, SAMPLE_RATE, BYTES_PER_SAMPLE } from './wav';

const DEFAULT_MODEL = 'SenseVoiceSmall';

export interface CustomOpenAiCompatibleEngineDeps {
  fetch?: typeof fetch;
}

interface OpenAiTranscriptionResponseBody {
  text?: string;
}

export class CustomOpenAiCompatibleEngine extends EventEmitter implements SttEngine {
  readonly id = 'custom-openai-compatible';
  private _state: EngineState = 'closed';
  private chunks: Buffer[] = [];
  private byteLength = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(private cfg: SttEngineConfig, deps: CustomOpenAiCompatibleEngineDeps = {}) {
    super();
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
  }

  get state(): EngineState {
    return this._state;
  }

  open(): Promise<void> {
    if (this._state !== 'closed') {
      return Promise.reject(new Error(`CustomOpenAiCompatibleEngine.open: illegal in state ${this._state}`));
    }
    this.chunks = [];
    this.byteLength = 0;
    this.transition('open');
    return Promise.resolve();
  }

  push(chunk: Buffer): void {
    if (this._state !== 'open') {
      throw new SttEngineError('STT_ENGINE_TIMEOUT', `CustomOpenAiCompatibleEngine.push: not open (${this._state})`, true);
    }
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.byteLength += chunk.length;
  }

  async flush(): Promise<void> {
    if (this._state !== 'open') return;
    if (this.byteLength === 0) return;

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

    const headers: Record<string, string> = {};
    if (this.cfg.api_key && this.cfg.api_key.length > 0) {
      headers['Authorization'] = `Bearer ${this.cfg.api_key}`;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'POST', body: form, headers });
    } catch (err) {
      this.emit('error', new SttEngineError('STT_ENGINE_TIMEOUT', (err as Error)?.message ?? 'custom-openai-compatible fetch failed', true));
      return;
    }

    if (!res.ok) {
      this.emit('error', mapHttpError(res.status));
      return;
    }

    let body: OpenAiTranscriptionResponseBody;
    try {
      body = (await res.json()) as OpenAiTranscriptionResponseBody;
    } catch (err) {
      this.emit('error', new SttEngineError('STT_ENGINE_TIMEOUT', (err as Error)?.message ?? 'invalid custom-openai-compatible json', true));
      return;
    }

    const text = typeof body.text === 'string' ? body.text : '';
    const ev: FinalResult = {
      kind: 'final',
      text,
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

function mapHttpError(status: number): SttEngineError {
  if (status === 401 || status === 403) {
    return new SttEngineError('STT_ENGINE_AUTH_FAIL', `custom-openai-compatible http ${status}`, false);
  }
  if (status === 429) {
    return new SttEngineError('STT_ENGINE_RATE_LIMITED', `custom-openai-compatible http ${status}`, true);
  }
  return new SttEngineError('STT_ENGINE_TIMEOUT', `custom-openai-compatible http ${status}`, true);
}
