#!/usr/bin/env node
// Drill for verify/lint/file-size.mjs — the 800-line source cap (with a
// pinned, shrink-only "translation bloat debt" ratchet for files English-ized
// past the cap). Until this file existed it had no fixture test.
//
// `evaluateFile(relPath, lines, opts)` and `unseenPinnedEntries(seenSet)` were
// extracted from run() on 2026-09-02 (B2-A): pure functions taking a relative
// path and a line count, with no filesystem access, so this drill never has
// to write an 801-line file to disk.
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP.

import { evaluateFile, unseenPinnedEntries, TRANSLATION_BLOAT_BASELINE, SRC_MAX, TEST_HTML_MAX } from '../verify/lint/file-size.mjs';
import fileSize from '../verify/lint/file-size.mjs';

let failures = 0;
const ok = (name, detail) => console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

console.log(`=== §1 REVERSE CONTROL: a file at exactly the cap (${SRC_MAX}) is ok; ${SRC_MAX + 1} FAILs ===`);
{
  const atCap = evaluateFile('apps/desktop/src/lib/x.ts', SRC_MAX, {});
  check(atCap.kind === 'ok', 'exactly SRC_MAX lines is fine (cap is inclusive)', JSON.stringify(atCap));
  const overCap = evaluateFile('apps/desktop/src/lib/x.ts', SRC_MAX + 1, {});
  check(overCap.kind === 'over', 'SRC_MAX + 1 lines is over cap', JSON.stringify(overCap));
  check(overCap.message.includes(String(SRC_MAX + 1)), 'the message names the actual line count', overCap.message);
}

console.log('=== §2 negative control: a small file is fine ===');
{
  const ev = evaluateFile('apps/desktop/src/lib/small.ts', 10, {});
  check(ev.kind === 'ok', 'a 10-line file is well under cap', JSON.stringify(ev));
}

console.log(`=== §3 test files get the looser ${TEST_HTML_MAX}-line cap, not SRC_MAX ===`);
{
  const between = SRC_MAX + 50; // over SRC_MAX, under TEST_HTML_MAX
  const prod = evaluateFile('apps/desktop/src/lib/x.ts', between, {});
  check(prod.kind === 'over', `a production file at src_max+50 (${between}) is over its cap`, JSON.stringify(prod));
  const test = evaluateFile('apps/desktop/src/lib/x.test.ts', between, {});
  check(test.kind === 'ok', 'the SAME line count in a .test.ts file is fine under the looser cap', JSON.stringify(test));
}

console.log('=== §4 HTML demo files get the looser cap via the isHtml flag ===');
{
  const html = evaluateFile('docs/demo/board.html', SRC_MAX + 50, { isHtml: true });
  check(html.kind === 'ok', 'an HTML file under TEST_HTML_MAX is fine even over SRC_MAX', JSON.stringify(html));
}

console.log('=== §5 a pinned translation-bloat entry: at or under its pinned ceiling is ok-pinned ===');
{
  const [pinnedPath, pinnedLines] = [...TRANSLATION_BLOAT_BASELINE.entries()][0];
  const ev = evaluateFile(pinnedPath, pinnedLines, {});
  check(ev.kind === 'ok-pinned', 'exactly at its pinned debt ceiling is fine', JSON.stringify(ev));
}

console.log('=== §6 REVERSE CONTROL: one line OVER a pinned ceiling is over-pin (debt may shrink, never grow) ===');
{
  const [pinnedPath, pinnedLines] = [...TRANSLATION_BLOAT_BASELINE.entries()][0];
  const ev = evaluateFile(pinnedPath, pinnedLines + 1, {});
  check(ev.kind === 'over-pin', 'one line beyond the pinned ceiling is reported as growing debt', JSON.stringify(ev));
  check(ev.message.includes('never grow'), 'the message states the ratchet direction', ev.message);
}

console.log('=== §7 REVERSE CONTROL: a pinned file back under the REAL cap is stale-pin, not silently ok ===');
{
  const [pinnedPath] = [...TRANSLATION_BLOAT_BASELINE.entries()][0];
  const ev = evaluateFile(pinnedPath, SRC_MAX - 5, {});
  check(ev.kind === 'stale-pin', 'a pinned file that shrank back under the real cap is reported, not silently accepted', JSON.stringify(ev));
  check(ev.message.includes('delete its baseline entry'), 'the message tells the reader what to do', ev.message);
}

console.log('=== §8 unseenPinnedEntries: a baseline path never scanned (renamed/deleted) is reported (positive control) ===');
{
  const seen = new Set(); // simulate a walk that never visited any pinned path
  const stale = unseenPinnedEntries(seen);
  check(stale.length === TRANSLATION_BLOAT_BASELINE.size, 'every pinned entry is reported when none were seen', JSON.stringify(stale));
}

console.log('=== §9 negative control: unseenPinnedEntries reports nothing when every pinned path was seen ===');
{
  const seen = new Set(TRANSLATION_BLOAT_BASELINE.keys());
  const stale = unseenPinnedEntries(seen);
  check(stale.length === 0, 'no stale entries when the walk visited every pinned path', JSON.stringify(stale));
}

console.log('=== §10 the lint itself runs on the real repo and answers ===');
{
  const res = await fileSize();
  check(res.status === 'PASS', 'the real repo is within all caps', JSON.stringify(res));
  console.log(`  --  measured on this tree: ${res.status} — ${res.detail}`);
  check(res.detail.includes(`${TRANSLATION_BLOAT_BASELINE.size} pinned`), 'the PASS detail names the pinned-debt count', res.detail);
}

console.log(`\n${failures === 0 ? '✔' : '✘'} file-size drill — ${failures} assertion failure(s)`);
process.exit(failures === 0 ? 0 : 1);
