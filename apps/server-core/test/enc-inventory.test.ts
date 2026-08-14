// D2 Stage 0 — a read-only inventory capability must be "really called", not merely defined.
//
// SPEC-REF: src/db/enc-inventory.ts (the module this file drives)
//           docs/strategy/2026-08-05-d2-secret-domain-separation-design-cn.md §4
//             Stage 0 ("add a read-only inventory capability: how many enc: fields are in the DB, and what prefixes they have")
//           docs/strategy/2026-08-05-d2-stage0-delivery-cn.md (this card's
//             delivery doc — §3 quotes real captured output from this file)
//           CLAUDE.md anti-façade ①: "a capability was defined and nobody calls it" is this repo's #1 defect shape
//
// WHY THE WIRING TEST AT THE BOTTOM, in the exact style of
// test/ops-audit-wiring.test.ts: a function that only test files call is
// DEFINED, not USED. inspectEncInventory's real production caller is
// src/startup-secret-check.ts — that grep is the proof, not a sentence in a
// comment asserting it.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey, ENVELOPE_PREFIX } from '../src/auth/crypto';
import { inspectEncInventory } from '../src/db/enc-inventory';
import { stripTsComments as stripComments } from '../../../verify/lint/strip-ts-comments.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(HERE, '..', 'src');

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFilesUnder(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** repo-relative src/ paths (comment-stripped) matching `re`, EXCLUDING the
 *  module's own definition file — a definition line textually contains the
 *  function name too, and would otherwise count as its own caller. */
function srcCallersMatching(re: RegExp, definitionFile: string): string[] {
  return tsFilesUnder(SRC)
    .map((f) => relative(SRC, f).replace(/\\/g, '/'))
    .filter((f) => f !== definitionFile)
    .filter((f) => re.test(stripComments(readFileSync(join(SRC, f), 'utf8'))))
    .sort();
}

describe('inspectEncInventory — read-only, and never decrypts', () => {
  let db: DbConnection;

  function fresh(secret: string): DbConnection {
    return createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey(secret) });
  }

  it('an empty database: zero fields, no sample, no prefixes', () => {
    db = fresh('enc-inventory-empty-secret-32-bytes-xx');
    const report = inspectEncInventory(db.raw);
    expect(report).toEqual({ totalApiKeyFields: 0, byPrefix: {}, sampleEnvelope: null, unparseableRows: 0 });
    db.close();
  });

  it('🔴 counts REAL enc:v1: envelopes written through the real SettingsRepo — and a sibling row with no api_key contributes NOTHING', () => {
    db = fresh('enc-inventory-count-secret-32-bytes-xxx');
    db.users.insert({ id: 'u1', email: 'a@b.co', display_name: 'A' });
    db.users.insert({ id: 'u2', email: 'c@b.co', display_name: 'C' });
    // u1: one settings row carrying TWO api_key leaves (nested + array), one
    // settings row carrying NONE — the negative case's positive control.
    db.settings.write('u1', 'stt.routings', [{ language: 'zh', engine_id: 'funasr', api_key: 'sk-u1-a' }]);
    db.settings.write('u1', 'llm.config', { nested: { deeper: { apiKey: 'sk-u1-b' } } });
    db.settings.write('u1', 'stt.polish', { enabled: true }); // no api_key field at all
    // u2: one more, to prove the scan is not scoped to a single user.
    db.settings.write('u2', 'stt.routings', [{ language: 'en', engine_id: 'whisper', api_key: 'sk-u2-a' }]);

    const report = inspectEncInventory(db.raw);
    expect(report.totalApiKeyFields).toBe(3);
    expect(report.byPrefix).toEqual({ [ENVELOPE_PREFIX]: 3 });
    expect(report.unparseableRows).toBe(0);
    expect(report.sampleEnvelope).not.toBeNull();
    expect((report.sampleEnvelope as string).startsWith(ENVELOPE_PREFIX)).toBe(true);
    db.close();
  });

  it('an api_key value with an UNRECOGNIZED prefix is counted separately, and is never chosen as the sample', () => {
    db = fresh('enc-inventory-unrecognized-secret-32byte');
    db.users.insert({ id: 'u1', email: 'a@b.co', display_name: 'A' });
    // A real enc:v1: envelope, through the repo …
    db.settings.write('u1', 'stt.routings', [{ language: 'zh', engine_id: 'funasr', api_key: 'sk-good' }]);
    // … and a row planted directly (bypassing encryption entirely) to simulate
    // a legacy/manually-edited row whose api_key never got wrapped. This is
    // deliberately raw SQL, not `.write()`, because `.write()` always encrypts —
    // there is no repo call that produces this shape, which is exactly why it
    // has to be simulated to exist at all.
    db.raw
      .prepare('INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?,?,?,?)')
      .run('u1', 'legacy.key', JSON.stringify({ api_key: 'plain-not-enveloped' }), '2020-01-01T00:00:00.000Z');

    const report = inspectEncInventory(db.raw);
    expect(report.totalApiKeyFields).toBe(2);
    expect(report.byPrefix).toEqual({ [ENVELOPE_PREFIX]: 1, unrecognized: 1 });
    // The sample must be the RECOGNIZED one — an unrecognized value is not
    // something startup-secret-check.ts could meaningfully decrypt-test.
    expect(report.sampleEnvelope).not.toBeNull();
    expect((report.sampleEnvelope as string).startsWith(ENVELOPE_PREFIX)).toBe(true);
    expect(report.sampleEnvelope).not.toBe('plain-not-enveloped');
    db.close();
  });

  it('a row whose value column is not valid JSON is counted as unparseable, and does NOT stop the rest of the scan', () => {
    db = fresh('enc-inventory-corrupt-secret-32-bytes-x');
    db.users.insert({ id: 'u1', email: 'a@b.co', display_name: 'A' });
    db.settings.write('u1', 'stt.routings', [{ language: 'zh', engine_id: 'funasr', api_key: 'sk-survives' }]);
    db.raw
      .prepare('INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?,?,?,?)')
      .run('u1', 'corrupt.row', 'not valid json{{{', '2020-01-01T00:00:00.000Z');

    const report = inspectEncInventory(db.raw);
    expect(report.unparseableRows).toBe(1);
    // POSITIVE CONTROL: the good row alongside the corrupt one is still
    // counted — a scan that silently gave up entirely would ALSO show
    // unparseableRows:1 with totalApiKeyFields:0, so this line is load-bearing.
    expect(report.totalApiKeyFields).toBe(1);
    db.close();
  });

  it('🔴 REAL CAPTURED OUTPUT (pasted into the delivery doc §3, verbatim)', () => {
    db = fresh('enc-inventory-capture-secret-32-bytes-x');
    db.users.insert({ id: 'u1', email: 'a@b.co', display_name: 'A' });
    db.users.insert({ id: 'u2', email: 'b@b.co', display_name: 'B' });
    db.settings.write('u1', 'stt.routings', [{ language: 'zh', engine_id: 'funasr', api_key: 'sk-capture-1' }]);
    db.settings.write('u2', 'llm.config', { providers: [{ name: 'x', api_key: 'sk-capture-2' }] });
    const report = inspectEncInventory(db.raw);
    // eslint-disable-next-line no-console -- deliberate: this line's stdout is
    // captured verbatim into the delivery doc, not a debugging leftover.
    console.log('【measured·enc-inventory actual output】', JSON.stringify(report));
    expect(report.totalApiKeyFields).toBe(2);
    db.close();
  });
});

describe('inspectEncInventory — anti-façade: a real production caller, not just this test file', () => {
  it('🔴 the ONLY production caller is startup-secret-check.ts', () => {
    const callers = srcCallersMatching(/\binspectEncInventory\s*\(/, 'db/enc-inventory.ts');
    expect(
      callers,
      'inspectEncInventory has no production caller outside its own definition — it would be ' +
        'DEFINED but not USED (this repo\'s #1 historical defect shape). The intended caller is ' +
        'startup-secret-check.ts checkSettingsSecretAtBoot().',
    ).toEqual(['startup-secret-check.ts']);
  });

  it('🔴 …and startup-secret-check.ts itself is actually wired into bootstrap.ts', () => {
    // A caller inside a module nobody calls is still [unwired] (the exact 0.2.47
    // ops-audit lesson this repo already learned once — see
    // test/ops-audit-wiring.test.ts). This is the second link in that chain.
    const callers = srcCallersMatching(/\bcheckSettingsSecretAtBoot\s*\(/, 'startup-secret-check.ts');
    expect(callers).toEqual(['bootstrap.ts']);
  });
});
