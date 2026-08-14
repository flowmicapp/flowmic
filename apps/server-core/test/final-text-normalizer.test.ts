// WP-R4-5 ② — final-text-normalizer (F-2249), ported verbatim from legacy
// apps/server/src/stt/final-text-normalizer.ts. Vectors exercise each ported
// rule: CJK disfluency stripping, CJK whitespace regularization, and terminal
// punctuation added ONLY when ensureTerminalPunctuation (the utterance-closing
// final) — the ④ segment-vs-terminal contract at the pure-function level.

import { describe, expect, it } from 'vitest';
import { normalizeFinalText } from '../src/stt/final-text-normalizer';

const term = (text: string, language = 'zh-CN'): string =>
  normalizeFinalText(text, { language, ensureTerminalPunctuation: true });
const seg = (text: string, language = 'zh-CN'): string =>
  normalizeFinalText(text, { language, ensureTerminalPunctuation: false });

describe('normalizeFinalText — trim + empty guards', () => {
  it('returns empty / non-string input unchanged', () => {
    expect(normalizeFinalText('')).toBe('');
    // whitespace-only collapses to empty, and stays empty even asked to close
    expect(term('   ')).toBe('');
    expect(term('  \t\n ')).toBe('');
  });

  it('trims surrounding whitespace', () => {
    expect(seg('  hello world  ', 'en-US')).toBe('hello world');
  });
});

describe('normalizeFinalText — CJK disfluency stripping (spoken fillers)', () => {
  it('strips a leading filler run (呃/嗯/额/啊)', () => {
    expect(seg('嗯今天天气不错')).toBe('今天天气不错');
    expect(seg('呃嗯今天')).toBe('今天');
  });

  it('strips a mid-sentence filler with its adjacent commas', () => {
    expect(seg('好的，呃，继续')).toBe('好的继续');
  });

  it('removes 的话呢 / 呢就是 verbal padding', () => {
    expect(seg('这样的话呢我们开始')).toBe('这样我们开始');
    expect(seg('这个呢就是重点')).toBe('这个重点');
  });

  it('rewrites 接下来/然后…呢就是 to the connective alone', () => {
    expect(seg('然后呢就是这样')).toBe('然后这样');
  });

  it('leaves a Latin-only span untouched by the CJK disfluency pass', () => {
    expect(seg('uh well then', 'en-US')).toBe('uh well then');
  });
});

describe('normalizeFinalText — CJK whitespace regularization', () => {
  it('collapses spaces between Han characters', () => {
    expect(seg('你好 世界')).toBe('你好世界');
  });

  it('collapses a full-width (ideographic) space between Han', () => {
    expect(seg('你好　世界')).toBe('你好世界');
  });

  it('tightens spacing around CJK punctuation', () => {
    expect(seg('你好 ， 世界')).toBe('你好，世界');
  });
});

describe('normalizeFinalText — terminal punctuation ONLY on the closing final', () => {
  it('④ a SEGMENT final gets grooming but NO forced terminal punctuation', () => {
    expect(seg('今天天气不错')).toBe('今天天气不错');
    expect(seg('this is a segment', 'en-US')).toBe('this is a segment');
  });

  it('a TERMINAL Chinese statement gets 。', () => {
    expect(term('今天天气不错')).toBe('今天天气不错。');
    expect(term('打开FlowMic')).toBe('打开FlowMic。');
  });

  it('a TERMINAL English statement gets .', () => {
    expect(term('no polish here', 'en-US')).toBe('no polish here.');
    expect(term('I go', 'en-US')).toBe('I go.');
  });

  it('a Chinese question (吗/嘛/么 tail) gets ？', () => {
    expect(term('你好吗')).toBe('你好吗？');
  });

  it('a Chinese wh-question gets ？', () => {
    expect(term('这是什么')).toBe('这是什么？');
  });

  it('an English wh/aux question gets ?', () => {
    expect(term('how are you', 'en-US')).toBe('how are you?');
  });

  it('does not double-punctuate an already-terminated span', () => {
    expect(term('完成了。')).toBe('完成了。');
    expect(term('done.', 'en-US')).toBe('done.');
  });

  it('replaces a trailing pause mark with the terminal mark', () => {
    expect(term('继续，')).toBe('继续。');
  });

  it('places the terminal mark INSIDE a trailing closer', () => {
    expect(term('他说“你好”')).toBe('他说“你好。”');
  });
});
