// owner 2026-07-31 — the local search predicate. Header corrected 0.2.27: it used
// to say "asserted AGAINST THE SQL IT REPLACES" and quote `history.repo.ts`'s
// SEARCH_CLAUSE. That file is DELETED (the server stores no transcripts), so the
// citation pointed at nothing — and a test whose stated authority does not exist
// is asserting against a memory. The four rules below now each stand on their own
// stated reason; the historical shape they came from was
//   (output_text LIKE ? ESCAPE '\' OR source_text LIKE ? ESCAPE '\')
// with an escaped literal term and SQLite's ASCII-only LIKE folding — kept here as
// PROVENANCE, not as the thing being mirrored.
// Every case below is one property of that clause; the file exists because a search
// that reaches FURTHER than the thing it replaced is not a better search, it is a
// second answer to "whether this row counts as a hit" — and the two would disagree exactly where the
// 0.2.22 ruling says they do.

import { describe, expect, it } from 'vitest';
import { foldAscii, makeQueryMatcher, type SearchableRow } from './timeline-query';

function row(output_text: string, source_text: string | null = null): SearchableRow {
  return { output_text, source_text };
}

describe('foldAscii — A–Z and nothing else', () => {
  it('folds ASCII upper case', () => {
    expect(foldAscii('Hello WORLD')).toBe('hello world');
  });

  it('leaves every non-ASCII letter exactly as it was', () => {
    // toLowerCase() would return 'ä', 'i̇', 'σ', 'ж'. SQLite's lower()/LIKE does not,
    // so neither may this: folding more than the server did is how a match that should
    // exist on both ends becomes a miss on one of them (0.2.22 ruling).
    for (const s of ['ÄÖÜ', 'ΣΊΣΥΦΟΣ', 'ЖУРНАЛ', 'İ']) {
      expect(foldAscii(s)).toBe(s);
    }
  });

  it('folds only the ASCII letters inside a MIXED word', () => {
    // Character by character, exactly like the SQL: the Turkish dotted capital stays,
    // its ASCII neighbours fold. Anything else would be a second folding table.
    expect(foldAscii('İSTANBUL')).toBe('İstanbul');
    expect(foldAscii('Ärger MEETING')).toBe('Ärger meeting');
  });

  it('leaves CJK alone (it has no case, which is why the surface is unchanged)', () => {
    expect(foldAscii('会议纪要')).toBe('会议纪要');
  });
});

describe('makeQueryMatcher — substring, ASCII-folded, escape-free (0.2.27: no SQL left to mirror)', () => {
  it('is a SUBSTRING match, not a prefix and not tokens', () => {
    const m = makeQueryMatcher('eeting');
    expect(m(row('the meeting notes'))).toBe(true);
    expect(m(row('nothing here'))).toBe(false);
  });

  it('searches output_text OR source_text — the two columns the SQL searches', () => {
    const m = makeQueryMatcher('会议');
    expect(m(row('translated text', '会议纪要'))).toBe(true);
    expect(m(row('会议纪要', null))).toBe(true);
    expect(m(row('unrelated', 'also unrelated'))).toBe(false);
  });

  it('a null source_text does not match and does not throw (NULL LIKE … is NULL)', () => {
    const m = makeQueryMatcher('anything');
    expect(() => m(row('nope', null))).not.toThrow();
    expect(m(row('nope', null))).toBe(false);
  });

  it('is case-insensitive for ASCII, case-SENSITIVE beyond it', () => {
    expect(makeQueryMatcher('HELLO')(row('hello there'))).toBe(true);
    expect(makeQueryMatcher('hello')(row('HELLO THERE'))).toBe(true);
    // The reverse assertion: matching here would mean this end folds further than the
    // server did, which is the silent-disagreement the ruling forbids.
    expect(makeQueryMatcher('ärger')(row('Ärger'))).toBe(false);
    expect(makeQueryMatcher('Ärger')(row('Ärger'))).toBe(true);
  });

  it('treats % and _ as characters, not wildcards (escapeLikeLiteral’s job)', () => {
    expect(makeQueryMatcher('100%')(row('100% done'))).toBe(true);
    expect(makeQueryMatcher('100%')(row('100 done'))).toBe(false);
    expect(makeQueryMatcher('a_b')(row('a_b'))).toBe(true);
    expect(makeQueryMatcher('a_b')(row('axb'))).toBe(false);
    // A backslash is just a backslash — there is no escape character to double here.
    expect(makeQueryMatcher('a\\b')(row('a\\b'))).toBe(true);
  });

  it('an empty query matches everything, exactly as LIKE %% does', () => {
    // The store never calls it this way (an empty box is "not searching"); mirroring the SQL
    // keeps the boundary rule in one place instead of two.
    expect(makeQueryMatcher('')(row('anything at all'))).toBe(true);
  });
});
