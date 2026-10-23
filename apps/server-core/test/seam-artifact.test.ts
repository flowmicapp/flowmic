// Card SEAM-2 — the vendor's 「not finished」 marks at a row cut, the next row's first word, and the
// polish guard: the pure half (src/stt/seam-artifact.ts).
//
// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2.2 (card SEAM-2 block), §5 (card SEAM-2 block)
//   docs/strategy/2026-10-14-soft-seam-root-cause.md §1.1 (evidence), §3.1 (rules and the test table)
//
// The literal tails and heads below are the recorded ones (baseline A); the data-driven block reads
// a deduplicated extract of every recorded seam (test/fixtures/seam2-pol2a-seams.json).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OpenSeamCarry, dropTerminalDash, joinSafeEnd, keepOpenEnd, lowerContinuationHead, repairRowEnd, seamOpenLogField, stripAddedTerminal, stripOpenSeam } from '../src/stt/seam-artifact';

describe('card SEAM-2 — stripOpenSeam: the mark our cut made the vendor write', () => {
  it.each([
    ['now please leave your—', 'now please leave your'],
    ['先把读和写拆开，然后——', '先把读和写拆开，然后'],
    ['悪化し始めていて、だんだん...', '悪化し始めていて、だんだん'],
    ['み始めていて、だんだん…', 'み始めていて、だんだん'],
    ['das Problem immer,.', 'das Problem immer,'],
    ['下午我们，。', '下午我们，'],
  ])('strips %j', (row, want) => {
    expect(stripOpenSeam(row)).toEqual({ text: want, open: true });
  });

  it.each(['in the afternoon.', '次の計画会議は12日の。', 'onto Kubernetes.', 'what is next?', 'Bestellvorgang', 'U.S.'])(
    'leaves a real or unprovable end alone: %j', (row) => {
      expect(stripOpenSeam(row)).toEqual({ text: row, open: false });
    });

  it('whitespace is not ours: only the mark goes, the trailing space stays', () => {
    expect(stripOpenSeam('afternoon we— ')).toEqual({ text: 'afternoon we ', open: true });
  });

  it('a row that is nothing but the mark is left as it was (no empty row minted)', () => {
    expect(stripOpenSeam('—')).toEqual({ text: '—', open: false });
    expect(stripOpenSeam('...')).toEqual({ text: '...', open: false });
  });
});

describe('card SEAM-2 — lowerContinuationHead: closed lists only (MAIN: precision over coverage)', () => {
  it.each([
    ['en', 'The usual time works', 'the usual time works'],
    ['en', 'She told me she would', 'she told me she would'],
    ['en-US', "It's on the list", "it's on the list"],
    ['en', 'It’s on the list', 'it’s on the list'],
    ['de', 'Für alle freigeben', 'für alle freigeben'],
    ['de-DE', 'Und dann gehen wir', 'und dann gehen wir'],
  ])('%s: %j → lower', (lang, row, want) => {
    expect(lowerContinuationHead(row, lang)).toBe(want);
  });

  it.each([
    ['en', 'I think we should'], ['en', "I'm not sure"], ['en', "I'll send it"], ['en', "I've seen it"], ['en', "I'd say so"],
    ['en', 'GitHub has it'], ['en', 'API keys rotate'], ['en', 'Maria said yes'], ['en', 'Comments directly here'],
    ['en', 'Take a boat'], ['en', 'Worse rather than'], ['en', 'May we start'], ['en', 'Will said so'],
    ['de', 'Kommentare direkt'], ['de', 'Sie können'], ['de', 'Ihr Konto'], ['de', 'Etwas im Schlepptau'], ['de', 'Aus dem Lager'],
    ['de', 'Schlimmer wird es'], ['zh', 'The boat'], ['fr', 'Le bateau'], ['', 'The boat'], ['en', 'The-end'],
  ])('%s: %j is untouched', (lang, row) => {
    expect(lowerContinuationHead(row, lang)).toBe(row);
  });

  it('only the first letter of the first word changes; leading whitespace is kept', () => {
    expect(lowerContinuationHead('  The Rest Stays', 'en')).toBe('  the Rest Stays');
  });
});

// Re-review R3: the carry no longer lower-cases; it tags the next final with the stripped row it continues
// (`seam_from`), and the bridge decides on that row's DELIVERED text (stt-session-seam.ts).
describe('card SEAM-2 — OpenSeamCarry: the one holder of 「the last row ended open」', () => {
  it('lower-cases the next row only after a stripped cut, and only once', () => {
    const c = new OpenSeamCarry();
    expect(c.cutRow('and in the afternoon we—', 'pause', true, 'en', 0)).toBe('and in the afternoon we');
    expect(c.logField()).toEqual({ seam_open: true });
    expect(c.continuation('The boat leaves at noon.')).toEqual({ seam_from: 0 });
    expect(c.continuation('The next one')).toEqual({}); // consumed
  });

  it('a real sentence end does not open the seam: 「afternoon.」 + 「Sorry, I mean」 keeps its capital', () => {
    const c = new OpenSeamCarry();
    expect(c.cutRow('on Tuesday afternoon.', 'pause', true, 'en', 0)).toBe('on Tuesday afternoon.');
    expect(c.logField()).toEqual({ seam_open: false });
    expect(c.continuation('The meeting')).toEqual({});
  });

  it('an empty row in between does not consume the open phrase', () => {
    const c = new OpenSeamCarry();
    c.cutRow('we told them—', 'word_gap', true, 'en', 0);
    expect(c.continuation('')).toEqual({});
    expect(c.cutRow('', 'pause', true, 'en', 0)).toBe('');
    expect(c.continuation('The rest')).toEqual({ seam_from: 0 });
  });

  it('not a flush-closing engine (FunASR family, F-2): nothing stripped, nothing carried, no log field', () => {
    const c = new OpenSeamCarry();
    expect(c.cutRow('we—', 'pause', false, 'en', 0)).toBe('we—');
    expect(c.logField()).toEqual({});
    expect(c.continuation('The boat')).toEqual({});
  });

  it('other cut reasons keep their own rule: sentence / overdue untouched, leg drops one SENTENCE_TERMINATOR', () => {
    const c = new OpenSeamCarry();
    expect(c.cutRow('we—', 'sentence', true, 'en', 0)).toBe('we—');
    expect(c.cutRow('we—', 'overdue', true, 'en', 0)).toBe('we—');
    expect(c.cutRow('下午我们。', 'leg', true, 'en', 0)).toBe('下午我们');
    expect(c.logField()).toEqual({});
    expect(c.continuation('The boat')).toEqual({});
  });

  it('seamOpenLogField answers the hang-up row cut the same way, before its emit', () => {
    expect(seamOpenLogField('we—', 'pause', true, 'en')).toEqual({ seam_open: true });
    expect(seamOpenLogField('we.', 'pause', true, 'en')).toEqual({ seam_open: false });
    expect(seamOpenLogField('we—', 'pause', false, 'en')).toEqual({});
  });
});

describe('card SEAM-2 — stripAddedTerminal: the polish may not close an open segment row', () => {
  it.each([
    ['and in the afternoon we', 'And in the afternoon we.', 'And in the afternoon we'],
    ['下午我们', '下午我们。', '下午我们'],
    ['he said “we go', 'He said “we go.”', 'He said “we go”'],
    ['we go ', 'We go. ', 'We go '],
  ])('%j → %j is stripped', (input, output, want) => {
    expect(stripAddedTerminal(input, output)).toBe(want);
  });

  it.each([
    ['on Tuesday afternoon.', 'On Tuesday afternoon.'],
    ['下午我们。', '下午我们。'],
    ['and in the afternoon we', 'And in the afternoon we'],
    ['', '.'],
  ])('%j → %j is left as the polish wrote it', (input, output) => {
    expect(stripAddedTerminal(input, output)).toBe(output);
  });
});

// 🔴 MAIN 2026-10-14 — a mark the speaker dictated is never ours to take (stt-polish-guard-dictation.ts reads
// which words were said as commands). REVERSE CONTROL (SAW RED, card SEAM-2): `trailingDictatedCommand` made to
// return null ⇒ the two command cases in this block red (the content-word case and the control stay green).
describe('card SEAM-2 — a dictated mark belongs to the speaker, not to the cut', () => {
  it('a row ending on a dictated command keeps the mark after it and is not open', () => {
    const c = new OpenSeamCarry();
    expect(c.cutRow('this is the main point dash—', 'pause', true, 'en', 0)).toBe('this is the main point dash—');
    expect(c.logField()).toEqual({ seam_open: false });
    expect(c.continuation('The next part')).toEqual({});
    expect(c.cutRow('wir treffen uns morgen Komma,.', 'pause', true, 'de', 0)).toBe('wir treffen uns morgen Komma,.');
    expect(seamOpenLogField('and the list goes on ellipsis...', 'pause', true, 'en')).toEqual({ seam_open: false });
  });

  // NR-262 (merged 921d3597): an `added` phrase is a command only as half of a pair. REVERSE CONTROL (SAW RED, card
  // SEAM-2): the `last.added` branch removed from `trailingDictatedCommand` ⇒ the unpaired case red.
  it('an unpaired added phrase is words (stripped); the closing half of a pair is dictated (kept)', () => {
    expect(repairRowEnd('wir nehmen den Strichpunkt—', 'de')).toMatchObject({ open: true, stripped: true });
    expect(repairRowEnd('der Server Klammer zu—', 'de')).toMatchObject({ open: true, stripped: true });
    expect(repairRowEnd('der Server Klammer auf Staging Klammer zu—', 'de')).toEqual({ text: 'der Server Klammer auf Staging Klammer zu—', open: false, stripped: false });
  });

  it('a word that reads as part of the sentence is not a command: the vendor mark still goes', () => {
    const c = new OpenSeamCarry();
    expect(c.cutRow('at the end of the period—', 'pause', true, 'en', 0)).toBe('at the end of the period');
  });

  it('the polish keeps its full stop on an open row that ends on a dictated period', () => {
    expect(keepOpenEnd('so please send the report period', 'So please send the report.', true, 'en')).toBe('So please send the report.');
    expect(keepOpenEnd('bitte schick den Bericht Punkt', 'Bitte schick den Bericht.', true, 'de-DE')).toBe('Bitte schick den Bericht.');
  });

  it('control: the same rows without the command lose the full stop of the polish; a row not opened by the cut keeps it', () => {
    expect(keepOpenEnd('so please send the report', 'So please send the report.', true, 'en')).toBe('So please send the report');
    expect(keepOpenEnd('so please send the report', 'So please send the report.', false, 'en')).toBe('So please send the report.');
  });
});

describe('card SEAM-2 review C1 — a strip may not create a seam the shipped joiners glue', () => {
  it.each(['afternoon we—', '先把读和写拆开，然后——', 'だんだん...', 'immer,.', 'ゆっくり—', 'number 42—', '（注）—', '１２３—'])('%j: strip (ASCII or no-space script left)', (row) => {
    expect(repairRowEnd(row, 'en')).toMatchObject({ open: true, stripped: true });
  });
  it.each([['и вечером мы—', 'ru'], ['dann Fuß—', 'de'], ['우리는—', 'ko'], ['nous allons à la côté—', 'fr'], ['tomamos un café—', 'es']])(
    '%j: open but kept as today', (row, lang) => {
      expect(repairRowEnd(row, lang)).toEqual({ text: row, open: true, stripped: false });
    });
  it('joinSafeEnd reads the last visible character; full-width Latin and half-width Hangul are spaced scripts', () => {
    expect(joinSafeEnd('ＡＢＣ')).toBe(false);
    expect(joinSafeEnd('ｂ')).toBe(false);
    expect(joinSafeEnd('ﾡ')).toBe(false);
    expect(joinSafeEnd('ｶ')).toBe(true);
    expect(joinSafeEnd('we ')).toBe(true);
    expect(joinSafeEnd('мы')).toBe(false);
    expect(joinSafeEnd('')).toBe(false);
  });
  it('a kept mark carries no lower-casing and no internal seam_open, but the log still says open', () => {
    const c = new OpenSeamCarry();
    expect(c.cutRow('и вечером мы—', 'pause', true, 'ru', 0)).toBe('и вечером мы—');
    expect(c.logField()).toEqual({ seam_open: true });
    expect(c.finalField()).toEqual({});
    expect(c.continuation('The rest')).toEqual({});
  });
});

describe('card SEAM-2 review C2 — the Soniox terminal final loses its closing dash', () => {
  it('drops a trailing dash run on a flush-closing engine (whitespace kept)', () => {
    expect(dropTerminalDash('until it is—', true, 'en')).toBe('until it is');
    expect(dropTerminalDash('感觉问题越来越—— ', true, 'zh')).toBe('感觉问题越来越 ');
  });
  it('keeps it on any other engine, after a dictated command, and when nothing else is left', () => {
    expect(dropTerminalDash('until it is—', false, 'en')).toBe('until it is—');
    expect(dropTerminalDash('this is the main point dash—', true, 'en')).toBe('this is the main point dash—');
    expect(dropTerminalDash('—', true, 'en')).toBe('—');
    expect(dropTerminalDash('until it is...', true, 'en')).toBe('until it is...');
  });
});

// REVERSE CONTROL (SAW RED, card SEAM-2 review P3): the previous `stripAddedTerminal` (any TERMINAL_RUN, no word
// check) ⇒ every 「kept」 case below red.
describe('card SEAM-2 review P3 — only a single added 「.」/「。」 goes, never a question, exclamation or word dot', () => {
  it.each([
    ['what time is it', 'What time is it?'],
    ['that is great', 'That is great!'],
    ['and then', 'And then…'],
    ['we meet at 3 p.m', 'We meet at 3 p.m.'],
    ['apples pears etc', 'Apples, pears, etc.'],
    ['made in the U.S', 'Made in the U.S.'],
    ['wir treffen uns am 3', 'Wir treffen uns am 3.', 'de'],
    ['plan B', 'Plan B.'],
    ['and so', 'And so..'],
  ])('%j → %j is kept', (input, output, lang?: string) => {
    expect(stripAddedTerminal(input, output, lang ?? 'en')).toBe(output);
  });
  it('the plain added stop still goes', () => {
    expect(stripAddedTerminal('we meet at three', 'We meet at three.', 'en')).toBe('We meet at three');
  });
  // Re-review R3 — REVERSE CONTROL (SAW RED): 'no' back in ABBREV / the number rule for every language ⇒ red.
  it('「no」 is not an abbreviation, and a number’s dot is an ordinal in German only', () => {
    expect(stripAddedTerminal('and I said no', 'And I said no.', 'en')).toBe('And I said no');
    expect(stripAddedTerminal('we need about 5', 'We need about 5.', 'en')).toBe('We need about 5');
    expect(stripAddedTerminal('wir brauchen etwa 5', 'Wir brauchen etwa 5.', 'de-DE')).toBe('Wir brauchen etwa 5.');
  });
});

interface FixtureSeam { id: string; lang: string; kind: 'mid' | 'end'; tail: string; head: string; ref_head: string | null; n: number }
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/seam2-pol2a-seams.json', import.meta.url), 'utf8')) as { seams: FixtureSeam[] };

describe('card SEAM-2 — every recorded baseline-A seam (deduplicated extract)', () => {
  const ends = FIXTURE.seams.filter((s) => s.kind === 'end');
  const mids = FIXTURE.seams.filter((s) => s.kind === 'mid');
  const sum = (xs: FixtureSeam[]): number => xs.reduce((a, s) => a + s.n, 0);

  it('POSITIVE CONTROL: the extract holds both kinds, at the recorded counts', () => {
    expect(sum(ends)).toBe(97);
    expect(sum(mids)).toBe(93);
  });

  it('no strip on a true sentence-end cut that ends in a sentence mark (96/96)', () => {
    const marked = ends.filter((s) => /[.。]$/u.test(s.tail));
    expect(sum(marked)).toBe(96);
    expect(marked.filter((s) => stripOpenSeam(s.tail).open)).toEqual([]);
    // The one remaining 「end」 seam is a vendor dash on a phrase the speaker had not finished; it is stripped.
    expect(ends.filter((s) => !/[.。]$/u.test(s.tail)).map((s) => [s.tail.slice(-6), stripOpenSeam(s.tail).open])).toEqual([['题越来越——', true]]);
  });

  it('every dash / ellipsis / 「,.」 at a mid-phrase cut is stripped (66 dashes and ellipses + 1 「,.」)', () => {
    const stripped = mids.filter((s) => stripOpenSeam(s.tail).open);
    expect(sum(stripped)).toBe(67);
    for (const s of stripped) expect(stripOpenSeam(s.tail).text).not.toMatch(/(?:—|…|\.\.\.)$|[,，、][.。]$/u);
  });

  it('the head lower-casing never lower-cases a word the reference capitalises, and fixes 12 of the 38 recorded capitals', () => {
    let fixed = 0; let capitals = 0;
    for (const s of mids) {
      const first = s.head.trim().split(/\s+/u)[0]!;
      const wrongCapital = s.ref_head !== null && /^\p{Lu}/u.test(first) && s.ref_head[0] === s.ref_head[0]!.toLowerCase() && /\p{Ll}/u.test(s.ref_head[0]!);
      if (wrongCapital) capitals += s.n;
      if (!stripOpenSeam(s.tail).open) continue;
      const head = lowerContinuationHead(s.head, s.lang);
      if (head === s.head) continue;
      const out = head.trim().split(/\s+/u)[0]!;
      expect(s.ref_head, `${s.id}: lower-cased 「${first}」`).not.toBeNull();
      expect(s.ref_head![0], `${s.id}: the reference capitalises 「${s.ref_head}」`).toBe(s.ref_head![0]!.toLowerCase());
      expect(out[0]).toBe(s.ref_head![0]);
      fixed += s.n;
    }
    expect(capitals).toBe(38);
    expect(fixed).toBe(12); // The ×4, She ×4, Für ×4 — Comments / Worse / Take / Fahren / Schlimmer / Etwas / Slow stay (not closed words, or no open mark)
  });
});
