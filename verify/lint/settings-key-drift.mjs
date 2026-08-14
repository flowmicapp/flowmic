// verify/lint/settings-key-drift.mjs
// Lint 3/12 — settings key drift (bidirectional).
// (🔴 CORRECTED 2026-08-07: was "3/9" — the suite is 12 lints now, see
// verify/lint/run-all.mjs; full account at verify/lint/i18n-error-keys.mjs:2.)
//
// Anti-façade guard for the settings surface: every key the UI *sets* must be
// *read* somewhere on the server, and every key the server *gets* must be
// *set* somewhere in the UI. Either half orphaned -> FAIL.
//
// Until apps/* exist there is nothing to cross-check -> SKIP. The collectors
// are written now so the lint lights up the moment app sources land.

import path from 'node:path';
import { ROOT, walk, readText, rel } from './_util.mjs';

export const name = 'settings-key-drift';

// UI side: keys pushed into the settings store.
const SET_RE = /(?:setSetting|settings\.set|settings\.update|updateSetting)\s*\(\s*(['"`])([a-zA-Z][\w.-]*)\1/g;
// Server side: keys pulled out of the settings store.
const GET_RE = /(?:getSetting|settings\.get|readSetting)\s*\(\s*(['"`])([a-zA-Z][\w.-]*)\1/g;

const UI_ROOTS = ['apps/desktop', 'apps/mobile'];
const SERVER_ROOTS = ['apps/server-core'];

// ── read-only CAPABILITY keys (card POLISH-CFG, 2026-08-09) ────────────────
//
// 🔴 THE HOLE THIS CLOSES, AND WHY A WAIVER WOULD HAVE BEEN WORSE THAN NOTHING.
// The two rules above pair 「UI writes」 with 「server reads」. A `capability.*` key
// does NEITHER: the server SYNTHESISES it on every `settings:list` and the UI only
// renders it. So it matches neither regex, and the first one shipped would have
// been invisible to this lint — not waived, not exempted, simply never looked at.
// An allowlist entry would have made the same silence permanent and would have hidden
// the NEXT one too. The rule is therefore keyed on the PREFIX, so a capability key
// nobody has thought of yet is still covered the day it is declared.
//
// Three failures, because a read-only fact can be broken three different ways:
//   · the UI WRITES one            → it was never storable; the write is a lie
//   · the server produces one nobody renders → façade (the repo's #1 historical bug)
//   · the UI renders one no server produces  → an invented fact
const CAPABILITY_PREFIX = 'capability.';
const PROTOCOL_CONSTANTS = 'packages/protocol/src/constants.ts';
// Declarations look like: export const SETTINGS_KEY_CAPABILITY_LLM = 'capability.llm';
const CAP_DECL_RE = /export const (SETTINGS_KEY_CAPABILITY_[A-Z0-9_]+)\s*=\s*(['"])(capability\.[\w.-]+)\2/g;
// The prefix constant itself, so the lint and the protocol cannot drift apart
// silently — the whole ruleset hangs off this string being the same in both.
const CAP_PREFIX_DECL_RE = /export const SETTINGS_CAPABILITY_KEY_PREFIX\s*=\s*(['"])(capability\.)\1/;

/** Does `needle` (a constant NAME) appear anywhere under these roots?
 *  Capability keys are referenced through the exported constant rather than a
 *  literal — that is deliberate, and it is what makes them greppable here. */
async function mentions(relRoots, needle) {
  for (const relRoot of relRoots) {
    for (const f of await walk(path.join(ROOT, relRoot))) {
      const ext = path.extname(f).toLowerCase();
      if (!['.ts', '.tsx', '.vue', '.dart', '.js', '.mjs'].includes(ext)) continue;
      const src = await readText(f);
      if (src != null && src.includes(needle)) return rel(f);
    }
  }
  return null;
}

async function collect(relRoots, re) {
  const keys = new Map(); // key -> first "file:line"
  let fileCount = 0;
  for (const relRoot of relRoots) {
    const abs = path.join(ROOT, relRoot);
    for (const f of await walk(abs)) {
      const ext = path.extname(f).toLowerCase();
      if (!['.ts', '.tsx', '.vue', '.dart', '.js', '.mjs'].includes(ext)) continue;
      const src = await readText(f);
      if (src == null) continue;
      fileCount++;
      for (const m of src.matchAll(re)) {
        const line = src.slice(0, m.index).split('\n').length;
        if (!keys.has(m[2])) keys.set(m[2], `${rel(f)}:${line}`);
      }
    }
  }
  return { keys, fileCount };
}

export default async function run() {
  const set = await collect(UI_ROOTS, SET_RE);
  const get = await collect(SERVER_ROOTS, GET_RE);

  if (set.fileCount === 0 && get.fileCount === 0) {
    return { status: 'SKIP', detail: 'no app sources yet (apps/* absent)' };
  }

  const orphans = [];
  for (const [k, where] of set.keys) {
    if (!get.keys.has(k)) orphans.push(`set-only '${k}' @ ${where}`);
  }
  for (const [k, where] of get.keys) {
    if (!set.keys.has(k)) orphans.push(`get-only '${k}' @ ${where}`);
  }

  // ── read-only capability keys ────────────────────────────────────────────
  const constantsSrc = await readText(path.join(ROOT, PROTOCOL_CONSTANTS));
  let capCount = 0;
  if (constantsSrc == null) {
    orphans.push(`cannot read ${PROTOCOL_CONSTANTS} — capability rules did not run`);
  } else {
    // If the prefix ever moves, every rule below silently stops matching. Fail
    // instead: a ruleset that quietly covers nothing is the thing being prevented.
    if (!CAP_PREFIX_DECL_RE.test(constantsSrc)) {
      orphans.push(
        `SETTINGS_CAPABILITY_KEY_PREFIX is not declared as '${CAPABILITY_PREFIX}' in ${PROTOCOL_CONSTANTS} — ` +
          `this lint's read-only ruleset keys off that literal and would match nothing`,
      );
    }
    for (const m of constantsSrc.matchAll(CAP_DECL_RE)) {
      const [, constName, , literal] = m;
      capCount++;
      if (!literal.startsWith(CAPABILITY_PREFIX)) {
        orphans.push(`capability constant ${constName} does not use the '${CAPABILITY_PREFIX}' prefix`);
        continue;
      }
      if (set.keys.has(literal)) {
        orphans.push(
          `read-only '${literal}' is WRITTEN by the UI @ ${set.keys.get(literal)} — ` +
            `capability keys are synthesised per read and are not storable`,
        );
      }
      const producer = await mentions(SERVER_ROOTS, constName);
      if (producer === null) {
        orphans.push(`capability '${literal}' (${constName}) has no server producer — nothing synthesises it`);
      }
      const consumer = await mentions(UI_ROOTS, constName);
      if (consumer === null) {
        orphans.push(
          `capability '${literal}' (${constName}) has no UI consumer — a fact nobody renders is a façade`,
        );
      }
    }
  }

  if (orphans.length > 0) {
    return { status: 'FAIL', detail: `${orphans.length} drift: ${orphans.slice(0, 10).join('; ')}` };
  }
  return {
    status: 'PASS',
    detail: `${set.keys.size} set / ${get.keys.size} get keys matched; ${capCount} read-only capability key(s) produced+consumed`,
  };
}
