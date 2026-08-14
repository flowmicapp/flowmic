// verify/hooks/commit-msg.mjs
// Conventional-commit type-prefix gate. Invoked by .husky/commit-msg with the
// commit message file path as argv[2]. Pure node to dodge shell/CRLF quirks on
// Windows (husky runs hooks under sh).
//
// Accepts: <type>(optional-scope)!: <subject>
//   type ∈ feat|fix|docs|refactor|test|chore|build|perf
// Exit 0 on match, exit 1 with a bilingual error otherwise.

import { readFileSync } from 'node:fs';

const PATTERN = /^(feat|fix|docs|refactor|test|chore|build|perf)(\([a-z0-9/-]+\))?!?: .+/;

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
