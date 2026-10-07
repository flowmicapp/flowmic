// verify/lint/no-device-uninstall.mjs
//
// 🔴 NOTHING WE SHIP OR TRACK MAY UNINSTALL THE APP FROM A DEVICE OR CLEAR ITS DATA.
//
// [measured 2026-10-03] The 0.3.106 release runbook's iPad step ran
// `flutter install`. That command UNINSTALLS the app first and then installs,
// so it wiped FlowMic and every byte of its data from the owner's iPad. The
// owner's standing rule is: never uninstall, never clear data on devices.
// The rule lived in memory and in the owner's head, not in anything that could
// turn red — and a runbook line is exactly the kind of text an executor copies
// without re-deriving.
//
// The allowed in-place paths:
//   · Android: `adb install -r`
//   · iOS:     `xcrun devicectl device install app`   (replaces in place)
//
// WHAT IS SCANNED (tracked, human- or machine-run command text):
//   scripts/, tools/, .github/, every Makefile/*.mk, every package.json, every
//   *.sh/*.ps1/*.bat/*.cmd, and docs/RELEASE-IRONRULES.md (the runbook the
//   builds are done from). NOT scanned: the rest of docs/ (history and decision
//   records that must be free to quote a command that bit us) and scratch/.
//
// THE ONE ESCAPE HATCH, deliberately narrow: a line that carries the marker
// below is skipped, and only that line. It exists for text that merely MENTIONS
// the ban (the rule itself in RELEASE-IRONRULES). It is a same-line marker, not
// a file allowlist, so it cannot hold a live call site anywhere else.
//
// ⚠️ This file lives under verify/, which is outside the scan, so its own
// pattern table does not trip it; the drill (scripts/no-device-uninstall-lint
// .test.mjs) builds its forbidden strings by concatenation for the same reason.

import path from 'node:path';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';
import { ROOT, readText, walk } from './_util.mjs';

refuseDirectRun(import.meta.url, 'pnpm verify:lint');

/** Same-line marker that exempts a line which only talks about the ban. */
export const MARKER = 'lint-allow: device-uninstall';

const RUNBOOK = 'docs/RELEASE-IRONRULES.md';

const PATTERNS = [
  { re: /\bflutter(?:\.bat)?\s+install\b/, what: 'flutter install (uninstalls first)' },
  { re: /\badb(?:\.exe)?\b[^\n]*\buninstall\b/, what: 'adb ... uninstall' },
  { re: /\bpm\s+clear\b/, what: 'pm clear (wipes app data)' },
  { re: /\bpm\s+uninstall\b/, what: 'pm uninstall' },
  { re: /--uninstall-first\b/, what: '--uninstall-first' },
  { re: /\bdevicectl\s+device\s+uninstall\b/, what: 'devicectl device uninstall' },
];

function inScope(rel) {
  if (rel === RUNBOOK) return true;
  if (rel.startsWith('docs/') || rel.startsWith('scratch/')) return false;
  const base = path.posix.basename(rel);
  if (rel.startsWith('scripts/') || rel.startsWith('tools/') || rel.startsWith('.github/')) return true;
  if (/^Makefile/.test(base) || base.endsWith('.mk') || base === 'package.json') return true;
  return /\.(sh|ps1|bat|cmd)$/.test(base);
}

export default async function noDeviceUninstall(root = ROOT) {
  const files = await walk(root, {
    skipDir: (name) =>
      ['node_modules', '.git', 'dist', 'build', 'target', '.dart_tool', '.local', 'publish', '.claude', 'Pods', 'scratch'].includes(name),
  });
  const hits = [];
  let scanned = 0;
  let runbookSeen = false;
  for (const abs of files) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (!inScope(rel)) continue;
    const text = await readText(abs);
    if (text === null) continue;
    scanned += 1;
    if (rel === RUNBOOK) runbookSeen = true;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.includes(MARKER)) continue;
      for (const { re, what } of PATTERNS) {
        if (re.test(line)) hits.push(`${rel}:${i + 1} — ${what}`);
      }
    }
  }
  // A control: if the runbook was not even read, the scan is blind, not clean.
  if (!runbookSeen) {
    return { status: 'FAIL', detail: `${RUNBOOK} was not scanned (${scanned} file(s) seen) — the scan is blind, not clean` };
  }
  if (hits.length > 0) {
    return {
      status: 'FAIL',
      detail:
        `${hits.length} command(s) that uninstall the app or clear its data on a device. ` +
        `Use \`adb install -r\` (Android) or \`xcrun devicectl device install app\` (iOS) instead; ` +
        `a line that only mentions the ban may carry "${MARKER}":\n  ` +
        hits.join('\n  '),
    };
  }
  return { status: 'PASS', detail: `${scanned} script/Makefile/package.json/runbook file(s), 0 device-uninstall commands` };
}
