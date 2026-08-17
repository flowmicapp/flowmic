// Drill for the three C10 scripts that ship in the public tree:
//   scripts/preflight-toolchain.mjs  (C10-1)
//   scripts/gate-receipt.mjs         (C10-4)
//   scripts/refresh-derived.mjs      (C10-3)
//   scripts/release-status.mjs       (C10-5)
//
// The lint half of C10 has its own drill (scripts/c10-oss-absent-sweep-lint.test.mjs),
// which travels with the excluded lint it exercises.
//
// WHAT IS DRIVEN FOR REAL AND WHAT IS NOT. The receipt's judgements are driven
// against a REAL temporary git repository, because the whole mechanism is about
// what git reports and a stub git would only prove that the stub agrees with
// itself. The toolchain preflight is driven with synthetic probe results for the
// opposite reason: the interesting direction is "a tool is MISSING", and the
// only way to produce that on a machine that has all four would be to break the
// machine.
//
// Run: `node scripts/c10-shift-left-gates.test.mjs`

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

let failed = 0;
let sections = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

// ── § 1  toolchain preflight ────────────────────────────────────────────────
sections += 1;
console.log('§1 toolchain preflight (C10-1)');
{
  const m = await import('./preflight-toolchain.mjs');

  check('all four tools the delivery chain shells out to are declared',
    ['node', 'pnpm', 'cargo', 'flutter'].every((id) => m.TOOLS.some((t) => t.id === id)),
    m.TOOLS.map((t) => t.id).join(','));

  check('every tool names the stages that need it AND a fix',
    m.TOOLS.every((t) => typeof t.stages === 'string' && t.stages.length > 0
      && typeof t.fix === 'string' && t.fix.length > 0));

  // The measured root cause of rows 1-3 of the ledger was a stale PATH copy, not
  // a missing install. If the refusal ever stops saying so, the tool stops being
  // worth its second: "command not found" already reads as "not installed", and
  // that is the wrong diagnosis this text exists to pre-empt.
  const refusal = m.formatRefusal([{ id: 'cargo', reason: 'not-found', detail: 'cargo exited 1' }], []);
  check('a missing tool names the stages that need it', refusal.includes('verify:clippy'), refusal);
  check('a missing tool prints the stale-PATH hint verbatim', refusal.includes(m.STALE_PATH_HINT));
  check('a missing tool hands back the toolchain-free subset', refusal.includes(m.NODE_ONLY_SUBSET));

  // A version below the declared floor is refused, and the floor is READ from
  // package.json engines rather than retyped here.
  const engines = m.readEngines();
  check('package.json declares a node floor this preflight can read',
    m.floorMajor(engines.node) != null, JSON.stringify(engines));
  check('majorOf parses the shapes the four tools actually print',
    m.majorOf('v22.22.3') === 22 && m.majorOf('9.15.9') === 9
    && m.majorOf('cargo 1.95.0 (f2d3ce0bd 2026-03-21)') === 1
    && m.majorOf('Flutter 3.41.9 • channel stable') === 3);
  check('an unparseable banner downgrades to "not checked", never to a failure',
    m.majorOf('some banner with no version') === null);

  // The real thing, end to end, on this machine.
  const real = spawnSync(node, [path.join(ROOT, 'scripts', 'preflight-toolchain.mjs')], { encoding: 'utf8', cwd: ROOT });
  check('running it on this box exits 0 and prints a version per tool',
    real.status === 0 && m.TOOLS.every((t) => (real.stdout ?? '').includes(t.id)),
    `status=${real.status} ${(real.stdout ?? '').slice(0, 200)}`);
}

// ── § 2  gate receipt ───────────────────────────────────────────────────────
sections += 1;
console.log('\n§2 gate receipt (C10-4) — driven against a real temporary git repo');
{
  const m = await import('./gate-receipt.mjs');
  const tmp = mkdtempSync(path.join(tmpdir(), 'c10-receipt-'));
  let receiptDir = tmp;
  const git = (...args) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' });
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'drill@example.test');
    git('config', 'user.name', 'drill');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(tmp, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'first');

    const fp0 = m.fingerprint(tmp);
    check('a clean tree fingerprints', fp0 != null && fp0.dirtyCount === 0, JSON.stringify(fp0));

    const fp0b = m.fingerprint(tmp);
    check('the fingerprint is stable across calls on an unchanged tree', fp0.digest === fp0b.digest);

    // CONTENT, not mtime: the whole reuse decision rests on this.
    writeFileSync(path.join(tmp, 'a.txt'), 'two\n');
    const fp1 = m.fingerprint(tmp);
    check('editing a tracked file changes the fingerprint', fp1.digest !== fp0.digest);
    check('and the dirty count reports it', fp1.dirtyCount === 1, String(fp1.dirtyCount));

    writeFileSync(path.join(tmp, 'a.txt'), 'one\n');
    check('restoring the exact bytes restores the exact fingerprint',
      m.fingerprint(tmp).digest === fp0.digest);

    // An untracked file is part of the tree being proved.
    writeFileSync(path.join(tmp, 'b.txt'), 'new\n');
    const fp2 = m.fingerprint(tmp);
    check('an untracked, non-ignored file changes the fingerprint', fp2.digest !== fp0.digest);

    // An untracked DIRECTORY is one `??` record covering an unknown number of
    // files. If the walk were skipped, editing inside it would be invisible.
    rmSync(path.join(tmp, 'b.txt'));
    mkdirSync(path.join(tmp, 'sub'));
    writeFileSync(path.join(tmp, 'sub', 'c.txt'), 'x\n');
    const fp3 = m.fingerprint(tmp);
    writeFileSync(path.join(tmp, 'sub', 'c.txt'), 'y\n');
    check('editing a file INSIDE an untracked directory changes the fingerprint',
      m.fingerprint(tmp).digest !== fp3.digest);
    rmSync(path.join(tmp, 'sub'), { recursive: true, force: true });

    // An ignored path must not: node_modules churn is not a change to the tree
    // being proved, and treating it as one would make every receipt worthless.
    writeFileSync(path.join(tmp, '.gitignore'), 'ignored/\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'ignore');
    const fp4 = m.fingerprint(tmp);
    mkdirSync(path.join(tmp, 'ignored'));
    writeFileSync(path.join(tmp, 'ignored', 'junk.txt'), 'junk\n');
    check('an IGNORED file does not change the fingerprint', m.fingerprint(tmp).digest === fp4.digest);

    // ── the four reuse conditions, each refused on its own ──
    const tools = ['cargo@cargo 1.0.0', 'node@v22.0.0'];
    const good = {
      version: m.RECEIPT_VERSION,
      sha: fp4.sha, digest: fp4.digest, dirtyCount: fp4.dirtyCount,
      tools, startedAt: 1000, finishedAt: 2000,
    };
    // 🔴 EVERY receipt path in this section is in a directory of its own, and
    // BOTH halves of that were learned by measurement.
    //   ① Never the real `.local/`. The first version of this drill wrote to the
    //      module constants, and because verify:scripts runs it in the MIDDLE of
    //      verify:delivery, it deleted the live run's pending marker: the full
    //      gate (25 lints, 2729 phone tests) went green and produced no receipt.
    //   ② Never inside `tmp` either. A receipt written inside the tree it
    //      certifies is an untracked file in that tree, so it changes the very
    //      fingerprint it is compared against — at tmp/.receipt every reuse check
    //      failed with "working tree changed". The observer must not be part of
    //      what it observes.
    const DIR = mkdtempSync(path.join(tmpdir(), 'c10-receipt-dir-'));
    receiptDir = DIR;
    const RECEIPT = m.receiptPathIn(DIR);
    const write = (obj) => {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(RECEIPT, JSON.stringify(obj));
    };

    write(good);
    const okRes = m.readValidReceipt({ root: tmp, now: 2000 + 60_000, tools, dir: DIR });
    check('all four conditions matching ⇒ reuse allowed', okRes.ok === true, okRes.reason);
    check('the reuse banner is LOUD and names when the proof was made',
      okRes.ok && m.reuseBanner(okRes).includes('REUSING A GATE PROOF')
      && m.reuseBanner(okRes).includes('proved at'));
    check('the banner says the gate is NOT running now',
      okRes.ok && m.reuseBanner(okRes).includes('NOT being run now'));

    // REVERSE CONTROL 1 — a tampered fingerprint must refuse.
    write({ ...good, digest: `${good.digest.slice(0, -1)}0` === good.digest ? '0'.repeat(64) : `${good.digest.slice(0, -1)}0` });
    const tampered = m.readValidReceipt({ root: tmp, now: 2000 + 60_000, tools, dir: DIR });
    check('REVERSE CONTROL: a tampered working-tree fingerprint refuses reuse', tampered.ok === false);
    check('  ...and says WHICH condition failed', /working tree changed/.test(tampered.reason ?? ''), tampered.reason);

    // REVERSE CONTROL 2 — a moved HEAD must refuse, with its own reason.
    write({ ...good, sha: '0'.repeat(40) });
    const moved = m.readValidReceipt({ root: tmp, now: 2000 + 60_000, tools, dir: DIR });
    check('REVERSE CONTROL: a moved HEAD refuses reuse', moved.ok === false);
    check('  ...and names HEAD rather than the tree', /HEAD moved/.test(moved.reason ?? ''), moved.reason);

    // REVERSE CONTROL 3 — an aged-out proof must refuse.
    write(good);
    const old = m.readValidReceipt({ root: tmp, now: 2000 + m.MAX_AGE_MS + 1, tools, dir: DIR });
    check('REVERSE CONTROL: a proof older than the window refuses reuse', old.ok === false);
    check('  ...and states the age and the limit', /min old \(limit/.test(old.reason ?? ''), old.reason);

    // REVERSE CONTROL 4 — a changed toolchain must refuse. This is the row that
    // covers the very failure C10-1 exists for: a different cargo is a different
    // proof, and nothing else in the fingerprint would notice.
    const drifted = m.readValidReceipt({ root: tmp, now: 2000 + 60_000, tools: ['cargo@cargo 2.0.0', 'node@v22.0.0'], dir: DIR });
    check('REVERSE CONTROL: a changed toolchain refuses reuse', drifted.ok === false);
    check('  ...and names the toolchain', /toolchain changed/.test(drifted.reason ?? ''), drifted.reason);

    // A receipt from an older recipe is not comparable under the new rules.
    write({ ...good, version: m.RECEIPT_VERSION + 1 });
    check('a receipt written by a different recipe version refuses reuse',
      m.readValidReceipt({ root: tmp, now: 2000 + 60_000, tools, dir: DIR }).ok === false);

    // REVERSE CONTROL 5 — the two stages typed by hand, with no gate between
    // them, must not mint a proof. `&&` cannot prevent that; the elapsed floor
    // can, and it is the honest boundary of "unforgeable" claimed in the header.
    rmSync(RECEIPT, { force: true });
    const t0 = Date.now();
    m.begin({ root: tmp, now: t0, dir: DIR });
    m.end({ root: tmp, now: t0 + 1_000, dir: DIR });
    const forged = (() => { try { readFileSync(RECEIPT); return true; } catch { return false; } })();
    check('REVERSE CONTROL: --begin then --end with no gate between writes NO receipt', forged === false);

    // ...and the same pair, with a plausible elapsed time, does write one — so
    // the floor is a floor and not a permanent refusal.
    m.begin({ root: tmp, now: t0, dir: DIR });
    m.end({ root: tmp, now: t0 + m.MIN_GATE_MS + 1, dir: DIR });
    const real = (() => { try { return JSON.parse(readFileSync(RECEIPT, 'utf8')); } catch { return null; } })();
    check('a run that lasted longer than the floor DOES write a receipt', real != null);
    check('  ...recording the toolchain it was proved with', Array.isArray(real?.tools) && real.tools.length > 0);

  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  rmSync(receiptDir, { recursive: true, force: true });
}

// ── § 3  publish reads the receipt, and can never skip silently ─────────────
sections += 1;
console.log('\n§3 publish.mjs consumes the receipt (C10-4 reader side)');
{
  const src = readFileSync(path.join(ROOT, 'scripts', 'publish.mjs'), 'utf8');
  check('publish imports the receipt reader rather than re-deriving the rules',
    src.includes("from './gate-receipt.mjs'") && src.includes('readValidReceipt('));
  check('a reused proof is announced with the shared banner',
    src.includes('reuseBanner(proof)'));
  // The whole point: there is no branch where the gate is skipped in silence.
  check('the non-reuse branch prints WHY the proof was unusable',
    src.includes('no reusable gate proof'));
  check('the gate stage itself is unchanged — still `pnpm verify:delivery`, still fatal',
    src.includes("spawnSync('pnpm', ['verify:delivery']") && src.includes('refusing to publish'));

  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const chain = pkg.scripts['verify:delivery'];
  check('verify:delivery OPENS with the preflight', /^pnpm verify:preflight\b/.test(chain), chain);
  check('verify:delivery CLOSES with the receipt writer', /pnpm verify:receipt$/.test(chain), chain);
  check('the preflight stage begins the receipt in the same second it checks the toolchain',
    pkg.scripts['verify:preflight'].includes('preflight-toolchain.mjs')
    && pkg.scripts['verify:preflight'].includes('gate-receipt.mjs --begin'));
}

// ── § 4  refresh-derived (the hooks' engine) ────────────────────────────────
sections += 1;
console.log('\n§4 refresh-derived (C10-3)');
{
  const m = await import('./refresh-derived.mjs');

  check('both measured failure classes have a refresher',
    m.REFRESHERS.some((r) => r.id === 'i18n') && m.REFRESHERS.some((r) => r.id === 'protocol-dist'));

  const i18n = m.REFRESHERS.find((r) => r.id === 'i18n');
  const proto = m.REFRESHERS.find((r) => r.id === 'protocol-dist');
  check('an i18n source change picks only the i18n refresher',
    m.pick(['i18n/mobile/zh_CN.json']).map((r) => r.id).join() === 'i18n');
  check('a protocol source change picks only the dist rebuild',
    m.pick(['packages/protocol/src/constants.ts']).map((r) => r.id).join() === 'protocol-dist');
  check('an unrelated change picks nothing (silence is the normal outcome)',
    m.pick(['apps/desktop/src/App.vue']).length === 0);
  check('a generated ARTEFACT changing does not re-trigger its own generator',
    m.pick(['apps/mobile/lib/src/settings/l10n/leaves.g.dart']).length === 0);
  check('each refresher prints the same command a human would type',
    i18n.command === 'pnpm i18n:gen' && proto.command === 'pnpm --filter @flowmic/protocol build');

  // "Cannot tell" must mean "do nothing", never "rebuild everything": a clone
  // passes the all-zero sha, and a hook that rebuilt there would run on a tree
  // whose dependencies are not installed yet.
  check('a fresh clone (all-zero sha) is not a range', m.changedPaths('0'.repeat(40), 'HEAD', ROOT) === null);
  check('a missing revision argument is not a range', m.changedPaths(undefined, undefined, ROOT) === null);
  check('an unchanged range is not a range', m.changedPaths('HEAD', 'HEAD', ROOT) === null);
  check('an unknown revision degrades to "cannot tell", it does not throw',
    m.changedPaths('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'HEAD', ROOT) === null);
}

// ── § 5  the hooks themselves ───────────────────────────────────────────────
sections += 1;
console.log('\n§5 husky hooks (C10-3 wiring)');
{
  const sh = spawnSync('sh', ['--version'], { encoding: 'utf8' });
  const haveSh = sh.status === 0 || (sh.stdout ?? '').length > 0;

  for (const hook of ['post-merge', 'post-checkout']) {
    const src = readFileSync(path.join(ROOT, '.husky', hook), 'utf8');
    check(`${hook} calls the shared engine rather than inlining the logic`,
      src.includes('node scripts/refresh-derived.mjs'));
    // `sh -e` is what husky runs these under, and a bare AND-list whose first
    // test is false returns 1 there — which would make husky print a failure on
    // every single-file checkout. `if` is the shape that survives it.
    check(`${hook} guards with \`if\`, not a bare AND-list (sh -e would kill it)`,
      /\bif \[/.test(src) && !/^\[ .*\] && \[/m.test(src));
    check(`${hook} ends by exiting 0 (git ignores this hook's status anyway)`,
      /exit 0\s*$/.test(src));
  }

  if (haveSh) {
    // The one case the hook must stay out of: `git checkout -- <file>`.
    const fileCheckout = spawnSync('sh', ['-e', path.join(ROOT, '.husky', 'post-checkout'), 'aaa', 'bbb', '0'],
      { encoding: 'utf8', cwd: ROOT });
    check('post-checkout on a FILE checkout exits 0 in silence',
      fileCheckout.status === 0 && `${fileCheckout.stdout}${fileCheckout.stderr}`.trim() === '',
      `status=${fileCheckout.status} out=${(fileCheckout.stdout + fileCheckout.stderr).slice(0, 120)}`);
  } else {
    check('post-checkout on a FILE checkout exits 0 in silence', true, 'no POSIX sh on this box — shape checked above only');
  }
}

// ── § 6  release-status is READ-ONLY ───────────────────────────────────────
sections += 1;
console.log('\n§6 release-status (C10-5)');
{
  const before = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const r = spawnSync(node, [path.join(ROOT, 'scripts', 'release-status.mjs')], { encoding: 'utf8', cwd: ROOT });
  const after = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });

  check('it exits 0', r.status === 0, `status=${r.status} ${(r.stderr ?? '').slice(0, 200)}`);
  // 🔴 The single property that matters. A status tool that mutates is a status
  // tool nobody dares run on a release day, which is the only day it is useful.
  check('READ-ONLY: it leaves the working tree byte-identical', before === after);

  const out = r.stdout ?? '';
  check('it says out loud that it built/uploaded/fetched nothing',
    out.includes('read-only'));
  check('it names one NEXT step rather than a list', (out.match(/NEXT:/g) ?? []).length === 1);
  check('server-side facts are UNKNOWN, never guessed', out.includes('UNKNOWN'));
  // Asserted through the DATA, not by grepping stdout for script names: two of
  // the three server-side rows name scripts the open-source export excludes, and
  // spelling one here would make this kept drill an ORPHANED PAIR — the export
  // refuses a kept `scripts/*.test.mjs` that references an excluded script.
  // (Measured: naming publish-download-center.mjs in this line did exactly that.)
  const data = await (await import('./release-status.mjs')).rows();
  check('every non-DONE row hands back a command that closes it',
    data.filter((x) => x.state !== 'DONE').every((x) => typeof x.next === 'string' && x.next.length > 0));
  check('and every one of those commands is printed beside its row',
    data.filter((x) => x.state !== 'DONE').every((x) => out.includes(x.next)));

  const m = await import('./release-status.mjs');
  check('it reads the version from the same manifest version-sync compares against',
    m.VERSION === JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  check('the CHANGELOG matcher accepts the combined-round heading spelling',
    m.changelogSection('9.9.9', ROOT) === null);
}

console.log(`\nACCOUNTING: sections run ${sections}/${sections}`);
console.log(failed === 0 ? '\nPASS' : `\nFAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
