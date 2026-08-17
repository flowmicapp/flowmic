// verify/hooks/commit-msg.mjs
// Two gates on every commit message. Invoked by .husky/commit-msg with the
// commit message file path as argv[2]. Pure node to dodge shell/CRLF quirks on
// Windows (husky runs hooks under sh).
//
//   1. Conventional-commit type prefix: <type>(optional-scope)!: <subject>
//        type ∈ feat|fix|docs|refactor|test|chore|build|perf
//   2. NO AI ATTRIBUTION (owner 2026-08-01 iron rule, machine-enforced 2026-08-16)
//
// Exit 0 when both pass, exit 1 with a bilingual error otherwise.
//
// ── WHY GATE 2 EXISTS ────────────────────────────────────────────────────────
// The rule is old; the gate is new, and it took a measured breach to earn it.
// Nine commits across three repos shipped with `Co-authored-by: Cursor
// <cursoragent@cursor.com>` (main d2d2d972/f602b579/349d8e7c/4b140b90/54c27ed9,
// web b24a02d/f9ac504, admin 19c2fad/b1a4fa5). Every one was already pushed
// when it was found, and branch protection correctly refuses the force-push
// that would erase them — so the cost of catching this late is permanent.
//
// CLAUDE.md's own rule applies literally: 「要靠人记住的纪律，已经被漏掉两次，
// 就该自动化。」 This is the second recorded miss of the same shape (the first:
// the CJK slip in the public sync commit message on 2026-08-15, which happened
// because only Release *bodies* were gated and a hand-typed commit message was
// not). Writing the rule down a third time would change nothing.
//
// ── WHY IT SCANS TRAILER-SHAPED LINES AND NOT THE WHOLE MESSAGE ──────────────
// 🔴 A bare substring scan for "cursor" is UNUSABLE in this repo. The product
// injects text at a caret: `caret.rs`, `GetGUIThreadInfo`, 「光标行 3」, and any
// number of honest subjects like "fix(ui): keep the cursor in the input box"
// would be rejected. A gate that cries wolf is a gate people disable — which is
// precisely how the pre-commit golden-path gate died in an earlier round.
//
// So the scan is narrow on purpose, and each half answers one question:
//   · a line shaped `Key: value` whose KEY is an attribution key — then, and
//     only then, is the VALUE tested for an AI actor;
//   · the two fixed generation phrases ("Generated with …", the 🤖 marker),
//     which are attribution regardless of where they sit.
// Human co-authorship stays legal: `Co-authored-by: A Person <a@example.com>`
// passes. What is refused is naming a MODEL or an agent vendor as an author.
//
// LIMIT, STATED RATHER THAN IMPLIED: this catches commits made through git on
// a checkout where `pnpm install` has run (husky sets core.hooksPath). It does
// NOT catch `--no-verify`, nor a checkout that never ran prepare. Same coverage
// as the conventional-commit gate above it — no better, and it is not sold as
// better. The reverse control lives in scripts/commit-msg-attribution.test.mjs.

import { readFileSync } from 'node:fs';

const PATTERN = /^(feat|fix|docs|refactor|test|chore|build|perf)(\([a-z0-9/-]+\))?!?: .+/;

/** Trailer keys through which authorship can be claimed. Matched case-insensitively. */
const ATTRIBUTION_KEYS = new Set([
  'co-authored-by',
  'coauthored-by',
  'authored-by',
  'assisted-by',
  'generated-by',
  'signed-off-by',
  'on-behalf-of',
  'reviewed-by',
]);

/** AI actors — vendor names and their bot addresses. Deliberately a list of
 *  ACTORS, not of message shapes: the next agent will have a different trailer
 *  format and the same name. */
const AI_ACTOR = new RegExp(
  [
    'claude',
    'anthropic',
    'cursor(?:\\s*agent)?',
    'cursoragent',
    'copilot',
    'chatgpt',
    'openai',
    'gpt-[0-9]',
    'codex',
    'devin',
    'gemini',
    'aider',
    'windsurf',
    '\\bllm\\b',
    '\\bai\\s+assistant\\b',
  ].join('|'),
  'i',
);

/** Fixed generation phrases — attribution wherever they appear, so these are
 *  the ONLY patterns allowed to look outside a trailer-shaped line. */
const GENERATED_PHRASE = /(?:🤖|generated\s+with\b|co-?authored\s+with\b|written\s+by\s+(?:an?\s+)?ai\b)/i;

/**
 * @returns {string|null} the offending line, or null when the message is clean.
 */
export function findAiAttribution(message) {
  for (const rawLine of message.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue; // '#' lines are git's own commentary

    if (GENERATED_PHRASE.test(line) && AI_ACTOR.test(line)) return line;

    const m = /^([A-Za-z][A-Za-z-]*)\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    if (!ATTRIBUTION_KEYS.has(m[1].toLowerCase())) continue;
    if (AI_ACTOR.test(m[2])) return line;
  }
  return null;
}

export function isValid(message) {
  // First non-empty, non-comment line is the subject.
  const firstLine = message
    .split(/\r?\n/)
    .find((l) => l.trim() !== '' && !l.startsWith('#'));
  return firstLine != null && PATTERN.test(firstLine);
}

function main() {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('commit-msg: no message file argument\n');
    process.exit(1);
  }
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(`commit-msg: cannot read ${file}: ${err.message}\n`);
    process.exit(1);
  }
  // Attribution first: a message can be perfectly well-formed AND still name a
  // model as an author, and that is the failure that cannot be undone once
  // pushed. Reporting the fixable-by-reformatting problem first would bury it.
  const offending = findAiAttribution(raw);
  if (offending !== null) {
    process.stderr.write(
      '\n✖ Commit message rejected — AI attribution / 提交信息带了 AI 署名\n' +
        `  got:  ${offending}\n\n` +
        '  owner iron rule (2026-08-01): no commit or PR in any repo may carry an\n' +
        '  AI co-author, generation notice, or agent byline. Remove that line.\n' +
        '  owner 铁律：任何仓库的提交/PR 都不许出现 AI 署名或「由…生成」落款，删掉那一行。\n\n' +
        '  A human co-author is still fine: Co-authored-by: A Person <a@example.com>\n' +
        '  真人协作者照常可写；被拒的只是把模型或代理厂商写成作者。\n\n'
    );
    process.exit(1);
  }

  if (isValid(raw)) process.exit(0);

  const firstLine = raw.split(/\r?\n/).find((l) => l.trim() !== '' && !l.startsWith('#')) || '';
  process.stderr.write(
    '\n✖ Commit message rejected / 提交信息不合规\n' +
      `  got:      ${firstLine}\n` +
      '  expected: <type>(scope)?: <subject>\n' +
      '  types:    feat|fix|docs|refactor|test|chore|build|perf\n' +
      '  期望格式: 类型(可选范围)?: 描述  (类型见上)\n' +
      '  e.g.      feat(lint): add protocol whitelist guard\n\n'
  );
  process.exit(1);
}

// Only run when invoked directly (not when imported by a test).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('commit-msg.mjs');
if (invokedDirectly) main();
