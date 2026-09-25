// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §5 (error-code namespaces)
//   docs/rebuild/06-STT-ENGINE-LAYER.md / 11-ENGINEERING-SYSTEM.md (i18n rule:
//     every code carries zh-CN + en)
//   F-1003 (error-codes.ts complete + zh-CN/en placeholders)
//
// Single source of truth for user-facing error codes. Every code MUST
// have both zh-CN and en messages — F-1003 / F-1005 lint enforces this.
// Messages are short, user-readable, no implementation jargon.

import { AUTH_AND_PAIRING_ERROR_CODES } from './error-codes-auth-and-pairing';
import { INJECT_ERROR_CODES } from './error-codes-inject';
import type { ErrorMessage } from './error-code-types';

export type { ErrorMessage } from './error-code-types';

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
  ...AUTH_AND_PAIRING_ERROR_CODES,
  // STT engine / config
  STT_CONFIG_MISSING:        { zh_CN: '该语言尚未配置识别引擎。',              en: 'No STT engine configured for this language.' },
  STT_ENGINE_AUTH_FAIL:      { zh_CN: '语音识别服务身份验证失败，请检查 API Key。',    en: 'STT engine authentication failed, check API key.' },
  STT_ENGINE_RATE_LIMITED:   { zh_CN: '语音识别服务请求过于频繁，请稍后重试。',        en: 'STT engine rate limited, retry later.' },
  STT_ENGINE_TIMEOUT:        { zh_CN: '语音识别服务响应超时，请重试。',                en: 'STT engine timeout.' },
  STT_NETWORK_DROP:          { zh_CN: '网络中断，识别会话终止。',                      en: 'Network drop, STT session terminated.' },
  // 72 → 73. B2-G (2026-09-02): every one of the eight bundled STT adapters
  // (apps/server-core/src/stt/engines/*.ts + packages/stt-cloud/src/engines/
  // soniox.ts) throws when `push()` is called while the engine's own state is
  // not `'open'` — and every one of them named that `STT_ENGINE_TIMEOUT`. It
  // never was one: nothing was sent to a vendor, so nothing timed OUT waiting
  // for a reply. The real fact — recorded verbatim in the message each site
  // already wrote — is a caller/orchestrator invariant violation: audio
  // arrived for an engine session that had not opened yet, or had already
  // closed/failed. Same failure shape argued at `STT_NO_ENGINE_REACHED` above
  // (a reused code answers a question nobody asked, one level closer to the
  // wire): grep for `STT_ENGINE_TIMEOUT` across those eight files before this
  // card shows the exact same string doing two jobs — "the vendor took too
  // long" and "we called push() on an engine that was not there to call it
  // on" — and only the first one is what the sentence below actually says.
  // 🔴 WHY NOT STT_NETWORK_DROP: `sherpa-local` is an in-process engine with no
  // network at all, so a message about a dropped connection would be false on
  // its face for that adapter — and for the ws-based adapters the drop code
  // already has its own, narrower meaning (`unexpectedCloseError` in
  // `engines/base.ts`: a socket that WAS open closing on its own).
  // 🔴 WHY NOT STT_CONFIG_MISSING: that one answers "this language has no
  // engine configured"; here an engine was configured and constructed, it
  // simply was not (or was no longer) accepting audio at the moment this
  // chunk arrived.
  // `retryable: true` unchanged from what every site already declared — the
  // condition is very often transient (a chunk arriving mid-rollover, mid-
  // reconnect, or just after a clean close) and the reconnect ladder is what
  // decides whether to act on that, not this code.
  STT_ENGINE_NOT_OPEN:       { zh_CN: '语音识别服务尚未准备就绪，未能接收音频，请重试。', en: 'The STT engine was not in a state to receive audio, so this segment was not delivered to it.' },
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
  // 84 → 85. card HANGUP-3 (2026-09-23), first-responsible approval (CLAUDE.md
  // D-32). The recording ended with a stretch the server CAPTURED and no engine
  // ever heard (`unheardVoice`), and the one re-dial made at release failed too:
  // part of the recording is missing from the transcript. Producer:
  // apps/server-core/src/stt/owed-voice-verdict.ts via orchestrator-terminal.ts.
  // 🔴 WHY NOT STT_NETWORK_DROP: that answers 「the connection dropped, the
  // session ended」, not 「this stretch was never transcribed, say it again」
  // (book 15 §6 G-23 forbids the borrow). WHY NOT STT_NO_ENGINE_REACHED: that
  // says NOTHING was transcribed, false whenever the row has words; its own
  // verdict still answers when nothing reached an engine, and this one is quiet.
  // 🔴 SENT ONLY TO A CLIENT THAT DECLARED `stt.segment_not_transcribed`
  // (protocol-schemas-auth.ts CLIENT_CAPABILITY_STT_SEGMENT_NOT_TRANSCRIBED):
  // an undeclared client would render this name raw. The copy below is the
  // phone's approved en / zh-CN sentence (i18n/mobile), pinned by
  // test/segment-not-transcribed-copy.test.ts.
  STT_SEGMENT_NOT_TRANSCRIBED: { zh_CN: '未能连上语音服务，刚才有一部分话没转成文字，请把那部分再说一遍', en: 'Part of what you said was not transcribed because the speech engine could not be reached. Say that part again' },
  STT_NO_ENGINE_REACHED:     { zh_CN: '录音未能送达语音识别服务，没有转成文字。请重新说话；如持续出现，请检查语音设置。', en: 'This recording reached no speech engine, so nothing was transcribed. Say it again; if it keeps happening, check the engine settings.' },
  // 71 → 72. owner approved on 2026-08-17 (WP-2 card C1; the ruling is recorded in
  // docs/archive/strategy/2026-08-17-wp2-task-book-settings-and-presence-followups.md §3-2).
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
  STT_POOL_NO_ROUTE:         { zh_CN: '云端服务暂无可用的语音识别线路。这不是您的设备设置问题，若持续出现请联系客服。', en: 'The service has no speech engine route available for this request. This is not a problem with your settings — if it keeps happening, tell us.' },
  // 72 → 73. owner approved on 2026-08-17, answering the request registered in the
  // WP-3 handback §7-2 (`docs/archive/strategy/2026-08-18-lan-fable-wp3-report.md`).
  // A route WAS found and an engine WAS selected — and that engine's model cannot
  // recognise the language this request asked for. Producer:
  // `apps/server-core/src/stt/engine-factory.ts`, the `sherpa-local` arm, guarded by
  // `SHERPA_MODEL_LANGUAGES` (`stt/sherpa/model-manifest.ts`).
  //
  // 🔴 WHY THIS IS A CODE AND NOT A REUSE, measured rather than argued. The seeded
  // `'*'` route sends every spoken language to the built-in engine on a self-hosted
  // box, and outside its five languages the recogniser EXITS CLEANLY with punctuation
  // dressed as a transcript — 22 words of French came back as 「La Mer.」, German and
  // Russian as 「.」, with the requested language echoed back on the frame (WP-3 §2,
  // real audio). Silence that reports success is the worst shape this product has;
  // the refusal exists to convert it into something a user can act on, and the action
  // is specific: pick a different engine for this language, or speak one it knows.
  //
  // 🔴 WHY NOT STT_CONFIG_MISSING, the code that shipped here for one round. Its
  // sentence is 「该语言尚未配置识别引擎」 ("no STT engine has been configured for this
  // language"). That is the NEAREST TRUE sentence and it is why it was allowed to
  // stand while the code was pending — but it is true only in the sense that no
  // configured engine CAN do the job, and it sends the reader to look for an absence
  // when what they have is a MISMATCH. A user who has configured an engine, sees it
  // configured, and is told nothing is configured, has been handed a contradiction.
  // ⚠️ STT_CONFIG_MISSING KEEPS ITS MEANING EXACTLY: a language with no route at all
  // still answers with it, and `stt-routing.test.ts` holds a positive control for
  // that rather than trusting this paragraph.
  //
  // 🔴 WHY NOT STT_POOL_NO_ROUTE, the code directly above. Both halves of its copy
  // are false here: this is not the platform's pool (a self-hosted box has none), and
  // it very much IS something the reader's own settings can change. That mismatch is
  // exactly what WP-3 recorded when it considered and rejected the reuse.
  //
  // ⚠️ NAME LENGTH: `STT_LANGUAGE_UNSUPPORTED` is 24 characters, under the phone's
  // 28-char raw-code slot (`chat_message_tile.dart` `_truncateFailureReason`). Not a
  // naming preference — a product constraint, and the reason the more descriptive
  // `STT_ENGINE_LANGUAGE_UNSUPPORTED` (31) was not chosen. The measurement is the
  // over-length guard in approved-codes-2026-08-10.test.ts, not this comment.
  //
  // ZERO wire-shape change and NO relay-before-client order on the FRAME:
  // `SttErrorSchema.code` is `NonEmpty`, not a closed enum. ⚠️ But the deployment
  // order still matters for a different reason: an old phone has no sentence for this
  // code and degrades to `sttStallEngineErrorCoded` — a readable sentence plus the
  // raw identifier — which is a worse read than the STT_CONFIG_MISSING sentence it
  // used to get. Relay and client ship together this round; a relay deployed alone
  // would make every affected phone read the identifier.
  STT_LANGUAGE_UNSUPPORTED:  { zh_CN: '当前语音识别引擎不支持您所选的说话语种。请在设置中更换引擎，或切换至支持的语种。', en: 'The speech engine used for this recording does not support the spoken language you selected. Choose a different engine for this language in settings, or speak one it supports.' },
  STT_PROBE_FAIL:            { zh_CN: '连接测试失败，请检查地址或密钥。',      en: 'Connection test failed, check endpoint or key.' },
  STT_PROBE_SCHEME_MISMATCH: { zh_CN: '该服务不支持加密连接（wss:// 握手失败），请将服务地址协议更改为 ws://。', en: 'Server reachable via ws:// but wss:// handshake failed — endpoint has no TLS, change scheme to ws://.' },
  // STT_HARD_LIMIT_REACHED retired 2026-09-02 (WP-8 registry hygiene) — see
  // the "75 → 69" note near EXPECTED_ERROR_CODE_COUNT.

  // ── Audio recovery: the server's operation registry ─────────────────────────
  //
  // 🔴 A NEW NAMESPACE (`AUDIO_*`), and it is one on purpose. This code speaks
  // about the RECOVERY REQUEST, not about a speech engine and not about an
  // injection: the recording never reached an engine because the server refused
  // to start it, and nothing about the engines is wrong. Filing it under `STT_*`
  // is what the borrowed code did, and the phone's stall table would then have to
  // dress a request-level refusal as an engine fault.
  //
  // owner approved it on 2026-09-06
  // (docs/decisions/2026-09-06-owner-grants-error-code-audio-op-binding-conflict.md).
  // Producer: apps/server-core/src/socket/handlers/audio-start-operation.ts
  // `admitOperation`, the `conflict` verdict of
  // db/repos/recovery-operations.repo.ts — a re-send that reuses an
  // `operation_id` while describing a different recording / sample range /
  // attempt kind / mode. Ruling O-9 (乙) forbids overwriting the registration,
  // so the frame is refused and the first registration stands.
  //
  // 🔴 NO IMPERATIVE, AND THE ABSENCE IS THE POINT. There is nothing the user can
  // do — the client mints a fresh operation for the next attempt on its own, and
  // the one action a sentence could ask for ("say it again", which the borrowed
  // `STT_NO_ENGINE_REACHED` does ask for) is the action that produced this. So it
  // states two facts instead: this send was not processed, and the earlier
  // result and charge did not move. The second half is the one the user would
  // otherwise have to guess at, and A7-2 is what makes it true — billing is a
  // different key and a different table, untouched by a refused start.
  //
  // ⚠️ NAME LENGTH IS A PRODUCT CONSTRAINT (see the 28-character note at the top
  // of this file). The request went in as `AUDIO_OPERATION_BINDING_CONFLICT` (32)
  // and owner shortened it to 25 so that a phone with no mirrored sentence prints
  // the whole identifier instead of 0.2.53's three letters.
  //
  // Wire shape unchanged: `SttErrorSchema.code` is `NonEmpty`, not a closed enum,
  // and no event was added, removed or renamed.
  AUDIO_OP_BINDING_CONFLICT: { zh_CN: '该录音重发请求与原记录不匹配，已取消处理。原记录及计费均未发生变动。', en: 'This re-send does not describe the original recording, so it was not processed. The earlier result and charge are unchanged.' },

  // LLM / compose
  LLM_TIMEOUT:               { zh_CN: '大模型响应超时。',                      en: 'LLM response timeout.' },
  LLM_AUTH_FAIL:             { zh_CN: '大模型服务身份验证失败，请检查 API Key。',      en: 'LLM authentication failed, check API key.' },
  LLM_RATE_LIMITED:          { zh_CN: '大模型服务请求过于频繁，请稍后重试。',          en: 'LLM rate limited, retry later.' },
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
  COMPOSE_OUTPUT_REJECTED:   { zh_CN: 'AI 生成的内容不符合要求，已自动拦截并保留原文。', en: 'The AI\'s answer did not meet the request, so we held it back.' },

  ...INJECT_ERROR_CODES,
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
  PC_IMAGE_STORE_FAILED:     { zh_CN: '图片已送达电脑，但电脑本地保存失败。请检查电脑磁盘剩余空间及存储权限。', en: 'The picture reached the PC but the PC could not save it, so it was not kept there. Check the free disk space and write permissions on the PC.' },

  // Settings
  SETTINGS_SYNC_FAIL:        { zh_CN: '云端同步失败，已保存本地。',            en: 'Cloud sync failed, saved locally.' },
  SETTINGS_SCHEMA_INVALID:   { zh_CN: '设置内容不合法。',                      en: 'Settings payload invalid.' },

  // Quota / plan
  QUOTA_EXCEEDED:            { zh_CN: '当前周期套餐用量已达上限。',            en: 'Plan quota exceeded for the current cycle.' },
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
  TIMELINE_BLOB_REJECTED:    { zh_CN: '云同步数据格式无效，同步失败。',        en: 'Cloud sync payload invalid, write rejected.' },
  // WP-5D (F-3094..F-3097): cloud-web E2EE timeline preview grant handshake.
  // TIMELINE_WEB_READ_ONLY: a kind:'web' socket attempted timeline:push/tombstone
  // (server-enforced read-only).
  TIMELINE_WEB_READ_ONLY:    { zh_CN: '网页预览为只读，无法写入云端时间线。',    en: 'Web preview is read-only; cannot write to the cloud timeline.' },
  // TIMELINE_GRANT_REQUIRED: timeline:pull from kind:'web' without an active,
  // unexpired, non-revoked grant (fail-closed pull-gate).
  TIMELINE_GRANT_REQUIRED:   { zh_CN: '需要手机重新授权才能预览云端时间线。',    en: 'Phone re-authorization required to preview the cloud timeline.' },
  // WEB_EVENT_NOT_ALLOWED: a kind:'web' socket emitted any event outside the
  // positive allowlist (timeline:grant-request + timeline:pull only).
  WEB_EVENT_NOT_ALLOWED:     { zh_CN: '无法在网页端执行此操作。',              en: 'This cannot be done from the web page.' },
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

  // ── Multi-node relay (srvny writer / srvjp replica) · 73 → 74 ───────────────
  // Owner approved 2026-08-29. Design docs/strategy/2026-08-29-multi-node-relay-
  // design-srvny-srvjp.md §10.
  //
  // WHAT IT ANSWERS: 「the node you are talking to cannot mint this, and another
  // one can」. A replica serves reads from a copy that a pull REPLACES every 30
  // seconds, so an identity write accepted there is not slow or degraded — it is
  // gone, with both ends having said OK. That is the silent-failure red line, and
  // this code is the sentence that breaks the silence.
  //
  // ⚠️ THE NAME IS DELIBERATELY THE ONE THE HTTP SIDE ALREADY USED. http/router.ts
  // has answered 421 with `error: 'NODE_IS_REPLICA'` since this channel was built.
  // Minting a second name for the same fact is how one fact comes to have two
  // answers — the shape this repo pays down constantly — so the socket refusal and
  // the HTTP refusal say the same word, and router.ts now imports it from here
  // instead of spelling it, which is what makes that a guarantee rather than a
  // coincidence.
  //
  // WHY NOT A NEIGHBOUR — every one of them sends the user somewhere useless:
  //   · PAIR_INVALID_PAYLOAD — the payload was perfect; nothing about the request
  //     is wrong, and the user cannot fix a correct request;
  //   · PAIR_PC_OFFLINE — the PC may be right there, online, on another node;
  //   · PC_BUSY / PAIR_RELEASED — both assert an ACTOR (another phone is using it /
  //     someone pressed 断开). Here nobody did anything. Reusing either invents a
  //     person, and PC_BUSY's copy then sends the user to a phone that does not
  //     exist — the exact half-false reuse that cost 0.2.18;
  //   · PAIR_RATE_LIMITED — 「try again later」 is the one piece of advice that is
  //     guaranteed not to work: waiting does not change which node answered.
  //
  // 🔴 THE COPY NAMES THE ONE ACTION THAT CAN ACTUALLY HELP, AND NOTHING ELSE.
  // Reconnecting re-runs node selection, so it genuinely can land somewhere that
  // can write — unlike waiting. It does NOT say 「replica」/「writer」: the user
  // never chose a server and owes us no model of our topology (owner 2026-08-22,
  // 对外文案从用户视角写). It also promises no automatic recovery, because none is
  // implemented — see the `writer` field on the refusal ack, which is a DIAGNOSTIC
  // and not yet a redirect.
  //
  // ⚠️ Name is 15 characters, inside the phone's 28-char raw-code slot.
  // ZERO wire-shape change: this rides the existing `{error}` ack field.
  // `whitelist=54` is untouched — no event was added, removed, or renamed.
  NODE_IS_REPLICA:           { zh_CN: '当前服务器暂不支持注册与配对，请重新连接后再试。', en: 'The current server does not handle registration or pairing — reconnect and try again.' },

  // ── 2026-09-02 (WP-8, registry hygiene) — two long-standing SHADOW codes
  // promoted into this registry. Both already had real producers and real
  // phone-side sentences before today; what they lacked was a row here, which
  // is the one thing every other guard in this file (the count guard, the
  // i18n-error-keys lint, `inject-verdict-authorship.ts`'s exhaustive
  // `satisfies`) actually reads. A shadow code cannot be caught by any of
  // that machinery — see 2026-09-02-full-implementation-audit-and-next-plan.md
  // §3-G G1.
  //
  // INJECT_RESULT_TIMEOUT — `http/inject-routes.ts`'s image-ingress waiter
  // (`socket/inject-pending.ts`) gave up on an `inject:result` inside its
  // window. Deliberately NOT a failure verdict: the frame WAS relayed
  // (`relayed:true` rides every answer that uses this code) and the PC may
  // still answer late, at which point `relay.handler.ts`'s write-back records
  // the truth. It rides the HTTP image-ingress ack's `error` field, never the
  // `inject:result` SOCKET event — which is why `inject-verdict-authorship.ts`
  // gives it `'none'` rather than `'relay'` (that value is reserved for "this
  // frame never reached any PC", and here the opposite is true: it did).
  INJECT_RESULT_TIMEOUT:     { zh_CN: '电脑端响应超时，未能确认处理状态，请重试。', en: 'No response from the PC in time — unsure whether it was handled, please retry.' },
  // EMAIL_VERIFY_GRACE_EXPIRED — `auth/verification-grace.ts`'s 3-day
  // unverified-email grace period (owner ruling 2026-08-27 items 3/4) ran out,
  // and `audio:start` / `compose:start` refused to open a new managed-cloud
  // session over it. It already has bespoke phone-side sentences
  // (`recording_strings.dart` `sttStallVerifyEmail`, `compose_strings.dart`
  // `case 'EMAIL_VERIFY_GRACE_EXPIRED'`) — this round only makes the registry
  // agree with what both ends already do. `verification-grace.test.ts`'s pin
  // ("EMAIL_VERIFY_GRACE_EXPIRED is NOT a protocol error code") is flipped in
  // the same commit.
  EMAIL_VERIFY_GRACE_EXPIRED: { zh_CN: '邮箱验证宽限期已结束，请先完成邮箱验证。', en: 'The unverified-email grace period has ended — please verify your email first.' },

  // ── Web target rooms (card S2-04) · 74 → 75 ──────────────────────────
  // Owner gate: ruling W-P (docs/decisions/2026-09-06-owner-web-client-rulings-
  // repo-protocol-domains.md) approved the three WEB_ROOM_* codes named in the
  // protocol addendum §2.1 AND ruled that each is registered WITH ITS FIRST
  // PRODUCER rather than up front. This is that first producer, and it is ONE of
  // the three: `POST /api/web/rooms` refusing a build that came too fast.
  //
  // ⚠️ 2026-09-09, card M4-01 — the paragraph that used to stand here said the
  // other two were 「deliberately still absent」 because no line of code could
  // produce them. That was true and is now spent: both have producers below,
  // registered in the SAME commit as those producers, which is the whole of what
  // ruling W-P asked for. Kept as a correction rather than deleted, because the
  // argument it made is the one that governs the NEXT reserved code.
  //
  // WHY NOT REUSE `REGISTER_RATE_LIMITED`, the nearest existing sentence: that
  // one says 「too many SIGN-UPS from this network」. This refusal is charged
  // against ONE ACCOUNT that is already signed in, so the holder who read it
  // would go looking for somebody else on their network — a true-sounding
  // sentence pointing at the wrong actor. It is the same reason
  // `PAIR_RATE_LIMITED` and `TIMELINE_RATE_LIMITED` are separate rows rather
  // than one shared 「rate limited」.
  //
  // The copy names the only action that helps (wait) and nothing else, because
  // there is nothing else: the caller owns the account and has done nothing
  // worse than clicking twice. The waiting TIME rides beside this code as the
  // 429's `retry_after_ms`, never inside the sentence, so the budget and the
  // translations cannot drift apart.
  WEB_ROOM_RATE_LIMITED:     { zh_CN: '打开网页过于频繁，请稍后再试。', en: 'Too many attempts to open the web page — please try again later.' },

  // ── The site demo (card M4-01) · 75 → 78 ────────────────────────────────
  // Owner gate: ruling 11 of 2026-09-09 (docs/decisions/2026-09-09-owner-stage4-
  // site-demo-twelve-rulings.md) approved these three as ONE batch with the
  // schema they ride beside. Producers: http/web-anon-routes.ts (all three) and
  // the anonymous arm of http/web-room-routes.ts (the first).
  //
  // 🔴 ALL THREE ARE HTTP-ONLY AND THE PHONE NEVER SEES ONE. They answer a
  // browser asking for a demo identity or a demo room; no `inject:result`, no
  // `stt:error`, no `compose:error` can carry them. That is why there is no
  // mirror in apps/mobile's own string table and no change to
  // `kPcInjectionVerdictCodes` — the closed set the phone uses to decide whether
  // a delivery is still owed. `WEB_ROOM_RATE_LIMITED` beside them set that
  // precedent on 2026-09-08 for the same reason.
  //
  // WEB_ROOM_ORIGIN_NOT_ALLOWED — the request came from a page this deployment
  // does not serve the demo to (or from no page at all: a missing `Origin` is
  // refused the same way, because 「we could not tell」 must not be the loose
  // arm on a gate). It rides the demo endpoints (http/web-anon-routes.ts's
  // mint and `handleAnonymous` in http/web-room-routes.ts) and, since card
  // MP-1, `handleIntegrator` in that same file — the third-party site-key
  // room arm. The account arm of /api/web/rooms deliberately does not check
  // an Origin at all (a desktop console is not a page), so this code can
  // never appear there.
  //
  // WHY NOT REUSE `AUTH_TOKEN_INVALID`: that one says 「your credential is bad」,
  // and a caller who read it would throw away a perfectly good token and mint
  // another from the same disallowed page, forever. The credential is fine; the
  // place it was used from is not.
  //
  // The copy states the fact and names no action, because for the visitor this
  // can reach there is none: an ordinary person on the real site never sees it,
  // and whoever does is the operator of the embedding page.
  WEB_ROOM_ORIGIN_NOT_ALLOWED: { zh_CN: '这个网站不允许使用语音输入。', en: 'Voice input is not allowed on this website.' },

  // WEB_ROOM_TURNSTILE_FAILED — the Cloudflare Turnstile token did not verify.
  //
  // 🔴 IT IS NOT THE SAME AS 「this deployment cannot run a challenge」, which is
  // WEB_DEMO_UNAVAILABLE below. auth/captcha.ts keeps those two facts apart on
  // purpose (`configured` beside `verify`), and collapsing them here would undo
  // that: one is this visitor's problem and refreshing fixes it, the other is
  // ours and refreshing forever will not.
  //
  // The copy names refreshing because that is what actually re-arms the widget —
  // a Turnstile token is single-use and short-lived, so 「try again」 without the
  // refresh would send someone to press a button that cannot succeed.
  WEB_ROOM_TURNSTILE_FAILED: { zh_CN: '人机验证没有通过，刷新页面后可以再试一次。', en: 'The human check did not pass. Refresh the page to try again.' },

  // WEB_DEMO_UNAVAILABLE — the demo is not being served right now: the master
  // switch is off, this deployment has no Turnstile secret, the site's daily
  // minutes are spent, or there are already as many live demo rooms as the
  // deployment allows.
  //
  // 🔴 ONE CODE FOR FOUR CAUSES ON PURPOSE, WHICH IS THE OPPOSITE OF THIS
  // REPO'S USUAL RULE, and the reason is that the rule is about the READER's
  // action, not about our taxonomy: every one of the four leaves a visitor with
  // exactly the same thing to do (come back later, or download the app), and
  // four sentences would be four ways of saying that. The four are told apart
  // where telling them apart is actionable — the operator's log, one line per
  // refusal with its own `reason` (design §3.2).
  //
  // WHY NOT REUSE `SERVER_BUSY`: that says a load spike will pass on its own. A
  // switch that is off does not pass on its own, and a visitor told to wait for
  // it would wait forever.
  //
  // The copy promises no time, because we have none to promise: the daily budget
  // resets at UTC midnight, the switch resets when a person flips it.
  WEB_DEMO_UNAVAILABLE:      { zh_CN: '现在暂时不能开始体验，请稍后再来。', en: 'The demo is not available right now. Please come back a little later.' },

  // INTEGRATOR_QUOTA_EXCEEDED — card MP-1. A third-party page embedded FlowMic
  // with a publishable key, and the allowance THAT PAGE'S OWNER pays from is
  // spent: either the integrator account's own plan minutes, or the smaller
  // per-key sub-quota they set beside it (whichever ran out first — the server
  // takes the lower of the two and never says which, because the visitor can act
  // on neither).
  //
  // 🔴 owner APPROVED IT ON 2026-09-11 (78 → 79), ruling §11 追认 item 4, in
  // docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md.
  // The design that asks for it is docs/strategy/2026-09-11-metering-principal-
  // matrix-design.md §4.
  //
  // 🔴 WHY NOT QUOTA_EXCEEDED, which is the obvious reuse: that code's sentence
  // is 「本月套餐用量已达上限」 — a statement about THE READER's subscription. The
  // reader here has no subscription in this story and may have no account at all;
  // on an integrator page the payer is decided BEFORE the speaker is even looked
  // at (`auth/metering-principal.ts` `resolvePayer` step 1). Telling a visitor
  // their plan is exhausted is false in both halves — it is not their plan, and
  // signing in or upgrading would not move this ceiling by a second, because
  // signing in does not change who pays.
  //
  // 🔴 WHY NOT WEB_DEMO_UNAVAILABLE, the other near neighbour: that one answers
  // 「FlowMic's own demo is not being served」, and its four causes are all OURS.
  // This is a specific third party's allowance, on a page we do not run. Folding
  // them would put「come back a little later」in front of somebody whose wait ends
  // only when a site owner they cannot contact tops up.
  //
  // ── WHAT THE COPY MAY NOT SAY, AND WHY EACH OMISSION IS LOAD-BEARING ───────
  // No plan name and no remaining figure: the payer is a DIFFERENT PARTY, and
  // both are that party's commercial facts — the design (§4) puts them off the
  // wire, so a sentence naming one would be inventing what the frame refuses to
  // carry. No sign-in prompt and no upgrade link: a visitor who signed in would
  // still be billed to the host (owner §11 追认 item 1), so an invitation to act
  // is an invitation to an action that changes nothing — the 「a control that
  // changes nothing is worse than no control」 rule, in sentence form.
  //
  // ⚠️ THE PHONE MIRRORS THIS BY HAND (`apps/mobile/lib/src/settings/strings/
  // recording_strings.dart`, `sttStallIntegratorQuotaExceeded`) because a handset
  // that scans an integrator page's QR is a speaker in that room too. Nothing
  // binds the two tables — CLAUDE.md's standing open account — so the mirror is
  // named here as well as there.
  INTEGRATOR_QUOTA_EXCEEDED: { zh_CN: '这个网站的语音额度已用完，这段话没有转成文字。', en: "This site's voice quota is used up, so this recording was not transcribed." },
  // Linux implementation additions; lead decision: docs/decisions/2026-09-22-linux-inject-verdict-codes-and-no-new-history-status.md.
  // These are distinct facts:
  // Wayland refusal happens before input; an X11 submission error may follow
  // partial input. Neither is the HTTP receipt timeout.
  INJECT_WAYLAND_UNSUPPORTED: { zh_CN: "当前 Wayland 桌面会话无法向其他应用输入文字。文字已保存至电脑时间线，内容未丢失。", en: "This Wayland session cannot put text into other applications. It did reach the PC and is on its timeline." },
  INJECT_SUBMISSION_UNCERTAIN: { zh_CN: "部分文字可能已输入目标应用，电脑无法确认具体输入了多少，输入结果未知。", en: "Part of the text may already be in the target application, and the computer cannot confirm how much." },
  // Unknown display backend is neither invalid focus nor a confirmed Wayland session (R-2).
  INJECT_DISPLAY_UNAVAILABLE: { zh_CN: "未找到支持的显示环境，文本仍在电脑上。", en: "No supported display environment found. The text remains on the PC." },
} as const satisfies Record<string, ErrorMessage>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function getErrorMessage(code: ErrorCode, locale: 'zh-CN' | 'en'): string {
  const entry = ERROR_CODES[code];
  return locale === 'zh-CN' ? entry.zh_CN : entry.en;
}

export const ERROR_CODE_LIST: readonly ErrorCode[] = Object.keys(ERROR_CODES) as ErrorCode[];
