// verify/lint/external-link-door.mjs
//
// 🔴 IN THE DESKTOP WEBVIEW, `target="_blank"` AND `window.open()` OPEN NOTHING.
//
// Not "sometimes", not "slowly", not "in an odd window" — nothing at all, with
// no error and no log line. [measured 2026-08-21, off the crate sources this
// build links against] `wry-0.55.1/src/webview2/mod.rs` attaches a
// `NewWindowRequested` handler unconditionally and its else-branch is
// `args.SetHandled(true)`, i.e. "handled, do nothing"; `tauri-2.11.5` defaults
// `new_window_handler: None`, and this app never sets one — it cannot, because
// `on_new_window` is a builder API and both FlowMic windows are declared in
// tauri.conf.json.
//
// ── WHY THIS IS A GATE AND NOT A NOTE ───────────────────────────────────────
//
// Every external link in the desktop app was dead this way, and nobody noticed
// for months:
//   · the in-app update card's 「打开下载页」 and 「查看更新说明」 — reported from a
//     real Windows 10 machine (owner 2026-08-21: 「要连接下载页去下载，但又点不开」);
//   · privacy policy and terms on the data-flow disclosure page — the product's
//     only in-app route to two documents we point at in writing;
//   · 「获取 App」 in the pairing modal.
//
// It survived because it fails the way this repo's worst defects always fail:
// it looks exactly like working code. There is no error to see, no exception to
// catch, and every test that touched it was written from the same wrong premise
// — one of them literally asserted `target="_blank"` was present, so the suite
// was green precisely because the links were dead and would have gone red the
// day they were fixed (data-flow-disclosure.test.ts carries that story now).
//
// RELEASE-IRONRULES' own rule for a fresh scar is 「能不能变成闸」 ("can it become
// a gate"). This is that gate. The door is
// `apps/desktop/src/lib/bridge-os.ts` → `openExternalUrl` →
// `src-tauri/src/shell/external_open.rs`.
//
// ⚠️ SCOPE: the desktop WEBVIEW only (`apps/desktop/src`). `apps/web` and
// `apps/admin` are ordinary browser pages where `target="_blank"` works exactly
// as written, and banning it there would be this gate answering a question it
// was not asked.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';
import { walk } from './_util.mjs';

refuseDirectRun(import.meta.url, 'pnpm verify:lint');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FACE = path.join(ROOT, 'apps/desktop/src');

/** The two ways a page can ask for a new window, and neither of them works. */
const PATTERNS = [
  { re: /target\s*=\s*["']_blank["']/g, what: 'target="_blank"' },
  { re: /\bwindow\.open\s*\(/g, what: 'window.open(' },
];

/** Files whose hits are the SUBJECT rather than a use.
 *
 * 🔴 Kept to test files and the door itself, and each one is a place that has to
 * be able to WRITE the forbidden string in order to assert something about it.
 * A production file must never appear here: an allowlist that can hold a live
 * call site is a gate with a hole shaped like the next defect. */
const ALLOW = [
  // The door's own JSDoc explains what it replaces.
  'lib/bridge-os.ts',
  // Tests that assert the strings are ABSENT (and say why).
  'main-window/data-flow-disclosure.test.ts',
];

export default async function externalLinkDoor() {
  const files = (await walk(FACE)).filter((f) => /\.(vue|ts)$/.test(f) && !f.endsWith('.d.ts'));
  // 🔴 An allowlist entry naming a file that no longer exists is a hole nobody
  // can see — the gate would keep passing while its exemptions drifted off the
  // tree. Checked here for the same reason the coordinate-anchors baseline
  // checks its own referrers.
  const present = new Set(files.map((f) => path.relative(FACE, f).replace(/\\/g, '/')));
  const stale = ALLOW.filter((a) => !present.has(a));
  if (stale.length > 0) {
    return {
      status: 'FAIL',
      detail: `the allowlist names ${stale.length} file(s) that do not exist: ${stale.join(', ')}`,
    };
  }

  const hits = [];
  let scanned = 0;
  // A control: if this gate ever stops seeing the door itself, it is scanning
  // the wrong tree and its silence would read as 「no dead links」.
  let doorSeen = 0;

  for (const file of files) {
    const rel = path.relative(FACE, file).replace(/\\/g, '/');
    const text = await readFile(file, 'utf8');
    scanned += 1;
    if (text.includes('openExternalUrl')) doorSeen += 1;
    if (ALLOW.includes(rel)) continue;
    for (const { re, what } of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const line = text.slice(0, m.index).split('\n').length;
        hits.push(`${rel}:${line} — ${what}`);
      }
    }
  }

  if (doorSeen === 0) {
    return {
      status: 'FAIL',
      detail: `scanned ${scanned} file(s) under apps/desktop/src and found no openExternalUrl caller at all — the scan is blind, not clean`,
    };
  }
  if (hits.length > 0) {
    return {
      status: 'FAIL',
      detail:
        `${hits.length} dead external link(s) — these open NOTHING in a WebView2 window ` +
        `(see this file's header). Route them through openExternalUrl (lib/bridge-os.ts):\n  ` +
        hits.join('\n  '),
    };
  }
  return {
    status: 'PASS',
    detail: `${scanned} desktop webview file(s), 0 target="_blank"/window.open; ${doorSeen} file(s) go through openExternalUrl`,
  };
}
