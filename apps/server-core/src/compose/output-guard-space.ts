// The CJK–Latin space-deletion detector for the compose output guard (Z3).
//
// output-guard.ts answers 「may this be delivered?」 and is the only place a
// ComposeGuardVerdict is minted. This file answers one narrower measurement:
// 「did the output glue a CJK-adjacent spaced token pair that the source kept
// apart?」 The call site decides what that measurement licenses.
//
// ─── WHY A NEW RULE, NOT invented_latin_tokens ──────────────────────────────
//
// Rule 8 fires on a novel Latin WORD in a Han-dominant source. Gluing Slack onto
// 通知 does not mint a novel word — `Slack通知` still matches LATIN_WORD_RE as
// `Slack`, which is already in the source — and Japanese/Korean sources fail
// HAN_SOURCE_FRACTION because kana and Hangul are not Han. The glue is invisible
// to every existing rule. The eval judge `preserve_internal_spaces` can see it;
// the judges and the guard answer different questions (eval-guard.mjs header)
// and must not be merged, so the production path needs its own detector.
//
// ─── WHAT FIRES ─────────────────────────────────────────────────────────────
//
// Source has a token pair separated by whitespace (not punctuation), and the
// output contains those tokens CONCATENated, with no gap:
//   · Latin word + CJK neighbour  (Slack 通知 → Slack通知)
//   · CJK neighbour + Latin word  (今日 GitHub → 今日GitHub)
//   · Latin word + Latin word, but ONLY when the pair sits next to CJK
//     (GitHub API の → GitHubAPI). A Latin-only source ("I opened GitHub API")
//     that concatenates the same words does not fire — that is a different
//     failure and this rule does not claim it.
//
// ─── WHAT MUST NOT FIRE ─────────────────────────────────────────────────────
//
// An output that rephrases and DROPS the pair has no glued form to match, so it
// is accepted. That is load-bearing: organize is allowed to omit a clause, and a
// rule that treated "the pair is gone" as glue would reject correct work.
//
// The glued probe is taken from the characters that actually touch the deleted
// space (at most two CJK code points on the CJK side). Using the whole CJK run
// would miss real glue — organize also edits the rest of the clause (adds を,
// drops ね), so "Slack 通知もね" must be caught by Slack通知, not by demanding
// the unedited tail Slack通知もね.
//
// If the source ALREADY contains the glued form, the output copying it is not
// a deletion. Silence is the safe direction.
//
// ─── WHAT THIS FILE DELIBERATELY DOES NOT SEE ───────────────────────────────
//
// Cyrillic↔Latin glue (Slackуведомления) is the same shape with a different
// script. The ruling named CJK. Extending the neighbour class is one regex;
// it is not this file's job.
//
// Organize emitting English from a French/Spanish/German source is same-script
// (both Latin). A script test cannot see it. That half needs language ID and
// is out of scope — see the Z3 report.

import { CJK_SCRIPT_RE } from './output-guard-text';

/** Same floor as LATIN_WORD_RE in output-guard.ts: one letter is not a token. */
const LATIN_TOKEN_RE = /[A-Za-z]{2,}/gu;
/** CJK_SCRIPT_RE's class, quantified, as a fresh `/gu` so we never touch the
 *  shared matcher. One source for "what is CJK" — drifting this class would
 *  make Hangul (or kana) silently stop counting as a neighbour. */
const CJK_RUN_RE = new RegExp(`${CJK_SCRIPT_RE.source}+`, 'gu');
const ONLY_WS_RE = /^[\s\u00A0\u3000]+$/u;

/** Adjacent CJK taken from the side that touches the space. Two code points is
 *  a typical CJK word; a one-character particle (の, 그) still has to count. */
const CJK_PROBE_CPS = 2;

interface Tok {
  kind: 'latin' | 'cjk';
  text: string;
  start: number;
  end: number;
}

function tokens(source: string): Tok[] {
  const found: Tok[] = [];
  for (const m of source.matchAll(LATIN_TOKEN_RE)) {
    found.push({ kind: 'latin', text: m[0], start: m.index, end: m.index + m[0].length });
  }
  for (const m of source.matchAll(CJK_RUN_RE)) {
    found.push({ kind: 'cjk', text: m[0], start: m.index, end: m.index + m[0].length });
  }
  found.sort((a, b) => a.start - b.start);
  return found;
}

function onlyWhitespace(s: string): boolean {
  return s.length > 0 && ONLY_WS_RE.test(s);
}

function cjkProbe(run: string, fromEnd: boolean): string {
  const cps = [...run];
  const n = Math.min(CJK_PROBE_CPS, cps.length);
  return (fromEnd ? cps.slice(-n) : cps.slice(0, n)).join('');
}

function containsFolded(hay: string, needle: string): boolean {
  if (needle === '') return false;
  return hay.toLowerCase().includes(needle.toLowerCase());
}

function pairTouchesCjk(toks: Tok[], i: number, source: string): boolean {
  const a = toks[i];
  const b = toks[i + 1];
  if (!a || !b) return false;
  const left = toks[i - 1];
  if (left?.kind === 'cjk' && onlyWhitespace(source.slice(left.end, a.start))) return true;
  const right = toks[i + 2];
  if (right?.kind === 'cjk' && onlyWhitespace(source.slice(b.end, right.start))) return true;
  return false;
}

function describe(left: string, right: string, glued: string): string {
  return `CJK-adjacent spaced pair ${JSON.stringify(`${left} ${right}`)} appears glued as ${JSON.stringify(glued)}`;
}

/**
 * Return a rejection detail when `output` glues a CJK-adjacent spaced pair from
 * `source`; otherwise null. Pure, deterministic, no clock.
 */
export function findCjkLatinGlue(source: string, output: string): string | null {
  const src = String(source ?? '');
  const out = String(output ?? '');
  if (src === '' || out.trim() === '') return null;

  const toks = tokens(src);
  for (let i = 0; i < toks.length - 1; i += 1) {
    const a = toks[i]!;
    const b = toks[i + 1]!;
    if (!onlyWhitespace(src.slice(a.end, b.start))) continue;

    let glued: string | null = null;
    let leftShown = a.text;
    let rightShown = b.text;

    if (a.kind === 'latin' && b.kind === 'cjk') {
      rightShown = cjkProbe(b.text, false);
      glued = `${a.text}${rightShown}`;
    } else if (a.kind === 'cjk' && b.kind === 'latin') {
      leftShown = cjkProbe(a.text, true);
      glued = `${leftShown}${b.text}`;
    } else if (a.kind === 'latin' && b.kind === 'latin' && pairTouchesCjk(toks, i, src)) {
      glued = `${a.text}${b.text}`;
    }

    if (glued === null) continue;
    // Source already carried the glued form: copying it is not a deletion.
    if (containsFolded(src, glued)) continue;
    if (containsFolded(out, glued)) return describe(leftShown, rightShown, glued);
  }
  return null;
}
