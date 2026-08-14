// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §1 (three modes / five states — the runtime whitelists below)
//   packages/protocol/src/protocol-schemas-sync.ts (history:* payloads)
//
// FOREIGN DATA → TimelineRow, at the ONE boundary where it enters.
//
// Two inputs are equally untrusted and get the same treatment: the rows read back
// from local storage (written by whatever build ran last — see normalizeCachedRow for
// the blank-page defect that taught this) and the wire rows arriving over the Rust
// bridge as plain JSON. Split out of timeline-store.ts when that file hit the 800-line
// cap; it is a coherent unit on its own — nothing here knows about channels' sockets,
// the change queue or persistence, and everything here is a pure function.

import type { ChannelTag, FocusEvidence, TimelineRow, WireHistoryItem } from './types';

/** ③evidence's three values, as RUNTIME data — same reason KNOWN_MODES exists below: the
 *  union is a TYPE and types are erased, so a row read back from disk cannot be
 *  validated against it. 🔴 An unrecognised value becomes `null` (= "never probed"), never
 *  `'unknown'`: "we didn't ask" and "we asked and got no answer" are two different facts
 *  (types.ts [[FocusEvidence]]), and quietly upgrading one into the other invents a probe
 *  run that never happened. */
const KNOWN_FOCUS_EVIDENCE = new Set<string>(['editable', 'not_editable', 'unknown']);

/** The channel tags this build knows. Anything else is not a channel we can address,
 *  so it becomes `null` and the caller drops the frame/row rather than guessing —
 *  guessing is precisely RV-01. */
export function asChannelTag(raw: unknown): ChannelTag | null {
  return raw === 'lan' || raw === 'cloud' ? raw : null;
}

/** 🔴 IJ-01 / owner 2026-08-07 ruling (c) — A VERDICT'S FOCUS OBSERVATION, PROJECTED
 *  ONTO THE PART OF IT A PERSISTED ROW MAY HOLD. This is where the window title is
 *  dropped, and it lives here rather than at the call site for the reason this whole
 *  module exists: it is the boundary where foreign data becomes a TimelineRow.
 *
 *  🔴 THE TITLE IS DROPPED, NOT FORGOTTEN. The wire's `focus_window` carries one, and
 *  it is genuinely wanted — for THIS-TIME display, on the capsule flash, which keeps
 *  nothing. What must not happen is the title reaching a row, because `onInjectResult`
 *  persists rows and book 04 §3.5 F-3113 holds that a focus mirror lands in no table
 *  (window title is sensitive). owner: "I think it should be fine for the window
 *  title not to be persisted to the DB" — adopting (c): persist only the process name.
 *  ⚠️ This says nothing about `inject_target.window_title` on an `ok:true` row: that
 *  is pre-existing success-path behaviour and the ruling governs only the newly-widened
 *  failure/cached path (design doc §4-5 implementation boundary 2).
 *
 *  🔴 A KEY IS OMITTED, NOT SET TO null, WHEN THE VERDICT SAYS NOTHING — so
 *  `Object.assign`-ing the result onto a row cannot ERASE what an earlier verdict on
 *  that row observed. "This time nothing was observed" must never overwrite "last
 *  time what was observed was chrome".
 *  Same reason the display backfills in TimelineStore.onHistoryUpdated only go from
 *  absent to present.
 *
 *  🔴 `focus_evidence` is passed through EXACTLY, including `'unknown'`, and an absent
 *  key stays absent: "we asked and got no answer" and "we didn't ask" are two
 *  different facts (§A-4) and defaulting either way would invent one of them. */
export function focusProvenanceOf(result: {
  focus_window?: { window_title: string; process_name: string };
  focus_evidence?: FocusEvidence;
}): { focus_process?: string; focus_evidence?: FocusEvidence } {
  const out: { focus_process?: string; focus_evidence?: FocusEvidence } = {};
  const proc = (result.focus_window?.process_name ?? '').trim();
  // Non-empty only. §A-3 promises `process_name` is non-empty whenever the key is
  // present, but this input crosses the Rust bridge as plain JSON — an empty string
  // written onto the row would render an arrow pointing at nothing.
  if (proc.length > 0) out.focus_process = proc;
  if (result.focus_evidence !== undefined) out.focus_evidence = result.focus_evidence;
  return out;
}

/** Map an inbound wire row onto a TimelineRow, or null when it carries no usable
 *  id. The inbound frame crosses the Rust bridge as plain JSON, so it gets the
 *  SAME normalization as the persisted cache (see normalizeCachedRow) — otherwise
 *  one malformed row would be written straight into the cache and keep blanking
 *  the page on every subsequent boot.
 *
 *  `channel` comes from the ENVELOPE (the Rust bridge stamps the frame, not the
 *  item), because only this machine knows which of its two sockets received it. */
export function mapItem(
  item: WireHistoryItem,
  channel: ChannelTag,
  prev?: TimelineRow,
  isImage = false,
): TimelineRow | null {
  const base = normalizeCachedRow(item, channel);
  if (base === null) return null;
  return {
    ...base,
    // The server row can carry entry_type one day; until then this PC's own
    // record of what it pasted is the only source, so both are honoured.
    // REQ-12-13: `'control'` is stamped by `socket::control_row` on a row this PC
    // minted itself, so it is honoured the same way — and `isImage` (the caller's
    // guess from the inject path) can never override it, because a keypress row is
    // never produced by an image delivery.
    entry_type: item.entry_type === 'control'
      ? 'control'
      : (item.entry_type === 'image' || isImage ? 'image' : 'transcript'),
    // REQ-12-13 — same `prev` rule as every other display field below: a later
    // frame for a row this PC already holds must not be able to un-say which key it
    // recorded. In practice a control row is never re-sent (it has no producer on
    // the wire at all), so this is defence in depth, not a live path.
    control_kind: (typeof item.control_kind === 'string' && item.control_kind.length > 0
      ? item.control_kind
      : null) ?? prev?.control_kind ?? null,
    control_outcome: (typeof item.control_outcome === 'string' && item.control_outcome.length > 0
      ? item.control_outcome
      : null) ?? prev?.control_outcome ?? null,
    // owner 2026-07-27: the server row now carries the preview. `prev` keeps it
    // across a refresh for a row whose thumbnail this PC already has.
    thumb_b64: typeof item.thumb_b64 === 'string' && item.thumb_b64.length > 0
      ? item.thumb_b64
      : (prev?.thumb_b64 ?? null),
    // RV-93 — same `prev` rule as the thumbnail, and for the same reason: a later
    // frame for a row this PC already holds (an INJ-3 replay of one delivery) must
    // not be able to un-say "this row has a large picture" and leave the page offering nothing.
    // The picture is addressed by the row id, so it is still exactly where the
    // first frame put it.
    full_image: item.full_image === true || (prev?.full_image ?? false),
    // Provenance is PC-local knowledge reconciled from inject:result — a server
    // row never carries it, so the previously-known target survives a refresh.
    target: prev?.target ?? null,
    // book 15 §2.5e-4 — same rule and same reason as `target`: PC-local, written only
    // by `onInjectResult`, so an inbound row must carry the one this PC already knows
    // rather than blanking the explanation the user is looking at.
    cached_cause: prev?.cached_cause ?? null,
    // IJ-01 — same rule and same reason as `target` / `cached_cause`: both are written
    // ONLY by `onInjectResult`, so an inbound row (which never carries them) must hand
    // back the ones this PC already knows rather than blanking the answer on screen.
    focus_process: prev?.focus_process ?? null,
    focus_evidence: prev?.focus_evidence ?? null,
    // owner 2026-07-27: WHICH PHONE sent this. HistoryItemSchema has always
    // carried mobile_id; the PC simply never read it. `prev` keeps it across a
    // refresh in case a later frame omits it.
    mobile_id: typeof item.mobile_id === 'string' && item.mobile_id.length > 0
      ? item.mobile_id
      : (prev?.mobile_id ?? null),
    // card P/D: the phone's own label off the delivery frame — the ONLY sender
    // identity a minted row can have (the relay forwards the inject frame verbatim
    // and it carries no mobile_id). Same `prev` rule as above: a later frame that
    // omits it must not blank a row that already knew who sent it.
    device_label: typeof item.device_label === 'string' && item.device_label.length > 0
      ? item.device_label
      : (prev?.device_label ?? null),
    // 0.2.43 — same `prev` rule as the fields above: an INJ-3 replay that omits
    // the duration must not blank a row that already knew how long it took.
    duration_ms: base.duration_ms ?? prev?.duration_ms ?? null,
  };
}

/** The three locked modes / four delivery states, as RUNTIME values. The protocol
 *  exports them as literal-union TYPES only (types.ts), which are erased at
 *  runtime and therefore cannot validate data read back from disk. Kept in step
 *  with 05 §1 by the contract tests; there is no fourth mode (red line). */
const KNOWN_MODES = new Set<string>(['realtime', 'translate', 'organize']);
const KNOWN_STATUSES = new Set<string>(['injected', 'cached', 'failed', 'noted']);

function normalizeTarget(raw: unknown): TimelineRow['target'] {
  if (raw === null || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const window_title = typeof t.window_title === 'string' ? t.window_title : '';
  const process_name = typeof t.process_name === 'string' ? t.process_name : '';
  // A target that names neither a window nor a process describes nothing — null
  // is the honest value, and it keeps the provenance tooltip from claiming a
  // delivery destination it cannot name.
  if (window_title === '' && process_name === '') return null;
  return {
    window_title,
    process_name,
    ...(typeof t.injected_at === 'string' ? { injected_at: t.injected_at } : {}),
  };
}

/** owner 2026-07-27 (the PC timeline page going entirely blank — the systemic half of that fix).
 *
 *  The persisted rows outlive upgrades: they hold whatever shape the build that last
 *  wrote them used, and reading that back with `as TimelineRow[]` is a compile-time
 *  fiction the runtime never checks. The owner's PC held raw SERVER rows (pairing_id /
 *  source_lang / duration_ms …) with `status:'injected'` and NO `target` key — the
 *  missing key threw inside a template helper and blanked the whole page (see
 *  lib/inject-provenance.ts). So foreign data is normalized to the TimelineRow
 *  contract HERE, at the single boundary where it enters. A row with no usable id is
 *  dropped (it could never be addressed); everything else degrades field by field,
 *  and an unrecognised mode/status falls back rather than leaking a fourth mode.
 *
 *  RV-01: `channel` is the SECOND thing that makes a row addressable, so it is
 *  narrowed the same way. Pass it when the caller knows it (an inbound frame is
 *  stamped by the bridge); omit it to read the row's own stamp, in which case an
 *  untagged row — every row written by a pre-RV-01 build — is dropped, because a row
 *  whose server is unknown is a row no verb may act on. */
export function normalizeCachedRow(raw: unknown, channel?: ChannelTag): TimelineRow | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id === '') return null;
  const tag = channel ?? asChannelTag(r.channel);
  if (tag === null) return null;
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
  const created_at = str(r.created_at);
  return {
    id: r.id,
    mode: (KNOWN_MODES.has(str(r.mode)) ? r.mode : 'realtime') as TimelineRow['mode'],
    status: (KNOWN_STATUSES.has(str(r.status)) ? r.status : 'cached') as TimelineRow['status'],
    edited: r.edited === true,
    source_text: typeof r.source_text === 'string' ? r.source_text : null,
    output_text: str(r.output_text),
    created_at,
    updated_at: str(r.updated_at, created_at),
    // 🔴 REQ-12-13 — `'control'` MUST BE LISTED HERE, and the reason is a real
    // failure this narrowing would otherwise cause SILENTLY: rows are persisted
    // whole and read back through this function, so a two-way ternary rewrites a
    // keypress row into a `transcript` on the next launch — and then re-persists it
    // that way, making the loss permanent after one boot. It would also hand that
    // row the "Re-inject" button, which types the key's label into the user's document.
    // Anything still unrecognised falls back to `transcript` exactly as before.
    entry_type: r.entry_type === 'image' || r.entry_type === 'control'
      ? r.entry_type
      : 'transcript',
    // REQ-12-13. Narrowed like every other field read back from disk, and NOT
    // cross-checked against `entry_type`: two fields that must agree, reconciled by
    // a rule invented here, would be a second answer to "what kind of row this is". The producer
    // (`socket::control_row`) writes both together or neither.
    control_kind: typeof r.control_kind === 'string' && r.control_kind.length > 0
      ? r.control_kind
      : null,
    control_outcome: typeof r.control_outcome === 'string' && r.control_outcome.length > 0
      ? r.control_outcome
      : null,
    // Narrowed like every other field read back from disk: a cached row written
    // by an older build has no thumbnail, and `as` would invent one.
    thumb_b64: typeof r.thumb_b64 === 'string' && r.thumb_b64.length > 0 ? r.thumb_b64 : null,
    // RV-93. `=== true`, not a truthiness test: every row cached before this
    // feature has no such key, and "wasn't stated" must read as "wasn't saved" — the
    // zoom then shows the thumbnail, which is exactly what those rows have always shown.
    full_image: r.full_image === true,
    target: normalizeTarget(r.target),
    // Narrowed like the rest (RV-新A ⑤ — a hand-written narrowing that lies): every
    // row cached before 0.2.49 has no such key, and "wasn't stated" must read as
    // "there is no further cause worth mentioning", which is what the tooltip then omits.
    cached_cause: typeof r.cached_cause === 'string' && r.cached_cause.length > 0
      ? r.cached_cause
      : null,
    // IJ-01, narrowed like the rest. 🔴 owner 2026-08-07 ruling (c): this is the PROCESS
    // NAME and a persisted row may never hold the window title — so nothing here reads
    // a `window_title`, and a row written by some future build that tried to put one in
    // simply does not get it back. The narrowing is the enforcement point, not a comment.
    focus_process: typeof r.focus_process === 'string' && r.focus_process.length > 0
      ? r.focus_process
      : null,
    // Anything not one of the three known readings ⇒ null = "never probed". See
    // KNOWN_FOCUS_EVIDENCE above for why it must not fall back to 'unknown'.
    focus_evidence: typeof r.focus_evidence === 'string' && KNOWN_FOCUS_EVIDENCE.has(r.focus_evidence)
      ? (r.focus_evidence as FocusEvidence)
      : null,
    // Narrowed like the rest: a row cached by an older build has no mobile_id,
    // and `as` would invent one.
    mobile_id: typeof r.mobile_id === 'string' && r.mobile_id.length > 0 ? r.mobile_id : null,
    // Narrowed like the rest: every row cached before 0.2.28+ has no device_label,
    // and `as` would invent one (RV-新A ⑤ — a hand-written narrowing that lies).
    device_label: typeof r.device_label === 'string' && r.device_label.length > 0 ? r.device_label : null,
    // 0.2.43 — non-negative integers only; anything else (absent, a float, an old
    // build's junk) reads as null. "No duration" is a value, never a guess of 0.
    duration_ms: typeof r.duration_ms === 'number' && Number.isInteger(r.duration_ms) && r.duration_ms >= 0
      ? r.duration_ms
      : null,
    channel: tag,
    // A row cached by a 0.2.26 build may carry `pending: true`. It is DROPPED, not
    // read: the field meant "this machine changed it and it hasn't been uplinked yet"
    // and there is no uplink any more, so the
    // only honest thing to do with that bit is forget it. The row's CONTENT already
    // includes the edit (0.2.26 wrote optimistically before queueing) — see
    // TimelineStore.windDownRetiredQueue for why nothing is lost.
  };
}
