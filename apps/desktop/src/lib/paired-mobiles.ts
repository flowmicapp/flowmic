// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (pc:list-mobiles → ack
//     `{ mobiles: [{pairing_id, mobile_name, paired_at, last_seen_at, online}] }`)
//   docs/rebuild/07-DESKTOP-SPEC.md §5 (device page)
//   docs/strategy/R6-BACKLOG-AND-PLAN.md T-8 (已配对手机表, "paired mobiles table")
//
// Pure, Tauri-free, DOM-free helpers for the device page's 「已配对手机」("paired
// mobiles") table so the three-state read (loading / loud failure / real rows)
// and the zh-CN fixed
// time formatting are unit-testable in isolation.
//
// TWO honesty rules live here, both learned the hard way:
//   • A FAILED read (socket down, ack timeout, server refusal) is NOT an empty
//     list. "No phones paired" and "we could not ask" are different facts and the
//     page must say which one it has — `null` rows → loud state, `[]` → the real
//     empty state.
//   • `online` comes from the server's live room presence. Nothing here upgrades
//     a phone to online on its own (e.g. from a recent last_seen_at); a missing
//     flag reads offline.

/** One row of the pc:list-mobiles ack — the PUBLIC projection, five fields.
 *  There is deliberately no token/secret field: the server never sends one and
 *  the Rust bridge narrows the ack again before it reaches this layer. */
export interface PairedMobile {
  /** mobile_pairings row id (the id the phone joins the room under). */
  pairing_id: string;
  mobile_name: string;
  /** ISO-8601 pairing timestamp. */
  paired_at: string;
  /** ISO-8601 last reconnect, or null for a pairing that has never returned. */
  last_seen_at: string | null;
  /** REAL room presence at query time — never a stored flag replayed as live. */
  online: boolean;
  /** v0.2.1 — WHICH channel this pairing lives on. Stamped by the Rust bridge
   *  (the server has no idea which of our two sockets asked it).
   *
   *  owner 2026-07-28:「同一个手机可以存在两条记录」("the same phone can have two
   *  records"). It is not a duplicate to be merged away: the two channels are
   *  two servers with two `mobile_pairings` tables, so the rows have different
   *  ids, independent presence, and 断开/撤销 ("disconnect/revoke") on one does
   *  nothing to the other. Collapsing them would make the revoke button lie
   *  about what it revokes. */
  channel: ChannelId;
  /** v0.2.4 — WHICH PHYSICAL HANDSET this row belongs to.
   *
   *  owner 2026-07-29:「应能明确知道是否都是同一台手机和同一台 PC」("must be able to
   *  clearly tell whether it's the same phone and the same PC"). `channel`
   *  above says the two rows are two pairings and must stay two rows; this says
   *  they are nonetheless one phone. Both facts are true and the table was only
   *  ever showing the first.
   *
   *  `null` for a pairing made by a pre-0.2.4 phone. Two nulls are NOT a match —
   *  see [derivePairedList]. */
  device_uid: string | null;
}

/** Which channel a pairing belongs to. Mirrors the Rust `Channel::tag()`. */
export type ChannelId = 'lan' | 'cloud';

/** What the card can honestly claim about one pairing's session right now.
 *
 *  🔴 未知 ≠ 错误 ("unknown ≠ error") (owner 2026-08-02 返工 ["rework"], 设计稿
 *  ["design doc"] 2026-08-02-ui-batch1-rework-design.md
 *  §2). Three answers to three different situations — one value, one question each:
 *   · `online`  — this pairing's channel ANSWERED and said the session is up;
 *   · `offline` — the channel answered and said it is not;
 *   · `unknown` — the channel DID NOT ANSWER, so this row is the cached last-known
 *     shape, not a live fact. It is rendered neutral (weak grey, dashed), never red:
 *     the previous screen shouted an error and dropped the row entirely, which the
 *     user read as「配对丢了」("the pairing is lost") — worse than any stale answer. */
export type Presence = 'online' | 'offline' | 'unknown';

/** The whole device-page read: rows from every channel that answered, plus the
 *  channels that are resident but did NOT answer.
 *
 *  `unreachable` exists so the page can keep this file's first honesty rule
 *  across TWO channels instead of one: omitting a channel we could not ask would
 *  render as 「那条通道上没有手机」("there are no phones on that channel"), which is
 *  the same conflation of 「没有」("none") and 「问不到」("could not ask") that
 *  `null` rows were introduced to prevent. */
export interface PairedMobilesView {
  rows: PairedMobile[];
  unreachable: ChannelId[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Narrow the raw IPC payload to typed rows. `null` in → `null` out (the failure
 *  state is preserved, never laundered into an empty list). A row missing its
 *  pairing_id is dropped: an unidentifiable phone cannot be rendered honestly. */
export function asPairedMobiles(raw: unknown): PairedMobile[] | null {
  if (!Array.isArray(raw)) return null;
  const rows: PairedMobile[] = [];
  for (const r of raw) {
    if (r === null || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const pairing_id = str(o.pairing_id);
    if (pairing_id === '') continue;
    rows.push({
      pairing_id,
      mobile_name: str(o.mobile_name) || '手机',
      paired_at: str(o.paired_at),
      last_seen_at: typeof o.last_seen_at === 'string' && o.last_seen_at !== '' ? o.last_seen_at : null,
      online: o.online === true,
      channel: o.channel === 'cloud' ? 'cloud' : 'lan',
      device_uid: typeof o.device_uid === 'string' && o.device_uid.trim() !== '' ? o.device_uid.trim() : null,
    });
  }
  return rows;
}

/** Narrow the v0.2.1 two-channel payload. A shape we do not recognise yields
 *  `null` — the loud state — rather than an empty table. */
export function asPairedMobilesView(raw: unknown): PairedMobilesView | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const rows = asPairedMobiles(o.rows);
  if (rows === null) return null;
  const unreachable: ChannelId[] = Array.isArray(o.unreachable)
    ? o.unreachable.filter((c): c is ChannelId => c === 'lan' || c === 'cloud')
    : [];
  return { rows, unreachable };
}

// ── the last-known cache (设计稿 §2.2, "design doc" §2.2) ────────────────────
//
// The ONLY honest way to keep a row on screen while its channel cannot be asked is
// to remember the previous answer and SAY it is old. Each successful read stores
// that channel's rows + when; an unreachable channel's rows come back from here
// marked `unknown`, carrying「截至几点」("as of what time") for the tooltip.

/** One channel's rows as of the last read that reached it. */
export interface PairedSnapshot {
  rows: PairedMobile[];
  /** ISO instant of the read. Rendered (via formatStamp) in the unknown-tooltip. */
  fetchedAt: string;
}

export type PairedCache = Partial<Record<ChannelId, PairedSnapshot>>;

/** A row plus what the card may claim about it. Live rows say online/offline;
 *  cached rows say unknown and carry the snapshot instant. */
export interface PresenceMobile extends PairedMobile {
  presence: Presence;
  /** Non-null ONLY on `unknown` rows: when this shape was last true. */
  asOf: string | null;
}

/** What the device page hands PairedList since the rework: rows with presence,
 *  plus the channels that neither answered NOR had a cache — those are named in a
 *  quiet (not red) note, keeping the old honesty rule:「问不到」("could not ask")
 *  must never render as「那条通道上没有手机」("there are no phones on that channel"). */
export interface PairedPresenceView {
  rows: PresenceMobile[];
  unlisted: ChannelId[];
}

const PAIRED_CACHE_KEY = 'paired.lastKnown.v1';

/** Storage seam — the minimal get/set the cache needs (lib/storage's localKv fits). */
interface CacheKv {
  get(key: string): string | null;
  set(key: string, value: string): unknown;
}

/** Read the persisted cache. Anything unparseable is an EMPTY cache, not an error:
 *  the cache is a comfort layer, and a corrupt one must degrade to the pre-cache
 *  behaviour (rows absent + the quiet note), never to a crash or a lie. Rows go
 *  through [[asPairedMobiles]] — the same narrowing the live read uses. */
export function readPairedCache(kv: CacheKv): PairedCache {
  const raw = kv.get(PAIRED_CACHE_KEY);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    const out: PairedCache = {};
    for (const ch of ['lan', 'cloud'] as const) {
      const entry = (parsed as Record<string, unknown>)[ch];
      if (entry === null || typeof entry !== 'object') continue;
      const rows = asPairedMobiles((entry as Record<string, unknown>).rows);
      const fetchedAt = (entry as Record<string, unknown>).fetchedAt;
      if (rows === null || typeof fetchedAt !== 'string' || fetchedAt === '') continue;
      // Stamp the channel back onto every row: the cache bucket is the authority,
      // and a row whose own tag drifted must not claim the other channel.
      out[ch] = { rows: rows.map((r) => ({ ...r, channel: ch })), fetchedAt };
    }
    return out;
  } catch {
    return {};
  }
}

export function writePairedCache(kv: CacheKv, cache: PairedCache): void {
  kv.set(PAIRED_CACHE_KEY, JSON.stringify(cache));
}

/** Fold one live read + the cache into the rendered view and the next cache.
 *
 *  Pure — `now` is passed in. Live rows keep live presence; each channel that
 *  answered refreshes its cache bucket; each unreachable channel is answered from
 *  its bucket (rows forced offline→unknown, `online` cleared so no aggregate or
 *  sort can mistake a cached session for a live one), or lands in `unlisted` when
 *  there is nothing cached to show. */
export function mergeWithCache(
  view: PairedMobilesView,
  cache: PairedCache,
  now: Date,
): { view: PairedPresenceView; nextCache: PairedCache } {
  const rows: PresenceMobile[] = view.rows.map((r) => ({
    ...r,
    presence: r.online ? 'online' : 'offline',
    asOf: null,
  }));
  const nextCache: PairedCache = {};
  const unlisted: ChannelId[] = [];
  const unreachable = new Set<ChannelId>(view.unreachable);
  for (const ch of ['lan', 'cloud'] as const) {
    if (unreachable.has(ch)) {
      const kept = cache[ch];
      if (kept !== undefined && kept.rows.length > 0) {
        for (const r of kept.rows) {
          rows.push({ ...r, online: false, presence: 'unknown', asOf: kept.fetchedAt });
        }
        nextCache[ch] = kept;
      } else {
        if (kept !== undefined) nextCache[ch] = kept;
        unlisted.push(ch);
      }
    } else {
      const own = view.rows.filter((r) => r.channel === ch);
      // Any channel NOT listed unreachable refreshes its bucket from the live rows,
      // even to empty:「真的没有配对」("really has no pairing") and「这条通道现在不
      // 驻留」("this channel is not currently resident") are both states in
      // which a stale phone must not resurrect as「状态未知」("state unknown") on
      // the next outage (e.g. right after the user revoked it, or signed the
      // cloud channel out).
      nextCache[ch] = { rows: own, fetchedAt: now.toISOString() };
    }
  }
  return { view: { rows, unlisted }, nextCache };
}

/** `YYYY-MM-DD HH:mm` local time, hand-built so the fixed zh-CN surface never
 *  picks up an OS locale format (UI 不跟随 OS locale 红线 — "UI does not follow
 *  the OS locale", a red line). Same shape as
 *  channel.formatExpiry. Unparseable / absent → null (the caller shows 「—」). */
export function formatStamp(iso: string | null): string | null {
  if (iso === null || iso.trim() === '') return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** What the 「已配对手机」("paired mobiles") card renders. `state` is the
 *  three-way truth. */
export interface PairedListView {
  state: 'loading' | 'failed' | 'empty' | 'rows';
  rows: PairedMobileRow[];
  /** Online count across the listed rows (0 when not in the `rows` state). */
  onlineCount: number;
}

export interface PairedMobileRow extends PairedMobile {
  /** Tri-state session claim (设计稿 §2, "design doc" §2). Rows from a plain
   *  PairedMobile input derive it from `online`, so pre-rework callers keep
   *  their behaviour. */
  presence: Presence;
  /** Preformatted「截至几点」("as of what time") for the unknown-tooltip; null
   *  on live rows. */
  asOfLabel: string | null;
  /** Preformatted 配对时间 ("pairing time"), or null → render 「—」. */
  pairedLabel: string | null;
  /** Preformatted 最近活动 ("last activity"). Null when the phone has never
   *  returned since pairing — the card then says 「从未连接」("never connected")
   *  rather than back-filling paired_at. */
  lastSeenLabel: string | null;
  /** v0.2.4 — another listed row is the SAME physical handset (same
   *  `device_uid`), i.e. this phone reached this PC over both channels. The row
   *  then says so instead of looking like a duplicate the user should clean up.
   *
   *  False whenever `device_uid` is null: two phones that both failed to
   *  identify themselves are not thereby the same phone. */
  sharedHandset: boolean;
}

/** Derive the whole card state. `mobiles === undefined` → still loading;
 *  `null` → the read FAILED (loud); an array → the real answer, empty or not.
 *  Online rows sort first, then most-recently-active, then name — the phone the
 *  user is holding is the one they are looking for. Unknown rows are NOT boosted:
 *  a cached shape must never outrank a live session. */
export function derivePairedList(
  mobiles: Array<PairedMobile & { presence?: Presence; asOf?: string | null }> | null | undefined,
): PairedListView {
  if (mobiles === undefined) return { state: 'loading', rows: [], onlineCount: 0 };
  if (mobiles === null) return { state: 'failed', rows: [], onlineCount: 0 };
  // Count handsets BEFORE sorting — the tally is over the whole list and must
  // not depend on row order. Only non-null uids are counted, so a table full of
  // pre-0.2.4 rows produces no claims at all.
  const perHandset = new Map<string, number>();
  for (const m of mobiles) {
    if (m.device_uid === null) continue;
    perHandset.set(m.device_uid, (perHandset.get(m.device_uid) ?? 0) + 1);
  }
  const rows = [...mobiles]
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      const at = Date.parse(a.last_seen_at ?? a.paired_at);
      const bt = Date.parse(b.last_seen_at ?? b.paired_at);
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at;
      return a.mobile_name.localeCompare(b.mobile_name);
    })
    .map((m) => ({
      ...m,
      presence: m.presence ?? (m.online ? ('online' as const) : ('offline' as const)),
      asOfLabel: formatStamp(m.asOf ?? null),
      pairedLabel: formatStamp(m.paired_at),
      lastSeenLabel: formatStamp(m.last_seen_at),
      sharedHandset: m.device_uid !== null && (perHandset.get(m.device_uid) ?? 0) > 1,
    }));
  return {
    state: rows.length === 0 ? 'empty' : 'rows',
    rows,
    // Presence, not the raw flag: an `unknown` row's cached `online` was already
    // cleared by mergeWithCache, but counting through presence keeps this true
    // even for a caller that skipped the merge.
    onlineCount: rows.filter((r) => r.presence === 'online').length,
  };
}

/** 2026-07-29 device-page polish (D1): the card renders PER HANDSET, not per
 *  pairing. Rows sharing a non-null `device_uid` are one physical phone (the
 *  same identity v0.2.4 stamped and `sharedHandset` flagged) and become ONE
 *  group with that phone's pairings as sub-rows — replacing the「同一台手机」
 *  ("same phone") chip, which said the same thing as a footnote on two loose rows.
 *
 *  A null uid can claim no handset, so every such row stays a singleton group;
 *  two unidentified rows are NEVER merged (the honesty rule sharedHandset
 *  already followed: 问不到 ["could not ask"] is not 同一台 ["the same one"]).
 *
 *  Pure presentation: rows are not merged, copied, or re-sorted — a group's
 *  `rows` are the exact PairedMobileRow objects derivePairedList returned, in
 *  the same order, so every per-row action still targets its own pairing_id
 *  on its own channel. */
export interface PairedGroup {
  /** Stable v-for key: the handset uid, or the singleton row's pairing id. */
  key: string;
  /** Display name — the first (best-sorted) row's, since the two servers can
   *  know one phone under different names and there is no truer source. */
  name: string;
  /** ANY row online → the handset is online (the group header's one aggregate). */
  online: boolean;
  /** The header's tri-state: any `online` wins; failing that, any `unknown` —
   *  「此刻没有会话」("no session right now") is not claimable while one channel
   *  could not be asked — and only an all-answered, all-down handset reads
   *  offline. */
  presence: Presence;
  /** true when the handset holds more than one pairing (one per channel). */
  multi: boolean;
  rows: PairedMobileRow[];
}

/** Group a derived list per physical handset. Group order follows the first
 *  member's position, so the list stays online-first as derivePairedList
 *  sorted it. */
export function derivePairedGroups(rows: readonly PairedMobileRow[]): PairedGroup[] {
  const groups = new Map<string, PairedGroup>();
  for (const row of rows) {
    const key = row.device_uid !== null ? `uid:${row.device_uid}` : `row:${row.pairing_id}`;
    const g = groups.get(key);
    if (g) {
      g.rows.push(row);
      g.online = g.online || row.online;
      g.presence = g.presence === 'online' || row.presence === 'online'
        ? 'online'
        : g.presence === 'unknown' || row.presence === 'unknown'
          ? 'unknown'
          : 'offline';
      g.multi = true;
    } else {
      groups.set(key, {
        key,
        name: row.mobile_name,
        online: row.online,
        presence: row.presence,
        multi: false,
        rows: [row],
      });
    }
  }
  return [...groups.values()];
}
