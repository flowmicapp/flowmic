// THE SECOND TERMINOLOGY DESTINATION — the user's terms reach Soniox.
//
// Until owner's 2026-08-24 ruling the three terminology sources were resolved
// for every session and handed to FunASR only (`withHotwords`: `id === 'funasr'`
// and nothing else). On the production managed default — Soniox — a personal
// dictionary therefore could not influence recognition at all; it could only
// repair a word after it had been misheard. This file is the proof that the
// terms now leave the building.
//
// 🔴 WHAT IS ASSERTED AND WHAT IS NOT. These tests assert ASSEMBLY and DELIVERY:
// the string is built from the same resolver the hotwords leg uses, and it is
// attached to the Soniox config and to no other engine's. They assert NOTHING
// about accuracy. The RT-6 card is explicit that `context`'s value is only
// measurable against audio containing the jargon, run with and without — and the
// resident eval corpus is text that is already correctly transcribed. A green
// run here means "the field is on the wire", never "recognition improved".

import { describe, expect, it } from 'vitest';

import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { buildSonioxContext, SONIOX_CONTEXT_MAX_CHARS } from '../src/stt/terminology-context';
import { loadSonioxContext, loadHotwords } from '../src/stt/engine-factory';

const U = 'ctx-user';

function freshDb(): DbConnection {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('soniox-context-key') });
  db.users.insert({ id: U, display_name: 'C', plan: 'free' });
  return db;
}

describe('buildSonioxContext — assembly', () => {
  it('names what the list is, so free text is not ambiguous between hint and constraint', () => {
    const s = buildSonioxContext(['Kubernetes', 'FlowMic'])!;
    expect(s).toContain('likely to be spoken');
    expect(s).toContain('Kubernetes');
    expect(s).toContain('FlowMic');
  });

  it('an empty set is ABSENT, not an empty string', () => {
    // Absent and present-but-empty are different frames, and a vendor is free to
    // read the second as "transcribe only these", i.e. nothing.
    expect(buildSonioxContext([])).toBeUndefined();
    expect(buildSonioxContext(['   ', ''])).toBeUndefined();
  });

  it('dedupes and stays under the documented ceiling, truncating by TERM', () => {
    const many = Array.from({ length: 4000 }, (_, i) => `Term${i}`);
    const s = buildSonioxContext([...many, 'Term0'])!;
    expect(s.length).toBeLessThanOrEqual(SONIOX_CONTEXT_MAX_CHARS);
    // Truncation must not leave half a word: every comma-separated piece is a
    // whole term that was in the input.
    const pieces = s.slice(s.indexOf(':') + 1).split(',').map((p) => p.trim());
    for (const p of pieces) expect(many).toContain(p);
    // deduped: Term0 appears once
    expect(pieces.filter((p) => p === 'Term0')).toHaveLength(1);
  });
});

describe('loadSonioxContext — the same source as the hotwords leg', () => {
  it('a dictionary pack reaches BOTH destinations, in each one shape', () => {
    const db = freshDb();
    db.settings.write(U, 'scenario.card', { professions: [], domains: [], packs: ['tech-dev'], terms: [] });

    const ctx = loadSonioxContext(db.settings, U)!;
    const hot = loadHotwords(db.settings, U)!;

    // Same term, two wire formats — which is the whole reason these are two
    // functions rather than one with a branch.
    expect(ctx).toContain('Docker');
    expect(hot).toContain('Docker');
    expect(hot.trim().startsWith('{')).toBe(true);   // FunASR: {term:weight} JSON
    expect(ctx.trim().startsWith('{')).toBe(false);  // Soniox: free text
  });

  it('REVERSE CONTROL — no terminology configured ⇒ no context at all', () => {
    const db = freshDb();
    expect(loadSonioxContext(db.settings, U)).toBeUndefined();
    expect(loadHotwords(db.settings, U)).toBeUndefined();
  });

  it('aliases are deliberately NOT sent — they are what the replacer removes', () => {
    const db = freshDb();
    // 2026-09-03 (owner Q1): aliases ride the card term; `stt.dictionary` is retired.
    db.settings.write(U, 'scenario.card', {
      professions: [], domains: [], packs: [], terms: [{ term: 'Kubernetes', aliases: ['库伯'] }],
    });
    const ctx = loadSonioxContext(db.settings, U)!;
    expect(ctx).toContain('Kubernetes');
    // Feeding 库伯 here would ask the recognizer to produce exactly the string
    // the deterministic replacement stage exists to map away.
    expect(ctx).not.toContain('库伯');
  });
});
