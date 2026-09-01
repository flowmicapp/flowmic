// WP2-6a — the flush-sent stamp has one author: raceFlushFinal, at the
// instant engine.flush() is invoked, not when the function is entered and
// not when the flush promise settles.
//
// REVERSE-CONTROL 6a-wire: move `d.onFlushSent?.()` to after `engine.flush()`
// (or into its `.then`) and `order` becomes `['flush-entered', 'hook']`.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { raceFlushFinal } from '../src/stt/flush-final';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import type { SttEngineId } from '@flowmic/protocol';

class FakeEngine extends EventEmitter implements SttEngine {
  readonly id: SttEngineId = 'custom-openai-compatible';
  private _state: EngineState = 'open';
  get state(): EngineState { return this._state; }
  order: string[];
  constructor(order: string[]) { super(); this.order = order; }
  push(): void { /* unused */ }
  flush(): Promise<void> {
    this.order.push('flush-entered');
    return Promise.resolve();
  }
  close(): Promise<void> { this._state = 'closed'; return Promise.resolve(); }
}

describe('raceFlushFinal onFlushSent (WP2-6a one author)', () => {
  const nopTimer = { setTimeoutFn: (): unknown => 1, clearTimeoutFn: (): void => { /* unused */ } };

  it('fires the hook immediately before engine.flush(), not after it settles', async () => {
    const order: string[] = [];
    const engine = new FakeEngine(order);
    await raceFlushFinal({
      engine,
      getOfflineText: () => '',
      language: 'en',
      timeoutMs: 3_000,
      ...nopTimer,
      onFlushSent: (): void => { order.push('hook'); },
    });
    expect(order[0]).toBe('hook');
    expect(order[1]).toBe('flush-entered');
  });

  it('does not fire the hook when there is no engine (nothing was sent)', async () => {
    let fired = 0;
    await raceFlushFinal({
      engine: null,
      getOfflineText: () => 'offline',
      language: 'en',
      timeoutMs: 3_000,
      ...nopTimer,
      onFlushSent: (): void => { fired += 1; },
    });
    expect(fired).toBe(0);
  });
});
