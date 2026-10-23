// Card CTX-1 — a user who never filled a dictionary still gets useful Soniox
// `context` when the target PC has a code editor or terminal focused.
//
// What is asserted (assembly + delivery + the diagnostic), and what is NOT:
// whether recognition improves is a measurement, not a unit test — it was
// measured with scripts/eval/speech-quality (numbers on CODING_DEFAULT_TERMS_CAP
// in src/stt/coding-terms.ts). A green run here means "the right list reaches
// the right engine and the trace says so", never "accuracy went up".
//
// The wiring cases go through the PRODUCTION factories: `makeSttSessionFactory`
// (reads the room's focus process at audio:start) → `makeSttOrchestratorFactory`
// (decorates the engine factory) → the config the engine is constructed with.
// Only the engine constructor and the managed route are replaced, so the config
// is read off what the production chain built, not re-derived here.
//
// REVERSE CONTROLS (run on this tree with `vitest run test/ctx1-coding-default-context.test.ts`;
// red lines quoted in the CTX-1 delivery report):
//   ① stt-factory.ts: stop passing `appCategory` into build ⇒ the room-focus case red;
//   ② engine-factory.ts: `sonioxDefaultTermsFor` always undefined ⇒ coding cases red;
//   ③ engine-factory.ts: context decorator applied to every engine ⇒ non-Soniox case red;
//   ④ stt-factory.ts trace back to `engine_accepts_hotwords: engineId === 'funasr'` /
//      `delivered: engineId === 'funasr' && …` (via terminologyTraceFields) ⇒ trace cases red;
//   ⑤ terminology-context.ts: default terms first ⇒ the user-priority case red.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import type { SttEngineId } from '@flowmic/protocol';

import type { SttEngine, SttEngineConfig } from '../src/stt/engines/base';
import type { EngineFactory, Routing } from '../src/stt/engine-router';

const captured = vi.hoisted(() => ({ configs: [] as Array<{ id: string; cfg: Record<string, unknown> }>, engine: 'soniox' }));

class StubEngine {
  state = 'closed' as const;
  constructor(public readonly id: SttEngineId, public cfg: SttEngineConfig) {}
  push(): void {}
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
  on(): this { return this; }
}
const stubFactory: EngineFactory = (id, cfg) => {
  captured.configs.push({ id, cfg: cfg as unknown as Record<string, unknown> });
  return new StubEngine(id, cfg) as unknown as SttEngine;
};
const route = (): Routing => ({ language: '*', engine_id: captured.engine as SttEngineId, api_key: 'platform-key' } as Routing);

vi.mock('../src/stt/engine-factory', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/stt/engine-factory')>();
  return {
    ...real,
    // The production factory, with only the engine constructor and the managed
    // route swapped; the built orchestrator's engine factory is then invoked so
    // the config the decorators produced is captured.
    makeSttOrchestratorFactory: (deps: Parameters<typeof real.makeSttOrchestratorFactory>[0]) => {
      const f = real.makeSttOrchestratorFactory({ ...deps, engineFactory: stubFactory, managedDefault: route });
      return (...a: Parameters<ReturnType<typeof real.makeSttOrchestratorFactory>>) => {
        const built = f(...a);
        (built.orchestrator as unknown as { engineFactory: () => unknown }).engineFactory();
        return built;
      };
    },
  };
});

import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { RoomStore } from '../src/room/store';
import { makeSttSessionFactory } from '../src/engine/stt-factory';
import { makeSttOrchestratorFactory, sonioxDefaultTermsFor } from '../src/stt/engine-factory';
import { AudioSession } from '../src/stt/audio/session';
import { assembleSonioxContext, buildSonioxContext } from '../src/stt/terminology-context';
import { terminologyTraceFields, terminologyDestinationFor } from '../src/stt/terminology-destination';
import { CODING_DEFAULT_TERMS, CODING_DEFAULT_TERMS_CAP } from '../src/stt/coding-terms';
import { appCategoryFor } from '../src/compose/app-category';
import { log } from '../src/log';
import type { QuotaGuard } from '../src/billing/quota-guard';

const U = 'ctx1-user';
function freshDb(): DbConnection {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('ctx1-coding-default-key') });
  db.users.insert({ id: U, display_name: 'C', plan: 'free' });
  return db;
}
const userTerms = (db: DbConnection, terms: string[]): void => {
  db.settings.write(U, 'scenario.card', { professions: [], domains: [], packs: [], terms: terms.map((term) => ({ term })) });
};
const lastCfg = (): Record<string, unknown> => captured.configs[captured.configs.length - 1]!.cfg;

beforeEach(() => { captured.configs.length = 0; captured.engine = 'soniox'; });

describe('assembleSonioxContext — the default list after the user', () => {
  it('coding default only: the default terms are sent and the source says so', () => {
    const a = assembleSonioxContext([], sonioxDefaultTermsFor('coding'));
    expect(a.source).toBe('default:coding');
    expect(a.userTerms).toBe(0);
    expect(a.defaultTerms).toBe(CODING_DEFAULT_TERMS_CAP);
    expect(a.context).toContain('Claude Code');
    expect(a.context).toContain('Kubernetes');
    expect(a.chars).toBe(a.context!.length);
  });

  it('unknown / non-coding category: exactly the pre-CTX-1 output (absent when empty)', () => {
    for (const cat of [undefined, 'email', 'chat'] as const) {
      expect(assembleSonioxContext([], sonioxDefaultTermsFor(cat))).toEqual({ context: undefined, source: 'none', userTerms: 0, defaultTerms: 0, dictationTerms: 0, chars: 0 });
      expect(assembleSonioxContext(['FlowMic'], sonioxDefaultTermsFor(cat)).context).toBe(buildSonioxContext(['FlowMic']));
    }
  });

  it('user terms come first and are never displaced by the cap; defaults fill the rest', () => {
    const mine = Array.from({ length: CODING_DEFAULT_TERMS_CAP - 10 }, (_, i) => `Mine${i}`);
    const a = assembleSonioxContext(mine, sonioxDefaultTermsFor('coding'));
    expect(a.source).toBe('both');
    expect(a.userTerms).toBe(mine.length);
    expect(a.defaultTerms).toBe(10);
    const pieces = a.context!.slice(a.context!.indexOf(':') + 1).split(', ').map((p) => p.trim());
    expect(pieces.slice(0, mine.length)).toEqual(mine);
    expect(pieces.slice(mine.length)).toEqual(CODING_DEFAULT_TERMS.slice(0, 10));
    // More user terms than the cap: every user term stays, no default is added.
    const many = Array.from({ length: CODING_DEFAULT_TERMS_CAP + 5 }, (_, i) => `Many${i}`);
    const b = assembleSonioxContext(many, sonioxDefaultTermsFor('coding'));
    expect(b.userTerms).toBe(many.length);
    expect(b.defaultTerms).toBe(0);
    expect(b.source).toBe('user');
  });

  it('a user term the default also carries is counted once, as the user\'s', () => {
    const a = assembleSonioxContext(['Kubernetes'], sonioxDefaultTermsFor('coding'));
    expect(a.context!.split('Kubernetes')).toHaveLength(2);
    expect(a.userTerms).toBe(1);
  });

  it('the shipped list fits the cap and the term ceiling of the scenario card', () => {
    expect(CODING_DEFAULT_TERMS.length).toBe(CODING_DEFAULT_TERMS_CAP);
    expect(new Set(CODING_DEFAULT_TERMS).size).toBe(CODING_DEFAULT_TERMS.length);
    for (const t of CODING_DEFAULT_TERMS) expect(t.length).toBeLessThanOrEqual(40);
  });
});

describe('makeSttOrchestratorFactory — which engine is told', () => {
  const build = (db: DbConnection, appCategory?: 'coding' | 'email') => {
    const f = makeSttOrchestratorFactory({ settings: db.settings, mode: 'saas' });
    return f(new AudioSession(), 'en', U, undefined, { settings: db.settings, ...(appCategory ? { appCategory } : {}) });
  };

  it('Soniox + coding focus + no dictionary ⇒ the default list is on the config', () => {
    build(freshDb(), 'coding');
    expect(String(lastCfg().context)).toContain('Claude Code');
  });

  it('the `stt.soniox context` log line carries counts, never a term (user or default)', () => {
    const infos = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    try {
      const db = freshDb();
      userTerms(db, ['Zyxwvutsrq']);
      build(db, 'coding');
      const lines = infos.mock.calls.filter((c) => c[0] === 'stt.soniox context');
      expect(lines).toHaveLength(1);
      expect(lines[0]![1]).toMatchObject({ source: 'both', user_terms: 1, default_terms: CODING_DEFAULT_TERMS_CAP - 1 });
      const text = JSON.stringify(lines[0]);
      expect(text).not.toContain('Zyxwvutsrq');
      for (const t of CODING_DEFAULT_TERMS) expect(text, t).not.toContain(`"${t}`);
      expect(text).not.toContain('likely to be spoken');
    } finally {
      infos.mockRestore();
    }
  });

  it('Soniox + no focus ⇒ no context at all (today\'s frame)', () => {
    build(freshDb());
    expect(lastCfg()).not.toHaveProperty('context');
    build(freshDb(), 'email');
    expect(lastCfg()).not.toHaveProperty('context');
  });

  it('non-Soniox engines are untouched by the default', () => {
    for (const engine of ['funasr', 'deepgram', 'sherpa-local']) {
      captured.engine = engine;
      build(freshDb(), 'coding');
      expect(lastCfg()).not.toHaveProperty('context');
    }
  });
});

describe('makeSttSessionFactory — the room\'s focused app reaches the engine', () => {
  const guard: QuotaGuard = { ensureQuota() {}, remainingSttMs: () => Infinity, continuousCapMs: () => Infinity };
  function startIn(processName: string | null): Record<string, unknown> {
    const db = freshDb();
    userTerms(db, ['FlowMic']);
    const store = new RoomStore<Socket>();
    if (processName !== null) store.setFocusProcess('room-1', processName);
    const factory = makeSttSessionFactory({ settings: db.settings, mode: 'standalone', store, quota: guard });
    const socket = { id: 'phone', data: { roomUuid: 'room-1', auth: { kind: 'mobile', userId: U, deviceId: 'pc-1' } }, emit: () => true } as unknown as Socket;
    factory(socket, { userId: U, mode: 'realtime', delivery: 'none', sourceLang: 'en', onComplete: () => {} });
    return lastCfg();
  }

  it('PC focus `Code` ⇒ user term first, then the coding default', () => {
    expect(appCategoryFor('Code')).toBe('coding');
    const ctx = String(startIn('Code').context);
    expect(ctx).toContain('FlowMic');
    expect(ctx).toContain('Claude Code');
    expect(ctx.indexOf('FlowMic')).toBeLessThan(ctx.indexOf('Claude Code'));
  });

  it('the closed process table covers the common editors and terminals (case-insensitive)', () => {
    for (const p of ['Code', 'Cursor', 'Windsurf', 'Zed', 'idea64', 'pycharm64', 'webstorm64', 'devenv',
      'WindowsTerminal', 'wezterm-gui', 'alacritty', 'iTerm2', 'Terminal', 'Warp', 'Ghostty']) {
      expect(appCategoryFor(p), p).toBe('coding');
    }
    for (const p of ['notepad', 'chrome', 'WINWORD', '']) expect(appCategoryFor(p), p).toBeUndefined();
    // Prototype keys are process names like any other: unmapped, not a function.
    for (const p of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) expect(appCategoryFor(p), p).toBeUndefined();
  });

  it('PC focus an unknown app, or none ⇒ the user terms only, as before', () => {
    expect(startIn('notepad').context).toBe(buildSonioxContext(['FlowMic']));
    expect(startIn(null).context).toBe(buildSonioxContext(['FlowMic']));
  });
});

describe('the `hotwords` pipeline-trace record tells the truth per engine', () => {
  const none = assembleSonioxContext([]);
  const coding = assembleSonioxContext([], sonioxDefaultTermsFor('coding'));

  it('Soniox with context ⇒ accepts context, delivered, with source and size (no terms)', () => {
    const f = terminologyTraceFields('soniox', 0, coding);
    expect(f).toMatchObject({ destination: 'context', engine_accepts_context: true, engine_accepts_hotwords: false, delivered: true, context_source: 'default:coding', context_default_terms: CODING_DEFAULT_TERMS_CAP });
    expect(JSON.stringify(f)).not.toContain('Claude Code');
  });

  it('Soniox with nothing to send ⇒ not delivered, source none', () => {
    expect(terminologyTraceFields('soniox', 0, none)).toMatchObject({ delivered: false, context_source: 'none' });
  });

  it('FunASR ⇒ hotwords, delivered iff it has rules; other engines ⇒ nothing', () => {
    expect(terminologyTraceFields('funasr', 2, none)).toMatchObject({ destination: 'hotwords', engine_accepts_hotwords: true, delivered: true });
    expect(terminologyTraceFields('funasr', 0, none)).toMatchObject({ delivered: false });
    expect(terminologyTraceFields('deepgram', 3, coding)).toMatchObject({ destination: 'none', engine_accepts_hotwords: false, engine_accepts_context: false, delivered: false });
    expect(terminologyTraceFields('deepgram', 3, coding)).not.toHaveProperty('context_source');
    expect(terminologyDestinationFor(undefined)).toBeUndefined();
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(terminologyDestinationFor(id), id).toBeUndefined();
      expect(terminologyTraceFields(id, 1, coding), id).toMatchObject({ destination: 'none', delivered: false });
    }
  });
});

// Card ML-2: the session language reaches the context (Japanese dictation
// command words, src/stt/terminology-context.ts dictationContextTerms).
describe('makeSttOrchestratorFactory — dictation command words (ML-2)', () => {
  const buildIn = (language: string) => {
    const db = freshDb();
    const f = makeSttOrchestratorFactory({ settings: db.settings, mode: 'saas' });
    f(new AudioSession(), language, U, undefined, { settings: db.settings });
  };

  it('a Japanese session tells Soniox the command words; an English one sends no context', () => {
    buildIn('ja');
    expect(String(lastCfg().context)).toContain('改行');
    buildIn('en');
    expect(lastCfg().context).toBeUndefined();
  });
});
