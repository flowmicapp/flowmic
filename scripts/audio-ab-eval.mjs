// RT-6-a — the recognition-layer "audio A/B" eval bed.
//
// Unified ledger §4: "RT-6-a | recognition-layer audio A/B eval bed (REC-2 corpus reusable as seed)
// — the three RT-6 cards cannot be accepted until this exists".
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT IS FOR — the shape is dictated by the three RT-6 cards, not by a
// generic benchmark. (docs/strategy/2026-08-07-rt6-soniox-tradeoff-cards.md)
// ─────────────────────────────────────────────────────────────────────────────
// Each card names an acceptance criterion the existing `verify/eval/` harness
// structurally cannot answer, because its cases are already-transcribed TEXT and
// every one of these flags acts at the audio→token boundary, upstream of where
// those cases begin. This bed answers them by running the SAME audio through two
// engine configurations and diffing:
//
//   D1a (one connection per press, `{"type":"finalize"}` on rollover)
//     needs: "terminal-final text is unchanged byte-for-byte vs today's
//     multi-connection path". → the `identical` column, which is a separate
//     question from accuracy and is therefore a separate column. A leg can score
//     better and still fail D1a.
//
//   D1b (`enable_endpoint_detection`)
//     needs: "no regression on WER / no_duplication vs baseline" plus "measured
//     reduction in release → terminal final latency". → per-segment recall, the
//     `lenRatio` duplication flag (recall is blind to duplication by
//     construction — see audio-ab-score.mjs §3a), and per-segment latency split
//     into total vs TAIL, because "release → final" is the tail, not the total.
//
//   `context` (≤10,000-char recognition-layer term injection)
//     needs: "the term is right in Soniox's OWN final tokens, not just fixed
//     post-hoc by polish". → per-segment span survival on the jargon spans.
//
//   `language_hints_strict`
//     needs, in the card's own words: "pass criterion is not 'average WER
//     improves' but 'no code-switch case loses its non-primary-language span' —
//     an aggregate score could pass while silently failing every mixed-language
//     case, so the judge needs a per-case code-switch check". → span survival is
//     reported per segment and is the ONE thing that sets this bed's exit code.
//     The aggregate is not allowed to average over it.
//
// Both `context` and `language_hints_strict` say the audio they need "does not
// yet exist in the repo". It exists now, outside the repo: 5 of the 15 segments
// in the REC-2 corpus carry embedded English product jargon. That is why this
// bed derives spans from the reference script instead of asking for a second
// hand-authored list (audio-ab-score.mjs `deriveSpans`).
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THREE HARD RULES, ENFORCED BY MECHANISM RATHER THAN BY MEMORY
// ─────────────────────────────────────────────────────────────────────────────
// 0. A SESSION THAT DID NOT COMPLETE IS NOT A RESULT. This is rule zero because
//    it was learned the expensive way: a Soniox session that died on a 408 was
//    scored as speech (recall 0.0000), written up as a catastrophic product
//    finding, and reached a ledger row and two commits before a clean re-run of
//    the same cell returned 0.9682 — byte-identical to the control leg. A
//    measurement harness that reports an infrastructure failure as a subject
//    result is worse than no harness, because its output looks exactly like
//    data. `runLeg` therefore VOIDS any row whose adapter did not affirmatively
//    declare `completed`, and a void row has no `text` and no `score` at all —
//    it is not filtered out later, it never becomes a number in the first place.
// 1. CORPUS BYTES NEVER ENTER THE REPO. This bed READS wavs and never copies
//    them. `assertOutsideGit()` below runs `git check-ignore` on both the corpus
//    path and the report path and refuses to proceed on anything git would
//    track. A comment saying "remember not to commit the audio" is the kind of
//    instruction this repo has watched fail; a refusal is not.
// 2. NO PASS THRESHOLD ON RECALL. P2 measured legitimate polish at 0.9513 and a
//    real 10% content loss at 0.9218. Any constant between them is wrong in one
//    of the two directions. The bed prints per-segment numbers plus the `missing`
//    list and the P3 block-vs-scatter shape; a human reads them. The only
//    mechanical verdict is span loss.
//
// ─────────────────────────────────────────────────────────────────────────────
// ADAPTER CONTRACT — what an "engine leg" is
// ─────────────────────────────────────────────────────────────────────────────
//   {
//     name: string,
//     describe(): string,                       // what config this leg IS, for the report header
//     assembler: { kind, note },                // 🔴 REQUIRED. Who built the string in `text`?
//                                               //   'product'   — the shipping pipeline produced it
//                                               //   'bed-local' — this bed assembled it; it is NOT
//                                               //                 what a user would see, and the
//                                               //                 report says so above every number
//                                               //   'synthetic' — no engine involved at all
//     probe(): Promise<{ready, reason}>,        // MUST NOT download, install, or spend money
//     transcribe(pcm, seg): Promise<{
//       text: string,
//       completed: boolean,   // 🔴 REQUIRED. Did the session reach its clean terminal
//                             // condition? Anything else — a server error frame, a timeout,
//                             // a socket error, a close, a truncation that still produced 75
//                             // tokens — is `false`, and the bed VOIDS the row rather than
//                             // scoring it. OMITTING THIS FIELD ALSO VOIDS THE ROW: see
//                             // runLeg for why the unsafe default is the silent one.
//       incompleteWhy?: string, // required in spirit when completed:false — one line, printed
//       tailMs?: number,      // last audio byte pushed → final text resolved.
//       meta?: object,        // free-form, lands in the JSON report
//     }>,
//   }
//
// The bed times `transcribe` itself and reports that as `totalMs`. `tailMs` is
// the adapter's own, and when an adapter does not report it the bed prints
// `n/a` rather than substituting `totalMs` — those are different quantities
// (a streaming engine overlaps recognition with upload, a batch engine does not),
// and silently conflating them would fabricate exactly the latency number D1b
// exists to measure.
//
// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────
//   node scripts/audio-ab-eval.mjs --a=<adapter> --b=<adapter> [options]
//
//   --a=SPEC --b=SPEC     engine legs. SPEC is `name` or `name:json-config`,
//                         e.g. `soniox:{"enable_endpoint_detection":true}`.
//                         `--b` may be omitted for a single-leg baseline run.
//   --corpus=DIR          default .local/audio-corpus (never inside the repo tree)
//   --out=FILE            report path; default .local/rt6-audio-ab/<stamp>-<a>-vs-<b>.md
//                         (a sibling .json is always written next to it)
//   --segments=1,3,7      subset, by manifest key
//   --list                print available adapters + their probe result, exit 0
//   --dry-run             resolve everything, probe, print the plan, transcribe nothing
//
// EXIT CODES: 0 = ran clean; 1 = operational failure OR a span regression in
// leg B relative to leg A; 2 = nothing was measured (every probe refused, or a
// leg scored zero segments), which is a SKIP and deliberately not a pass;
// 3 = ran, but at least one cell is MISSING — a void session or a leg that did
// not declare where its text came from. 3 is separate from 1 because "the flag
// lost a span" and "we never measured the flag" call for opposite next actions.
//
// Node 22 ESM, builtins only.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scoreOne, aggregate } from './audio-ab-score.mjs';
import { renderReport } from './audio-ab-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
export const DEFAULT_CORPUS = join(REPO_ROOT, '.local', 'audio-corpus');
export const DEFAULT_OUT_DIR = join(REPO_ROOT, '.local', 'rt6-audio-ab');

// ---------------------------------------------------------------------------
// Guard: nothing this bed touches may be a path git would track
// ---------------------------------------------------------------------------

/**
 * Refuse any path inside the working tree that git does NOT ignore.
 *
 * The audio corpus is owner speech and the reports quote it verbatim; both are
 * `.local/` material. This is checked by asking git, not by matching on the
 * string ".local", because the question being asked is literally "would this get
 * committed?" and only git can answer it. Paths entirely outside the repo are
 * fine and skip the git call.
 *
 * @param {string} p
 * @param {string} what human label for the error
 * @param {(cmd:string,args:string[],opts:object)=>{status:number|null}} [run] injectable for the drill
 */
export function assertOutsideGit(p, what, run = spawnSync) {
  const abs = isAbsolute(p) ? p : resolve(p);
  const rel = relative(REPO_ROOT, abs);
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  if (!inside) return { ok: true, reason: 'outside the repo working tree' };
  const r = run('git', ['check-ignore', '-q', abs], { cwd: REPO_ROOT, stdio: 'ignore' });
  if (r.status === 0) return { ok: true, reason: 'inside the repo but gitignored' };
  throw new Error(
    `${what} resolves to ${abs}, which is inside the repo and NOT gitignored.\n` +
    `  Corpus audio and A/B reports quote owner speech verbatim and must never be committable.\n` +
    `  Put it under .local/ or anywhere outside ${REPO_ROOT}.`,
  );
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/**
 * Read the REC-2 manifest into an ordered array.
 *
 * `manifest.segments` is an OBJECT keyed "1".."15", not an array — keys are
 * preserved as `id` so `--segments=11,14` addresses exactly what the manifest
 * calls 11 and 14, and so a report can be cross-read against the manifest
 * without an off-by-one.
 *
 * @param {string} corpusDir
 */
export function loadCorpus(corpusDir) {
  const manifestPath = join(corpusDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    const hint = existsSync(corpusDir)
      ? `  directory exists; it holds: ${readdirSync(corpusDir).slice(0, 8).join(', ') || '(empty)'}`
      : '  the directory does not exist';
    throw new Error(`no manifest.json in ${corpusDir}\n${hint}`);
  }
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const segs = raw?.segments;
  if (!segs || typeof segs !== 'object') throw new Error(`${manifestPath}: no \`segments\` object`);
  const out = [];
  for (const [id, s] of Object.entries(segs)) {
    if (!s?.file || typeof s.script !== 'string') {
      throw new Error(`${manifestPath}: segment ${id} lacks \`file\` or \`script\``);
    }
    out.push({
      id,
      file: s.file,
      path: join(corpusDir, s.file),
      reference: s.script,
      durationSec: typeof s.duration_sec === 'number' ? s.duration_sec : null,
      sampleRate: typeof s.sample_rate === 'number' ? s.sample_rate : null,
      // Not present in the v1 manifest; honoured if a later one adds it, so the
      // span check can be authored rather than derived when that matters.
      declaredSpans: Array.isArray(s.required_spans) ? s.required_spans : null,
    });
  }
  out.sort((a, b) => Number(a.id) - Number(b.id));
  return { version: raw.version ?? null, dir: corpusDir, segments: out };
}

/**
 * Extract the `data` chunk of a RIFF/WAVE file as raw PCM, plus the format the
 * header claims.
 *
 * The format is READ AND RETURNED rather than assumed. An engine fed 44.1 kHz
 * while being told it is 16 kHz produces a plausible-looking wrong transcript,
 * and that is precisely the failure this bed would then attribute to the engine
 * under test.
 *
 * @param {string} path
 */
export function readWavPcm(path) {
  const buf = readFileSync(path);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }
  let off = 12;
  let fmt = null;
  let pcm = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      pcm = buf.subarray(body, Math.min(body + size, buf.length));
    }
    off = body + size + (size & 1);
  }
  if (!fmt) throw new Error(`${path}: no fmt chunk`);
  if (!pcm) throw new Error(`${path}: no data chunk`);
  return { pcm, fmt, durationSec: pcm.length / (fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8)) };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Run one leg over the whole corpus.
 *
 * An adapter throwing on one segment does NOT abort the run and does NOT get
 * scored as an empty transcript — it is recorded as `error` and excluded from
 * the aggregate. Scoring a crash as 0.0 recall would blend "the engine is worse"
 * into "the engine is broken", and those are two different findings with two
 * opposite next actions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 VOID ROWS — the same rule, for the failure that does not throw
 * ─────────────────────────────────────────────────────────────────────────────
 * The paragraph above was true and insufficient. A soniox session that died —
 * TLS handshake refused, a 408 frame, the 120 s timeout — resolved its promise
 * NORMALLY with `text: ''`, so nothing threw, `error` stayed null, and the bed
 * scored a dead session as speech. Measured, three times, on this machine
 * (【measured·dev-pc-b】 2026-08-10):
 *
 *   · recall 0.0000 on a 408 → written up as a catastrophic product finding,
 *     reached a ledger row and two commits, retracted the next day. A clean
 *     re-run of the same cell: 0.9682, byte-identical to the control leg.
 *   · recall 0.0000 on a TLS failure → the verdict block printed
 *     "seg-11: recovered 7 spans", i.e. a network fault was reported as the
 *     flag's biggest WIN of the run, and leg A's aggregate moved 0.9840 → 0.8010
 *     while the "adapter errors (excluded from the aggregate)" counter said 0.
 *   · recall 0.6201 on a 120 s timeout that had already produced 75 final
 *     tokens — the shape a `finalTokens === 0` guard would have let through.
 *
 * ⇒ A row is VOID when the adapter did not affirmatively declare `completed`.
 * A void row gets `text: null` and `score: null` and never touches `scoreOne`,
 * so it is not "excluded by a later filter someone can forget" — there is no
 * number for anything downstream to pick up.
 *
 * 🔴 WHY ABSENCE OF THE DECLARATION IS VOID RATHER THAN ASSUMED-COMPLETE.
 * Both defaults are wrong for somebody; the question is what each one does when
 * it is wrong. Absence-means-complete fails by SCORING A DEAD SESSION AND SAYING
 * NOTHING — the exact defect being repaired, re-introducible by any future
 * adapter that simply forgets. Absence-means-void fails by voiding a perfectly
 * good leg and printing "adapter did not declare completion" against every
 * segment, with a non-zero exit. One failure mode is a number nobody can tell
 * from data; the other is a refusal nobody can miss.
 *
 * 🔴 WHY VOID EXCLUDES RATHER THAN ABORTS THE RUN. Four reasons, and the first
 * is the strongest:
 *  1. This module already answers the question "what happens when a leg fails to
 *     answer for one segment?" — a throw is recorded and excluded. A void is the
 *     SAME finding arriving through a different door. Making it abort would give
 *     one question two answers, which is this repo's most-repeated bug shape.
 *  2. The distribution is the diagnosis. 1 void in 15 is a flake; 15 in 15 is a
 *     dead key or a blocked route; a void that follows the same segment across
 *     legs is a corpus problem. Aborting on the first one destroys exactly the
 *     evidence that tells those three apart.
 *  3. The surviving segments cost real money and real minutes against a vendor.
 *     Discarding 14 good measurements because the 15th never connected is the
 *     `safeFileName` lesson again — the measurement was done and the evidence
 *     was thrown away at the last step.
 *  4. Aborting was never what was missing. The harm was that a void BECAME A
 *     NUMBER. Removing the number removes the harm; aborting adds nothing to it.
 * ⇒ So: excluded from the aggregate, printed distinctly in §1/§2/§3/§4, and the
 *   process exits 3. It is not allowed to be quiet, and it is not allowed to be
 *   a recall.
 *
 * @param {object} adapter
 * @param {ReturnType<typeof loadCorpus>['segments']} segments
 * @param {(msg:string)=>void} log
 */
export async function runLeg(adapter, segments, log = () => {}) {
  const rows = [];
  for (const seg of segments) {
    const { pcm, fmt } = readWavPcm(seg.path);
    const t0 = Date.now();
    try {
      const r = await adapter.transcribe(pcm, { ...seg, fmt });
      const totalMs = Date.now() - t0;
      const text = typeof r?.text === 'string' ? r.text : '';
      if (r?.completed !== true) {
        const why = typeof r?.incompleteWhy === 'string' && r.incompleteWhy.length > 0
          ? r.incompleteWhy
          : (r?.completed === false
            ? 'the adapter reported completed:false without saying why'
            : `the adapter did not declare \`completed\` — see the contract in this file's header. ` +
              'An undeclared session is VOID on purpose: the alternative default silently scores dead sessions.');
        rows.push({
          id: seg.id,
          text: null,
          totalMs,
          tailMs: null,
          meta: r?.meta ?? null,
          error: null,
          // The partial text is KEPT — it is the diagnostic — but it is kept
          // under a name no scorer reads, and `text` above is null so every
          // `?.text != null` guard downstream (D1a's identity column included)
          // already treats this row as non-comparable.
          void: { why, partialText: text, partialChars: text.length },
          score: null,
        });
        log(`  ${adapter.name} seg-${seg.id}: VOID (${why})`);
        continue;
      }
      rows.push({
        id: seg.id,
        text,
        totalMs,
        tailMs: typeof r?.tailMs === 'number' ? r.tailMs : null,
        meta: r?.meta ?? null,
        error: null,
        void: null,
        score: scoreOne(seg.reference, text, seg.declaredSpans),
      });
      log(`  ${adapter.name} seg-${seg.id}: ${totalMs}ms recall=${rows[rows.length - 1].score.recall.toFixed(4)}`);
    } catch (e) {
      rows.push({
        id: seg.id,
        text: null,
        totalMs: Date.now() - t0,
        tailMs: null,
        meta: null,
        error: e instanceof Error ? e.message : String(e),
        void: null,
        score: null,
      });
      log(`  ${adapter.name} seg-${seg.id}: ERROR ${e?.message ?? e}`);
    }
  }
  return {
    name: adapter.name,
    describe: adapter.describe?.() ?? adapter.name,
    // P2: provenance of the STRING in `text`. Carried on the leg (and therefore
    // into the JSON report) rather than written into the renderer, so the
    // disclosure cannot drift from the adapter that earned it.
    assembler: adapter.assembler ?? null,
    rows,
  };
}

/**
 * Pair two legs (or report a single leg) and compute the comparison.
 *
 * @param {ReturnType<typeof loadCorpus>} corpus
 * @param {Awaited<ReturnType<typeof runLeg>>} legA
 * @param {Awaited<ReturnType<typeof runLeg>>|null} legB
 */
export function compare(corpus, legA, legB) {
  const byId = (leg) => new Map((leg?.rows ?? []).map((r) => [r.id, r]));
  const A = byId(legA);
  const B = byId(legB);
  const segments = [];
  for (const seg of corpus.segments) {
    const a = A.get(seg.id) ?? null;
    const b = B.get(seg.id) ?? null;
    /**
     * D1a's criterion is IDENTITY, not accuracy — compared on the raw strings,
     * not the normalised ones, because "byte-for-byte" is what the card says and
     * normalising first would hide exactly the punctuation drift a rollover
     * change could introduce.
     */
    const identical = a?.text != null && b?.text != null ? a.text === b.text : null;
    /**
     * A span kept by A and lost by B is the one mechanical regression this bed
     * reports. The reverse (B keeps what A lost) is an improvement and is
     * counted separately — reporting only the net would let one of each cancel
     * out, and they are not fungible.
     *
     * 🔴 BOTH SIDES MUST BE SCORABLE. This used to read `a?.score?.span.lost ??
     * []`, and that `?? []` is a second half of the P0 defect in its own right:
     * an unscored row has no `lost` list, the coalesce turned "we do not know"
     * into "it lost nothing", and a leg whose TLS handshake never completed was
     * therefore credited with RECOVERING all seven spans the other leg had lost
     * — printed in the verdict block as the flag's biggest win of that run
     * (【measured·dev-pc-b】 2026-08-10, wave4-L-ctx-rep2). A pair where one
     * side never answered is NOT COMPARABLE, and saying so is the only honest
     * output. `pairScored` records it so the report can say which.
     */
    const pairScored = Boolean(a?.score && b?.score);
    const aLost = new Set(a?.score?.span.lost ?? []);
    const bLost = new Set(b?.score?.span.lost ?? []);
    const regressed = pairScored ? [...bLost].filter((s) => !aLost.has(s)) : [];
    const recovered = pairScored ? [...aLost].filter((s) => !bLost.has(s)) : [];
    /**
     * P1: the word-boundary signal the primary metrics are blind to. Same
     * pairing rule, and deliberately NOT a verdict — a span that moved its
     * spaces is still a span that survived, and this bed does not convert
     * signals into thresholds (see audio-ab-score.mjs §2).
     */
    const aExact = new Set(a?.score?.span.exact ?? []);
    const bExact = new Set(b?.score?.span.exact ?? []);
    const formFused = pairScored ? [...aExact].filter((s) => !bExact.has(s) && !bLost.has(s)) : [];
    const formFixed = pairScored ? [...bExact].filter((s) => !aExact.has(s) && !aLost.has(s)) : [];
    segments.push({
      id: seg.id,
      reference: seg.reference,
      durationSec: seg.durationSec,
      a,
      b,
      identical,
      pairScored: legB ? pairScored : null,
      spanRegressed: legB ? regressed : [],
      spanRecovered: legB ? recovered : [],
      // A kept the script's own word boundaries, B did not (and vice versa).
      spanFormLostInB: legB ? formFused : [],
      spanFormGainedInB: legB ? formFixed : [],
    });
  }
  const okRows = (leg) => (leg?.rows ?? []).filter((r) => r.score).map((r) => r.score);
  const aggA = legA ? aggregate(okRows(legA)) : null;
  const aggB = legB ? aggregate(okRows(legB)) : null;
  const spanRegressions = segments.filter((s) => s.spanRegressed.length > 0);
  const identicalCount = segments.filter((s) => s.identical === true).length;
  const comparable = segments.filter((s) => s.identical !== null).length;
  const voidIds = (leg) => (leg?.rows ?? []).filter((r) => r.void).map((r) => r.id);
  const undeclared = [legA, legB].filter(Boolean).filter((l) => !l.assembler).map((l) => l.name);
  return {
    segments,
    aggA,
    aggB,
    spanRegressions,
    identicalCount,
    comparable,
    errorsA: (legA?.rows ?? []).filter((r) => r.error).length,
    errorsB: (legB?.rows ?? []).filter((r) => r.error).length,
    // 🔴 Never folded into `errorsA/B`. A throw and a void have the same
    // consequence (not scored) and different causes (our code broke / the
    // session never completed), and the operator's next action differs.
    voidsA: voidIds(legA),
    voidsB: voidIds(legB),
    // P2: a leg that did not say where its text came from. Reported, not fatal —
    // see renderReport on why this does not throw away a finished run.
    undeclaredAssembler: undeclared,
    spanFormChanges: segments.filter((s) => s.spanFormLostInB.length > 0 || s.spanFormGainedInB.length > 0),
  };
}

// ---------------------------------------------------------------------------
// Report — MOVED to ./audio-ab-report.mjs
// ---------------------------------------------------------------------------
//
// `renderReport` and its three formatters were lifted VERBATIM into
// scripts/audio-ab-report.mjs when this file crossed the repo's 800-line cap.
// A structural split, not a deletion: not one line of the reasoning recorded in
// those comments was dropped. The seam is "what happened" (here) versus "how it
// is said to a human" (there).
//
// Re-exported below so that `import { renderReport } from './audio-ab-eval.mjs'`
// keeps working for callers that already had it — a re-export is ONE definition
// under two names, which is not the same thing as a second answer.
//
// 🔴 IT IS IMPORTED AT THE TOP OF THIS FILE AS WELL, AND THAT IS NOT REDUNDANT.
// The first attempt used only `export { renderReport } from …`, which re-exports
// the binding WITHOUT introducing it into this module's scope. Every drill
// assertion stayed green — the drill imports `renderReport` from this file, and
// the re-export serves importers perfectly — while `main()` died with
// `ReferenceError: renderReport is not defined` on the first real CLI run
// (【measured·dev-pc-b】 2026-08-10, after both legs had already transcribed).
// A textbook instance of this bed's own lesson: the test drove a different path
// from the product, so the product's path was unmeasured and broken.

export { renderReport };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Reduce a leg-derived label to something every filesystem accepts.
 *
 * 🔴 This exists because of a measured failure, not a hypothetical one. A leg
 * configured with Soniox's `context` field produced a name carrying `"`, `：`
 * and CJK; both legs transcribed 26 seconds of real audio correctly and the run
 * then died on `writeFileSync` with ENOENT — the measurement was done and the
 * evidence was thrown away at the last step. Sanitising here rather than at the
 * label source keeps the descriptive name in the report header, where it is
 * useful, and out of the path, where it is fatal.
 */
export function safeFileName(s) {
  return String(s)
    .replace(/[^A-Za-z0-9._=-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

export function parseArgs(argv) {
  const out = { a: null, b: null, corpus: null, outPath: null, segments: null, list: false, dryRun: false };
  for (const raw of argv) {
    const [k, ...rest] = raw.split('=');
    const v = rest.join('=');
    switch (k) {
      case '--a': out.a = v; break;
      case '--b': out.b = v; break;
      case '--corpus': out.corpus = v; break;
      case '--out': out.outPath = v; break;
      case '--segments': out.segments = v.split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--list': out.list = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--help': case '-h': out.help = true; break;
      default: throw new Error(`unknown argument ${JSON.stringify(raw)}`);
    }
  }
  return out;
}

const USAGE = `RT-6-a recognition-layer audio A/B bed

  node scripts/audio-ab-eval.mjs --a=<spec> [--b=<spec>] [options]

  --a=SPEC --b=SPEC   engine leg; SPEC = name | name:{"json":"config"}
  --corpus=DIR        default .local/audio-corpus
  --out=FILE          default .local/rt6-audio-ab/<stamp>-<a>-vs-<b>.md (+ .json)
  --segments=1,11,14  subset by manifest key
  --list              list adapters and probe them, then exit
  --dry-run           probe and print the plan; transcribe nothing

Exit: 0 ran clean · 1 operational failure or span regression in B vs A · 2 nothing measured
      · 3 ran, but a cell is missing (a VOID session, or a leg with undeclared text provenance).`;

async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(`✗ ${e.message}\n\n${USAGE}`); process.exit(1); }
  if (args.help) { console.log(USAGE); process.exit(0); }

  const { ADAPTERS, buildAdapter } = await import('./audio-ab-adapters.mjs');

  if (args.list) {
    console.log('adapters:');
    for (const name of Object.keys(ADAPTERS)) {
      let verdict;
      try {
        const ad = buildAdapter(name);
        const pr = await ad.probe();
        verdict = pr.ready ? `READY — ${ad.describe()}` : `NOT READY — ${pr.reason}`;
      } catch (e) { verdict = `NOT READY — ${e.message}`; }
      console.log(`  ${name.padEnd(14)} ${verdict}`);
    }
    process.exit(0);
  }

  if (!args.a) { console.error(`✗ --a is required\n\n${USAGE}`); process.exit(1); }

  const corpusDir = resolve(args.corpus ?? DEFAULT_CORPUS);
  const startedAt = new Date().toISOString();
  const machine = process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown-machine';
  const notes = [];

  try {
    assertOutsideGit(corpusDir, 'corpus directory');
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }

  let corpus;
  try { corpus = loadCorpus(corpusDir); } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
  if (args.segments) {
    const want = new Set(args.segments);
    corpus = { ...corpus, segments: corpus.segments.filter((s) => want.has(s.id)) };
    if (corpus.segments.length === 0) { console.error(`✗ --segments matched nothing (manifest keys: ${args.segments.join(',')})`); process.exit(1); }
  }

  let adapterA; let adapterB = null;
  try {
    adapterA = buildAdapter(args.a);
    if (args.b) adapterB = buildAdapter(args.b);
  } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }

  const probes = [];
  for (const ad of [adapterA, adapterB].filter(Boolean)) {
    const pr = await ad.probe();
    probes.push({ name: ad.name, ...pr });
    console.log(`${pr.ready ? '✓' : '✗'} ${ad.name}: ${pr.ready ? ad.describe() : pr.reason}`);
  }
  const notReady = probes.filter((p) => !p.ready);
  if (notReady.length === probes.length) {
    // Every leg refused. That is a SKIP: nothing was measured, and reporting it
    // with the same exit code as a clean run would be the "empty pass" shape
    // scripts/run-script-tests.mjs guards against one level up.
    console.log(`SKIP: no engine leg is runnable here — ${notReady.map((p) => `${p.name}: ${p.reason}`).join(' | ')}`);
    process.exit(2);
  }
  if (notReady.length > 0) {
    console.error(`✗ leg ${notReady.map((p) => p.name).join(', ')} not runnable: ${notReady.map((p) => p.reason).join(' | ')}`);
    console.error('  A one-legged A/B is not an A/B. Fix the leg or run it alone with --a only.');
    process.exit(1);
  }

  const stamp = startedAt.replace(/[:.]/g, '-');
  const outPath = resolve(args.outPath ?? join(DEFAULT_OUT_DIR, `${safeFileName(`${stamp}-${adapterA.name}${adapterB ? `-vs-${adapterB.name}` : ''}`)}.md`));
  try { assertOutsideGit(outPath, 'report path'); } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }

  if (args.dryRun) {
    console.log(`\nDRY RUN — would transcribe ${corpus.segments.length} segment(s) per leg and write:`);
    console.log(`  ${outPath}`);
    console.log(`  ${outPath.replace(/\.md$/, '')}.json`);
    process.exit(0);
  }

  console.log(`\nrunning ${corpus.segments.length} segment(s) × ${adapterB ? 2 : 1} leg(s)…`);
  const legA = await runLeg(adapterA, corpus.segments, (m) => console.log(m));
  const legB = adapterB ? await runLeg(adapterB, corpus.segments, (m) => console.log(m)) : null;
  const cmp = compare(corpus, legA, legB);

  const md = renderReport({ corpus, legA, legB, cmp, startedAt, machine, notes });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md, 'utf8');
  const jsonPath = `${outPath.replace(/\.md$/, '')}.json`;
  writeFileSync(jsonPath, JSON.stringify({ startedAt, machine, corpus: { dir: corpus.dir, version: corpus.version }, legA, legB, cmp }, null, 2), 'utf8');

  console.log(`\nreport: ${outPath}`);
  console.log(`json  : ${jsonPath}`);
  const scoredA = cmp.aggA?.segments ?? 0;
  const scoredB = cmp.aggB?.segments ?? 0;
  // Same rule as the report's cells: a leg that scored nothing prints n/a, never
  // a number. `aggregate()` returns null for that case and this is where the CLI
  // one-liner — the thing an operator actually reads — has to honour it.
  const r4 = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(4) : 'n/a');
  console.log(`A micro-avg recall ${r4(cmp.aggA?.recall)} over ${scoredA}/${legA.rows.length}${legB ? ` · B ${r4(cmp.aggB?.recall)} over ${scoredB}/${legB.rows.length}` : ''}`);
  if (legB) console.log(`byte-identical terminal text: ${cmp.identicalCount}/${cmp.comparable}`);

  const voids = [...cmp.voidsA, ...cmp.voidsB];
  if (voids.length > 0) {
    console.error(`\n🔴 ${voids.length} VOID row(s) — a session that never completed, excluded from every number above:`);
    console.error(`   A: ${cmp.voidsA.length ? `seg ${cmp.voidsA.join(',')}` : 'none'}${legB ? ` · B: ${cmp.voidsB.length ? `seg ${cmp.voidsB.join(',')}` : 'none'}` : ''}`);
    console.error('   These are NOT zeros. Re-run the affected segments before quoting anything from this run.');
  }
  if (cmp.undeclaredAssembler.length > 0) {
    console.error(`\n🔴 leg(s) ${cmp.undeclaredAssembler.join(', ')} did not declare an \`assembler\` — the text in this report is of unknown provenance.`);
  }

  /**
   * EXIT PRECEDENCE, and why in this order.
   *  2 — a leg scored NOTHING. There is no measurement, and a bed that measured
   *      nothing must not exit 0. This outranks everything: with zero scored
   *      pairs no verdict below it could have been computed anyway.
   *  1 — span regression. The documented red line from RT-6's
   *      `language_hints_strict` card. It keeps its code even when voids are
   *      also present: with the pairing fix, a regression is only ever computed
   *      on segments BOTH legs scored, so the finding is sound on its own terms
   *      and downgrading it because something else also went wrong would bury
   *      the one hard verdict this bed has.
   *  3 — ran, but at least one cell is missing (void / undeclared provenance).
   *      Distinct from 1 on purpose: "the flag lost a span" and "we did not
   *      measure the flag" call for opposite next actions, and a single non-zero
   *      code would make an operator guess which one happened.
   */
  if (scoredA === 0 || (legB && scoredB === 0)) {
    console.error('\nSKIP: a leg scored 0 segments — nothing was measured. That is not a pass.');
    process.exit(2);
  }
  if (cmp.spanRegressions.length > 0) {
    console.error(`\n🔴 SPAN REGRESSION in ${cmp.spanRegressions.length} segment(s) — see §1 of the report.`);
    process.exit(1);
  }
  if (voids.length > 0 || cmp.undeclaredAssembler.length > 0) process.exit(3);
  process.exit(0);
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).catch((e) => { console.error(`✗ ${e?.stack ?? e}`); process.exit(1); });
}
