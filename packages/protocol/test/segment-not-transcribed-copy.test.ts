// card HANGUP-3 — the registry fallback and the phone's own sentence for
// STT_SEGMENT_NOT_TRANSCRIBED state the same approved fact. Compare the
// registry's public renderer with the phone catalogue (the Gemini-approved
// source), rather than keeping another hand-written translation here.
// Same construction as target-admission-copy.test.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getErrorMessage } from '../src/error-codes';

describe('STT_SEGMENT_NOT_TRANSCRIBED registry copy', () => {
  it.each(['en', 'zh-CN'] as const)('matches the approved %s phone sentence', (locale) => {
    const catalogue = JSON.parse(readFileSync(
      new URL(`../../../i18n/mobile/${locale}.json`, import.meta.url), 'utf8',
    )) as { strings: Record<string, string> };
    const approved = catalogue.strings.sttStallSegmentNotTranscribed;
    expect(approved).toBeDefined();
    expect(approved).not.toContain('DEV:');
    // Plain single-quoted Dart literals in this source; the generator gate owns decoding.
    expect(`'${getErrorMessage('STT_SEGMENT_NOT_TRANSCRIBED', locale)}'`).toBe(approved);
  });
});
