// scripts/eval/speech-quality/two-stage-scoring.mjs — card POL-2 scoring for the
// two-stage polish eval (design docs/strategy/2026-10-14-two-stage-polish-design.md §9.4).
// Pure functions over one corpus item and the rows one press produced; no I/O.
// The CLI and report are score-two-stage.mjs; the unit test is
// scripts/pol2-two-stage-scoring.test.mjs.
//
// Tokens (both sides): NFKC, lower case for comparison, original case kept for
// the capitalisation check. Latin languages: words (letters/digits, inner
// apostrophes kept). Chinese and Japanese: one token per Han/kana character, a
// Latin/digit run is one token. Number forms listed in an item's `numbers` are
// mapped to the reference's form before tokenising the hypothesis.
//
// A SEAM is the boundary between two consecutive rows. Where it falls in the
// reference comes from a token alignment (edit distance with backtrace) of the
// joined rows against the reference. A seam is `end` when the reference has a
// sentence terminator in the gap before the token it lands on (or it lands at
// either end), otherwise `mid`. Per seam:
//   · mid seam: `terminator` (the row before it ends on . ! ? 。 ！ ？ …),
//     `dash` (it ends on an em dash: Soniox's forced finalize marks a cut
//     mid-phrase that way, apps/server-core/src/stt/leg-seam-join.ts EM_DASH),
//     `capital` (Latin only: the next row's first word is capitalised where the
//     reference word is not — German nouns are capitalised in the reference, so
//     they are not errors), `lead_punct` (the next row starts with punctuation);
//   · end seam: `lost_terminator` (the row before it does not end on one);
//   · both: `lost` reference tokens within 3 of the seam that the alignment
//     deletes or substitutes, and `dup` hypothesis tokens within 3 of it that it
//     inserts. These include recognition errors; the raw text (what the relay
//     asked the model to polish) is scored the same way to separate them.
// Blind spots: the alignment can shift a seam by a token when the words around
// it are wrong; a mid-sentence period the model put somewhere other than the
// row end is not a seam error (it is in the error rate); `capital` sees only the
// first word of a row.

import { joinRows } from './relay-rows.mjs';

const TERMINATOR_END = /[.!?。！？…]["'”’」』)）]*$/u;
const DASH_END = /—$/u;
const LEAD_PUNCT = /^[,.;:!?，。、；：！？]/u;
const LATIN_ABBR = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'nr', 'z.b', 'bzw', 'ca']);
const isCharLang = (lang) => lang === 'zh' || lang === 'ja';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = (s) => String(s ?? '').normalize('NFKC').replace(/[‘’ʼ`´]/g, "'").toLowerCase();

/** Tokens with offsets into `s`: [{t (folded), raw, start, end}]. */
export function tokenize(lang, s) {
  const text = String(s ?? '').normalize('NFKC');
  const re = isCharLang(lang)
    ? /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]|[\p{Script=Latin}\p{N}]+/gu
    : /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
  return [...text.matchAll(re)].map((m) => ({ t: fold(m[0]), raw: m[0], start: m.index, end: m.index + m[0].length }));
}

/** Any accepted number form becomes the form the reference uses (as scoring.mjs canonNumbers). */
export function canonNumbers(it, text) {
  let t = String(text ?? '');
  const refF = fold(it.reference);
  for (const alts of it.numbers ?? []) {
    const canon = alts.find((a) => refF.includes(fold(a)));
    if (!canon) continue;
    for (const a of [...alts].sort((x, y) => y.length - x.length)) {
      if (a === canon || canon.includes(a)) continue;
      const re = isCharLang(it.lang) ? new RegExp(`(?<![\\p{N}])${escapeRe(a)}(?![\\p{N}])`, 'giu') : new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(a)}(?![\\p{N}])`, 'giu');
      t = t.replace(re, () => canon);
    }
  }
  return t;
}

/** Edit-distance alignment with backtrace: ops in order, each {op: M|S|D|I, r, h}. */
export function align(ref, hyp) {
  const n = ref.length, m = hyp.length;
  const d = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
  }
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) { ops.push({ op: ref[i - 1] === hyp[j - 1] ? 'M' : 'S', r: i - 1, h: j - 1 }); i--; j--; }
    else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { ops.push({ op: 'D', r: i - 1, h: -1 }); i--; }
    else { ops.push({ op: 'I', r: -1, h: j - 1 }); j--; }
  }
  return { distance: d[n][m], ops: ops.reverse() };
}

/** The reference token index a hypothesis boundary `b` (tokens before it) maps to. */
export function refIndexAt(ops, b) {
  let rc = 0, hc = 0;
  for (const o of ops) {
    if (hc === b && o.op !== 'D') return rc;
    if (o.op !== 'I') rc++;
    if (o.op !== 'D') hc++;
  }
  return rc;
}

/** Is the reference boundary before token `r` a sentence end? */
export function isSentenceEnd(lang, reference, refToks, r) {
  if (r <= 0 || r >= refToks.length) return true;
  const gap = reference.normalize('NFKC').slice(refToks[r - 1].end, refToks[r].start);
  if (isCharLang(lang)) return /[。！？!?…]/u.test(gap) || /[.](?=\s)/u.test(gap);
  // The gap ends where the next token starts, so a terminator must be followed by
  // whitespace INSIDE it: "1.5" has the gap "." and is not a sentence end.
  if (!/[.!?…](?=["'”’)]*\s)/u.test(gap)) return false;
  return !(/^\.\s/.test(gap) && LATIN_ABBR.has(refToks[r - 1].t));
}

const ALT = (spec) => String(spec).split('|');
const has = (lang, text, w) => countIn(lang, text, w) > 0;
/** Occurrences of `w` in `text`: substring for CJK, whole word otherwise; case-insensitive. */
export function countIn(lang, text, w) {
  const t = fold(text), x = fold(w);
  if (!x) return 0;
  if (isCharLang(lang) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(x)) return t.split(x).length - 1;
  return (t.match(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(x).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'gu')) ?? []).length;
}
const countExact = (text, w) => String(text ?? '').normalize('NFKC').split(w.normalize('NFKC')).length - 1;

/** Planned cuts as reference token indices. */
export function plannedCuts(it) {
  const ref = it.reference.normalize('NFKC');
  const toks = tokenize(it.lang, ref);
  return (it.cuts ?? []).map((c) => {
    const at = ref.indexOf(c.after.normalize('NFKC'));
    if (at < 0 || ref.indexOf(c.after.normalize('NFKC'), at + 1) >= 0) throw new Error(`${it.id}: cut anchor "${c.after}" is not unique in the reference`);
    const off = at + c.after.normalize('NFKC').length;
    return { kind: c.kind, r: toks.filter((t) => t.start < off).length };
  });
}

/** Seams of one row list. `rows` = delivered row texts in order. */
export function seams(it, rows) {
  const refToks = tokenize(it.lang, it.reference);
  const rowToks = rows.map((t) => tokenize(it.lang, canonNumbers(it, t)));
  const hyp = rowToks.flat();
  const { distance, ops } = align(refToks.map((t) => t.t), hyp.map((t) => t.t));
  const planned = plannedCuts(it);
  const out = [];
  let b = 0;
  for (let k = 0; k + 1 < rows.length; k++) {
    b += rowToks[k].length;
    if (!rows[k].trim() || !rows[k + 1].trim()) continue;
    const r = refIndexAt(ops, b);
    const kind = isSentenceEnd(it.lang, it.reference, refToks, r) ? 'end' : 'mid';
    const before = rows[k].trimEnd(), after = rows[k + 1].trimStart();
    const s = { k, r, kind, planned: planned.find((p) => Math.abs(p.r - r) <= 2)?.kind ?? null, errors: [] };
    if (kind === 'mid') {
      if (TERMINATOR_END.test(before)) s.errors.push('terminator');
      if (DASH_END.test(before)) s.errors.push('dash');
      if (LEAD_PUNCT.test(after)) s.errors.push('lead_punct');
      if (!isCharLang(it.lang) && rowToks[k + 1].length && refToks[r]) {
        const h0 = rowToks[k + 1][0].raw[0], r0 = refToks[r].raw[0];
        if (h0 !== h0.toLowerCase() && r0 === r0.toLowerCase()) s.errors.push('capital');
      }
    } else if (!TERMINATOR_END.test(before) && r > 0 && r < refToks.length) s.errors.push('lost_terminator');
    s.lost = ops.filter((o) => (o.op === 'D' || o.op === 'S') && o.r >= r - 3 && o.r < r + 3).length;
    s.dup = ops.filter((o) => o.op === 'I' && o.h >= b - 3 && o.h < b + 3).length;
    out.push(s);
  }
  return { seams: out, distance, ref_tokens: refToks.length, planned };
}

/** Everything one press is scored on. `rows` = delivered texts; `raw` = per-row raw texts or null. */
export function scorePress(it, strength, rows, raw = null) {
  const joined = joinRowTexts(it.lang, rows);
  const s = seams(it, rows);
  const later = joinRowTexts(it.lang, rows.slice(1));
  const res = {
    error_rate: s.ref_tokens ? s.distance / s.ref_tokens : null, errors: s.distance, ref_tokens: s.ref_tokens,
    rows: rows.length, seams: s.seams, planned_cuts: s.planned.length,
    cut_errors: s.seams.filter((x) => x.kind === 'mid' && x.errors.length > 0).length,
    cross_refs: (it.cross_refs ?? []).map((c) => ({
      right: c.right,
      in_context: rows.length > 1 && has(it.lang, rows[0], c.right),
      ok: rows.length > 1 && countIn(it.lang, later, c.right) >= 1 && !(c.wrong ?? []).some((w) => has(it.lang, later, w)),
    })),
    self_correction: it.self_correction ? it.self_correction.right.some((w) => has(it.lang, joined, w)) : null,
    poison: (it.poison ?? []).map((p) => ({ keep: p.keep, ok: countIn(it.lang, joined, p.keep) >= countIn(it.lang, it.reference, p.keep) && !has(it.lang, joined, p.bad) })),
    expect: expectations(it, strength, joined),
    term_inconsistent: (it.terms ?? []).reduce((a, term) => a + Math.max(0, countIn(it.lang, joined, term) - countExact(joined, term)), 0),
  };
  if (raw && raw.every((x) => typeof x === 'string')) {
    const rs = seams(it, raw);
    res.raw = { error_rate: rs.ref_tokens ? rs.distance / rs.ref_tokens : null, errors: rs.distance, cut_errors: rs.seams.filter((x) => x.kind === 'mid' && x.errors.length > 0).length, seams: rs.seams };
  }
  return res;
}

/** polish_expect.<strength>: every `must` entry (alternatives with `|`) present, no `must_not` present (case-sensitive). */
export function expectations(it, strength, text) {
  const e = it.polish_expect?.[strength];
  if (!e) return null;
  const fails = [];
  for (const m of e.must ?? []) if (!ALT(m).some((w) => countExact(text, w) > 0 || has(it.lang, text, w))) fails.push(`must:${m}`);
  for (const m of e.must_not ?? []) if (countExact(text, m) > 0) fails.push(`must_not:${m}`);
  return { ok: fails.length === 0, fails };
}

/** Rows joined the way the phone joins them (relay-rows.mjs). */
export const joinRowTexts = (_lang, rows) => joinRows(rows);
