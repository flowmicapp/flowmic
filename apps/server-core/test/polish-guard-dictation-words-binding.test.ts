// NR-262 — every reader of the dictated-command table, and R1.
//
// The cases are GENERATED from DICTATION_COMMANDS (src/stt/
// stt-polish-guard-dictation-words.ts), one per entry, from its `say` field.
// Nothing here is a hand-kept list of command words: a word added to the table
// is covered the day it is added.
//
// R1 (MAIN 2026-10-14): a command phrase of the input is excused from the
// content check ONLY where the output has that command's symbol at its own
// place. The dictation check finds those places (DictationEdits.excused); the
// content check blanks exactly those spans and nothing else. So, per entry:
// converted to its symbol in place => excused, and the content check accepts;
// dropped with no symbol => not excused, and its words are compared like any
// other words. An `added` entry (one main's content check never excused) is
// excused only as half of a converted open / close pair (MAIN final decision):
// on its own, converted, it is not excused; a pairable one is tested as a pair.
import { describe, expect, it } from 'vitest';
import {
  DICTATION_COMMANDS,
  ENGLISH_HOMOGRAPHS,
  commandLanguages,
  dictationCommandRegExp,
  normalizeSurface,
  type SymClass,
} from '../src/stt/stt-polish-guard-dictation-words';
import { diffChars } from '../src/stt/stt-polish-guard';
import { contentDrift } from '../src/stt/stt-polish-guard-content';
import { dictationEdits, type SpanHunk } from '../src/stt/stt-polish-guard-dictation';
import { registerDrift } from '../src/stt/stt-polish-guard-structure';
import { dictationContextTerms } from '../src/stt/terminology-context';

const SYMBOL: Readonly<Record<SymClass, string>> = {
  comma: ',', period: '.', question: '?', exclaim: '!', colon: ':', semicolon: ';',
  newline: '\n', quote: '"', paren_open: '(', paren_close: ')', dash: '-', ellipsis: '…',
};

const entries = Object.entries(DICTATION_COMMANDS).flatMap(([lang, cmds]) => cmds.map((c) => ({ lang, ...c })));
const latin = (lang: string): boolean => ['en', 'fr', 'de', 'es'].includes(lang);

function edits(raw: string, polished: string, language: string | undefined): ReturnType<typeof dictationEdits> {
  const spans: SpanHunk[] = [];
  diffChars(raw, polished, (h, rawStart, polStart) => {
    spans.push({ rawStart, rawEnd: rawStart + h.rawText.length, polStart, polEnd: polStart + h.polText.length });
  });
  return dictationEdits(raw, polished, language, spans);
}

/** The probe for one entry: `Alpha <say> Bravo`. A command that starts with a
 *  number word (deux points) is a command only at a clause start. */
function probe(e: (typeof entries)[number]): { raw: string; converted: string; deleted: string; at: number } {
  const lead = e.numeric === true ? 'Alpha.' : 'Alpha';
  return { raw: `${lead} ${e.say} Bravo`, converted: `${lead}${SYMBOL[e.kind]} Bravo`, deleted: `${lead} Bravo`, at: lead.length + 1 };
}

describe('dictated command table: one source, every reader agrees (NR-262)', () => {
  it('covers the seven dictation languages', () => {
    expect(Object.keys(DICTATION_COMMANDS).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'ru']);
  });

  it('R2: "next line" is not a command in any table', () => {
    for (const lang of Object.keys(DICTATION_COMMANDS)) {
      expect({ lang, match: dictationCommandRegExp(lang)!.test('Check next line TODO') }).toEqual({ lang, match: false });
    }
  });

  it.each(entries.map((e) => [e.lang, e.say, e]))('%s "%s": the example is matched by its own pattern', (_l, _s, e) => {
    expect(new RegExp(`^(?:${e.re})$`, 'iu').test(e.say)).toBe(true);
    expect(` ${e.say} `.replace(dictationCommandRegExp(e.lang)!, '').trim()).toBe('');
  });

  it.each(entries.map((e) => [e.lang, e.say, e]))('%s "%s": converted in place it is excused; dropped it is not (R1)', (_l, _s, e) => {
    const p = probe(e);
    const conv = edits(p.raw, p.converted, e.lang);
    const want = e.added === true ? [] : [[p.at, p.at + e.say.length]];
    expect({ say: e.say, refused: conv.refused, excused: conv.excused }).toEqual({ say: e.say, refused: null, excused: want });
    const del = edits(p.raw, p.deleted, e.lang);
    expect({ say: e.say, excused: del.excused }).toEqual({ say: e.say, excused: [] });
    if (!latin(e.lang)) return; // the content check reads Latin-script words only
    // An unpaired `added` conversion is a lost word, as on main.
    expect({ say: e.say, lost: contentDrift(p.raw, p.converted, [], e.lang, conv.excused) === null }).toEqual({ say: e.say, lost: e.added !== true });
    // Not excused => compared like any other word: the deletion is a lost word.
    expect({ say: e.say, lost: contentDrift(p.raw, p.deleted, [], e.lang, del.excused) === null }).toEqual({ say: e.say, lost: false });
  });

  // A pairable `added` entry is excused as a pair enclosing the same words,
  // and not when the symbols enclose other words.
  const PARTNER: Readonly<Record<string, string>> = {
    'begin quote': 'end quote', 'ferme les guillemets': 'ouvre les guillemets', 'ouvre la parenthèse': 'ferme la parenthèse',
    'fermez la parenthèse': 'ouvrez la parenthèse', 'Anführungszeichen unten': 'Anführungszeichen oben', 'Klammer auf': 'Klammer zu',
    'Klammer zu': 'Klammer auf', 'abre comillas': 'cierra comillas', 'abrir paréntesis': 'cerrar paréntesis', 'cierra paréntesis': 'abre paréntesis',
  };
  const OPENS = new Set(['begin quote', 'ouvre les guillemets', 'ouvre la parenthèse', 'ouvrez la parenthèse', 'Anführungszeichen unten', 'Klammer auf', 'abre comillas', 'abrir paréntesis', 'abre paréntesis']);
  const pairable = entries.filter((e) => e.added === true && PARTNER[e.say] !== undefined);
  it('every pairable added entry has a partner listed here', () => {
    const missing = entries.filter((e) => e.added === true && (e.kind === 'quote' || e.kind === 'paren_open' || e.kind === 'paren_close') && PARTNER[e.say] === undefined);
    expect(missing.map((e) => e.say)).toEqual([]);
  });
  it.each(pairable.map((e) => [e.lang, e.say, e]))('%s "%s": a converted pair enclosing the same words is excused', (_l, _s, e) => {
    const [open, close] = OPENS.has(e.say) ? [e.say, PARTNER[e.say]!] : [PARTNER[e.say]!, e.say];
    const [o, c] = e.kind === 'quote' ? ['"', '"'] : ['(', ')'];
    const raw = `Alpha ${open} Bravo Charlie ${close} Delta`;
    const good = edits(raw, `Alpha ${o}Bravo Charlie${c} Delta`, e.lang);
    expect({ say: e.say, refused: good.refused, n: good.excused.length }).toEqual({ say: e.say, refused: null, n: 2 });
    const other = edits(raw, `Alpha ${o}Bravo Echo${c} Delta`, e.lang);
    expect({ say: e.say, n: other.excused.length }).toEqual({ say: e.say, n: 0 });
  });

  const endings = entries.filter((e) => e.lang === 'ja' || e.lang === 'ko');
  it.each(endings.map((e) => [e.lang, e.say, e]))('%s "%s" is not read as a sentence ending of its own', (_l, _s, e) => {
    const clause = e.lang === 'ja' ? '了解です' : '확인했어요';
    expect({ say: e.say, drift: registerDrift(`${clause} ${e.say}`, `${clause}${SYMBOL[e.kind]}`, e.lang) })
      .toEqual({ say: e.say, drift: false });
  });

  // Which tables a session reads: its own, then English, except an English
  // command that is an ordinary word of the session language (homograph).
  // Only what a session reads can ever be excused.
  const sessions: (string | undefined)[] = [undefined, 'zh', 'it', ...Object.keys(DICTATION_COMMANDS)];
  it.each(sessions.map((s) => [String(s), s]))('session %s: a conversion is excused exactly where the session reads the command', (_n, session) => {
    const read = commandLanguages(session);
    expect(read).toContain('en');
    const disagree: string[] = [];
    for (const e of entries.filter((x) => latin(x.lang))) {
      const p = probe(e);
      const homograph = e.lang === 'en' && (ENGLISH_HOMOGRAPHS[session ?? 'en'] ?? []).includes(normalizeSurface(e.say));
      const want = read.includes(e.lang) && !homograph && e.added !== true;
      const got = edits(p.raw, p.converted, session).excused.length > 0;
      if (got !== want) disagree.push(`${e.lang}:${e.say} excused=${got} want=${want}`);
    }
    expect(disagree).toEqual([]);
  });

  it('every word sent to the recognizer as a dictation hint is a command in the table', () => {
    for (const lang of Object.keys(DICTATION_COMMANDS)) {
      for (const term of dictationContextTerms(lang)) {
        expect({ lang, term, left: ` ${term} `.replace(dictationCommandRegExp(lang)!, '').trim() }).toEqual({ lang, term, left: '' });
      }
    }
    expect(dictationContextTerms('ja').length).toBeGreaterThan(0);
  });
});
