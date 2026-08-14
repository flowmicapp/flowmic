// Repo contract tests: enc:v1: at-rest encryption, timeline e2e:v1: write-path
// reject + push idempotency, usage UPSERT accumulation.

import { describe, expect, it } from 'vitest';
import { createDbConnection } from '../src/db/connection';
import { deriveKey, ENVELOPE_PREFIX } from '../src/auth/crypto';
import { ServerError } from '../src/errors';
import { TIMELINE_E2E_PREFIX } from '@flowmic/protocol';

function freshDb() {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
  return db;
}

describe('settings repo — enc:v1 at rest, plaintext on read', () => {
  it('encrypts api_key fields at rest and decrypts on read', () => {
    const db = freshDb();
    db.settings.write('u1', 'llm.config', { protocol: 'openai-compatible', endpoint: 'http://x', api_key: 'secret-key', model: 'm' });
    // read gives back plaintext
    const row = db.settings.read('u1', 'llm.config');
    expect((row?.value as { api_key: string }).api_key).toBe('secret-key');
    // raw stored value carries the enc:v1: envelope (server-decryptable prefix)
    const raw = db.raw.prepare("SELECT value FROM user_settings WHERE user_id='u1' AND key='llm.config'").get() as { value: string };
    expect(raw.value).toContain(ENVELOPE_PREFIX);
    expect(raw.value).not.toContain('secret-key');
    db.close();
  });

  it('encrypts nested api_key inside stt.routings array rows', () => {
    const db = freshDb();
    // Long high-entropy sentinel: a 2-char needle like 'k1' can appear by chance
    // inside the random base64 ciphertext (junit-captured flake 2026-08-06).
    const secret = 'plaintext-secret-Zq7xK9mR2vT4-do-not-appear';
    db.settings.write('u1', 'stt.routings', [{ language: 'zh', engine_id: 'funasr', api_key: secret }]);
    const raw = db.raw.prepare("SELECT value FROM user_settings WHERE user_id='u1' AND key='stt.routings'").get() as { value: string };
    expect(raw.value).not.toContain(secret);
    expect(raw.value).toContain(ENVELOPE_PREFIX);
    db.close();
  });
});

describe('timeline repo — e2e:v1: write path guard + idempotency', () => {
  it('rejects any ciphertext without the e2e:v1: prefix (never coerced to enc:v1:)', () => {
    const db = freshDb();
    expect(() => db.timeline.push('u1', [{ id: 'b1', ciphertext: 'enc:v1:nope', created_at: Date.now(), schema_ver: 2 }])).toThrow(
      ServerError,
    );
    expect(() => db.timeline.push('u1', [{ id: 'b1', ciphertext: 'plaintext', created_at: Date.now(), schema_ver: 2 }])).toThrow(
      /TIMELINE_BLOB_REJECTED|e2e:v1/,
    );
    db.close();
  });

  it('push is idempotent by id+ciphertext; an edit gets a fresh seq', () => {
    const db = freshDb();
    const ct1 = `${TIMELINE_E2E_PREFIX}aaa`;
    const r1 = db.timeline.push('u1', [{ id: 'b1', ciphertext: ct1, created_at: 1000, schema_ver: 2 }]);
    const seq1 = r1[0]!.seq;
    // same ciphertext → pure echo, same seq
    const r2 = db.timeline.push('u1', [{ id: 'b1', ciphertext: ct1, created_at: 1000, schema_ver: 2 }]);
    expect(r2[0]!.seq).toBe(seq1);
    // different ciphertext for same id → edit, fresh seq
    const r3 = db.timeline.push('u1', [{ id: 'b1', ciphertext: `${TIMELINE_E2E_PREFIX}bbb`, created_at: 2000, schema_ver: 2 }]);
    expect(r3[0]!.seq).toBeGreaterThan(seq1);
    // pull reflects the edit once
    const pulled = db.timeline.pull('u1', 0, 100);
    expect(pulled.blobs.filter((b) => b.id === 'b1')).toHaveLength(1);
    db.close();
  });

  it('tombstone sets deleted flag with a fresh seq (pull sees it)', () => {
    const db = freshDb();
    db.timeline.push('u1', [{ id: 'b1', ciphertext: `${TIMELINE_E2E_PREFIX}x`, created_at: 1, schema_ver: 2 }]);
    const n = db.timeline.tombstone('u1', ['b1']);
    expect(n).toBe(1);
    const pulled = db.timeline.pull('u1', 0, 100);
    expect(pulled.blobs.find((b) => b.id === 'b1')?.deleted).toBe(true);
    db.close();
  });
});

// The `history repo` describe block (3 tests: edited overlay, GA-05 user-scoped
// id-addressed writes, the fifth status value `noted`) was REMOVED on 2026-07-31
// with `history.repo.ts` and the `transcript_history` table — owner architecture ruling
// docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md. Every one of those
// three pinned a property of a SERVER-SIDE transcript store that no longer
// exists; the properties themselves moved with their owner:
//   · "source_text is immutable / status records delivery truth only / edited is an independent bit" are now each end's own
//     store's job (desktop timeline-store, mobile timeline_sqlite);
//   · the GA-05 tenant scope has no object here — nothing on this server is
//     addressed by a transcript row id any more (see relay.handler's 0.2.27 note).
// The e2e:v1: blind store above is the store this server still HAS, and its
// guards are untouched.

describe('usage repo — monthly UPSERT accumulation', () => {
  it('accumulates deltas into the same month bucket', () => {
    const db = freshDb();
    db.usage.increment('u1', '2026-07', { stt_minutes: 5 });
    const rec = db.usage.increment('u1', '2026-07', { stt_minutes: 3, llm_tokens_in: 100 });
    expect(rec.stt_minutes).toBe(8);
    expect(rec.llm_tokens_in).toBe(100);
    db.close();
  });
});
