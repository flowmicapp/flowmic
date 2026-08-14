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

import type { KvStore, SettingsTransport } from './types';
import { KeyedDebouncer } from './debounce';

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
}

export class SettingsClient {
  /** Last value pushed per key; re-sent on reconnect (last-write-wins). */
  private readonly latest = new Map<string, unknown>();
  /** Keys whose latest value has NOT reached a live wire (failed emit / offline).
   *  This is the fail-loud pending set surfaced as 「已存本地」("saved locally"). */
  private readonly dirty = new Set<string>();
  private readonly debouncer: KeyedDebouncer;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly transport: SettingsTransport,
    private readonly store: KvStore,
    debounceMs = 200,
  ) {
    this.debouncer = new KeyedDebouncer(debounceMs);
    this.hydrate();
  }

  private hydrate(): void {
    const raw = this.store.get(QUEUE_KEY);
    if (raw === null) return;
    try {
      const snap = JSON.parse(raw) as QueueSnapshot;
      for (const [k, v] of Object.entries(snap.latest ?? {})) this.latest.set(k, v);
      for (const k of snap.dirty ?? []) this.dirty.add(k);
    } catch {
      // Corrupt cache degrades to empty — never throws into the UI.
    }
  }

  private persist(): void {
    const snap: QueueSnapshot = {
      latest: Object.fromEntries(this.latest),
      dirty: [...this.dirty],
    };
    this.store.set(QUEUE_KEY, JSON.stringify(snap));
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
  /** WP-R4-6 ⑥ — opt-in AI polish; wire value is `{enabled: boolean}`. */
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
      ok = await this.transport.settingsUpdate(key, this.latest.get(key));
    } catch {
      ok = false;
    }
    if (ok) this.dirty.delete(key);
    else this.dirty.add(key);
    this.persist();
    this.notify();
  }

  /** Re-flush every remembered key on the connected rising edge (07 §8 durable
   *  replay). Idempotent server-side (upsert), so re-sending is safe. */
  async flushPending(): Promise<void> {
    for (const [key, value] of this.latest) {
      let ok = false;
      try {
        ok = await this.transport.settingsUpdate(key, value);
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
