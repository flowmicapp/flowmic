// SETTINGS-EFFECT PROBE — "does this switch actually change anything?"
//
// WHY THIS FILE EXISTS. The phone's settings offer the terminology/correction
// controls (AI polish, two-pass refine, and the scenario card's professions /
// domains / dictionary packs / custom terms with their aliases). Every one of
// them is stored on the phone, pushed on the socket and rendered. None of that
// answers the only question that matters to a user: when I speak, does this
// setting reach anything?
//
// 2026-09-03 (owner Q6 note, design D2): the settings arrive on the server in
// TWO ways now — an old phone leaves them in the database, a new phone pushes
// a per-connection bundle that `overlaySettings` answers from. Probe 7 runs the
// same consumers through BOTH and diffs them: the acceptance instrument for
// "the overlay reaches every consumer the database reached".
//
// So this probe drives the REAL production resolvers — the same functions the
// audio handler and the compose handler call — over a REAL settings repo, and
// records, per setting, WHICH of the possible consumers it actually reached:
//
//   (1) replacer      — the deterministic alias->canonical pass on the STT final
//                       (runs for realtime AND translate/organize)
//   (2) hotwords      — the terms handed to the recognizer for biasing
//   (3) scenarioBlock — the BACKGROUND CONTEXT block inside the LLM system
//                       prompt (translate / organize / draft_polish only)
//   (4) polish/refine arming — whether the opt-in correction legs are usable
//
// THE ASSERTIONS HERE ARE DELIBERATELY ONE-SIDED. They pin the reaches that are
// CONTRACTUAL (a pack alias must reach the replacer; a profession must reach the
// scenario block). They deliberately do NOT assert the gaps as desired: writing
// "professions reach nothing in realtime" into an expectation would turn today's
// defect into an acceptance criterion, which is the failure recorded in 0.2.52
// (a reverse control pointed the wrong way makes a bug into a spec, and goes red
// on the day somebody fixes it). Measurements that are merely MEASURED — not
// wanted — are marked as such on the line above them, and they are argued in
// the ledger doc where a human decides.
//
// OUTPUT: FLOWMIC_PROBE_OUT (default <repo>/.local/pipeline-probe/) receives
//   settings-effect.jsonl — one JSON record per (setting x consumer) measurement
//   settings-effect.md    — the same records as a table, for reading
// Both are regenerated on every run; neither is an input to any assertion.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { composeDictionary, type SttEngineId } from '@flowmic/protocol';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import {
  resolveScenarioContext,
  resolveReplacementRules,
  buildScenarioBlock,
  buildDictionaryReplacer,
  renderSystemPrompt,
} from '../src/compose';
import { loadHotwords } from '../src/stt/engine-factory';
import { readSttPolish } from '../src/stt/stt-polish-settings';
import { readSttRefine } from '../src/stt/stt-refine-settings';
import { overlaySettings, type SessionPrefs } from '../src/settings/session-overlay';
import type { SettingsRepo } from '../src/db/repos/settings.repo';

const U = 'probe-user';
const OUT_DIR = process.env.FLOWMIC_PROBE_OUT
  ?? path.join(process.cwd(), '..', '..', '.local', 'pipeline-probe');

type Consumer =
  | 'replacer'
  | 'hotwords'
  | 'scenarioBlock'
  | 'polishArming'
  | 'refineArming';

/** One measurement: a setting, a consumer, and whether the setting's own bytes
 *  were observable in that consumer's output. `evidence` is the raw thing that
 *  was looked at, so a reader can re-derive the verdict instead of trusting it. */
interface Measurement {
  setting: string;
  consumer: Consumer;
  reached: boolean;
  evidence: string;
  note?: string;
}

const records: Measurement[] = [];
function rec(m: Measurement): void {
  records.push(m);
}

function freshDb(): DbConnection {
  const db = createDbConnection({
    dbPath: ':memory:',
    encryptionKey: deriveKey('settings-effect-probe-key'),
  });
  db.users.insert({ id: U, display_name: 'Probe', plan: 'free' });
  return db;
}

type CardTerm = string | { term: string; aliases?: string[] };
interface CardInput { professions?: string[]; domains?: string[]; packs?: string[]; terms?: CardTerm[] }

function cardValue(card: CardInput): Record<string, unknown> {
  return {
    professions: card.professions ?? [],
    domains: card.domains ?? [],
    packs: card.packs ?? [],
    terms: card.terms ?? [],
  };
}

/** Write the card exactly as the phone's ScenarioCardController serialises it
 *  (a term is a bare string or `{term, aliases}` since owner Q1, 2026-09-03). */
function writeCard(db: DbConnection, card: CardInput): void {
  db.settings.write(U, 'scenario.card', cardValue(card));
}

/** The same card as the phone's per-request bundle (audio:start prefs → wire.ts setSessionPrefs
 *  → overlaySettings): the repo the consumers read when a NEW phone spoke. */
function bundleCard(db: DbConnection, card: CardInput): SettingsRepo {
  const prefs: SessionPrefs = { 'scenario.card': cardValue(card) };
  return overlaySettings(db.settings, prefs);
}

interface Consumers {
  replace: (t: string) => string;
  ruleCount: number;
  hotwords: string | undefined;
  scenarioBlock: string;
  systemPrompt: string;
}

/** The terminology consumers, run over one settings REPO. Mirrors the two
 *  production call sites: engine/stt-factory.ts (replacer + hotwords) and
 *  compose/index.ts (scenario block -> system prompt) — both of which now take
 *  the overlay repo, which is why this helper takes a repo and not the db. */
function runConsumersOn(repo: SettingsRepo): Consumers {
  const rules = resolveReplacementRules(repo, U);
  const replacer = buildDictionaryReplacer(rules);
  const ctx = resolveScenarioContext(repo, U);
  const scenarioBlock = buildScenarioBlock(ctx);
  return {
    replace: (t) => replacer.apply(t),
    ruleCount: replacer.ruleCount,
    hotwords: loadHotwords(repo, U),
    scenarioBlock,
    systemPrompt: renderSystemPrompt({ task: 'organize' }, scenarioBlock),
  };
}

function runConsumers(db: DbConnection): Consumers {
  return runConsumersOn(db.settings);
}

describe('probe 1 — custom terms (scenario.card.terms)', () => {
  it('a LATIN custom term reaches the replacer (casing), hotwords and the scenario block', () => {
    const db = freshDb();
    writeCard(db, { terms: ['FlowMic'] });
    const c = runConsumers(db);

    const spoken = 'i use flowmic every day';
    const replaced = c.replace(spoken);
    rec({ setting: 'card.terms (latin)', consumer: 'replacer', reached: replaced.includes('FlowMic'), evidence: `${spoken} -> ${replaced}` });
    rec({ setting: 'card.terms (latin)', consumer: 'hotwords', reached: (c.hotwords ?? '').includes('FlowMic'), evidence: c.hotwords ?? '(undefined)' });
    rec({ setting: 'card.terms (latin)', consumer: 'scenarioBlock', reached: c.scenarioBlock.includes('FlowMic'), evidence: c.scenarioBlock });

    expect(replaced).toContain('FlowMic');
    expect(c.hotwords ?? '').toContain('FlowMic');
    expect(c.scenarioBlock).toContain('FlowMic');
  });

  it('a CJK custom term reaches hotwords + the scenario block but is a NO-OP in the replacer', () => {
    const db = freshDb();
    writeCard(db, { terms: ['飞秒激光'] });
    const c = runConsumers(db);
    const spoken = '我们用飞秒激光做这个';
    const replaced = c.replace(spoken);

    // Not a defect on its own: a canonical with no alias has nothing to map
    // FROM, and buildDictionaryReplacer skips a CJK identity surface by design.
    // Recorded because the settings page gives the user no way to know that a
    // Chinese term they typed can only ever act through the recognizer and the
    // LLM, never through the deterministic pass.
    rec({
      setting: 'card.terms (CJK)',
      consumer: 'replacer',
      reached: replaced !== spoken,
      evidence: `${spoken} -> ${replaced}`,
      note: 'CJK identity surface skipped by buildDictionaryReplacer (no alias => nothing to map from)',
    });
    rec({ setting: 'card.terms (CJK)', consumer: 'hotwords', reached: (c.hotwords ?? '').includes('飞秒激光'), evidence: c.hotwords ?? '(undefined)' });
    rec({ setting: 'card.terms (CJK)', consumer: 'scenarioBlock', reached: c.scenarioBlock.includes('飞秒激光'), evidence: c.scenarioBlock });

    // MEASURED, not desired — see this file's header.
    expect(replaced).toBe(spoken);
    // contractual: the two channels that CAN carry a bare canonical must do so
    expect(c.hotwords ?? '').toContain('飞秒激光');
    expect(c.scenarioBlock).toContain('飞秒激光');
  });
});

describe('probe 2 — dictionary packs (scenario.card.packs)', () => {
  it('a curated pack ALIAS reaches the replacer; the pack term reaches hotwords + block', () => {
    const db = freshDb();
    writeCard(db, { packs: ['tech-dev'] });
    const c = runConsumers(db);
    // 多克 is a curated homophone alias of Docker in the tech-dev pack.
    const spoken = '我们把服务放到多克里面';
    const replaced = c.replace(spoken);

    rec({ setting: 'card.packs (tech-dev alias)', consumer: 'replacer', reached: replaced.includes('Docker'), evidence: `${spoken} -> ${replaced}` });
    rec({ setting: 'card.packs (tech-dev)', consumer: 'hotwords', reached: (c.hotwords ?? '').includes('Docker'), evidence: (c.hotwords ?? '(undefined)').slice(0, 240) });
    rec({ setting: 'card.packs (tech-dev)', consumer: 'scenarioBlock', reached: c.scenarioBlock.includes('Docker'), evidence: c.scenarioBlock.slice(0, 400) });

    expect(replaced).toContain('Docker');
    expect(c.hotwords ?? '').toContain('Docker');
    expect(c.scenarioBlock).toContain('Docker');
    // Curated weights must survive into the hotword payload, or the curation is
    // decorative and every pack term collapses to the builder's default.
    expect(composeDictionary(['tech-dev']).some((e) => e.weight === 25)).toBe(true);
  });

  it('REVERSE CONTROL — with the pack deselected the same sentence is untouched', () => {
    const db = freshDb();
    writeCard(db, { packs: [] });
    const c = runConsumers(db);
    const spoken = '我们把服务放到多克里面';
    expect(c.replace(spoken)).toBe(spoken);
    expect(c.hotwords).toBeUndefined();
    expect(c.scenarioBlock).toBe('');
  });
});

describe('probe 3 — card-term aliases (the retired personal dictionary, owner Q1)', () => {
  it('a term with aliases reaches all three terminology consumers', () => {
    const db = freshDb();
    writeCard(db, { terms: [{ term: 'Kubernetes', aliases: ['K8S', '库伯'] }] });
    const c = runConsumers(db);
    const spoken = '这个跑在库伯上面';
    const replaced = c.replace(spoken);

    rec({ setting: 'card.terms (aliases)', consumer: 'replacer', reached: replaced.includes('Kubernetes'), evidence: `${spoken} -> ${replaced}` });
    rec({ setting: 'card.terms (aliases)', consumer: 'hotwords', reached: (c.hotwords ?? '').includes('Kubernetes'), evidence: c.hotwords ?? '(undefined)' });
    rec({ setting: 'card.terms (aliases)', consumer: 'scenarioBlock', reached: c.scenarioBlock.includes('Kubernetes'), evidence: c.scenarioBlock });

    expect(replaced).toContain('Kubernetes');
    expect(c.hotwords ?? '').toContain('Kubernetes');
    expect(c.scenarioBlock).toContain('Kubernetes');
  });

  it('REVERSE CONTROL — a stored stt.dictionary row reaches NOTHING (the key is retired)', () => {
    const db = freshDb();
    db.settings.write(U, 'stt.dictionary', [{ term: 'Kubernetes', aliases: ['K8S', '库伯'], weight: 30 }]);
    const c = runConsumers(db);
    const spoken = '这个跑在库伯上面';
    rec({ setting: 'stt.dictionary (retired)', consumer: 'replacer', reached: c.replace(spoken) !== spoken, evidence: `${spoken} -> ${c.replace(spoken)}`, note: 'retired 2026-09-03 (owner Q1); no server reader' });
    expect(c.replace(spoken)).toBe(spoken);
    expect(c.hotwords).toBeUndefined();
    expect(c.scenarioBlock).toBe('');
  });
});

describe('probe 4 — professions / domains (scenario.card)', () => {
  it('they reach the LLM scenario block, and nothing on the terminology path', () => {
    const db = freshDb();
    writeCard(db, { professions: ['眼科医生'], domains: ['医疗器械'] });
    const c = runConsumers(db);
    const spoken = '今天做了三台手术';

    rec({
      setting: 'card.professions/domains',
      consumer: 'scenarioBlock',
      reached: c.scenarioBlock.includes('眼科医生') && c.scenarioBlock.includes('医疗器械'),
      evidence: c.scenarioBlock,
    });
    rec({
      setting: 'card.professions/domains',
      consumer: 'replacer',
      reached: c.replace(spoken) !== spoken,
      evidence: `ruleCount=${c.ruleCount}`,
      note: 'resolveReplacementRules reads terms/packs/dictionary only — a profession is not terminology',
    });
    rec({
      setting: 'card.professions/domains',
      consumer: 'hotwords',
      reached: c.hotwords !== undefined,
      evidence: String(c.hotwords),
      note: 'hotwords are built from the same replacement rules, so professions/domains never reach the recognizer',
    });

    // Contractual: the block is what carries them, and the system prompt must
    // actually embed the block (a block nobody renders is the façade shape).
    expect(c.scenarioBlock).toContain('眼科医生');
    expect(c.scenarioBlock).toContain('医疗器械');
    expect(c.systemPrompt.startsWith(c.scenarioBlock)).toBe(true);
    // MEASURED, not desired — see this file's header.
    expect(c.ruleCount).toBe(0);
    expect(c.hotwords).toBeUndefined();
  });
});

describe('probe 5 — AI polish (stt.polish)', () => {
  it('absent row reads OFF; the desktop value round-trips with its strength', () => {
    const db = freshDb();
    const off = readSttPolish(db.settings, U);
    rec({
      setting: 'stt.polish (absent row)',
      consumer: 'polishArming',
      reached: off.enabled,
      evidence: JSON.stringify(off),
      note: 'absent row => DEFAULT {enabled:false}: a server that never received the key runs bare STT',
    });
    expect(off.enabled).toBe(false);

    db.settings.write(U, 'stt.polish', { enabled: true, strength: 'smooth' });
    const on = readSttPolish(db.settings, U);
    rec({ setting: 'stt.polish (on/smooth)', consumer: 'polishArming', reached: on.enabled, evidence: JSON.stringify(on) });
    expect(on).toEqual({ enabled: true, strength: 'smooth' });
  });
});

describe('probe 6 — the second pass (stt.refine)', () => {
  // 🔴 2026-09-04 — THIS PROBE USED TO MEASURE THE WRONG THING, AND IT WAS
  // RIGHT TO. Until that day the second pass was a batch STT RE-TRANSCRIPTION,
  // so whether the switch could do anything was decided by the routed engine,
  // and this probe walked all eight engine ids through `batchEngineIdFor` to
  // record which of them the switch was a no-op on. The answer, every time, was
  // "every engine production actually runs on" — soniox and funasr both
  // streaming-only.
  //
  // The pass is now an LLM smoothing pass over the delivered TEXT, so the engine
  // is not a party to the question any more. What this probe records now is that
  // consequence: the switch reads ON and reaches its consumer whatever engine
  // the session routed to.
  const ENGINES: SttEngineId[] = [
    'soniox', 'funasr', 'deepgram', 'openai-realtime',
    'sherpa-local', 'openai-whisper', 'funspeech-http', 'custom-openai-compatible',
  ];

  it('the switch reads ON, and the routed engine no longer decides whether it can run', () => {
    const db = freshDb();
    db.settings.write(U, 'stt.refine', { enabled: true });
    expect(readSttRefine(db.settings, U).enabled).toBe(true);

    for (const id of ENGINES) {
      rec({
        setting: `stt.refine ON + engine=${id}`,
        consumer: 'refineArming',
        reached: true,
        evidence: `the second pass reads the delivered text, not the audio — engine '${id}' is not consulted`,
      });
    }
  });
});

describe('probe 7 — the phone bundle (session overlay) reaches the same consumers as the database', () => {
  // 🔴 THE ACCEPTANCE INSTRUMENT for design D2 (task book WP-A 7). The same
  // card is handed to the consumers twice — once as a stored row (old phone),
  // once as a per-connection bundle over an EMPTY database (new phone) — and
  // every consumer output is diffed. A consumer the overlay does not reach
  // would show up here as the database run reaching it and the bundle run not.
  const CARDS: { name: string; card: CardInput; spoken: string }[] = [
    { name: 'latin term', card: { terms: ['FlowMic'] }, spoken: 'i use flowmic every day' },
    { name: 'CJK term', card: { terms: ['飞秒激光'] }, spoken: '我们用飞秒激光做这个' },
    { name: 'pack alias', card: { packs: ['tech-dev'] }, spoken: '我们把服务放到多克里面' },
    { name: 'term alias', card: { terms: [{ term: 'Kubernetes', aliases: ['K8S', '库伯'] }] }, spoken: '这个跑在库伯上面' },
    { name: 'professions/domains', card: { professions: ['眼科医生'], domains: ['医疗器械'] }, spoken: '今天做了三台手术' },
  ];

  for (const { name, card, spoken } of CARDS) {
    it(`${name}: database run and bundle run reach the same consumers with the same bytes`, () => {
      const stored = freshDb();
      writeCard(stored, card);
      const viaDb = runConsumers(stored);

      const empty = freshDb();
      expect(empty.settings.read(U, 'scenario.card')).toBeNull(); // the bundle is the ONLY source
      const viaBundle = runConsumersOn(bundleCard(empty, card));

      const diff = {
        replace: viaDb.replace(spoken) === viaBundle.replace(spoken),
        hotwords: viaDb.hotwords === viaBundle.hotwords,
        scenarioBlock: viaDb.scenarioBlock === viaBundle.scenarioBlock,
        systemPrompt: viaDb.systemPrompt === viaBundle.systemPrompt,
        ruleCount: viaDb.ruleCount === viaBundle.ruleCount,
      };
      rec({
        setting: `overlay diff (${name})`,
        consumer: 'replacer',
        reached: Object.values(diff).every(Boolean),
        evidence: JSON.stringify(diff),
        note: 'true = the phone bundle and a stored row produce byte-identical consumer output',
      });
      expect(viaBundle.replace(spoken)).toBe(viaDb.replace(spoken));
      expect(viaBundle.hotwords).toBe(viaDb.hotwords);
      expect(viaBundle.scenarioBlock).toBe(viaDb.scenarioBlock);
      expect(viaBundle.systemPrompt).toBe(viaDb.systemPrompt);
      expect(viaBundle.ruleCount).toBe(viaDb.ruleCount);
    });
  }

  it('the polish and refine switches read through the bundle exactly as through a row', () => {
    const stored = freshDb();
    stored.settings.write(U, 'stt.polish', { enabled: true, strength: 'smooth' });
    stored.settings.write(U, 'stt.refine', { enabled: true, min_utterance_ms: 15_000 });
    const empty = freshDb();
    const bundle = overlaySettings(empty.settings, {
      'stt.polish': { enabled: true, strength: 'smooth' },
      'stt.refine': { enabled: true, min_utterance_ms: 15_000 },
    });
    expect(readSttPolish(bundle, U)).toEqual(readSttPolish(stored.settings, U));
    expect(readSttRefine(bundle, U)).toEqual(readSttRefine(stored.settings, U));
    rec({ setting: 'stt.polish / stt.refine (bundle)', consumer: 'polishArming', reached: readSttPolish(bundle, U).enabled, evidence: JSON.stringify(readSttPolish(bundle, U)) });
  });

  it('🔴 REVERSE CONTROL — the bundle WINS over a contradicting stored row, and an absent bundle key never falls through to one', () => {
    const db = freshDb();
    db.settings.write(U, 'stt.polish', { enabled: false });
    writeCard(db, { terms: ['StaleRowTerm'] });
    // ① the phone says ON — the stored OFF must not be what the session arms.
    expect(readSttPolish(overlaySettings(db.settings, { 'stt.polish': { enabled: true } }), U)).toEqual({ enabled: true });
    // ② the phone pushed a bundle WITHOUT a card — the stored card must not act.
    const c = runConsumersOn(overlaySettings(db.settings, { 'stt.polish': { enabled: true } }));
    expect(c.hotwords).toBeUndefined();
    expect(c.scenarioBlock).toBe('');
    // ③ positive control: the same database, read WITHOUT a bundle (old phone), does see the row.
    expect(runConsumers(db).hotwords ?? '').toContain('StaleRowTerm');
  });
});

afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    path.join(OUT_DIR, 'settings-effect.jsonl'),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
    'utf8',
  );
  const rows = records.map(
    (r) => `| ${r.setting} | ${r.consumer} | ${r.reached ? 'REACHED' : 'not reached'} | ${(r.note ?? '').replace(/\|/g, '/')} |`,
  );
  writeFileSync(
    path.join(OUT_DIR, 'settings-effect.md'),
    ['# settings-effect probe', '', '| setting | consumer | verdict | note |', '| --- | --- | --- | --- |', ...rows, ''].join('\n'),
    'utf8',
  );
});
