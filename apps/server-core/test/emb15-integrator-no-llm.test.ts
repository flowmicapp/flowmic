// card EMB-15 (privacy draft C-2): speech in an EMBEDDED (`room_kind==='integrator'`)
// room never reaches a language model, whatever the host's stored polish switch,
// the visitor's own app prefs, or the refine switch say. The model that would
// have been used is the HOST's, and the words are a STRANGER's.
//
// What is observed, and why it is not a mock of the thing under test:
//   - `resolveLlmConfigWithSource` is spied (real implementation underneath): it is
//     the single place either LLM leg (polish, refine) picks the host's model, so
//     "never called" = "no LLM leg was even armed for this session".
//   - `SttSessionBridge` is the real class wrapped so the deps the factory built
//     for the session are captured: `polish`, `refine`, `polishUnavailable`.
//   - The wiring under test is the REAL `registerAudioHandlers` /
//     `registerComposeHandlers` reading the room kind off a `pcRoom` reader.
//
// TRUTHFUL OUTCOME: the session is armed with NO `polish` and NO
// `polishUnavailable` -- the existing SILENT-OFF state (`resolvePolishDep` returns
// `{armed:false}` when the switch is off). That is what stt:final reports as "no
// polish field": polish did not run and nothing failed. It is deliberately NOT
// `llm_error` (which says "asked for and failed") and no new `polish_reason`
// wire value exists (kSttPolishReasons on the phone is a closed set).
//
// REVERSE CONTROLS (executed on this tree; see the EMB-15 delivery report):
//   stt-factory.ts `args.integratorRoom === true ? { armed:false } : ...` -> drop the
//   ternary => the polish/refine cases below go red; audio.handler.ts drop the
//   `integratorRoom: true` stamp => the handler-wiring cases go red;
//   compose.handler.ts drop the isIntegratorSession refusal => the compose case red.
//   NR-132 (2026-09-29, this tree): the same ternary replaced by a comparison that
//   is never true ⇒ `vitest run test/emb15-integrator-no-llm.test.ts`: 5 red,
//   including both new 「NOTHING set」 integrator cases (expected 1 to be +0 —
//   the host's model was resolved). Restored from a byte copy; 9/9 green.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';

const llmSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../src/compose/llm-config', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/compose/llm-config')>();
  return {
    ...real,
    resolveLlmConfigWithSource: (...a: Parameters<typeof real.resolveLlmConfigWithSource>) => {
      llmSpy.calls += 1;
      return real.resolveLlmConfigWithSource(...a);
    },
  };
});
const bridgeSpy = vi.hoisted(() => ({ deps: [] as Array<Record<string, unknown>> }));
vi.mock('../src/engine/stt-session', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/engine/stt-session')>();
  class CapturingBridge extends real.SttSessionBridge {
    constructor(d: ConstructorParameters<typeof real.SttSessionBridge>[0]) {
      super(d);
      bridgeSpy.deps.push(d as unknown as Record<string, unknown>);
    }
  }
  return { ...real, SttSessionBridge: CapturingBridge };
});

import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { RoomStore } from '../src/room/store';
import { makeSttSessionFactory } from '../src/engine/stt-factory';
import { registerAudioHandlers, type AudioHandlerDeps, type SttStartArgs } from '../src/socket/handlers/audio.handler';
import { registerComposeHandlers } from '../src/socket/handlers/compose.handler';
import { seedDefaultSettings } from '../src/settings/defaults';
import type { QuotaGuard, QuotaKind } from '../src/billing/quota-guard';
import type { UsageTracker } from '../src/billing/usage-tracker';
import type { ComposeOrchestrator } from '../src/engine/orchestrator';

const noopUsage: UsageTracker = { recordSttUsage() {}, recordLlmUsage() {}, recordQuotaRefusal() {} };
function recordingGuard(): QuotaGuard & { asked: QuotaKind[] } {
  const asked: QuotaKind[] = [];
  return {
    asked,
    ensureQuota(_u: string, k: QuotaKind): void { asked.push(k); },
    remainingSttMs: () => Infinity,
    continuousCapMs: () => Infinity,
  };
}

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = { auth: { kind: 'mobile', userId: 'u1', deviceId: 'pc-1' } };
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(event: string, payload?: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
  received(event: string): Array<Record<string, unknown>> {
    return this.emitted.filter((e) => e.event === event).map((e) => e.payload as Record<string, unknown>);
  }
}

const LLM = { protocol: 'openai-compatible', endpoint: 'http://x/v1', api_key: 'EMPTY', model: 'm' } as const;
const START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };

function rig(roomKind: string | null, opts: { hostPolish?: boolean; hostRefine?: boolean; noModel?: boolean } = {}) {
  const db: DbConnection = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('emb15-no-llm-secret') });
  db.users.insert({ id: 'u1', display_name: 'Host', plan: 'free' });
  seedDefaultSettings(db.settings, 'u1');
  if (!opts.noModel) db.settings.write('u1', 'llm.config', LLM);
  if (opts.hostPolish) db.settings.write('u1', 'stt.polish', { enabled: true });
  if (opts.hostRefine) db.settings.write('u1', 'stt.refine', { enabled: true });
  const guard = recordingGuard();
  const store = new RoomStore<FakeSocket>();
  const phone = new FakeSocket('phone');
  const factory = makeSttSessionFactory({
    settings: db.settings, mode: 'standalone', store: store as unknown as RoomStore<Socket>, quota: guard,
  });
  const seen: SttStartArgs[] = [];
  const pcRoom = (id: string) => (id === 'pc-1' ? { userId: 'u1', roomKind } : null);
  const deps: AudioHandlerDeps = {
    io: {} as unknown as import('socket.io').Server,
    guard,
    usageTracker: noopUsage,
    store: store as unknown as RoomStore<Socket>,
    pcRoom,
    sttFactory: (args: SttStartArgs) => { seen.push(args); return factory(phone as unknown as Socket, args); },
  };
  registerAudioHandlers(phone as unknown as Socket, deps);
  const composeRuns: number[] = [];
  const composeFactory = (): ComposeOrchestrator => {
    composeRuns.push(1);
    return { async *run() { yield 'x'; } };
  };
  registerComposeHandlers(phone as unknown as Socket, {
    io: deps.io, guard, usageTracker: noopUsage, store: deps.store, pcRoom, composeFactory,
  });
  return { phone, guard, seen, composeRuns };
}

function startAndStop(r: ReturnType<typeof rig>, extra: Record<string, unknown> = {}): Record<string, unknown> | undefined {
  let ack: Record<string, unknown> | undefined;
  r.phone.fire('audio:start', { ...START, ...extra }, (x) => { ack = x as Record<string, unknown>; });
  r.phone.fire('audio:stop', {}, () => {});
  return ack;
}
const lastBridge = (): Record<string, unknown> => bridgeSpy.deps[bridgeSpy.deps.length - 1] ?? {};

beforeEach(() => { llmSpy.calls = 0; bridgeSpy.deps.length = 0; });

describe('EMB-15 - no language model for embedded rooms', () => {
  it('integrator room + HOST polish switch ON: no LLM config resolved, no llm valve asked, session armed with no polish', () => {
    const r = rig('integrator', { hostPolish: true });
    const ack = startAndStop(r);
    expect(ack?.ok).toBe(true);
    expect(r.seen[0]?.integratorRoom).toBe(true); // the handler stamped it from the ROOM ROW
    expect(llmSpy.calls).toBe(0);
    expect(r.guard.asked).toEqual(['stt']);
    expect(lastBridge()['polish']).toBeUndefined();
    // Truthful outcome: silent-off (no `polishUnavailable`), NOT `llm_error`.
    expect(lastBridge()['polishUnavailable']).toBeUndefined();
    expect(r.phone.received('stt:error')).toEqual([]);
  });

  it("integrator room + the VISITOR APP's own polish and refine prefs ON: still no LLM leg", () => {
    const r = rig('integrator'); // host has nothing switched on
    startAndStop(r, { prefs: { 'stt.polish': { enabled: true }, 'stt.refine': { enabled: true } } });
    expect(llmSpy.calls).toBe(0);
    expect(r.guard.asked).toEqual(['stt']);
    expect(lastBridge()['polish']).toBeUndefined();
    expect(lastBridge()['refine']).toBeUndefined();
    expect(lastBridge()['polishUnavailable']).toBeUndefined();
  });

  // NR-132 (2026-09-29) made an UNSET polish switch mean ON on every server.
  // These two pin that the embed gate is not a function of the default: nothing
  // set anywhere, and the room still gets no LLM leg — and, with no model, no
  // `not_configured` either (a stranger's page is not told about the host's model).
  it('NR-132: integrator room + NOTHING set (no host row, no visitor prefs) + a usable model: still no LLM leg', () => {
    const r = rig('integrator');
    startAndStop(r);
    expect(r.seen[0]?.integratorRoom).toBe(true);
    expect(llmSpy.calls).toBe(0);
    expect(r.guard.asked).toEqual(['stt']);
    expect(lastBridge()['polish']).toBeUndefined();
    expect(lastBridge()['polishUnavailable']).toBeUndefined();
  });

  it('NR-132: integrator room + NOTHING set + NO model: silent off, never not_configured', () => {
    const r = rig('integrator', { noModel: true });
    startAndStop(r);
    expect(llmSpy.calls).toBe(0);
    expect(lastBridge()['polish']).toBeUndefined();
    expect(lastBridge()['polishUnavailable']).toBeUndefined();
  });

  it('NR-132 POSITIVE CONTROL - a normal room with NOTHING set: polish armed (unset means ON); no model => not_configured', () => {
    const withModel = rig(null);
    startAndStop(withModel);
    expect(lastBridge()['polish']).toBeDefined();
    bridgeSpy.deps.length = 0;
    const noModel = rig(null, { noModel: true });
    startAndStop(noModel);
    expect(lastBridge()['polish']).toBeUndefined();
    expect(lastBridge()['polishUnavailable']).toBe('not_configured');
  });

  it('integrator room + HOST refine ON: no refine second pass', () => {
    const r = rig('integrator', { hostRefine: true });
    startAndStop(r);
    expect(llmSpy.calls).toBe(0);
    expect(lastBridge()['refine']).toBeUndefined();
  });

  it('POSITIVE CONTROL - a normal room with the same switches ON still polishes and refines', () => {
    const r = rig(null, { hostPolish: true, hostRefine: true });
    startAndStop(r);
    expect(r.seen[0]?.integratorRoom).toBeUndefined();
    expect(llmSpy.calls).toBeGreaterThanOrEqual(2); // one resolve for polish, one for refine
    expect(r.guard.asked).toEqual(['stt', 'llm', 'llm']);
    expect(lastBridge()['polish']).toBeDefined();
    expect(lastBridge()['refine']).toBeDefined();
  });

  it('POSITIVE CONTROL - the accounts OWN web room (room_kind "web") is not treated as embedded', () => {
    const r = rig('web', { hostPolish: true });
    startAndStop(r);
    expect(lastBridge()['polish']).toBeDefined();
  });

  it('compose:start in an integrator room is refused before any quota read or model call; a normal room runs', () => {
    const r = rig('integrator');
    r.phone.fire('compose:start', { task: 'organize', source_text: 'hello', request_id: 'req-1' }, () => {});
    const err = r.phone.received('compose:error')[0];
    expect(err?.code).toBe('WEB_EVENT_NOT_ALLOWED');
    expect(err?.request_id).toBe('req-1');
    expect(r.composeRuns).toEqual([]);
    expect(r.guard.asked).toEqual([]);

    const normal = rig(null);
    normal.phone.fire('compose:start', { task: 'organize', source_text: 'hello', request_id: 'req-2' }, () => {});
    expect(normal.phone.received('compose:error')).toEqual([]);
    expect(normal.composeRuns).toEqual([1]);
    expect(normal.guard.asked).toEqual(['llm']);
  });
});
