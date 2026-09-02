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
import { parseTokenResolution, type TokenResolution } from './token-rows';

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
/** Token read-through budget. Its own value, an order of magnitude UNDER the
 *  JSON default, because a socket.io handshake is waiting on it: this call sits
 *  between a phone tapping 「connect」 and its connection being admitted, and the
 *  failure it must never produce is a hang. Sized against the measured
 *  cross-ocean RTT this design lives on (154 ms NY-Tokyo, 2026-08-29) — three
 *  seconds is ~19 round trips of headroom, so a timeout here means the writer is
 *  down or unreachable and not that the link is slow.
 *
 *  ⚠️ Its EXPIRY is not a failure of the product: it degrades to exactly the
 *  refusal a replica gave before this route existed. Making it longer buys a
 *  better answer for a writer that is barely alive, at the price of holding a
 *  user's connect button for that long. */
export const RESOLVE_TOKEN_TIMEOUT_MS = 3_000;

/** `forwardSync`'s budget — the SAME 3-second reasoning as
 *  `RESOLVE_TOKEN_TIMEOUT_MS` (a user's own ack is waiting on it, sized against
 *  the measured cross-ocean RTT), given its own named constant rather than
 *  reusing that one so the two can diverge later without one comment lying
 *  about the other's number. */
export const FORWARD_SYNC_TIMEOUT_MS = 3_000;

/** The result of a generic replica→writer handoff. See `WriterClient.forwardSync`. */
export type ForwardSyncOutcome =
  | { status: 'ok'; result: unknown }
  | { status: 'refused'; error: string };

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
  /**
   * 「Which rows does this token stand for?」 — the second read that may not be
   * served locally, and the one a handshake is waiting on (node/token-rows.ts
   * has the defect and the exposure argument; http/node-routes.ts has the route).
   *
   * Three outcomes, structurally apart for the same reason `mintShortCode`'s are:
   *   · rows              — the writer knows the token. Land them and proceed.
   *   · `null`            — the writer does not know it (404). A FACT, and the
   *                         writer is the authority, so the refusal it produces
   *                         is honest rather than merely local.
   *   · WriterUnreachable — nothing is known. Refuse anyway (that is today's
   *                         behaviour), but never record it as「no such token」.
   *
   * ⚠️ NEVER RETRIED HERE. The client's own reconnect ladder is the retry, and a
   * loop inside a handshake would turn one slow writer into every phone in the
   * region holding a connection open.
   */
  resolveToken(token: string): Promise<TokenResolution | null>;
  /**
   * The generic replica→writer handoff (`node/forward-sync.ts` has the writer
   * side, `node/forward-sync-types.ts` the per-verb shapes). One route rather
   * than a new hand-rolled one per writer-only event — see that file's header.
   *
   * Two outcomes, kept structurally apart the same way `mintShortCode`'s are:
   *   · `{status:'ok', result}`     — the writer performed the mutation.
   *   · `{status:'refused', error}` — a STRUCTURAL refusal (e.g. the payload's
   *     `pc_id`/`user_id`/`room_uuid` do not agree with the writer's own rows),
   *     never a transport problem — those throw WriterUnreachable instead, the
   *     same split `mintShortCode`'s 404-vs-throw draws.
   *
   * ⚠️ NEVER RETRIED HERE, for the same reason as the other two: each of the
   * three verbs this carries changes state on one call (revoke a pairing,
   * retire a pairing, write a settings row), so a blind retry after a timeout
   * could double-apply a write whose first attempt actually landed.
   */
  forwardSync(verb: string, payload: Record<string, unknown>): Promise<ForwardSyncOutcome>;
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

  // `budgetMs` overrides the shared JSON timeout for the ONE call that has a
  // user waiting on it. A parameter rather than a second client: the client is
  // where the shared secret and the writer URL live, and a second one is a
  // second place either of them can be wrong (this file's own opening argument).
  const call = async (path: string, init: RequestInit, budgetMs = timeoutMs): Promise<Response> => {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(budgetMs),
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

    async resolveToken(token: string): Promise<TokenResolution | null> {
      const res = await call(
        '/api/node/resolve-token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        },
        RESOLVE_TOKEN_TIMEOUT_MS,
      );
      // The writer is authoritative and says it has never seen this token.
      if (res.status === 404) return null;
      if (!res.ok) throw new WriterUnreachable(`HTTP ${res.status}`);
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch (err) {
        throw new WriterUnreachable(`unreadable response: ${err instanceof Error ? err.message : String(err)}`);
      }
      const rows = parseTokenResolution(parsed);
      // 🔴 THROWS rather than returning null, the same distinction
      // `mintShortCode` draws: null means 「there is no such token」, and a 200
      // carrying rows we cannot use has told us neither that nor an identity.
      // Collapsing the two would let one bad deploy on the writer turn every
      // valid pairing in the region into a permanent AUTH_TOKEN_INVALID.
      if (!rows) throw new WriterUnreachable('writer answered 200 with no usable rows');
      return rows;
    },

    async forwardSync(verb: string, payload: Record<string, unknown>): Promise<ForwardSyncOutcome> {
      const res = await call(
        '/api/node/forward-sync',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ verb, payload }),
        },
        FORWARD_SYNC_TIMEOUT_MS,
      );
      // A structural refusal (node-routes.ts: the writer's own rows disagree
      // with what this replica sent, or the verb/payload was malformed). Never
      // a transport problem — those are the `!res.ok` branch below.
      if (res.status === 409 || res.status === 400) {
        let parsed: { error?: unknown };
        try {
          parsed = (await res.json()) as { error?: unknown };
        } catch (err) {
          throw new WriterUnreachable(`unreadable response: ${err instanceof Error ? err.message : String(err)}`);
        }
        return { status: 'refused', error: typeof parsed.error === 'string' ? parsed.error : 'refused' };
      }
      if (!res.ok) throw new WriterUnreachable(`HTTP ${res.status}`);
      let parsed: { result?: unknown };
      try {
        parsed = (await res.json()) as { result?: unknown };
      } catch (err) {
        throw new WriterUnreachable(`unreadable response: ${err instanceof Error ? err.message : String(err)}`);
      }
      // 🔴 `'result' in parsed`, not a truthiness check: `null`/`false`/`0` are
      // all legitimate results a verb could return, and a truthiness check
      // would misread any of them as「the writer answered 200 with nothing」.
      if (!('result' in parsed)) throw new WriterUnreachable('writer answered 200 with no usable result');
      return { status: 'ok', result: parsed.result };
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
