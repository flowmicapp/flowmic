// S string catalogue shard: pairing dialog (pairing code / QR code /
// refresh). Merged and exported by ../strings.ts.
// V2-07.8a: per-locale catalogue (zh-CN baseline + en).
import { shardCatalogue } from './shard';

export const PAIRING_KEYS = [
  // pairing modal
  'pair_title',
  // REQ-13-21 (owner 2026-08-13): the modal used to stack a 46px code + its own
  // hint line + the QR + a second 「或扫码」("or scan the code") hint — the QR
  // is now the hero and the code is ONE line under it. `pair_code_hint` /
  // `pair_scan_hint` left with their render sites (no producer ⇒ no string,
  // following the INJECT_NO_RECEIPT precedent).
  'pair_code_inline',
  /** Fallback only: shown when the server sent no expiry (GA-18 keeps the TTL a
   *  server fact — the desktop never counts down from a number it invented). */
  'pair_ttl',
  'pair_expires_in',
  'pair_expired_refreshing',
  'pair_loopback',
  'pair_no_code',
  'pair_disconnected',
  // N5 — replaces pair_other_channel（「请先去设备页切换通道」, "please go to
  // the devices page and switch channels first"): the modal now switches
  // the channel itself, so that instruction became a lie. This is the
  // brief window while the newly picked channel's code+address are being
  // read; the modal draws nothing from the previous channel's snapshot in
  // the meantime.
  'pair_switching',
  // owner ⑦: a QR that fails to render must say so, not leave a blank.
  'pair_qr_render_failed',
  'pair_refresh',
  'pair_refresh_failed',
  'pair_close',
  // 0.2.66 — cloud-relay pairing needs two things, a PCID + a pairing code
  // (owner 2026-08-14). The entire job of these entries is to keep people
  // **from confusing the two**: one is this computer's fixed number, safe
  // to read aloud to someone else; the other is a temporary secret that
  // changes every 5 minutes. The wording deliberately avoids the word
  // "password" — the PCID isn't a secret, and calling it a password would
  // make people think it shouldn't be spoken aloud (when speaking it aloud
  // is exactly the point of it existing).
  'pair_pcid_label',
  'pair_pcid_hint',
  'pair_pcid_copy',
  'pair_pcid_copied',
  // A failure must be loud, and offer an alternative action: the number is
  // right there on the screen, and copying it down by hand still works for pairing.
  'pair_pcid_copy_failed',
  // B4-15 — the manual-entry path needs the address to be visible. The QR
  // code already carries every candidate address and the phone picks
  // whichever one works on its own; these lines show the same information
  // to "the person typing it by hand."
  // REQ-13-21: the address block is folded behind this one line by default —
  // the QR already carries every address and a scanning phone picks one by
  // itself; the list serves only the manual-typing path. NOT the settings
  // page's forbidden 「高级折叠」("advanced fold"): nothing here is a setting, it is diagnostic
  // detail. The fold auto-opens on the loud paths (loopback / QR render
  // failure / dropped addresses) so no warning ever hides behind it.
  'pair_addr_toggle',
  'pair_addr_title',
  'pair_addr_in_qr',
  'pair_addr_others',
  'pair_addr_dropped',
  // U8 2026-08-04 — a first-time user hit a dead end here: a 4-digit code with
  // no word about WHERE the thing that reads it comes from, and (cloud tab) a
  // Cloud Key prompt with no pointer to where one is minted. This is shown
  // regardless of channel — both tabs need the phone app installed first.
  'pair_need_app',
  // Link LABEL only — the href comes from `PAIR_APP_URL` below (a plain
  // constant, NOT a locale key: see its comment for why).
  'pair_get_app',
  // The cloud tab's Cloud-Key dead end: `dev_chan_cloud_no_key` (owned by
  // devices.ts, sibling card F5+U11) says a key is needed but not where one
  // comes from. This modal does not own that string, so it adds the pointer
  // as a second line instead of rewriting sibling copy. Domain confirmed LIVE
  // in code: apps/server-core/src/config.ts symbol `DEFAULT_CORS_ORIGIN =
  // 'https://flowmic.app'` (symbol anchor, not a line number: IT-50 —
  // server-core legitimately edits that file and a line-numbered reference
  // from here turns their normal edit into everyone's failing gate);
  // the `/console` path is the one real-device
  // testers actually opened in a browser (docs/strategy/2026-08-02-a2-real-
  // device-sheet.md:348,508 — [measured]) rather than a guess.
  'pair_cloud_console_hint',
] as const;

// Notes that were recorded against a TRANSLATION rather than against the
// key itself. Carried across verbatim (only the language tag is new): they
// explain a rendering choice in one language, and the block they lived in
// is now a data file that cannot hold them.
// [en] Prefix before the countdown (template: `{{ S.pair_expires_in }} {{ countdown }}`).

export const PAIRING_STRINGS = shardCatalogue(PAIRING_KEYS);

// U8 (2026-08-04) — the phone-app download URL, kept behind ONE key so card
// S1 can fill it in in one place once the download page ships. Deliberately
// NOT a PAIRING_STRINGS entry: that catalogue is guarded by
// locale-parity.test.ts's "values are all non-empty strings" rule (every
// locale, every key), and (a) a URL is not translatable content — one value
// serves all four locales, four copies of the same string would just be a
// second place to forget to update, and (b) empty is the ONLY honest value
// today, which that guard would reject outright.
//
// 🔴 FAÇADE GUARD — empty on purpose: the download page lives in the
// undelivered private web console repo. docs/rebuild/09-WEB-SPEC.md:43 records
// that a hardcoded `flowmic.app/dl/...` link ALREADY exists elsewhere in
// this codebase pointing at a route the server does not serve — the exact
// 「404 dressed as success」 shape this repo forbids. PairingModal.vue treats
// '' as "no link yet" and renders `pair_need_app` as plain text with no <a>;
// it only turns `pair_get_app` into a real hyperlink once this is non-empty.
export const PAIR_APP_URL = '';
