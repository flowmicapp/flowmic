// The phone-owned bundle rides the START frame (owner ruling 2026-09-03,
// follow-up: the carrier is `audio:start` / `compose:start`, not a settings
// push). This file pins the handler half: the bundle a frame carries is what
// the factory sees for THAT session, a frame without one clears the previous
// bundle, and a malformed bundle is refused at the wire before anything moves.
// The factory half (the overlay reaching every consumer) is
// session-overlay.test.ts + settings-effect-probe.test.ts probe 7.
//
// REVERSE CONTROL (executed 2026-09-03, this tree; restored byte-identical,
// sha256 compared):
//   audio.handler.ts — `setSessionPrefs(socket, parsed.data.prefs ?? null)`
//   changed to set only when present (`if (parsed.data.prefs) …`, i.e. a frame
//   without prefs KEEPS the previous bundle) → 1 red / 7 green:
//     FAIL  audio:start > REVERSE CONTROL: a second audio:start WITHOUT prefs on the same socket must NOT see the previous bundle
//       AssertionError: expected { 'scenario.card': { …(4) } } to be null
//   i.e. exactly the stale-bundle shape the ruling forbids, and only that case
//   sees it — the "verbatim" and "replace" cases stay green under the break,
//   which is why the absent-prefs case exists on its own. Restored; all green.

import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers, type AudioHandlerDeps } from '../src/socket/handlers/audio.handler';
import { registerComposeHandlers, type ComposeHandlerDeps } from '../src/socket/handlers/compose.handler';
import { getSessionPrefs } from '../src/socket/wire';
import type { SessionPrefs } from '../src/settings/session-overlay';
import type { QuotaGuard } from '../src/billing/quota-guard';
import type { UsageTracker } from '../src/billing/usage-tracker';
import type { ComposeOrchestrator } from '../src/engine/orchestrator';

class FakeSocket {
  data: Record<string, unknown> = {};
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
const stubOrchestrator = { pushChunk() {}, finish: async () => {}, dispose() {} };
const emptyCompose: ComposeOrchestrator = { async *run() { /* no deltas */ } };

const CARD = { professions: ['eye surgeon'], domains: [], packs: [], terms: [{ term: 'Kubernetes', aliases: ['k8s'] }] };
const AUDIO = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };
const COMPOSE = { task: 'organize', source_text: 'x' };

/** A mobile socket with the audio handler; the fake factory records what the
 *  overlay WOULD read — `getSessionPrefs(socket)` at the moment it is called. */
function wireAudio(): { mobile: FakeSocket; seen: (SessionPrefs | null)[] } {
  const seen: (SessionPrefs | null)[] = [];
  const mobile = new FakeSocket('m');
  mobile.data = { auth: { kind: 'mobile', userId: 'u1' }, roomUuid: 'room-1' };
  const deps: AudioHandlerDeps = {
    io: {} as unknown as import('socket.io').Server,
    guard: noopGuard,
    usageTracker: noopUsage,
    store: new RoomStore<FakeSocket>() as unknown as RoomStore<Socket>,
    sttFactory: () => { seen.push(getSessionPrefs(mobile as unknown as Socket)); return stubOrchestrator as never; },
  };
  registerAudioHandlers(mobile as unknown as Socket, deps);
  return { mobile, seen };
}

function wireCompose(): { mobile: FakeSocket; seen: (SessionPrefs | null)[] } {
  const seen: (SessionPrefs | null)[] = [];
  const mobile = new FakeSocket('m');
  mobile.data = { auth: { kind: 'mobile', userId: 'u1' }, roomUuid: 'room-1' };
  const deps: ComposeHandlerDeps = {
    io: {} as unknown as import('socket.io').Server,
    guard: noopGuard,
    usageTracker: noopUsage,
    store: new RoomStore<FakeSocket>() as unknown as RoomStore<Socket>,
    // bootstrap.ts closes the production factory over the socket the same way
    composeFactory: () => { seen.push(getSessionPrefs(mobile as unknown as Socket)); return emptyCompose; },
  };
  registerComposeHandlers(mobile as unknown as Socket, deps);
  return { mobile, seen };
}

const ackOf = (fire: (cb: (r: unknown) => void) => void): unknown => { let r: unknown; fire((x) => { r = x; }); return r; };
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('audio:start', () => {
  it('the bundle the frame carries is on the socket when the factory runs, verbatim', () => {
    const { mobile, seen } = wireAudio();
    const prefs = { 'scenario.card': CARD, 'stt.polish': { enabled: true, strength: 'smooth' } };
    const ack = ackOf((cb) => mobile.fire('audio:start', { ...AUDIO, prefs }, cb));
    expect(ack).toEqual({ ok: true });
    expect(seen).toEqual([prefs]);
  });

  it('REPLACE, not merge: a second frame with a different bundle leaves nothing of the first', () => {
    const { mobile, seen } = wireAudio();
    mobile.fire('audio:start', { ...AUDIO, prefs: { 'scenario.card': CARD, 'stt.polish': { enabled: true } } }, () => {});
    mobile.fire('audio:start', { ...AUDIO, prefs: { 'stt.refine': { enabled: true } } }, () => {});
    expect(seen[1]).toEqual({ 'stt.refine': { enabled: true } });
    expect(seen[1]).not.toHaveProperty('scenario.card');
  });

  it('REVERSE CONTROL: a second audio:start WITHOUT prefs on the same socket must NOT see the previous bundle', () => {
    const { mobile, seen } = wireAudio();
    mobile.fire('audio:start', { ...AUDIO, prefs: { 'scenario.card': CARD } }, () => {});
    mobile.fire('audio:start', AUDIO, () => {});
    // Positive control first: the first start DID see the card.
    expect(seen[0]).toEqual({ 'scenario.card': CARD });
    // Then the assertion: the second sees NOTHING, not the stale card.
    expect(seen[1]).toBeNull();
  });

  it('a frame with no prefs at all (old phone) leaves the factory reading the database (null bundle)', () => {
    const { mobile, seen } = wireAudio();
    mobile.fire('audio:start', AUDIO, () => {});
    expect(seen).toEqual([null]);
  });

  it('a malformed bundle is refused at the wire: no session starts, the factory is never called', () => {
    const { mobile, seen } = wireAudio();
    const ack = ackOf((cb) => mobile.fire('audio:start', { ...AUDIO, prefs: { 'stt.polish': { enabled: 'yes' } } }, cb));
    expect(ack).toMatchObject({ error: 'STT_CONFIG_MISSING' });
    expect(mobile.received('stt:error')).toHaveLength(1);
    expect(seen).toEqual([]);
  });
});

describe('compose:start', () => {
  it('the bundle the frame carries is on the socket when the factory runs', async () => {
    const { mobile, seen } = wireCompose();
    mobile.fire('compose:start', { ...COMPOSE, prefs: { 'scenario.card': CARD, 'scenario.inference': { granted: true, granted_for: 'local' } } });
    await settle();
    expect(seen).toEqual([{ 'scenario.card': CARD, 'scenario.inference': { granted: true, granted_for: 'local' } }]);
  });

  it('a compose:start without prefs clears a bundle an earlier turn carried', async () => {
    const { mobile, seen } = wireCompose();
    mobile.fire('compose:start', { ...COMPOSE, prefs: { 'scenario.card': CARD } });
    await settle();
    mobile.fire('compose:start', COMPOSE);
    await settle();
    expect(seen).toEqual([{ 'scenario.card': CARD }, null]);
  });

  it('a malformed bundle is refused at the wire with the payload code, and the factory never runs', async () => {
    const { mobile, seen } = wireCompose();
    mobile.fire('compose:start', { ...COMPOSE, prefs: { 'scenario.inference': { granted: true, granted_for: 'cloud' } } });
    await settle();
    expect(mobile.received('compose:error')[0]).toMatchObject({ code: 'LLM_INVALID_MODEL' });
    expect(seen).toEqual([]);
  });
});
