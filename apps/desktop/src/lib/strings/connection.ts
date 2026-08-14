// S string catalogue shard: connection state (four-state dot) and the
// connection-diagnostic card / diagnostics page. Merged and exported by
// ../strings.ts.
// V2-07.8a: per-locale catalogue (zh-CN baseline + en); the focus-probe
// block was extracted from inline Chinese in the ConnDiagPage template into
// new keys in this shard (diag_focus_probe / diag_probe_*).
import { shardCatalogue } from './shard';

export const CONNECTION_KEYS = [
  // connection (T-5b four-state dot)
  'conn_offline',
  'conn_online',
  'conn_reconnecting',
  'conn_fault',
  // connection diagnostic card (sidebar click → devices page)
  'diag_endpoint',
  'diag_registered',
  'diag_registered_yes',
  'diag_registered_no',
  'diag_mobiles',
  // Latched, not live: the row survives recovery so the card can explain what
  // just happened. The label must say so, or a green dot beside「故障原因」
  // ("fault reason") reads as a CURRENT fault (no silent failure cuts both
  // ways — no silent false alarms either).
  'diag_loud',
  'diag_machine_uid',
  'diag_machine_uid_unknown',
  // ConnDiagPage (owner 2026-07-26 ①: diagnostics split into its own page)
  'diag_channels',
  'diag_ch_up',
  'diag_ch_down',
  'diag_ch_unknown',
  // REQ-12-12 — local STT/LLM one-shot probe section on ConnDiagPage.
  'diag_engines',
  // V2-01 focus-probe block (extracted in V2-07.8a). The hint is split into
  // two sentences to preserve the <b> emphasis slot — the two languages'
  // word order is compatible at the split point; see en for the full sentence.
  // 🔴 The sole consumer of the ten entries below (diag_focus_probe /
  // diag_probe_*) — the connection-diagnostics page's focus-probe block —
  // has been **temporarily hidden** since owner's 2026-08-02 UI batch-1 ④
  // (the 「V2-01 焦点探测」("V2-01 focus probe") section in
  // `main-window/ConnDiagPage.vue`: both the script and the template are
  // commented out as a block, **the code itself was not deleted**, and the
  // conditions for restoring it are written in place).
  // ⚠️ These ten entries are **deliberately kept**, all four languages
  // intact: they are not 「没有生产方的字符串」("a string with no
  // producer," the kind that should be deleted along with its producer),
  // but the other half of "the producer was temporarily commented out and
  // needs to come back together with it." When the probe block is restored
  // they take effect immediately, with no need to retranslate all four
  // languages. **If focus-probe is ever ruled permanently retired, these
  // ten entries must be deleted along with it.**
  'diag_focus_probe',
  'diag_probe_start',
  /** Countdown suffix: template `{{ n }} {{ S.diag_probe_countdown }}`. */
  'diag_probe_countdown',
  'diag_probe_hint_1a',
  'diag_probe_hint_1b',
  'diag_probe_hint_1c',
  'diag_probe_hint_2a',
  'diag_probe_hint_2b',
  'diag_probe_failed',
  'diag_probe_paste_hint',
] as const;

export const CONNECTION_STRINGS = shardCatalogue(CONNECTION_KEYS);
