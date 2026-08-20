// verify/lint/protocol-whitelist.mjs
// Lint 1/12 — protocol event whitelist.
// (🔴 CORRECTED 2026-08-07: was "1/9" — the suite is 12 lints now, see
// verify/lint/run-all.mjs; full account at verify/lint/i18n-error-keys.mjs:2.)
//
// Scans TS/Rust/Dart/Vue source in apps/** and packages/** (excluding the
// protocol package itself, dist, node_modules and test files) for socket
// event string literals in emit/on/send calls (the 'xx:yy' form) and checks
// each against the canonical whitelist parsed live from
// packages/protocol/src/events.ts. Unknown event -> FAIL.
//
// When a language has no target sources it is SKIPped; with zero targets
// across all four languages the whole lint SKIPs.

import path from 'node:path';
import { ROOT, walk, readText, rel } from './_util.mjs';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

// `node verify/lint/protocol-whitelist.mjs` evaluates this module and exits 0 without
// checking anything -- a silence indistinguishable from a pass (it was written
// down as one twice; see the guard's header). platform-cfg-count carried this
// alone since 2026-08-10; every registered lint carries it since 2026-08-19.
refuseDirectRun(import.meta.url, 'pnpm verify:lint');

export const name = 'protocol-whitelist';

const EVENTS_TS = path.join(ROOT, 'packages', 'protocol', 'src', 'events.ts');

const LANG_EXT = {
  ts: new Set(['.ts', '.tsx']),
  rust: new Set(['.rs']),
  dart: new Set(['.dart']),
  vue: new Set(['.vue']),
};

// .emit('x:y' | .on('x:y' | .send('x:y'  — captures the event literal.
const CALL_RE = /\.(?:emit|on|send)\s*\(\s*(['"`])([a-zA-Z][\w-]*:[\w:-]+)\1/g;

export function parseWhitelist(src) {
  const start = src.indexOf('EVENT_NAMES');
  const open = src.indexOf('[', start);
  const close = src.indexOf('] as const', open);
  const block = src.slice(open, close === -1 ? src.length : close);
  const set = new Set();
  for (const m of block.matchAll(/'([^']+)'/g)) set.add(m[1]);
  return set;
}

function langOf(ext) {
  for (const [lang, exts] of Object.entries(LANG_EXT)) {
    if (exts.has(ext)) return lang;
  }
  return null;
}

function isTestFile(relPath) {
  return (
    /(^|\/)(test|tests|__tests__)\//.test(relPath) ||
    /\.(test|spec)\.[tj]sx?$/.test(relPath) ||
    /_test\.rs$/.test(relPath) ||
    /_test\.dart$/.test(relPath) ||
    /_test\.go$/.test(relPath)
  );
}

export default async function run() {
  const whitelistSrc = await readText(EVENTS_TS);
  if (whitelistSrc == null) {
    return { status: 'FAIL', detail: 'cannot read packages/protocol/src/events.ts' };
  }
  const whitelist = parseWhitelist(whitelistSrc);
  if (whitelist.size === 0) {
    return { status: 'FAIL', detail: 'parsed 0 events from events.ts (parser drift?)' };
  }

  const roots = [path.join(ROOT, 'apps'), path.join(ROOT, 'packages')];
  const counts = { ts: 0, rust: 0, dart: 0, vue: 0 };
  // 🔴 CHECK THE RULER BEFORE TRUSTING WHAT IT MEASURED (2026-08-20).
  //
  // `parseWhitelist` above is a single-quote regex over the array literal, so
  // ONE apostrophe in a comment inside that literal re-pairs every quote after
  // it. events.ts has carried a hand-written warning about this since R6 T-8 —
  // and today a comment saying「owner's machine」walked straight past it and put
  // a 400-character prose fragment into the whitelist SET. The gate still said
  // PASS, with `whitelist=56` where the real count was 55.
  //
  // That is the dangerous half. A swallowed quote can also DELETE names from the
  // set (removing one apostrophe took the parse from 56 entries to 24), and a
  // whitelist missing names does not fail loudly — it makes this gate start
  // reporting real events as violations, or, if the swallow eats the emit sites
  // too, quietly stop checking anything at all.
  //
  // So the parse now has to prove it parsed. Every entry must LOOK like an event
  // name; anything else means the regex lost its place, and the count printed on
  // the PASS line is not describing the whitelist.
  //
  // ⚠️ `heartbeat` has no colon — the shape allows a bare segment on purpose.
  // A rule demanding `x:y` would reject a real, shipped event name.
  const EVENT_SHAPE = /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)*$/;
  const malformed = [...whitelist].filter((n) => !EVENT_SHAPE.test(n));
  if (malformed.length > 0) {
    return {
      status: 'FAIL',
      detail:
        `whitelist parse is corrupt: ${malformed.length} entr(y|ies) are not event names. ` +
        `Almost always an apostrophe in a comment INSIDE the EVENT_NAMES array literal ` +
        `(the parser pairs single quotes). First offender: ` +
        `${JSON.stringify(malformed[0].slice(0, 60))}`,
    };
  }

  const violations = [];

  for (const root of roots) {
    const files = await walk(root);
    for (const abs of files) {
      const relPath = rel(abs);
      if (relPath.startsWith('packages/protocol/')) continue; // the SSOT itself
      if (isTestFile(relPath)) continue;
      const lang = langOf(path.extname(abs).toLowerCase());
      if (!lang) continue;
      const src = await readText(abs);
      if (src == null) continue;
      counts[lang]++;
      for (const m of src.matchAll(CALL_RE)) {
        const ev = m[2];
        if (!whitelist.has(ev)) {
          const line = src.slice(0, m.index).split('\n').length;
          violations.push(`${relPath}:${line} '${ev}'`);
        }
      }
    }
  }

  if (violations.length > 0) {
    return {
      status: 'FAIL',
      detail: `${violations.length} unknown event(s): ${violations.slice(0, 10).join('; ')}`,
    };
  }


  const scanned = counts.ts + counts.rust + counts.dart + counts.vue;
  const perLang = Object.entries(counts)
    .map(([l, c]) => `${l}=${c}${c === 0 ? '(skip)' : ''}`)
    .join(' ');
  if (scanned === 0) {
    return { status: 'SKIP', detail: `no target sources yet (${perLang}); whitelist=${whitelist.size}` };
  }
  return { status: 'PASS', detail: `${scanned} file(s) clean (${perLang}); whitelist=${whitelist.size}` };
}
