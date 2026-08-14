// WP-R4-5 ③④ — the FINAL pipeline composition (06 §5): dictionary replace FIRST,
// then the F-2249 normalizer. Proves the ORDER (a homophone alias is resolved to
// the canonical BEFORE grooming/terminal punctuation) and the ④ segment-vs-
// terminal rule (soft-segment finals get dict + grooming but no forced terminal
// punctuation; the utterance-closing final does).

import { describe, expect, it } from 'vitest';
import { makeFinalTextPipeline } from '../src/stt/final-text-pipeline';
import { buildDictionaryReplacer } from '../src/compose/dictionary-replace';

const pipeline = makeFinalTextPipeline(
  buildDictionaryReplacer([
    { canonical: 'FlowMic', aliases: ['飞麦克'] },
    { canonical: 'Kubernetes', aliases: ['k8s'] },
  ]),
);

describe('makeFinalTextPipeline — dictionary replace FIRST, then normalize', () => {
  it('resolves a CJK homophone alias to the canonical, THEN adds terminal punctuation', () => {
    expect(pipeline('打开飞麦克', { isSegment: false, language: 'zh-CN' })).toBe('打开FlowMic。');
  });

  it('resolves a Latin alias (case-insensitive, word-bounded) before grooming', () => {
    expect(pipeline('deploy k8s now', { isSegment: false, language: 'en-US' })).toBe('deploy Kubernetes now.');
  });

  it('applies dictionary + disfluency grooming together on the final', () => {
    // leading filler stripped AND the homophone resolved
    expect(pipeline('嗯打开飞麦克', { isSegment: false, language: 'zh-CN' })).toBe('打开FlowMic。');
  });
});

describe('makeFinalTextPipeline — ④ segment finals never get terminal punctuation', () => {
  it('a soft-segment final gets dict + grooming but NO terminal mark', () => {
    expect(pipeline('打开飞麦克', { isSegment: true, language: 'zh-CN' })).toBe('打开FlowMic');
  });

  it('the SAME text as the utterance-closing final DOES get the terminal mark', () => {
    expect(pipeline('打开飞麦克', { isSegment: false, language: 'zh-CN' })).toBe('打开FlowMic。');
  });

  it('an empty final stays empty through the pipeline (both segment and terminal)', () => {
    expect(pipeline('', { isSegment: true, language: 'zh-CN' })).toBe('');
    expect(pipeline('', { isSegment: false, language: 'zh-CN' })).toBe('');
  });
});
