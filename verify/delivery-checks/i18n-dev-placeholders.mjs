// verify/delivery-checks/i18n-dev-placeholders.mjs — delivery gate stage
// `verify:i18n-dev-placeholders`. NOT a lint (NR-83).
//
// Guarantee: no `DEV:` placeholder string in i18n/{desktop,desktop-rust,mobile}
// reaches delivery. The scan below is the one that lived in the `run()` of
// verify/lint/i18n-error-keys.mjs, moved verbatim in strength: the same three
// surfaces, the same nine locale files, the same test on every string value
// (trimmed, an optional leading quote, then `DEV:` in any case), the whole
// JSON tree walked. Nothing new counts as acceptable.
//
// ── WHY IT MOVED (NR-83, docs/strategy/2026-08-27-next-release-feature-and-
// optimization-ledger.md) ─────────────────────────────────────────────────────
// Inside `verify:lint` it ran in pre-commit, so a new feature could never commit
// the placeholder key that the copy-rewrite pipeline needs to exist before it
// can write the real sentence: a deadlock. The round that tightened the scan had
// already replaced its own placeholders and never met the wall. What must hold
// is "no placeholder reaches delivery", not "no placeholder exists on a branch
// in flight". The registry half of i18n-error-keys (every protocol code has a
// non-placeholder zh_CN and en) is about the commit and stays in verify:lint.
//
// Where it runs: package.json `verify:delivery` (so the release receipt covers
// it), the TSC lane of verify/run-delivery-fast.mjs, and verify/lane-map.mjs
// selects it for any change to the scanned catalogues.
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { ROOT } from '../lint/_util.mjs';
import { runAsCommand } from './_cli.mjs';

export const name = 'i18n-dev-placeholders';
export const SURFACES = ['desktop', 'desktop-rust', 'mobile'];
const LOCALE_FILE = /^(?:en|zh-CN|zh-TW|de|es|fr|ja|ko|ru)\.json$/;
const PLACEHOLDER = /^['"]?DEV:/i;

/** Every `surface/file:.key.path` whose string value is a DEV placeholder. */
export async function scanPlaceholders(root = ROOT) {
  const placeholders = [];
  for (const surface of SURFACES) {
    const directory = path.join(root, 'i18n', surface);
    for (const file of await readdir(directory)) {
      if (!LOCALE_FILE.test(file)) continue;
      const visit = (value, key) => {
        if (typeof value === 'string' && PLACEHOLDER.test(value.trim())) placeholders.push(`${surface}/${file}:${key}`);
        else if (value && typeof value === 'object') for (const [child, item] of Object.entries(value)) visit(item, `${key}.${child}`);
      };
      visit(JSON.parse(await readFile(path.join(directory, file), 'utf8')), '');
    }
  }
  return placeholders;
}

export default async function run() {
  const placeholders = await scanPlaceholders();
  if (placeholders.length) {
    return {
      status: 'FAIL',
      detail:
        `${placeholders.length} DEV placeholders remain; ${placeholders.slice(0, 6).join(', ')}. `
        + 'A placeholder may live on a branch in flight but may not be delivered: run the copy pipeline '
        + '(docs/knowledge-base/native-copy-rewrite-and-incremental-audit.md) and land the real sentences.',
    };
  }
  return { status: 'PASS', detail: `no DEV placeholder in i18n/{${SURFACES.join(',')}} (9 locales each)` };
}

await runAsCommand(import.meta.url, name, run);
