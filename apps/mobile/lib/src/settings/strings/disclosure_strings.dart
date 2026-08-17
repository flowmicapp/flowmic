// AppStrings catalogue shard — 0.3.0 P1: the in-product answer to
// 「where do my words go」. The single entry point is still ../app_strings.dart.
//
// 🔴 THIS COPY IS A SUMMARY OF docs/legal/privacy-policy.md 「What happens to your
// voice」 / 「Who else sees your data」 — not a second source of truth. The two are
// changed in the same batch: if one moves and the other does not, one of them is
// lying. Every factual claim has a code coordinate:
//
//   · engine order (exact language → wildcard '*' → platform managed default →
//     the engines we seeded at first boot → STOP with an error, no hidden
//     fallback). 🔴 W1.5: the seeded tier was missing from this list AND from
//     the copy, which made the copy's 「STOP with an error」 clause false —
//     every booted account owns seeded rows, so the error tier is essentially
//     unreachable. Desktop's shard had already been corrected; this one had
//     not, so two 「verbatim-equivalent」 catalogues described the same function
//     two different ways.
//       apps/server-core/src/stt/engine-router.ts  selectRoutingWithSource()
//     🔴 REQ-13-09: THE SEEDED TIER IS NO LONGER CALLED "local" (本地 / local). The
//     clause used to read 「the two LOCAL engine routes we seeded」, and that
//     adjective is a claim about where those engines run — which this side
//     cannot make, because the seed is env-selected:
//       apps/server-core/src/settings/defaults.ts  buildDefaultSettings()
//         reads FLOWMIC_DEFAULT_STT_ZH_PRESET / _WILDCARD_PRESET, defaulting to
//         `builtin-sherpa-local` but accepting ANY id in the catalogue —
//       packages/protocol/src/engine-presets.ts includes `cloud-deepgram`
//         (wss://api.deepgram.com) and `cloud-openai-realtime`, and the LAN
//         presets are then re-pointed by FLOWMIC_DEFAULT_STT_HOST at a machine
//         the OPERATOR runs (defaults.ts hostOverride) — not the reader's.
//     So the word was true of a stock install and false of the deployment this
//     page says it describes (`discScopeNote`: "the above describes the
//     FlowMic-managed service" 「以上描述的是 FlowMic 托管服务」).
//     That is this file's own rule four blocks down — DO NOT WRITE A SENTENCE WHOSE
//     TRUTH DEPENDS ON THE CURRENT VALUE OF A SERVER-SIDE SWITCH — applied to a
//     clause written before that rule existed. The three branch bullets below still
//     say what a LOCAL engine means; the ORDER paragraph now names the tier
//     without grading it. Pinned by test/data_flow_disclosure_test.dart
//     「🔴 the seeded tier is named without claiming it is local」.
//   · the platform managed default is env-gated and fail-loud on a bad engine id
//       apps/server-core/src/stt/managed-default.ts  managedDefaultRouting()
//   · the speech vendor named below
//       packages/stt-cloud/src/engines/soniox.ts
//   · 「we do not store transcripts」 — the table was DROPPED, tombstone kept
//       apps/server-core/src/db/schema.ts §5
//   · the LAN leg — 🔴 THIS BULLET USED TO READ 「the LAN leg is not encrypted」
//     and pointed at the policy's 「Two things we have not done yet」. 0.2.60
//     shipped LAN TLS with the key pinned from the QR, so that sentence expired
//     the moment 0.2.60 deployed. The block near the bottom of this header says
//     what replaced it and why it had to become THREE claims.
//
// 🔴 DeepSeek IS NOW A PRESENT FACT — this comment used to say the opposite, and
// the change of tense is the whole point of the engine-switch batch. Until then
// the platform language model ran on machines we operate and 「we use DeepSeek」
// would have been a lie told early; the switch made the plan the fact, so the
// copy moved in the SAME batch as the mechanism, which is what the old comment
// promised would happen. Coordinates for the new claim:
//   · the platform LLM config is env-gated, fail-loud, and the key is OURS
//       apps/server-core/src/compose/llm-config.ts  managedLlmConfig()
//   · which vendor / endpoint / model that is
//       docs/decisions/2026-08-02-production-engine-lineup-soniox-deepseek.md
//       docs/strategy/2026-08-06-engine-switch-execution-brief.md §5
// Pinned by test/data_flow_disclosure_test.dart, INVERTED rather than deleted:
// the sentence must name the vendor that processes the text and must carry no
// 「planned / not yet」 hedge. Sliding back into a plan is now as loud a failure
// as jumping ahead to a fact used to be.
//
// 🔴 THE SPEECH BRANCH'S 「backup line」 SENTENCE WAS WRONG, AND THE OLD
// JUSTIFICATION IS EXACTLY WHY. It said the servers we operate 「are kept as
// a backup line」 and pointed at apps/server-core/src/stt/pool-routing.ts for the
// failover that would reach them. That code is real and still there — but it is
// ARMED ONLY WHEN A POOL IS CONFIGURED:
//     pool-routing.ts   `const probing = pool.source == 'pool-env';`
// and production deliberately does not set FLOWMIC_STT_POOL
// (docs/strategy/2026-08-06-w1-engine-switch-ledger.md §5; measured on the box
// as `candidates:1`). loadPool() therefore synthesises a ONE-route pool, health
// is null, and no failover can occur. The copy promised the user a mechanism the
// deployment does not have. A second overstatement rode along: route selection
// runs per audio:start, so even a real pool could not move a LIVE session
// mid-utterance.
//
// 🔴 THE SHAPE, because it will recur — this was anti-façade rule ④: a comment asserting
// behaviour elsewhere. It was TRUE ABOUT THE CODE AND FALSE ABOUT PRODUCTION,
// and nothing about it changed on the day the deployment made it false.
// ⇒ A claim whose truth depends on an env var must cite THE ENV VAR, not the
//   module that reads it. `pool-routing.ts` exists in both worlds.
//
// 🔴 AND THE FIRST REPLACEMENT FOR IT WAS ALSO WRONG — caught by adversarial
// review before it was believed, but AFTER it shipped in 0.2.57. It read: "the
// speech-recognition servers we run are not in this path… moving it back would
// be a deployment change, and this sentence changes with it." Both halves fail:
//   · `FLOWMIC_MANAGED_STT_ENABLED=0` ⇒ managedDefaultRouting() returns null ⇒
//     selectRoutingWithSource falls through to the SEEDED rows, which point at
//     FLOWMIC_DEFAULT_STT_HOST — a speech-recognition server we operate. The
//     W1 ledger §7.7.5 MEASURED it: 45 connections to 10.0.0.68:10095.
//   · that flip is the documented Soniox-outage response (ledger §5). So the
//     copy's escape hatch was "we will ship a new client build" against an
//     incident response that is one `systemctl restart` — and shipped binaries
//     cannot be updated at that speed. That is C-1 repeating, in the sentence
//     written to atone for C-1.
// ⇒ RULE: DO NOT WRITE A USER-FACING SENTENCE WHOSE TRUTH DEPENDS ON THE CURRENT
//   VALUE OF A SERVER-SIDE SWITCH. Write the one that is true at BOTH settings.
//   The copy below now names both possible processors and says the choice is an
//   operator action rather than an automatic mid-session re-route.
// The LLM side genuinely has no second destination — `managedLlmConfig` resolves
// ONE env-configured endpoint, with no seeded-row fallthrough at the vendor
// level — so that leg is stated the narrower way, on purpose.
//
// 🔴 STAGE ③'S SCOPE IS A CONDITION, NOT A MODE LIST. The title used to read
// 「only Translate / Organize」. Realtime reaches the vendor too, whenever the
// user has switched on AI polish (desktop settings `polish_toggle` →
// `stt.polish`, DEFAULT `{enabled: false}`, never seeded):
//   apps/server-core/src/engine/stt-factory.ts  resolvePolishDep()
//     — resolves through the SAME resolveLlmConfigWithSource() the compose turn
//       uses, and never reads `mode` at all
//   apps/server-core/src/engine/stt-session.ts  `if (this.deps.polish && !isSegment)`
// ⚠️ compose/mode.ts `modeUsesLlm()` reads like the guard that would have made the
// old title true. It has ZERO production call sites — a tested constant is not a
// runtime gate.
// ⚠️ delivery:'none' ("record only" 仅记录) does NOT gate it either, so an utterance the user
// deliberately kept off the PC still leaves for the vendor. That is the clause
// this copy is most at risk of under-stating, so it is said outright.
// Interim text is never sent; only the terminal final.
//
// 🔴 STAGE 3 IS WRITTEN TO BE TRUE AT BOTH VALUES OF THE POLISH SWITCH, and this
// shard carries ONE deliberate divergence from the desktop twin. The old copy
// said "only if you switched on AI polish YOURSELF" — which encoded one value of
// a server-side default (`stt.polish` DEFAULT in server-core
// stt/stt-polish-settings.ts) into a string compiled into a shipped APK, where
// the server cannot reach it. owner's 2026-08-08 ruling "AI polish default
// switched to on" 「AI 改顺默认全开」 would have made it a lie the instant the
// constant moved. It now states the CONDITION and where the current value is
// shown. Do not put a default back into it.
// 🔴 THE DIVERGENCE: this shard adds "this phone does not have it" (手机上没有).
// 【Measured: `polish` has ZERO hits across the mobile settings shards — the
// control genuinely does not exist here.】 The desktop twin cannot say that
// sentence (there the switch IS on screen), and a phone-only reader told merely
// that a switch exists would go looking for one that is not there. Verbatim
// parity with the desktop shard would therefore have cost this reader the only
// actionable half of the paragraph — parity serves truth, not the other way
// round. Everything else in the four strings stays word-for-word with desktop.
//
// 🔴 THE LAN LEG IS NOW THREE CLAIMS, NOT ONE — and a blanket 「it is encrypted
// now」 would have been a lie in the opposite direction from the one it replaced.
// 0.2.60 shipped LAN TLS with the server key pinned from the QR. What is true:
//   ① A pairing made from a QR that carries the fingerprint is TLS, and the pin
//      is checked on EVERY dial, not just the first. Four dial sites, all in
//      this app: ptt_pair.dart:63, reconnect.dart:355-358 (every rung of the
//      ladder), ptt_session.dart:563-569 + :601-610 (resume, and re-arming the
//      ladder under the same key), pair_retire.dart:49-54. The check is
//      lan_pinning.dart `PinnedHttpClient._judge` / `pinnedWebSocketConnector`,
//      and socket_core.dart:213-218 REFUSES to dial a plain URL while holding a
//      pin rather than silently downgrading. Pinned by
//      test/lan_pin_enforced_on_every_dial_test.dart.
//   ② A pairing made BEFORE 0.2.60 is still plaintext, and the old warning is
//      still true FOR IT. ptt_session.dart:566-569 says it in the source:
//      `pinFingerprint: session.lanTlsFp` is "Null for an unpinned row, which is
//      every pre-D2-LAN pairing … and then this call is byte-for-byte the old
//      one". There is no auto-upgrade path, so re-pairing is the ONLY action
//      that moves such a row — which is why the copy carries that one imperative
//      and no other. This half is what stops the paragraph from becoming a
//      blanket "encrypted" claim, which for these users would be a fresh lie.
//   ③ `FLOWMIC_LAN_TLS=0` (server-core config.ts, resolveLanTls branch ②) puts
//      the leg back to plaintext AND stops the QR carrying the fingerprint. That
//      is why claim ① is written as a CONDITION ("as long as the code carries
//      the identity") rather than as a fact — the rule above forbids a sentence
//      whose truth depends on the current value of a switch, and ③ is that
//      switch.
//      🔴 W6R ruled the second half must travel with the first: the switch is
//      NOT a rollback. A pairing created under TLS stored `https://` + the pin,
//      `resumePairing` has no plaintext fallback, and with no certificate seen
//      `lastDialPinMismatch` is FALSE — so this phone cannot even say "the key
//      changed", only "could not connect". Recovery is delete-and-re-pair, and
//      until this copy said so, nothing the user can reach said it: the switch
//      is an environment variable with NO settings-page surface, and the only
//      other place the failure is written down is CHANGELOG.md, in Chinese only.
//      【Measured, and the first wording of this line was WRONG — it claimed
//      "zero hits under apps/desktop/" and the grep refuted it. The hits under
//      apps/desktop/ are: the disclosure copy, its test, and `src-tauri/
//      resources/server.js` + its target/debug twin — the BUNDLED SIDECAR, i.e.
//      a compiled copy of server-core, not desktop source. No Vue component, no
//      settings shard, no other string catalogue mentions it.】 The correction is
//      left visible on purpose: a comment asserting a measurement is anti-façade
//      rule ④ like any other, and "zero hits" was a claim about a grep nobody had run.
// ⚠️ The paragraph sends the reader to "Connection encryption" in the connection
//   diagnostics sheet (connection_strings.dart `diagEncryptionSection`, reached
//   by tapping the PC name — chat_header.dart:192 `chat.deviceNameTap` →
//   openDiagnostics → connection_diagnostics_sheet.dart:122). Same "state the
//   condition and say where the current value is shown" shape stage ③ uses. That
//   pointer is not a comment's word: test/data_flow_disclosure_test.dart asserts
//   this string CONTAINS the live `diagEncryptionSection` getter, so renaming the
//   section breaks the test rather than silently orphaning the sentence.
//   It answers for legacy rows too — socket_core.dart:224-226 sets
//   `LinkEncryption.plain` on a `ws://` dial, so a pre-0.2.60 pairing renders
//   "unencrypted" (未加密) rather than the section vanishing.
// ⚠️ The three tier NAMES are deliberately NOT repeated here. The sheet already
//   discloses trust-on-first-use for hand-typed addresses in full
//   (`diagEncryptionTofuNote`), and a second copy of it here would drift.
//   Terminology is kept identical to that sheet on purpose: user-facing text
//   says 身份 / identity / 身元 / 신원 — never "fingerprint", "pin" or
//   "certificate", which live only in code, tests and the CHANGELOG.
// ⚠️ This string stays word-for-word with the desktop twin (the polish paragraph
//   remains this shard's ONE deliberate divergence). "on the phone" reads a
//   little redundantly on a phone screen, but that is a style wart, not an
//   untruth, and byte-parity is itself a guard against the two catalogues
//   describing one mechanism two ways — the exact failure W1.5 caught above.
// ✅ THE "same batch" PROMISE AT THE TOP OF THIS FILE IS KEPT: the same card's
//   follow-up rewrote docs/legal/privacy-policy.md (LAN moved out of "things we
//   have not done yet" into its own section), SECURITY.md and README.md. No
//   surface still carries the BLANKET pre-0.2.60 claim.
//   【Measured — and worded carefully, because the FIRST version of this line was
//   also wrong. Grepping not encrypted|unencrypted|in the clear|明文 (plaintext)
//   across those three plus terms-of-service.md still returns hits, and every
//   one of them is deliberate: the new scoped sentences (a pre-0.2.60 pairing is
//   in the clear until re-paired; `FLOWMIC_LAN_TLS=0` returns the leg to
//   unencrypted) and the policy's maintainer note describing this change.
//   "Zero hits" was never the target — zero hits would have meant the caveats
//   went missing.】
// ⚠️ It was NOT kept by anyone remembering it. The privacy policy's own header
//   had scheduled this edit for "the day D2 closes out" (D2 收口当天) and D2
//   shipped in 0.2.60 with the policy untouched; what actually fired was the
//   whole-repo grep run while rewriting THIS file. A synchronisation promise
//   that lives only in prose and relies on someone remembering it is barely a
//   promise — noted here because this file is the one that makes it.
//
// 🔴 LEGAL PAGES ARE LIVE (2026-08-14). The previous block here said
// docs/legal/*.md were unpublished and therefore must not be linked. That
// sentence expired the day https://flowmic.app/privacy and /terms
// returned HTTP 200. The disclosure page opens those two URLs in the
// external browser (`url_launcher`, LaunchMode.externalApplication). The
// earlier claim that this app cannot take that dependency was true about
// the win32 pins and false about url_launcher. Copy-to-clipboard stays as
// the fail-loud fallback when the opener returns false or throws.
// State-aware sentences (engine branch, LAN encryption) stay in this shard.
part of '../app_strings.dart';

mixin DisclosureStrings on AppStringsLeaves {

  // 🔴 WP3 C16 (owner 2026-08-17: 「a simple diagram plus short explanation —
  // no long text; privacy and terms live on the web」). The step BODIES were
  // rewritten as diagram captions on 2026-08-18. Two claim families MOVED
  // behind the privacy-policy link rather than being deleted (the policy is
  // the authority and already carries both in full):
  //   ① the four-tier engine resolution ORDER, incl. the two seeded routes
  //     (docs/legal/privacy-policy.md, engine resolution section);
  //   ② the FLOWMIC_LAN_TLS=0 switch-off, its lockout consequence and the
  //     recovery steps (privacy-policy.md, LAN channel section).
  // [discDetailsOnSite] is the on-screen pointer to where they went. Every
  // OTHER claim in the pre-rewrite copy is still on this screen — the WP3
  // handback carries the full before/after claims diff. The release gate's
  // three zh-CN canaries in [discStep4LanPlain] survive byte-identical
  // (scripts/apk-disclosure-copy-marker.mjs answers 「did the CLAIM survive」,
  // and it did — verified by that script's own marker list).

  // ── Entry points (home screen / settings) ────────────────────────────────
  String get discEntry => _lfDiscEntry;

  String get discEntrySub => _lfDiscEntrySub;

  String get discTitle => discEntry;

  String get discLead => _lfDiscLead;

  // ── 1. Capture ───────────────────────────────────────────────────────────
  String get discStep1Title => _lfDiscStep1Title;

  String get discStep1Body => _lfDiscStep1Body;

  // ── 2. Recognition ───────────────────────────────────────────────────────
  String get discStep2Title => _lfDiscStep2Title;

  String get discStep2Body => _lfDiscStep2Body;

  String get discStep2Cloud => _lfDiscStep2Cloud;

  String get discStep2Byok => _lfDiscStep2Byok;

  // The parenthesised opt-in sentence was ADDED by owner ruling 2026-08-11
  // (deferred-batch #12), superseding the 2026-08-09 "no copy change" ruling.
  // It must stay true to the mechanism on the PC side: sherpa-local.ts parses
  // the flag strictly ('1'/'true'), default OFF, and a missing model fails loud
  // with STT_CONFIG_MISSING. Mirrors desktop disclosure.ts `disc_s2_local` —
  // the two surfaces change together or not at all.
  //
  // 🔴 REQ-13-09 / owner Q12㋐ — THE CLAIM IS SCOPED TO THE SPEECH LEG, IN THE
  // SENTENCE ITSELF. It used to read "nothing leaves your own device" /
  // "nothing leaves your own hardware" (「什么都不离开你自己的设备」) with
  // nothing after it, and inside ②'s numbering that was TRUE: this bullet is
  // one branch of "which engine hears you", and where the TEXT goes
  // afterwards is ③'s subject, one screen down.
  //   ⇒ so why change a true sentence: because THE NUMBERING IS NOT PART OF THE
  //     SENTENCE. This line is quotable on its own — in a screenshot, a support
  //     answer, a review — and read alone it says the words never leave the
  //     device, which is false the moment Translate/Organize run or "AI polish"
  //     (AI 润色) is on: the closing transcript goes to the endpoint
  //     `llm.config` names (apps/server-core/src/engine/stt-factory.ts
  //     resolvePolishDep() → resolveLlmConfigWithSource(), and
  //     compose/llm-config.ts for the two modes), which the presets catalogue
  //     lets be a cloud vendor.
  //   ⇒ the qualifier does NOT re-state ③. It says which leg this line is about
  //     and sends the other question to the section that owns it — one answer
  //     per sentence, which is why ③'s body is untouched by this card.
  // ⚠️ The parenthesised opt-in sentence is owner's verbatim wording and is NOT
  // touched here; the clause is inserted BEFORE it.
  // ⚠️ the word "local" in all four languages (本地 / local / ローカル / 로컬) must
  // SURVIVE in this string — the REQ-13-09 seeded-tier guard uses it as its
  // positive control, so a rewrite that drops the word here would let the
  // ban leak out of discStep2Body. Pinned by
  // test/data_flow_disclosure_test.dart "🔴 the local-engine line scopes its
  // claim to speech and points text at ③", which also measures the
  // rendered paragraph at 360dp (the 0.2.53 rule).
  String get discStep2Local => _lfDiscStep2Local;

  // ── 3. Language model ────────────────────────────────────────────────────
  String get discStep3Title => _lfDiscStep3Title;

  String get discStep3Body => _lfDiscStep3Body;

  // ── 4. Delivery + injection ──────────────────────────────────────────────
  String get discStep4Title => _lfDiscStep4Title;

  String get discStep4Body => _lfDiscStep4Body;

  String get discStep4LanPlain => _lfDiscStep4LanPlain;

  // ── 5. What is left behind ───────────────────────────────────────────────
  String get discStep5Title => _lfDiscStep5Title;

  String get discStep5Body => _lfDiscStep5Body;

  // ── Privacy policy / terms ───────────────────────────────────────────────
  String get discLegalTitle => _lfDiscLegalTitle;

  // Labels only — destinations live in support/legal_urls.dart so a path
  // change cannot drift from the origin the app already names. No sentence
  // here claims the linked page is in the user's language: the site is a
  // four-language SPA and does not read a locale off the URL.
  String get discLegalPrivacy => _lfDiscLegalPrivacy;

  String get discLegalTerms => _lfDiscLegalTerms;

  String get discOpenInBrowser => _lfDiscOpenInBrowser;

  // Shown when launchUrl returns false or throws. The copy labels below
  // stay because that is the reachable fallback on this path — a tap that
  // does nothing is worse than the copy control this replaced.
  String get discOpenFailed => _lfDiscOpenFailed;

  String get discCopyLink =>
      _lfDiscCopyLink;

  String get discLinkCopied => _lfDiscLinkCopied;

  String get discScopeNote => _lfDiscScopeNote;

  /// WP3 C16: the pointer to where the two MOVED claim families live (the
  /// engine-selection order; the LAN-TLS fine print). It exists so shortening
  /// this screen never silently shortened the product's story — the sentence
  /// names what moved and where to read it, right above the links that open it.
  String get discDetailsOnSite => _lfDiscDetailsOnSite;
}
