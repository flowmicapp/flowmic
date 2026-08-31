// SPEC-REF:
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §1 (nodes)
//   docs/strategy/2026-08-31-multinode-regression-rca-and-geo-strategy.md §13/§14
//     (the Hong Kong front door, and the measurements that made it worth having)
//
// WHICH NODE AM I, FOR THIS REQUEST.
//
// Until 2026-08-31 a process had exactly one node id, read once from
// FLOWMIC_NODE_ID, and that was right because a node was a machine. It stopped
// being right the day a second hostname started reaching the same process:
// `srvasia02.flowmic.app` is a Hong Kong reverse proxy in front of the Tokyo
// relay, and it exists because Cloudflare is a ~6x detour on some networks
// (measured from a mainland tablet: 212 ms through that door versus 1242 ms
// through the CF-fronted one).
//
// 🔴 WHY THE HOSTNAME AND NOT A CLIENT-SUPPLIED FIELD. `home_node` is how a
// phone finds its PC. A client that could name its own node could send other
// people's phones somewhere of its choosing, and「the client asserts the
// topology」is not a thing this repo does. The Host header is chosen by whoever
// operates the door, which is the same party that operates the node directory —
// one owner for one fact.
//
// 🔴 AND WHY UNKNOWN HOSTS FALL BACK RATHER THAN FAIL. The mapping only takes
// effect when a front door forwards the original Host. If an operator has not
// done that yet — or reverts it — every request arrives under the node's own
// hostname, no entry matches, and the process answers exactly what it answered
// before this file existed. The failure mode of a missing mapping is "no
// change", never "a node with no name".

/** A parsed `host → node id` mapping. Hosts are lower-cased and port-stripped. */
export type NodeHostMap = ReadonlyMap<string, string>;

/** Strip the port and lower-case, so `SrvJP.flowmic.app:443` and
 *  `srvjp.flowmic.app` are one key. IPv6 literals keep their brackets and are
 *  therefore never split on the wrong colon. */
function normaliseHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close < 0 ? host : host.slice(0, close + 1);
  }
  const colon = host.indexOf(':');
  return colon < 0 ? host : host.slice(0, colon);
}

/**
 * Parse `FLOWMIC_NODE_HOSTS`.
 *
 * Format: `host=nodeId` pairs separated by commas or whitespace, e.g.
 *   `srvasia02.flowmic.app=srvasia02`
 *
 * ⚠️ Anything unparseable is DROPPED, not thrown. This value is set by hand in
 * an operator's env file on a machine that also serves real users; a typo must
 * cost the alias, not the relay.
 */
export function parseNodeHostMap(raw: string | undefined | null): NodeHostMap {
  const out = new Map<string, string>();
  if (typeof raw !== 'string' || raw.trim() === '') return out;
  for (const chunk of raw.split(/[,\s]+/)) {
    if (chunk === '') continue;
    const eq = chunk.indexOf('=');
    if (eq <= 0) continue;
    const host = normaliseHost(chunk.slice(0, eq));
    const id = chunk.slice(eq + 1).trim();
    // An empty id would map a host onto "no node", and every consumer of a node
    // id treats the empty string as absent — so it would silently behave like
    // the host was never listed, which is a confusing way to spell "ignored".
    if (host === '' || id === '') continue;
    out.set(host, id);
  }
  return out;
}

/**
 * The node id to answer with for a request that arrived under `host`.
 *
 * `fallback` is the process's own FLOWMIC_NODE_ID and is returned whenever the
 * host is absent, unmapped, or unparseable.
 */
export function nodeIdForHost(
  host: string | undefined | null,
  map: NodeHostMap,
  fallback: string,
): string {
  if (map.size === 0) return fallback;
  if (typeof host !== 'string' || host.trim() === '') return fallback;
  return map.get(normaliseHost(host)) ?? fallback;
}

/** The `Host` a Node http request arrived under, preferring the forwarded one.
 *
 * ⚠️ `x-forwarded-host` is trusted here and that is a deliberate, bounded
 * decision: this process is only ever reached through doors the operator runs
 * (Cloudflare, or a reverse proxy they configured), the value is used for
 * nothing but choosing between node ids the operator themselves listed, and an
 * unlisted value falls back. It is not an authentication input and must never
 * become one.
 */
export function requestHost(headers: Record<string, unknown>): string | undefined {
  const fwd = headers['x-forwarded-host'];
  const first = typeof fwd === 'string' ? fwd.split(',')[0] : undefined;
  if (typeof first === 'string' && first.trim() !== '') return first;
  const host = headers['host'];
  return typeof host === 'string' ? host : undefined;
}
