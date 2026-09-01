// Z3 — CJK–Latin space deletion on the production compose output guard.
//
// Strings below are hand-written, not copied from verify/eval/cases/*.jsonl.
// The corpus measures the guard from the outside; if these tests were the
// corpus samples, both would be true of the same remembered strings.

import { describe, expect, it } from 'vitest';
import { guardComposeOutput } from '../src/compose/output-guard';
import { findCjkLatinGlue } from '../src/compose/output-guard-space';

const ruleOf = (v: ReturnType<typeof guardComposeOutput>): string | null => (v.ok ? null : v.rule);

const organize = (source: string, output: string) =>
  guardComposeOutput({ task: 'organize', source, output });

describe('compose output guard — cjk_latin_glued', () => {
  it('rejects a Latin word glued onto the following CJK neighbour', () => {
    const v = organize(
      'あと Slack 通知も直した',
      'あとSlack通知も直した。',
    );
    expect(ruleOf(v)).toBe('cjk_latin_glued');
  });

  it('rejects a CJK run glued onto the following Latin word', () => {
    const v = organize(
      '今日 GitHub のログを見た',
      '今日GitHubのログを見た。',
    );
    expect(ruleOf(v)).toBe('cjk_latin_glued');
  });

  it('rejects two Latin words concatenated when the pair sits next to CJK', () => {
    const v = organize(
      'えっと GitHub API のドキュメントを直した',
      'えっと GitHubAPI のドキュメントを直した。',
    );
    expect(ruleOf(v)).toBe('cjk_latin_glued');
  });

  it('rejects Hangul-adjacent glue, not only Han/kana', () => {
    const v = organize(
      '그리고 Slack 알림도',
      '그리고 Slack알림도.',
    );
    expect(ruleOf(v)).toBe('cjk_latin_glued');
  });

  it('does NOT fire when the output drops the pair entirely — a rephrase is not glue', () => {
    // The source had a CJK-adjacent Latin pair; the output is a legitimate
    // tightening that never mentions it. Firing here would reject correct work.
    expect(organize(
      'えっと Slack 通知もね、会議は木曜にずらした',
      '会議は木曜にずらした。',
    ).ok).toBe(true);
    expect(findCjkLatinGlue(
      'えっと Slack 通知もね、会議は木曜にずらした',
      '会議は木曜にずらした。',
    )).toBeNull();
  });

  it('does NOT fire when the space is kept', () => {
    expect(organize(
      'あと Slack 通知も直した',
      'あと Slack 通知も直した。',
    ).ok).toBe(true);
  });

  it('does NOT fire on Latin–Latin concatenation in a Latin-only source', () => {
    // Same glued product name, no CJK neighbour. Different failure; this rule
    // does not claim it. An English organize that writes GitHubAPI is out of
    // scope the same way English-unasked is — no script evidence.
    expect(organize(
      'so uh I looked at the GitHub API docs this morning',
      'I looked at the GitHubAPI docs this morning.',
    ).ok).toBe(true);
  });

  it('does NOT apply on translate — Chinese orthography may drop the space', () => {
    // A ja→zh translation of "Slack 通知" as "Slack通知" is a writing-system
    // convention, not an organize failure. Restricting the rule to organize is
    // the false-reject bound.
    expect(guardComposeOutput({
      task: 'translate',
      source: 'Slack 通知も直した',
      output: '也修好了Slack通知。',
      source_lang: 'ja',
      target_lang: 'zh-CN',
    }).ok).toBe(true);
  });

  it('does NOT fire when both tokens survive but stay separated', () => {
    expect(organize(
      'あと Slack 通知も直した',
      'Slack の通知も直した。',
    ).ok).toBe(true);
  });

  it('does NOT fire when the source already carried the glued form', () => {
    // The spaced pair is in the source AND so is the glued spelling. Copying
    // the glued spelling is not a deletion.
    expect(organize(
      'メモは Slack通知。あと Slack 通知も直した',
      'Slack通知も直した。',
    ).ok).toBe(true);
  });
});
