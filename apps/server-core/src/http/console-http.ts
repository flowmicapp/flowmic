// The console family's JSON plumbing — a responder, a bounded body reader and
// one string coercion, shared by `console-routes.ts` and the password-reset
// routes that split out of it (card MAIL-1, 2026-08-09).
//
// WHY THIS FILE EXISTS. These three functions were module-private inside
// `console-routes.ts` since WP-W1. When the two `/api/password/*` routes moved
// to their own file (that file's header argues why), both halves still needed
// them. The alternative was a second copy — and two hand-rolled bounded readers
// is exactly the shape `http/body.ts`'s own header was written to prevent. So
// this is a MOVE, not a multiplication: the bodies below are verbatim from
// `console-routes.ts`, behaviour unchanged.
//
// ⚠️ NOT THE SAME AS `http/body.ts`, AND THE DIFFERENCE IS DELIBERATE FOR NOW.
// `body.ts` serves the diag/inject family and answers an over-cap upload with an
// explicit `'TOO_LARGE'` the route turns into a 413. The console reader below
// TRUNCATES at the cap and parses what is left (a truncated JSON body then fails
// to parse and becomes `{}` → the route's own 「field required」 400). Merging the
// two would change what every console route answers for an oversized body, which
// is a behaviour change with its own acceptance and is therefore not smuggled
// into an extraction card. Stated here so the divergence is a known open item
// rather than something a later reader discovers and assumes was an accident.

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Upper bound on a console request body. Bytes past it are dropped. */
export const BODY_CAP = 64_000;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > BODY_CAP) raw = raw.slice(0, BODY_CAP);
    });
    req.on('end', () => {
      if (raw.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** A body field as a string, or '' — never `undefined`, never a coerced number.
 *  Every caller's next test is `=== ''`, so a non-string is not a value to
 *  salvage, it is a missing field. */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
