// SPEC-REF:
//   docs/strategy/2026-10-11-replication-tiering-design.md §11 (REVOKE-PUSH)
//   apps/server-core/src/node/revocation-hint.ts   (the writer half)
//   apps/server-core/src/node/replica-puller.ts    (the pull this triggers; `onApplied`)
//   apps/server-core/src/node/forward-sync.ts      (`credentials_check`, the writer's verdict)
//   apps/server-core/src/http/console-device-routes.ts `evictPairing` (the eviction shape)
//   *** HUMAN-AUDIT SENSITIVE (auth: closing live sessions on a replica) ***
//
// REPLICA ONLY. Two jobs, one module, because each is useless without the other.
//
// ── 1. HEAR ABOUT A REVOCATION NOW, NOT AT THE NEXT 30-SECOND PULL ──────────
//
// A long-poll on the writer's revocation hint. When the writer's `(boot, gen)`
// differs from the last one seen, pull the whole database at once — the same
// import the 30-second timer runs, which is already the authority on every row.
// The hint carries no ids on purpose (revocation-hint.ts says why), so there is
// no second, row-shaped path into this database to keep honest.
//
// ── 2. CLOSE THE LIVE SESSIONS A PULL JUST REVOKED ──────────────────────────
//
// Measured by reading the code (design §11-1): before this module, NOTHING on a
// replica ever looked back at a socket after admitting it. A pairing revoked on
// the writer stopped new handshakes here at the next pull — and the phone that
// was already connected kept injecting indefinitely, because the writer's own
// eviction (`evictPairing`) can only reach sockets in the writer's process.
//
// So after every committed import (`ReplicaPuller` `onApplied`), each live
// pc/mobile socket is checked against the rows that just landed. A socket whose
// row is gone is a CANDIDATE, never a verdict:
//
// 🔴 WHY A CANDIDATE IS CONFIRMED WITH THE WRITER BEFORE ANYTHING IS CLOSED.
// The import is DELETE-then-INSERT of whole tables. A phone that paired on the
// writer a second ago and was admitted here through the token read-through
// (token-read-through.ts lands its rows locally) loses those rows to any import
// whose snapshot was produced before the pairing existed. Closing on 「the row
// is missing here」 would tell a perfectly valid phone 「the computer cancelled
// this pairing」 — a status this layer cannot back (R11). The writer is the only
// node that can say 「gone」, the same rule `TokenReadThroughOutcome` already
// encodes: only a writer-confirmed absence licenses treating a credential as dead.
//
// 🔴 D-25. A socket is matched by the exact pair it was admitted under — the
// pairing id AND the PC it hung off, or the PC id AND its account — and the
// writer judges that same pair. Never by account, never by room: two phones of
// one account must not be closed because one of them was revoked.
//
// The eviction is the shape the writer already uses, so no client changes:
// a phone gets `mobile:released {retry_after_ms: 0, revoked: true}` THEN
// `disconnect(true)` (emit first — socket.io drops what is queued on a closed
// socket); a PC is only disconnected and meets AUTH_TOKEN_INVALID on its next
// handshake through the ordinary read-through.
//
// ── 3. A FLOOR UNDER HINT-TRIGGERED PULLS (design §11-3 step 2, review) ─────
//
// A signed-in user can bump the writer's counter on demand and without a rate
// limit — a PC re-register and a phone re-pair both rotate a token in place
// (room/registry.ts `setToken`), which the triggers count — and each pull costs
// the writer a synchronous VACUUM INTO + gzip (node/snapshot.ts). So two
// HINT-TRIGGERED pulls start at least HINT_PULL_MIN_INTERVAL_MS apart: the first
// hint pulls at once, any number arriving inside the window coalesce into ONE
// pull at its edge, which starts after all of them (none is lost). The 30-second
// timed pull is the puller's own timer and never passes through here.
//
// ── 4. ONE-WAY FAILURE: THE WRITER ANSWERS, BUT NO IMPORT LANDS (§11-4) ─────
//
// The sweep in 2. runs only after a committed import. If imports keep failing
// while the writer is perfectly reachable (snapshot route broken, an import that
// trips on schema, a transfer that times out), the rows here freeze and a
// revocation issued meanwhile never closes anything. A watchdog therefore looks
// every STALE_CHECK_INTERVAL_MS; once the last committed import (or, if none,
// this follower's start) is STALE_IMPORT_CEILING_MS old, each round asks the
// writer about EVERY live pc/mobile socket — not only those missing locally —
// in chunks, at most FULL_VERIFY_MAX_ENTRIES per round (the next round resumes
// where this one stopped; locally-missing ones go first), and closes only the
// exact pairs the writer confirms gone (same keys, same D-25 rule as 2.).
// 「Does the writer answer?」 is answered by that very `credentials_check`: no
// answer ⇒ nothing closes and the rest of the round is not asked.
//
// ── FAILURE DIRECTION ───────────────────────────────────────────────────────
//
// Fail-open, by decision (design §11-4): a writer that cannot be reached closes
// nothing, and the hint loop backs off. Revocations can only be issued on the
// writer, so while it is unreachable no new revocation can reach this node by
// any route; the first answer after it comes back differs (or its `boot` did)
// and the pull + sweep catch up at once. Every failure is a latched WARN with a
// matching recovery INFO — quiet means 「already said so」, as in replica-puller.ts.
//
// ⚠️ What this module does NOT close (design §11-6 ⑥): a socket admitted under a
// token that was since rotated IN PLACE. The admission pair carries no token,
// and the writer judges the same pair, so it answers 「still held」.

import type { AuthContext } from '../auth/middleware';
import type {
  CredentialsCheckPairing,
  CredentialsCheckPc,
  CredentialsCheckRequest,
  CredentialsCheckResult,
} from './forward-sync-types';
import { REVOCATION_HINT_MAX_WAIT_MS, type RevocationHintState } from './revocation-hint';

/** The slice of a socket.io Socket this module touches. */
export interface LiveSocket {
  connected?: boolean;
  data: unknown;
  emit(event: string, payload: unknown): unknown;
  disconnect(close?: boolean): unknown;
}

/** Entries per `credentials_check` call. Normally a sweep has zero or one; the
 *  cap matters after an outage, and stays well under the writer's refusal line
 *  (CREDENTIALS_CHECK_MAX_ENTRIES). */
export const SWEEP_CHECK_CHUNK = 200;
export const HINT_BACKOFF_MIN_MS = 5_000;
export const HINT_BACKOFF_MAX_MS = 60_000;
/** A hint answer that came back this fast WITHOUT a change means the writer is
 *  not holding requests (shutting down, or misbehaving). Wait this long before
 *  asking again rather than spinning. */
export const HINT_MIN_ROUND_MS = 1_000;
/** Floor between the STARTS of two hint-triggered pulls (header §3). */
export const HINT_PULL_MIN_INTERVAL_MS = 5_000;
/** No committed import for this long ⇒ verify every live session (header §4). */
export const STALE_IMPORT_CEILING_MS = 5 * 60_000;
/** How often the staleness watchdog looks — and so, while stale, how often a
 *  full verification round runs. */
export const STALE_CHECK_INTERVAL_MS = 60_000;
/** Entries one full verification round asks the writer about. */
export const FULL_VERIFY_MAX_ENTRIES = 1_000;

export interface RevocationFollowerDeps {
  /** `signal` aborts a held long-poll when the follower stops. */
  waitHint(seen: RevocationHintState | null, waitMs: number, signal: AbortSignal): Promise<RevocationHintState>;
  /** One replication pull (ReplicaPuller.pull). Its import fires the sweep
   *  through `onApplied`, so this module never sweeps on its own pull path. */
  pull(): Promise<unknown>;
  /** When the last import COMMITTED (ReplicaPuller.lastAppliedAt), `null` if
   *  none has yet — read by the staleness watchdog (header §4). Same clock as
   *  `now`. */
  lastAppliedAt(): number | null;
  pcs: { findById(id: string): { user_id: string } | null };
  mobiles: { findById(id: string): { pc_device_id: string } | null };
  /** The writer's verdict. `null` ⇒ nothing was learned (unreachable, refused,
   *  an older writer that does not know the verb, an unusable body). */
  checkOnWriter(req: CredentialsCheckRequest): Promise<CredentialsCheckResult | null>;
  log: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
  waitMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  minRoundMs?: number;
  minPullIntervalMs?: number;
  staleCeilingMs?: number;
  staleCheckMs?: number;
  fullVerifyMaxEntries?: number;
  now?: () => number;
}

export interface SweepReport {
  /** Distinct admissions asked about: after an import, those whose row was
   *  missing or re-parented locally; in a stale round, every one (bounded). */
  candidates: number;
  /** Of those, how many the writer confirmed it no longer holds as admitted. */
  confirmedAbsent: number;
  /** Sockets actually closed. */
  evicted: number;
  /** Candidates the writer could not be asked about this time. */
  unverified: number;
}

export interface RevocationFollower {
  /** Hand over this node's live sockets and START the hint loop and the
   *  stale-import watchdog. Late-bound
   *  because socket.io is created after the node runtime; and starting here
   *  rather than at construction means a runtime built without sockets (unit
   *  tests, a process that never serves) never dials the writer. */
  bindSockets(provider: () => Iterable<LiveSocket>): void;
  /** Check every live socket against the rows this node now holds. Called
   *  after each committed import. Single-flight: a call during a sweep runs one
   *  more sweep afterwards. Never rejects. */
  sweep(): Promise<SweepReport>;
  /** One hint-triggered pull, single-flight with one queued rerun. Exposed so
   *  the wiring and the tests drive the same function the loop does. */
  triggerPull(): Promise<void>;
  stop(): void;
}

const EMPTY_REPORT: SweepReport = { candidates: 0, confirmedAbsent: 0, evicted: 0, unverified: 0 };

function authOf(socket: LiveSocket): AuthContext | null {
  const data = socket.data as { auth?: AuthContext | null } | null | undefined;
  return data?.auth ?? null;
}

const pairingKey = (e: CredentialsCheckPairing): string => `${e.id}\u0000${e.pc_id}`;
const pcKey = (e: CredentialsCheckPc): string => `${e.id}\u0000${e.user_id}`;

/** The admission a socket holds, as the pair the writer will judge — or null
 *  for a socket this module does not police (no auth, `web`, partial). */
function admissionOf(auth: AuthContext | null):
  | { kind: 'mobile'; entry: CredentialsCheckPairing }
  | { kind: 'pc'; entry: CredentialsCheckPc }
  | null {
  if (!auth) return null;
  if (auth.kind === 'mobile' && auth.pairingId && auth.deviceId) {
    return { kind: 'mobile', entry: { id: auth.pairingId, pc_id: auth.deviceId } };
  }
  // ⚠️ `userId` on a MOBILE context is the payer, not the pairing's owner
  // (mobile-reconnect.ts `actingUserId`), which is why it is not compared for
  // phones. On a PC context it IS the row's owner (middleware.ts, pc.handler.ts).
  if (auth.kind === 'pc' && auth.deviceId) {
    return { kind: 'pc', entry: { id: auth.deviceId, user_id: auth.userId } };
  }
  return null;
}

export function makeRevocationFollower(deps: RevocationFollowerDeps): RevocationFollower {
  const { log } = deps;
  const now = deps.now ?? Date.now;
  const waitMs = deps.waitMs ?? REVOCATION_HINT_MAX_WAIT_MS;
  const backoffMin = deps.backoffMinMs ?? HINT_BACKOFF_MIN_MS;
  const backoffMax = deps.backoffMaxMs ?? HINT_BACKOFF_MAX_MS;
  const minRound = deps.minRoundMs ?? HINT_MIN_ROUND_MS;
  const minPullInterval = deps.minPullIntervalMs ?? HINT_PULL_MIN_INTERVAL_MS;
  const staleCeiling = deps.staleCeilingMs ?? STALE_IMPORT_CEILING_MS;
  const staleCheck = deps.staleCheckMs ?? STALE_CHECK_INTERVAL_MS;
  const fullVerifyMax = Math.max(1, deps.fullVerifyMaxEntries ?? FULL_VERIFY_MAX_ENTRIES);

  let sockets: (() => Iterable<LiveSocket>) | null = null;
  let stopped = false;
  let started = false;
  const halt = new AbortController();

  // Cancellable, unref'd sleeps: stop() must not wait out a 60-second backoff,
  // and a sleeping loop must never be what keeps a process alive.
  const sleepers = new Set<() => void>();
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    if (stopped) return resolve();
    const wake = (): void => {
      sleepers.delete(wake);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    timer.unref?.();
    sleepers.add(wake);
  });

  // ── triggered pull: single-flight, one rerun, a floor between starts ─────
  let pulling: Promise<void> | null = null;
  let pullAgain = false;
  let pullFailing = false;
  let lastHintPullAt = Number.NEGATIVE_INFINITY;
  const triggerPull = (): Promise<void> => {
    if (pulling) {
      pullAgain = true;
      return pulling;
    }
    pulling = (async (): Promise<void> => {
      try {
        do {
          // The floor (header §3). Hints that land while we wait are covered by
          // the pull that starts after the wait, so the flag is cleared only now.
          const wait = lastHintPullAt + minPullInterval - now();
          if (wait > 0) await sleep(wait);
          if (stopped) break;
          pullAgain = false;
          lastHintPullAt = now();
          try {
            await deps.pull();
            if (pullFailing) {
              log.info('node.revocation: on-demand pull recovered');
              pullFailing = false;
            }
          } catch (err) {
            if (!pullFailing) {
              log.warn('node.revocation: on-demand pull FAILED — the 30-second pull remains the only path', {
                reason: err instanceof Error ? err.message : String(err),
              });
              pullFailing = true;
            }
          }
        } while (pullAgain && !stopped);
      } finally {
        pulling = null;
      }
    })();
    return pulling;
  };

  // ── sweep: single-flight, one rerun ───────────────────────────────────────
  // 'missing' — after an import: only sockets whose admission row is missing or
  // re-parented here. 'all' — the stale watchdog (header §4): every socket,
  // bounded per round. Both close only what the writer confirms.
  type SweepMode = 'missing' | 'all';
  type Entry = { k: string; p: CredentialsCheckPairing } | { k: string; c: CredentialsCheckPc };
  let checkFailing = false;
  let fullCursor = 0;
  const sweepOnce = async (mode: SweepMode): Promise<SweepReport> => {
    const provider = sockets;
    if (!provider || stopped) return EMPTY_REPORT;

    const missing = new Map<string, Entry>();
    const held = new Map<string, Entry>();
    for (const socket of provider()) {
      if (socket.connected === false) continue;
      const adm = admissionOf(authOf(socket));
      if (!adm) continue;
      let entry: Entry;
      let rowHeld: boolean;
      if (adm.kind === 'mobile') {
        const row = deps.mobiles.findById(adm.entry.id);
        rowHeld = row !== null && row.pc_device_id === adm.entry.pc_id;
        entry = { k: `m\u0000${pairingKey(adm.entry)}`, p: adm.entry };
      } else {
        const row = deps.pcs.findById(adm.entry.id);
        rowHeld = row !== null && row.user_id === adm.entry.user_id;
        entry = { k: `p\u0000${pcKey(adm.entry)}`, c: adm.entry };
      }
      if (!rowHeld) missing.set(entry.k, entry);
      else if (mode === 'all') held.set(entry.k, entry);
    }
    let asked = [...missing.values()];
    if (mode === 'all') {
      // Bounded and fair: the locally-missing first, then the rest in a stable
      // order, resumed where the previous round stopped.
      asked = asked.slice(0, fullVerifyMax);
      const rest = [...held.values()].sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : 0));
      const take = Math.min(fullVerifyMax - asked.length, rest.length);
      if (take > 0) {
        const start = fullCursor % rest.length;
        for (let i = 0; i < take; i += 1) asked.push(rest[(start + i) % rest.length]!);
        fullCursor = (start + take) % rest.length;
      }
    }
    const candidates = asked.length;
    if (candidates === 0) return EMPTY_REPORT;

    // Ask in chunks. A chunk the writer does not answer leaves its sockets up,
    // and the rest of this round is not asked: a writer that is not answering
    // is not hammered, and nothing it did not confirm is closed (fail-open).
    const absentPairings = new Set<string>();
    const absentPcs = new Set<string>();
    let unverified = 0;
    for (let i = 0; i < asked.length; i += SWEEP_CHECK_CHUNK) {
      const slice = asked.slice(i, i + SWEEP_CHECK_CHUNK);
      const chunkP = slice.flatMap((x) => ('p' in x ? [x.p] : []));
      const chunkC = slice.flatMap((x) => ('c' in x ? [x.c] : []));
      let verdict: CredentialsCheckResult | null;
      try {
        verdict = await deps.checkOnWriter({ pairings: chunkP, pcs: chunkC });
      } catch {
        verdict = null;
      }
      if (!verdict) {
        unverified += asked.length - i;
        break;
      }
      for (const e of verdict.absent_pairings) absentPairings.add(pairingKey(e));
      for (const e of verdict.absent_pcs) absentPcs.add(pcKey(e));
    }
    if (unverified > 0 && !checkFailing) {
      log.warn('node.revocation: could not confirm with the writer — those sessions stay up until the next pull', {
        unverified, scope: mode,
      });
      checkFailing = true;
    } else if (unverified === 0 && checkFailing) {
      log.info('node.revocation: writer confirmation recovered');
      checkFailing = false;
    }
    if (stopped) return { candidates, confirmedAbsent: 0, evicted: 0, unverified };

    // Close only what the writer confirmed, and only a socket whose admission
    // is STILL the one that was judged — re-read now, because the await above
    // gave it time to re-admit as something else.
    let evicted = 0;
    const closedPairings: string[] = [];
    const closedPcs: string[] = [];
    for (const socket of provider()) {
      if (socket.connected === false) continue;
      const adm = admissionOf(authOf(socket));
      if (!adm) continue;
      if (adm.kind === 'mobile' && absentPairings.has(pairingKey(adm.entry))) {
        socket.emit('mobile:released', { retry_after_ms: 0, revoked: true });
        socket.disconnect(true);
        evicted += 1;
        closedPairings.push(adm.entry.id);
      } else if (adm.kind === 'pc' && absentPcs.has(pcKey(adm.entry))) {
        socket.disconnect(true);
        evicted += 1;
        closedPcs.push(adm.entry.id);
      }
    }
    const confirmedAbsent = absentPairings.size + absentPcs.size;
    if (evicted > 0 || confirmedAbsent > 0) {
      log.info('node.revocation: closed sessions whose credential the writer no longer holds', {
        evicted, pairings: closedPairings, pcs: closedPcs, confirmed_absent: confirmedAbsent, candidates, scope: mode,
      });
    }
    return { candidates, confirmedAbsent, evicted, unverified };
  };

  let sweeping: Promise<SweepReport> | null = null;
  let pendingMode: SweepMode | null = null;
  const runSweep = (mode: SweepMode): Promise<SweepReport> => {
    if (sweeping) {
      // 'all' covers 'missing', so a queued request keeps the wider one.
      pendingMode = pendingMode === 'all' || mode === 'all' ? 'all' : 'missing';
      return sweeping;
    }
    sweeping = (async (): Promise<SweepReport> => {
      let last: SweepReport = EMPTY_REPORT;
      let next: SweepMode | null = mode;
      try {
        while (next !== null && !stopped) {
          const current: SweepMode = next;
          pendingMode = null;
          try {
            last = await sweepOnce(current);
          } catch (err) {
            log.warn('node.revocation: sweep threw — no session was closed by it', {
              reason: err instanceof Error ? err.message : String(err),
            });
          }
          next = pendingMode;
        }
      } finally {
        sweeping = null;
        pendingMode = null;
      }
      return last;
    })();
    return sweeping;
  };
  const sweep = (): Promise<SweepReport> => runSweep('missing');

  // ── the stale-import watchdog (header §4) ─────────────────────────────────
  let startedAt = 0;
  let staleSaid = false;
  const watchdog = async (): Promise<void> => {
    while (!stopped) {
      await sleep(staleCheck);
      if (stopped) return;
      const appliedAt = deps.lastAppliedAt();
      const age = now() - (appliedAt ?? startedAt);
      if (age < staleCeiling) {
        if (staleSaid) {
          log.info('node.revocation: imports recovered — live sessions are checked after each import again');
          staleSaid = false;
        }
        continue;
      }
      if (!staleSaid) {
        log.warn('node.revocation: no committed import for too long — every live session is checked with the writer each round', {
          age_ms: age, never_applied: appliedAt === null,
        });
        staleSaid = true;
      }
      await runSweep('all');
    }
  };

  // ── the hint loop ─────────────────────────────────────────────────────────
  const loop = async (): Promise<void> => {
    let seen: RevocationHintState | null = null;
    let backoff = backoffMin;
    let down = false;
    while (!stopped) {
      const askedAt = now();
      let next: RevocationHintState;
      try {
        next = await deps.waitHint(seen, waitMs, halt.signal);
      } catch (err) {
        if (stopped) return;
        if (!down) {
          log.warn('node.revocation hints unavailable — revocations reach this node by the 30-second pull only', {
            reason: err instanceof Error ? err.message : String(err),
          });
          down = true;
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, backoffMax);
        continue;
      }
      if (stopped) return;
      if (down) {
        log.info('node.revocation hints recovered');
        down = false;
      }
      backoff = backoffMin;
      const changed = seen === null || next.boot !== seen.boot || next.gen !== seen.gen;
      if (changed) {
        // The first answer after boot counts as a change: this node has not
        // pulled since it started, and that is when it is most out of date.
        seen = next;
        void triggerPull();
      } else if (now() - askedAt < minRound) {
        await sleep(minRound);
      }
    }
  };

  return {
    bindSockets(provider) {
      sockets = provider;
      if (started || stopped) return;
      started = true;
      startedAt = now();
      void loop();
      void watchdog();
    },
    sweep,
    triggerPull,
    stop() {
      stopped = true;
      halt.abort();
      for (const wake of [...sleepers]) wake();
    },
  };
}
