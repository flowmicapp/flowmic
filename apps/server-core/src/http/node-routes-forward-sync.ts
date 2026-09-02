// SPEC-REF:
//   apps/server-core/src/http/node-routes.ts   (the ONE caller — this file
//     exists only because that one was at the 800-line cap when this route
//     landed, verify/lint/file-size.mjs; it is not a second entry point)
//   apps/server-core/src/node/forward-sync.ts  (the dispatch table this calls)
//
// POST /api/node/forward-sync — the generic replica→writer handoff. `verb` and
// `payload` arrive as opaque wire values; this route only shape-checks the
// envelope (verb is a non-empty string) and hands the payload to
// `deps.forwardSync`, which knows each verb's fields (node/forward-sync.ts).
//
// 🔴 409, NOT 404 or 400, FOR A STRUCTURAL REFUSAL. `/mint-code` and
// `/resolve-token` use 404 for "I don't have this row" because their whole
// shape is a lookup by id; several verbs here (`release_mobile`) are asked to
// mutate rows that must already agree with what the caller believes about
// them, so "the writer's rows disagree with the request" is closer to a
// conflict than to "not found" — and either way it must stay visibly different
// from `!res.ok` (a transport problem, WriterUnreachable on the client side),
// which 409 does by not being in the 5xx range the client treats that way.

import type { IncomingMessage, ServerResponse } from 'node:http';

/** The three module-private helpers this route needs from node-routes.ts,
 *  passed in rather than exported and re-imported: exporting them would widen
 *  that file's public surface for a dependency only this one route has, and a
 *  parameter object makes the coupling visible at the one call site instead of
 *  implicit in two files' import lists. */
export interface ForwardSyncRouteHelpers {
  readJsonBody: (req: IncomingMessage) => Promise<{ verb?: unknown; payload?: unknown }>;
  secretMatches: (expected: string, offered: string) => boolean;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
}

/** Only the two fields this route reads off `NodeRoutesDeps` — a structural
 *  subset rather than importing that type, which would re-create the very
 *  import cycle (node-routes.ts → this file → node-routes.ts) this file's
 *  extraction exists to avoid (verify/lint/circular.mjs does not special-case
 *  `import type`, so a type-only edge counts the same as a value one). Any
 *  object with these two fields satisfies both this and `NodeRoutesDeps`. */
export interface ForwardSyncRouteDeps {
  nodeId: string;
  forwardSync?: (verb: string, payload: unknown) => { ok: true; result: unknown } | { ok: false; error: string };
  sharedSecret?: string;
}

export function handleForwardSyncRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ForwardSyncRouteDeps,
  helpers: ForwardSyncRouteHelpers,
): void {
  const { readJsonBody, secretMatches, sendJson } = helpers;
  if (!deps.forwardSync || !deps.sharedSecret) {
    sendJson(res, 501, { ok: false, error: 'forward_sync_not_configured' });
    return;
  }
  const offered = req.headers['x-flowmic-node-secret'];
  if (!secretMatches(deps.sharedSecret, typeof offered === 'string' ? offered : '')) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  void (async (): Promise<void> => {
    try {
      const body = await readJsonBody(req);
      if (typeof body.verb !== 'string' || !body.verb) {
        sendJson(res, 400, { ok: false, error: 'verb_required' });
        return;
      }
      const outcome = deps.forwardSync!(body.verb, body.payload ?? {});
      if (!outcome.ok) {
        sendJson(res, 409, { ok: false, node: deps.nodeId, error: outcome.error });
        return;
      }
      sendJson(res, 200, { ok: true, node: deps.nodeId, result: outcome.result });
    } catch (err) {
      // A 500 here means "not processed" — same contract as /forward: the
      // caller must not read this as a refusal of the request's CONTENT.
      sendJson(res, 500, {
        ok: false,
        error: 'forward_sync_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}
