// WP-R4-6 contract reversal #1 (fail-loud), end-to-end at the audio:start seam:
// a present-but-malformed `stt.polish` value must surface as stt:error
// (SETTINGS_SCHEMA_INVALID) + a failed ack — NEVER a silent OFF (legacy behaviour)
// — driven through the REAL makeSttSessionFactory + registerAudioHandlers catch
// path (the same catch scenario.card fail-loud rides). A valid {enabled:false}
// proceeds normally (the engine build is what then decides, proven by golden).

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'socket.io';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { RoomStore } from '../src/room/store';
import { makeSttSessionFactory, resolvePolishDep } from '../src/engine/stt-factory';
import { registerAudioHandlers, type AudioHandlerDeps, type SttStartArgs } from '../src/socket/handlers/audio.handler';
import { seedDefaultSettings } from '../src/settings/defaults';
import { llmCapabilityFact, readSttPolish, STT_POLISH_DEFAULT } from '../src/stt/stt-polish-settings';
import { overlaySettings } from '../src/settings/session-overlay';
import { resolveLlmConfigWithSource } from '../src/compose/llm-config';
import { ServerError } from '../src/errors';
import type { QuotaGuard, QuotaKind } from '../src/billing/quota-guard';
import type { UsageTracker } from '../src/billing/usage-tracker';

const noopGuard: QuotaGuard = { ensureQuota() {}, remainingSttMs: () => Infinity, continuousCapMs: () => Infinity };
const noopUsage: UsageTracker = { recordSttUsage() {}, recordLlmUsage() {}, recordQuotaRefusal() {} };

/** A guard that records every kind it was asked about, and optionally refuses one
 *  of them the way makeQuotaGuard does (ServerError('QUOTA_EXCEEDED')). */
function recordingGuard(refuse?: QuotaKind): QuotaGuard & { asked: QuotaKind[] } {
  const asked: QuotaKind[] = [];
  return {
    asked,
    ensureQuota(_userId: string, kind: QuotaKind): void {
      asked.push(kind);
      if (kind === refuse) throw new ServerError('QUOTA_EXCEEDED', `${kind} quota exceeded (used 9/9)`);
    },
    remainingSttMs: () => Infinity,
    // card G-8 — no sitting-length ceiling in this fake (the standalone answer).
    continuousCapMs: () => Infinity,
  };
}

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = { auth: { kind: 'mobile', userId: 'u1' } };
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(event: string, payload?: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
  received(event: string): Array<Record<string, unknown>> { return this.emitted.filter((e) => e.event === event).map((e) => e.payload as Record<string, unknown>); }
}

function freshDb(): DbConnection {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('polish-audio-start-secret') });
  db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
  seedDefaultSettings(db.settings, 'u1'); // stt.routings, so the ONLY thing that can throw is stt.polish
  // 🔴 OSS-DEFAULTS (0.3.0): seeding no longer writes an `llm.config` — a stock
  // install has no LLM configured (defaults.ts LLM_NOT_CONFIGURED). This file is
  // about the llm_tokens VALVE, not about what ships as the default, so it now
  // states its own LLM row instead of borrowing whatever the seeder happened to
  // write. That is the stronger arrangement anyway: the previous version would
  // have gone green or red for a reason living in another file.
  db.settings.write('u1', 'llm.config', {
    protocol: 'openai-compatible', endpoint: 'http://x/v1', api_key: 'EMPTY', model: 'm',
  });
  return db;
}

function wire(db: DbConnection, guard: QuotaGuard = noopGuard): FakeSocket {
  const store = new RoomStore<FakeSocket>();
  const mobile = new FakeSocket('mobile-sock');
  const factory = makeSttSessionFactory({ settings: db.settings, mode: 'standalone', store: store as unknown as RoomStore<Socket>, quota: guard });
  const deps: AudioHandlerDeps = {
    io: {} as unknown as import('socket.io').Server,
    guard,
    usageTracker: noopUsage,
    store: store as unknown as RoomStore<Socket>,
    sttFactory: (args: SttStartArgs) => factory(mobile as unknown as Socket, args),
  };
  registerAudioHandlers(mobile as unknown as Socket, deps);
  return mobile;
}

const START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };

describe('WP-R4-6 stt.polish fail-loud at audio:start', () => {
  it('present-but-malformed stt.polish → stt:error(SETTINGS_SCHEMA_INVALID) + failed ack (NOT silent OFF)', () => {
    const db = freshDb();
    db.settings.write('u1', 'stt.polish', true); // legacy would silently treat as OFF; new line fails loud
    const mobile = wire(db);
    let ack: Record<string, unknown> | undefined;
    mobile.fire('audio:start', START, (r) => { ack = r as Record<string, unknown>; });
    const err = mobile.received('stt:error')[0];
    expect(err?.code).toBe('SETTINGS_SCHEMA_INVALID');
    expect(ack?.error).toBe('SETTINGS_SCHEMA_INVALID');
  });

  it('a valid {enabled:false} does NOT trip the snapshot (audio:start proceeds, no SETTINGS_SCHEMA_INVALID)', () => {
    const db = freshDb();
    db.settings.write('u1', 'stt.polish', { enabled: false });
    const mobile = wire(db);
    let ack: Record<string, unknown> | undefined;
    mobile.fire('audio:start', START, (r) => { ack = r as Record<string, unknown>; });
    // With routings seeded, the build succeeds → ack ok:true; the point is the
    // snapshot did NOT raise SETTINGS_SCHEMA_INVALID for a well-formed value.
    expect(mobile.received('stt:error').map((e) => e.code)).not.toContain('SETTINGS_SCHEMA_INVALID');
    expect(ack?.ok).toBe(true);
    mobile.fire('audio:stop', {}, () => {});
  });
});

// ── M6: the llm_tokens VALVE covers the polish path ──────────────────────────
//
// Card M6 (0.3.0). The polish LLM ran with no quota check of any kind: a user could
// spend platform LLM tokens for as long as they could keep talking, and the
// llm_tokens ceiling only ever looked at compose:start. The ceiling is RUNAWAY
// PROTECTION — ~30-40x what the tier's minutes can physically produce
// (docs/strategy/2026-08-02-b12-plan-minute-quota-resizing-options.md) — not a
// product gate, so the response to an exhausted valve is 「no polish for this
// session」, never 「the recording fails」.

describe('M6 — the llm_tokens valve gates the polish pass (and never the recording)', () => {
  const PLAIN_LLM = { protocol: 'openai-compatible', endpoint: 'http://x/v1', api_key: 'EMPTY', model: 'm' } as const;

  it('polish ON ⇒ audio:start really consults the llm valve (anti-façade: the call happens)', () => {
    const db = freshDb();
    db.settings.write('u1', 'stt.polish', { enabled: true });
    const guard = recordingGuard();
    const mobile = wire(db, guard);
    mobile.fire('audio:start', START, () => {});
    // 'stt' is the audio handler's own admission gate; 'llm' is the M6 valve. A
    // list assertion, not a `toContain`, so a duplicate would also fail.
    expect(guard.asked).toEqual(['stt', 'llm']);
    mobile.fire('audio:stop', {}, () => {});
  });

  it('polish OFF ⇒ the llm valve is NOT consulted (positive control for the line above)', () => {
    // Without this pair, an implementation that asked for 'llm' unconditionally
    // would pass the test above while charging the valve for sessions that spend
    // no LLM tokens at all.
    const db = freshDb();
    db.settings.write('u1', 'stt.polish', { enabled: false });
    const guard = recordingGuard();
    const mobile = wire(db, guard);
    mobile.fire('audio:start', START, () => {});
    expect(guard.asked).toEqual(['stt']);
    mobile.fire('audio:stop', {}, () => {});
  });

  it('an EXHAUSTED llm valve disables polish but the recording still starts', () => {
    // 🔴 The failure direction that matters: a runaway-protection valve that fails
    // the utterance would turn a billing ceiling into 「your microphone is broken」.
    const db = freshDb();
    db.settings.write('u1', 'stt.polish', { enabled: true });
    const mobile = wire(db, recordingGuard('llm'));
    let ack: Record<string, unknown> | undefined;
    mobile.fire('audio:start', START, (r) => { ack = r as Record<string, unknown>; });
    expect(ack?.ok).toBe(true);
    expect(mobile.received('stt:error')).toEqual([]);
    mobile.fire('audio:stop', {}, () => {});
  });

  // The unit-level contract of the seam the three wiring tests above drive.
  // RT-1 changed the return from `dep | undefined` to PolishArming, because
  // `undefined` was answering two questions (「not asked for」 vs 「asked for and
  // unavailable」) and only the second one may reach the user's screen.
  it('resolvePolishDep: exhausted valve ⇒ unarmed WITH a reason; open valve ⇒ armed, with provenance', () => {
    const db = freshDb();
    db.settings.write('u1', 'stt.polish', { enabled: true });
    db.settings.write('u1', 'llm.config', PLAIN_LLM);

    const closed = resolvePolishDep({ settings: db.settings, quota: recordingGuard('llm') }, 'u1', ['FlowMic']);
    expect(closed.armed).toBe(false);
    // 🔴 RT-1: the valve closing is 「you turned polish on and it did not run」 — the user is told
    // (polish:'skipped' → PolishSkippedMark), not left to guess.
    expect(closed.armed === false && closed.unavailable).toBe('llm_error');

    const open = resolvePolishDep({ settings: db.settings, quota: recordingGuard() }, 'u1', ['FlowMic']);
    expect(open.armed).toBe(true);
    if (!open.armed) throw new Error('unreachable: asserted armed above');
    expect(open.llm.source).toBe('user'); // M4: the dep carries 「who supplied it」
    expect(open.llm.cfg).toEqual(PLAIN_LLM);
    expect(open.deps.protectedTerms).toEqual(['FlowMic']);
  });

  it('resolvePolishDep RETHROWS anything that is not QUOTA_EXCEEDED (no silent swallow)', () => {
    // Catching broadly here would turn a broken billing layer into 「polish is off
    // today」 — a silent failure, and one nobody would ever report. Both arms
    // matter: a DIFFERENT ServerError code must not be absorbed by the
    // `instanceof ServerError` half of the guard, and a bare Error (a bug in the
    // usage repo, say) must not be absorbed at all.
    const db = freshDb();
    db.settings.write('u1', 'stt.polish', { enabled: true });
    const wrongCode: QuotaGuard = {
      ensureQuota(): void { throw new ServerError('SETTINGS_SCHEMA_INVALID', 'not the valve'); },
      remainingSttMs: () => Infinity,
      // card G-8 — no sitting-length ceiling in this fake (the standalone answer).
      continuousCapMs: () => Infinity,
    };
    expect(() => resolvePolishDep({ settings: db.settings, quota: wrongCode }, 'u1', [])).toThrow(ServerError);
    const bug: QuotaGuard = {
      ensureQuota(): void { throw new TypeError('usage repo is undefined'); },
      remainingSttMs: () => Infinity,
      // card G-8 — no sitting-length ceiling in this fake (the standalone answer).
      continuousCapMs: () => Infinity,
    };
    expect(() => resolvePolishDep({ settings: db.settings, quota: bug }, 'u1', [])).toThrow(TypeError);
  });
});

// ── RT-1a: an unusable LLM degrades to a bare final, it never refuses the
//    recording ────────────────────────────────────────────────────────────────
//
// Card RT-1a (0.3.0 seventh task book), the mandatory precondition of RT-1. polish
// ON + an unresolvable `llm.config` used to THROW out of resolvePolishDep, up
// through makeSttSessionFactory, into audio.handler's audio:start catch ⇒
// stt:error + failed ack ⇒ the microphone never opens at all. Latent while stt.polish defaults OFF;
// RT-1 turns it ON for everyone, and then every account without a usable LLM
// loses the ability to record at all.
//
// owner's red line: 「correction is an enhancement; any failed link must degrade to the status quo; never let 『correction did not run
// ⇒ the user saw nothing』 happen」. A refused audio:start IS 「the user saw nothing」.
//
// 🔴 REVERSE CONTROL, ACTUALLY RUN (2026-08-07, dev-pc-a). With the
// try/catch around resolveLlmConfigWithSource deleted (the pre-RT-1a line
// restored verbatim) this file went 3 failed | 11 passed, exit code 1:
//
//   FAIL … > 🔴 the recording still starts: ack ok:true, no stt:error (RED LINE)
//   AssertionError: expected undefined to be true // Object.is equality
//   - Expected: true
//   + Received: undefined          ← the ack was {error:'LLM_INVALID_MODEL'}
//
//   FAIL … > resolvePolishDep returns undefined … — absent row
//   ServerError: llm.config is not configured
//    ❯ resolveLlmConfigWithSource src/compose/llm-config.ts (resolveLlmConfigWithSource)
//    ❯ resolvePolishDep src/engine/stt-factory.ts (resolvePolishDep)
//      ⚠️ RT-1 refreshed that one LINE NUMBER (was :273) because the coordinate
//      lint walks it and a pointer that no longer points is worse than none —
      //      「those coordinates are there to be walked」. The MEASUREMENT above is untouched: same run, same
//      counts, same assertion text. (The test it names was also renamed by RT-1
//      to 「…returns UNARMED…」; the transcript keeps the name it had that day.)
//      ⚠️ fix-025 refreshed it AGAIN (:296 → :345, +49) for the same reason and
//      by the same rule: that card added lines above `resolvePolishDep` in
//      stt-factory.ts, so it owed this pointer. TWO refreshes of one number in
//      two windows is IT-50's own argument arriving on schedule — the number is
//      not the fact here, the stack SHAPE is. 🔴 Third move (stt.error forensic
//      log above makeSttEmitter, 2026-08-12): dropped the `:NNN` per the rule
//      this comment already wrote for itself — symbol anchor only. NR-129 did the
//      same for the llm-config.ts frame above (was :216:29) when it added lines there.
//
//   FAIL … > …and for a present-but-MALFORMED llm.config too
//   ServerError: llm.config.protocol must be one of openai-compatible|anthropic
//    ❯ validate src/compose/llm-config.ts:77:11
//
// The other 11 stayed green, which is the point of the last three cases in this
// block: they pin what the degrade must NOT have changed.
//
// ⚠️ Recorded because it was measured, and the measurement corrected the guess:
// this comment first predicted `expected 'LLM_INVALID_MODEL' to be true`. The ack
// object has no `ok` key at all on that path, so the real reading is `undefined`.
// A plausible-looking predicted output is exactly the substitution the task book §1-bis-10
// warns about — 「the test exists」 standing in for 「the measurement happened」.
describe('RT-1a — polish ON with no usable LLM degrades to a bare final (never refuses audio:start)', () => {
  const WORKING_LLM = { protocol: 'openai-compatible', endpoint: 'http://x/v1', api_key: 'EMPTY', model: 'm' } as const;

  /** A db whose `llm.config` row is GONE — the shape resolveLlmConfigWithSource
   *  throws LLM_INVALID_MODEL on when no managed default is configured (the env
   *  gate FLOWMIC_MANAGED_LLM_ENABLED is off in tests, asserted below). */
  function dbWithPolishOnAndNoLlm(): DbConnection {
    const db = freshDb();
    db.settings.write('u1', 'stt.polish', { enabled: true });
    db.settings.remove('u1', 'llm.config');
    return db;
  }

  it('the precondition really holds: this fixture makes the resolver throw', () => {
    // Positive control for every assertion below. Without it, a fixture that
    // quietly still had a usable llm.config would make the whole block pass while
    // testing nothing — the degrade path would never be entered.
    expect(process.env.FLOWMIC_MANAGED_LLM_ENABLED).toBeUndefined();
    const db = dbWithPolishOnAndNoLlm();
    expect(() => resolveLlmConfigWithSource(db.settings, 'u1')).toThrow(ServerError);
  });

  it('🔴 the recording still starts: ack ok:true, no stt:error (RED LINE)', () => {
    const mobile = wire(dbWithPolishOnAndNoLlm());
    let ack: Record<string, unknown> | undefined;
    mobile.fire('audio:start', START, (r) => { ack = r as Record<string, unknown>; });
    expect(ack?.ok).toBe(true);
    // Asserted on the FRAMES, not on one code: an implementation that acked ok
    // while still emitting stt:error would be caught here too.
    expect(mobile.received('stt:error')).toEqual([]);
    mobile.fire('audio:stop', {}, () => {});
  });

  it('resolvePolishDep returns UNARMED (no polish dep) instead of throwing — absent row', () => {
    const db = dbWithPolishOnAndNoLlm();
    const a = resolvePolishDep({ settings: db.settings, quota: noopGuard }, 'u1', []);
    expect(a.armed).toBe(false);
    // 🔴 RT-1 closes the account RT-1a registered: the degrade is no longer
    // silent to the user. The reason rides `polish:'skipped'` on stt:final.
    // NR-123: NOTHING configured is its own reason, not `llm_error` — the phone
    // tells the user to set a model up instead of calling polish broken. The
    // one-value-one-question control is the MALFORMED case right below, which
    // must stay `llm_error`.
    expect(a.armed === false && a.unavailable).toBe('not_configured');
  });

  it("NR-123: the desktop's own unconfigured face (empty endpoint + model) is not_configured too", () => {
    // settings-model.ts LLM_UNCONFIGURED is `{protocol, endpoint:'', api_key:'', model:''}`
    // and pushLlm() writes exactly that shape, so a user who opened the model page
    // and left it blank has not configured anything — not a broken model.
    const db = freshDb();
    db.settings.write('u1', 'stt.polish', { enabled: true });
    db.settings.write('u1', 'llm.config', { protocol: 'openai-compatible', endpoint: '', api_key: '', model: '' });
    const a = resolvePolishDep({ settings: db.settings, quota: noopGuard }, 'u1', []);
    expect(a.armed === false && a.unavailable).toBe('not_configured');
  });

  describe('NR-129 — a cloud vendor picked with no key is not configured', () => {
    function armingFor(cfg: Record<string, unknown>): ReturnType<typeof resolvePolishDep> {
      const db = freshDb();
      db.settings.write('u1', 'stt.polish', { enabled: true });
      db.settings.write('u1', 'llm.config', cfg);
      return resolvePolishDep({ settings: db.settings, quota: noopGuard }, 'u1', []);
    }
    function usableFor(cfg: Record<string, unknown>): boolean {
      const db = freshDb();
      db.settings.write('u1', 'llm.config', cfg);
      return llmCapabilityFact(db.settings, 'u1').usable;
    }
    // The 0.3.100 VM row, verbatim in shape: the desktop's "OpenAI" preset pushed
    // inline with the key never filled in (diag-0100 failure 1).
    const OPENAI_NO_KEY = { protocol: 'openai-compatible', endpoint: 'https://api.openai.com/v1', api_key: '', model: 'gpt-4o' };

    it.each([
      ['OpenAI, empty key (the VM row)', OPENAI_NO_KEY],
      ['OpenAI, whitespace key', { ...OPENAI_NO_KEY, api_key: '   ' }],
      ['OpenAI, the EMPTY sentinel', { ...OPENAI_NO_KEY, api_key: 'EMPTY' }],
      ['Anthropic, no key field at all', { protocol: 'anthropic', endpoint: 'https://api.anthropic.com', model: 'claude' }],
      ['DeepSeek, hand-typed with a trailing slash', { protocol: 'openai-compatible', endpoint: 'https://API.deepseek.com/v1/', api_key: '', model: 'deepseek-chat' }],
      ['OpenRouter by preset_id', { preset_id: 'cloud-openrouter' }],
    ])('%s ⇒ not_configured, and capability.llm.usable is false', (_label, cfg) => {
      const a = armingFor(cfg);
      expect(a.armed === false && a.unavailable).toBe('not_configured');
      expect(usableFor(cfg)).toBe(false);
    });

    it.each([
      ['a LAN vLLM with an empty key', { protocol: 'openai-compatible', endpoint: 'http://192.168.1.20:8000/v1', api_key: '', model: 'qwen' }],
      ['local Ollama by preset_id (no key by design)', { preset_id: 'lan-ollama-gemma3' }],
      ['the vLLM seed shape (EMPTY sentinel on localhost)', { protocol: 'openai-compatible', endpoint: 'http://localhost:8000/v1', api_key: 'EMPTY', model: 'm' }],
      ['OpenAI WITH a key', { ...OPENAI_NO_KEY, api_key: 'sk-test-not-real' }],
    ])('POSITIVE CONTROL: %s stays configured (armed, usable)', (_label, cfg) => {
      expect(armingFor(cfg).armed).toBe(true);
      expect(usableFor(cfg)).toBe(true);
    });
  });

  it('...and for a present-but-MALFORMED llm.config too (same degrade, different cause)', () => {
    // The other arm of the resolver's fail-loud: the row exists but validate()
    // rejects it. Both arms must reach the user as 「no polish」, never as 「no mic」.
    const db = freshDb();
    db.settings.write('u1', 'stt.polish', { enabled: true });
    db.settings.write('u1', 'llm.config', { protocol: 'not-a-protocol', endpoint: 'http://x', model: 'm' });
    const malformed = resolvePolishDep({ settings: db.settings, quota: noopGuard }, 'u1', []);
    expect(malformed.armed).toBe(false);
    expect(malformed.armed === false && malformed.unavailable).toBe('llm_error');

    const mobile = wire(db);
    let ack: Record<string, unknown> | undefined;
    mobile.fire('audio:start', START, (r) => { ack = r as Record<string, unknown>; });
    expect(ack?.ok).toBe(true);
    mobile.fire('audio:stop', {}, () => {});
  });

  it('POSITIVE DIRECTION: polish ON with a WORKING llm.config still polishes', () => {
    // 🔴 Without this, "return undefined on any trouble" and "return undefined
    // always" are indistinguishable — the degrade could have silently switched the
    // feature off for everybody and every other test in this block would be green.
    const db = freshDb();
    db.settings.write('u1', 'stt.polish', { enabled: true });
    db.settings.write('u1', 'llm.config', WORKING_LLM);
    const dep = resolvePolishDep({ settings: db.settings, quota: noopGuard }, 'u1', ['FlowMic']);
    expect(dep.armed).toBe(true);
    if (!dep.armed) throw new Error('unreachable: asserted armed above');
    expect(dep.llm.cfg).toEqual(WORKING_LLM);
    expect(dep.llm.source).toBe('user');
    expect(dep.deps.protectedTerms).toEqual(['FlowMic']);
  });

  // 🔴 RT-1 — the OTHER half of 「no silent failure」, and it is not a nicety: the desktop
  // renders `polish_hint` (apps/desktop/src/lib/strings/settings.ts, printed by
  // SttSettings.vue) which promises in FOUR languages 「on failure, deliver the unpolished text and tell the user honestly, never a silent fallback」/「…with an explicit notice — never a silent fallback」. RT-1a
  // (426ccc0) created a failure case that promise does not cover: the degraded
  // session's stt:final was byte-identical to 「polish was never on」.
  //
  // The property the string actually promises is DISTINGUISHABILITY, so that is
  // what is asserted — not the presence of one field, which a future refactor
  // could keep while making both cases carry it.
  it('🔴 a degraded session is DISTINGUISHABLE on the wire from a polish-OFF session', () => {
    const off = freshDb();
    off.settings.write('u1', 'stt.polish', { enabled: false });
    const offArming = resolvePolishDep({ settings: off.settings, quota: noopGuard }, 'u1', []);

    const degraded = resolvePolishDep({ settings: dbWithPolishOnAndNoLlm().settings, quota: noopGuard }, 'u1', []);

    // Both are unarmed — that much is genuinely the same …
    expect(offArming.armed).toBe(false);
    expect(degraded.armed).toBe(false);
    // … and what the wire says about them must NOT be.
    const wireOf = (a: typeof offArming): unknown => (a.armed === false ? a.unavailable : 'ARMED');
    expect(wireOf(degraded)).not.toEqual(wireOf(offArming));
    expect(wireOf(offArming)).toBeUndefined();     // nothing was asked for ⇒ nothing is said
    // The reason must stay inside the phone's known set (`kSttPolishReasons` in
    // apps/mobile/lib/src/stt/stt_stream.dart; NR-123 added not_configured there) —
    // a value the phone does not know parses to null, the same defect one layer along.
    expect(['timeout', 'llm_error', 'empty_output', 'guard_reject', 'not_configured']).toContain(wireOf(degraded));
  });

  it('the degrade did NOT widen: a malformed stt.polish row still fails loud', () => {
    // 🔴 The throw RT-1a converts is the LLM one only. `stt.polish` being corrupt
    // answers a different question (「your settings row is broken」 — user-fixable, and silently
    // treating it as OFF is the legacy behaviour WP-R4-6 deliberately reversed).
    // A `catch` placed one line too high would swallow this, and nothing else in
    // this file's RT-1a block would notice.
    const db = freshDb();
    db.settings.write('u1', 'stt.polish', true);
    db.settings.remove('u1', 'llm.config');
    expect(() => resolvePolishDep({ settings: db.settings, quota: noopGuard }, 'u1', []))
      .toThrow(/stt\.polish failed schema validation/);
  });

  it('the QUOTA_EXCEEDED path is untouched: exhausted valve ⇒ undefined, other throws ⇒ rethrow', () => {
    // Pins that the new catch did not absorb the valve's narrow contract. The
    // asymmetry is deliberate and costs nothing: audio.handler already calls
    // ensureQuota(userId,'stt') before the factory and fails audio:start on ANY
    // throw, so a guard broken enough to throw a TypeError has already refused
    // the recording one layer up.
    const db = freshDb();
    db.settings.write('u1', 'stt.polish', { enabled: true });
    db.settings.write('u1', 'llm.config', WORKING_LLM);
    expect(resolvePolishDep({ settings: db.settings, quota: recordingGuard('llm') }, 'u1', []).armed).toBe(false);
    const bug: QuotaGuard = {
      ensureQuota(): void { throw new TypeError('usage repo is undefined'); },
      remainingSttMs: () => Infinity,
      // card G-8 — no sitting-length ceiling in this fake (the standalone answer).
      continuousCapMs: () => Infinity,
    };
    expect(() => resolvePolishDep({ settings: db.settings, quota: bug }, 'u1', [])).toThrow(TypeError);
  });
});

// ── NR-132 — an UNSET polish switch means ON, on every server ───────────────
//
// 0.3.101 device test T2 (dispatch report 2026-09-29-test-0-3-101, outside the repo):
// LAN, no usable model, the phone's 「AI 润色」 switch reads ON (never touched), and
// the rows carried no NR-123 badge and no hint. The phone rendered its untouched
// switch as ON and sent nothing; this server, holding no row, defaulted to OFF
// because no model resolved (POLISH-CFG); resolvePolishDep returned a SILENT
// `{armed:false}` and `not_configured` was never emitted. One switch, two answers.
// MAIN's NR-132 decision: the phone's displayed value is the truth, so an unset
// switch is ON here too (stt-polish-settings.ts `STT_POLISH_DEFAULT`).
//
// ⚠️ HISTORY. This block used to be 「OSS-DEFAULTS — a stock install polishes
// nothing and says nothing about it」 and asserted the exact silence T2 measured.
// Its premise — 「an optional feature nobody configured is not an error」 — held
// while the only switch was the desktop's and rendered the server's value; it
// stopped holding when the switch moved to the phone (2026-09-03) and started
// rendering ON regardless. The composition argument it made (no test built the
// stock state: no `stt.polish` row AND no `llm.config`) still stands, so the same
// stock fixture is kept and its expected answer is inverted.
//
// Each case goes through the production composition — the audio handler's
// overlay (settings/session-overlay.ts `overlaySettings`) over the database —
// because that is where 「the phone sent nothing」 and 「the phone sent OFF」 are
// told apart.
//
// REVERSE CONTROLS (executed 2026-09-29, on this tree; each restored from a byte
// copy, marker `REVERSE-CONTROL-NR132` grep = 0, same command green again):
//   1. stt-polish-settings.ts readSttPolish absent branch put back on the model
//      (`llmCapabilityFact(repo, userId).usable ? STT_POLISH_DEFAULT : { enabled: false }`)
//      ⇒ `vitest run test/stt-polish-audio-start.test.ts test/emb15-integrator-no-llm.test.ts`:
//      3 red — both 「unset + no model ⇒ not_configured」 cases here
//      (expected undefined to be 'not_configured') and the EMB-15 normal-room
//      NR-132 positive control.
//   2. stt-factory.ts resolvePolishDep `if (!polishSetting.enabled && false)`
//      (explicit OFF ignored) ⇒ `vitest run test/stt-polish-audio-start.test.ts`:
//      3 red — this block's explicit-OFF positive control
//      (expected 'not_configured' to be undefined), M6 「polish OFF ⇒ valve not
//      consulted」, RT-1a 「degraded is distinguishable from OFF」.
describe('NR-132 — unset polish is ON: stock install ⇒ not_configured, model ⇒ armed, explicit OFF ⇒ silent', () => {
  /** A stranger's first boot / a LAN PC with no model: the real seeder and NOTHING
   *  else written. No `llm.config` (defaults.ts seeds LLM_NOT_CONFIGURED), no
   *  `stt.polish` row. Deliberately NOT freshDb(), which writes a working model. */
  function stockDb(): DbConnection {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('polish-stock-install-secret') });
    db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
    seedDefaultSettings(db.settings, 'u1');
    return db;
  }
  const arm = (repo: import('../src/db/repos/settings.repo').SettingsRepo): ReturnType<typeof resolvePolishDep> =>
    resolvePolishDep({ settings: repo, quota: noopGuard }, 'u1', []);
  const reasonOf = (a: ReturnType<typeof resolvePolishDep>): unknown => (a.armed ? 'ARMED' : a.unavailable);

  it('the precondition really holds: a stock seed writes neither llm.config nor stt.polish, and no model resolves', () => {
    // Positive control for everything below: a seeder that started writing an
    // llm.config again, or a leaked managed-LLM env, would turn this block into a
    // test of the opposite situation.
    expect(process.env.FLOWMIC_MANAGED_LLM_ENABLED).toBeUndefined();
    expect(process.env.FLOWMIC_DEFAULT_LLM_PRESET).toBeUndefined();
    const db = stockDb();
    expect(db.settings.read('u1', 'llm.config')).toBeNull();
    expect(db.settings.read('u1', 'stt.polish')).toBeNull();
    expect(() => resolveLlmConfigWithSource(db.settings, 'u1')).toThrow(ServerError);
  });

  it('🔴 unset + no model (an old phone: no prefs bundle at all) ⇒ not_configured — the T2 case', () => {
    const db = stockDb();
    expect(readSttPolish(db.settings, 'u1')).toEqual(STT_POLISH_DEFAULT);
    expect(STT_POLISH_DEFAULT.enabled).toBe(true);
    // prefs === null is how the handler encodes 「this request carried no bundle」.
    expect(reasonOf(arm(overlaySettings(db.settings, null)))).toBe('not_configured');
  });

  it('🔴 unset + no model (a bundle that carries other keys but not stt.polish) ⇒ not_configured', () => {
    const db = stockDb();
    expect(reasonOf(arm(overlaySettings(db.settings, { 'stt.refine': { enabled: false } })))).toBe('not_configured');
  });

  it('a new phone carrying its default {enabled:true, strength:strict} + no model ⇒ not_configured (same answer)', () => {
    const db = stockDb();
    expect(reasonOf(arm(overlaySettings(db.settings, { 'stt.polish': { enabled: true, strength: 'strict' } }))))
      .toBe('not_configured');
  });

  it('🔴 unset + a usable model ⇒ polish is ATTEMPTED (armed, with the default strength)', () => {
    const db = freshDb(); // freshDb writes a working llm.config and no stt.polish row
    expect(db.settings.read('u1', 'stt.polish')).toBeNull();
    const a = arm(overlaySettings(db.settings, null));
    expect(a.armed).toBe(true);
    expect(a.armed && a.deps.strength).toBe('strict');
  });

  it('🔴 POSITIVE CONTROL: an explicit OFF still means off — no polish, and NO reason (no badge, no hint)', () => {
    // From the phone bundle (the post-09-03 carrier) …
    expect(reasonOf(arm(overlaySettings(stockDb().settings, { 'stt.polish': { enabled: false, strength: 'strict' } }))))
      .toBeUndefined();
    // … from a legacy stored row read by an old phone (prefs === null, D11) …
    const legacy = stockDb();
    legacy.settings.write('u1', 'stt.polish', { enabled: false });
    expect(reasonOf(arm(overlaySettings(legacy.settings, null)))).toBeUndefined();
    // … and with a usable model too: OFF is a choice, not a missing model.
    expect(reasonOf(arm(overlaySettings(freshDb().settings, { 'stt.polish': { enabled: false } })))).toBeUndefined();
  });

  it('the recording still starts on a stock install and nothing is emitted on stt:error (end to end)', () => {
    const mobile = wire(stockDb());
    let ack: Record<string, unknown> | undefined;
    mobile.fire('audio:start', START, (r) => { ack = r as Record<string, unknown>; });
    expect(ack?.ok).toBe(true);
    // Asserted on the FRAMES: the degrade is a mark on the final, never a refusal.
    expect(mobile.received('stt:error')).toEqual([]);
    mobile.fire('audio:stop', {}, () => {});
  });
});

// ── RT-1 — the LLM config is resolved EXACTLY ONCE, at build time ────────────
//
// The detached polish closes over a `SelectedLlmConfig` that carries its
// PROVENANCE, and `resolveByokLlm` reads that provenance to decide whether the
// tokens are billed to us or waived to the user's own key (M4). A refactor that
// re-derived the config anywhere downstream — inside a retry, inside the
// detached closure, 「to get a fresh one」 — would drop `source` and misattribute
// the payer, with nothing going red.
//
// Two instruments, because they fail on different mistakes:
//   · the census catches a SECOND call site appearing (the actual hazard);
//   · the runtime count catches the same site being called twice per session.
describe('RT-1 — resolveLlmConfigWithSource is called once per session, from one place', () => {
  const SRC = fileURLToPath(new URL('../src', import.meta.url));
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const abs = join(dir, name);
      return statSync(abs).isDirectory() ? walk(abs) : abs.endsWith('.ts') ? [abs] : [];
    });
  }
  /** Files that CALL it — its own definition module is excluded by name. */
  function callSites(): string[] {
    return walk(SRC)
      .filter((f) => !f.endsWith(join('compose', 'llm-config.ts')))
      .filter((f) => {
        // Strip line comments: this repo names its seams in prose constantly.
        const code = readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
        return /resolveLlmConfigWithSource\s*\(/.test(code);
      })
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'))
      .sort();
  }

  it('a census: exactly the compose turn, the polish snapshot, and the capability.llm fact resolve it', () => {
    // 🔴 POLISH-CFG (2026-08-09) added the third entry deliberately, and this
    // census going red is the mechanism working, not noise: a new consumer of the
    // resolver is the actual hazard this case was built to surface, so it must be
    // re-declared by a human rather than pattern-matched away.
    //
    // WHY THE THIRD SITE IS SAFE where a fourth might not be. The hazard named
    // above is DROPPING `source` and misattributing who pays. This call site
    // discards the resolved config entirely — it only asks 「did it resolve at
    // all」 (since NR-132 for `capability.llm` only; it used to decide the polish
    // default too, stt-polish-settings.ts `llmCapabilityFact`) — so there is no `source` for it to lose and no
    // billing judgement anywhere near it. It also runs on the settings read path,
    // not inside a session, so it cannot double-charge a turn.
    expect(callSites()).toEqual([
      'compose/index.ts',
      'engine/stt-factory.ts',
      'stt/stt-polish-settings.ts',
    ]);
  });

  it('the census can actually fail (it is not matching nothing)', () => {
    expect(callSites().length).toBeGreaterThan(0);
  });

  it('one audio:start reads llm.config exactly ONCE (not once per final, not per retry)', () => {
    const db = freshDb();
    db.settings.write('u1', 'stt.polish', { enabled: true });
    let llmReads = 0;
    const counting = new Proxy(db.settings, {
      get(target, prop, recv): unknown {
        if (prop !== 'read') return Reflect.get(target, prop, recv) as unknown;
        return (userId: string, key: string): unknown => {
          if (key === 'llm.config') llmReads += 1;
          return target.read(userId, key);
        };
      },
    });
    const store = new RoomStore<FakeSocket>();
    const mobile = new FakeSocket('mobile-sock');
    const factory = makeSttSessionFactory({ settings: counting, mode: 'standalone', store: store as unknown as RoomStore<Socket>, quota: noopGuard });
    registerAudioHandlers(mobile as unknown as Socket, {
      io: {} as unknown as import('socket.io').Server,
      guard: noopGuard,
      usageTracker: noopUsage,
      store: store as unknown as RoomStore<Socket>,
      sttFactory: (args: SttStartArgs) => factory(mobile as unknown as Socket, args),
    });
    let ack: Record<string, unknown> | undefined;
    mobile.fire('audio:start', START, (r) => { ack = r as Record<string, unknown>; });
    // Positive control: the session really was built, so `1` is not 「nothing ran」.
    expect(ack?.ok).toBe(true);
    expect(llmReads).toBe(1);
    mobile.fire('audio:stop', {}, () => {});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-08-28 — the polish pass had no language, and the hop above it had one.
//
// `stt-session.ts` receives the engine's reported language and `polishFinalText`
// took no language at all, so a user reporting "I dictated German and got English
// back" left a log that could not say what the session believed it was hearing.
// The field is DIAGNOSTIC ONLY: it reaches the trace and the skip warnings and
// nothing else -- not the prompt, not the guard, not the cache key.
//
// 🔴 THE SECOND TEST IS THE ANTI-FACADE ONE. A dep nobody fills is this repo's
// #1 historical bug class, and it is invisible to any test that constructs
// PolishDeps by hand. Refs docs/archive/strategy/2026-08-28-multilingual-chain-audit.md
// §2 hop 7.
// ─────────────────────────────────────────────────────────────────────────────
describe('polish diagnostics carry the session language', () => {
  const PLAIN_LLM = { protocol: 'openai-compatible', endpoint: 'http://x/v1', api_key: 'EMPTY', model: 'm' } as const;

  it('resolvePolishDep puts the spoken language on the dep', () => {
    const db = freshDb();
    db.settings.write('u1', 'stt.polish', { enabled: true });
    db.settings.write('u1', 'llm.config', PLAIN_LLM);

    const armed = resolvePolishDep({ settings: db.settings, quota: recordingGuard() }, 'u1', [], 'de');
    expect(armed.armed).toBe(true);
    if (!armed.armed) throw new Error('unreachable: asserted armed above');
    expect(armed.deps.language).toBe('de');

    // Absent stays absent rather than becoming a guess: an invented language on a
    // diagnostic field would be worse than a blank one, because a reader would
    // believe it.
    const noLang = resolvePolishDep({ settings: db.settings, quota: recordingGuard() }, 'u1', []);
    expect(noLang.armed && noLang.deps.language).toBeUndefined();
  });

  it('the field has a real production writer — not a dep nobody fills', () => {
    // The value is threaded from audio:start's source_lang at exactly one site.
    // If this count is not 1, the wiring moved and this test is stale.
    const src = readFileSync(
      new URL('../src/engine/stt-factory.ts', import.meta.url),
      'utf8',
    );
    const wired = src
      .split('\n')
      .filter((l) => l.includes('resolvePolishDep(') && l.includes('args.sourceLang'));
    expect(wired.length).toBe(1);
  });
});
