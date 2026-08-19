// AppStrings catalogue shard — 0.3.0 P1: the in-product answer to
// 「where do my words go」. The single entry point is still ../app_strings.dart.
//
// 🔴 THIS COPY IS A SUMMARY OF docs/legal/privacy-policy.md 「What happens to your
// voice」 / 「Who else sees your data」 — not a second source of truth. The two are
// changed in the same batch: if one moves and the other does not, one of them is
// lying. Every factual claim has a code coordinate:
//
// 🔴 HEADER REFRESH — 2026-08-19, machine dev-pc-a, WP-3 report §7 item 6
// (docs/strategy/2026-08-18-lan-fable-wp3-report.md). Everything below was
// written BEFORE the 0.3.8 copy rewrite (WP3 C16, commit 611a05bf, 2026-08-18)
// turned the step bodies into diagram captions. Every coordinate has now been
// walked against the tree. NOTHING IS DELETED: where a claim was true and
// stopped being true, the original stands and a 【CORRECTED 2026-08-19】 block
// says what changed — a claim's history is the only evidence that the mechanism
// it describes ever behaved that way. Where only a line number rotted, the
// number is updated in place AND the greppable symbol is named beside it, so the
// next rot fails LOUD (reader greps, gets one hit or zero) instead of silently
// landing on an unrelated line — the migration direction
// verify/lint/coordinate-anchors.mjs exists to push.
// ⚠️ THE BULLETS BELOW DESCRIBE THE MECHANISM, NOT ALWAYS THE SENTENCE. Two
// claim families left this screen in the rewrite and now live behind the
// privacy-policy link (see the WP3 C16 block on the mixin). Their bullets are
// KEPT and marked, because the mechanism did not move — only the copy did, and a
// mechanism nobody describes is exactly how the next rewrite loses it.
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
//     【CORRECTED 2026-08-19 — THIS BULLET NO LONGER DESCRIBES A SENTENCE ON THIS
//     SCREEN. W1.5's fix (the seeded tier written INTO the copy) shipped and was
//     true; WP3 C16 then moved the ORDER itself off the phone. What the copy
//     says today is the tier and the terminal clause, not the four steps:
//     `discStep2Body` = 「…down to the two engine routes we seeded for you at
//     first boot. If none fits, transcription stops with an error…」. The four
//     steps are enumerated in docs/legal/privacy-policy.md 「What happens to your
//     voice」 (opening paragraph), and `discDetailsOnSite` is the on-screen
//     pointer. The mechanism coordinate above is UNCHANGED and still exact —
//     which is the whole reason this bullet is kept rather than deleted: W1.5's
//     defect was a copy that contradicted selectRoutingWithSource(), and that
//     comparison stays possible only while someone writes down where to look.】
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
//     `testWidgets` 「🔴 the seeded tier is named without claiming it is local
//     (REQ-13-09)」 — this citation used to stop before the 「(REQ-13-09)」 and
//     therefore matched no test title in the tree; grep the full string.
//     ⚠️ That guard SURVIVED the WP3 C16 rewrite: it asserts the seeded tier is
//     still NAMED in `discStep2Body` and still not graded 「local」, and both are
//     true of today's copy. It is the reason the tier survived a rewrite that
//     deleted the order around it.
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
//     pool-routing.ts:146   `const probing = pool.source === 'pool-env';`
//     (2026-08-19: this header quoted it with `==`. The source has always used
//     `===`; a quotation that is not the bytes it claims to be is the same
//     failure as a rotted line number, one character wide.)
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
// 【CORRECTED 2026-08-19 — 「DEFAULT `{enabled: false}`」 EXPIRED, TWICE OVER.
// Still true: `stt.polish` is never seeded (no row for most accounts). No longer
// true: the default is not a constant. Card POLISH-CFG (owner ruling
// docs/decisions/2026-08-09-owner-polish-follows-llm-configuration.md) made it a
// FUNCTION of 「is a usable llm.config resolvable」 — stt/stt-polish-settings.ts
// `resolveSttPolishDefault` → `STT_POLISH_DEFAULT_WITH_LLM = {enabled: true}` /
// `STT_POLISH_DEFAULT_WITHOUT_LLM = {enabled: false}`. On flowmic.app
// FLOWMIC_MANAGED_LLM_ENABLED=1, so a cloud account with no row defaults to ON.
// ⇒ The copy this block defends was written to be true at BOTH values, and that
// is the only reason the flip cost nothing here. See the STAGE 3 block below,
// where the hypothetical 「would have made it a lie」 is now a past tense.】
//   apps/server-core/src/engine/stt-factory.ts  resolvePolishDep()
//     — resolves through the SAME resolveLlmConfigWithSource() the compose turn
//       uses, and never reads `mode` at all
//   apps/server-core/src/engine/stt-session.ts:225
//     `if (this.deps.polish && !isSegment && this.polishDelivery() === 'sync')`
//     【CORRECTED 2026-08-19 — this header quoted the guard's first two clauses
//     as the whole condition. A third was added when the DETACHED (replace-late)
//     polish mode was built beside the synchronous one. It changes nothing this
//     paragraph claims: `polishDelivery()` defaults to `'sync'`, production never
//     sets anything else (census tripwire: server-core
//     test/polish-delivery-census.test.ts), and BOTH modes keep `!isSegment` — so
//     the line below about interim text is still exact. Quoted in full anyway,
//     because a two-thirds quotation reads like a complete one.】
// ⚠️ compose/mode.ts `modeUsesLlm()` USED to read like the guard that would have
// made the old title true; it had ZERO production call sites — a tested constant
// is not a runtime gate — and was DELETED on 2026-08-19 for exactly that reason
// (the deletion record is in that file's header).
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
// 【CORRECTED 2026-08-19 — 「WOULD HAVE MADE IT A LIE」 IS NO LONGER A
// HYPOTHETICAL. The constant moved twice: 2026-08-08 flipped it to ON, and
// 2026-08-09 (POLISH-CFG) replaced it with `resolveSttPolishDefault`, a function
// of whether a usable llm.config resolves. A shipped APK carrying 「only if you
// switched it on yourself」 would have been false on every cloud account from
// 08-08 onwards, with no way to correct it short of a new build. This is the
// rule earning its keep, not an argument for it — which is why the sentence
// above is kept in its original tense and this block sits under it.】
// 🔴 THE DIVERGENCE: this shard adds "this phone does not have it" (手机上没有).
// 【Measured: `polish` has ZERO hits across the mobile settings shards — the
// control genuinely does not exist here.】 The desktop twin cannot say that
// sentence (there the switch IS on screen), and a phone-only reader told merely
// that a switch exists would go looking for one that is not there. Verbatim
// parity with the desktop shard would therefore have cost this reader the only
// actionable half of the paragraph — parity serves truth, not the other way
// round. Everything else in the four strings stays word-for-word with desktop.
// 【RE-MEASURED 2026-08-19, dev-pc-a — THE CLAIM HOLDS, THE MEASUREMENT DOES
// NOT. Case-insensitive `polish` under lib/, excluding the generated l10n and
// this file, is 14 hits in lib/src/settings/ and 80 across lib/ — not zero.
// NONE of them is a control: they are `compose_strings.dart`'s draft_polish AI
// ACTION (a different feature — a button you press on a line you already have,
// not the always-on switch), `recording_strings.dart`'s polish-SKIPPED signal,
// and `settings_client.dart`'s READ of the server's effective value.
// `grep -rn "stt.polish" lib/` finds no writer at all ⇒ nothing on this phone
// can turn it on or off, which is exactly what the sentence claims.
// ⚠️ WHY IT HAD TO BE RE-RUN, and the transferable part: 「ZERO hits」 measured a
// WORD while the sentence claims a CONTROL. The two came apart the moment an
// unrelated feature borrowed the word — nothing about the claim's subject
// changed. A measurement whose subject is not the claim's subject expires on
// events that have nothing to do with the claim, and it expires silently.
// (Counts exclude this file on purpose: the raw numbers with it are 42 / 108,
// and a measurement that counts its own prose is measuring itself.)】
// 【CORRECTED 2026-08-19 — 「the four strings」 IS NOW NINE, and the sentence it
// belongs to has expired for a second, independent reason. Both catalogues
// carry en / zh-CN / zh-TW / fr / es / de / ja / ko / ru (mobile
// `enum AppLocale`; desktop `CATALOGUE` in strings/generated/catalogue.g.ts), so
// every 「four languages」 count in this header means 「all of them」, not 「four of
// the nine」. But 「Everything else … word-for-word with desktop」 is itself no
// longer true after WP3 C16 — see the EXPIRED block on byte-parity near the
// bottom of this header for the measured diff.】
//
// 🔴 THE LAN LEG IS NOW THREE CLAIMS, NOT ONE — and a blanket 「it is encrypted
// now」 would have been a lie in the opposite direction from the one it replaced.
// 0.2.60 shipped LAN TLS with the server key pinned from the QR. What is true:
//   ① A pairing made from a QR that carries the fingerprint is TLS, and the pin
//      is checked on EVERY dial, not just the first. Four dial sites, all in
//      this app — 【every number in this list was re-walked 2026-08-19; all five
//      but one had rotted, and each is now written with the symbol that anchors
//      it so the next drift fails loud instead of landing you mid-function】:
//        · ptt_pair.dart:65 `transport.connect(url: dial, jwt: jwt,
//          pinFingerprint: pin)`                      (was :63)
//        · reconnect.dart:456-459 `secureDialUrl(url)` then
//          `.connect(url: target, token: _token, pinFingerprint: pin)`
//          — one site, every rung of the ladder             (was :355-358)
//        · ptt_session.dart:632-638 (resume) and :674-681
//          (`reconnect.configure(… pinFingerprint: live.lanTlsFp,
//          replacePin: true)` — re-arming the ladder under the same key)
//                                                (was :563-569 and :601-610)
//        · pair_retire.dart:49-54 `final String? pin = pairing.lanTlsFp` …
//          `probe.connect(… pinFingerprint: pin)`     (unrotted, still exact)
//      The check is lan_pinning.dart `PinnedHttpClient._judge` /
//      `pinnedWebSocketConnector`, and socket_core.dart:216-221 (was :213-218)
//      `if (pinFingerprint != null && !isSecureEndpoint(url)) throw
//      SocketHandshakeException(…)` REFUSES to dial a plain URL while holding a
//      pin rather than silently downgrading. Pinned by
//      test/lan_pin_enforced_on_every_dial_test.dart.
//   ② A pairing made BEFORE 0.2.60 is still plaintext, and the old warning is
//      still true FOR IT. ptt_session.dart:635-638 (was :566-569) says it in
//      the source:
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
//      【CORRECTED 2026-08-19 — ③ IS NO LONGER ON THIS SCREEN, AND ITS REASON
//      FOR EXISTING HALF SURVIVED THE MOVE AND HALF DID NOT.
//      WP3 C16 (2026-08-18) took the switch's name, its lockout cost and the
//      recovery out of `discStep4LanPlain`. Today the copy reads 「Encryption on
//      the local network depends on how the pairing was made」 — still a
//      CONDITION, but the condition it now states is ②'s, not ③'s. The mechanism
//      and the coordinate above are UNCHANGED and still exact (config.ts
//      `resolveLanTls`, second branch, `FLOWMIC_LAN_TLS === '0'`).
//      ⚠️ WHAT SURVIVES IS THE RULE: a sentence saying flatly 「the LAN is
//      encrypted」 would still go false the moment an operator sets that var, so
//      this paragraph must never be 「simplified」 into one.
//      🔴 WHAT DID NOT SURVIVE IS LOGGED AS A DEFECT AND DELIBERATELY NOT FIXED
//      HERE (this is a header task; the repair is a docs/legal/ edit and belongs
//      to whoever owns that page). Both the mixin's WP3 C16 block below and the
//      matching in-place correction in test/data_flow_disclosure_test.dart
//      justify the removal with 「the policy already carried all three」.
//      Measured 2026-08-19, dev-pc-a: the policy carries ONE of the
//      three. docs/legal/privacy-policy.md 「The local-network channel」 has the
//      switch (「Setting the environment variable `FLOWMIC_LAN_TLS` to `0`
//      returns this channel to unencrypted operation … so pairings made after
//      that are in the clear」) and stops there. The LOCKOUT — phones already
//      paired under TLS cannot connect at all and can report only a generic
//      failure — and the RECOVERY — delete-and-re-pair — are in SECURITY.md,
//      a repo file no user reaches from the app.
//      ⇒ W6R's finding is back in the tree in its original shape: the switch is
//      described where a user can read it and its cost is not. The note directly
//      below is the one that predicted this, and it is why it stays.】
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
//      【RE-MEASURED 2026-08-19, dev-pc-a — the shape of the answer moved
//      and the conclusion did not. `FLOWMIC_LAN_TLS` under apps/desktop/ now
//      hits FOUR files: strings/disclosure.ts (COMMENTS only — the desktop copy
//      no longer names the switch either, same WP3 C16 rewrite),
//      main-window/data-flow-disclosure.test.ts, `src-tauri/resources/server.js`
//      (the bundled sidecar; its target/debug twin is gone from this tree), and
//      — new since the line above was written —
//      main-window/components/DataFlowDisclosure.vue, which is A VUE COMPONENT,
//      so 「No Vue component … mentions it」 is now false. It is one comment line
//      pointing at the privacy policy, not a rendered string, so the conclusion
//      stands: nothing a desktop USER can read names the switch. ⇒ The wording
//      that rotted was the EVIDENCE (「no Vue component」), not the finding — and
//      those are the two halves people most often conflate when re-checking an
//      old measurement.】
// ⚠️ The paragraph sends the reader to "Connection encryption" in the connection
//   diagnostics sheet (connection_strings.dart:127 `diagEncryptionSection`,
//   reached by tapping the PC name — chat_header.dart:242 `ValueKey<String>
//   ('chat.deviceNameTap')` with `onTap: openDiagnostics` (was :192) →
//   openDiagnostics (chat_header.dart:160 `showConnectionDiagnostics`) →
//   connection_diagnostics_sheet.dart:442 `s.diagEncryptionSection`
//   (was :122 — that line is now the `diagState` row, i.e. this citation had
//   rotted into a DIFFERENT, plausible-looking row of the same sheet, which is
//   the silent-failure mode `:NNN` citations have)). Same "state the
//   condition and say where the current value is shown" shape stage ③ uses. That
//   pointer is not a comment's word: test/data_flow_disclosure_test.dart asserts
//   this string CONTAINS the live `diagEncryptionSection` getter, so renaming the
//   section breaks the test rather than silently orphaning the sentence.
//   (Verified 2026-08-19: that assertion is still in the suite, in the
//   `🔴 the expired 「not encrypted」 sentence cannot come back` test, together
//   with the emptiness guard that keeps the `contains` from being vacuous.)
//   It answers for legacy rows too — socket_core.dart:226-229 (was :224-226)
//   `_linkEncryption = isSecureEndpoint(url) ? LinkEncryption.unknown :
//   LinkEncryption.plain` sets plain on a `ws://` dial, so a pre-0.2.60 pairing
//   renders "unencrypted" (未加密) rather than the section vanishing.
// ⚠️ The three tier NAMES are deliberately NOT repeated here. The sheet already
//   discloses trust-on-first-use for hand-typed addresses in full
//   (`diagEncryptionTofuNote`), and a second copy of it here would drift.
//   Terminology is kept identical to that sheet on purpose: user-facing text
//   says 身份 / identity / 身元 / 신원 — never "fingerprint", "pin" or
//   "certificate", which live only in code, tests and the CHANGELOG.
//   【RE-MEASURED 2026-08-19, dev-pc-a — the list of four was the whole
//   catalogue when it was written and is now four of NINE. The other five say
//   身分 (zh-TW) / identité / identidad / Identität / личность, so read the
//   enumeration as 「all of them」 rather than as the set. The ban itself still
//   holds: no user-visible string in any of the nine says fingerprint or pin.
//   ⚠️ ONE EDGE, STATED RATHER THAN ROUNDED OFF: 「certificate」 has no clean
//   Chinese counterpart here — `diagEncryptionTofuNote` says 凭据 (zh-CN) and
//   憑證 (zh-TW), and 憑證 IS the ordinary zh-TW word for a certificate. English
//   sidesteps it ("there was nothing to check it against"). So the rule is kept
//   as written for the Latin and Japanese/Korean catalogues and is approximate
//   in Chinese; a future edit must not "fix" this by importing 指纹/PIN.】
// ⚠️ This string stays word-for-word with the desktop twin (the polish paragraph
//   remains this shard's ONE deliberate divergence). "on the phone" reads a
//   little redundantly on a phone screen, but that is a style wart, not an
//   untruth, and byte-parity is itself a guard against the two catalogues
//   describing one mechanism two ways — the exact failure W1.5 caught above.
//   🔴【EXPIRED — CORRECTED 2026-08-19, dev-pc-a. THE PARAGRAPH ABOVE IS
//   NO LONGER TRUE OF `discStep4LanPlain`, AND THE STYLE WART IT EXCUSES IS
//   GONE FROM THIS SIDE. Measured across all 20 disclosure keys, mobile English
//   vs desktop `disc_*` English, four now diverge:
//     · discStep4LanPlain — mobile 「This connection's state is under
//       "Connection encryption".」 vs desktop 「The current state is under
//       "Connection encryption" on the phone. The relay is TLS.」 The 「on the
//       phone」 the note above calls a wart is now correctly absent HERE and
//       correctly present THERE; the extra 「The relay is TLS.」 sentence exists
//       only on desktop.
//     · discStep3Body — the known polish divergence, but WIDER than 「this
//       phone does not have it」: desktop also carries 「that row shows its
//       current value」 and 「While it is off, Realtime sends nothing;
//       provisional words are never sent.」, neither of which is on the phone.
//     · discLead and discStep1Title — 「this phone / your PC」 vs 「your phone /
//       this PC」, a deliberate point-of-view swap, not drift.
//   ⇒ SO WHAT THIS NOTE MEANT IS DEAD AND WHAT IT WAS FOR IS NOT. Byte-parity
//   was never the goal; it was a cheap PROXY for 「two catalogues cannot
//   describe one mechanism two ways」, and the proxy stopped being available the
//   moment the two screens were shortened by different amounts. Nothing has
//   replaced it — there is no locale-parity or cross-app test comparing these
//   two catalogues — so from here on that guard is a human one. Do NOT restore
//   parity by copying desktop text back: two of the four differences are
//   correct, and a diff run without reading is how the 「on the phone」 wart
//   would return.
//   ⚠️ Logged, not fixed: whether the phone SHOULD also say 「provisional words
//   are never sent」 is a copy decision, and this was a header task.】
//   🔴【FOLLOW-UP 2026-08-19, SAME DAY — BOTH HALVES ARE NOW CLOSED, and the
//   paragraph above is kept because it is the diagnosis this fix was built on.
//   ① THE GUARD EXISTS AGAIN, and it is not byte-parity:
//   verify/lint/disclosure-copy-mirror.mjs pairs all 22 disclosure keys across
//   the two apps and requires every pair to be byte-identical IN ENGLISH or
//   DECLARED, with a reason and a fingerprint of both sides. So the four
//   point-of-view differences stay exactly as they are — the lint holds them
//   still rather than erasing them — and a FIFTH one cannot appear quietly.
//   It compares English only, and its header says why and what that leaves
//   uncovered. Do not read its green as 「the two screens say the same thing in
//   nine languages」.
//   ② THE COPY DECISION WAS MADE, TOWARDS THE PHONE. 「While it is off, Realtime
//   sends nothing; provisional words are never sent」 and 「The relay is TLS」 are
//   now in [discStep3Body] / [discStep4LanPlain] in all nine locales, lifted
//   from the desktop twin so the two screens carry one wording per language.
//   Both are true of the phone: whether the polish switch is on decides whether
//   ANY text reaches a language model, and the relay leg is wss:// either way.
//   The reason it was worth doing is that a phone-only user never opens the
//   desktop page — withholding a privacy fact from the only screen someone
//   reads is not neutral just because the other screen carries it.】
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
//   【RE-MEASURED 2026-08-19, dev-pc-a — the finding holds, the tally
//   moved. The same grep over the same four files now returns 4 hits, all in
//   privacy-policy.md 「The local-network channel」 (3) and SECURITY.md (1); the
//   policy's maintainer note and README.md's hits are gone, README now carrying
//   the scoped positive form instead (「The LAN channel is encrypted — if your
//   pairing is recent.」). No surface carries the blanket pre-0.2.60 claim.
//   ⚠️ Do NOT read a falling count as progress here: this grep can only find a
//   caveat that IS written down. It is blind to the failure this refresh
//   actually found — a caveat that was removed from one surface on the promise
//   that another already carried it. See the ③ correction above.】
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
  //   🔴【CORRECTED 2026-08-19, dev-pc-a — ② ARRIVED ONE-THIRD. Measured
  //   against docs/legal/privacy-policy.md 「The local-network channel」: the
  //   SWITCH-OFF is there; the LOCKOUT CONSEQUENCE and the RECOVERY STEPS are
  //   not. Both live in SECURITY.md 「`FLOWMIC_LAN_TLS=0` is an escape hatch, not
  //   a rollback」, which is a repo file, not a page this app links to. ① is
  //   fine — the policy's opening paragraph does carry the full four-tier order.
  //   ⇒ The removal from this screen was justified by a claim about a second
  //   surface that nobody diffed. Logged as a defect, deliberately NOT fixed in
  //   this header pass (the repair is an edit to docs/legal/, and shortening a
  //   screen on the strength of an unchecked 「it is already over there」 is the
  //   part worth remembering, not the missing paragraph). Full account in the ③
  //   correction in this file's header.】
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
  //
  // 🔴 IN-PLACE CORRECTION 2026-08-19 — that sentence NAMED the environment
  // variable, and it stopped being true this batch. It read 「it downloads one
  // over the internet only if you explicitly set FLOWMIC_SHERPA_AUTO_DOWNLOAD=1
  // on the computer」, which was accurate while the variable was the ONLY way to
  // consent. The PC's settings now have a download button
  // (docs/strategy/2026-08-19-local-model-onboarding-design.md §5-A) ⇒ the word
  // 「only」 turned false the moment the button shipped. What owner's ruling
  // bought was the CONSENT PROMISE, not the identifier, so the promise is what
  // the copy keeps: nothing is fetched until you ask for it, and the button is
  // where you ask. The variable survives as the unattended/CI path and is now
  // documented, not disclosed (§5-D bans it from body copy — and this screen is
  // the one read by someone holding a phone, not the computer the variable
  // would be set on).
  // It must stay true to the mechanism on the PC side: sherpa-local.ts parses
  // the flag strictly ('1'/'true'), default OFF, and a missing model fails loud
  // with STT_CONFIG_MISSING. Mirrors desktop disclosure.ts `disc_s2_local` —
  // the two surfaces change together or not at all, and `verify:lint
  // disclosure-copy-mirror` is what makes that a mechanism rather than a hope.
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
  // ⚠️ The clause is inserted BEFORE the parenthesised opt-in sentence, never
  // instead of it. (That sentence WAS owner's verbatim wording until
  // 2026-08-19, when the download button made its 「only if you set …」 false —
  // see the correction above. Its promise is pinned by the test below; the
  // identifier that used to carry it is now banned from the copy.)
  // ⚠️ the word "local" in all four languages (本地 / local / ローカル / 로컬) must
  // SURVIVE in this string — the REQ-13-09 seeded-tier guard uses it as its
  // positive control, so a rewrite that drops the word here would let the
  // ban leak out of discStep2Body. Pinned by
  // test/data_flow_disclosure_test.dart "🔴 the local-engine line scopes its
  // claim to speech and points text at ③ (REQ-13-09 / Q12㋐)", which also
  // measures the rendered paragraph at 360dp (the 0.2.53 rule).
  // (2026-08-19: the citation above used to stop before the parenthesis and so
  // matched no `testWidgets` title in the tree — grep the full string. The
  // guard itself is intact and still green after the WP3 C16 rewrite.)
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
