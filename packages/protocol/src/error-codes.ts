// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §5 (error-code namespaces)
//   docs/rebuild/06-STT-ENGINE-LAYER.md / 11-ENGINEERING-SYSTEM.md (i18n rule:
//     every code carries zh-CN + en)
//   F-1003 (error-codes.ts complete + zh-CN/en placeholders)
//
// Single source of truth for user-facing error codes. Every code MUST
// have both zh-CN and en messages — F-1003 / F-1005 lint enforces this.
// Messages are short, user-readable, no implementation jargon.

export interface ErrorMessage {
  zh_CN: string;
  en: string;
}

// ── 🔴 2026-08-10 · FOUR CODES REGISTERED AHEAD OF THEIR PRODUCERS (64 → 68) ──
//
// owner approved group #5 on 2026-08-10
// (docs/decisions/2026-08-10-owner-ruling-requests-from-lan-window.md — the
// result table at the top, the per-code reasoning in 一 #5). This round does the
// REGISTRY HALF ONLY: four codes here, plus one additive enum value on
// `AudioAutoStoppedSchema.reason` in protocol-schemas-audio.ts. No producer is
// wired. Cards fix-020…fix-024 do that and every one of them depends on this one.
//
// 🔴 SO ALL FOUR HAVE ZERO PRODUCERS RIGHT NOW — the façade shape this file has
// already deleted codes for twice (INJECT_NO_RECEIPT, CLOUD_SESSION_NO_HISTORY,
// both written up further down). It is accepted here for the same reason
// INJECT_PC_MISMATCH was: the producers are already carded and depend on this
// card, so the protocol face is agreed before three ends implement against it.
// The rule that keeps that honest is inherited verbatim from INJECT_PC_MISMATCH:
// **if the wave ships without a code's producer, that code goes with it.**
//
// 🔴 NONE OF THE FOUR RIDES `inject:result` TODAY, and that is a measurement, not
// an intention: inject-verdict-authorship.ts declares all four `'none'`, and a
// repo-wide grep for each name reaches only this file, that table, and
// packages/protocol/test/approved-codes-2026-08-10.test.ts.
// ⚠️ The day fix-021 puts PC_IMAGE_STORE_FAILED on an `inject:result`, that row
// stops being true and THREE things have to move in the same commit — the row
// itself, the phone's closed mirror set `kPcInjectionVerdictCodes`
// (apps/mobile/lib/src/session/outbox_inject_authorship.dart), and phone copy in
// `injectVerdictNote`. Miss the mirror and the phone reads an unrecognised code
// as 「还欠着」, returns the item to `queued` and shows 「待投递」 forever — the
// 0.2.48 P0 verbatim. That conditional is PINNED as an assertion rather than left
// as a note; see the approved-codes test named above.
//
// ⚠️ WIRE SHAPE — BOTH HALVES CHECKED RATHER THAN ASSUMED:
//   · the four codes change nothing. `error` is a KNOWN key of
//     InjectResultSchema and `SttErrorSchema.code` / `ComposeErrorSchema.code`
//     are `NonEmpty`, not closed enums, so a new code string rides the existing
//     frames untouched. `whitelist=54` is untouched — no event was added, removed
//     or renamed;
//   · the ENUM VALUE is the one part that is not purely additive on the wire, and
//     protocol-schemas-audio.ts states why at the value itself instead of leaving
//     the reader to notice.
//
// 🔴 EVERY NAME IS ≤ 28 CHARACTERS, WHICH IS A PRODUCT CONSTRAINT AND NOT A
// NAMING PREFERENCE. The phone truncates a raw code at 28
// (`chat_message_tile.dart` `_truncateFailureReason`) and 0.2.53 shipped a code
// rendered as three letters. Lengths: REGISTER_EMAIL_INVALID 22,
// LAN_CERT_PIN_MISMATCH 21, STT_NO_ENGINE_REACHED 21, PC_IMAGE_STORE_FAILED 21.
// ⚠️ Two EXISTING keys are over that line (INJECT_DEFERRED_NOT_AUTOINJECTED 32,
// INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED 33) and are deliberately left alone — neither
// can reach the raw-identifier surface, because each has human copy or a face of
// its own. That is why the guard added this round measures the NEW names and
// pins the two exceptions BY NAME, rather than claiming the whole table is under
// 28 (it is not) or dropping the rule because it is not universal (it is the rule
// that matters most on the codes a user can be shown raw).

export const ERROR_CODES = {
  // Authentication / pairing
  AUTH_TOKEN_INVALID:        { zh_CN: '令牌无效，请重新配对。',                en: 'Token invalid, please pair again.' },
  AUTH_TOKEN_EXPIRED:        { zh_CN: '登录已过期，请重新登录。',              en: 'Session expired, please sign in again.' },
  AUTH_LOGIN_FAILED:         { zh_CN: '邮箱或密码不正确。',                    en: 'Email or password incorrect.' },
  AUTH_USE_REST_LOGIN:       { zh_CN: '请通过登录接口完成登录。',              en: 'Please sign in via the login endpoint.' },
  // F-2327 (SB-3): per-IP registration throttle. Too many sign-ups from one IP
  // inside the window -> 429 (a throwaway-account farm mints unbounded free quota).
  REGISTER_RATE_LIMITED:     { zh_CN: '注册过于频繁，请稍后再试。',            en: 'Too many sign-ups from this network, please try again later.' },
  // 64 → 65. owner approved on 2026-08-10 (ruling group #5-d). A sign-up was refused
  // because the EMAIL STRING is not a legal address. Producer lands with card
  // fix-023 (`apps/server-core/src/auth/auth-service.ts`).
  //
  // 🔴 WHY NOT SETTINGS_SCHEMA_INVALID, which is what that path borrows today:
  // it renders 「设置内容不合法」 to somebody who is not in settings and has not
  // touched a setting — they are registering. The underlying fact ("your payload
  // did not validate") is true and the SENTENCE is false, which is the 0.2.18
  // PC_BUSY reuse again: the user is pointed at a screen they are not on, so
  // there is no action they can take that helps.
  //
  // ⚠️ IT SAYS NOTHING ABOUT WHETHER AN ACCOUNT EXISTS, and that is load-bearing
  // rather than incidental. `auth-service.ts` deliberately makes an unknown email
  // cost the same as a wrong password (a scrypt verify against a fixed dummy
  // hash) so neither timing nor copy is an enumeration oracle. Malformed is a
  // property of the STRING alone, so this refusal may be fast and specific
  // without leaking anything — but the copy must never grow a clause about the
  // account, and fix-023 is required to state what a caller can learn before and
  // after it lands.
  REGISTER_EMAIL_INVALID:    { zh_CN: '邮箱地址格式不正确，请检查后重新填写。',  en: 'This email address is not in a valid format — check it and try again.' },
  PAIR_INVALID_CODE:         { zh_CN: '配对码无效。',                          en: 'Invalid pairing code.' },
  PAIR_INVALID_PAYLOAD:      { zh_CN: '配对载荷无效；请重新扫描二维码或重新输入配对码。', en: 'Invalid pairing payload; please rescan the QR code or re-enter the code.' },
  PAIR_EXPIRED_CODE:         { zh_CN: '配对码已过期，请刷新。',                en: 'Pairing code expired, please refresh.' },
  PAIR_PC_OFFLINE:           { zh_CN: '电脑离线，无法配对。',                  en: 'PC is offline, cannot pair.' },
  PC_MOBILE_SLOT_BUSY:       { zh_CN: '电脑已连接其他手机，请先断开后再试。',  en: 'This PC is already connected to another phone.' },
  PAIR_NOT_CONNECTED:        { zh_CN: '未连接电脑，请先在 PC 端打开 FlowMic 并完成配对。', en: 'No PC connected — open FlowMic on your PC and pair first.' },
  // WP-R23-1: 4-digit-code brute-force guard. The code space is only 10^4, so an
  // unthrottled mobile:pair spray cracks the ACTIVE code within its 5-min TTL in
  // seconds. Per-socket exponential backoff (after 5 consecutive misses) + a
  // per-IP sliding-window cap reject further attempts with THIS code — an honest,
  // distinct signal (never masquerading as PAIR_INVALID_CODE). Additive, in-memory
  // only (0.1.0 single instance — no DB/schema touched).
  PAIR_RATE_LIMITED:         { zh_CN: '配对尝试过于频繁，请稍后再试。',            en: 'Too many pairing attempts, please try again later.' },
  // GA-08: the PC pressed 「断开」. The pairing is still VALID — only this
  // session ended — so a mobile:reconnect inside the 60 s suppression window is
  // refused with THIS code and not AUTH_TOKEN_INVALID: the mobile's ladder treats
  // an unknown code as transient (keeps the token, backs off, returns when the
  // window lapses), while AUTH_TOKEN_INVALID would wipe the pairing the user
  // never revoked. Distinct from PAIR_RATE_LIMITED (a brute-force verdict about
  // the caller) — this is a deliberate, operator-initiated pause.
  PAIR_RELEASED:             { zh_CN: '电脑刚刚断开了这台手机，请稍后再连接。',      en: 'The PC just disconnected this phone; please reconnect in a moment.' },
  // GA-29: the PC keeps BOTH channels resident (07 §6) but the capsule admits
  // exactly ONE phone at a time — and only the PC can see both channels, so only
  // the PC can decide. A second phone is refused with THIS code rather than being
  // left recording into a capsule that will never show it. Deliberately separate
  // from PAIR_RELEASED: nothing about this pairing is wrong and no operator
  // pressed anything, so the hold-out window is seconds, not a minute.
  PC_BUSY:                   { zh_CN: '这台电脑正被另一台手机占用。请先在那台手机上退出转录页，再从这里连接。', en: 'Another phone is using this PC. Leave the transcription page on that phone first, then connect from here.' },
  // ── PCID addressing (0.2.66) · 69 → 71, owner approved 2026-08-14 ────────────
  // Ruling   docs/decisions/2026-08-14-owner-cloud-pairing-requires-pcid.md
  // Design   docs/strategy/…-0266-cloud-pcid-pairing-design.md §5.3 — the full
  //          「why not a neighbour」 argument and the security account live there
  // Producer apps/server-core/src/room/registry.ts `resolvePcByPcid` (saas only;
  //          there is no PCID on the LAN)
  //
  // PCID splits ADDRESSING (public, 9 digits, stable) from the SECRET (the same
  // 4-digit, 5-minute, 20-guess code). Neither may borrow PAIR_INVALID_PAYLOAD
  // (claims a malformed frame; it is well-formed, and 「rescan」 is half the cure)
  // nor PAIR_INVALID_CODE (a claim about the CODE, which here may be perfectly
  // correct) — one value answering two questions is this repo's #1 defect shape.
  // 🔴 REQUIRED is the one refusal here a USER CAN FIX, so it names both actions;
  // it is also the phone's signal to FORCE its PCID field visible when its own
  // endpoint guess was wrong (apps/mobile/lib/src/ui/add_pairing_sheet.dart).
  PAIR_PCID_REQUIRED:        { zh_CN: '云端配对需要电脑的 PCID。请扫描电脑上的二维码，或输入电脑上显示的 PCID。', en: 'Cloud pairing needs this PC\'s PCID. Scan the QR code on the PC, or type the PCID it shows.' },
  // UNKNOWN folds 「malformed」 and 「no such PC」 together on purpose: one action
  // fixes both. ⚠️ It IS an existence oracle over the PCID space, ACCEPTED because
  // a PCID is public addressing — contrast '0000' in registry.ts, a secret.
  PAIR_PCID_UNKNOWN:         { zh_CN: 'PCID 没有对应的电脑，请核对电脑上显示的 PCID。', en: 'No PC matches that PCID — check the PCID shown on the PC.' },

  // LAN transport security
  // 65 → 66. owner approved on 2026-08-10 (ruling group #5-e). The phone dialled a PC on
  // the LAN and the TLS certificate it presented does not match the fingerprint
  // pinned when the two were paired, so the connection was refused. The surface
  // lands with card fix-024 (`apps/mobile/lib/src/signaling/lan_pinning.dart`,
  // whose `lastDialPinMismatch` already knows the difference internally).
  //
  // 🔴 TODAY THE USER IS TOLD NOTHING AT ALL — tapping the instance looks like it
  // did nothing, and the only trace is `CERTIFICATE_VERIFY_FAILED` in logcat
  // (real-device measured, ledger row W8-1). That is 没有静默失败 in its first
  // direction, and it is the expensive kind: a SOLVABLE problem (re-scan the QR
  // and pair again) turned UNSOLVABLE by silence.
  //
  // 🔴 WHY NOT ANY 「连不上」 WORDING, which is the obvious fold: the two send the
  // user to opposite places. 「连不上」 means go and check the network — and the
  // network is fine here; we reached that PC, spoke to it, and refused what it
  // presented. Folding them buys one word and spends the only action that works.
  //
  // ⚠️ THE COPY MUST NOT OFFER 「仍要连接」. A pin mismatch is the one signal that
  // the pinning is doing its job, and an override turns a working defence into a
  // prompt people click through; fix-024 carries that as a red line and this
  // sentence is written to match it — the only action it names is pairing again.
  LAN_CERT_PIN_MISMATCH:     { zh_CN: '这台电脑出示的安全证书与配对时记下的不一致，已拒绝连接。请在电脑上重新生成二维码，用手机重新扫码配对。', en: 'This PC presented a different security certificate from the one recorded when you paired, so the connection was refused. Generate a new QR code on the PC and scan it again to pair.' },

  // STT engine / config
  STT_CONFIG_MISSING:        { zh_CN: '该语言尚未配置识别引擎。',              en: 'No STT engine configured for this language.' },
  STT_ENGINE_AUTH_FAIL:      { zh_CN: '识别引擎鉴权失败，请检查 API Key。',    en: 'STT engine authentication failed, check API key.' },
  STT_ENGINE_RATE_LIMITED:   { zh_CN: '识别引擎请求过频，请稍后重试。',        en: 'STT engine rate limited, retry later.' },
  STT_ENGINE_TIMEOUT:        { zh_CN: '识别引擎响应超时。',                    en: 'STT engine timeout.' },
  STT_NETWORK_DROP:          { zh_CN: '网络中断，识别会话终止。',              en: 'Network drop, STT session terminated.' },
  // 66 → 67. owner approved on 2026-08-10 (ruling group #5-c). The utterance was captured
  // and NO speech engine ever received it. Producer lands with card fix-022
  // (`apps/server-core/src/stt/orchestrator-core.ts`).
  //
  // 🔴 WHY NOT STT_NETWORK_DROP — the code sitting directly above, and the one
  // this path answers with today. It says 「网络中断」 while the user's question is
  // 「我说的话去哪了」, so it sends them to check a WiFi connection that is working
  // perfectly. Same failure shape as the LLM_INVALID_MODEL reuse argued at
  // COMPOSE_OUTPUT_REJECTED below: it names a fault that does not exist, and every
  // minute spent acting on it is spent on the wrong thing.
  // ⚠️ STT_NETWORK_DROP KEEPS ITS MEANING EXACTLY. This code narrows what reaches
  // it; a genuine drop must still answer with it, and fix-022 is required to prove
  // that with a paired test rather than assert it — otherwise the ambiguity has
  // been moved rather than removed.
  //
  // 🔴 WHY NOT STT_CONFIG_MISSING either: that one answers 「这个语言还没配引擎」,
  // a configuration question with a configuration answer. This one is for the case
  // where an engine WAS selected and the audio still reached none of them.
  //
  // ⚠️ AND 「我判断不出来」 MUST NOT BECOME EITHER ANSWER. A path that genuinely
  // cannot separate the two keeps the old code and gets reported; stating an
  // unknown as a definite answer is the very defect this code exists to fix, one
  // level up.
  STT_NO_ENGINE_REACHED:     { zh_CN: '这段录音没有到达任何识别引擎，没有转成文字。请重新说一次；如果一直这样，请检查识别引擎设置。', en: 'This recording reached no speech engine, so nothing was transcribed. Say it again; if it keeps happening, check the engine settings.' },
  // 71 → 72. owner approved on 2026-08-17 (WP-2 card C1; the ruling is recorded in
  // docs/strategy/2026-08-17-wp2-task-book-settings-and-presence-followups.md §3-2).
  // The PLATFORM's engine pool was consulted and had no route it could give this
  // request — `selectRoute` answered `outcome:'refused'`
  // (`apps/server-core/src/pool/select-route.ts`), so `makePoolManagedDefault`'s
  // resolver returned null, and no user row and no seeded row covered the language
  // either. Producer: `apps/server-core/src/stt/engine-factory.ts`, the
  // `SttConfigMissingError` throw site, which now chooses between two codes instead
  // of always saying one of them.
  //
  // 🔴 WHY NOT STT_CONFIG_MISSING, the code this path used to answer with. Its
  // sentence is 「该语言尚未配置识别引擎」 ("no STT engine has been configured for this
  // language"), and on the relay every clause of that is FALSE: engines are
  // configured, several of them, and the operator can see them in the pool. Worse
  // than vague — it hands the user a task ("go configure an engine") on a surface
  // they do not own and cannot reach, so every minute spent acting on it is wasted.
  // The pool is OUR configuration, not theirs, which is why this sentence's second
  // half is the load-bearing half: nothing they can change will help.
  // ⚠️ STT_CONFIG_MISSING KEEPS ITS MEANING EXACTLY — a deployment with no pool and
  // no routings at all still answers with it, and that is pinned by a positive
  // control in `apps/server-core/test/stt-pool-refusal.test.ts` rather than assumed.
  //
  // 🔴 WHY NOT STT_NO_ENGINE_REACHED, the nearest neighbour. That code's own
  // registration above says it is for the case where 「an engine WAS selected and
  // the audio still reached none of them」 — i.e. a route existed and the audio got
  // lost on the way. Here NO route was ever selected and no audio was ever sent, so
  // its advice ("say it again") is exactly wrong: repeating the utterance re-runs
  // the same refusal. Two codes because the actions differ — wait/report vs. speak
  // again — which is the test this registry applies to every fold.
  //
  // ⚠️ THE SENTENCE DELIBERATELY DOES NOT NAME THE LANGUAGE. The refusal is not
  // always language-shaped: `POOL_GROUP_EMPTY` / `POOL_GROUP_UNKNOWN` mean the
  // group has no usable routes at all, and only `POOL_NO_CANDIDATE` is about the
  // language. One sentence that is true of all of them beats a more specific one
  // that is false for two thirds of its producers.
  //
  // ⚠️ NO 「稍后再试」/「try again later」, and that is a deliberate removal rather
  // than an omission — an earlier draft of this sentence had it. A pool refusal
  // does not heal on a timer: it lifts when an operator changes the pool, which
  // may be minutes or never. 「待…」-shaped promises are only allowed here when
  // something mechanically redeems them (CLAUDE.md red line, the 0.1.x 「待投递」
  // account). The phone mirror `sttStallPoolNoRoute` makes the same refusal in the
  // same words for the same reason; if one of the two ever grows the clause back,
  // the other one is now a written contradiction rather than a silent drift.
  //
  // ⚠️ NAME LENGTH: `STT_POOL_NO_ROUTE` is 17 characters, under the phone's 28-char
  // raw-code slot (`chat_message_tile.dart` `_truncateFailureReason`). A product
  // constraint, not a naming preference — and it is MEASURED, not counted by hand:
  // approved-codes-2026-08-10.test.ts asserts that the set of over-length codes is
  // exactly the two pinned exceptions, so a third would have gone red here.
  //
  // ZERO wire-shape change and NO relay-before-client deployment order:
  // `SttErrorSchema.code` is `NonEmpty`, not a closed enum, and the phone's
  // `stt:error` path has no closed set anywhere on it — an unrecognised code
  // degrades to `sttStallEngineErrorCoded` (a readable sentence plus the raw
  // identifier) and the stall still converges. `whitelist=54` is untouched.
  STT_POOL_NO_ROUTE:         { zh_CN: '平台这边没有可用于这次识别的引擎线路。这不是你的设置的问题——如果一直这样，请联系我们。', en: 'The service has no speech engine route available for this request. This is not a problem with your settings — if it keeps happening, tell us.' },
  STT_PROBE_FAIL:            { zh_CN: '连接测试失败，请检查地址或密钥。',      en: 'Connection test failed, check endpoint or key.' },
  STT_PROBE_SCHEME_MISMATCH: { zh_CN: '服务可经 ws:// 访问，但 wss:// 握手失败 — 该服务未启用 TLS，请把端点改为 ws://。', en: 'Server reachable via ws:// but wss:// handshake failed — endpoint has no TLS, change scheme to ws://.' },
  STT_HARD_LIMIT_REACHED:    { zh_CN: '已达 5 分钟单次最长录音限制。',         en: 'Reached 5-minute single-recording hard limit.' },

  // LLM / compose
  LLM_TIMEOUT:               { zh_CN: '大模型响应超时。',                      en: 'LLM response timeout.' },
  LLM_AUTH_FAIL:             { zh_CN: '大模型鉴权失败，请检查 API Key。',      en: 'LLM authentication failed, check API key.' },
  LLM_RATE_LIMITED:          { zh_CN: '大模型请求过频，请稍后重试。',          en: 'LLM rate limited, retry later.' },
  LLM_PROBE_FAIL:            { zh_CN: '大模型连接测试失败。',                  en: 'LLM connection test failed.' },
  LLM_INVALID_MODEL:         { zh_CN: '指定的模型不可用。',                    en: 'Specified model is unavailable.' },
  // 61 → 62. owner approved on 2026-08-07 (`docs/decisions/2026-08-07-owner-grants-
  // error-code-62-compose-output-rejected.md`). W2.5 gave translate/organize a
  // runtime output guard (FB-5's second cut): when the model answers instead of
  // translating, does not translate at all, or invents content, the result is
  // REFUSED rather than delivered.
  //
  // 🔴 THE POINT OF THE CODE IS THAT IT IS TRUE. Every existing neighbour renders
  // a sentence that is false here — the model DID respond, the key was fine,
  // nothing timed out, the output was NOT empty, and the model is configured
  // correctly. We are refusing what it produced. `LLM_INVALID_MODEL` is the worst
  // available reuse, not the best: 「指定的模型不可用」 sends the user to configure
  // a model that is already configured and working, i.e. it points at a fault
  // that does not exist. R11 (owner's iron rule 「状态一定要对」) says a status word that
  // cannot answer 「凭什么这么说」 must be replaced by one that can — so this is a
  // new code rather than a convenient lie.
  //
  // ⚠️ Deliberately NOT `COMPOSE_EMPTY_OUTPUT`: that one already owns a true
  // sentence for a DIFFERENT fact. Reusing it would trade a true sentence for a
  // false one and give one question two answers.
  //
  // 🔴 CORRECTED (2026-08-07): the sentence quoted above used to read 「AI 什么
  // 都没返回」 — that is not the real copy. The real string is 「AI 返回了空结果」
  // (`apps/mobile/lib/src/settings/strings/compose_strings.dart`, under
  // `case 'COMPOSE_EMPTY_OUTPUT'` — symbol anchor, not a line number: IT-50,
  // because the mobile lane legitimately edits that file and a line-numbered
  // reference here turns their normal edit into everyone's failing gate).
  // ⚠️ ALSO WORTH SAYING EXPLICITLY: `COMPOSE_EMPTY_OUTPUT` is NOT a key of
  // this ERROR_CODES catalog, despite sitting in the sentence right above a
  // real entry (`COMPOSE_OUTPUT_REJECTED`, below) — which invites a reader to
  // assume it is a neighbouring row in this same table. It is a mobile-LOCAL
  // code: defined only in the phone's own `compose_strings.dart` switch table
  // and thrown as a bare string literal from
  // `apps/mobile/lib/src/session/ai_compose_controller.dart` and
  // `utterance_compose.dart`. It never crosses the wire as a protocol
  // `ErrorCode` and has no entry here to reuse or to conflict with.
  //
  // ⚠️ ZERO wire-shape change: `ComposeErrorSchema.code` is `NonEmpty`, not a
  // closed enum, so this rides the existing frame. `whitelist=54` is untouched —
  // no event was added, removed or renamed.
  // ⚠️ Single quotes + an escaped apostrophe. When this entry was written,
  // `verify/lint/i18n-error-keys.mjs`'s parsing regex **only recognized
  // single-quoted strings**, so this entry's complete double-quoted copy was
  // reported by it as 「missing en」 — **the copy was complete; the ruler only
  // recognized one quoting style**. That lint has since been changed in the same
  // round to recognize both quote styles (reverse control: blanking out one `en`
  // still FAILs), so the single quotes here are now **stylistic consistency**,
  // not **evasion**.
  // 🔴 Deliberately no line number given: this entry originally read `:31-32`,
  // and the same round's comment added to that lint pushed those two lines down,
  // tripping `coordinate-anchors` red on the spot ⇒ **coordinate-anchor rot can
  // happen on a timescale of minutes**.
  COMPOSE_OUTPUT_REJECTED:   { zh_CN: 'AI 的结果不合要求，已拦下。',            en: 'The AI\'s answer did not meet the request, so we held it back.' },

  // Inject
  INJECT_TARGET_INVALID:     { zh_CN: '目标无效，无法注入。已缓存。',          en: 'Target invalid, cannot inject. Cached.' },
  // owner 2026-07-27: a focused WINDOW is not a focused INPUT. SendInput has no
  // receipt — it hands keystrokes to whatever holds keyboard focus — so with
  // nothing usable focused they were swallowed while we reported 「已注入」. The
  // keystrokes are NOT sent: stray synthetic keys outside an input site fire the
  // app's single-key accelerators, which is the real harm.
  // 2026-07-30: the desktop's JUDGEMENT behind this code changed (the UIA
  // 「is the focused element editable?」 query was retired for refusing every
  // browser dictation). It is now emitted only for the two things provable from
  // outside the target process: nothing holds keyboard focus, or a menu /
  // move-resize is active. The user-facing sentence is unchanged and still the
  // actionable one for both.
  INJECT_NO_TEXT_TARGET:     { zh_CN: '没有可输入的位置——请先点进输入框再说话。', en: 'No editable field is focused — click into a text box first.' },
  INJECT_SENDINPUT_FAIL:     { zh_CN: '应用拒绝了直接输入，已自动改用粘贴。',  en: 'App rejected input, used paste fallback.' },
  // ⚠️ 2026-07-30: INJECT_NO_RECEIPT was REMOVED here (56 → 55 codes). It named
  // the desktop read-back's 「发出去了但读不回来」 verdict, and read-back is retired
  // (owner ruled on 2026-07-30 that injected = 「已送到键盘焦点，且当时焦点处于可输入状态」 —
  // docs/decisions/2026-07-30-injected-means-delivered-to-keyboard-focus.md). With
  // no producer left, keeping the code would put a sentence in this table that
  // nothing can ever say — a façade on the protocol face, which is worse than a
  // missing nuance. The nuance it carried is gone too, and deliberately: the state
  // it described ('sent, unconfirmable') no longer exists as an outcome.
  INJECT_CLIPBOARD_FAIL:     { zh_CN: '剪贴板操作失败。',                      en: 'Clipboard operation failed.' },
  INJECT_IMAGE_UNSUPPORTED:  { zh_CN: '图片注入失败。',                        en: 'Image injection failed.' },
  INJECT_FOCUS_LOST:         { zh_CN: '焦点已丢失，注入取消。',                en: 'Focus lost, injection cancelled.' },
  // GA-28: the frame arrived on the channel that is NOT carrying the capsule
  // (a race: a refused phone's inject already in flight). Reported as a genuine failure
  // instead of being dropped — a request with no result leaves the phone's entry
  // stuck 「投递中」 forever.
  INJECT_NOT_PRIMARY:        { zh_CN: '这台电脑正被另一台手机占用，未注入。',    en: 'This PC is occupied by another phone; not injected.' },
  INJECT_TAURI_MISSING:      { zh_CN: '未检测到 Tauri 运行时；请在桌面端启动 FlowMic。', en: 'Tauri invoke unavailable; ensure the desktop runtime is present.' },
  // 2026-07-29 (owner「按最优选择修复」): the three server-side verdicts that used
  // to be SILENT. A dropped inject:request left the phone waiting out its 20 s
  // watchdog with no reason ever stated — the frame died at the zod boundary
  // (image_b64 over the 5.5M cap, seen live: 「reason: image_b64: too_big」) or in
  // relay's `getPc(room)?.emit` when no PC was in the room. Each verdict now has
  // an honest code and rides a server-authored inject:result back to the sender.
  INJECT_FRAME_TOO_LARGE:    { zh_CN: '图片数据超过上限，电脑侧未接收。',        en: 'Image data exceeds the wire cap; the PC never received it.' },
  INJECT_FRAME_INVALID:      { zh_CN: '发送的数据不符合协议，电脑侧未接收。',    en: 'Malformed frame; the PC never received it.' },
  // 2026-08-09 (DOC-HYG, conductor-reviewed): this used to read 「电脑不在线，
  // 未注入。」/ "nothing was injected" — a DELIVERY-segment code wearing an
  // INJECTION-segment word (投递 ≠ 注入, 15 册 §2.0). The frame never reached a
  // PC (`inject-verdict-authorship.ts`: INJECT_PC_OFFLINE is relay-authored), so
  // 「未注入」 answered for a machine that never judged it — the phone's own
  // deliveryRefusalNote already refused to mirror it for exactly this reason.
  // Deliberately NO retry promise here: the phone's copy may promise a resend
  // because it owns the queue that honours it; this string has consumers with no
  // such mechanism, and a promise without a mechanism is the F-1 red line.
  INJECT_PC_OFFLINE:         { zh_CN: '电脑不在线，这一条未送达。',              en: 'PC is not connected; this was never delivered.' },
  // 2026-07-30 (image-transit RCA-v3): the LAST silent drop on the relay path. A frame
  // arriving on a socket with no auth or no room used to `return` with no log
  // and no answer — which is exactly where a client-side reconnect flushes its
  // send buffer BEFORE re-registering, so the loss was real, reachable, and
  // indistinguishable from 「帧从未发出」. Deliberately distinct from
  // INJECT_PC_OFFLINE: that one says the ROOM has no PC (retrying later may
  // help); this one says the SENDER isn't in a room yet (rejoin, then retry).
  INJECT_NOT_IN_ROOM:        { zh_CN: '连接尚未就绪（未进入会话），请稍候重试。',  en: 'Connection not ready (not in a session yet); retry shortly.' },
  // 2026-07-30 (RV-04): the http image ingress refuses to relay a frame it could
  // not report a verdict for — its request_id ledger is momentarily full. First
  // written as PC_BUSY, which was a LIE in a user-visible string: PC_BUSY says
  // 「另一台手机占用了这台电脑」 and the phone renders exactly that, while the
  // actual fact is 「服务器这一刻接不下」 — nothing to do with another phone and
  // nothing the user could act on by leaving a page on it. Distinct code so the
  // sentence can be true; retryable either way.
  INJECT_SERVER_BUSY:        { zh_CN: '服务器同时处理的投递过多，这一次未发出，请稍候重试。', en: 'The server has too many deliveries in flight; this one was not sent — retry shortly.' },
  // 🔴 2026-07-31 (卡 P, owner's iron rule 「投递 id 与目标 PC 的 id 必须对应，不能串」).
  // The frame named a target PC (`inject:request.target_pc_id`) that is not the PC
  // on this connection. The verdict is REFUSE — never re-route, never deliver it
  // 「anyway」: a message typed into the wrong person's computer is not a degraded
  // delivery, it is the failure this red line exists to make impossible.
  //
  // Deliberately NOT INJECT_TARGET_INVALID, and the difference is the whole point:
  // that code answers 「这一行/这个目标窗口有问题」 — its one producer is the desktop
  // pipeline (src-tauri/src/inject/pipeline.rs, an over-cap or unusable target) and
  // its sentence is 「目标无效，无法注入。已缓存」, which tells the user to go fix
  // something about the window in front of them. THIS code answers
  // 「你要送的那台不是这台」 — nothing is wrong with the target, and nothing the user does to it
  // helps. Two questions, two codes: reusing one value for both is this repo's #1
  // bug shape, and the 0.2.18 PC_BUSY reuse already paid for the lesson once.
  //
  // The copy states the ADDRESSING fact and stops there — no imperative, because
  // there is nothing for the user to do and the phone is what re-addresses the
  // item; a 「请…」 here would read as 「你操作错了」 about something they never did.
  //
  // ⚠️ ZERO PRODUCERS AS OF THIS CARD — the check that emits it is the server-side
  // one (卡 S), one card later in the same wave. That is the opposite direction
  // from INJECT_NO_RECEIPT / CLOUD_SESSION_NO_HISTORY above, which were codes that
  // OUTLIVED their producers and were removed for it; this one precedes its
  // producer by design, because the protocol face is agreed before three ends
  // implement against it. The rule that keeps that honest: if the wave ships
  // without the server-side target check, THIS CODE GOES WITH IT — a sentence no
  // branch can say is a façade regardless of which side of the producer it is on.
  INJECT_PC_MISMATCH:        { zh_CN: '这条投递指定的是另一台电脑，未在这台电脑上注入。', en: 'This delivery is addressed to a different PC; nothing was injected on this one.' },
  // 🔴 2026-07-31 (window B3, 0.2.33). The frame named NO target PC at all. Until this
  // round that was a KNOWN COMPATIBILITY GAP — a 0.2.28 phone could not stamp
  // `target_pc_id`, so an address-less frame was forwarded unchecked with a log
  // line saying so. 0.2.32 senders stamp it on all four emission paths, so absence
  // stopped being 「这个手机还不会说」 and became a protocol violation, and the gap
  // closed the way this repo closes gaps: not by making the field `required` (that
  // kills the frame at the zod boundary, where the answer is an anonymous
  // 「数据不符合协议」), but by parsing it and refusing it BY NAME.
  //
  // Deliberately NOT INJECT_PC_MISMATCH, and this is the whole reason it is a
  // separate code rather than one more branch into that one: the two answer
  // different questions and put the user in different places.
  //   · MISMATCH  = 「你要送的那台不是这台」. The sender HAS an address and it is
  //     the wrong one — the interesting facts are which two machines, and there is
  //     nothing for the user to do (the phone re-addresses the item), so its copy
  //     states the fact and stops.
  //   · THIS CODE = 「你没说要送给哪台」. There is no address at all. Nothing is
  //     wrong with any machine and no re-addressing will happen on its own,
  //     because the sender is a build that does not stamp the field — the ONE
  //     actionable thing is to update the phone, so this copy says so and the
  //     other must not.
  // Folding them would produce a sentence claiming a target the frame never named
  // — half false, which is exactly what the 0.2.18 PC_BUSY reuse and the 0.2.29
  // INJECT_TARGET_INVALID call already paid for. A code is a sentence.
  //
  // ⚠️ Like every INJECT_* refusal, ONLY THE PHONE EVER SEES IT (the desktop does
  // not subscribe to inject:result). Do not add desktop copy for it — that would
  // be a new façade.
  INJECT_PC_UNSPECIFIED:     { zh_CN: '这条投递没有指明目标电脑，未注入。请更新手机端后重试。', en: 'This delivery named no target PC; nothing was injected. Update the phone app and retry.' },
  // ── RV-87 (owner 2026-08-01): the cloud relay's image policy — two codes ─────
  //
  // owner, verbatim: 「如果是中继通道，服务器统一拦客户端，图片超过 1M 就不允许传，防止将
  // 中继当作照片同步的工具」("if it's the relay channel, the server uniformly blocks
  // the client — images over 1 MB are not allowed through, to keep the relay from
  // being used as a photo-sync tool") + 「限制到 200 张吧……要加个限制排除机器的自动发」
  // ("cap it at 200 photos... and add a carve-out excluding automated machine sends").
  // Decision log: docs/decisions/2026-08-01-cloud-image-policy-size-cap-and-anti-sync.md.
  //
  // WHY TWO CODES AND NOT ONE 「云端拒收了这张图」. They send the user to two
  // different places, which is the only test this repo uses for splitting a code:
  //   · TOO_LARGE — the picture is the problem, and it is ONLY a problem on this
  //     channel. The action is switching to the LAN, and over there the same file goes through
  //     untouched (kInjectImageB64Budget is ~3.9 MB raw, four times this ceiling).
  //     Waiting does nothing.
  //   · QUOTA_EXCEEDED — nothing is wrong with the picture. The action is waiting (or,
  //     equally true, switching to the LAN — the ceiling is a relay policy and the LAN sidecar
  //     never counts). Choosing a different picture does nothing.
  // Folding them would produce a sentence that is half false whichever half you
  // keep — the exact cost the 0.2.18 PC_BUSY reuse and the 0.2.29
  // INJECT_TARGET_INVALID call already paid. A code is a sentence.
  //
  // WHY NOT INJECT_FRAME_TOO_LARGE, which is the obvious reuse: its sentence is
  // 「图片数据超过上限，电脑侧未接收」 — a statement about the WIRE cap that holds on
  // both channels, so it tells a user on the relay to go find a smaller picture
  // when the picture they have is fine and the LAN would carry it as-is. Same
  // fact ("too big"), different question ("too big for what").
  //
  // WHY NOT QUOTA_EXCEEDED for the second one: that code says 「本月套餐用量已达上
  // 限」 and its whole point is that PAYING RAISES IT (it is produced by
  // billing/quota-guard against the plan's STT/LLM budget). This ceiling is an
  // anti-abuse gate that no plan raises, so reusing it would put an upgrade prompt
  // in front of a user for whom upgrading changes nothing.
  //
  // ⚠️ THE NUMBERS IN BOTH SENTENCES ARE PINNED to CLOUD_IMAGE_BYTES_MAX /
  // CLOUD_IMAGE_QUOTA_MAX (constants.ts) by test/error-codes.test.ts — a limit
  // that moves without its copy moving fails there rather than shipping a server
  // that refuses at one number while naming another.
  //
  // ⚠️ ONLY THE PHONE EVER SEES THESE (the desktop does not subscribe to
  // inject:result — see the note at INJECT_PC_UNSPECIFIED). Do not add desktop
  // copy for them.
  INJECT_CLOUD_IMAGE_TOO_LARGE: { zh_CN: '云端中继不传超过 1 MB 的图片，这一张未发出。连到同一局域网就能发。', en: 'The cloud relay does not carry images over 1 MB; this one was not sent. Connect over the same LAN to send it.' },
  INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED: { zh_CN: '这个账号 24 小时内经云端中继发送的图片已达 200 张上限，这一张未发出。请稍后再试，或连到同一局域网发送。', en: 'This account has reached the 200-image / 24-hour cloud relay limit; this one was not sent. Try again later, or connect over the same LAN.' },
  // ── 🔴 2026-08-02 (owner ruling: re-delivered messages must not auto-inject) ──
  //
  // docs/decisions/2026-08-02-deferred-delivery-must-not-autoinject.md. The frame
  // said `inject_origin:'deferred'` — an AUTOMATIC re-delivery (a reconnect drain, a
  // PC_BUSY-release drain), not anything the user did just now — so the PC did not
  // type it, **even though it had a live focused window**. owner:「这时用户对这个行为
  // 是不可预知、没有准备的，直接注进当前输入窗口可能引起事故。」("at this moment the
  // user has no way to anticipate this action and isn't prepared for it — injecting
  // straight into the current input window could cause an accident.")
  //
  // 🔴 IT IS NOT A FAILURE, AND THE COPY MUST NOT READ AS ONE. The delivery
  // SUCCEEDED — the message is on the PC, on its timeline, with its own row. Only
  // the INJECTION was withheld, on purpose, by policy. This is the 投递/注入 two-segment
  // split (2026-08-02-delivery-vs-injection-terminology-contract.md) in its sharpest
  // form: 投递成功 + 未注入·已缓存, and a code that said 「没送到」 would be false.
  //
  // WHY IT IS A CODE AT ALL, rather than a bare `ok:false, mode:'cached'`:
  //   · 没有静默失败 — every non-injected outcome on this path carries a named code
  //     (src-tauri/src/error_codes.rs's own opening rule). An outcome with no code
  //     would be the one branch where the PC declines to act and says nothing;
  //   · the QUEUE needs it. Without a positive signal the phone's outbox reads this
  //     as an ordinary retryable failure and returns the item to `queued` — and
  //     since EVERY subsequent drain is by definition another re-delivery, the item can
  //     never succeed: it would be re-sent on every reconnect for the life of the
  //     install while 「还有 N 条未投递」 counted it forever. `settle` keys the
  //     terminal 「投递成功」 on THIS code (delivery_outbox.dart);
  //   · 🔴 and it is a code rather than a new additive field on `inject:result`
  //     because `error` is a KNOWN key of InjectResultSchema — a relay older than
  //     this round forwards it untouched, whereas an unknown key is STRIPPED in
  //     flight (zod). The queue's terminal decision therefore does not depend on the
  //     relay's version, which the injection decision itself unavoidably does.
  //
  // Deliberately NOT a reuse of either neighbour:
  //   · INJECT_FOCUS_LOST says 「焦点已丢失，注入取消」 — the OTHER cause of `cached`,
  //     and a completely different user action (click into a text box and it will
  //     land). Folding them is the one thing 15 册 explicitly forbids for this
  //     status: cached now has two causes and they must stay distinguishable;
  //   · INJECT_NOT_PRIMARY says 「另一台手机占用了这台电脑」 — about a different
  //     machine's session, and nothing here is occupied.
  //
  // ⚠️ ONLY THE PHONE EVER SEES IT (the desktop does not subscribe to inject:result
  // — see the note at INJECT_PC_UNSPECIFIED). The PC states the same fact on its own
  // row and in its forensic line; do NOT add desktop copy for this code.
  //
  // 🔴 THE COPY STATES THE FACT AND STOPS — NO IMPERATIVE — AND THAT IS DELIBERATE.
  // The first draft ended 「请在电脑的时间线上点『重新注入』」. That sentence is TRUE for
  // a transcript row and FALSE for a picture row, which is 「文案承诺一个不存在的动作」
  // — the red line's own literal wording. The evidence, all greppable:
  //   · PC:   `TimelinePage.vue` `rowCanReinject` = `e.entry_type !== 'image' &&
  //           canReinject(e.status)` ⇒ an IMAGE row renders NO 重新注入 button
  //           (the button at :592 is `v-if="rowCanReinject(e)"`). The function's own
  //           doc says why and logs it as a gap: 重新注入 re-types the ROW'S TEXT, and
  //           a picture row's text is its descriptor 「🖼 PNG · 214 KB」.
  //   · PHONE: `chat_message_tile.dart` offers 重发 on a `undelivered` face, but for a
  //           picture it also requires `canResendImage`
  //           (`OutboxPendingView.resendableImageEntryIds` ⇒ `item.isPending`) — and
  //           this verdict settles the item TERMINALLY (delivered), so that set no
  //           longer contains it.
  // ⇒ 🔴 OPEN GAP, NAMED RATHER THAN PAPERED OVER: a DEFERRED PICTURE has no
  // 「inject it now」 affordance on either end today. It is not lost — it is on the PC
  // timeline and `socket::row_image` kept the full picture, so 点开大图 works — but
  // the user cannot ask for the paste. Closing it is a PC-side capability (read the
  // file → clipboard → paste), which `rowCanReinject`'s doc already logs as a gap and
  // which is deliberately NOT invented here. Same posture as INJECT_PC_MISMATCH:
  // state the fact, add no imperative the product cannot honour.
  //
  // 59 → 60. Ships WITH its producer (src-tauri/src/inject/pipeline.rs
  // `deferred_outcome`, reached from socket/inject_ops.rs `run_inject`) and with its
  // consumer (apps/mobile delivery_outbox_settle.dart `outboxSettle`), pinned by the
  // Rust inline tests, apps/mobile/test/outbox_test.dart and verify/golden/g19-*.
  // ⚠️ NO PHONE RENDERER YET — like INJECT_FOCUS_LOST / INJECT_NOT_PRIMARY and every
  // other code that settles a row `undelivered`, the phone shows the FACE and stays
  // silent about the code (`chat_message_tile.dart` `_reasonLineFor`: 未投递 speaks
  // only for the two cloud-image codes). Adding a third exception belongs with the
  // 投递/注入 word pass that owns that table, not here.
  INJECT_DEFERRED_NOT_AUTOINJECTED: { zh_CN: '这条是自动补投的消息，已送到电脑并留在电脑的时间线上；为免打断你手上的事，没有自动注入。', en: 'Re-delivered automatically: it reached the PC and is on its timeline. It was deliberately not auto-injected, so it could not interrupt what you were doing.' },
  // 🔴 owner 2026-08-02 (F1a reversal ruling, docs/strategy/2026-08-02-0248-status-truth-analysis.md
  // 「owner clarification」 item 1):「FlowMic 自家输入框（如时间线搜索框）必须能注入——它本身就是
  // PC 端的一个窗口，光标定位到这里我说的话肯定能注入，这是非常正常的要求。」("FlowMic's
  // own input fields — like the timeline search box — must be able to receive
  // injection: it's a window on the PC side just like any other, so if the cursor
  // is sitting there, what I say should obviously be able to go in. That's a
  // perfectly normal expectation.")
  //
  // This code is the OTHER half of that ruling: FlowMic's own window IS the window in
  // front of the user, and nothing in it holds an editable focus. Nothing was typed.
  //
  // 🔴 IT IS NOT A FAILURE AND IT IS NOT A GUESS. `mode:'cached'` — the delivery
  // succeeded, the row is on the PC's timeline, only the injection had nowhere to
  // land. And unlike every cross-process judgement in this product, this one is
  // PRECISE: FlowMic's own window is FlowMic's own PROCESS, and the WebView reports
  // which element holds DOM focus (src-tauri/src/inject/self_focus.rs). The
  // 2026-07-30 ruling 「跨进程判不了就打字」 therefore does not reach here, and saying
  // so is the point — owner's clarification is explicit that the boundary does not
  // apply to our own window.
  //
  // Deliberately NOT a reuse of any of its three neighbours:
  //   · INJECT_FOCUS_LOST — `cached`'s FIRST cause: 「我们没拿到任何目标窗口」. It cannot
  //     name the window; this one can, and the window is on screen right now. Folding
  //     them puts a sentence about somebody else's app on a screenful of FlowMic;
  //   · INJECT_DEFERRED_NOT_AUTOINJECTED — `cached`'s SECOND cause: 「窗口没问题，是我们
  //     刻意不注」, where nothing the user does to the window helps. This one is fixed
  //     BY the window. Opposite advice ⇒ third code (15 册 §2.5e-4: the causes of one
  //     status share `mode` and must never share a code);
  //   · INJECT_NO_TEXT_TARGET — rides `mode:'sendinput'` ⇒ the relay maps it to
  //     `failed`, and owner's ruling for this case is 未注入 · **已缓存**.
  //
  // 🔴 THE IMPERATIVE IS ALLOWED HERE, and the contrast with INJECT_DEFERRED_NOT_
  // AUTOINJECTED above is the reason it has to be argued rather than assumed. That
  // code carries no instruction because a deferred PICTURE has no 「inject it now」
  // affordance on either end. This code only ever rides a TEXT delivery (the picture
  // path is deliberately excluded — `pipeline.rs` `self_window_stage0`), and a cached
  // transcript row DOES render 重新注入 (`TimelinePage.vue` `rowCanReinject` =
  // `entry_type !== 'image' && canReinject(status)` ⇒ true for a cached transcript).
  // So the action the copy names exists and can be taken.
  //
  // ⚠️ ITS RENDERERS ARE ON THE **PC**, which is the reverse of the codes above it.
  // The desktop mints its own row and forwards the verdict to its own windows
  // (`socket::row_transit::forward_verdict` → `flowmic://inject-result`), so the
  // capsule and the timeline read this code locally; the phone shows only 已投递
  // (投递/注入 two-segment contract, 15 册 §2.5e-8). The desktop copy is
  // `lib/strings/capsule.ts` INJECT_FAIL_REASON — ONE definition, read by both PC
  // surfaces (§2.5c).
  //
  // 60 → 61. ZERO wire-shape change: `error` is a KNOWN key of InjectResultSchema, so
  // every relay forwards the string untouched (the same property that made
  // INJECT_DEFERRED_NOT_AUTOINJECTED a code rather than a field). No relay redeploy is
  // required BY THIS CODE.
  INJECT_SELF_WINDOW_NO_INPUT: { zh_CN: '焦点在 FlowMic 自己的窗口上，没有停在可以输入的位置，所以没有注入。点进 FlowMic 的输入框，或切到你要输入的程序，再重新注入。', en: 'Focus was on FlowMic\'s own window and not in an editable field, so nothing was typed. Click into a FlowMic input box, or switch to the app you want, then re-inject.' },
  // ── MAC-05: the two macOS conditions under which the OS silently swallows a
  //    synthetic keystroke. owner approved on 2026-08-07 (docs/decisions/2026-08-07-owner-
  //    grants-mac-injection-refusal-codes-63-64.md). Producer for both:
  //    `apps/desktop/src-tauri/src/inject/preflight.rs` `synthetic_input_verdict`,
  //    reached from `inject/pipeline.rs` `synthetic_input_preflight()` on the text
  //    path and the image path. `control:key` takes the same gate but has no result
  //    frame, so there it only reaches the forensic log (`socket/inject_ops.rs`
  //    `ChordExit::OsWillNotDeliver`).
  //
  // 🔴 BOTH ARE `mode:'cached'`, i.e. THE DELIVERY SUCCEEDED. The frame is in the
  // PC's own process when the judgement is made and `row_transit::mint_row` mints
  // its timeline row from the very expression that produced this verdict
  // (`socket/client.rs`). Only the injection was withheld. Neither sentence may
  // ever be read as 「没送到」 (投递 ≠ 注入, docs/rebuild/15 §2.0).
  //
  // 🔴 WHY NEITHER COULD BORROW AN EXISTING CODE — every candidate is not vague
  // but FALSE, which is the one thing R11 forbids outright:
  //   · INJECT_NO_TEXT_TARGET 「点进一个输入框」 — a password field IS editable and
  //     IS focused. It sends the user to do the thing they already did;
  //   · INJECT_CLIPBOARD_FAIL — the pasteboard write SUCCEEDS in both cases; what
  //     fails is the ⌘V that follows it;
  //   · INJECT_FOCUS_LOST 「我们没拿到目标窗口」 — the focus is exactly where we want
  //     it. Nothing about the window is wrong;
  //   · INJECT_TARGET_INVALID is merely vague rather than false, and it is already
  //     spoken for (over `INJECT_TEXT_MAX_CHARS`). Borrowing it would give ONE code
  //     two questions — this repo's #1 historical bug shape;
  //   · INJECT_SELF_WINDOW_NO_INPUT — that one is about OUR window; these two hold
  //     no matter whose window is in front.
  //
  // 🔴 AND WHY THE TWO ARE NOT FOLDED INTO EACH OTHER, by the usual test (does it
  // send the user somewhere different?): YES, and they are the furthest apart of
  // any pair in this table. 63 is undone by leaving a field; 64 is undone only in
  // System Settings and holds for EVERY app until it is. Telling a user with no
  // Accessibility grant to 「离开密码框」 sends them hunting for a password field
  // they do not have while the real answer sits in a settings pane — which is why
  // `synthetic_input_verdict` also checks 64 FIRST.
  //
  // ⚠️ 64 IS THE ONLY FAILURE ON THIS WHOLE PATH THE USER CAN FIX THEMSELVES, so
  // its copy names the exact pane rather than a category. Under ad-hoc signing the
  // grant is keyed to a code signature that changes on every rebuild — that is a
  // DEV-time fact and is deliberately kept out of the user-facing string (it lives
  // in `preflight.rs`'s `error_message`, which is the developer-facing surface).
  //
  // 62 → 63.
  INJECT_SECURE_INPUT_ACTIVE: { zh_CN: '电脑正处在系统的安全输入状态（密码框、终端的「安全键盘输入」或锁屏），系统不接收任何模拟按键，所以没有注入。这一句已经送到电脑，留在电脑的时间线上。离开密码框后在电脑上重新注入。', en: 'The PC is in the system\'s secure input mode (a password field, Terminal\'s Secure Keyboard Entry, or the lock screen), where synthetic keystrokes reach nobody, so nothing was typed. It did reach the PC and is on its timeline. Leave the secure field, then re-inject on the PC.' },
  // 63 → 64. ZERO wire-shape change for both: `error` is a KNOWN key of
  // InjectResultSchema, so every relay forwards the string untouched and no relay
  // redeploy is required by either code (the same property that made
  // INJECT_DEFERRED_NOT_AUTOINJECTED a code rather than a field). `whitelist=54`
  // is untouched — no event was added, removed or renamed.
  //
  // ⚠️ THE NAME IS SHORT ON PURPOSE AND MUST NOT BE LENGTHENED. The phone truncates
  // a raw code at 28 characters (`chat_message_tile.dart` `_truncateFailureReason`).
  // The originally drafted `INJECT_ACCESSIBILITY_NOT_GRANTED` is 32 ⇒ it would have
  // rendered as 「INJECT_ACCESSIBILITY_NOT_GRA…」, a verbatim repeat of the defect
  // that caused the 0.2.53 release — on the one failure a user can actually fix.
  // `INJECT_NO_ACCESSIBILITY` is 23.
  INJECT_NO_ACCESSIBILITY: { zh_CN: '电脑上还没给 FlowMic「辅助功能」权限，系统会丢掉它发出的每一个按键，所以没有注入。这一句已经送到电脑，留在电脑的时间线上。到电脑上打开「系统设置 ▸ 隐私与安全性 ▸ 辅助功能」，把 FlowMic 打开，再重新注入。', en: 'FlowMic has not been granted Accessibility on the PC, so the system discards every keystroke it sends and nothing was typed. It did reach the PC and is on its timeline. On the PC open System Settings ▸ Privacy & Security ▸ Accessibility, turn FlowMic on, then re-inject.' },
  // R-i18n-1 SSOT: mandated by the R-mobile-5 "Invalid kind → typed error"
  // rule. Produced by the Rust key command (F-2110), surfaced by the desktop
  // control:key consumer (F-2111) via result.error_code. Renamed in the
  // WP-R0-1 window (controller ruling) from its legacy FLOW_ name to track the
  // control:key event rename — old→new mapping in the decision log.
  CONTROL_UNKNOWN_KIND:      { zh_CN: '不支持的快捷操作，已忽略。',            en: 'Unsupported quick action, ignored.' },

  // PC-local storage (the PC's own disk — deliberately NOT the Inject block above)
  // 67 → 68. owner approved on 2026-08-10 (ruling group #5-b). The picture reached the PC
  // and the PC could not write it to disk — `socket/row_image.rs` `store` returns
  // false on a full disk, a failed mkdir or a failed rename. Producer lands with
  // card fix-021.
  //
  // 🔴 IT IS A **STORAGE** FACT, NOT AN INJECTION FACT, AND THE NAMESPACE SAYS SO
  // ON PURPOSE — this is the whole reason it is not an `INJECT_*` name. Every code
  // in the block above answers 「这一句/这张图有没有进到那个窗口」. This one answers
  // 「电脑有没有把这张图留下来」, and the two genuinely come apart: the paste can
  // succeed while the write fails, and the write can succeed while the paste does
  // not. INJECT_IMAGE_UNSUPPORTED is the worst available reuse rather than the
  // best — its sentence blames the PICTURE (unsupported format, too large) when
  // the picture is fine and the disk is not, so it sends the user off to convert
  // or shrink a file that would store perfectly tomorrow.
  //
  // 🔴 WHY IT IS WORTH A CODE AT ALL — **and the original answer here was wrong,
  // measured 2026-08-10 during fix-021.** The sentence that stood here read:
  // 「today the wire still answers `ok:true`, so BOTH ENDS write 「成功」 while the
  // picture is nowhere. That is 没有静默失败 in its SECOND direction…」.
  // It is quoted rather than deleted because this entry is what a future executor
  // reads to decide what the code means, and an un-marked rewrite would let the
  // same wrong premise be re-derived from scratch.
  //
  // **Both halves are false.** `socket/row_image.rs` states in its own words that
  // the store runs AFTER the inject, 「so the delivery is unaffected — only the
  // row's 点开大图 is」: the picture was already pasted into the focused window,
  // so `ok:true` is the correct answer to the question `ok` asks. And
  // `socket/row_transit.rs` sets `full_image` ONLY when the store returned true,
  // with a comment spelling out that a row claiming a picture it does not have
  // would offer a double-click that opens nothing — 「一个改变不了任何东西的控件」.
  // So there is no silent success and no lying control.
  //
  // ⇒ Acting on the retracted premise would have made the product WORSE: flipping
  // `ok:false` reports a delivery that genuinely succeeded as a failure — a new
  // lie pointing the other way.
  //
  // **What the code is actually worth having for** is narrower and still real:
  // the user is never told the PC could not KEEP the picture. They get an image
  // row with no large-image affordance and no way to know why, when the cause
  // (disk full, permissions) is one of the few on this path they can fix
  // themselves. The copy below already says exactly that — it affirms delivery
  // and denies only the keeping — so the string needed no change when the premise
  // was corrected. That is a coincidence worth noticing, not a vindication:
  // the copy was written from the mechanism, and the premise was not.
  //
  // ⚠️ The M5 F-4 compounding case survives the correction: an image the target
  // never took, with the clipboard already withdrawn, IS gone from both places —
  // but that is a failure of the paste, not of this store, and this code does not
  // answer it.
  //
  // ⚠️ THE COPY NAMES A CHECK, NOT A RETRY, AND THAT IS ARGUED RATHER THAN
  // ASSUMED. Whether a failed store should be re-attempted is a product question
  // nobody has ruled on (fix-021 is explicitly forbidden from inventing one), and
  // 「重发」 is a promise this product may not be able to honour on a picture row —
  // the affordance gap is written out at INJECT_DEFERRED_NOT_AUTOINJECTED above
  // and is still open. Naming free space and write permission covers all three
  // measured causes and promises nothing that may not exist.
  //
  // ⚠️ THE SENTENCE OPENS BY CONFIRMING DELIVERY (「已经送到电脑」) and says nothing
  // about injection, which is the 投递 ≠ 注入 split (15 册 §2.0) applied to a third
  // segment that neither word covers: the frame demonstrably arrived, the row is
  // minted, and whether the keystrokes landed is a different question answered by
  // a different code.
  PC_IMAGE_STORE_FAILED:     { zh_CN: '图片已经送到电脑，但电脑没能把它保存下来，这张图没有留在电脑上。请检查电脑的磁盘空间和写入权限。', en: 'The picture reached the PC but the PC could not save it, so it was not kept there. Check the free disk space and write permissions on the PC.' },

  // Settings
  SETTINGS_SYNC_FAIL:        { zh_CN: '云端同步失败，已保存本地。',            en: 'Cloud sync failed, saved locally.' },
  SETTINGS_SCHEMA_INVALID:   { zh_CN: '设置内容不合法。',                      en: 'Settings payload invalid.' },

  // Quota / plan
  QUOTA_EXCEEDED:            { zh_CN: '本月套餐用量已达上限。',                en: 'Monthly plan quota exceeded.' },
  PLAN_UPGRADE_REQUIRED:     { zh_CN: '该功能需要升级到 Pro。',                en: 'This feature requires Pro upgrade.' },
  PCS_LIMIT_EXCEEDED:        { zh_CN: '已达套餐电脑数量上限。',                en: 'Plan PC limit reached.' },
  MOBILES_LIMIT_EXCEEDED:    { zh_CN: '已达套餐手机数量上限。',                en: 'Plan mobile limit reached.' },
  // F-2325 (SB-1): only an admin may change a plan (admin grants Pro per SPEC;
  // online payment is restraint-#4-locked). Surfaced to the console Upgrade CTA.
  ADMIN_ONLY:                { zh_CN: '仅管理员可执行此操作。',                en: 'Only an admin may perform this action.' },

  // ── Account standing (card A2-3, 2026-08-12) ───────────────────────────────
  //
  // 「这个账号被限制使用，所以这个动作我们不做。」("this account is restricted from
  // use, so we won't perform this action.") 68 → 69.
  //
  // Owner approved ADDING a code for this state (docs/decisions/owner-web-
  // rulings/latest.md:71 + the design's §8 gate 2); the NAME was the open half,
  // and the lead ruled it `ACCOUNT_RESTRICTED` on 2026-08-12 [owner ratification
  // pending]. Two constraints decided the name over the ban design's original
  // `ACCOUNT_SUSPENDED`:
  //   ① SEMANTICS — 「suspend」 is the English of the very word owner called too
  //      authoritative (「封禁这个词太权威，改为限制使用」), and a CODE NAME IS
  //      USER-VISIBLE COPY: when a surface has no human sentence for a code it
  //      renders the identifier itself. `ACCOUNT_BANNED` is worse for the same
  //      reason.
  //   ② LENGTH — 18 characters, inside the phone's 28-character raw-code slot
  //      (`chat_row_reason.dart` `_truncateFailureReason`). 0.2.53 shipped a code
  //      that rendered as three letters; the census in
  //      test/approved-codes-2026-08-10.test.ts is what keeps that from recurring.
  //
  // 🔴 WHAT IT DOES **NOT** MEAN — sign-in still succeeds. owner: 「用户还可登录，
  // 但只看到被限制使用的提示」("the user can still sign in; they just see a notice
  // that their account is restricted"). So this code never appears on a login response; it
  // appears when a restricted (and fully authenticated) session asks for a
  // capability. `apps/server-core/src/auth/account-restriction.ts` is the policy
  // module, and it enumerates the four near-miss codes and the exact lie each
  // would tell — AUTH_TOKEN_INVALID would make the phone WIPE a pairing nobody
  // revoked, AUTH_LOGIN_FAILED sends the user to reset a working password,
  // ADMIN_ONLY answers the caller's ROLE, and QUOTA_EXCEEDED / PLAN_UPGRADE_
  // REQUIRED say 「pay and it goes away」 about a decision with no appeal channel.
  //
  // ⚠️ TODAY IT HAS EXACTLY ONE PRODUCER FAMILY: the saas console REST gate
  // (`http/console-routes.ts` `refuseRestricted`). It is deliberately NOT on
  // `inject:result` this round — that path means widening the phone's CLOSED
  // verdict set and its terminal-refusal table, and an unknown code there means
  // 「待投递」 forever (the 0.2.48 P0 shape). Deferred by lead ruling, with the
  // reason, rather than half-done. `inject-verdict-authorship.ts` therefore
  // declares it `'none'`, which is a statement about TODAY and is guarded.
  // ⚠️ The phone's own four-language copy table does NOT carry this code yet,
  // because no phone surface can receive it yet. The day one can, that table is
  // the face nothing checks (CLAUDE.md records it as a still-open root cause).
  ACCOUNT_RESTRICTED:        { zh_CN: '此账号已被限制使用。',                  en: 'This account has been restricted.' },

  // Timeline (V2.0 E2EE cloud sync)
  // F-3005/F-3008: timeline_blobs write path rejects any ciphertext that
  // does not carry the e2e:v1: prefix (strictly distinct from F-705's
  // server-decryptable enc:v1: — never coerced into it).
  TIMELINE_BLOB_REJECTED:    { zh_CN: '云同步内容格式无效，已拒绝写入。',      en: 'Cloud sync payload invalid, write rejected.' },
  // WP-5D (F-3094..F-3097): cloud-web E2EE timeline preview grant handshake.
  // TIMELINE_WEB_READ_ONLY: a kind:'web' socket attempted timeline:push/tombstone
  // (server-enforced read-only).
  TIMELINE_WEB_READ_ONLY:    { zh_CN: '网页预览为只读，无法写入云端时间线。',    en: 'Web preview is read-only; cannot write to the cloud timeline.' },
  // TIMELINE_GRANT_REQUIRED: timeline:pull from kind:'web' without an active,
  // unexpired, non-revoked grant (fail-closed pull-gate).
  TIMELINE_GRANT_REQUIRED:   { zh_CN: '需要手机重新授权才能预览云端时间线。',    en: 'Phone re-authorization required to preview the cloud timeline.' },
  // WEB_EVENT_NOT_ALLOWED: a kind:'web' socket emitted any event outside the
  // positive allowlist (timeline:grant-request + timeline:pull only).
  WEB_EVENT_NOT_ALLOWED:     { zh_CN: '网页会话不允许执行该操作。',              en: 'Web session is not allowed to perform this action.' },
  // TIMELINE_RATE_LIMITED: per-user timeline:grant-request token-bucket.
  TIMELINE_RATE_LIMITED:     { zh_CN: '预览授权请求过于频繁，请稍后再试。',      en: 'Too many preview grant requests, please try again later.' },

  // Cloud session (WP-R4-1 / F-3140) — CLOUD_SESSION_NO_HISTORY REMOVED 2026-07-31
  // (0.2.27, same round that added HISTORY_SYNC_RETIRED below). It said "云端会话不
  // 在服务器保存历史记录" ("cloud sessions do not save history on the server") and
  // was produced by exactly one branch: the cloud-session
  // gate in history.handler that refused history:create for a 「云端实例」 pairing.
  // That gate is gone because the RULE swallowed it — no session of any type writes
  // server history now — so the code was left with ZERO producers while the phone
  // still rendered it. This repo has already ruled on that exact shape once
  // (INJECT_NO_RECEIPT, one release long): a user-facing string with no producer is
  // a façade on the protocol face, and the specific harm is that it lingers as a
  // code someone reuses one day to answer a DIFFERENT question. It goes with its
  // producer. The policy it expressed did not disappear — it became universal, and
  // HISTORY_SYNC_RETIRED is the sentence that states it truthfully.
  // Net for this round: 55 → 56 → 55.
  // 0.2.27 (window A, owner's architecture ruling 2026-07-31 no-cloud-sync). The server no
  // longer stores transcripts AT ALL — `transcript_history` is dropped and the
  // four history:* handlers are kept ONLY to answer old clients out loud. This
  // is the "原处明写取消" ("state the retirement explicitly in place") form of
  // retirement: a client on 0.2.26 still emits
  // history:create/update/delete, and an unregistered event is SILENTLY DROPPED,
  // which is the red line (没有静默失败).
  //
  // Deliberately a NEW code rather than reusing either neighbour:
  //   · SETTINGS_SYNC_FAIL would say 「已保存本地」 — a promise about the SERVER's
  //     behaviour that is now permanently false, and it is also the code the
  //     phone hard-codes into 「对方删了这一行」 (timeline_sync.dart), i.e. reusing
  //     it would make a retirement look like a peer deletion and DELETE the
  //     user's local row;
  //   · CLOUD_SESSION_NO_HISTORY blames the SESSION TYPE ("云端会话…"), which was
  //     true when only cloud sessions were barred; after retirement it is true of
  //     EVERY session, so that sentence would be half false — the exact shape that
  //     cost 0.2.18 a wrong PC_BUSY reuse.
  // The copy must leave the user with a true belief: the row is not lost, it is
  // simply this device's own.
  HISTORY_SYNC_RETIRED:      { zh_CN: '服务器不再保存转录历史，这一条只留在本机。', en: 'The server no longer stores transcript history — this entry stays on this device.' },

  // Console / account management (R5-WEB WP-W1). PASSWORD_RESET_INVALID: the
  // /api/password/reset token is unknown, does not match the stored one, or has
  // passed its 30-min TTL — a SINGLE code for every failed-reset branch so the
  // response never becomes an account-enumeration oracle (unknown-email and
  // wrong-token are indistinguishable). Distinct from AUTH_TOKEN_INVALID (whose
  // "请重新配对/pair again" copy is about DEVICE pairing, not a password reset) —
  // additive per the WP-W1 discipline (error codes are chosen from the existing
  // table; only when a new code is genuinely needed is one added, additive and
  // bilingual).
  PASSWORD_RESET_INVALID:    { zh_CN: '重置链接无效或已过期，请重新申请。',        en: 'Reset link is invalid or expired, please request a new one.' },
} as const satisfies Record<string, ErrorMessage>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function getErrorMessage(code: ErrorCode, locale: 'zh-CN' | 'en'): string {
  const entry = ERROR_CODES[code];
  return locale === 'zh-CN' ? entry.zh_CN : entry.en;
}

export const ERROR_CODE_LIST: readonly ErrorCode[] = Object.keys(ERROR_CODES) as ErrorCode[];
