// verify/eval/run-eval.mjs
//
// Runner for the W2 adversarial corpus (FB-5 translate/organize precision,
// FB-6 realtime transcription quality). Two modes, and the difference between
// them is the whole point:
//
//   --mode=selftest   Validates THE RULER. No network, no keys, no engine.
//                     Every case's golden_good must pass all its judges and
//                     every case's golden_bad must fail at least one. This is
//                     what runs in the resident gate.
//
//   --mode=live       Validates THE PRODUCT. Runs the real prompts against a
//                     real engine line and reports pass rates per suite and
//                     per adversarial family. Needs credentials and network,
//                     so it is NOT in the gate — its output is archived.
//
// WHY THE GATE RUNS THE SELFTEST AND NOT THE LIVE RUN. A gate that needs a
// vendor to be up is a gate that goes red for reasons that are not about this
// repository, and a gate that goes red for unrelated reasons gets ignored —
// CLAUDE.md records exactly that happening to G12, which was red for a day
// before anyone noticed. The selftest is hermetic and sub-second, so it can be
// believed. What it proves is narrower than "the product is good": it proves
// the measuring instrument still discriminates between a correct output and
// the specific failure each case was written to catch. That is the property
// that silently rots, and it is the one this repo has been burned by.
//
// Usage:
//   node verify/eval/run-eval.mjs --mode=selftest
//   node verify/eval/run-eval.mjs --mode=live --line=managed    --suite=translate
//   node verify/eval/run-eval.mjs --mode=live --line=selfhosted --suite=organize
//   node verify/eval/run-eval.mjs --mode=live --line=openrouter --suite=translate
//
// Exit codes follow the scripts/*.test.mjs convention: 0 PASS, 1 FAIL, 2 SKIP.

// ─── FILE LAYOUT ────────────────────────────────────────────────────────────
//
// This file was one 794-line module until it crossed the repo's 800-line cap.
// It is now a thin entry point that parses --mode and dispatches; every mode
// lives beside it, and each was moved VERBATIM (the split commit contains no
// behaviour change, and the proof is that all four modes' output is
// byte-identical before and after):
//
//   eval-paths.mjs        HERE / ROOT / CASES_DIR / TMP / SUITES
//   eval-args.mjs         the --flag parsing, read once at import
//   eval-corpus.mjs       loadSuite + the case-schema validator
//   eval-prod-bundle.mjs  the esbuild shim that imports production TypeScript
//   eval-selftest.mjs     --mode=selftest   (the ruler)
//   eval-replay.mjs       --mode=replay     (the real merge fold)
//   eval-guard.mjs        --mode=guard      (the real compose output guard)
//   eval-live.mjs         --mode=live       (a real engine; not in the gate)
//
// The cut is by SUBJECT — one file per mode — not by line count. A cut made to
// get a number under a cap lands wherever the number happens to fall, and the
// next person to add ten lines pays the same cost again.

import { SUITES } from './eval-paths.mjs';
import { MODE, ONLY_SUITE } from './eval-args.mjs';
import { loadSuite } from './eval-corpus.mjs';
import { selftest } from './eval-selftest.mjs';
import { replay } from './eval-replay.mjs';
import { guardMode } from './eval-guard.mjs';
import { live } from './eval-live.mjs';

// ---------------------------------------------------------------------------

const loaded = SUITES.filter((s) => !ONLY_SUITE || s === ONLY_SUITE || MODE === 'selftest').map(loadSuite);

if (MODE === 'selftest') {
  process.exit(selftest(loaded) ? 0 : 1);
} else if (MODE === 'replay') {
  const r = await replay(loaded);
  process.exit(r === 'skip' ? 2 : r ? 0 : 1);
} else if (MODE === 'guard') {
  const r = await guardMode(loaded);
  process.exit(r === 'skip' ? 2 : r ? 0 : 1);
} else if (MODE === 'live') {
  const r = await live(loaded);
  process.exit(r === 'skip' ? 2 : r ? 0 : 1);
} else {
  console.error(`unknown --mode=${MODE}`);
  process.exit(1);
}
