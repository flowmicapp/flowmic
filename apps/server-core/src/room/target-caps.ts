// SPEC-REF:
//   docs/strategy/2026-09-06-web-client-parity-privacy-image-and-ux-addendum.md §3
//   packages/protocol/src/protocol-schemas-auth.ts (TargetCapsSchema — the shape)
//   card S2-01
//
// The ONE place `pc_devices.target_caps` crosses between a stored string and a
// wire object, in both directions.
//
// 🔴 WHY A MODULE AND NOT TWO `JSON.parse` CALLS. This column has THREE states —
// undeclared / declared-yes / declared-no — and only one of them is spelled by
// the JSON. The other two are「the column is NULL」and「the column holds
// something this build cannot read」, and both of those have to arrive at the
// SAME answer (undeclared) or the microphone end starts refusing images to
// targets that never said no. A `JSON.parse` at each call site is two chances to
// answer that question differently, and a `try/catch` at only one of them is the
// bug shipping.
//
// ⚠️ IT NEVER RETURNS `{image:false}` AS A FALLBACK. A stored value we cannot
// parse is not a target that declined — it is a target we have not heard from,
// and this repo's rule for that is to degrade to today's product (images flow),
// never to a new refusal nobody can act on.

import { TargetCapsSchema, type TargetCaps } from '@flowmic/protocol';

/**
 * Wire object → the string that goes in the column. `undefined` in means
 * `null` out: a client that declared nothing must leave the column exactly as a
 * pre-S2-01 row has it, so the two are indistinguishable downstream — which is
 * the whole meaning of「undeclared」.
 */
export function serializeTargetCaps(caps: TargetCaps | undefined): string | null {
  return caps === undefined ? null : JSON.stringify(caps);
}

/**
 * Column → the wire object, or `undefined` for「this target has not declared」.
 *
 * Three inputs collapse to `undefined` and that is deliberate: NULL (never
 * declared), unparseable text (a write from some future or broken build), and a
 * shape this build's schema rejects. All three mean the same thing to a reader —
 * we do not know — and inventing a different answer for any of them would be
 * asserting something nobody said.
 */
export function parseTargetCaps(stored: string | null): TargetCaps | undefined {
  if (stored === null || stored === '') return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return undefined;
  }
  const parsed = TargetCapsSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
