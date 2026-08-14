// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §5 (`stt.routings` / `stt.byok_enabled`)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §4 (BYOK = user-authored routing)
//   settings/provenance.ts (seed vs user — GET must not show platform seeds
//     as if the owner typed them)
//   *** HUMAN-AUDIT SENSITIVE (auth-adjacent: BYOK keys + probe dial) ***
//
// Console BYOK policy. Three questions, three functions — never one value
// answering two of them:
//   · What does a brand-new SaaS account store?          seedSaasByokEmpty
//   · May the engine router use the user's own rows?     isByokEnabled
//   · Which rows may the console editor display?         authoredRoutings
//
// 🔴 SaaS register used to call seedDefaultSettings, which writes the stock
// STT presets (sherpa-local, or whatever FLOWMIC_DEFAULT_STT_*_PRESET names).
// Those rows are `provenance:'seed'` so they do not steal traffic from the
// managed default — but GET /api/cloud/stt-routings returned them verbatim, so
// a new account's BYOK page looked pre-filled. Owner 2026-08-14: the page
// starts empty; the user configures it. This module writes `[]` + `false`
// BEFORE seedDefaultSettings so the existing key is not overwritten.

import { isSeedMarked, STT_ROUTINGS_KEY } from './provenance';
import type { SettingsRepo } from '../db/repos/settings.repo';

/** Console master switch. Absent ⇒ do not change existing routing behaviour
 *  (standalone seeds and already-configured BYOK keep working). `false` is
 *  written explicitly on SaaS register. */
export const BYOK_ENABLED_KEY = 'stt.byok_enabled';

/** Rows the console may show or echo — platform seeds are not the user's. */
export function authoredRoutings(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row) => !isSeedMarked(row));
}

/**
 * Engine-router question. Absent is TRUE on purpose: a desktop / pre-switch
 * account must keep today's selection. Only an explicit `false` (the SaaS
 * register write, or the console toggle) drops user-authored rows.
 */
export function isByokEnabled(settings: SettingsRepo, userId: string): boolean {
  const row = settings.read(userId, BYOK_ENABLED_KEY);
  if (row === null) return true;
  return row.value === true;
}

/**
 * What the console paints for the switch. Distinct from {@link isByokEnabled}:
 * a missing key on an account that already has user rows must show ON
 * (grandfather), and a missing key with no user rows must show OFF (empty
 * page). Routing does not use this function.
 */
export function consoleByokEnabled(settings: SettingsRepo, userId: string, authored: readonly unknown[]): boolean {
  const row = settings.read(userId, BYOK_ENABLED_KEY);
  if (row !== null) return row.value === true;
  return authored.length > 0;
}

/** First-write only. Never overwrites a row the user (or an older seed) owns. */
export function seedSaasByokEmpty(repo: SettingsRepo, userId: string): string[] {
  const written: string[] = [];
  if (repo.read(userId, STT_ROUTINGS_KEY) === null) {
    repo.write(userId, STT_ROUTINGS_KEY, []);
    written.push(STT_ROUTINGS_KEY);
  }
  if (repo.read(userId, BYOK_ENABLED_KEY) === null) {
    repo.write(userId, BYOK_ENABLED_KEY, false);
    written.push(BYOK_ENABLED_KEY);
  }
  return written;
}

/**
 * Cloud TEST may not turn the VPS into a loopback / metadata scanner.
 * RFC1918 is allowed: a user's engine may live on a network the relay can
 * already reach (the owner's own VPN path is the existence proof).
 */
export function byokProbeEndpointAllowed(endpoint: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = endpoint.trim();
  if (trimmed === '') return { ok: false, reason: 'endpoint required' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'endpoint is not a URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return { ok: false, reason: 'endpoint scheme must be http(s) or ws(s)' };
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return { ok: false, reason: 'endpoint must be reachable from FlowMic servers — loopback is not' };
  }
  if (host === '169.254.169.254' || host === 'metadata.google.internal') {
    return { ok: false, reason: 'this address is not a valid engine endpoint' };
  }
  return { ok: true };
}
