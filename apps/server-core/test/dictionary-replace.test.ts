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
