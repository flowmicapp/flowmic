// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md (TimelineEntry data model + "Source /
//     product separation": immutable source_text, the
//     `processed_text ?? source_text` display fallback, pre-v2r2 backfill)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.8 (E2EE entry payload; forward
//     compatibility mandatory in both directions)
//   F-3110
//
// The plaintext entry payload sealed inside an EncryptedBlob's ciphertext is
// opaque to the server, so its compatibility rules are enforced entirely
// client-side. These two pure functions are that enforcement for every
// TypeScript reader; the mobile Dart twin lives in
// apps/mobile/lib/src/timeline/timeline_entry.dart (displayText).
//
// ⚠️ NOT WIRED ON THE TS SIDE — say so out loud, because everything around this
// file reads as if it were (ruling 主控 2026-07-30, RV-46; kept per that same
// ruling rather than deleted in the 2026-07-31 stage-5 sweep). Today:
//   · the Dart twin IS wired and used by chat_utterance / image_clipboard /
//     punctuation_append — but it runs on the phone's LOCAL E2EE payload, which
//     is a different data path from the server's (now deleted) transcript store;
//   · `processed_text` has no PRODUCER anywhere. Until 0.2.27 that was an
//     observation about one column — `transcript_history.processed_text` had no
//     write site, so it was always NULL, and `history.repo.ts` said so. That table
//     and that repo were DROPPED in 0.2.27 (owner 架构裁定,
//     docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md), which does not
//     restore the field — it strengthens the statement: the invariant now rests on
//     there being no server-side transcript record at all, and on neither end's wire
//     row carrying the key (`HistoryItemSchema` has no `processed_text`;
//     the PC's own row — apps/desktop/src/lib/types.ts `TimelineRow` — has none
//     either). So the fallback's left operand is `undefined` on every TS path that
//     exists, and the only thing that could change that is a NEW writer;
//   · desktop and web render `output_text`, not this fallback.
// So `processed_text ?? source_text` is the v2r2 DESIGN, not what any TypeScript
// surface currently does. Both functions below are retained as the TS half of a
// cross-end contract whose Dart half already ships — deleting them would drop
// the contract — but a reader must not mistake「present」for「in effect」.

import {
  InjectTargetSchema,
  ProcessModeSchema,
  ProcessParamsSchema,
} from './protocol-schemas-timeline';
import type { InjectTarget, ProcessParams, TimelineEntry } from './types';

/** The four v2r2 fields, independent of the rest of the entry. */
export interface TimelineProcessingFields {
  processed_text: string | null;
  process_mode: 'translate' | 'organize' | null;
  process_params: ProcessParams | null;
  inject_target: InjectTarget | null;
}

/** Read result: the four v2r2 fields plus the backfilled source_text. */
export interface TimelineEntryPayloadFields extends TimelineProcessingFields {
  source_text: string | null;
}

/**
 * Display fallback: `processed_text ?? source_text`.
 *
 * The final `output_text` term is not a third rule — it is exactly the value
 * the backfill assigns to `source_text` for a pre-v2r2 row ("keeps its current
 * display text as source_text"), so the expression stays total for the
 * nullable field without changing what any row displays.
 */
export function resolveTimelineDisplayText(
  entry: Pick<TimelineEntry, 'processed_text' | 'source_text' | 'output_text'>,
): string {
  if (entry.processed_text !== null && entry.processed_text !== undefined) {
    return entry.processed_text;
  }
  if (entry.source_text !== null && entry.source_text !== undefined) {
    return entry.source_text;
  }
  return entry.output_text;
}

/**
 * Both-directions compatibility for a decrypted entry payload.
 *
 * - A v1 payload (no v2r2 fields) yields the four null defaults, and
 *   `source_text` falls back to the payload's display text.
 * - A v2 payload yields its fields verbatim.
 * - A field whose value does not match its shape degrades to null rather than
 *   failing the entry: forward compatibility forbids either direction from
 *   dropping an entry over a field the reader cannot use.
 *
 * Fields are read by PRESENCE, never by the blob's `schema_ver` integer, so a
 * payload whose declared version disagrees with its content still reads back
 * consistently.
 */
export function normalizeTimelineEntryPayload(raw: unknown): TimelineEntryPayloadFields {
  const o: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  const mode = ProcessModeSchema.safeParse(o.process_mode);
  const params = ProcessParamsSchema.safeParse(o.process_params);
  const target = InjectTargetSchema.safeParse(o.inject_target);

  return {
    source_text: readSourceText(o),
    processed_text: typeof o.processed_text === 'string' ? o.processed_text : null,
    process_mode: mode.success ? mode.data : null,
    process_params: params.success ? params.data : null,
    inject_target: target.success ? target.data : null,
  };
}

/** An absent `source_text` backfills from the payload's display text. */
function readSourceText(o: Record<string, unknown>): string | null {
  if (typeof o.source_text === 'string') return o.source_text;
  if (typeof o.output_text === 'string') return o.output_text;
  return null;
}
