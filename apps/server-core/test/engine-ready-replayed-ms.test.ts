// Card RC-3b — the `ready` that ENDS an engine reconnect says how much audio the
// relay re-fed to the new leg from its retention ring (`replayed_ms`).
//
// Contract: book 04 §3 `stt:engine-status` row (RC-3b note); protocol schema
// `SttEngineStatusSchema.replayed_ms`. Producer: `engine-session.ts`
// `attemptReconnect`, reading the return value of `orchestrator-core.ts`
// `replayBufferTail`. Reader: the phone's outage accounting
// (apps/mobile/lib/src/ptt/ptt_capture_pump.dart).
//
// WHY THE ASSERTION IS 「EQUAL TO THE BYTES THE NEW LEG WAS HANDED」, measured on
// the engine and not re-derived from the ring or from the clock: the phone takes
// this number as the part of its outage that an engine DID hear. A number that
// merely looked plausible (the outage length, the window constant) would tell
// the phone that audio the ring had already evicted was transcribed — the words
// would be gone and the recording would say nothing was owed.
//
// Three claims:
//   ① after a long outage whose oldest audio fell out of the ring, `replayed_ms`
//      equals what the new leg was handed at replay time, and is LESS than the
//      outage (i.e. it is the fact, not the outage restated);
//   ② a short outage: everything was still held, and the number says so;
//   ③ the bridge copies the field onto the outbound socket frame.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { EngineStatusPayload } from '../src/stt/engine-session';
import { SttSessionBridge } from '../src/engine/stt-session';
import type { SttEngineId } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';

const CHUNK_MS = 200;
const CHUNK_BYTES = CHUNK_MS * 32; // 16 kHz mono s16le

class FakeClock {
  now = 0;
  private timers: { id: number; fn: () => void; at: number }[] = [];
  private seq = 0;
  setTimeout = (fn: () => void, ms: number): number => { const id = ++this.seq; this.timers.push({ id, fn, at: this.now + ms }); return id; };
  clearTimeout = (id: unknown): void => { this.timers = this.timers.filter((t) => t.id !== id); };
  nowFn = (): number => this.now;
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.now = due.at;
      due.fn();
      await drain();
    }
    this.now = target;
    await drain();
  }
}
const drain = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

type OpenMode = 'ok' | 'reject';
/** Records every byte it is handed — the measurement this file asserts against. */
class RecordingEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  bytes = 0;
  constructor(private readonly openMode: OpenMode = 'ok', public readonly id: SttEngineId = 'soniox') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> {
    if (this.openMode === 'reject') throw new Error('connect refused');
    this._state = 'open';
  }
  push(chunk: Buffer): void { this.bytes += chunk.length; }
  async flush(): Promise<void> { /* noop */ }
  async close(): Promise<void> { this._state = 'closed'; }
  drop(): void { this.emit('error', new Error('drop')); }
}

interface Rig {
  clock: FakeClock;
  engines: RecordingEngine[];
  readies: { frame: EngineStatusPayload; handed: number }[];
  statuses: EngineStatusPayload[];
  orch: SttEngineOrchestrator;
  speak(chunks: number): Promise<void>;
}

async function rig(engines: RecordingEngine[], opts: ConstructorParameters<typeof SttEngineOrchestrator>[2] = {}): Promise<Rig> {
  const clock = new FakeClock();
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 600_000 });
  session.start();
  let i = 0;
  const orch = new SttEngineOrchestrator(session, () => engines[Math.min(i++, engines.length - 1)]!, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 600_000, // this file measures the reconnect path, not a rollover
    ...opts,
  });
  const statuses: EngineStatusPayload[] = [];
  const readies: { frame: EngineStatusPayload; handed: number }[] = [];
  orch.on('engine-status', (s: EngineStatusPayload) => {
    statuses.push(s);
    // Read the new leg's tally AT the moment the frame goes out: anything
    // pushed after it is live audio, not replay.
    if (s.status === 'ready') readies.push({ frame: s, handed: engines[Math.min(i, engines.length) - 1]!.bytes });
  });
  await orch.start({ language: 'zh', mode: 'realtime' });
  readies.length = 0; // the cold open's `ready` ends no reconnect (asserted on its own below)
  let seq = 0;
  // Every chunk is loud: the VAD gate must pass it, or the replay would skip
  // withheld silence and this file would be measuring the gate.
  const loud = (): Buffer => { const b = Buffer.alloc(CHUNK_BYTES); for (let k = 0; k < b.length; k += 2) b.writeInt16LE(k % 4 === 0 ? 12_000 : -12_000, k); return b; };
  return {
    clock, engines, readies, statuses, orch,
    async speak(chunks: number): Promise<void> {
      for (let k = 0; k < chunks; k++) {
        orch.pushChunk({ seq, ts_ms: clock.now, payload: loud() });
        seq += 1;
        await clock.advance(CHUNK_MS);
      }
    },
  };
}

describe('RC-3b ① a long outage: replayed_ms is what the new leg was handed, not the outage', () => {
  it('the ring evicted the oldest unheard audio; the frame says how much it still held', async () => {
    // Grace = the ladder's worst case = 1 000 wait + 1 000 cap = 2 s; the ring
    // window is 5 s ⇒ unheard audio older than ~7 s is evicted. The unbounded
    // (long-recording) ladder keeps climbing: 1, 2, 4, 8 s ⇒ open at ~15 s.
    const engines = [new RecordingEngine('ok'), new RecordingEngine('reject'), new RecordingEngine('reject'), new RecordingEngine('reject'), new RecordingEngine('ok')];
    const r = await rig(engines, { reconnectBackoffMs: [1_000], maxRetries: 1, engineSpawnTimeoutMs: 1_000, reconnectUnbounded: true });
    await r.speak(10); // 2 s healthy
    engines[0]!.drop();
    await drain();
    const outageChunks = 80; // 16 s of speech while no leg is open
    await r.speak(outageChunks);

    expect(r.readies, 'positive control: the ladder came back').toHaveLength(1);
    const { frame, handed } = r.readies[0]!;
    expect(handed, 'positive control: the replay handed the new leg something').toBeGreaterThan(0);
    expect(frame.replayed_ms).toBe(handed / 32);
    expect(frame.replayed_ms!, 'the ring could not hold the whole outage').toBeLessThan(outageChunks * CHUNK_MS);
    // The field rides only the frame that ENDS a reconnect.
    for (const s of r.statuses.filter((x) => x.status !== 'ready')) expect(s, s.status).not.toHaveProperty('replayed_ms');
  });
});

describe('RC-3b ② a short outage: the ring held all of it', () => {
  it('replayed_ms covers the unheard audio and the window of context before it', async () => {
    const engines = [new RecordingEngine('ok'), new RecordingEngine('ok')];
    const r = await rig(engines);
    await r.speak(10);
    engines[0]!.drop();
    await drain();
    await r.speak(5); // rung 1 fires at 1 000 ms and opens
    expect(r.readies).toHaveLength(1);
    const { frame, handed } = r.readies[0]!;
    expect(frame.replayed_ms).toBe(handed / 32);
    expect(frame.replayed_ms!).toBeGreaterThanOrEqual(1_000);
  });

  it('the cold-open ready carries no replayed_ms (it ends no reconnect)', async () => {
    const r = await rig([new RecordingEngine('ok')]);
    expect(r.statuses.filter((s) => s.status === 'ready').every((s) => !('replayed_ms' in s))).toBe(true);
  });
});

describe('RC-3b ③ the bridge copies replayed_ms onto the outbound socket frame', () => {
  it('stt:engine-status{ready} leaves the bridge with replayed_ms', async () => {
    const emitted: { event: string; payload: unknown }[] = [];
    let orch: SttEngineOrchestrator | null = null;
    new SttSessionBridge({
      build: (session: AudioSession) => {
        orch = new SttEngineOrchestrator(session, () => new RecordingEngine('ok'), { engineFlushTimeoutMs: 200 });
        return { orchestrator: orch, isByok: false, gated: false };
      },
      emitter: { emit: (event, payload) => emitted.push({ event, payload }) },
      userId: 'u', mode: 'realtime', sourceLang: 'zh',
      onComplete: () => { /* noop */ },
      levelIntervalMs: 0,
    });
    await new Promise((res) => setTimeout(res, 5));
    orch!.emit('engine-status', { provider: 'soniox', status: 'ready', replayed_ms: 12_000 });
    const frames = emitted.filter((e) => e.event === 'stt:engine-status').map((e) => e.payload);
    expect(frames.at(-1)).toEqual({ provider: 'soniox', status: 'ready', replayed_ms: 12_000 });
  });
});
