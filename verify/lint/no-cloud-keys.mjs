// verify/lint/no-cloud-keys.mjs
// Lint 2/12 — real cloud credential fingerprints.
// (🔴 CORRECTED 2026-08-07: was "2/9" — the suite is 12 lints now, see
// verify/lint/run-all.mjs; full account at verify/lint/i18n-error-keys.mjs:2.)
//
// Whole-repo scan (excluding node_modules/dist/.git via default prune, plus
// .local, docs/legacy-reference read-only reference, and THIS file — which
// is the fingerprint definition source and would self-match). Any hit -> FAIL.
//
// This is the hard security gate from CLAUDE.md: real cloud API keys never
// enter the repo.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ROOT, walk, readText, rel, DEFAULT_SKIP_DIRS } from './_util.mjs';

export const name = 'no-cloud-keys';

const SELF = fileURLToPath(import.meta.url);

// Second fingerprint-definition site (2026-08-14): the open-source export
// manifest's REQUIRE_ABSENT list mirrors these fingerprints so a leaked key
// can never survive into the exported tree. Like SELF above, the mirror
// self-matches its own rule literals; unlike SELF it lives in scripts/.
const EXPORT_MANIFEST = path.join(ROOT, 'scripts', 'opensource-manifest.mjs');

const FINGERPRINTS = [
  { vendor: 'aws-akia', re: /AKIA[0-9A-Z]{16}/ },
  { vendor: 'openai', re: /sk-[A-Za-z0-9]{20,}/ },
  { vendor: 'anthropic', re: /sk-ant-/ },
  { vendor: 'google-api', re: /AIza[0-9A-Za-z_-]{35}/ },
  { vendor: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  // Fine-grained PATs have their own prefix the classic rule above never
  // matches — found missing 2026-08-02, the day one arrived in .local/.
  { vendor: 'github-fine-grained', re: /github_pat_[A-Za-z0-9_]{36,}/ },
  { vendor: 'aliyun', re: /LTAI[0-9A-Za-z]{12,}/ },
  { vendor: 'tencent', re: /AKID[0-9A-Za-z]{32}/ },
  { vendor: 'azure-connstr', re: /AccountKey=[A-Za-z0-9+/=]{40,}/ },
];

function skipDir(basename, relPath) {
  // .claude/ (concurrent sessions' full repo checkouts — each carrying a copy
  // of THIS file whose fingerprint table self-matches, since the SELF
  // exemption below is path-exact) is skipped by DEFAULT_SKIP_DIRS since
  // 2026-08-11; the full account lives on that list in _util.mjs.
  if (DEFAULT_SKIP_DIRS.has(basename)) return true;
  if (relPath === 'docs/legacy-reference') return true;
  return false;
}

function mask(s) {
  if (s.length <= 8) return s[0] + '***';
  return s.slice(0, 4) + '***' + s.slice(-2);
}

// Exposed for fixture testing: scan a single text blob, return array of hits.
export function scanText(text) {
  const hits = [];
  for (const { vendor, re } of FINGERPRINTS) {
    const m = re.exec(text);
    if (m) {
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({ vendor, line, sample: mask(m[0]) });
    }
  }
  return hits;
}

export default async function run() {
  const files = await walk(ROOT, { skipDir });
  const findings = [];
  for (const abs of files) {
    if (abs === SELF || abs === EXPORT_MANIFEST) continue; // fingerprint definitions live in both
    const text = await readText(abs);
    if (text == null) continue;
    for (const { vendor, line, sample } of scanText(text)) {
      findings.push(`${rel(abs)}:${line} [${vendor}] ${sample}`);
    }
  }
  if (findings.length > 0) {
    return {
      status: 'FAIL',
      detail: `${findings.length} credential fingerprint(s): ${findings.slice(0, 10).join('; ')}`,
    };
  }
  return { status: 'PASS', detail: `${files.length} file(s) scanned, no cloud keys` };
}
