// SPEC-REF:
//   src/bootstrap.ts (the ONE caller)
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §3-4
//   apps/server-core/src/node/node-config.ts
//
// ── STRUCTURAL SPLIT (2026-08-29) ───────────────────────────────────────────
// This block moved out of `bootstrap.ts` `startServer`, which crossed the
// 800-line cap verify/lint/file-size.mjs enforces when multi-node wiring landed
// in it — the same pressure and the same remedy as bootstrap-http-deps.ts's own
// split. The `makeUsageTracker` construction and the comment above it travelled
// VERBATIM; everything else here is new.
//
// It also earns its own file: 「which tracker does this process get, and who
// delivers what it owes」 is one decision with three moving parts, and having
// them in one named place is what makes it impossible to wire an outbox with no
// drainer — the shape that looks completely healthy while silently accumulating
// every charge the node ever made.
// ────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import type { ServerConfig } from '../config';
import type { DbConnection } from '../db/connection';
import { makeUsageTracker, type UsageTracker } from '../billing/usage-tracker';
import { claimInCallerTransaction } from '../db/repos/usage-effects.repo';
import { ReplicaOutbox } from '../db/replica-outbox';
import { readNodeConfig, type NodeConfig } from './node-config';
import { assertWriterDirectoryConsistencyFromFile } from './writer-directory-check';
import { makeForwardingUsageTracker } from './forwarding-usage-tracker';
import { makeWriterClient, type ForwardSyncOutcome, type MintedCode } from './writer-client';
import { startOutboxDrainer, type OutboxDrainer } from './outbox-drainer';
import { makeReplicaPuller, type ReplicaPuller } from './replica-puller';
import { makeSnapshotProducer } from './snapshot';
import { makeAuthoritativeQuotaReader, type QuotaReader } from './authoritative-quota';
import { makeWriterOnlyGuard, NODE_CAN_WRITE, type WriterOnlyGuard } from './writer-only';
import { makeTokenReadThrough, type TokenReadThrough } from './token-read-through';
import { applyTokenResolution } from './token-rows';
import {
  isReleaseMobileResult, isSettingsUpdateResult, isUnpairMobileResult,
  type SettingsUpdateRequest, type SettingsUpdateResult,
} from './forward-sync-types';

export interface NodeRuntimeDeps {
  db: DbConnection;
  config: ServerConfig;
  now?: () => number;
  /** The metering-cycle resolver both meters write through — see
   *  UsageTrackerConfig.periodKeyFor. Required: bootstrap passes
   *  `billing.usagePeriodKey`. */
  periodKeyFor: (user_id: string, atMs: number) => string;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  log: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
}

export interface NodeRuntime {
  nodeConfig: NodeConfig;
  /** The metering seam the rest of the process uses. On a replica this is the
   *  forwarding one; everywhere else it is the ordinary local tracker. */
  usageTracker: UsageTracker;
  /** Present only on a replica. Shutdown disarms it. */
  outboxDrainer: OutboxDrainer | null;
  /** Present only on a replica: the loop that keeps this node's copy current. */
  replicaPuller: ReplicaPuller | null;
  /** Present only on the WRITER. Absent on a replica is what stops a replica
   *  re-serving the database it holds. */
  snapshot: (() => Promise<Buffer>) | null;
  /**
   * WRITER ONLY — the tracker used to REPLAY a forwarded metering call, and the
   * only difference from the ordinary one is its clock.
   *
   * 🔴 WHY A SECOND TRACKER EXISTS AT ALL. `recordSttUsage` buckets into
   * `currentMonth(clock)` and stamps `occurred_at` from the same clock. On one
   * node those are the same instant as the utterance. Through an outbox they are
   * not: a record enqueued at 23:59:58 on the last day of a month and delivered
   * after a writer outage lands in the NEXT month — the user is billed in the
   * wrong period, both totals are wrong, and nothing anywhere reports an error.
   *
   * Raised by the other window (2026-08-29) while describing CR-3, which keeps
   * the microphone open through a link death: a phone can now capture for
   * minutes with no socket and replay the ring on reconnect, so「delivered long
   * after the seconds it describes」stopped being an outage-only case.
   *
   * ⚠️ It is the SAME factory with the same rules — not a second author of
   * anything. Only `now` differs, and the receiver pins it to the record's own
   * timestamp for the duration of one synchronous call.
   */
  replayUsage: { tracker: UsageTracker; pinClock: (atMs: number) => void } | null;
  /**
   * Wraps the quota guard so that ON A REPLICA the「how many minutes are left」
   * read is answered by the writer. IDENTITY everywhere else — a wrapper that
   * always wraps would put a Map lookup and a staleness check on the hot path of
   * every single-node deployment, which is every deployment today.
   *
   * 🔴 It takes and returns the WHOLE guard rather than the one method, so the
   * call site is `wrapQuota(makeQuotaGuard(…))` and there is no window in which
   * an unwrapped guard exists in a variable somebody could use by accident.
   */
  wrapQuota: <T extends QuotaReader>(guard: T) => T;
  /**
   * Record that a PC is reachable through THIS node — locally on a writer or a
   * single node, through the outbox on a replica.
   *
   * `null` on a single-node deployment, and that null is the honest answer: with
   * one node there is no such fact, and writing a node id there would assert
   * something nothing has observed. The pc handler treats absent as「there is
   * nothing to record」, never as「skip recording it」.
   *
   * `asNode` (2026-08-31) is the node id THIS CONNECTION arrived as — a process
   * reachable under a regional front door answers as that door, and the value a
   * phone follows must be the same one its PC's ack reported. Omitted → the
   * process's own id, which is every single-name deployment.
   */
  stampHomeNode: ((pcId: string, asNode?: string) => void) | null;

  /**
   * REPLICA ONLY — forward the heartbeat's presence fact to the writer, so the
   * web console (which always talks to the writer) can tell a working remote PC
   * from an absent one. `null` on a writer or a single node, where the heartbeat
   * handler's own `touchLastSeen` already wrote the row and a second write would
   * be one fact with two authors. See the construction site for why the first
   * diagnosis of this gap was wrong and what measuring the read path changed.
   */
  stampPresence: ((pcId: string, isOnline: boolean, lastSeenAtMs: number) => void) | null;

  /**
   * 2026-08-29 — 「must this node refuse a writer-only socket event?」
   *
   * Constructed HERE and nowhere else, then handed to the socket handlers as a
   * required dep: six handlers asking `if (role === 'replica')` for themselves
   * is six places for the seventh to be forgotten. The measured list of which
   * events are writer-only, and the four write sites that are knowingly NOT
   * covered, live in node/writer-only.ts.
   *
   * Never null — a node that can write returns `NODE_CAN_WRITE`, which is an
   * explicit decision rather than an absent one.
   */
  writerOnly: WriterOnlyGuard;
  /**
   * 2026-08-31 — present ONLY on a replica that has a writer client: ask the
   * writer to mint a pairing code for a PC connected here.
   *
   * 🔴 It is the counterpart of `writerOnly`, and the pair has to be read
   * together: the guard says 「this node must not perform that write」, and this
   * says 「and here is the one place it may ask for it instead」. Everything
   * `writerOnly` refuses stays refused; this narrows exactly one event
   * (`pc:refresh-code`), which is the one whose refusal left a registered PC
   * permanently unable to add a phone.
   *
   * `null` on the writer and on every single-node deployment — there is nobody
   * to ask, because this process IS the answer.
   */
  mintCodeOnWriter: ((pcId: string) => Promise<MintedCode | null>) | null;
  /**
   * 2026-08-31 (P0-①) — present ONLY on a replica that has a writer client: the
   * handshake's read-through for a token this node's copy of the database has
   * never seen.
   *
   * 🔴 It is the THIRD member of the same family as `wrapQuota` and
   * `mintCodeOnWriter`, and the family rule is worth stating once: a replica
   * answers everything locally EXCEPT the questions whose whole purpose is to
   * detect someone else's recent write. 「How many minutes are left」, 「mint me a
   * code」, and now 「does this token exist」 — a pairing is created on the writer
   * and reaches a replica only through the 30-second pull, so a local miss here
   * is a maybe and not a no (node/token-read-through.ts has the measurement).
   *
   * `null` on the writer and on every single-node deployment. That null is what
   * makes those deployments byte-identical: `authMiddleware` with no seam is the
   * code that shipped before this existed, refusing on the same tick.
   */
  resolveTokenOnWriter: TokenReadThrough | null;
  /**
   * 2026-09-02 (WP-6) — present ONLY on a replica that has a writer client: the
   * GENERIC form of `mintCodeOnWriter`/`resolveTokenOnWriter`, for every small
   * synchronous writer-only mutation added since those two (`pc:release-mobile`,
   * `mobile:unpair`, `settings:update` — node/forward-sync.ts has the table).
   *
   * Keyed off the writer CLIENT for the same reason the other two are: the
   * client is what actually carries the secret and the URL, so a role with no
   * client could only produce a promise it cannot keep.
   *
   * `null` on the writer and on every single-node deployment — same meaning as
   * the other two members of this family.
   */
  forwardSyncOnWriter: ((verb: string, payload: Record<string, unknown>) => Promise<ForwardSyncOutcome>) | null;
  /**
   * 2026-09-02 (WP-6, B5) — the `release_mobile` verb of `forwardSyncOnWriter`,
   * typed and narrowed so `pc.handler.ts` need not reach into an `unknown`
   * result. A malformed/unexpected shape from the writer (a version-skew
   * safety net, not an expected path) is treated as `refused` rather than
   * thrown, so a rolling deploy degrades to the honest `NODE_IS_REPLICA`
   * refusal instead of crashing the handler.
   *
   * `null` on the writer and on every single-node deployment, same as every
   * other member of this family.
   */
  forwardReleaseMobileOnWriter: ((req: {
    pc_id: string;
    user_id: string;
    room_uuid: string;
    revoke: boolean;
    reason: 'manual' | 'busy';
    mobile_id?: string;
  }) => Promise<
    | { status: 'ok'; result: { target_ids: string[]; revoke: boolean; revoked_count: number; suppressed_ms: number } }
    | { status: 'refused'; error: string }
  >) | null;
  /**
   * 2026-09-02 (WP-6, B4) — the `unpair_mobile` verb of `forwardSyncOnWriter`,
   * typed for `mobile.handler.ts`. Same version-skew posture as
   * `forwardReleaseMobileOnWriter`: an unexpected shape degrades to `refused`.
   */
  forwardUnpairMobileOnWriter: ((pairingId: string) => Promise<
    | { status: 'ok'; result: { unpaired: boolean; mobile_id: string | null; pc_room_uuid: string | null } }
    | { status: 'refused'; error: string }
  >) | null;
  /**
   * 2026-09-02 (WP-6, B6) — the `settings_update` verb of `forwardSyncOnWriter`,
   * typed for `settings.handler.ts`. Same version-skew posture as the other two.
   */
  forwardSettingsUpdateOnWriter: ((req: SettingsUpdateRequest) => Promise<
    | { status: 'ok'; result: SettingsUpdateResult }
    | { status: 'refused'; error: string }
  >) | null;
}

export function wireNodeRuntime(deps: NodeRuntimeDeps): NodeRuntime {
  const { db, config, log } = deps;

  // Read FIRST and before anything is served: an incoherent node role is a
  // data-loss configuration, and the only harmless moment to discover one is
  // before this process has done any work. Reading it once also means every
  // later decision consults ONE resolved value instead of re-deriving a role
  // from environment variables in three places, which is how two of them come
  // to disagree. `single` is the default and is what every deployment that
  // exists today resolves to.
  const nodeConfig = readNodeConfig();
  if (nodeConfig.role !== 'single') {
    log.info(`node role: ${nodeConfig.role}`, {
      node: nodeConfig.nodeId,
      ...(nodeConfig.writerUrl ? { writer: nodeConfig.writerUrl } : {}),
    });
  }
  // B11 (2026-09-02, WP-6) — this process's own env-declared role must agree
  // with what the published node directory says about the node carrying its
  // id, or first contact (registration, pairing) can be routed at a door that
  // refuses it. Throws (boot fails loud) on a genuine disagreement; degrades
  // to a warning, never a throw, when there is nothing to compare against —
  // see writer-directory-check.ts for the full argument.
  assertWriterDirectoryConsistencyFromFile(nodeConfig, log);

  // 🔴 `events` is passed UNCONDITIONALLY while `usageEventsEnabled` carries the
  // decision, and the split is deliberate: wiring the sink behind the same `if`
  // would mean flipping the env var on a machine whose build forgot the wiring
  // produces a server that reports "enabled" and records nothing. With them
  // separated, that combination THROWS at construction (usage-tracker.ts) —
  // boot-time, loud, before a single utterance.
  const localUsageTracker = makeUsageTracker(db.usage, {
    mode: config.mode,
    usageEventsEnabled: config.usageEventsEnabled,
    events: db.usageEvents,
    // Card PR-2 — the metering-effect ledger. Passed UNCONDITIONALLY, like
    // `events` above and for a related reason: the server advertises
    // `recovery.idempotent_operation` on every pairing ack, so a build where this
    // was wired only sometimes would be a build that claims the protection
    // sometimes. It engages only for calls that carry an `operation_id`.
    operations: db.usageEffects,
    periodKeyFor: deps.periodKeyFor,
    ...(deps.now ? { now: deps.now } : {}),
  });

  // On a REPLICA the local tracker is not merely wrong, it is quietly wrong: its
  // increment lands in a snapshot file that the next replication pull REPLACES.
  // The write succeeds, nothing logs, and the minutes are gone twenty seconds
  // later — not a failure, a success that was not true. So a replica gets a
  // tracker that only ever owes the writer. The swap is here rather than inside
  // makeUsageTracker so neither tracker grows an `if (replica)` branch.
  const replicaOutbox = nodeConfig.role === 'replica' && nodeConfig.outboxPath
    ? new ReplicaOutbox(nodeConfig.outboxPath)
    : null;

  const usageTracker = replicaOutbox
    ? makeForwardingUsageTracker({
      outbox: replicaOutbox,
      nodeId: nodeConfig.nodeId ?? 'unknown',
      newId: () => randomUUID(),
      // 🔴 There is no recovery from a failed enqueue — the fact is already
      // lost. What must not happen is losing it in silence.
      onEnqueueFailed: (err, write) => log.error(
        'node.outbox enqueue FAILED — a metering fact was lost',
        { kind: write.kind, reason: err instanceof Error ? err.message : String(err) },
      ),
    })
    : localUsageTracker;

  // The replication pull, and the ONE writer client both directions share. Built
  // once rather than per-consumer: a second client is a second place the shared
  // secret and the writer URL can be wrong, including a place where one of them
  // is subtly right.
  const writerClient = nodeConfig.role === 'replica' && nodeConfig.writerUrl && nodeConfig.sharedSecret
    ? makeWriterClient({
      writerUrl: nodeConfig.writerUrl,
      sharedSecret: nodeConfig.sharedSecret,
      nodeId: nodeConfig.nodeId ?? 'unknown',
    })
    : null;

  // The delivery half, started beside the tracker that fills the queue so the
  // two cannot be wired up one without the other.
  const outboxDrainer = replicaOutbox && writerClient
    ? startOutboxDrainer({
      outbox: replicaOutbox,
      client: writerClient,
      log,
      ...(deps.setIntervalFn ? { setIntervalFn: deps.setIntervalFn } : {}),
      ...(deps.clearIntervalFn ? { clearIntervalFn: deps.clearIntervalFn } : {}),
    })
    : null;

  const replicaPuller = writerClient
    ? makeReplicaPuller({
      db: db.raw,
      fetchSnapshot: () => writerClient.fetchSnapshot(),
      log,
      ...(deps.setIntervalFn ? { setIntervalFn: deps.setIntervalFn } : {}),
      ...(deps.clearIntervalFn ? { clearIntervalFn: deps.clearIntervalFn } : {}),
    })
    : null;

  // 🔴 WRITER ONLY, and the guard is the role rather than 「is a secret set」. A
  // replica serving this route would hand out a copy of the user database it
  // holds only because we gave it one — turning one authenticated channel into
  // a second, weaker copy of the same secret.
  const snapshot = nodeConfig.role === 'writer' ? makeSnapshotProducer(db.raw) : null;

  // The replay clock. A plain mutable cell is safe here precisely because
  // `applyForwardedWrite` is synchronous: nothing can interleave between the pin
  // and the call, so there is no window in which another record could read
  // somebody else's timestamp. If that ever becomes async, this becomes wrong —
  // which is why the pin and the call live in ONE function in the receiver.
  let replayNow = 0;
  const replayUsage = nodeConfig.role === 'writer'
    ? {
      tracker: makeUsageTracker(db.usage, {
        mode: config.mode,
        usageEventsEnabled: config.usageEventsEnabled,
        events: db.usageEvents,
        operations: claimInCallerTransaction(db.usageEffects),
        // 🔴 THE SAME `usage_effects` CLAIM THE LOCAL TRACKER TAKES, joined to
        // the transaction this tracker already runs inside (audit F1). This
        // tracker is called from `forward-ledger.once`'s `BEGIN IMMEDIATE` and
        // SQLite has no nested transaction, so it takes the claim through
        // `claimInCallerTransaction` — same row, same key, no second `BEGIN`.
        //
        // ⚠️ THE FORWARD LEDGER'S DETERMINISTIC ID IS NOT ENOUGH ON ITS OWN, and
        // believing it was is what this fix corrects: that id dedupes ONE
        // replica's queue. An operation metered locally on this writer and then
        // re-sent by the phone to a REPLICA arrives under an id
        // `node_forward_seen` has never seen — accepted, applied, charged twice,
        // while the pairing ack advertises `recovery.idempotent_operation`. The
        // two paths do not share a forward id; they share
        // `(user, operation, kind)`, so that is where the join has to be.
        // ⇒ TWO dedupes, one per path, and the second is the one that is true
        // across paths.
        // The pinned instant reaches the bucket choice too: `periodKeyFor` takes
        // the instant the meter passes it, which under replay is the record's.
        periodKeyFor: deps.periodKeyFor,
        now: () => (replayNow > 0 ? replayNow : (deps.now ? deps.now() : Date.now())),
      }),
      // 0 means 「no record is being replayed」 ⇒ fall back to the real clock, so
      // a bug that forgot to pin degrades to today's behaviour rather than to
      // 1970.
      pinClock: (atMs: number) => { replayNow = Number.isFinite(atMs) && atMs > 0 ? atMs : 0; },
    }
    : null;

  // See node/authoritative-quota.ts for why this ONE read crosses a region
  // boundary when nothing else does, and for the three constraints the wrapper
  // must not break (it stays synchronous; an unreachable writer keeps the last
  // budget; the floor stays).
  const wrapQuota = <T extends QuotaReader>(guard: T): T => {
    if (!writerClient) return guard;
    const reader = makeAuthoritativeQuotaReader({
      local: guard,
      askWriter: async (userId) => {
        const r = await writerClient.authoritativeRead<{ remaining_stt_ms: number }>(
          `/api/node/quota?user_id=${encodeURIComponent(userId)}`,
        );
        return r.remaining_stt_ms;
      },
      log,
    });
    return { ...guard, remainingSttMs: (u: string) => reader.remainingSttMs(u) };
  };

  // 🔴 The SAME fact, taking two different routes depending on who can write it.
  // Deliberately not「the replica skips it」: a phone locating its PC asks the
  // WRITER, so a replica that did not forward this would leave every PC on it
  // permanently unlocatable — the feature would look implemented and do nothing.
  const stampHomeNode = nodeConfig.nodeId === null
    ? null
    : replicaOutbox
      ? (pcId: string, asNode?: string): void => {
        try {
          replicaOutbox.enqueue({
            id: randomUUID(),
            kind: 'home_node',
            // `node` is WHICH PROCESS queued this — an audit field, and it stays
            // the process id even when the connection arrived under a front
            // door. `home_node` is WHERE THE PHONE MUST DIAL, and that is the
            // door. Two questions, two values; collapsing them would send every
            // phone to the name the operator front-ended away from.
            node: nodeConfig.nodeId ?? 'unknown',
            body: { kind: 'pc.home_node', pc_id: pcId, home_node: asNode ?? nodeConfig.nodeId },
          });
        } catch (err) {
          log.error('node.outbox could not record home_node — this PC will not be locatable', {
            pc_id: pcId,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      : (pcId: string, asNode?: string): void =>
        db.pcs.setHomeNode(pcId, asNode ?? (nodeConfig.nodeId as string));

  /**
   * The heartbeat's presence fact, taking the same two routes as `stampHomeNode`.
   *
   * 🔴 WHY THIS EXISTS AT ALL, AND WHY THE FIRST ANSWER WAS WRONG. `pc.presence`
   * has been a member of the ForwardedWrite union since the channel was built,
   * with an apply arm on the writer (`bootstrap-http-deps.ts` `setPresence`) and
   * NO PRODUCER anywhere but a test. The first diagnosis of that gap said a
   * replica's PC would「read offline to its own phone」— that was FALSE, and
   * measuring the READ path is what showed it: the phone polls `reconnect.url`,
   * the node it is itself on, and follows its PC there, so presence is answered
   * from live socket state in one process and is correct.
   *
   * The surface that genuinely breaks is the WEB CONSOLE, which always talks to
   * `flowmic.app` (the writer). `pcPresence()` requires local room membership,
   * and the writer's RoomStore cannot contain a PC that is on a replica — so a
   * working computer reads as offline, and (per that function's own
   * failure-direction note) becomes REMOVABLE.
   *
   * ⚠️ Forwarding alone does not fix it either: the console deliberately does not
   * consult `is_online` (owner ruling 2026-08-28 §5-1 — a persisted flag survives
   * a relay restart and lies). What forwarding buys is a FRESH `last_seen_at`
   * from the node that actually holds the socket, which is the only honest
   * substitute for「is it in my room」 when the room is in another process. The
   * console-side half is in `pcPresence`.
   *
   * ⚠️ EVERY heartbeat, not every other one. The budget is tight and stated
   * rather than left to be discovered: heartbeat 5 s + drain 5 s + a cross-ocean
   * RTT ≈ 10.2 s against a 15 s staleness window. Forwarding on a slower cadence
   * spends margin this path does not have.
   *
   * 🔴 B8/F3 (2026-09-02) — `isOnline` IS A PARAMETER, not a hardcoded `true`.
   * Before this, the ONLY producer forwarded `is_online: true` on every
   * heartbeat and NOTHING ever forwarded `false`: a PC's socket disconnects on
   * a replica, the disconnect handler writes `is_online=0` into THAT REPLICA'S
   * OWN database (a snapshot the next pull replaces wholesale), and the writer
   * — the only database `reaper.ts`'s `listStaleOffline` and the console ever
   * read — never learns the machine left. The row sits at `is_online=1`
   * forever, the console reports it online forever, and the reaper's
   * `(is_online=0 AND last_seen_at < cutoff)` gate can never true for it. The
   * disconnect handler (bootstrap.ts) now calls this the same way the
   * heartbeat handler does, with `false`.
   */
  const stampPresence = nodeConfig.nodeId === null
    ? null
    : replicaOutbox
      ? (pcId: string, isOnline: boolean, lastSeenAtMs: number): void => {
        try {
          replicaOutbox.enqueue({
            id: randomUUID(),
            kind: 'presence',
            node: nodeConfig.nodeId ?? 'unknown',
            body: { kind: 'pc.presence', pc_id: pcId, is_online: isOnline, last_seen_at: lastSeenAtMs },
          });
        } catch (err) {
          // Not fatal to the session — the PC keeps working and its phone keeps
          // seeing it. What is lost is the CONSOLE's view, so the message says
          // that rather than implying the connection is in trouble.
          log.error('node.outbox could not record presence — this PC will read offline in the console', {
            pc_id: pcId,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Writer / single node: nothing to forward. The heartbeat handler's own
      // `touchLastSeen` already wrote the row locally, so a second write here
      // would be one fact with two authors.
      : null;

  // A replica refuses writer-only events by name; everyone else serves them.
  // Keyed off `writerUrl` and not off `role` on purpose: the refusal has to be
  // able to SAY where to go, so a role with no writer URL could not produce an
  // honest one — and readNodeConfig already rejects that combination at boot,
  // which is why this reads as a total function rather than a defensive one.
  const writerOnly: WriterOnlyGuard = nodeConfig.role === 'replica' && nodeConfig.writerUrl
    ? makeWriterOnlyGuard(nodeConfig.writerUrl)
    : NODE_CAN_WRITE;

  // The narrow counterpart of : the single writer-only event a
  // replica may ask the writer to perform for it, synchronously. Keyed off the
  // writer CLIENT rather than off the role, because that client is the thing
  // that actually carries the secret and the URL — a role with no client could
  // only produce a promise it cannot keep.
  const mintCodeOnWriter = writerClient
    ? (pcId: string): Promise<MintedCode | null> => writerClient.mintShortCode(pcId)
    : null;

  // The handshake read-through, keyed off the writer CLIENT for the same reason
  // `mintCodeOnWriter` is: the client is what actually carries the secret and the
  // URL, so a role with no client could only produce a promise it cannot keep.
  //
  // 🔴 `apply` writes to THIS node's database, and that is not a contradiction of
  // 「a replica must not write」. Every other write a replica is forbidden is one
  // it ORIGINATES — a fact the writer has never seen, landing in a snapshot the
  // next pull replaces, which is a success that was not true. This one writes
  // rows the writer already holds and the next pull will hand us anyway; it moves
  // them thirty seconds earlier and invents nothing.
  const resolveTokenOnWriter = writerClient
    ? makeTokenReadThrough({
      askWriter: (token) => writerClient.resolveToken(token),
      apply: (rows) => applyTokenResolution(db, rows),
      log,
    })
    : null;

  // The generic handoff, keyed off the writer client for the same reason
  // `mintCodeOnWriter`/`resolveTokenOnWriter` are — see this field's doc.
  const forwardSyncOnWriter = writerClient
    ? (verb: string, payload: Record<string, unknown>): Promise<ForwardSyncOutcome> =>
      writerClient.forwardSync(verb, payload)
    : null;

  // The three typed verbs, each a thin narrowing of `forwardSyncOnWriter` —
  // see each field's own doc on NodeRuntime for why an unexpected shape
  // degrades to `refused` rather than throwing.
  const forwardReleaseMobileOnWriter = forwardSyncOnWriter
    ? async (req: {
      pc_id: string; user_id: string; room_uuid: string; revoke: boolean;
      reason: 'manual' | 'busy'; mobile_id?: string;
    }) => {
      const outcome = await forwardSyncOnWriter('release_mobile', req);
      if (outcome.status !== 'ok' || !isReleaseMobileResult(outcome.result)) {
        return { status: 'refused' as const, error: outcome.status === 'refused' ? outcome.error : 'bad_shape' };
      }
      return { status: 'ok' as const, result: outcome.result };
    }
    : null;

  const forwardUnpairMobileOnWriter = forwardSyncOnWriter
    ? async (pairingId: string) => {
      const outcome = await forwardSyncOnWriter('unpair_mobile', { pairing_id: pairingId });
      if (outcome.status !== 'ok' || !isUnpairMobileResult(outcome.result)) {
        return { status: 'refused' as const, error: outcome.status === 'refused' ? outcome.error : 'bad_shape' };
      }
      return { status: 'ok' as const, result: outcome.result };
    }
    : null;

  const forwardSettingsUpdateOnWriter = forwardSyncOnWriter
    ? async (req: SettingsUpdateRequest) => {
      const outcome = await forwardSyncOnWriter('settings_update', { ...req });
      if (outcome.status !== 'ok' || !isSettingsUpdateResult(outcome.result)) {
        return { status: 'refused' as const, error: outcome.status === 'refused' ? outcome.error : 'bad_shape' };
      }
      return { status: 'ok' as const, result: outcome.result as SettingsUpdateResult };
    }
    : null;

  return {
    nodeConfig, usageTracker, outboxDrainer, replicaPuller, snapshot, replayUsage,
    wrapQuota, stampHomeNode, stampPresence, writerOnly, mintCodeOnWriter,
    resolveTokenOnWriter, forwardSyncOnWriter, forwardReleaseMobileOnWriter,
    forwardUnpairMobileOnWriter, forwardSettingsUpdateOnWriter,
  };
}
