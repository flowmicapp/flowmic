// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (pairing address shapes)
//   docs/decisions/2026-08-14-owner-cloud-pairing-requires-pcid.md (0.2.66 PCID)
//
// 🔴 STRUCTURAL SPLIT ONLY (WP-9, 2026-09-02) — moved VERBATIM out of
// registry.ts (the 800-line cap; see that file's header and
// registry-pair-resolve.ts's for the full account). This is the LEAF of the
// split: both registry.ts and registry-pair-resolve.ts need `PairInput` /
// `isRealPc` / the PCID constants, and putting them in either of those two
// files would make the other IMPORT FROM IT — an import cycle the repo's own
// `verify:lint circular` rule exists to catch. A leaf file with no imports
// from either side is what breaks that cycle before it can form.
//
// registry.ts re-exports every name here (`export * from './registry-shared'`)
// so every existing `import { isRealPc } from '../room/registry'` (console-
// routes.ts and others) keeps working unchanged — this split is invisible to
// every importer except the two files that now share this leaf directly.

export interface PairInput {
  short_code?: string;
  qr_payload?: string;
  /** 0.2.66 — the PUBLIC 9-digit addressing id of the PC this phone means (04
   *  §3.1 PCID addressing). Only ever set on the short-code arm: the QR arm carries
   *  its own inside `qr_payload` and is parsed out of it in `resolvePcForPair`,
   *  so both arms reach the same code path (owner 2026-08-14: "scanning a QR
   *  and typing it by hand are the same logic"). Required in SAAS, ignored in standalone (no PCID on the LAN). */
  pcid?: string;
  mobile_name?: string;
  /** v0.2.4 — the handset's own machine-level id (protocol DeviceUid). The
   *  reuse key, in preference to the name; absent for a pre-0.2.4 phone. */
  device_uid?: string;
  user_id?: string | null;
}

// F-3140 (05 §1): the fixed "cloud instance" virtual PC row identity. Per-user,
// find-or-created on cloud admission; never online (pc_online:false), never a
// code-pairing target (its short_code is never stamped ACTIVE in the governor).
export const CLOUD_INSTANCE_ID = 'flowmic-cloud-instance';
export const CLOUD_INSTANCE_SHORT_CODE = '0000';
export const CLOUD_INSTANCE_PC_NAME = 'FlowMic Cloud';

/** 0.2.66 — the PCID shape, stated once so the arithmetic has a symbol to cite
 *  instead of a number retyped across the server, the desktop and the phone:
 *  `randomInt(0, PCID_SPACE)` zero-padded to PCID_DIGITS, so the alphabet is 0-9,
 *  the length is 9 and the space is exactly 10^9. Pinned (alphabet, length and
 *  bounds, by sampling) in test/pcid-pairing.test.ts.
 *
 *  🔴 THIS IS ADDRESSING, NOT A SECRET — do not reason about it the way
 *  SHORT_CODE_SPACE is reasoned about in short-code.ts. It is printed on the PC
 *  for anyone in the room to read, it never expires, and knowing one buys an
 *  attacker nothing on its own: pairing still requires a live 4-digit code, and
 *  that code keeps all three of its limits (5-minute TTL, per-issuance failure
 *  budget, per-IP window). The size is chosen so a PCID is comfortably typeable
 *  while a blind walk of the space is pointless, not because it is a password. */
export const PCID_DIGITS = 9;
export const PCID_SPACE = 1_000_000_000;
/** The one shape gate. Used by the resolve path AND by the tests; a second
 *  hand-written `/^\d{9}$/` somewhere else is how the desktop and the server end
 *  up disagreeing about what a PCID is. */
export const PCID_RE = /^\d{9}$/;

/** Is this a PC the USER actually registered?
 *
 *  v0.2.3 — the ONE definition. The F-3140 cloud-instance row is a virtual device
 *  the server mints on cloud admission (it has no focus window and nobody
 *  installed it), so it is not a machine anyone owns. The quota path has always
 *  known that; the console's device counter did not, and answered the same
 *  question — "how many PCs does this user have" — with `pcs.length`. owner 2026-07-29 read
 *  "Device 5 · PC 2" with exactly one PC.
 *
 *  Exported so there is nowhere left to disagree: two definitions of a real PC is
 *  how the display and the limit drift apart, and a device count that does not
 *  match the limit it is displayed next to is worse than no count. */
export function isRealPc(pc: { client_instance_id: string | null }): boolean {
  return pc.client_instance_id !== CLOUD_INSTANCE_ID;
}
