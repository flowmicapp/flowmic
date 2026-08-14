// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §1 (timeline_blobs: e2e:v1: ciphertext, per-user
//     seq cursor, deleted tombstone), §2 (double-prefix red line: write path REJECTS any
//     non-e2e:v1: content — TIMELINE_BLOB_REJECTED; never coerced to enc:v1:)
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D4 (push idempotent by id+ciphertext,
//     NOT id alone — id-only drops an edit as an echo; tombstone needs a wire
//     `deleted` flag, seq bump alone can't tell "edited" from "deleted")
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.8 (timeline sync payloads)
//
// The server is BLIND: it stores and returns ciphertext verbatim and can never
// decrypt it. The one thing it enforces is the e2e:v1: prefix — the double-
// prefix red line's server-side guard.

import type { DatabaseSync } from 'node:sqlite';
import { TIMELINE_E2E_PREFIX } from '@flowmic/protocol';
import { ServerError } from '../../errors';

export interface StoredBlob {
  id: string;
  seq: number;
  ciphertext: string;
  created_at: string;
  schema_ver: number;
  deleted: boolean;
}

export interface PushBlobInput {
  id: string;
  ciphertext: string;
  created_at: number;
  schema_ver: number;
}

export interface TimelineRepo {
  /** Idempotent by (id, ciphertext): a re-push of the SAME ciphertext is a
   *  no-op echo; a push with a DIFFERENT ciphertext for a known id is an edit
   *  and gets a fresh seq. Returns the assigned/existing seq per input id. */
  push(user_id: string, blobs: PushBlobInput[]): { id: string; seq: number }[];
  pull(user_id: string, since_seq: number, limit: number): { blobs: StoredBlob[]; next_seq: number };
  /**
   * E-B0: marks the blob deleted AND releases its stored bytes in the same
   * statement — see TOMBSTONE_CIPHERTEXT below for why that is a payload-less
   * `e2e:v1:` value and not the empty string. The row and its `seq` survive so
   * peers still pull the tombstone and converge; the row itself is reclaimed
   * later by `purgeOlderThan`. Returns the number of rows affected.
   */
  tombstone(user_id: string, ids: string[]): number;
  /**
   * GA-06 retention sweep: hard-delete this user's blobs created strictly before
   * `cutoff_iso`. Returns the deleted row count.
   *
   * TOMBSTONES ARE INCLUDED (GA-06 settled internally): a `deleted=1` row is itself subject to
   * the TTL — past the retention window the tombstone is dropped along with the
   * live blobs. Pull-side delete semantics fall back on the client's own local
   * deleted state (0.1.0 ships no E2EE client, so the blast radius is zero).
   * The server stays blind: this only ever reads `created_at`, never ciphertext.
   */
  purgeOlderThan(user_id: string, cutoff_iso: string): number;
}

function assertE2ePrefix(ciphertext: string): void {
  if (!ciphertext.startsWith(TIMELINE_E2E_PREFIX)) {
    throw new ServerError(
      'TIMELINE_BLOB_REJECTED',
      `timeline ciphertext must be ${TIMELINE_E2E_PREFIX}-prefixed (double-prefix red line)`,
    );
  }
}

// E-B0 (2026-08-08): a tombstone must actually FREE SPACE, not merely set a
// flag. owner ruling, docs/strategy/2026-08-01-data-asset-lifecycle-design.md
// §4-5 (deleting history on the phone ⇒ the corresponding content in the cloud's
// light record deletion **frees space**), restated as the fix in
// docs/strategy/2026-08-08-design-e-blindstore-client.md §4.
//
// 🔴 Why this is the bare prefix and NOT the empty string. The design says
// "clear the ciphertext"; the empty string cannot be used, because the WIRE
// forbids it: `EncryptedBlobSchema.ciphertext` (packages/protocol, symbol
// `E2eCiphertext` in protocol-schemas-timeline.ts) refines
// `startsWith(TIMELINE_E2E_PREFIX)`, and `timeline:pull-result` carries that
// very schema. An empty value would make every tombstone frame fail validation
// at the reader — the tombstone would be dropped and peers would never
// converge, which is the entire reason the row is kept in the first place. The
// bare prefix carries ZERO payload bytes (that is the space the ruling is
// about) while remaining a legal e2e:v1: value. Pinned by
// test/timeline-tombstone-frees-space.test.ts.
//
// 🔴 What this is NOT: `assertE2ePrefix` — the push-path guard that is the
// server-side enforcement point of the double-prefix red line — is UNTOUCHED,
// and this admits no new value class through `push` (the bare prefix already
// passed it before this change). The tombstone path writes to this repo
// directly and stays that way.
const TOMBSTONE_CIPHERTEXT = TIMELINE_E2E_PREFIX;

function toBlob(r: Record<string, unknown>): StoredBlob {
  return {
    id: r.id as string,
    seq: r.seq as number,
    ciphertext: r.ciphertext as string,
    created_at: r.created_at as string,
    schema_ver: r.schema_ver as number,
    deleted: Number(r.deleted ?? 0) === 1,
  };
}

export function makeTimelineRepo(db: DatabaseSync): TimelineRepo {
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM timeline_blobs WHERE user_id=?');
  const byId = db.prepare('SELECT * FROM timeline_blobs WHERE user_id=? AND id=?');
  const ins = db.prepare(
    `INSERT INTO timeline_blobs (id, user_id, seq, ciphertext, created_at, schema_ver, deleted)
     VALUES (?,?,?,?,?,?,0)`,
  );
  const updCiphertext = db.prepare(
    'UPDATE timeline_blobs SET ciphertext=?, seq=?, created_at=?, schema_ver=?, deleted=0 WHERE user_id=? AND id=?',
  );
  const pullStmt = db.prepare(
    'SELECT * FROM timeline_blobs WHERE user_id=? AND seq>? ORDER BY seq ASC LIMIT ?',
  );
  const tombStmt = db.prepare(
    'UPDATE timeline_blobs SET deleted=1, seq=?, ciphertext=? WHERE user_id=? AND id=?',
  );
  // GA-06: no `deleted` predicate — tombstones expire on the same TTL as live
  // blobs. Scan cost is (user_id) via idx_timeline_blobs_user_seq then a
  // created_at filter; at 0.1.0 private-domain scale that is a handful of rows per user
  // per day, so no new index (= no DB migration) is warranted here.
  const purgeStmt = db.prepare('DELETE FROM timeline_blobs WHERE user_id=? AND created_at < ?');

  function nextSeq(user_id: string): number {
    return Number((maxSeq.get(user_id) as { m: number }).m) + 1;
  }

  return {
    push(user_id, blobs): { id: string; seq: number }[] {
      const out: { id: string; seq: number }[] = [];
      for (const b of blobs) {
        assertE2ePrefix(b.ciphertext);
        const existing = byId.get(user_id, b.id) as Record<string, unknown> | undefined;
        const createdAtIso = new Date(b.created_at).toISOString();
        if (!existing) {
          const seq = nextSeq(user_id);
          ins.run(b.id, user_id, seq, b.ciphertext, createdAtIso, b.schema_ver);
          out.push({ id: b.id, seq });
        } else if ((existing.ciphertext as string) === b.ciphertext) {
          out.push({ id: b.id, seq: existing.seq as number }); // pure echo — no-op
        } else {
          const seq = nextSeq(user_id); // edit → fresh cursor so peers re-pull it
          updCiphertext.run(b.ciphertext, seq, createdAtIso, b.schema_ver, user_id, b.id);
          out.push({ id: b.id, seq });
        }
      }
      return out;
    },
    pull(user_id, since_seq, limit): { blobs: StoredBlob[]; next_seq: number } {
      const rows = (pullStmt.all(user_id, since_seq, limit) as Record<string, unknown>[]).map(toBlob);
      const next_seq = rows.length > 0 ? (rows[rows.length - 1] as StoredBlob).seq : since_seq;
      return { blobs: rows, next_seq };
    },
    tombstone(user_id, ids): number {
      let n = 0;
      for (const id of ids) {
        const seq = nextSeq(user_id);
        if (Number(tombStmt.run(seq, TOMBSTONE_CIPHERTEXT, user_id, id).changes) > 0) n++;
      }
      return n;
    },
    purgeOlderThan(user_id, cutoff_iso): number {
      return Number(purgeStmt.run(user_id, cutoff_iso).changes);
    },
  };
}
