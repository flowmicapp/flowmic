// NR-262 — dictated commands the content check used to miss.
//
// The dictation half of the guard (stt-polish-guard-dictation.ts) and the
// content-word half (stt-polish-guard-content.ts) each kept their own list of
// command words, and the lists drifted: a correct conversion of "ouvre la
// parenthèse", "Strichpunkt", "Klammer auf", "punto final", "abre comillas",
// "begin quote" was refused as a lost content word ("polish not applied,
// original kept"). Both now read stt-polish-guard-dictation-words.ts.
//
// Rows, by kind:
//   · convert         — command words replaced by their symbols (accepted);
//   · meaning_changed — the same conversion with a real word changed next to
//                       it (refused: blanking the commands must not hide it);
//   · deleted         — a command gone with no symbol (refused);
//   · noun_converted  — the word used as part of the sentence, converted or
//                       dropped (refused);
//   · noun_kept       — that sentence left as words (accepted).
//
// polish-guard-dictation-nr262-review.jsonl holds every row of the independent
// adversarial review of this card (MAIN 2026-10-14), kind accept / refuse, run
// with the row's own delivery (lineBreaks) and language (absent = unknown).
// Four review rows are left out on purpose, because no reading of command
// words decides them (a name changed, an inflected Russian noun, Chinese
// content words): en-period-name, ru-tochka, zh-comma-conv-han, zh-plain-han —
// docs/strategy/2026-10-13-speech-quality-program.md, NR-262.
// kind noun_synonym: an English command word that is an ordinary word of the
// sentence, swapped for a synonym ("a quote" -> "a price", "die Quote" ->
// "die Rate"). Refused, as the same swap of any other noun is ("die Marge" ->
// "die Rate" is refused on main too); accepting it would mean blanking the
// word, and then deleting it ("Die Quote liegt…" -> "Die liegt…") is unseen.
// kind next_line_not_a_command (NR-262 R2): "next line" is not a dictation
// command (Apple / Dragon say "new line"); the real model turned noun uses of
// it into line breaks ("Check next line TODO." -> "Check" + break + "TODO."),
// so its conversion is refused like any other word change.
// kind unpaired_added (MAIN final decision, 2026-10-14): a command phrase
// main's content check never excused ("semi-colon", "Strichpunkt", "punto
// final", "signo de pregunta / admiración") is excused only as half of a
// converted open / close pair; said on its own and converted, it is refused
// as on main. kind pair_no_english_budget: a converted English pair in a
// German session earns no edit-budget discount, so strict refuses it on the
// budget (smooth accepts).
// polish-guard-dictation-nr262-review3x.jsonl: the final review pass. Its two
// contrived pairs that really enclose the same words ("El código abre
// paréntesis y el bloque cierra paréntesis") are accepted by design and left
// out — never pinned as accepted (program doc, NR-262).
// polish-guard-dictation-nr262-review3.jsonl: the third review's rows (fresh
// cases after the R1 redesign; MAIN 2026-10-14).
// polish-guard-dictation-nr262-review2.jsonl: the second review's own rows
// (round 1 rows are in -review). kind known_false_refusal:<class> pins a
// correct polish the guard still refuses, in the classes MAIN accepted:
// an it/es/fr/de homograph meant as the English command, a score "3 colon 1"
// written 3-1, "semicolon" respelled "semi-colon". Rows wrong on main and on
// this branch alike (other checks' holes: Han / Hangul / Cyrillic content,
// numbers, Italian legal "comma", "quote unquote" split) are left out and
// listed in the program doc. Both review files are generated from the
// reviews' harness by the current verdicts under that rule; a leak or an
// unlisted false refusal stops the generator.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkMeaningPreserved } from '../src/stt/stt-polish-guard';

type Verdict = 'accept' | 'refuse';
interface Row {
  id: string;
  lang?: string;
  kind: string;
  label: 'harmful' | 'neutral';
  input: string;
  output: string;
  lineBreaks?: boolean;
  /** A strength is absent when main and this branch are both wrong there. */
  expect: { strict?: Verdict; smooth?: Verdict };
}

const read = (name: string): Row[] => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
  .split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as Row);
const rows: Row[] = [
  ...read('polish-guard-dictation-nr262.jsonl'),
  ...read('polish-guard-dictation-nr262-review.jsonl'),
  ...read('polish-guard-dictation-nr262-review2.jsonl'),
  ...read('polish-guard-dictation-nr262-review3.jsonl'),
  ...read('polish-guard-dictation-nr262-review3x.jsonl'),
];

describe('polish guard: dictated commands the content check used to miss (NR-262)', () => {
  it('labels agree with the expected verdicts', () => {
    expect(rows.length).toBeGreaterThan(100);
    for (const r of rows) expect({ id: r.id, label: r.label }).toEqual({ id: r.id, label: (r.expect.strict ?? r.expect.smooth) === 'accept' ? 'neutral' : 'harmful' });
  });

  for (const r of rows) {
    for (const strength of ['strict', 'smooth'] as const) {
      if (r.expect[strength] === undefined) continue;
      it(`${r.id} ${r.kind} ${strength}: ${r.input.slice(0, 40)}`, () => {
        const got = checkMeaningPreserved(r.input, r.output, {
          strength,
          ...(r.lang !== undefined ? { language: r.lang } : {}),
          ...(r.lineBreaks !== undefined ? { lineBreaks: r.lineBreaks } : {}),
        });
        expect({ id: r.id, strength, verdict: got.ok ? 'accept' : 'refuse', reason: got.reason })
          .toMatchObject({ id: r.id, strength, verdict: r.expect[strength] });
      });
    }
  }
});

// MAIN 2026-10-14 (round 2): in zh / ja / ko / ru sessions an English command
// converted to its symbol earns no edit-budget discount, and stays visible to
// the clause and numbers gates, as on main — those are what read Han / kana /
// Hangul / Cyrillic content there until a content check for those scripts
// exists. Only strict is asserted for the zh row: under smooth the same Han
// change is accepted on main too (that hole is the separate card's).
describe('dictated commands: English in zh / ja / ko / ru sessions keeps main\'s budget and clause reading', () => {
  it('zh: a converted English command does not pay for a Han change (strict)', () => {
    expect(checkMeaningPreserved('明天开会 new paragraph 记得带电脑', '后天开会\n\n记得带电脑', { strength: 'strict', language: 'zh' }).ok).toBe(false);
  });
  it('ru: a Cyrillic change next to a converted English command is refused, a plain conversion is not (smooth)', () => {
    const raw = 'Встреча завтра в десять exclamation mark спасибо';
    for (const strength of ['strict', 'smooth'] as const) {
      expect({ strength, ok: checkMeaningPreserved(raw, 'Встреча послезавтра в десять! спасибо', { strength, language: 'ru' }).ok }).toEqual({ strength, ok: false });
    }
    expect(checkMeaningPreserved(raw, 'Встреча завтра в десять! спасибо', { strength: 'smooth', language: 'ru' }).ok).toBe(true);
  });
});
