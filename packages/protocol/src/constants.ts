// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §1 (transport / topology),
//     §2 (handshake / version negotiation), §7 (protocol evolution)
//   docs/decisions/2026-07-23-wp-r0-1-protocol-rename-window.md
//
// Endpoint constants. SaaS endpoint is fixed and MUST NOT be overridable
// from the client UI when the client runs in 'saas' mode.
//
// Consumers: desktop lib/channel.ts (DEFAULT_CLOUD_ENDPOINT) and, as a
// documented hand-mirror, mobile auth/saas_endpoint.dart. PAIR_HTTPS_HOST
// (below) is consumed by desktop lib/pairing.ts `buildHttpsQrPayload`.
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

// W-12 / S1-01 / DOM-1 — host of the https pairing link the desktop QR emits
// (`https://<host><PAIR_HTTPS_PATH>?...`). Same key set/order as the legacy
// `flowmic://pair` form; only scheme+host+path change.
//
// WHY IT LIVES HERE rather than beside the desktop builder: the phone's Dart
// prefix (`kPairLinkPrefixHttps`) cannot import this file, and a third copy
// inside pairing.ts was a silent-drift hole (XC-1-FIX). The host is the
// contract both sides must agree on; the Dart side GETS the full prefix
// `https://` + this + PAIR_HTTPS_PATH by codegen —
// `apps/mobile/tool/gen_protocol.mjs` reads this declaration and emits
// `FlowMicPairLink.httpsPrefix`, so the two cannot disagree. It used to be a
// second hand-written literal pinned equal by a lint; what the lint still does
// (`verify/lint/pair-link-single-source.mjs`) is refuse a THIRD copy.
//
// 🔴 THE APEX ONLY, NEVER `www.`. iOS Universal Links DO NOT FOLLOW REDIRECTS:
// the host in the scanned URL must be one of the hosts declared in
// `applinks:` (Runner.entitlements) and in the Android intent-filter, so a
// `www.` link would open Safari on a phone that has the app. Only `flowmic.app`
// is declared. A `www.flowmic.app/go/*` -> apex 301 exists at the edge for
// links a HUMAN typed or forwarded; it is not, and cannot be, a path an app
// link travels (owner ruling 2026-09-08, card DOM-1 §1).
//
// CONSUMER (anti-façade): apps/desktop/src/lib/pairing.ts
// `buildHttpsQrPayload` — imported, not re-typed.
export const PAIR_HTTPS_HOST = 'flowmic.app';

// DOM-1 — the path half of that link. Owner ruling 2026-09-08: the web client
// is NOT a new hostname; it is served from the existing site the way `/console`
// already is, so the pairing link is `https://flowmic.app/go/pair?...`.
//
// WHY IT IS A CONSTANT AND NOT FIVE STRING LITERALS. Before this card the path
// was the literal `/pair`, typed independently in the desktop builder, the Dart
// prefix, the Android `android:path`, and BOTH lints that check those against
// each other — five copies of a value that had never had to change, so nothing
// proved they agreed. Moving the path is precisely the edit that turns a
// forgotten copy into a pairing QR the phone will not open, and the failure is
// silent on every side (the parser is right, its tests are green, and the
// product does not work). Naming it here gives the two mirror lints one thing
// to read.
//
// ⚠️ IT IS THE PATH, NOT THE PREFIX — no host, no query, leading slash, no
// trailing one. `apps/mobile/tool/gen_protocol.mjs` composes
// `https://${PAIR_HTTPS_HOST}${PAIR_HTTPS_PATH}` for the phone and THROWS on a
// value shaped any other way, so a bad shape fails every mobile build rather
// than half-migrating the product.
//
// CONSUMERS (anti-façade): apps/desktop/src/lib/pairing.ts
// `buildHttpsQrPayload`; apps/mobile/tool/gen_protocol.mjs, which generates the
// phone's prefix from it; verify/lint/applink-declarations.mjs and
// verify/lint/pair-link-single-source.mjs, which read it out of this file
// rather than re-typing it.
export const PAIR_HTTPS_PATH = '/go/pair';

// H-14 (2026-09-15) — the OTHER half of the same pairing link: the custom-scheme
// form `flowmic://pair?...` the desktop QR has always emitted and the phone has
// always accepted. Same query, same key order as the https twin above; only
// scheme+host change (04-PROTOCOL-SPEC §3.1 L64).
//
// 🔴 WHY THIS BECAME A CONSTANT. Until now the https half had one source and the
// custom half had none: `apps/desktop/src/lib/pairing.ts` built its prefix out of
// a literal, `apps/mobile/lib/src/ui/scan_payload.dart` declared a second literal,
// and `apps/mobile/lib/src/signaling/wire_payloads.dart` typed a THIRD one inline
// instead of reading the constant beside it. `verify:lint pair-link-single-source`
// covered only the https spelling, so the copy count for this half was unbounded
// and nothing could see it. A builder and a parser that disagree about this prefix
// produce a QR the phone refuses on the right host, with both sides' tests green
// — the failure this file's https block already spends a page describing.
//
// ⚠️ SCHEME AND HOST, NOT A PREFIX. `apps/mobile/tool/gen_protocol.mjs` composes
// `${PAIR_CUSTOM_SCHEME}://${PAIR_CUSTOM_HOST}` and THROWS on a value shaped any
// other way, so a bad shape fails every mobile build rather than half-migrating
// the product. They are split because the two halves answer different questions:
// the SCHEME is what an operating system routes (`flowmic://login` is the same
// scheme, a different host), the HOST is which of our links this is.
//
// ⚠️ THIS PAIR IS NOT DECLARED TO EITHER OPERATING SYSTEM, and that is deliberate,
// not an oversight — measured 2026-09-15: the Android manifest and the iOS
// Info.plist declare `flowmic://login` only. A `flowmic://pair` link reaches the
// app by being SCANNED or PASTED, never by being opened, so it needs no
// intent-filter and gets none. Do not "complete" the declaration here; that is a
// product decision about link handling, not a spelling fix.
//
// CONSUMERS (anti-façade): apps/desktop/src/lib/pairing.ts `buildQrPayload`;
// apps/mobile/tool/gen_protocol.mjs, which generates `FlowMicPairLink.customPrefix`
// from these two; verify/lint/pair-link-single-source.mjs, which reads them out of
// this file rather than re-typing them.
export const PAIR_CUSTOM_SCHEME = 'flowmic';
export const PAIR_CUSTOM_HOST = 'pair';

// M4-01b — the sibling path used ONLY for the anonymous site-demo room's
// pair_url (apps/server-core/src/http/web-room-routes.ts `webRoomPairUrl`'s
// `path` argument, passed by `handleAnonymous`). Owner ruling 6
// (docs/decisions/2026-09-09-owner-stage4-site-demo-twelve-rulings.md) requires
// a phone that already HAS FlowMic and scans the site's demo QR to still land
// on the web demo, not be pulled into the installed app.
//
// 🔴 THIS PATH MUST NEVER BE ADDED to the Android intent-filter or the iOS
// `applinks:` entitlement that `PAIR_HTTPS_PATH` is declared to
// (verify/lint/applink-declarations.mjs). Declaring it would defeat the whole
// point: the OS decides which app owns a path by exact match, so as long as
// this one is undeclared every phone — with or without FlowMic installed —
// gets handed to a browser, which is the behaviour ruling 6 asks for. Design
// SSOT: docs/strategy/2026-09-09-web-client-stage4-site-demo-design.md §5.2
// ("码用另一条路径，不用改 App 的任何声明").
//
// Regular (account) rooms are UNAFFECTED — `webRoomPairUrl`'s `path` parameter
// defaults to `PAIR_HTTPS_PATH`, so this constant has exactly one MINTING caller.
//
// 🔴 PARTLY OVERTURNED 2026-09-17 (docs/decisions/2026-09-17-owner-app-scans-
// demo-qr-as-ephemeral-session.md): the App now DOES recognise this link when
// SCANNED, and joins the demo room as an ephemeral session (off the device
// list, nothing persisted, no reconnect). What ruling 6 keeps is the OS half
// above — the path stays undeclared to both operating systems, so an OPENED
// link still lands in a browser. Second reader, read-only:
// apps/mobile/tool/gen_protocol.mjs emits it as `FlowMicPairLink.demoPath`, and
// the phone matches on host + LAST path segment (the site puts a locale in
// front: `/go/zh-cn/demo`) — never on this string as a prefix.
export const DEMO_PAIR_HTTPS_PATH = '/go/demo';

// Relay addresses this product HAS served from and has since RETIRED as the
// address it hands out. Not a decommission notice: per card C7's own measurement
// (docs/strategy/2026-08-17-lan-cc-agent-work-package-2.md §1 C7 — restated here,
// NOT re-measured by this change), the one entry below still answers
// `/api/health` byte-identically to the canonical host and still completes a
// socket.io handshake, because it IS the same box. What is retired is the address
// an install should CARRY, which is why the migration below is safe: it changes
// no connectivity.
//
// WHY THIS EXISTS AT ALL. `CloudConfig.endpoint` on the desktop is a stored
// value, not a label — only an EMPTY one falls back to DEFAULT_SAAS_ENDPOINT. An
// install that was configured while the legacy host was canonical keeps dialing
// (and displaying) that host forever, and the web console mints the endpoint from
// `window.location.origin`, so logging in over the legacy domain hands it back
// again. The desktop therefore performs a ONE-TIME migration of a stored endpoint
// that equals one of these to DEFAULT_SAAS_ENDPOINT.
//
// CONSUMERS (the anti-façade anchor — a constant with no live reader is this
// repo's #1 bug class):
//   · apps/desktop/src/lib/channel.ts  `cloudEndpointSsot()` — packs this list
//     plus the canonical value into the `cloud_status` IPC arguments;
//   · apps/desktop/src-tauri/src/socket/cloud_endpoint.rs `plan_migration()` —
//     the migration itself RUNS in Rust (the Cloud Key never crosses back to the
//     frontend, so the frontend cannot re-save the endpoint on its own) while the
//     LITERALS stay here, which is what keeps socket/channel.rs's standing rule
//     true: no endpoint literal is hardcoded anywhere in that crate.
//
// COMPARISON CONTRACT (implemented in cloud_endpoint.rs, restated here because
// this list is where someone will add an entry): both sides are normalised by
// trimming whitespace, stripping trailing `/`, and ASCII-lowercasing — so a
// stored `https://host/` and `HTTPS://Host` both migrate. Nothing else is
// normalised: the SCHEME is part of the identity (`http://…` is a different
// entry, add it here if it is ever wanted) and a subdomain is not a match.
// UNDER-matching is the safe direction on purpose. This field exists so a
// self-hosted relay can override the default, and rewriting one of THOSE would be
// a worse bug than the one this fixes.
//
// 🔴 THIS LIST MUST NEVER CONTAIN DEFAULT_SAAS_ENDPOINT (asserted by
// test/saas-endpoints.test.ts). The migration is idempotent by construction —
// rewriting the value removes the thing that triggered it — and an entry equal to
// the canonical value would break exactly that: every status read would "migrate"
// the endpoint onto itself, writing the config and a forensic line forever.
//
// 🔴 THE VALUE BELOW IS DEPLOYMENT DATA, NOT A PROTOCOL CONSTANT, AND THE
// OPEN-SOURCE EXPORT SHIPS IT EMPTY (scripts/opensource-manifest-strips.mjs).
// A build of this project that is not our hosted service has retired nothing, so
// `[]` is the CORRECT value there and the migration simply has no work — that is
// an empty set, not an inert mechanism. This is the same category as not
// exporting our API keys: the code is identical, the operator's data is not.
// It is also the last place in this repository that names the address the owner
// retired on 2026-08-17 (the ruling is
// docs/decisions/2026-08-17-owner-retires-flowmic-online-public-service.md, and
// it says to take that domain out of the project — this line survives it only
// because deleting it would strand every install still carrying that address,
// which is the very thing the retirement needs finished).
// ⚠️ DELETE THIS ENTRY (and its strip) once the repair window closes. It is not
// meant to outlive the installs it exists to heal.
export const LEGACY_SAAS_ENDPOINTS: readonly string[] = [];

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

// ─── Password policy (card PW-1, 2026-09-08) ────────────────────────────────
// These two numbers used to be declared once in `apps/server-core/src/auth/
// password-policy.ts` and hand-copied a second time in `@flowmic/web` (a
// separate git repo, cannot import server-core), pinned equal only by
// verify/lint/password-policy-mirror.mjs comparing two integers it found by
// text search. A THIRD hand-copy has now shown up in the web CLIENT repo
// (yet another separate checkout) — three copies of two integers is the shape
// this package exists to retire: one declaration, N importers.
//
// SPEC-REF: docs/decisions/2026-08-12-password-policy-medium-complexity.md §1/§3/§4-1
//           docs/strategy/2026-09-07-web-client-crosscheck-after-audio-durability.md §4.2
//
// 🔴 ONLY THESE TWO MOVED HERE, NOT `MIN_PASSWORD_CLASSES`. The mirror lint
// treats the two below as `required` (a repo declaring the anchor MUST also
// carry the other one, or the lint fails) — those are the pair every
// hand-copy is obligated to match. `MIN_PASSWORD_CLASSES` is `required: false`
// there by the C9 doctrine ("a mirror is registered because someone WROTE a
// copy, never because one should exist") and today NOTHING outside
// server-core declares it. Moving an unmirrored constant here would not fix
// any drift — it would just relocate a number nobody is copying.
//
// 🔴 THIS FILE DOES NOT AND CANNOT CARRY THE FULL POLICY. The measure
// (CODE POINTS — `[...pw].length`, never `pw.length`) and the character-class
// regexes live only in `apps/server-core/src/auth/password-policy.ts` and are
// pinned by the shared vector table (`apps/server-core/test/password-policy.
// test.ts`) — a consumer of these two integers still needs its own vector
// table if it re-implements the check locally rather than calling the server.
/** Minimum account password length, in CODE POINTS. Historical ruling named
 *  10; the live value has been 8 since before this repo's decision log started
 *  tracking it (see the disagreement noted in password-policy.ts's header). */
export const MIN_PASSWORD_LENGTH = 8;
/** Maximum account password length, in CODE POINTS. Human-scale ceiling
 *  (password-manager 32-character secrets still fit). */
export const MAX_PASSWORD_LENGTH = 32;
