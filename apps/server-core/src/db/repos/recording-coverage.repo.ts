// SPEC-REF:
//   docs/strategy/2026-10-10-nr224-billed-once-guard-design.md (the design; §2.2 is the rule below, §6 the failure directions)
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.12
//   apps/server-core/src/db/schema-recovery.ts (table 17 `recording_coverage`, its DDL)
//   apps/server-core/src/db/repos/usage-effects.repo.ts `step` (the ONE caller, inside the claim's transaction)
//   *** HUMAN-AUDIT SENSITIVE (billing) ***
//
// NR-224 — the same audio of one recording is paid for once.
//
// An old phone (0.3.95–0.3.107) that loses a long recording's link re-sends the WHOLE recording as an automatic
// catch-up: a new recovery operation over [0, end), while the live session had already been billed for most of it.
// The claim ledger (usage-effects.repo.ts) dedupes re-sends of ONE operation; it cannot see that two different
// sessions carried the same audio. This store can, because both frames name the same `recording_id`
// (live: apps/mobile/lib/src/session/recovery_identity.dart `liveStartFields`; recovery: `RecoveryIdentity.toStartFields`).
//
// One row per (account, recording): disjoint sample intervals, each with the milliseconds already PAID for it
// (book 22 §4.9 basis, not audio length) and who wrote it (`l` a live session, `r` a recovery session).
// INVARIANT: per recording, the paid ms of all intervals sum to what was charged through this store.

import type { DatabaseSync } from 'node:sqlite';
import { RECOVERY_CLAIM_RETENTION_MS } from '../schema-recovery';
import { REPLAY_FREE_LIMIT, replayToleranceMs } from './usage-effects.repo';
import { log } from '../../log';
import type {
  CoverageSettlement, CoverageSegment, CoverageState, RecordingCoverageRef, RecordingCoverageRow, RecordingCoverageStore,
} from './recording-coverage-types';

export type {
  CoverageAttemptKind, CoverageSettlement, CoverageSegment, CoverageState, RecordingCoverageRef, RecordingCoverageRow,
  RecordingCoverageStore,
} from './recording-coverage-types';

/** 16 kHz mono: the server measures received audio as bytes / 32 per ms (engine/stt-session.ts `BYTES_PER_MS`),
 *  and the phone counts its ranges in samples of the same stream (04 §3.3-a). */
export const SAMPLES_PER_MS = 16;

/** How many FREE sessions one recording may have because of coverage — credited first meterings, credited longer
 *  replays, credited live presses and every free re-send of a credited operation, all from ONE budget. Each free session
 *  is worth at most what the recording already paid, so a modified client gets at most five times what it paid.
 *  Equal to REPLAY_FREE_LIMIT (usage-effects.repo.ts), whose own doc names the phone constant it mirrors
 *  (`kRecoveryMaxAutoAttempts`, apps/mobile/lib/src/session/recovery_backoff.dart). */
export const COVERAGE_CREDIT_LIMIT = REPLAY_FREE_LIMIT;

/** The most stretches one recording's row may hold. Past it a session draws nothing and is not recorded (billed as
 *  the claim says), so many tiny sessions under one `recording_id` cannot grow the row inside the write lock. */
export const COVERAGE_MAX_STRETCHES = 64;


/**
 * The session's coverage, or undefined when it cannot be determined — and then the session is billed exactly as
 * before (design §6: no evidence of an earlier payment ⇒ no credit; erring the other way would let any client that
 * drops `recording_id` transcribe free).
 *
 * 🔴 THE END IS THE SERVER'S OWN MEASUREMENT, NOT THE CLIENT'S WORD: [receivedUniqueMs] is the audio the pipeline
 * took with replays de-duplicated (engine/stt-session-intake.ts `FrameTally.fedBytes`). A live press states no end
 * at all; a recovery frame's stated end only ever shortens the interval, so a client cannot claim more coverage than
 * it sent.
 */
export function coverageRefOf(
  frame: { recording_id?: string | undefined; range_start_sample?: number | undefined; range_end_sample?: number | undefined; attempt_kind?: string | undefined },
  receivedUniqueMs: number | undefined,
): RecordingCoverageRef | undefined {
  const { recording_id, range_start_sample: start, range_end_sample: stated, attempt_kind } = frame;
  if (typeof recording_id !== 'string' || recording_id === '') return undefined;
  if (attempt_kind !== 'live' && attempt_kind !== 'auto_retry' && attempt_kind !== 'user_retranscribe') return undefined;
  if (start === undefined || !Number.isSafeInteger(start) || start < 0) return undefined;
  if (receivedUniqueMs === undefined || !Number.isFinite(receivedUniqueMs) || receivedUniqueMs <= 0) return undefined;
  let end = start + Math.floor(receivedUniqueMs * SAMPLES_PER_MS);
  if (stated !== undefined && Number.isSafeInteger(stated) && stated > start) end = Math.min(end, stated);
  return end > start ? { recording_id, start_sample: start, end_sample: end, attempt_kind } : undefined;
}


/**
 * THE RULE (design §2.2), pure. [basisMs] is the session's §4.9 basis; [proposedMs] what the claim would charge
 * (the basis on a first metering, the excess on a longer replay).
 *
 * · Each overlapped interval offers `min(its paid ms, the overlap's audio ms)` — an interval can never pay for more
 *   audio than overlaps it.
 * · `auto_retry` draws from every interval; `live` only from intervals a recovery session wrote (a live press always
 *   says it starts at sample 0, so a second live session of one recording sits at the wrong place and must not draw);
 *   `user_retranscribe` neither draws nor records (ruling O-4: a press the user asked for is billed as its own).
 * · Fully inside paid audio and within the §4.11 tolerance ⇒ 0; otherwise basis − offered, never below 0.
 * · The interval is then rewritten: overlapped money moves into the new interval, which holds offered + charged.
 */
export function settleCoverage(
  state: CoverageState | undefined, ref: RecordingCoverageRef, basisMs: number, proposedMs: number, operation_id?: string,
): CoverageSettlement {
  const proposed = Math.max(0, Math.round(proposedMs));
  const untouched: CoverageSettlement = { charge: proposed, credited: 0, next: null };
  if (ref.attempt_kind === 'user_retranscribe') return untouched;
  const cur = state ?? { segments: [], credits: 0, credited_ops: [] };
  if (cur.segments.length >= COVERAGE_MAX_STRETCHES) return untouched; // the row is full: no credit, no growth
  const lo = ref.start_sample;
  const hi = ref.end_sample;
  const draws = (seg: CoverageSegment): boolean => ref.attempt_kind === 'auto_retry' || seg.by === 'r';
  const kept: CoverageSegment[] = [];
  let carried = 0; // every overlapped ms that moves into the new interval (drawable or not) — keeps the invariant
  let offered = 0; // the drawable part of it
  let drawableCovered = 0; // samples of [lo, hi) under a drawable interval
  for (const seg of cur.segments) {
    const os = Math.max(seg.s, lo);
    const oe = Math.min(seg.e, hi);
    if (oe <= os) { kept.push(seg); continue; }
    const inside = Math.min(seg.ms, (oe - os) / SAMPLES_PER_MS);
    carried += inside;
    if (draws(seg)) { offered += inside; drawableCovered += oe - os; }
    const rest = seg.ms - inside;
    const leftLen = Math.max(0, os - seg.s);
    const rightLen = Math.max(0, seg.e - oe);
    if (leftLen + rightLen === 0) { carried += rest; continue; } // nowhere left to hold it: it moves too
    const leftMs = Math.round((rest * leftLen) / (leftLen + rightLen));
    if (leftLen > 0) kept.push({ s: seg.s, e: os, ms: leftMs, by: seg.by });
    if (rightLen > 0) kept.push({ s: oe, e: seg.e, ms: rest - leftMs, by: seg.by });
  }
  let charge = proposed;
  if (offered > 0 && cur.credits < COVERAGE_CREDIT_LIMIT) {
    const basis = Math.max(0, basisMs);
    const covered = drawableCovered >= hi - lo;
    const owed = covered && basis <= offered + replayToleranceMs(offered) ? 0 : Math.max(0, Math.round(basis - offered));
    charge = Math.min(proposed, owed);
  }
  const credited = proposed - charge;
  kept.push({ s: lo, e: hi, ms: Math.round(carried + charge), by: ref.attempt_kind === 'live' ? 'l' : 'r' });
  if (kept.length > COVERAGE_MAX_STRETCHES) return untouched; // this session would overflow the row: billed as proposed
  kept.sort((a, b) => a.s - b.s);
  const ops = credited > 0 && operation_id !== undefined && !cur.credited_ops.includes(operation_id)
    ? [...cur.credited_ops, operation_id] : cur.credited_ops;
  return { charge, credited, next: { segments: kept, credits: cur.credits + (credited > 0 ? 1 : 0), credited_ops: ops } };
}

/**
 * *** billing *** A re-send of a CREDITED operation (review of NR-224, MAIN decision 2026-10-10). Its claim records the
 * whole basis as settled — so an honest phone's lost-ack re-send is not billed again — and the claim alone would let it
 * through free up to REPLAY_FREE_LIMIT times without touching this recording's budget. Here it spends one credit like
 * any other free session; once the budget is gone it is billed the whole [amount]. Null ⇒ not a credited operation.
 */
export function replayOfCredited(
  state: CoverageState | undefined, operation_id: string, amount: number, claimCharge: number,
): { charge: number; next: CoverageState | null } | null {
  if (state === undefined || !state.credited_ops.includes(operation_id)) return null;
  if (state.credits >= COVERAGE_CREDIT_LIMIT) return { charge: Math.max(0, Math.round(amount)), next: null };
  return { charge: Math.max(0, Math.round(claimCharge)), next: { ...state, credits: state.credits + 1 } };
}

/** SQLite result codes after which SQLite may already have rolled the transaction back itself (sqlite.org/lang_transaction.html
 *  「Response To Errors Within A Transaction」: FULL, IOERR, BUSY, NOMEM; plus CORRUPT and INTERRUPT). `node:sqlite` puts the
 *  EXTENDED code on `errcode`, so the primary code is its low byte (probe: BUSY → 5, a UNIQUE violation → 1555). */
const ROLLBACK_CLASS = new Set([5 /* BUSY */, 7 /* NOMEM */, 9 /* INTERRUPT */, 10 /* IOERR* */, 11 /* CORRUPT */, 13 /* FULL */]);
export function isRollbackClassSqliteError(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && ROLLBACK_CLASS.has(code & 0xff);
}


function decodeOps(raw: unknown): string[] {
  const arr = JSON.parse(String(raw)) as unknown;
  if (!Array.isArray(arr) || !arr.every((x) => typeof x === 'string')) throw new Error('credited_ops is not a string array');
  return arr as string[];
}

function decodeSegments(raw: unknown): CoverageSegment[] {
  const arr = JSON.parse(String(raw)) as unknown;
  if (!Array.isArray(arr)) throw new Error('segments is not an array');
  return arr.map((t) => {
    if (!Array.isArray(t) || t.length !== 4) throw new Error('malformed segment');
    const [s, e, ms, by] = t as [unknown, unknown, unknown, unknown];
    if (!Number.isFinite(s) || !Number.isFinite(e) || !Number.isFinite(ms) || (by !== 'l' && by !== 'r')) throw new Error('malformed segment');
    return { s: Number(s), e: Number(e), ms: Number(ms), by };
  });
}

export function makeRecordingCoverageStore(db: DatabaseSync): RecordingCoverageStore {
  const select = db.prepare('SELECT segments, credits, credited_ops FROM recording_coverage WHERE user_id = ? AND recording_id = ?');
  const upsert = db.prepare(
    `INSERT INTO recording_coverage (user_id, recording_id, segments, credits, credited_ops, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, recording_id) DO UPDATE SET
       segments = excluded.segments, credits = excluded.credits, credited_ops = excluded.credited_ops,
       updated_at = excluded.updated_at`,
  );
  const read = (user_id: string, recording_id: string): CoverageState | undefined => {
    const row = select.get(user_id, recording_id) as { segments: unknown; credits: unknown; credited_ops: unknown } | undefined;
    return row === undefined ? undefined
      : { segments: decodeSegments(row.segments), credits: Number(row.credits), credited_ops: decodeOps(row.credited_ops) };
  };
  const write = (user_id: string, recording_id: string, next: CoverageState, at: number): void => {
    upsert.run(user_id, recording_id, JSON.stringify(next.segments.map((g) => [g.s, g.e, g.ms, g.by])), next.credits,
      JSON.stringify(next.credited_ops), at, at);
  };
  /** Data errors ⇒ logged, the caller bills [fallback] in full. Rollback-class errors ⇒ re-thrown (see the type's doc). */
  const failed = (err: unknown, user_id: string, recording_id: string, fallback: number): number => {
    if (isRollbackClassSqliteError(err)) throw err;
    log.error('usage: recording coverage unreadable or unwritable — charged in full, coverage unchanged', {
      user_id, recording_id, reason: err instanceof Error ? err.message : String(err),
    });
    return Math.max(0, Math.round(fallback));
  };
  const sweep = db.prepare('DELETE FROM recording_coverage WHERE created_at < ?');
  const byUser = db.prepare(
    'SELECT recording_id, segments, credits, credited_ops, created_at, updated_at FROM recording_coverage WHERE user_id = ? ORDER BY created_at DESC',
  );
  return {
    settle(user_id, ref, basisMs, proposedMs, at, operation_id): CoverageSettlement {
      try {
        const out = settleCoverage(read(user_id, ref.recording_id), ref, basisMs, proposedMs, operation_id);
        if (out.next !== null) write(user_id, ref.recording_id, out.next, at);
        if (out.credited > 0) {
          // Said out loud, once per credited session: a catch-up correctly charged only its tail and one silently
          // under-charged look the same from outside, and only this line separates them.
          log.info('usage: recording audio already paid for — charged only what was not', {
            user_id, recording_id: ref.recording_id, attempt_kind: ref.attempt_kind,
            range: [ref.start_sample, ref.end_sample], basis_ms: Math.round(basisMs), charged_ms: out.charge, credited_ms: out.credited,
          });
        }
        return out;
      } catch (err) {
        return { charge: failed(err, user_id, ref.recording_id, proposedMs), credited: 0, next: null };
      }
    },
    creditedReplay(user_id, ref, operation_id, amount, claimCharge, at): number | null {
      try {
        const out = replayOfCredited(read(user_id, ref.recording_id), operation_id, amount, claimCharge);
        if (out === null) return null;
        if (out.next !== null) write(user_id, ref.recording_id, out.next, at);
        else {
          log.info('usage: re-send of a credited operation past the recording\'s free budget — billed in full', {
            user_id, recording_id: ref.recording_id, operation_id, charged_ms: out.charge,
          });
        }
        return out.charge;
      } catch (err) {
        // A row we cannot read cannot say whether this operation was credited: bill the whole session (the safe
        // side for a budget), unless SQLite itself is rolling back.
        return failed(err, user_id, ref.recording_id, amount);
      }
    },
    prune(now = Date.now()): number {
      return Number(sweep.run(now - RECOVERY_CLAIM_RETENTION_MS).changes ?? 0);
    },
    listByUser(user_id): RecordingCoverageRow[] {
      return (byUser.all(user_id) as Record<string, unknown>[]).map((r) => ({
        recording_id: String(r['recording_id']),
        segments: decodeSegments(r['segments']),
        credits: Number(r['credits']),
        credited_ops: decodeOps(r['credited_ops']),
        created_at: Number(r['created_at']),
        updated_at: Number(r['updated_at']),
      }));
    },
  };
}
