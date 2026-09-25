// Acceptance review 2026-09-22 §8 S-2: the web selection must not silently
// omit a PC injection verdict. Sentences are generated from mobile, not copied.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PC_INJECTION_VERDICT_CODES } from '../src/inject-verdict-authorship';

const subset = JSON.parse(readFileSync(new URL('../../../i18n/web/subset.json', import.meta.url), 'utf8')) as {
  groups: { id: string; keys: string[] }[];
};
const keys = new Set(subset.groups.flatMap(group => group.keys));

describe('web PC injection verdict copy binding', () => {
  for (const code of PC_INJECTION_VERDICT_CODES) {
    it(`${code} has selected wording for the web client`, () => {
      // Existing web outbox row.ts routes this verdict to deferredNotInjected,
      // whose label is statusDeferredNotInjected rather than a reason note.
      // NO_TEXT_TARGET already has a selected note in the web-target group.
      const key = code === 'INJECT_DEFERRED_NOT_AUTOINJECTED'
        ? 'statusDeferredNotInjected' : `injectVerdictNote_${code}`;
      expect(keys.has(key), `web subset missing ${key}`).toBe(true);
    });
  }
});
