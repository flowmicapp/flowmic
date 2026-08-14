// D2 Stage 0 — boot self-check: make §1.3's silent disaster loud (warn only, do not refuse to start).
//
// SPEC-REF: src/startup-secret-check.ts (the module this file drives)
//           docs/strategy/2026-08-05-d2-secret-domain-separation-design-cn.md
//             §1.3 (the silent-disaster mechanism) §3.4 (the self-check design)
//             §7 decision 3 (refuse-to-start vs warn-only — owner has not ruled; this file only tests the warn branch)
//           docs/strategy/2026-08-05-d2-stage0-delivery-cn.md (§5 quotes the RED
//             failure text captured here, verbatim)
//           test/ops-audit-wiring.test.ts (the grep-wiring pattern this file's
//             last two tests copy — a caller that lives in a module nobody
//             calls is still [unwired])

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { checkSettingsSecretAtBoot } from '../src/startup-secret-check';
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

function srcCallersMatching(re: RegExp, definitionFile: string): string[] {
  return tsFilesUnder(SRC)
    .map((f) => relative(SRC, f).replace(/\\/g, '/'))
    .filter((f) => f !== definitionFile)
    .filter((f) => re.test(stripComments(readFileSync(join(SRC, f), 'utf8'))))
    .sort();
}

const SECRET_A = 'startup-check-secret-a-32-bytes-xxxxxxxx';
const SECRET_B = 'startup-check-secret-b-DIFFERENT-32-bytes';

function seededDb(): DbConnection {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey(SECRET_A) });
  db.users.insert({ id: 'u1', email: 'a@b.co', display_name: 'A' });
  db.settings.write('u1', 'stt.routings', [{ language: 'zh', engine_id: 'funasr', api_key: 'sk-startup-check' }]);
  return db;
}

describe('checkSettingsSecretAtBoot', () => {
  it('a fresh database with no api_key field ever saved: ok, and says explicitly there was nothing to check', () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey(SECRET_A) });
    const result = checkSettingsSecretAtBoot(db.raw, deriveKey(SECRET_A));
    expect(result.ok).toBe(true);
    expect(result.totalApiKeyFields).toBe(0);
    expect(result.detail).toContain('nothing to verify');
    expect(result.reason).toBeUndefined();
    db.close();
  });

  it('🟢 POSITIVE CONTROL — the CORRECT key decrypts the real stored envelope: ok, and says so', () => {
    const db = seededDb();
    const result = checkSettingsSecretAtBoot(db.raw, deriveKey(SECRET_A));
    expect(result.ok).toBe(true);
    expect(result.totalApiKeyFields).toBe(1);
    expect(result.detail).toContain('decrypted successfully');
    expect(result.reason).toBeUndefined();
    db.close();
  });

  it('🔴 RED — a MISMATCHED key fails loud: ok:false, with a real (non-empty) captured reason and the §1.3 explanation', () => {
    const db = seededDb();
    // The exact §1.3 scenario: data was encrypted under SECRET_A; this boot's
    // resolved secret is SECRET_B (e.g. only one of FLOWMIC_JWT_SECRET /
    // FLOWMIC_SETTINGS_SECRET got restored after a DB restore).
    const result = checkSettingsSecretAtBoot(db.raw, deriveKey(SECRET_B));
    expect(result.ok).toBe(false);
    expect(result.totalApiKeyFields).toBe(1);
    // [measured · RED, verbatim in the delivery doc §5] — captured, not assumed: GCM tag-verification
    // errors are OpenSSL/Node-version-flavored text, so this asserts SHAPE
    // (a real, non-empty message) rather than pinning an exact string that
    // could drift with the Node runtime and turn a passing gate into a false
    // failure unrelated to this card.
    expect(typeof result.reason).toBe('string');
    expect((result.reason as string).length).toBeGreaterThan(0);
    expect(result.detail).toContain('database was restored but the deployment secret env var was not');
    // eslint-disable-next-line no-console -- deliberate: this exact text is
    // quoted verbatim into docs/strategy/2026-08-05-d2-stage0-delivery-cn.md §5.
    console.log('【measured·RED original text】', result.reason);
    db.close();
  });

  it('a positive/negative pair over the SAME seeded row: right key ok, wrong key not ok — not two unrelated fixtures', () => {
    const db = seededDb();
    expect(checkSettingsSecretAtBoot(db.raw, deriveKey(SECRET_A)).ok).toBe(true);
    expect(checkSettingsSecretAtBoot(db.raw, deriveKey(SECRET_B)).ok).toBe(false);
    db.close();
  });

  // 🔴 lead 2026-08-05 acceptance: enc-inventory.ts counts unparseable rows and
  // its doc comment promises that number becomes VISIBLE rather than silently
  // walked past. It is this result object that carries it to the boot log, so
  // the promise is only kept if it survives this hop — the first version of
  // SecretCheckResult dropped it, which made the claim true only inside the
  // module that made it (this repo's #1 defect shape: computed, never consumed).
  it('🔴 an unparseable row is carried THROUGH to the boot-facing result, not dropped at this hop', () => {
    const db = seededDb();
    db.raw
      .prepare('INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?,?,?,?)')
      .run('u1', 'corrupt.row', 'not valid json{{{', '2020-01-01T00:00:00.000Z');

    const result = checkSettingsSecretAtBoot(db.raw, deriveKey(SECRET_A));
    expect(result.unparseableRows).toBe(1);
    // POSITIVE CONTROL, on the SAME call: the good row beside the corrupt one is
    // still counted and still decrypts, so `unparseableRows:1` here means "one
    // bad row among good ones", not "the scan gave up".
    expect(result.totalApiKeyFields).toBe(1);
    expect(result.ok).toBe(true);
    // …and the clean fixture reports zero, so the assertion above is reading a
    // real count rather than a constant that happens to be 1.
    const clean = seededDb();
    expect(checkSettingsSecretAtBoot(clean.raw, deriveKey(SECRET_A)).unparseableRows).toBe(0);
    clean.close();
    db.close();
  });
});

describe('checkSettingsSecretAtBoot — anti-façade: wired into a real boot path', () => {
  it('🔴 the ONLY production caller is bootstrap.ts', () => {
    const callers = srcCallersMatching(/\bcheckSettingsSecretAtBoot\s*\(/, 'startup-secret-check.ts');
    expect(
      callers,
      'checkSettingsSecretAtBoot has no production caller — it would be DEFINED but not USED.',
    ).toEqual(['bootstrap.ts']);
  });
});
