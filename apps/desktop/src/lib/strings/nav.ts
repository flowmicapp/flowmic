// S string catalogue shard: nav / app name. Merged and exported by
// ../strings.ts — that remains the only external entry point.
// V2-07.8a: per-locale catalogue. zh-CN is the baseline (it defines the key
// set), en matches it key-for-key; key completeness is guarded by
// locale-parity.test.ts (missing keys are printed by name). When adding
// ja/ko, add a matching same-key table here for each.
import { shardCatalogue } from './shard';

export const NAV_KEYS = [
  // nav
  'nav_devices',
  'nav_timeline',
  'nav_settings',
  'app_name',
  // Custom titlebar window controls (owner 2026-08-21: the native Windows
  // titlebar is hidden; these are the aria-labels/tooltips of our own buttons).
  'win_minimize',
  'win_maximize',
  'win_restore',
  'win_close',
  // 0.3.24 — app-global, which is why it lives in this shard and not in
  // `update`/`disclosure`/`pairing`: it is what EVERY external link says when
  // the OS would not take the address, and it is always followed by the address
  // itself. Three pages use it today. It exists because until 0.3.24 an
  // external link in this app opened nothing at all and said nothing at all
  // (src-tauri/src/shell/external_open.rs) — replacing that silence with a
  // rarer silence would not have been a fix.
  'ext_open_failed',
] as const;

// Notes that were recorded against a TRANSLATION rather than against the
// key itself. Carried across verbatim (only the language tag is new): they
// explain a rendering choice in one language, and the block they lived in
// is now a data file that cannot hold them.
// [en] FlowMic is not translated.

export const NAV_STRINGS = shardCatalogue(NAV_KEYS);
