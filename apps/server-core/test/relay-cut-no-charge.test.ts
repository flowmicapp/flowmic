// NR-138, MAIN extension 2026-10-01 — a recording our own relay cut off, with no usable transcript, is not charged.
// *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.10 item 4 and its "MAIN extension" paragraph
//   docs/decisions/2026-10-01-owner-engine-failure-no-charge.md ("MAIN 扩展")
//   apps/server-core/src/engine/relay-lifecycle.ts, apps/server-core/src/shutdown.ts (`makeShutdownSequence`)
//
// THE SHUTDOWN UNDER TEST IS THE PRODUCTION ONE: `makeShutdownSequence` (the one list SIGTERM, SIGINT and the fatal
// guard all run), over the real audio handler (`registerAudioHandlers`, its `disconnect` branch), the real session
// registry (`AudioSessionRegistry`: grace on disconnect, then `stopAll`), real `SttSessionBridge`s and the real
// ledger (usage tracker + `usage_effects` on SQLite). Only the steps that own no recording are stubs. Assertions land
// on the PERSISTED minutes, and each failure row also proves its session DID settle, with which fact.
//
// REVERSE CONTROLS (run 2026-10-01; each restored byte-for-byte, then this file re-run green):
//   · `SttSessionBridge.dispose()` no longer records the relay cut ⇒ both relay-cut rows red on the persisted
//     minutes (`expected 0.1 to be +0`);
//   · the shutdown sequence no longer marks the relay as shutting down ⇒ the same two rows red, the same way.

import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { BillingService } from '../src/billing/billing-service';
import { makeQuotaGuard } from '../src/billing/quota-guard';
import { makeUsageTracker } from '../src/billing/usage-tracker';
import { currentMonth } from '../src/db/repos/usage.repo';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers } from '../src/socket/handlers/audio.handler';
import { AudioSessionRegistry } from '../src/engine/audio-registry';
import { SttSessionBridge } from '../src/engine/stt-session';
import type { SttSessionDeps } from '../src/engine/stt-session-deps';
import { makeShutdownSequence } from '../src/shutdown';
import { relayIsShuttingDown, resetRelayLifecycleForTests } from '../src/engine/relay-lifecycle';
import type { SttEngineOrchestrator, ChunkIntake } from '../src/stt/orchestrator-core';
import { CHUNK_BYTES, CHUNK_MS, FakeClock, T0, drain } from './fixtures/stt-outage-harness';

const USER = 'u-relay-cut';
const NOW = Date.parse('2026-10-01T00:00:00.000Z');
const MONTH = currentMonth(() => NOW);
const AUDIO_START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'en', delivery: 'none' };
const SIX_SECONDS_IN_MIN = 6_000 / 60_000;

class FakeSocket {
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string, readonly data: { auth?: unknown; roomUuid?: string }) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(): boolean { return true; }
  fire(event: string, payload?: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

/** An engine that is healthy while it runs; a recording cut off mid-stream never reaches its `stop()`. */
class ScriptedOrchestrator extends EventEmitter {
  fedBytes = 0;
  async start(): Promise<void> {}
  pushChunk(c: { payload: Buffer }): ChunkIntake { this.fedBytes += c.payload.length; return 'fed'; }
  async stop(): Promise<void> { this.final('the words'); }
  async close(): Promise<void> {}
  async waitForTerminal(): Promise<void> {}
  get fedAudioMs(): number { return this.fedBytes / 32; }
  get uniqueFedAudioMs(): number { return this.fedBytes / 32; }
  final(text: string, isSegment = false): void {
    this.emit('final', { text, confidence: 0.9, language: 'en', segment_idx: 0, is_segment: isSegment, duration_ms: 1000 });
  }
}

function loudChunk(): string {
  const b = Buffer.alloc(CHUNK_BYTES);
  for (let i = 0; i < CHUNK_BYTES; i += 2) b.writeInt16LE(i % 64 < 32 ? 8_000 : -8_000, i);
  return b.toString('base64');
}

let db: DbConnection;
beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('nr-138-relay-cut-no-charge-32bytes') });
  db.users.insert({ id: USER, display_name: 'U', plan: 'free' });
});
afterEach(() => { resetRelayLifecycleForTests(); db.close(); });

const minutes = (): number => db.usage.get(USER, MONTH)?.stt_minutes ?? 0;

/** The production handler + ledger + registry; one unpaired and one paired phone socket. */
function relay() {
  const billing = new BillingService({ settings: db.settings, users: db.users, usage: db.usage, billing: db.billing, unlockAll: false, now: () => NOW });
  const guard = makeQuotaGuard(db.usage, { effectiveLimits: (u) => billing.effectiveLimits(u), usagePeriodKey: () => MONTH }, { mode: 'saas', now: () => NOW });
  const usageTracker = makeUsageTracker(db.usage, { mode: 'saas', now: () => NOW, periodKeyFor: () => MONTH, operations: db.usageEffects });
  const sessions = new AudioSessionRegistry();
  const clock = new FakeClock(T0);
  const settles: Parameters<SttSessionDeps['onComplete']>[] = [];
  const sockets: FakeSocket[] = [];
  let lastBridge: SttSessionBridge | null = null;
  let lastEngine: ScriptedOrchestrator | null = null;

  function phone(paired: boolean): FakeSocket {
    const s = new FakeSocket(`m${sockets.length}`, paired
      ? { auth: { kind: 'mobile', userId: USER, pairingId: `p-${sockets.length}` }, roomUuid: 'room-1' }
      : { auth: { kind: 'mobile', userId: USER } });
    sockets.push(s);
    registerAudioHandlers(s as unknown as Socket, {
      io: {} as unknown as import('socket.io').Server,
      guard, usageTracker, recoveryOps: db.recoveryOps, sessions,
      store: new RoomStore<Socket>() as unknown as RoomStore<Socket>,
      sttFactory: (args) => {
        lastBridge = new SttSessionBridge({
          build: () => {
            lastEngine = new ScriptedOrchestrator();
            return { orchestrator: lastEngine as unknown as SttEngineOrchestrator, isByok: false, gated: false };
          },
          emitter: { emit: () => {} },
          userId: args.userId, mode: args.mode, sourceLang: args.sourceLang,
          onComplete: (...a) => { settles.push(a); args.onComplete(...a); },
          levelIntervalMs: 0,
          now: clock.nowFn,
        });
        return lastBridge;
      },
      now: () => NOW,
    });
    return s;
  }

  /** Start a recording on [s] and stream six seconds of speech — no stop: it is still in flight. */
  async function speak(s: FakeSocket): Promise<{ engine: ScriptedOrchestrator; bridge: SttSessionBridge }> {
    let ack: unknown;
    s.fire('audio:start', AUDIO_START, (r) => { ack = r; });
    await drain();
    expect(ack, 'precondition: the recording was admitted').toMatchObject({ ok: true });
    const bridge = lastBridge!;
    for (let seq = 0; seq * CHUNK_MS < 6_000; seq++) {
      bridge.pushChunk(seq, loudChunk(), clock.now);
      await clock.advance(CHUNK_MS);
    }
    return { engine: lastEngine!, bridge };
  }

  /** The production shutdown sequence; the steps that own no recording are inert. */
  async function shutDown(): Promise<void> {
    const inert = { stop(): void {} };
    await makeShutdownSequence({
      retention: inert, growthReaper: inert, recoveryPrune: inert, anonCleanup: inert, statusProbes: inert, latencyReader: inert,
      // socket.io's close fires every connected socket's `disconnect`, which is what this does.
      closeSocket: () => { for (const s of sockets) s.fire('disconnect'); },
      audioRegistry: sessions,
      httpServer: createServer(),
      db: { close(): void {} }, // the test reads the ledger afterwards
    })();
    await drain();
  }

  return { phone, speak, shutDown, settles };
}

describe('MAIN extension — a recording the relay itself cut off, with no usable transcript, is not charged (book 22 §4.10 item 4)', () => {
  it('🔴 an unpaired recording in flight when the relay shuts down ⇒ nothing is debited', async () => {
    const r = relay();
    await r.speak(r.phone(false));
    await r.shutDown();
    expect(r.settles, 'positive control: the cut session DID settle, once').toHaveLength(1);
    expect(minutes(), 'the persisted ledger did not move').toBe(0);
    expect(r.settles[0]![3]).toEqual({ kind: 'relay_shutdown' });
  });

  it('🔴 a paired recording (grace window armed by the disconnect, then stopAll) ⇒ nothing is debited', async () => {
    const r = relay();
    await r.speak(r.phone(true));
    await r.shutDown();
    expect(r.settles).toHaveLength(1);
    expect(minutes()).toBe(0);
    expect(r.settles[0]![3]).toEqual({ kind: 'relay_shutdown' });
  });

  it('control — a partial usable transcript, then the relay cut it ⇒ billed normally', async () => {
    const r = relay();
    const { engine } = await r.speak(r.phone(false));
    engine.final('part one', true);
    await r.shutDown();
    expect(r.settles).toHaveLength(1);
    expect(minutes()).toBeCloseTo(SIX_SECONDS_IN_MIN, 6);
  });

  it('control — a recording that finished before the shutdown is billed, and the shutdown changes nothing', async () => {
    const r = relay();
    const s = r.phone(false);
    await r.speak(s);
    s.fire('audio:stop', {}, () => {});
    await drain();
    expect(minutes(), 'billed at its own finish').toBeCloseTo(SIX_SECONDS_IN_MIN, 6);
    await r.shutDown();
    expect(r.settles).toHaveLength(1);
    expect(minutes()).toBeCloseTo(SIX_SECONDS_IN_MIN, 6);
  });

  it('control — the phone dropping while the relay runs is not the relay\'s cut, billed as today', async () => {
    const r = relay();
    const s = r.phone(false);
    await r.speak(s);
    s.fire('disconnect');
    await drain();
    expect(relayIsShuttingDown()).toBe(false);
    expect(r.settles).toHaveLength(1);
    expect(r.settles[0]![3]).toBeUndefined();
    expect(minutes()).toBeCloseTo(SIX_SECONDS_IN_MIN, 6);
  });
});
