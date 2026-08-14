// scripts/i18n/interpolation.mjs
//
// The piece the first P1 attempt did not have, and the reason it was rolled back
// (architecture doc §8-bis): 86 of the 690 catalogue strings interpolate
// something that only exists AT THE CALL SITE — a method parameter or a local
// (`$why`, `${age.inHours}`, `${formatBytes(bytes)}`, `${r.added}`). Move such a
// string into a locale class and those names are simply not in scope there.
//
// So a leaf comes in two kinds, and this module is what decides which:
//   · no interpolation  -> `String get _lfFoo;`
//   · interpolation     -> `String _lfFoo(Object? why);`, called `_lfFoo(why)`.
//
// 🔴 WHY WHOLE `${…}` UNITS, AND NOT THE FREE IDENTIFIERS INSIDE THEM.
// Extracting `age` out of `${age.inHours}` would give a shorter parameter list
// and read better. It is also the one variant that can be SILENTLY WRONG: an
// identifier left inside the string is re-resolved in the generated class, where
// a same-named member of the catalogue may shadow the call site's local, and the
// result is a compiling app with one wrong sentence in one language. Hoisting the
// WHOLE expression cannot do that — the expression is evaluated at exactly the
// place it was evaluated before, so its value is identical by construction. The
// cost is uglier parameter names, which is a price worth paying here.
// (A second reason: `Object?` is only sound for a value that is interpolated.
// `${aiTaskLabel(task)}` with `task` hoisted as `Object?` would not even compile,
// because `aiTaskLabel` wants a `ComposeTask`.)
//
// 🔴 WHY PARAMETERS ARE MATCHED BY EXPRESSION TEXT AND NOT BY POSITION.
// Word order is a property of the language: zh writes 「$a 的 $b」 where en writes
// 「$b of $a」. Pairing arm #1's first hole with arm #2's first hole would swap the
// two values in every language whose word order differs from the reference — a
// defect that compiles, renders, and is invisible to anyone who does not read
// that language. Holes are therefore keyed by the source text of the expression;
// order only decides the DECLARED parameter order, which is taken from the base
// locale (English, owner 2026-08-14).

/** Dart keywords that cannot be a parameter name. Only the ones a derived name
 *  could realistically collide with; an unlisted one surfaces as a compile
 *  error, never as a wrong string. */
const DART_RESERVED = new Set([
  'assert', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'do', 'else',
  'enum', 'extends', 'false', 'final', 'finally', 'for', 'if', 'in', 'is', 'new', 'null',
  'rethrow', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'var', 'void',
  'while', 'with',
]);

/** Longest a derived parameter name may get before it is truncated. Collisions
 *  created by truncation are resolved by the numeric suffix below, so this is a
 *  readability cap and not a correctness one. */
const MAX_PARAM_LEN = 44;

/** Index of the `}` that closes the `{` at `openIdx`, or -1.
 *  Nested braces and nested string literals both occur inside this catalogue's
 *  interpolations (`${outcome.detail ?? '未知原因'}`), so both are tracked. */
function matchBrace(src, openIdx, end) {
  let depth = 0;
  let i = openIdx;
  while (i < end) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i += 1;
      while (i < end) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === c) break;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Split ONE Dart string literal (source text, quotes included) into text and
 * interpolation parts. Text parts keep their ORIGINAL source bytes — escapes are
 * copied, never decoded — which is what lets [renderLiteral] rebuild a literal
 * that is byte-identical wherever nothing was substituted.
 *
 * @param {string} piece e.g. `'还有 $n 条'` or `r'C:\x'`
 */
export function splitLiteral(piece) {
  let i = 0;
  let raw = false;
  if (piece[0] === 'r') {
    raw = true;
    i = 1;
  }
  const quote = piece[i];
  if (quote !== "'" && quote !== '"') throw new Error(`not a Dart string literal: ${piece}`);
  const end = piece.length - 1;
  if (piece[end] !== quote) throw new Error(`literal does not end in its own quote: ${piece}`);
  i += 1;

  const parts = [];
  let text = '';
  const flush = () => {
    if (text !== '') {
      parts.push({ kind: 'text', text });
      text = '';
    }
  };
  while (i < end) {
    const c = piece[i];
    // In a raw string a backslash is literal and `$` does not interpolate.
    if (!raw && c === '\\') {
      text += piece.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (!raw && c === '$') {
      if (piece[i + 1] === '{') {
        const close = matchBrace(piece, i + 1, end);
        if (close === -1) throw new Error(`unbalanced \${…} in: ${piece}`);
        flush();
        parts.push({ kind: 'interp', expr: piece.slice(i + 2, close), brace: true });
        i = close + 1;
        continue;
      }
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(piece.slice(i + 1, end));
      if (m) {
        flush();
        parts.push({ kind: 'interp', expr: m[0], brace: false });
        i += 1 + m[0].length;
        continue;
      }
    }
    text += c;
    i += 1;
  }
  flush();
  return { raw, quote, parts };
}

/**
 * Rebuild a literal, replacing each interpolated expression with whatever
 * `mapExpr` returns for it.
 *
 * The bare `$name` form is preserved when the substitution changes nothing, so
 * the overwhelmingly common case (`'$n 条'` with a parameter also called `n`)
 * comes out byte-identical to the source. A BRACED hole always stays braced:
 * turning `${n}abc` into `$nabc` would silently re-parse as the identifier
 * `nabc`.
 */
export function renderLiteral(split, mapExpr) {
  let out = (split.raw ? 'r' : '') + split.quote;
  for (const p of split.parts) {
    if (p.kind === 'text') {
      out += p.text;
      continue;
    }
    const name = mapExpr(p.expr);
    out += !p.brace && name === p.expr ? `$${name}` : `\${${name}}`;
  }
  return out + split.quote;
}

/**
 * A Dart identifier derived from the SOURCE TEXT of an interpolated expression.
 *
 * `why` -> `why` · `age.inHours` -> `ageInHours` · `r.added` -> `rAdded` ·
 * `formatBytes(bytes)` -> `formatBytesBytes`.
 *
 * ⚠️ String literals inside the expression are dropped before tokenising, so a
 * localised fallback (`outcome.detail ?? '未知原因'`) can never leak its text
 * into an identifier — and, since Dart identifiers are ASCII-only, could not be
 * spelled there anyway.
 */
export function paramNameFor(expr) {
  const stripped = expr
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ');
  const tokens = stripped.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  let name = tokens
    .map((t, i) => (i === 0 ? t[0].toLowerCase() + t.slice(1) : t[0].toUpperCase() + t.slice(1)))
    .join('');
  name = name.replace(/^_+/, ''); // a leading underscore would read as private
  if (name === '') name = 'value';
  if (name.length > MAX_PARAM_LEN) name = name.slice(0, MAX_PARAM_LEN);
  if (DART_RESERVED.has(name)) name = `${name}Value`;
  return name;
}

/** The interpolated expressions in one arm, in source order (duplicates kept:
 *  the caller needs first-appearance order, and the de-dup is its business). */
function armExpressions(arm) {
  if (arm && arm.expression !== undefined) return [arm.expression];
  const out = [];
  for (const piece of arm) {
    for (const p of splitLiteral(piece).parts) if (p.kind === 'interp') out.push(p.expr);
  }
  return out;
}

/**
 * Decide what one call site becomes.
 *
 * @param entry     one worksheet entry from derive-keys.mjs
 * @param armNames  the locale arms present on it, e.g. ['zh','en','ja','ko']
 * @param baseArm   the arm whose word order defines the DECLARED parameter order
 * @returns
 *   `{kind:'getter'}`                      — no interpolation anywhere
 *   `{kind:'method', params, bodies}`      — params: [{name, expr}] in declared
 *                                            order; bodies: arm -> Dart source
 *   `{kind:'skip', reason, detail}`        — the arms disagree about WHICH
 *                                            expressions they use; reported, not
 *                                            guessed at (see below)
 *
 * 🔴 WHY DISAGREEMENT IS REFUSED RATHER THAN UNIONED.
 * Taking the union would compile and would render correctly today, so the reason
 * is not safety — it is WHAT half of those sites are. Measured on the mobile
 * catalogue, 12 calls disagree and they split evenly:
 *   · six carry LANGUAGE-SPECIFIC content inside the expression itself — an
 *     English plural rule (`n == 1 ? '' : 'es'`), a localised fallback
 *     (`outcome.detail ?? '未知原因'`), a localised list separator
 *     (`reasons.join('、')`), whole localised sentences inside a conditional.
 *     Hoisting those to the call site moves translated text OUT of the locale
 *     layer, which is the exact opposite of what the migration is for: the next
 *     language could then never supply its own plural, its own fallback or its
 *     own separator without editing hand-written Dart;
 *   · six are `packLabel`, whose `en` arm is not a translation but the
 *     protocol's own SSOT label handed in by the caller. Unioning those would
 *     have been fine.
 * They are all refused, because the alternative is a rule that decides case by
 * case which disagreements are benign — and a rule with exceptions is a rule
 * whose next exception nobody reviews. Leaving the `_t(...)` in place keeps the
 * residue visible and countable instead of laundering it into a parameter list.
 */
export function planEntry(entry, armNames, baseArm) {
  const perArm = {};
  for (const a of armNames) {
    const arm = entry.arms[a];
    const isExpr = arm && arm.expression !== undefined;
    perArm[a] = {
      isExpr,
      splits: isExpr ? null : arm.map(splitLiteral),
      exprs: armExpressions(arm),
    };
  }

  const signature = (a) => [...new Set(perArm[a].exprs)].sort().join('\u0000');
  const signatures = new Set(armNames.map(signature));
  if (signatures.size !== 1) {
    return {
      kind: 'skip',
      reason: 'arms interpolate different expressions',
      detail: armNames.map((a) => `${a}: [${[...new Set(perArm[a].exprs)].join(' | ')}]`),
    };
  }

  if (perArm[baseArm].exprs.length === 0) return { kind: 'getter' };

  // Declared order = first appearance in the BASE locale. Deterministic, and it
  // is the one arm whose order is defensible as "the order a reader of the
  // source language meets these values in".
  const order = [];
  for (const e of perArm[baseArm].exprs) if (!order.includes(e)) order.push(e);

  const used = new Set();
  const params = order.map((expr) => {
    let name = paramNameFor(expr);
    if (used.has(name)) {
      let n = 2;
      while (used.has(`${name}${n}`)) n += 1;
      name = `${name}${n}`;
    }
    used.add(name);
    return { name, expr };
  });
  const byExpr = new Map(params.map((p) => [p.expr, p.name]));
  const mapExpr = (e) => {
    const n = byExpr.get(e);
    if (n === undefined) throw new Error(`interpolation.planEntry: no parameter for ${e}`);
    return n;
  };

  const bodies = {};
  for (const a of armNames) {
    bodies[a] = perArm[a].isExpr
      ? // The whole arm was an expression rather than a literal (the six
        // `en: englishLabel` sites). Wrapping it in an interpolation is what
        // makes it a String under an `Object?` parameter; for a String value
        // the result is equal to the value itself.
        `'\${${mapExpr(perArm[a].exprs[0])}}'`
      : perArm[a].splits.map((s) => renderLiteral(s, mapExpr));
  }
  return { kind: 'method', params, bodies };
}
