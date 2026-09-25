// Card HANGUP-3 — THE GATE on STT_SEGMENT_NOT_TRANSCRIBED.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (c′) (`client_caps`) and §5
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d (HANGUP-3 block), §6 G-23
//
// WHY A GATE AT ALL. A phone that does not know the code renders it through its
// last fallback, 「Speech engine reported an error (STT_SEGMENT_NOT_TRANSCRIBED)」
// — measured on the 0.3.94 phone code (apps/mobile recording_strings.dart
// `sttStallEngineErrorCoded`, widget probe on card HANGUP-3). So the verdict goes
// only to a client that declared `stt.segment_not_transcribed` in its admission
// frame; an undeclared client keeps the behaviour it had before this card.
//
// THE CHAIN, one link per block below, each asserted on production code:
//   ① admission — mobile.handler.ts / mobile-reconnect.ts put the frame's
//     `client_caps` on the socket (wire.ts setClientCaps), every admission site;
//   ② audio:start — audio.handler.ts hands `getClientCaps(socket)` to the factory;
//   ③ factory — stt-factory.ts turns it into the orchestrator's flag through
//     owed-voice-verdict.ts `declaresSegmentNotTranscribed`;
//   ④ frames — through the real SttSessionBridge, a declared client gets the
//     frame and an undeclared one gets NOT ONE frame carrying the code.
// ④ is asserted on FRAMES (every emit the bridge makes for this phone, each
// searched for the code AND a marker unique to the failed closing dial), with a
// positive control on the undeclared side: that probe is non-empty and holds
// the same terminal final the declared run got, so its silence is the gate and
// not a blind probe (CLAUDE.md, the G13 rule for negative assertions).
//
// REVERSE CONTROL (run, SAW RED 〔2026-09-23, lane-c, card HANGUP-3〕): the gate
// removed from `owedVoiceLostError` (`!clientDeclared ||` deleted) ⇒ the
// undeclared frame row, 1 failed | 9 passed:
//   expected [ { event: 'stt:error', …(1) } ] to deeply equal []
// Restored from a byte backup (cmp identical); same command green again.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { CLIENT_CAPABILITY_STT_SEGMENT_NOT_TRANSCRIBED as CAP } from '@flowmic/protocol';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { DEFAULT_ENGINE_IDLE_HANGUP_MS } from '../src/stt/orchestrator-types';
import { declaresSegmentNotTranscribed } from '../src/stt/owed-voice-verdict';
import { SttSessionBridge } from '../src/engine/stt-session';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers, type AudioHandlerDeps, type SttStartArgs } from '../src/socket/handlers/audio.handler';
import { getClientCaps, setClientCaps } from '../src/socket/wire';
import { makeSttSessionFactory } from '../src/engine/stt-factory';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { seedDefaultSettings } from '../src/settings/defaults';
import type { QuotaGuard } from '../src/billing/quota-guard';
import type { UsageTracker } from '../src/billing/usage-tracker';
import { CHUNK_MS, FakeClock, T0, TranscribingEngine, ZH, drain, frame } from './fixtures/stt-outage-harness';

const CODE = 'STT_SEGMENT_NOT_TRANSCRIBED';
const SILENCE_CHUNKS = Math.floor(DEFAULT_ENGINE_IDLE_HANGUP_MS / CHUNK_MS) + 1;
const noopGuard: QuotaGuard = { ensureQuota() {}, remainingSttMs: () => Infinity, continuousCapMs: () => Infinity };
const noopUsage: UsageTracker = { recordSttUsage() {}, recordLlmUsage() {}, recordQuotaRefusal() {} };

class FakeSocket {
  data: Record<string, unknown> = { auth: { kind: 'mobile', userId: 'u1' } };
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(event: string, payload?: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

const START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };

describe('① admission puts the declared client_caps on the socket, at every mobile admission site', () => {
  // A structural guard: the admission handlers need a registry, a database and a
  // paired PC to reach these lines, and the value they store is not observable
  // from a client. What must hold is that no admission site sets the room
  // without also replacing the caps — a site that forgot would leave the
  // PREVIOUS admission's declaration on the socket.
  it.each([
    ['src/socket/handlers/mobile.handler.ts', 2],
    ['src/socket/handlers/mobile-reconnect.ts', 1],
  ] as const)('%s: each of its %i admission sites replaces the caps from the parsed frame', (rel, sites) => {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    const rooms = src.match(/setRoomUuid\(socket, pc\.room_uuid\);\n\s*setClientCaps\(socket, parsed\.data\.client_caps\);/g) ?? [];
    expect(rooms).toHaveLength(sites);
    expect(src.match(/setRoomUuid\(socket, /g) ?? []).toHaveLength(sites); // POSITIVE CONTROL: no site unpaired
  });

  it('REPLACE, never merge: an admission without the field clears an earlier declaration', () => {
    const s = new FakeSocket('m') as unknown as Socket;
    setClientCaps(s, [CAP]);
    expect(getClientCaps(s)).toEqual([CAP]);
    setClientCaps(s, undefined);
    expect(getClientCaps(s)).toEqual([]);
  });
});

describe('② audio:start hands the socket\'s declaration to the factory', () => {
  it('declared, then a re-admission without the field', () => {
    const mobile = new FakeSocket('m');
    const seen: (readonly string[] | undefined)[] = [];
    const deps: AudioHandlerDeps = {
      io: {} as unknown as import('socket.io').Server,
      guard: noopGuard,
      usageTracker: noopUsage,
      store: new RoomStore<FakeSocket>() as unknown as RoomStore<Socket>,
      sttFactory: (args: SttStartArgs) => { seen.push(args.clientCaps); return { pushChunk() {}, finish: async () => {}, dispose() {} } as never; },
    };
    registerAudioHandlers(mobile as unknown as Socket, deps);
    setClientCaps(mobile as unknown as Socket, [CAP]);
    mobile.fire('audio:start', START, () => {});
    setClientCaps(mobile as unknown as Socket, undefined);
    mobile.fire('audio:start', START, () => {});
    expect(seen).toEqual([[CAP], []]);
  });
});

describe('③ the production factory turns the declaration into the orchestrator flag', () => {
  it.each([[[CAP], true], [[], false], [undefined, false], [['something.else'], false]] as const)(
    'client_caps %j ⇒ %s', (caps, expected) => {
      const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('hangup3-gate-secret') });
      db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
      seedDefaultSettings(db.settings, 'u1');
      const store = new RoomStore<FakeSocket>() as unknown as RoomStore<Socket>;
      const factory = makeSttSessionFactory({ settings: db.settings, mode: 'standalone', store, quota: noopGuard });
      const args: SttStartArgs = { userId: 'u1', mode: 'realtime', delivery: 'inject', sourceLang: 'zh', onComplete: () => {}, ...(caps ? { clientCaps: caps } : {}) };
      const bridge = factory(new FakeSocket('m') as unknown as Socket, args);
      const orch = (bridge as unknown as { orchestrator: SttEngineOrchestrator }).orchestrator;
      expect(orch.segmentNotTranscribedDeclared).toBe(expected);
      expect(declaresSegmentNotTranscribed(caps)).toBe(expected);
      bridge.dispose();
      db.close();
    },
  );
});

// ── ④ frames ────────────────────────────────────────────────────────────────

const MARKER = 'hangup3-closing-dial-marker-7f3a';

/** Leg 0 opens; the redial (leg 1) is refused; the closing dial (leg 2) is refused
 *  with a message nothing else in the run can contain. */
class ScriptedLeg extends TranscribingEngine {
  constructor(private readonly legIdx: number, clock: FakeClock) { super(ZH, clock, { open: 'ok', finalEveryN: 0 }); }
  override async open(): Promise<void> {
    if (this.legIdx === 1) throw new Error('connect refused');
    if (this.legIdx >= 2) throw new Error(`connect refused ${MARKER}`);
    return super.open();
  }
}

async function owedAtRelease(caps: readonly string[] | undefined): Promise<Array<{ event: string; payload: unknown }>> {
  const clock = new FakeClock(T0);
  const frames: Array<{ event: string; payload: unknown }> = [];
  let voiced = true;
  let legs = 0;
  const bridge = new SttSessionBridge({
    build: (session: AudioSession) => {
      const orchestrator = new SttEngineOrchestrator(session, () => new ScriptedLeg(legs++, clock), {
        now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
        softSegmentMs: 600_000, shouldFeedEngine: (): boolean => voiced, idleHangupMs: DEFAULT_ENGINE_IDLE_HANGUP_MS,
      });
      // The same reading stt-factory.ts applies (block ③ pins that it does).
      orchestrator.segmentNotTranscribedDeclared = declaresSegmentNotTranscribed(caps);
      return { orchestrator, isByok: false, gated: false };
    },
    emitter: { emit: (event, payload) => frames.push({ event, payload }) },
    userId: 'u', mode: 'realtime', sourceLang: 'zh',
    onComplete: () => undefined,
    levelIntervalMs: 0,
  });
  await drain();
  let seq = 0;
  const pump = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) { bridge.pushChunk(seq, frame(seq).toString('base64'), clock.now); seq += 1; await clock.advance(CHUNK_MS); }
  };
  await pump(10);                        // heard by leg 0
  voiced = false; await pump(SILENCE_CHUNKS); // leg 0 hung up
  voiced = true; await pump(2);          // owed: the redial (leg 1) is refused, a rung is pending
  const done = bridge.finish(); await drain(); await clock.advance(20_000); await done; // the closing dial (leg 2) fails
  bridge.dispose();
  expect(legs).toBe(3); // RACE CONTROL: the owed-at-release path really ran
  return frames;
}

const carries = (f: { event: string; payload: unknown }): boolean => {
  const s = JSON.stringify(f);
  return s.includes(CODE) || s.includes(MARKER);
};
const terminal = (fs: Array<{ event: string; payload: unknown }>): unknown =>
  fs.find((f) => f.event === 'stt:final' && (f.payload as { is_segment: boolean }).is_segment === false)?.payload;

describe('④ the verdict reaches the wire only for a declared client — asserted on frames', () => {
  it('🔴 DECLARED: the stt:error frame carries the code and the closing dial\'s reason, before the terminal final', async () => {
    const fs = await owedAtRelease([CAP]);
    const hits = fs.filter(carries);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.event).toBe('stt:error');
    expect(hits[0]!.payload).toMatchObject({ code: CODE, retryable: false });
    expect(JSON.stringify(hits[0])).toContain(MARKER);
    expect(fs.indexOf(hits[0]!)).toBeLessThan(fs.findIndex((f) => f.event === 'stt:final' && (f.payload as { is_segment: boolean }).is_segment === false));
  });

  it('🔴 UNDECLARED (no field, empty list, other names): NOT ONE frame carries the code or the marker', async () => {
    const declared = await owedAtRelease([CAP]);
    for (const caps of [undefined, [], ['something.else']] as const) {
      const fs = await owedAtRelease(caps);
      // POSITIVE CONTROL — the probe saw this recording's frames, including the same
      // terminal final the declared run got, so its silence below is the gate's.
      expect(fs.filter((f) => f.event === 'stt:interim').length).toBeGreaterThan(0);
      expect(terminal(fs)).toBeDefined();
      expect((terminal(fs) as { text: string }).text).toBe((terminal(declared) as { text: string }).text);
      expect(fs.filter(carries)).toEqual([]);
    }
  });
});
