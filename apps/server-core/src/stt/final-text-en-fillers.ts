// EN-1 (card ML-2, 2026-10-14): standalone English hesitation sounds.
//
// Measured before writing this: Soniox writes them out. All five EVAL-1 filler
// items came back with them in the final text ("Um, I think we should, uh,
// push the release to next week.", "Uh, can you— um— check ..."), base run
// .local/eval-speech/base-stt-hints.jsonl. The CJK strip next door
// (final-text-normalizer.ts stripDisfluencies) has done the same for 呃/嗯
// since the legacy line; this is its English sibling, deterministic, no LLM.
//
// Only um, uh, erm, er, hmm (any run of their letters: ummm, uhh, hmmm), as
// whole words. NOT "like", "you know", "so", "well": those are words with a
// meaning in many sentences, and deleting one is an edit only a model with
// the sentence in view may make (Smooth does). NOT "uh-huh" / "mm-hmm" (a
// hyphen on either side keeps the word): those answer yes.
//
// Gated on an English session by the caller: "er" is German for "he".

// ML-2 review (2026-10-14): the forms are matched CASE-SENSITIVELY. Lowercase
// anywhere; Titlecase (Um, Uh, Er, Hmm) only where a sentence starts; never
// all-caps (UM, ER, HMM are names and acronyms). "err" is a verb and does not
// match. Text inside quotes is somebody's words and is left alone, and so is
// any term in the user's dictionary (this runs after dictionary replacement).
const FILLER = /(?<![\p{L}\p{N}'’-])(?:u+m+|u+h+|erm+|er|h+m+|Um+|Uh+|Erm+|Er|Hm+)(?![\p{L}\p{N}'’-])/gu;
const SENTENCE_START = /(?:^|[.!?]["”’)]?\s*)$/u;
const LEFT_PAUSE = /\s*(,|—|–|\.\.\.|…)?\s*$/u;
const RIGHT_PAUSE = /^\s*(,|—|–|\.\.\.|…)?\s*/u;

/** True when the clause before a comma is one word ("So, uh, the build"):
 *  that comma belongs to the word, not to the hesitation. */
function oneWordLead(before: string): boolean {
  const clause = before.split(/[.!?;:—–]\s*/u).pop() ?? '';
  return /^\s*[\p{L}'’]+\s*$/u.test(clause);
}

/** Inside a quotation that opened before `at` and has not closed. */
function quoted(text: string, at: number): boolean {
  const head = text.slice(0, at);
  const n = (re: RegExp): number => head.match(re)?.length ?? 0;
  return n(/"/gu) % 2 === 1 || n(/“/gu) > n(/”/gu) || n(/«/gu) > n(/»/gu);
}

/** Inside an occurrence of one of the user's terms (any case). */
function inTerm(text: string, at: number, end: number, terms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  for (const raw of terms) {
    const t = raw.trim().toLowerCase();
    if (t.length === 0) continue;
    for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + 1)) {
      if (i <= at && i + t.length >= end) return true;
    }
  }
  return false;
}

/** `text` without standalone English hesitation sounds and the pauses that
 *  only marked them. Returns `text` unchanged when nothing would be left. */
export function stripEnglishFillers(text: string, keepTerms: readonly string[] = []): string {
  let out = text;
  let from = 0;
  for (let guard = 0; guard < 64; guard += 1) {
    FILLER.lastIndex = from;
    const m = FILLER.exec(out);
    if (!m) break;
    const leftM = LEFT_PAUSE.exec(out.slice(0, m.index))!;
    const before = out.slice(0, m.index - leftM[0].length);
    const titlecase = /^\p{Lu}/u.test(m[0]);
    if ((titlecase && !SENTENCE_START.test(before)) || quoted(out, m.index) || inTerm(out, m.index, m.index + m[0].length, keepTerms)) {
      from = m.index + m[0].length;
      continue;
    }
    const rightM = RIGHT_PAUSE.exec(out.slice(m.index + m[0].length))!;
    let after = out.slice(m.index + m[0].length + rightM[0].length);
    const left = leftM[1] ?? '';
    let keep = '';
    if (left === '...' || left === '…') keep = left;
    // MAIN 2026-10-14: a hesitation set off by commas on both sides leaves one
    // comma ("here, er, there" -> "here, there"); so does one after a
    // one-word lead ("So, um the build" -> "So, the build").
    else if (left === ',' && before.length > 0 && (rightM[1] === ',' || oneWordLead(before)) && !/^[.!?]/u.test(after)) keep = ',';
    // A hesitation that opened the sentence: the next word opens it now, but
    // only a plain lowercase word is re-cased (iPhone, eBay stay as they are).
    if (keep === '' && SENTENCE_START.test(before)) {
      after = after.replace(/^\p{Ll}+(?![\p{L}])/u, (w) => w[0]!.toUpperCase() + w.slice(1));
    }
    const space = after.length > 0 && !/^[.,!?;:…]/u.test(after) && (before.length > 0 || keep !== '') ? ' ' : '';
    out = `${before}${keep}${space}${after}`;
    from = before.length;
  }
  return /[\p{L}\p{N}]/u.test(out) ? out.trim() : text;
}
