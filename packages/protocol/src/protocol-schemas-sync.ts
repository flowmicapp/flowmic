// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.6 (history sync), §3.7 (settings sync)
//   F-701 (no unknown events), F-702 (zod schemas for every event payload),
//   F-2367 (FIX-7b mobile local-fallback row upload)
//
// One module per protocol domain to stay under the file-size cap (F-801). The
// SYNC_EVENT_SCHEMAS sub-map below is spread into EVENT_SCHEMAS by
// protocol-schemas.ts, which also re-exports every symbol here, so the public
// @flowmic/protocol surface is unchanged.

import { z } from 'zod';
import { EntryTypeSchema, Iso8601, NonEmpty, ThumbB64 } from './protocol-primitives';
import { ModeSchema } from './protocol-schemas-audio';

// ─── §3.6 history sync — RETIRED SERVER-SIDE 2026-07-31 (0.2.27) ──────
//
// owner 架构裁定 (docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md):
// 「手机↔PC 不做云端存储同步、云端不存转录」("phone↔PC do no cloud storage sync;
// the cloud stores no transcripts"). `transcript_history` and every
// server read/write path over it are GONE; each `history:*` handler in
// server-core now answers HISTORY_SYNC_RETIRED.
//
// The EVENT NAMES and their schemas deliberately STAY (rule 8): a 0.2.26 client is
// still in the field and will keep sending these frames, and an unregistered
// event name is SILENTLY DISCARDED — silence is the red line. Keeping the schema
// is what lets the server parse the frame it is about to refuse OUT LOUD.
//
// What was removed with the flow, because it had no object left to act on:
//   · HistoryListSchema.query + HISTORY_QUERY_MAX_CHARS (0.2.22 server LIKE
//     search) — there are no server rows to search; timeline search is LOCAL on
//     each end now (PC: 0.2.26 local ownership; phone: sqflite).
//   · HistoryUpdateSchema.base_output_text + HistoryUpdateOutcomeSchema +
//     HistoryUpdateAckSchema (0.2.23 C5 conflict verdict) — it arbitrated two
//     writers of ONE server row, and there is no server row. The design
//     knowledge (§「输家必须被告知」("the loser must be told")) is preserved in
//     docs/strategy/2026-07-30-c5-conflict-criteria-design.md, which carries a
//     retirement header naming the light-record multi-device case that will reuse it.
const HistoryItemSchema = z.object({
  id: NonEmpty,
  pairing_id: NonEmpty.nullable(),
  pc_device_id: NonEmpty,
  user_id: NonEmpty,
  mobile_id: NonEmpty.nullable(),
  mode: ModeSchema,
  source_text: z.string().nullable(),
  source_lang: NonEmpty.nullable(),
  output_text: z.string(),
  output_lang: NonEmpty.nullable(),
  duration_ms: z.number().int().nullable(),
  segments_count: z.number().int().nonnegative(),
  // WP-R1-1 (master-plan §4.0 D): status records DELIVERY TRUTH ONLY —
  // injected | cached | failed | noted (📥 record-only, the new fifth badge).
  // The legacy 'edited' STATUS VALUE was removed (this rev's single non-additive
  // exception, sanctioned because the 0.1.0 line has zero deployed consumers);
  // editing is now the independent `edited` overlay bit below, which also fixes
  // the old line's injected→edited information loss (a delivered-then-edited row
  // no longer forgets it was delivered).
  status: z.enum(['injected', 'cached', 'failed', 'noted']),
  // Overlay flag, orthogonal to `status`. Absence = false (an un-edited row);
  // set true once the user has edited the text. Optional/additive so every v1
  // row (which never carried it) still parses.
  edited: z.boolean().optional(),
  // ── owner 2026-07-27 (authorised): the picture row stops being a sentence ──
  //
  // A T-4 image synced as an ORDINARY row whose text was its own descriptor
  // (「🖼 PNG · 78 KB」) — `entry_type` was device-local because the protocol was
  // frozen at the time, so every peer saw a line of prose where a picture had
  // been. Two additive fields end that:
  //
  //   entry_type — what the row IS. Absent ⇒ 'transcript', so every pre-existing
  //     row parses byte-for-byte as before. The PC used to infer imageness from
  //     its own inject path, which is a guess about someone else's row.
  //   thumb_b64 — a BOUNDED inline thumbnail (longest edge 256 px), base64 with
  //     no data: prefix. Deliberately NOT the original: the timeline is the
  //     product's essence and a row you cannot recognise is worthless, but a full
  //     picture per row would turn a sync list into a file transfer. An
  //     attachment table would carry retention, cleanup, sync and e2ee with it —
  //     out of proportion to "show me which screenshot this was".
  //
  // Both shapes moved to protocol-primitives.ts in the row-transit round: the
  // SAME two fields now also ride `inject:request` (§3.5), and two literals for
  // one field is the「同一个符号两份答案」("one symbol, two answers") shape. The cap is still enforced at this
  // boundary — it is now the same cap object the other boundary enforces.
  entry_type: EntryTypeSchema.optional(),
  thumb_b64: ThumbB64.optional(),
  created_at: Iso8601,
  updated_at: Iso8601,
});
// `query` (0.2.22 server-side LIKE search, owner 2026-07-30 ③) was REMOVED on
// 2026-07-31 with the server's transcript store: a search field whose server has
// no rows to search would answer「没搜到」("not found") about a table that does not exist, which
// is the false-negative half of 没有静默失败. Search now lives where the rows do —
// locally on each end. `since`/`limit` stay because the schema must still parse
// the frames a 0.2.26 client sends at a server that refuses them.
export const HistoryListSchema       = z.object({
  since: Iso8601.optional(),
  limit: z.number().int().positive().max(100).optional(),
});
export const HistoryListResultSchema = z.object({ items: z.array(HistoryItemSchema), has_more: z.boolean() });
export const HistoryCreateSchema     = z.object({ item: HistoryItemSchema });
// GA-13 — WHO rewrote this row.
//
// `history:update` has always meant「人改的」("a human changed it") and set the `edited` bit accordingly.
// Entry-level reprocess (re-translate/reorganize) needs to replace `output_text` too, but a
// machine rewrite that set `edited` would have the row claim a human touched it —
// directly against the rule GA-01 established (applyProcessed deliberately does
// not touch the bit). Hence one additive optional field rather than a second
// event: absent ⇒ `'user'` ⇒ byte-for-byte the pre-GA-13 behaviour, so an older
// client needs no negotiation and EVENT_NAMES/the count guard are untouched.
//
// ── the C5 conflict half of this event was REMOVED on 2026-07-31 (0.2.27) ────
//
// `base_output_text` + `HistoryUpdateOutcomeSchema` + `HistoryUpdateAckSchema`
// existed to arbitrate TWO writers of ONE server row (0.2.23). The server no
// longer holds the row, so there is nothing to arbitrate and no ack shape to
// answer with — `history:update` itself is refused (HISTORY_SYNC_RETIRED).
// Deleted rather than left in place: a judgement rule with no object is read by
// the next reader as「它在服务某个流程」("it's serving some process"), which is the façade shape this project
// keeps paying for. The rule itself is preserved as DESIGN, with the case that
// will reuse it named in the header of
// docs/strategy/2026-07-30-c5-conflict-criteria-design.md.
export const HistoryUpdateSchema     = z.object({
  id: NonEmpty,
  output_text: z.string(),
  origin: z.enum(['user', 'machine']).optional(),
});
export const HistoryUpdatedSchema    = z.object({ item: HistoryItemSchema });
export const HistoryDeleteSchema     = z.object({ id: NonEmpty });
export const HistoryDeletedSchema    = z.object({ id: NonEmpty });
export const HistoryInjectSchema     = z.object({ id: NonEmpty });
// HistoryCreateLocalSchema was deleted with the `history:create-local` event on
// 2026-07-31 (stage-5 cleanup). The F-2367 compose-watchdog local-fallback
// upload was never ported to this line: no mobile emitter, no server handler.

// ─── §3.7 settings sync ───────────────────────────────────────────────
export const SettingsListSchema      = z.object({});
export const SettingsUpdateSchema    = z.object({ key: NonEmpty, value: z.unknown() });
export const SettingsUpdatedSchema   = z.object({ key: NonEmpty, value: z.unknown() });

// Sub-map spread into protocol-schemas.ts's EVENT_SCHEMAS registry so that
// file only needs one spread line per split-out module.
export const SYNC_EVENT_SCHEMAS = {
  // §3.6
  'history:list':          HistoryListSchema,
  'history:list-result':   HistoryListResultSchema,
  'history:create':        HistoryCreateSchema,
  'history:update':        HistoryUpdateSchema,
  'history:updated':       HistoryUpdatedSchema,
  'history:delete':        HistoryDeleteSchema,
  'history:deleted':       HistoryDeletedSchema,
  'history:inject':        HistoryInjectSchema,
  // §3.7
  'settings:list':         SettingsListSchema,
  'settings:update':       SettingsUpdateSchema,
  'settings:updated':      SettingsUpdatedSchema,
} as const;
