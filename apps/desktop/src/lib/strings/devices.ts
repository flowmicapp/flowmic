// S string catalogue shard: devices page (channel status / rename / paired
// phones / LAN address selection / account fold).
// Merged and exported by ../strings.ts — that remains the only external entry point.
// V2-07.8a: per-locale catalogue (zh-CN baseline + en). Bilingual terminology
// discipline: 本地局域网 = Local LAN, 云端中继 = Cloud relay — the whole repo
// is allowed only this one pair of words.
import { shardCatalogue } from './shard';

export const DEVICES_KEYS = [
  // devices page
  'dev_title',
  'dev_add_phone',
  // P7 (0.3.1, owner 2026-08-15) — the manual offline switch, top-right of
  // this page (OfflineSwitch.vue) and mirrored in the tray (desktop-rust
  // surface, Msg::TrayGoOffline family). `dev_offline_active` is the on-state
  // truth line: while the switch is on, both sockets are down and the stale
  // channel chips must not be the only thing on screen.
  'dev_offline_toggle',
  'dev_offline_hint',
  'dev_offline_active',
  // Channel terminology discipline (R6 T-2): the whole repo uses only the
  // two terms「本地局域网」("Local LAN") and「云端中继」("Cloud relay").
  'dev_chan_lan',
  'dev_chan_lan_ready',
  'dev_chan_lan_loopback',
  'dev_chan_lan_suspended',
  'dev_chan_lan_failed',
  'dev_chan_cloud',
  'dev_chan_cloud_ready',
  'dev_chan_cloud_no_key',
  'dev_chan_cloud_signed_out',
  // owner 2026-07-30 ②: `dev_chan_inactive` (standing by), `dev_chan_use`
  // (set as primary channel), and `dev_chan_advanced` (advanced) were
  // deleted together — all three describe the user setting "primary
  // channel," which no longer exists.
  // 🔴 owner 2026-08-02 UI batch-1 ①「主通道应该已经不需要，其它的地方也要审查，
  // 如有要去掉，全部要对齐」("primary channel should already be unnecessary;
  // other places must be audited too, and if it's removed, everything must
  // be aligned"): the last survivor, `dev_chan_in_use` ('主通道' / "primary
  // channel"), was deleted too. The two uses that had kept it alive in the
  // previous round — the pairing dialog's tab dot, the connection-
  // diagnostics page's primary badge — both had their labels stripped
  // **at the same time** this round, leaving it with zero producers. Per
  // the established precedent of `INJECT_NO_RECEIPT` /
  // `CLOUD_SESSION_NO_HISTORY`: **a user-visible string with no producer
  // must be retired along with its producer**; it must not be kept around
  // for someone to repurpose for a different question someday. ⚠️ **UI
  // label removal ≠ mechanism removal**: `Admission::primary()` and the
  // CONNECTION frame's `primary` bit are both still running (`store.conn`
  // is the primary channel's copy) — inventory in
  // docs/decisions/2026-08-02-primary-channel-ui-retired-mechanism-inventory.md.
  'dev_chan_connecting',
  // REQ-12-10b — the same-machine grouping shell. The two channel cards
  // describe two channels on **the same computer**, so they live inside a
  // shell that says so. The shell only **states** the fact and never
  // merges: each card still has its own status, its own address, its own
  // actions (same origin as the hard constraint in the mobile side's
  // machine_group.dart).
  'dev_chan_group_title',
  // {n} = the count that's ready right now, {m} = how many cards the shell
  // holds in total (taken from how many cards actually render, not
  // hardcoded to 2).
  'dev_chan_group_ready',
  'dev_chan_group_hint',
  // REQ-12-14 status pill: compresses "is it reachable" from a sentence
  // down to a single word. The word list corresponds one-to-one with the
  // four meanings ChannelCard.dot already spells out in lib/channel.ts; the
  // mapping and its red line are in lib/channel-card-state.ts's file
  // header. ⛔ Do not invent a fifth word here — the pill has no fifth
  // criterion; `连接中…` ("Connecting…") deliberately reuses
  // dev_chan_connecting above.
  'dev_chan_state_ready',
  'dev_chan_state_down',
  'dev_chan_state_off',
  // GA-10 rename (04 §3.7 device.pc_name) — the ONE surface that may change it.
  'dev_rename',
  'dev_rename_hint',
  'dev_rename_save',
  'dev_rename_failed',
  'dev_paired',
  'dev_mobiles_online',
  // R6 T-8: the server-side query (pc:list-mobiles) now exists, so the table is
  // REAL rows instead of the old「仅在线台数」("online-count only") stand-in.
  // The states are kept distinct on purpose — 「读取失败」("failed to read")
  // is not 「一台都没有」("there are zero devices").
  'dev_paired_loading',
  'dev_paired_failed',
  // 🔴 2026-08-02 rework (design doc §2): dev_paired_channel_unreachable
  // (red banner + an internal-reasoning sentence) deleted — unknown ≠
  // error. An unreachable-to-query channel now ① keeps its row, labeled
  // with the neutral 「状态未知」("status unknown") (the three new keys
  // below), ② only drops a single weak-gray explanatory line when even the
  // cache is empty (dev_paired_unlisted, {ch} = channel name).
  'dev_paired_empty',
  'dev_paired_online',
  'dev_paired_offline',
  'dev_paired_unknown',
  'dev_paired_unknown_tip',
  'dev_paired_unlisted',
  'dev_revoke_unreachable',
  'dev_paired_at',
  'dev_paired_last_seen',
  'dev_paired_never',
  // 🔴 owner 2026-08-02 UI batch-1 ②: 「离线」与「最近活动 刚刚」("offline"
  // next to "last active: just now") appearing side by side looks
  // self-contradictory. After tracing the code, the conclusion is that both
  // values are true — they just answer two different questions (per-row
  // wording and the writer are in components/PairedList.vue's
  // lastSeenTitle()). These two entries are what puts both questions into
  // words. ⛔ Do not compress them into a single 「在线状态」("online
  // status") sentence — that would merge the two questions back into one
  // value. Passed the plain-language standard on rework: machine words like
  // "server room" must not appear on the user's screen.
  'dev_paired_online_tip',
  'dev_paired_last_seen_tip',
  // 2026-07-29 polish (D1): rows are GROUPED per physical handset now, so the
  //「同一台手机」chip is gone; this sentence moved to the multi-pairing group
  // header's count-chip tooltip — the fact is the structure, the tooltip says why.
  'dev_group_pairings',
  'dev_group_hint',
  'dev_paired_count',
  'dev_paired_unit',
  'dev_paired_retry',
  // GA-08 「断开｜取消配对」("disconnect | unpair") (revocation has been
  // uniformly called "unpair" since 2026-07-29). The two verbs are spelled
  // out because they are NOT the same act: 断开 ("disconnect") ends this
  // session (the phone comes back on its own after a minute), 取消配对
  // ("unpair") deletes the pairing (the phone must be paired again). The
  // confirmation copy states exactly that consequence — never a bare
  // 「确定吗？」("are you sure?").
  'dev_release',
  'dev_release_hint',
  'dev_revoke',
  'dev_revoke_hint',
  'dev_revoke_confirm',
  'dev_revoke_do',
  'dev_release_cancel',
  'dev_release_failed',
  'dev_self',
  'dev_rename_sync',
  /** GA-21: the endpoint picker beside the LAN card's address. Multi-NIC hosts
   *  (VPN, WSL, an office segment) offer several, and only the owner knows which
   *  one the phone shares. */
  'dev_lan_pick',
  // owner 2026-07-30 ②「局域网显示监听的 IP，多个要全部列出」("the LAN card
  // shows the listening IP; if there are several, list all of them")
  // owner 2026-08-02 UI batch-1 ⑤: the candidate-address list is collapsed
  // by default; this is the control that opens it. The wording uses the
  // verb「修改」("change") rather than「展开地址」("expand address list") —
  // a user clicks it because they want to switch to a different address,
  // not because they want to see a list.
  'dev_lan_edit',
  'dev_lan_listen',
  'dev_lan_in_qr',
  /** A legal private range that is NOT RFC1918 (172.77.x, CGNAT…). Labelled, not
   *  demoted — the demotion is what broke owner's LAN pairing. */
  'dev_lan_nonstandard',
  // devices page cloud-card fold
  'dev_fold_more',
  'dev_fold_less',
  // ⚠️ This used to say 「『设为主通道』住在这个折叠区里 —— 『主通道』徽标常驻，动词离一次
  // 点击」("'set as primary channel' lives inside this fold — the 'primary
  // channel' badge is always on, the verb is one click away"). **Both of
  // those sentences are now false**: the verb was deleted in owner
  // 2026-07-30 ②, the badge was deleted in owner 2026-08-02 UI batch-1 ①.
  // Per this repo's rule that "a comment defending a design decision is
  // itself an assertion that can be falsified by grep," it's been changed
  // to match — leaving a comment describing a control that no longer
  // exists just means the next person cards their work off of it.
  // Two-layer channel status: the card's own line says whether the channel is
  // UP; this second line says whether any phone is actually connected over it
  // (per-channel mobiles from connByChannel — a fact, never derived from role).
  'dev_chan_ready_no_mobiles',
  'dev_chan_ready_mobiles',
  // 2026-07-29 polish (D5): relative labels for the paired table's "last
  // active" column (lib/relative-time.ts); the full stamp moves to the tooltip.
  'dev_time_just_now',
  'dev_time_minutes_ago',
  'dev_time_hours_ago',
  'dev_time_yesterday',
  // MAC-08 plan B (non-Windows only): credentials.bin / credentials-cloud.bin /
  // cloud.bin are the plaintext identity branch of dpapi_protect. Windows has
  // real DPAPI — this sentence must not render there. No imperative: the user
  // cannot encrypt these files today; Keychain is deferred.
  'dev_cred_plaintext_note',
] as const;

// Notes that were recorded against a TRANSLATION rather than against the
// key itself. Carried across verbatim (only the language tag is new): they
// explain a rendering choice in one language, and the block they lived in
// is now a data file that cannot hold them.
// [en] The channel terms are locked in en too: Local LAN / Cloud relay, nothing else.
// [en] REQ-12-10b / REQ-12-14 — see zh-CN for the rules these five obey.
// [en] Suffix after the online count (template: `{{ n }} {{ S.dev_mobiles_online }}`).
// [en] Suffix after the row count: "Paired 3 total · 2 phones online".
// [en] MAC-08 plan B — see zh-CN. Statement of fact; no imperative.
// [ja] REQ-12-10b / REQ-12-14 — 規則は zh-CN 参照。
// [ja] MAC-08 plan B — see zh-CN. Statement of fact; no imperative.
// [ko] REQ-12-10b / REQ-12-14 — 규칙은 zh-CN 참조.
// [ko] MAC-08 plan B — see zh-CN. Statement of fact; no imperative.

export const DEVICES_STRINGS = shardCatalogue(DEVICES_KEYS);
