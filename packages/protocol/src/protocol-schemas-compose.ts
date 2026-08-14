// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.4 (LLM / compose)
//   F-701 (no unknown events), F-702 (zod schemas for every event payload)
//
// One module per protocol domain to stay under the file-size cap (F-801). The
// COMPOSE_EVENT_SCHEMAS sub-map below is spread into EVENT_SCHEMAS by
// protocol-schemas.ts, which also re-exports every symbol here, so the public
// @flowmic/protocol surface is unchanged.
//
// NOTE (WP-R0-1): `draft` (boolean) and the `draft_polish` task are the
// compose draft-origin markers — a DIFFERENT concept from the deleted legacy
// history MODE values `draft`/`typing`. They are NOT touched by the rename
// window and remain part of the compose contract.

import { z } from 'zod';
import { NonEmpty } from './protocol-primitives';

// ─── §3.4 LLM / compose ───────────────────────────────────────────────
// F-2137: `draft` is the draft-origin marker. When true the originating
// compose:start came from a DraftPage AI task (mode ④ Polish/Organize/
// Translate), which only mutates the editable draft and does NOT inject in
// the same breath — the user explicitly injects later via the manual "Inject
// to PC" button (source:'manual'). R-history-1 still requires a
// transcript_history row on compose:done, so the server's compose:done
// side-effect commits the draft-origin row with the truthful non-injected
// status 'cached' (composed but not yet delivered) instead of a phantom
// 'injected' (F-2112 — status carries the TRUE delivery outcome / R-llm-1
// mode ④). The Tier-1 auto-compose (F-2132), which DOES inject, omits the
// flag and commits its optimistic 'injected' row.
// F-3111: `entry_id` is the reprocess write-back target. It is an additive
// optional field in the same style as `request_id` above — the server treats
// it as an opaque correlation token (never resolved against any table) and
// echoes it unchanged on chunk/done/error, exactly as it already does for
// request_id. A reprocess run always pairs entry_id with draft:true so the
// existing compose:done/compose:error side effects write no second
// `transcript_history` row and inject nothing. No name is added to the §3
// whitelist.
export const ComposeStartSchema     = z.object({
  task: z.enum(['translate', 'organize', 'draft_polish']),
  source_text: z.string(),
  source_lang: NonEmpty.optional(),
  target_lang: NonEmpty.optional(),
  draft: z.boolean().optional(),
  request_id: NonEmpty.optional(),
  entry_id: NonEmpty.optional(),
});
// GA-14 — the SECOND-PASS transcript for an utterance that already finished.
//
// Deliberately NOT a `stt:final`: that event drives the mobile FSM, and a second
// final for a settled utterance is the wedging class GA-03 fixed. This one has
// no FSM meaning at all — it is a late, better version of text the user already
// has.
//
// 🔴 CORRECTED 2026-08-07 (RT-1, 反 façade ④). This block used to end 「correlated
// by the SAME `request_id` the utterance used (A-58), so the phone can find the
// row without guessing」. Measured, all three legs false:
//   · no producer has ever set `request_id` here (server emits `{text}`);
//   · the phone does not read it — `ptt_inbound.dart` takes `data['text']` and
//     nothing else, and `_applyRefined` writes to 「最近一行」, i.e. it guesses;
//   · and there is no id TO correlate with: nothing in the audio path carries
//     one. `audio:start` has no request_id and neither does `SttFinalSchema`, so
//     the ids the phone calls `request_id` elsewhere are its own client-minted
//     `entry.clientId` values the server has never seen.
// Populating this field today would therefore mint a key with no counterpart —
// a correlation that looks available and is not, which is the same defect one
// layer along. It stays ABSENT until an utterance id exists on `stt:final`
// (additive + optional) AND the phone stores it; that is a protocol + mobile
// change and it is registered, not smuggled in.
//
// 🔴 AND THE MISSING ID IS NOT THE WORST OF IT. The phone's consumer
// (`chat_utterance.dart` `_applyRefined`) applies this frame to the newest ROW in
// `store.entries`, unfiltered by entry type or owner and guarded only on `edited`
// / `processedText`. Four of the five row-insertion callers are not utterances —
// an image sent to the PC, a record-only image, a typed note, a 常用语 tap — and
// `buildDeliveryRow` leaves both guards open on them. So a late frame can
// overwrite a picture's label or text the user typed, persisted, unrecoverably.
// RT-1 therefore did NOT add its detached polish as a second producer of this
// event: today's polish never touches `stt:refined`, and wiring it here would
// have created that path rather than found it. The unblocking condition is one
// mobile fix — `_applyRefined` must select its row the way the same package
// already does twice (`punctuation_append.dart` refuses image rows;
// `chat_control_keys.dart` uses `entriesForOwners(owners)` after card F2).
//
// `text` may be empty ONLY in the sense that zod allows it; the server does not
// send a refine that produced nothing (see stt-refine.ts) — an empty refined
// text would blank a row the user could read a moment ago.
export const SttRefinedSchema       = z.object({
  text: z.string(),
  request_id: NonEmpty.optional(),
  entry_id: NonEmpty.optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export const ComposeChunkSchema     = z.object({
  delta: z.string(),
  request_id: NonEmpty.optional(),
  entry_id: NonEmpty.optional(),
});
export const ComposeDoneSchema      = z.object({
  output_text: z.string(),
  task: z.enum(['translate', 'organize', 'draft_polish']).optional(),
  request_id: NonEmpty.optional(),
  entry_id: NonEmpty.optional(),
});
export const ComposeErrorSchema     = z.object({
  code: NonEmpty,
  message: NonEmpty,
  request_id: NonEmpty.optional(),
  entry_id: NonEmpty.optional(),
});

// Sub-map spread into protocol-schemas.ts's EVENT_SCHEMAS registry so that
// file only needs one spread line per split-out module.
export const COMPOSE_EVENT_SCHEMAS = {
  // §3.4
  // §3.3 (GA-14) — the late second-pass transcript.
  'stt:refined':           SttRefinedSchema,
  'compose:start':         ComposeStartSchema,
  'compose:chunk':         ComposeChunkSchema,
  'compose:done':          ComposeDoneSchema,
  'compose:error':         ComposeErrorSchema,
} as const;
