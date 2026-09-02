// SPEC-REF:
//   apps/server-core/src/node/node-config.ts   (readNodeConfig — the env half)
//   apps/server-core/src/http/node-routes.ts   (parseNodeList — the file half,
//     GET /api/node/list — the same parse every client and this check use)
//   docs/strategy/2026-09-02-full-implementation-audit-and-next-plan.md
//     §3-B B7/B11
//
// B11 (2026-09-02, WP-6) — a machine gate against a SPECIFIC split-brain: this
// process's OWN role comes from FLOWMIC_NODE_ROLE, an env var read on THIS box
// (node-config.ts `readNodeConfig`); which node accepts first contact
// (registration, pairing) comes from the PUBLISHED node directory's
// `role:"writer"` entry (node-list.json, the same file GET /api/node/list
// serves to every client and desktop's `node_select.rs` reads to route
// registration). Nothing before this card cross-checked those two
// independently-edited declarations against each other.
//
// findings-crossend-multinode.md B7: "ShortCodeGovernor maps per-process...
// works only because [pairing traffic] uses cfg.endpoint = writer; if endpoint
// points at a replica door => valid code refused. No machine gate." The socket
// handler's own writer-only refusal (mobile.handler.ts `mobile:pair`, checked
// BEFORE any admission variant) already makes a misrouted pairing attempt FAIL
// SAFELY — never wrong-node crosstalk, never a silently accepted write. What it
// cannot do is catch the MISCONFIGURATION that produces the failure in the
// first place: an operator promotes a new writer in the shared JSON file
// without updating that box's own FLOWMIC_NODE_ROLE, or demotes a former
// writer's env var without updating the file every phone's QR and every
// desktop's `/api/node/list` read still names. Either produces the same
// symptom — first contact routed at a door that refuses it — days before
// anyone connects the report to a config file two people edited separately.
//
// So this asserts the two sources AGREE, ONCE, at boot, where an operator is
// watching (the same "fail the boot, not 3am inside someone's recording" rule
// node-config.ts's own header states) — never per-request, and never when
// there is nothing to compare against (a fresh box with no directory yet, or a
// single-node deployment, must boot exactly as they do today).

import { readFileSync } from 'node:fs';
import { NodeConfigError, type NodeConfig } from './node-config';
import { parseNodeList, type NodeEntry } from '../http/node-routes';

/**
 * Pure check: does this process's OWN role agree with what the directory says
 * about the node carrying its id? `nodes` is whatever `parseNodeList` already
 * produced — this never re-parses or re-validates a row's shape.
 *
 * Silently returns (no assertion made) when there is nothing to compare:
 *   · `single` deployments have no directory concept at all;
 *   · a `nodeId` the directory does not mention is a directory that has not
 *     caught up yet (a fresh box, a file mid-edit) — a MISS is not evidence of
 *     a mismatch, and inventing one here would be exactly the "boot fails on a
 *     file that simply is not there yet" fault this must not add.
 */
export function assertWriterDirectoryConsistency(
  config: Pick<NodeConfig, 'role' | 'nodeId'>,
  nodes: readonly Pick<NodeEntry, 'id' | 'role'>[],
): void {
  if (config.role === 'single' || config.nodeId === null) return;
  const mine = nodes.find((n) => n.id === config.nodeId);
  if (!mine) return;
  const directorySaysWriter = mine.role === 'writer';
  const envSaysWriter = config.role === 'writer';
  if (directorySaysWriter === envSaysWriter) return;
  throw new NodeConfigError(
    envSaysWriter
      ? `this process is configured as the writer (FLOWMIC_NODE_ROLE=writer) but `
        + `the published node directory does not mark node ${JSON.stringify(config.nodeId)} `
        + `as role:"writer" — clients and desktops following the directory will never `
        + `route registration or pairing here.`
      : `this process is configured as a ${JSON.stringify(config.role)} `
        + `(FLOWMIC_NODE_ROLE=${config.role}) but the published node directory marks node `
        + `${JSON.stringify(config.nodeId)} as role:"writer" — every registration and pairing `
        + `the directory routes here will be refused.`,
  );
}

/**
 * The boot-time IO wrapper `node-runtime.ts` calls: read `config.listPath`
 * (when set) and run the pure check above.
 *
 * ⚠️ A missing or malformed file is NOT a new fault this gate invents —
 * `node-routes.ts`'s own reader already treats that as "nothing to act on"
 * (an operator hand-edits this file on a live box; a typo must degrade to "no
 * list" rather than take the process down). This wrapper degrades the SAME
 * way: a file that cannot be read or parsed means there is nothing to compare
 * against, so it warns and returns rather than throwing — the one thing it
 * refuses to do silently is disagree.
 */
export function assertWriterDirectoryConsistencyFromFile(
  config: NodeConfig,
  log: { warn(msg: string, meta?: Record<string, unknown>): void },
): void {
  if (config.listPath === null) return;
  let nodes: NodeEntry[];
  try {
    nodes = parseNodeList(readFileSync(config.listPath, 'utf8'));
  } catch (err) {
    log.warn('node directory consistency check: could not read/parse the node list — skipped, not failed', {
      list_path: config.listPath,
      reason: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  assertWriterDirectoryConsistency(config, nodes);
}
