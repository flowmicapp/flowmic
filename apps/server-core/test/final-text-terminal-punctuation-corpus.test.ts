// W4S ④ — terminal punctuation for ENGLISH finals, measured in BOTH directions
// against the W2 adversarial corpus (verify/eval/cases/realtime.jsonl).
//
// WHAT WENT WRONG. chooseTerminal()'s English branch was a bare keyword
// alternation with no positional anchor:
//
//   /\b(who|what|when|where|why|how|is|are|can|could|should|would|do|does|did)\b/i
//
// so ANY sentence that merely CONTAINED an auxiliary was closed with '?':
// "the server is excepting connections again?", "do not auto inject deferred
// messages?", "don't merge until the golden path is green?". The CJK branch of
// the SAME function was already positional (吗|嘛|么 anchored to $, question
// words limited to the last 6 characters) — the asymmetry between the two
// halves was the evidence that the English half was never designed.
//
// WHY IT MATTERED ENOUGH TO GATE. Every English utterance-closing final passes
// through this function and lands directly in the user's editor. There is no
// LLM after it on the realtime path: final-text-pipeline.ts states "realtime
// default is passthrough after these two pure stages", and the optional
// stt.polish layer is opt-in with stt-polish-settings.ts documenting "Absent →
// default OFF". Three corpus notes used to defend the wrong '?' as an
// intentional difference "left for the LLM polish stage to correct" — an assertion about a stage
// that does not run for the default user (anti-façade ④). Those notes are
// corrected in realtime.jsonl by the same commit that added this file.
//
// WHY THE CORPUS AND NOT VECTORS WRITTEN HERE. A heuristic tuned against
// examples authored by the person doing the tuning measures the tuner. The
// corpus is authored separately, is discriminated by run-eval's selftest (every
// golden_good must pass its judges, every golden_bad must fail one), and — the
// part that actually matters — it is the artifact the next person will find.
//
// WHY IT IS HERMETIC. run-eval.mjs --mode=live needs an engine, a network and a
// key, so it cannot be a gate; CLAUDE.md records what happens to gates that go
// red for reasons unrelated to the commit (G12 was red for a day and nobody
// looked). This file drives the REAL normalizeFinalText over the real corpus
// file with nothing else in the process.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeFinalText } from '../src/stt/final-text-normalizer';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(HERE, '..', '..', '..', 'verify', 'eval', 'cases', 'realtime.jsonl');

interface Case {
  id: string;
  family: string;
  input: string;
  golden_good: string;
  known_open?: boolean;
  open_reason?: string;
}

function loadCorpus(): Case[] {
  const raw = readFileSync(CORPUS_PATH, 'utf8');
  const out: Case[] = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (t === '') return;
    try {
      out.push(JSON.parse(t) as Case);
    } catch (e) {
      throw new Error(`realtime.jsonl line ${i + 1} is not valid JSON: ${(e as Error).message}`);
    }
  });
  return out;
}

const HAS_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** The terminal mark a string carries, or null. Both scripts. */
function terminalOf(text: string): string | null {
  const m = /[。！？.!?…]$/u.exec(text.trim());
  return m ? m[0] : null;
}

/** Drive the real production function exactly as the utterance-closing final does. */
function actualTerminal(input: string): string | null {
  return terminalOf(normalizeFinalText(input, { language: 'en-US', ensureTerminalPunctuation: true }));
}

const ALL = loadCorpus();
// A case is "English" iff its INPUT carries no CJK — the same question
// prefersCjkPunctuation() asks, so this selects exactly the cases that reach
// the English branch of chooseTerminal.
const ENGLISH = ALL.filter((k) => !HAS_CJK.test(k.input));
const OPEN = ENGLISH.filter((k) => k.known_open === true);
const CLOSED = ENGLISH.filter((k) => k.known_open !== true);

/** Expected mark = the one this case's golden_good (the correct product output) carries. */
const expectedOf = (k: Case): string | null => terminalOf(k.golden_good);

const describeMismatch = (k: Case): string =>
  `${k.id} [${k.family}] want ${JSON.stringify(expectedOf(k))} got ${JSON.stringify(actualTerminal(k.input))} :: ${k.input}`;

describe('chooseTerminal (English) — measured against the W2 realtime corpus', () => {
  // 🔴 THE BLINDNESS GUARD, and it is the most important assertion in the file.
  //
  // Before W4S the corpus held 11 English cases and every single one of them
  // expected '.'. So the "must NOT get ?" direction was fully covered and the
  // "must get ?" direction was covered by nothing at all — which means the
  // cheapest way to make the numbers perfect was to delete the English branch
  // and answer '.' to everything. That trade (false positives for false
  // negatives) would have scored 11/11 against the corpus as it stood.
  //
  // Pinning both counts non-zero is what stops the next person — or the next
  // model — from "fixing" this by deleting one side of the measurement.
  it('measures BOTH directions — the corpus must contain English questions AND non-questions', () => {
    const wantQuestion = CLOSED.filter((k) => expectedOf(k) === '?');
    const wantStatement = CLOSED.filter((k) => expectedOf(k) === '.');
    expect(
      wantQuestion.length,
      'no English case expects "?" — a corpus that only holds statements cannot tell a correct rule from "always answer full stop"',
    ).toBeGreaterThan(0);
    expect(
      wantStatement.length,
      'no English case expects "." — a corpus that only holds questions cannot tell a correct rule from "always answer question mark"',
    ).toBeGreaterThan(0);
    // Every English golden_good must actually declare a terminal mark, or the
    // expectation this file reads is silently null and every comparison passes.
    const undeclared = ENGLISH.filter((k) => expectedOf(k) === null).map((k) => k.id);
    expect(undeclared, 'golden_good with no terminal mark — this case cannot express an expectation').toEqual([]);
  });

  it('direction A — a statement or imperative is NEVER closed with a question mark', () => {
    const cases = CLOSED.filter((k) => expectedOf(k) === '.');
    const wrong = cases.filter((k) => actualTerminal(k.input) !== '.').map(describeMismatch);
    expect(wrong, `${cases.length} English non-question case(s) measured`).toEqual([]);
  });

  it('direction B — a question IS closed with a question mark', () => {
    const cases = CLOSED.filter((k) => expectedOf(k) === '?');
    const wrong = cases.filter((k) => actualTerminal(k.input) !== '?').map(describeMismatch);
    expect(wrong, `${cases.length} English question case(s) measured`).toEqual([]);
  });

  // 🔴 THE RESIDUAL LEDGER. This asserts that every case flagged `known_open`
  // in the corpus is STILL wrong, and it is deliberately NOT a specification.
  //
  // The distinction matters because this repo has been bitten by exactly the
  // confusion (0.2.52 §3: a reverse-control test written in 0.2.51 pinned a
  // defect as the acceptance criterion and went red on the day the fix landed,
  // making the fix look like the mistake). The difference here:
  //
  //   • It does not assert the current output is CORRECT. It asserts the
  //     corpus's written account of what is still broken is TRUE.
  //   • The failure message says what to do, and it is never "revert".
  //   • It mirrors a mechanism this repo already runs for the `merge` suite: a
  //     known_open case that starts passing is a FAILURE that asks you to close
  //     the account. Greppable anchor for that claim, true as of W4S: the string
  //     "a known-open account started passing and needs closing" in
  //     scripts/w2-eval-corpus.test.mjs. (Stated as an anchor and not as a line
  //     reference on purpose — the eval runner is being restructured by another
  //     lane, and a comment that asserts someone else's behaviour is only as
  //     true as the last time somebody checked it.)
  //
  // Without it, a residual documented in a `note` decays into a claim nobody
  // re-checks — and CLAUDE.md's whole anti-façade ④ rule is about exactly that.
  it('residual ledger — every known_open English case is still open, and says why', () => {
    for (const k of OPEN) {
      expect(k.open_reason ?? '', `${k.id}: known_open with no open_reason`).not.toBe('');
      expect(
        actualTerminal(k.input),
        `${k.id} now produces the mark its golden_good wants. ` +
          `FIRST check whether "direction A" above is still green. If it is, this is GOOD NEWS — the rule ` +
          `improved; close the account by dropping known_open/open_reason from the case in ` +
          `verify/eval/cases/realtime.jsonl so it joins the strict direction, and do NOT revert the rule to ` +
          `make this test green again. If direction A is ALSO red, this is NOT an improvement: the rule got ` +
          `looser, not better, and it is answering "?" to everything on its way past this case. ` +
          `(Measured, W4S: the original unanchored keyword rule "closed" rt-q-008 by pure accident — it ` +
          `matched the "is" in "the relay is on 0.2.49 right" — while failing 8 of 16 statements.)`,
      ).not.toBe(expectedOf(k));
    }
    // Non-empty on purpose: the residuals below are real and unfixable by a
    // text-only rule, and an empty ledger here would mean someone deleted the
    // honest accounting rather than that the rule became perfect.
    expect(OPEN.length, 'the known-open English residuals were removed from the corpus rather than fixed').toBeGreaterThan(0);
  });
});

describe('chooseTerminal (English) — the shapes the rule is built around', () => {
  // These are not a second corpus; they are the four discriminations the rule
  // makes, stated as executable prose so that a later reader can see WHY the
  // rule is positional without re-deriving it from the regex.
  const term = (t: string) => normalizeFinalText(t, { language: 'en-US', ensureTerminalPunctuation: true });

  it('a fronted wh-word makes a question; the same word inside a clause does not', () => {
    expect(term('what time does the download center go offline')).toMatch(/\?$/);
    expect(term('I know what the problem is with the sidecar')).toMatch(/\.$/);
  });

  it('subject-auxiliary inversion makes a question; an auxiliary in place does not', () => {
    expect(term('is the meeting still at three tomorrow')).toMatch(/\?$/);
    expect(term('the server is excepting connections again')).toMatch(/\.$/);
  });

  it('an inverted auxiliary needs a SUBJECT after it, not the verb it negates', () => {
    expect(term("don't you think we should test on a second phone first")).toMatch(/\?$/);
    expect(term("don't merge until the golden path is green")).toMatch(/\.$/);
    expect(term('do not auto inject deferred messages')).toMatch(/\.$/);
  });

  it('do/have are bare-verb imperatives too, so a determiner does not prove inversion', () => {
    expect(term('do the full rebuild before you cut the msi')).toMatch(/\.$/);
    expect(term('have a look at the sidecar log before you restart it')).toMatch(/\.$/);
    // …while the auxiliaries that have NO imperative form keep the determiner path
    expect(term('does the cloud key expire before the subscription')).toMatch(/\?$/);
    expect(term('has the relay been redeployed yet')).toMatch(/\?$/);
  });

  it('a leading discourse marker does not hide the inversion behind it', () => {
    expect(term('so what do we do about the msi')).toMatch(/\?$/);
    expect(term('so we shipped the windows build already')).toMatch(/\.$/);
  });

  it('the CJK branch is untouched', () => {
    expect(normalizeFinalText('你好吗', { language: 'zh-CN', ensureTerminalPunctuation: true })).toBe('你好吗？');
    expect(normalizeFinalText('这是什么', { language: 'zh-CN', ensureTerminalPunctuation: true })).toBe('这是什么？');
    expect(normalizeFinalText('今天天气不错', { language: 'zh-CN', ensureTerminalPunctuation: true })).toBe('今天天气不错。');
  });
});
