import { describe, it, expect } from 'vitest';
import { safeParseEvent } from '../src/protocol-schemas';
import {
  ScenarioCardSchema,
  SCENARIO_MAX_ALIASES_PER_TERM,
  SCENARIO_MAX_TERMS,
  aliasesOf,
  termOf,
} from '../src/scenario';

// 2026-09-03 owner rulings (phone-owned preferences, transit not storage):
//   Q1  the personal dictionary merges into the scenario card — a term entry may
//       now be `{term, aliases?}` as well as the bare string it always was;
//   Q2b two-pass refine is delivered for real — `stt:final` and `stt:refined`
//       carry a server-minted `utterance_id` so the phone can target the row.
// Both are ADDITIVE: every frame and every card that parsed before still parses,
// and the event whitelist / count guard are untouched (payload fields only).

describe('scenario card terms: bare string OR {term, aliases}', () => {
  const base = { professions: [], domains: [], packs: [] };

  it('a v2 card with bare-string terms still parses byte-for-byte', () => {
    const r = ScenarioCardSchema.safeParse({ ...base, terms: ['FlowMic', '语流'] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.terms.map(termOf)).toEqual(['FlowMic', '语流']);
  });

  it('an aliased term parses and exposes its canonical + aliases', () => {
    const r = ScenarioCardSchema.safeParse({
      ...base,
      terms: ['bare', { term: 'Cursor', aliases: ['克舍', 'curser'] }, { term: 'Docker' }],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.terms.map(termOf)).toEqual(['bare', 'Cursor', 'Docker']);
    expect(aliasesOf(r.data.terms[1]!)).toEqual(['克舍', 'curser']);
    expect(aliasesOf(r.data.terms[0]!)).toEqual([]);
    expect(aliasesOf(r.data.terms[2]!)).toEqual([]);
  });

  it('refuses an empty canonical, an empty alias, and too many aliases', () => {
    expect(ScenarioCardSchema.safeParse({ ...base, terms: [{ term: '   ' }] }).success).toBe(false);
    expect(ScenarioCardSchema.safeParse({ ...base, terms: [{ term: 'a', aliases: [' '] }] }).success).toBe(false);
    const tooMany = { term: 'a', aliases: Array.from({ length: SCENARIO_MAX_ALIASES_PER_TERM + 1 }, (_, i) => `x${i}`) };
    expect(ScenarioCardSchema.safeParse({ ...base, terms: [tooMany] }).success).toBe(false);
    const justEnough = { term: 'a', aliases: Array.from({ length: SCENARIO_MAX_ALIASES_PER_TERM }, (_, i) => `x${i}`) };
    expect(ScenarioCardSchema.safeParse({ ...base, terms: [justEnough] }).success).toBe(true);
  });

  it('the terms cap counts entries, whatever their shape', () => {
    const terms = Array.from({ length: SCENARIO_MAX_TERMS + 1 }, (_, i) => (i % 2 ? `t${i}` : { term: `t${i}` }));
    expect(ScenarioCardSchema.safeParse({ ...base, terms }).success).toBe(false);
  });
});

describe('utterance_id rides stt:final and stt:refined, optionally', () => {
  const final = {
    text: 'hello', confidence: 0.9, language: 'en', segment_idx: 0, is_segment: false, duration_ms: 1200,
  };

  it('stt:final parses with and without utterance_id', () => {
    expect(safeParseEvent('stt:final', final).success).toBe(true);
    const r = safeParseEvent('stt:final', { ...final, utterance_id: 'u-abc' });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as { utterance_id?: string }).utterance_id).toBe('u-abc');
  });

  it('stt:refined parses with and without utterance_id; empty id is refused', () => {
    expect(safeParseEvent('stt:refined', { text: 'better' }).success).toBe(true);
    expect(safeParseEvent('stt:refined', { text: 'better', utterance_id: 'u-abc' }).success).toBe(true);
    expect(safeParseEvent('stt:refined', { text: 'better', utterance_id: '' }).success).toBe(false);
  });
});

// 2026-09-03 follow-up (owner ruling: the carrier changes). The bundle rides
// INSIDE `audio:start` / `compose:start` as an optional `prefs` field —
// additive, no new event, count guard untouched (events-count.test.ts).
import { PhonePrefsSchema } from '../src/phone-prefs';

describe('prefs on audio:start / compose:start — the phone-owned bundle rides the request', () => {
  const AUDIO = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };
  const COMPOSE = { task: 'organize', source_text: 'x' };
  const PREFS = {
    'scenario.card': { professions: ['eye surgeon'], domains: [], packs: [], terms: [{ term: 'Kubernetes', aliases: ['k8s'] }] },
    'stt.polish': { enabled: true, strength: 'smooth' },
    'stt.refine': { enabled: true, min_utterance_ms: 15000 },
    'scenario.inference': { granted: true, granted_for: 'local' },
  };

  it('both start frames parse WITHOUT prefs exactly as before (old phones)', () => {
    expect(safeParseEvent('audio:start', AUDIO).success).toBe(true);
    expect(safeParseEvent('compose:start', COMPOSE).success).toBe(true);
  });

  it('a full bundle parses on both frames and comes through verbatim', () => {
    const a = safeParseEvent('audio:start', { ...AUDIO, prefs: PREFS });
    const c = safeParseEvent('compose:start', { ...COMPOSE, prefs: PREFS });
    expect(a.success && c.success).toBe(true);
    if (a.success) expect(a.data.prefs).toEqual(PREFS);
    if (c.success) expect(c.data.prefs).toEqual(PREFS);
  });

  it('a partial bundle parses — an absent key means "unset", not "invalid"', () => {
    const r = safeParseEvent('audio:start', { ...AUDIO, prefs: { 'stt.refine': { enabled: false } } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.prefs).toEqual({ 'stt.refine': { enabled: false } });
  });

  it('a malformed value is refused at the wire, with the key named in the issue path', () => {
    const bad: [string, unknown][] = [
      ['scenario.card', { professions: [42], domains: [], packs: [], terms: [] }],
      ['stt.polish', { enabled: 'yes' }],
      ['stt.refine', []],
      ['scenario.inference', { granted: true, granted_for: 'cloud' }],
      ['scenario.inference', { granted: true, granted_for: 'local', extra: 1 }],
    ];
    for (const [key, value] of bad) {
      const r = PhonePrefsSchema.safeParse({ [key]: value });
      expect(r.success, `${key} ${JSON.stringify(value)}`).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.path[0]).toBe(key);
      expect(safeParseEvent('audio:start', { ...AUDIO, prefs: { [key]: value } }).success).toBe(false);
    }
  });

  it('an unknown key in the bundle is refused (strict) — the retired stt.dictionary cannot ride along', () => {
    expect(PhonePrefsSchema.safeParse({ 'stt.dictionary': [{ term: 'x' }] }).success).toBe(false);
    expect(PhonePrefsSchema.safeParse({}).success).toBe(true);
  });
});
