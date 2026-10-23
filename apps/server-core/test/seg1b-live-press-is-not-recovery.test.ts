// Card SEG-1b (device check 2026-10-13, relay 0.3.111, Play 0.3.107, Notes
// screen): four presses longer than the soft-segment window, and the text before
// every cut came back unpolished with no mark. The relay log had eight
// `stt.polish.timing` lines, all `is_segment:false`.
//
// Cause: a LIVE press from a phone with first-frame retention (the default since
// RC-1) names its recording on `audio:start` — mobile `liveStartFields`
// (apps/mobile/lib/src/session/recovery_identity.dart) sends `recording_id`,
// `attempt_id`, `attempt_kind:'live'`, `range_start_sample:0`. The relay lifted
// that into `deps.recovery`, and SEG-1's gate read 「deps.recovery is set」 as
// 「this is a recovery leg」. The eval harness that A/B'd SEG-1 sends no such
// fields, which is why the local run was green.
//
// These cases drive the REAL `audio:start` handler with the payloads the phone
// sends and assert what the session is told: the echo (it must survive — the
// coverage receipt on the terminal final rides on it) and `recoveryLeg` (the one
// fact the polish gate reads). The bridge half is in seg1-segment-polish.test.ts.

import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers, type AudioHandlerDeps, type SttStartArgs } from '../src/socket/handlers/audio.handler';
import { AudioSessionRegistry } from '../src/engine/audio-registry';
import { isRecoveryLeg } from '../src/engine/stt-session-receipt';
import type { QuotaGuard } from '../src/billing/quota-guard';
import type { UsageTracker } from '../src/billing/usage-tracker';

const ROOM = 'room-1';
const PAIRING = 'mob-1';
// The Notes (record-only) press of the Play build: `AudioStartPayload.toJson()`
// with delivery 'none' (destination_controller.dart), no `continuous` key.
const NOTES_PRESS = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', send_policy: 'direct', delivery: 'none', source_lang: 'en' };
// `liveStartFields` — spread FIRST by `pttDown` (ptt_edges.dart).
const LIVE_STAMP = { recording_id: 'sess-1#1760371200000', attempt_id: 'att-live-1', attempt_kind: 'live', range_start_sample: 0, audio_format_version: 1 };
// `RecoveryIdentity.toStartFields` minus `operation_id`/`job_id` (not read here).
const RETRY_STAMP = { recording_id: 'sess-1#1760371200000', attempt_id: 'att-retry-1', attempt_kind: 'auto_retry', range_start_sample: 0, range_end_sample: 960_000, audio_format_version: 1 };

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string; audioSessions?: unknown } = {};
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(event: string, payload?: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  fire(event: string, payload?: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

async function startArgsFor(start: Record<string, unknown>): Promise<SttStartArgs> {
  const store = new RoomStore<FakeSocket>();
  store.joinPc(ROOM, new FakeSocket('pc'));
  const guard: QuotaGuard = { ensureQuota() {}, remainingSttMs: () => Infinity, continuousCapMs: () => Infinity };
  const usage: UsageTracker = { recordSttUsage() {}, recordLlmUsage() {}, recordQuotaRefusal() {} };
  const seen: SttStartArgs[] = [];
  const deps: AudioHandlerDeps = {
    io: {} as unknown as import('socket.io').Server,
    guard, usageTracker: usage,
    store: store as unknown as RoomStore<Socket>,
    sessions: new AudioSessionRegistry(),
    sttFactory: ((args: SttStartArgs) => { seen.push(args); return { pushChunk(): void {}, async finish(): Promise<void> {}, dispose(): void {} }; }) as unknown as AudioHandlerDeps['sttFactory'],
  };
  const mob = new FakeSocket('mob-sock');
  mob.data = { auth: { kind: 'mobile', userId: 'u1', pairingId: PAIRING }, roomUuid: ROOM };
  store.joinMobile(ROOM, PAIRING, mob);
  registerAudioHandlers(mob as unknown as Socket, deps);
  mob.fire('audio:start', start, () => {});
  for (let i = 0; i < 20 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  expect(seen, `audio:start was refused: ${JSON.stringify(mob.emitted)}`).toHaveLength(1);
  return seen[0]!;
}

describe('card SEG-1b — a live press that names its recording is NOT a recovery leg', () => {
  it('🔴 the Play build\'s Notes press (live stamp): echo kept for the receipt, recoveryLeg absent', async () => {
    const args = await startArgsFor({ ...LIVE_STAMP, ...NOTES_PRESS });
    expect(args.recovery).toEqual({ recording_id: LIVE_STAMP.recording_id, attempt_id: 'att-live-1', range_start_sample: 0 });
    expect(args.recoveryLeg).toBeUndefined();
    expect(args.continuous).toBeUndefined();
  });

  it('a recovery leg (auto_retry) is one', async () => {
    const args = await startArgsFor({ ...RETRY_STAMP, ...NOTES_PRESS });
    expect(args.recovery).toMatchObject({ attempt_id: 'att-retry-1', range_end_sample: 960_000 });
    expect(args.recoveryLeg).toBe(true);
  });

  it('a press from a phone that stamps nothing: neither echo nor recoveryLeg', async () => {
    const args = await startArgsFor({ ...NOTES_PRESS });
    expect(args.recovery).toBeUndefined();
    expect(args.recoveryLeg).toBeUndefined();
  });

  it('the predicate: user_retranscribe is a recovery leg; identifiers without attempt_kind fail closed to recovery', () => {
    expect(isRecoveryLeg({ recording_id: 'r', attempt_kind: 'user_retranscribe' })).toBe(true);
    expect(isRecoveryLeg({ recording_id: 'r', attempt_id: 'a' })).toBe(true);
    expect(isRecoveryLeg({ recording_id: 'r', attempt_kind: 'live' })).toBe(false);
    expect(isRecoveryLeg({ attempt_kind: 'auto_retry' })).toBe(false); // no identifiers ⇒ nothing to re-feed against
  });
});
