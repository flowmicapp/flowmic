// verify/lint/strip-ts-comments.mjs
// Shared `stripTsComments()` — the crude, whole-file comment stripper used by
// server-core's anti-façade "wiring" tests (grep a production caller out of
// comment-stripped .ts source, so a mention inside a comment can never satisfy
// a "must exist in production" assertion). Formerly six near-identical private
// copies; this is the one implementation all of them now call.
//
// CONSTRAINT — ORDER IS LOAD-BEARING, NOT A STYLE CHOICE: whole-line `//`
// comments MUST be stripped BEFORE `/* … */` block comments are stripped.
// Doing it the other way around — running the block-comment regex first, over
// the raw, un-stripped text — is position-blind: if a `//` line contains a
// literal `/*` with no closing `*/` on the same line (e.g. a file header
// reading `// /api/ops/* — THE CROSS-ACCOUNT OPERATIONS SURFACE.`), the block
// regex opens a comment right there and consumes everything up to the next
// UNRELATED `*/` anywhere later in the file — including real code in between.
// Stripping `//` lines first removes that trigger before the block regex ever
// sees it, which is what makes the crude two-pass approach below safe. This is
// not hypothetical: measured on src/http/ops-routes.ts under the block-first
// order, the block-strip stage alone deleted 7,982 of 17,784 characters (45%
// of the file), taking 7 real code lines with it (four imports and two
// page-size constants) — see git commit b1ad631.
//
// STILL DELIBERATELY CRUDE: this is a test/wiring helper, not a parser. A `//`
// occurring inside a string or template literal on its own line (rare in this
// codebase's style) is not distinguished from a real line comment, and a
// multi-line string containing something that looks like `/*` is not handled
// specially either. If a caller needs a stripper that is safe against string
// and template-literal content, that is `stripJsComments` in `./_util.mjs` — a
// different, position-safe state-machine implementation used by
// module-reachability.mjs and circular.mjs. The two are not interchangeable:
// `stripJsComments` blanks comment bodies with spaces (preserving line
// numbers, for scanners that report positions); this one deletes commented
// lines outright and does not promise stable line numbers.
//
// EXCLUDED ON PURPOSE: verify/lint/css-var-defined.mjs keeps its own local
// `stripComments()` (same line-then-block order, fixed by the same commit)
// rather than calling this one. Its semantics differ — it blanks comment
// bodies with spaces instead of deleting them, to keep reported line numbers
// true for its own scanner — so unifying it here would change its behaviour.
// Do not merge it in.

/**
 * Strip whole-line `//` comments, then `/* … *\/` block comments, from
 * TypeScript/JavaScript source. See the module-level comment above for the
 * ordering constraint this implementation depends on.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripTsComments(src) {
  return src
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}
