#!/usr/bin/env node
// Drill for LANE MODE of scripts/refresh-derived.mjs (card SC-3, 2026-09-17).
//
// The hook mode (`REFRESHERS` / `pick` / `changedPaths`) is drilled in
// `scripts/c10-shift-left-gates.test.mjs` §4 and is deliberately not re-tested
// here. This file covers the second mode only: the one that re-points a
// PERSISTENT lane slot, whose three jobs each have a failure that has actually
// cost a round trip —
//
//   · a dist that is older than its source, which makes tsc and the golden
//     paths read a contract that is not in the tree (the false GREEN this
//     file's subject was written about);
//   · a lane tree with no sidecar payload, which dies minutes into `tauri build`;
//   · a web lane with no Playwright browsers, which is 707 MB of download per
//     lane unless it is junctioned to the main checkout.
//
// 🔴 WHY THE BUNDLERS ARE FAKED AND THE JUNCTION IS NOT. What this file owns is
// the DECISION — stale or fresh, reset or hands off. `exec` is therefore injected
// for the tsup rows: spawning real tsup here would spend 10 s proving that
// `spawnSync` spawns, which is exactly the "prove the same tree a second time"
// that SC-3 exists to delete. The junction is the opposite case: its whole
// content is a platform call (`mklink /J` vs `ln -s`) whose behaviour we do not
// own, so it is made FOR REAL, on a throwaway directory, and read back.
//
// ⚠️ FIXTURE LOCATION is not a free choice: owner ruling 2026-08-18 keeps every
// project tree off the system volume, so the fixtures are made under the repo's
// own gitignored `.local/` — same volume as the repo by construction.
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP+reason.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const m = await import('./refresh-derived.mjs');

let failures = 0;
let checks = 0;
function check(what, ok, detail) {
  checks += 1;
  if (ok) { console.log(`  ok   ${what}`); return; }
  failures += 1;
  console.log(`  FAIL ${what}${detail ? `\n       ${detail}` : ''}`);
}

const scratchParent = join(ROOT, '.local');
mkdirSync(scratchParent, { recursive: true });
const scratch = mkdtempSync(join(scratchParent, 'refresh-derived-drill-'));

/** Write a file and stamp its mtime, so "newer" and "older" are stated rather
 *  than raced — two files written in the same millisecond are a coin flip. */
function put(path, body, whenMs) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  const secs = whenMs / 1000;
  utimesSync(path, secs, secs);
}

/** Stamp a whole subtree, deepest first — a DIRECTORY's mtime moves every time a
 *  file is written inside it, so stamping only the files would leave the fixture's
 *  dist directory dated "now", and the fixture would then silently mean the
 *  opposite of what it says. (This cost one red run before it was believed.) */
function stampTree(path, whenMs) {
  let st;
  try { st = statSync(path); } catch { return; }
  if (st.isDirectory()) for (const e of readdirSync(path)) stampTree(join(path, e), whenMs);
  const secs = whenMs / 1000;
  utimesSync(path, secs, secs);
}

/** A tree shaped like the monorepo's three bundle packages, and nothing else. */
function makeFixture(name, { distAgeMs }) {
  const root = join(scratch, name);
  const t0 = Date.now() - 600_000;
  for (const spec of m.LANE_DISTS) {
    put(join(root, spec.sources[0], 'index.ts'), 'export const x = 1;\n', t0);
    put(join(root, spec.sources[1]), '{"name":"fixture"}\n', t0);
    if (distAgeMs != null) put(join(root, spec.dist, 'index.js'), 'exports.x = 1;\n', t0 + distAgeMs);
  }
  for (const spec of m.LANE_DISTS) {
    stampTree(join(root, spec.sources[0]), t0);
    stampTree(join(root, spec.sources[1]), t0);
    if (distAgeMs != null) stampTree(join(root, spec.dist), t0 + distAgeMs);
  }
  return root;
}

const recorder = () => {
  const calls = [];
  const exec = (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { status: 0, stdout: '', stderr: '' }; };
  return { calls, exec };
};

try {
  // ── §1 staleness: the measurement itself ────────────────────────────────
  console.log('\n§1 distState — source newer than dist means stale');
  {
    const fresh = makeFixture('fresh', { distAgeMs: 60_000 });   // dist 60 s NEWER
    const stale = makeFixture('stale', { distAgeMs: -60_000 });  // dist 60 s OLDER
    const proto = m.LANE_DISTS[0];

    check('a dist newer than its sources is not stale', m.distState(fresh, proto).stale === false);
    check('a dist older than its sources IS stale', m.distState(stale, proto).stale === true);
    check('a missing dist is reported as absent, not as fresh',
      m.distState(join(scratch, 'nothing-here'), proto).present === false);
    check('a package that is not in this tree does not apply',
      m.distState(join(scratch, 'nothing-here'), proto).applies === false);
  }

  // ── §2 the plan: stale → rebuild, fresh → SKIP (fresh) ──────────────────
  console.log('\n§2 planDists — the decision, with no side effects');
  {
    const fresh = join(scratch, 'fresh');
    const stale = join(scratch, 'stale');

    const freshPlan = m.planDists(fresh);
    check('every row of a fresh tree skips with the reason "fresh"',
      freshPlan.every((r) => r.action === 'skip' && r.reason === 'fresh'),
      JSON.stringify(freshPlan.map((r) => `${r.id}:${r.action}/${r.reason}`)));

    const stalePlan = m.planDists(stale);
    check('every row of a stale tree is a build for the measured reason',
      stalePlan.every((r) => r.action === 'build' && r.reason === 'source newer than dist'),
      JSON.stringify(stalePlan.map((r) => `${r.id}:${r.action}/${r.reason}`)));

    // The measured dependency: protocol is INLINED into server-core's bundle, so
    // a protocol rebuild invalidates server-core even though its own sources did
    // not move. Without this row the lane would carry a server bundle with last
    // week's protocol in it and nothing would say so.
    const dep = m.planDists(fresh, m.LANE_DISTS, new Set(['protocol']));
    const server = dep.find((r) => r.id === 'server-core');
    check('a protocol rebuild forces the server-core bundle even when it is fresh',
      server.action === 'build' && server.reason === 'protocol was rebuilt', JSON.stringify(server));
    check('stt-cloud does NOT declare that dependency (measured: no protocol in its dist)',
      dep.find((r) => r.id === 'stt-cloud').action === 'skip');

    check('each bundle row prints the same command a human would type',
      m.LANE_DISTS.map((s) => s.command).join('|')
        === 'pnpm --filter @flowmic/protocol build|pnpm --filter @flowmic/server-core build|pnpm --filter @flowmic/stt-cloud build');
  }

  // ── §3 refreshLane end to end on a fixture ──────────────────────────────
  console.log('\n§3 refreshLane — stale is rebuilt, fresh says SKIP (fresh), twice is idempotent');
  {
    const stale = join(scratch, 'stale');
    const { calls, exec } = recorder();
    const lines = m.refreshLane({ root: stale, exec, quiet: true, skipBase: true });

    check('a stale tree runs exactly the three bundle commands, protocol first',
      calls.join('\n') === [
        'pnpm --filter @flowmic/protocol build',
        'pnpm --filter @flowmic/server-core build',
        'pnpm --filter @flowmic/stt-cloud build',
      ].join('\n'), calls.join(' | '));
    check('and says so, one line per task',
      lines.filter((l) => /^lane\[(protocol|server-core|stt-cloud)\] rebuilt /.test(l)).length === 3,
      lines.join('\n'));
    check('every task emits exactly one line — base, three bundles, sidecar, browsers',
      lines.length === 6, lines.join('\n'));

    const fresh = join(scratch, 'fresh');
    const r2 = recorder();
    const freshLines = m.refreshLane({ root: fresh, exec: r2.exec, quiet: true, skipBase: true });
    check('a fresh tree runs NOTHING', r2.calls.length === 0, r2.calls.join(' | '));
    check('a fresh tree prints SKIP (fresh) for all three bundles',
      freshLines.filter((l) => l.endsWith('SKIP (fresh)')).length === 3, freshLines.join('\n'));

    // Idempotence, stated the way it is actually used: run it twice in a row.
    const r3 = recorder();
    const again = m.refreshLane({ root: fresh, exec: r3.exec, quiet: true, skipBase: true });
    check('running it twice changes nothing the second time',
      r3.calls.length === 0 && again.join('\n') === freshLines.join('\n'));
  }

  // ── §4 the sidecar row is presence-only ─────────────────────────────────
  console.log('\n§4 sidecar payload — staged when missing, silent when present');
  {
    const tree = makeFixture('sidecar', { distAgeMs: 60_000 });
    mkdirSync(join(tree, 'apps', 'desktop'), { recursive: true });
    const r = recorder();
    const lines = m.refreshLane({ root: tree, exec: r.exec, quiet: true, skipBase: true });
    check('a desktop tree with no resources/server.js stages the sidecar',
      r.calls.includes('pnpm -F @flowmic/desktop build:sidecar'), r.calls.join(' | '));
    check('and names the artefact it is missing in its own row',
      lines.some((l) => l.startsWith('lane[sidecar] staged')), lines.join('\n'));

    put(join(tree, m.LANE_SIDECAR.artefact), '// payload\n', Date.now());
    const r2 = recorder();
    const lines2 = m.refreshLane({ root: tree, exec: r2.exec, quiet: true, skipBase: true });
    check('once the payload is there it is SKIP (fresh), not a rebuild',
      r2.calls.length === 0 && lines2.includes('lane[sidecar] SKIP (fresh)'), lines2.join('\n'));
  }

  // ── §5 the Playwright junction, made for real ───────────────────────────
  console.log('\n§5 Playwright junction — restored when missing, on a real directory');
  {
    const src = join(scratch, 'web-main');
    const lane = join(scratch, 'web-lane');
    const core = (root) => join(root, 'node_modules', '.pnpm', 'playwright-core@1.63.0', 'node_modules', 'playwright-core');
    mkdirSync(join(core(src), '.local-browsers', 'chromium-1234'), { recursive: true });
    writeFileSync(join(core(src), '.local-browsers', 'chromium-1234', 'marker.txt'), 'browser bytes\n');
    mkdirSync(core(lane), { recursive: true });

    check('the lane tree is found to have playwright-core', m.playwrightCoreDir(lane) !== null);
    const before = m.junctionState(lane, src);
    check('a lane with no .local-browsers reports applies:true, present:false',
      before.applies === true && before.present === false, JSON.stringify(before));

    const run = m.ensureJunction(before);
    check('the link is created', run != null && run.status === 0,
      run ? `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() : 'no child process ran');
    check('and the browsers are readable THROUGH it (not just a directory that exists)',
      existsSync(join(before.link, 'chromium-1234', 'marker.txt')));

    const after = m.junctionState(lane, src);
    check('a second look says present:true', after.applies === true && after.present === true);
    check('ensureJunction is a no-op once the link is there', m.ensureJunction(after) === null);

    // The source checkout must never junction to itself.
    check('the checkout that owns the download is not a candidate',
      m.junctionState(src, src).applies === false, JSON.stringify(m.junctionState(src, src)));
    // A tree with no Playwright at all is "nothing to do", not an error.
    check('a tree with no playwright-core is skipped by name',
      m.junctionState(join(scratch, 'fresh'), src).applies === false);
  }

  // ── §6 the base reset refuses to touch anybody's work ───────────────────
  console.log('\n§6 base reset — slot branches only, clean only, worktree roots only');
  {
    const here = m.slotState(ROOT, 'main');
    check('the slot predicate accepts lane/a..lane/c and nothing else',
      m.SLOT_BRANCH.test('lane/a') && m.SLOT_BRANCH.test('lane/c')
      && !m.SLOT_BRANCH.test('lane/sc3-lane-rules') && !m.SLOT_BRANCH.test('main'));
    check('a card branch is refused BY NAME, never reset',
      here.isSlot || /never reset/.test(here.reason ?? ''),
      `branch=${here.branch} reason=${here.reason}`);

    // 🔴 THE GUARD THAT MATTERS MOST, and it needs its own repository to be
    // tested honestly. `git` answers about the ENCLOSING repository no matter how
    // deep you stand, so a fixture path inside a slot worktree would inherit that
    // slot's branch — pass the idle test — and get `git reset --hard` run on a
    // directory nobody asked about. Asserting this from THIS worktree proves
    // nothing: we are on a card branch, so `!isSlot` refuses first and the check
    // is green whether the guard exists or not. (Measured: removing the guard
    // left that version of this assertion green.) So the fixture below is a real
    // git repo standing on a real slot branch, where `isSlot` cannot do the work.
    const repo = join(scratch, 'slot-repo');
    mkdirSync(repo, { recursive: true });
    const g = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    g('init', '--initial-branch=main', '--quiet');
    g('config', 'user.email', 'drill@example.invalid');
    g('config', 'user.name', 'drill');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'README'), 'fixture');
    g('add', '-A');
    g('commit', '--quiet', '--no-verify', '-m', 'fixture');
    g('checkout', '--quiet', '-b', 'lane/a');
    const nestedDir = join(repo, 'packages', 'protocol', 'src');
    mkdirSync(nestedDir, { recursive: true });

    const atTop = m.slotState(repo, 'main');
    check('POSITIVE CONTROL: a clean slot branch at its worktree root IS idle',
      atTop.idle === true && atTop.branch === 'lane/a', JSON.stringify(atTop));

    const nested = m.slotState(nestedDir, 'main');
    check('a nested directory inside that same idle slot is REFUSED by name',
      nested.idle === false && /not a worktree root/.test(nested.reason ?? ''), JSON.stringify(nested));

    writeFileSync(join(repo, 'README'), 'dirty');
    check('a slot with uncommitted changes is refused — never stashed, never reset',
      m.slotState(repo, 'main').reason === 'slot has uncommitted changes');
    g('checkout', '--quiet', '--', 'README');
    g('commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'a card commit');
    check('a slot carrying a commit of its own is refused, and says how many',
      /1 commit\(s\) ahead/.test(m.slotState(repo, 'main').reason ?? ''),
      m.slotState(repo, 'main').reason);

    const disabled = m.refreshLane({ root: join(scratch, 'fresh'), exec: recorder().exec, quiet: true, skipBase: true });
    check('skipBase names itself in the output rather than printing nothing',
      disabled[0] === 'lane[base] SKIP (disabled by caller)', disabled[0]);
  }

  // ── §7 dispatch: one file, two modes, no overlap ────────────────────────
  console.log('\n§7 dispatch — --lane never runs the hook path and vice versa');
  {
    const dry = spawnSync(process.execPath, [join(HERE, 'refresh-derived.mjs'), '--lane', '--dry-run'],
      { cwd: ROOT, encoding: 'utf8' });
    check('`--lane --dry-run` exits 0 and prints one line per task',
      dry.status === 0 && `${dry.stdout}`.trim().split('\n').length === 6,
      `status=${dry.status} out=${`${dry.stdout}${dry.stderr}`.slice(0, 300)}`);
    check('a dry run never spawns a bundler (nothing says "rebuilt" or "staged")',
      !/\b(rebuilt|staged|reset) /.test(`${dry.stdout}`), `${dry.stdout}`.slice(0, 300));

    const hook = spawnSync(process.execPath, [join(HERE, 'refresh-derived.mjs'), 'HEAD', 'HEAD'],
      { cwd: ROOT, encoding: 'utf8' });
    check('the hook mode still exits 0 in silence on a non-range',
      hook.status === 0 && `${hook.stdout}${hook.stderr}`.trim() === '',
      `status=${hook.status} out=${`${hook.stdout}${hook.stderr}`.slice(0, 200)}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} refresh-derived lane mode — ${checks - failures}/${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
