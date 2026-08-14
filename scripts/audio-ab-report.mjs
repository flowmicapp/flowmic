// RT-6-a — the RENDERING half of the audio A/B bed. VERBATIM SPLIT from
// scripts/audio-ab-eval.mjs (2026-08-10), not a rewrite: `renderReport` and its
// three formatters moved here character-for-character when the eval module
// crossed the repo's 800-line cap.
//
// WHY THIS IS THE SEAM. Everything left in audio-ab-eval.mjs answers "what
// happened" — read the corpus, drive a leg, void what did not complete, compare.
// This file answers "how is that said to a human", and it is the half whose
// defects are the expensive ones: this bed's output gets quoted into a ledger,
// and the three failures being repaired here were all failures of TELLING, not
// of measuring. The 408 session really did return nothing; the bug was that the
// report called that `recall 0.0000` instead of VOID.
//
// 🔴 THE RULES THIS RENDERER ENFORCES, none of which is decoration:
//  1. A row that produced no measurement prints VOID or ERR — never `n/a`, never
//     a number. `n/a` reads as "this column does not apply"; VOID reads as "this
//     session died", which is the fact.
//  2. Provenance goes ABOVE the first number: whoever assembled the text says so
//     before anyone reads a score computed on it.
//  3. The denominator sits on the line under the recall it belongs to.
//  4. It never throws. A finished run must not be discarded at its last step —
//     see `safeFileName` in audio-ab-eval.mjs for the 26 seconds of real audio
//     that were transcribed correctly and then lost to an ENOENT.
//
// Deterministic: no clock, no randomness, no network, no I/O.
// Node 22 ESM, builtins only.

import { DUP_SUSPECT_RATIO } from './audio-ab-score.mjs';

const f4 = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(4) : 'n/a');
const f2 = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : 'n/a');
const ms = (n) => (typeof n === 'number' ? `${n}` : 'n/a');

/**
 * Render the human report.
 *
 * Deliberately verbose about what a number does NOT mean. This bed's output will
 * be quoted into a ledger, and a bare table of recalls quoted without its
 * caveats is how "0.9513 legitimate vs 0.9218 real loss" turns into someone
 * writing a threshold.
 *
 * @param {object} ctx
 */
export function renderReport(ctx) {
  const { corpus, legA, legB, cmp, startedAt, machine, notes } = ctx;
  const L = [];
  const p = (s = '') => L.push(s);

  p(`# RT-6-a audio A/B — ${legA.name}${legB ? ` vs ${legB.name}` : ' (single leg)'}`);
  p();
  p(`- generated: ${startedAt}`);
  p(`- machine: ${machine}`);
  p(`- corpus: \`${corpus.dir}\` (manifest v${corpus.version ?? '?'}, ${corpus.segments.length} segment(s))`);
  p(`- leg A: **${legA.name}** — ${legA.describe}`);
  if (legB) p(`- leg B: **${legB.name}** — ${legB.describe}`);
  p();

  /**
   * P2 — WHOSE STRING IS THIS. Printed before any number, because it changes
   * what every number below is a measurement OF.
   *
   * 🔴 WHY THIS BLOCK IS GENERATED FROM DATA AND NOT WRITTEN HERE AS PROSE. A
   * sentence in the renderer is an assertion about somebody else's code, and
   * this repo's anti-façade rule ④ is that such a sentence stays green while the
   * code it describes changes underneath it. The text comes off the adapter, so
   * the leg that assembles tokens is the leg that has to say so.
   *
   * 🔴 AND WHY AN UNDECLARED LEG IS A BANNER RATHER THAN A THROW. Refusing to
   * render would destroy a finished run at its last step — the exact failure
   * `safeFileName` below exists because of (26 s of real audio transcribed
   * correctly, then ENOENT). The declaration is enforced instead by the drill
   * (every registry adapter must carry one) and by the exit code (3), neither of
   * which can eat the evidence.
   */
  const legsForProvenance = [['A', legA], ['B', legB]].filter(([, l]) => l);
  const nonProduct = legsForProvenance.filter(([, l]) => !l.assembler || l.assembler.kind !== 'product');
  if (nonProduct.length > 0) {
    p('> 🔴 **THE TEXT IN THIS REPORT IS NOT WHAT THE PRODUCT WOULD EMIT.** Every hypothesis below');
    p('> was assembled by this bed, not by the shipping pipeline. This bed has already reported one');
    p('> of its own artefacts as a product defect (`<end>` in a "final transcript"; the retraction is');
    p('> in `packages/stt-cloud/src/engines/soniox-markers.ts`). Per leg:');
    p('>');
    for (const [tag, l] of nonProduct) {
      if (!l.assembler) {
        p(`> - 🔴 **${tag} (${l.name}) DID NOT DECLARE ITS ASSEMBLER.** Provenance unknown — treat this leg's`);
        p('>   text as unattributed. (The adapter contract requires an `assembler` field.)');
        continue;
      }
      p(`> - **${tag} (${l.name})** — \`${l.assembler.kind}\`: ${l.assembler.note}`);
    }
    p();
  }
  p('> 🔴 There is no pass threshold on recall, on purpose. P2 measured a legitimate');
  p('> polish at 0.9513 and a real 10% content loss at 0.9218 — three points apart, so any');
  p('> constant between them is wrong in one direction. Read the per-segment numbers WITH');
  p('> the `missing` list. The first question is P3\'s: is the loss one block (a segment was');
  p('> dropped) or a scatter (the engine misheard here and there)?');
  p('>');
  p('> The one mechanical verdict below is SPAN SURVIVAL. It is per segment and is never');
  p('> averaged, because an aggregate can look healthy while one code-switch segment has');
  p('> silently lost its only English word.');
  p();

  p('## 1. Verdict (mechanical)');
  p();

  // 🔴 VOID FIRST. A void row is not a bad score, it is the absence of a
  // measurement, and it is printed above the verdict because it changes the
  // basis the verdict was computed on.
  const voidRows = [];
  for (const [tag, leg] of legsForProvenance) {
    for (const r of leg.rows) if (r.void) voidRows.push({ tag, name: leg.name, r });
  }
  if (voidRows.length > 0) {
    p(`🔴 **${voidRows.length} VOID row(s) — a session that did not complete. NOT SCORED, NOT A ZERO.**`);
    p('These segments produced no measurement at all. They are excluded from every number in this');
    p('report, and the aggregate below is therefore over a SUBSET — read the "segments scored" row');
    p('before quoting any recall. A void is the bed refusing to turn an infrastructure failure into');
    p('a subject result; that has happened here before and reached a ledger as a product finding.');
    p();
    for (const v of voidRows) {
      p(`- seg-${v.r.id} · ${v.tag} (${v.name}) — ${v.r.void.why}`);
      if (v.r.void.partialChars > 0) p(`  - partial text discarded (${v.r.void.partialChars} chars, diagnostic only): ${JSON.stringify(v.r.void.partialText.slice(0, 120))}`);
    }
    p();
  }
  const notComparable = (cmp.segments ?? []).filter((s) => s.pairScored === false);
  if (legB && notComparable.length > 0) {
    p(`⚠️ ${notComparable.length} segment(s) are NOT A/B-COMPARABLE (one side never answered): ` +
      `${notComparable.map((s) => `seg-${s.id}`).join(', ')}. No span regression, recovery or identity`);
    p('claim is made for them — an unscored side is "we do not know", never "it lost nothing".');
    p();
  }

  if (!legB) {
    p('Single-leg run — no A/B verdict. Span losses against the reference are listed per segment below.');
  } else if (cmp.spanRegressions.length === 0) {
    // 🔴 The basis is part of the verdict, not a footnote to it. A green tick
    // over 4 of 5 segments and a green tick over 5 of 5 are different claims,
    // and the difference is exactly what a void hides.
    const eligible = (cmp.segments ?? []).filter((s) => s.pairScored === true).length;
    const total = (cmp.segments ?? []).length;
    p(`✅ **No span regression** across the ${eligible} of ${total} segment(s) BOTH legs scored. No segment lost a required span under **${legB.name}** that **${legA.name}** kept.`);
    if (eligible < total) p(`   ⚠️ The other ${total - eligible} segment(s) were not comparable — this tick does not cover them.`);
  } else {
    p(`🔴 **SPAN REGRESSION in ${cmp.spanRegressions.length} segment(s)** — this is the red line from RT-6's`);
    p('`language_hints_strict` card ("no code-switch case loses its non-primary-language span"):');
    p();
    for (const s of cmp.spanRegressions) {
      p(`- seg-${s.id}: lost ${JSON.stringify(s.spanRegressed)}`);
    }
  }
  const recovered = (cmp.segments ?? []).filter((s) => s.spanRecovered.length > 0);
  if (recovered.length > 0) {
    p();
    p(`ℹ️ ${recovered.length} segment(s) RECOVERED a span leg A had lost (counted separately — a gain and a`);
    p('loss are not fungible and must not net out). Only segments BOTH legs scored are eligible:');
    for (const s of recovered) p(`- seg-${s.id}: recovered ${JSON.stringify(s.spanRecovered)}`);
  }
  // P1 — the word-boundary signal, reported beside the verdict and never as one.
  const formChanges = cmp.spanFormChanges ?? [];
  if (legB && formChanges.length > 0) {
    p();
    p(`ℹ️ ${formChanges.length} segment(s) changed a span's WORD BOUNDARIES while keeping the span. Both`);
    p('primary metrics are blind to this by construction (`normalize()` deletes whitespace, so');
    p('`getUserProfile` and `get user profile` are one string) — and for a product that injects its');
    p('output into someone\'s editor, the boundary is what lands. This is a signal, NOT a verdict:');
    for (const s of formChanges) {
      if (s.spanFormLostInB.length > 0) p(`- seg-${s.id}: ${JSON.stringify(s.spanFormLostInB)} — A matched the script's spacing, B re-spaced it`);
      if (s.spanFormGainedInB.length > 0) p(`- seg-${s.id}: ${JSON.stringify(s.spanFormGainedInB)} — B matched the script's spacing, A re-spaced it`);
    }
  }
  p();

  p('## 2. Aggregate');
  p();
  p('| metric | A: ' + legA.name + (legB ? ` | B: ${legB.name}` : '') + ' |');
  p('|---|---|' + (legB ? '---|' : ''));
  const row = (label, av, bv) => p(`| ${label} | ${av} |${legB ? ` ${bv} |` : ''}`);
  // The denominator sits directly under the number it belongs to: a recall over
  // 4 of 5 segments and a recall over 5 of 5 are not the same measurement, and
  // the row that says so must not be three lines away from the row that needs it.
  const scoredOf = (agg, leg) => `${agg?.segments ?? 0} of ${(leg?.rows ?? []).length}`;
  row('micro-avg recall (NOT a verdict)', f4(cmp.aggA?.recall), f4(cmp.aggB?.recall));
  row('…computed over', scoredOf(cmp.aggA, legA), scoredOf(cmp.aggB, legB));
  row('reference points', cmp.aggA?.refPoints ?? 'n/a', cmp.aggB?.refPoints ?? 'n/a');
  row('segments with a span LOST vs reference', (cmp.aggA?.spanLossSegments.length ?? 0), (cmp.aggB?.spanLossSegments.length ?? 0));
  row('🔴 segments VOID (session never completed — NOT scored, NOT a zero)',
    (cmp.voidsA ?? []).length ? `${cmp.voidsA.length} (seg ${cmp.voidsA.join(',')})` : 0,
    (cmp.voidsB ?? []).length ? `${cmp.voidsB.length} (seg ${cmp.voidsB.join(',')})` : 0);
  row('adapter errors — threw (excluded from the aggregate)', cmp.errorsA, cmp.errorsB);
  const sumMs = (leg) => (leg?.rows ?? []).reduce((t, r) => t + (r.totalMs ?? 0), 0);
  row('total wall time (ms)', sumMs(legA), sumMs(legB));
  if (legB) {
    p();
    p(`**Byte-for-byte identical terminal text (RT-6 D1a's criterion):** ${cmp.identicalCount}/${cmp.comparable} comparable segment(s).`);
    p('This is a different question from accuracy — a leg can score higher and still fail D1a.');
  }
  p();

  p('## 3. Per segment');
  p();
  p('`shape` is P3\'s aid, not a verdict: `block` = the loss sits in one contiguous run (a segment');
  p('was dropped); `scatter` = spread thin (acoustic / mishearing). `lenRatio` is the duplication');
  p(`direction that recall is structurally blind to; > ${DUP_SUSPECT_RATIO} is flagged 🔁.`);
  p();
  const head = legB
    ? '| seg | dur s | A recall | B recall | Δ | A total ms | B total ms | A tail ms | B tail ms | ident | A span | B span | shape B | lenRatio B |'
    : '| seg | dur s | recall | total ms | tail ms | span | shape | lenRatio |';
  p(head);
  p(legB ? '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|---|---|');
  for (const s of cmp.segments) {
    // 🔴 A cell for a row that produced no measurement says VOID or ERR, never
    // `n/a` and never a number. `n/a` reads as "this column does not apply
    // here"; VOID reads as "this session died", which is the fact.
    const noneCell = (r) => (r?.void ? '**VOID**' : r?.error ? 'ERR' : 'n/a');
    const recallCell = (r) => (r?.score ? f4(r.score.recall) : noneCell(r));
    const spanCell = (r) => {
      if (!r?.score) return noneCell(r);
      const sp = r.score.span;
      if (sp.spans.length === 0) return '—';
      const respaced = sp.respaced?.length ? ` ✎respaced ${JSON.stringify(sp.respaced)}` : '';
      return (sp.ok ? `${sp.kept.length}/${sp.spans.length}` : `🔴 ${sp.kept.length}/${sp.spans.length} lost ${JSON.stringify(sp.lost)}`) + respaced;
    };
    const dupCell = (r) => {
      if (!r?.score) return noneCell(r);
      const { lenRatio, duplicationSuspect } = r.score.length;
      return `${f2(lenRatio)}${duplicationSuspect ? ' 🔁' : ''}`;
    };
    if (legB) {
      const d = s.a?.score && s.b?.score ? s.b.score.recall - s.a.score.recall : null;
      p(`| ${s.id} | ${f2(s.durationSec)} | ${recallCell(s.a)} | ${recallCell(s.b)} | ${d === null ? 'n/a' : (d >= 0 ? '+' : '') + d.toFixed(4)} | ${ms(s.a?.totalMs)} | ${ms(s.b?.totalMs)} | ${ms(s.a?.tailMs)} | ${ms(s.b?.tailMs)} | ${s.identical === null ? 'n/a' : s.identical ? 'yes' : 'NO'} | ${spanCell(s.a)} | ${spanCell(s.b)} | ${s.b?.score?.shape.shape ?? noneCell(s.b)} | ${dupCell(s.b)} |`);
    } else {
      p(`| ${s.id} | ${f2(s.durationSec)} | ${recallCell(s.a)} | ${ms(s.a?.totalMs)} | ${ms(s.a?.tailMs)} | ${spanCell(s.a)} | ${s.a?.score?.shape.shape ?? noneCell(s.a)} | ${dupCell(s.a)} |`);
    }
  }
  p();

  p('## 4. What was lost, per segment (the human read)');
  p();
  for (const s of cmp.segments) {
    const legs = legB ? [['A', s.a, legA.name], ['B', s.b, legB.name]] : [['A', s.a, legA.name]];
    const interesting = legs.filter(([, r]) => r && (r.error || r.void
      || (r.score && (r.score.missing.length > 0 || !r.score.span.ok || r.score.span.respaced?.length > 0))));
    if (interesting.length === 0) continue;
    p(`### seg-${s.id}`);
    p();
    p(`ref: ${s.reference}`);
    p();
    for (const [tag, r, name] of interesting) {
      if (r.error) { p(`- **${tag} (${name})** — ERROR (the adapter threw): ${r.error}`); continue; }
      if (r.void) {
        p(`- **${tag} (${name})** — 🔴 **VOID, NOT MEASURED**: ${r.void.why}`);
        p(`  - there is no recall for this cell and none may be inferred. What follows is the ${r.void.partialChars}-char`);
        p('    partial the dead session had produced, kept as a diagnostic only — it is NOT a hypothesis:');
        p(`  - partial: ${JSON.stringify(r.void.partialText)}`);
        continue;
      }
      p(`- **${tag} (${name})** recall ${f4(r.score.recall)} · shape ${r.score.shape.shape} (longest run ${r.score.shape.longestRun} of ${r.score.shape.missingCount} in ${r.score.shape.runs} run(s))`);
      if (!r.score.span.ok) p(`  - 🔴 lost span(s): ${JSON.stringify(r.score.span.lost)} (span source: ${r.score.span.source})`);
      if (r.score.span.respaced?.length > 0) p(`  - ✎ span(s) kept but RE-SPACED vs the script: ${JSON.stringify(r.score.span.respaced)} — both primary metrics score these as unchanged`);
      if (r.score.missing.length > 0) p(`  - missing: ${JSON.stringify(r.score.missing.slice(0, 60))}${r.score.missing.length > 60 ? ` … +${r.score.missing.length - 60} more` : ''}`);
      p(`  - hyp: ${r.text}`);
    }
    p();
  }

  if (notes?.length) {
    p('## 5. Notes recorded by the run');
    p();
    for (const n of notes) p(`- ${n}`);
    p();
  }
  return L.join('\n');
}

