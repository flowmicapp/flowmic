#!/usr/bin/env node
// Drill for the commit-msg AI-attribution gate (verify/hooks/commit-msg.mjs).
//
// WHY IT LIVES HERE AND NOT NEXT TO THE HOOK: `scripts/run-script-tests.mjs`
// discovers `scripts/*.test.mjs` by glob and IS wired into `verify:delivery`.
// Nothing walks `verify/hooks/`. A test the gate never calls is the runtime
// form of a façade — 「它红着和不存在是一回事」 — so the file goes where the
// runner already looks rather than where it would read most tidily.
//
// 🔴 THE POSITIVE SAMPLES ARE REAL. Every rejected message below is a verbatim
// trailer from a commit that actually shipped on 2026-08-15 against the owner's
// 2026-08-01 iron rule (main f602b579 / 54c27ed9 …, web b24a02d / f9ac504,
// admin 19c2fad / b1a4fa5). A drill written from invented strings proves the
// regex matches what its author imagined; these prove it would have stopped
// what actually happened.
//
// The negative samples matter just as much and are the reason the scan is
// narrow: this product injects text at a caret, so honest subjects and bodies
// say "cursor" constantly. A gate that rejected those would be turned off
// within a day, which is how the pre-commit golden-path gate died once already.
//
// Exit 0 = pass, 1 = fail (contract of scripts/run-script-tests.mjs).

import { findAiAttribution, isValid } from '../verify/hooks/commit-msg.mjs';

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) {
    failures += 1;
    console.error(`  ✗ ${label}\n      expected: ${expected}\n      actual:   ${actual}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

function rejects(label, message) {
  check(label, findAiAttribution(message) !== null, true);
}

function accepts(label, message) {
  const hit = findAiAttribution(message);
  check(label + (hit ? ` (falsely flagged: ${hit})` : ''), hit === null, true);
}

console.log('AI attribution — the real breaches (verbatim from 2026-08-15):');
rejects(
  'main f602b579 — the exact trailer that shipped nine times',
  'feat(server): first-party site aggregate counts (schema + public/ops routes)\n\n' +
    'Add site_daily_counts buckets, cookieless collect/download hop, auth-success\n' +
    'bumps, and admin-gated summary/breakdown. FLOWMIC_SITE_ANALYTICS defaults off.\n\n' +
    'Co-authored-by: Cursor <cursoragent@cursor.com>\n',
);
rejects(
  'the harness default this repo overrides',
  'fix(stt): stop blaming the engine\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
);
rejects(
  'the generation notice, robot marker and all',
  'docs: update the changelog\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n',
);
rejects('casing and spacing must not be an escape hatch', 'chore: x\n\nco-authored-by:   CURSOR AGENT <a@b>\n');
rejects('a different vendor, same shape', 'chore: x\n\nCo-authored-by: GitHub Copilot <copilot@github.com>\n');
rejects('attribution through a non-coauthor key', 'chore: x\n\nAssisted-by: ChatGPT\n');

console.log('\nHonest messages this product genuinely writes — must all pass:');
accepts('a caret subject, the false positive that would kill the gate', 'fix(ui): keep the cursor in the input box');
accepts(
  'a body discussing the caret probe at length',
  'fix(inject): read the caret through GetGUIThreadInfo\n\n' +
    'The cursor is where the text lands, so the probe asks the target thread for\n' +
    'its GUI info rather than guessing. 光标行 3 in the manual drill.\n',
);
accepts(
  'a human co-author stays legal — this gate is about models, not co-authorship',
  'feat(web): first-party site pageview beacon\n\nCo-authored-by: A Person <a@example.com>\n',
);
accepts('a subject naming the vendor as a SUBJECT, not an author', 'feat(stt): route managed sessions to Soniox');
accepts(
  'prose mentioning the agent without claiming authorship',
  'docs: record how the cursor-agent window was dispatched\n\n' +
    'The LAN agent pulled main and pushed back; this note says what it ran.\n',
);
accepts('the plain message shape used all round', 'docs: record the site-analytics deploy');

console.log('\nThe conventional-commit gate still answers its own question:');
check('a well-formed subject is valid', isValid('feat(lint): add protocol whitelist guard'), true);
check('an unprefixed subject is not', isValid('add protocol whitelist guard'), false);

if (failures > 0) {
  console.error(`\n✗ commit-msg attribution drill: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\n✓ commit-msg attribution drill: all checks passed');
process.exit(0);
