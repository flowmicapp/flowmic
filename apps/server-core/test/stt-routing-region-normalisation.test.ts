// Owner ruling 2026-08-27 section 2-2: routing must match a language tag to a
// routing row after stripping the region, on BOTH sides.
//
// ── THE DEFECT, AS THE OWNER MET IT ─────────────────────────────────────────
// `selectRoutingWithSource` compared `c.language === language`, a raw string
// equality. The desktop's pre-first-sync placeholder row was authored as
// `zh-CN` (settings-model.ts) while the phone announces the spoken language as
// `zh` and the server seeds `zh`. So a user who had ever opened the desktop
// settings page owned a `zh-CN` row that could not be selected by any Chinese
// utterance — it fell through to whatever `'*'` said, or to
// SttConfigMissingError when they had no `'*'`. The row was on screen. It was
// unreachable. Nothing anywhere said so.
//
// It is the repo's oldest shape wearing a new coat: `zh-CN` and `zh` are one
// question ("which language is this person speaking") answered in two
// vocabularies, and the layer holding both never reconciled them.
//
// ── 🔴 REVERSE CONTROL, ACTUALLY RUN ────────────────────────────────────────
// The two cases marked REVERSE CONTROL below were written and run against the
// UNMODIFIED router first. VERBATIM READING, 2026-08-27, machine dev-pc-a:
//
//   × region normalisation in routing selection > 🔴 REVERSE CONTROL — a user's
//     'zh-CN' row is selected by a 'zh' utterance
//   AssertionError: a user's zh-CN row must serve a zh utterance: expected
//   'sherpa-local' to be 'funasr'
//
//   × region normalisation in routing selection > 🔴 REVERSE CONTROL — a 'zh'
//     row is selected by a 'zh-CN' utterance (the other direction)
//   AssertionError: expected null not to be null
//
// (The `❯ file:line:col` frames vitest printed are deliberately NOT quoted: a
// line number in this file's own header rots on the next edit of this file, and
// `verify:lint coordinate-anchors` says so — it caught exactly that here. The
// test NAMES are the durable coordinates.)
//
//   Test Files  1 failed (1)
//        Tests  5 failed | 3 passed (8)
//
// The first reading is the owner's bug in one line: the wildcard answered, so
// the user's own Chinese row was silently overridden by their catch-all.
//
// FIVE, not two: the three non-REVERSE-CONTROL failures were the same defect
// seen from the other cases (`expected undefined to be 'funasr'`, `expected
// 'seed' to be 'user'`, `expected undefined to be 'seed'`). That is worth the
// line — a reverse control whose siblings all happen to fail too is measuring
// one defect from four angles, not four defects, and reading the count as four
// would overstate what this file covers. All 8 are green after the change.
//
// ── AND THE CONTROL THAT MATTERS MORE ───────────────────────────────────────
// Normalisation that is too eager is a WORSE bug than the one it fixes, because
// it routes speech to an engine that cannot recognise it and the user gets
// confident wrong text instead of an error. So the last cases pin that `ja`
// never reaches a `zh` row, that `'*'` is not a base language, and that the
// user-beats-seed precedence is unchanged at every rung — the normalised rung
// is inserted INSIDE each authorship tier, never across tiers.

import { describe, expect, it } from 'vitest';
import { selectRouting, selectRoutingWithSource, type Routing } from '../src/stt/engine-router';

/** A user-authored row (no provenance marker ⇒ 'user', see engine-router). */
const U = (language: string, engine_id: Routing['engine_id']): Routing => ({ language, engine_id });
/** A seeded row, marked the way settings/provenance.ts marks them. */
const S = (language: string, engine_id: Routing['engine_id']): Routing => ({
  language,
  engine_id,
  provenance: 'seed',
});

describe('region normalisation in routing selection', () => {
  it('exact match still wins over everything — normalisation is a SECOND rung, not a replacement', () => {
    const rows = [U('zh-CN', 'funasr'), U('zh', 'sherpa-local')];
    // 'zh' is an exact hit on the second row; the first must not be preferred
    // just because it also normalises to 'zh'.
    expect(selectRouting('zh', rows)?.engine_id).toBe('sherpa-local');
    // …and 'zh-CN' is an exact hit on the first.
    expect(selectRouting('zh-CN', rows)?.engine_id).toBe('funasr');
  });

  it('🔴 REVERSE CONTROL — a user\'s zh-CN row is selected by a zh utterance', () => {
    const rows = [U('zh-CN', 'funasr'), U('*', 'sherpa-local')];
    expect(
      selectRouting('zh', rows)?.engine_id,
      'a user\'s zh-CN row must serve a zh utterance',
    ).toBe('funasr');
  });

  it('🔴 REVERSE CONTROL — a zh row is selected by a zh-CN utterance (the other direction)', () => {
    // The phone can announce either form depending on where the tag came from,
    // so normalising only the ROW would leave half the defect standing.
    const rows = [U('zh', 'funasr')];
    const got = selectRouting('zh-CN', rows);
    expect(got).not.toBeNull();
    expect(got?.engine_id).toBe('funasr');
  });

  it('CONTROL — normalisation never lets ja reach a zh row', () => {
    // The whole hazard of this change in one case: a too-eager normaliser sends
    // Japanese to a Chinese recogniser, which answers confidently and wrongly.
    // A refusal is the correct outcome and it must stay the outcome.
    expect(selectRouting('ja', [U('zh', 'funasr')])).toBeNull();
    expect(selectRouting('ja-JP', [U('zh-CN', 'funasr')])).toBeNull();
    // …and the near-miss inside one base: zh-TW and zh-CN DO share a base, and
    // that is deliberate (owner: 简体/繁体 is one spoken language).
    expect(selectRouting('zh-TW', [U('zh-CN', 'funasr')])?.engine_id).toBe('funasr');
  });

  it('CONTROL — the wildcard is not a base language', () => {
    // `'*'.split('-')[0]` is `'*'`, so a naive implementation would let the
    // normalised rung match the wildcard row and thereby promote it above the
    // managed default. It must keep serving from the LAST rung only.
    const managed: Routing = { language: '*', engine_id: 'deepgram' };
    const got = selectRoutingWithSource('zh', [U('*', 'sherpa-local')], () => managed);
    expect(got?.source).toBe('user');
    expect(got?.routing.engine_id).toBe('sherpa-local');
    // With no user row at all the managed default still outranks a seeded one.
    const seededOnly = selectRoutingWithSource('zh', [S('zh', 'sherpa-local')], () => managed);
    expect(seededOnly?.source).toBe('managed-default');
  });

  it('authorship still dominates: a user\'s normalised row beats a SEEDED exact row', () => {
    // The 2026-08-06 provenance ruling, restated at the new rung. A user's
    // zh-CN row is the user's stated choice for Chinese; the platform's zh row
    // is not. Inserting normalisation inside each tier keeps that ordering —
    // inserting it across tiers would quietly undo it.
    const rows = [U('zh-CN', 'funasr'), S('zh', 'sherpa-local')];
    const got = selectRoutingWithSource('zh', rows);
    expect(got?.source).toBe('user');
    expect(got?.routing.engine_id).toBe('funasr');
  });

  it('a seeded normalised row still serves when the user has nothing', () => {
    const got = selectRoutingWithSource('zh-CN', [S('zh', 'sherpa-local')]);
    expect(got?.source).toBe('seed');
    expect(got?.routing.engine_id).toBe('sherpa-local');
  });

  it('an unhealthy engine at the normalised rung is skipped like any other', () => {
    // Health filtering has to apply per candidate, not per rung, or a sick
    // normalised match would shadow a healthy wildcard.
    const rows = [U('zh-CN', 'funasr'), U('*', 'sherpa-local')];
    const got = selectRouting('zh', rows, undefined, (id) => id !== 'funasr');
    expect(got?.engine_id).toBe('sherpa-local');
  });
});
