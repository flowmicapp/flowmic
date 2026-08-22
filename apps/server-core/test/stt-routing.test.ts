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
import {
  catalogCanServe, catalogModelById, sherpaModelCanRecognize,
} from '../src/stt/sherpa/model-catalog';
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

// ── WP3 C13 (2026-08-18) → LM-CAT (2026-08-22): the gate now asks the CATALOG ──
//
// 🔴 WHAT CHANGED AND WHY THE OLD ASSERTION IS GONE. WP3's gate asked "can the
// (one) SenseVoice model recognise this" and the positive control here pinned
// `refused === ['de','es','fr','ru']`. LM-CAT replaced the single model with a
// per-language CATALOG of downloadable packs, every spoken language has at
// least one covering row, so the factory-time refusal set for the product's
// wire tags is now EMPTY — French no longer refuses at construction, it
// refuses (or serves) at open() depending on what is actually downloaded
// (model-resolve.ts; STT_CONFIG_MISSING with the settings-download action).
// STT_LANGUAGE_UNSUPPORTED still exists for a language NO catalog row claims.
describe('sherpa-local language gate — catalog-backed (LM-CAT)', () => {
  const cfg = (language: string) =>
    ({ id: 'sherpa-local', language, sample_rate: 16_000 }) as const;

  // DERIVED from the registry, not hand-rolled: the product's wire tags are
  // the registry codes' base forms.
  const wireTags = [...new Set(UI_LOCALES.map((l) => l.code.split('-')[0]!))];
  const accepted = wireTags;

  it('🔴 every product wire tag now constructs — the catalog claims all eight', () => {
    // Positive control on the catalog derivation: the wire tags and the
    // catalog keys must be the same set (a ninth UI language whose base has
    // no catalog row would show up here, which is the point).
    for (const lang of wireTags) {
      expect(catalogCanServe(lang), lang).toBe(true);
      const e = defaultEngineFactory('sherpa-local', cfg(lang));
      expect(e.id, lang).toBe('sherpa-local');
    }
  });

  it('a language NO catalog row claims still refuses with STT_LANGUAGE_UNSUPPORTED, by name', () => {
    // 'it' (Italian) is a real language the catalog does not claim — the
    // refusal shape WP3 measured (silence dressed as a transcript) must not
    // come back for it.
    for (const lang of ['it', 'pt', 'ar']) {
      let thrown: unknown;
      try { defaultEngineFactory('sherpa-local', cfg(lang)); } catch (e) { thrown = e; }
      expect(thrown, lang).toBeInstanceOf(SttConfigMissingError);
      expect((thrown as SttConfigMissingError).code, lang).toBe('STT_LANGUAGE_UNSUPPORTED');
      expect((thrown as Error).message, lang).toContain('cannot recognise');
      expect((thrown as Error).message, lang).not.toContain('No STT engine configured');
    }
  });

  // ── LM-CAT §8-④: the per-MODEL question, with its reverse control ─────────
  it('🔴 sherpaModelCanRecognize asks the ROW: French is true of whisper-turbo and false of SenseVoice', () => {
    const turbo = catalogModelById('sherpa-onnx-whisper-turbo')!;
    const senseVoice = catalogModelById('sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17')!;
    expect(sherpaModelCanRecognize('fr', turbo)).toBe(true);
    // The reverse control the task demands: the SenseVoice-only answer to
    // French is NO — an implementation that fell back to a global language
    // set would answer the same for both rows and one of these two lines
    // would go red (proven red by inverting the check during development).
    expect(sherpaModelCanRecognize('fr', senseVoice)).toBe(false);
    // …and zh is true of both, so the split above is about the ROW, not
    // about French being special.
    expect(sherpaModelCanRecognize('zh', turbo)).toBe(true);
    expect(sherpaModelCanRecognize('zh', senseVoice)).toBe(true);
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

  it("the catalog languages, yue, the wildcard, auto, and a region-tagged form all still construct", () => {
    // 'yue' stays constructible: the SenseVoice row claims it (its model card
    // does) even though the phone never offers it — LM-CAT §4 note.
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
    // CATALOG — otherwise the route "works" and the recogniser answers 「.」.
    // (LM-CAT: 'de' moved to the constructible side — a downloadable pack
    // claims it now — so the uncovered language here is Italian.)
    const seeded: Routing[] = [
      { language: 'zh', engine_id: 'sherpa-local', provenance: 'seed' },
      { language: '*', engine_id: 'sherpa-local', provenance: 'seed' },
    ];
    const router = makeEngineRouter({});
    expect(() => router.pickEngine('it', seeded, defaultEngineFactory))
      .toThrow(SttConfigMissingError);
    // Positive control on the same wiring: a language the catalog claims builds.
    expect(router.pickEngine('ja', seeded, defaultEngineFactory).id).toBe('sherpa-local');
  });
});
