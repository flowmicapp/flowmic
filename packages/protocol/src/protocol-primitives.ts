// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §2 (handshake / version negotiation)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3 (event whitelist)
//
// Shared zod primitives for the §3.x protocol-schema modules. These were
// file-local consts of protocol-schemas.ts before the domain split and
// stay package-internal: protocol-schemas.ts deliberately does NOT re-export
// this module, so the public @flowmic/protocol surface is byte-for-byte the
// same set of symbols it was before the split.

import { z } from 'zod';

// ─── primitives ────────────────────────────────────────────────────────
export const Iso8601 = z.string().min(1);
export const NonEmpty = z.string().min(1);
export const Token = z.string().min(32);
export const ClientInstanceId = z.string().min(16);

// ─── row primitives, shared by §3.5 inject and §3.6 history ───────────
//
// These two live HERE, once, because two domain modules assert the same field:
// `HistoryItemSchema` (§3.6, protocol-schemas-sync.ts) and, since the row-transit
// field-add, `InjectRequestSchema` (§3.5, protocol-schemas-inject.ts). Written as
// two literals they would be the「同一个符号两份答案」("one symbol, two answers") shape this repo keeps paying
// for — the src/dist variant of it cost 0.2.22 a false-green assertion — and a
// drifting cap is the worst kind: the sender's boundary would accept a thumbnail
// the receiver's boundary then refuses, i.e. a frame that dies mid-flight for a
// reason neither end can state.

/** Longest legal `thumb_b64` string, in base64 characters. */
export const THUMB_B64_MAX_CHARS = 200_000;

/** A BOUNDED inline thumbnail: base64 with no `data:` prefix, longest edge
 *  256 px. Deliberately not the original picture — a row you cannot recognise
 *  is worthless, but a full image per row turns a timeline into a file transfer.
 *  The cap is enforced at the wire boundary so an oversized thumbnail is refused
 *  OUT LOUD instead of quietly bloating every frame that carries one. */
export const ThumbB64 = z.string().max(THUMB_B64_MAX_CHARS);

/** What a row IS — a transcript or a picture. The two render completely
 *  differently, and inferring it from the sender's own code path is a guess
 *  about someone else's row. Absent ⇒ `'transcript'` on both events, so every
 *  frame written before this field existed still parses byte-for-byte. */
export const EntryTypeSchema = z.enum(['transcript', 'image']);

// ─── v0.2.4 · machine-level identity (owner 2026-07-29) ───────────────────────────────
//
// 「PC 端要有一个唯一的实例名或 ID 来区分是否同一 PC，手机也是……但应能明确知道是否
// 都是同一台手机和同一台 PC」("the PC side needs a unique instance name or ID to tell
// whether it's the same PC; phones too……but it must be possible to clearly tell whether
// it's the same phone and the same PC").
//
// This is NOT `ClientInstanceId`, and the difference is the whole point:
//
//   · `client_instance_id` is per CONNECTION SLOT. The desktop keeps a separate
//     credentials file per channel (socket/channel.rs), so LAN and cloud each
//     mint their own uuid. That is correct and must stay — the phone's
//     `connectionIdentity` is keyed on it, and collapsing the two would make
//     token_storage dedupe a phone's two pairings into one and silently drop a
//     token (verified against auth/token_storage.dart `_upsertPairing`).
//   · `machine_uid` / `device_uid` are per PHYSICAL MACHINE. Derived, never
//     stored per channel, so both channels compute the same value with nothing
//     to reconcile — the failure mode 0.2.1 hit with `device_name` (two files,
//     two answers) cannot occur for something that is not a file.
//
// Shape: `<2 letters>-<hex>`, e.g. `pc-1f3a…` / `mb-91c4…`. The prefix keeps a
// PC uid from ever matching a phone uid, even by accident in a log grep.
//
// PRIVACY — the raw seed NEVER travels. The desktop hashes the Windows
// MachineGuid (+ the Windows user, see pc_name.rs for why); the phone hashes
// ANDROID_ID (device_label.dart already established the rule for its 4-hex
// display suffix, and this is the same rule at 64 bits). Neither raw value
// leaves the device, and what does leave is scoped to one account — no wider
// than the `client_instance_id` uuid that has always been sent beside it.
export const DEVICE_UID_RE = /^[a-z]{2}-[0-9a-f]{16,48}$/;

/** A malformed uid degrades to ABSENT rather than failing the frame.
 *
 *  Deliberate: this field exists to GROUP rows for display and to recognise a
 *  returning machine. Neither is worth refusing a pairing over — a phone that
 *  cannot pair because its cosmetic id had the wrong shape would be a far worse
 *  bug than the duplicate row this is here to prevent. `.catch(undefined)` is
 *  the honest form of that: the server then behaves exactly like it does for a
 *  client that sent nothing, which is a path that already works. */
export const DeviceUid = z.string().regex(DEVICE_UID_RE).optional().catch(undefined);
