// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (deepgram WS streaming nova-3: URL
//     params punctuate/interim_results/endpointing=300/linear16; Authorization:
//     Token; {type:'CloseStream'} flush; cloud BYOK)
//   Ported from legacy stt/engines/deepgram.ts ("the mechanism follows the old
//     line" — 机理照旧线, F-403/S-API-8/F-2136).
//
// Deepgram Nova-3 WebSocket streaming client. Cloud-only. Adapter only: open ws
// with Authorization header, push raw PCM linear16 binary frames, parse Results
// JSON → emit interim/final, flush via CloseStream JSON, close.

import { EventEmitter } from 'node:events';
import WebSocket, { type RawData } from 'ws';
import type { EngineState, FinalResult, InterimResult, SttEngine, SttEngineConfig } from './base';
import { SttEngineError, unexpectedCloseError } from './base';

const DEEPGRAM_WS_BASE = 'wss://api.deepgram.com/v1/listen';
const DEFAULT_MODEL = 'nova-3';

/** Minimal structural subset of `ws` we depend on (test FakeWs injection). */
export interface WebSocketLike {
  send(data: string | Buffer): void;
  close(): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeAllListeners(): unknown;
}

export interface DeepgramConnectOptions {
  headers: { [key: string]: string };
}

export interface DeepgramEngineDeps {
  connect?: (url: string, options: DeepgramConnectOptions) => WebSocketLike;
}

interface DeepgramAlternative {
  transcript?: string;
  confidence?: number;
}

interface DeepgramFrame {
  type?: string;
  is_final?: boolean;
  channel?: { alternatives?: DeepgramAlternative[] };
  error?: unknown;
  message?: string;
  reason?: string;
}

/** 'zh-CN' → 'zh', 'en-US' → 'en'. Empty/falsy → 'en'. */
function shortLang(lang: string | undefined): string {
  if (!lang) return 'en';
  const dash = lang.indexOf('-');
  return dash === -1 ? lang : lang.slice(0, dash);
}

function buildUrl(cfg: SttEngineConfig): string {
  const params = new URLSearchParams({
    model: cfg.model ?? DEFAULT_MODEL,
    language: shortLang(cfg.language),
    punctuate: 'true',
    interim_results: 'true',
    endpointing: '300',
    sample_rate: String(cfg.sample_rate),
    channels: '1',
    encoding: 'linear16',
  });
  return `${DEEPGRAM_WS_BASE}?${params.toString()}`;
}

export class DeepgramEngine extends EventEmitter implements SttEngine {
  readonly id = 'deepgram';
  private ws: WebSocketLike | null = null;
  private _state: EngineState = 'closed';
  private startedAt = 0;
  private resolveFlush: (() => void) | null = null;
  private intentionalClose = false;

  constructor(private cfg: SttEngineConfig, private deps: DeepgramEngineDeps = {}) {
    super();
  }

  get state(): EngineState {
    return this._state;
  }

  open(): Promise<void> {
    if (this._state !== 'closed') {
      return Promise.reject(new Error(`DeepgramEngine.open: illegal in state ${this._state}`));
    }
    const url = buildUrl(this.cfg);
    const headers = { Authorization: `Token ${this.cfg.api_key ?? ''}` };
    const factory = this.deps.connect
      ?? ((u: string, o: DeepgramConnectOptions) => new WebSocket(u, o) as unknown as WebSocketLike);
    this.ws = factory(url, { headers });
    this.startedAt = Date.now();

    return new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      let opened = false;
      ws.on('open', (() => {
        opened = true;
        this.transition('open');
        resolve();
      }) as never);
      ws.on('message', ((data: RawData) => this.onMessage(data)) as never);
      ws.on('error', ((err: Error) => {
        if (!opened) {
          reject(err);
          return;
        }
        this.onError(err);
      }) as never);
      ws.on('close', (() => this.onClose()) as never);
    });
  }

  push(chunk: Buffer): void {
    if (this._state !== 'open' || !this.ws) {
      throw new SttEngineError('STT_ENGINE_TIMEOUT', `DeepgramEngine.push: not open (${this._state})`, true);
    }
    this.ws.send(chunk);
  }

  flush(): Promise<void> {
    if (this._state !== 'open' || !this.ws) return Promise.resolve();
    this.intentionalClose = true; // F-2136: a post-CloseStream ws close is expected.
    return new Promise<void>((resolve) => {
      this.resolveFlush = resolve;
      this.ws!.send(JSON.stringify({ type: 'CloseStream' }));
    });
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    if (this.ws && this._state === 'open') {
      try { this.ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (err) { console.error('[DeepgramEngine] close CloseStream send error:', err); }
    }
    this.ws?.close();
    this.ws = null;
    this.transition('closed');
    this.resolvePendingFlush();
    this.removeAllListeners();
  }

  private resolvePendingFlush(): void {
    if (!this.resolveFlush) return;
    const r = this.resolveFlush;
    this.resolveFlush = null;
    r();
  }

  private onMessage(data: RawData): void {
    let frame: DeepgramFrame;
    try {
      frame = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      return;
    }
    if (frame.type === 'Metadata') return;
    if (frame.type === 'Error' || frame.error) {
      this.emitErrorFrame(frame);
      return;
    }
    const alt = frame.channel?.alternatives?.[0];
    if (!alt || typeof alt.transcript !== 'string') return;
    const text = alt.transcript;
    const confidence = typeof alt.confidence === 'number' ? alt.confidence : 0;
    if (frame.is_final) {
      const ev: FinalResult = {
        kind: 'final',
        text,
        confidence,
        language: this.cfg.language,
        duration_ms: Math.max(0, Date.now() - this.startedAt),
      };
      this.emit('final', ev);
      this.resolvePendingFlush();
    } else {
      const ev: InterimResult = {
        kind: 'interim',
        text,
        confidence,
        language: this.cfg.language,
      };
      this.emit('interim', ev);
    }
  }

  private emitErrorFrame(frame: DeepgramFrame): void {
    if (this._state === 'closed') return;
    const msg = String(frame.message ?? frame.reason ?? frame.error ?? 'Deepgram error frame');
    const isAuth = /auth|unauthor|forbid|api[_\s-]?key|token/i.test(msg);
    const wrapped = isAuth
      ? new SttEngineError('STT_ENGINE_AUTH_FAIL', msg, false)
      : new SttEngineError('STT_ENGINE_TIMEOUT', msg, true);
    if (this._state !== 'failed') this.transition('failed');
    if (this.listenerCount('error') > 0) this.emit('error', wrapped);
  }

  private onError(err: Error): void {
    // Swallow a late ws 'error' after teardown (no listener → would throw).
    if (this._state === 'closed') return;
    const msg = err.message || 'Deepgram ws error';
    const isAuth = /401|403|unauthor|forbid|auth/i.test(msg);
    const wrapped = isAuth
      ? new SttEngineError('STT_ENGINE_AUTH_FAIL', msg, false)
      : new SttEngineError('STT_ENGINE_TIMEOUT', msg, true);
    if (this._state !== 'failed') this.transition('failed');
    if (this.listenerCount('error') > 0) this.emit('error', wrapped);
  }

  private onClose(): void {
    if (this._state === 'closed') return;
    const unexpected = !this.intentionalClose && this._state === 'open';
    if (this._state !== 'failed') this.transition('failed');
    if (unexpected && this.listenerCount('error') > 0) this.emit('error', unexpectedCloseError('Deepgram'));
    this.resolvePendingFlush();
  }

  private transition(next: EngineState): void {
    this._state = next;
    this.emit('state', next);
  }
}
