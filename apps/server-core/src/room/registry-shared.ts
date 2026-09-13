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

import { clientOriginOf } from '@flowmic/protocol';

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
  /** card S2-01 — which kind of end is pairing ('app' | 'web'), and its own
   *  version string. Both optional and both absent for every build that predates
   *  the field; the row then keeps NULL and the READER applies the default
   *  (protocol `clientOriginOf`). Nothing in the pairing decision branches on
   *  either — they describe the row, they do not admit or refuse it. */
  client?: string;
  client_version?: string;
  user_id?: string | null;
  // ⚠️ `trial_visitor` STOOD HERE (card NR-29) AND IS GONE (card MP-6). It was
  // the caller's statement that a pairing was about to become an unsigned web
  // trial visitor, and it existed only because the exemption was read off a
  // column written a moment after `pairMobile` returned. The exemption is now
  // read off `client`, which this insert writes itself, so the field had nothing
  // left to state — and a caller-supplied flag that no longer decides anything
  // is the façade shape this repo hunts for. `registry.ts` `pairMobile` carries
  // the whole argument at the line that used to consult it.
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

/** SECURITY (S2-04 crosscheck, 2026-09) — `isRealPc` trusts whatever sits in
 *  `client_instance_id`, and that column is filled from a CLIENT FRAME:
 *  `pc:register` and `pc:reconnect` both pass `parsed.data.client_instance_id`
 *  straight into the registry (pc.handler.ts). The only LEGITIMATE writer of
 *  the literal `CLOUD_INSTANCE_ID` is `admitCloudInstance` (registry.ts),
 *  which never reads client_instance_id off the wire — it mints the row
 *  itself. Nothing stopped an ordinary desktop from typing the reserved
 *  string into its own registration frame and, by `isRealPc`'s definition,
 *  walking straight out of the PC slot ceiling `ensurePcSlot` exists to
 *  enforce (and off the console's device counter, `console-routes.ts`) —
 *  the exact one-line opt-out `isWebRoom`'s own doc warns a client-reachable
 *  marker would be, for the sibling exemption right below this one.
 *
 *  Fix follows that same pattern at the one place that is cheaper to guard
 *  than to re-architect: treat a wire-supplied value equal to the reserved
 *  literal exactly as if the client had sent none at all (the pre-0.2.4
 *  shape every client already tolerates). `registerPc` and `reconnectPc`
 *  MUST run every client-supplied `client_instance_id` through this before
 *  it reaches a read or a write — `admitCloudInstance`'s own call sites never
 *  go through this function, so the legitimate row is untouched. */
export function sanitizeClientInstanceId(id: string | undefined): string | undefined {
  return id === CLOUD_INSTANCE_ID ? undefined : id;
}

// card S2-04 · the browser-target room. `POST /api/web/rooms` mints a `pc_devices`
// row for a web page acting as a target; `WEB_ROOM_KIND` is the value it stamps
// into `room_kind`, and this predicate is the only reader of it.
export const WEB_ROOM_KIND = 'web';

/**
 * card MP-0 — the third-party HOST room: a page that embedded FlowMic with a
 * publishable key, whose owner (the integrator, 「T」) pays for every visitor who
 * speaks into it (owner 2026-09-11 §9-1).
 *
 * 🔴 DECLARED HERE WITH NO WRITER, ON PURPOSE, AND THE COMMENT IS THE ONLY
 * THING THAT MAKES THAT HONEST. `POST /api/web/rooms` refuses `publishable_key`
 * today («not served by this deployment yet»), so NOTHING in this repo stamps
 * this value — card MP-1 is what gives it a producer. It exists now because
 * three READERS need to be right about it before that day, and each of them
 * fails toward money if it is not: `roomKindOf` (which payer rule applies),
 * `webTrialDecision` (a third-party visitor must never mint a FlowMic trial —
 * design D3), and `parsePc` (a replica that cannot bill a room must drop it
 * rather than serve it). This is the same shape `BILLING_BUDGET_MODES`'
 * `'integrator'` is declared under, and the same rule applies: the presence of
 * this constant is NOT evidence that anything emits it — grep for the writer.
 */
export const INTEGRATOR_ROOM_KIND = 'integrator';

/** Every value `pc_devices.room_kind` may legally hold. NULL is not in the list
 *  and is not a gap: it is the ordinary desktop row, which is what that column
 *  means when nobody minted the room (see the DDL). One author, because
 *  `parsePc` refuses a replicated row outside this set and `roomKindOf` maps it
 *  — two answers to 「is this value known」 would let a row be droppable on one
 *  node and billable on another. */
export const STORED_ROOM_KINDS: readonly string[] = [WEB_ROOM_KIND, INTEGRATOR_ROOM_KIND];

/** Is this a `room_kind` string this build understands? NULL is yes (ordinary
 *  PC row). Anything else is a row written by a build newer than this one, and
 *  every caller must fail CLOSED on it — never bill a guess. */
export function isKnownRoomKind(roomKind: string | null | undefined): boolean {
  return roomKind === null || roomKind === undefined || STORED_ROOM_KINDS.includes(roomKind);
}

/** Was this row minted by `POST /api/web/rooms` for a browser?
 *
 *  🔴 IT READS A SERVER-MINTED COLUMN, AND THAT IS THE WHOLE DESIGN. The
 *  register (`docs/strategy/2026-09-05-web-client-subproject-design.md` §3)
 *  proposed marking these rows with a reserved `client_instance_id` prefix. That
 *  value arrives INSIDE `pc:register`'s payload, and this predicate decides
 *  whether a row spends one of the account's paid PC slots (owner ruling W-3:
 *  a browser room must not) — so a prefix would have made 「I do not count
 *  against my own plan」 a string any desktop can type into its own registration
 *  frame. `room_kind` cannot be reached from any client frame. Same reason
 *  `client` ('app' | 'web', card S2-01) is NOT consulted here: that column is
 *  documented at its own DDL as a claim the client makes about itself.
 *
 *  ⚠️ `room_kind` is OPTIONAL in the parameter type so the many callers that pass
 *  a hand-built `{client_instance_id}` literal (tests, projections) still
 *  compile — and absent reads as 「not a web room」, which is what an ordinary row
 *  is. A required field would have been the stricter choice and the wrong one:
 *  it would have forced every such literal to state something about a feature it
 *  has never heard of. */
export function isWebRoom(pc: { room_kind?: string | null }): boolean {
  return pc.room_kind === WEB_ROOM_KIND;
}

/** Does this row spend one of the account's PAID computer slots?
 *
 *  🔴 THIS IS A SECOND QUESTION, NOT A WIDER `isRealPc`, and the difference is
 *  the whole card. The design register (§3) said to extend `isRealPc` so a
 *  browser room stops eating a slot (owner ruling W-3). Measured before writing
 *  it: `isRealPc` is ALSO the filter on both pairing-resolution paths
 *  (`registry-pair-resolve.ts` — the short-code arm and the PCID arm) and the
 *  guard inside `stampPcid`. Widening it would therefore have left a web room
 *  with no PCID and unreachable by any code — a target nothing can ever pair
 *  with, delivered under a commit message about plan slots.
 *
 *  So `isRealPc` keeps its one meaning (「not the F-3140 virtual cloud-instance
 *  row」) and this answers the plan question. Both exclusions are here because
 *  neither row is a computer the user installed anything on; the cloud-instance
 *  row additionally cannot be paired with, and a web room very much can.
 *
 *  CALLERS (anti-façade — the count and the ceiling must be the same set, which
 *  is the 「Device 5 · PC 2」 defect `isRealPc` itself was created to fix):
 *  `registry.ts` `ensurePcSlot`, and the console's device list/counter
 *  (`console-routes.ts`).
 *
 *  ⚠️ NOT the mobile ceiling. A phone paired to a web room is a real handset
 *  using the account, so it is counted — see `ensureMobileSlot`, which walks
 *  `isRealPc` rows on purpose. Sharing one predicate there would have made
 *  「pair everything to the browser room」 a way around the phone limit. */
export function occupiesPcSlot(pc: { client_instance_id: string | null; room_kind?: string | null }): boolean {
  return isRealPc(pc) && !isBrowserMintedRoom(pc);
}

/** Was this row minted by `POST /api/web/rooms` at all — for a browser TARGET
 *  (`'web'`) or for a third-party HOST page (`'integrator'`, card MP-1)?
 *
 *  🔴 A SECOND PREDICATE RATHER THAN A WIDER `isWebRoom`, for the reason
 *  `occupiesPcSlot` itself is a second predicate rather than a wider `isRealPc`:
 *  `isWebRoom` has three OTHER callers (`room/web-room.ts` — the one-room-per-
 *  account lookup, its unique-violation recovery, and the release path) and all
 *  three mean 「the account's ONE browser target room」. Widening it there would
 *  have made an integrator's rooms collide with the account's own web room and
 *  be released by it — an integrator would lose every live page the moment they
 *  opened the web client.
 *
 *  🔴 AND AN INTEGRATOR ROOM MUST NOT SPEND A PAID COMPUTER SLOT, which is what
 *  this predicate is for. An integration mints one room per host page; counting
 *  them as computers would put an integrator on a plan ceiling designed for
 *  desktops they installed, and the FIRST symptom would be `PCS_LIMIT_EXCEEDED`
 *  on a page that has nothing to do with their own devices.
 *
 *  ⚠️ THE MOBILE ceiling is NOT this question — `occupiesMobileSlot` reads
 *  `client` and already excludes every browser end. A phone that scans an
 *  integrator page's QR is a real handset and still counts, which is correct:
 *  it is a device on somebody's account either way. */
export function isBrowserMintedRoom(pc: { room_kind?: string | null }): boolean {
  return pc.room_kind === WEB_ROOM_KIND || pc.room_kind === INTEGRATOR_ROOM_KIND;
}

/** Does this pairing row spend one of the account's MOBILE slots?
 *
 *  🔴 card NR-29 · 待 owner 追认 (registered in
 *  `docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md` §16;
 *  the decision recorded there is the MAIN-AGENT's, not owner's, and is flagged
 *  待 owner 追认 both here and in that entry).
 *
 *  THE MEASUREMENT THIS EXISTS FOR (originally golden g29-web-unsigned-trial.mjs,
 *  RETIRED 2026-09-11 by card MP-6; the assertion now lives in
 *  `verify/golden/g26-site-demo.mjs`, which is where run-golden.mjs's registry
 *  records the move): every web
 *  instance — signed in or not — used to consume one of the PC OWNER's mobile
 *  slots, so the THIRD unsigned stranger to scan a free account's QR code was
 *  answered `MOBILES_LIMIT_EXCEEDED`, from the owner's plan, about a browser
 *  that was never going to spend a second of the owner's minutes (card R-1 put
 *  its seconds on `trial_user_id`). The ledger cites this as 「G28」; measured, it
 *  was G29 — G28 is the room-release path and says in its own header that R-1 is
 *  out of its scope.
 *
 *  THE RULE: an UNSIGNED web instance is a trial visitor, metered by the trial
 *  ledger and bounded by it (120/60/30/0 per network per UTC day) plus the
 *  one-live-end-per-room rule — it is not a device on the account, so it takes
 *  no slot. A SIGNED-IN web client counts exactly like a phone.
 *
 *  🔴🔴 REWRITTEN 2026-09-11 (card MP-6). IT READS `client`, NOT `trial_user_id`,
 *  AND THE PARAGRAPH BELOW IS KEPT BECAUSE IT WAS TRUE WHEN IT WAS WRITTEN. The
 *  old predicate said 「a web row that carries a trial identity」, and MP-6 stopped
 *  minting identities outside site-demo rooms — so on the very next deploy every
 *  unsigned browser guest on a real desktop would have started consuming the
 *  owner's handset slots again, restoring the exact defect NR-29 measured, with
 *  no test anywhere going red. The rule NR-29 decided is unchanged; what changed
 *  is which column can still express it.
 *
 *  ⚠️ AND IT IS NOW SYMMETRIC, which the old one was not. A signed-in web client
 *  was supposed to count like a phone, and the paragraph below records that it
 *  did not in practice (a row that paired unsigned kept its anchor for life). A
 *  browser tab is not a device on the account either way; saying so in one line
 *  is honest, where the previous rule's outcome depended on whether the visitor
 *  happened to sign in before or after they first scanned.
 *
 *  🔴 THE SUPERSEDED PARAGRAPH: 「UNSIGNED」 IS READ OFF `trial_user_id`, AND THAT
 *  IS A CLAIM ABOUT WHO WRITES THAT COLUMN, not a convenience.
 *  `auth/web-trial-identity.ts` is its only writer, it writes only on the branch
 *  where the socket carried NO verified account, and the foreign key's
 *  `ON DELETE SET NULL` empties it when the 48-hour sweep takes the identity —
 *  so a non-null value means 「this row was admitted as an unsigned trial visitor
 *  and still carries that identity」.
 *
 *  🔴🔴 KNOWN GAP, STATED HERE BECAUSE NOTHING ELSE WILL SAY IT (card NR-29,
 *  待 owner 追认): A WEB INSTANCE THAT PAIRED UNSIGNED AND LATER SIGNED IN KEEPS
 *  ITS ANCHOR, SO IT GOES ON NOT COUNTING. The card's own decision says a
 *  signed-in web client counts like a phone, and that half is only true for a
 *  browser that was ALREADY signed in when it paired (no anchor was ever
 *  minted). Making the other half true needs a place to record 「this row has
 *  graduated」, and the obvious one — clearing `trial_user_id` on the W4-05
 *  redial — was NOT available: the retired golden g29-web-unsigned-trial.mjs
 *  §6 asserted the opposite in as many words (「the identity stays ON the row …
 *  re-minting here would hand a fresh two minutes to a visitor who has already
 *  had theirs」), and card R-1 argued for it. Overturning that, or adding an
 *  additive `mobile_pairings` column for it, is a decision above this card, so
 *  it is registered rather than implemented: the ledger entry for NR-29 carries
 *  it. A refusal-only gate on the sign-in was considered and REJECTED — a wall
 *  raised by a count that will never include the row it is refusing is a status
 *  word with nothing behind it (product red line R11).
 *
 *  ⚠️ `mobile_pairings.user_id` is NOT consulted, and could not be: `pairMobile`
 *  writes `input.user_id ?? pc.user_id` and no caller passes one, so on a web row
 *  it is the PC owner by DEFAULT rather than by declaration — the same sentence
 *  `auth/metering-principal.ts` had to narrow for card R-1.
 *
 *  Through `clientOriginOf` and never `client === 'web'`: an absent `client`
 *  means 'app' and the protocol is the one author of that default
 *  (`auth/web-trial-identity.ts` `isWebPairing` states it at length). Not
 *  imported from there — `room/` importing `auth/web-trial-identity` is the
 *  module cycle `verify:lint circular` exists to catch, and metering-principal.ts
 *  resolved the identical question the identical way. */
export function occupiesMobileSlot(m: { client: string | null }): boolean {
  return clientOriginOf(m.client) !== 'web';
}
