// scripts/eval/speech-quality/ml-scoring.mjs — card ML-0 scoring for fr / es /
// de / ja / ko / ru. Separate from scoring.mjs (en / zh / mixed) so the EVAL-1
// numbers cannot move when this file changes. Pure functions, no I/O except
// the corpus (FLOWMIC_EVAL_CORPUS, see lib.mjs).
//
// Error-rate unit, per language (stated in the report header too):
//   fr / es / de / ru  WER on words (Unicode letters and digits; hyphens and
//                      slashes split; French elisions l' d' j' qu' split off).
//   ja                 CER on characters (each kana / kanji is one token; a
//                      Latin or digit run is one token). Japanese has no word
//                      spaces, so word error would score the tokenizer.
//   ko                 CER on Hangul syllables (same rule as ja), plus an
//                      eojeol (space-separated word) WER as a second column.
//                      Korean ASR spacing is inconsistent and eojeol WER
//                      charges a missing space as two word errors, so CER is
//                      the primary number.
// Both sides: NFKC, lower case, punctuation removed, ё -> е (ru), listed
// fillers removed, number forms from the item's `numbers` mapped to the
// reference's form, spoken punctuation commands removed (own metric).

import { loadCorpus } from './lib.mjs';

export const corpus = loadCorpus();
export const byId = new Map(corpus.items.map((it) => [it.id, it]));
export const ML_LANGS = ['fr', 'es', 'de', 'ja', 'ko', 'ru'];
export const isCharLang = (lang) => lang === 'ja' || lang === 'ko' || lang === 'zh';
export const rateName = (lang) => (isCharLang(lang) ? 'CER' : 'WER');

// Fillers dropped from both sides before the edit distance. Ambiguous words
// that are also content (es "este", ru "это", ko "그") are NOT here; they are
// scored only by the per-item `fillers` metric.
const DROP_FILLERS = {
  fr: ['euh', 'heu', 'hum', 'ben', 'bah'],
  de: ['äh', 'ähm', 'öhm', 'hm', 'hmm', 'äm'],
  es: ['eh', 'em', 'ehm', 'mmm', 'mm'],
  ru: ['э', 'ээ', 'эээ', 'эм', 'ну'],
  ko: ['음', '어', '아'],
  ja: ['えーと', 'ええと', 'えっと', 'あのー', 'えー', 'あの'],
};

const apos = (s) => s.replace(/[‘’ʼ`´]/g, "'");
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = (lang, s) => {
  let t = apos(String(s ?? '').normalize('NFKC')).toLowerCase();
  if (lang === 'ru') t = t.replace(/ё/g, 'е');
  return t;
};

/** Whole-word (letters/digits boundary) or substring for ja. */
export function countIn(lang, text, w) {
  const t = fold(lang, text), x = fold(lang, w);
  if (!x) return 0;
  if (lang === 'ja' || lang === 'zh') return t.split(x).length - 1;
  // Korean particles attach to the word (김 대리님께), so a multi-syllable
  // needle only needs a word START; a single syllable (음, 안, 못) needs both
  // edges or it would match inside 어제 / 안녕.
  const tail = lang === 'ko' && [...x].length > 1 ? '' : '(?![\\p{L}\\p{N}])';
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(x).replace(/ /g, '\\s+')}${tail}`, 'gu');
  return (t.match(re) ?? []).length;
}
/** Case-sensitive variant (German Sie vs sie). */
function countExact(lang, text, w) {
  const t = apos(String(text ?? '').normalize('NFKC')), x = apos(w.normalize('NFKC'));
  if (lang === 'ja') return t.split(x).length - 1;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(x).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'gu');
  return (t.match(re) ?? []).length;
}

function dropFillers(lang, t) {
  for (const f of DROP_FILLERS[lang] ?? []) {
    t = lang === 'ja' ? t.split(f).join(' ') : t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(f)}(?![\\p{L}\\p{N}])`, 'gu'), ' ');
  }
  return t;
}

export function tokens(lang, s, { unit = 'primary', drop = true } = {}) {
  let t = fold(lang, s).replace(/(\d)[ ,.  ](?=\d{3}\b)/g, '$1');
  if (drop) t = dropFillers(lang, t);
  if (isCharLang(lang) && unit === 'primary') {
    return t.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]|[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N}.']*[\p{Script=Latin}\p{N}]|[\p{Script=Latin}\p{N}]/gu) ?? [];
  }
  if (lang === 'fr') t = t.replace(/\b([cdjlmnst]|qu)'/gu, '$1 ');
  return t.split(/[^\p{L}\p{N}']+/u).map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean);
}

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

/** Map any accepted number form to the one the reference uses (see scoring.mjs canonNumbers). */
export function canonNumbers(it, text) {
  let t = String(text ?? '');
  const refF = fold(it.lang, it.reference);
  for (const alts of it.numbers ?? []) {
    const canon = alts.find((a) => refF.includes(fold(it.lang, a)));
    if (!canon) continue;
    for (const a of [...alts].sort((x, y) => y.length - x.length)) {
      if (a === canon || canon.includes(a)) continue;
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(a)}(?![\\p{N}])`, 'giu');
      const reCjk = new RegExp(`(?<![\\p{N}])${escapeRe(a)}(?![\\p{N}])`, 'giu');
      t = t.replace(isCharLang(it.lang) ? reCjk : re, () => canon);
    }
  }
  return t;
}

export function stripCommands(it, text) {
  let t = String(text ?? '');
  for (const { cmd } of [...(it.spoken_punct ?? [])].sort((a, b) => b.cmd.length - a.cmd.length)) {
    t = it.lang === 'ja' ? t.split(cmd).join(' ') : t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(cmd).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu'), ' ');
  }
  return t;
}

const SYM_ALT = { '?': ['?', '？'], '？': ['?', '？'], ',': [',', '、', '，'], '、': ['、', ',', '，'], '.': ['.', '。'], '。': ['。', '.'], ':': [':', '：'], '\n': ['\n'] };

// ── language drift ──────────────────────────────────────────────────────────
//
// A deliberately simple detector of our own (card ML-0 asks for one, not a
// library): script shares for ja / ko / ru, a stopword profile for the Latin
// languages. Lists avoid words shared across the four Latin languages (a, de,
// en, la, que, no, es, in, an, was, will, die, on, so).
const STOP = {
  en: 'the and is are were to of that this with for it be have has we you they should please before after would can not from at by our your which there been what when if but just my he she its do does did than then them their these those into about also'.split(' '),
  fr: 'le les des du une et est sont qui pour avec dans sur pas ne nous vous je tu il elle ils ce cette au aux mais ou très été être son sa ses leur leurs par c l d j qu n s y on'.split(' '),
  es: 'el los las del y una unos para con por pero muy más está están hay ya lo se su sus al como cuando también este esta esto eso nos usted puedes tiene yo mi sí hemos han'.split(' '),
  de: 'der das und ist sind nicht ein eine einen dem den des mit für auf ich wir sie du zu von bei auch noch wird werden hat haben dass oder aber wenn bitte schon wie nach im vom zum zur uns euch ihr mir dir'.split(' '),
};
const LATIN_LANGS = ['en', 'fr', 'es', 'de'];

function scriptCounts(s) {
  const c = { latin: 0, cyr: 0, hangul: 0, kana: 0, han: 0 };
  for (const ch of s) {
    if (/\p{Script=Latin}/u.test(ch)) c.latin++;
    else if (/\p{Script=Cyrillic}/u.test(ch)) c.cyr++;
    else if (/\p{Script=Hangul}/u.test(ch)) c.hangul++;
    else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) c.kana++;
    else if (/\p{Script=Han}/u.test(ch)) c.han++;
  }
  return c;
}

function latinProfile(sentence) {
  const words = sentence.toLowerCase().replace(/[’']/g, "' ").split(/[^\p{L}']+/u).map((w) => w.replace(/'$/, '')).filter(Boolean);
  const score = {};
  for (const l of LATIN_LANGS) score[l] = words.filter((w) => STOP[l].includes(w)).length;
  return { words: words.length, score };
}

/** Which language one sentence is in, or null when it is too short to say. */
function sentenceLang(sentence) {
  const c = scriptCounts(sentence);
  const letters = c.latin + c.cyr + c.hangul + c.kana + c.han;
  if (letters < 4) return null;
  if (c.kana / letters >= 0.15) return 'ja';
  if (c.hangul / letters >= 0.4) return 'ko';
  if (c.cyr / letters >= 0.4) return 'ru';
  if (c.han / letters >= 0.4) return 'zh';
  if (c.latin / letters >= 0.6) {
    const { words, score } = latinProfile(sentence);
    if (words < 4) return null;
    const best = LATIN_LANGS.reduce((a, b) => (score[b] > score[a] ? b : a));
    const sorted = Object.values(score).sort((x, y) => y - x);
    // Two stopword hits at least: one shared-looking word must not decide.
    if (score[best] < 2 || sorted[0] === sorted[1]) return null;
    return best;
  }
  return null;
}

/**
 * Drift = some sentence of the text is confidently in another language than
 * `lang`. `terms` (the item's own English terms) are removed first so
 * "GitHub Actions" in a Japanese sentence is not English. Returns the
 * offending sentences so every case can be listed.
 */
export function detectDrift(lang, text, terms = []) {
  let t = String(text ?? '');
  for (const term of terms) t = t.split(term).join(' ');
  const sentences = t.split(/(?<=[.!?。！？])\s*|\n+/u).map((s) => s.trim()).filter(Boolean);
  const off = [];
  for (const s of sentences) {
    const l = sentenceLang(s);
    if (l && l !== lang) off.push({ sentence: s.slice(0, 120), detected: l });
  }
  const whole = sentenceLang(t);
  const drifted = off.length > 0 || (whole !== null && whole !== lang);
  return { drifted, detected: off[0]?.detected ?? (whole !== lang ? whole : null), sentences: off };
}

// ── per-item checks ─────────────────────────────────────────────────────────
export function checks(it, text) {
  const raw = String(text ?? '');
  const r = {};
  const refT = tokens(it.lang, stripCommands(it, it.reference));
  const hypT = tokens(it.lang, stripCommands(it, canonNumbers(it, raw)));
  if (process.env.EVAL_DEBUG_ID === it.id) console.error(JSON.stringify({ refT, hypT }));
  r.edits = editDistance(refT, hypT); r.refLen = refT.length;
  if (it.lang === 'ko') {
    const a = tokens('ko', stripCommands(it, it.reference), { unit: 'word' }), b = tokens('ko', stripCommands(it, canonNumbers(it, raw)), { unit: 'word' });
    r.wEdits = editDistance(a, b); r.wRefLen = a.length;
  }
  const despaced = (s) => (isCharLang(it.lang) ? s.replace(/\s+/g, '') : s);
  r.termN = it.terms.length;
  r.termHit = it.terms.filter((x) => despaced(apos(raw)).includes(despaced(apos(x)))).length;
  r.termHitCi = it.terms.filter((x) => despaced(fold(it.lang, raw)).includes(despaced(fold(it.lang, x)))).length;
  r.missedTerms = it.terms.filter((x) => !despaced(apos(raw)).includes(despaced(apos(x))));
  if (it.numbers) {
    r.numN = it.numbers.length; r.numHit = 0; r.numDigit = 0; r.numWord = 0; r.missedNumbers = [];
    const f = despaced(fold(it.lang, raw));
    for (const alts of it.numbers) {
      const hit = alts.find((a) => f.includes(despaced(fold(it.lang, a))));
      if (hit) { r.numHit++; if (/\d/.test(hit)) r.numDigit++; else r.numWord++; } else r.missedNumbers.push(alts[0]);
    }
  }
  if (it.fillers) r.fillerLeft = it.fillers.reduce((a, f) => a + countIn(it.lang, raw, f), 0);
  if (it.spoken_punct) {
    r.spN = it.spoken_punct.length;
    r.spHit = it.spoken_punct.filter(({ cmd, sym }) => countIn(it.lang, raw, cmd) < countIn(it.lang, it.reference, cmd) && (SYM_ALT[sym] ?? [sym]).some((s) => raw.includes(s))).length;
    r.spLeft = it.spoken_punct.reduce((a, { cmd }) => a + countIn(it.lang, raw, cmd), 0);
  }
  if (it.self_correction) {
    const has = (xs) => xs.some((x) => countIn(it.lang, raw, x) > 0);
    r.scRight = has(it.self_correction.right);
    r.scWrong = has(it.self_correction.wrong);
    r.scResolved = r.scRight && !r.scWrong;
  }
  if (it.register) {
    const caseSensitive = it.lang === 'de';
    // Korean: spacing before an auxiliary (보내 주시겠어요 / 보내주시겠어요) is free
    // variation, so register endings are matched with spaces removed.
    const c = (w) => (caseSensitive ? countExact(it.lang, raw, w) : it.lang === 'ko' ? (despaced(raw).includes(despaced(w)) ? 1 : 0) : countIn(it.lang, raw, w));
    r.regKept = it.register.keep.every((k) => c(k) > 0);
    r.regFlipped = it.register.forbid.filter((f) => c(f) > 0);
    r.regOk = r.regKept && r.regFlipped.length === 0;
  }
  if (it.negation) {
    const need = new Map();
    for (const n of it.negation) need.set(n, (need.get(n) ?? 0) + 1);
    r.negLost = [...need].filter(([w, k]) => countIn(it.lang, raw, w) < k).map(([w]) => w);
    r.negOk = r.negLost.length === 0;
  }
  const d = detectDrift(it.lang, raw, it.terms);
  r.drift = d.drifted ? d : null;
  return r;
}

export function expectChecks(it, strength, text) {
  const e = it.polish_expect?.[strength];
  if (!e) return null;
  const t = apos(String(text ?? ''));
  const fails = [];
  const has = (m) => (isCharLang(it.lang) ? t.replace(/\s+/g, '').includes(apos(m).replace(/\s+/g, '')) : (it.lang === 'de' ? countExact(it.lang, t, m) : countIn(it.lang, t, m)) > 0);
  for (const m of e.must ?? []) if (!has(m)) fails.push(`missing "${m}"`);
  for (const m of e.must_not ?? []) if (has(m)) fails.push(`contains "${m}"`);
  return fails;
}

export function agg(rows, textKey) {
  const a = { n: 0, edits: 0, refLen: 0, wEdits: 0, wRefLen: 0, termHit: 0, termHitCi: 0, termN: 0, numHit: 0, numN: 0, numDigit: 0, numWord: 0, spHit: 0, spN: 0, fillerItems: 0, fillerClean: 0, scN: 0, scResolved: 0, scBoth: 0, regN: 0, regOk: 0, negN: 0, negOk: 0, drift: [], missed: [], missedNumbers: [] };
  for (const row of rows) {
    const it = byId.get(row.id);
    if (!it) continue;
    const c = checks(it, row[textKey] ?? '');
    a.n++; a.edits += c.edits; a.refLen += c.refLen; a.termHit += c.termHit; a.termHitCi += c.termHitCi; a.termN += c.termN;
    if (c.wRefLen !== undefined) { a.wEdits += c.wEdits; a.wRefLen += c.wRefLen; }
    if (c.numN) { a.numN += c.numN; a.numHit += c.numHit; a.numDigit += c.numDigit; a.numWord += c.numWord; for (const m of c.missedNumbers) a.missedNumbers.push(`${row.id}:${m}`); }
    if (c.spN) { a.spN += c.spN; a.spHit += c.spHit; }
    if (c.fillerLeft !== undefined) { a.fillerItems++; if (c.fillerLeft === 0) a.fillerClean++; }
    if (c.scResolved !== undefined) { a.scN++; if (c.scResolved) a.scResolved++; if (c.scRight && c.scWrong) a.scBoth++; }
    if (c.regOk !== undefined) { a.regN++; if (c.regOk) a.regOk++; }
    if (c.negOk !== undefined) { a.negN++; if (c.negOk) a.negOk++; }
    if (c.drift) a.drift.push({ id: row.id, ...c.drift });
    for (const m of c.missedTerms) a.missed.push(`${row.id}:${m}`);
  }
  a.rate = a.refLen > 0 ? a.edits / a.refLen : null;
  a.wRate = a.wRefLen > 0 ? a.wEdits / a.wRefLen : null;
  return a;
}
