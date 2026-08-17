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

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers, type AudioHandlerDeps } from '../src/socket/handlers/audio.handler';
import { AudioSessionRegistry } from '../src/engine/audio-registry';
import { SttConfigMissingError } from '../src/stt/engine-router';
import type { QuotaGuard } from '../src/billing/quota-guard';
import type { UsageTracker } from '../src/billing/usage-tracker';
import { ServerError } from '../src/errors';
import { log } from '../src/log';
import { wrapSocketHandlers } from '../src/error-handling';

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = {};
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this {
    this.handlers.set(event, cb);
    return this;
  }
  /** card K-3 — present so this socket can be handed to `wrapSocketHandlers`,
   *  which patches `on` and translates removals by reference. Never called by
   *  the audio handler; they exist to make the CONTAINMENT layer wrappable. */
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

/** A guard that refuses ONE named account — the phone-signed-into-A,
 *  desktop-signed-into-B shape from the production diagnosis. Also records the
 *  accounts that were ASKED, which is the probe cards QTA-2 and K-1 both need:
 *  "was the session allowed" and "was that ledger consulted" are two facts, and
 *  only the second one distinguishes a narrowed gate from a deleted one.
 *
 *  🔴 Module scope (it was inside the QTA-2 block until card K-1) so the K-1 and
 *  K-5 blocks below drive the exact same wiring rather than a lookalike copy. */
function dualWire(refusedUser: string | null, pcOwner: string | null): FakeSocket {
  const asked: string[] = [];
  const guard: QuotaGuard = {
    ensureQuota(user_id: string): void {
      asked.push(user_id);
      if (user_id === refusedUser) throw new ServerError('QUOTA_EXCEEDED', `stt quota exceeded for ${user_id}`);
    },
    remainingSttMs: () => Infinity,
  };
  const mobile = new FakeSocket('mobile-sock');
  mobile.data = { auth: { kind: 'mobile', userId: 'phone-acct', deviceId: 'pc-1' }, roomUuid: 'room-1' };
  const deps: AudioHandlerDeps = {
    io: {} as unknown as import('socket.io').Server,
    guard,
    usageTracker: noopUsage,
    store: new RoomStore<FakeSocket>() as unknown as RoomStore<Socket>,
    sttFactory: () => stubOrchestrator as never,
    pcOwnerUserId: () => pcOwner,
  };
  registerAudioHandlers(mobile as unknown as Socket, deps);
  (mobile as FakeSocket & { asked: string[] }).asked = asked;
  return mobile;
}

// ── card QTA-2 (owner 2026-08-15, correcting his own same-day one-side ruling):
// 「计费在 PC 和手机端都进行检查，两边有一方不满足都不能继续」 ─────────────────
describe('QTA-2: BOTH accounts must admit the session', () => {
  it('🔴 the PC owner being over quota blocks, even when the phone account is fine', () => {
    const mobile = dualWire('pc-acct', 'pc-acct');
    mobile.fire('audio:start', START, () => {});
    expect(mobile.received('stt:error')[0]).toMatchObject({ code: 'QUOTA_EXCEEDED', retryable: false });
  });

  it('the phone account being over quota blocks, whatever the PC owner has left', () => {
    const mobile = dualWire('phone-acct', 'pc-acct');
    mobile.fire('audio:start', START, () => {});
    expect(mobile.received('stt:error')[0]).toMatchObject({ code: 'QUOTA_EXCEEDED', retryable: false });
  });

  it('both accounts fine ⇒ admitted, and each was really ASKED once', () => {
    const mobile = dualWire(null, 'pc-acct');
    mobile.fire('audio:start', START, () => {});
    expect(mobile.received('stt:error')).toHaveLength(0);
    expect((mobile as FakeSocket & { asked: string[] }).asked).toEqual(['phone-acct', 'pc-acct']);
  });

  it('same account on both ends is asked ONCE — not double-jeopardy on one ledger', () => {
    const mobile = dualWire(null, 'phone-acct');
    mobile.fire('audio:start', START, () => {});
    expect((mobile as FakeSocket & { asked: string[] }).asked).toEqual(['phone-acct']);
  });

  it('no resolver wired (old wiring) ⇒ single-account behaviour, unchanged', () => {
    const mobile = wire(false);
    mobile.fire('audio:start', START, () => {});
    expect(mobile.received('stt:error')).toHaveLength(0);
  });

  // ── card K-1 ───────────────────────────────────────────────────────────────
  //
  // QTA-2 put the PC owner's ledger in front of every press. It reads
  // `delivery` NOWHERE, because in the shipped handler that const was declared
  // ~30 lines BELOW the quota block — so the gate ran without knowing whether
  // this utterance targets a PC at all.
  //
  // A record-only press is one the PC is contractually forbidden to hear
  // anything about (GA-02, the zero-frames tests in audio-fanout.test.ts). It
  // could nevertheless be refused because that PC's owner is out of minutes —
  // a refusal whose stated reason is true of an account the utterance never
  // touches, and the user's own minutes are untouched too. The words stay on
  // the phone and the phone still says nothing.
  //
  // ⚠️ BLAST RADIUS, stated precisely rather than generously: a CLOUD
  // light-record instance mints its virtual PC under the SAME user_id, so
  // `pcUserId === auth.userId` and the second check was skipped anyway. The
  // path that was really hit is a PC-PAIRED instance toggled to record-only
  // over the relay, with the desktop signed into a different account.
  it('🔴 record-only is admitted while the PC owner is over quota', () => {
    const mobile = dualWire('pc-acct', 'pc-acct');
    mobile.fire('audio:start', { ...START, delivery: 'none' }, () => {});
    expect(mobile.received('stt:error')).toHaveLength(0);
  });

  it("🔴 …and the PC owner is never ASKED — 'admitted anyway' is not the same fact", () => {
    // Without this row the one above could pass on a handler that still asks
    // and then ignores the answer. The two questions are: was the session
    // allowed, and was that ledger consulted at all. Only the second one is
    // what "a session that targets no PC must not be judged by a PC's ledger"
    // actually claims.
    const mobile = dualWire(null, 'pc-acct');
    mobile.fire('audio:start', { ...START, delivery: 'none' }, () => {});
    expect((mobile as FakeSocket & { asked: string[] }).asked).toEqual(['phone-acct']);
  });

  it('positive control: the SAME wiring with delivery:inject still asks both and still refuses', () => {
    // The narrowing must not have become a removal. Same guard, same accounts,
    // one field different — and this row is what tells "K-1 landed" apart from
    // "the PC-owner gate was deleted".
    const mobile = dualWire('pc-acct', 'pc-acct');
    mobile.fire('audio:start', { ...START, delivery: 'inject' }, () => {});
    expect((mobile as FakeSocket & { asked: string[] }).asked).toEqual(['phone-acct', 'pc-acct']);
    expect(mobile.received('stt:error')[0]).toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it("the ACTING account is still judged on a record-only press — its own minutes are spent either way", () => {
    // The other half of the narrowing, and the one that would make it a hole:
    // record-only still transcribes, so the phone's own ledger is still due.
    const mobile = dualWire('phone-acct', 'pc-acct');
    mobile.fire('audio:start', { ...START, delivery: 'none' }, () => {});
    expect(mobile.received('stt:error')[0]).toMatchObject({ code: 'QUOTA_EXCEEDED', retryable: false });
  });
});

// ── card K-5: the refusal log line must say WHOSE ledger, and about WHAT ─────
//
// `refuseStart` logged {code, message, room}. Post-QTA-2 two accounts can
// produce the identical `QUOTA_EXCEEDED` string, so the line named the failure
// without naming the half — the same ambiguity that made the QTA-1 diagnosis an
// afternoon of archaeology. These rows assert the discriminator on the LOG, not
// on the frame: the wire deliberately carries no account id (it goes to the
// phone, and the PC owner's id is not the phone's business).
describe('K-5: audio:start refusals are attributable', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  /** Only the lines this handler writes — `log.warn` has other producers. */
  function refusals(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
    return warn.mock.calls
      .filter((c) => c[0] === 'audio:start refused')
      .map((c) => c[1] as Record<string, unknown>);
  }

  it("the PC-owner half names gate:'pc_owner' AND the PC owner's id", () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const mobile = dualWire('pc-acct', 'pc-acct');
    mobile.fire('audio:start', START, () => {});
    expect(refusals(warn)).toHaveLength(1);
    expect(refusals(warn)[0]).toMatchObject({
      code: 'QUOTA_EXCEEDED', gate: 'pc_owner', user_id: 'pc-acct', delivery: 'inject',
    });
  });

  it("the acting half names gate:'acting' AND the phone's id", () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const mobile = dualWire('phone-acct', 'pc-acct');
    mobile.fire('audio:start', START, () => {});
    expect(refusals(warn)[0]).toMatchObject({
      code: 'QUOTA_EXCEEDED', gate: 'acting', user_id: 'phone-acct',
    });
  });

  it('the payload arm carries delivery:null — there is no parsed frame to read it from', () => {
    // Honest absence rather than a defaulted 'inject': the frame did not parse,
    // so we do not know what it wanted, and saying 'inject' would be a guess
    // printed in a diagnostic.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const mobile = wire(false);
    mobile.fire('audio:start', { mode: 'not-a-mode' }, () => {});
    expect(refusals(warn)[0]).toMatchObject({ gate: 'payload', delivery: null });
  });
});

// ── card K-3: nothing between the auth check and the ack may be unguarded ────
//
// The fan-out emit and `sessions.put` used to sit between the quota catch and
// the engine try. `put` disposes a same-key survivor, and dispose() runs
// `orchestrator.close()` / `vad.finish()` unwrapped — a throw there was caught
// only by `wrapSocketHandlers`, which rate-gate logs and DROPS the event. No
// ack, no `stt:error`: the phone holds the button against a server that has
// already given up. Reaching the ack is not the same as reaching an answer.
//
// 🔴 THE CONTAINMENT LAYER IS IN THE HARNESS ON PURPOSE. `wrapSocketHandlers`
// is what bootstrap wraps every socket in, and it is the reason the old shape
// produced SILENCE rather than a crash. Without it here, the reverse control
// would show a raw throw escaping `fire()` — which is a red, but not the red
// the user experiences. With it, breaking the fix reproduces the actual
// symptom: zero frames, zero ack, one rate-gated log line nobody is reading.
describe('K-3: a throw while installing the session is ANSWERED, not dropped', () => {
  function wireWithExplodingRegistry(): { mobile: FakeSocket; acked: () => unknown } {
    const sessions = new AudioSessionRegistry();
    // Patched rather than faked: `put` is a real method with a real disposal
    // side effect, and the failure under test is that side effect throwing.
    sessions.put = (): never => { throw new Error('dispose blew up inside put'); };
    const mobile = new FakeSocket('mobile-sock');
    mobile.data = { auth: { kind: 'mobile', userId: 'u1', pairingId: 'pair-1' }, roomUuid: 'room-1' };
    let acked: unknown = null;
    const deps: AudioHandlerDeps = {
      io: {} as unknown as import('socket.io').Server,
      guard: { ensureQuota(): void {}, remainingSttMs: () => Infinity },
      usageTracker: noopUsage,
      store: new RoomStore<FakeSocket>() as unknown as RoomStore<Socket>,
      sessions,
      sttFactory: () => stubOrchestrator as never,
    };
    // Exactly bootstrap's order: contain FIRST, then register the handlers that
    // the containment is meant to contain.
    wrapSocketHandlers(mobile as unknown as Socket, { logger: { error: () => {} } });
    registerAudioHandlers(mobile as unknown as Socket, deps);
    mobile.fire('audio:start', START, (r) => { acked = r; });
    return { mobile, acked: () => acked };
  }

  it('the phone hears one stt:error instead of nothing at all', () => {
    const { mobile } = wireWithExplodingRegistry();
    expect(mobile.received('stt:error')).toHaveLength(1);
  });

  it('…and the ack carries an error too — both channels, exactly as the other arms', () => {
    const { acked } = wireWithExplodingRegistry();
    // ⚠️ `SETTINGS_SYNC_FAIL` is `errorPayload`'s generic fallback for a
    // non-ServerError, and it is a poor NAME for "installing the session threw".
    // Asserted as-is rather than improved: minting a truthful code is an owner
    // gate, and K-3's claim is about the answer EXISTING, not about its wording.
    expect(acked()).toMatchObject({ error: 'SETTINGS_SYNC_FAIL' });
  });
});

// ── card K-4: the engine arm must reach the LOG, not only the wire ──────────
//
// It emitted `stt:error` by hand, so unlike the three other arms it wrote no
// server line. QTA-1's whole diagnosis rested on the relay journal being able
// to say a press was turned away — and on the arm that fires when STT is
// MISCONFIGURED, the journal stayed empty.
describe('K-4: an engine-build failure is spoken to the journal as well', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function wireBrokenEngine(): FakeSocket {
    const mobile = new FakeSocket('mobile-sock');
    mobile.data = { auth: { kind: 'mobile', userId: 'u1' }, roomUuid: 'room-1' };
    registerAudioHandlers(mobile as unknown as Socket, {
      io: {} as unknown as import('socket.io').Server,
      guard: { ensureQuota(): void {}, remainingSttMs: () => Infinity },
      usageTracker: noopUsage,
      store: new RoomStore<FakeSocket>() as unknown as RoomStore<Socket>,
      // The router's own failure, which is what this arm exists for.
      sttFactory: () => { throw new SttConfigMissingError('no engine for zh'); },
    });
    return mobile;
  }

  it("exactly one 'audio:start refused' line, carrying STT_CONFIG_MISSING and gate:'engine'", () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    wireBrokenEngine().fire('audio:start', START, () => {});
    const lines = warn.mock.calls.filter((c) => c[0] === 'audio:start refused');
    expect(lines).toHaveLength(1);
    expect(lines[0]![1]).toMatchObject({ code: 'STT_CONFIG_MISSING', gate: 'engine' });
  });

  it('the wire message is unchanged by the reroute — the frame the phone reads is the same', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const mobile = wireBrokenEngine();
    mobile.fire('audio:start', START, () => {});
    // The error's own sentence, verbatim — `SttConfigMissingError` composes it
    // from the language, and rerouting through refuseStart must not swap it for
    // refuseStart's generic fallback.
    expect(mobile.received('stt:error')[0]).toMatchObject({
      code: 'STT_CONFIG_MISSING',
      message: 'No STT engine configured for language no engine for zh',
      retryable: false,
    });
  });
});
