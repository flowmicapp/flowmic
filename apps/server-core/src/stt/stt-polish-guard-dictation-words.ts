// NR-262 (2026-10-14): the ONE list of dictated punctuation and layout command
// words, per session language. Data only.
//
// Before this file the same words lived in three hand-kept copies that drifted:
// the dictation check's table (stt-polish-guard-dictation.ts), the content
// check's blanking lists (stt-polish-guard-content.ts SPOKEN_PUNCT_RE /
// LANG_SPOKEN_PUNCT) and the ja / ko sentence-ending reading
// (stt-polish-guard-structure.ts endings). A correct conversion of a command
// only the dictation table knew ("ouvre la parenthèse", "Strichpunkt", "Klammer
// auf", "punto final", "abre comillas", "begin quote") was refused by the
// content check as a lost word. All three now derive from DICTATION_COMMANDS;
// test/polish-guard-dictation-words-binding.test.ts generates one case per
// entry from `say` and fails if any reader stops accepting it.
//
// Not derived from here, on purpose: the recognizer hint list
// (terminology-context.ts DICTATION_CONTEXT_TERMS) is a measured subset sent to
// Soniox, and growing it changes recognition. The binding test only checks
// that each of its words is a command here.

export type SymClass =
  | 'comma' | 'period' | 'question' | 'exclaim' | 'colon' | 'semicolon'
  | 'newline' | 'quote' | 'paren_open' | 'paren_close' | 'dash' | 'ellipsis';

// `re` is the word said as a command; `bare` (default: `re`) is every
// occurrence of the word, command or not, so that losing a noun use of it is
// seen even where the command form cannot match (句点は, 마침표를).
// `numeric`: the command starts with a number word (deux points, dos puntos),
// so it is read as a command only where it clearly is one
// (stt-polish-guard-dictation.ts hits()).
// `say`: one way a speaker says it, matched in full by `re`. The binding test
// builds its cases from it, so every entry must carry one.
// `added` (NR-262, MAIN 2026-10-14 final decision): a phrase main's content
// check never excused. It is excused only as one half of a converted open /
// close PAIR that encloses the same words (stt-polish-guard-dictation.ts
// pairedExcusal); unpaired it is compared as words, exactly as on main. Every
// entry without it is one main's content check excused (its SPOKEN_PUNCT_RE /
// LANG_SPOKEN_PUNCT at 2bbaecef), excused here only with its symbol in place.
export interface DictationCommand { kind: SymClass; re: string; say: string; bare?: string; numeric?: true; added?: true }

// Longest first within a language: the alternation takes the first that
// matches at a position ("point d'interrogation" before "point").
// Japanese kana commands may not run into another word (まるで, てんき,
// 始まる); Han commands may not take a particle (改行を, 句点の, 改行コード).
const JA_KANA_TAIL = '(?![\\p{Script=Hiragana}\\p{Script=Katakana}ー])';
const JA_KANA_HEAD = '(?<=^|[\\s\\p{P}]|[すたねよかだ])';
const JA_HAN_TAIL = '(?!を|が|は|に|の|で|と|も|す|し|さ|コード|記号|文字)';

export const DICTATION_COMMANDS: Readonly<Record<string, readonly DictationCommand[]>> = {
  en: [
    { kind: 'newline', re: 'new\\s+paragraph', say: 'new paragraph' },
    // NR-262 R2: "next line" is not a command (Apple / Dragon dictate "new
    // line" and "new paragraph"); the model turned noun uses of it into breaks
    // ("Check next line TODO." -> "Check\nTODO."). A glued "newline" is the
    // programmer's noun ("Print newline after each row"), as main's content
    // check always read it.
    { kind: 'newline', re: 'new\\s+line', say: 'new line' },
    { kind: 'question', re: 'question\\s+mark', say: 'question mark' },
    { kind: 'exclaim', re: 'exclamation\\s+(?:mark|point)', say: 'exclamation point' },
    { kind: 'period', re: 'full\\s+stop|period', say: 'full stop' },
    { kind: 'semicolon', re: 'semi-colon', say: 'semi-colon', added: true },
    { kind: 'semicolon', re: 'semicolon', say: 'semicolon' },
    { kind: 'colon', re: 'colon', say: 'colon' },
    { kind: 'comma', re: 'comma', say: 'comma' },
    { kind: 'quote', re: '(?:end|begin)\\s+quote', say: 'begin quote', added: true },
    { kind: 'quote', re: '(?:open|close)\\s+quote|unquote|quote', say: 'open quote' },
    { kind: 'paren_open', re: 'open\\s+(?:paren|parenthesis|bracket)', say: 'open bracket' },
    { kind: 'paren_close', re: 'close\\s+(?:paren|parenthesis|bracket)', say: 'close parenthesis' },
    { kind: 'dash', re: 'dash|hyphen', say: 'hyphen' },
    { kind: 'ellipsis', re: 'ellipsis', say: 'ellipsis' },
  ],
  fr: [
    { kind: 'semicolon', re: 'point[\\s-]virgule', say: 'point-virgule' },
    { kind: 'question', re: "point\\s+d['’]interrogation", say: "point d'interrogation" },
    { kind: 'exclaim', re: "point\\s+d['’]exclamation", say: 'point d’exclamation' },
    { kind: 'colon', re: 'deux[\\s-]points', say: 'deux points', numeric: true },
    { kind: 'newline', re: 'nouveau\\s+paragraphe|(?:retour\\s+)?à\\s+la\\s+ligne|nouvelle\\s+ligne', say: 'retour à la ligne' },
    // The imperative only: the infinitive ("Il faut fermer les guillemets ici")
    // is a sentence about quotes, not a command (NR-262 review round 3).
    { kind: 'quote', re: '(?:ouvrez|fermez)\\s+les\\s+guillemets', say: 'fermez les guillemets' },
    { kind: 'quote', re: '(?:ouvre[z]?|ferme[z]?)\\s+(?:les\\s+)?guillemets', say: 'ferme les guillemets', added: true },
    { kind: 'paren_open', re: 'ouvre[z]?\\s+(?:la\\s+)?parenthèse', say: 'ouvre la parenthèse', added: true },
    { kind: 'paren_close', re: 'ferme[z]?\\s+(?:la\\s+)?parenthèse', say: 'fermez la parenthèse', added: true },
    { kind: 'comma', re: 'virgule', say: 'virgule' },
    { kind: 'period', re: 'point', say: 'point' },
  ],
  de: [
    { kind: 'colon', re: 'Doppelpunkt', say: 'Doppelpunkt' },
    { kind: 'question', re: 'Fragezeichen', say: 'Fragezeichen' },
    { kind: 'exclaim', re: 'Ausrufezeichen', say: 'Ausrufezeichen' },
    { kind: 'semicolon', re: 'Semikolon', say: 'Semikolon' },
    { kind: 'semicolon', re: 'Strichpunkt', say: 'Strichpunkt', added: true },
    { kind: 'newline', re: 'neue[rn]?\\s+(?:Zeile|Absatz)', say: 'neuer Absatz' },
    { kind: 'quote', re: 'Anführungszeichen(?:\\s+(?:oben|unten|auf|zu))?', say: 'Anführungszeichen unten', added: true },
    { kind: 'paren_open', re: 'Klammer\\s+auf', say: 'Klammer auf', added: true },
    { kind: 'paren_close', re: 'Klammer\\s+zu', say: 'Klammer zu', added: true },
    { kind: 'comma', re: 'Komma', say: 'Komma' },
    { kind: 'period', re: 'Punkt', say: 'Punkt' },
  ],
  es: [
    { kind: 'semicolon', re: 'punto\\s+y\\s+coma', say: 'punto y coma' },
    { kind: 'newline', re: 'punto\\s+y\\s+aparte|nuevo\\s+párrafo|nueva\\s+línea', say: 'nueva línea' },
    { kind: 'newline', re: 'nuevo\\s+parrafo|nueva\\s+linea', say: 'nueva linea', added: true },
    { kind: 'period', re: 'punto\\s+y\\s+seguido', say: 'punto y seguido' },
    { kind: 'period', re: 'punto\\s+final', say: 'punto final', added: true },
    { kind: 'colon', re: 'dos\\s+puntos', say: 'dos puntos', numeric: true },
    { kind: 'question', re: 'signo\\s+de\\s+interrogación', say: 'signo de interrogación' },
    { kind: 'question', re: 'signo\\s+de\\s+(?:interrogacion|pregunta)', say: 'signo de pregunta', added: true },
    { kind: 'exclaim', re: 'signo\\s+de\\s+exclamación', say: 'signo de exclamación' },
    { kind: 'exclaim', re: 'signo\\s+de\\s+(?:exclamacion|admiraci[óo]n)', say: 'signo de admiración', added: true },
    { kind: 'quote', re: '(?:abrir|cerrar|abre|cierra)\\s+comillas', say: 'abre comillas', added: true },
    { kind: 'paren_open', re: '(?:abrir|abre)\\s+par[ée]ntesis', say: 'abrir paréntesis', added: true },
    { kind: 'paren_close', re: '(?:cerrar|cierra)\\s+par[ée]ntesis', say: 'cierra paréntesis', added: true },
    { kind: 'comma', re: 'coma', say: 'coma' },
    { kind: 'period', re: 'punto', say: 'punto' },
  ],
  ru: [
    { kind: 'semicolon', re: 'точка\\s+с\\s+запятой', say: 'точка с запятой' },
    { kind: 'question', re: 'вопросительный\\s+знак', say: 'вопросительный знак' },
    { kind: 'exclaim', re: 'восклицательный\\s+знак', say: 'восклицательный знак' },
    { kind: 'colon', re: 'двоеточие', say: 'двоеточие' },
    { kind: 'newline', re: 'новый\\s+абзац|с\\s+нового\\s+абзаца|новая\\s+строка|с\\s+новой\\s+строки', say: 'с новой строки' },
    { kind: 'quote', re: '(?:открыть|закрыть|открываем|закрываем)\\s+кавычки', say: 'открываем кавычки' },
    { kind: 'ellipsis', re: 'многоточие', say: 'многоточие' },
    { kind: 'comma', re: 'запятая', say: 'запятая' },
    { kind: 'period', re: 'точка', say: 'точка' },
  ],
  ko: [
    { kind: 'newline', re: '새\\s*문단|줄\\s*바꿈', say: '새 문단' },
    { kind: 'question', re: '물음표', say: '물음표' },
    { kind: 'exclaim', re: '느낌표', say: '느낌표' },
    { kind: 'comma', re: '쉼표', say: '쉼표' },
    { kind: 'period', re: '마침표', say: '마침표' },
  ],
  ja: [
    { kind: 'newline', re: `改行${JA_HAN_TAIL}|${JA_KANA_HEAD}かいぎょう${JA_KANA_TAIL}`, bare: '改行|かいぎょう', say: 'かいぎょう' },
    { kind: 'question', re: `疑問符${JA_HAN_TAIL}|${JA_KANA_HEAD}(?:はてな|ハテナ|クエスチョンマーク)${JA_KANA_TAIL}`, bare: '疑問符|はてな|ハテナ|クエスチョンマーク', say: 'はてな' },
    { kind: 'exclaim', re: `感嘆符${JA_HAN_TAIL}|${JA_KANA_HEAD}びっくりマーク${JA_KANA_TAIL}`, bare: '感嘆符|びっくりマーク', say: 'びっくりマーク' },
    // まる / てん stay bounded in both passes: as bare strings they sit inside
    // ordinary words (始まる, まるで, てんき) a homophone fix may rewrite.
    { kind: 'period', re: `句点${JA_HAN_TAIL}|${JA_KANA_HEAD}(?:まる|マル)${JA_KANA_TAIL}`, bare: `句点|${JA_KANA_HEAD}(?:まる|マル)${JA_KANA_TAIL}`, say: 'まる' },
    { kind: 'comma', re: `読点${JA_HAN_TAIL}|${JA_KANA_HEAD}(?:てん|テン)${JA_KANA_TAIL}`, bare: `読点|${JA_KANA_HEAD}(?:てん|テン)${JA_KANA_TAIL}`, say: '読点' },
  ],
};

// Lowercase scripts: a command may not sit inside a word. Hangul: only the
// tail is checked (a particle glued on, 마침표를, makes it a noun); Japanese
// carries its own boundaries per entry.
export function commandBoundaries(lang: string): [string, string] {
  if (lang === 'ja') return ['', ''];
  if (lang === 'ko') return ['', '(?![\\p{Script=Hangul}])'];
  // NR-262 review: nor one half of a hyphenated compound (quote-part,
  // Punkt-Abzug).
  return ['(?<![\\p{L}\\p{M}])(?<!\\p{L}-)', '(?![\\p{L}\\p{M}])(?!-\\p{L})'];
}

const SOURCE_CACHE = new Map<string, string | null>();

/** The command forms of `lang`'s table as one alternation with the table's
 *  word boundaries (regex source), or null when the language has no table. */
export function dictationCommandSource(lang: string): string | null {
  const cached = SOURCE_CACHE.get(lang);
  if (cached !== undefined) return cached;
  const table = DICTATION_COMMANDS[lang];
  const [head, tail] = commandBoundaries(lang);
  const source = table ? `${head}(?:${table.map((c) => c.re).join('|')})${tail}` : null;
  SOURCE_CACHE.set(lang, source);
  return source;
}

/** Every command word of `lang` as a fresh global, case-insensitive regex, or
 *  null when the language has no table. Fresh per call: a shared /g regex
 *  carries lastIndex between callers. */
export function dictationCommandRegExp(lang: string): RegExp | null {
  const source = dictationCommandSource(lang);
  return source === null ? null : new RegExp(source, 'giu');
}

/** Every occurrence of a command word of `lang` (the `bare` forms) with the
 *  Japanese left boundary dropped, as regex source, or null. For reading a
 *  ja / ko sentence ending (stt-polish-guard-structure.ts endings), which adds
 *  its own right boundary: there 問題ありませんまる ends a sentence even though
 *  the dictation check, which must not read まんまる as a command, does not
 *  count that まる. */
export function sentenceEndCommandSource(lang: string): string | null {
  const table = DICTATION_COMMANDS[lang];
  if (!table) return null;
  return table.map((c) => (c.bare ?? c.re).split(JA_KANA_HEAD).join('')).join('|');
}

/** The tables a session reads, in match priority: its own language's table
 *  when it has one, then English. English is read in EVERY session (MAIN
 *  2026-10-14, NR-262): the content check has always blanked English command
 *  words whatever the language, so the dictation check must judge them there
 *  too, or "the end quote" deleted from a French session is a silent loss. The
 *  content check (blanks) and the dictation check (judges) both read this, so
 *  the two can no longer disagree about which words are commands. */
export function commandLanguages(language: string | undefined): readonly string[] {
  return language !== undefined && language !== 'en' && DICTATION_COMMANDS[language] ? [language, 'en'] : ['en'];
}

export interface SessionCommand extends DictationCommand { lang: string }

/** The entries of commandLanguages(language), in that order, each tagged with
 *  the table it came from. */
export function sessionCommands(language: string | undefined): readonly SessionCommand[] {
  return commandLanguages(language).flatMap((lang) => DICTATION_COMMANDS[lang]!.map((c) => ({ ...c, lang })));
}

/** One entry as regex source (no capture group), with its table's word
 *  boundaries. `bare` is every occurrence of the word; Japanese and Korean
 *  bare forms carry no outer boundary. */
export function commandPiece(c: SessionCommand, form: 'command' | 'bare'): string {
  const [head, tail] = commandBoundaries(c.lang);
  if (form === 'command') return `${head}(?:${c.re})${tail}`;
  const latin = c.lang !== 'ja' && c.lang !== 'ko';
  return latin ? `${head}(?:${c.bare ?? c.re})${tail}` : `(?:${c.bare ?? c.re})`;
}

/** English command words that are ordinary words of the session language
 *  (NR-262 review, measured): in such a session the English entry is not read
 *  at all, neither blanked by the content check nor judged by the dictation
 *  check, so the word is compared like any other word of the sentence
 *  ("eine hohe Quote", "cáncer de colon", "il comma 3", "le colon").
 *  Keys are session languages; values are normalized surfaces. */
export const ENGLISH_HOMOGRAPHS: Readonly<Record<string, readonly string[]>> = {
  de: ['quote'],
  it: ['quote', 'comma', 'colon'],
  es: ['colon'],
  fr: ['colon'],
};

/** A matched command as compared across input and output: case, accents,
 *  curly apostrophes, hyphens and runs of spaces folded ("nueva línea" ==
 *  "nueva linea", "Point-virgule" == "point virgule"). Two different spoken
 *  commands of the same kind ("open quote" / "close quote", "punto final" /
 *  "punto y seguido") stay different. */
export function normalizeSurface(s: string): string {
  // Hangul: spacing inside a word is optional (줄바꿈 / 줄 바꿈, 새문단 / 새 문단).
  const folded = s.toLowerCase().replace(/’/gu, "'").replace(/[\s-]+/gu, ' ').trim()
    .replace(/(?<=\p{Script=Hangul}) (?=\p{Script=Hangul})/gu, '');
  // Accents are folded in Latin script only: kana voicing marks and Hangul
  // syllables are part of the word.
  return /^[\p{Script=Latin}\p{M}' ]+$/u.test(folded.normalize('NFD')) ? folded.normalize('NFD').replace(/\p{M}/gu, '') : folded;
}
