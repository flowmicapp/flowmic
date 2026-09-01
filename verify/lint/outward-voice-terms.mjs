// verify/lint/outward-voice-terms.mjs
// DATA for the outward-copy voice contract: which words are internal
// vocabulary on which surface, and which sentence shapes are meta-statements.
//
// TWO CONSUMERS, ONE FILE, ON PURPOSE:
//   1. verify/lint/outward-voice.mjs  — the gate.
//   2. docs/rebuild/21-OUTWARD-COPY-VOICE-CONTRACT.md — the contract, which is
//      also the system prompt handed to an AI tool before it touches outward
//      copy. The contract POINTS AT THIS FILE and does not restate the list.
// One question with two answers is this repository's most expensive recurring
// defect, so the term list exists exactly once and both readers dereference it.
//
// ── WHY EVERY ENTRY CARRIES `surfaces`, AND NEVER A GLOBAL BAN (amendment M2)
// `verify:` is a dirty word in README.md and a REQUIRED word in
// CONTRIBUTING.md — a contributor has to type it. `sidecar` is an accurate
// technical name in an architecture diagram and internal jargon in a settings
// hint. A global ban would be red on CONTRIBUTING.md the day it landed and
// switched off within a fortnight; this repository has watched that happen to
// gates before, which is why the shape here is (term x surfaces x why) rather
// than a list of words.
//
// ── HOW THIS LIST GREW ───────────────────────────────────────────────────────
// Seeded from what was actually measured on the outward surfaces on
// 2026-09-01 (the work package's §1 table), then extended by re-scanning
// README.md while rewriting it. Nothing here is a word somebody imagined a
// project like this might say: every entry has been observed on a real surface
// in this repository, or is the second spelling of one that was.
//
// ── ADDING AN ENTRY ──────────────────────────────────────────────────────────
// State the surfaces and the reason. A term whose `why` reads "it sounds
// technical" is not an entry: the question is whether the READER has to know
// something about how we work in order to parse the sentence.

/**
 * The surfaces a term can be banned on. `site` and `console` live in the web
 * repository and are NOT reachable from this repository's lint — they are
 * declared here because the contract's prompt routes by the same names, and a
 * term list that only knew the surfaces one gate can walk would give the
 * prompt a shorter rule than the contract states.
 *
 * `contrib` is deliberately absent from every entry below: contributor-facing
 * documents are exempt from internal VOCABULARY (they are the surface where it
 * belongs) and are not exempt from META_PATTERNS.
 */
export const SURFACES = /** @type {const} */ ([
  { id: 'readme', what: 'Root-level visitor-facing prose in this repository (README.md and its neighbours).' },
  { id: 'site', what: 'The marketing site. Lives in the web repository; this repository cannot see it.' },
  { id: 'app', what: 'Strings the desktop and phone apps render to a user.' },
  { id: 'console', what: 'The account console. Lives in the web repository; this repository cannot see it.' },
]);

/**
 * A term is matched case-insensitively on word boundaries unless it carries
 * `caseSensitive`. `allow` lists surroundings that are NOT the jargon use;
 * every `allow` entry is checked for staleness by the gate, so a waiver cannot
 * outlive the thing it waived.
 *
 * @type {ReadonlyArray<{
 *   term: string,
 *   surfaces: ReadonlyArray<'readme'|'site'|'app'|'console'>,
 *   why: string,
 *   caseSensitive?: boolean,
 *   allow?: ReadonlyArray<{ re: RegExp, why: string }>,
 * }>}
 */
export const BANNED = [
  {
    term: 'golden path',
    surfaces: ['readme', 'site', 'app', 'console'],
    why: 'Internal name of the end-to-end test suite. A visitor reads it as a product feature.',
  },
  {
    term: 'golden suite',
    surfaces: ['readme', 'site', 'app', 'console'],
    why: 'The same suite under its other spelling. CONTRIBUTING.md uses it correctly and is exempt.',
  },
  {
    term: 'verify:',
    surfaces: ['readme', 'site', 'app', 'console'],
    why: 'Internal gate name. Required vocabulary for a contributor, meaningless to a visitor or a user.',
  },
  {
    term: 'probe',
    surfaces: ['site', 'app', 'console'],
    why: 'Internal word for a one-shot check. Users read "check". Owner ruling D6, 2026-09-01.',
  },
  {
    term: 'forensic',
    surfaces: ['readme', 'site', 'app', 'console'],
    why: 'Internal name for the diagnostic log format.',
    allow: [
      {
        re: /window-forensics\.log/i,
        why: 'A file name on the user\'s own disk. Naming the file they have to find is not jargon; '
          + 'renaming the file is a product change, not a copy edit.',
      },
    ],
  },
  {
    term: 'decision log',
    surfaces: ['readme', 'site', 'app', 'console'],
    why: 'Internal record. A visitor cannot read it (docs/ is not exported) and does not need to.',
  },
  {
    term: 'reverse control',
    surfaces: ['readme', 'site', 'app', 'console'],
    why: 'Internal method: watching a test go red on purpose. It describes how we work, not what the product does.',
  },
  {
    term: 'sidecar',
    surfaces: ['site', 'app', 'console'],
    why: 'Accurate in an architecture diagram, jargon in a settings hint. NOT banned on readme for that reason '
      + '(amendment M2 uses this exact word as its example).',
  },
  {
    term: 'CER',
    surfaces: ['readme', 'site', 'app', 'console'],
    why: 'Character error rate. An accuracy figure is a number with a unit, not an acronym the reader has to look up.',
    caseSensitive: true,
  },
  {
    term: 'bake-off',
    surfaces: ['readme', 'site', 'app', 'console'],
    why: 'Internal name for a comparison round between engines.',
  },
  {
    term: 'bakeoff',
    surfaces: ['readme', 'site', 'app', 'console'],
    why: 'The same round, unhyphenated.',
  },
  {
    term: 'SSOT',
    surfaces: ['readme', 'site', 'app', 'console'],
    why: 'Internal document vocabulary (single source of truth). Names our filing system, not the product.',
  },
  {
    term: 'facade',
    surfaces: ['readme', 'site', 'app', 'console'],
    why: 'Internal defect vocabulary for a capability with no caller.',
  },
  {
    term: 'façade',
    surfaces: ['readme', 'site', 'app', 'console'],
    why: 'The same word with the cedilla, which is how this repository usually spells it.',
  },
];

/**
 * Meta-statements: sentences about how we maintain our own text, or about what
 * a page deliberately does not do. They apply to EVERY surface, contributor
 * documents included — a contributor is owed the same plain prose a visitor is,
 * and CONTRIBUTING.md's exemption covers vocabulary only.
 *
 * Each pattern below was written against a sentence that really existed on an
 * outward surface in this repository on 2026-09-01, and each was checked
 * against every scanned surface before it was added: a pattern that is red on
 * the day it lands teaches everyone to ignore the gate.
 */
export const META_PATTERNS = [
  {
    re: /if .{0,40}(disagree|conflict|contradict)/i,
    why: 'Documentation-maintenance narration. The visitor reads "this page may be wrong".',
    seenIn: 'README.md, the speech-model section: "if that file and this table ever disagree, the file is right".',
  },
  {
    re: /this (table|list|document|section) is (stale|out of date)/i,
    why: 'Same shape, stated about the page the reader is on.',
    seenIn: 'README.md, the same sentence: "and this table is stale".',
  },
  {
    re: /the runner'?s own output/i,
    why: 'Tells the reader which of our artefacts to trust. That is an internal filing rule.',
    seenIn: 'README.md, repository layout: "counts drift; the runner\'s own output is the truth".',
  },
  {
    re: /\bwe would rather\b/i,
    why: 'Narrates our editorial preference instead of stating the fact. Note the "we": '
      + '"if you would rather not sign" addresses the reader and is not this shape.',
    seenIn: 'README.md: "we would rather show you a blank than a 404" and '
      + '"We would rather name an open gap than imply it is shut."',
  },
  {
    re: /\bstated plainly\b/i,
    why: 'Announces the tone of the next sentence rather than being it.',
    seenIn: 'README.md, privacy: "One thing that is not true yet, stated plainly because...".',
  },
  {
    re: /\bto be evaluated\b/i,
    why: 'The over-correction the owner rejected: an empty column filled with a note about its own emptiness. '
      + 'The honest form is to omit the column.',
    seenIn: 'README.md, both measurement tables, eight cells reading "to be evaluated".',
  },
];

/**
 * Blind-scan control. If a scan reports zero banned terms AND zero occurrences
 * of this string, the scanner is blind rather than the tree clean — two
 * verdicts that call for opposite actions. Precedent: the APK self-update
 * marker gate, which carries a control string for the same reason.
 */
export const CONTROL_STRING = 'FlowMic';

/**
 * Printed, never enforced (owner ruling D7, 2026-09-01). Em-dashes per 1,000
 * words is the most machine-measurable tell of AI cadence, and it also has real
 * false positives: technical writing has legitimate uses for the dash. The
 * number goes in the PASS line so it is visible every run; nothing fails on it.
 */
export const EM_DASH_PER_1000_REFERENCE = 8;
