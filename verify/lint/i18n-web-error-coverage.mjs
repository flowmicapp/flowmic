// The browser selection is a fifth error-code surface (decision
// docs/decisions/2026-09-22-inject-target-not-ready-lead-ruling-and-cached-mode-pin.md).
// Check INJECT_* from the actual registry, not yesterday's copied code list.
// New codes, including desktop-platform refusals, must select a sentence.
// This checks coverage, not whether a renderer actually displays the sentence;
// the browser's mounted-screen tests remain responsible for that other claim.
import path from 'node:path';
import { ROOT, readText } from './_util.mjs';
import { ERROR_CODE_SOURCE_RELS, parseErrorCodes } from './i18n-error-keys.mjs';
import { refuseDirectRun } from '../../scripts/module-entrypoint-guard.mjs';

refuseDirectRun(import.meta.url, 'pnpm verify:lint');
export const name = 'i18n-web-error-coverage';

const PREFIXES = [
  'injectVerdictNote_', 'deliveryRefusalNote_',
  'cloudImageRelayErrorNote_', 'pcAdmissionRefusalNote_',
];

// Existing omissions, not an allowance for new omissions. These codes have no
// code-specific sentence in subset.json today. Keep the debt visible by name:
// In flowmic-web, `packages/core/src/outbox/row.ts`:374-393 rowNoteKey returns null
// when the selected catalogue lacks a candidate; its row.test.ts pins the
// NOT_PRIMARY case. DEFERRED has a distinct status face in row.ts:44, not a note.
// RESULT_TIMEOUT is the HTTP image waiter
// (packages/protocol/src/error-codes.ts:595-604),
// rather than a new browser note. This gate does not claim these four have
// full explanatory copy. Any added exception must be a separately reviewed diff.
export const EXISTING_WITHOUT_CODE_NOTE = new Set([
  'INJECT_DEFERRED_NOT_AUTOINJECTED', 'INJECT_NOT_PRIMARY',
  'INJECT_NOT_IN_ROOM', 'INJECT_RESULT_TIMEOUT',
]);

export function validateCoverage(codes, subset) {
  if (!Array.isArray(subset?.groups) || subset.groups.some((group) => !Array.isArray(group.keys))) {
    return { status: 'FAIL', detail: 'i18n/web/subset.json: invalid groups/keys structure' };
  }
  const registered = new Set(codes);
  const injectCodes = codes.filter((code) => code.startsWith('INJECT_'));
  if (!injectCodes.length) return { status: 'FAIL', detail: 'registry has no INJECT_* codes (parser drift?)' };
  const keys = subset.groups.flatMap((group) => group.keys);
  const mapped = new Set();
  const errors = [];
  for (const key of keys) {
    if (typeof key !== 'string') {
      errors.push('non-string selected key');
      continue;
    }
    const prefix = PREFIXES.find((candidate) => key.startsWith(candidate));
    if (!prefix) continue;
    const code = key.slice(prefix.length);
    if (!registered.has(code)) errors.push(`${key}: code is absent from protocol registry`);
    if (mapped.has(code)) errors.push(`${code}: more than one selected code-note mapping`);
    mapped.add(code);
  }
  for (const code of injectCodes) {
    if (!mapped.has(code) && !EXISTING_WITHOUT_CODE_NOTE.has(code)) {
      errors.push(`${code}: missing code-to-sentence selection in i18n/web/subset.json`);
    }
  }
  for (const code of EXISTING_WITHOUT_CODE_NOTE) {
    if (registered.has(code) && mapped.has(code)) errors.push(`${code}: remove obsolete no-note exception`);
  }
  return errors.length
    ? { status: 'FAIL', detail: errors.join('; ') }
    : { status: 'PASS', detail: `${injectCodes.length} INJECT_* registry codes checked; ${mapped.size} selected code-note mappings; ${injectCodes.filter((code) => EXISTING_WITHOUT_CODE_NOTE.has(code)).length} named existing no-note cases` };
}

export default async function run() {
  const codes = [];
  for (const rel of ERROR_CODE_SOURCE_RELS) {
    const source = await readText(path.join(ROOT, rel));
    if (source == null) return { status: 'FAIL', detail: `cannot read ${rel}` };
    const parsed = parseErrorCodes(source);
    if (parsed.error || !parsed.entries.length) return { status: 'FAIL', detail: `${rel}: ${parsed.error ?? 'no error codes parsed'}` };
    codes.push(...parsed.entries.map((entry) => entry.code));
  }
  if (new Set(codes).size !== codes.length) return { status: 'FAIL', detail: 'duplicate protocol code across registry shards' };
  try {
    return validateCoverage(codes, JSON.parse(await readText(path.join(ROOT, 'i18n/web/subset.json'))));
  } catch (error) {
    return { status: 'FAIL', detail: `cannot parse i18n/web/subset.json: ${error.message}` };
  }
}
