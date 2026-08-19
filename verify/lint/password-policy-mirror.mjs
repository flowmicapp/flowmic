// verify/lint/password-policy-mirror.mjs
// A4-3 — the password policy's two numbers exist twice, in two git repos, and
// this pins them equal.
//
// SPEC-REF: docs/decisions/2026-08-12-password-policy-medium-complexity.md §3
//           ("why there must be a cross-repo lint (rather than 'sharing one package')")
//
// ── WHAT THE PROBLEM ACTUALLY IS ───────────────────────────────────────────
// The console/web front end is a SEPARATE REPO (`@flowmic/web`). It shows the
// user the password rules WHILE THEY TYPE (the owner's ruling: "the user needs
// to know this rule while they type"), which means it must know the rules locally — it cannot
// wait for a 400 to find out. It cannot import `apps/server-core`, so the two
// numbers are typed in a second time by hand:
//
//   MIN_PASSWORD_LENGTH    10  apps/server-core/src/auth/password-policy.ts
//                          10  @flowmic/web (hand-written)
//   MAX_PASSWORD_LENGTH    32  apps/server-core/src/auth/password-policy.ts
//                          32  @flowmic/web (hand-written)
//
// The failure this catches: someone raises the server minimum, the web form
// keeps drawing "at least 10 characters" and keeps reporting "satisfied" for a password the
// server is about to refuse. The user is told they satisfied a rule and then
// refused for breaking it, and no test in either repo is looking at both.
//
// ── 🔴 WHAT THIS LINT DOES *NOT* PROVE — READ THIS BEFORE TRUSTING A GREEN ─
// It compares NUMBERS. It cannot see:
//   · which length measure either side used (CODE POINTS here — `[...pw].length`
//     — vs UTF-16 `.length`. Both are integers named the same thing; the
//     disagreement is invisible to any regex);
//   · the character-class regexes (`\p{L}` / `\p{N}` / other);
//   · the order the rules are evaluated in, which decides WHICH refusal the
//     user reads for a password that breaks two rules at once.
// Every one of those can drift with this lint green. Ruling §3 says so in as
// many words: "do not read a green lint as 'both sides' rules match' — it only answers 'those few numbers are the same'".
// The half this lint cannot carry is carried by the SHARED VECTOR TABLE, run
// once in each repo (here: apps/server-core/test/password-policy.test.ts,
// ruling §4-1). If you change a rule, changing this lint is not enough.
//
// ── DIVISION OF LABOUR WITH C9 (admin-limit-mirror.mjs) ────────────────────
// Two mirror lints now exist and they own DIFFERENT REPOS. Stated here and in
// C9's header so neither one is read as covering the other:
//   · admin-limit-mirror  → `@flowmic/admin`  (ops console limit constants)
//   · password-policy-mirror → `@flowmic/web` (this file)
// Neither scans the other's repo. Before A4-3, C9's PASS line ended with the
// words 「web repo declares no numeric mirrors (not scanned)」 — a FROZEN
// measurement printed as if it were a live one, which would have gone silently
// false the moment the web half of A4-3 landed. C9 would NOT have gone red:
// it never opens the web repo at all. That sentence is corrected in place, and
// the web repo is now genuinely scanned — by this lint, which owns it.
//
// ── HOW THE OTHER REPO IS LOCATED (and why not by path) ────────────────────
// Same rule as C9, for the same reason: CLAUDE.md forbids baking an absolute
// path into this repo's source, because the checkouts HAVE already diverged
// across machines (F:\flowmic\ and F:\vibecoding-project\ have each been the
// right answer on some box; a third layout spelled the legal entity, and that
// spelling is deliberately NOT repeated here — `corp-absolute-path` in
// scripts/opensource-manifest.mjs is a REQUIRE_ABSENT hard block that stops the
// public export on it, as it did on 2026-08-12). The web repo is found BY IDENTITY — each
// sibling directory is asked what its package.json calls itself.
// `FLOWMIC_WEB_REPO` overrides: an absolute path from the ENVIRONMENT is fine,
// an absolute path in the SOURCE is not. Messages print `@flowmic/web:src/…`,
// never a machine path.
//
// ── WHY THE WEB SIDE IS SEARCHED BY NAME, NOT AT A REGISTERED PATH ─────────
// C9 registers `src/lib/api.ts` and looks there. This lint searches the whole of
// `src/` for the declaration instead, and that difference is deliberate: the web
// half of A4-3 is being written concurrently with this file, so its filename is
// not knowable here. Registering a guessed path would produce a FAIL that says
// 「the mirror is missing」 when the mirror exists one directory over — an
// accusation this lint cannot support. Searching by name also catches the worse
// case a fixed path would miss: the SAME constant declared in TWO places on the
// web side, which is a drift already in progress.
//
// ── 🔴 THE SKIP, AND THE HOLE IT LEAVES, SAID OUT LOUD ─────────────────────
// When the web repo is not beside this one (CI, a fresh clone, the public export
// tree), the cross-repo half CANNOT run. It reports SKIP WITH THE COUNT IT DID
// NOT COMPARE — never PASS. A green line whose name says "mirror" while it
// compared zero mirrors is the exact façade this repo keeps paying for.
// The in-repo half still runs first and can still FAIL on its own.
//
// The same SKIP is returned when the web repo IS present but declares NONE of
// these constants — which today means 「the web half has not landed yet」. The
// hole: that is indistinguishable from 「someone deleted the whole mirror」.
// It is narrowed rather than closed, by the ANCHOR rule below — once the web
// side declares MIN_PASSWORD_LENGTH, every other registered constant becomes
// REQUIRED, so dropping one of them is a FAIL rather than a quiet relapse to
// SKIP. Only wholesale deletion of every password constant returns to SKIP, and
// that is a much louder act than deleting one line. There is no manual 「the web
// half has landed」 flag anywhere in this file on purpose: a flag someone has to
// remember to flip is a gate that is off.

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { ROOT, walk, readText, readJson, lineOf, DEFAULT_SKIP_DIRS } from './_util.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/password-policy-mirror.mjs` evaluates this module and exits 0 without
// checking anything -- a silence indistinguishable from a pass (it was written
// down as one twice; see the guard's header). platform-cfg-count carried this
// alone since 2026-08-10; every registered lint carries it since 2026-08-19.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'password-policy-mirror';

const WEB_PKG_NAME = '@flowmic/web';

/** The server-side declaration for every constant below. Repo-relative. */
const POLICY_FILE = 'apps/server-core/src/auth/password-policy.ts';

/**
 * The registry of mirrors. A constant is listed here because someone WROTE a
 * copy of it (or, for the two `required` ones, because the ruling names them as
 * the pair the web side must carry) — never because one 「should」 exist. That is
 * C9's doctrine ② and it is what keeps a lint from conjuring dead constants into
 * the other repo.
 *
 * `anchor`  — its presence on the web side means 「the mirror exists」, which
 *             promotes every `required` entry from optional to mandatory.
 * `required`— once the anchor is present, absence is a FAIL.
 *             MIN_PASSWORD_CLASSES is NOT required: the server names it, the web
 *             side may or may not hand-copy it, and demanding it would be
 *             demanding a constant nobody wrote. It is listed only so that a web
 *             copy of it is COMPARED rather than reported as unregistered.
 */
const MIRRORS = [
  { decl: 'MIN_PASSWORD_LENGTH', anchor: true, required: true },
  { decl: 'MAX_PASSWORD_LENGTH', anchor: false, required: true },
  { decl: 'MIN_PASSWORD_CLASSES', anchor: false, required: false },
];

/** `const NAME = <int>;` / `export const NAME = <int>;`, optionally `: number`.
 *  Same shape C9 uses — a plain named integer literal and nothing else. */
function declRe(constName) {
  return new RegExp(
    `^[ \\t]*(?:export[ \\t]+)?const[ \\t]+${constName}[ \\t]*(?::[ \\t]*number[ \\t]*)?=[ \\t]*(\\d+)[ \\t]*;`,
    'm'
  );
}

/** Same shape, sweeping every integer constant in a file. */
const ANY_DECL_RE = /^[ \t]*(?:export[ \t]+)?const[ \t]+([A-Z][A-Z0-9_]*)[ \t]*(?::[ \t]*number[ \t]*)?=[ \t]*(\d+)[ \t]*;/gm;

/**
 * A `.vue` SFC is not JavaScript. Reduce it to its `<script>` blocks before any
 * JS-shaped matching, so an HTML comment or an apostrophe in template prose is
 * never read as code. (Verbatim reasoning from C9 — the web repo is Vue, so this
 * matters more here than it did there.)
 */
function scriptSource(abs, text) {
  if (!abs.endsWith('.vue')) return text;
  const blocks = [];
  const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(text))) blocks.push(m[1]);
  return blocks.join('\n');
}

/** Every integer constant declared under `srcDir`, as name -> [{file,value,line}].
 *  `repoRoot` is what paths are reported relative to, NOT `srcDir` — C9 learned
 *  that the hard way (a sweep reporting `lib/api.ts` failed to match its own
 *  registry of `src/lib/api.ts` and accused every registered mirror of being
 *  unregistered). */
async function sweepConstants(repoRoot, srcDir, exts) {
  const found = new Map();
  for (const abs of await walk(srcDir, { skipDir: (b) => DEFAULT_SKIP_DIRS.has(b) })) {
    if (!exts.some((e) => abs.endsWith(e))) continue;
    // Test files declare fixtures, not mirrors. A vector table in a *.test.ts
    // that happens to name a constant is not a second copy of the policy.
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(abs)) continue;
    const raw = await readText(abs);
    if (raw === null) continue;
    const text = scriptSource(abs, raw);
    let m;
    ANY_DECL_RE.lastIndex = 0;
    while ((m = ANY_DECL_RE.exec(text))) {
      const file = path.relative(repoRoot, abs).split(path.sep).join('/');
      if (!found.has(m[1])) found.set(m[1], []);
      found.get(m[1]).push({ file, value: Number(m[2]), line: lineOf(text, m.index) });
    }
  }
  return found;
}

/**
 * The web repo's root, found by asking each directory beside this one what it
 * calls itself. Returns `{ dir }`, or `{ reason }` explaining what was looked at
 * and found — the caller prints that reason rather than going quietly green.
 */
async function findWebRepo() {
  const override = process.env.FLOWMIC_WEB_REPO;
  if (override) {
    const pkg = await readJson(path.join(override, 'package.json'));
    if (pkg?.name === WEB_PKG_NAME) return { dir: override };
    return {
      reason:
        `FLOWMIC_WEB_REPO is set but does not point at ${WEB_PKG_NAME} ` +
        `(package.json name = ${pkg?.name ? `"${pkg.name}"` : 'unreadable'})`,
    };
  }

  const parent = path.dirname(ROOT);
  let entries;
  try {
    entries = await fsp.readdir(parent, { withFileTypes: true });
  } catch {
    return { reason: 'cannot read the directory containing this repo' };
  }

  const hits = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(parent, e.name);
    const pkg = await readJson(path.join(dir, 'package.json'));
    if (pkg?.name === WEB_PKG_NAME) hits.push({ dir, base: e.name });
  }

  if (hits.length === 0) {
    return { reason: `no sibling directory declares itself ${WEB_PKG_NAME} (${entries.length} checked)` };
  }
  if (hits.length > 1) {
    // More than one sibling declares the same package name (e.g. an extra
    // worktree beside the checkout) — ambiguous by design, not guessed at.
    return {
      reason:
        `${hits.length} sibling directories declare themselves ${WEB_PKG_NAME} ` +
        `(${hits.map((h) => h.base).join(', ')}) — set FLOWMIC_WEB_REPO to pick one`,
    };
  }
  return { dir: hits[0].dir };
}

export default async function run() {
  // ── in-repo half: the policy must still be plain named integer literals ────
  const policyText = await readText(path.join(ROOT, POLICY_FILE));
  if (policyText === null) {
    return {
      status: 'FAIL',
      detail: `${POLICY_FILE} is missing — it declares the password policy every mirror is compared against`,
    };
  }

  const ssot = new Map();
  for (const m of MIRRORS) {
    const hit = declRe(m.decl).exec(policyText);
    if (!hit) {
      if (!m.required) continue; // an optional constant may legitimately not exist
      return {
        status: 'FAIL',
        detail:
          `${m.decl} is no longer declared as a plain integer literal in ${POLICY_FILE}. ` +
          'Renamed, moved, or computed — either way the mirror registered against it would ' +
          'now be compared against nothing and this lint would go green while covering zero. ' +
          'Update MIRRORS in verify/lint/password-policy-mirror.mjs.',
      };
    }
    ssot.set(m.decl, Number(hit[1]));
  }

  const inRepoNote = `${ssot.size} server constant(s) verified in-repo`;
  const webRepo = await findWebRepo();
  if (!webRepo.dir) {
    return {
      status: 'SKIP',
      detail: `${inRepoNote}; ${MIRRORS.length} mirror(s) NOT compared — ${webRepo.reason}`,
    };
  }

  // ── cross-repo half ───────────────────────────────────────────────────────
  const webSrc = path.join(webRepo.dir, 'src');
  const webConsts = await sweepConstants(webRepo.dir, webSrc, ['.ts', '.vue', '.js']);
  const anchorName = MIRRORS.find((m) => m.anchor).decl;

  if (!webConsts.has(anchorName)) {
    // Not landed yet, or removed wholesale. Either way nothing was compared, and
    // saying PASS here would be the façade this file exists to avoid.
    const known = MIRRORS.filter((m) => ssot.has(m.decl)).length;
    return {
      status: 'SKIP',
      detail:
        `${inRepoNote}; ${known} mirror(s) NOT compared — ${WEB_PKG_NAME} declares no ${anchorName} ` +
        `under src/ (${webConsts.size} integer constant(s) found there). Either the web half of A4-3 ` +
        'has not landed, or the mirror was removed; this lint cannot tell those apart and does not guess.',
    };
  }

  const problems = [];
  let compared = 0;

  for (const m of MIRRORS) {
    const sites = webConsts.get(m.decl);
    const label = `${WEB_PKG_NAME}`;
    if (!sites) {
      if (m.required) {
        problems.push(
          `${label} declares ${anchorName} but NOT \`${m.decl}\` — a half-landed mirror. ` +
            `${POLICY_FILE} says ${m.decl}=${ssot.get(m.decl)}; the web side is enforcing a policy ` +
            'made of one number from this repo and one from somewhere else.'
        );
      }
      continue;
    }
    if (!ssot.has(m.decl)) {
      problems.push(
        `${label}:${sites[0].file}:${sites[0].line} declares \`${m.decl}\` but ${POLICY_FILE} no longer ` +
          'does — the mirror outlived the thing it mirrors.'
      );
      continue;
    }
    if (sites.length > 1) {
      problems.push(
        `${label} declares \`${m.decl}\` in ${sites.length} places ` +
          `(${sites.map((s) => `${s.file}:${s.line}=${s.value}`).join(', ')}) — ` +
          'two copies on one side is drift already in progress, whatever they currently say.'
      );
      continue;
    }
    compared++;
    const expected = ssot.get(m.decl);
    if (sites[0].value !== expected) {
      problems.push(
        `${label}:${sites[0].file}:${sites[0].line} ${m.decl}=${sites[0].value} but ${POLICY_FILE} ` +
          `says ${m.decl}=${expected} — the form and the server disagree about what it will accept`
      );
    }
  }

  // ── sweep: a NEW hand-copy must be registered, not merely present ──────────
  // This is the half that makes 「the web repo is scanned」 true. C9 owns
  // @flowmic/admin and never opens this repo; this lint owns @flowmic/web.
  const serverConsts = await sweepConstants(ROOT, path.join(ROOT, 'apps/server-core/src'), ['.ts']);
  const registered = new Set(MIRRORS.map((m) => m.decl));
  for (const [constName, sites] of webConsts) {
    if (registered.has(constName)) continue;
    if (!serverConsts.has(constName)) continue;
    const where = serverConsts.get(constName).map((s) => `${s.file}=${s.value}`);
    problems.push(
      `${WEB_PKG_NAME}:${sites[0].file}:${sites[0].line} declares \`${constName}=${sites[0].value}\`, a name ` +
        `server-core also declares (${where.join(', ')}), but it is not registered in MIRRORS — a new ` +
        'hand-copy nobody is watching. Register it (or rename it if it is unrelated).'
    );
  }

  if (problems.length > 0) {
    return { status: 'FAIL', detail: problems.join(' | ') };
  }

  return {
    status: 'PASS',
    detail:
      `${compared} mirror(s) agree with ${ssot.size} server constant(s) in ${POLICY_FILE}; ` +
      `swept ${webConsts.size} ${WEB_PKG_NAME} constant(s) / ${serverConsts.size} server constant(s) ` +
      'for unregistered copies. NUMBERS ONLY — the code-point measure and the class regexes are ' +
      'pinned by the shared vector table (apps/server-core/test/password-policy.test.ts), not here.',
  };
}
