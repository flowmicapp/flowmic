// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.2 (mobile_token is the phone's standing
//     credential — the same one mobile:reconnect presents)
//   docs/strategy/2026-07-30-task-package-v1.md group D, D10 (RV-32) / D3 (RV-13)
//   CLAUDE.md human-audit for the four sensitive path classes: pairing/auth
//   *** HUMAN-AUDIT SENSITIVE (auth) — reviewable in isolation ***
//
// ONE definition of "this http request carries a live pairing token", extracted
// from inject-routes.ts (2026-07-30) the moment a second route needed the same
// judgement. Two hand-rolled Bearer parsers is how one of them ends up accepting
// `Bearer` with a trailing space, or comparing against the wrong column.
//
// This module DECIDES ONLY. It writes no response, because the two callers owe
// their clients different refusal shapes (inject answers the phone's delivery
// protocol; diag answers its own upload protocol) and a shared helper that also
// answered would force one of them to lie about the other's contract.
//
// NOTE ON THE SIDE EFFECT: registry.reconnectMobile touches last_seen_at and
// backfills device_uid. That is deliberate and pre-existing — presenting a live
// token over http IS the phone being seen — but it does mean this is not a pure
// predicate, so it must not be called speculatively.

import type { IncomingMessage } from 'node:http';
import type { Registry } from '../room/registry';

/** The single method this module needs. Typed as a slice of the real Registry so
 *  there is no second interface to drift from it. */
export type PairingRegistry = Pick<Registry, 'reconnectMobile'>;

/** What a verified token resolves to: the pairing row and its owning PC row. */
export type PairedIdentity = NonNullable<ReturnType<Registry['reconnectMobile']>>;

/** `Authorization: Bearer <token>` → the token, or '' when absent/malformed.
 *  '' is never a valid token, so an empty return is always a refusal — no caller
 *  can accidentally treat "no header" as "no check needed". Deliberately NOT
 *  exported: verifyPairedMobile is the only thing that should ever have the raw
 *  token, and an exported parser with no caller is a façade waiting to happen. */
function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

/**
 * Resolve the request's Bearer token against the pairing registry — the SAME
 * lookup mobile:reconnect performs, so an http ingress can never admit a phone
 * the socket path would reject. `null` = no token, or a token no live pairing
 * owns (a revoked pairing's row is gone, so its token stops resolving here too).
 */
export function verifyPairedMobile(req: IncomingMessage, registry: PairingRegistry): PairedIdentity | null {
  const token = bearerToken(req);
  if (token === '') return null;
  return registry.reconnectMobile(token);
}
