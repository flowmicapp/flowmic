// WP-R4-4 ① — the app-scenario feed. The room store now tracks the PC's latest
// focus:state process_name (mirrored from the relay), cleared on PC disconnect /
// room switch; compose:start reads it and fills ComposeStartArgs.processName so
// resolveScenarioContext finally receives the app-scenario signal in production.
// This pins: (a) the store's set/get/clear semantics, (b) the relay populates it,
// (c) the compose handler threads it into the factory args (with + without focus).

import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { RoomStore } from '../src/room/store';
import { registerRelayHandlers } from '../src/socket/handlers/relay.handler';
import { registerComposeHandlers, type ComposeHandlerDeps } from '../src/socket/handlers/compose.handler';
import type { QuotaGuard } from '../src/billing/quota-guard';
import { ServerError } from '../src/errors';
import type { UsageTracker } from '../src/billing/usage-tracker';
import type { ComposeStartArgs } from '../src/compose';
import type { ComposeOrchestrator } from '../src/engine/orchestrator';

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = {};
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(event: string, payload?: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
  received(event: string): unknown[] { return this.emitted.filter((e) => e.event === event).map((e) => e.payload); }
}

const noopGuard: QuotaGuard = { ensureQuota() {}, remainingSttMs: () => Infinity };
const noopUsage: UsageTracker = { recordSttUsage() {}, recordLlmUsage() {}, recordQuotaRefusal() {} };
const emptyOrchestrator: ComposeOrchestrator = { async *run() { /* no deltas */ } };

describe('RoomStore focus tracking — transient, cleared on PC leave / switch', () => {
  it('set / get the latest focus process_name for a room', () => {
    const store = new RoomStore();
    expect(store.getFocusProcess('room-1')).toBeUndefined();
    store.setFocusProcess('room-1', 'Code');
    expect(store.getFocusProcess('room-1')).toBe('Code');
    store.setFocusProcess('room-1', 'OUTLOOK');
    expect(store.getFocusProcess('room-1')).toBe('OUTLOOK');
  });

  it('a blank process_name clears the tracked focus', () => {
    const store = new RoomStore();
    store.setFocusProcess('room-1', 'Code');
    store.setFocusProcess('room-1', '   ');
    expect(store.getFocusProcess('room-1')).toBeUndefined();
  });

  it('PC disconnect (leavePc) drops the focus — no stale carry-over', () => {
    const store = new RoomStore<FakeSocket>();
    const pc = new FakeSocket('pc');
    store.joinPc('room-1', pc);
    // keep the room alive with a mobile so we can still read after leavePc
    store.joinMobile('room-1', 'm1', new FakeSocket('m1'));
    store.setFocusProcess('room-1', 'Code');
    store.leavePc('room-1', 'pc');
    expect(store.getFocusProcess('room-1')).toBeUndefined();
  });

  it('a new PC session (joinPc) starts with no inherited focus (room switch)', () => {
    const store = new RoomStore<FakeSocket>();
    store.joinPc('room-1', new FakeSocket('pc-a'));
    store.setFocusProcess('room-1', 'Code');
    store.joinPc('room-1', new FakeSocket('pc-b')); // PC replaced
    expect(store.getFocusProcess('room-1')).toBeUndefined();
  });
});

describe('relay focus:state populates the room-focus map (PC → store)', () => {
  it('a well-formed focus:state records the process_name for the room', () => {
    const store = new RoomStore<FakeSocket>();
    const pc = new FakeSocket('pc');
    pc.data = { auth: { kind: 'pc', userId: 'u1' }, roomUuid: 'room-1' };
    registerRelayHandlers(pc as unknown as Socket, { store: store as unknown as RoomStore<Socket> });

    pc.fire('focus:state', { window_title: 'main.ts — flowmic', process_name: 'Code' });
    expect(store.getFocusProcess('room-1')).toBe('Code');
  });
});

describe('compose:start fills processName from the tracked focus (store → factory)', () => {
  function wire(store: RoomStore<FakeSocket>, guard: QuotaGuard = noopGuard): { mobile: FakeSocket; seen: () => ComposeStartArgs | undefined; calls: () => number } {
    let captured: ComposeStartArgs | undefined;
    let calls = 0;
    const composeFactory = (args: ComposeStartArgs): ComposeOrchestrator => { captured = args; calls += 1; return emptyOrchestrator; };
    const mobile = new FakeSocket('m');
    mobile.data = { auth: { kind: 'mobile', userId: 'u1' }, roomUuid: 'room-1' };
    const deps: ComposeHandlerDeps = {
      io: {} as unknown as import('socket.io').Server,
      guard, usageTracker: noopUsage,
      store: store as unknown as RoomStore<Socket>,
      composeFactory,
    };
    registerComposeHandlers(mobile as unknown as Socket, deps);
    return { mobile, seen: () => captured, calls: () => calls };
  }

  it('WITH a tracked focus → processName is threaded into the factory args', async () => {
    const store = new RoomStore<FakeSocket>();
    store.setFocusProcess('room-1', 'Code');
    const { mobile, seen } = wire(store);
    mobile.fire('compose:start', { task: 'organize', source_text: 'um so like the thing' }, () => {});
    await Promise.resolve();
    expect(seen()?.processName).toBe('Code');
  });

  it('WITHOUT a tracked focus → processName is absent (undefined)', async () => {
    const store = new RoomStore<FakeSocket>();
    const { mobile, seen } = wire(store);
    mobile.fire('compose:start', { task: 'organize', source_text: 'x' }, () => {});
    await Promise.resolve();
    expect(seen()?.processName).toBeUndefined();
  });

  // 🔴 M6 (0.3.0). scenario-infer-store.ts's kick() carries a comment saying it
  // needs NO quota site of its own «because compose.handler.ts runs the ONE
  // ensureQuota('llm') gate BEFORE the compose factory (and therefore resolve())
  // is ever invoked». Anti-façade ④: that is a falsifiable claim about ANOTHER file,
  // so it gets a pinning test rather than a promise. If the gate ever moves below
  // the factory call, an exhausted llm_tokens valve would keep scheduling off-band
  // inference calls — spend with the valve already shut.
  it('M6: an exhausted llm valve stops compose:start BEFORE the factory (no inference is scheduled)', async () => {
    const store = new RoomStore<FakeSocket>();
    const exhausted: QuotaGuard = {
      ensureQuota(): void { throw new ServerError('QUOTA_EXCEEDED', 'llm quota exceeded (used 9/9)'); },
      remainingSttMs: () => Infinity,
    };
    const { mobile, calls } = wire(store, exhausted);
    let ack: Record<string, unknown> | undefined;
    mobile.fire('compose:start', { task: 'organize', source_text: 'x' }, (r) => { ack = r as Record<string, unknown>; });
    await Promise.resolve();
    // The factory is where the inference store lives, so 「zero constructions」 is 「zero inferences」.
    expect(calls()).toBe(0);
    // …and the refusal is LOUD on both channels (never a silent no-op turn).
    expect(mobile.received('compose:error')).toHaveLength(1);
    expect(ack?.error).toBe('QUOTA_EXCEEDED');
  });

  it('positive control: with an OPEN valve the same turn does reach the factory', async () => {
    // Otherwise 「calls()===0」 above could mean the harness never fired at all.
    const store = new RoomStore<FakeSocket>();
    const { mobile, calls } = wire(store);
    mobile.fire('compose:start', { task: 'organize', source_text: 'x' }, () => {});
    await Promise.resolve();
    expect(calls()).toBe(1);
  });
});
