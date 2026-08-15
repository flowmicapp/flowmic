// QTA-1 (2026-08-15) — a refusal at the `audio:start` entry must LEAVE THE
// SERVER, not just fill an ack nobody reads.
//
// ── WHAT WAS MEASURED, and why this file exists ──────────────────────────────
// Tablet TB335ZC on 0.3.1, cloud-relay PC instance, 2026-08-15 ~17:21 CST:
// held the talk button for 4 s. `logcat` shows the mic really opened
// (`AudioRecord … sampleRate 16000 … packageName app.flowmic.android`);
// `/proc/net/tcp` shows exactly one live socket for the app, to the relay on
// :443. And then nothing happened anywhere — `journalctl -u flowmic-app` had no
// line at all for that window, and the phone showed no text, no error, no
// banner. The identical gesture in the record-only instance two minutes earlier
// produced the full trace (route selection + `audio intake`).
//
// The two instances belong to two DIFFERENT accounts (an artefact of an old
// automated dual-account test run): the record-only one had 2.1 of its 20 free
// STT minutes spent, the PC one had 20.012. So `ensureQuota` threw, the handler
// answered through `safeAck` — and `billing/quota-guard.ts`'s own header already
// records that the phone emits `audio:start` FIRE-AND-FORGET, so that ack has no
// reader. Both ends silent about a user being turned away is the red line
// ("没有静默失败"), and it is also why attributing it took an afternoon: the
// journal was silent too.
//
// ── WHY `stt:error` IS THE RIGHT CHANNEL ─────────────────────────────────────
// It reaches phones ALREADY IN THE FIELD. `ptt_inbound.dart` has routed terminal
// `stt:error` into the FSM since ENG-3, and `onSttTerminalError` deliberately
// handles the RECORDING case — its comment names this exact moment, "a cold-open
// failure on `audio:start` … moments into the press" — latching until the press
// ends; `sttStallBannerMessage` then keys on the WIRE CODE. Zero protocol
// change: same whitelisted event, same schema, same direction.
//
// ⚠️ The `AUTH_TOKEN_INVALID` arm is deliberately NOT covered — that socket is
// not an authenticated mobile and has its own re-pair surface. Asserted below so
// the exclusion is a decision on the record rather than an oversight.

import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers, type AudioHandlerDeps } from '../src/socket/handlers/audio.handler';
import type { QuotaGuard } from '../src/billing/quota-guard';
import type { UsageTracker } from '../src/billing/usage-tracker';
import { ServerError } from '../src/errors';

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = {};
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this {
    this.handlers.set(event, cb);
    return this;
  }
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

const stubOrchestrator = { pushChunk() {}, finish: async () => {}, dispose() {} };
const noopUsage: UsageTracker = { recordSttUsage() {}, recordLlmUsage() {}, recordQuotaRefusal() {} };

/** `guard` is the only knob: `overQuota` reproduces the production account. */
function wire(overQuota: boolean, opts: { authed?: boolean } = {}): FakeSocket {
  const guard: QuotaGuard = {
    ensureQuota(): void {
      if (overQuota) throw new ServerError('QUOTA_EXCEEDED', 'stt quota exceeded (used 20.012/20)');
    },
    remainingSttMs: () => (overQuota ? 0 : Infinity),
  };
  const mobile = new FakeSocket('mobile-sock');
  mobile.data = {
    ...(opts.authed === false ? {} : { auth: { kind: 'mobile', userId: 'u1' } }),
    roomUuid: 'room-1',
  };
  const deps: AudioHandlerDeps = {
    io: {} as unknown as import('socket.io').Server,
    guard,
    usageTracker: noopUsage,
    store: new RoomStore<FakeSocket>() as unknown as RoomStore<Socket>,
    sttFactory: () => stubOrchestrator as never,
  };
  registerAudioHandlers(mobile as unknown as Socket, deps);
  return mobile;
}

const START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };

describe('QTA-1: audio:start refusals are spoken, not only acked', () => {
  it('over quota ⇒ a terminal stt:error carrying the CODE, alongside the ack', () => {
    const mobile = wire(true);
    let acked: unknown = null;
    mobile.fire('audio:start', START, (r) => { acked = r; });

    // The ack still answers — nothing was taken away.
    expect(acked).toMatchObject({ error: 'QUOTA_EXCEEDED' });

    // 🔴 The part that was missing: a frame the phone actually reads.
    const errs = mobile.received('stt:error');
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ code: 'QUOTA_EXCEEDED', retryable: false });
  });

  it('retryable:false — a retryable frame would leave the phone waiting for a final that never comes', () => {
    const mobile = wire(true);
    mobile.fire('audio:start', START, () => {});
    // ptt_inbound.dart only acts on `!e.retryable`; a `true` here would be a
    // frame the phone receives and deliberately ignores, i.e. silence again.
    expect((mobile.received('stt:error')[0] as { retryable: boolean }).retryable).toBe(false);
  });

  it('an unparseable audio:start is spoken too, with the code that already has copy', () => {
    const mobile = wire(false);
    mobile.fire('audio:start', { mode: 'not-a-mode' }, () => {});
    expect(mobile.received('stt:error')[0]).toMatchObject({
      code: 'STT_CONFIG_MISSING',
      retryable: false,
    });
  });

  it('the happy path emits NO stt:error — the frame means "refused", never "started"', () => {
    const mobile = wire(false);
    let ackOk = false;
    mobile.fire('audio:start', START, (r) => { ackOk = (r as { ok?: boolean }).ok === true; });
    expect(ackOk).toBe(true);
    expect(mobile.received('stt:error')).toHaveLength(0);
  });

  it('an unauthenticated socket is NOT dressed as an engine fault (the deliberate exclusion)', () => {
    const mobile = wire(false, { authed: false });
    let acked: unknown = null;
    mobile.fire('audio:start', START, (r) => { acked = r; });
    expect(acked).toMatchObject({ error: 'AUTH_TOKEN_INVALID' });
    // Auth has its own surface (re-pair). Calling it an engine error would be
    // the 0.2.53 shape; this asserts the boundary rather than trusting a comment.
    expect(mobile.received('stt:error')).toHaveLength(0);
  });
});
