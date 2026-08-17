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
//  1. LITERAL-KEY SET ANCHORS (settings-key-drift lint). `setLlmConfig` /
//     `setSttRoutings` / `setScenarioCard` / `setSttPolish` are the ONLY places
//     in apps/desktop that name a settings key as a string literal —
//     `updateSetting('llm.config' | …)` — so the drift lint's SET regex has real
//     writers to pair with the server's readSetting('llm.config') /
//     readSetting('stt.routings') / readSetting('scenario.card') /
//     readSetting('stt.polish') GET anchors. Every other reference uses the
//     SETTINGS_ANCHOR_KEYS constants; a test pins each literal == its constant
//     (and scenario.card == the SETTINGS_KEY_SCENARIO_CARD protocol SSOT). A key
//     with no server reader (e.g. stt.dictionary) MUST NOT use this literal form
//     (it would be a set-only orphan) — it goes through updateSetting with a
//     variable key.
//
//  2. Save-on-change (即改即存) = cache-first (durable) + 200ms-debounced wire push + fail-loud
//     offline. updateSetting writes the durable cache synchronously (survives a
//     restart / offline edit), then debounces the settings:update. A push that
//     fails (socket down) marks the key PENDING — surfaced as SETTINGS_SYNC_FAIL
//     「已存本地」("saved locally"), never a silent drop — and is re-flushed the instant the socket
//     reconnects (call flushPending on the connected rising edge).
//
//  3. 🔴 `updated_at` — WHEN THE USER EDITED, minted HERE (card C3). This client
//     is the SECOND writer of `scenario.card`; the phone is the first
//     (apps/mobile/lib/src/settings/scenario_card_controller.dart). Until this
//     card the desktop sent no stamp at all, and the consequence was not
//     symmetry but a one-directional guard: with nothing to compare, the
//     server's regress check — the `existingMs > incomingMs` guard in
//     settings.handler.ts — can never fire against a desktop write, so a stale
//     offline edit replayed on reconnect still clobbers a card the phone edited
//     five minutes ago.
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

/** The keys with a real server reader — each gets one literal SET anchor. */
export const SETTINGS_ANCHOR_KEYS = {
  llmConfig: 'llm.config',
  sttRoutings: 'stt.routings',
  scenarioCard: 'scenario.card',
  sttPolish: 'stt.polish',
  sttRefine: 'stt.refine',
} as const;

/** Durable queue localStorage key (a device-local cache — never the wire). */
const QUEUE_KEY = 'flowmic.settings.queue';

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
      for (const [k, v] of Object.entries(snap.latest ?? {})) this.latest.set(k, v);
      for (const k of snap.dirty ?? []) this.dirty.add(k);
      for (const [k, s] of Object.entries(snap.stamps ?? {})) {
        if (typeof s === 'string' && s.length > 0) this.stamps.set(k, s);
      }
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

  isKeyPending(key: string): boolean {
    return this.dirty.has(key);
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

  // ── the four literal-key SET anchors (settings-key-drift lint) ──
  setLlmConfig(value: unknown): void {
    this.updateSetting('llm.config', value);
  }
  setSttRoutings(value: unknown): void {
    this.updateSetting('stt.routings', value);
  }
  setScenarioCard(value: unknown): void {
    this.updateSetting('scenario.card', value);
  }
  /** WP-R4-6 ⑥ — opt-in AI polish; wire value is `{enabled: boolean,
   *  strength?: 'strict'|'smooth'}` (`SttPolishSchema` is the contract; C8
   *  added `strength`, absent means strict). */
  setSttPolish(value: unknown): void {
    this.updateSetting('stt.polish', value);
  }
  /** GA-14 — opt-in two-pass refine; wire value is
   *  `{enabled: boolean, min_utterance_ms?: number}`. */
  setSttRefine(value: unknown): void {
    this.updateSetting('stt.refine', value);
  }

  private async flushKey(key: string): Promise<void> {
    let ok = false;
    try {
      ok = await this.transport.settingsUpdate(key, this.latest.get(key), this.stamps.get(key));
    } catch {
      ok = false;
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
  async flushPending(): Promise<void> {
    for (const [key, value] of this.latest) {
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
