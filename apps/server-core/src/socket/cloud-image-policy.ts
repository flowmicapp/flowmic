// SPEC-REF:
//   docs/decisions/2026-08-01-cloud-image-policy-size-cap-and-anti-sync.md
//     (RV-87 — owner's exact words: "if it's the relay channel, the server
//      should uniformly block the client — pictures over 1M should not be
//      allowed through, to prevent the relay from being used as a photo-sync
//      tool" / "cap it at 200 pictures… and add an exclusion for a machine's
//      automatic sending")
//   packages/protocol/src/constants.ts (CLOUD_IMAGE_BYTES_MAX /
//     CLOUD_IMAGE_QUOTA_MAX / CLOUD_IMAGE_QUOTA_WINDOW_MS — the numbers, and the
//     🔴 assumption about the window, are written down there)
//   packages/protocol/src/error-codes.ts (INJECT_CLOUD_IMAGE_TOO_LARGE /
//     INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED — why they are two codes and why neither
//     reuses INJECT_FRAME_TOO_LARGE or QUOTA_EXCEEDED)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §1.1 / §3.2
//   *** HUMAN-AUDIT SENSITIVE (inject path + quota) — reviewable in isolation ***
//
// The cloud relay's image policy: one size ceiling, one 24-hour count ceiling.
// Pure decision object — it touches no socket, no DB and no clock but the one
// injected into it, so both ceilings are provable without a server.
//
// ── WHY THE MODE IS THE SERVER'S OWN, NEVER THE CLIENT'S CLAIM ────────────────
//
// owner: "the server uniformly blocks the client". `config.mode` is resolved at boot from
// FLOWMIC_MODE (config.ts:102) and is the single branch point between the LAN
// sidecar the desktop spawns and the flowmic.app deployment — the same value
// billing/quota-guard.ts and billing/usage-tracker.ts already NOOP on. Nothing a
// client sends is consulted, because a limit a client can talk its way out of is
// the "client self-discipline" that this card exists to stop being the whole story.
// Standalone NOOPs at the top of every entry: there is no relay to protect, and
// the LAN leg is where owner's own answer "switch to LAN and it will send" has
// to keep working.
//
// ── WHY IN MEMORY AND NOT `usage_records` ─────────────────────────────────────
//
// Asked first, because the card's rule is "prefer plugging into an existing
// mechanism". It does not fit, for
// two independent reasons and one that decides it:
//   ① SHAPE — `usage_records` is a MONTH bucket, PK (user_id, month), three fixed
//      numeric columns that only ever accumulate (db/repos/usage.repo.ts). A
//      rolling 24-hour window needs per-event timestamps, i.e. a new table ⇒ a DB
//      migration, which CLAUDE.md puts behind human audit + production data
//      destruction. A whole migration to hold a counter that is allowed to be
//      forgotten is the wrong trade.
//   ② MEANING — that table is what a user is BILLED for, and this ceiling is not
//      billable: no plan raises it (see the QUOTA_EXCEEDED note in
//      error-codes.ts). Filing it there would make an anti-abuse gate look like a
//      metered resource, which is the same "one thing answering two questions"
//      shape this repo
//      keeps paying for.
//   ③ PRECEDENT — this repo already has exactly this mechanism twice, in memory
//      and deliberately so: auth/register-rate-limit.ts (per-IP sliding window)
//      and room/pair-rate-limit.ts, both of which state "in-memory only (single
//      instance — no DB/schema)" in their own headers. This is the third.
//
// 🔴 THE COST, STATED RATHER THAN DISCOVERED: a server restart clears every
// window, so a restart hands everyone a fresh 200. That is a real hole and it is
// accepted knowingly — the thing owner named is "a machine's automatic
// sending", and a script
// cannot restart the relay. If the day comes that it matters, the fix is a table
// and a migration, not a bigger comment.
//
// ── WHY THE BUDGET BELONGS TO THE ACCOUNT ─────────────────────────────────────
//
// `user_id`, not the pairing and not the phone. owner's sentence is about a
// PERSON deciding to use the relay as a photo-sync pipe, and a person has one
// account and may hold several pairings. Counting per pairing would hand the same
// person 200 per handset — and worse, `mobile:pair` is scriptable, so a bot could
// mint itself a fresh budget on demand, which is precisely the actor this exists
// to bound. `user_id` is also the unit every other saas-side budget here uses
// (usage_records PK, quota-guard's argument), and on a mobile socket it is
// resolved from the phone's own token via `mobile_pairings.user_id`
// (auth/middleware.ts:165-170) — never from anything the frame says.

import type { ServerMode } from '@flowmic/protocol';
import {
  CLOUD_IMAGE_BYTES_MAX,
  CLOUD_IMAGE_QUOTA_MAX,
  CLOUD_IMAGE_QUOTA_WINDOW_MS,
} from '@flowmic/protocol';

/** The two refusals this policy can produce. Named as literals rather than as a
 *  general `ErrorCode` so a third one cannot appear here without being read. */
export type CloudImageRefusal = 'INJECT_CLOUD_IMAGE_TOO_LARGE' | 'INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED';

export type CloudImageVerdict =
  | { admit: true }
  | {
      admit: false;
      error: CloudImageRefusal;
      /** Forensic detail for the server log — never sent on the wire (the
       *  inject:result frame carries only the schema's fields). */
      detail: Record<string, number>;
    };

export interface CloudImagePolicy {
  /** May THIS account relay THIS picture right now? Pure read — nothing is
   *  stamped, so a frame that is refused further down the handler (no PC in the
   *  room) has not consumed anything. */
  judge(userId: string, imageB64: string): CloudImageVerdict;
  /** Stamp one relayed picture against the account's window. Called ONLY where
   *  the frame is actually handed to a PC — see the note at the call site. */
  record(userId: string): void;
}

/** Exact DECODED byte count of a canonical base64 string, without allocating the
 *  buffer. The schema already guarantees the shape (`InjectImageBase64Schema`:
 *  length % 4 === 0, canonical alphabet, at most two '='), so this is arithmetic
 *  rather than parsing.
 *
 *  🔴 DECODED, NOT ENCODED, and the difference is the user's: base64 is 4/3 of
 *  the picture, so judging the string would refuse a 790 KB photo for being
 *  「over 1 MB」 — a refusal naming a number the user cannot reconcile with
 *  anything their phone shows them. The phone measures the same quantity (raw
 *  bytes out of the picker, image_payload.dart), which is what lets the two gates
 *  agree on which pictures are legal. */
export function decodedBase64Bytes(b64: string): number {
  if (b64.length === 0) return 0;
  let padding = 0;
  if (b64.endsWith('==')) padding = 2;
  else if (b64.endsWith('=')) padding = 1;
  return (b64.length / 4) * 3 - padding;
}

/** Above this many tracked accounts, a `record()` also sweeps the ones whose
 *  whole window has expired. Not a limit on anything the user can see — purely a
 *  bound on a Map that would otherwise keep an array per account that ever sent a
 *  picture, forever (the sibling limiters get away without one because their
 *  windows are minutes, not a day). */
const SWEEP_THRESHOLD = 512;

export interface CloudImagePolicyOptions {
  mode: ServerMode;
  now?: () => number;
  /** Test seams. Production always takes the protocol constants. */
  bytesMax?: number;
  quotaMax?: number;
  windowMs?: number;
}

export function makeCloudImagePolicy(opts: CloudImagePolicyOptions): CloudImagePolicy {
  const now = opts.now ?? Date.now;
  const bytesMax = opts.bytesMax ?? CLOUD_IMAGE_BYTES_MAX;
  const quotaMax = opts.quotaMax ?? CLOUD_IMAGE_QUOTA_MAX;
  const windowMs = opts.windowMs ?? CLOUD_IMAGE_QUOTA_WINDOW_MS;
  /** account → ascending ms timestamps of pictures relayed inside the window. */
  const windows = new Map<string, number[]>();

  /** Trim one account's list to the live window and return it (mutates the map,
   *  dropping the account entirely when nothing survives). */
  function prune(userId: string, at: number): number[] {
    const cutoff = at - windowMs;
    const existing = windows.get(userId);
    if (existing === undefined) return [];
    const kept = existing.filter((ts) => ts > cutoff);
    if (kept.length === 0) {
      windows.delete(userId);
      return [];
    }
    windows.set(userId, kept);
    return kept;
  }

  return {
    judge(userId, imageB64): CloudImageVerdict {
      if (opts.mode !== 'saas') return { admit: true }; // standalone NOOP — no relay to protect
      // ── ① size, first ───────────────────────────────────────────────────────
      // Ahead of the count on purpose: an over-size picture is refused with the
      // verdict the user can act on (switch to LAN) even when they are also out of
      // budget, because "wait until tomorrow" would be advice that still does not
      // let this picture through. The other order would make the size ceiling
      // invisible to anyone who hit the count first.
      const bytes = decodedBase64Bytes(imageB64);
      if (bytes > bytesMax) {
        return {
          admit: false,
          error: 'INJECT_CLOUD_IMAGE_TOO_LARGE',
          detail: { bytes, max_bytes: bytesMax },
        };
      }
      // ── ② count ─────────────────────────────────────────────────────────────
      const at = now();
      const window = prune(userId, at);
      if (window.length >= quotaMax) {
        const oldest = window[0] as number; // non-empty: length >= quotaMax >= 1
        return {
          admit: false,
          error: 'INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED',
          detail: {
            used: window.length,
            max: quotaMax,
            retry_after_ms: Math.max(oldest + windowMs - at, 0),
          },
        };
      }
      return { admit: true };
    },

    record(userId): void {
      if (opts.mode !== 'saas') return;
      const at = now();
      const window = prune(userId, at);
      window.push(at);
      windows.set(userId, window);
      if (windows.size > SWEEP_THRESHOLD) {
        for (const [key, stamps] of windows) {
          const newest = stamps[stamps.length - 1];
          if (newest === undefined || newest <= at - windowMs) windows.delete(key);
        }
      }
    },
  };
}
