// WP-R2-2 frontend shared types. The wire item shapes come straight from
// @flowmic/protocol so the desktop and server never disagree on a field name.

import type { HistoryStatus, Mode } from '@flowmic/protocol';

/** The two delivery channels, as the stable machine tags Rust's `Channel::tag()`
 *  puts on the wire-adjacent IPC boundary ('lan' | 'cloud').
 *
 *  Declared HERE rather than imported from lib/channel.ts (which re-exports it as
 *  `ChannelId`, its historical name) because channel.ts imports lib/strings and the
 *  locale shard imports THIS file — a `types → channel` import would close an
 *  import cycle (lint 6/9 `circular`). One declaration, one direction. */
export type ChannelTag = 'lan' | 'cloud';

/** 🔴 ③evidence — WHAT STAGE 1b READ, and nothing else (owner 2026-08-07 甲-3;
 *  docs/strategy/2026-08-07-inject-status-truth-and-evidence-design.md §4-1).
 *
 *  `editable`     — the focus was observed to accept input;
 *  `not_editable` — it was observed NOT to;
 *  `unknown`      — 🔴 WE ASKED AND COULD NOT TELL.
 *
 *  ABSENCE IS A FOURTH THING AND IS NOT `unknown` (§A-4). A missing value means
 *  "we didn't ask" (the probe never ran: a deferred delivery, an admission refusal, an
 *  RV-83 disk replay, or a focus-lost that never reached stage 1b), and the two
 *  must not collapse — that is the same distinction IJ-03 §2.2-3 draws between
 *  "we didn't get to ask" and "there genuinely is none". Both nonetheless render the
 *  WEAK word, because neither of them confirms anything (lib/status.ts). */
export type FocusEvidence = 'editable' | 'not_editable' | 'unknown';

/** A timeline row as the PC main window renders it. THIS PC owns it (owner's
 *  2026-07-31 architecture ruling): the fields came in over the room-sync history:* items
 *  (TranscriptHistoryItem shape) plus the live inject_target reconciled from
 *  inject:result, and since 0.2.27 nothing anywhere else holds a copy. */
export interface TimelineRow {
  id: string;
  mode: Mode;
  status: HistoryStatus;
  edited: boolean;
  source_text: string | null;
  output_text: string;
  created_at: string;
  updated_at: string;
  /** WHAT THIS ROW IS. `'control'` (REQ-12-13, 2026-08-12) is a remote key press
   *  this PC executed — contract docs/rebuild/15 §2.0-e.
   *
   *  🔴 `'control'` IS PC-LOCAL AND NEVER ARRIVES OVER THE WIRE. The protocol's
   *  `EntryTypeSchema` still has exactly two values on purpose: if a frame could
   *  claim `entry_type:'control'`, a phone could send an `inject:request` carrying
   *  text to type while calling itself a keypress row. The author of a control row
   *  can only be the end that executed the keypress (`socket::control_row`).
   *
   *  🔴 EVERY PREDICATE THAT ACTS ON A ROW MUST NAME `'transcript'` POSITIVELY.
   *  The `!== 'image'` shape that guarded Re-inject/Edit fails OPEN on a third value,
   *  and re-injecting a control row would type its label into the user's document. */
  entry_type: 'transcript' | 'image' | 'control';
  /** REQ-12-13 — WHICH remote key this row records (`clear` / `backspace` / `undo`
   *  / `enter`, or the two whitelisted chords no button surfaces). null on every
   *  other row. The row's FACE is composed from this at render time, deliberately:
   *  a sentence baked in at mint time would be frozen in the language the row
   *  happened to be created in, and it would give the re-injection path text to
   *  find. */
  control_kind: string | null;
  /** REQ-12-13 — what THIS MACHINE did with that key: `sent` / `no_target` /
   *  `foreground_refused` / `os_refused` / `send_failed` / `not_primary`
   *  (`socket::control_row::ControlOutcome`). A CODE, not a sentence — same reason
   *  as above. null on every other row. */
  control_outcome: string | null;
  /** owner 2026-07-27: the bounded inline thumbnail (base64, no data: prefix) a
   *  picture row now carries. null when unknown — a transcript, a pre-thumbnail
   *  row, or a picture whose preview could not be produced. The view falls back
   *  to the descriptor line rather than drawing a broken frame. */
  thumb_b64: string | null;
  /** RV-93 (owner 2026-08-01 "when you open it, what shows should also be the actual
   *  delivered picture that works"): whether the
   *  DELIVERED picture — the same bytes that were typed into the focused window —
   *  was kept on disk for this row.
   *
   *  🔴 A BOOLEAN, NOT THE BYTES, and that is structural rather than tidy: these
   *  rows are persisted whole into localStorage under a 1.5 M character budget for
   *  ALL of them (timeline-retention.ts), while one `image_b64` may be 5.5 M. The
   *  picture lives beside the forensic log and is fetched only when the user opens
   *  it (`TimelineTransport.rowImage`).
   *
   *  It is the WRITE's own verdict, stamped by `socket::row_image::store` — never
   *  an intention. `false` on a row whose picture could not be kept, and the zoom
   *  then shows the 256 px thumbnail: a smaller picture, not a broken one. */
  full_image: boolean;
  /** Injection provenance — the foreground window the text landed in, when known
   *  (from a live inject:result / a v2 timeline row). null when unknown.
   *  `injected_at` is optional: older cache rows may lack it; the tooltip only
   *  appears when it is present (never fabricated). */
  target: { window_title: string; process_name: string; injected_at?: string | null } | null;
  /** owner 2026-07-27: "the PC side needs the phone-instance-name → target
   *  mapping". The pairing this row came
   *  from. The NAME is resolved at render time from the PC's own paired-mobile
   *  list — a renamed phone should read correctly on old rows, and duplicating
   *  the name into every row would be a second source of truth. null on a row
   *  the server could not attribute (and on every pre-0.1.11 cached row). */
  mobile_id: string | null;
  /** card P/D — the phone's OWN label, as the delivery frame carried it
   *  (`inject:request.device_label`).
   *
   *  WHY IT IS NOT `mobile_id`. Both answer "which phone said it", and that is exactly why
   *  they must not be one field: `mobile_id` is a PAIRING ID resolved live against
   *  this PC's paired-mobile list (so a renamed phone reads correctly on old rows),
   *  while this is a STRING the sender stamped at delivery time and nothing can
   *  re-resolve. Collapsing them would put a raw id where a name is rendered the
   *  first time a lookup missed.
   *
   *  A row minted from a delivery frame can only ever have THIS one: the relay
   *  forwards `parsed.data` verbatim (server-core relay.handler.ts) and
   *  `InjectRequestSchema` has no `mobile_id`. A row that came from the retired
   *  history broadcast has only the other. So they are never both present, and
   *  `senderLabel` (main-window/TimelinePage.vue) prefers the resolvable one.
   *  null = this row cannot say which phone sent it — the chip is then omitted,
   *  never filled with a placeholder. */
  device_label: string | null;
  /** 0.2.43 (owner "voice duration needs to come back") — how long the utterance took
   *  to SAY, ms. The phone's engine-reported number, carried by the delivery frame
   *  (`inject:request.duration_ms`, additive optional) and by nothing else.
   *  OPTIONAL and null-meaning-absent on purpose: every row cached before 0.2.43,
   *  every typed/manual/image row, and every frame that crossed a pre-0.2.43
   *  relay has none — and "none" must never be rendered or summed as 0
   *  (book 16 §6.1). Read through `rowDurationMs` (entry-metrics.ts), never raw. */
  duration_ms?: number | null;
  /** 🔴 owner 2026-08-02 (F1a) / docs/rebuild/15 §2.5e-4 — WHICH of `cached`'s three
   *  causes this row hit, as the ERROR CODE off the verdict.
   *
   *  WHY A CODE AND NOT THE SENTENCE. The sentence is per-locale and this row outlives
   *  every language switch; storing the words would freeze the language the row was
   *  delivered in (the same bug class `status.ts`'s getter labels exist to avoid).
   *  Resolved at render time through `INJECT_FAIL_REASON`, which is the ONE definition
   *  both PC surfaces read (book 15 §2.5c).
   *
   *  CLIENT-LOCAL and PC-ONLY, like `target`: reconciled from `inject:result.error`
   *  and never part of the row shape any server ever sent. null = "this row needs
   *  nothing more said about it" — an injected row, a `failed` row, or a `cached` row
   *  whose cause is `INJECT_FOCUS_LOST`, for which "not injected · buffered" plus "no
   *  input focus was found" is one sentence said twice (card L7's reasoning, unchanged).
   *
   *  ⚠️ CORRECTED 2026-08-07 (IJ-02 §C-4-2). The `failed` clause above used to read
   *  "a failed row (**whose face already names the failure**)", and that parenthetical
   *  died the moment owner deleted the word "injection failed": the ✗ face now says
   *  the neutral "not injected" and names nothing. The BEHAVIOUR is unchanged and that
   *  is deliberate: this field is still written for `cached` only.
   *  🔴 THE CONSEQUENCE IS AN OPEN GAP, NOT A CLOSED DECISION — the wording spec
   *  (§C-2) provides for "✗ not injected · <named reason>" on a failed row, and no
   *  code is stored on one, so that branch has no data source and the render degrades
   *  to the spec's own stated fallback "✗ not injected". Left open and reported
   *  rather than closed here, because making it reachable changes what a PERSISTED
   *  field carries.
   *
   *  🔴 CLOSED 2026-08-19. `onInjectResult` now stores the verdict code on BOTH
   *  not-injected statuses, so "written for `cached` only" above stopped being true
   *  on that date (original text kept as the record of when the gap was open). The
   *  §C-2 failed branch has its data source: TimelinePage resolves the code through
   *  the same INJECT_FAIL_REASON table and statusLine renders 「✗ 未注入 · <具名原因>」
   *  inline (book 15 §2.5's `failed` row). The null meaning tightens accordingly:
   *  null = an injected row, a row cached/failed before this build, or a cause the
   *  reason table cannot name — never "failed rows don't carry causes". Persisted
   *  rows are unaffected in the old direction: a failed row written by an older
   *  build simply has no cause, which renders as the bare fallback it always did. */
  cached_cause?: string | null;
  /** 🔴 owner 2026-08-07 ruling (c) — WHICH PROCESS this row's injection was AIMED AT,
   *  whatever the outcome (`chrome.exe` / `Cursor.exe`). null = not known.
   *
   *  🔴 THE PROCESS NAME, NEVER THE WINDOW TITLE — that IS the ruling. The wire's
   *  `focus_window` does carry a title (this-time display; the capsule flash reads it
   *  and nothing keeps it), but book 04 §3.5 F-3113 holds that a focus mirror lands in no
   *  table because window titles are sensitive, and widening the durable record to the
   *  failure path would have widened that. owner: "I think it should be fine for the
   *  window title not to be persisted to the DB" — the half that helps is the app,
   *  not the title.
   *  ⚠️ `target.window_title` on an `ok:true` row is UNTOUCHED by this: that is
   *  pre-existing success-path behaviour and the ruling governs only the newly-widened
   *  failure/cached path (design doc §4-5 implementation boundary 2).
   *
   *  It answers "which foreground window we observed during this attempt", NOT "where
   *  the text actually landed" — the second question is still `target`'s alone, and
   *  still only on success. */
  focus_process?: string | null;
  /** 🔴 ③evidence for this row, as Stage 1b read it. See [[FocusEvidence]]: absent / null
   *  means the probe never ran, which is NOT `'unknown'` and must never be normalised
   *  into it. Drives the "injected" / "input sent" split in lib/status.ts.
   *
   *  🔴 UPDATED BY IJ-05 (2026-08-08). This used to read "MSAA is NOT wired … every
   *  third-party app reads `unknown`". MSAA IS now wired (`inject::msaa_focus`), so a
   *  third-party window CAN reach `editable` when MSAA positively identifies an
   *  enabled, writable text element holding focus.
   *
   *  ⚠️ Two things that did NOT change, because "wired" is not "universal":
   *   · apps whose accessibility tree answers with the window shell — measured for
   *     360极速浏览器X (360 Extreme Browser X) and 微信 (WeChat) — still read `unknown`,
   *     deliberately and forever. MSAA is positive-only: it can never produce
   *     `not_editable` and can never refuse.
   *   · [unverified] HOW MANY apps land in the strong bucket for an ordinary user. The
   *     Medium-integrity configuration has never been measured (IJ-03b). Do not write
   *     a percentage here without one. */
  focus_evidence?: FocusEvidence | null;
  /** RV-01 — WHICH SERVER this row lives on.
   *
   *  The desktop keeps both channels resident (07 §6) and they are two servers with
   *  two `transcript_history` tables, so `(channel, id)` is the row's only address.
   *  Every edit / delete / deferred delivery travels THIS channel — never `primary`, which
   *  answers "which channel is carrying the runtime" and was the wrong answer being read (a cloud key
   *  expiring at day 7 was enough to send every LAN row's delete to the relay).
   *
   *  CLIENT-LOCAL, never a wire field: stamped by the Rust bridge onto the frame
   *  that carried the row (`socket::bridge::tag_channel`), because only this machine
   *  knows which of its two sockets received it.
   *
   *  0.2.27 — no verb travels to a server any more, so this is no longer a ROUTE. It
   *  is still the other half of the row's ADDRESS: both channels' rows live in one
   *  list, and `inject:result` and the page's own `:key` both need `(channel, id)`. */
  channel: ChannelTag;
  // `pending` ("saved locally" — a local edit/delete still queued for the server) was
  // REMOVED in 0.2.27 with the queue and the uplink it fed. There is no server copy to
  // be out of step with, so the flag could never be true again and the chip would have
  // been a sentence about an impossible state — the text-layer face of a façade
  // (W2 rule: leaving behind copy that can never render).
}

/** The raw row shape arriving on the `flowmic://history-updated` bridge channel.
 *
 *  It used to be "a subset of TranscriptHistoryItem — the fields the PC timeline
 *  consumes", i.e. the server's broadcast row. That producer is gone (the server
 *  stores no transcripts), and since 0.2.28+ the SOLE producer is this machine's own
 *  `socket::row_transit`, which mints one of these from the `inject:request` that
 *  delivered the message plus the truthful verdict of typing it. The shape is
 *  unchanged so the frontend's single "inbound row → timeline row" implementation
 *  still applies — see lib/timeline-store.ts `onHistoryUpdated`. */
export interface WireHistoryItem {
  id: string;
  mode: Mode;
  status: HistoryStatus;
  edited?: boolean;
  source_text: string | null;
  output_text: string;
  created_at: string;
  updated_at: string;
  /** `'control'` is CLIENT-LOCAL like `full_image` below — `socket::control_row`
   *  stamps it on a row it minted itself. It is not a wire value and the protocol's
   *  `EntryTypeSchema` deliberately does not know it (see TimelineRow.entry_type). */
  entry_type?: 'transcript' | 'image' | 'control';
  /** REQ-12-13 — CLIENT-LOCAL, present only on a `'control'` row. */
  control_kind?: string;
  /** REQ-12-13 — CLIENT-LOCAL, present only on a `'control'` row. */
  control_outcome?: string;
  thumb_b64?: string;
  /** RV-93 — CLIENT-LOCAL, never a wire field. Stamped by `socket::row_transit`
   *  when it succeeded in keeping this row's delivered picture; OMITTED otherwise,
   *  never `false`, for the same reason `thumb_b64` is omitted rather than empty:
   *  the frontend narrows on presence and a written-out `false` would be a claim
   *  made by a producer that has nothing to say (a pre-RV-93 build says nothing at
   *  all, and must read the same as "wasn't saved"). */
  full_image?: boolean;
  /** HistoryItemSchema has always carried this; the PC simply never read it. Never
   *  present on a row minted from a delivery frame — see TimelineRow.device_label. */
  mobile_id?: string | null;
  /** card P/D — `inject:request.device_label`, the only sender identity a minted row
   *  can carry. Absent from every row the retired history broadcast produced. */
  device_label?: string;
  /** 0.2.43 — the frame's engine-reported speaking duration, ms. See
   *  TimelineRow.duration_ms for the absence rules. */
  duration_ms?: number | null;
}

/** inject:result payload (A-58) forwarded from the Rust bridge. */
export interface InjectResult {
  ok: boolean;
  mode: 'sendinput' | 'clipboard' | 'cached';
  error?: string;
  target_window?: string;
  inject_target?: { window_title: string; process_name: string; injected_at: string };
  /** 🔴 IJ-01 §A-1 — THE FOREGROUND WINDOW WE OBSERVED ON THIS ATTEMPT, success or
   *  not. Additive optional, produced by `wire::build_inject_result`.
   *
   *  IT IS NOT `inject_target` WIDENED, and the two must never be merged: that one
   *  answers "where the text actually landed" and is still emitted on `ok:true` only,
   *  and it carries an `injected_at` — "a result that didn't inject carrying an
   *  injection timestamp is a lie" (design doc §4-3). This one answers "which window
   *  the attempt was aimed at".
   *
   *  ABSENT on the three branches that observed nothing (§A-1): an admission refusal
   *  (`INJECT_NOT_PRIMARY`), an RV-83 disk replay, and any path that never resolved a
   *  target. 🔴 Absence is the honest value there — "never re-claim a place it never
   *  observed" — so a consumer must render nothing, never a placeholder.
   *
   *  `window_title` may be the empty string (a titleless window); `process_name` is
   *  non-empty whenever the key is present at all (§A-3). 🔴 ONLY `process_name` may
   *  reach a persisted row — see TimelineRow.focus_process. */
  focus_window?: { window_title: string; process_name: string };
  /** 🔴 IJ-01 §A-4 — Stage 1b's already-computed reading, carried rather than
   *  recomputed. See [[FocusEvidence]]; ABSENT ≠ `'unknown'` (§A-4: absent = we didn't
   *  ask, `unknown` = we asked and got no answer), so a consumer must not default it
   *  to a string. */
  focus_evidence?: FocusEvidence;
  request_id?: string;
  entry_id?: string;
  /** R6 T-4, BRIDGE-LOCAL — never a wire field. `'image'` when the frame this
   *  result answers was an image inject. `entry_type` is not part of the frozen
   *  history wire shape (HistoryItemSchema has no such key), so this PC's own
   *  knowledge of what it just pasted is the only honest source for the
   *  timeline's image chip. Attached by socket/client.rs to the forwarded copy
   *  only; the frame emitted back on the socket stays exactly
   *  InjectResultSchema. */
  entry_kind?: 'image';
  /** RV-72, CLIENT-LOCAL — never a wire field. WHICH ROW this verdict belongs to.
   *
   *  `entry_id` cannot answer it any more, and that is the whole point of the ruling
   *  (owner 2026-07-31 ② "one re-delivery = one new row on the PC"): a re-delivery keeps the phone's
   *  `entry_id` and mints a new `request_id`, so a row is addressed by the DELIVERY,
   *  and `entry_id` went back to being a pure correlation echo (A-58).
   *
   *  It is HANDED OVER rather than re-derived here. The rule that turns a frame into a
   *  row address lives in exactly one place — `socket::row_transit::row_id` — and one
   *  of its branches (a frame with neither id) is not reproducible at all. Recomputing
   *  it in TypeScript would be the same rule implemented twice, free to drift.
   *
   *  Two writers, one meaning: socket/client.rs stamps the forwarded copy via
   *  `row_transit::forward_verdict` for a delivery the PHONE asked for; for a LOCAL
   *  deferred delivery the store stamps the address of the row the user clicked.
   *  Absent ⇒ the store updates nothing and the caller records it — never a guess (RV-01). */
  row_id?: string;
  /** owner 2026-07-30 ①, CLIENT-LOCAL — never a wire field. The row ADDRESS half that
   *  `row_id` alone cannot supply, because the timeline holds both servers' rows.
   *
   *  Two writers, one meaning: for a delivery the PHONE asked for, socket/client.rs
   *  stamps the forwarded copy with the socket that carried the frame (the same stamp
   *  `bridge::tag_channel` puts on the history frames); for a LOCAL deferred delivery
   *  the store stamps the channel it already holds on the row (0.2.27 — the Rust command routes
   *  nowhere, so it has nothing to say about this). Absent ⇒ the store updates no row
   *  rather than guessing (RV-01). */
  channel?: string;
}

/** CONNECTION bridge payload (07 §9 refresh / reconnect-flush trigger). */
export interface ConnectionState {
  connected: boolean;
  registered: boolean;
  room_uuid: string | null;
  mobiles: number;
  reason: string;
  /** GA-28: which resident channel this snapshot describes ('lan' | 'cloud').
   *  Absent on frames from a pre-GA-28 shell — treated as the primary's. */
  channel?: string;
  /** GA-28: whether that channel is the one carrying the runtime right now. */
  primary?: boolean;
}

// ── transports (injected so the stores are testable without Tauri) ──

/** One server-authoritative settings row from a settings:list snapshot.
 *
 *  ⚠️ MOVED HERE FROM bridge.ts (card C3) rather than grown in place: that file
 *  sits one line under the 800-line cap and two cards were widening it in the
 *  same round. Nothing else changed — this is the same shape, with the wire's
 *  optional stamp added. */
export interface ServerSettingItem {
  key: string;
  value: unknown;
  /** 04 §3.7-a — when the WRITER last changed this value. Absent means UNKNOWN
   *  (an older relay strips the field; a synthesized row never had one), and
   *  unknown must never be read as epoch — see `ABSENCE MEANS UNKNOWN, NEVER
   *  EPOCH` in protocol-schemas-sync.ts. */
  updated_at?: string;
}

export interface SettingsTransport {
  /** Fire a settings:update through the Rust socket. Resolves to whether the
   *  frame reached the wire (false → hold pending, re-flush on reconnect).
   *
   *  `updatedAt` (card C3) is WHEN THE USER MADE THIS EDIT, ISO-8601 UTC — not
   *  when the queue drained, and not when the server received it. It is what
   *  lets the server's regress guard refuse a stale replay from this machine
   *  (the `existingMs > incomingMs` guard in settings.handler.ts); without it
   *  the desktop can never LOSE an
   *  arbitration, so a day-old offline edit replayed on reconnect still
   *  overwrites a card edited on the phone five minutes ago. Optional because
   *  absence must keep meaning UNKNOWN: a caller that does not know the edit
   *  time omits it and gets exactly the pre-stamp behaviour.
   *
   *  The whole path is live: bridge.ts hands it to the `settings_update` command
   *  as `stamp`, `SocketOut::emit_settings_update` passes it on, and
   *  `wire::build_settings_update` puts `updated_at` on the frame — omitting the
   *  key entirely when it is `None`, because absent means UNKNOWN and an explicit
   *  `null` would fail `Iso8601.optional()` at the server's zod boundary, where a
   *  refusal is anonymous. Pinned by `socket::wire::wire_tests`
   *  (`settings_update_carries_the_edit_moment_when_the_frontend_knows_it`,
   *  `settings_update_omits_the_key_entirely_when_the_moment_is_unknown`).
   *
   *  ⚠️ ONE settings write is deliberately never stamped: `device.pc_name`. The
   *  server's G2 arbitration stops at that branch (settings.handler.ts — no KV
   *  row, no column, one writer, nothing to race) so `build_pc_name_update`
   *  passes `None`, pinned from both ends by `pc_name_update_carries_no_stamp`
   *  here and `test/pc-rename.test.ts` there.
   *
   *  ⚠️ The IPC argument is named `stamp`, not `updatedAt`: this file's header
   *  says the boundary uses single-word argument names precisely to keep
   *  camelCase↔snake_case off the table. The WIRE field is still `updated_at`
   *  — the two names answer to different layers. */
  settingsUpdate(key: string, value: unknown, updatedAt?: string): Promise<boolean>;
}

/** The timeline's ONE remaining native call (0.2.27).
 *
 *  It used to have four — `historyList` / `historyUpdate` / `historyDelete` /
 *  `historyInject`, each a wire verb addressed to the server that owned the row. All
 *  four are gone with the server's transcript store (owner's architecture ruling,
 *  docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md): the pull would answer
 *  nothing forever, the two writes had no mirror left to write to (and would have
 *  drawn a red "the server hasn't confirmed" line on every edit and delete, plus an
 *  op that re-queued itself on every reconnect), and deferred delivery stopped needing
 *  a server the moment the PC owned the text. Editing and deleting are now writes to
 *  this machine's own store and need no transport at all. */
export interface TimelineTransport {
  /** Deferred delivery — inject `text` into THIS machine's focused window, right now.
   *
   *  Runs the Rust `timeline_reinject` command, i.e. the SAME `run_inject` pipeline an
   *  inbound `inject:request` runs, on the same focus FSM and dedup table — so
   *  `injected` keeps exactly one meaning across both delivery paths (the RV-45
   *  ruling's hard constraint). `entryId` rides along as the A-58 correlation echo so
   *  the returned verdict can be put on the right row.
   *
   *  Resolves to the truthful `inject:result` payload, or `null` when NOTHING WAS
   *  TYPED — which the caller must state rather than treat as a success. Note what
   *  `null` is NOT: an `ok:false` result is a real answer ("tried, but it didn't
   *  land") and comes back as a value; `null` means the attempt never happened at all. */
  reInjectLocally(text: string, entryId: string): Promise<InjectResult | null>;

  /** RV-93 — this row's DELIVERED picture as a `data:` URL, fetched on demand when
   *  the user opens one (the row itself carries only the 256 px thumbnail).
   *
   *  `null` is a NORMAL answer — a transcript row, a row from before this feature,
   *  or one whose picture could not be kept — and the caller falls back to the
   *  thumbnail. It must never be surfaced as a failure. */
  rowImage(id: string): Promise<string | null>;

  /** RV-93 — the pictures of rows this store has just REMOVED.
   *
   *  🔴 Called from the ONE DELETER (lib/timeline-purge.ts) and nowhere else, so
   *  "when the row goes, its bytes go with it" has exactly one implementation.
   *
   *  ⚠️ Correction (C2, 0.2.39): this used to read "called from the eviction path and
   *  nowhere else", and that sentence was TRUE and was the bug — anti-façade rule ④, a
   *  comment defending a design is a greppable claim, and this one defended a design
   *  in which the user's own delete was the other path and did NOT call it (book 15
   *  G-21: a manually deleted image row left its file on disk forever). All three
   *  triggers go through the deleter now.
   *
   *  It is deliberately NOT a Rust-side sweep: a second bound over there would drift
   *  from this store's (rows AND characters, whichever binds first) and produce a row
   *  on screen whose picture is gone. */
  dropRowImages(ids: readonly string[]): void;
}

/** A tiny persistence seam (localStorage in the app, in-memory in tests). */
export interface KvStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** A [[KvStore]] whose writes SAY WHETHER THEY LANDED.
 *
 *  Why this exists (owner 2026-07-31: the PC timeline is now the OWNER of its rows,
 *  not a cache of the server's): `localKv.set` swallows storage exceptions, which was
 *  the right call for a cache — a dropped cache write costs a refresh. For an owner
 *  it is the storage face of this repo's No.1 bug shape: localStorage runs out of
 *  quota, `setItem` throws, the `catch {}` eats it, the in-memory store carries on
 *  looking perfectly healthy, and every row since the last successful write is gone
 *  at the next restart. "The user thinks their whole history is there" — and nothing
 *  anywhere had said otherwise.
 *
 *  It is a SEPARATE interface rather than a change to `KvStore.set` because a
 *  boolean-returning function is assignable to a void-returning one in TypeScript:
 *  `localKv` can satisfy both, so the settings client / theme / locale / capsule
 *  position keep the seam they have and only the store that needs the answer asks
 *  for it. */
export interface ReportingKvStore extends Omit<KvStore, 'set'> {
  /** `true` = the value is in the store. `false` = it is NOT, and the caller must
   *  say so rather than assume. */
  set(key: string, value: string): boolean;
}
