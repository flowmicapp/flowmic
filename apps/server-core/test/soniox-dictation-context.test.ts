// Card ML-2: in a Japanese session the recognizer is told the dictated
// punctuation command words (てん / まる / 改行 ...), because without them Soniox
// wrote 天 and 開業 and the polish could not recover the commands. Only Japanese
// (measurement in src/stt/terminology-context.ts DICTATION_CONTEXT_TERMS).
import { describe, expect, it } from 'vitest';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { assembleSonioxContext, dictationContextTerms } from '../src/stt/terminology-context';
import { assembleSessionSonioxContext } from '../src/stt/engine-factory';

const U = 'dictation-ctx-user';

describe('dictation command words in the Soniox context (ML-2)', () => {
  it('a Japanese session gets them, in any spelling of the tag; no other language does', () => {
    expect(dictationContextTerms('ja')).toContain('改行');
    expect(dictationContextTerms('ja-JP')).toContain('改行');
    expect(dictationContextTerms('JA_jp')).toContain('改行');
    // Spanish and Korean were measured and not adopted (see the table's comment).
    expect(dictationContextTerms('es')).toEqual([]);
    expect(dictationContextTerms('ko')).toEqual([]);
    expect(dictationContextTerms('en-US')).toEqual([]);
    expect(dictationContextTerms('')).toEqual([]);
    expect(dictationContextTerms(undefined)).toEqual([]);
  });

  it('they follow the user terms and are counted on their own', () => {
    const a = assembleSonioxContext(['FlowMic'], undefined, dictationContextTerms('ja'));
    expect(a.context).toMatch(/FlowMic, てん, まる, 改行/u);
    expect(a).toMatchObject({ source: 'user', userTerms: 1, dictationTerms: 6, defaultTerms: 0 });
    expect(assembleSonioxContext([], undefined, dictationContextTerms('ja'))).toMatchObject({ source: 'dictation', userTerms: 0, dictationTerms: 6 });
  });

  it('the session builder passes the session language through', () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('ml2-dictation-context') });
    db.users.insert({ id: U, display_name: 'D', plan: 'free' });
    expect(assembleSessionSonioxContext(db.settings, U, undefined, 'ja').context).toContain('改行');
    expect(assembleSessionSonioxContext(db.settings, U, undefined, 'en').context).toBeUndefined();
    expect(assembleSessionSonioxContext(db.settings, U).context).toBeUndefined();
  });
});
