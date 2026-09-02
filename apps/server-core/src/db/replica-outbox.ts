// SPEC-REF:
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §3-4 (the
//     narrow write set a replica has to forward), §8-4 (why replication lag is
//     tolerable and what has to be pushed instead)
//   CLAUDE.md red line: no silent failure — in BOTH directions
//
// A replica cannot write to the shared database. Some of its writes still have
// to reach the writer, and some of those are billing facts:
//
//   · metering — the whole UsageTracker interface, not one method: STT at
//     session settle, LLM from compose (translate/organize runs on whichever
//     node the PC is on), and quota refusals.
//     🔴 losing one silently UNDERCHARGES an account, which is a hole rather
//     than a degraded feature, and a 30-minute recording is one record;
//   · presence (pc_devices.is_online / last_seen_at), ~every 10 s;
//   · home_node, once per registration.
//
// ⚠️ This list was 「three writes」 until node/forwarded-write.ts counted them:
// metering is an interface, and calling an interface one write is how a
// forwarding layer ends up dropping two thirds of a billing surface. The
// authoritative, compiler-checked set is the `ForwardedWrite` union there —
// this comment is a summary and is allowed to go stale; that union is not.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY AN OUTBOX AND NOT AN HTTP CALL AT THE CALL SITE
//
// The data layer here is synchronous — 106 prepare sites, zero async repo
// methods — and `fetch` is not. Making the call site async would turn a
// two-node deployment into a whole-server sync-to-async refactor, which is the
// exact cost the design chose sqlite replication to avoid (§3-4).
//
// So the enqueue is synchronous and the delivery is not. `appendFileSync` to a
// JSONL file is the smallest thing that is durable at the moment of the call:
// the fact is on disk before the caller returns, and a process that dies one
// instruction later still owes the writer a record it can find on restart.
//
// A second sqlite database was the obvious alternative and is worse here: it
// buys transactions we do not need (every record is independent and idempotent
// by id) and costs a second file to open, migrate and keep read-only-safe.
// ─────────────────────────────────────────────────────────────────────────────
//
// AT-LEAST-ONCE, AND THE WRITER MUST DEDUPE. Delivery retries, so the same
// record can arrive twice — a crash between "POST succeeded" and "mark done"
// is not preventable, only survivable. Every record therefore carries an `id`
// the writer keys on. 🔴 Do not "fix" this into at-most-once by acking before
// delivering: for metering, a duplicate is a rounding error the writer can drop
// and a loss is money.

import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync,
  readFileSync, readSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** What a replica owes the writer. Deliberately a closed union: a new kind is a
 *  deliberate decision about what may cross a node boundary, not something a
 *  caller can invent by passing a string. */
export type OutboxKind = 'usage' | 'presence' | 'home_node';

export interface OutboxRecord {
  /** Unique per fact. The writer keys on it — see the at-least-once note. */
  id: string;
  kind: OutboxKind;
  /** ms since epoch, stamped at enqueue. The writer uses it for ordering, not
   *  for freshness: a record delivered late is still true. */
  at: number;
  /** Which node owes this. Carried on the record rather than inferred from the
   *  connection, so the writer's log can answer 「where did this come from」
   *  without correlating timestamps across two machines. */
  node?: string;
  /** Payload shape is the caller's; the writer validates it. Deliberately
   *  `unknown` rather than a shape: the moment this module knows what a usage
   *  record means, it has become a second author of one. */
  body: unknown;
  /** Delivery attempts so far. Carried in the record rather than in memory so a
   *  restart does not reset a poison record's count back to zero. */
  tries?: number;
  /** F1 (2026-09-02 audit) — set the FIRST time this record is parked past
   *  MAX_TRIES, and never unset. Its only job is telling "just parked" from
   *  "still parked" apart across drain cycles, so `failed` (below) counts a
   *  poison record ONCE rather than once per tick forever. Absent/false on
   *  every record that has not yet exhausted its retry budget. */
  parked?: boolean;
}

export interface OutboxStats {
  /** F1 — records still being actively retried. A parked record (see `parked`
   *  below) is EXCLUDED, on purpose: it will never move again, so counting it
   *  here would make a healthy, draining queue look identical to one where
   *  every record but the poisoned one is stuck too. */
  pending: number;
  delivered: number;
  /** F1 — incremented ONCE, the tick a record crosses MAX_TRIES and parks, not
   *  once per tick for as long as it stays parked. Before this it grew without
   *  bound for the lifetime of the process over a single poison record. */
  failed: number;
  /** Oldest STILL-ACTIVE record's age in ms, or null when nothing is actively
   *  retrying (an empty queue, or a queue that is ENTIRELY parked records).
   *  🔴 This is the number that matters operationally: a queue that is draining
   *  has a small age, and a queue that is stuck has a growing one — whereas
   *  `pending` alone looks identical in both cases at any single instant.
   *  🔴 F1 — MUST exclude parked records or this number can never shrink again:
   *  one permanently-poisoned record used to keep `oldest_pending_ms` growing
   *  forever, even while every other record flowed normally, so
   *  outbox-drainer.ts's stuck-queue alarm could never clear (`warnedStuck`
   *  stayed true for the rest of the process's life). */
  oldest_pending_ms: number | null;
  /** F1 — records parked past MAX_TRIES. Still counted (via `failed`, once —
   *  see MAX_TRIES's own doc comment on why they are never silently dropped),
   *  just kept OUT of `pending`/`oldest_pending_ms` so they cannot poison the
   *  health signal those two exist to carry. */
  parked: number;
}

/** A record that has failed this many times is parked rather than retried
 *  forever. Parked is NOT dropped: it stays in the file, and `failed` counts it,
 *  because a metering record we cannot deliver is something an operator has to
 *  learn about — silently discarding it is the failure this module exists to
 *  prevent, one layer deeper. */
export const MAX_TRIES = 12;

export class ReplicaOutbox {
  private readonly path: string;
  private delivered = 0;
  /** A second concurrent drain would read the same records, send them twice, and
   *  then race two compactions — the second overwriting the first. One at a
   *  time; an overlapping call is a no-op, not a queue. */
  private draining = false;
  private failed = 0;

  constructor(path: string) {
    this.path = path;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /**
   * SYNCHRONOUS and durable. Returns after the fact is on disk.
   *
   * 🔴 The leading-newline guard is not defensive tidiness, it is the whole
   * difference between losing ONE record and losing TWO. `appendFileSync`
   * concatenates: if a previous append was torn by a power cut and left no
   * trailing newline, the next record lands on the SAME line as the fragment
   * and both parse as garbage. The torn record was already gone; the next one
   * did not have to be. Found by the test that feeds a fragment and then
   * enqueues a good record — which failed before this line existed.
   */
  enqueue(rec: Omit<OutboxRecord, 'at'> & { at?: number }): void {
    const full: OutboxRecord = { at: Date.now(), ...rec };
    appendFileSync(this.path, `${this.needsLeadingNewline() ? '\n' : ''}${JSON.stringify(full)}\n`, 'utf8');
  }

  private needsLeadingNewline(): boolean {
    if (!existsSync(this.path)) return false;
    const size = statSync(this.path).size;
    if (size === 0) return false;
    // One byte, not the whole file: this runs on every enqueue.
    const fd = openSync(this.path, 'r');
    try {
      const buf = Buffer.alloc(1);
      readSync(fd, buf, 0, 1, size - 1);
      return buf[0] !== 0x0a;
    } finally {
      closeSync(fd);
    }
  }

  /** Everything still owed, oldest first. Malformed lines are SKIPPED rather
   *  than thrown on: one corrupt line (a torn write at a power cut) must not
   *  make the whole queue undeliverable. */
  pending(): OutboxRecord[] {
    if (!existsSync(this.path)) return [];
    const out: OutboxRecord[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as OutboxRecord;
        if (r && typeof r.id === 'string' && typeof r.kind === 'string') out.push(r);
      } catch {
        /* torn line — skip, keep the rest deliverable */
      }
    }
    return out;
  }

  stats(): OutboxStats {
    const p = this.pending();
    // F1 — `rec.parked` is the authoritative signal (set the tick a record
    // first crosses MAX_TRIES, in drainBatch below); `(rec.tries ?? 0) >=
    // MAX_TRIES` is the fallback for a record parked by a PRE-F1 build, whose
    // on-disk shape has no `parked` field at all.
    const active = p.filter((r) => !r.parked && (r.tries ?? 0) < MAX_TRIES);
    const oldest = active.length ? Math.min(...active.map((r) => r.at)) : null;
    return {
      pending: active.length,
      delivered: this.delivered,
      failed: this.failed,
      oldest_pending_ms: oldest === null ? null : Date.now() - oldest,
      parked: p.length - active.length,
    };
  }

  /**
   * Deliver everything owed. `send` resolves true when the writer has the
   * record; anything else is a retry.
   *
   * 🔴 The rewrite is ATOMIC (temp file + rename), because the alternative is a
   * crash mid-truncate that loses records the writer never received. The whole
   * point of this file is that a fact survives the process; a non-atomic
   * compaction would hand that guarantee back at the worst moment.
   */
  async drain(send: (rec: OutboxRecord) => Promise<boolean>): Promise<OutboxStats> {
    return this.drainBatch(async (owed) => {
      const verdicts = new Map<string, boolean>();
      for (const rec of owed) {
        try {
          verdicts.set(rec.id, await send(rec));
        } catch {
          verdicts.set(rec.id, false);
        }
      }
      return verdicts;
    });
  }

  /**
   * Drain with a sender that sees the whole batch — which is what the writer
   * actually wants: one HTTP request with N records, not N requests.
   *
   * `send` returns a verdict per id. 🔴 AN ID THE SENDER SAYS NOTHING ABOUT IS
   * LEFT COMPLETELY ALONE — not retried-and-failed, untouched, its try count
   * unchanged. The distinction matters: 「the writer refused this」 and 「the
   * writer never saw this」 are different facts, and folding the second into the
   * first burns a record's retry budget for something that was never its fault.
   */
  async drainBatch(
    send: (owed: OutboxRecord[]) => Promise<Map<string, boolean>>,
  ): Promise<OutboxStats> {
    if (this.draining) return this.stats();
    this.draining = true;
    try {
      const owed = this.pending();
      if (!owed.length) return this.stats();
      const attemptable = owed.filter((r) => (r.tries ?? 0) + 1 <= MAX_TRIES);
      let verdicts = new Map<string, boolean>();
      if (attemptable.length) {
        try {
          verdicts = await send(attemptable);
        } catch {
          // A sender that throws for the whole batch has told us nothing about
          // any individual record. Nothing is marked; everything is retried.
          verdicts = new Map();
        }
      }

      const resolved = new Map<string, OutboxRecord | null>();
      for (const rec of owed) {
        const tries = (rec.tries ?? 0) + 1;
        if (tries > MAX_TRIES) {
          // F1 (2026-09-02 audit) — `this.failed` counts a poison record ONCE,
          // the tick it first crosses MAX_TRIES. `rec.parked` is what tells
          // that tick apart from every tick after it: without this guard the
          // record re-enters this branch on EVERY drain cycle for the rest of
          // the process's life (its `tries` is frozen, so it is never NOT
          // over the limit again), and `failed` grew without bound over a
          // single record — a metric that looked like an ever-worsening
          // outage was one record parked once.
          if (!rec.parked) this.failed += 1;
          resolved.set(rec.id, { ...rec, tries: rec.tries ?? 0, parked: true }); // parked, count frozen
          continue;
        }
        if (!verdicts.has(rec.id)) continue; // never asked about — leave untouched
        if (verdicts.get(rec.id) === true) {
          this.delivered += 1;
          resolved.set(rec.id, null); // done, drop it
        } else {
          resolved.set(rec.id, { ...rec, tries });
        }
      }

      // 🔴 RE-READ BEFORE COMPACTING. `send` is async, so anything the process
      // enqueued while it was in flight is already on disk and is NOT in `owed`.
      // Writing `owed`-minus-delivered back would silently delete every record
      // that arrived during the round trip — measured, not theorised: a probe
      // that enqueued one record inside the send callback found it gone
      // afterwards, on a drain that reported success.
      const current = this.pending();
      const keep: OutboxRecord[] = [];
      for (const rec of current) {
        if (!resolved.has(rec.id)) {
          keep.push(rec); // arrived during the drain, or was never attempted
          continue;
        }
        const next = resolved.get(rec.id);
        if (next) keep.push(next);
      }
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, keep.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
      renameSync(tmp, this.path);
      return this.stats();
    } finally {
      this.draining = false;
    }
  }
}
