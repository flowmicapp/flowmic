// Card INC-1d — the planner of "polish while speaking": where a committed text
// may be cut into pieces, what read-only context each piece carries, and how a
// final text is assembled from pieces polished earlier. PURE: no I/O, no clock,
// no model. Design = docs/strategy/2026-10-13-realtime-polish-while-speaking-design.md
// §2.2 (pieces), D3 (context), §3.1 (release plan), §9 item 2 (invariants).
//
// 🔴 THE ONE PROPERTY EVERYTHING ELSE LEANS ON: a result is reused only when its
// (context, input) pair is found again in the final text by EXACT STRING. The
// planner never trusts an offset remembered from speech. A re-folded seam, a
// replay trim or a normalizer that rewrote a word turns a piece into a MISS
// (polished again at release), never into a wrong text.

/** A piece closes once it holds at least this many code points (design D2). */
export const MIN_PIECE = 60;
/** A run without a sentence end is split at a weak mark past this (design D2). */
export const MAX_PIECE = 240;
/** Read-only context: at most this many code points of the text before a piece (D3). */
export const CONTEXT_MAX = 160;
/** An over-long run is split only once this many code points follow MAX_PIECE,
 *  so every sentence end inside the first MAX_PIECE already has the character
 *  after it that decides whether it IS an end. Without the margin a prefix and
 *  its extension could cut the same run differently. ⚠️ Defensive: T1's random
 *  corpus does NOT go red when this is set to 0 (measured), it rarely puts a
 *  sentence end exactly at the MAX_PIECE boundary. */
const SPLIT_MARGIN = 8;

const CLOSERS = new Set(['”', '’', '」', '』', '）', ')', ']', '】', '》', '"', '\'']);
const ALWAYS_STRONG = new Set(['。', '！', '？', '．', '!', '?', '؟', '।', '۔']);
const WEAK_CJK = new Set(['，', '、', '；', '：', '…']);
const WEAK_SPACED = new Set([',', ';', ':', '،']);
const ABBREV = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'e.g', 'i.e', 'no', 'fig']);

const isWs = (ch: string | undefined): boolean => ch !== undefined && /\s/u.test(ch);
const cpLen = (s: string): number => [...s].length;

/** Offset just past the closers that follow `i`. */
function pastClosers(s: string, i: number): number {
  let j = i;
  while (j < s.length && CLOSERS.has(s[j]!)) j += 1;
  return j;
}

/** Is the `.` at `i` a sentence end? Only before whitespace, and not after a
 *  single letter, a number, an ellipsis, or a listed abbreviation. */
function periodEnds(s: string, i: number, after: number): boolean {
  if (after < s.length && !isWs(s[after])) return false;
  if (s[i - 1] === '.') return false; // "..." is a hesitation, not an end
  let k = i;
  while (k > 0 && !isWs(s[k - 1])) k -= 1;
  const token = s.slice(k, i).toLowerCase();
  if (token.length === 0) return false;
  if ([...token].length === 1 && /\p{L}/u.test(token)) return false;
  if (/^[\p{N}.,]+$/u.test(token)) return false;
  return !ABBREV.has(token.replace(/^[("'“‘]+/u, ''));
}

/**
 * Offsets just past every sentence end in `s` at or after `from` (closers
 * included). Unless `final`, an end needs at least one character after it: a
 * sentence whose closing quote has not arrived yet must not be cut early.
 */
export function sentenceEnds(s: string, from = 0, final = false): number[] {
  const out: number[] = [];
  for (let i = from; i < s.length; i += 1) {
    const ch = s[i]!;
    if (!ALWAYS_STRONG.has(ch) && ch !== '.') continue;
    const after = pastClosers(s, i + 1);
    if (ch === '.' && !periodEnds(s, i, after)) continue;
    if (!final && after >= s.length) continue;
    out.push(after);
    i = after - 1;
  }
  return out;
}

/** Offset past the last weak mark in s[start, limit), or -1. */
function lastWeakMark(s: string, start: number, limit: number): number {
  let best = -1;
  for (let i = start; i < limit; i += 1) {
    const ch = s[i]!;
    if (WEAK_CJK.has(ch)) best = pastClosers(s, i + 1);
    else if (WEAK_SPACED.has(ch) && isWs(s[i + 1])) best = i + 1;
  }
  return best <= limit && best > start ? best : -1;
}

/** Offset of the code point `n` code points past `start` (or s.length). */
function cpOffset(s: string, start: number, n: number): number {
  let i = start;
  for (let c = 0; c < n && i < s.length; c += 1) i += s.codePointAt(i)! > 0xffff ? 2 : 1;
  return i;
}

function skipWs(s: string, i: number): number {
  while (i < s.length && isWs(s[i])) i += 1;
  return i;
}

export interface Span { start: number; end: number }

/** Trim [start, end) to its non-space content. */
function trimSpan(s: string, start: number, end: number): Span {
  while (start < end && isWs(s[start])) start += 1;
  while (end > start && isWs(s[end - 1])) end -= 1;
  return { start, end };
}

/**
 * The pieces of `s` that are CLOSED, greedy left to right from `from`: whole
 * sentences until a piece holds `min` code points; a run with no sentence end
 * past MAX_PIECE is split at its last weak mark, and when it has none it stays
 * open (it becomes part of the release tail — today's behaviour for it).
 * Returned spans are trimmed; the whitespace between them is a joint.
 *
 * `final` = `s` is the whole text (the release kick): its last sentence may end
 * at the very end. `min` = 1 at release ("every closed sentence").
 */
export function closedPieces(s: string, from = 0, opts: { final?: boolean; min?: number } = {}): Span[] {
  const min = opts.min ?? MIN_PIECE;
  const ends = sentenceEnds(s, from, opts.final === true);
  const out: Span[] = [];
  let start = skipWs(s, from);
  let pos = start;
  let k = 0;
  while (start < s.length) {
    while (k < ends.length && ends[k]! <= pos) k += 1;
    const e = k < ends.length ? ends[k]! : -1;
    const maxAt = cpOffset(s, start, MAX_PIECE);
    if (e !== -1 && e <= maxAt) {
      pos = e;
      if (cpLen(s.slice(start, e).trim()) >= min) { out.push(trimSpan(s, start, e)); start = skipWs(s, e); pos = start; }
      continue;
    }
    // The next sentence would carry the piece past MAX_PIECE (or there is none yet).
    if (e === -1 && cpLen(s.slice(start)) <= MAX_PIECE + SPLIT_MARGIN) break; // still open
    if (pos > start) { out.push(trimSpan(s, start, pos)); start = skipWs(s, pos); pos = start; continue; }
    const w = lastWeakMark(s, start, maxAt);
    if (w === -1) break; // unpunctuated run: stays open
    out.push(trimSpan(s, start, w));
    start = skipWs(s, w); pos = start;
  }
  return out.filter((p) => p.end > p.start);
}

/**
 * The read-only context for a piece starting at `q` (design D3): at most
 * CONTEXT_MAX code points of the UN-polished text before it, starting at a
 * sentence start where the window holds one. Depends only on s[0, q), which is
 * what makes a background result reusable at release.
 */
export function contextOf(s: string, q: number): string {
  const before = s.slice(0, q).trimEnd();
  const n = cpLen(before);
  if (n <= CONTEXT_MAX) return before.trimStart();
  const ws = cpOffset(before, 0, n - CONTEXT_MAX);
  const ends = sentenceEnds(before, ws, true).filter((e) => e < before.length);
  const start = ends.length > 0 ? skipWs(before, ends[0]!) : ws;
  return before.slice(start).trim();
}

/** A finished background request the release plan may reuse. */
export interface SpecEntry { input: string; context: string }

export type PlanSpan<E extends SpecEntry = SpecEntry> =
  | { kind: 'joint'; text: string }
  | { kind: 'hit'; input: string; at: number; entry: E }
  | { kind: 'polish'; input: string; at: number; context: string };

/**
 * Design §3.1 — cover the final text `p` with (a) entries found again by exact
 * string AND exact context, in kick order, forward only; (b) the gaps between
 * them and the tail, to be polished now; (c) the whitespace between, copied.
 */
export function planRelease<E extends SpecEntry>(p: string, entries: readonly E[]): PlanSpan<E>[] {
  const out: PlanSpan<E>[] = [];
  let at = 0;
  const gap = (from: number, to: number): void => {
    const t = trimSpan(p, from, to);
    if (t.start > from) out.push({ kind: 'joint', text: p.slice(from, t.start) });
    if (t.end > t.start) out.push({ kind: 'polish', input: p.slice(t.start, t.end), at: t.start, context: contextOf(p, t.start) });
    if (to > t.end) out.push({ kind: 'joint', text: p.slice(t.end, to) });
  };
  for (const r of entries) {
    if (r.input.length === 0) continue;
    let q = p.indexOf(r.input, at);
    while (q >= 0 && contextOf(p, q) !== r.context) q = p.indexOf(r.input, q + 1);
    if (q < 0) continue; // a miss, not an error
    gap(at, q);
    out.push({ kind: 'hit', input: r.input, at: q, entry: r });
    at = q + r.input.length;
  }
  gap(at, p.length);
  return out;
}

/** Invariant (a) of design §9 item 2: the plan's inputs and joints re-join to
 *  exactly `p`. False ⇒ an assembly bug; the caller delivers `p` un-polished. */
export function reconstructs(p: string, plan: readonly PlanSpan[]): boolean {
  return plan.map((s) => (s.kind === 'joint' ? s.text : s.input)).join('') === p;
}

/** The delivered text: joints verbatim, every other span replaced by its output. */
export function assemble(plan: readonly PlanSpan[], outputOf: (span: Exclude<PlanSpan, { kind: 'joint' }>, i: number) => string): string {
  return plan.map((s, i) => (s.kind === 'joint' ? s.text : outputOf(s, i))).join('');
}
