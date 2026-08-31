// SPEC-REF:
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §4-4
//   apps/server-core/src/node/forwarded-write.ts
//   apps/server-core/src/db/replica-outbox.ts
//
// The ONE place a replica talks to the writer. Three operations, and they answer
// three different questions on purpose:
//
//   · forward()          — 「here are writes I owe you」   (at-least-once, retried)
//   · authoritativeRead()— 「what is the CURRENT truth」    (never retried blindly)
//   · fetchSnapshot()    — 「give me your whole database」  (the replication pull)
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A READ EVER LEAVES THE REPLICA
//
// Design §4-4, sharpened after review: a read whose PURPOSE IS TO DETECT
// SOMEONE ELSE'S RECENT WRITE must not be served from a replica. Not「a read of
// important data」— importance is not the test, and using it as one produces a
// rule nobody can apply. The test is what the caller does with a stale answer:
//
//   · 「how many minutes has this account used」 asked in order to decide whether
//     to CUT OFF a recording — the whole question is whether someone else just
//     spent them. A replica answers this confidently and wrongly.
//   · 「what is this user's display name」 — a stale answer is a stale name.
//
// Everything else stays local, because a cross-region round trip on every read
// is how a multi-node deployment becomes slower than the single node it
// replaced — which was the entire reason for building it.
// ─────────────────────────────────────────────────────────────────────────────

import type { OutboxRecord } from '../db/replica-outbox';

/** Per-record outcome. `duplicate` and `accepted` both mean「stop owing it」;
 *  they are two values rather than one because a duplicate RATE is the health
 *  signal for the retry loop, and folding it into `accepted` would erase it. */
export type ForwardOutcome = 'accepted' | 'duplicate' | 'rejected';

export interface ForwardResult {
  outcomes: Map<string, ForwardOutcome>;
}

export class WriterUnreachable extends Error {
  constructor(cause: string) {
    super(`writer unreachable: ${cause}`);
    this.name = 'WriterUnreachable';
  }
}

export interface WriterClientOptions {
  writerUrl: string;
  sharedSecret: string;
  nodeId: string;
  /** Transport timeout. Deliberately short: the outbox is durable, so giving up
   *  early and retrying costs nothing, while a hung request holds the drain. */
  timeoutMs?: number;
  /** Injected for tests. Production uses global fetch. */
  fetchImpl?: typeof fetch;
}

/** Batch cap. A replica that has been offline for an hour must not try to hand
 *  the writer its entire backlog in one request — one oversized body that the
 *  writer rejects would make the queue permanently undeliverable, which is the
 *  failure mode a backlog least needs. */
export const FORWARD_BATCH_MAX = 200;
/** Snapshot transfer budget. Deliberately NOT the JSON timeout: this moves a
 *  whole database across an ocean (154 ms RTT NY-Tokyo, 120 KB gzipped,
 *  measured 2026-08-29). Giving it the 8-second budget meant for a small JSON
 *  round trip would make replication time out on precisely the link it exists
 *  to serve, and the symptom would be 「the replica is stale」 with nothing
 *  saying why.
 */
export const SNAPSHOT_TIMEOUT_MS = 120_000;

/** What the writer minted, as the replica hands it back to the desktop. */
export interface MintedCode {
  short_code: string;
  /** The governor's remaining life for THIS issuance, or null if it said none.
   *  Carried rather than re-derived: a countdown computed on a second machine is
   *  a second author for one deadline (GA-18's whole point). */
  expires_in_ms: number | null;
}

export interface WriterClient {
  forward(records: OutboxRecord[]): Promise<ForwardResult>;
  authoritativeRead<T>(path: string): Promise<T>;
  /**
   * 「Mint a pairing code for this PC」 — the one WRITE this client performs
   * synchronously instead of queueing (http/node-routes.ts `mintShortCode` has
   * the measurement and the reason).
   *
   * Three outcomes, kept structurally apart on purpose:
   *   · a code            — the writer minted it and it will resolve there;
   *   · `null`            — the writer does not know this PC (404). A fact.
   *   · WriterUnreachable — nothing is known. The caller must NOT read this as
   *                         「no code exists」 and must fall back to the honest
   *                         refusal, because retrying is what the user will do.
   *
   * ⚠️ NEVER RETRIED HERE. Every retry mints another code and invalidates the
   * previous one (single-column overwrite), so a blind retry loop would race the
   * user's own screen. The user's 「refresh」 button is the retry.
   */
  mintShortCode(pcId: string): Promise<MintedCode | null>;
  /** The writer's whole database, gzipped. Its own timeout, an order of
   *  magnitude longer than the others: this transfers a file across an ocean
   *  (154 ms RTT NY↔Tokyo, measured), and giving it the 8-second budget meant
   *  for a JSON round trip would make replication fail on exactly the link it
   *  exists to serve. */
  fetchSnapshot(): Promise<Buffer>;
}

export function makeWriterClient(opts: WriterClientOptions): WriterClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const base = opts.writerUrl.replace(/\/+$/, '');

  const call = async (path: string, init: RequestInit): Promise<Response> => {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          ...(init.headers ?? {}),
          'x-flowmic-node-secret': opts.sharedSecret,
          'x-flowmic-node-id': opts.nodeId,
        },
      });
    } catch (err) {
      throw new WriterUnreachable(err instanceof Error ? err.message : String(err));
    }
    return res;
  };

  return {
    async forward(records: OutboxRecord[]): Promise<ForwardResult> {
      const outcomes = new Map<string, ForwardOutcome>();
      if (!records.length) return { outcomes };
      const batch = records.slice(0, FORWARD_BATCH_MAX);
      const res = await call('/api/node/forward', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ node: opts.nodeId, records: batch }),
      });
      if (!res.ok) {
        // 🔴 A NON-2xx IS NOT A REJECTION OF THE RECORDS. It says the writer did
        // not process this request — a restart, a 502 from its own proxy, a
        // rolling deploy. Reading it as「these records are bad」would discard
        // metering on the most ordinary event in an operator's week.
        throw new WriterUnreachable(`HTTP ${res.status}`);
      }
      let parsed: { outcomes?: Record<string, string> };
      try {
        parsed = (await res.json()) as { outcomes?: Record<string, string> };
      } catch (err) {
        throw new WriterUnreachable(`unreadable response: ${err instanceof Error ? err.message : String(err)}`);
      }
      for (const [id, outcome] of Object.entries(parsed.outcomes ?? {})) {
        if (outcome === 'accepted' || outcome === 'duplicate' || outcome === 'rejected') {
          outcomes.set(id, outcome);
        }
      }
      // ⚠️ Records the writer said nothing about are NOT marked. They stay owed
      // and are retried. Silence is not consent when the subject is money.
      return { outcomes };
    },

    async fetchSnapshot(): Promise<Buffer> {
      let res: Response;
      try {
        res = await doFetch(`${base}/api/node/snapshot`, {
          method: 'GET',
          signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
          headers: {
            'x-flowmic-node-secret': opts.sharedSecret,
            'x-flowmic-node-id': opts.nodeId,
          },
        });
      } catch (err) {
        throw new WriterUnreachable(err instanceof Error ? err.message : String(err));
      }
      if (!res.ok) throw new WriterUnreachable(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },

    async mintShortCode(pcId: string): Promise<MintedCode | null> {
      const res = await call('/api/node/mint-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pc_id: pcId }),
      });
      // The writer knows this PC does not exist there. Not a transport problem,
      // and the caller acts differently on it — see the interface doc.
      if (res.status === 404) return null;
      if (!res.ok) throw new WriterUnreachable(`HTTP ${res.status}`);
      let parsed: { short_code?: unknown; expires_in_ms?: unknown };
      try {
        parsed = (await res.json()) as { short_code?: unknown; expires_in_ms?: unknown };
      } catch (err) {
        throw new WriterUnreachable(`unreadable response: ${err instanceof Error ? err.message : String(err)}`);
      }
      // 🔴 The shape is CHECKED, not trusted, and a bad one throws rather than
      // returning null: null means「there is no such PC」, and a writer that
      // answered 200 with nothing usable has told us neither that nor a code.
      // Four digits is the protocol's own definition of a short code
      // (room/registry.ts resolvePcForPair) — anything else could never be
      // redeemed, so showing it to a user would be a code-shaped lie.
      if (typeof parsed.short_code !== 'string' || !/^\d{4}$/.test(parsed.short_code)) {
        throw new WriterUnreachable('writer answered 200 with no usable short_code');
      }
      return {
        short_code: parsed.short_code,
        expires_in_ms: typeof parsed.expires_in_ms === 'number' && Number.isFinite(parsed.expires_in_ms)
          ? parsed.expires_in_ms
          : null,
      };
    },

    async authoritativeRead<T>(path: string): Promise<T> {
      const res = await call(path, { method: 'GET' });
      if (!res.ok) throw new WriterUnreachable(`HTTP ${res.status}`);
      try {
        return (await res.json()) as T;
      } catch (err) {
        throw new WriterUnreachable(`unreadable response: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
