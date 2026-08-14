// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (openai-realtime WS realtime:
//     session.update (pcm16+whisper-1+server_vad) + input_audio_buffer.append/
//     commit; cloud BYOK)
//   Ported from legacy stt/engines/openai-realtime.ts (mechanism unchanged from the legacy line, F-403/F-2136).
//
// OpenAI Realtime WebSocket adapter, STT-only subset. After the ws opens we send
// a session.update (pcm16 input, whisper-1 transcription, server VAD).
// push(chunk) sends input_audio_buffer.append with base64 PCM. flush() sends
// input_audio_buffer.commit + response.create and resolves on the next
// transcription.completed.

import { EventEmitter } from 'node:events';
import WebSocket, { type RawData } from 'ws';
import type { EngineState, FinalResult, InterimResult, SttEngine, SttEngineConfig } from './base';
import { SttEngineError, unexpectedCloseError } from './base';

const DEFAULT_MODEL = 'gpt-4o-realtime-preview-2024-10-01';
const REALTIME_BASE_URL = 'wss://api.openai.com/v1/realtime';

interface RealtimeFrame {
  type?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string; code?: string };
}

/** Minimal WebSocket surface this adapter relies on. Matches `ws`. */
export interface WebSocketLike {
  on(event: 'open', cb: () => void): unknown;
  on(event: 'message', cb: (data: RawData) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  once(event: 'error', cb: (err: Error) => void): unknown;
  send(data: string): void;
  close(): void;
}

export interface OpenAiRealtimeEngineDeps {
  connect?: (url: string, options: { headers: Record<string, string> }) => WebSocketLike;
}

export class OpenAiRealtimeEngine extends EventEmitter implements SttEngine {
  readonly id = 'openai-realtime';
  private ws: WebSocketLike | null = null;
  private _state: EngineState = 'closed';
  private startedAt = 0;
  private resolveFlush: (() => void) | null = null;
  private intentionalClose = false;

  constructor(private cfg: SttEngineConfig, private deps: OpenAiRealtimeEngineDeps = {}) {
    super();
  }

  get state(): EngineState {
    return this._state;
  }

  open(): Promise<void> {
    if (this._state !== 'closed') {
      return Promise.reject(new Error(`OpenAiRealtimeEngine.open: illegal in state ${this._state}`));
    }
    const model = this.cfg.model ?? DEFAULT_MODEL;
    const url = `${REALTIME_BASE_URL}?model=${encodeURIComponent(model)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.api_key ?? ''}`,
      'OpenAI-Beta': 'realtime=v1',
    };
    const factory =
      this.deps.connect ??
      ((u: string, o: { headers: Record<string, string> }) =>
        new WebSocket(u, o) as unknown as WebSocketLike);
    this.ws = factory(url, { headers });
    this.startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const ws = this.ws!;
      let opened = false;
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            input_audio_format: 'pcm16',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: { type: 'server_vad' },
          },
        }));
        opened = true;
        this.transition('open');
        resolve();
      });
      ws.on('message', (data: RawData) => this.onMessage(data));
      ws.on('error', (err: Error) => this.onError(err));
      ws.on('close', () => this.onClose());
      ws.once('error', (err: Error) => { if (!opened) reject(err); });
    });
  }

  push(chunk: Buffer): void {
    if (this._state !== 'open' || !this.ws) {
      throw new SttEngineError('STT_ENGINE_TIMEOUT', `OpenAiRealtimeEngine.push: not open (${this._state})`, true);
    }
    this.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: chunk.toString('base64'),
    }));
  }

  flush(): Promise<void> {
    if (this._state !== 'open' || !this.ws) return Promise.resolve();
    this.intentionalClose = true; // F-2136: a ws close after flush is expected.
    return new Promise<void>((resolve) => {
      this.resolveFlush = resolve;
      this.ws!.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      this.ws!.send(JSON.stringify({ type: 'response.create' }));
    });
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    this.ws?.close();
    this.ws = null;
    this.transition('closed');
    if (this.resolveFlush) {
      const r = this.resolveFlush;
      this.resolveFlush = null;
      r();
    }
    this.removeAllListeners();
  }

  private onMessage(data: RawData): void {
    let frame: RealtimeFrame;
    try {
      const text = typeof data === 'string'
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data as Buffer[]).toString('utf8')
          : (data as Buffer).toString('utf8');
      frame = JSON.parse(text);
    } catch {
      return;
    }
    switch (frame.type) {
      case 'conversation.item.input_audio_transcription.delta': {
        if (typeof frame.delta !== 'string') return;
        const ev: InterimResult = {
          kind: 'interim',
          text: frame.delta,
          confidence: 0.5,
          language: this.cfg.language,
        };
        this.emit('interim', ev);
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        if (typeof frame.transcript !== 'string') return;
        const ev: FinalResult = {
          kind: 'final',
          text: frame.transcript,
          confidence: 1,
          language: this.cfg.language,
          duration_ms: Math.max(0, Date.now() - this.startedAt),
        };
        this.emit('final', ev);
        if (this.resolveFlush) {
          const r = this.resolveFlush;
          this.resolveFlush = null;
          r();
        }
        return;
      }
      case 'error': {
        if (this._state === 'closed') return;
        const msg = frame.error?.message ?? 'openai realtime error';
        const code = frame.error?.code ?? '';
        const isAuth = /auth|unauthor|invalid.*api.*key/i.test(`${code} ${msg}`);
        if (this.listenerCount('error') > 0) this.emit('error', new SttEngineError(isAuth ? 'STT_ENGINE_AUTH_FAIL' : 'STT_ENGINE_TIMEOUT', msg, true));
        return;
      }
      default:
        return;
    }
  }

  private onError(err: Error): void {
    // Swallow a late ws 'error' after teardown (no listener → would throw).
    if (this._state === 'closed') return;
    const wrapped = new SttEngineError('STT_NETWORK_DROP', err.message || 'OpenAI Realtime ws error', true);
    this.transition('failed');
    if (this.listenerCount('error') > 0) this.emit('error', wrapped);
  }

  private onClose(): void {
    if (this._state === 'closed') return;
    const unexpected = !this.intentionalClose && this._state === 'open';
    if (this._state !== 'failed') this.transition('failed');
    if (unexpected && this.listenerCount('error') > 0) this.emit('error', unexpectedCloseError('OpenAI Realtime'));
    if (this.resolveFlush) {
      const r = this.resolveFlush;
      this.resolveFlush = null;
      r();
    }
  }

  private transition(next: EngineState): void {
    this._state = next;
    this.emit('state', next);
  }
}
