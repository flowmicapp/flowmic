// NR-130 (MAIN 2026-09-29; design = diag-0100 failure 2, "server fact for the
// desktop") — "the model set up for this account was refused by its provider".
//
// WHY THIS EXISTS: the desktop's devices-page notice may only say what the
// server that runs LAN polish knows (book 15 R11). `capability.llm.usable`
// answers "can a config be resolved"; it cannot answer "did the provider accept
// it", because that is only learned by calling the provider. The polish bridge
// learns it on every terminal final, so it records it here and the settings
// read (settings.handler.ts, via stt-polish-settings.ts `llmCapabilityFact`)
// reports it as `capability.llm.rejected`.
//
// WHAT IS REMEMBERED: a fingerprint of the exact config that was refused
// (protocol, endpoint, model, sha-256 of the key). The fact is reported only
// while the config the resolver returns NOW has the same fingerprint, so ANY
// edit of the model settings — from the desktop, the console or a test — ends
// it without a hook in every writer. A later polish run that the provider
// answered (applied, or a model reply our guard refused) clears it too.
// Timeouts and rate limits leave it alone: they say nothing about the config.
//
// In memory, per process, per user. On a restart the fact is simply unknown
// until the next polish run, which is the honest answer.

import { createHash } from 'node:crypto';
import type { LlmConfig } from '@flowmic/protocol';
import type { PolishWireSignal } from './stt-polish';

/** Bound on remembered accounts. A relay can host many users; the LAN sidecar
 *  has one. Oldest entry goes first — it is a hint, not a record. */
const MAX_USERS = 10_000;

const refused = new Map<string, string>();
const listeners = new Set<(userId: string) => void>();

/** Stable fingerprint of a config. The key is hashed, never held in clear. */
export function llmConfigFingerprint(cfg: LlmConfig): string {
  const keyHash = createHash('sha256').update(cfg.api_key).digest('hex');
  return JSON.stringify([cfg.protocol, cfg.endpoint.trim(), cfg.model.trim(), keyHash]);
}

function set(userId: string, fp: string | null): void {
  const before = refused.get(userId) ?? null;
  if (before === fp) return;
  if (fp === null) refused.delete(userId);
  else {
    refused.delete(userId);
    refused.set(userId, fp);
    if (refused.size > MAX_USERS) {
      const oldest = refused.keys().next().value;
      if (oldest !== undefined) refused.delete(oldest);
    }
  }
  for (const fn of listeners) {
    try { fn(userId); } catch { /* A listener cannot break the polish path. */ }
  }
}

/**
 * Called by the polish bridge (engine/stt-session.ts `runPolishedFinal`) with the
 * signal it is about to put on the wire and the config the run used.
 * `model_rejected` ⇒ remember; a run the provider answered ⇒ forget;
 * `timeout` / `llm_error` ⇒ no change.
 */
export function observePolishSignal(userId: string, cfg: LlmConfig, signal: PolishWireSignal): void {
  if (signal.polish === 'applied') return set(userId, null);
  switch (signal.polish_reason) {
    case 'model_rejected': return set(userId, llmConfigFingerprint(cfg));
    case 'guard_reject':
    case 'empty_output': return set(userId, null);
    default: return;
  }
}

/** True only while `current` is the very config that was refused. */
export function isLlmConfigRejected(userId: string, current: LlmConfig): boolean {
  const fp = refused.get(userId);
  return fp !== undefined && fp === llmConfigFingerprint(current);
}

/** Subscribe to "this user's rejected fact may have changed". Returns unsubscribe.
 *  Production subscriber: settings.handler.ts `wireLlmCapabilityPush`. */
export function onLlmRejectChange(fn: (userId: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Test-only reset. */
export function __resetLlmRejectLatchForTest(): void {
  refused.clear();
  listeners.clear();
}
