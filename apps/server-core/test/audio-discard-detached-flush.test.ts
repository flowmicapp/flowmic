// Codex rc3 ⑤ (relay half) — a discarding audio:stop also silences a session
// that an earlier ordinary stop already detached and is still flushing.
//
// The phone yields a recovery attempt to live speech with `audio:stop
// {discard:true}` (apps/mobile/lib/src/ptt/ptt_backfill.dart
// `yieldRecoveryForLive`). If the attempt had already sent its ordinary stop,
// the relay had DETACHED that session and was flushing it: the discard found no
// session, acknowledged at once, and the flush went on emitting to the socket —
// its terminal `stt:error` (a flush cap) then reached the new live recording,
// which stopped on it. The phone discards every stt frame only until that ack.
//
// Harness: the one in audio-stop-final.test.ts, with a finish() that waits.

import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers, type AudioHandlerDeps, type SttStartArgs } from '../src/socket/handlers/audio.handler';
import { AudioSessionRegistry } from '../src/engine/audio-registry';
import { makeSttEmitter } from '../src/engine/stt-factory';
import type { QuotaGuard } from '../src/billing/quota-guard';
import type { UsageTracker } from '../src/billing/usage-tracker';

const ROOM = 'room-1';
const PAIRING = 'mob-1';
const START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh', delivery: 'none' };

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string; audioSessions?: unknown } = {};
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(event: string, payload?: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  fire(event: string, payload?: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

function harness() {
  const registry = new AudioSessionRegistry();
  const store = new RoomStore<FakeSocket>();
  const guard: QuotaGuard = { ensureQuota() {}, remainingSttMs: () => Infinity, continuousCapMs: () => Infinity };
  const usage: UsageTracker = { recordSttUsage() {}, recordLlmUsage() {}, recordQuotaRefusal() {} };
  let release: () => void = () => {};
  const flushed = new Promise<void>((r) => { release = r; });
  const disposed: number[] = [];
  let n = 0;
  const sttFactory = (args: SttStartArgs) => {
    const id = ++n;
    const emitter = makeSttEmitter({
      resolveSocket: args.resolveSocket ?? ((): null => null),
      store: store as unknown as RoomStore<Socket>,
      roomUuid: ROOM,
      delivery: args.delivery,
    });
    return {
      pushChunk(): void {},
      // The flush of a backlog: it outlives the stop, then its cap runs out.
      async finish(): Promise<void> {
        await flushed;
        emitter.emit('stt:error', { code: 'STT_NETWORK_DROP', message: 'flush cap reached', retryable: false });
        emitter.emit('stt:final', { text: '迟到的补转写', confidence: 1, language: 'zh', segment_idx: 0, is_segment: false, duration_ms: 1200 });
      },
      dispose(): void { disposed.push(id); },
    };
  };
  const deps: AudioHandlerDeps = {
    io: {} as unknown as import('socket.io').Server,
    guard, usageTracker: usage,
    store: store as unknown as RoomStore<Socket>,
    sessions: registry,
    sttFactory: sttFactory as unknown as AudioHandlerDeps['sttFactory'],
  };
  const mob = new FakeSocket('mob-sock');
  mob.data = { auth: { kind: 'mobile', userId: 'u1', pairingId: PAIRING }, roomUuid: ROOM };
  store.joinMobile(ROOM, PAIRING, mob);
  registerAudioHandlers(mob as unknown as Socket, deps);
  return { mob, release: () => release(), disposed };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('a discarding audio:stop silences a session already detached and flushing', () => {
  it('nothing of the flushing session reaches the socket after the discard is acknowledged', async () => {
    const { mob, release, disposed } = harness();
    mob.fire('audio:start', START, () => {});
    mob.fire('audio:chunk', { seq: 0, data_b64: 'AAAA', ts_ms: 1 });
    mob.fire('audio:stop', {}, () => {}); // the recovery's ordinary stop: flush starts
    await tick();
    let acked = false;
    mob.fire('audio:stop', { discard: true }, () => { acked = true; }); // the yield
    expect(acked).toBe(true);
    const at = mob.emitted.length;
    release(); // the flush's cap runs out
    await tick();
    await tick();
    const after = mob.emitted.slice(at).map((e) => e.event);
    expect(after).not.toContain('stt:error');
    expect(after).not.toContain('stt:final');
    expect(disposed).toContain(1); // torn down (and settled once, on dispose)
  });

  it('positive control: without the discard, the flush still answers the phone', async () => {
    const { mob, release } = harness();
    mob.fire('audio:start', START, () => {});
    mob.fire('audio:chunk', { seq: 0, data_b64: 'AAAA', ts_ms: 1 });
    mob.fire('audio:stop', {}, () => {});
    await tick();
    release();
    await tick();
    await tick();
    expect(mob.emitted.map((e) => e.event)).toContain('stt:final');
  });
});
