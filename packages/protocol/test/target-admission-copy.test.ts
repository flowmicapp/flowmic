// The protocol fallback and the phone admission note state the same approved
// fact. Compare the registry's public renderer with the owner copy catalogue,
// rather than keeping another hand-written translation in this test.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getErrorMessage } from '../src/error-codes';

describe('target admission formal copy', () => {
  it.each(['en', 'zh-CN'] as const)('matches the approved %s admission note', (locale) => {
    const catalogue = JSON.parse(readFileSync(
      new URL(`../../../i18n/mobile/${locale}.json`, import.meta.url), 'utf8',
    )) as { strings: Record<string, string> };
    const approved = catalogue.strings.pcAdmissionRefusalNote_INJECT_TARGET_NOT_READY;
    expect(approved).not.toContain('DEV:');
    // Both approved notes are plain Dart string literals in this source. The
    // generator gate owns general Dart decoding; no second decoder belongs here.
    expect(`'${getErrorMessage('INJECT_TARGET_NOT_READY', locale)}'`).toBe(approved);
  });
});
