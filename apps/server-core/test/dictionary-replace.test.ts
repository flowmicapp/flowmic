// WP-R4-4 ② — the deterministic-replacement leg (§4.1 source ③). A pure
// alias→canonical rewriter applied to the compose/correction INPUT before the
// LLM. Pins: Latin case-insensitive word-boundary matching, CJK exact-substring
// homophone fixes, regex-injection safety (terms are escaped), longest-surface
// precedence, no cross-cascade, and identity on an empty rule set.

import { describe, expect, it } from 'vitest';
import { buildDictionaryReplacer } from '../src/compose/dictionary-replace';

describe('buildDictionaryReplacer — Latin case-insensitive, word-bounded', () => {
  it('normalises a canonical term to its preferred spelling (case-insensitive)', () => {
    const r = buildDictionaryReplacer([{ canonical: 'FlowMic' }]);
    expect(r.apply('i love flowmic')).toBe('i love FlowMic');
    expect(r.apply('FLOWMIC rocks')).toBe('FlowMic rocks');
    expect(r.apply('FlowMic')).toBe('FlowMic'); // already canonical → no-op
  });

  it('respects word boundaries — never rewrites inside a larger word', () => {
    const r = buildDictionaryReplacer([{ canonical: 'API' }]);
    expect(r.apply('the API is here')).toBe('the API is here');
    expect(r.apply('RAPID growth')).toBe('RAPID growth'); // 'API' inside RAPID untouched
    expect(r.apply('call the api')).toBe('call the API');
  });

  it('maps an alias to the canonical (case-insensitive)', () => {
    const r = buildDictionaryReplacer([{ canonical: 'Kubernetes', aliases: ['k8s'] }]);
    expect(r.apply('deploy k8s now')).toBe('deploy Kubernetes now');
    expect(r.apply('K8S cluster')).toBe('Kubernetes cluster');
  });
});

describe('buildDictionaryReplacer — CJK exact-substring homophones', () => {
  it('rewrites a CJK homophone alias to the Latin canonical (no spaces / no case)', () => {
    const r = buildDictionaryReplacer([{ canonical: 'FlowMic', aliases: ['飞麦克'] }]);
    expect(r.apply('我在用飞麦克说话')).toBe('我在用FlowMic说话');
  });

  it('a mixed CJK+ascii alias is matched as a substring', () => {
    const r = buildDictionaryReplacer([{ canonical: 'WiFi', aliases: ['歪fi'] }]);
    expect(r.apply('连上歪fi了')).toBe('连上WiFi了');
  });
});

describe('buildDictionaryReplacer — safety + precedence', () => {
  it('escapes regex metacharacters in a term (no injection)', () => {
    const r = buildDictionaryReplacer([{ canonical: 'A.B' }]);
    expect(r.apply('a.b matched')).toBe('A.B matched'); // literal dot only
    expect(r.apply('axb not matched')).toBe('axb not matched'); // '.' is not a wildcard
  });

  it('prefers the longest surface (a short alias never bites inside a longer one)', () => {
    const r = buildDictionaryReplacer([{ canonical: 'Node.js', aliases: ['node', 'nodejs'] }]);
    expect(r.apply('nodejs rocks')).toBe('Node.js rocks');
    expect(r.apply('node app')).toBe('Node.js app');
  });

  it('does not cascade — a canonical that contains a shorter term is left whole', () => {
    const r = buildDictionaryReplacer([{ canonical: 'JavaScript' }, { canonical: 'Java' }]);
    expect(r.apply('i use JavaScript daily')).toBe('i use JavaScript daily');
    expect(r.apply('i use java daily')).toBe('i use Java daily');
  });

  it('empty rule set is the identity replacer', () => {
    const r = buildDictionaryReplacer([]);
    expect(r.ruleCount).toBe(0);
    expect(r.apply('anything at all')).toBe('anything at all');
  });

  it('ruleCount counts distinct surface forms (canonical + aliases, deduped)', () => {
    const r = buildDictionaryReplacer([{ canonical: 'Go', aliases: ['golang', 'GOLANG'] }]);
    // 'go' + 'golang' (the two GOLANG cases collapse under case-insensitive latin)
    expect(r.ruleCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-08-28 — the split is by SCRIPT, not by "is it ASCII".
//
// Every case below reproduced a real defect before the fix, measured against
// this very function on dev-pc-a. The old branch (`hasNonAscii`) sent
// accented Latin and Cyrillic down the path built for scripts with no word
// boundaries and no case; the boundary class itself was ASCII-only, so a
// non-ASCII letter read as a word boundary.
//
// 🔴 BOTH HALVES OF THE FIX ARE LOAD-BEARING — reverted one at a time and each
// reversion MEASURED RED (2026-08-28), reproducing the original defect strings
// verbatim rather than merely failing:
//   · restore `[A-Za-z0-9_]` as the boundary class → 2 red
//       expected 'das APIö' to be 'das apiö'
//       expected 'КОДировка UTF-8' to be 'кодировка UTF-8'
//   · restore `hasNonAscii` as the split           → 2 red
//       expected 'größe der datei' to be 'Größe der datei'
//       expected 'КОДировка UTF-8' to be 'кодировка UTF-8'
//
// ⚠️ THE RUSSIAN CASE NEEDS BOTH, and this comment first claimed it needed only
// the split — corrected after actually running the two reversions. Cyrillic is
// routed by the split AND bounded by the boundary class, so either regression
// alone brings it back. A comment about which test guards which change is itself
// an assertion about behaviour; this one was wrong until it was measured.
// Full account: docs/strategy/2026-08-28-multilingual-chain-audit.md §3 F2.
// ─────────────────────────────────────────────────────────────────────────────
describe('buildDictionaryReplacer — the split is by script, not by ASCII-ness', () => {
  it('an ASCII term does not bite into a word whose neighbour is an accented letter', () => {
    const r = buildDictionaryReplacer([{ canonical: 'API' }, { canonical: 'Server' }]);
    // measured before the fix: "das apiö" -> "das APIö"
    expect(r.apply('das apiö')).toBe('das apiö');
    expect(r.apply('die serverüberwachung läuft')).toBe('die serverüberwachung läuft');
  });

  it('CONTROL — the ASCII neighbour behaviour is byte-for-byte what it always was', () => {
    const r = buildDictionaryReplacer([{ canonical: 'API' }, { canonical: 'Server' }]);
    expect(r.apply('RAPID api test')).toBe('RAPID API test');
    expect(r.apply('die api-schnittstelle')).toBe('die API-schnittstelle');
    expect(r.apply('der server läuft')).toBe('der Server läuft');
    expect(r.apply('die serverwartung läuft')).toBe('die serverwartung läuft');
  });

  it('a German term is case-insensitive like every other worded term', () => {
    const r = buildDictionaryReplacer([{ canonical: 'Größe' }, { canonical: 'Präzision' }]);
    // measured before the fix: no match at all — German capitalises every noun,
    // so a German user's dictionary was case-SENSITIVE and an English user's was not.
    expect(r.apply('größe der datei')).toBe('Größe der datei');
    expect(r.apply('die präzision zählt')).toBe('die Präzision zählt');
  });

  it('a Cyrillic term is word-bounded and does not bite inside an inflected word', () => {
    const r = buildDictionaryReplacer([{ canonical: 'КОД', aliases: ['код'] }]);
    // measured before the fix: "кодировка UTF-8" -> "КОДировка UTF-8"
    expect(r.apply('кодировка UTF-8')).toBe('кодировка UTF-8');
    expect(r.apply('этот код работает')).toBe('этот КОД работает');
  });

  it('CONTROL — Han/kana/Hangul keep exact-substring matching (they have no boundaries)', () => {
    const r = buildDictionaryReplacer([{ canonical: 'FlowMic', aliases: ['飞麦克'] }]);
    expect(r.apply('飞麦克很好')).toBe('FlowMic很好');
  });

  it('a mixed CJK+Latin surface is boundaryless — the CJK half has nothing to anchor to', () => {
    const r = buildDictionaryReplacer([{ canonical: 'FlowMic', aliases: ['飞麦克App'] }]);
    expect(r.apply('用飞麦克App写字')).toBe('用FlowMic写字');
  });

  it('KNOWN LIMIT, pinned rather than left to be discovered: ß does not fold to SS', () => {
    const r = buildDictionaryReplacer([{ canonical: 'Größe' }]);
    // Neither JS regex case folding nor toLowerCase turns ß into ss, so a
    // shouted "GRÖSSE" is a MISS. A miss is a non-replacement, never a
    // corruption — the text passes through as spoken.
    expect(r.apply('GRÖSSE der datei')).toBe('GRÖSSE der datei');
    // …while the ordinary capitalisation a speaker actually produces does hit.
    expect(r.apply('Größe der datei')).toBe('Größe der datei');
  });
});
