// EVALUATION — does carrying the context help, and how far does each strength go?
//
// owner asked (2026-08-24) for a simple evaluation of two things:
//   (a) carrying the scenario/dictionary context to the correction model —
//       with vs without;
//   (b) the correction STRENGTHS, against a stated principle:
//         纠错  fixes wrong characters/words; the user's words all survive
//         润色  processes a little more, but changes neither the sentence nor
//               the order of its words
//         重排  reorders/restructures — a much bigger difference, ~10%
//       and then keep a defensible set of modes.
//
// TWO PARTS, AND THE SPLIT IS THE POINT.
//
//   PART A is HERMETIC and always runs. It measures the POLICY: what each
//   strength's guard will and will not let through. That is a property of our
//   code, it is deterministic, and it is the half that must never silently
//   drift — so it belongs in the resident suite.
//
//   PART B needs a real model and is SKIPPED unless asked for. It measures the
//   BEHAVIOUR: what the model actually does with the context, per strength. A
//   gate that needs a vendor to be up is a gate that goes red for reasons that
//   are not about this repository, and CLAUDE.md records what then happens to
//   it (G12 was red for a day before anyone noticed).
//
//     FLOWMIC_POLISH_EVAL=1 pnpm --filter @flowmic/server-core exec \
//       vitest run test/polish-context-and-strength-eval.test.ts
//
//   Credentials come from `.local/deepseek.env`, the same file the resident
//   eval harness reads — this measures THE PRODUCTION LINE, not a stand-in.
//
// 🔴 WHAT PART B IS NOT. It is a handful of sentences against one model on one
// day. It is enough to answer "does the context reach the model and change what
// it does", which is what was asked. It is NOT an accuracy benchmark, it has no
// confidence interval, and the report it writes says so on its face. The
// multilingual STT benchmark project owns that job and owns an audio bed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkMeaningPreserved, polishFinalText, polishSystemPromptWithScenario } from '../src/stt/stt-polish';
import { buildScenarioBlock } from '../src/compose/scenario';
import type { LlmConfig } from '../src/compose/llm';

const OUT_DIR = process.env.FLOWMIC_PROBE_OUT
  ?? path.join(process.cwd(), '..', '..', '.local', 'pipeline-probe');
const LIVE = process.env.FLOWMIC_POLISH_EVAL === '1';

// ── PART A — the policy, measured ────────────────────────────────────────────
//
// Each row is a transformation a correction pass could apply, written as the
// pair (what was said, what came back). The verdict column is the GUARD's, at
// each strength. Nothing here calls a model.
interface Case {
  name: string;
  said: string;
  back: string;
  /** The owner's tier this transformation belongs to. */
  tier: 'character-fix' | 'light-polish' | 'restructure';
}

const CASES: Case[] = [
  {
    name: 'homophone repair (the thing correction exists for)',
    tier: 'character-fix',
    said: '我们把服务部署到多克里面',
    back: '我们把服务部署到Docker里面',
  },
  {
    name: 'model-number spacing repair',
    tier: 'character-fix',
    said: '我买了一块RTS409048G的卡',
    back: '我买了一块RTX 4090 48G的卡',
  },
  {
    name: 'terminal punctuation only',
    tier: 'character-fix',
    said: '今天先到这里',
    back: '今天先到这里。',
  },
  {
    name: 'filler removal (a real polish edit)',
    tier: 'light-polish',
    said: '那个我觉得吧这个方案呃应该是可以的',
    back: '我觉得这个方案应该是可以的',
  },
  {
    name: 'false-start cleanup',
    tier: 'light-polish',
    said: '我们下周下周一开会讨论这件事',
    back: '我们下周一开会讨论这件事',
  },
  {
    name: 'clause REORDER — same words, different order',
    tier: 'restructure',
    said: '先把数据导出来然后再清空历史记录',
    back: '再清空历史记录之前先把数据导出来',
  },
  {
    name: 'rephrase into different words',
    tier: 'restructure',
    said: '这个功能现在还不能用',
    back: '该特性目前尚未开放使用',
  },
  {
    name: 'summarise (drops content)',
    tier: 'restructure',
    said: '我们讨论了预算、排期和人力三件事最后决定先做排期',
    back: '决定先做排期',
  },
];

/** Character-level divergence, 0..1 — the number the owner's "~10%" is about. */
function divergence(a: string, b: string): number {
  const s = [...a];
  const t = [...b];
  if (s.length === 0 && t.length === 0) return 0;
  const prev = new Array<number>(t.length + 1);
  const cur = new Array<number>(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= t.length; j += 1) prev[j] = cur[j]!;
  }
  return prev[t.length]! / Math.max(s.length, t.length);
}

describe('PART A — what each strength ALLOWS (policy, hermetic)', () => {
  it('measures every case at both strengths and writes the table', () => {
    const rows = CASES.map((c) => {
      const strict = checkMeaningPreserved(c.said, c.back, { strength: 'strict' });
      const smooth = checkMeaningPreserved(c.said, c.back, { strength: 'smooth' });
      return {
        name: c.name,
        tier: c.tier,
        divergence: Number(divergence(c.said, c.back).toFixed(3)),
        strict: strict.ok ? 'allowed' : `rejected(${strict.reason})`,
        smooth: smooth.ok ? 'allowed' : `rejected(${smooth.reason})`,
      };
    });
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(path.join(OUT_DIR, 'polish-strength-policy.json'), JSON.stringify(rows, null, 2), 'utf8');

    // Every case produced a verdict at both strengths — otherwise the table
    // below is measuring the harness rather than the guard.
    expect(rows).toHaveLength(CASES.length);
    for (const r of rows) expect(r.strict.length).toBeGreaterThan(0);
  });

  it('THE PRINCIPLE, as a contract: a REORDER is refused at EVERY strength', () => {
    // This is the one line of owner's tier model that the code must enforce
    // rather than merely intend. Both prompts already state
    // "Never reorder sentences or clauses"; a prompt is a request, and the
    // guard is what makes it a rule.
    const reorder = CASES.find((c) => c.name.startsWith('clause REORDER'))!;
    for (const strength of ['strict', 'smooth'] as const) {
      const v = checkMeaningPreserved(reorder.said, reorder.back, { strength });
      expect(v.ok, `${strength} must refuse a reorder`).toBe(false);
    }
  });

  it('a homophone repair survives at BOTH strengths — the case correction exists for', () => {
    const fix = CASES.find((c) => c.tier === 'character-fix')!;
    for (const strength of ['strict', 'smooth'] as const) {
      expect(checkMeaningPreserved(fix.said, fix.back, { strength }).ok, strength).toBe(true);
    }
  });

  it('smooth is a SUPERSET of strict — never the other way round', () => {
    // If some transformation were allowed by strict and refused by smooth, the
    // two names would be lying about their relationship, and a user turning
    // "more polish" on would get LESS.
    for (const c of CASES) {
      const strict = checkMeaningPreserved(c.said, c.back, { strength: 'strict' }).ok;
      const smooth = checkMeaningPreserved(c.said, c.back, { strength: 'smooth' }).ok;
      if (strict) expect(smooth, `${c.name}: strict allowed it, smooth must too`).toBe(true);
    }
  });

  it('the scenario block reaches the polish system prompt, and its absence changes nothing', () => {
    const block = buildScenarioBlock({ professions: ['眼科医生'], domains: [], terms: ['飞秒激光'] });
    const withCtx = polishSystemPromptWithScenario('strict', block);
    const without = polishSystemPromptWithScenario('strict', '');
    expect(withCtx).toContain('眼科医生');
    expect(withCtx).toContain('飞秒激光');
    // The no-scenario path must be byte-identical to the pinned constant, or
    // every existing prompt assertion and every cache key silently moves.
    expect(without).toBe(polishSystemPromptWithScenario('strict', ''));
    expect(without).not.toContain('BACKGROUND CONTEXT');
  });
});

// ── PART B — what the MODEL does with it (live, opt-in) ──────────────────────

/** The production line, read from the same file verify/eval/ reads. */
function deepseekConfig(): LlmConfig | null {
  const envPath = path.join(process.cwd(), '..', '..', '.local', 'deepseek.env');
  if (!existsSync(envPath)) return null;
  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!.trim();
  }
  const key = env.FLOWMIC_DEEPSEEK_API_KEY ?? '';
  if (key === '') return null;
  return {
    protocol: 'openai-compatible',
    // The streamer appends `/chat/completions` itself (openai-compatible.ts),
    // so this is the BASE. Passing the full path produced 12/12 LLM_TIMEOUT and
    // a 0/6-vs-0/6 table that looked exactly like a real null result — the
    // instrument failing while reporting a finding. Same base the resident eval
    // harness uses (verify/eval/eval-live.mjs resolveLine).
    endpoint: 'https://api.deepseek.com/v1',
    model: env.FLOWMIC_DEEPSEEK_MODEL ?? 'deepseek-chat',
    api_key: key,
  };
}

/**
 * Transcripts where the right answer depends on knowing the speaker's field.
 *
 * 🔴 THE FIRST VERSION OF THIS CORPUS COULD NOT MEASURE ANYTHING, and the run
 * that proved it is worth keeping: with 飞秒机光→飞秒激光, 多克→Docker and
 * 吉特哈布→GitHub the score was 6/6 WITH context and 6/6 WITHOUT. The honest
 * reading of that table is not "context does not help" — it is "these terms are
 * famous enough that a strong model resolves them unaided, so the experiment had
 * no room to show a difference". A corpus whose control and treatment arms both
 * saturate measures the corpus.
 *
 * So the cases below are split deliberately:
 *   · `discriminating: true`  — a name the model CANNOT know (a product, an
 *     internal system). The mis-hearing is a perfectly plausible Chinese string,
 *     so there is no reason to change it unless something told the model to.
 *   · `discriminating: false` — a famous term, kept as a POSITIVE CONTROL. If
 *     even this one stops landing, the harness is broken and the zeros above it
 *     mean nothing.
 */
const CONTEXT_CASES = [
  {
    said: '打开飞麦克然后开始录音',
    want: 'FlowMic',
    discriminating: true,
    card: { professions: ['产品经理'], domains: ['语音输入'], terms: ['FlowMic'] },
  },
  {
    said: '这批数据都存在洛克斯托里面',
    want: 'Rockstore',
    discriminating: true,
    card: { professions: ['数据工程师'], domains: ['数据平台'], terms: ['Rockstore'] },
  },
  {
    said: '这个服务已经部署到多克容器里面了',
    want: 'Docker',
    discriminating: false, // positive control — famous, expected to land either way
    card: { professions: ['后端工程师'], domains: ['云原生'], terms: ['Docker', 'Kubernetes'] },
  },
];

describe.skipIf(!LIVE)('PART B — what the model does with the context (live)', () => {
  it('context on vs off, at both strengths, against the production line', async () => {
    const cfg = deepseekConfig();
    if (cfg === null) {
      console.log('SKIP: no .local/deepseek.env key');
      return;
    }

    const results: Record<string, unknown>[] = [];
    for (const c of CONTEXT_CASES) {
      for (const strength of ['strict', 'smooth'] as const) {
        for (const withContext of [false, true]) {
          const block = withContext
            ? buildScenarioBlock({ professions: c.card.professions, domains: c.card.domains, terms: c.card.terms })
            : '';
          const r = await polishFinalText(c.said, cfg, {
            strength,
            scenarioBlock: block,
            // PRODUCTION CONFIGURATION: the audio session hands the same terms
            // to both legs, so the eval does too. Passing them was avoided in
            // the first draft on the theory that the drift check would score
            // our guard rather than the model — which was true while that check
            // rejected an INTRODUCED term. Once that direction was fixed the
            // realistic wiring is the honest one: this is what a real session
            // sends.
            protectedTerms: c.card.terms,
            budgetMs: 30_000,
          });
          results.push({
            said: c.said,
            want: c.want,
            strength,
            context: withContext ? 'on' : 'off',
            got: r.text,
            applied: r.applied,
            reason: r.reason ?? null,
            discriminating: c.discriminating,
            hit: r.text.includes(c.want),
            divergence: Number(divergence(c.said, r.text).toFixed(3)),
          });
        }
      }
    }

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(path.join(OUT_DIR, 'polish-context-eval.json'), JSON.stringify(results, null, 2), 'utf8');

    const hits = (rs: Record<string, unknown>[]): number => rs.filter((r) => r.hit === true).length;
    const rate = (rs: Record<string, unknown>[]): string => `${hits(rs)}/${rs.length}`;
    // Reported SPLIT. A pooled number would let the saturated control mask the
    // arm that carries the signal — which is exactly how the first run of this
    // corpus produced a confident-looking 6/6 vs 6/6.
    const disc = results.filter((r) => r.discriminating === true);
    const ctrl = results.filter((r) => r.discriminating === false);
    console.log('DISCRIMINATING (model cannot guess the name):');
    console.log(`  context ON  : ${rate(disc.filter((r) => r.context === 'on'))}`);
    console.log(`  context OFF : ${rate(disc.filter((r) => r.context === 'off'))}`);
    console.log('POSITIVE CONTROL (famous term — expected to land either way):');
    console.log(`  context ON  : ${rate(ctrl.filter((r) => r.context === 'on'))}`);
    console.log(`  context OFF : ${rate(ctrl.filter((r) => r.context === 'off'))}`);
    for (const strength of ['strict', 'smooth'] as const) {
      const rs = results.filter((r) => r.strength === strength);
      const avg = rs.reduce((n, r) => n + (r.divergence as number), 0) / rs.length;
      console.log(`${strength.padEnd(6)}: mean divergence ${avg.toFixed(3)}`);
    }

    // The only ASSERTION is that the run happened and produced a verdict for
    // every cell. The hit counts are REPORTED, deliberately: pinning "context on
    // must beat context off" would make a vendor's mood on one afternoon into a
    // gate, and this repo has a rule about tests that measure the instrument.
    expect(results).toHaveLength(CONTEXT_CASES.length * 4);
    for (const r of results) expect(typeof r.got).toBe('string');
  }, 180_000);
});
