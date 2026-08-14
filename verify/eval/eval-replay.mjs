// verify/eval/eval-replay.mjs
//
// --mode=replay: the `merge` suite, driven through the PRODUCTION accumulator
// fold. Extracted VERBATIM from run-eval.mjs in the 800-line split.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { judgeCase } from './judges/index.mjs';
import { ROOT } from './eval-paths.mjs';
import { loadProductionPrompts } from './eval-prod-bundle.mjs';

// ---------------------------------------------------------------------------
// replay — the `merge` suite, run for real against the production accumulators
// ---------------------------------------------------------------------------

/**
 * Reproduces SttEngineOrchestrator's two accumulators exactly.
 *
 * The three lines below are transcribed from production and each carries its
 * file:line so a reader can check them rather than trust this comment
 * (anti-facade #4 — a comment asserting behaviour elsewhere must be checkable):
 *   interim : orchestrator-core.ts  onlineDraft = mergeOnlineDraft(onlineDraft, e.text)
 *   final   : orchestrator-core.ts  offlineAccum = mergeOverlap(offlineAccum, e.text); onlineDraft = ''
 *   terminal: orchestrator-core.ts:375  getOfflineText = () => foldConfirmedWithDraft(this.offlineAccum, this.onlineDraft)
 *
 * That last line is the one under test. raceFlushFinal (flush-final.ts:104-109)
 * resolves with exactly this string on every non-timeout path, so it IS the
 * terminal transcript, not a preview.
 *
 * 🔴 CORRECTED (2026-08-07). This "terminal:" line used to read:
 *   "orchestrator-core.ts:368  getOfflineText = () => mergeOnlineDraft(offlineAccum, onlineDraft)"
 * Both halves were wrong: the real call site is :375, not :368, and the fold
 * used there is `foldConfirmedWithDraft`, not `mergeOnlineDraft`.
 * `mergeOnlineDraft` is the EXACT name checkProductionWiring() below treats as
 * a REGRESSION (`call[1] !== 'foldConfirmedWithDraft'` -> FAIL) — this
 * comment, while presenting itself as a verbatim transcription of production
 * (see the paragraph above), was asserting the precise broken state that
 * function exists to detect and fail the gate on. Original text kept above
 * for the trace; do not restore it.
 * ⚠️ It was also a live specimen of this repo's own coordinate-anchors lint
 * warning that a green coordinate is not a verified one (see the header of
 * verify/lint/coordinate-anchors.mjs, search for "VERIFIED COORDINATE"): the
 * lint passed this citation, because line 368 sits inside orchestrator-core.ts's
 * :367-372 block comment, which itself contains the bare word `mergeOnlineDraft` — in a sentence that
 * REPUDIATES it ("the fold is `foldConfirmedWithDraft`, NOT
 * `mergeOnlineDraft`"). The anchor token was textually present within the
 * lint's ±3-line window; the lint only checks that the word is nearby, not
 * that the sentence containing it agrees with the claim being made here.
 * Already logged as item A-8 in
 * docs/strategy/2026-08-06-w2-transcription-quality-ledger.md.
 */
function simulateAccumulators(frames, prod) {
  let offlineAccum = '';
  let onlineDraft = '';
  for (const [kind, text] of frames) {
    if (kind === 'interim') {
      onlineDraft = prod.mergeOnlineDraft(onlineDraft, text);
    } else {
      offlineAccum = prod.mergeOverlap(offlineAccum, text);
      onlineDraft = '';
    }
  }
  return prod.foldConfirmedWithDraft(offlineAccum, onlineDraft);
}


/**
 * Prove the production call site actually USES the no-loss fold.
 *
 * 🔴 WHY THIS EXISTS. Without it this replay was a façade of the exact kind
 * this repo keeps paying for: it imported `foldConfirmedWithDraft` and drove it
 * directly, so it proved the FUNCTION was correct while proving nothing about
 * whether anything CALLS it. Measured: reverting orchestrator-core.ts:375 back
 * to `mergeOnlineDraft` left this gate fully green. A capability that is defined
 * and not wired is CLAUDE.md's #1 historical bug class, and the anti-façade rule
 * is explicit that unit-green says nothing about wiring.
 * 🔴 CORRECTED (2026-08-07): this line used to cite `:368` — wrong, that line
 * sits inside the block comment explaining the fix, not the call site itself.
 * Full correction on the "terminal:" line in the doc-comment above.
 *
 * ⚠️ WHAT IT IS AND IS NOT. This is a source anchor, not an execution proof: it
 * reads the file and checks the fold used to build the terminal transcript is
 * the no-loss one. It would not catch someone rewriting the fold's body, and it
 * is not a substitute for driving a real orchestrator against a real engine —
 * that proof does not exist yet and is logged as an open account in the W2
 * ledger. What it does catch is the cheap, likely regression: someone
 * "simplifying" the two folds back into one.
 */
function checkProductionWiring() {
  const p = join(ROOT, 'apps/server-core/src/stt/orchestrator-core.ts');
  if (!existsSync(p)) return ['orchestrator-core.ts not found — cannot verify the fold is wired'];
  const src = readFileSync(p, 'utf8');
  const problems = [];
  const call = /getOfflineText:\s*\(\)\s*=>\s*(\w+)\(/.exec(src);
  if (!call) {
    problems.push('could not find the getOfflineText fold in orchestrator-core.ts — the terminal transcript is built somewhere this gate no longer watches');
  } else if (call[1] !== 'foldConfirmedWithDraft') {
    problems.push(`the terminal transcript is folded by ${call[1]}(), not foldConfirmedWithDraft() — confirmed speech can be discarded again (orchestrator-core.ts)`);
  }
  return problems;
}

async function replay(loaded) {
  const wiring = checkProductionWiring();
  if (wiring.length) {
    console.log('── production wiring ──');
    for (const w of wiring) console.log(`  ✗ ${w}`);
  } else {
    console.log('── production wiring: terminal transcript folded by foldConfirmedWithDraft ✓ ──');
  }
  const prod = await loadProductionPrompts();
  const cases = loaded.find((l) => l.suite === 'merge')?.cases ?? [];
  if (cases.length === 0) {
    console.log('SKIP: no merge cases found');
    return 'skip';
  }
  const rows = cases.map((k) => {
    const output = simulateAccumulators(k.frames, prod);
    const v = judgeCase(k, output);
    return { k, output, v };
  });
  const byFam = new Map();
  for (const { k, v } of rows) {
    const cur = byFam.get(k.family) ?? { n: 0, pass: 0 };
    cur.n += 1;
    if (v.ok) cur.pass += 1;
    byFam.set(k.family, cur);
  }
  console.log('── merge replay against production text-merge.ts ──');
  for (const [f, v] of [...byFam.entries()].sort()) {
    const mark = v.pass === v.n ? 'ok  ' : 'LOSS';
    console.log(`  ${mark} ${String(v.pass).padStart(2)}/${String(v.n).padStart(2)}  ${f}`);
  }
  const bad = rows.filter((r) => !r.v.ok && !r.k.known_open);
  const openAccts = rows.filter((r) => r.k.known_open);
  // A known_open case that starts PASSING is a failure too. Otherwise this field
  // becomes a place to park anything inconvenient: the account would stay open
  // in the file long after the defect was gone, and the next person would read a
  // ledger entry that is no longer true. Passing means the account can be
  // closed, and closing it is a human's job.
  const closable = openAccts.filter((r) => r.v.ok);
  if (openAccts.length) {
    console.log(`
${openAccts.length} known-open account(s) — printed every run, never silently tolerated:`);
    for (const { k, output, v } of openAccts) {
      console.log(`  ${v.ok ? '!' : '~'} ${k.id} [${k.family}] ${v.ok ? 'NOW PASSES — close the account' : v.failures.map((f) => f.judge).join('+')}`);
      console.log(`      merged : ${JSON.stringify(output)}`);
      console.log(`      why open: ${k.open_reason}`);
      // W2-14: the block above claimed to be "printed every run", and it is —
      // by THIS process. But the resident gate spawns this runner and only
      // echoes its output when it FAILS, so on the green path (which is every
      // normal run) the accounts were printed into a buffer nobody read. One
      // greppable line per account gives the caller something it can forward
      // without dumping the whole log; making the claim true rather than
      // deleting it, because the accounts do need to stay visible.
      console.log(`KNOWN-OPEN: ${k.id} [${k.family}] ${v.ok ? 'NOW PASSES — close it' : 'still open'} — ${k.open_reason}`);
    }
  }
  if (bad.length) {
    console.log(`
${bad.length} case(s) lost spoken content:`);
    for (const { k, output, v } of bad) {
      console.log(`  ✗ ${k.id} [${k.family}]`);
      console.log(`      spoken : ${JSON.stringify(k.input)}`);
      console.log(`      merged : ${JSON.stringify(output)}`);
      for (const f of v.failures) console.log(`      ${f.judge}: ${f.detail}`);
    }
  }
  const pass = rows.length - bad.length - openAccts.length;
  console.log(`
ACCOUNTING: sections run ${rows.length}/${rows.length} merge cases (+1 wiring check); ${pass} clean, ${openAccts.length} known-open, ${bad.length} unexpected failure(s)`);
  return bad.length === 0 && closable.length === 0 && wiring.length === 0;
}
export { simulateAccumulators, checkProductionWiring, replay };
