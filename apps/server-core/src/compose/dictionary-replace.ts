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
// (scenario-card custom terms + enabled dictionary packs + stt.dictionary), it
// maps every configured surface form (the canonical term itself AND each alias)
// back to the canonical spelling on a piece of text — BEFORE the LLM correction
// stage sees it, so the model is anchored on the exact preferred spellings.
//
// Matching rules (master-plan §4.1 + card WP-R4-4 ②):
//   • Latin/ASCII surfaces: CASE-INSENSITIVE, word-boundary matched (so "api"
//     fixes to "API" but "RAPID" is never touched); the canonical is included as
//     a surface so a case variant of the term itself is normalised.
//   • CJK / non-ASCII surfaces (homophone aliases like 飞麦克→FlowMic, i.e. a Chinese
//     homophone spelling of "FlowMic"): EXACT substring (CJK has no spaces / no
//     case), canonical-identity skipped (no-op).
//   • Every surface is regex-ESCAPED before it enters a pattern — a term can never
//     inject regex metacharacters. Longer surfaces are tried first so a short
//     alias never bites inside a longer one, and each pass is SINGLE-scan (a
//     replacement is never re-scanned → no cascade).
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

/** True when the surface carries a non-ASCII (CJK / full-width / homophone)
 *  character — such surfaces match as exact substrings, not Latin words. */
function hasNonAscii(s: string): boolean {
  return /[^\x00-\x7f]/.test(s);
}

/** Build a deterministic replacer from preferred-terminology rules. Ordering is
 *  first-write-wins on a surface collision (deterministic). An empty rule set
 *  yields an identity replacer (apply returns its input unchanged). */
export function buildDictionaryReplacer(rules: readonly TermRule[]): DictionaryReplacer {
  // surface(lowercased) → canonical, for the Latin case-insensitive pass.
  const latin = new Map<string, string>();
  // surface(exact) → canonical, for the CJK/non-ASCII exact-substring pass.
  const cjk = new Map<string, string>();
  let surfaces = 0;

  const addSurface = (raw: string, canonical: string): void => {
    if (surfaces >= MAX_SURFACES) return;
    const surface = raw.trim();
    if (surface.length === 0 || surface.length > MAX_SURFACE_LEN) return;
    if (hasNonAscii(surface)) {
      if (surface === canonical) return; // CJK identity → pure no-op, skip
      if (!cjk.has(surface)) { cjk.set(surface, canonical); surfaces += 1; }
    } else {
      const key = surface.toLowerCase();
      if (!latin.has(key)) { latin.set(key, canonical); surfaces += 1; }
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

  const latinKeys = [...latin.keys()].sort(byLenDesc);
  const cjkKeys = [...cjk.keys()].sort(byLenDesc);

  const latinRe = latinKeys.length > 0
    ? new RegExp(`(?<![A-Za-z0-9_])(?:${latinKeys.map(escapeRegex).join('|')})(?![A-Za-z0-9_])`, 'gi')
    : null;
  const cjkRe = cjkKeys.length > 0
    ? new RegExp(`(?:${cjkKeys.map(escapeRegex).join('|')})`, 'g')
    : null;

  const ruleCount = surfaces;

  return {
    ruleCount,
    apply(text: string): string {
      if (ruleCount === 0 || text.length === 0) return text;
      let out = text;
      // Latin first: a later CJK→Latin canonical output is never re-scanned by the
      // Latin pass (single-pass per regex), so no cascade across the two passes.
      if (latinRe) out = out.replace(latinRe, (m) => latin.get(m.toLowerCase()) ?? m);
      if (cjkRe) out = out.replace(cjkRe, (m) => cjk.get(m) ?? m);
      return out;
    },
  };
}
