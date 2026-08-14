// S catalogue shard — 0.3.0 P1: the in-product answer to 「where do my words go」.
// Merged out through ../strings.ts like every other shard; four locales, key set
// pinned by locale-parity.test.ts.
//
// 🔴 THIS COPY IS DERIVED FROM docs/legal/privacy-policy.md 「What happens to your
// voice」 / 「Who else sees your data」. It is a SUMMARY, not a second source of
// truth: if one changes and the other does not, one of them is lying. Every
// factual claim below has a code coordinate, because a disclosure that cannot be
// checked against the implementation is the legal-surface version of 反 façade ④:
//
//   · engine order (the engine YOU named for the language → YOUR wildcard '*' →
//     platform managed default → the engines we seeded at first boot → STOP with
//     an error, no hidden fallback)
//       apps/server-core/src/stt/engine-router.ts  selectRoutingWithSource()
//     🔴 W1.5: THE FOURTH STEP IS NOW IN THE COPY, because leaving it out made
//     the sentence's LAST clause false. The previous note here argued the copy
//     was still true 「because of how it is worded」 — that defence covers the
//     ORDERING (a seeded row is neither 「你为这门语言指定的」("the one you
//     specified for this language") nor 「你设的」("the one you set")) and
//     it is sound. It does not reach the terminal clause 「三者都没有时，转录直接
//     报错停止」("when none of the three exist, transcription stops with an
//     error, right away"): engine-router.ts selectRoutingWithSource() serves the SEEDED
//     rows before it errors, and every booted account owns seeded rows, so
//     stopping with an error is essentially never what happens. Two claims lived
//     in one sentence; the defence was written for one of them.
//     ⇒ Rule: when you justify leaving something out, name WHICH clause your
//       justification covers — the rest of the sentence is not covered by it.
//     🔴 REQ-13-09: AND THE SEEDED TIER IS NO LONGER CALLED 「本地 / local」.
//     The clause used to read 「the two LOCAL engine routes we seeded」. That
//     adjective is a claim about where those engines RUN, and this side cannot
//     make it, because the seed is env-selected:
//       apps/server-core/src/settings/defaults.ts  buildDefaultSettings()
//         reads FLOWMIC_DEFAULT_STT_ZH_PRESET / _WILDCARD_PRESET, defaulting to
//         `builtin-sherpa-local` but accepting ANY id in the catalogue —
//       packages/protocol/src/engine-presets.ts includes `cloud-deepgram`
//         (wss://api.deepgram.com) and `cloud-openai-realtime`, and the LAN
//         presets are then re-pointed by FLOWMIC_DEFAULT_STT_HOST at a machine
//         the OPERATOR runs (defaults.ts hostOverride) — not the reader's.
//     True of a stock install, false of the deployment this section says it is
//     describing (`disc_scope_note`). It is the rule further down this header,
//     applied to a clause that predates it. The three branch bullets still say
//     what a LOCAL engine means; the ORDER paragraph now names the tier without
//     grading it. Pinned by main-window/data-flow-disclosure.test.ts 「🔴 the
//     seeded tier is named without claiming it is local」.
//   · the platform managed default is env-gated and fail-loud on a bad engine id
//       apps/server-core/src/stt/managed-default.ts  managedDefaultRouting()
//   · the speech vendor named below
//       packages/stt-cloud/src/engines/soniox.ts
//   · 「we do not store transcripts」 — the table was DROPPED, tombstone kept
//       apps/server-core/src/db/schema.ts §5
//   · the LAN leg — 🔴 THIS BULLET USED TO READ 「the LAN leg is not encrypted」
//     and pointed at the policy's 「Two things we have not done yet」. 0.2.60
//     shipped LAN TLS with the key pinned from the QR, so that sentence expired
//     the moment 0.2.60 deployed. See the block at the bottom of this header for
//     what replaced it and why it is THREE claims rather than one.
//
// 🔴 DeepSeek IS NOW A PRESENT FACT — this comment used to say the opposite, and
// the change of tense is the whole point of the engine-switch batch. Until then
// the platform language model ran on machines we operate (settings/defaults.ts
// lan-vllm-qwen35 + deployment host override) and 「we use DeepSeek」 would have
// been a lie told early. The switch made the plan the fact, so the copy moved in
// the SAME batch as the mechanism — which is what the old comment promised would
// happen. Coordinates for the new claim:
//   · the platform LLM config is env-gated, fail-loud, and the key is OURS
//       apps/server-core/src/compose/llm-config.ts  managedLlmConfig()
//   · which vendor / endpoint / model that is
//       docs/decisions/2026-08-02-production-engine-lineup-soniox-deepseek.md
//       docs/strategy/2026-08-06-engine-switch-execution-brief.md §5
// Pinned by main-window/data-flow-disclosure.test.ts, INVERTED rather than
// deleted: the sentence must name the vendor that processes the text and must
// carry no 「planned / not yet」 hedge. Sliding back into a plan is now as loud a
// failure as jumping ahead to a fact used to be.
//
// 🔴 THE SPEECH BRANCH'S 「backup line」 SENTENCE WAS WRONG, AND THE OLD
// JUSTIFICATION IS EXACTLY WHY. It said the servers we operate 「are kept as
// a backup line」 and pointed at apps/server-core/src/stt/pool-routing.ts for the
// failover that would reach them. That code is real and still there — but it is
// ARMED ONLY WHEN A POOL IS CONFIGURED:
//     pool-routing.ts   `const probing = pool.source === 'pool-env';`
// and production deliberately does not set FLOWMIC_STT_POOL
// (docs/strategy/2026-08-06-w1-engine-switch-ledger.md §5; measured on the box
// as `candidates:1`). loadPool() therefore synthesises a ONE-route pool, health
// is null, and no failover can occur. The copy promised the user a mechanism the
// deployment does not have. A second overstatement rode along: route selection
// runs per audio:start (engine-factory.ts makePoolManagedDefault), so even a
// real pool could not move a LIVE session mid-utterance.
//
// 🔴 THE SHAPE, because it will recur — this was 反 façade ④: a comment asserting
// behaviour elsewhere. It was TRUE ABOUT THE CODE AND FALSE ABOUT PRODUCTION,
// and nothing about it changed on the day the deployment made it false; it went
// on defending a user-facing sentence that had stopped being true.
// ⇒ A claim whose truth depends on an env var must cite THE ENV VAR, not the
//   module that reads it. `pool-routing.ts` exists in both worlds.
//
// 🔴 AND THE FIRST REPLACEMENT FOR IT WAS ALSO WRONG — caught by adversarial
// review before it was believed, but AFTER it shipped in 0.2.57. It read: 「the
// speech-recognition servers we run are not in this path… moving it back would
// be a deployment change, and this sentence changes with it.」 Both halves fail:
//   · `FLOWMIC_MANAGED_STT_ENABLED=0` ⇒ managedDefaultRouting() returns null ⇒
//     selectRoutingWithSource falls through to the SEEDED rows, which point at
//     FLOWMIC_DEFAULT_STT_HOST — a speech-recognition server we operate. The
//     W1 ledger §7.7.5 MEASURED it: 45 connections to 10.0.0.68:10095.
//   · that flip is the documented Soniox-outage response (ledger §5). So the
//     copy's escape hatch was 「we will ship a new client build」 against an
//     incident response that is one `systemctl restart` — and the shipped
//     binaries cannot be updated at that speed. That is C-1 repeating, in the
//     sentence written to atone for C-1.
// ⇒ Rule: DO NOT WRITE A USER-FACING SENTENCE WHOSE TRUTH DEPENDS ON THE CURRENT
//   VALUE OF A SERVER-SIDE SWITCH. Write the one that is true at BOTH settings.
//   The copy below now names both possible processors and says the choice is an
//   operator action rather than an automatic mid-session re-route — which is
//   what the mechanism actually guarantees (selection happens per audio:start).
// The LLM side genuinely has no second destination — `managedLlmConfig` resolves
// ONE env-configured endpoint, and there is no seeded-row fallthrough for it at
// the vendor level — so that leg is stated the narrower way, on purpose.
//
// 🔴 STAGE ③ IS NOW WRITTEN TO BE TRUE AT BOTH VALUES OF THE SWITCH — this is the
// rule twelve lines above being applied to the switch it was written about. The
// previous copy said 「only if you switched on AI polish YOURSELF」 and titled the
// section 「not every sentence goes through it」. Both sentences encoded ONE value
// of a server-side default (`stt.polish` DEFAULT in stt/stt-polish-settings.ts),
// so owner's 2026-08-08 ruling 「AI 改顺默认全开」("AI polish reordering defaults
// to fully on") would have turned them into lies
// in the same second the constant changed — in binaries already on users' disks,
// which the server cannot reach. That is C-1 exactly.
// ⇒ The copy now states the CONDITION and says where the current value is shown,
//   instead of asserting which value it has. Flipping the default changes nothing
//   about whether these four sentences are true. Do not reintroduce a default into
//   them, in any language.
// ⚠️ 「the switch lives only on your computer」 is load-bearing, not padding: the
//   phone has no such control 【measured: `polish` has zero hits in the mobile
//   settings shards】, so a phone-only reader who is not told where it lives can
//   neither verify nor change what this paragraph describes.
//
// 🔴 STAGE ③'S SCOPE IS A CONDITION, NOT A MODE LIST. The title used to read
// 「only Translate / Organize」. Realtime reaches the vendor too, whenever
// AI polish is on for the account (settings.ts `polish_toggle` → `stt.polish`,
// DEFAULT in stt/stt-polish-settings.ts):
//   apps/server-core/src/engine/stt-factory.ts  resolvePolishDep()
//     — resolves through the SAME resolveLlmConfigWithSource() the compose turn
//       uses, and never reads `mode` at all
//   apps/server-core/src/engine/stt-session.ts  `if (this.deps.polish && !isSegment)`
//     — the only two conditions: polish present, and the utterance-closing final
// ⚠️ compose/mode.ts `modeUsesLlm()` reads like the guard that would have made the
// old title true. It has ZERO production call sites — a tested constant is not a
// runtime gate. (Tell: every polish test in stt-session-bridge.test.ts runs on
// the shared harness, and that harness is hard-coded `mode: 'realtime'`.)
// ⚠️ delivery:'none' (「仅记录」, "record-only") does NOT gate it either — resolvePolishDep never
// reads `delivery`, so an utterance the user deliberately kept off the PC still
// leaves for the vendor. That is the clause this copy is most at risk of
// under-stating, so it is said outright instead of being folded into 「optional」.
// Interim text is never sent; only the terminal final (is_segment === false).
//
// 🔴 THE LAN LEG IS NOW THREE CLAIMS, NOT ONE — and a blanket 「it is encrypted
// now」 would have been a lie in the opposite direction from the one it replaced.
// 0.2.60 shipped LAN TLS with the server key pinned from the QR. What is true:
//   ① A pairing made from a QR that carries the fingerprint is TLS, and the pin
//      is checked on EVERY dial, not just the first — the four dial sites are
//      ptt_pair.dart:63, reconnect.dart:355-358 (every rung of the ladder),
//      ptt_session.dart:563-569 + :601-610 (resume, and re-arming the ladder
//      under the same key), pair_retire.dart:49-54. The check itself is
//      lan_pinning.dart `PinnedHttpClient._judge` / `pinnedWebSocketConnector`,
//      and socket_core.dart:213-218 REFUSES to dial a plain URL while holding a
//      pin rather than silently downgrading. Enforced by
//      apps/mobile/test/lan_pin_enforced_on_every_dial_test.dart.
//   ② A pairing made BEFORE 0.2.60 is still plaintext, and the old warning is
//      still true FOR IT. ptt_session.dart:566-569 says it in the source:
//      `pinFingerprint: session.lanTlsFp` is 「Null for an unpinned row, which is
//      every pre-D2-LAN pairing … and then this call is byte-for-byte the old
//      one」. There is no auto-upgrade path, so re-pairing is the ONLY action
//      that moves such a row — which is why the copy carries that one imperative
//      and no other.
//   ③ `FLOWMIC_LAN_TLS=0` (server-core config.ts, resolveLanTls branch ②) puts
//      the leg back to plaintext AND stops the QR carrying the fingerprint. That
//      is why claim ① is written as a CONDITION (「whenever the code carries the
//      identity」) rather than as a fact — this file's own rule twelve lines up
//      forbids a sentence whose truth depends on the current value of a switch,
//      and ③ is exactly that switch.
//      🔴 W6R ruled the second half must travel with the first: the switch is
//      NOT a rollback. A pairing created under TLS stored `https://` + the pin,
//      `resumePairing` has no plaintext fallback, and with no certificate seen
//      `lastDialPinMismatch` is FALSE — so the phone cannot even say 「the key
//      changed」, only 「could not connect」. Recovery is delete-and-re-pair, and
//      until this copy said so, nothing the user can reach said it: the switch
//      is an environment variable with NO settings-page surface, and the only
//      other place the failure is written down is CHANGELOG.md, in Chinese only.
//      【Measured, and the first wording of this line was WRONG — it claimed
//      「zero hits under apps/desktop/」 and the grep refuted it. The hits under
//      apps/desktop/ are: this copy, its test, and `src-tauri/resources/
//      server.js` + its target/debug twin — the BUNDLED SIDECAR, i.e. a compiled
//      copy of server-core, not desktop source. No Vue component, no settings
//      shard, no other string catalogue mentions it.】 The correction is left
//      visible on purpose: a comment asserting a measurement is 反 façade ④ like
//      any other, and 「zero hits」 was a claim about a grep nobody had run.
// ⚠️ The paragraph sends the reader to the PHONE's 「Connection encryption」
//   section (connection_strings.dart `diagEncryptionSection`, reached by tapping
//   the PC name — chat_header.dart:192 `chat.deviceNameTap` → openDiagnostics →
//   connection_diagnostics_sheet.dart:122). That is the same 「state the
//   condition and say where the current value is shown」 shape stage ③ uses, and
//   it is deliberate that the desktop points at a phone screen: the desktop has
//   no encryption indicator of its own, and inventing a sentence here that
//   asserts the current value would repeat C-1. The section is a live per-
//   connection reading (`req.socket.encrypted`'s peer side), and it answers for
//   legacy rows too — socket_core.dart:224-226 sets `LinkEncryption.plain` on a
//   `ws://` dial, so a pre-0.2.60 pairing renders 「未加密」("not encrypted") rather than nothing.
// ⚠️ The three tier NAMES are deliberately NOT repeated here. The sheet already
//   discloses trust-on-first-use for hand-typed addresses in full
//   (`diagEncryptionTofuNote`), and duplicating it would create a second copy
//   that drifts. Terminology is kept identical to it on purpose: user-facing
//   text says 身份 / identity / 身元 / 신원 — never 「fingerprint」, 「pin」 or
//   「certificate」, which live only in code, tests and the CHANGELOG.
// ✅ THE 「changed together」 PROMISE AT THE TOP OF THIS FILE IS KEPT: the same
//   card's follow-up rewrote docs/legal/privacy-policy.md (LAN moved out of
//   「things we have not done yet」 into its own section), SECURITY.md and
//   README.md. No surface still carries the BLANKET pre-0.2.60 claim.
//   【Measured — and worded carefully, because the FIRST version of this line was
//   also wrong. Grepping not encrypted|unencrypted|in the clear|明文 across those
//   three plus terms-of-service.md still returns hits, and every one of them is
//   deliberate: the new scoped sentences (a pre-0.2.60 pairing is in the clear
//   until re-paired; `FLOWMIC_LAN_TLS=0` returns the leg to unencrypted) and the
//   policy's maintainer note describing this change. 「Zero hits」 was never the
//   target — zero hits would have meant the caveats went missing.】
// ⚠️ It was NOT kept by anyone remembering it. The privacy policy's own header
//   had scheduled this edit for 「D2 收口当天」("the day D2 closes out") and D2 shipped in 0.2.60 with the
//   policy untouched; what actually fired was the whole-repo grep run while
//   rewriting THIS file. A synchronisation promise that lives only in prose and
//   relies on someone remembering it is barely a promise — noted here because
//   this file is the one that makes it.
//
// 🔴 LEGAL TEXTS ARE LIVE LINKS (owner 2026-08-14). The previous copy said the
// documents were unpublished repo files under docs/legal/ — that sentence
// expired the day https://flowmic.app/privacy and /terms returned HTTP 200
// (measured 2026-08-14). The five in-product steps STAY: they answer THIS
// machine's configuration (engine, LAN pin, polish switch), which the website
// cannot know. Moving them would turn a status into a guess.
//
// URLs are the site's published paths, with no locale segment: the site stores
// language in localStorage and has no /:locale/privacy route (a prefix would
// hit the SPA catch-all and land on home). Do not invent ?lang= either — the
// site does not read it. Do not claim the opened page is in the UI language.
import { shardCatalogue } from './shard';

export const DISCLOSURE_PRIVACY_URL = 'https://flowmic.app/privacy';
export const DISCLOSURE_TERMS_URL = 'https://flowmic.app/terms';

export const DISCLOSURE_KEYS = [
  'disc_nav',
  'disc_entry',
  'disc_entry_sub',
  'disc_title',
  'disc_lead',
  'disc_s1_title',
  'disc_s1_body',
  'disc_s2_title',
  'disc_s2_body',
  'disc_s2_cloud',
  'disc_s2_byok',
  // The parenthesised opt-in sentence was ADDED by owner ruling 2026-08-11
  // (deferred-batch #12), superseding the 2026-08-09 "no copy change" ruling.
  // It must stay true to the mechanism: sherpa-local.ts parses the flag
  // strictly ('1'/'true'), default OFF, and a missing model fails loud with
  // STT_CONFIG_MISSING. If that default ever flips back, this sentence is the
  // first thing that becomes a lie.
  //
  // 🔴 REQ-13-09 / owner Q12㋐ — THE CLAIM IS SCOPED TO THE SPEECH LEG, IN THE
  // SENTENCE ITSELF, and the phone's `discStep2Local` carries the identical
  // change in the same commit (this pair 「change together or not at all」 —
  // and NOTHING automated enforces that, see the audit annex §8-3).
  // The line used to end at 「什么都不离开你自己的设备」("nothing leaves your
  // own device"). Inside ②'s numbering
  // that was true — this is one branch of 「which engine hears you」, and where
  // the TEXT goes is ③'s subject. But the numbering is not part of the
  // sentence: quoted alone it says the words never leave the device, which is
  // false the moment Translate/Organize run or 「AI 润色」("AI polish") is on (the closing
  // transcript goes to the endpoint `llm.config` names —
  // apps/server-core/src/engine/stt-factory.ts resolvePolishDep() →
  // resolveLlmConfigWithSource(), and compose/llm-config.ts for the two modes
  // — and packages/protocol/src/engine-presets.ts lets that be a cloud vendor).
  // The clause does not re-state ③; it names the leg and hands the other
  // question to the section that owns it, so ③'s body is untouched.
  // ⚠️ The parenthesised opt-in sentence is owner's verbatim wording and is
  // NOT touched; the clause goes in BEFORE it.
  // ⚠️ 「本地 / local / ローカル / 로컬」 must SURVIVE here — the REQ-13-09
  // seeded-tier guard uses this string as its positive control.
  // Pinned by main-window/data-flow-disclosure.test.ts 「🔴 the local-engine
  // line scopes its claim to speech and points text at ③」.
  'disc_s2_local',
  'disc_s3_title',
  'disc_s3_body',
  'disc_s4_title',
  'disc_s4_body',
  'disc_s4_lan_plain',
  'disc_s5_title',
  'disc_s5_body',
  'disc_legal_title',
  'disc_legal_privacy',
  'disc_legal_terms',
  'disc_more_on_site',
  'disc_scope_note',
] as const;

// Notes that were recorded against a TRANSLATION rather than against the
// key itself. Carried across verbatim (only the language tag is new): they
// explain a rendering choice in one language, and the block they lived in
// is now a data file that cannot hold them.
// [en] No apostrophe in the parenthesis on purpose: the rendered-HTML test
// [en] compares this raw string against serialized markup, and Vue escapes ' to
// [en] &#39; — an apostrophe here makes that honest assertion impossible.

export const DISCLOSURE_STRINGS = shardCatalogue(DISCLOSURE_KEYS);
