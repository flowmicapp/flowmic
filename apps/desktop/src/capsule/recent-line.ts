// Capsule "delivered-in record" (转入记录) row model — split out of controller.ts (800-line cap,
// verify/lint/file-size.mjs SRC_MAX=800), same reason and same rule as the mobile
// side's ptt_capture_pump.dart / ptt_wire_keepalive.dart splits: 卡 F1 added the
// phone-pause handlers and the file was sitting at exactly 799.
//
// 🔴 DIFF DISCIPLINE: every line below is moved **character-for-character** from
// controller.ts. The only additions are this header and the two imports. Nothing
// here reads or writes the reactive `state` — it is the pure narrowing family
// (`RecentLine` / `RecentStatus` / `toRecentLine` / `upsertRecentLine`), which is
// exactly why it is the piece that can leave. **Any other difference is a bug.**
//
// controller.ts re-exports all four names, so every existing import site
// (CapsuleApp.vue, capsule-copy.ts, recent.test.ts) is untouched.

import type { WireHistoryItem } from '../lib/types';

/** V2-15 — one structured "delivered-in record" (转入记录) line. Every field is narrowed from the
 *  history:updated / history:list-result wire row; what the wire did not say
 *  stays null and the view OMITS that cell — a plausible-looking default would
 *  be a fabrication (red line: no silent failure, both directions). */
export interface RecentLine {
  /** History row id — the upsert key (a stt:refined / peer-edit row updates in
   *  place instead of duplicating the strip). */
  id: string;
  /** content-status (内容状态) from item.mode. null when the wire carried no KNOWN mode — never
   *  a guessed 'realtime' (that guess is wrong two times out of three). */
  mode: 'realtime' | 'translate' | 'organize' | null;
  /** body text (正文) = output_text: the PROCESSED result for translate/organize, the
   *  transcript itself for realtime — always the row's display face. */
  text: string;
  /** original text (原文) source_text when the row carries one (translate/organize). */
  source: string | null;
  /** pairing_id of the sending phone. The NAME is resolved at render time from
   *  state.mobileNames (a renamed phone reads correctly on old rows; one source
   *  of truth, same pattern as the timeline's sender chip). */
  mobileId: string | null;
  /** 卡 P/D — the label the sending phone stamped on the delivery frame. The
   *  fallback when [[mobileId]] is absent or unresolvable, in that order (same
   *  rule and same reason as the timeline's `senderLabel`). A row minted from a
   *  delivery frame has only this one; a row from the retired history broadcast
   *  had only the other. null → the device cell stays omitted. */
  deviceLabel: string | null;
  /** 'HH:mm' from created_at (the capsule is narrow (胶囊很窄) — hour:minute only); null when unparseable. */
  time: string | null;
  /** v0.2.2 — 'image' rows are a DIFFERENT KIND of row, not a transcript with a
   *  picture in it. The strip used to draw them with the MODE badge, so an image
   *  wore the realtime waveform icon and looked like something that was said.
   *  `mode` is meaningless for a picture; this is what decides the badge. */
  entryType: 'transcript' | 'image';
  /** The 256px preview the phone sent (HistoryItemSchema.thumb_b64, additive
   *  since 0.1.7), or null when the row carries none — an image row without a
   *  thumbnail falls back to a generic icon rather than inventing a picture. */
  thumb: string | null;
  /** created_at as epoch ms for newest-first ordering; NaN when unknown. */
  created: number;
  /** 🔴 卡 L7 / owner 2026-08-02 "on the PC-side capsule window, the row for a
   *  message that wasn't injected should use a different background or style
   *  to set it apart" — this row's **injection result** (docs/rebuild/15 §2.5c-2).
   *
   *  ⚠️ This **is not a new field, nor a new fact**: `WireHistoryItem.status` has
   *  ALWAYS been there
   *  (lib/types.ts) — [[toRecentLine]] simply never read it ⇒ every row on the
   *  strip never knew whether it had been injected or not. Same shape as book 15
   *  §1.4's line "`pc_online` was always right there on the ack, and the phone
   *  dropped it on the floor".
   *
   *  null = this frame didn't say (or said a value this machine doesn't recognize) ⇒ the view
   *  **wears no style at all**, never guesses. Same rule as `mode`: a field that
   *  is not in the literal is never seen by the caller — guessing one is
   *  fabricating data. */
  status: RecentStatus | null;
}

/** The four delivery truths a row can carry (protocol `HistoryStatus`). Narrowed
 *  here rather than imported so an unknown wire value degrades to null instead of
 *  widening the union (same rule as [[KNOWN_MODES]]). */
export type RecentStatus = 'injected' | 'cached' | 'failed' | 'noted';

const KNOWN_MODES = new Set(['realtime', 'translate', 'organize']);
const KNOWN_STATUSES = new Set<string>(['injected', 'cached', 'failed', 'noted']);

/** 'HH:mm' hand-built so the fixed zh-CN surface never picks up an OS locale
 *  (red line: UI does not follow OS locale). Absent/unparseable → null, and the cell vanishes. */
function hhmm(iso: unknown): string | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Narrow one wire history row to a RecentLine, or null when it has no usable
 *  id (same first rule as the timeline's mapItem — an unidentifiable row cannot
 *  be rendered honestly). */
export function toRecentLine(item: WireHistoryItem): RecentLine | null {
  if (item === null || typeof item !== 'object') return null;
  const id = typeof item.id === 'string' ? item.id : '';
  if (id === '') return null;
  // 🔴 REQ-12-13 — a remote key press does not belong on the "delivered-in record" (转入记录) strip, and
  // dropping it here is the honest half of that. The strip answers "what was the
  // utterance that just came in"; a keypress is not an utterance (话), its `output_text` is `''` (the face is composed
  // by the timeline from `control_kind`), and [[RecentLine]] has no field for one.
  // Rendering it would put a blank line under the capsule, which reads as "there
  // is a message, and it is empty" — a claim about a transcript that does not exist.
  // ⚠️ Dropped rather than blanked: the row IS on the PC timeline (contract book 15
  // §2.0-e), so nothing is being hidden — it is being shown in the one place that
  // can say what it is.
  if (item.entry_type === 'control') return null;
  const rawMode = typeof item.mode === 'string' ? item.mode : '';
  const rawCreated = typeof item.created_at === 'string' ? item.created_at : '';
  return {
    id,
    mode: (KNOWN_MODES.has(rawMode) ? rawMode : null) as RecentLine['mode'],
    text: typeof item.output_text === 'string' ? item.output_text : '',
    source: typeof item.source_text === 'string' && item.source_text !== '' ? item.source_text : null,
    mobileId: typeof item.mobile_id === 'string' && item.mobile_id !== '' ? item.mobile_id : null,
    deviceLabel: typeof item.device_label === 'string' && item.device_label !== '' ? item.device_label : null,
    time: hhmm(item.created_at),
    created: Date.parse(rawCreated),
    entryType: item.entry_type === 'image' ? 'image' : 'transcript',
    thumb: typeof item.thumb_b64 === 'string' && item.thumb_b64 !== '' ? item.thumb_b64 : null,
    // 卡 L7 — see [[RecentLine.status]]. An unknown/absent value stays null and the
    // view draws the baseline style; it is never guessed into 'injected'.
    status: (typeof item.status === 'string' && KNOWN_STATUSES.has(item.status)
      ? item.status
      : null) as RecentStatus | null,
  };
}

/** Upsert by id: an existing line is REPLACED IN PLACE (the second-pass refine /
 *  peer edit keeps its slot), a new id prepends. Capped — the strip is a HUD,
 *  not a list.
 *
 *  🔴 卡 L7 — **this IS the answer to "two frames out of order" — no new
 *  mechanism needed** (book 15 §2.5c-2 ②): the row and its injection verdict are
 *  two frames, arriving in no fixed order; when the verdict arrives late,
 *  `row_transit` mints another row with the same id, and this replaces it in
 *  place — [[RecentLine.status]] changes along with it. **No new table may be
 *  built for this.** */
export function upsertRecentLine(list: RecentLine[], line: RecentLine, cap = 5): RecentLine[] {
  const i = list.findIndex((r) => r.id === line.id);
  if (i >= 0) {
    const next = [...list];
    next[i] = line;
    return next;
  }
  return [line, ...list].slice(0, cap);
}

// `mergeRecentSeed` (the history:list-result seed merge) was DELETED in 0.2.27 together
// with the pull it merged. The strip used to ask the server for the newest five rows on
// mount; the server stores no transcripts (owner architecture ruling), so that request could only
// ever come back empty — and an empty answer merged into an empty strip looks exactly
// like a working seed. There is nothing to replace it with here: the rows live on the
// PC now, and the capsule window does not own them (see the note at onHistoryItem).
