// Card CORS-2 (2026-09-08) — the browser-read routes CORS-1 granted (see
// web-cors.ts's own header for that card's full story) each answer their OWN
// OPTIONS preflight, scoped to their own path, origin allow-list and methods.
// router.ts's replica write-guard never heard of that: it runs FIRST, sees
// `OPTIONS !== 'GET' && !== 'HEAD'`, and 421s the preflight before any of
// those handlers ever see it — so on a replica the browser never gets a
// grant, never sends the real GET, and the exact bug CORS-1 fixed on a writer
// comes right back on the two of three online PCs a replica happens to be
// homed on.
//
// This constant is a NAMED exception for exactly these four paths, not a
// blanket "OPTIONS never mutates so let every OPTIONS through" — that would
// still be TRUE (OPTIONS cannot mutate), but it would hand a free pass
// through the replica guard to every route added here in the future, sight
// unseen, on the strength of a fact about the HTTP method rather than about
// what that specific route does with it. The four paths listed are exactly
// the ones CORS-1 already wired a scoped, origin-checked preflight handler
// onto; nothing else is touched, so an OPTIONS to any other `/api/` path —
// including a write route with no preflight handler of its own — keeps the
// 421 it had before this card, unchanged.
//
// Pulled into its own module (not inlined in router.ts) purely for the
// 800-line file-size cap — CORS-1 hit the same wall on node-routes.ts and
// split the same way (node-routes-resolve-token.ts). This is a structural
// split, not a change in what either file does.

import { PC_PRESENCE_PATH } from './presence-routes';

// Card MP-11 / gap G-16 (2026-09-11) — A FIFTH PATH, and the FIRST that is not
// a browser READ. The criterion this list states above is「the route already
// owns a scoped preflight handler of its own」, and since MP-11
// `POST /api/web/rooms` does (web-room-routes.ts). It is added for the same
// reason the four above were: without it the guard below answers the preflight
// itself, and no handler ever sees it.
//
// 🔴 IT DOES NOT WEAKEN THE MUTATION RULE BY ONE BYTE. The exception is the
// OPTIONS verb, which cannot mutate; `POST /api/web/rooms` on a replica still
// gets `NODE_IS_REPLICA`, and web-cors-replica-preflight.test.ts asserts
// exactly that, unchanged.
//
// ⚠️ AND IT DOES NOT, BY ITSELF, MAKE THAT ROUTE WORK ON A REPLICA — recorded
// here rather than left for the next reader to discover. The POST that follows
// the granted preflight is refused 421, and that 421 carries NO origin grant,
// so a browser cannot read `NODE_IS_REPLICA` or the writer URL inside it: the
// integrator's page sees an opaque network failure instead of「ask the writer」.
// Closing that is a decision about the replica guard's own response, not about
// this list, and it is registered rather than taken here.
// W6a correction (2026-09-22): router.ts now grants this path's POST 421 too.
// The browser can read the refusal and writer URL; the replica still cannot mint.
export const WEB_CORS_PREFLIGHT_PATHS = new Set<string>([
  PC_PRESENCE_PATH,
  '/api/node/list',
  '/api/node/locate',
  '/api/health',
  '/api/web/rooms',
]);
