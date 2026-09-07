// SPEC-REF:
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md
//     §3-4 (single writer + read replicas, and why not Postgres),
//     §4-4 (which reads may NOT be served from a replica)
//   CLAUDE.md red line: no silent failure, in BOTH directions
//
// Which node this process is, and what that permits it to do.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FAILS THE BOOT RATHER THAN DEFAULTING
//
// Every incoherent combination below has a plausible-looking default, and every
// one of those defaults is a data-loss bug wearing a sensible face:
//
//   · a replica with no writer URL would come up and serve reads, and every
//     write it owes would pile into an outbox nobody drains — invisible until
//     someone reconciles a bill;
//   · a replica that silently degraded to `single` would write into a snapshot
//     file that the next replication pull OVERWRITES. The write succeeds, the
//     process logs nothing, and the fact is gone twenty seconds later. That is
//     the exact shape this repo keeps paying for: not a failure, a success that
//     was not true.
//
// So the rule is `resolvePlanLimits`'s rule (billing/plan-limits.ts): a
// misconfiguration stops the process at boot, where an operator is watching,
// instead of at 3am inside someone's recording.
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ `single` IS THE DEFAULT AND MUST STAY THE DEFAULT. Every existing
// deployment — the whole product until today — sets none of these variables and
// must keep behaving exactly as it does now. Multi-node is opt-in per process.

/** What this process may do with the database.
 *
 *  · `single`  — one node, one database, writes locally. Today's production.
 *  · `writer`  — the authoritative node. Writes locally AND accepts forwarded
 *                writes from replicas.
 *  · `replica` — serves relay traffic from a read-only snapshot; forwards the
 *                writes it owes; asks the writer for reads that must be fresh. */
export type NodeRole = 'single' | 'writer' | 'replica';

export interface NodeConfig {
  role: NodeRole;
  /** Stable node identity (`srvny` / `srvjp`). Null only when `single`, where
   *  there is nothing to distinguish this node FROM. */
  nodeId: string | null;
  /** Replica only: where to forward writes and send authoritative reads. */
  writerUrl: string | null;
  /** Shared between writer and replicas; authenticates node-to-node calls.
   *  🔴 NOT a user credential and never reachable from a user-facing route. */
  sharedSecret: string | null;
  /**
   * 2026-09-07 — a SECOND credential that opens `GET /api/node/snapshot` and
   * NOTHING ELSE. Null when the deployment has not issued one.
   *
   * 🔴 WHY IT EXISTS, AND WHY IT IS NOT [sharedSecret]. The LAN ops console
   * (a third party) pulls the database snapshot on a timer. The shared secret
   * would do that — and it would ALSO unlock `/api/node/forward`,
   * `/api/node/forward-sync`, `/api/node/mint-code`, `/api/node/resolve-token`
   * and `/api/node/quota`, i.e. a channel that PERFORMS WRITES on the writer
   * and hands back whole `users` rows. Handing that value to a reader is the
   * second writer R3 of the ops console spec exists to keep out
   * (docs/strategy/2026-08-31-lan-ops-console-third-party-spec.md §2 R3, §6 P3).
   *
   * ⚠️ IT DOES NOT WIDEN THE SNAPSHOT ROUTE'S EXPOSURE, and that must not be
   * misread: the body is still the entire user database, password hashes and
   * tokens included. What this narrows is the OTHER direction — what else the
   * holder of this particular string can do.
   *
   * ⚠️ THE HEADER NAME DOES NOT CHANGE (`x-flowmic-node-secret`). One header,
   * two acceptable values on ONE route: the puller's code is identical either
   * way, which is what makes issuing a reader credential a deployment change
   * rather than a client change.
   *
   * ⚠️ NO BOOT FAILURE WHEN THIS IS SET ON A NON-WRITER, deliberately, unlike
   * every other combination this file refuses. A snapshot secret on a replica
   * is inert (the route is refused on role grounds before the secret is even
   * read) and killing a live relay node over an inert variable is a worse
   * outcome than the mistake it would catch. The one combination that IS
   * refused below is the one that would make this credential a lie.
   */
  snapshotSecret: string | null;
  /** Operator-maintained node list, served by GET /api/node/list. */
  listPath: string | null;
  /** Where a replica parks the writes it still owes. */
  outboxPath: string | null;
}

export class NodeConfigError extends Error {
  constructor(message: string) {
    super(`FlowMic node configuration: ${message}`);
    this.name = 'NodeConfigError';
  }
}

const trim = (v: string | undefined): string | null => {
  const s = (v ?? '').trim();
  return s.length ? s : null;
};

/**
 * Read the node role from the environment, or throw.
 *
 * ⚠️ `FLOWMIC_NODE_ROLE` is deliberately explicit rather than inferred from
 *「is FLOWMIC_NODE_WRITER_URL set?」. Inference means a typo'd variable name
 * silently demotes a replica to a writer — and a demoted replica writes into a
 * file that gets overwritten. An explicit role makes the typo a boot failure.
 */
export function readNodeConfig(env: NodeJS.ProcessEnv = process.env): NodeConfig {
  const raw = trim(env.FLOWMIC_NODE_ROLE);
  const nodeId = trim(env.FLOWMIC_NODE_ID);
  const writerUrl = trim(env.FLOWMIC_NODE_WRITER_URL);
  const sharedSecret = trim(env.FLOWMIC_NODE_SHARED_SECRET);
  const snapshotSecret = trim(env.FLOWMIC_NODE_SNAPSHOT_SECRET);
  const listPath = trim(env.FLOWMIC_NODE_LIST_PATH);
  const outboxPath = trim(env.FLOWMIC_NODE_OUTBOX_PATH);

  // 🔴 THE ONE COMBINATION THAT IS REFUSED. Two names for one value would make
  // 「this credential is read-only」 false while every log line, every route and
  // this file's own type went on saying it — and the third party we hand it to
  // has no way to find that out. Refused at boot, where an operator is watching,
  // rather than discovered when somebody uses the reader's key to forward a
  // write. (Set neither, or set two different strings.)
  if (snapshotSecret !== null && snapshotSecret === sharedSecret) {
    throw new NodeConfigError(
      'FLOWMIC_NODE_SNAPSHOT_SECRET must not equal FLOWMIC_NODE_SHARED_SECRET. The snapshot secret '
      + 'is handed out as a READ-ONLY credential; making it the same string would silently give its '
      + 'holder the write endpoints (/api/node/forward, forward-sync, mint-code, resolve-token, quota).',
    );
  }

  if (raw === null) {
    // The untouched deployment. Anything else set alongside it is a half-done
    // configuration, and half-done is the state that looks like it worked.
    if (writerUrl !== null) {
      throw new NodeConfigError(
        'FLOWMIC_NODE_WRITER_URL is set but FLOWMIC_NODE_ROLE is not. '
        + "A node that forwards writes must say so: set FLOWMIC_NODE_ROLE=replica.",
      );
    }
    return { role: 'single', nodeId, writerUrl: null, sharedSecret, snapshotSecret, listPath, outboxPath: null };
  }

  if (raw !== 'single' && raw !== 'writer' && raw !== 'replica') {
    throw new NodeConfigError(
      `FLOWMIC_NODE_ROLE must be one of single | writer | replica, got ${JSON.stringify(raw)}`,
    );
  }

  if (raw !== 'single' && nodeId === null) {
    throw new NodeConfigError(
      `FLOWMIC_NODE_ROLE=${raw} requires FLOWMIC_NODE_ID (the id clients see in /api/node/list).`,
    );
  }

  if (raw === 'replica') {
    if (writerUrl === null) {
      throw new NodeConfigError('FLOWMIC_NODE_ROLE=replica requires FLOWMIC_NODE_WRITER_URL.');
    }
    if (!/^https:\/\//.test(writerUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(writerUrl)) {
      // The forwarded payload carries metering and the shared secret. Plaintext
      // between regions is not a hardening preference here, it is the whole
      // confidentiality of the channel — loopback is allowed only because tests
      // and a same-box writer have no network to cross.
      throw new NodeConfigError(
        `FLOWMIC_NODE_WRITER_URL must be https:// (loopback http is allowed), got ${writerUrl}`,
      );
    }
    if (sharedSecret === null) {
      throw new NodeConfigError('FLOWMIC_NODE_ROLE=replica requires FLOWMIC_NODE_SHARED_SECRET.');
    }
    if (outboxPath === null) {
      throw new NodeConfigError(
        'FLOWMIC_NODE_ROLE=replica requires FLOWMIC_NODE_OUTBOX_PATH — the file where writes '
        + 'wait out a writer outage. Without it a network blip loses metering.',
      );
    }
  }

  if (raw === 'writer' && sharedSecret === null) {
    throw new NodeConfigError(
      'FLOWMIC_NODE_ROLE=writer requires FLOWMIC_NODE_SHARED_SECRET — otherwise the forward '
      + 'endpoint would accept records from anyone who can reach it.',
    );
  }

  return { role: raw, nodeId, writerUrl, sharedSecret, snapshotSecret, listPath, outboxPath };
}
