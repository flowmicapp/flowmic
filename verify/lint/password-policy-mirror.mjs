// verify/lint/password-policy-mirror.mjs
// A4-3 — the password policy's two numbers exist twice, in two git repos, and
// this pins them equal.
//
// SPEC-REF: docs/decisions/2026-08-12-password-policy-medium-complexity.md §3
//           ("why there must be a cross-repo lint (rather than 'sharing one package')")
//
// 🔴 UPDATED — CARD PW-1 (2026-09-08): the two numbers' SSOT moved. It is no
// longer `apps/server-core/src/auth/password-policy.ts` — it is
// `packages/protocol/src/constants.ts`. A THIRD repo (the web CLIENT, separate
// from both server-core and `@flowmic/web`) needed the same two numbers, and
// "declared once in server-core" stopped being true the moment a second
// monorepo-external consumer showed up; password-policy.ts now IMPORTS and
// re-exports them instead of declaring literals. Everything below this note
// that talks about the numbers living in password-policy.ts is HISTORY — it
// describes A4-3's shape, not today's — except the parts explicitly called out
// as still true. Two things changed in what THIS lint checks:
//   (1) the in-repo half now reads the literal from `packages/protocol/src/
//       constants.ts`, not from password-policy.ts (see `PROTOCOL_FILE`
//       below), and separately asserts password-policy.ts carries NO
//       competing local literal for either name — only an import;
//   (2) the cross-repo half (against `@flowmic/web`) is UNCHANGED in every
//       other respect: same anchor/required rules, same "NUMBERS ONLY, not
//       the measure or the class regexes" ceiling, same reason it lives here
//       and not as "sharing one package".
// The web CLIENT (the third repo) is NOT covered by this lint — it is not a
// hand-copy, it can and does import `@flowmic/protocol` directly, so there is
// nothing here for a mirror lint to pin.
//
// ── WHAT THE PROBLEM ACTUALLY IS ───────────────────────────────────────────
// The console/web front end is a SEPARATE REPO (`@flowmic/web`). It shows the
// user the password rules WHILE THEY TYPE (the owner's ruling: "the user needs
// to know this rule while they type"), which means it must know the rules locally — it cannot
// wait for a 400 to find out. It cannot import `apps/server-core`, so the two
// numbers are typed in a second time by hand:
//
//   MIN_PASSWORD_LENGTH     8  apps/server-core/src/auth/password-policy.ts
//                           8  @flowmic/web (hand-written)
//   MAX_PASSWORD_LENGTH    32  apps/server-core/src/auth/password-policy.ts
//                          32  @flowmic/web (hand-written)
//
// The failure this catches: someone raises the server minimum, the web form
// keeps drawing "at least 8 characters" and keeps reporting "satisfied" for a password the
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
import { execFileSync } from 'node:child_process';
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
const PROTOCOL_PKG_NAME = '@flowmic/protocol';

/** `MIN_PASSWORD_CLASSES` (not moved by PW-1 — see MIRRORS below) is still
 *  declared, and read, here. Repo-relative. */
const POLICY_FILE = 'apps/server-core/src/auth/password-policy.ts';

/** `MIN_PASSWORD_LENGTH` / `MAX_PASSWORD_LENGTH`'s SSOT since card PW-1
 *  (2026-09-08) — moved out of POLICY_FILE because a THIRD repo (the web
 *  client) needed the same two numbers and could not import server-core
 *  either. Repo-relative. */
const PROTOCOL_FILE = 'packages/protocol/src/constants.ts';

/** `MAX_ORIGINS`'s SSOT — a plain literal declared and used only inside this
 *  one route file, unrelated to the password-policy pair above. It landed in
 *  MIRRORS because this lint's cross-repo sweep (below) is what caught the
 *  web side's hand-copy of it in the first place: the sweep does not care
 *  what topic a constant belongs to, only that its name collides with a
 *  server-core declaration and was not registered. Repo-relative. */
const CONSOLE_INTEGRATOR_FILE = 'apps/server-core/src/http/console-integrator-routes.ts';

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
 * `source`  — which file this lint reads the SSOT literal from. PW-1 moved
 *             only the two `required` numbers to PROTOCOL_FILE; the pair the
 *             `@flowmic/web` mirror is obligated to match now lives there, not
 *             in POLICY_FILE. MIN_PASSWORD_CLASSES was left in POLICY_FILE —
 *             nobody hand-copies it, so there was nothing to fix by moving it.
 */
const MIRRORS = [
  { decl: 'MIN_PASSWORD_LENGTH', anchor: true, required: true, source: PROTOCOL_FILE },
  { decl: 'MAX_PASSWORD_LENGTH', anchor: false, required: true, source: PROTOCOL_FILE },
  { decl: 'MIN_PASSWORD_CLASSES', anchor: false, required: false, source: POLICY_FILE },
  // Registered by the sweep, not by the password ruling: @flowmic/web's
  // WebsiteVoiceView.vue hand-copies the console integrator's site-count cap
  // as a COURTESY message-only number (the server still refuses on its own),
  // which is why it is `required: false` like MIN_PASSWORD_CLASSES above.
  { decl: 'MAX_ORIGINS', anchor: false, required: false, source: CONSOLE_INTEGRATOR_FILE },
  // Same file, same reason: WebsiteVoiceView.vue also hand-copies the label
  // length cap (card MP-13/CON-2) as a courtesy client-side check — the
  // server still refuses on its own. `required: false` for the same reason
  // as MAX_ORIGINS above.
  { decl: 'MAX_LABEL_CHARS', anchor: false, required: false, source: CONSOLE_INTEGRATOR_FILE },
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
 * CARD PW-1. `true` iff `text` has a
 * `import { …, constName, … } from '@flowmic/protocol'` (or `import type`)
 * statement naming `constName` as a bare specifier (an `as`-aliased import
 * does not count — the re-export below relies on the name matching exactly).
 * Deliberately does not care how many other names share the statement, or
 * whether there are several such statements — POLICY_FILE already imports
 * other protocol types elsewhere and this must not require the two names to
 * be the only ones on their line.
 */
function importsFromProtocol(text, constName) {
  const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@flowmic\/protocol['"]\s*;?/g;
  let m;
  while ((m = re.exec(text))) {
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim());
    if (names.includes(constName)) return true;
  }
  return false;
}

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

  // 🔴 SEARCH THE MAIN WORKTREE'S NEIGHBOURHOOD TOO, NOT JUST THIS ONE'S.
  //
  // Measured 2026-08-29: run from a linked worktree — which is how both active
  // windows work — this scan looked at `<repo>-worktrees/` and found only other
  // worktrees, so it reported 「no sibling declares itself」 and SKIPPED. A skip
  // prints in the summary line beside the passes ("30 pass / 3 skip / 0 fail"),
  // so every gate run from a worktree had this check silently disarmed while
  // reading green. Pointing FLOWMIC_WEB_REPO at the repo by hand made the same
  // check run and PASS, which is what proved the skip was an artefact of where
  // it was run rather than a fact about the tree.
  //
  // That is this repo's favourite shape: a check answering 「I could not look」
  // in a way that reads like 「I looked and it is fine」. The fix is to look
  // where the answer actually is — a linked worktree knows its main worktree
  // through git, and the sibling we want is beside THAT.
  const searchRoots = [path.dirname(ROOT)];
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // <main-worktree>/.git → the main worktree is its parent, and the repos we
    // mirror sit beside that.
    if (commonDir) {
      const mainParent = path.dirname(path.dirname(commonDir));
      if (mainParent && !searchRoots.includes(mainParent)) searchRoots.push(mainParent);
    }
  } catch {
    // Not a git checkout, or no git on PATH. The sibling scan below still runs;
    // this only ever ADDS a place to look.
  }

  const entriesByRoot = [];
  for (const parent of searchRoots) {
    try {
      entriesByRoot.push([parent, await fsp.readdir(parent, { withFileTypes: true })]);
    } catch {
      /* unreadable root — the others may still answer */
    }
  }
  if (entriesByRoot.length === 0) {
    return { reason: 'cannot read the directory containing this repo' };
  }
  const entries = entriesByRoot.flatMap(([, e]) => e);

  const hits = [];
  for (const [parent, list] of entriesByRoot) for (const e of list) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(parent, e.name);
    const pkg = await readJson(path.join(dir, 'package.json'));
    if (pkg?.name === WEB_PKG_NAME) hits.push({ dir, base: e.name });
  }

  if (hits.length === 0) {
    return { reason: `no sibling directory declares itself ${WEB_PKG_NAME} (${entries.length} checked)` };
  }
  const unique = [...new Map(hits.map((h) => [path.resolve(h.dir), h])).values()];
  hits.length = 0;
  hits.push(...unique);
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
  // ── in-repo half: each MIRROR's `source` file must carry a plain named
  //    integer literal for it (unchanged shape from before PW-1 — only WHERE
  //    two of the three now live has changed; see MIRRORS' `source` field). ──
  const policyText = await readText(path.join(ROOT, POLICY_FILE));
  if (policyText === null) {
    return {
      status: 'FAIL',
      detail: `${POLICY_FILE} is missing — it declares MIN_PASSWORD_CLASSES and must import the two protocol constants`,
    };
  }
  const protocolText = await readText(path.join(ROOT, PROTOCOL_FILE));
  if (protocolText === null) {
    return {
      status: 'FAIL',
      detail: `${PROTOCOL_FILE} is missing — it is the SSOT for MIN_PASSWORD_LENGTH / MAX_PASSWORD_LENGTH since card PW-1`,
    };
  }
  const consoleIntegratorText = await readText(path.join(ROOT, CONSOLE_INTEGRATOR_FILE));
  if (consoleIntegratorText === null) {
    return {
      status: 'FAIL',
      detail: `${CONSOLE_INTEGRATOR_FILE} is missing — it is the SSOT for MAX_ORIGINS`,
    };
  }
  const textBySource = {
    [POLICY_FILE]: policyText,
    [PROTOCOL_FILE]: protocolText,
    [CONSOLE_INTEGRATOR_FILE]: consoleIntegratorText,
  };

  const ssot = new Map();
  for (const m of MIRRORS) {
    const sourceText = textBySource[m.source];
    const hit = declRe(m.decl).exec(sourceText);
    if (!hit) {
      if (!m.required) continue; // an optional constant may legitimately not exist
      return {
        status: 'FAIL',
        detail:
          `${m.decl} is no longer declared as a plain integer literal in ${m.source}. ` +
          'Renamed, moved, or computed — either way the mirror registered against it would ' +
          'now be compared against nothing and this lint would go green while covering zero. ' +
          'Update MIRRORS in verify/lint/password-policy-mirror.mjs.',
      };
    }
    ssot.set(m.decl, Number(hit[1]));
  }

  // 🔴 PW-1's actual point: POLICY_FILE must not grow a SECOND, competing
  // literal for a constant whose SSOT moved to PROTOCOL_FILE — that would be
  // the exact drift this move exists to make impossible (two numbers, two
  // authors, one of them silent). It must instead import the name from
  // `@flowmic/protocol`. Both directions are checked; either failing alone
  // means server-core's own two numbers could disagree with each other before
  // the web mirror even enters the picture.
  for (const m of MIRRORS.filter((x) => x.source === PROTOCOL_FILE)) {
    if (declRe(m.decl).test(policyText)) {
      return {
        status: 'FAIL',
        detail:
          `${POLICY_FILE} declares its OWN literal for \`${m.decl}\` again, alongside the SSOT in ` +
          `${PROTOCOL_FILE} — exactly the two-authors-one-number shape card PW-1 moved this constant ` +
          `to stop. Import it from ${PROTOCOL_PKG_NAME} instead of re-declaring it.`,
      };
    }
    if (!importsFromProtocol(policyText, m.decl)) {
      return {
        status: 'FAIL',
        detail:
          `${POLICY_FILE} neither declares nor imports \`${m.decl}\` from ${PROTOCOL_PKG_NAME} — its ` +
          `SSOT is ${PROTOCOL_FILE} (=${ssot.get(m.decl)}) and nothing in ${POLICY_FILE} reads it, so ` +
          `every consumer of ./password-policy for this name (auth-service.ts's callers, ` +
          'test/password-policy.test.ts, test/registration-email-code.test.ts) would be undefined.',
      };
    }
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
            `${m.source} says ${m.decl}=${ssot.get(m.decl)}; the web side is enforcing a policy ` +
            'made of one number from this repo and one from somewhere else.'
        );
      }
      continue;
    }
    if (!ssot.has(m.decl)) {
      problems.push(
        `${label}:${sites[0].file}:${sites[0].line} declares \`${m.decl}\` but ${m.source} no longer ` +
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
        `${label}:${sites[0].file}:${sites[0].line} ${m.decl}=${sites[0].value} but ${m.source} ` +
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
      `${compared} mirror(s) agree with ${ssot.size} SSOT constant(s) (${PROTOCOL_FILE} + ${POLICY_FILE}); ` +
      `confirmed ${POLICY_FILE} imports rather than re-declares the ${PROTOCOL_FILE} pair; ` +
      `swept ${webConsts.size} ${WEB_PKG_NAME} constant(s) / ${serverConsts.size} server constant(s) ` +
      'for unregistered copies. NUMBERS ONLY — the code-point measure and the class regexes are ' +
      'pinned by the shared vector table (apps/server-core/test/password-policy.test.ts), not here.',
  };
}
