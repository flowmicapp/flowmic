// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §1 (transport / topology),
//     §2 (handshake / version negotiation), §7 (protocol evolution)
//   docs/decisions/2026-07-23-wp-r0-1-protocol-rename-window.md
//
// Endpoint constants. SaaS endpoint is fixed and MUST NOT be overridable
// from the client UI when the client runs in 'saas' mode.
//
// Consumers: desktop lib/channel.ts (DEFAULT_CLOUD_ENDPOINT) and, as a
// documented hand-mirror, mobile auth/saas_endpoint.dart.
//
// The three siblings that shipped alongside it — DEFAULT_SAAS_WS_ENDPOINT,
// DEFAULT_STANDALONE_ENDPOINT, DEFAULT_STANDALONE_WS_ENDPOINT — were removed on
// 2026-07-31 (stage-5 cleanup): a repo-wide grep found zero readers on any end.
// They were never merely unused, they were WRONG for this line and would have
// misled the next reader: socket.io upgrades an http:// origin, so the ws://
// form is DERIVED where it is needed (desktop lib/pairing.ts toWsUrl) and a
// second constant could only drift from it; and a standalone endpoint has to
// name the machine's real LAN host, because the phone that scans the pairing
// code cannot reach the PC's `localhost`. Re-adding any of the three means
// re-deciding that, which is the point of removing them.
export const DEFAULT_SAAS_ENDPOINT = 'https://flowmic.app';

// V2.0 timeline E2EE (A-49 / F-3005 / F-3008 redline). Ciphertext persisted in
// timeline_blobs.ciphertext (and the timeline:grant wrap) MUST carry this
// prefix. STRICTLY distinct from F-705's server-decryptable 'enc:v1:'
// prefix -- the two are never interchangeable.
export const TIMELINE_E2E_PREFIX = 'e2e:v1:';

// Handshake-level protocol schema version (F-3092/F-3093, 04-PROTOCOL-SPEC.md
// §2 + §7.4). WP-R0-1 reset it to 1 for the fresh 0.1.0 line; WP-R1-1 bumps it
// 1→2 for this additive rev (status `noted` + `edited` overlay, audio:start
// `delivery`, scenario-card settings). Sent by clients as the optional
// `schema_ver` field on `socket.handshake.auth` (a handshake field, NOT a
// socket.io event, so it needs no whitelist entry) and echoed back on the
// register/pair acks. A client that omits it is treated as schema_ver=1 by the
// server — never rejected (the design's explicit "degrade, don't break"
// intent, P-v2-1). The bump is capability-negotiation metadata only; every v2
// field is additive/optional, so a v1 peer still interoperates by ignoring
// fields it does not know.
export const PROTOCOL_SCHEMA_VERSION = 2;

// The version of the PLAINTEXT ENTRY PAYLOAD sealed inside an EncryptedBlob's
// ciphertext, carried as `schema_ver` on the blob envelope (§3.8). This is a
// DIFFERENT number from PROTOCOL_SCHEMA_VERSION above (handshake-level
// capability negotiation) and the two move independently. It describes the
// entry payload shape carried by this package's TimelineEntry —
//   v2 = a payload carrying processed_text / process_mode / process_params /
//        inject_target (null-defaulted when unset),
// which is exactly the shape shipped in src/types.ts. Both compatibility
// directions are mandatory and neither may raise: an old client ignores fields
// it does not know; a new client reading a v1 payload takes the null defaults
// (see timeline-payload.ts). The server never inspects this integer — it
// stores and returns it verbatim.
// WP-R0-1 (owner ruling): this stays at 2 and is NOT reset. It marks the
// lineage of the ciphertext-inner entry format — the v2r2 fields carry over
// from the old line, preserving semantic continuity for data migration — and
// is fully independent of the handshake-level PROTOCOL_SCHEMA_VERSION (reset
// to 1 for the fresh line).
export const TIMELINE_ENTRY_SCHEMA_VERSION = 2;

// ─── WP-R1-1 settings keys (destination / scenario model) ───────────────────
// Canonical user_settings KV key names introduced by this rev. DEFINED here;
// this package only NAMES them — it never sets or reads them. The consumer that
// PRODUCES each key is recorded below as the anti-façade accountability anchor
// (a key with no live producer is this project's #1 historical bug class).
//
// `scenario.card` — JSON value = a ScenarioCard (see src/scenario.ts).
//   Producer/consumer: WP-R1-4 compose pipeline (renders the card as a
//   delimited "background data, not instructions" block into the correction /
//   compose prompt).
export const SETTINGS_KEY_SCENARIO_CARD = 'scenario.card';
// `stt.polish` — JSON value = an SttPolish ({enabled: boolean}, see
//   src/stt-polish.ts). The opt-in LLM STT-polish layer (06 §5, WP-R4-6). Default
//   OFF (absent ⇔ disabled). This package only NAMES the key and owns the value
//   schema; it never reads or writes it.
//   Producer: desktop STT settings toggle (updateSetting('stt.polish', {enabled}))
//     — the settings-key-drift SET anchor.
//   Consumer: server-core engine/stt-factory.ts snapshots it per audio:start via
//     stt/stt-polish-settings.ts readSetting('stt.polish') — the GET anchor; a
//     present-but-malformed value fails loud (SETTINGS_SCHEMA_INVALID), same
//     contract as scenario.card.
export const SETTINGS_KEY_STT_POLISH = 'stt.polish';
/** GA-14 two-pass refine (05 §5). */
export const SETTINGS_KEY_STT_REFINE = 'stt.refine';

// ── read-only CAPABILITY facts (card POLISH-CFG, 2026-08-09) ────────────────
//
// 🔴 A DIFFERENT KIND OF KEY, AND THE PREFIX IS THE WARNING. Everything above is
// a STORED setting: the UI writes it, the server reads it back. A `capability.*`
// key is the opposite — the SERVER computes it on every `settings:list` and
// NOBODY may write it. It is not in the settings table and never will be.
//
// WHY IT EXISTS. The desktop has to render owner's sentence 「AI优化所需的能力未配置,
// 未生效」 next to the polish switch, and it cannot tell 「no model configured」 from
// 「the user switched it off」 on its own: the effective `stt.polish` value says
// on/off but not WHY, and the desktop can only see the `llm.config` ROW — while
// the platform's managed default is env-gated and is never a row. A desktop that
// guessed would call a working cloud account 「未配置」. 15 册 R11: the layer making
// the claim must hold the fact the claim needs, so the fact is sent.
//
// 🔴 THE PREFIX IS LOAD-BEARING, NOT COSMETIC. `verify/lint/settings-key-drift.mjs`
// keys its whole read-only ruleset off this string: a `capability.*` key that the
// UI ever WRITES is a hard failure, one the server synthesises but no UI reads is
// a façade, and one the UI reads but no server produces is an invention. Naming a
// read-only fact `llm.*` or `stt.*` would file it under 「storable」 and hand the
// next reader a key that looks writable. Do not widen this prefix to hold anything
// that is actually persisted.
export const SETTINGS_CAPABILITY_KEY_PREFIX = 'capability.';
/**
 * `capability.llm` — JSON value `{ usable: boolean }`. 「能不能解出一个可用的语言模型」
 * ("can a usable language model be resolved?") is answered by the SAME resolver
 * the server itself defaults from
 * (server-core stt/stt-polish-settings.ts `llmCapabilityUsable`), so the switch's
 * value and the reason shown beside it cannot disagree. It deliberately says
 * nothing about WHICH model or whose key: only whether one exists.
 */
export const SETTINGS_KEY_CAPABILITY_LLM = 'capability.llm';
// `scenario.inference` — JSON value = a ScenarioConsentRow (see
//   src/scenario-consent.ts): `{granted, granted_for}`. V2-08's explicit-consent opt-in for
//   sending the focused executable's basename to the LLM. ABSENT ⇔ never asked ⇔
//   the feature is off, which is every account that has not seen the consent
//   screen.
//   Producer: the desktop consent switch (main-window/settings-model.ts) — pushed
//     with this CONSTANT, never a string literal, because the server reads it with
//     a variable key and a literal-keyed UI write would be a set-only orphan under
//     the settings-key-drift lint (same stance as stt.dictionary).
//   Consumer: server-core compose/scenario-infer-store.ts, which owns the reader
//     and treats an unreadable row as「没有设置」("not set") ⇒ off. A server-core test asserts
//     that reader honours a row stored under THIS constant, so the two spellings
//     cannot drift apart silently.
//   The sibling key `scenario.inference.overrides` (the owner's per-process manual
//   descriptor corrections) is also read there; it has no UI yet, so it is
//   deliberately NOT named here — a key constant with no producer is the façade
//   this comment block exists to prevent.
export const SETTINGS_KEY_SCENARIO_INFERENCE = 'scenario.inference';
// `flowmic.timeline.sync.noted` — RETIRED 2026-07-31 (0.2.27), both the key and
//   its default. It was a device-local switch governing whether THIS instance
//   emitted its delivery:'none' record-only entries into ROOM SYNC, and its only
//   consumer was the mobile emission filter (`shouldSync`). owner 架构裁定
//   (docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md) removed room sync
//   for transcripts altogether, so the filter went and the key was left with
//   nothing to govern — which is precisely what the block three lines above says
//   this file exists to prevent («a key constant with no producer is the façade
//   this comment block exists to prevent»). It goes.
//   The product red line it served is now UNCONDITIONAL rather than a default:
//   「仅记录」("record-only") entries stay on the phone, full stop, with no switch
//   that could ever say otherwise (master-plan §4.0 C is satisfied more strongly
//   than before).
//   ⚠️ If 「把仅记录条目也送到 PC」("also deliver record-only entries to the PC")
//   comes back with 窗口B's outbox, it is a DELIVERY
//   choice, not a storage-sync choice — give it a new key, do not resurrect this
//   name. Old phones have a stale `flowmic.timeline.sync.noted=true` in their
//   shared_preferences; nothing reads it, and reusing the name would make that
//   dead byte suddenly mean something again.

// ─── Cloud relay image policy (RV-87, owner 2026-08-01) ─────────────────────
//
// docs/decisions/2026-08-01-cloud-image-policy-size-cap-and-anti-sync.md
// owner, verbatim: 「如果是中继通道，服务器统一拦客户端，图片超过 1M 就不允许传，防止将
// 中继当作照片同步的工具」("if it's the relay channel, the server uniformly blocks
// the client — once a picture is over 1 MB it isn't allowed through, to keep the
// relay from being used as a photo-sync tool") / 「限制到 200 张吧，因为每次只发一张图，
// 手动操作发 200 张是个烦人的活，正常是不愿意的，但要加个限制排除机器的自动发」("cap it
// at 200 — you only send one picture at a time, and manually sending 200 is a
// tedious enough chore that a normal person wouldn't bother, but we need a limit
// to rule out an automated script sending them").
//
// WHY THE NUMBERS LIVE IN THE PROTOCOL PACKAGE rather than beside the check in
// server-core: they are the CONTRACT the refusal sentences quote. The user-facing
// copy at INJECT_CLOUD_IMAGE_TOO_LARGE / INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED names
// 「1 MB」 and 「200 张」, and packages/protocol/test/error-codes.test.ts asserts the
// copy against THESE constants — so a limit that changes without its sentence
// changing fails a test instead of shipping a server that refuses at one number
// while telling the user a different one.
//
// ⚠️ THE PHONE HAS ITS OWN COPY OF THE SIZE CEILING AND THAT IS DELIBERATE, not
// drift: `kCloudImageBytesMax` (mobile image_payload.dart) is Dart and cannot
// import this file. The two answer different questions — this one is 「服务端允不
// 允许」("does the server allow it"), the phone's is 「要不要白跑这一趟」("is it worth
// making the trip for nothing") (owner's own two reasons: user experience +
// saving server connections) — so they are two gates, not two answers to one question. They
// MUST hold the same integer; if this one ever moves, move that one in the same
// round.
//
/** owner:「最大不能大于 1M」("the max must not exceed 1M"), resolved to 1 MiB rather than 1,000,000 — the SAME
 *  tie-break the phone already made (image_payload.dart `kCloudImageBytesMax`:
 *  its `formatBytes` is 1024-based, so 1,048,576 renders as 「1.0 MB」 and the
 *  number the user is refused over is the number they are shown). Measured on
 *  the DECODED image bytes, never on the base64 string: base64 is 4/3 of the
 *  picture and judging the encoding would refuse pictures that are under the
 *  limit the user was told about. */
export const CLOUD_IMAGE_BYTES_MAX = 1_048_576;
/** owner:「限制到 200 张吧」("cap it at 200"). The judgement he stated is 「区分人和
 *  机器」("distinguishing a person from a machine"), not 「省流量」("saving
 *  bandwidth") — the ceiling belongs where a person cannot reach it by hand and a
 *  script crosses it in a minute. */
export const CLOUD_IMAGE_QUOTA_MAX = 200;
/** 🔴 AN ASSUMPTION THE LEAD MADE ON owner'S BEHALF — owner said 「200 张」("200
 *  pictures") and did NOT say over what period. Recorded here as an assumption
 *  rather than as his words, per
 *  docs/decisions/2026-08-01-cloud-image-policy-size-cap-and-anti-sync.md
 *  §「主控必须声明的一个假设」("an assumption the lead must state")
 *  (「若不对请纠正」 — "correct it if wrong").
 *
 *  The reasoning, from the reasons owner DID give:
 *    · 「手动操作发 200 张是个烦人的活」("sending 200 pictures by hand is a tedious
 *      chore") describes ONE stretch of human work ⇒ the window is about the
 *      length of a sitting, not a lifetime;
 *    · 「排除机器的自动发」("to rule out an automated script sending them") is about
 *      a script that keeps going ⇒ the window must be long enough that pacing
 *      cannot walk around it.
 *  The two readings this rejects, and why:
 *    · 「总量 200」("200 total, ever") — a normal user permanently loses image
 *      delivery after a few months. Plainly not what he meant;
 *    · 「每小时 200」("200 per hour") — 4,800/day for a script, i.e. no constraint
 *      on the thing the rule exists to stop. */
export const CLOUD_IMAGE_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

// Audio config defaults from 06-STT-ENGINE-LAYER.md.
export const AUDIO_DEFAULTS = {
  sample_rate_hz: 16_000,
  channels: 1,
  encoding: 'pcm_s16le',
  chunk_size_ms: 200,
  soft_segment_ms: 30_000,
  hard_limit_ms: 300_000,
  client_ring_buffer_ms: 30_000,
  server_replay_buffer_ms: 5_000,
  // F-2135 / S-API-7: keep the audio/STT session alive across a brief mobile
  // socket drop ("network blip < 30s recovers losslessly"). Matches the 30s
  // client ring buffer so the auto-replayed chunks land in the SAME live
  // session (SeqTracker survives); only disposed if the mobile never returns
  // within this grace window.
  mobile_drop_grace_ms: 30_000,
  heartbeat_interval_ms: 5_000,
  heartbeat_timeout_ms: 15_000,
  engine_reconnect_backoff_ms: [1000, 2000, 4000] as const,
  engine_reconnect_max_retries: 3,
} as const;
