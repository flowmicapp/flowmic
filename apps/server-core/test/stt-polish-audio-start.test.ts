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
import { readSttPolish, STT_POLISH_DEFAULT_WITHOUT_LLM } from '../src/stt/stt-polish-settings';
import { resolveLlmConfigWithSource } from '../src/compose/llm-config';
import { ServerError } from '../src/errors';
import type { QuotaGuard, QuotaKind } from '../src/billing/quota-guard';
import type { UsageTracker } from '../src/billing/usage-tracker';

const noopGuard: QuotaGuard = { ensureQuota() {}, remainingSttMs: () => Infinity };
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
    };
    expect(() => resolvePolishDep({ settings: db.settings, quota: wrongCode }, 'u1', [])).toThrow(ServerError);
    const bug: QuotaGuard = {
      ensureQuota(): void { throw new TypeError('usage repo is undefined'); },
      remainingSttMs: () => Infinity,
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
//    ❯ resolveLlmConfigWithSource src/compose/llm-config.ts:216:29
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
//      this comment already wrote for itself — symbol anchor only.
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
    expect(a.armed === false && a.unavailable).toBe('llm_error');
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
    // The reason must stay inside the phone's FROZEN four (`kSttPolishReasons` in
    // apps/mobile/lib/src/stt/stt_stream.dart) — a new value would parse to null
    // there, which is the same defect one layer along.
    expect(['timeout', 'llm_error', 'empty_output', 'guard_reject']).toContain(wireOf(degraded));
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
    };
    expect(() => resolvePolishDep({ settings: db.settings, quota: bug }, 'u1', [])).toThrow(TypeError);
  });
});

// ── OSS-DEFAULTS / W4A-9 (a) — what a STRANGER'S FIRST BOOT actually gets ────
//
// The finding this pins: 「`stt.polish` ships as true ⇒ every stock-install final hits
// LLM_INVALID_MODEL」 (W4A-9, 2026-08-09 registration ledger §4).
//
// 🔴 WHY THIS BLOCK EXISTS WHEN BOTH HALVES ARE ALREADY GREEN ELSEWHERE. The
// default-side fix (2aa4286, POLISH-CFG) is pinned by settings-anchors.test.ts /
// settings-effective-defaults.test.ts; the runtime-side fix (RT-1a, the block
// above) is pinned by this file. NEITHER of them pins the COMPOSITION, and the
// composition is the whole finding — every assertion in both places writes the
// row it is about, so a stock account (no `stt.polish` row AND no `llm.config`
// row at the same time) is a state no test in this repo ever constructs.
// That is the same shape book 15 R11 keeps producing: two layers each correct
// about its own question, and nobody asking what they answer together.
//
// 🔴 AND THE ASSERTION IS 「NOTHING IS SAID」, NOT 「NOTHING FAILS」. owner's
// 2026-08-12 delivery principle is 「smooth, simple, easy to use」: an optional feature nobody
// configured is not an error, so the stock session must be BYTE-IDENTICAL on the
// wire to one where polish was never asked for — `unavailable` undefined, not
// merely 「the recording still started」. `armed:false` alone would be green for
// both the correct behaviour and the one where every closing final carries an
// amber 「polish did not take effect」 mark for a feature the user never turned on.
//
// ⚠️ The opposite arm is asserted here too, in the same block, on the same db:
// somebody who DOES flip the switch without a model keeps the mark. Splitting
// 「not configured」 from 「configured but this turn failed」 is this feature's founding distinction
// (stt-polish-settings.ts header), and a test for the silent half that does not
// also hold the loud half in place is how the loud half gets optimised away.
describe('OSS-DEFAULTS — a stock install polishes nothing and says nothing about it', () => {
  /** A stranger's first boot: the real seeder, and NOTHING else written. No
   *  `llm.config` (defaults.ts seeds LLM_NOT_CONFIGURED), no `stt.polish` row.
   *  Deliberately NOT freshDb() — that helper writes a working llm.config, which
   *  is exactly the state this block must not be in. */
  function stockDb(): DbConnection {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('polish-stock-install-secret') });
    db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
    seedDefaultSettings(db.settings, 'u1');
    return db;
  }

  it('the precondition really holds: a stock seed writes neither llm.config nor stt.polish', () => {
    // Positive control for everything below. Without it, a seeder that started
    // writing an llm.config again would make this whole block pass while testing
    // the opposite situation — and the env gates are the other way the fixture
    // could quietly stop being a stock install.
    expect(process.env.FLOWMIC_MANAGED_LLM_ENABLED).toBeUndefined();
    expect(process.env.FLOWMIC_DEFAULT_LLM_PRESET).toBeUndefined();
    const db = stockDb();
    expect(db.settings.read('u1', 'llm.config')).toBeNull();
    expect(db.settings.read('u1', 'stt.polish')).toBeNull();
    // …and the resolver really cannot produce a model from that state.
    expect(() => resolveLlmConfigWithSource(db.settings, 'u1')).toThrow(ServerError);
  });

  it('🔴 polish is unarmed AND silent — no error, and no amber mark either', () => {
    const db = stockDb();
    const arming = resolvePolishDep({ settings: db.settings, quota: noopGuard }, 'u1', []);
    expect(arming.armed).toBe(false);
    // The silent half, asserted FIRST on purpose. `unavailable` is what becomes
    // `polish:'skipped'` on every stt:final (stt-factory :295 → stt-session
    // polishWireForFinal), so undefined here is the difference between 「nothing
    // was asked for」 and 「you asked and it failed」 — on a feature nobody asked
    // for. It is also the only assertion in this block that no other test in the
    // repo makes; ordering it ahead of the default read is what makes the
    // reverse control name the COMPOSITION rather than re-fail settings-anchors'
    // question one file over.
    expect(arming.armed === false && arming.unavailable).toBeUndefined();
    // The default half (2aa4286): absent row + no model ⇒ OFF.
    expect(readSttPolish(db.settings, 'u1')).toEqual(STT_POLISH_DEFAULT_WITHOUT_LLM);
  });

  it('the recording starts and nothing is emitted on stt:error (end to end)', () => {
    const mobile = wire(stockDb());
    let ack: Record<string, unknown> | undefined;
    mobile.fire('audio:start', START, (r) => { ack = r as Record<string, unknown>; });
    expect(ack?.ok).toBe(true);
    // Asserted on the FRAMES: an implementation that acked ok while emitting
    // stt:error(LLM_INVALID_MODEL) — the exact finding — is caught here too.
    expect(mobile.received('stt:error')).toEqual([]);
    mobile.fire('audio:stop', {}, () => {});
  });

  it('…but a DELIBERATE opt-in on the same stock install still gets its mark', () => {
    // The half that must not be swallowed. Same db, one row different: the user
    // turned the switch on. That is a choice, not an unconfigured feature, so the
    // honest answer is the RT-1a degrade WITH its reason — 「you turned it on and it did not run」.
    const db = stockDb();
    db.settings.write('u1', 'stt.polish', { enabled: true });
    const arming = resolvePolishDep({ settings: db.settings, quota: noopGuard }, 'u1', []);
    expect(arming.armed).toBe(false);
    expect(arming.armed === false && arming.unavailable).toBe('llm_error');
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

  it('a census: exactly the compose turn, the polish snapshot, and the polish DEFAULT resolve it', () => {
    // 🔴 POLISH-CFG (2026-08-09) added the third entry deliberately, and this
    // census going red is the mechanism working, not noise: a new consumer of the
    // resolver is the actual hazard this case was built to surface, so it must be
    // re-declared by a human rather than pattern-matched away.
    //
    // WHY THE THIRD SITE IS SAFE where a fourth might not be. The hazard named
    // above is DROPPING `source` and misattributing who pays. This call site
    // discards the resolved config entirely — it only asks 「did it resolve at
    // all」 to decide a default — so there is no `source` for it to lose and no
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
