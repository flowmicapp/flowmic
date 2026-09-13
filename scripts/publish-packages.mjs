#!/usr/bin/env node
// scripts/publish-packages.mjs
//
// Publish the two packages an outside repository needs — `@flowmic/protocol`
// (the wire contract) and `@flowmic/i18n-web` (the browser clients' message
// subset) — to GitHub Packages, a PRIVATE npm registry.
//
// SPEC-REF:
//   docs/strategy/2026-09-05-web-client-subproject-design.md §10
//   docs/decisions/2026-09-06-owner-web-client-rulings-repo-protocol-domains.md (W-8, W-11)
//   docs/strategy/2026-09-07-web-client-execution-plan-three-stages.md §1 (S1-04)
//
// ── THE THREE THINGS THIS SCRIPT REFUSES ────────────────────────────────────
//
// 1. 🔴 IT NEVER PUBLISHES WHAT HAPPENS TO BE ON DISK. It rebuilds `dist/` and
//    then checks that every file it is about to ship was written by THAT build
//    (mtime >= the moment the build started). This repo has been bitten twice by
//    a stale `dist` — once as a false green (0.2.22: new zod fields stripped by an
//    old bundle, so an assertion that should have failed passed) and once as a
//    false red — and both times the bundle was gitignored, so nothing in the
//    tree showed the difference. A published tarball is that same hazard with a
//    consumer repo on the other end of it.
//    REVERSE CONTROL [measured 2026-09-07, dev-pc-a]: with `buildStart`
//    moved ten minutes into the future — every emitted file therefore looking
//    older than its own build — `--dry-run` refused and named all four dist
//    files. Restored; the same command then packed normally. The refusal fires;
//    it is not green-by-construction.
//
// 2. 🔴 IT REFUSES A MODE IT WAS NOT GIVEN. No bare invocation, no default. Same
//    posture, and the same reason, as scripts/bump-version.mjs: every shell here
//    is non-interactive, so a "are you sure?" prompt would read EOF and proceed —
//    the accident with a fig leaf. `--dry-run=1` and `--publish=1` are rejected
//    at parse time too (IT-07's lesson: a valued boolean must never quietly
//    become a real run).
//
// 3. 🔴 IT REFUSES TO PUBLISH FROM A DIRTY PACKAGE. A tarball that corresponds to
//    no commit cannot be explained afterwards. Scoped to the package's own paths
//    and its generator inputs rather than the whole tree, because other sessions
//    leave files in this worktree and their dirt is not evidence about this
//    artifact.
//
// ── THE SCOPE RENAME, AND WHY THE MONOREPO KEEPS ITS OWN NAME ───────────────
// GitHub's npm registry requires a package's scope to match the repository owner
// [assumed from GitHub's documented rule for npm on GitHub Packages — NOT
// measured here, since this card publishes nothing]. The owner is `flowmicapp`
// and the workspace scope is `@flowmic`, so the published name is
// `@flowmicapp/<pkg>` while the source keeps `@flowmic/<pkg>` and every existing
// import in this repo keeps working. The consumer closes the gap with an alias:
//
//     "@flowmic/protocol": "npm:@flowmicapp/protocol@<exact version>"
//
// That IS a second name for one thing, which this repo normally treats as a
// defect. It is confined to one constant (PUBLISH_OWNER) and one line of the
// consumer's package.json; the alternative that removes it entirely is a GitHub
// organisation actually named `flowmic`, which is an owner-level decision and
// not one a script may make. `--keep-scope` publishes under `@flowmic/…` for the
// day that decision lands (or for a different registry that has no such rule).
//
// ── THE TOKEN NEVER TOUCHES A TRACKED FILE ─────────────────────────────────
// It is read from `.local/github.env` (gitignored) or from the environment, and
// the `.npmrc` this script writes contains the literal string
// `${NODE_AUTH_TOKEN}` — npm expands it from the environment at run time, so no
// file anywhere ever holds the secret. `verify:lint no-cloud-keys` would catch a
// leaked one, and it being correct to do so is exactly why nothing here writes
// an `.npmrc` into the repo.
//
// Usage:
//   node scripts/publish-packages.mjs --all --print-plan     # no build, no npm
//   node scripts/publish-packages.mjs --all --dry-run        # build + npm pack
//   node scripts/publish-packages.mjs --package @flowmic/protocol --publish
//
// Publishing is an OUTWARD action. `--publish` is what CI runs on a version tag
// (.github/workflows/publish-packages.yml); a person running it by hand should
// know they are doing exactly that.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://npm.pkg.github.com';
const PUBLISH_OWNER = 'flowmicapp';

/** The publishable set. `inputs` are the paths whose dirtiness would make the
 *  tarball unexplainable — for a generated package that includes the source the
 *  generator reads, because a clean package directory says nothing about it. */
const PACKAGES = [
  { name: '@flowmic/protocol', dir: 'packages/protocol', inputs: ['packages/protocol'] },
  {
    name: '@flowmic/i18n-web',
    dir: 'packages/i18n-web',
    inputs: ['packages/i18n-web', 'i18n/web', 'i18n/mobile', 'packages/protocol/src/locales.ts'],
    freshness: ['scripts/i18n/gen-i18n-web.mjs', '--check'],
  },
];

function die(...lines) {
  for (const l of lines) console.error(l);
  console.error('  nothing was published.');
  process.exit(1);
}

// ── arguments ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
for (const a of argv) {
  if (/^--(dry-run|publish|print-plan|all|keep-scope)=/.test(a)) {
    die(`refusing '${a}': these are bare flags. A valued boolean is how '--dry-run=0' becomes a real publish.`);
  }
}
const has = (flag) => argv.includes(flag);
const modes = ['--print-plan', '--dry-run', '--publish'].filter(has);
if (modes.length !== 1) {
  die(
    modes.length === 0
      ? 'no mode given. Pass exactly one of --print-plan | --dry-run | --publish.'
      : `more than one mode given (${modes.join(' ')}). Pass exactly one.`,
    '  --print-plan  what would be published, from the tree alone (no build, no npm)',
    '  --dry-run     rebuild and pack; npm reports the tarball but contacts no registry',
    '  --publish     rebuild, pack and PUBLISH to the private registry',
  );
}
const MODE = modes[0];
const KEEP_SCOPE = has('--keep-scope');

let selected;
if (has('--all')) {
  selected = PACKAGES;
} else {
  const i = argv.indexOf('--package');
  const wanted = i >= 0 ? argv[i + 1] : undefined;
  if (!wanted || wanted.startsWith('--')) {
    die('give --all, or --package <name>.', `  known: ${PACKAGES.map((p) => p.name).join(', ')}`);
  }
  const hit = PACKAGES.find((p) => p.name === wanted);
  if (!hit) die(`unknown package '${wanted}'.`, `  known: ${PACKAGES.map((p) => p.name).join(', ')}`);
  selected = [hit];
}

// ── helpers ─────────────────────────────────────────────────────────────────
const rootVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

function publishedName(name) {
  if (KEEP_SCOPE) return name;
  const bare = name.slice(name.indexOf('/') + 1);
  return `@${PUBLISH_OWNER}/${bare}`;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', shell: process.platform === 'win32', ...opts });
  if (r.error) die(`${cmd} ${args.join(' ')} could not start: ${r.error.message}`);
  return r;
}

function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(abs));
    else out.push(abs);
  }
  return out;
}

function dirtyPaths(inputs) {
  const r = run('git', ['status', '--porcelain', '--', ...inputs]);
  if (r.status !== 0) die(`git status failed:\n${r.stderr}`);
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

function readToken() {
  const fromEnv = process.env.NODE_AUTH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv) return { token: fromEnv, from: 'environment' };
  const envPath = join(ROOT, '.local', 'github.env');
  if (!existsSync(envPath)) return { token: null, from: null };
  const line = readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('GITHUB_TOKEN='));
  const token = line ? line.slice('GITHUB_TOKEN='.length).trim() : '';
  return token ? { token, from: '.local/github.env' } : { token: null, from: null };
}

// ── plan ────────────────────────────────────────────────────────────────────
const plan = selected.map((pkg) => {
  const manifestPath = join(ROOT, pkg.dir, 'package.json');
  if (!existsSync(manifestPath)) die(`${pkg.dir}/package.json does not exist`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== pkg.name) die(`${pkg.dir}/package.json is named '${manifest.name}', expected '${pkg.name}'`);
  if (manifest.version !== rootVersion) {
    die(
      `${pkg.name} is at ${manifest.version} while the product is at ${rootVersion}.`,
      '  Both packages are on the single product version line (owner 2026-07-29); a tarball',
      '  published off it cannot be compared with the relay it has to agree with.',
      '  Fix: `node scripts/bump-version.mjs <version>` — it moves every face at once.',
    );
  }
  return { ...pkg, manifest, published: publishedName(pkg.name) };
});

console.log(`registry: ${REGISTRY}`);
console.log(`mode:     ${MODE.replace('--', '')}${KEEP_SCOPE ? ' (--keep-scope: publishing under the workspace scope)' : ''}`);
for (const p of plan) {
  console.log(`  ${p.name}  ->  ${p.published}@${p.manifest.version}${p.published === p.name ? '' : '   (scope renamed for GitHub Packages)'}`);
}

if (MODE === '--print-plan') {
  console.log('\nprint-plan: nothing was built, packed, or published.');
  process.exit(0);
}

// ── token ───────────────────────────────────────────────────────────────────
const { token, from } = readToken();
if (MODE === '--publish' && !token) {
  die(
    'no token. --publish needs GITHUB_TOKEN (or NODE_AUTH_TOKEN) in the environment,',
    '  or a GITHUB_TOKEN= line in .local/github.env (gitignored).',
  );
}
console.log(token ? `token:    found (${from})` : 'token:    none — fine for --dry-run, which contacts no registry');

// ── per package ─────────────────────────────────────────────────────────────
const STAGE_ROOT = join(ROOT, '.local', 'publish-staging');

for (const p of plan) {
  console.log(`\n=== ${p.name} ===`);

  if (MODE === '--publish') {
    const dirty = dirtyPaths(p.inputs);
    if (dirty.length > 0) {
      die(
        `${p.name} has uncommitted changes in its own inputs:`,
        ...dirty.map((l) => `    ${l}`),
        '  A published tarball that corresponds to no commit cannot be explained later.',
      );
    }
  }

  // A generated package: a stale generated SOURCE would be baked into dist and
  // the mtime check below would happily call it fresh, because it IS a fresh
  // build of the wrong input.
  if (p.freshness) {
    const r = run(process.execPath, [join(ROOT, p.freshness[0]), ...p.freshness.slice(1)]);
    process.stdout.write(r.stdout);
    if (r.status !== 0) die(r.stderr.trim(), `  ${p.name}'s generated source is stale; run \`pnpm i18n:gen\` and commit.`);
  }

  const distDir = join(ROOT, p.dir, 'dist');
  const buildStart = Date.now();
  const build = run('pnpm', ['--filter', p.name, '--fail-if-no-match', 'build']);
  if (build.status !== 0) die(`build failed for ${p.name}:\n${build.stdout}\n${build.stderr}`);
  if (!existsSync(distDir)) die(`${p.dir}/dist does not exist after a successful build — nothing to publish`);

  // The freshness proof. Not "does dist exist" (a truncated bundle exists just as
  // confidently) but "was every byte of it written by the build we just ran".
  // 2s of slack for filesystem timestamp granularity, no more.
  const built = filesUnder(distDir);
  if (built.length === 0) die(`${p.dir}/dist is empty after a successful build`);
  const stale = built.filter((f) => statSync(f).mtimeMs < buildStart - 2000);
  if (stale.length > 0) {
    die(
      `${p.name}: ${stale.length} file(s) in dist/ predate the build that just ran:`,
      ...stale.slice(0, 10).map((f) => `    ${relative(ROOT, f).replace(/\\/g, '/')}`),
      '  Refusing to publish a bundle this run did not produce.',
    );
  }
  console.log(`built:    ${built.length} file(s) in ${p.dir}/dist, all newer than this run`);

  // ── stage ────────────────────────────────────────────────────────────────
  // Under .local/ (gitignored, and on the repo's own volume — owner 2026-08-18
  // forbids development trees on the system drive and the system temp dir).
  const stage = join(STAGE_ROOT, p.published.replace(/[@/]/g, '_'));
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(distDir, join(stage, 'dist'), { recursive: true });
  for (const extra of ['README.md', 'LICENSE']) {
    const src = join(ROOT, p.dir, extra);
    if (existsSync(src)) cpSync(src, join(stage, extra));
  }

  // The staged manifest is the published one. Scripts and devDependencies are
  // dropped: they name tooling that is not in the tarball, and a `prepare`
  // script inherited into a consumer's install is a whole class of surprise.
  const staged = { ...p.manifest, name: p.published };
  delete staged.scripts;
  delete staged.devDependencies;
  staged.publishConfig = { ...(staged.publishConfig ?? {}), registry: REGISTRY, access: 'restricted' };
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`, 'utf8');

  // `${NODE_AUTH_TOKEN}` verbatim — npm expands it from the environment, so the
  // secret exists only in this process's env and never in any file.
  const scope = p.published.slice(0, p.published.indexOf('/'));
  writeFileSync(
    join(stage, '.npmrc'),
    `${scope}:registry=${REGISTRY}\n${REGISTRY.replace('https:', '')}/:_authToken=\${NODE_AUTH_TOKEN}\n`,
    'utf8',
  );

  const args = ['publish'];
  if (MODE === '--dry-run') args.push('--dry-run');
  const r = run('npm', args, {
    cwd: stage,
    env: { ...process.env, NODE_AUTH_TOKEN: token ?? 'dry-run-no-token' },
  });
  process.stdout.write(r.stdout);
  const scrub = (s) => (token ? s.split(token).join('<token>') : s);
  process.stderr.write(scrub(r.stderr));
  if (r.status !== 0) die(`npm ${args.join(' ')} failed for ${p.published} (exit ${r.status})`);

  console.log(
    MODE === '--dry-run'
      ? `dry run:  ${p.published}@${staged.version} would go to ${REGISTRY}. Nothing was uploaded.`
      : `PUBLISHED ${p.published}@${staged.version} -> ${REGISTRY}`,
  );
}

console.log(
  MODE === '--dry-run'
    ? '\nDry run complete — no package was published.'
    : `\nPublished ${plan.length} package(s).`,
);
