// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §8 (settings keys + 200ms debounce + localStorage
//     cache + durable change-queue disconnect-replay; no Save button)
//   docs/decisions/2026-07-23-settings-key-drift-literal-anchors.md (this file's
//     three literal-key SET anchors close the drift lint loop for WP-R2-2)
//   packages/protocol/src/protocol-schemas-sync.ts (SettingsUpdate {key, value})
//   CLAUDE.md red line: settings save the instant they change, no save button; no silent failure (offline → saved locally)
//
// The desktop → server settings writer, mirroring apps/mobile SettingsClient:
//
//  1. LITERAL-KEY SET ANCHORS (settings-key-drift lint). `setLlmConfig` and
//     `setSttRoutings` are the ONLY places in apps/desktop that name a settings
//     key as a string literal — `updateSetting('llm.config' | …)` — so the drift
//     lint's SET regex has real writers to pair with the server's
//     readSetting('llm.config') / readSetting('stt.routings') GET anchors. Every
//     other reference uses the SETTINGS_ANCHOR_KEYS constants; a test pins each
//     literal == its constant. A key with no server reader MUST NOT use this
//     literal form (it would be a set-only orphan) — it goes through
//     updateSetting with a variable key.
//     🔴 THE OTHER THREE ANCHORS LEFT ON 2026-09-03 (owner ruling, phone-owned
//     preferences). `setScenarioCard` / `setSttPolish` / `setSttRefine` were
//     deleted with the screens that called them; `scenario.card` / `stt.polish`
//     / `stt.refine` are still READ by the server, and their literal SET anchors
//     now live on the phone (apps/mobile/lib/src/settings/settings_client.dart
//     `pushScenarioCard` / `pushPolish` / `pushRefine`). The drift lint scans
//     apps/desktop AND apps/mobile as one UI side, so the pairs are intact —
//     and a fake anchor invented here to 「keep the lint happy」 would be a
//     writer for a key this server refuses from a PC.
//
//  2. Save-on-change (即改即存) = cache-first (durable) + 200ms-debounced wire push + fail-loud
//     offline. updateSetting writes the durable cache synchronously (survives a
//     restart / offline edit), then debounces the settings:update. A push that
//     fails (socket down) marks the key PENDING — surfaced as SETTINGS_SYNC_FAIL
//     「已存本地」("saved locally"), never a silent drop — and is re-flushed the instant the socket
//     reconnects (call flushPending on the connected rising edge).
//
//  3. 🔴 `updated_at` — WHEN THE USER EDITED, minted HERE (card C3). Until this
//     card the desktop sent no stamp at all, and the consequence was not
//     symmetry but a one-directional guard: with nothing to compare, the
//     server's regress check — the `existingMs > incomingMs` guard in
//     settings.handler.ts — can never fire against a desktop write, so a stale
//     offline edit replayed on reconnect still clobbers a newer value.
//     ⚠️ It was written FOR `scenario.card`, which had two writers. That key is
//     the phone's alone since 2026-09-03, so the two remaining keys have one
//     writer each per server and the guard has nothing to arbitrate TODAY. The
//     stamp is kept anyway, and not because of symmetry: a second PC signed into
//     the same account is a second writer of `llm.config`, and the durable queue
//     can still replay a week-old `stt.routings` edit onto a server that has
//     moved on. Removing it would restore exactly the one-directional guard
//     described above.
//     · The stamp is minted in `updateSetting`, i.e. at the moment of the edit,
//       and it is what the DRAIN sends. A queue that re-stamped on drain would
//       say "the user changed this the instant the network came back", which is
//       false and is precisely the claim that makes the stale replay win.
//     · It is persisted with the queue, so an edit made offline and replayed
//       after a restart still carries its own moment rather than the reboot's.
//     · It is corrected for this machine's clock skew (settings-stamp.ts). The
//       stamp is only meaningful against another machine's clock, so a lagging
//       clock silently loses arbitrations it should win.
//     · Absent stays UNKNOWN: a key with no recorded edit moment (a queue
//       hydrated from a pre-C3 session) is sent without a stamp and gets exactly
//       the pre-C3 behaviour — written unconditionally.

import type { KvStore, SettingsTransport } from './types';
import { KeyedDebouncer } from './debounce';
import { SettingsStampClock } from './settings-stamp';

/** The keys THIS end writes and the server reads — each gets one literal SET
 *  anchor below. The phone-owned keys (`scenario.card` / `stt.polish` /
 *  `stt.refine`) are deliberately absent: they are read by the server and
 *  written by the phone, and listing them here would make
 *  `applyServerSettings`'s exhaustiveness pin demand a desktop case for a value
 *  no desktop screen shows. */
export const SETTINGS_ANCHOR_KEYS = {
  llmConfig: 'llm.config',
  sttRoutings: 'stt.routings',
} as const;

/** Durable queue localStorage key (a device-local cache — never the wire). */
const QUEUE_KEY = 'flowmic.settings.queue';

/** 🔴 KEYS THIS END MUST NEVER SEND AGAIN (owner ruling, 2026-09-03).
 *
 *  The server-side twin is `PHONE_OWNED_SETTING_KEYS` +
 *  `RETIRED_SETTING_KEY_STT_DICTIONARY` in
 *  apps/server-core/src/settings/session-overlay.ts, and the settings handler
 *  refuses every one of them from a PC socket ("key is phone-owned").
 *  Deliberately literal strings rather than an import: the protocol package
 *  exports `PhonePrefsSchema` (the four keys as a zod SHAPE, for the wire
 *  bundle) but no key LIST, and it knows nothing about the retired
 *  `stt.dictionary` — so this is a local statement pinned against
 *  `PhonePrefsSchema.shape` in settings-client.test.ts rather than a copy
 *  nobody checks.
 *
 *  Why the prune has to exist at all: `latest` is DURABLE. A queue written by
 *  a build <= 0.3.59 — which still had the desktop panes for these keys — is
 *  hydrated by this build and replayed by `flushPending` on EVERY LAN
 *  `connected` rising edge. The server refuses each one, `flushPending` marks
 *  the key dirty, and `pending` latches "saved locally" forever for a value no
 *  desktop screen shows and no server will ever store. Observed on a real
 *  device: the LAN sidecar's server.log logs
 *  `settings:update refused — key is phone-owned … {"key":"stt.polish"}`
 *  seconds after every desktop launch.
 *
 *  ⚠️ Scope: the durable CHANGE QUEUE only. The `flowmic.ui.*` display caches
 *  are untouched — they are read-side mirrors, never a wire replay source. */
const RETIRED_PHONE_OWNED_KEYS: readonly string[] = [
  'scenario.card',
  'stt.polish',
  'stt.refine',
  'scenario.inference',
  'stt.dictionary',
];

function isRetiredPhoneOwnedKey(key: string): boolean {
  return RETIRED_PHONE_OWNED_KEYS.includes(key);
}

interface QueueSnapshot {
  latest: Record<string, unknown>;
  dirty: string[];
  /** C3: per-key edit moment. Optional on read so a queue written by a pre-C3
   *  build hydrates as "no stamp" = UNKNOWN rather than as a fabricated one. */
  stamps?: Record<string, string>;
}

export class SettingsClient {
  /** Last value pushed per key; re-sent on reconnect (last-write-wins). */
  private readonly latest = new Map<string, unknown>();
  /** When the user made the edit held in `latest` for that key. Kept beside the
   *  value rather than inside it: `updated_at` is a WIRE sibling of `value`
   *  (`It is deliberately a SIBLING of value` in protocol-schemas-sync.ts), and
   *  burying it would push it through the
   *  settings model's value parsers, which have no business reading it. */
  private readonly stamps = new Map<string, string>();
  /** Keys whose latest value has NOT reached a live wire (failed emit / offline).
   *  This is the fail-loud pending set surfaced as 「已存本地」("saved locally"). */
  private readonly dirty = new Set<string>();
  /** E4 — keys with a `flushKey` network call currently in flight. Covers the
   *  gap `dirty` cannot: a key that is neither debounce-armed nor yet failed
   *  (or succeeded) is, for the duration of the await, indistinguishable from
   *  "nothing is happening" unless something says otherwise. */
  private readonly inFlight = new Set<string>();
  private readonly debouncer: KeyedDebouncer;
  private readonly listeners = new Set<() => void>();
  private readonly clock: SettingsStampClock;

  constructor(
    private readonly transport: SettingsTransport,
    private readonly store: KvStore,
    debounceMs = 200,
    now: () => number = Date.now,
  ) {
    this.debouncer = new KeyedDebouncer(debounceMs);
    this.clock = new SettingsStampClock(now);
    this.hydrate();
  }

  private hydrate(): void {
    const raw = this.store.get(QUEUE_KEY);
    if (raw === null) return;
    try {
      const snap = JSON.parse(raw) as QueueSnapshot;
      let pruned = false;
      const keep = (k: string): boolean => {
        if (!isRetiredPhoneOwnedKey(k)) return true;
        pruned = true;
        return false;
      };
      for (const [k, v] of Object.entries(snap.latest ?? {})) {
        if (keep(k)) this.latest.set(k, v);
      }
      for (const k of snap.dirty ?? []) {
        if (keep(k)) this.dirty.add(k);
      }
      for (const [k, s] of Object.entries(snap.stamps ?? {})) {
        if (typeof s === 'string' && s.length > 0 && keep(k)) this.stamps.set(k, s);
      }
      // One-time cache migration: write the pruned snapshot back NOW rather
      // than waiting for the next edit. Without this, a build that only
      // filtered on the way out would still carry the dead keys in storage,
      // and any future code path that reads the raw snapshot (or a rollback to
      // <= 0.3.59) would resurrect the replay loop.
      if (pruned) this.persist();
    } catch {
      // Corrupt cache degrades to empty — never throws into the UI.
    }
  }

  private persist(): void {
    const snap: QueueSnapshot = {
      latest: Object.fromEntries(this.latest),
      dirty: [...this.dirty],
      stamps: Object.fromEntries(this.stamps),
    };
    this.store.set(QUEUE_KEY, JSON.stringify(snap));
  }

  /** Feed one stamp observed from the server so this machine can measure how far
   *  its own clock lags the timebase its writes are judged against. The one
   *  production caller is `applyServerSettings` (settings-model.ts), which sees
   *  every settings:list item — including the loser frame's value, which reaches
   *  it as a settings:updated notification followed by a re-pull. Reasoning and
   *  the bound on the correction are in settings-stamp.ts. */
  observeStamp(updatedAt: string | null | undefined): void {
    this.clock.observe(updatedAt);
  }

  /** The skew correction in force, ms. Exposed for tests and diagnostics. */
  get stampCorrectionMs(): number {
    return this.clock.correctionMs;
  }

  /** True while ANY key is still waiting to sync (offline). */
  get pending(): boolean {
    return this.dirty.size > 0;
  }

  // E4 (2026-09-02) — `isKeyPending` used to answer ONLY "did the last flush
  // attempt for this key fail" (`dirty`). That leaves a real window open:
  // `updateSetting` debounces 200ms before it even TRIES to flush, and the
  // flush itself awaits a network round trip — for the whole of both spans the
  // edit is neither flushed nor (yet) marked dirty, so `isKeyPending` said
  // false about a key the user had, in fact, just changed. `applyServerSettings`
  // (settings-model.ts) trusts this exact flag to decide whether an incoming
  // server snapshot should overwrite the local value; a `settings:updated` push
  // for an UNRELATED key (any key on the same settings:list, since the pull
  // fetches the whole snapshot) landing inside that window carried the
  // pre-edit value for THIS key too, and it wrote right over what the user had
  // just typed — `KeyedDebouncer.pending()` already answered the debounce half
  // of this and had zero callers (findings-desktop-fe.md P1 #3).
  isKeyPending(key: string): boolean {
    return this.dirty.has(key) || this.debouncer.pending(key) || this.inFlight.has(key);
  }

  onPending(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  /** Generic settings:update — VARIABLE key. The sole literal-key callers are the
   *  four anchor methods below, by design (drift-lint SET anchors). */
  updateSetting(key: string, value: unknown): void {
    // A phone-owned / retired key never enters the durable queue. No-op with a
    // console warning rather than a throw: this client's other failure mode
    // (a corrupt cache) also degrades quietly and "never throws into the UI",
    // and there is no user-facing story here — no desktop screen writes these
    // keys any more, so a caller reaching this line is a code defect, not a
    // user action to report.
    if (isRetiredPhoneOwnedKey(key)) {
      console.warn(
        `[settings] refusing to queue '${key}': phone-owned/retired key; `
        + 'the server refuses it from a PC and no desktop screen writes it',
      );
      return;
    }
    this.latest.set(key, value);
    // THE stamp is minted here and nowhere else: this call IS the moment a human
    // changed the value, which is the only thing `updated_at` is allowed to
    // mean. Not at flush time — a debounce of 200ms would be a harmless lie, but
    // the same code path drains a queue that may be a day old, and there the lie
    // is what makes a stale edit win.
    this.stamps.set(key, this.clock.nowIso());
    this.persist(); // durable first — the edit survives restart / offline
    this.debouncer.run(key, () => {
      void this.flushKey(key);
    });
  }

  // ── the two literal-key SET anchors (settings-key-drift lint) ──
  setLlmConfig(value: unknown): void {
    this.updateSetting('llm.config', value);
  }
  setSttRoutings(value: unknown): void {
    this.updateSetting('stt.routings', value);
  }

  private async flushKey(key: string): Promise<void> {
    // E4 — marked BEFORE the await, cleared in `finally` so a throwing
    // transport still releases it: the whole point is that `isKeyPending`
    // must see this key as pending for the full lifetime of the network call,
    // not just once it has already failed.
    this.inFlight.add(key);
    let ok = false;
    try {
      ok = await this.transport.settingsUpdate(key, this.latest.get(key), this.stamps.get(key));
    } catch {
      ok = false;
    } finally {
      this.inFlight.delete(key);
    }
    if (ok) this.dirty.delete(key);
    else this.dirty.add(key);
    this.persist();
    this.notify();
  }

  /** Re-flush every remembered key on the connected rising edge (07 §8 durable
   *  replay). Idempotent server-side (upsert), so re-sending is safe.
   *
   *  🔴 C3 — each key is replayed with the stamp of ITS OWN EDIT, which is what
   *  makes this loop safe rather than merely idempotent. `latest` survives
   *  restarts, so this can replay an edit made a week ago; re-stamping it here
   *  would announce a week-old value as the newest write on the account and
   *  overwrite whatever the phone has done since. With the real edit moment
   *  attached, the server refuses it (the `existingMs > incomingMs` guard in
   *  settings.handler.ts) and hands back the value that won. */
  // E4 (2026-09-02) test-only escape hatch. `settings` (main-window/store.ts)
  // is a MODULE SINGLETON shared by every test in a worker process — real
  // `setTimeout`, not fake, since most of this client's suite runs against
  // wall-clock debounce. Before `isKeyPending` read the debouncer, an armed
  // timer left over from a PRECEDING test's `updateSetting` call for the same
  // key was invisible to `applyServerSettings`; after E4 it correctly answers
  // "yes, pending" — which surfaced two unrelated tests
  // (stt-routing-order.test.ts and, until 2026-09-03, the consent suite) that
  // write a key in one `it()` and then call
  // `applyServerSettings` for that SAME key in the next, with no reset of this
  // singleton between them and often well under 200ms of real wall-clock time
  // between the two. That is a test-isolation gap, not a reason to weaken
  // `isKeyPending` — the fix is here, called from those suites' `beforeEach`.
  cancelPendingDebouncesForTest(): void {
    this.debouncer.clearAll();
  }

  async flushPending(): Promise<void> {
    for (const [key, value] of this.latest) {
      // Belt and braces with the hydrate-time prune: this is the loop that ran
      // on every reconnect, so it refuses the dead keys itself rather than
      // trusting that nothing upstream put one back into `latest`.
      if (isRetiredPhoneOwnedKey(key)) {
        this.latest.delete(key);
        this.dirty.delete(key);
        this.stamps.delete(key);
        continue;
      }
      let ok = false;
      try {
        ok = await this.transport.settingsUpdate(key, value, this.stamps.get(key));
      } catch {
        ok = false;
      }
      if (ok) this.dirty.delete(key);
      else this.dirty.add(key);
    }
    this.persist();
    this.notify();
  }
}
