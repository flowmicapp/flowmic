// SPEC-REF:
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §1 (nodes),
//     §2-2 (why the probe must be application-level), §4-2/§4-3 (home_node +
//     authoritative read)
//   docs/strategy/2026-08-28-soniox-geo-latency-findings.md §8/§9 (the regional
//     endpoint measurements this whole design rests on)
//   CLAUDE.md red lines: no silent failure; one value answers one question only
//
// The routes a multi-node deployment needs, and nothing else:
//
//   GET  /api/node/ping    — an ORIGIN-answered round trip, for picking a node
//   GET  /api/node/list    — which nodes exist (operator-maintained file)
//   GET  /api/node/locate  — which node a given PC is registered on
//   POST /api/node/forward — a replica handing the writer the writes it owes
//   GET  /api/node/quota    — the ONE read a replica may not answer itself
//   GET  /api/node/snapshot — the writer's database, for the replication pull
//
// The first three are PUBLIC — a client must choose a node before it has
// anywhere to authenticate. The last three are the NODE-TO-NODE channel: all
// three require the shared secret, and two of them are writer-only, which is
// what stops a replica re-serving the database it was given.
//
// 🔴 Read the paragraph above /forward before touching it: its per-record
// response shape is load-bearing, and 「silence means retry」 is the whole
// contract with the replica's queue.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY /ping EXISTS AT ALL, WHEN TCP AND TLS ARE FREE
//
// Because behind Cloudflare they measure the wrong thing, and they do it
// convincingly. Measured 2026-08-28 from five VPS in five regions against one
// CF-fronted host: `tls_ms` was 7 / 8 / 10 / 9 / 10 ms — a 3 ms spread — while
// the SAME machines running a real session against the SAME host spanned
// 44 → 279 ms. The handshake reaches the local CF edge and stops; the latency a
// user actually pays lives behind it.
//
// So a node selector built on ping/connect/TLS would report every node as
// equally fast, pick one at random, and NEVER LOOK BROKEN. This route is the
// cheapest thing that cannot do that: the origin process itself must produce
// the body, so the reading contains the backhaul by construction.
//
// It follows that the response MUST NOT be cacheable. A cached /ping is exactly
// the failure this route was built to prevent, wearing the route's own name.
// ─────────────────────────────────────────────────────────────────────────────
//
// PUBLIC AND UNAUTHENTICATED, on the same argument as /api/health and
// /api/updates/latest: a client has to choose a node BEFORE it has anywhere to
// authenticate against. The body carries no secret — a node id, a monotonic
// counter, and the server's own version.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

/** What a node calls itself. Matches the subdomain: `srvny`, `srvjp`. */
export type NodeId = string;

export interface NodeEntry {
  /** `srvny` — also the DB value stored in pc_devices.home_node. */
  id: NodeId;
  /** `https://srvny.flowmic.app` — what a client dials. */
  url: string;
  /** Free-text, for humans reading logs. Never parsed. */
  region?: string;
  /** Absent or true = offer it. false = published but not selectable, so an
   *  operator can drain a node without deleting it and losing the record of
   *  what its id meant. */
  selectable?: boolean;
  /**
   * `'writer'` marks the ONE node that accepts first contact — registration and
   * pairing. Absent everywhere else, including on every single-node deployment,
   * where there is nothing to route away from.
   *
   * 🔴 WHY IT IS ON THE ENTRY AND NOT INFERRED FROM THE ANSWERING NODE. A replica
   * already reports `writer: <url>` beside the list, so a client that asked a
   * REPLICA could work it out — but a client that asked the WRITER gets no
   * marker at all, and「absent because you are talking to the writer」and「absent
   * because this deployment has no writer」would be the same bytes. One value,
   * two questions, and the caller acts differently on each: raised by the mobile
   * lane, which could not route pairing without it and correctly refused to
   * guess ("the first selectable entry" would have been a guess wearing a rule).
   *
   * ⚠️ Pairing must reach the writer even though the phone's first contact
   * naturally lands on the PC'S node, which may be a replica: the phone learns
   * the PC from a QR or short code, not from an account. Replication lag makes
   * 「register, then immediately pair」 fail on a replica, so first contact is
   * routed here and the reconnect ack then moves the phone to `home_node`.
   */
  role?: 'writer';
}

export interface NodeRoutesDeps {
  /** This node's own id. Mounting without it is a configuration error, not a
   *  default — a node that does not know its own name cannot be located, and
   *  guessing one would put a wrong value into pc_devices.home_node. */
  nodeId: NodeId;
  /** Operator-maintained list, same shape of dependency as the update manifest:
   *  a path, whose mere presence means "this deployment is multi-node". */
  nodeListPath?: string;
  /** Server version, echoed so a client can see two nodes disagree. */
  version: string;
  /** Authoritative lookup: which node is this PC registered on right now.
   *  Returns undefined when the PC is unknown HERE — see the caller contract
   *  in the handler, which is the whole subtlety of this file. */
  locatePc?: (pcid: string) => { node: NodeId | null; known: boolean };
  /** True on a replica. A replica's own local answer to `locate` can be stale,
   *  so it must not pretend to be authoritative — it says who is. */
  writerUrl?: string;
  /** Node-to-node credential. Present on the writer (to check) and on a replica
   *  (to send). 🔴 NOT a user credential: it authenticates a MACHINE, grants no
   *  account, and must never be reachable from a user-facing route. */
  sharedSecret?: string;
  /** Writer only. Perform a batch of forwarded writes and report each one's
   *  outcome by id. Synchronous because the database is (`node:sqlite`), and
   *  making it async would be the first domino of a whole-server refactor the
   *  design chose sqlite replication specifically to avoid. */
  receiveForward?: (
    records: unknown[],
    fromNode: string | null,
  ) => Record<string, 'accepted' | 'duplicate' | 'rejected'>;
  /** Writer only. A gzipped, transactionally-consistent copy of the database
   *  (`VACUUM INTO` — 8 ms and 120 KB on the wire, measured 2026-08-29 against
   *  production). Absent on a replica, which is what stops a replica re-serving
   *  the database it holds. */
  snapshot?: () => Promise<Buffer>;
  /** Writer only. The ONE authoritative read a replica is allowed to make, and
   *  deliberately not a general account API: one number, one question. */
  remainingSttMs?: (userId: string) => number;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // 🔴 The load-bearing header of this module. See the block comment above: a
  // cached /ping measures the CDN edge, which is precisely the reading this
  // route exists to avoid producing.
  'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
  pragma: 'no-cache',
} as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

interface CachedList {
  mtimeMs: number;
  nodes: NodeEntry[];
}

/** A batch bigger than this is refused rather than parsed. The replica caps its
 *  own batches (writer-client FORWARD_BATCH_MAX); this is the writer refusing to
 *  let a misbehaving or hostile sender choose how much memory it allocates. */
export const FORWARD_RECORDS_MAX = 500;

/** Constant-time comparison. A `===` here leaks the shared secret one byte at a
 *  time to anyone who can measure the reply — slowly, but this endpoint is
 *  reachable from the internet and there is no reason to be the cheap kind of
 *  wrong about it. Length is compared first because timingSafeEqual throws on a
 *  length mismatch, and a length is not the secret. */
function secretMatches(expected: string, offered: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(offered, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Read and parse the forward body, with a hard byte ceiling. Streaming rather
 *  than buffering the whole request first: the ceiling has to bite BEFORE the
 *  bytes are in memory, or it is decoration. */
async function readForwardBody(req: IncomingMessage): Promise<{ records?: unknown }> {
  const MAX_BYTES = 4 * 1024 * 1024;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BYTES) throw new Error('forward body too large');
    chunks.push(buf);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!parsed || typeof parsed !== 'object') throw new Error('forward body must be an object');
  return parsed as { records?: unknown };
}

/** Parse defensively: an operator edits this file by hand on a live box, and a
 *  typo must degrade to "no list" rather than to a 500 that takes the node
 *  offline for everyone. */
export function parseNodeList(raw: string): NodeEntry[] {
  const parsed: unknown = JSON.parse(raw);
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { nodes?: unknown })?.nodes)
      ? (parsed as { nodes: unknown[] }).nodes
      : null;
  if (!arr) throw new Error('node list must be an array, or {nodes:[...]}');
  const out: NodeEntry[] = [];
  for (const e of arr) {
    const o = e as Partial<NodeEntry>;
    if (typeof o?.id !== 'string' || !o.id.trim()) continue;
    if (typeof o?.url !== 'string' || !/^https:\/\//.test(o.url)) continue;
    out.push({
      id: o.id.trim(),
      url: o.url.replace(/\/+$/, ''),
      ...(typeof o.region === 'string' ? { region: o.region } : {}),
      ...(o.selectable === false ? { selectable: false } : {}),
      // Exact match, never 「any non-empty role」: an unrecognised role is
      // dropped rather than carried, so a typo cannot promote a replica to
      // first contact. Under-matching is the safe failure — the client stays on
      // the endpoint it already had.
      ...(o.role === 'writer' ? { role: 'writer' as const } : {}),
    });
  }
  return out;
}

export function makeNodeRoutes(
  deps: NodeRoutesDeps,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  let cache: CachedList | null = null;

  const nodeList = (): NodeEntry[] => {
    if (!deps.nodeListPath) return [];
    let mtimeMs: number;
    try {
      mtimeMs = statSync(deps.nodeListPath).mtimeMs;
    } catch {
      return [];
    }
    if (cache && cache.mtimeMs === mtimeMs) return cache.nodes;
    try {
      const nodes = parseNodeList(readFileSync(deps.nodeListPath, 'utf8'));
      cache = { mtimeMs, nodes };
      return nodes;
    } catch {
      // A malformed file is not an outage. Keep serving whatever last parsed;
      // if nothing ever did, serve nothing and let the client fall back to the
      // host it already dialled.
      return cache?.nodes ?? [];
    }
  };

  return (req, res): boolean => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    if (!url.startsWith('/api/node/')) return false;
    const path = url.split('?')[0];
    // /forward is the one write in this file, so it is the one POST. Everything
    // else stays read-only, which is what lets the rest of the module be
    // unauthenticated without further argument.
    const allowed = path === '/api/node/forward' ? method === 'POST' : method === 'GET' || method === 'HEAD';
    if (!allowed) {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }

    // ── /api/node/ping ──────────────────────────────────────────────────────
    // Deliberately does no I/O, touches no database and takes no lock: the
    // number a client derives from it must be transport, not load. A ping that
    // queued behind a busy DB would make a healthy-but-loaded node look far,
    // and the client would route around a node that was fine.
    if (path === '/api/node/ping') {
      sendJson(res, 200, {
        ok: true,
        node: deps.nodeId,
        version: deps.version,
        // Wall clock at the ORIGIN. A client that sees two nodes report the
        // same instant to the millisecond is being served by something that is
        // not these processes.
        t: Date.now(),
      });
      return true;
    }

    // ── /api/node/list ──────────────────────────────────────────────────────
    if (path === '/api/node/list') {
      const nodes = nodeList();
      sendJson(res, 200, {
        ok: true,
        // Always name the node answering, even when the list is empty: a client
        // that gets [] still learns where it is, and "empty list" then means
        // 「single-node deployment」 rather than 「I could not read the file」.
        node: deps.nodeId,
        nodes,
        // A replica says who can be asked authoritatively. Absent = this node
        // is the writer.
        ...(deps.writerUrl ? { writer: deps.writerUrl } : {}),
      });
      return true;
    }

    // ── /api/node/locate?pcid=… ─────────────────────────────────────────────
    //
    // 🔴 THE SUBTLE ONE. Replication only ever makes a row arrive LATE; it never
    // invents one. So:
    //   · a local HIT is trustworthy for existence,
    //   · a local MISS may simply be a row that has not replicated yet.
    // A replica therefore answers a miss with `authority: <writer url>` instead
    // of with "unknown", and the client re-asks there. Answering "unknown" on a
    // replica would send a phone that just paired on the other side of the
    // world to a screen saying its PC is offline — true of this node's copy of
    // the database, false of the product.
    if (path === '/api/node/locate') {
      const pcid = new URL(url, 'http://x').searchParams.get('pcid')?.trim() ?? '';
      if (!pcid) {
        sendJson(res, 400, { ok: false, error: 'pcid_required' });
        return true;
      }
      if (!deps.locatePc) {
        sendJson(res, 501, { ok: false, error: 'locate_not_configured' });
        return true;
      }
      const hit = deps.locatePc(pcid);
      if (hit.known) {
        sendJson(res, 200, { ok: true, pcid, node: hit.node, authoritative: !deps.writerUrl });
        return true;
      }
      // Not known here.
      if (deps.writerUrl) {
        sendJson(res, 200, {
          ok: true,
          pcid,
          node: null,
          authoritative: false,
          // Not an error and not a redirect: the client asked the nearest node
          // as designed, and this is the node telling it where the answer lives.
          authority: deps.writerUrl,
        });
        return true;
      }
      // We ARE the writer and we do not have it. That is a real answer.
      sendJson(res, 200, { ok: true, pcid, node: null, authoritative: true });
      return true;
    }

    // ── POST /api/node/forward ──────────────────────────────────────────────
    //
    // The writer receiving the writes a replica owes it. THE ONLY AUTHENTICATED
    // ROUTE IN THIS FILE, and the only one that changes anything.
    //
    // 🔴 THE RESPONSE IS PER-RECORD, NOT ALL-OR-NOTHING. A batch is not a
    // transaction: one malformed record from a replica running an older build
    // must not block the twenty good ones queued behind it, and telling the
    // replica「the batch failed」would make it retry the whole batch forever with
    // the poison record still at the front. The ids the writer says nothing
    // about stay owed — silence is not consent when the subject is money.
    if (path === '/api/node/forward') {
      if (!deps.receiveForward || !deps.sharedSecret) {
        sendJson(res, 501, { ok: false, error: 'forward_not_configured' });
        return true;
      }
      const offered = req.headers['x-flowmic-node-secret'];
      if (!secretMatches(deps.sharedSecret, typeof offered === 'string' ? offered : '')) {
        // No detail, on purpose: an attacker learning WHICH half was wrong is
        // the only thing a verbose 403 here would buy anyone.
        sendJson(res, 403, { ok: false, error: 'forbidden' });
        return true;
      }
      const from = req.headers['x-flowmic-node-id'];
      void (async (): Promise<void> => {
        try {
          const body = await readForwardBody(req);
          const records = Array.isArray(body.records) ? body.records : [];
          if (records.length > FORWARD_RECORDS_MAX) {
            sendJson(res, 413, { ok: false, error: 'too_many_records', max: FORWARD_RECORDS_MAX });
            return;
          }
          const outcomes = deps.receiveForward!(records, typeof from === 'string' ? from : null);
          sendJson(res, 200, { ok: true, node: deps.nodeId, outcomes });
        } catch (err) {
          // A 500 here is CORRECT and must stay a 500: the replica reads it as
          //「not processed」and retries. Answering 200 with an empty outcome map
          // would be indistinguishable to the replica, but a later change that
          // 「tidied」the empty map into 「all accepted」 would silently delete a
          // queue. Keep the two answers structurally different.
          sendJson(res, 500, {
            ok: false,
            error: 'forward_failed',
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }

    // ── GET /api/node/quota?user_id=… ───────────────────────────────────────
    //
    // The one read a replica may not answer for itself. Authenticated with the
    // node secret, like the other two writes-adjacent routes, and answering with
    // exactly one number: this is not a general account-reading API and must not
    // grow into one. See node/authoritative-quota.ts for why this read in
    // particular crosses a region boundary when nothing else does.
    if (path === '/api/node/quota') {
      if (!deps.remainingSttMs || !deps.sharedSecret) {
        sendJson(res, 501, { ok: false, error: 'quota_not_configured' });
        return true;
      }
      const offered = req.headers['x-flowmic-node-secret'];
      if (!secretMatches(deps.sharedSecret, typeof offered === 'string' ? offered : '')) {
        sendJson(res, 403, { ok: false, error: 'forbidden' });
        return true;
      }
      const userId = new URL(url, 'http://x').searchParams.get('user_id')?.trim() ?? '';
      if (!userId) {
        sendJson(res, 400, { ok: false, error: 'user_id_required' });
        return true;
      }
      try {
        sendJson(res, 200, { ok: true, user_id: userId, remaining_stt_ms: deps.remainingSttMs(userId) });
      } catch (err) {
        // 🔴 A 500, never a zero. The caller keeps its last known budget on a
        // failure; answering 0 would end somebody's recording because this
        // node's database hiccuped.
        sendJson(res, 500, {
          ok: false,
          error: 'quota_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }

    // ── GET /api/node/snapshot ──────────────────────────────────────────────
    //
    // The writer handing a replica a consistent copy of its database. Same
    // credential as /forward, and the same reason: this is a machine channel.
    //
    // 🔴 THIS BODY IS THE ENTIRE USER DATABASE — password hashes, tokens,
    // settings envelopes. It is not sensitive by accident, it is the most
    // sensitive response this server can produce. Two consequences that must not
    // be relaxed: the secret is required (never 「optional in dev」), and the
    // route is refused outright unless this process is a writer, so a replica
    // cannot be talked into re-serving what it holds.
    if (path === '/api/node/snapshot') {
      if (!deps.snapshot || !deps.sharedSecret) {
        sendJson(res, 501, { ok: false, error: 'snapshot_not_configured' });
        return true;
      }
      const offered = req.headers['x-flowmic-node-secret'];
      if (!secretMatches(deps.sharedSecret, typeof offered === 'string' ? offered : '')) {
        sendJson(res, 403, { ok: false, error: 'forbidden' });
        return true;
      }
      void (async (): Promise<void> => {
        try {
          const body = await deps.snapshot!();
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-encoding': 'gzip',
            'content-length': body.length,
            // Same argument as /ping, for a different reason: a cached snapshot
            // is a replica frozen at whatever the edge kept.
            'cache-control': 'no-store',
          });
          res.end(body);
        } catch (err) {
          sendJson(res, 500, {
            ok: false,
            error: 'snapshot_failed',
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }

    sendJson(res, 404, { ok: false, error: 'unknown_node_route' });
    return true;
  };
}
