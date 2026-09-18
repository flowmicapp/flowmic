// Drill for scripts/protocol-dist-stamp.mjs — the content proof that lets the
// release gate skip rebuilding packages/protocol/dist.
//
// WHAT IS AT STAKE. The gate's `--dist-ready` stands entirely on this judgment.
// If it can be talked into "ok" by a dist that is NOT the build of the source
// on disk, the release gate type-checks, tests and goldens a stale contract and
// says so in a receipt — the 2026-08-07 false-green ("a stale dist makes the
// type check pass against an expired contract"), with a receipt attached.
//
// So every branch below is driven for real: the fingerprint is computed over
// real files in a temporary tree, and each refusal is produced by actually
// putting the tree into that state rather than by handing the judge a shape.
//
// SAFETY: nothing here touches the real `packages/protocol`, the real
// `.local/protocol-dist.stamp`, or any gate. Every path is a mkdtemp.
//
// EXIT: 0 = PASS, 1 = FAIL. Never skips.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONFIG_INPUTS,
  DIST_DIR,
  PKG_DIR,
  STAMP_PATH,
  checkStamp,
  distShape,
  fingerprintInputs,
  judgeStamp,
  readStamp,
  writeStamp,
} from './protocol-dist-stamp.mjs';

let failures = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
const check = (cond, label) => {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}`); failures += 1; }
};

/** A throwaway tree shaped like the real one: two source files, the three
 *  config inputs, and a dist with two files in it. */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'protocol-stamp-'));
  mkdirSync(join(root, PKG_DIR, 'src', 'nested'), { recursive: true });
  mkdirSync(join(root, DIST_DIR), { recursive: true });
  writeFileSync(join(root, PKG_DIR, 'src', 'index.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, PKG_DIR, 'src', 'nested', 'b.ts'), 'export const b = 2;\n');
  for (const rel of CONFIG_INPUTS) writeFileSync(join(root, rel), '{}\n');
  writeFileSync(join(root, DIST_DIR, 'index.js'), 'built\n');
  writeFileSync(join(root, DIST_DIR, 'index.d.ts'), 'declared\n');
  return root;
}

const trees = [];
const tree = () => { const t = makeTree(); trees.push(t); return t; };

try {
  // ── §1 the fingerprint answers "is this the same SOURCE", by content ──────
  section('§1 the fingerprint moves when an input moves, and only then');
  {
    const root = tree();
    const base = fingerprintInputs(root).hash;
    check(fingerprintInputs(root).hash === base, 'reading twice with nothing changed gives the same hash (it is a content hash, not a clock)');

    writeFileSync(join(root, DIST_DIR, 'index.js'), 'built differently\n');
    check(fingerprintInputs(root).hash === base, 'rewriting the OUTPUT does not move it — dist is not an input');

    writeFileSync(join(root, PKG_DIR, 'src', 'nested', 'b.ts'), 'export const b = 3;\n');
    const afterSrc = fingerprintInputs(root).hash;
    check(afterSrc !== base, 'changing one byte of one source file moves it');

    writeFileSync(join(root, PKG_DIR, 'tsup.config.ts'), '{"entry":["src/index.ts"]}\n');
    check(fingerprintInputs(root).hash !== afterSrc, 'changing the tsup config moves it (the config decides what dist contains)');

    // 🔴 The case a "hash every file" implementation gets wrong: a DELETED
    // source file leaves every surviving file byte-identical.
    const root2 = tree();
    const before = fingerprintInputs(root2).hash;
    rmSync(join(root2, PKG_DIR, 'src', 'nested', 'b.ts'));
    check(fingerprintInputs(root2).hash !== before, 'DELETING a source file moves it, even though no surviving file changed');
  }

  // ── §2 the round trip: build, stamp, check ───────────────────────────────
  section('§2 a stamped tree passes, and the pass names its evidence');
  {
    const root = tree();
    const written = writeStamp(root);
    check(readStamp(root)?.fingerprint === written.fingerprint, 'the stamp is on disk and readable at ' + STAMP_PATH);
    const r = checkStamp(root);
    check(r.ok === true, `a freshly stamped tree checks ok (${r.reason})`);
    check(/fingerprint [0-9a-f]{12}/.test(r.reason), '  ...and the reason names the fingerprint it matched, not just "ok"');
  }

  // ── §3 every refusal, produced by putting the tree in that state ──────────
  section('§3 four refusals, four different sentences, all fail closed');
  {
    const noStamp = tree();
    const r0 = checkStamp(noStamp);
    check(r0.ok === false && /no stamp/.test(r0.reason), 'no stamp at all → refused, and told to run verify:protocol-dist');

    const moved = tree();
    writeStamp(moved);
    writeFileSync(join(moved, PKG_DIR, 'src', 'index.ts'), 'export const a = 99;\n');
    const r1 = checkStamp(moved);
    check(r1.ok === false && /build of a DIFFERENT source/.test(r1.reason), 'source edited after the stamp → refused (the whole point: dist is the build of something else)');

    const gone = tree();
    writeStamp(gone);
    rmSync(join(gone, DIST_DIR), { recursive: true, force: true });
    const r2 = checkStamp(gone);
    check(r2.ok === false && /not on disk at all/.test(r2.reason), 'stamp matches but dist was deleted → refused (a stamp is not a substitute for the bytes)');

    const shrunk = tree();
    writeStamp(shrunk);
    rmSync(join(shrunk, DIST_DIR, 'index.d.ts'));
    const r3 = checkStamp(shrunk);
    check(r3.ok === false && /smaller than when it was stamped/.test(r3.reason), 'dist partially deleted after the stamp → refused');

    const garbled = tree();
    writeStamp(garbled);
    writeFileSync(join(garbled, STAMP_PATH), '{"stamp_version":99}\n');
    const r4 = checkStamp(garbled);
    check(r4.ok === false && /not a shape this version understands/.test(r4.reason), 'an unrecognised stamp shape is treated as absent, not guessed at');

    // REVERSE CONTROL for the whole section: the same judge, same inputs, with
    // nothing wrong — otherwise every assertion above would also pass against a
    // judge that refuses everything.
    const fine = tree();
    writeStamp(fine);
    check(checkStamp(fine).ok === true, 'REVERSE CONTROL: with nothing broken, the same judge says ok (it is not refusing on principle)');
  }

  // ── §4 the judge never invents a state it was not given ──────────────────
  section('§4 judgeStamp is pure over facts it is handed');
  {
    const inputs = { hash: 'a'.repeat(64), fileCount: 3 };
    const dist = { present: true, fileCount: 2, bytes: 10 };
    const ok = judgeStamp({ stamp: { stamp_version: 1, fingerprint: inputs.hash, dist, writtenAt: 'T', by: 'x' }, inputs, dist });
    check(ok.ok === true, 'matching fingerprint + intact dist ⇒ ok');
    const bigger = judgeStamp({
      stamp: { stamp_version: 1, fingerprint: inputs.hash, dist, writtenAt: 'T', by: 'x' },
      inputs,
      dist: { present: true, fileCount: 3, bytes: 99 },
    });
    check(bigger.ok === true, 'a dist that GREW since the stamp is still ok — sourcemaps/extra artifacts are not evidence of a stale build');
  }

  // ── §5 the shape reading is real, not assumed ────────────────────────────
  section('§5 distShape counts what is there');
  {
    const root = tree();
    const s = distShape(root);
    check(s.present === true && s.fileCount === 2 && s.bytes > 0, `dist read as ${s.fileCount} files / ${s.bytes} B`);
    const empty = mkdtempSync(join(tmpdir(), 'protocol-stamp-empty-'));
    trees.push(empty);
    check(distShape(empty).present === false, 'an absent dist reads as absent rather than as zero files');
  }
} finally {
  for (const t of trees) { try { rmSync(t, { recursive: true, force: true }); } catch { /* temp */ } }
}

console.log(failures === 0 ? '\nOK — the dist proof is a content proof, and every way of being wrong refuses' : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
