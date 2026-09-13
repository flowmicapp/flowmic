// Card MP-12 (owner 2026-09-11 §11 追认 item 3) — A REFUSED SITE-KEY PRESS LEAVES
// A ROW.
//
// SPEC-REF:
//   docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md §11
//   src/socket/handlers/audio-start-quota.ts (the correction block: what MP-1
//     argued, which half of it was right, and why the conclusion flipped)
//   src/billing/usage-tracker.ts `recordQuotaRefusal` (the writer being reused)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// ── WHAT THIS FILE IS FOR ──────────────────────────────────────────────────
//
// MP-1 shipped the sub-quota refusal DELIBERATELY writing nothing to
// `usage_events`, on an argument that is half right (a row must not claim T's
// PLAN ran out) and whose conclusion was wrong (so T got no durable record of
// 「how many visitors did my site turn away」 at all — the journal line beside it
// rotates). This pins the row, its four identifying columns, and the one thing
// it must NOT do: move a counter.
//
// ⚠️ THE COLUMNS ARE NOT ASSERTED ONE BY ONE FROM A LITERAL. They arrive through
// `principalRefOf`, which reads the ADMISSION — so the test drives an admission
// shaped like the production one and asserts what came out the other end. A test
// that handed the tracker a principal itself would prove the tracker forwards
// its own argument.

import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers, type AudioHandlerDeps } from '../src/socket/handlers/audio.handler';
import type { QuotaGuard } from '../src/billing/quota-guard';
import type { MeteredPrincipalRef, UsageTracker } from '../src/billing/usage-tracker';

const T = 'user-integrator-T';
const KEY_ID = 'ik_g31000000000000000000000000000';
const SPEAKER = 'wb-1111222233334444';

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = {};
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this {
    this.handlers.set(event, cb);
    return this;
  }
  off(event: string): this { this.handlers.delete(event); return this; }
  removeListener(event: string): this { return this.off(event); }
  emit(event: string, payload?: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void {
    this.handlers.get(event)?.(payload, ack);
  }
  received(event: string): Array<unknown> {
    return this.emitted.filter((e) => e.event === event).map((e) => e.payload);
  }
}

interface RefusalCall {
  user_id: string;
  kind: string;
  refused_user_id: string;
  principal: MeteredPrincipalRef;
}

/**
 * An integrator-room admission, exactly as `resolvePayer`'s `'host'` branch
 * stamps one: the account is T (「谁的页面谁付」), the speaker is a visitor's
 * browser uid, and the key rides along.
 *
 * `keyRemainingMs` is the ONLY knob — T's plan is never the thing that refuses
 * here, which is what makes the row's subject the interesting question.
 */
function wire(keyRemainingMs: number): { socket: FakeSocket; refusals: RefusalCall[]; sttRows: number } {
  const refusals: RefusalCall[] = [];
  const counters = { stt: 0 };
  const usageTracker: UsageTracker = {
    recordSttUsage(): void { counters.stt += 1; },
    recordLlmUsage(): void {},
    recordQuotaRefusal(user_id, kind, refused_user_id, principal): void {
      refusals.push({ user_id, kind, refused_user_id, principal });
    },
  };
  const guard: QuotaGuard = {
    // T's PLAN is healthy throughout — see the file header.
    ensureQuota(): void {},
    remainingSttMs: () => Infinity,
    continuousCapMs: () => Infinity,
  };
  const socket = new FakeSocket('visitor-sock');
  socket.data = {
    auth: {
      kind: 'mobile',
      userId: T,
      deviceId: 'pc-integrator-room',
      payerReason: 'host',
      speakerRef: SPEAKER,
      integratorKeyId: KEY_ID,
    },
    roomUuid: 'room-integrator',
  };
  const deps: AudioHandlerDeps = {
    io: {} as unknown as import('socket.io').Server,
    guard,
    usageTracker,
    store: new RoomStore<FakeSocket>() as unknown as RoomStore<Socket>,
    sttFactory: () => ({ pushChunk() {}, finish: async () => {}, dispose() {} }) as never,
    integratorKeys: { remainingMs: () => keyRemainingMs },
  };
  registerAudioHandlers(socket as unknown as Socket, deps);
  return { socket, refusals, sttRows: counters.stt };
}

const START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'en' };

/** The one refusal, with 「there is exactly one」 asserted on the way past. The
 *  throw is unreachable once that assertion holds; it exists because `[0]` on a
 *  possibly-empty array is `T | undefined` and silencing that with `!` would
 *  turn an empty list into six confusing failures instead of one clear one. */
function theOnly(list: RefusalCall[]): RefusalCall {
  expect(list).toHaveLength(1);
  const [row] = list;
  if (row === undefined) throw new Error('unreachable: the length assertion above holds');
  return row;
}

describe('MP-12: a refused site-key press is recorded, not only spoken', () => {
  it('the sub-quota refusal writes ONE quota_refused row', () => {
    const { socket, refusals } = wire(0);
    socket.fire('audio:start', START, () => {});
    // Still spoken — this card adds a record, it does not move the refusal off
    // the wire (QTA-1).
    expect(socket.received('stt:error')[0]).toMatchObject({ code: 'INTEGRATOR_QUOTA_EXCEEDED' });
    expect(theOnly(refusals).kind).toBe('stt');
  });

  it('the row names T twice and the VISITOR nowhere but speaker_ref', () => {
    const { refusals } = (() => {
      const w = wire(0);
      w.socket.fire('audio:start', START, () => {});
      return w;
    })();
    const row = theOnly(refusals);
    // 🔴 `user_id` = whose attempt this ran against, `refused_user_id` = whose
    // ceiling said no. On an integrator room BOTH are T, because the `'host'`
    // branch made T the account this press runs against — and a visitor must
    // never appear as either, which would put a stranger's identity in the
    // subject of somebody else's billing row.
    expect(row.user_id).toBe(T);
    expect(row.refused_user_id).toBe(T);
    expect(row.principal.payer_reason).toBe('host');
    expect(row.principal.speaker_ref).toBe(SPEAKER);
    // 🔴 THE COLUMN THAT KEEPS THE ROW HONEST. Without it the row says 「T was
    // refused」, which reads as 「T's plan ran out」 — false, and the exact defect
    // MP-1's own comment refused to commit. With it, it says 「this key refused
    // a press」.
    expect(row.principal.integrator_key_id).toBe(KEY_ID);
  });

  it('a key with headroom is admitted and writes NO refusal row — the positive control', () => {
    // Without this, 「a row appeared」 could equally mean 「this arm records every
    // press」, and the assertion above would be about nothing.
    const { socket, refusals } = wire(60_000);
    socket.fire('audio:start', START, () => {});
    expect(socket.received('stt:error')).toHaveLength(0);
    expect(refusals).toHaveLength(0);
  });

  it('no counter moves — a refusal is a record, never a charge', () => {
    const w = wire(0);
    w.socket.fire('audio:start', START, () => {});
    // `recordSttUsage` is the only thing in this handler that moves money and
    // the key's `used_ms`. A refused press consumed no vendor seconds, so
    // spending sub-quota on it would let an exhausted key refuse forever while
    // its counter kept climbing.
    expect(w.sttRows).toBe(0);
  });
});
