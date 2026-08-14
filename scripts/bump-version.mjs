// Bump every version face in one shot (owner ruling, 2026-07-27).
//
// The rule: EVERY round of changes bumps the patch digit, until the owner calls
// for a minor bump. The reason is 13 册 D5 in its most literal form — three
// rounds of artifacts all stamped 0.1.0 meant「看版本号分不出新旧」and the owner
// had to compare SHA256 by hand to know which MSI they were installing.
//
// Eleven files carry the version and they must move together, or the number stops
// being an identity and becomes a second lie on top of the first. Doing that by
// hand is how faces drift, so this script is the only sanctioned way to do it and
// `verify:lint version-sync` fails the commit if any face disagrees.
// (This count itself has drifted before — trust `pnpm verify:lint`'s reported
// count over this comment; see CLAUDE.md's own warning about stale numbers.)
//
// Usage:
//   node scripts/bump-version.mjs patch      # patch:  0.1.0 -> 0.1.1
//   node scripts/bump-version.mjs minor      # minor:  0.1.4 -> 0.2.0
//   node scripts/bump-version.mjs 0.3.7      # explicit, must be > current
//
// It does NOT rebuild or publish; run the build + scripts/publish.mjs after.
//
// ⚠️ The no-argument form REFUSES (exit 1, writes nothing) — it used to
// silently alias to `patch`, which is exactly the shape of accident that
// bit this repo once: an agent ran the bare command and pushed all nine
// faces to a version nobody asked for. This is a refuse-and-name fix, not a
// confirmation prompt: every shell in this repo is non-interactive with
// stdin at the null device, so a prompt would either read EOF and proceed
// anyway (the same accident with a fig leaf) or hang. The failure mode is an
// unattended tool writing N files, so the fix cannot depend on a human being
// present to answer anything.
//
// 🔴 IT-C1 (2026-08-06): that guard tested `rawArg === undefined`, and `''` is
// not `undefined`. `node scripts/bump-version.mjs "$KIND"` with KIND unset —
// i.e. the careful author who quoted their variable — sailed straight past it
// and silently patch-bumped all eleven faces (measured). The guard now rejects
// on MEANING, not on presence: an argument that is absent, empty, or nothing
// but whitespace are one and the same refusal, because they are one and the
// same accident. Unquoted `$KIND` word-splits to nothing and was already
// caught; quoting it is what defeated the check, and quoting is the thing
// careful script authors do.
//
// 🔴 IT-C1: explicit versions must move FORWARD (numeric, component-wise).
// Before this, `0.2.45` — a plausible typo for `0.2.54` — rewrote all eleven
// faces DOWNWARD and `verify:lint` then reported `11 face(s) @ 0.2.45` PASS,
// because version-sync only asks whether the faces AGREE with root, never
// whether root moved forward. A downgrade survived every gate we have, which
// is precisely the D5 failure the whole version-number discipline exists to prevent. See
// ALLOW_DOWNGRADE below for the one case where going backward is legitimate
// and how it is spelled.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// IT-41 (2026-08-07): FACES' `optional:` notes below used to be self-attesting —
// nothing checked them against scripts/opensource-manifest.mjs's EXCLUDE list.
// verify/golden/requires.mjs already does this correctly for golden's `requires`
// (built for IT-40); ask THAT mechanism rather than re-deriving a second copy of
// "is this path excluded" — same reasoning, same import, as verify/lint/
// version-sync.mjs's identical cross-check.
import { publicExportExclusions, publicExportReplacements, excludedBy } from '../verify/golden/requires.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every face, with the surgical edit each one needs. `find` must match exactly
 *  once — a pattern that matches zero or many times is a drifted file, not a
 *  reason to guess.
 *
 *  `optional` marks a face that is legitimately ABSENT in some tree this very
 *  script runs in, with the reason and the rule that makes it true. See the
 *  ENOENT handling in the plan loop for why the marker exists and what it is
 *  deliberately NOT allowed to become. */
const FACES = [
  { file: 'package.json', find: (v) => new RegExp(`("version":\\s*")${esc(v)}(")`) },
  { file: 'apps/desktop/package.json', find: (v) => new RegExp(`("version":\\s*")${esc(v)}(")`) },
  { file: 'apps/server-core/package.json', find: (v) => new RegExp(`("version":\\s*")${esc(v)}(")`) },
  // 🔴 H6/P2 (0.2.4x): the private `@flowmic/stt-cloud` package. It MUST be here
  // because `verify/lint/version-sync.mjs` DISCOVERS its faces by walking
  // `packages/*` + `apps/*` while this list is HAND-MAINTAINED — the two answer
  // the same question by different means, so a new workspace package is green on
  // the day it is added (it matches root) and turns the gate RED on the very
  // next bump (the lint sees it, this list does not move it). That asymmetry is
  // exactly the drift version-number discipline exists to prevent.
  // ⚠️ Adding any future workspace package under packages/* or apps/* requires a
  // line here too. It is private and never published, but the version still
  // answers 「哪一次交付」, which is the same question for every other face.
  {
    file: 'packages/stt-cloud/package.json',
    find: (v) => new RegExp(`("version":\\s*")${esc(v)}(")`),
    optional: 'EXCLUDEd from the public export tree (packages/stt-cloud/ — private vendor adapters)',
  },
  { file: 'apps/desktop/src-tauri/tauri.conf.json', find: (v) => new RegExp(`("version":\\s*")${esc(v)}(")`) },
  { file: 'apps/mobile/pubspec.yaml', find: (v) => new RegExp(`(^version:\\s*)${esc(v)}(\\s*$)`, 'm') },
  // Not covered by the lint before today — see verify/lint/version-sync.mjs.
  { file: 'apps/desktop/src-tauri/Cargo.toml', find: (v) => new RegExp(`(^version = ")${esc(v)}(")`, 'm') },
  { file: 'apps/server-core/src/bootstrap.ts', find: (v) => new RegExp(`(SERVER_VERSION = ')${esc(v)}(')`) },
  // owner 2026-07-28 (需求⑧): the DOC face. CLAUDE.md's first screen asserts the current
  // version and it had already drifted (said 0.1.1 while root was 0.1.11) — the
  // drift happened inside the very file that declares the version discipline.
  //
  // ONLY the anchored span moves. A global regex over docs would rewrite
  //「押后 0.2」「进 0.1.0」「0.1.0 押后登记」in the decision logs and task cards,
  // and those are HISTORICAL FACTS — falsifying them is worse than drifting.
  { file: 'CLAUDE.md', find: (v) => new RegExp(`(<!--version:current-->)${esc(v)}(<!--/version:current-->)`) },
  // IT-32 (2026-08-06): CLAUDE.public.md carries the SAME anchor syntax as
  // CLAUDE.md but was in neither table — it only became a face AFTER
  // scripts/opensource-manifest.mjs renamed it to CLAUDE.md on export, which
  // meant a public export tree could fail its own version-sync on arrival
  // and nobody in THIS repo would ever see it fail. It had already drifted
  // (anchor said 0.2.53 while root was 0.2.54) before this line existed.
  {
    file: 'CLAUDE.public.md',
    find: (v) => new RegExp(`(<!--version:current-->)${esc(v)}(<!--/version:current-->)`),
    optional: 'EXCLUDEd from the public export tree (it ships AS CLAUDE.md via REPLACE, so it is not there under its own name)',
  },
  // IT-28 (2026-08-06): Cargo.lock also stamps the flowmic-desktop crate
  // version and was in neither table (kept up this round only because a
  // build happened to run).
  // 🔴 IT-C1: what the pattern actually anchors on is the crate's own
  // `name = "flowmic-desktop"` line IMMEDIATELY followed by its `version = "…"`
  // line — the `[[package]]` header is NOT part of the regex (an earlier
  // comment here claimed it was; anti-façade ④). What makes that safe is the
  // pair, not the header: this lockfile has 507 `version = "…"` lines and 507
  // `[[package]]` blocks, and Cargo emits `name` directly above `version` in
  // every one, so the two adjacent lines are unique to this crate — measured,
  // exactly 1 hit of 507. A bare `version = "…"` pattern would match all 507.
  // `apps/desktop/src-tauri/` uses LF line endings throughout (verified), so
  // the literal `\n` here is safe; if that ever changes, or if Cargo ever
  // reorders those fields, the hit-count check below refuses to write rather
  // than mismatch silently — that check, not the comment, is the real guard.
  {
    file: 'apps/desktop/src-tauri/Cargo.lock',
    find: (v) => new RegExp(`(name = "flowmic-desktop"\\nversion = ")${esc(v)}(")`),
  },
];

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Canonical x.y.z only. `00.2.54` passes /^\d+\.\d+\.\d+$/ and used to be
// written verbatim into three package.json files (measured) — a literal that
// is not semver at all. Leading zeros are rejected here, not downstream.
const CANONICAL = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// Anything a human plainly MEANT as a version, so `1.2` / `v1.2.3` / `00.2.54`
// get the version-shaped refusal instead of a generic "unknown argument".
const VERSION_SHAPED = /^v?\d[\d.]*$/i;
const KINDS = new Set(['patch', 'minor', 'major']);
const ALLOW_DOWNGRADE = '--allow-downgrade';

function die(...lines) {
  for (const l of lines) console.error(l);
  console.error('  nothing was written.');
  process.exit(1);
}

/** Numeric, component-wise. NOT string comparison: '0.2.9' > '0.2.10' as
 *  strings, and that is the one comparison this repo will actually hit. */
function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

function readCurrent() {
  // Named, like every other refusal here — root package.json is read before the
  // FACES loop, so an unreadable one used to produce a bare node:fs stack too.
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  } catch (err) {
    die(`✗ cannot read the reference face ${join(ROOT, 'package.json')}: ${err.message}`,
        '  it is the version every other face is compared against.');
  }
  if (typeof pkg.version !== 'string') {
    die('✗ root package.json has no "version" — nothing to bump from.');
  }
  if (!CANONICAL.test(pkg.version)) {
    die(`✗ root package.json version is not a canonical x.y.z: ${pkg.version}`,
        '  fix it by hand first — every comparison below depends on it.');
  }
  return pkg.version;
}

function nextVersion(current, arg) {
  const m = CANONICAL.exec(current);
  const [maj, min, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (arg === 'patch') return `${maj}.${min}.${patch + 1}`;
  if (arg === 'minor') return `${maj}.${min + 1}.0`;
  if (arg === 'major') return `${maj + 1}.0.0`;
  if (CANONICAL.test(arg)) return arg;
  if (VERSION_SHAPED.test(arg)) {
    die(`✗ ${arg} is not a canonical x.y.z version.`,
        '  three components, decimal, no leading zeros, no "v" prefix.',
        '  e.g. 0.2.55 — not v0.2.55, not 0.2, not 00.2.55.');
  }
  die(`✗ unknown argument: ${arg}`,
      '  accepted forms: patch | minor | major | x.y.z (explicit)');
}

// ── argument parsing ────────────────────────────────────────────────────────
// Flags are pulled out first so the positional check below counts only real
// arguments. Extra positionals are refused rather than ignored: silently
// dropping argv[3] is how `bump-version.mjs 0.2.55 --dry-run` would become a
// real write in a shell that does not have that flag.
const argv = process.argv.slice(2);
const allowDowngrade = argv.includes(ALLOW_DOWNGRADE);
const positional = argv.filter((a) => a !== ALLOW_DOWNGRADE);

// 🔴 Absent, empty, and whitespace-only are ONE refusal. See the header note:
// they are the same accident wearing three spellings, and the previous guard
// only recognised the first.
if (positional.length === 0 || positional[0].trim() === '') {
  const shown = positional.length === 0 ? '(no argument)' : JSON.stringify(positional[0]);
  die(`✗ refusing to bump: ${shown} is not a usable argument.`,
      '  accepted forms: patch | minor | major | x.y.z (explicit)',
      '  (an empty or whitespace-only argument is treated exactly like no',
      '   argument — usually an unset shell variable inside quotes.)');
}
if (positional.length > 1) {
  die(`✗ refusing to bump: expected one argument, got ${positional.length} (${positional.join(' ')}).`,
      '  accepted forms: patch | minor | major | x.y.z (explicit)',
      `  the only accepted flag is ${ALLOW_DOWNGRADE}.`);
}

const rawArg = positional[0];
if (allowDowngrade && KINDS.has(rawArg)) {
  die(`✗ ${ALLOW_DOWNGRADE} is meaningless with \`${rawArg}\` — it can only ever go up.`,
      '  that flag is for an explicit x.y.z that is LOWER than the current version.');
}

const current = readCurrent();
const next = nextVersion(current, rawArg);
if (next === current) {
  console.error(`✗ ${next} is already the current version`);
  process.exit(1);
}

// 🔴 The number must move FORWARD. A lower number is not「一轮变更」at all: it
// re-stamps an identity that a previously built artifact already carries, so
// two different binaries end up answering「哪一版」with the same string — the
// D5 failure itself, one level worse than the drift this script prevents.
//
// It stays POSSIBLE, behind a flag that has to be typed, for exactly one case:
// undoing a bump that was never released. That happens (a round gets abandoned,
// or a lane bumps by accident), and the honest repair is to put the number back.
// ⚠️ It is NOT for rolling back a botched release. If anything was ever built,
// published, or installed at the current number, the repair goes FORWARD to a
// new patch — never back onto a number that is already out there.
//
// ⚠️ And the flag is refused when it would do nothing. A no-op flag is how a
// guard gets permanently disarmed: pasted once into a wrapper script or a
// shell history entry, it rides along on every future bump, and the day
// someone typos a lower number there is nothing left to stop it. It has to be
// typed for the one bump it is actually for.
if (allowDowngrade && cmpVersion(next, current) > 0) {
  die(`✗ ${ALLOW_DOWNGRADE} was passed, but ${next} is HIGHER than the current ${current}.`,
      '  the flag does nothing here — remove it.',
      '  it exists for one case only: putting a never-released bump back.');
}
if (cmpVersion(next, current) < 0) {
  if (!allowDowngrade) {
    die(`✗ ${next} is LOWER than the current version ${current}.`,
        '  a version is an identity, not a counter: re-stamping a number that a',
        '  built artifact already carries is the 13 册 D5 failure, and',
        '  `verify:lint version-sync` cannot catch it (it only checks that the',
        '  faces AGREE with root, never that root moved forward).',
        `  if you are undoing a bump that was NEVER released, re-run with ${ALLOW_DOWNGRADE}.`,
        '  if a released version was botched, go FORWARD to a new patch instead.');
  }
  console.log(`⚠ ${ALLOW_DOWNGRADE}: walking ${current} back to ${next}.`);
  console.log('  this is only correct if nothing was ever built or published at');
  console.log(`  ${current}. If something was, stop and bump forward instead.`);
  console.log('');
}

// ── IT-41 cross-check ───────────────────────────────────────────────────────
// Every `optional:` note in FACES, checked against scripts/opensource-manifest.mjs
// BEFORE it is trusted. `exclude` is null when this tree IS the export (the
// manifest does not exist there — requires.mjs property ②), in which case there
// is nothing to check against and this is a no-op, same as before this card.
// CLAUDE.md is a REPLACE destination (CLAUDE.public.md's content lands there) as
// well as an EXCLUDE entry, so it is not really "absent" from the export — only
// its content differs — and an EXCLUDE hit on a REPLACE destination must not
// read as "gone" (measured: without this override, this cross-check FAILED on
// CLAUDE.md the first time it ran, for exactly this reason — same discovery as
// verify/lint/version-sync.mjs's identical comment).
{
  const exclude = await publicExportExclusions();
  if (exclude !== null) {
    const replacements = await publicExportReplacements();
    const isReplaceDest = (file) => replacements.some((r) => r.dest === file);
    for (const face of FACES) {
      // Same shape, same fix, as verify/lint/version-sync.mjs's IT-41 cross-check:
      // `excludedBy(...) && !isReplaceDest(...)` would discard the matched entry
      // (the `&&` returns the trailing boolean, not the object) — kept as the
      // real object here even though this message does not embed hit.path/why,
      // so the two cross-checks stay the same shape rather than silently drifting.
      const excludedHit = excludedBy(face.file, exclude);
      const hit = excludedHit && !isReplaceDest(face.file) ? excludedHit : null;
      if (face.optional && !hit) {
        die(`✗ ${face.file}: carries an \`optional\` note here (${face.optional}) but`,
            '  scripts/opensource-manifest.mjs does NOT exclude it — one of the two is',
            '  wrong (IT-41). The note claims the public export drops this face while the',
            '  manifest ships it; fix the drift instead of trusting an unverified note.');
      }
      if (!face.optional && hit) {
        die(`✗ ${face.file}: is EXCLUDEd from the public export (scripts/opensource-manifest.mjs`,
            `  says so) but this FACES entry has no \`optional\` note (IT-41). An exported`,
            '  tree would ENOENT here forever — add an `optional` note matching the',
            '  exclusion, or drop the entry.');
      }
    }
  }
}

// ── plan ────────────────────────────────────────────────────────────────────
// Verify EVERY face before writing ANY. That guarantee is VALIDATION
// COMPLETENESS, not atomicity: nothing is written until every face has been
// read, matched, and found to hit exactly once, so the whole class of
// "the regex missed face 7" aborts with zero files touched. It is NOT a
// transaction — see the write loop for what happens on an I/O fault.
const planned = [];
const skipped = [];
for (const face of FACES) {
  const path = join(ROOT, face.file);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      die(`✗ ${face.file}: cannot read (${err.code}) — ${err.message}`);
    }
    // 🔴 An absent face is a NAMED, EXPLAINED skip only when this table says
    // ahead of time that it can be absent, and why. Everything else is a hard
    // stop, because from in here "this tree legitimately does not have that
    // file" and "someone deleted a face" look identical — the only difference
    // is that a human decided the first one and wrote it down.
    //
    // So: how does a reader tell the two apart? By the `optional` field, not
    // by the filesystem. You cannot get a silent skip without editing FACES,
    // and editing FACES is a code review. That is the whole mechanism — it
    // keeps "absent ⇒ skip" from quietly becoming "a face stopped being
    // maintained and nobody noticed", which is the failure this guard would
    // otherwise have invented.
    //
    // Today exactly two faces are marked, and both are the same shape: FACES ∩
    // opensource-manifest.mjs's EXCLUDE. This script is itself exported, so in
    // the public tree it runs where those two files do not exist — it used to
    // die there with a raw ENOENT stack trace from node:fs (measured).
    // `verify/lint/version-sync.mjs` already degraded gracefully in that tree;
    // this now matches it.
    if (!face.optional) {
      die(`✗ ${face.file}: face is missing from this tree.`,
          '  it is not marked optional in FACES, so this is drift, not a variant tree:',
          '  either the file was deleted/moved (fix that), or it legitimately does not',
          '  exist here and FACES needs an `optional` note saying so and why.');
    }
    skipped.push({ file: face.file, why: face.optional });
    continue;
  }
  const re = face.find(current);
  const hits = text.match(new RegExp(re.source, re.flags.includes('m') ? 'gm' : 'g'));
  if (!hits || hits.length !== 1) {
    console.error(`✗ ${face.file}: expected exactly one "${current}" version literal, found ${hits ? hits.length : 0}`);
    console.error('  nothing was written — fix that face by hand, then re-run.');
    process.exit(1);
  }
  planned.push({ path, file: face.file, text, re });
}

if (skipped.length) {
  for (const s of skipped) console.log(`— ${s.file}: skipped, absent here (${s.why})`);
  console.log('');
}

// ── write ───────────────────────────────────────────────────────────────────
// 🔴 Not transactional, and the comment above deliberately does not claim it
// is. Every new file body is already computed before the first write, but an
// EACCES/EBUSY/ENOSPC on face 7 of 11 still leaves the tree half-moved.
// Ruling (IT-C1): full atomicity across 11 files would need write-to-temp +
// rename-all, and rename can fail partway too — real complexity bought against
// a low-probability fault whose DETECTION is already covered (`verify:lint
// version-sync` screams at a half-moved tree). What was actually missing is
// RECOVERY INFORMATION, so that is what this does: name every face that moved,
// put the originals back on a best effort, and say plainly which restores
// themselves failed. A restore that fails is reported, never swallowed.
const writtenBack = [];
try {
  for (const p of planned) {
    writeFileSync(p.path, p.text.replace(p.re, `$1${next}$2`));
    writtenBack.push(p);
    console.log(`✓ ${p.file}`);
  }
} catch (err) {
  console.error(`\n✗ write failed on ${planned[writtenBack.length]?.file ?? '(unknown face)'}: ${err.code || ''} ${err.message}`);
  console.error(`  ${writtenBack.length} of ${planned.length} faces had already been written to ${next}.`);
  const failedRestores = [];
  for (const p of writtenBack) {
    try {
      writeFileSync(p.path, p.text);
    } catch (rerr) {
      failedRestores.push(`${p.file} (${rerr.code || rerr.message})`);
    }
  }
  if (failedRestores.length === 0) {
    console.error(`  all ${writtenBack.length} were restored to ${current}; the tree is back where it started.`);
  } else {
    console.error(`  🔴 ${failedRestores.length} could NOT be restored and are still at ${next}:`);
    for (const f of failedRestores) console.error(`     ${f}`);
    console.error(`  fix those by hand back to ${current}, then re-run. \`pnpm verify:lint\` will confirm.`);
  }
  process.exit(1);
}

const skipNote = skipped.length ? ` (${skipped.length} skipped: ${skipped.map((s) => s.file).join(', ')})` : '';
console.log(`\n${current} → ${next}  (${planned.length} faces${skipNote})`);
console.log('next: rebuild, then `node scripts/publish.mjs`');
// Owner 2026-07-29: web repo shares the same version line. Remind only on the
// success path — a failed bump must not tell anyone to sync a version that was
// never written.
//
// 🔴 IT-C1: this used to print a hardcoded absolute path to the web repo. That
// path is machine-specific — CLAUDE.md's own correction block records that it
// is false on at least one of the two dev machines, and rules that no absolute
// path written in that file may be relied on: 「两仓路径一律自己 pwd /
// git rev-parse --show-toplevel 去问」. So ask, don't assert. The web repo
// already converted its own counterparts to relative derivation. If the sibling
// checkout is not there, say nothing about where it is rather than guess.
const webRepo = join(ROOT, '..', 'flowmic-web-private');
console.log('');
console.log('web repo shares the same version line (owner 2026-07-29 ruling):');
console.log(`  cd ${existsSync(webRepo) ? webRepo : '<your private web repo checkout>'}`);
console.log(`  node scripts/bump-version.mjs ${next}`);
console.log('  ↑ must be an explicit version, not patch — each repo patching on its own will drift apart again.');
console.log('');
console.log('three gates before delivery: pnpm verify:delivery (= lint + types + golden)');
