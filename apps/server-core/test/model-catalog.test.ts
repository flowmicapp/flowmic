// LM-CAT phase A/B/C acceptance (task file §8):
//   ① every spoken language has at least one osi/cc-by offline-or-quasi row;
//   ② SenseVoice stays, labelled funasr-model (never "open source");
//   ③ streaming rows refuse loading with a named reason;
//   ⑤ SHERPA_REPO is a derived alias, not a second registry;
//   §6 the resolution ladder; the selection store; the movable models root.
//
// Excluded-by-name models are asserted ABSENT — Kroko (CC-BY-SA) and
// Fun-ASR-Nano must not reappear in a "helpful" catalog expansion.

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  baseLang, CATALOG_SPOKEN_LANGS, catalogCanServe, catalogModelById,
  catalogRowsForLanguage, isLoadableThisPhase, MODEL_CATALOG,
  SENSE_VOICE_MODEL_ID, sherpaModelCanRecognize,
} from '../src/stt/sherpa/model-catalog';
import {
  CatalogRoleMissingError, offlineModelConfigFor, StreamingLoaderUnsupportedError,
} from '../src/stt/sherpa/loader-config';
import {
  SHERPA_MODEL_FILES, SHERPA_REPO, configuredModelsRoot, defaultModelsRoot,
  resolveModelDir, resolveModelsRoot, setModelsRoot,
} from '../src/stt/sherpa/model-manifest';
import { readModelSelection, writeModelSelection } from '../src/stt/sherpa/model-selection';
import { candidateRowsForLanguage, resolveReadyModelForLanguage } from '../src/stt/sherpa/model-resolve';
import { resetSherpaModelControllers } from '../src/stt/sherpa/model-downloader';

afterEach(() => resetSherpaModelControllers());

function tempEnv(): NodeJS.ProcessEnv {
  return { APPDATA: mkdtempSync(join(tmpdir(), 'flowmic-cat-appdata-')) } as NodeJS.ProcessEnv;
}

// ── ① coverage invariants ────────────────────────────────────────────────────

describe('catalog coverage (task §8 acceptance ①)', () => {
  it('the eight spoken keys are exactly kSpokenLangs\u2019 bare codes', () => {
    // The mobile SSOT cannot be imported (Dart); this literal is the hand
    // mirror the catalog comment declares. If the phone ever grows a ninth
    // spoken language, this line is the tripwire that says "the catalog has
    // not heard about it".
    expect([...CATALOG_SPOKEN_LANGS].sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']);
  });

  it('🔴 every spoken language has ≥1 osi/cc-by row that is offline or quasi (downloadable this phase)', () => {
    for (const lang of CATALOG_SPOKEN_LANGS) {
      const usable = catalogRowsForLanguage(lang).filter(
        (m) => isLoadableThisPhase(m) &&
          (m.license_class === 'osi' || m.license_class === 'cc-by') &&
          (m.streaming === 'offline' || m.streaming === 'quasi'),
      );
      expect(usable.length, `${lang} needs at least one downloadable open/attribution-licensed row`).toBeGreaterThanOrEqual(1);
    }
  });

  it('every row\u2019s spoken set stays inside the catalog keys (+ the documented yue exception)', () => {
    for (const m of MODEL_CATALOG) {
      for (const s of m.spoken) {
        const allowed = CATALOG_SPOKEN_LANGS.includes(s) || (s === 'yue' && m.model_id === SENSE_VOICE_MODEL_ID);
        expect(allowed, `${m.model_id} claims '${s}'`).toBe(true);
      }
    }
  });

  it('② SenseVoice remains a row and is funasr-model — never presented as open source', () => {
    const sv = catalogModelById(SENSE_VOICE_MODEL_ID)!;
    expect(sv).not.toBeNull();
    expect(sv.license_class).toBe('funasr-model');
    expect(sv.license_spdx_or_name).toBe('FunASR-Model-1.1');
    // The words the UI must not be handed for this row:
    expect(sv.attribution.toLowerCase()).not.toContain('open source');
    expect(sv.attribution).not.toContain('Apache');
  });

  it('the excluded models are absent by name (Kroko CC-BY-SA, Fun-ASR-Nano)', () => {
    for (const m of MODEL_CATALOG) {
      expect(m.model_id.toLowerCase()).not.toContain('kroko');
      expect(m.model_id.toLowerCase()).not.toContain('funasr-nano');
      expect(m.model_id.toLowerCase()).not.toContain('fun-asr-nano');
    }
  });

  it('license_class is one of the three shippable values on every row (excluded is not a value)', () => {
    for (const m of MODEL_CATALOG) {
      expect(['osi', 'cc-by', 'funasr-model']).toContain(m.license_class);
      expect(m.attribution.length, `${m.model_id} needs an attribution line`).toBeGreaterThan(0);
    }
  });

  it('model ids are unique — the id is the disk directory name', () => {
    const ids = MODEL_CATALOG.map((m) => m.model_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('⑤ SHERPA_REPO and SHERPA_MODEL_FILES are the SenseVoice row, not a second registry', () => {
    const sv = catalogModelById(SENSE_VOICE_MODEL_ID)!;
    expect(SHERPA_REPO).toBe(sv.model_id);
    expect(SHERPA_MODEL_FILES).toBe(sv.files); // identity, not just equality
  });

  it('every downloadable row has files with roles enough to build its loader config', () => {
    for (const m of MODEL_CATALOG.filter(isLoadableThisPhase)) {
      // Building the config for a fake dir exercises every required role.
      const cfg = offlineModelConfigFor(m, 'X:/fake', 'en', 2);
      expect(cfg['tokens']).toBeDefined();
    }
  });
});

// ── ③ streaming refuses, by name ─────────────────────────────────────────────

describe('streaming rows refuse this phase (task §8 acceptance ③)', () => {
  const streamingRows = MODEL_CATALOG.filter((m) => m.streaming === 'streaming');

  it('the catalog DOES list a streaming row (fr) — existence is the point', () => {
    expect(streamingRows.length).toBeGreaterThanOrEqual(1);
    expect(streamingRows.some((m) => m.spoken.includes('fr'))).toBe(true);
  });

  it('🔴 loading one throws the NAMED refusal, not a generic failure', () => {
    for (const m of streamingRows) {
      let thrown: unknown;
      try { offlineModelConfigFor(m, 'X:/fake', 'fr', 2); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(StreamingLoaderUnsupportedError);
      expect((thrown as Error).message).toContain('streaming');
      expect((thrown as Error).message).toContain(m.model_id);
    }
  });

  it('streaming rows are not loadable-this-phase and never resolvable', () => {
    for (const m of streamingRows) expect(isLoadableThisPhase(m)).toBe(false);
    const env = tempEnv();
    // fr candidates must not contain the streaming row even though it is the
    // only fr-dedicated pack.
    for (const c of candidateRowsForLanguage('fr', {})) {
      expect(c.streaming).not.toBe('streaming');
    }
    void env;
  });

  it('a row missing a required role blames the catalog, not the download', () => {
    const sv = catalogModelById(SENSE_VOICE_MODEL_ID)!;
    const broken = { ...sv, files: sv.files.filter((f) => f.role !== 'tokens') };
    let thrown: unknown;
    try { offlineModelConfigFor(broken, 'X:/fake', 'zh', 2); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(CatalogRoleMissingError);
    expect((thrown as Error).message).toContain('catalog row');
  });
});

// ── per-model language question + factory gate ───────────────────────────────

describe('sherpaModelCanRecognize / catalogCanServe', () => {
  it('asks the row (fr: whisper yes, SenseVoice no) — the §8-④ reverse control lives in stt-routing.test.ts', () => {
    const turbo = catalogModelById('sherpa-onnx-whisper-turbo')!;
    const sv = catalogModelById(SENSE_VOICE_MODEL_ID)!;
    expect(sherpaModelCanRecognize('fr', turbo)).toBe(true);
    expect(sherpaModelCanRecognize('fr', sv)).toBe(false);
    expect(sherpaModelCanRecognize('fr-FR', turbo)).toBe(true); // region-strip
    expect(sherpaModelCanRecognize('*', sv)).toBe(true); // wildcard passes
  });

  it('catalogCanServe: all eight keys yes; an unclaimed language no', () => {
    for (const lang of CATALOG_SPOKEN_LANGS) expect(catalogCanServe(lang), lang).toBe(true);
    expect(catalogCanServe('it')).toBe(false);
    expect(catalogCanServe('auto')).toBe(true);
  });

  it('baseLang strips exactly one region suffix', () => {
    expect(baseLang('zh-CN')).toBe('zh');
    expect(baseLang('EN')).toBe('en');
  });
});

// ── the movable models root (owner 2026-08-22) ───────────────────────────────

describe('models root: configurable, validated, resettable', () => {
  it('default root is under app data; a configured root wins; reset restores', () => {
    const env = tempEnv();
    const dflt = defaultModelsRoot(env);
    expect(resolveModelsRoot(env)).toBe(dflt);
    const target = mkdtempSync(join(tmpdir(), 'flowmic-cat-root-'));
    setModelsRoot(target, env);
    expect(configuredModelsRoot(env)).toBe(target);
    expect(resolveModelsRoot(env)).toBe(target);
    expect(resolveModelDir('some-model', env)).toBe(join(target, 'some-model'));
    setModelsRoot(null, env);
    expect(configuredModelsRoot(env)).toBe(null);
    expect(resolveModelsRoot(env)).toBe(dflt);
  });

  it('refuses a relative path loudly', () => {
    const env = tempEnv();
    expect(() => setModelsRoot('relative/dir', env)).toThrow(/absolute/);
    expect(configuredModelsRoot(env)).toBe(null);
  });

  it('FLOWMIC_SHERPA_MODEL_DIR still overrides per-model resolution (debug scripts)', () => {
    const env = { ...tempEnv(), FLOWMIC_SHERPA_MODEL_DIR: 'D:/debug/dir' } as NodeJS.ProcessEnv;
    expect(resolveModelDir('anything', env)).toBe('D:/debug/dir');
  });
});

// ── selection store ──────────────────────────────────────────────────────────

describe('per-language selection store', () => {
  it('round-trips a valid pair and refuses invalid ones', () => {
    const env = tempEnv();
    expect(readModelSelection(env)).toEqual({});
    writeModelSelection('zh', SENSE_VOICE_MODEL_ID, env);
    expect(readModelSelection(env)['zh']).toBe(SENSE_VOICE_MODEL_ID);
    expect(() => writeModelSelection('fr', SENSE_VOICE_MODEL_ID, env)).toThrow(/does not claim/);
    expect(() => writeModelSelection('zh', 'nope', env)).toThrow(/unknown model_id/);
    expect(() => writeModelSelection('yue', SENSE_VOICE_MODEL_ID, env)).toThrow(/not a catalog/);
  });

  it('drops entries that stopped parsing instead of handing them downstream', () => {
    const env = tempEnv();
    writeModelSelection('zh', SENSE_VOICE_MODEL_ID, env);
    // Corrupt by hand: an id the catalog does not carry.
    const p = join(env.APPDATA!, 'FlowMic', 'stt-model-selection.json');
    writeFileSync(p, JSON.stringify({ selected_by_lang: { zh: 'gone-model', en: 42 } }));
    expect(readModelSelection(env)).toEqual({});
  });
});

// ── §6 resolution ladder ─────────────────────────────────────────────────────
//
// 🔴 SYNTHETIC rows through the resolver's declared seam, deliberately. The
// first version staged REAL catalog rows by allocating their declared sizes
// into the OS temp dir — hundreds of MB per case on the system drive, and the
// moment the verification pass pins SHA-256 on those rows, zero-filled files
// can never pass the gate again. The ladder under test is the ORDERING; the
// real rows' integrity mechanics have their own suites and the real-download
// verification pass.

import type { CatalogModel } from '../src/stt/sherpa/model-catalog';

const T = (over: Partial<CatalogModel>): CatalogModel => ({
  model_id: 'syn-model',
  spoken: ['ko'],
  tier: 'recommended',
  loader: 'offline-transducer',
  license_class: 'osi',
  license_spdx_or_name: 'Apache-2.0',
  attribution: 'synthetic test row',
  streaming: 'offline',
  files: [{ path: 'tokens.txt', size: 16, role: 'tokens' }],
  sources: [],
  ...over,
});

/** Stage a synthetic row "ready" under the env's models root: 16 bytes. */
function stageSyn(env: NodeJS.ProcessEnv, row: CatalogModel): void {
  const dir = resolveModelDir(row.model_id, env);
  mkdirSync(dir, { recursive: true });
  for (const f of row.files) writeFileSync(join(dir, f.path), Buffer.alloc(f.size ?? 16));
}

describe('resolveReadyModelForLanguage — the §6 ladder (synthetic rows via the seam)', () => {
  const REC = T({ model_id: 'syn-ko-recommended', tier: 'recommended' });
  const MULTI = T({ model_id: 'syn-multi', tier: 'multilingual', spoken: ['ko', 'fr', 'zh'], loader: 'whisper' });
  const LITE = T({ model_id: 'syn-ko-lite', tier: 'lite' });
  const STREAMING = T({ model_id: 'syn-fr-streaming', spoken: ['fr'], tier: 'recommended', loader: 'streaming-transducer', streaming: 'streaming', files: [] });
  const CATALOG = [REC, MULTI, LITE, STREAMING];

  it('returns null when nothing is downloaded (→ the loud STT_CONFIG_MISSING at open)', async () => {
    const env = tempEnv();
    expect(await resolveReadyModelForLanguage('ko', env, { catalog: CATALOG, selection: {} })).toBeNull();
  });

  it('finds the one ready model claiming the language — and never lends it to another', async () => {
    const env = tempEnv();
    stageSyn(env, REC);
    const hit = await resolveReadyModelForLanguage('ko', env, { catalog: CATALOG, selection: {} });
    expect(hit?.row.model_id).toBe(REC.model_id);
    resetSherpaModelControllers();
    // 🔴 Task §3-3 (the model-form of the no-crosstalk red line): a language
    // the staged model does NOT claim must resolve to nothing — never borrow
    // the Korean pack for French.
    expect(await resolveReadyModelForLanguage('fr', env, { catalog: CATALOG, selection: {} })).toBeNull();
  });

  it('an explicit selection outranks tier order', async () => {
    const env = tempEnv();
    stageSyn(env, REC);
    stageSyn(env, MULTI);
    // Default order prefers the recommended tier…
    expect((await resolveReadyModelForLanguage('ko', env, { catalog: CATALOG, selection: {} }))?.row.model_id).toBe(REC.model_id);
    resetSherpaModelControllers();
    // …but a selection flips it.
    expect((await resolveReadyModelForLanguage('ko', env, { catalog: CATALOG, selection: { ko: MULTI.model_id } }))?.row.model_id).toBe(MULTI.model_id);
  });

  it('candidate order: recommended → multilingual → lite; streaming never appears', () => {
    const order = candidateRowsForLanguage('ko', {}, CATALOG).map((m) => m.model_id);
    expect(order).toEqual([REC.model_id, MULTI.model_id, LITE.model_id]);
    for (const m of candidateRowsForLanguage('fr', {}, CATALOG)) expect(m.streaming).not.toBe('streaming');
    // The REAL catalog obeys the same two properties (order + no streaming):
    const realRu = candidateRowsForLanguage('ru', {}).map((m) => m.tier);
    expect(realRu.indexOf('lite')).toBeGreaterThan(realRu.indexOf('recommended'));
    for (const m of candidateRowsForLanguage('fr', {})) expect(m.streaming).not.toBe('streaming');
  });

  it('a ready model whose files were changed stops resolving (stat-keyed memo invalidates)', async () => {
    const env = tempEnv();
    stageSyn(env, REC);
    expect((await resolveReadyModelForLanguage('ko', env, { catalog: CATALOG, selection: {} }))?.row.model_id).toBe(REC.model_id);
    // Truncate a file; the (size, mtime) stamp changes and the memo re-reads.
    const victim = join(resolveModelDir(REC.model_id, env), 'tokens.txt');
    expect(existsSync(victim)).toBe(true);
    writeFileSync(victim, Buffer.alloc(1)); // wrong size now
    expect(await resolveReadyModelForLanguage('ko', env, { catalog: CATALOG, selection: {} })).toBeNull();
  });
});

// ── the pointer file itself ──────────────────────────────────────────────────

describe('root pointer file shape', () => {
  it('is the documented one-key JSON, atomically written', () => {
    const env = tempEnv();
    const target = mkdtempSync(join(tmpdir(), 'flowmic-cat-ptr-'));
    setModelsRoot(target, env);
    const p = join(env.APPDATA!, 'FlowMic', 'stt-models-root.json');
    const body = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    expect(body).toEqual({ models_root: target });
  });
});
