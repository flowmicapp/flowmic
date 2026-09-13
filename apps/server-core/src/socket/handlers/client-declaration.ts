// SPEC-REF:
//   docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §1.1/§1.2
//   docs/strategy/2026-09-06-web-client-parity-privacy-image-and-ux-addendum.md §3
//   packages/protocol/src/protocol-schemas-auth.ts (the field declarations)
//   card S2-01
//
// The frame → declaration mapping, in one place because BOTH PC admission legs
// (`pc:register`, `pc:reconnect`) must agree on it. The ack half lives next door
// in ./mobile-ack-fields.ts.
//
// 🔴 OMIT-WHEN-ABSENT IS THE WHOLE POINT of `clientDeclarationOf`. A frame from
// a build that predates these fields must produce an object with NO keys, not
// one with `undefined` values — 「did not say」 and 「said nothing in particular」
// have to stay distinguishable all the way to the column, and the moment one
// call site spells `client: parsed.data.client` the two collapse. Same shape
// `pcid` uses on the pairing arm, for the same reason.

import type { TargetCaps } from '@flowmic/protocol';

/** What a `pc:register` / `pc:reconnect` payload declares about its sender. */
export interface ClientDeclaration {
  client?: string;
  client_version?: string;
  target_caps?: TargetCaps;
}

export function clientDeclarationOf(
  payload: { client?: string; client_version?: string; target_caps?: TargetCaps },
): ClientDeclaration {
  return {
    ...(payload.client !== undefined ? { client: payload.client } : {}),
    ...(payload.client_version !== undefined ? { client_version: payload.client_version } : {}),
    ...(payload.target_caps !== undefined ? { target_caps: payload.target_caps } : {}),
  };
}
