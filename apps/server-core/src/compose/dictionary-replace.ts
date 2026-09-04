// SPEC-REF:
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.1 (source ③: the dictionary
//     is upgraded to a "deterministic replacement + LLM reference" dual channel —
//     the deterministic-replacement leg of the dictionary channel; pipeline order
//     dictionary replacement → normalizer → scenario correction → fan-out)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §5 (final pipeline order:
//     dictionary → normalizer → scenario correction → fan-out)
//   @flowmic/protocol SttDictionaryEntry (term + optional aliases) / ScenarioCard.terms
//   CLAUDE.md red line: source_text is immutable — this operates on the
//     compose/correction INPUT only, never rewriting the persisted source_text row
//     (as spoken).
//
// The deterministic-replacement half of the "deterministic replacement + LLM
// reference" dual dictionary channel (§4.1 source ③). Given the user's
// preferred-terminology sources
// (scenario-card custom terms with their aliases + enabled dictionary packs), it
// maps every configured surface form (the canonical term itself AND each alias)
// back to the canonical spelling on a piece of text — BEFORE the LLM correction
// stage sees it, so the model is anchored on the exact preferred spellings.
//
// Matching rules (master-plan §4.1 + card WP-R4-4 ②):
//   • WORDED surfaces — every script that has word boundaries and case, which is
//     ASCII Latin, accented Latin, Cyrillic and Greek alike: CASE-INSENSITIVE,
//     word-boundary matched (so "api" fixes to "API" but "RAPID" is never
//     touched); the canonical is included as a surface so a case variant of the
//     term itself is normalised.
//   • BOUNDARYLESS surfaces — Han / kana / Hangul (homophone aliases like
//     飞麦克→FlowMic, i.e. a Chinese homophone spelling of "FlowMic"): EXACT
//     substring, canonical-identity skipped (no-op).
//
//   • Every surface is regex-ESCAPED before it enters a pattern — a term can never
//     inject regex metacharacters. Longer surfaces are tried first so a short
//     alias never bites inside a longer one, and each pass is SINGLE-scan (a
//     replacement is never re-scanned → no cascade).
//
// 🔴 THE SPLIT USED TO BE `hasNonAscii`, AND THAT IS NOT THE SAME QUESTION.
// "Not ASCII" was read as "CJK", so accented Latin and Cyrillic were routed down
// the path built for scripts that have no spaces and no case. Measured
// (2026-08-28, dev-pc-a, against this very function):
//   · "das apiö" → "das APIö"   — the ASCII boundary class [A-Za-z0-9_] treats
//     every non-ASCII LETTER as a boundary, so the header's own promise ("api
//     fixes to API but RAPID is never touched") failed for de/fr/es/ru.
//   · dictionary "Größe" vs spoken "größe der datei" → NO match. German
//     capitalises every noun, so a German user's dictionary was case-SENSITIVE
//     while an English user's was not — the same feature, two products.
//   · dictionary "код" vs "кодировка UTF-8" → "КОДировка UTF-8". Russian is
//     inflected, so a short term bites inside longer words constantly.
// The rule is now the script's own property — does it have word boundaries and
// case — which is the question the two strategies were always answering.
// Full account: docs/strategy/2026-08-28-multilingual-chain-audit.md §3 F2.
//
// Pure: no I/O, no clock. The settings-reading resolver is resolveReplacementRules
// (scenario-context.ts); the TWO live call sites are createComposeFactory
// (compose/index.ts — the LLM correction INPUT) and makeSttSessionFactory
// (engine/stt-factory.ts — the STT FINAL pipeline stage 1, 06 §5, feeding the
// stt:final fan-out that mobile/PC/history all read).

/** One preferred-terminology rule: the canonical spelling plus the surface forms
 *  (aliases / homophones) that should be rewritten to it. `canonical` is always
 *  itself a surface (Latin case-normalisation). */
export interface TermRule {
  canonical: string;
  aliases?: readonly string[];
  /** Authored biasing weight, CARRIED but NOT CONSUMED here.
   *
   *  `buildDictionaryReplacer` below reads `canonical` and `aliases` only —
   *  deterministic replacement is all-or-nothing, there is no "how strongly"
   *  knob for it — so this field is provably inert on this path.
   *
   *  It exists because `resolveReplacementRules` is now ALSO the source for the
   *  FunASR open-frame hotwords (`stt/engine-factory.ts loadHotwords`), and the
   *  curated packs carry hand-authored weights (`@flowmic/protocol`
   *  DICTIONARY_PACKS: API 25, GitHub 25, Kubernetes 20 …). Without a place to
   *  put them, every pack term would silently collapse to the default 20
   *  (`stt/hotwords.ts` HOTWORD_DEFAULT_WEIGHT) on the way to the engine — a
   *  loss no replacer test could ever see, because the replacer does not look
   *  at it. Consumers that DO care read it; this one ignores it. */
  weight?: number;
}

/** A built, reusable replacer. `apply` is pure; `ruleCount` is the number of
 *  distinct surface forms wired (anti-façade / test visibility). */
export interface DictionaryReplacer {
  apply(text: string): string;
  readonly ruleCount: number;
}

// Defensive ceiling on distinct surface forms folded into the alternation. The
// dictionary is already capped at 300 entries upstream; with aliases this bounds
// the compiled regex even against a pathological config.
const MAX_SURFACES = 2000;
// Skip absurdly long surfaces (terms are ≤40 chars by schema; be generous).
const MAX_SURFACE_LEN = 128;

/** Escape every regex metacharacter so a term can never forge a pattern. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The scripts written WITHOUT word boundaries and WITHOUT case. A surface
 *  carrying any of them can only be matched as an exact substring; everything
 *  else — ASCII Latin, accented Latin, Cyrillic, Greek — is a word and gets the
 *  word-boundary + case-insensitive treatment.
 *
 *  ⚠️ Han is listed once and covers zh AND the kanji half of ja; kana and Hangul
 *  are listed because a surface may be written entirely in either. A MIXED
 *  surface (飞麦克FlowMic) lands here too, which is right: the CJK half has no
 *  boundary to anchor to. */
const BOUNDARYLESS_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function isBoundaryless(s: string): boolean {
  return BOUNDARYLESS_SCRIPT_RE.test(s);
}

/** Build a deterministic replacer from preferred-terminology rules. Ordering is
 *  first-write-wins on a surface collision (deterministic). An empty rule set
 *  yields an identity replacer (apply returns its input unchanged). */
export function buildDictionaryReplacer(rules: readonly TermRule[]): DictionaryReplacer {
  // surface(lowercased) → canonical, for the worded case-insensitive pass.
  const worded = new Map<string, string>();
  // surface(exact) → canonical, for the boundaryless exact-substring pass.
  const boundaryless = new Map<string, string>();
  let surfaces = 0;

  const addSurface = (raw: string, canonical: string): void => {
    if (surfaces >= MAX_SURFACES) return;
    const surface = raw.trim();
    if (surface.length === 0 || surface.length > MAX_SURFACE_LEN) return;
    if (isBoundaryless(surface)) {
      if (surface === canonical) return; // boundaryless identity → pure no-op, skip
      if (!boundaryless.has(surface)) { boundaryless.set(surface, canonical); surfaces += 1; }
    } else {
      // 🔴 `toLowerCase`, NOT `toLocaleLowerCase`: the key written here and the
      // key read back in `apply` must agree, and a locale-sensitive fold makes
      // that agreement depend on the server process's locale (Turkish dotted-I
      // is the classic divergence). Consistency beats linguistic accuracy here
      // because a disagreement is a SILENT miss.
      // ⚠️ Known limit, pinned by a test rather than left to be discovered:
      // German ß does not fold to SS in either JS regex or `toLowerCase`, so a
      // dictionary "Größe" does not match a shouted "GRÖSSE". That is a miss (no
      // replacement), never a corruption.
      const key = surface.toLowerCase();
      if (!worded.has(key)) { worded.set(key, canonical); surfaces += 1; }
    }
  };

  for (const rule of rules) {
    const canonical = rule.canonical.trim();
    if (canonical.length === 0) continue;
    addSurface(canonical, canonical); // the canonical is itself a surface (casing)
    if (rule.aliases) for (const a of rule.aliases) addSurface(a, canonical);
  }

  // Longer surfaces first so alternation prefers the longest match (JS alternation
  // is leftmost-listed-wins; sorting by length desc makes "javascript" beat "java").
  const byLenDesc = (a: string, b: string): number => b.length - a.length || (a < b ? -1 : 1);

  const wordedKeys = [...worded.keys()].sort(byLenDesc);
  const boundarylessKeys = [...boundaryless.keys()].sort(byLenDesc);

  // 🔴 The boundary class is `[\p{L}\p{N}_]` under the `u` flag, NOT `[A-Za-z0-9_]`.
  // The ASCII class calls every accented letter a boundary, which is what let
  // "api" bite inside "apiö". Behaviour on purely ASCII neighbours is unchanged
  // (measured: "RAPID api test" → "RAPID API test", "serverwartung" untouched) —
  // what changed is that a non-ASCII LETTER now correctly counts as part of a word.
  const wordedRe = wordedKeys.length > 0
    ? new RegExp(
        `(?<![\\p{L}\\p{N}_])(?:${wordedKeys.map(escapeRegex).join('|')})(?![\\p{L}\\p{N}_])`,
        'giu',
      )
    : null;
  const boundarylessRe = boundarylessKeys.length > 0
    ? new RegExp(`(?:${boundarylessKeys.map(escapeRegex).join('|')})`, 'gu')
    : null;

  const ruleCount = surfaces;

  return {
    ruleCount,
    apply(text: string): string {
      if (ruleCount === 0 || text.length === 0) return text;
      let out = text;
      // Worded first: a later boundaryless→Latin canonical output is never
      // re-scanned by the worded pass (single-pass per regex), so no cascade
      // across the two passes.
      if (wordedRe) out = out.replace(wordedRe, (m) => worded.get(m.toLowerCase()) ?? m);
      if (boundarylessRe) out = out.replace(boundarylessRe, (m) => boundaryless.get(m) ?? m);
      return out;
    },
  };
}
