// WP-R2-2 main-window app state. Constructs the settings client + timeline store
// over the real Tauri bridge transports + a localStorage cache, wires the inbound
// bridge channels to the stores, and exposes Vue reactive views. The PRIMARY
// channel's connected rising edge refreshes the timeline (07 §9) and the LAN
// channel's own rising edge replays the settings queue (07 §8 — RV-16: the settings
// verbs are pinned to the LAN socket, so that is the socket their trigger watches);
// a rising mobile count is the pc:mobile-joined refresh trigger.
//
// ⚠️ 0.2.27 — THE TIMELINE HAS NO CONNECTION TRIGGERS ANY MORE, and that is not a
// simplification: it is the consequence of the server holding no transcripts (owner's
// architecture ruling, docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md). Three
// things that were wired here are gone:
//   · `timeline.refresh(...)` on each channel's connected rising edge and on
//     pc:mobile-joined — there is nothing to pull, and a pull that always returns
//     nothing is worse than no pull (it looks like an answer);
//   · `timeline.flushQueue(...)` on those same edges — the durable change queue is
//     retired with the uplink it fed (TimelineStore.windDownRetiredQueue);
//   · the `history:list-result` listener — no producer, no request.
// The SETTINGS queue and its LAN-edge flush are untouched: settings really do live on
// the server (owner ⑤ pins them to the LAN one), so "resend after reconnect" is still a
// promise this build keeps. Do not restore the timeline half by symmetry with it.
//
// owner 2026-07-30 ①: the timeline is never told "which server you are looking at
// right now." It shows every message delivered to THIS PC, over either channel, so
// the primary channel is not one of its inputs — which also means a phone joining on
// the other channel cannot blank the page.

import { computed, reactive, ref, watch } from 'vue';
import { SettingsClient } from '../lib/settings-client';
import {
  asChannelTag,
  TimelineStore,
  type RetentionFacts,
  type TimelineOpFailure,
} from '../lib/timeline-store';
import { CH, appendForensic, fetchConnectionSnapshot, fetchPairedMobiles, onChannel, settingsTransport, timelineTransport } from '../lib/bridge';
import { localKv } from '../lib/storage';
import type { ChannelTag, ConnectionState, InjectResult, TimelineRow, WireHistoryItem } from '../lib/types';

export const settings = new SettingsClient(settingsTransport, localKv);
export const timeline = new TimelineStore(timelineTransport, localKv);

export const entries = ref<TimelineRow[]>(timeline.entries());
/** The term the timeline is filtered by (`''` = not searching).
 *
 *  There is no companion `timelineSearching` any more. It answered "the query has
 *  gone out, the answer is still on its way," which was a real state while the
 *  SERVER ran the search; the search is local and synchronous now (owner
 *  2026-07-31), so that moment does not exist and a ref reporting it would be a
 *  value answering a question nobody can ask. The copy it drove was retired
 *  with it — see lib/strings/search.ts. */
export const timelineQuery = ref<string>(timeline.query);
/** owner 2026-07-31 ②③ — what this PC actually keeps, and whether the last write
 *  landed. The page states BOTH: a bound that nobody is told about is
 *  "the user thinks all their history is there, when it was actually trimmed
 *  a while ago," and a storage failure nobody is told about is the same lie
 *  about rows that were never saved at all. */
export const timelineRetention = ref<RetentionFacts>(timeline.retention);
export const timelineStorageFailed = ref<boolean>(timeline.storageFailed);
/** The op that did NOT happen, for the page to state. 0.2.27: deferred delivery
 *  (补投) is the only one left — edit and delete are writes to this machine's own
 *  store, and there is nothing to refresh. RV-01 ③ built this surface because
 *  the three wire verbs used to `void`-discard the server's ack, so a delete
 *  the server refused looked exactly like one that worked; what survives the
 *  retirement is the rule, not the verbs: an action that did not happen has to
 *  be sayable. */
export const timelineFailure = ref<TimelineOpFailure | null>(timeline.lastFailure);

/** RV-93 — one row's DELIVERED picture (size B) as a `data:` URL, read on
 *  demand when the user opens one. `null` = this row has none, and the
 *  page draws its 256 px thumbnail instead; never an error ("only has the
 *  small picture" is a smaller picture, not a broken one).
 *
 *  ⚠️ A PASSTHROUGH ON PURPOSE, and it lives HERE rather than on `TimelineStore`: the
 *  store owns the rows, and a picture read is neither a read nor a write of one — it
 *  holds no state, invalidates nothing and would be the store's only async getter.
 *  (It also would not fit: timeline-store.ts is at the 800-line cap.) The wiring layer
 *  is where a call that only forwards belongs. */
export const rowImage = (id: string): Promise<string | null> => timelineTransport.rowImage(id);
timeline.subscribe(() => {
  entries.value = timeline.entries();
  timelineFailure.value = timeline.lastFailure;
  timelineQuery.value = timeline.query;
  timelineRetention.value = timeline.retention;
  timelineStorageFailed.value = timeline.storageFailed;
});

/** The PRIMARY channel's connection state — what the sidebar dot, the capsule
 *  and the timeline triggers read. */
export const conn = reactive<ConnectionState>({
  connected: false,
  registered: false,
  room_uuid: null,
  mobiles: 0,
  reason: 'init',
});

/** GA-28: one snapshot PER resident channel.
 *
 *  Both channels stay connected (07 §6), so BOTH pumps push a CONNECTION frame.
 *  Before this, `Object.assign(conn, p)` took whichever arrived last — the
 *  sidebar dot would blink between two live sockets and the device page could
 *  not tell which card was actually up. Each frame now lands in its own slot and
 *  `conn` mirrors the primary one. */
export const connByChannel = reactive<Record<string, ConnectionState>>({});

/** Apply connection rows to the two stores — the ONE place a row becomes state,
 *  shared by the snapshot seed and the push handler so they can never diverge.
 *
 *  `primary === false` updates only the per-channel slot: the global `conn` is
 *  the PRIMARY channel's view, and letting a presence channel's "0 phones"
 *  overwrite it is how the sidebar dot used to blink between two live sockets.
 *  `primary` ABSENT (a pre-GA-28 shell with one socket) is by definition primary. */
export function applyConnectionRows(rows: readonly ConnectionState[]): void {
  for (const row of rows) {
    const ch = row.channel ?? 'lan';
    connByChannel[ch] = { ...row };
    if (row.primary === false) continue;
    Object.assign(conn, row);
    // owner 2026-07-30 ①: the timeline is NOT told which channel is primary here any
    // more. It shows both, so this row has nothing to say to it — and the old
    // `timeline.setChannel(tag)` cleared the cache on every flip, which is how rows
    // that legitimately belong to this PC disappeared from the page.
  }
}

/** RV-16 — the LAN channel's OWN transport state, as one reactive predicate.
 *
 *  `conn` above is the PRIMARY channel's view. The two settings verbs are pinned to
 *  the LAN socket on the Rust side — `settings_update` and `settings_list` both go
 *  through `with_lan_socket` (src-tauri/src/shell/mod.rs: "owner ⑤: settings target
 *  the LAN server only") — so anything that must fire "settings can talk again" has
 *  to read THIS, never `conn.connected`: with preference=cloud the primary edge is
 *  the CLOUD socket's, and a LAN socket that came back raised no edge at all. The
 *  "saved locally" pending edit then sat there until cloud happened to reconnect or
 *  the app restarted. Trigger and verb must read the same socket.
 *
 *  Deriving it from `connByChannel` (rather than a hand-kept flag inside one
 *  handler) is also what makes it fire on BOTH row paths: the push handler and the
 *  v0.2.4 snapshot seed both write that map, and a desktop that boots with the LAN
 *  socket already up only ever gets the seed (connection-seed.test.ts). */
/** RV-新B — "which channel is current," the main window's ONE answer.
 *
 *  `conn` is by construction the PRIMARY channel's snapshot (`applyConnectionRows` and
 *  the push handler both skip `primary === false`), so its own `channel` tag IS the
 *  current channel — pushed by the pump on the very edge that moves it, and pulled by
 *  `connection_snapshot` for a window that booted late.
 *
 *  It replaces `cloud.channel`, which came from the Rust `CloudConfig.active` flag that
 *  owner 2026-07-30 ② left with no writer: a constant `'lan'` that the footer dot, the
 *  diagnostics "current channel" row, the settings page and the pairing modal's
 *  default tab were all rendering as live state. A pure-cloud user therefore saw a
 *  LAN-coloured verdict and "Add Phone" opened on the wrong tab.
 *
 *  Undefined before the first frame/seed ⇒ `'lan'`, the same process default Rust
 *  answers with while it has no evidence — not a claim, just the two ends agreeing. */
export const currentChannel = computed<ChannelTag>(() => asChannelTag(conn.channel) ?? 'lan');

export const lanConnected = computed(() => connByChannel.lan?.connected === true);
// `cloudConnected` was DELETED in 0.2.27. It existed for one reason — "a queued
// operation belonging to the relay needs to wait for the relay to come back" —
// and the timeline's durable queue is retired with the uplink it fed, so it
// had no production reader left. An exported derived value nobody reads is
// the plainest façade there is; the per-channel state itself is still available as
// `connByChannel.cloud` for anything that genuinely needs it (the device page does).

// The LAN connected RISING edge → replay the durable settings queue (07 §8).
// `flush: 'sync'` so the replay is not a tick late, and the watcher's own previous
// value IS this edge's memo — deliberately NOT `lastConnected` below, which is the
// primary channel's account (one flag must answer one question).
watch(
  lanConnected,
  (up, was) => {
    if (up && was !== true) void settings.flushPending();
  },
  { flush: 'sync' },
);

export const settingsPending = ref(settings.pending);
settings.onPending(() => {
  settingsPending.value = settings.pending;
  // Debounced-flush-failed forensic point (07 §10): a settings push that could
  // not reach the wire is held pending "saved locally" — record the
  // transition, never a silent drop.
  if (settings.pending) appendForensic('settings', 'debounce flush failed — held pending (已存本地)');
});

export function isKeyPending(key: string): boolean {
  return settings.isKeyPending(key);
}

let lastConnected = false;
let lastMobiles = 0;

/** owner 2026-07-27: pairing_id → mobile name, so a timeline row can say WHICH
 *  phone sent it. Resolved at render time from this map rather than stamped
 *  onto each row: a renamed phone then reads correctly on old rows too, and
 *  there is only ever one source of truth for the name. */
export const mobileNames = reactive<Record<string, string>>({});

/** pairing_id → device_uid (v0.2.4 handset identity), null when the pairing never
 *  identified its handset. A SECOND record beside [[mobileNames]] rather than one
 *  merged object so every existing name reader keeps its shape; both are written by
 *  the one refresh below, so they cannot drift apart. Consumed by the statistics
 *  breakdown (groupByMachine — merged by machine, mockup
 *  2026-08-02-ui-batch1-rework-design.md §1.3): two pairings of one handset
 *  must not render as two source phones. */
export const mobileMachines = reactive<Record<string, string | null>>({});

/** Refresh the map from pc:list-mobiles. A FAILED read (null) is deliberately a
 *  no-op: the previous names stay, because "we could not ask" is not "the phone
 *  has no name" — the same distinction paired-mobiles.ts draws for the device
 *  page's three-state card. */
export async function refreshMobileNames(): Promise<void> {
  const rows = await fetchPairedMobiles();
  if (rows === null) return;
  for (const r of rows) {
    mobileNames[r.pairing_id] = r.mobile_name;
    mobileMachines[r.pairing_id] = r.device_uid;
  }
}

/** Wire the inbound bridge channels + kick the first refresh. Idempotent-ish;
 *  call once at mount. */
export async function initBridge(): Promise<void> {
  // v0.2.4 — three markers, because the symptom ("the UI always says not
  // connected") has three possible causes that look identical on screen: this
  // function never ran, the
  // `listen` registration was rejected, or Tauri delivered nothing. Only the log
  // can tell them apart, and until now the main window wrote nothing at all —
  // every forensic line in the file came from the capsule.
  appendForensic('bridge', 'initBridge: wiring…');
  await onChannel<ConnectionState>(CH.connection, (p) => {
    // Per-channel first (the device page's two cards read this), then the global
    // view — but ONLY from the channel that is primary. A presence channel's
    // "0 phones" must never overwrite what the phone on the other channel is doing.
    const ch = p.channel ?? 'lan';
    connByChannel[ch] = { ...p };
    // v0.2.4 — the RECEIVING half of the pump's own record. The device page's
    // "connecting…" and the footer's "not connected" are both just "no frame
    // has arrived yet", and that is indistinguishable from "the frame arrived
    // and said false" — and from "the pump died". With both ends logged, the
    // answer is one grep instead of a guess (owner 2026-07-29 devices-page screenshot).
    appendForensic(
      'bridge',
      `CONNECTION ← ui (channel=${ch} connected=${p.connected} registered=${p.registered} mobiles=${p.mobiles} primary=${p.primary ?? '(absent)'})`,
    );
    // `primary` absent = a pre-GA-28 shell with one socket, which is by
    // definition the primary one.
    if (p.primary === false) return;
    Object.assign(conn, p);
    // RV-16: the settings queue is flushed on the LAN edge by the watcher above —
    // trigger and verb must watch the same socket. 0.2.27: there is no timeline
    // refresh on any edge (see this file's header) — pc:mobile-joined used to pull
    // 07 §9's incremental list, and the rows are this machine's own now.
    // owner 2026-07-27: "the PC side needs phone-instance-name → target." Names
    // are refreshed on the same two edges the timeline is, because those are
    // exactly when a new pairing can have appeared. A failed read leaves the
    // previous map alone — losing a name is a worse answer than a slightly
    // stale one, and the row falls back to "phone" (手机) rather than
    // inventing anything.
    if ((p.connected && !lastConnected) || p.mobiles !== lastMobiles) {
      void refreshMobileNames();
    }
    lastConnected = p.connected;
    lastMobiles = p.mobiles;
  });

  // Seed from a PULL, AFTER the listener is registered.
  //
  // Order matters and is the whole fix: register first so a frame arriving
  // mid-seed is not lost, then ask for the current state so a frame that
  // already fired before we existed is not lost either. Both halves are
  // idempotent — the snapshot and the push carry the same fields, so a
  // duplicate simply rewrites the same values.
  //
  // Without this the page could only ever learn about connections that changed
  // AFTER it mounted, and on this machine nothing ever did: Rust had both
  // sockets up 1.1 s before the WebView finished booting, and the device page
  // then showed "connecting…" for the entire session (owner 2026-07-29).
  try {
    const snap = await fetchConnectionSnapshot();
    applyConnectionRows(snap);
    appendForensic(
      'bridge',
      `seeded from snapshot: ${snap.length === 0 ? '(no resident channel)' : snap.map((r) => `${r.channel}=${r.connected}`).join(' ')}`,
    );
  } catch (e) {
    // A seed that failed is stated, not swallowed — otherwise this degrades
    // silently back to the exact push-only behaviour it replaces.
    appendForensic('bridge', `snapshot seed FAILED: ${String(e)}`);
  }
  // RV-01: all three timeline frames now arrive stamped with the channel that
  // received them (socket::bridge::tag_channel). An UNSTAMPED frame is dropped and
  // recorded rather than guessed into the cache — a row whose server is unknown is a
  // row no edit / delete / deferred-delivery replay could honestly address later,
  // and guessing is the whole defect. In a shipped build the stamp is always there (both halves ship in
  // one binary), so a line in the log here means the bridge itself drifted.
  const stampOf = (raw: unknown, what: string): ChannelTag | null => {
    const ch = asChannelTag(raw);
    if (ch === null) appendForensic('timeline', `${what} arrived with no channel stamp — dropped`);
    return ch;
  };
  // `history:list-result` stays unwired (no request, no producer — 0.2.27).
  //
  // ⚠️ THE TWO BELOW ARE NOT A PAIR ANY MORE. `history:updated` HAS a producer again:
  // the desktop's own `socket::row_transit` mints a row from each delivery frame and
  // forwards it here (owner's architecture ruling on transit-not-storage — see
  // lib/timeline-store.ts's header). `history:deleted` still has none and is kept
  // only for the local cross-window notice; do not "restore symmetry" between them.
  await onChannel<{ item?: WireHistoryItem; channel?: string }>(CH.historyUpdated, (p) => {
    const ch = stampOf(p.channel, 'history:updated');
    if (!ch || !p.item) return;
    const report = timeline.onHistoryUpdated(p.item, ch);
    // RV-76 — no silent failures on the path that produced NO ROW AT ALL. This
    // branch used to be unwritten, and it covered two very different things: a
    // frame the store could not use, and a row refused for being older than
    // the eviction cutoff. The second one is gone (lead's ruling 2026-07-31:
    // "a row that was just delivered" beats "older than the cutoff" — those
    // words were typed into the user's window), so what is left is a frame
    // with no usable id, which a minted row cannot have ⇒ a line here means
    // the producer drifted.
    if (report === null) {
      appendForensic(
        'timeline',
        `history:updated channel=${ch} id=${JSON.stringify(p.item.id)} produced NO ROW — ` +
          'the frame carried no usable id, so nothing could be addressed. Every row minted by ' +
          'socket::row_transit has one (`row minted id=…`), so this means the two ends drifted',
      );
      return;
    }
    // RV-76 — the row WAS taken in and then dropped by the bound in the same write. Only
    // reachable at MAX_ROWS / MAX_CHARS with a row older than everything held (a queued
    // delivery from days ago). The words were typed; the record of them did not survive.
    if (report.evictedOnArrival) {
      appendForensic(
        'timeline',
        `row DROPPED ON ARRIVAL id=${report.id} channel=${report.channel} — accepted, then ` +
          'trimmed by the stated bound in the same write (this PC is at MAX_ROWS/MAX_CHARS and ' +
          'the row is older than everything it holds). ⚠️ it WAS typed into the user’s window ' +
          'and has no record here; the bound is owner ② and is deliberately not overridden',
      );
    }
    // No silent failures, BOTH directions. Refusing to let a re-delivery overwrite a
    // row this machine owns is correct (see the store's onHistoryUpdated) — doing it
    // QUIETLY would just swap one silence for another, because the text that frame
    // carried WAS typed into the user's window and now has no visible record on this
    // PC. Same line family as the Rust producer's `row minted …`, so one grep finds
    // both ends.
    if (report.refusedFields.length > 0) {
      appendForensic(
        'timeline',
        `row kept-local id=${report.id} channel=${report.channel} ` +
          `refused=[${report.refusedFields.join(', ')}] locally_edited=${report.locallyEdited} — ` +
          'an inbound delivery frame disagreed with the row this PC holds and was NOT applied; ' +
          'only status (forward-only) and absent→present display fields may update an existing row. ' +
          '⚠️ if `output_text` is in that list, the re-delivered text has no visible record here ' +
          '(a known gap, owner has not ruled on it yet — see lib/timeline-store.ts onHistoryUpdated)',
      );
    }
  });
  await onChannel<{ id?: string; channel?: string }>(CH.historyDeleted, (p) => {
    const ch = stampOf(p.channel, 'history:deleted');
    if (ch && p.id) timeline.onHistoryDeleted(p.id, ch);
  });
  await onChannel<InjectResult>(CH.injectResult, (p) => {
    // RV-72 — this verdict is the ONLY thing that ever puts "which window it was
    // injected into" on a row, and after the address moved from `entry_id` to
    // `row_id` a producer/consumer drift would show up here as rows that quietly
    // never get a target. Two bare `return`s used to eat exactly that (red line: no
    // silent failures).
    const miss = timeline.onInjectResult(p);
    if (miss !== null) {
      appendForensic(
        'timeline',
        `inject:result NOT applied (${miss}) row_id=${JSON.stringify(p.row_id)} ` +
          `channel=${JSON.stringify(p.channel)} entry_id=${JSON.stringify(p.entry_id)} ok=${p.ok} — ` +
          (miss === 'unaddressable'
            ? 'the bridge stamps row_id + channel on every forwarded copy ' +
              '(row_transit::forward_verdict) and both halves ship in one binary ⇒ they drifted'
            : 'the row is not in this store: deleted by the user, or dropped by the bound. ' +
              'The delivery itself is unaffected; what is lost is its window title'),
      );
    }
  });
  // NOTE (RV-22): the flowmic://settings-updated listener is NOT here. Its sink is
  // `pullServerSettings` in settings-model.ts, which already imports this module —
  // wiring it from here would close an import cycle (lint 3/9 `circular`). The
  // listener therefore lives with its sink (settings-model.ts
  // `watchServerSettingsUpdates`), registered by App.vue at mount.

  // 0.2.27: no first pull. The rows were loaded from this machine's own storage in the
  // TimelineStore constructor, which is the whole of "where is the timeline" now. If
  // the store wound down a 0.2.26 change queue, say so — a one-way discard of work
  // the user initiated has to be discoverable even when discarding it is correct (no
  // silent failures).
  if (timeline.windedDownQueueOps !== 0) {
    appendForensic(
      'timeline',
      `retired 0.2.26 change queue: ${timeline.windedDownQueueOps} op(s) dropped — the rows ` +
        'already carry those edits/deletes (they were applied locally before queueing); ' +
        'what is gone is the server mirror, which no longer exists',
    );
  }
  // D8: hydrate-time corruption. The store already quarantined the bytes to a
  // `<key>.corrupt-<timestamp>` sibling (or is withholding writes over them when
  // even that failed) and console.error'd; this mirror puts each incident where
  // forensic readers look, beside the wind-down line above.
  for (const line of timeline.hydrateFaults) {
    appendForensic('timeline', line);
  }
  // The names the timeline resolves against, so rows read correctly on the very first
  // paint rather than only after the next connection edge.
  void refreshMobileNames();
}
