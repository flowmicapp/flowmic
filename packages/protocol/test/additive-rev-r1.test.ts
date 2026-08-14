import { describe, it, expect } from 'vitest';
import { EVENT_SCHEMAS, safeParseEvent } from '../src/protocol-schemas';
import {
  PROTOCOL_SCHEMA_VERSION,
  SETTINGS_KEY_SCENARIO_CARD,
} from '../src/constants';
import {
  ScenarioCardSchema,
  SCENARIO_MAX_LABEL_LEN,
  SCENARIO_MAX_PROFESSIONS,
  SCENARIO_MAX_DOMAINS,
  SCENARIO_MAX_PACKS,
  SCENARIO_MAX_TERMS,
} from '../src/scenario';

// WP-R1-1 additive rev (0.1.0 -> 0.2.0, PROTOCOL_SCHEMA_VERSION 1 -> 2):
//   1. status five-state (injected|cached|failed|noted) + `edited` overlay bit
//      — the sole non-additive change ('edited' STATUS VALUE removed).
//   2. audio:start.delivery (inject|none), additive/optional, omission=inject.
//   3. ScenarioCard structured settings shape + limits.
// Every v1 sample (minus the removed status:'edited') MUST still parse.

// A v1-shaped history item, minus status/edited which each test supplies.
const baseHistoryItem = {
  id: 'h1',
  pairing_id: null,
  pc_device_id: 'pc1',
  user_id: 'u1',
  mobile_id: null,
  mode: 'realtime',
  source_text: null,
  source_lang: null,
  output_text: 'hello world',
  output_lang: null,
  duration_ms: null,
  segments_count: 0,
  created_at: '2026-07-23T00:00:00.000Z',
  updated_at: '2026-07-23T00:00:00.000Z',
} as const;

const historyItem = (extra: Record<string, unknown>) =>
  safeParseEvent('history:create', { item: { ...baseHistoryItem, ...extra } });

const baseAudioStart = {
  sample_rate: 16_000,
  channels: 1,
  encoding: 'pcm_s16le',
  mode: 'realtime',
  source_lang: 'zh-CN',
} as const;

const audioStart = (extra: Record<string, unknown>) =>
  safeParseEvent('audio:start', { ...baseAudioStart, ...extra });

describe('WP-R1-1 status five-state (delivery truth only)', () => {
  for (const status of ['injected', 'cached', 'failed', 'noted'] as const) {
    it(`accepts status '${status}'`, () => {
      expect(historyItem({ status }).success).toBe(true);
    });
  }

  it("rejects the removed 'edited' STATUS value (non-additive change guard)", () => {
    expect(historyItem({ status: 'edited' }).success).toBe(false);
  });
});

describe('WP-R1-1 edited overlay bit', () => {
  it('accepts edited: true', () => {
    expect(historyItem({ status: 'injected', edited: true }).success).toBe(true);
  });
  it('accepts edited: false', () => {
    expect(historyItem({ status: 'injected', edited: false }).success).toBe(true);
  });
  it('accepts an item with NO edited field (v1 compat — absence = false)', () => {
    expect(historyItem({ status: 'injected' }).success).toBe(true);
  });
  it('rejects a non-boolean edited', () => {
    expect(historyItem({ status: 'injected', edited: 'yes' }).success).toBe(false);
  });
  it('edited combines with the record-only noted state', () => {
    expect(historyItem({ status: 'noted', edited: true }).success).toBe(true);
  });
});

describe('WP-R1-1 audio:start.delivery', () => {
  it("accepts delivery 'inject'", () => {
    expect(audioStart({ delivery: 'inject' }).success).toBe(true);
  });
  it("accepts delivery 'none' (record-only)", () => {
    expect(audioStart({ delivery: 'none' }).success).toBe(true);
  });
  it('accepts a v1 audio:start with NO delivery field (omission = inject)', () => {
    expect(audioStart({}).success).toBe(true);
  });
  it('rejects an unknown delivery value', () => {
    expect(audioStart({ delivery: 'broadcast' }).success).toBe(false);
  });
});

describe('WP-R1-1 ScenarioCard', () => {
  const fullCard = {
    professions: ['软件开发者', 'IT'],
    domains: ['distributed systems'],
    packs: ['tech-dev', 'proper-noun'],
    terms: ['FlowMic', 'Kubernetes', 'zod'],
  };

  it('accepts a fully-populated card', () => {
    expect(ScenarioCardSchema.safeParse(fullCard).success).toBe(true);
  });

  it('accepts an empty card (all arrays empty)', () => {
    const r = ScenarioCardSchema.safeParse({ professions: [], domains: [], packs: [], terms: [] });
    expect(r.success).toBe(true);
  });

  it('rejects a card missing a required array key', () => {
    const { terms, ...noTerms } = fullCard;
    expect(ScenarioCardSchema.safeParse(noTerms).success).toBe(false);
  });

  it('rejects a term longer than the per-entry cap', () => {
    const term = 'x'.repeat(SCENARIO_MAX_LABEL_LEN + 1);
    expect(ScenarioCardSchema.safeParse({ ...fullCard, terms: [term] }).success).toBe(false);
  });

  it('rejects a whitespace-only term (trim >= 1)', () => {
    expect(ScenarioCardSchema.safeParse({ ...fullCard, terms: ['   '] }).success).toBe(false);
  });

  it('trims surrounding whitespace on a term', () => {
    const parsed = ScenarioCardSchema.parse({ ...fullCard, terms: ['  spaced  '] });
    expect(parsed.terms[0]).toBe('spaced');
  });

  it('rejects a profession longer than the per-entry cap', () => {
    const prof = 'p'.repeat(SCENARIO_MAX_LABEL_LEN + 1);
    expect(ScenarioCardSchema.safeParse({ ...fullCard, professions: [prof] }).success).toBe(false);
  });

  it('rejects more than the max professions/domains/packs/terms', () => {
    const fill = (n: number, v: string) => Array.from({ length: n }, (_, i) => `${v}${i}`);
    expect(
      ScenarioCardSchema.safeParse({ ...fullCard, professions: fill(SCENARIO_MAX_PROFESSIONS + 1, 'p') }).success,
    ).toBe(false);
    expect(
      ScenarioCardSchema.safeParse({ ...fullCard, domains: fill(SCENARIO_MAX_DOMAINS + 1, 'd') }).success,
    ).toBe(false);
    expect(
      ScenarioCardSchema.safeParse({ ...fullCard, packs: fill(SCENARIO_MAX_PACKS + 1, 'k') }).success,
    ).toBe(false);
    expect(
      ScenarioCardSchema.safeParse({ ...fullCard, terms: fill(SCENARIO_MAX_TERMS + 1, 't') }).success,
    ).toBe(false);
  });

  it('accepts exactly the max terms (boundary)', () => {
    const terms = Array.from({ length: SCENARIO_MAX_TERMS }, (_, i) => `t${i}`);
    expect(ScenarioCardSchema.safeParse({ ...fullCard, terms }).success).toBe(true);
  });
});

describe('WP-R1-1 version + settings keys', () => {
  it('PROTOCOL_SCHEMA_VERSION is bumped to 2', () => {
    expect(PROTOCOL_SCHEMA_VERSION).toBe(2);
  });
  it('names the scenario.card settings key', () => {
    expect(SETTINGS_KEY_SCENARIO_CARD).toBe('scenario.card');
  });
  // RETIRED 2026-07-31 (0.2.27): this pinned the device-local sync-noted key and
  // its `false` default. Both are gone with room sync for transcripts (owner
  // 架构裁定 no-cloud-sync) — the red line they encoded (「仅记录」stays on the
  // phone) is now unconditional instead of a default, so there is no value left
  // to pin. Deleting the assertion rather than weakening it: a test that asserts
  // a constant nobody can consume pins nothing.
});

describe('WP-R1-1 v1 backward compatibility', () => {
  it('a full v1 history item (no edited field) still round-trips through EVENT_SCHEMAS', () => {
    const r = EVENT_SCHEMAS['history:create'].safeParse({
      item: { ...baseHistoryItem, status: 'cached' },
    });
    expect(r.success).toBe(true);
  });
  it('a v1 audio:start (no send_policy, no delivery) still parses', () => {
    expect(safeParseEvent('audio:start', baseAudioStart).success).toBe(true);
  });
});
