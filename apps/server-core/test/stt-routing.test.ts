// WP-R1-3 routing contract tests (06 §4 no implicit fallback #16). Covers pickEngine's
// explicit→wildcard→managed→throw order, per-call re-resolution, the BYOK
// judgement (06 §4), the env-gated managed default (fail-loud on bad engine),
// and the id→constructor switch (all seven engines incl. sherpa-local).

import { describe, expect, it } from 'vitest';
import {
  makeEngineRouter, selectRouting, selectRoutingWithSource, SttConfigMissingError,
  type Routing, type EngineFactory, type SelectedRouting,
} from '../src/stt/engine-router';
import { managedDefaultRouting } from '../src/stt/managed-default';
import { defaultEngineFactory, resolveByok } from '../src/stt/engine-factory';
import { sherpaModelCanRecognize } from '../src/stt/sherpa/model-manifest';
import { UI_LOCALES } from '@flowmic/protocol';
import type { SttEngineId } from '@flowmic/protocol';
import type { SttEngine, SttEngineConfig } from '../src/stt/engines/base';

/** A trivial engine stub the router builds without touching the network. */
class StubEngine implements SttEngine {
  state = 'closed' as const;
  constructor(public readonly id: SttEngineId, public cfg: SttEngineConfig) {}
  push(): void {}
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
  on(): this { return this; }
}
const stubFactory: EngineFactory = (id, cfg) => new StubEngine(id, cfg) as unknown as SttEngine;

const R = (over: Partial<Routing>): Routing => ({ language: 'zh', engine_id: 'funasr', ...over });

describe('pickEngine — no implicit fallback (#16)', () => {
  it('resolves an exact language match', () => {
    const router = makeEngineRouter();
    const e = router.pickEngine('zh', [R({ language: 'zh', engine_id: 'funasr', endpoint: 'ws://x' })], stubFactory) as unknown as StubEngine;
    expect(e.id).toBe('funasr');
    expect(e.cfg.endpoint).toBe('ws://x');
    expect(e.cfg.sample_rate).toBe(16_000);
  });

  it('falls to the universal * routing when no exact match', () => {
    const router = makeEngineRouter();
    const e = router.pickEngine('ja', [R({ language: '*', engine_id: 'custom-openai-compatible' })], stubFactory) as unknown as StubEngine;
    expect(e.id).toBe('custom-openai-compatible');
    expect(e.cfg.language).toBe('ja'); // requested language stamped, not '*'
  });

  it('THROWS SttConfigMissingError when nothing matches (never a silent default)', () => {
    const router = makeEngineRouter();
    expect(() => router.pickEngine('ko', [R({ language: 'zh' })], stubFactory)).toThrow(SttConfigMissingError);
  });

  it('consults the managed default only after user routings miss', () => {
    const managed: Routing = { language: '*', engine_id: 'deepgram', api_key: 'mk' };
    const router = makeEngineRouter({ managedDefault: () => managed });
    // user routing wins
    const a = router.pickEngine('zh', [R({ language: 'zh', engine_id: 'funasr' })], stubFactory) as unknown as StubEngine;
    expect(a.id).toBe('funasr');
    // miss → managed default
    const b = router.pickEngine('ko', [], stubFactory) as unknown as StubEngine;
    expect(b.id).toBe('deepgram');
  });

  it('re-resolves per call (a settings change takes effect next audio:start)', () => {
    const router = makeEngineRouter();
    const first = router.pickEngine('zh', [R({ language: 'zh', engine_id: 'funasr' })], stubFactory) as unknown as StubEngine;
    const second = router.pickEngine('zh', [R({ language: 'zh', engine_id: 'openai-whisper' })], stubFactory) as unknown as StubEngine;
    expect(first.id).toBe('funasr');
    expect(second.id).toBe('openai-whisper');
  });
});

describe('selectRouting + resolveByok (06 §4)', () => {
  const user = (routing: Routing): SelectedRouting => ({ routing, source: 'user' });

  it('BYOK = user-supplied non-empty api_key; EMPTY sentinel + blank = platform', () => {
    expect(resolveByok(user({ language: '*', engine_id: 'deepgram', api_key: 'user-key' }))).toBe(true);
    expect(resolveByok(user({ language: '*', engine_id: 'custom-openai-compatible', api_key: '' }))).toBe(false);
    expect(resolveByok(user({ language: '*', engine_id: 'openai-whisper', api_key: 'EMPTY' }))).toBe(false);
    expect(resolveByok(user({ language: 'zh', engine_id: 'funasr' }))).toBe(false); // no key at all
    expect(resolveByok(null)).toBe(false);
  });

  // 🔴 T7 ①: the SAME key string, differing only in who supplied it.
  it('T7 ①: an identical key is BYOK from the user and NOT BYOK from the platform', () => {
    const routing: Routing = { language: '*', engine_id: 'deepgram', api_key: 'the-very-same-key' };
    expect(resolveByok({ routing, source: 'user' })).toBe(true);
    expect(resolveByok({ routing, source: 'managed-default' })).toBe(false);
  });

  it('T7 ①: selectRoutingWithSource stamps the provenance the resolver needs', () => {
    const managed = (): Routing => ({ language: '*', engine_id: 'deepgram', api_key: 'platform-key' });
    // user routing wins → source user → its key IS byok
    const a = selectRoutingWithSource('zh', [R({ language: 'zh', engine_id: 'deepgram', api_key: 'mine' })], managed);
    expect(a).toMatchObject({ source: 'user' });
    expect(resolveByok(a)).toBe(true);
    // user routings miss → managed default → source managed-default → NOT byok
    const b = selectRoutingWithSource('ko', [], managed);
    expect(b).toMatchObject({ source: 'managed-default' });
    expect(b?.routing.api_key).toBe('platform-key'); // the key really is non-empty
    expect(resolveByok(b)).toBe(false);
  });

  it('selectRouting mirrors pickEngine selection order', () => {
    const routings = [R({ language: 'zh', engine_id: 'funasr' }), R({ language: '*', engine_id: 'custom-openai-compatible' })];
    expect(selectRouting('zh', routings)?.engine_id).toBe('funasr');
    expect(selectRouting('en', routings)?.engine_id).toBe('custom-openai-compatible');
    expect(selectRouting('en', [])).toBeNull();
  });
});

describe('managedDefaultRouting — env gate (fail-loud)', () => {
  it('returns null when disabled', () => {
    expect(managedDefaultRouting({} as NodeJS.ProcessEnv)).toBeNull();
    expect(managedDefaultRouting({ FLOWMIC_MANAGED_STT_ENABLED: '0' } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it('builds a * routing when enabled with a valid engine', () => {
    const r = managedDefaultRouting({
      FLOWMIC_MANAGED_STT_ENABLED: '1',
      FLOWMIC_MANAGED_STT_ENGINE: 'deepgram',
      FLOWMIC_MANAGED_STT_ENDPOINT: 'wss://x',
      FLOWMIC_MANAGED_STT_API_KEY: 'k',
    } as unknown as NodeJS.ProcessEnv);
    expect(r).toMatchObject({ language: '*', engine_id: 'deepgram', endpoint: 'wss://x', api_key: 'k' });
  });

  it('THROWS (fail-loud) when enabled with an invalid engine id', () => {
    expect(() => managedDefaultRouting({
      FLOWMIC_MANAGED_STT_ENABLED: 'true', FLOWMIC_MANAGED_STT_ENGINE: 'not-an-engine',
    } as unknown as NodeJS.ProcessEnv)).toThrow(/invalid/i);
  });
});

describe('defaultEngineFactory — id → constructor switch (all 7)', () => {
  const ids: SttEngineId[] = [
    'funasr', 'deepgram', 'openai-realtime', 'openai-whisper',
    'custom-openai-compatible', 'funspeech-http', 'sherpa-local',
  ];
  it('constructs a real engine for every catalogue id', () => {
    for (const id of ids) {
      const e = defaultEngineFactory(id, { id, language: 'zh', sample_rate: 16_000 });
      expect(e.id).toBe(id);
    }
  });
});

// ── WP3 C13 (2026-08-18): the built-in engine refuses what its model cannot do ──
describe('sherpa-local refuses a language outside its model, BY NAME', () => {
  const cfg = (language: string) =>
    ({ id: 'sherpa-local', language, sample_rate: 16_000 }) as const;

  // DERIVED from the registry, not hand-rolled (the i18n-add-locale-cost gate
  // is right to bite here): the product's wire tags are the registry codes'
  // base forms, so a tenth language lands on the correct SIDE of this split
  // the day its registry row exists, with no edit to this file.
  const wireTags = [...new Set(UI_LOCALES.map((l) => l.code.split('-')[0]!))];
  const refused = wireTags.filter((t) => !sherpaModelCanRecognize(t));
  const accepted = wireTags.filter((t) => sherpaModelCanRecognize(t));

  it('🔴 the spoken languages the model does not know are refused with STT_LANGUAGE_UNSUPPORTED — never "recognised" as something nearby', () => {
    // Measured (WP3 handback): these came back as punctuation dressed as a
    // transcript with a clean exit ('de' → 「.」). The refusal replaces that.
    // Positive control on the derivation itself: today that set is exactly the
    // four languages WP3 added to the spoken picker.
    expect(refused.sort()).toEqual(['de', 'es', 'fr', 'ru']);
    for (const lang of refused) {
      let thrown: unknown;
      try { defaultEngineFactory('sherpa-local', cfg(lang)); } catch (e) { thrown = e; }
      expect(thrown, lang).toBeInstanceOf(SttConfigMissingError);
      // ⚠️ THIS ASSERTION SAID `STT_CONFIG_MISSING` FOR ONE ROUND, and it was
      // correct then: WP3 shipped the nearest TRUE code while the precise one
      // was owner-pending. owner granted it 2026-08-17. The old code is not
      // wrong here so much as misdirecting — it tells a reader nothing is
      // configured while they are looking at the engine that is.
      expect((thrown as SttConfigMissingError).code, lang).toBe('STT_LANGUAGE_UNSUPPORTED');
      // 🔴 The diagnostic message travels to a support log and must not have
      // inherited the old sentence — a message/code pair that disagrees is
      // worse than either alone, because only one of them is ever read.
      expect((thrown as Error).message, lang).toContain('cannot recognise');
      expect((thrown as Error).message, lang).not.toContain('No STT engine configured');
    }
  });

  // 🔴 THE OTHER TWO REFUSALS MUST NOT HAVE MOVED. Minting a code is only safe
  // if the codes it was folded into keep their own meanings, and this is the
  // positive control that says so rather than a paragraph claiming it.
  it('a language with NO route at all still answers STT_CONFIG_MISSING — the new code narrowed nothing else', () => {
    const router = makeEngineRouter({});
    let thrown: unknown;
    try { router.pickEngine('de', [], defaultEngineFactory); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(SttConfigMissingError);
    expect((thrown as SttConfigMissingError).code).toBe('STT_CONFIG_MISSING');
    expect((thrown as Error).message).toContain('No STT engine configured');
  });

  it("the model's languages, the wildcard, auto, and a region-tagged form all still construct", () => {
    for (const lang of [...accepted, 'yue', '*', 'auto', 'zh-CN', '']) {
      const e = defaultEngineFactory('sherpa-local', cfg(lang));
      expect(e.id, lang).toBe('sherpa-local');
    }
  });

  it('the refusal is the FACTORY arm, not the routing layer — a seeded wildcard row that selects sherpa still refuses at construction', () => {
    // The exact production shape of a stranger's first boot: no user rows, no
    // managed default, the seeded '*' row points at the built-in engine. The
    // selection legitimately matches (the wildcard IS the general-purpose
    // entry point); the refusal must come from the layer that knows the
    // MODEL — otherwise the route "works" and the recogniser answers 「.」.
    const seeded: Routing[] = [
      { language: 'zh', engine_id: 'sherpa-local', provenance: 'seed' },
      { language: '*', engine_id: 'sherpa-local', provenance: 'seed' },
    ];
    const router = makeEngineRouter({});
    expect(() => router.pickEngine('de', seeded, defaultEngineFactory))
      .toThrow(SttConfigMissingError);
    // Positive control on the same wiring: a language the model knows builds.
    expect(router.pickEngine('ja', seeded, defaultEngineFactory).id).toBe('sherpa-local');
  });
});
