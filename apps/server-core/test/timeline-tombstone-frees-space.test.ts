// E-B0 — a server-side tombstone must actually free space.
//
// owner ruling: docs/strategy/2026-08-01-data-asset-lifecycle-design.md §4-5
//   "phone deletes history (including images) ⇒ matching cloud light-record content is deleted and **frees space**"
// restated as the server-side fix in
//   docs/strategy/2026-08-08-design-e-blindstore-client.md §4 / §0-1.
//
// Before this card `tombstone()` only did `SET deleted=1, seq=?` — the stored
// ciphertext stayed on disk until `purgeOlderThan` came around days later, so
// "delete" freed nothing and the ruling was not satisfied.
//
// 🔴 Every assertion about the bytes below queries the DATABASE (`db.raw`), not
// the return value of `tombstone()`. A function that returns 1 proves it ran,
// never that the bytes are gone — that distinction is the whole card.

import { describe, expect, it } from 'vitest';
import { EncryptedBlobSchema, TIMELINE_E2E_PREFIX } from '@flowmic/protocol';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';

// A long high-entropy sentinel: a short needle can appear by chance inside
// other stored bytes (the flake already paid for once in repos.test.ts).
const PAYLOAD = 'blind-store-payload-Zq7xK9mR2vT4-must-not-survive-a-delete';
const CT = `${TIMELINE_E2E_PREFIX}${PAYLOAD}`;

function freshDb() {
  const db = createDbConnection({
    dbPath: ':memory:',
    encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx'),
  });
  db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
  return db;
}

function storedRow(db: ReturnType<typeof freshDb>, id: string) {
  return db.raw
    .prepare('SELECT id, seq, ciphertext, deleted FROM timeline_blobs WHERE user_id=? AND id=?')
    .get('u1', id) as { id: string; seq: number; ciphertext: string; deleted: number } | undefined;
}

describe('timeline repo — tombstone releases the stored bytes (E-B0)', () => {
  it('the persisted ciphertext carries zero payload bytes after tombstone', () => {
    const db = freshDb();
    db.timeline.push('u1', [{ id: 'b1', ciphertext: CT, created_at: 1000, schema_ver: 2 }]);

    // Positive control: before the delete the payload really IS on disk, so a
    // green "it is gone" below cannot be the probe looking at nothing.
    expect(storedRow(db, 'b1')!.ciphertext).toContain(PAYLOAD);

    db.timeline.tombstone('u1', ['b1']);

    const after = storedRow(db, 'b1')!;
    expect(after.ciphertext).not.toContain(PAYLOAD);
    // Zero payload bytes: nothing beyond the e2e:v1: marker itself survives.
    expect(after.ciphertext.length).toBe(TIMELINE_E2E_PREFIX.length);
    db.close();
  });

  it('the row and its seq survive so peers can converge on a tombstone', () => {
    const db = freshDb();
    const seq0 = db.timeline.push('u1', [
      { id: 'b1', ciphertext: CT, created_at: 1000, schema_ver: 2 },
    ])[0]!.seq;

    db.timeline.tombstone('u1', ['b1']);

    const after = storedRow(db, 'b1');
    expect(after).toBeDefined(); // the row is NOT removed here (purgeOlderThan's job)
    expect(after!.deleted).toBe(1);
    expect(after!.seq).toBeGreaterThan(seq0); // fresh cursor → peers re-pull it
    db.close();
  });

  it('a peer that already pulled the live blob then pulls the tombstone', () => {
    const db = freshDb();
    db.timeline.push('u1', [{ id: 'b1', ciphertext: CT, created_at: 1000, schema_ver: 2 }]);

    // Device B syncs up to "now" and holds that cursor.
    const first = db.timeline.pull('u1', 0, 100);
    expect(first.blobs.find((b) => b.id === 'b1')?.deleted).toBe(false);
    const cursor = first.next_seq;

    // Device A deletes.
    db.timeline.tombstone('u1', ['b1']);

    // Device B pulls again from where it left off and learns about the delete —
    // the entry does not silently vanish, it arrives as a tombstone.
    const second = db.timeline.pull('u1', cursor, 100);
    const tomb = second.blobs.find((b) => b.id === 'b1');
    expect(tomb).toBeDefined();
    expect(tomb!.deleted).toBe(true);
    expect(tomb!.ciphertext).not.toContain(PAYLOAD);
    db.close();
  });

  it('tombstoning an already-tombstoned id succeeds and corrupts nothing', () => {
    const db = freshDb();
    db.timeline.push('u1', [{ id: 'b1', ciphertext: CT, created_at: 1000, schema_ver: 2 }]);

    expect(db.timeline.tombstone('u1', ['b1'])).toBe(1);
    const once = storedRow(db, 'b1')!;

    // The mobile pending-delete set drains with ack-before-remove (design §4.1), so a retry
    // re-sends the same id — it must be safe.
    expect(db.timeline.tombstone('u1', ['b1'])).toBe(1);
    const twice = storedRow(db, 'b1')!;

    expect(twice.deleted).toBe(1);
    expect(twice.ciphertext).toBe(once.ciphertext); // still payload-less, not doubled
    expect(twice.ciphertext.length).toBe(TIMELINE_E2E_PREFIX.length);
    expect(twice.seq).toBeGreaterThanOrEqual(once.seq);
    // Exactly one row — a retry must never fan out into a second entry.
    const count = db.raw
      .prepare('SELECT COUNT(*) AS c FROM timeline_blobs WHERE user_id=? AND id=?')
      .get('u1', 'b1') as { c: number };
    expect(count.c).toBe(1);

    // An unknown id is a no-op, not a throw (idempotence across devices that
    // already purged their copy).
    expect(db.timeline.tombstone('u1', ['never-existed'])).toBe(0);
    db.close();
  });

  it('🔴 the emptied blob is still a LEGAL wire value (this is why it is not "")', () => {
    // The design says "empty the ciphertext". The empty string cannot be used:
    // `EncryptedBlobSchema.ciphertext` (= `E2eCiphertext`) refines
    // startsWith(e2e:v1:) and `timeline:pull-result` carries that same schema,
    // so an empty value would make every tombstone frame fail validation at the
    // reader — the tombstone would be DROPPED and peers would never converge,
    // defeating the only reason the row is kept. This test is the guard: if
    // anyone later "finishes the job" by writing '', it goes red here.
    //
    // The blob mapping below mirrors the `timeline:pull` branch of
    // `registerTimelineHandlers` (socket/handlers/timeline.handler.ts).
    const db = freshDb();
    db.timeline.push('u1', [{ id: 'b1', ciphertext: CT, created_at: 1000, schema_ver: 2 }]);
    db.timeline.tombstone('u1', ['b1']);

    const b = db.timeline.pull('u1', 0, 100).blobs.find((x) => x.id === 'b1')!;
    const wire = {
      id: b.id,
      seq: b.seq,
      ciphertext: b.ciphertext,
      created_at: Date.parse(b.created_at),
      schema_ver: b.schema_ver,
      ...(b.deleted ? { deleted: true } : {}),
    };
    expect(EncryptedBlobSchema.safeParse(wire).success).toBe(true);

    // Positive control on the guard itself: the empty string really would be
    // rejected, so the assertion above is not vacuously true.
    expect(EncryptedBlobSchema.safeParse({ ...wire, ciphertext: '' }).success).toBe(false);
    db.close();
  });
});
