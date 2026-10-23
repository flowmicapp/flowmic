// scripts/eval/speech-quality/scoring.mjs — the scoring core shared by
// score.mjs (the EVAL-1 report) and compare-ctx.mjs (card CTX-1). Moved here
// VERBATIM from score.mjs so both reports count the same way; see README.md
// for every metric's blind spots.

import { loadCorpus } from './lib.mjs';

export const corpus = loadCorpus();
export const byId = new Map(corpus.items.map((it) => [it.id, it]));

// ── normalisation + tokenisation ────────────────────────────────────────────
export const EN_FILLERS = new Set(['um', 'uh', 'er', 'erm', 'ah', 'hmm', 'mm', 'uhm', 'umm']);
export const ZH_FILLER_CHARS = /[嗯呃]/g;
export const apos = (s) => s.replace(/[\u2018\u2019\u02bc]/g, "'");

export function tokensEn(s, dropFillers = true) {
  let t = apos(s.normalize('NFKC')).toLowerCase()
    .replace(/\b([ap])\.m\./g, '$1m').replace(/[$€£]/g, '').replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/%/g, ' percent');
  const out = [];
  for (let w of t.split(/[\s\-/]+/)) {
    w = w.replace(/^[^a-z0-9']+|[^a-z0-9]+$/g, '');
    if (!w) continue;
    if (dropFillers && EN_FILLERS.has(w)) continue;
    out.push(w);
  }
  return out;
}

/** CJK chars as single tokens, Latin/digit runs as one token each. */
export function tokensZh(s, dropFillers = true) {
  let t = apos(s.normalize('NFKC')).toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1');
  if (dropFillers) t = t.replace(ZH_FILLER_CHARS, ' ');
  return t.match(/\p{Script=Han}|[a-z0-9][a-z0-9.':]*[a-z0-9]|[a-z0-9]/gu) ?? [];
}
export const tokensFor = (lang, s, drop = true) => (lang === 'en' ? tokensEn(s, drop) : tokensZh(s, drop));

export function editDistance(a, b) {
  const n = a.length, m = b.length;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[m];
}

// ── per-item checks ─────────────────────────────────────────────────────────
export const isCjk = (s) => /\p{Script=Han}/u.test(s);
export const countWord = (text, w) => {
  if (isCjk(w)) return text.split(w).length - 1;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}'])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}(?=$|[^\\p{L}\\p{N}'])`, 'giu');
  return (apos(text).match(re) ?? []).length;
};

/** Number-format-insensitive view of a hypothesis: any accepted alternative
 *  of a corpus number group (`numbers`) is rewritten to the form the reference
 *  uses, so "2350" vs "两千三百五十" or "6" vs "six" is scored by the numbers
 *  metric and not double-counted as a recognition error. Driven only by the
 *  corpus' own alternatives; an unlisted format still counts as an error. */
export function canonNumbers(it, text) {
  let t = text;
  for (const alts of it.numbers ?? []) {
    const canon = alts.find((a) => it.reference.toLowerCase().includes(a.toLowerCase()));
    if (!canon) continue;
    for (const a of [...alts].sort((x, y) => y.length - x.length)) {
      if (a === canon || canon.includes(a)) continue;
      const re = isCjk(a) ? new RegExp(escapeRe(a), 'g') : new RegExp(`(?<![A-Za-z0-9])${escapeRe(a)}(?![A-Za-z0-9])`, 'gi'); // Han chars are \p{L}, so "了2350件" must still match
      t = t.replace(re, () => canon);
    }
  }
  return t;
}

/** Spoken-punctuation command words are scored by their own metric; strip them
 *  from both sides of the edit distance so a correct conversion ("question
 *  mark" -> "?") is not counted as two deleted words. */
export function stripCommands(it, text) {
  let t = text;
  for (const { cmd } of it.spoken_punct ?? []) t = t.replace(new RegExp(`\\b${cmd.replace(/ /g, '\\s+')}\\b`, 'gi'), ' ');
  return t;
}

export function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Soniox spaces mixed script inconsistently ("500 万" vs "500万"); spacing
 *  next to a Han character carries no meaning in Chinese, so drop it before
 *  any substring check. Spaces between two Latin words are kept. */
export const despace = (s) => s.replace(/\s+(?=\p{Script=Han})|(?<=\p{Script=Han})\s+/gu, '');

export function checks(it, text) {
  const t = despace(apos(text ?? ''));
  const lower = t.toLowerCase();
  const r = {};
  const refTok = tokensFor(it.lang, stripCommands(it, it.reference)), hypTok = tokensFor(it.lang, stripCommands(it, canonNumbers(it, t)));
  if (process.env.EVAL_DEBUG_ID === it.id) console.error(JSON.stringify({ refTok, hypTok }));
  r.edits = editDistance(refTok, hypTok); r.refLen = refTok.length;
  r.termHit = it.terms.filter((x) => t.includes(apos(x))).length;
  r.termHitCi = it.terms.filter((x) => lower.includes(apos(x).toLowerCase())).length;
  r.termN = it.terms.length;
  r.missedTerms = it.terms.filter((x) => !t.includes(apos(x)));
  if (it.numbers) { r.numN = it.numbers.length; r.numHit = it.numbers.filter((alts) => alts.some((a) => lower.includes(apos(a).toLowerCase()))).length; }
  if (it.contractions) { r.conN = it.contractions.length; r.conHit = it.contractions.filter((c) => countWord(t, c) > 0).length; }
  if (it.fillers) { r.fillerLeft = it.fillers.reduce((a, f) => a + countWord(t, f), 0); }
  if (it.spoken_punct) {
    r.spN = it.spoken_punct.length;
    r.spHit = it.spoken_punct.filter(({ cmd, sym }) => countWord(t, cmd) < countWord(it.reference, cmd) && t.includes(sym)).length;
  }
  // Onset: is the first spoken (non-filler) token near the start of the hypothesis?
  if (refTok.length > 0) {
    r.onsetLost = it.lang === 'en'
      ? !hypTok.slice(0, 3).includes(refTok[0])
      : !hypTok.slice(0, 5).join('').includes(refTok.slice(0, 2).join(''));
  }
  return r;
}

export function expectChecks(it, strength, text) {
  const e = it.polish_expect?.[strength];
  if (!e) return null;
  const t = apos(text ?? ''), lower = t.toLowerCase();
  const fails = [];
  for (const m of e.must ?? []) if (!t.includes(apos(m))) fails.push(`missing "${m}"`);
  for (const m of e.must_not ?? []) if (lower.includes(apos(m).toLowerCase())) fails.push(`contains "${m}"`);
  return fails;
}

// ── aggregation helpers ─────────────────────────────────────────────────────
export const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
export const ms = (x) => (x === null || x === undefined ? 'n/a' : `${Math.round(x)}`);
export const rateName = (lang) => (lang === 'en' ? 'WER' : lang === 'zh' ? 'CER' : 'MER');

export function agg(rows, textKey = 'pipeline_text') {
  const a = { n: 0, edits: 0, refLen: 0, termHit: 0, termHitCi: 0, termN: 0, numHit: 0, numN: 0, conHit: 0, conN: 0, spHit: 0, spN: 0, fillerItems: 0, fillerClean: 0, onsetLost: 0, missed: [] };
  for (const row of rows) {
    const it = byId.get(row.id);
    if (!it) continue;
    const c = checks(it, row[textKey] ?? '');
    a.n++; a.edits += c.edits; a.refLen += c.refLen; a.termHit += c.termHit; a.termHitCi += c.termHitCi; a.termN += c.termN;
    if (c.numN) { a.numN += c.numN; a.numHit += c.numHit; }
    if (c.conN) { a.conN += c.conN; a.conHit += c.conHit; }
    if (c.spN) { a.spN += c.spN; a.spHit += c.spHit; }
    if (c.fillerLeft !== undefined) { a.fillerItems++; if (c.fillerLeft === 0) a.fillerClean++; }
    if (c.onsetLost) a.onsetLost++;
    for (const m of c.missedTerms) a.missed.push(`${row.id}:${m}`);
  }
  a.rate = a.refLen > 0 ? a.edits / a.refLen : null;
  return a;
}
export const fmtRate = (a) => (a.rate === null ? 'n/a' : `${(100 * a.rate).toFixed(1)}%`);
