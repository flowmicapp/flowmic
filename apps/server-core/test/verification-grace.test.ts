// Card NR-2a item 2 — the 3-DAY UNVERIFIED GRACE.
// (item 3's anti-abuse floor lives in test/register-daily-cap.test.ts.)
//
// Behaviour contract:
//   docs/decisions/2026-08-27-owner-web-rulings-nr-ledger.md items 3 and 4
//     (宽限期 3 天; 云端拒新会话 + 具名提示; 已连会话不掐; LAN 永不受限)
//   src/auth/verification-grace.ts (the one conversion site + the guard)
//
// THREE LAYERS, measured separately on purpose:
//   ① the PURE verdict — every branch, on an injected clock, including the
//      grandfathering one that only exists because of a deploy-day trap;
//   ② the GUARD — the standalone exemption and the unknown-account direction;
//   ③ the two ENFORCEMENT SITES — driven through the real handlers, because a
//      guard nobody calls is this repo's canonical façade.
//
// 🔴 REVERSE CONTROL — run red once, then reverted (2026-08-27, dev-pc-a).
// The gate was bypassed in `makeVerificationGraceGuard` by making `check`
// return null unconditionally (drill-marked DRILL-NR2A-GRACE), i.e. an expired
// account admitted as if nothing had changed. Red output verbatim (the vitest
// `❯ file:line` pointer lines elided per the coordinate-anchors discipline; the
// failing assertions are named by symbol):
//
//   FAIL  test/verification-grace.test.ts > ② the guard > saas + expired ⇒ the
//     named refusal; saas + in-grace ⇒ admitted
//   AssertionError: expected null to deeply equal { …(2) }
//   FAIL  test/verification-grace.test.ts > ③ enforcement: the two session-start
//     sites, driven through the real handlers > 🔴 audio:start past the grace is
//     refused BY NAME, and the refusal leaves the server
//   AssertionError: expected { ok: true } to match object
//     { error: 'EMAIL_VERIFY_GRACE_EXPIRED' }
//   FAIL  test/verification-grace.test.ts > ③ enforcement: the two session-start
//     sites, driven through the real handlers > 🔴 compose:start past the grace
//     is refused BY NAME, on the ack AND on compose:error
//   AssertionError: expected 'LLM_PROBE_FAIL' to be 'EMAIL_VERIFY_GRACE_EXPIRED'
//   Tests  3 failed | 16 passed (19)
//
// 🔴 The middle line is the defect itself in one string: with the gate
// bypassed, an account three weeks past its grace gets `{ ok: true }` — the
// session starts, on our managed engine, on our bill.
//
// Drill reverted, suite green again, residue grep for the drill marker = 0.
//
// *** HUMAN-AUDIT SENSITIVE (auth: who may start a managed cloud session) ***

import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { ERROR_CODES } from '@flowmic/protocol';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers, type AudioHandlerDeps } from '../src/socket/handlers/audio.handler';
import { registerComposeHandlers, type ComposeHandlerDeps } from '../src/socket/handlers/compose.handler';
import type { QuotaGuard } from '../src/billing/quota-guard';
import type { UsageTracker } from '../src/billing/usage-tracker';
import {
  DAY_MS,
  EMAIL_VERIFY_GRACE_EXPIRED,
  makeVerificationGraceGuard,
  verificationGrace,
  verificationGraceEpochMs,
  VERIFICATION_GRACE_DAYS,
  VERIFICATION_GRACE_EPOCH_ENV,
  VERIFICATION_GRACE_MS,
} from '../src/auth/verification-grace';

// A fixed feature epoch for every case below. The production default is a
// constant in the source; pinning a DIFFERENT one here is deliberate — a test
// that reused the shipped date would go green or red depending on what day it
// is run, which is the exact class of defect this file is about.
const EPOCH = Date.parse('2026-09-01T00:00:00.000Z');
const AFTER_EPOCH = EPOCH + 10 * DAY_MS;

function verdict(o: {
  emailVerifiedAt?: number | null;
  createdAtMs: number;
  hasEmail?: boolean;
  nowMs: number;
}): ReturnType<typeof verificationGrace> {
  return verificationGrace({
    emailVerifiedAt: o.emailVerifiedAt ?? null,
    createdAtMs: o.createdAtMs,
    hasEmail: o.hasEmail ?? true,
    nowMs: o.nowMs,
    epochMs: EPOCH,
  });
}

describe('① the pure verdict — one conversion site, every branch', () => {
  it('a verified account has no countdown at all (null, never 0)', () => {
    expect(verdict({ emailVerifiedAt: AFTER_EPOCH, createdAtMs: AFTER_EPOCH, nowMs: AFTER_EPOCH + 99 * DAY_MS }))
      .toEqual({ state: 'verified', daysLeft: null });
  });

  it('an account with NO address never enters grace — nothing to verify', () => {
    // Standalone's single 'default' row is exactly this shape, which is why the
    // exemption is a FACT rather than a second mode branch in the guard.
    expect(verdict({ createdAtMs: AFTER_EPOCH, hasEmail: false, nowMs: AFTER_EPOCH + 99 * DAY_MS }))
      .toEqual({ state: 'verified', daysLeft: null });
  });

  it('a fresh unverified account counts down 3 → 2 → 1 and then expires', () => {
    const created = AFTER_EPOCH;
    expect(verdict({ createdAtMs: created, nowMs: created })).toEqual({ state: 'in_grace', daysLeft: 3 });
    expect(verdict({ createdAtMs: created, nowMs: created + DAY_MS })).toEqual({ state: 'in_grace', daysLeft: 2 });
    expect(verdict({ createdAtMs: created, nowMs: created + 2 * DAY_MS })).toEqual({ state: 'in_grace', daysLeft: 1 });
    // Rounded UP, so the last partial day still reads 1 — 0 is reserved for
    // 「the countdown finished」 and must not appear while the product works.
    expect(verdict({ createdAtMs: created, nowMs: created + 3 * DAY_MS - 1 })).toEqual({ state: 'in_grace', daysLeft: 1 });
    // Exactly at the deadline it is over.
    expect(verdict({ createdAtMs: created, nowMs: created + VERIFICATION_GRACE_MS })).toEqual({ state: 'expired', daysLeft: 0 });
  });

  it('🔴 GRANDFATHERING: an account created LONG before the epoch still gets its full 3 days', () => {
    // This is the deploy-day trap the epoch exists for. Without max(created,
    // epoch) every pre-existing unverified account — all of them older than
    // three days — would be refused on its very next sentence.
    const ancient = EPOCH - 400 * DAY_MS;
    expect(verdict({ createdAtMs: ancient, nowMs: EPOCH })).toEqual({ state: 'in_grace', daysLeft: 3 });
    expect(verdict({ createdAtMs: ancient, nowMs: EPOCH + VERIFICATION_GRACE_MS - 1 })).toMatchObject({ state: 'in_grace' });
    // …and it does eventually end. A grandfather clause that never expires is
    // a gate that does not exist.
    expect(verdict({ createdAtMs: ancient, nowMs: EPOCH + VERIFICATION_GRACE_MS })).toEqual({ state: 'expired', daysLeft: 0 });
  });

  it('an unreadable created_at is NOT a refusal — a failed read must not become 「verify your email」', () => {
    expect(verdict({ createdAtMs: NaN, nowMs: AFTER_EPOCH })).toEqual({ state: 'verified', daysLeft: null });
  });

  it('the epoch is overridable by env, and a garbage override falls back to the constant', () => {
    const prev = process.env[VERIFICATION_GRACE_EPOCH_ENV];
    try {
      process.env[VERIFICATION_GRACE_EPOCH_ENV] = '2026-12-25';
      expect(verificationGraceEpochMs()).toBe(Date.parse('2026-12-25'));
      // 🔴 Fail-safe direction: a typo must not silently set the epoch to
      // something that refuses everybody. It falls back to the constant.
      process.env[VERIFICATION_GRACE_EPOCH_ENV] = 'tuesday-ish';
      expect(verificationGraceEpochMs()).toBe(verificationGraceEpochMs({}));
    } finally {
      if (prev === undefined) delete process.env[VERIFICATION_GRACE_EPOCH_ENV];
      else process.env[VERIFICATION_GRACE_EPOCH_ENV] = prev;
    }
  });
});

// ── ② the guard ─────────────────────────────────────────────────────────────
function guardFor(mode: 'saas' | 'standalone', row: {
  emailVerifiedAt: number | null;
  createdAtMs: number;
  hasEmail: boolean;
} | null, nowMs: number): ReturnType<typeof makeVerificationGraceGuard> {
  return makeVerificationGraceGuard(
    { graceInputs: () => row },
    { mode, now: () => nowMs, epochMs: EPOCH },
  );
}
const EXPIRED_ROW = { emailVerifiedAt: null, createdAtMs: AFTER_EPOCH, hasEmail: true };
const WAY_LATER = AFTER_EPOCH + 30 * DAY_MS;

describe('② the guard', () => {
  it('saas + expired ⇒ the named refusal; saas + in-grace ⇒ admitted', () => {
    expect(guardFor('saas', EXPIRED_ROW, WAY_LATER).check('u1')).toEqual({
      error: EMAIL_VERIFY_GRACE_EXPIRED,
      message: expect.stringContaining(String(VERIFICATION_GRACE_DAYS)),
    });
    expect(guardFor('saas', EXPIRED_ROW, AFTER_EPOCH).check('u1')).toBeNull();
  });

  it('🔴 STANDALONE IS EXEMPT — LAN is never gated (owner ruling item 4)', () => {
    // Same expired row, same clock, different mode. This is the assertion that
    // says 「LAN 永不受限」 rather than a comment claiming it.
    expect(guardFor('standalone', EXPIRED_ROW, WAY_LATER).check('u1')).toBeNull();
  });

  it('an unknown account is admitted — a failed read is not a verdict', () => {
    expect(guardFor('saas', null, WAY_LATER).check('u1')).toBeNull();
    expect(guardFor('saas', null, WAY_LATER).daysLeft('u1')).toBeNull();
  });

  it('daysLeft reports on BOTH modes, and reports 0 exactly when check refuses', () => {
    // The report is not mode-gated: a standalone box has no email on its single
    // row, so it answers null by fact. What must never happen is a countdown
    // that disagrees with the wall — one conversion site is what prevents it.
    expect(guardFor('saas', EXPIRED_ROW, AFTER_EPOCH).daysLeft('u1')).toBe(3);
    expect(guardFor('saas', EXPIRED_ROW, WAY_LATER).daysLeft('u1')).toBe(0);
    expect(guardFor('standalone', { emailVerifiedAt: null, createdAtMs: AFTER_EPOCH, hasEmail: false }, WAY_LATER)
      .daysLeft('u1')).toBeNull();
  });
});

// ── ③ enforcement, through the real handlers ────────────────────────────────
class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = {};
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  off(event: string): this { this.handlers.delete(event); return this; }
  removeListener(event: string): this { return this.off(event); }
  emit(event: string, payload?: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
  received(event: string): unknown[] { return this.emitted.filter((e) => e.event === event).map((e) => e.payload); }
}

const noopUsage: UsageTracker = { recordSttUsage() {}, recordLlmUsage() {}, recordQuotaRefusal() {} };
const openQuota: QuotaGuard = { ensureQuota() {}, remainingSttMs: () => Infinity };
const stubOrchestrator = { pushChunk() {}, finish: async () => {}, dispose() {} };
const AUDIO_START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };
const COMPOSE_START = { request_id: 'req-1', task: 'organize', source_text: 'hello', source_lang: 'zh' };

function audioSocket(expired: boolean): FakeSocket {
  const socket = new FakeSocket('mobile-sock');
  socket.data = { auth: { kind: 'mobile', userId: 'u1' }, roomUuid: 'room-1' };
  const deps: AudioHandlerDeps = {
    io: {} as unknown as import('socket.io').Server,
    guard: openQuota,
    usageTracker: noopUsage,
    store: new RoomStore<FakeSocket>() as unknown as RoomStore<Socket>,
    sttFactory: () => stubOrchestrator as never,
    verificationGrace: guardFor('saas', EXPIRED_ROW, expired ? WAY_LATER : AFTER_EPOCH),
  };
  registerAudioHandlers(socket as unknown as Socket, deps);
  return socket;
}

function composeSocket(expired: boolean): FakeSocket {
  const socket = new FakeSocket('mobile-sock');
  socket.data = { auth: { kind: 'mobile', userId: 'u1' }, roomUuid: 'room-1' };
  const deps: ComposeHandlerDeps = {
    io: {} as unknown as import('socket.io').Server,
    guard: openQuota,
    usageTracker: noopUsage,
    store: new RoomStore<FakeSocket>() as unknown as RoomStore<Socket>,
    verificationGrace: guardFor('saas', EXPIRED_ROW, expired ? WAY_LATER : AFTER_EPOCH),
  };
  registerComposeHandlers(socket as unknown as Socket, deps);
  return socket;
}

describe('③ enforcement: the two session-start sites, driven through the real handlers', () => {
  it('🔴 audio:start past the grace is refused BY NAME, and the refusal leaves the server', () => {
    const socket = audioSocket(true);
    let acked: unknown = null;
    socket.fire('audio:start', AUDIO_START, (r) => { acked = r; });
    expect(acked).toMatchObject({ error: EMAIL_VERIFY_GRACE_EXPIRED });
    // 🔴 QTA-1: the ack on this leg has no reader (the phone emits `audio:start`
    // fire-and-forget), so a refusal that only acked would be silence. It goes
    // through `refuseStart`, which emits a terminal stt:error.
    const errs = socket.received('stt:error');
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ code: EMAIL_VERIFY_GRACE_EXPIRED, retryable: false });
  });

  it('POSITIVE CONTROL — the same account inside its grace starts normally and emits no error', () => {
    // Without this, the assertion above could be measuring a handler that
    // refuses every press for any reason at all.
    const socket = audioSocket(false);
    let ackOk = false;
    socket.fire('audio:start', AUDIO_START, (r) => { ackOk = (r as { ok?: boolean }).ok === true; });
    expect(ackOk).toBe(true);
    expect(socket.received('stt:error')).toHaveLength(0);
  });

  it('🔴 compose:start past the grace is refused BY NAME, on the ack AND on compose:error', () => {
    const socket = composeSocket(true);
    let acked: any = null;
    socket.fire('compose:start', COMPOSE_START, (r) => { acked = r; });
    expect(acked?.error).toBe(EMAIL_VERIFY_GRACE_EXPIRED);
    // compose:start's contract is that a run ends in done or error. An ack-only
    // refusal would leave the phone waiting out its 45-second watchdog and then
    // naming the wrong wall (`timeout`).
    const errs = socket.received('compose:error') as Array<{ code: string; request_id?: string }>;
    expect(errs).toHaveLength(1);
    expect(errs[0]?.code).toBe(EMAIL_VERIFY_GRACE_EXPIRED);
    // The echo rides along, or the phone discards the frame before rendering it
    // (compose.handler.ts's card-F3 note).
    expect(errs[0]?.request_id).toBe('req-1');
  });

  it('POSITIVE CONTROL — inside the grace, compose:start gets past this gate', () => {
    const socket = composeSocket(false);
    let acked: any = null;
    socket.fire('compose:start', COMPOSE_START, (r) => { acked = r; });
    // No composeFactory is wired here, so it fails LOUD one gate further on —
    // which is the point: the refusal is no longer OURS.
    expect(acked?.error).not.toBe(EMAIL_VERIFY_GRACE_EXPIRED);
    const errs = socket.received('compose:error') as Array<{ code: string }>;
    expect(errs[0]?.code).not.toBe(EMAIL_VERIFY_GRACE_EXPIRED);
  });

  it('an UNWIRED guard changes nothing — the gate is opt-in at the seam, closed by the mode inside it', () => {
    const socket = new FakeSocket('mobile-sock');
    socket.data = { auth: { kind: 'mobile', userId: 'u1' }, roomUuid: 'room-1' };
    registerAudioHandlers(socket as unknown as Socket, {
      io: {} as unknown as import('socket.io').Server,
      guard: openQuota,
      usageTracker: noopUsage,
      store: new RoomStore<FakeSocket>() as unknown as RoomStore<Socket>,
      sttFactory: () => stubOrchestrator as never,
    });
    let ackOk = false;
    socket.fire('audio:start', AUDIO_START, (r) => { ackOk = (r as { ok?: boolean }).ok === true; });
    expect(ackOk).toBe(true);
  });
});

describe('pins', () => {
  it('🔴 EMAIL_VERIFY_GRACE_EXPIRED is NOT a protocol error code — the owner-gated table did not move', () => {
    expect(Object.prototype.hasOwnProperty.call(ERROR_CODES, EMAIL_VERIFY_GRACE_EXPIRED)).toBe(false);
  });
});
