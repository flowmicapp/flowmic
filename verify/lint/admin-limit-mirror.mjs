// verify/lint/admin-limit-mirror.mjs
// C9 — the admin console's hand-copied limit constants must not drift from the
// server constants they mirror.
//
// ── WHAT THE PROBLEM ACTUALLY IS (measured 2026-08-11, not assumed) ─────────
// The ops/admin console is a SEPARATE REPO (`@flowmic/admin`). It cannot import
// from `apps/server-core`, so three server constants exist there a second time,
// typed in by hand:
//
//   EVENTS_MAX_LIMIT      100  apps/server-core/src/http/console-routes.ts
//                         100  @flowmic/admin:src/lib/api.ts
//   AUDIT_RECENT_DEFAULT   50  apps/server-core/src/http/ops-routes.ts
//                          50  @flowmic/admin:src/lib/api.ts
//   AUDIT_RECENT_MAX      500  apps/server-core/src/http/ops-routes.ts
//                         500  @flowmic/admin:src/lib/api.ts
//
// Measured intersection at the time this lint was written: server-core/src
// declares 85 integer constants, the admin repo declares 5, and EXACTLY these
// three names occur in both. The web repo (`@flowmic/web`) declares ZERO
// integer constants and therefore mirrors nothing — it is not scanned, and that
// is a measurement, not an assumption.
//
// ── 🔴 CORRECTION 2026-08-12 (A4-3). THE PARAGRAPH ABOVE IS DATED, NOT WRONG ─
// It is kept verbatim because it was true when it was written (re-measured
// 2026-08-12 on dev-pc-a before this note: admin 5, web 0, server-core 85
// — still exact). What makes it dangerous is not that it is false, but the
// sentence it licenses: 「the web repo … is not scanned, and that is a
// measurement」. That measurement is FROZEN — nothing at runtime re-takes it.
// It is also printed, verbatim, in this lint's PASS line.
//
// Card A4-3 gives `@flowmic/web` two hand-written integer constants
// (MIN_PASSWORD_LENGTH / MAX_PASSWORD_LENGTH), and MIN_PASSWORD_LENGTH is a name
// SERVER-CORE ALSO DECLARES — precisely the shape the unregistered-mirror sweep
// below exists to catch. Worked out rather than assumed: THIS LINT WILL NOT GO
// RED. It never opens the web repo — `findAdminRepo` looks only for
// `@flowmic/admin`, and `sweepConstants` is called on this repo and that one.
// So C9 would have stayed green while printing a sentence that had become
// false, which is the worse of the two outcomes: a red line gets fixed, a stale
// green line gets quoted.
//
// ⇒ Two things changed, and neither of them silences a check here:
//   ① the PASS line below no longer asserts what the web repo contains. It names
//      the OWNER of that repo instead, which is a fact about this suite's
//      structure and does not expire when someone edits another repo;
//   ② the web repo is now genuinely scanned — by
//      verify/lint/password-policy-mirror.mjs, which owns it.
//
// ── DIVISION OF LABOUR, so neither lint is read as covering the other ───────
//   · admin-limit-mirror (this file) → `@flowmic/admin`  — ops console limits
//   · password-policy-mirror         → `@flowmic/web`    — password policy
// If a THIRD repo ever hand-copies a server constant, it belongs to whichever
// lint owns that repo, and if none does, it needs one. Adding a name to the
// registry below does not extend this lint's reach past `@flowmic/admin`.
//
// Both sides agreed on arrival. This lint pins that agreement; it did not have
// to repair anything to be green.
//
// ── 🔴 WHY THIS PINS AGREEMENT INSTEAD OF FORCING ONE CONSTANT ──────────────
// The obvious "fix" — collapse the copies into a shared package — is WRONG here
// twice over, and both refusals are written down in the code already:
//
//  ① `AUDIT_RECENT_DEFAULT` and `USAGE_PAGE_DEFAULT` are both 50 and are
//     DELIBERATELY separate constants (ops-routes.ts's own doc comment: those
//     bound a per-user, per-month page, this bounds a cross-account trail read,
//     and "the two questions having the same numeric answer today is
//     coincidence, not a reason to share one constant"). A lint that de-duped
//     by VALUE would weld together two questions this repo went out of its way
//     to keep apart — the #1 historical bug shape (one value answering two questions).
//  ② The admin repo once held a `USAGE_PAGE_MAX` mirror (200) and DELETED it,
//     because the anti-façade grep found zero call sites. Demanding a mirror
//     per server constant would drag that dead constant back. So the registry
//     below is a list of mirrors that EXIST, never a list of mirrors that
//     SHOULD exist — a mirror is registered when someone writes one.
//
// ⇒ The failure this catches is the drift itself: someone raises
//   AUDIT_RECENT_MAX to 1000 in server-core, the console keeps rendering
//   "the server returns at most 500 rows per request", and the sentence on the operator's screen is a
//   stale truth that no test in either repo is looking at.
//
// ── TWO RELATIONS, NOT ONE ─────────────────────────────────────────────────
//   equals — a named mirror of a server constant. Must match exactly.
//   atMost — a view's own request size (`const PAGE = 50`), which is NOT a
//            mirror: nothing in server-core is called `PAGE`. It is bound by a
//            ceiling instead. The server REFUSES an out-of-range `?limit=` with
//            a named 400 rather than clamping (deliberately, so a caller cannot
//            mistake a trimmed page for the whole answer) — which means the day
//            a ceiling drops below one of these, that view stops working
//            outright. Encoding the bound HERE rather than as a constant over
//            there is what keeps ② true: no unused constant is created in the
//            admin repo to satisfy this check.
//
// ── HOW THE OTHER REPO IS LOCATED (and why not by path) ────────────────────
// CLAUDE.md is explicit that absolute paths must never be baked into this repo:
// the checkouts have already diverged across machines (F:\flowmic\ and
// F:\vibecoding-project\ have both been the real answer on some box; a third
// layout spelled the legal entity, and that spelling is deliberately NOT in
// this example list — `corp-absolute-path` in scripts/opensource-manifest.mjs
// is a REQUIRE_ABSENT hard block, so writing it here stops the public export.
// It did: measured 2026-08-12, this line was one of three survivors that
// failed the final sweep). So the admin repo is found BY IDENTITY, not by path: each directory
// beside this repo is asked what its package.json calls itself, and the one
// answering `@flowmic/admin` is it. `FLOWMIC_ADMIN_REPO` overrides — an
// absolute path from the ENVIRONMENT is fine, an absolute path in the SOURCE is
// not. Messages print `@flowmic/admin:src/…`, never a machine path.
//
// ── 🔴 WHAT THIS LINT DOES NOT CHECK ───────────────────────────────────────
//  · When the admin repo is not beside this one (CI, a public export tree, a
//    fresh clone), the cross-repo half CANNOT run. It then reports SKIP with
//    the count it did not compare. It does NOT report PASS: a green line whose
//    name says "mirror" while zero mirrors were compared is precisely the
//    façade this repo keeps paying for. The in-repo half still runs first and
//    can still FAIL on its own.
//  · It does not read the admin repo's git history, so it cannot say which side
//    moved — only that the two disagree.
//  · It cannot see a limit that was never given a name. `fetch('…?limit=25')`
//    written inline in a component is invisible to every check here. Measured
//    today: zero such literals in either repo's ops surface, but nothing
//    ENFORCES that, so do not read a green line as "there is no hard-coded limit".
//  · The unregistered-mirror sweep matches on NAME. A copy that renamed the
//    constant on the way over (`MAX_AUDIT_ROWS = 500`) is not detected.

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { ROOT, walk, readText, readJson, lineOf, DEFAULT_SKIP_DIRS } from './_util.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/admin-limit-mirror.mjs` evaluates this module and exits 0 without
// checking anything -- a silence indistinguishable from a pass (it was written
// down as one twice; see the guard's header). platform-cfg-count carried this
// alone since 2026-08-10; every registered lint carries it since 2026-08-19.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'admin-limit-mirror';

const ADMIN_PKG_NAME = '@flowmic/admin';

/** The server-side declaration for every constant referenced below. A name
 *  missing from its file is a FAIL, not a skip: a rename here would otherwise
 *  turn every mirror check downstream into a comparison against nothing. */
const SSOT = {
  EVENTS_MAX_LIMIT: 'apps/server-core/src/http/console-routes.ts',
  AUDIT_RECENT_DEFAULT: 'apps/server-core/src/http/ops-routes.ts',
  AUDIT_RECENT_MAX: 'apps/server-core/src/http/ops-routes.ts',
  USAGE_PAGE_MAX: 'apps/server-core/src/db/repos/usage.repo.ts',
  USAGE_EVENTS_PAGE_DEFAULT: 'apps/server-core/src/db/repos/usage-events.repo.ts',
  USAGE_EVENTS_PAGE_MAX: 'apps/server-core/src/db/repos/usage-events.repo.ts',
};

/** Every hand-written copy in the admin repo that is tied to one of the above.
 *  Paths are relative to that repo's root. */
const MIRRORS = [
  { rel: 'equals', ssot: 'EVENTS_MAX_LIMIT', file: 'src/lib/api.ts', decl: 'EVENTS_MAX_LIMIT' },
  { rel: 'equals', ssot: 'AUDIT_RECENT_DEFAULT', file: 'src/lib/api.ts', decl: 'AUDIT_RECENT_DEFAULT' },
  { rel: 'equals', ssot: 'AUDIT_RECENT_MAX', file: 'src/lib/api.ts', decl: 'AUDIT_RECENT_MAX' },
  // `GET /api/cloud/billing/orphans?limit=` — bounded by the ledger ceiling.
  { rel: 'atMost', ssot: 'EVENTS_MAX_LIMIT', file: 'src/views/ops/OpsReconcileView.vue', decl: 'LIMIT' },
  // `GET /api/ops/usage/users?limit=` — bounded by the usage page ceiling.
  { rel: 'atMost', ssot: 'USAGE_PAGE_MAX', file: 'src/views/ops/OpsUsageView.vue', decl: 'PAGE' },
  // `GET /api/ops/usage/events?user_id=` — the account-events drill-down's page
  // sizing, hand-copied by the admin console the day it grew its first caller.
  { rel: 'equals', ssot: 'USAGE_EVENTS_PAGE_DEFAULT', file: 'src/lib/api.ts', decl: 'USAGE_EVENTS_PAGE_DEFAULT' },
  { rel: 'equals', ssot: 'USAGE_EVENTS_PAGE_MAX', file: 'src/lib/api.ts', decl: 'USAGE_EVENTS_PAGE_MAX' },
];

/** `const NAME = <int>;` / `export const NAME = <int>;`, optionally `: number`. */
function declRe(constName) {
  return new RegExp(
    `^[ \\t]*(?:export[ \\t]+)?const[ \\t]+${constName}[ \\t]*(?::[ \\t]*number[ \\t]*)?=[ \\t]*(\\d+)[ \\t]*;`,
    'm'
  );
}

/** Same shape, but sweeping for every integer constant in a file. */
const ANY_DECL_RE = /^[ \t]*(?:export[ \t]+)?const[ \t]+([A-Z][A-Z0-9_]*)[ \t]*(?::[ \t]*number[ \t]*)?=[ \t]*(\d+)[ \t]*;/gm;

/**
 * A `.vue` SFC is not JavaScript. Reducing it to its `<script>` blocks before
 * any JS-shaped matching keeps the template out — an HTML comment or an
 * apostrophe in prose would otherwise be read as code.
 */
function scriptSource(abs, text) {
  if (!abs.endsWith('.vue')) return text;
  const blocks = [];
  const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(text))) blocks.push(m[1]);
  return blocks.join('\n');
}

/** `{ value, line }` for one constant in one file, or null when absent. */
function readDecl(text, constName) {
  const m = declRe(constName).exec(text);
  if (!m) return null;
  return { value: Number(m[1]), line: lineOf(text, m.index) };
}

/**
 * Every integer constant declared under `srcDir`, as name -> [{file,value}].
 *
 * `repoRoot` is what file paths are reported relative to — NOT `srcDir`. The
 * two differ, and the difference is not cosmetic: MIRRORS registers
 * `src/lib/api.ts`, so a sweep that reported `lib/api.ts` would fail to match
 * its own registry and accuse every registered mirror of being unregistered.
 * Measured — that is exactly what the first run of this lint did.
 */
async function sweepConstants(repoRoot, srcDir, exts) {
  const found = new Map();
  for (const abs of await walk(srcDir, { skipDir: (b) => DEFAULT_SKIP_DIRS.has(b) })) {
    if (!exts.some((e) => abs.endsWith(e))) continue;
    const raw = await readText(abs);
    if (raw === null) continue;
    const text = scriptSource(abs, raw);
    let m;
    ANY_DECL_RE.lastIndex = 0;
    while ((m = ANY_DECL_RE.exec(text))) {
      const file = path.relative(repoRoot, abs).split(path.sep).join('/');
      if (!found.has(m[1])) found.set(m[1], []);
      found.get(m[1]).push({ file, value: Number(m[2]) });
    }
  }
  return found;
}

/**
 * The admin repo's root, found by asking each directory beside this one what it
 * calls itself. Returns `{ dir }`, or `{ reason }` explaining what was looked
 * at and found — the caller prints that reason rather than going quietly green.
 */
async function findAdminRepo() {
  const override = process.env.FLOWMIC_ADMIN_REPO;
  if (override) {
    const pkg = await readJson(path.join(override, 'package.json'));
    if (pkg?.name === ADMIN_PKG_NAME) return { dir: override };
    return {
      reason:
        `FLOWMIC_ADMIN_REPO is set but does not point at ${ADMIN_PKG_NAME} ` +
        `(package.json name = ${pkg?.name ? `"${pkg.name}"` : 'unreadable'})`,
    };
  }

  const parent = path.dirname(ROOT);
  let entries;
  try {
    entries = await fsp.readdir(parent, { withFileTypes: true });
  } catch {
    return { reason: `cannot read the directory containing this repo` };
  }

  const hits = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(parent, e.name);
    const pkg = await readJson(path.join(dir, 'package.json'));
    if (pkg?.name === ADMIN_PKG_NAME) hits.push({ dir, base: e.name });
  }

  if (hits.length === 0) {
    return { reason: `no sibling directory declares itself ${ADMIN_PKG_NAME} (${entries.length} checked)` };
  }
  if (hits.length > 1) {
    // More than one sibling declares the same package name (e.g. an extra
    // worktree beside the checkout) — ambiguous by design, not guessed at.
    return {
      reason:
        `${hits.length} sibling directories declare themselves ${ADMIN_PKG_NAME} ` +
        `(${hits.map((h) => h.base).join(', ')}) — set FLOWMIC_ADMIN_REPO to pick one`,
    };
  }
  return { dir: hits[0].dir };
}

export default async function run() {
  // ── in-repo half: every SSOT declaration must still be there, as a literal ──
  const ssotValues = new Map();
  for (const [constName, file] of Object.entries(SSOT)) {
    const text = await readText(path.join(ROOT, file));
    if (text === null) {
      return { status: 'FAIL', detail: `${file} is missing — it declares ${constName}, which mirrors are compared against` };
    }
    const decl = readDecl(text, constName);
    if (decl === null) {
      return {
        status: 'FAIL',
        detail:
          `${constName} is no longer declared as a plain integer literal in ${file}. ` +
          'Renamed, moved, or computed — either way every mirror registered against it ' +
          'would now be compared against nothing and this lint would go green while ' +
          'covering zero. Update the SSOT table in verify/lint/admin-limit-mirror.mjs.',
      };
    }
    ssotValues.set(constName, decl.value);
  }

  const adminRepo = await findAdminRepo();
  const inRepoNote = `${ssotValues.size} server constant(s) verified in-repo`;
  if (!adminRepo.dir) {
    return {
      status: 'SKIP',
      detail: `${inRepoNote}; ${MIRRORS.length} mirror(s) NOT compared — ${adminRepo.reason}`,
    };
  }

  // ── cross-repo half ────────────────────────────────────────────────────────
  const problems = [];
  let compared = 0;

  for (const m of MIRRORS) {
    const abs = path.join(adminRepo.dir, m.file);
    const raw = await readText(abs);
    const label = `${ADMIN_PKG_NAME}:${m.file}`;
    if (raw === null) {
      problems.push(`${label} is missing (registered as the home of \`${m.decl}\`)`);
      continue;
    }
    const decl = readDecl(scriptSource(abs, raw), m.decl);
    if (decl === null) {
      problems.push(
        `${label} no longer declares \`${m.decl}\` as an integer literal — ` +
          `if it was renamed or inlined, update MIRRORS in verify/lint/admin-limit-mirror.mjs`
      );
      continue;
    }
    compared++;
    const expected = ssotValues.get(m.ssot);
    if (m.rel === 'equals' && decl.value !== expected) {
      problems.push(
        `${label}:${decl.line} ${m.decl}=${decl.value} but ${SSOT[m.ssot]} says ${m.ssot}=${expected}`
      );
    } else if (m.rel === 'atMost' && decl.value > expected) {
      problems.push(
        `${label}:${decl.line} ${m.decl}=${decl.value} exceeds the server ceiling ` +
          `${m.ssot}=${expected} (${SSOT[m.ssot]}) — the server answers a named 400, not a short page`
      );
    }
  }

  // ── sweep: a NEW hand-copy must be registered, not merely present ──────────
  const serverConsts = await sweepConstants(ROOT, path.join(ROOT, 'apps/server-core/src'), ['.ts']);
  const adminConsts = await sweepConstants(adminRepo.dir, path.join(adminRepo.dir, 'src'), ['.ts', '.vue']);
  const registered = new Set(MIRRORS.map((m) => `${m.file}:${m.decl}`));
  let swept = 0;
  for (const [constName, sites] of adminConsts) {
    swept++;
    if (!serverConsts.has(constName)) continue;
    for (const site of sites) {
      if (registered.has(`${site.file}:${constName}`)) continue;
      const where = serverConsts.get(constName).map((s) => `${s.file}=${s.value}`);
      problems.push(
        `${ADMIN_PKG_NAME}:${site.file} declares \`${constName}=${site.value}\`, a name server-core also ` +
          `declares (${where.join(', ')}), but it is not registered in MIRRORS — a new hand-copy ` +
          'nobody is watching. Register it (or rename it if it is unrelated).'
      );
    }
  }

  if (problems.length > 0) {
    return { status: 'FAIL', detail: problems.join(' | ') };
  }

  return {
    status: 'PASS',
    detail:
      `${compared} mirror(s) agree with ${ssotValues.size} server constant(s); ` +
      `swept ${swept} admin constant(s) / ${serverConsts.size} server constant(s) for unregistered copies; ` +
      // 🔴 A4-3 correction: this used to end 「web repo declares no numeric
      // mirrors (not scanned)」 — a frozen 2026-08-11 measurement of ANOTHER
      // repo, printed on every green run as though it had just been taken. It
      // went stale the day @flowmic/web declared MIN_PASSWORD_LENGTH, and
      // nothing here would have noticed. Now it states which repo this lint
      // covers — a fact about this file, which cannot expire somewhere else.
      `scope: ${ADMIN_PKG_NAME} only (@flowmic/web is covered by password-policy-mirror)`,
  };
}
