// F2 — pins the fix for a defect shared by six copies of a `stripComments()`
// test helper: console-admin-gate-coverage.test.ts, ops-audit-wiring.test.ts,
// mail-password-reset.test.ts, startup-secret-check.test.ts,
// enc-inventory.test.ts (all in this directory), and
// verify/lint/css-var-defined.mjs.
//
// SPEC-REF: verify/lint/strip-ts-comments.mjs (the shared implementation the
//           five files above now import — see UPDATE below)
//
// THE DEFECT (found and measured 2026-08-12, not hypothetical). Every copy
// stripped `/* ... */` block comments BEFORE stripping whole-line `//`
// comments, over the raw, unmodified text:
//
//   src.replace(/\/\*[\s\S]*?\*\//g, '').split(...).filter(not-a-`//`-line)
//
// That order is position-blind: if a `//` line contains a literal `/*` with
// no closing `*/` on the same line — e.g. a file header reading
// `// /api/ops/* — THE CROSS-ACCOUNT OPERATIONS SURFACE.` — the block-comment
// regex opens a comment right there and swallows everything up to the next
// UNRELATED `*/` anywhere later in the file, including real code. Measured on
// src/http/ops-routes.ts: the block-strip stage alone deleted 7,982 of 17,784
// characters (45% of the file), lines 10→67, taking 7 real code lines with it
// (four imports and two page-size constants). The old docstring on every copy
// claimed the opposite, verbatim: "it can only ever ADD spurious matches …
// never delete a real one". That sentence was false — which is the second
// defect this test pins: a comment asserting behaviour that isn't true.
//
// THE FIX (now shipped in all six copies): strip whole-line `//` comments
// FIRST, so a `/*` that only ever existed inside a comment nobody meant to
// open cannot do so — THEN strip block comments from what remains. Still
// "deliberately crude" (these are test/lint helpers, not a parser), but crude
// no longer means wrong in the dangerous direction.
//
// UPDATE (2026-08-12, follow-up to F2): the five apps/server-core/test/ copies
// are gone — they now import `stripTsComments` from
// verify/lint/strip-ts-comments.mjs, one implementation instead of five. This
// file's "NEW (line-first) order" case below calls THAT shared function
// directly (not a local mirror), so it is a real regression pin against the
// production module, not a copy that could drift out of sync with it. The
// "OLD (block-first) order" case stays a local, never-exported, VERBATIM copy
// of the order that shipped before the fix — it must never become importable
// from anywhere, since its entire purpose is to demonstrate that order is
// wrong; keeping it error-shaped and unreachable from production code is
// deliberate.
//
// verify/lint/css-var-defined.mjs is EXCLUDED from the shared module by
// design (blanks comments with spaces to keep line numbers stable, rather
// than deleting lines) — see the exclusion note in strip-ts-comments.mjs.

import { describe, expect, it } from 'vitest';
import { stripTsComments } from '../../../verify/lint/strip-ts-comments.mjs';

/** VERBATIM copy of the order that shipped in all six files before the
 *  2026-08-12 fix. Present ONLY so this test can demonstrate it is wrong —
 *  deliberately never exported, never imported by production code. */
function stripCommentsOldBuggyOrder(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

// A `//` line containing an un-terminated `/*` — the exact shape of the real
// trigger in src/http/ops-routes.ts's own file header (`// /api/ops/* — THE
// CROSS-ACCOUNT OPERATIONS SURFACE.`) — followed by a real code line that
// must survive, and a genuine block comment that must still be removed.
const FIXTURE = [
  '// this comment mentions /api/ops/* in passing, never meaning to open a block',
  "export const REAL_CODE_MARKER = 'survives stripping';",
  '/** a legitimate block comment, which should still be removed */',
  "export const AFTER_BLOCK_MARKER = 'also survives';",
].join('\n');

describe('stripComments() comment-strip order (F2 regression pin)', () => {
  it('OLD (block-first) order deletes the real code — reproduces the defect', () => {
    const out = stripCommentsOldBuggyOrder(FIXTURE);
    // This is the bug: the `//` line's un-terminated `/*` opens a block
    // comment that runs past it, non-greedily, to the very next `*/` it can
    // find — which here is the legitimate block comment's own closer — and
    // swallows the real code line in between. (AFTER_BLOCK_MARKER sits past
    // that `*/`, so it survives either way; it is not what this test is
    // pinning. REAL_CODE_MARKER is the one line that must never disappear,
    // and under the old order it does.)
    expect(out).not.toContain('REAL_CODE_MARKER');
  });

  it('NEW (line-first) order keeps every real code line and still removes the genuine block comment', () => {
    // Calls the actual shared implementation — not a mirror of it — so this
    // pin breaks if strip-ts-comments.mjs ever regresses back to block-first.
    const out = stripTsComments(FIXTURE);
    expect(out).toContain('REAL_CODE_MARKER');
    expect(out).toContain('AFTER_BLOCK_MARKER');
    expect(out).not.toContain('legitimate block comment');
    expect(out).not.toContain('/api/ops/*');
  });
});
