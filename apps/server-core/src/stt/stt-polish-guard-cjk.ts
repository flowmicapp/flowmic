// GUARD-CJK (2026-10-15): time and place words, opposite pairs and script in
// Han / kana / Hangul text, and content words in Hangul and Cyrillic, must
// survive the polish.
//
// Before this module those scripts were guarded only by the closed-class
// tables (negation / modal / quantifier / numbers) and the §3.1 edit budget.
// The Latin content rule (stt-polish-guard-content.ts) does not read them, and
// the budget is a count, not a meaning. Measured holes on main, all accepted
// (the ja 無理 -> 大丈夫 and 本番へ rows stay open: rule 2 below):
//   · zh smooth 「我们明天去北京开会」->「我们后天去上海开会」; strict
//     「我们去北京下周开会」->「我们去上海下周开会」;
//   · ja 「明日は無理です」->「明日は大丈夫です」, 「明日、東京で会議」->
//     「明後日、大阪で会議」, and strict dropping 本番へ from 「本番へのデプロイ」;
//   · ko 「서울에서 만나요」->「부산에서 만나요」;
//   · ru 「Я приду завтра」->「Я приду послезавтра」, 「С моей точки зрения」
//     ->「С моей зрения」 (only the base form точка was listed anywhere).
//
// What is compared (all on text with dictated commands blanked, the same text
// the numbers gate reads):
//   1. TIME AND PLACE WORDS (stt-polish-guard-cjk-tables.ts): days, weeks,
//      months, years, weekdays, parts of the day, major cities and countries.
//      A class the output has FEWER of is refused. A class it has MORE of is
//      refused unless each new one was written over something the input had
//      in the same place (名天 -> 明天, アスコラ -> 明日から: a misheard word
//      respelled), never added from nothing.
//   2. HAN, per changed stretch of a character diff (width folded, each run
//      of spaces and punctuation one boundary), judged only where a meaning
//      can be read without a reading dictionary:
//        · written in the other Chinese script (这個 -> 这个, or back) ->
//          refused: a polish does not convert the user's script;
//        · one character for its opposite (买 / 卖, 来 / 去, 你 / 我;
//          HAN_SWAP_PAIRS) -> refused;
//        · a connective for one of another class (但是 -> 所以) -> refused;
//        · numbers on both sides (两点半 -> 2:30) are not judged here, and
//          nothing else is: a change inside a time word of the same meaning
//          (下礼拜三 -> 下周三) is left to the term check of rule 1.
//      Two or more Han characters swapped, dropped or added are NOT refused:
//      that cannot be told from a same-reading repair (後悔 -> 公開, 移行 ->
//      以降, 带吗 -> 代码) without a reading table (ledger follow-up card).
//   3. HANGUL WORDS: a content word (two or more syllables after its particle
//      is stripped, not a filler or a pronoun) must still be in the output,
//      spaces ignored; a missing one is excused only by a new word of close
//      spelling (jamo edit distance within 40%: 다름이 -> 다리의) or by a new
//      Latin word (시 -> CI).
//   4. CYRILLIC WORDS: the same, compared by stem (the common endings
//      stripped, so точки and точка are one word); excused by a close
//      spelling or a new Latin word. Fillers set off by commas (в общем,
//      блин) and a word run repeated at once (я я думаю) are read once.
//
// Cost, stated: a Han content swap that keeps every time / place word,
// opposite pair and script (同意 -> 反对, 会议室 -> 食堂) is accepted, as on
// main before this module; a Hangul or Cyrillic word repair the spelling
// distance does not cover is refused (smooth then falls back to one strict
// polish; strict leaves the transcript as it was, with the notice). The
// sound-alike excuse (stt-polish-guard-soundalike.ts) is Latin-script only.

import { wordNumbers } from './stt-polish-guard-numwords';
import {
  CJK_PLACE, CJK_TIME, CYR_COLLOQUIAL, CYR_SET_OFF_FILLERS, CYR_STOP, CYR_TIME, HAN_CONNECTIVES, HAN_FILLERS, HAN_NUMERALS, HAN_PARTICLES, HAN_SWAP_COMPOUNDS, HAN_SWAP_PAIRS,
  HANGUL_STOP, KANA_FILLERS, TRAD_SIMP, type TermClass,
} from './stt-polish-guard-cjk-tables';

const HAN = /\p{Script=Han}/u;
const WIDE_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Width folded (NFKC), each run of spaces / punctuation / symbols one
 *  space, as codepoints. The space stays a boundary: 「一下，下周」 must not
 *  read as 下下周. */
function squeeze(s: string): string[] {
  return [...s.normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, ' ').trim()];
}

const HANGUL_CHAR = /\p{Script=Hangul}/u;

/** Katakana folded to hiragana (one codepoint each), for matching readings. */
function hira(c: string): string {
  const code = c.codePointAt(0)!;
  return code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : c;
}

interface Hunk { rs: number; re: number; ps: number; pe: number }

/** The changed stretches between two codepoint arrays (LCS). */
function hunksOf(a: readonly string[], b: readonly string[]): Hunk[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if (n === 0 && m === 0) return [];
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[pre + i] === b[pre + j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[pre + i] === b[pre + j]) {
      if (cur) { out.push(cur); cur = null; }
      i += 1; j += 1;
    } else {
      cur ??= { rs: pre + i, re: pre + i, ps: pre + j, pe: pre + j };
      if (j < m && (i >= n || dp[i * w + j + 1]! >= dp[(i + 1) * w + j]!)) { j += 1; cur.pe = pre + j; }
      else { i += 1; cur.re = pre + i; }
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ─── 1. time and place words ───────────────────────────────────────────────

interface Surface { text: string[]; cls: TermClass }
const BY_FIRST: ReadonlyMap<string, readonly Surface[]> = (() => {
  const map = new Map<string, Surface[]>();
  for (const cls of [...CJK_TIME, ...CJK_PLACE]) {
    for (const s of cls.surfaces) {
      const text = [...s].map(hira);
      const list = map.get(text[0]!) ?? [];
      list.push({ text, cls });
      map.set(text[0]!, list);
    }
  }
  for (const list of map.values()) list.sort((x, y) => y.text.length - x.text.length);
  return map;
})();

interface Occ { cls: TermClass; start: number; end: number; surface: string }

/** `chars[from, to)` with the boundary spaces dropped. */
function solid(chars: readonly string[], from: number, to: number): string {
  return chars.slice(Math.max(0, from), Math.max(0, to)).filter((c) => c !== ' ').join('');
}

/** Is the same word, met again at `start`, a stutter of the unit that began
 *  with its previous occurrence (明天 明天, 来週の、来週の)? The unit is what
 *  lies between the two, spaces and punctuation dropped; it must follow
 *  again right away. */
function stutter(chars: readonly string[], prev: Occ, start: number): boolean {
  const unit = solid(chars, prev.start, start);
  if (unit.length === 0 || [...unit].length > 6) return false;
  let k = start;
  let read = '';
  while (k < chars.length && read.length < unit.length) {
    if (chars[k] !== ' ') read += chars[k];
    k += 1;
  }
  return read === unit;
}

/** Every time / place word in `chars`, longest first, left to right. A
 *  repetition of the same word as a stutter (明天明天, 来週の、来週の) counts once. */
function termOccurrences(chars: readonly string[]): Occ[] {
  // Korean spacing varies (이번 주 / 이번주): a space between two Hangul
  // letters is read through. Positions stay those of `chars`.
  const at: number[] = [];
  const folded: string[] = [];
  chars.forEach((c, k) => {
    if (c === ' ' && HANGUL_CHAR.test(chars[k - 1] ?? '') && HANGUL_CHAR.test(chars[k + 1] ?? '')) return;
    at.push(k);
    folded.push(hira(c));
  });
  const out: Occ[] = [];
  let i = 0;
  while (i < folded.length) {
    const hit = (BY_FIRST.get(folded[i]!) ?? []).find((s) => s.text.every((c, k) => folded[i + k] === c));
    if (hit === undefined) { i += 1; continue; }
    const surface = hit.text.join('');
    const start = at[i]!;
    const end = at[i + hit.text.length - 1]! + 1;
    const prev = [...out].reverse().find((o) => o.surface === surface);
    if (!(prev && stutter(chars, prev, start))) out.push({ cls: hit.cls, start, end, surface });
    i += hit.text.length;
  }
  return out;
}

function termDrift(r: readonly string[], p: readonly string[], hunks: readonly Hunk[]): string | null {
  const ro = termOccurrences(r);
  const po = termOccurrences(p);
  if (ro.length === 0 && po.length === 0) return null;
  const count = (os: readonly Occ[]): Map<TermClass, number> => {
    const m = new Map<TermClass, number>();
    for (const o of os) m.set(o.cls, (m.get(o.cls) ?? 0) + 1);
    return m;
  };
  const rc = count(ro);
  const pc = count(po);
  // Lost only if missing with the punctuation boundaries ignored too: a comma
  // the polish put inside a run that read as a place (その日本当に ->
  // その日、本当に: 日本) did not remove that place.
  let joined: Map<TermClass, number> | null = null;
  for (const [cls, n] of rc) {
    if ((pc.get(cls) ?? 0) >= n) continue;
    joined ??= count(termOccurrences(p.filter((c) => c !== ' ')));
    if ((joined.get(cls) ?? 0) < n) return cls.kind;
  }
  for (const [cls, n] of pc) {
    const need = n - (rc.get(cls) ?? 0);
    if (need <= 0) continue;
    // Written over something the input had in the same place.
    const respelled = po.filter((o) => o.cls === cls
      && hunks.some((h) => h.re > h.rs && h.ps < o.end && o.start < h.pe)).length;
    if (respelled < need) return cls.kind;
  }
  return null;
}

// ─── 2. Han and katakana ──────────────────────────────────────────────────

const FILLERS = [...HAN_FILLERS, ...KANA_FILLERS].map((f) => f.normalize('NFKC')).sort((x, y) => y.length - x.length);

function stripFillers(s: string): string {
  let out = s;
  for (const f of FILLERS) out = out.split(f).join('');
  return out;
}

function isContentHan(c: string): boolean {
  return HAN.test(c) && !HAN_NUMERALS.has(c) && !HAN_PARTICLES.has(c);
}

const DIGIT = /[0-9]/u;
/** Characters that may stand around a number: half, o'clock, units, of. */
const NUMBER_COMPANIONS = new Set([...'半点點分秒时時号號月日年天周週个個之第']);
/** Has a digit or a Han numeral. */
function hasNumber(s: string): boolean {
  return [...s].some((c) => DIGIT.test(c) || HAN_NUMERALS.has(c));
}
/** Only digits, Han numerals and the characters that go with a number. */
function numeric(s: string): boolean {
  return s.length > 0 && [...s].every((c) => DIGIT.test(c) || HAN_NUMERALS.has(c) || NUMBER_COMPANIONS.has(c));
}

const CONNECTIVES: readonly [string, number][] = HAN_CONNECTIVES
  .flatMap((cls, k) => cls.map((w) => [w, k] as [string, number]))
  .sort((x, y) => y[0].length - x[0].length);

/** The connective classes `s` is made of ('' when empty, sorted keys), or
 *  null when it holds anything else. */
function connectiveClasses(s: string): string | null {
  const keys = new Set<number>();
  let rest = s;
  while (rest.length > 0) {
    const hit = CONNECTIVES.find(([w]) => rest.startsWith(w));
    if (hit === undefined) return null;
    keys.add(hit[1]);
    rest = rest.slice(hit[0].length);
  }
  return [...keys].sort().join(',');
}

function occurrencesOf(hay: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) n += 1;
  return n;
}

function scriptConverted(raw: string, pol: string): boolean {
  const a = [...raw];
  const b = [...pol];
  if (a.length !== b.length || a.length === 0) return false;
  let pairs = 0;
  for (let k = 0; k < a.length; k++) {
    if (a[k] === b[k]) continue;
    if (TRAD_SIMP.get(a[k]!) !== b[k]) return false;
    pairs += 1;
  }
  return pairs > 0;
}

function hanDrift(r: readonly string[], p: readonly string[], hunks: readonly Hunk[]): string | null {
  for (const h of hunks) {
    const rawS = r.slice(h.rs, h.re).join('');
    const polS = p.slice(h.ps, h.pe).join('');
    if (!HAN.test(rawS + polS)) continue;
    if (scriptConverted(rawS, polS)) return 'cjk-script';
    // One character for its opposite (买 -> 卖, 你 -> 我), read as written:
    // a pronoun is not content, but swapping one changes who.
    if ([...rawS].length === 1 && [...polS].length === 1 && HAN_SWAP_PAIRS.has(rawS + polS)) return 'cjk-swap';
    // The same, inside a word that only then says the opposite (出席 -> 欠席).
    if ([...rawS].length === 1 && [...polS].length === 1 && r[h.re] !== undefined && r[h.re] === p[h.pe]
      && HAN_SWAP_COMPOUNDS.has(`${rawS}${r[h.re]}|${polS}${p[h.pe]}`)) return 'cjk-swap';
    // A number rewritten (两点半 -> 2:30, 百分之五 -> 5%): the numbers gate
    // has compared the values.
    const rawT = stripFillers(rawS.replace(/ /gu, ''));
    const polT = stripFillers(polS.replace(/ /gu, ''));
    const rawN = [...rawT].filter((c) => !HAN_PARTICLES.has(c)).join('');
    const polN = [...polT].filter((c) => !HAN_PARTICLES.has(c)).join('');
    if (numeric(rawN) && numeric(polN) && (hasNumber(rawN) || hasNumber(polN))) continue;
    // A connective for another of its class (以及 -> 和); of another class
    // (但是 -> 所以), refused. Added or dropped: not judged (HAN_CONNECTIVES).
    const rc = connectiveClasses(rawT);
    const pc = connectiveClasses(polT);
    if (rc !== null && pc !== null && rc !== '' && pc !== '' && rc !== pc) return 'cjk-swap';
    // The opposite pair again, with fillers and particles around it.
    const rHan = [...rawT].filter(isContentHan);
    const pHan = [...polT].filter(isContentHan);
    if (rHan.length === 1 && pHan.length === 1 && HAN_SWAP_PAIRS.has(rHan[0]! + pHan[0]!)) return 'cjk-swap';
  }
  return null;
}

// ─── 3 / 4. Hangul and Cyrillic words ───────────────────────────────────────

const KO_PARTICLES = ['에서는', '에게서', '으로는', '으로써', '으로서', '에서도', '에게는', '한테서', '까지는', '부터는',
  '이라고', '이에요', '입니다', '습니다', '에서', '에게', '한테', '까지', '부터', '처럼', '보다', '하고', '이랑', '으로',
  '이나', '께서', '라고', '예요', '은', '는', '이', '가', '을', '를', '의', '도', '만', '와', '과', '로', '에', '랑', '나', '께', '요'];

function syllables(s: string): number {
  return [...s].length;
}

// Particles that can also end a noun (회의, 아이, 우리나라) are stripped only
// when two syllables remain; the others always.
const KO_AMBIGUOUS: ReadonlySet<string> = new Set(['이', '가', '의', '도', '나', '요', '만', '라고']);

function koStem(w: string): string {
  for (const p of KO_PARTICLES) {
    if (!w.endsWith(p)) continue;
    const left = syllables(w) - syllables(p);
    if (left >= 2 || (left >= 1 && !KO_AMBIGUOUS.has(p))) return w.slice(0, -p.length);
  }
  return w;
}

/** A Hangul syllable as its jamo (initial, vowel, final). */
function jamo(s: string): string[] {
  const out: string[] = [];
  for (const c of s) {
    const code = c.codePointAt(0)! - 0xac00;
    if (code < 0 || code > 11171) { out.push(c); continue; }
    out.push(`L${Math.floor(code / 588)}`, `V${Math.floor((code % 588) / 28)}`);
    if (code % 28 !== 0) out.push(`T${code % 28}`);
  }
  return out;
}

function editDistance<T>(a: readonly T[], b: readonly T[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

const RU_ENDINGS = ['иями', 'ями', 'ами', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ией', 'иях', 'ах', 'ях', 'ам', 'ям',
  'ов', 'ев', 'ей', 'ой', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ую', 'юю', 'ом', 'ем', 'им', 'ым', 'ия',
  'ться', 'ть', 'ла', 'ло', 'ли', 'ет', 'ит', 'ут', 'ют', 'ат', 'ят', 'ешь', 'ишь', 'ете', 'ите',
  'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'й', 'і', 'ї', 'є'];

function cyrStem(w: string): string {
  const base = w.replace(/(?:ся|сь)$/u, '');
  const core = base.length >= 4 ? base : w;
  for (const e of RU_ENDINGS) if (core.endsWith(e) && core.length - e.length >= 3) return core.slice(0, -e.length);
  return core;
}

/** `s` with the [at, end) spans replaced by spaces (same length). */
export function blankSpans(s: string, spans: readonly (readonly [number, number])[]): string {
  let out = s;
  for (const [at, end] of spans) out = out.slice(0, at) + ' '.repeat(Math.max(0, end - at)) + out.slice(end);
  return out;
}

function blankNumbers(s: string, lang: string | undefined): string {
  let out = s;
  for (const w of wordNumbers(s, lang)) out = out.slice(0, w.at) + ' '.repeat(w.end - w.at) + out.slice(w.end);
  return out;
}

function latinWords(s: string): Set<string> {
  return new Set((s.match(/\p{Script=Latin}[\p{Script=Latin}\p{M}'’]*/gu) ?? []).map((w) => w.toLowerCase()));
}

/** New Latin words of the output (a word written as a term: 시 -> CI). */
function newLatinWords(raw: string, polished: string): number {
  const have = latinWords(raw);
  return [...latinWords(polished)].filter((w) => !have.has(w)).length;
}

function hangulDrift(raw: string, polished: string): boolean {
  const word = /\p{Script=Hangul}+/gu;
  const stems = (s: string): string[] => (s.match(word) ?? []).map(koStem);
  const content = (st: string): boolean => syllables(st) >= 2 && !HANGUL_STOP.has(st);
  const rawStems = stems(raw).filter(content);
  if (rawStems.length === 0) return false;
  const polFlat = polished.normalize('NFKC').replace(/\s+/gu, '');
  const missing = rawStems.filter((st) => !polFlat.includes(st));
  if (missing.length === 0) return false;
  const tally = (xs: readonly string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const rawTally = tally(stems(raw));
  const fresh = [...tally(stems(polished).filter(content))].filter(([st, n]) => n > (rawTally.get(st) ?? 0)).map(([st]) => st);
  const unexcused = missing.filter((st) => !fresh.some((u) => {
    const x = jamo(st);
    const y = jamo(u);
    return editDistance(x, y) <= Math.ceil(0.4 * Math.max(x.length, y.length));
  }));
  return unexcused.length > newLatinWords(raw, polished);
}

const SET_OFF_RE = new RegExp(
  `(^|[,.!?;:—–]\\s*)(?:${CYR_SET_OFF_FILLERS.map((f) => f.replace(/ /gu, '\\s+')).join('|')})(?=\\s*(?:[,.!?;:—–]|$))`,
  'giu',
);

/** Words of `s`, lowercased, set-off fillers dropped, and an immediately
 *  repeated run of one to three words kept once (я я думаю, мы пошли мы пошли). */
function cyrWords(s: string): string[] {
  const words = cyrRawWords(s.replace(SET_OFF_RE, '$1'));
  const out: string[] = [];
  for (const w of words) {
    out.push(w);
    for (let n = 1; n <= 3 && 2 * n <= out.length; n++) {
      const tail = out.slice(-n).join(' ');
      if (out.slice(-2 * n, -n).join(' ') === tail) { out.splice(-n, n); break; }
    }
  }
  return out;
}

/** Lowercased words, ё read as е, colloquial spellings read as the standard
 *  word (CYR_COLLOQUIAL). */
function cyrRawWords(s: string): string[] {
  return (s.toLowerCase().replace(/ё/gu, 'е').replace(/[’ʼ]/gu, "'").match(/\p{Script=Cyrillic}+(?:['-]\p{Script=Cyrillic}+)*/gu) ?? [])
    .map((w) => CYR_COLLOQUIAL.get(w) ?? w);
}

function cyrTimeKey(w: string): string | null {
  let best: { key: string; len: number } | null = null;
  for (const t of CYR_TIME) {
    if (t.not?.some((n) => w.startsWith(n))) continue;
    for (const s of t.starts) if (w.startsWith(s) && (best === null || s.length > best.len)) best = { key: t.key, len: s.length };
  }
  return best?.key ?? null;
}

function cyrillicDrift(raw: string, polished: string): string | null {
  const a = cyrWords(raw);
  if (a.length === 0) return null;
  const b = cyrWords(polished);
  const times = (ws: readonly string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const w of ws) { const k = cyrTimeKey(w); if (k !== null) m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  };
  const ta = times(a);
  const tb = times(b);
  for (const [k, n] of ta) if ((tb.get(k) ?? 0) !== n) return 'time';
  for (const [k, n] of tb) if ((ta.get(k) ?? 0) !== n) return 'time';
  // э-э, м-м, ну-у: a hesitation written with hyphens is a filler.
  const content = (w: string): boolean => [...w].length >= 3 && !CYR_STOP.has(w) && !/^(\p{L}{1,2})(?:-+\1)+$/u.test(w)
    && !/^(\p{L})\1+$/u.test(w);
  const count = (ws: readonly string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const w of ws) if (content(w)) m.set(cyrStem(w), (m.get(cyrStem(w)) ?? 0) + 1);
    return m;
  };
  const ra = count(a);
  const rb = count(b);
  const missing: string[] = [];
  for (const [st, n] of ra) for (let k = rb.get(st) ?? 0; k < n; k++) missing.push(st);
  if (missing.length === 0) return null;
  const fresh = [...rb].filter(([st, n]) => n > (ra.get(st) ?? 0)).map(([st]) => st);
  const joinedPol = b.join('');
  const unexcused = missing.filter((st) => !joinedPol.includes(st) || occurrencesOf(joinedPol, st) < occurrencesOf(a.join(''), st))
    .filter((st) => !fresh.some((u) => {
      const longest = Math.max(st.length, u.length);
      return u[0] === st[0] && editDistance([...st], [...u]) <= Math.max(1, Math.floor(longest / 3));
    }));
  return unexcused.length > newLatinWords(raw, polished) ? 'cyrillic-content' : null;
}

/**
 * GUARD-CJK: the first content change in Han, kana, Hangul or Cyrillic text
 * that no excuse covers, as a reason suffix (it names no word: reasons reach
 * telemetry), or null. `raw` / `polished` are the command-masked texts.
 */
export function scriptContentDrift(
  rawIn: string,
  polished: string,
  lang: string | undefined,
  excused: readonly (readonly [number, number])[] = [],
): string | null {
  const raw = blankSpans(rawIn, excused);
  const wide = WIDE_SCRIPTS.test(raw) || WIDE_SCRIPTS.test(polished);
  if (wide) {
    const r = squeeze(raw);
    const p = squeeze(polished);
    const hunks = hunksOf(r, p);
    if (hunks.length > 0) {
      const term = termDrift(r, p, hunks);
      if (term !== null) return `cjk-${term}`;
      const han = hanDrift(r, p, hunks);
      if (han !== null) return han;
    }
  }
  const rawWords = blankNumbers(raw, lang);
  const polWords = blankNumbers(polished, lang);
  if (/\p{Script=Hangul}/u.test(raw) && hangulDrift(rawWords, polWords)) return 'hangul-content';
  if (/\p{Script=Cyrillic}/u.test(raw)) {
    const cyr = cyrillicDrift(rawWords, polWords);
    if (cyr !== null) return cyr === 'time' ? 'cyrillic-time' : cyr;
  }
  return null;
}
