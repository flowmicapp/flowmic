// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (funasr WS 2pass: open frame
//     {mode:'2pass',chunk_size,chunk_interval,wav_name,audio_fs,itn,is_speaking,
//     hotwords?}; binary PCM frames; {is_speaking:false} flush; 2pass-online→interim,
//     2pass-offline→final; default Chinese engine), §5 (hotwords F-2117)
//   Ported from legacy stt/engines/funasr.ts (mechanism unchanged from the old line, F-2078/F-2100/F-2136).
//
// FunASR WebSocket 2-pass streaming client. Thin adapter: open → send config →
// push PCM binary frames → parse JSON responses → emit interim/final → flush
// (is_speaking:false) → close. Reconnect/replay stays in the orchestrator.

import { EventEmitter } from 'node:events';
import WebSocket, { type RawData } from 'ws';
import type { EngineState, FinalResult, InterimResult, SttEngine, SttEngineConfig } from './base';
import { SttEngineError, requireEndpoint, unexpectedCloseError } from './base';
import { funasrChunkFromEnv, funasrItnFromEnv } from '../tuning-env';

interface FunasrFrame {
  mode?: string;
  text?: string;
  wav_name?: string;
  is_final?: boolean;
  timestamp?: string;
}

export interface FunasrEngineDeps {
  /** Connection factory; injectable for tests. */
  connect?: (url: string) => WebSocket;
}

export class FunasrEngine extends EventEmitter implements SttEngine {
  readonly id = 'funasr';
  private ws: WebSocket | null = null;
  private _state: EngineState = 'closed';
  private startedAt = 0;
  private resolveFlush: (() => void) | null = null;
  /** F-2136: set by OUR teardown (flush/close) — see base.unexpectedCloseError. */
  private intentionalClose = false;

  constructor(private cfg: SttEngineConfig, private deps: FunasrEngineDeps = {}) {
    super();
  }

  get state(): EngineState {
    return this._state;
  }

  open(): Promise<void> {
    if (this._state !== 'closed') {
      return Promise.reject(new Error(`FunasrEngine.open: illegal in state ${this._state}`));
    }
    // OSS-DEFAULTS: no endpoint ⇒ a named refusal, never a guessed address.
    // Rejection (not `throw`) because open() is the async contract the
    // orchestrator awaits; a synchronous throw here would escape that await.
    let url: string;
    try {
      url = requireEndpoint(this.id, this.cfg.endpoint);
    } catch (err) {
      return Promise.reject(err);
    }
    const factory = this.deps.connect ?? ((u) => new WebSocket(u));
    this.ws = factory(url);
    this.startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const ws = this.ws!;
      // Track open-resolution locally: a connect-time ws error (ECONNREFUSED)
      // MUST reject open() promptly so the orchestrator surfaces the §2.3
      // terminal error, not after the 5s spawn-timeout cap.
      let opened = false;
      ws.on('open', () => {
        // hotwords (F-2117): added ONLY when the dictionary is non-empty; when
        // absent the open frame is byte-identical to baseline.
        const chunk = funasrChunkFromEnv();
        const openFrame: Record<string, unknown> = {
          mode: '2pass',
          chunk_size: chunk.chunk_size,
          chunk_interval: chunk.chunk_interval,
          wav_name: 'h5',
          audio_fs: this.cfg.sample_rate,
          itn: funasrItnFromEnv(),
          is_speaking: true,
        };
        if (this.cfg.hotwords) openFrame.hotwords = this.cfg.hotwords;
        ws.send(JSON.stringify(openFrame));
        opened = true;
        this.transition('open');
        resolve();
      });
      ws.on('message', (data: RawData) => this.onMessage(data));
      ws.on('error', (err) => this.onError(err));
      ws.on('close', () => this.onClose());
      ws.once('error', (err) => { if (!opened) reject(err); });
    });
  }

  push(chunk: Buffer): void {
    if (this._state !== 'open' || !this.ws) {
      throw new SttEngineError('STT_ENGINE_TIMEOUT', `FunasrEngine.push: not open (${this._state})`, true);
    }
    this.ws.send(chunk);
  }

  flush(): Promise<void> {
    if (this._state !== 'open' || !this.ws) return Promise.resolve();
    this.intentionalClose = true; // F-2136: a ws close after flush is expected.
    return new Promise<void>((resolve) => {
      this.resolveFlush = resolve;
      this.ws!.send(JSON.stringify({ is_speaking: false }));
    });
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    if (this.ws && this._state === 'open') {
      try { this.ws.send(JSON.stringify({ is_speaking: false })); } catch (err) { console.error('[FunasrEngine] close flush send error:', err); }
    }
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
    let frame: FunasrFrame;
    try {
      frame = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      return;
    }
    if (typeof frame.text !== 'string') return;

    // F-2100 — route by PASS, not by is_final. A 2pass-offline frame is the
    // authoritative offline result for a completed VAD span → 'final' +
    // offlineAccum. A 2pass-online frame is always a live chunk-boundary draft
    // → 'interim' only, never offlineAccum. frame.mode=undefined keeps the
    // legacy is_final→final routing for test fakes.
    const isOfflinePass = frame.mode === '2pass-offline'
      || (frame.mode === undefined && frame.is_final === true);
    if (isOfflinePass) {
      const ev: FinalResult = {
        kind: 'final',
        text: frame.text,
        confidence: 1,
        language: this.cfg.language,
        duration_ms: Math.max(0, Date.now() - this.startedAt),
      };
      this.emit('final', ev);
    } else {
      const ev: InterimResult = {
        kind: 'interim',
        text: frame.text,
        confidence: 0.5,
        language: this.cfg.language,
      };
      this.emit('interim', ev);
    }

    // Unblock flush() on the OFFLINE pass only. The offline frame can carry
    // is_final=false; resolveFlush is set only after is_speaking:false, so a
    // mid-session offline frame can't settle flush early.
    if (isOfflinePass && this.resolveFlush) {
      const r = this.resolveFlush;
      this.resolveFlush = null;
      r();
    }
  }

  private onError(err: Error): void {
    // A late ws 'error' after teardown (e.g. ws.close() on a still-connecting
    // socket → "closed before established") must NOT re-emit onto an engine
    // whose listeners are gone — an unhandled 'error' throws (process crash on
    // an unreachable endpoint). Swallow once closed; otherwise emit only if a
    // listener is attached.
    if (this._state === 'closed') return;
    const wrapped = new SttEngineError('STT_NETWORK_DROP', err.message || 'FunASR ws error', true);
    if (this._state !== 'failed') this.transition('failed');
    if (this.listenerCount('error') > 0) this.emit('error', wrapped);
  }

  private onClose(): void {
    if (this._state === 'closed') return;
    // F-2136: an UNEXPECTED clean close (server FIN / idle timeout) drives the
    // reconnect ladder via a synthetic 'error'.
    const unexpected = !this.intentionalClose && this._state === 'open';
    if (this._state !== 'failed') this.transition('failed');
    if (unexpected && this.listenerCount('error') > 0) this.emit('error', unexpectedCloseError('FunASR'));
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
