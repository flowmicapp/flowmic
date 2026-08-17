// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.7 (settings:list / settings:update /
//     settings:updated)
//   docs/rebuild/05-DATA-MODEL.md §5 (KV keys; broadcast deny-list for mobile:
//     account.*, llm.api_key, ^(stt\.|llm\.).*\.api_key$ + deep redactApiKeys),
//     §2 (enc:v1: at-rest is the repo's job; wire is plaintext)
//   CLAUDE.md red line: settings persist the instant they change, no save button
//   Ported broadcast/redaction mechanism from legacy socket/handlers/settings.handler.ts.
//
// Persist-on-change: settings:update upserts immediately (no save button). The origin
// gets ack {ok:true}; every OTHER socket of the same user gets settings:updated
// — peer PCs unfiltered, the paired mobile only for non-credential keys with
// nested api_key stripped. Wire payloads are plaintext (encryption is at-rest).

import type { Server, Socket } from 'socket.io';
import {
  SETTINGS_KEY_CAPABILITY_LLM,
  SETTINGS_KEY_STT_POLISH,
  safeParseEvent,
  type SttPolish,
} from '@flowmic/protocol';
import type { SettingRow, SettingsRepo } from '../../db/repos/settings.repo';
import { stampSettingProvenance } from '../../settings/defaults';
import { llmCapabilityUsable, sttPolishDefaultFrom } from '../../stt/stt-polish-settings';
import type { AuthContext } from '../../auth/middleware';
import type { Registry } from '../../room/registry';
import type { RoomStore } from '../../room/store';
import { getAuth, safeAck } from '../wire';

export interface SettingsHandlerDeps {
  io: Server;
  repo: SettingsRepo;
  /** GA-10: `device.pc_name` is a RESERVED key that writes `pc_devices`, not the
   *  KV store — so this handler needs the device registry. Optional so an older
   *  caller (and every KV-only test) keeps working; absent ⇒ the reserved key is
   *  refused loudly rather than silently falling through to the KV path, which
   *  would store a name nothing reads. */
  registry?: Registry;
  /** The live room membership, so the rename reaches THIS PC's phones only. */
  store?: RoomStore<Socket>;
  now?: () => string;
}

/** 04 §3.7 F-3101 — the reserved key. Not in the KV namespace and never stored
 *  there; the name lives in `pc_devices.device_name`, which is also the row the
 *  web console reads, so a rename shows up there with no extra plumbing. */
export const PC_NAME_KEY = 'device.pc_name';
/** 04 §3.7: trim non-empty, ≤80 chars. */
export const PC_NAME_MAX = 80;

/** Extract a valid `{pc_name}` from the wire value, or null. Rejects (never
 *  truncates) an over-long name: silently storing something other than what the
 *  user typed is the quiet kind of lie. */
export function parsePcName(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = (value as { pc_name?: unknown }).pc_name;
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (name.length === 0 || name.length > PC_NAME_MAX) return null;
  return name;
}

const API_KEY_RE = /^(stt\.|llm\.).*\.api_key$/;
function isCredentialBearing(key: string): boolean {
  return key.startsWith('account.') || key === 'llm.api_key' || API_KEY_RE.test(key);
}

const API_KEY_FIELD_RE = /^api[_-]?key$/i;
export function redactApiKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactApiKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (API_KEY_FIELD_RE.test(k)) continue;
      out[k] = redactApiKeys(v);
    }
    return out;
  }
  return value;
}

/** 04 §3.7-a — the wire shape of a settings change. `updated_at` is OPTIONAL and
 *  its absence means UNKNOWN, so it is omitted rather than sent as undefined. */
export interface SettingsUpdatedPayload {
  key: string;
  value: unknown;
  updated_at?: string;
}

/** Re-attach an optional stamp without ever materialising `updated_at: undefined`
 *  — an explicit undefined would make "no stamp" and "a stamp we lost" look the
 *  same to anything comparing shapes. */
function withStamp(payload: { key: string; value: unknown }, updated_at: string | undefined): SettingsUpdatedPayload {
  return updated_at === undefined ? payload : { ...payload, updated_at };
}

/** What a MOBILE may see of this change, or null when it may see nothing at all.
 *  ONE definition, used by both the account-wide fan-out below and the G2
 *  regress refusal — a second copy of the deny-list is exactly the「同一个符号
 *  两份答案」shape, and this one guards credentials. */
function mobileView(payload: SettingsUpdatedPayload): SettingsUpdatedPayload | null {
  // GA-10: the reserved rename key is delivered to mobiles by the room-scoped
  // loop in the handler (04 §3.7 "broadcast only to mobiles within that PC's
  // room"). Excluding
  // them here keeps that scope real — otherwise this account-wide fan-out would
  // hand the rename to every phone on the account, including ones paired to a
  // different PC entirely.
  if (isCredentialBearing(payload.key) || payload.key === PC_NAME_KEY) return null;
  return withStamp({ key: payload.key, value: redactApiKeys(payload.value) }, payload.updated_at);
}

/** Fan a settings change out to every OTHER online socket of the same user —
 *  peer PCs unfiltered, paired mobiles behind the credential deny-list with
 *  nested api_key stripped. Exported (WP-W1b) so the console REST write path
 *  reuses the EXACT same semantics (originSocketId '' = no origin to skip).
 *
 *  G2: `payload.updated_at` rides along when the caller has one. The console and
 *  BYOK callers (bootstrap.ts, http/byok-routes.ts) pass none and therefore keep
 *  today's behaviour byte for byte — absence is UNKNOWN, never epoch. */
export function broadcastUpdated(io: Server, originSocketId: string, userId: string, payload: SettingsUpdatedPayload): void {
  const mobilePayload = mobileView(payload);
  for (const [, peer] of io.sockets.sockets) {
    if (peer.id === originSocketId) continue;
    const auth = (peer.data as { auth?: AuthContext | null }).auth ?? null;
    if (!auth || auth.userId !== userId) continue;
    if (auth.kind === 'mobile') {
      if (mobilePayload === null) continue;
      peer.emit('settings:updated', mobilePayload);
    } else {
      peer.emit('settings:updated', payload);
    }
  }
}

/**
 * 🔴 G2 — how far ahead of THIS server's clock an incoming `updated_at` may be
 * before it is replaced by `now()`.
 *
 * The clamp exists because the regress guard below introduces exactly one new
 * failure mode: a row stamped in the future is refused every subsequent write
 * and becomes PERMANENTLY UNWRITABLE. A client with a badly wrong clock (or a
 * hostile one) would otherwise be able to freeze a key forever.
 *
 * Five minutes, and the reasoning is what makes the number defensible rather
 * than arbitrary: it is comfortably wider than the clock drift a real NTP-synced
 * phone or desktop shows (seconds), so a legitimate edit is never re-stamped in
 * practice; and it BOUNDS THE DAMAGE, because the worst a clamped row can do is
 * refuse writes until the wall clock catches up — at most this window, after
 * which the key heals itself with no operator action. A tighter value would
 * start re-stamping honest edits with server time; a looser one buys nothing and
 * lengthens the freeze.
 *
 * ⚠️ Being re-stamped is not a rejection: the write still happens, it is only
 * recorded as having happened NOW. That is the honest answer when the only other
 * option is to record a moment that has not occurred yet.
 */
export const SETTINGS_STAMP_MAX_SKEW_MS = 5 * 60_000;

/**
 * A wire stamp as epoch millis, or null when it cannot be used as an instant.
 *
 * 🔴 `Iso8601` in @flowmic/protocol is `z.string().min(1)` — a NAME, not a
 * validator (MEASURED 2026-08-16; it contradicted the first draft of the
 * protocol test, which asserted a rejection and went red). So an unparseable
 * string DOES cross the boundary, and comparing these as STRINGS would rank
 * 'yesterday' above '2026-08-16T…' (lowercase 'y' > '2') ⇒ a garbage stamp
 * would win every comparison and pin the row — the same permanent-unwritability
 * failure the clamp closes, arriving through a different door.
 *
 * ⇒ Unparseable is treated as ABSENT, i.e. UNKNOWN, i.e. degrade to today's
 * behaviour (write it). Never as a comparable value, and never as epoch zero:
 * both of those let a malformed stamp decide who wins.
 */
function stampMs(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

/**
 * Append the keys whose ABSENCE still means something, carrying the value the
 * server would actually use. Today that is `stt.polish` and only `stt.polish`.
 *
 * 🔴 WHY THIS EXISTS (0.3.0 L2, RT ledger §6.1 item 6). `settings:list` used to
 * return exactly the rows in the table, so "no row" and "the server does X when
 * there is no row" were indistinguishable on the wire. `stt.polish` is never
 * seeded, so for most accounts there is no row — and the desktop, unable to learn
 * the server's default, fell back to a hard-coded `false` and rendered the switch
 * OFF while the server polished every closing final. Owner's 2026-08-08 "default
 * to fully on"
 * makes that divergence the NORMAL case rather than a corner. R11 ("a transcript
 * message's status must always be correct") says the layer making the claim
 * must hold the fact the claim
 * needs; this is that fact being put on the wire.
 *
 * ⚠️ READ PATH ONLY — deliberately not seeding. A seeded row is a DB migration
 * and a one-way door (it would survive a later flip back and outlive the constant
 * that justified it); this synthesises the answer on every read, so the value
 * always tracks the server's own default and reverting is a one-line change.
 *
 * 🔴 THE DEFAULT IS PASSED IN, NOT COMPUTED HERE (card POLISH-CFG, 2026-08-09).
 * It stopped being a constant and became a function of "whether there is an
 * available llm.config"
 * (stt/stt-polish-settings.ts `resolveSttPolishDefault`). This function must not
 * work it out from `rows`: the rows DO contain `llm.config`, which is exactly what
 * makes the shortcut tempting — but the platform's env-gated MANAGED default is
 * not a row, so a rows-only answer would report "off" for every flowmic.app
 * account whose model comes from the platform, while the server armed polish for
 * them anyway. That is this function's own founding bug with the sign flipped, one
 * release later. The caller resolves it once and hands the SAME value to both
 * readers; the parameter exists to make sharing the cheaper option than copying.
 * ⚠️ A real row always wins — this only fills a GAP. Verified by the negative
 * control in settings-effective-defaults.test.ts, without which this function
 * could clobber a user's own `{enabled:false}` and every other assertion here
 * would still pass.
 * ⚠️ The key comes from `SETTINGS_KEY_STT_POLISH`, not a literal: the literal-key
 * anchors for this key are the desktop SET site and stt/stt-polish-settings.ts's
 * GET site (decision 2026-07-23-settings-key-drift-literal-anchors), and this is
 * neither.
 *
 * 🔴 G2 — A SYNTHESIZED ROW CARRIES NO `updated_at`, AND THAT IS THE POINT.
 * A stored row answers with its own stamp (the column has been per-key since the
 * table was created — 05 §5.1, no migration involved). The two rows invented
 * here are COMPUTED, not stored: there is no moment at which a human set them,
 * so there is no honest value to report. Minting one would be precisely the lie
 * this function's header above forbids — and worse than cosmetic, because the
 * client convergence that reads these stamps would then compare a fabricated
 * time against a real one. Absent = unknown = "this cannot be compared", which
 * is the truth.
 */
export function withEffectiveDefaults(
  rows: readonly SettingRow[],
  polishDefault: SttPolish,
  llmUsable: boolean,
): SettingsUpdatedPayload[] {
  const out: SettingsUpdatedPayload[] = rows.map((it) => ({
    key: it.key,
    value: it.value as unknown,
    updated_at: it.updated_at,
  }));
  if (!out.some((it) => it.key === SETTINGS_KEY_STT_POLISH)) {
    out.push({ key: SETTINGS_KEY_STT_POLISH, value: { ...polishDefault } });
  }
  // synthesizeCapability: the settings-key-drift READ-ONLY anchor. A `capability.*`
  // key is computed here on every read and is never storable — the lint keys its
  // whole ruleset off that prefix, so this call is what proves the key has a
  // producer. It is UNCONDITIONAL, unlike the gap-filler above: a stored row can
  // never shadow a capability fact, because there is no such row to write.
  out.push({ key: SETTINGS_KEY_CAPABILITY_LLM, value: { usable: llmUsable } });
  return out;
}

export function registerSettingsHandlers(socket: Socket, deps: SettingsHandlerDeps): void {
  const { io, repo } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());

  socket.on('settings:list', (payload: unknown, ack: unknown) => {
    const auth = getAuth(socket);
    if (!auth) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    const parsed = safeParseEvent('settings:list', payload);
    if (!parsed.success) return safeAck(ack, { error: 'SETTINGS_SCHEMA_INVALID' });
    try {
      // 🔴 ONE resolution, TWO derived answers (card POLISH-CFG). The default the
      // server will use and the capability fact the desktop will render must be
      // the same boolean; resolving twice would let them disagree the moment the
      // resolver's inputs change between calls.
      const llmUsable = llmCapabilityUsable(repo, auth.userId);
      const items = withEffectiveDefaults(repo.readAll(auth.userId), sttPolishDefaultFrom(llmUsable), llmUsable);
      // G2: `updated_at` rides the ack on BOTH arms. This projection is the
      // whole reason the stamp was invisible for so long — the column, the
      // upsert and the repo have carried it since the table was created, and
      // this `.map` dropped it (05 §5.1). Nothing else had to change to expose
      // it: no migration, no schema, no new column.
      const out: SettingsUpdatedPayload[] =
        auth.kind === 'mobile'
          ? items
            .filter((it) => !isCredentialBearing(it.key))
            .map((it) => withStamp({ key: it.key, value: redactApiKeys(it.value) }, it.updated_at))
          : items.map((it) => withStamp({ key: it.key, value: it.value }, it.updated_at));
      safeAck(ack, { items: out });
    } catch {
      safeAck(ack, { error: 'SETTINGS_SYNC_FAIL' });
    }
  });

  socket.on('settings:update', (payload: unknown, ack: unknown) => {
    const auth = getAuth(socket);
    if (!auth) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
    const parsed = safeParseEvent('settings:update', payload);
    if (!parsed.success) return safeAck(ack, { error: 'SETTINGS_SCHEMA_INVALID' });
    const { key, value } = parsed.data;

    // ── GA-10 reserved key: device.pc_name (04 §3.7 F-3101) ──────────────────
    // owner's 2026-07-26 iron rule: "naming on the PC side can only be
    // controlled by the PC side". A mobile-originated
    // write is refused — not ignored, not accepted-and-dropped. This is the rule
    // itself, not defensive coding: the phone renames things LOCALLY (its own
    // displayAlias, which never leaves the device), and the PC's name is the
    // PC's to set.
    //
    // 🔴 G2 DELIBERATELY STOPS AT THIS BRANCH — no `updated_at`, in or out.
    // This key does not live in the KV at all (it writes `pc_devices.device_name`),
    // so there is no `user_settings.updated_at` for it to be honest about, and
    // `pc_devices` has no equivalent column. Stamping it would mean inventing a
    // time from nothing — the same lie `withEffectiveDefaults` refuses to tell
    // for its computed rows. It also has no convergence problem to solve: a PC's
    // name is a fact about ONE machine, room-scoped, single-writer by owner's
    // iron rule below, so there is no second copy to race.
    // ⇒ test/pc-rename.test.ts asserts the exact un-stamped payload and stays
    //   green. Anyone tempted to "finish the job" here should read this first.
    if (key === PC_NAME_KEY) {
      if (auth.kind !== 'pc' || !auth.deviceId) return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
      const name = parsePcName(value);
      if (name === null) return safeAck(ack, { error: 'SETTINGS_SCHEMA_INVALID' });
      const pc = deps.registry?.findPc(auth.deviceId);
      // No registry wired, or the socket names a PC this account does not own:
      // both are refusals, and they are INDISTINGUISHABLE on the wire — row
      // existence must not be an oracle (same rule as pc:release-mobile).
      if (!deps.registry || !pc || pc.user_id !== auth.userId) {
        return safeAck(ack, { error: 'AUTH_TOKEN_INVALID' });
      }
      deps.registry.renamePc(pc.id, name);
      // Fan out to THIS PC's room only (04 §3.7) — a rename is a fact about one
      // machine, so the account's other rooms have no business hearing it. The
      // payload carries `pc_id` so a phone paired to several PCs can tell which
      // one was renamed.
      const roomUuid = pc.room_uuid;
      for (const m of deps.store?.getMobiles(roomUuid) ?? []) {
        m.emit('settings:updated', { key, value: { pc_id: pc.id, pc_name: name } });
      }
      // Peer PCs of the same account see it too — the console and a second
      // desktop both read `pc_devices`, so they must not keep the stale label.
      broadcastUpdated(io, socket.id, auth.userId, { key, value: { pc_id: pc.id, pc_name: name } });
      return safeAck(ack, { ok: true });
    }
    // Legacy singular stt.routing is a deleted key (V1.6-H6 incident) — reject
    // it loudly rather than let it silently resurrect (05 §5 red line).
    if (key === 'stt.routing') return safeAck(ack, { error: 'SETTINGS_SCHEMA_INVALID', message: 'stt.routing is removed; use stt.routings' });
    // 🔴 The provenance marker is RE-DERIVED here and whatever the client sent is
    // thrown away (settings/provenance.ts). This is the forgery gate, and the
    // forgery is not hypothetical: the desktop hydrates `stt.routings` from
    // settings:list by spreading each row (settings-model.ts applyServerSettings),
    // so a `seed` marker survives the round trip and would come back attached to a
    // row the user has since edited — at which point the platform managed default
    // would override a real user choice, the one thing the ruling forbids.
    // Non-provenance keys pass through byte-identical.
    let stamped: unknown;
    let storedAt: string;
    try {
      stamped = stampSettingProvenance(key, value);

      // ── G2 regress guard (04 §3.7-a rule 2) ──────────────────────────────
      // 🔴 THIS IS THE LOAD-BEARING HALF. `scenario.card` has TWO writers — the
      // phone AND the desktop (apps/desktop/src/lib/settings-client.ts) — and two
      // writers across two servers make four copies. Once clients start pushing
      // their local copy on reconnect to converge, a phone holding a week-old
      // card would clobber a desktop edit made five minutes ago. Without this
      // refusal the convergence fix CREATES a data-loss path that does not exist
      // today, which is strictly worse than the divergence it cures.
      const wall = now();
      const incomingMs = stampMs(parsed.data.updated_at);
      const existing = repo.read(auth.userId, key);
      const existingMs = stampMs(existing?.updated_at);
      if (incomingMs !== null && existingMs !== null && existingMs > incomingMs) {
        // Do not write, do not broadcast — and TELL THE LOSER. It is not an
        // error code: the sender did nothing wrong, it is simply holding an
        // older copy, and the one useful thing we can hand it is the copy that
        // won. A silent `{ok:true}` would leave it believing its stale value is
        // now authoritative — the exact 没有静默失败 shape, in the direction
        // that says a thing was done when it was not.
        // (04 §3.7-a: the same 「输家必须被告知」 rule the retired C5 conflict
        //  verdict was built on.)
        const winner: SettingsUpdatedPayload = withStamp(
          { key, value: existing!.value },
          existing!.updated_at,
        );
        const view = auth.kind === 'mobile' ? mobileView(winner) : winner;
        // `view === null` only for keys a mobile may never hear (credentials /
        // the reserved rename key). Then the loser is NOT told, deliberately:
        // the credential deny-list has ONE definition and this is not the place
        // to invent an exception to it.
        if (view !== null) socket.emit('settings:updated', view);
        return safeAck(ack, { ok: true });
      }

      // The stamp actually STORED: the client's own edit time when it gave one,
      // otherwise this server's clock. Clamped — a stamp from the future would
      // make the row permanently unwritable by the guard above.
      storedAt = incomingMs !== null && incomingMs <= Date.parse(wall) + SETTINGS_STAMP_MAX_SKEW_MS
        ? parsed.data.updated_at!
        : wall;
      repo.write(auth.userId, key, stamped, storedAt);
    } catch {
      return safeAck(ack, { error: 'SETTINGS_SYNC_FAIL' });
    }
    // Peers are told what was STORED, not what was sent — otherwise a second PC
    // would hold a value that differs from the database by exactly the marker.
    // G2 extends that rule to the stamp: the broadcast carries the time that was
    // WRITTEN, not the one that arrived, so a clamped stamp does not reach peers
    // as a moment that never happened.
    broadcastUpdated(io, socket.id, auth.userId, withStamp({ key, value: stamped }, storedAt));
    safeAck(ack, { ok: true });
  });
}
