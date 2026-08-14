// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.8 (timeline sync payloads — v2.0, A-49)
//   docs/rebuild/04-PROTOCOL-SPEC.md §5 / product red line: the `e2e:v1:`
//     prefix is strictly distinct from the server-decryptable `enc:v1:`
//   F-3001 (WP-1B)
//
// One module per protocol domain to stay under the file-size cap (F-801); the
// §3.8 timeline block is registered into EVENT_SCHEMAS / EVENT_NAMES
// atomically via re-export from protocol-schemas.ts (the
// `satisfies Record<EventName, ...>` constraint requires events.ts and the
// registry map to change together).

import { z } from 'zod';
import { TIMELINE_E2E_PREFIX } from './constants';

const NonEmpty = z.string().min(1);

// `ciphertext` / `wrap` MUST carry the 'e2e:v1:' prefix (F-3005/F-3008
// redline) — the server treats the value as fully opaque and can never
// decrypt it. STRICTLY distinct from F-705's server-decryptable 'enc:v1:'
// prefix.
const E2eCiphertext = z.string().refine(
  (v) => v.startsWith(TIMELINE_E2E_PREFIX),
  `ciphertext must be ${TIMELINE_E2E_PREFIX}-prefixed`,
);

// F-3034 (SPEC_AUDIT_LOG A-52): optional pull-direction tombstone signal.
// Push-direction callers never set it; the server stamps `deleted: true` on
// tombstoned rows when serving `timeline:pull-result` (ciphertext left
// untouched).
export const EncryptedBlobSchema  = z.object({
  id: NonEmpty,
  seq: z.number().int().nonnegative(),
  ciphertext: E2eCiphertext,
  created_at: z.number().int().nonnegative(),
  schema_ver: z.number().int().positive(),
  deleted: z.boolean().optional(),
});

// v2r2 batch1 (A-56 / F-3110): the shapes of the two structured v2r2 entry
// fields. They live inside the E2EE ciphertext (the server never sees them)
// and are validated client-side when a payload is read back — see
// timeline-payload.ts. `sync_state` is deliberately absent here and everywhere
// else in this file (ruling R-3, F-3016).
export const ProcessModeSchema   = z.enum(['translate', 'organize']);
export const ProcessParamsSchema = z.record(z.string(), z.string());
export const InjectTargetSchema  = z.object({
  window_title: z.string(),
  process_name: NonEmpty,
  injected_at: NonEmpty,
});

export const timelinePushSchema        = z.object({ entries: z.array(EncryptedBlobSchema) });
export const timelinePullSchema        = z.object({
  since_seq: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export const timelinePullResultSchema  = z.object({
  blobs: z.array(EncryptedBlobSchema),
  next_seq: z.number().int().nonnegative(),
});
export const timelineTombstoneSchema   = z.object({ ids: z.array(NonEmpty) });

// GRANT-1 (2026-08-11, docs/strategy/2026-08-11-design-e-grant-web-preview.md
// §3.1) — the SERVER half of the web-preview grant handshake now exists:
// server-core registers handlers for both names (grant.handler.ts, symbol
// `registerGrantHandlers`) and the server itself emits `timeline:grant` to the
// requesting web socket (blind forward of `wrap`). The client emitters are
// still pending: the web page is card GRANT-3 (web repo) and the phone's
// confirm/seal flow is card GRANT-2 — until those land there is no production
// emitter in THIS repo, and that is a delivery fact, not a reserved-shape
// disclaimer any more. (The pre-GRANT-1 note here said「no handler on any end,
// and timeline.handler.ts registers nothing for them」— true when written,
// false now, replaced rather than left to rot.)
//
// The `wrap` field carries the `e2e:v1:` half of the double-prefix red line
// (E5 ruling): the server forwards it verbatim and never parses, stores or
// logs it — the ONLY judgement is the family-prefix refine below.
//
// FIELD NOTES (all four new fields are zod-OPTIONAL, additive per the house
// rule — but the HANDLERS refuse frames missing them, by design §3.1: these
// events have never had a producer, so there are no old frames to stay
// compatible with, and「缺字段＝畸形」("a missing field = a malformed frame") is enforced at the handler rather than at
// zod so the schema change stays purely additive):
//   · `gid`            — web-minted uuid correlating request → phone grant →
//                        the durable `timeline_grants` row. Producer: web
//                        (GRANT-3). Consumer: server handlers + phone confirm
//                        page (GRANT-2, via the QR payload).
//   · `origin`         — the web origin asking for the preview (rendered on
//                        the phone's confirm page; stored on the grant row so
//                        the REST list can answer「谁被授权了」("who has been
//                        granted access")). Consumer-
//                        neutral on purpose: a future MCP consumer is a new
//                        origin value, not a new mechanism (design §7).
//   · `expires_at_ms`  — the expiry the USER chose on the phone at grant time
//                        (default 1 h, design §1 — supersedes 05 册's 24 h
//                        sketch). Producer: phone. Consumer: server (enforced
//                        on every web pull) + web (display). The server only
//                        rejects nonsense (past, or > 7 days out).
export const timelineGrantRequestSchema = z.object({
  web_pubkey: NonEmpty,
  session_fingerprint: NonEmpty,
  gid: NonEmpty.optional(),
  origin: NonEmpty.optional(),
});
export const timelineGrantSchema        = z.object({
  wrap: E2eCiphertext,
  gid: NonEmpty.optional(),
  expires_at_ms: z.number().int().positive().optional(),
});

// Sub-map spread into protocol-schemas.ts's EVENT_SCHEMAS registry (F-3002)
// so that file only needs one spread line per split-out module.
export const TIMELINE_EVENT_SCHEMAS = {
  'timeline:push':          timelinePushSchema,
  'timeline:pull':          timelinePullSchema,
  'timeline:pull-result':   timelinePullResultSchema,
  'timeline:tombstone':     timelineTombstoneSchema,
  'timeline:grant-request': timelineGrantRequestSchema,
  'timeline:grant':         timelineGrantSchema,
} as const;
