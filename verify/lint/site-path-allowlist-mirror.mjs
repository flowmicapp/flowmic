// verify/lint/site-path-allowlist-mirror.mjs
// SITE-COUNT-2 — the site's pages are enumerated in the WEBSITE repo and the
// counter's path whitelist is enumerated HERE, and the two have to be the same
// set or a page is counted nowhere.
//
// ── WHAT THE PROBLEM ACTUALLY IS ───────────────────────────────────────────
// `sanitizePath` (apps/server-core/src/site/sanitize.ts) folds anything outside
// SITE_PATH_ALLOWLIST into `(other)`. The browser only beacons paths the site
// registry knows (the `@flowmic/web` repo, src/lib/site-collect.ts `isCountedPath` →
// `publicPageFor`), so the browser half cannot go stale: a page starts being
// counted by existing. This half CAN, because it is a hand-kept list in a
// different repository that cannot import that registry.
//
// Measured on production the day this lint was written — 37 days of
// `site_daily_counts`, 2026-08-16 → 2026-09-21, 640 pageviews on the `path`
// dimension — the whole site had resolved to SIX values (`/`, `/signin`,
// `(other)`, `/faq`, `/privacy`, `/terms`) while the registry held 50 pages.
// `/pricing`, every `/download*`, every `/use-cases*`, every `/vs*`,
// `/refunds` and 25 of the 26 guide chapters had never been counted once, in
// any language, and nothing was red anywhere: a whitelist that has stopped
// describing the site keeps working perfectly on the pages it still names.
// This lint is the thing that is red instead.
//
// ── WHY IT DERIVES INSTEAD OF HOLDING A SECOND LIST ────────────────────────
// Everything below is read out of the website's own sources — the page table,
// the four `*_DOC_IDS` registries it spreads in, the path builders it derives
// slugs with, and the alias line in THIS repo's sanitizer. Nothing about the
// site is written down here. A 51st page therefore makes this check fail with
// the exact string to add; it does not make it wrong.
//
// ⚠️ WHAT A PASS HERE DOES NOT SAY:
//   · nothing about what the DEPLOYED relay carries. This compares two source
//     files. A widened list that has not been deployed still files new pages
//     under `(other)` on the live site, and no gate in this repo can see that.
//   · nothing about whether the browser really beacons those paths. That is
//     proved at the other end, by the website's own src/lib/site-collect.test.ts
//     driving the app's real router.
//   · nothing about `(other)`'s CONTENTS, which is not a fixed set and never
//     was — it is "everything not on the list", so it shrinks whenever the list
//     grows. That is the deliverable, not a drift.
//
// ── 🔴 A MISSING SIBLING IS A SKIP, NEVER A PASS ───────────────────────────
// Same rule spoken-langs-mirror and commit-hook-mirror state: a machine that
// does not have the website checked out cannot verify anything here, and
// printing PASS would be this suite reporting an unattempted check as done.
// The SKIP names what went unchecked so the line cannot be misread.
//
// ── SHAPE ──────────────────────────────────────────────────────────────────
// Same contract as spoken-langs-mirror: named files, regex-extract plain
// literals, FAIL when an extractor stops matching (a rename would otherwise
// compare against nothing and go green covering zero), FAIL when the two sides
// disagree, and say in the failure text what to do about it.

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ROOT, readText, stripJsComments } from './_util.mjs';
// One sibling-repo search for the whole suite, not two. It carries a measured
// fix for linked worktrees (see its header) that a second copy would lose.
import { findWebRepo } from './password-policy-mirror.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'site-path-allowlist-mirror';

/** This repo's hand-kept half. */
const SANITIZE_FILE = 'apps/server-core/src/site/sanitize.ts';
/** The website's page registry, and the beacon that reads it. Repo-relative to
 *  the WEBSITE, not to this repo. */
const WEB_ROUTES_FILE = 'src/lib/site-routes.ts';
const WEB_COLLECT_FILE = 'src/lib/site-collect.ts';

/** `export const SITE_PATH_ALLOWLIST = Object.freeze([ … ] as const);` */
const SERVER_LIST_RE =
  /export[ \t]+const[ \t]+SITE_PATH_ALLOWLIST[ \t]*=[ \t]*Object\.freeze\(\[([\s\S]*?)\][ \t]*as[ \t]+const\)/;
/** `if (p === '/reset') p = '/reset-password';` — the aliases applied BEFORE
 *  the whitelist test, so an aliased path must not be on the list itself. */
const SERVER_ALIAS_RE = /if[ \t]*\(p[ \t]*===[ \t]*'([^']+)'\)[ \t]*p[ \t]*=[ \t]*'([^']+)'[ \t]*;/g;

/** `export const PUBLIC_PAGES: readonly PublicPage[] = [ … ];` */
const PAGES_RE = /export[ \t]+const[ \t]+PUBLIC_PAGES[^=]*=[ \t]*\[([\s\S]*?)\n\];/;
/** One written-out entry's path: `{ key: 'faq', …, path: '/faq', … }`. */
const PAGE_PATH_RE = /\bpath:[ \t]*'([^']+)'/g;
/** One spread of a derived family: `...GUIDE_PAGES,`. */
const PAGE_SPREAD_RE = /^[ \t]*\.\.\.([A-Z][A-Z0-9_]*_PAGES)[ \t]*,?[ \t]*$/gm;

/** The four families' path builders, all written in the same shape:
 *  `export function guidePathForDoc(doc: GuideDocId): string {
 *     return doc === GUIDE_ROOT_DOC ? '/guide' : `/guide/${doc}`;
 *   }`
 *  Captures: 1 builder name, 2 root constant, 3 root path, 4 child prefix.
 *  The PREFIX IS READ, NOT ASSUMED — writing `/use-cases` into this file would
 *  be one more copy of a thing the website already states. */
const BUILDER_RE =
  /export[ \t]+function[ \t]+(\w+)\([ \t]*doc:[ \t]*\w+[ \t]*\):[ \t]*string[ \t]*\{\s*return[ \t]+doc[ \t]*===[ \t]*([A-Z][A-Z0-9_]*)[ \t]*\?[ \t]*'([^']+)'[ \t]*:[ \t]*`([^`$]+)\$\{doc\}`[ \t]*;\s*\}/g;

/** `import { GUIDE_DOC_IDS, type GuideDocId } from '@/views/guide/copy/docs';`
 *  — the lint follows the registry's OWN imports rather than keeping a table of
 *  where the four id files live. */
const IMPORT_RE = /import[ \t]*\{([\s\S]*?)\}[ \t]*from[ \t]*'([^']+)'[ \t]*;/g;

/** `export const GUIDE_DOC_IDS = [ … ] as const;` */
function docIdsRe(constName) {
  return new RegExp(
    `export[ \\t]+const[ \\t]+${constName}[ \\t]*=[ \\t]*\\[([\\s\\S]*?)\\][ \\t]*as[ \\t]+const[ \\t]*;`,
  );
}
/** `export const DOWNLOAD_ROOT_DOC: DownloadDocId = 'overview';` */
function rootDocRe(constName) {
  return new RegExp(`export[ \\t]+const[ \\t]+${constName}[^=]*=[ \\t]*'([^']+)'[ \\t]*;`);
}

/** `export const NON_REGISTRY_COUNTED_PATHS: ReadonlySet<string> = new Set([…]);` */
const NON_REGISTRY_RE =
  /const[ \t]+NON_REGISTRY_COUNTED_PATHS[^=]*=[ \t]*new[ \t]+Set\(\[([\s\S]*?)\]\)/;

function quoted(body) {
  return [...body.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
}

function fail(detail) {
  return { status: 'FAIL', detail };
}

/** Turn `@/views/guide/copy/docs` into a path under the website's `src/`. */
function resolveWebImport(spec) {
  if (spec.startsWith('@/')) return `src/${spec.slice(2)}`;
  if (spec.startsWith('./')) return `src/lib/${spec.slice(2)}`;
  return null;
}

/** Read one of the website's sources WITH ITS COMMENTS REMOVED.
 *
 *  🔴 NOT TIDINESS — measured while writing this lint. These files carry long
 *  prose headers, prose is full of apostrophes ("the registry's"), and a
 *  quoted-literal extractor reads `'s (GUIDE_DOC_IDS), not alphabetical, so a`
 *  as a perfectly good string. The first run reported five nonsense entries as
 *  paths the website never reports. `stripJsComments` is the string- and
 *  template-aware stripper (_util.mjs), not the crude one: a path builder's
 *  backtick template is code this lint must still be able to read. */
async function readWeb(webDir, relPath) {
  for (const ext of ['', '.ts', '/index.ts']) {
    try {
      return stripJsComments(await readFile(path.join(webDir, `${relPath}${ext}`), 'utf8'));
    } catch {
      /* try the next spelling */
    }
  }
  return null;
}

export default async function run() {
  // ── This repo's half. It lives here, so absence is a failure. ─────────────
  const sanitizeRaw = await readText(path.join(ROOT, SANITIZE_FILE));
  const sanitizeText = sanitizeRaw === null ? null : stripJsComments(sanitizeRaw);
  if (sanitizeText === null) {
    return fail(`${SANITIZE_FILE} is missing — it declares the path whitelist this check exists to keep honest`);
  }
  const listHit = SERVER_LIST_RE.exec(sanitizeText);
  if (!listHit) {
    return fail(
      `SITE_PATH_ALLOWLIST is no longer declared as a plain frozen array literal in ${SANITIZE_FILE}. ` +
        'Renamed, moved or computed — the website registry would now be compared against nothing. ' +
        'Update verify/lint/site-path-allowlist-mirror.mjs.',
    );
  }
  const serverPaths = quoted(listHit[1]);
  if (serverPaths.length === 0) {
    return fail(`${SANITIZE_FILE}: SITE_PATH_ALLOWLIST parsed as empty — the extractor no longer matches the source`);
  }
  const aliases = new Map();
  SERVER_ALIAS_RE.lastIndex = 0;
  for (const m of sanitizeText.matchAll(SERVER_ALIAS_RE)) aliases.set(m[1], m[2]);

  // ── The website's half. Sibling repo, so absence is a SKIP. ───────────────
  const web = await findWebRepo();
  if (!web.dir) {
    return {
      status: 'SKIP',
      detail:
        `the website repository was not found (${web.reason}), so SITE_PATH_ALLOWLIST ` +
        `(${serverPaths.length} paths in ${SANITIZE_FILE}) was NOT compared against its page registry ` +
        `(${WEB_ROUTES_FILE}) — nothing about that mirror was checked here. ` +
        'Set FLOWMIC_WEB_REPO to point at the checkout.',
    };
  }

  const routesText = await readWeb(web.dir, WEB_ROUTES_FILE);
  if (routesText === null) {
    return fail(
      `${WEB_ROUTES_FILE} is missing from the website checkout at ${web.dir} — ` +
        'the page registry this whitelist mirrors has moved, and this check would compare against nothing',
    );
  }
  const collectText = await readWeb(web.dir, WEB_COLLECT_FILE);
  if (collectText === null) {
    return fail(`${WEB_COLLECT_FILE} is missing from the website checkout at ${web.dir} — the beacon this whitelist serves has moved`);
  }

  // The derivation below is only valid while the BROWSER really asks the
  // registry. If that line is rewritten back into a hand list, this lint would
  // keep comparing the server against a registry nobody reads.
  if (!/publicPageFor\(path\)\s*!==\s*null/.test(collectText)) {
    return fail(
      `the website checkout at ${web.dir} does not decide what to count with ` +
        `\`publicPageFor(path) !== null\` in ${WEB_COLLECT_FILE}, so comparing this repo against that ` +
        'registry would say nothing about what is actually reported. Either the two halves of this pair ' +
        'have not landed together yet (point FLOWMIC_WEB_REPO at the branch that carries the other half), ' +
        'or the browser has stopped deriving and this lint needs updating with it.',
    );
  }

  // ── Derive the site's counted paths. ─────────────────────────────────────
  const pagesHit = PAGES_RE.exec(routesText);
  if (!pagesHit) {
    return fail(`PUBLIC_PAGES is no longer a plain array literal in ${WEB_ROUTES_FILE} — update this lint`);
  }
  const registryPaths = new Set();
  PAGE_PATH_RE.lastIndex = 0;
  for (const m of pagesHit[1].matchAll(PAGE_PATH_RE)) registryPaths.add(m[1]);
  if (registryPaths.size === 0) {
    return fail(`${WEB_ROUTES_FILE}: PUBLIC_PAGES yielded no written-out page paths — the extractor no longer matches`);
  }

  // Families: `...GUIDE_PAGES` in the table, `guidePathForDoc` next to it, and
  // `GUIDE_DOC_IDS` in whichever module the registry imports it from.
  const spreads = [...pagesHit[1].matchAll(PAGE_SPREAD_RE)].map((m) => m[1]);
  const builders = [...routesText.matchAll(BUILDER_RE)];
  if (builders.length === 0) {
    return fail(
      `${WEB_ROUTES_FILE}: no \`xPathForDoc\` builder matched the shape this lint reads slugs from — ` +
        'the per-chapter paths would silently vanish from the comparison. Update this lint.',
    );
  }
  if (builders.length !== spreads.length) {
    return fail(
      `${WEB_ROUTES_FILE}: ${spreads.length} derived page families are spread into PUBLIC_PAGES ` +
        `(${spreads.join(', ') || 'none'}) but ${builders.length} path builders were found — ` +
        'one family would be compared against nothing. Update this lint.',
    );
  }

  // Where each `*_DOC_IDS` lives, read off the registry's own imports.
  const importedFrom = new Map();
  IMPORT_RE.lastIndex = 0;
  for (const m of routesText.matchAll(IMPORT_RE)) {
    for (const raw of m[1].split(',')) {
      const nameOnly = raw.trim().replace(/^type[ \t]+/, '').split(/[ \t]+as[ \t]+/)[0];
      if (nameOnly) importedFrom.set(nameOnly, m[2]);
    }
  }

  for (const [, builderName, rootConst, rootPath, childPrefix] of builders) {
    const family = builderName.replace(/PathForDoc$/, '');
    const idsConst = `${family.toUpperCase()}_DOC_IDS`;
    const spec = importedFrom.get(idsConst);
    if (!spec) {
      return fail(
        `${WEB_ROUTES_FILE}: ${builderName} builds paths from ${idsConst}, which this file does not import — ` +
          'this lint cannot find the slug list. Update it.',
      );
    }
    const relFile = resolveWebImport(spec);
    const idsText = relFile === null ? null : await readWeb(web.dir, relFile);
    if (idsText === null) {
      return fail(`cannot read ${spec} in the website checkout at ${web.dir} — ${idsConst} is unreadable`);
    }
    const idsHit = docIdsRe(idsConst).exec(idsText);
    if (!idsHit) {
      return fail(`${spec}: ${idsConst} is no longer a plain \`as const\` array literal — update this lint`);
    }
    const ids = quoted(idsHit[1]);
    if (ids.length === 0) {
      return fail(`${spec}: ${idsConst} parsed as empty — the extractor no longer matches`);
    }
    // The root doc constant is declared either beside the ids or beside the builder.
    const rootHit = rootDocRe(rootConst).exec(idsText) ?? rootDocRe(rootConst).exec(routesText);
    if (!rootHit) {
      return fail(`${rootConst} is not a plain string literal in ${spec} or ${WEB_ROUTES_FILE} — update this lint`);
    }
    const rootDoc = rootHit[1];
    if (!ids.includes(rootDoc)) {
      return fail(`${spec}: ${rootConst} is '${rootDoc}', which ${idsConst} does not contain`);
    }
    for (const id of ids) registryPaths.add(id === rootDoc ? rootPath : `${childPrefix}${id}`);
  }

  // The public pages the registry does NOT hold (sign-in, password reset).
  const nonRegHit = NON_REGISTRY_RE.exec(collectText);
  if (!nonRegHit) {
    return fail(
      `${WEB_COLLECT_FILE}: NON_REGISTRY_COUNTED_PATHS is no longer a plain \`new Set([…])\` literal — ` +
        'the non-registry pages the browser reports would drop out of this comparison. Update this lint.',
    );
  }
  const nonRegistry = quoted(nonRegHit[1]);
  if (nonRegistry.length === 0) {
    return fail(`${WEB_COLLECT_FILE}: NON_REGISTRY_COUNTED_PATHS parsed as empty — the extractor no longer matches`);
  }
  // 🔴 AN ALIASED PATH MUST NOT BE ON THE LIST. `/reset` is rewritten to
  // `/reset-password` BEFORE the whitelist test, so listing it too would be a
  // dead entry that looks like coverage.
  for (const p of nonRegistry) registryPaths.add(aliases.get(p) ?? p);

  // ── Compare. ─────────────────────────────────────────────────────────────
  const server = new Set(serverPaths);
  const missing = [...registryPaths].filter((p) => !server.has(p)).sort();
  const extra = [...server].filter((p) => !registryPaths.has(p)).sort();
  const aliasedOnList = serverPaths.filter((p) => aliases.has(p));

  if (aliasedOnList.length > 0) {
    return fail(
      `${SANITIZE_FILE}: SITE_PATH_ALLOWLIST lists ${aliasedOnList.join(', ')}, which sanitizePath rewrites ` +
        'before the whitelist is consulted — the entry can never match and reads as coverage it does not provide',
    );
  }
  if (missing.length === 0 && extra.length === 0) {
    return {
      status: 'PASS',
      detail: `${server.size} counted paths agree with the website registry (${path.basename(web.dir)})`,
    };
  }

  const parts = [];
  if (missing.length > 0) {
    parts.push(
      `${missing.length} page(s) the website counts are NOT on SITE_PATH_ALLOWLIST and are stored as ` +
        `'(other)': ${missing.join(', ')}`,
    );
  }
  if (extra.length > 0) {
    parts.push(
      `${extra.length} entr(y/ies) on SITE_PATH_ALLOWLIST that the website never reports: ${extra.join(', ')}`,
    );
  }
  return fail(
    `${parts.join('; ')}. Fix ${SANITIZE_FILE} to match, then REDEPLOY the relay — ` +
      'editing the list changes nothing until the running server carries it.',
  );
}
