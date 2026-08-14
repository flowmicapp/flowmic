// verify/lint/coordinate-anchors-baseline.mjs
// Baseline DATA for verify/lint/coordinate-anchors.mjs — nothing else imports
// this, and run-all.mjs never runs it (lints are registered by explicit
// import there, not by directory glob).
//
// ENTRY FORMAT (IT-64, four fields):
//   `<referrer>|<referenced path>#<NNN>|<claim digest>|<target digest>`
//   - referrer / referenced path / NNN identify the coordinate;
//   - the FIRST 12-hex field is sha256 of the CLAIM WINDOW (±CLAIM_SPAN
//     normalized chars around the reference, reference text blanked — see the
//     lint's header, section "THE BASELINE PINS THE CLAIM"). IT-59: a baseline
//     that pinned only the coordinate was a slot, and a slot absorbs a
//     fabricated claim — measured 2026-08-06, replacing a pinned entry's whole
//     sentence with an invented one still reported PASS. With the digest,
//     changing the words WITHIN ±CLAIM_SPAN normalized chars of the reference
//     makes the hit NEW and the gate fail. 🔴 SCOPE (closeout adversarial
//     review, 2026-08-06, measured): a rewrite landing WHOLLY OUTSIDE that span
//     is absorbed — same digest, PASS 0 new. The pin covers a NEIGHBOURHOOD of
//     the claim, not the claim; a sentence long enough to put its verb 80+
//     normalized chars from the reference can still be flipped silently.
//   - the SECOND 12-hex field is sha256 of the TARGET's cited window — the same
//     ±ANCHOR_WINDOW lines the anchor predicate reads. IT-64 added it because
//     until then the pin certified nothing about the thing it points AT: the
//     target's cited region could be rewritten wholesale and the entry absorbed
//     it. 🔴 IT-64 hashed that window through the REFERRER's normalizer, which
//     strips comment leaders — so COMMENTING OUT the cited line was invisible
//     to the pin (measured twice on the real tree: appending a marker to the
//     line FAILED 3 new, prefixing `// ` to the same line PASSED 0 new). Since
//     IT-65 the target window is hashed as two components — the window's WORDS
//     (leaders stripped, so a re-wrap does not move them) and a positional
//     LEADER VECTOR (one token per line, so a line being commented out, or a
//     leading `*` appearing, does move them). It is invariant to
//     re-indentation, to trailing whitespace, and to a word moving across a
//     line break inside the window at unchanged line count — including when
//     that empties the donor line, which IT-64's header claimed and did not
//     deliver. It is NOT invariant to the words changing, to a line being
//     commented out or its leader style changing, to a blank line being
//     inserted, to a `//` ↔ `/** */` reformat, or to the window shifting.
//     Exact list in the lint's header. Two spelled sentinels appear instead of
//     a digest when there is no window to hash: `nofile` / `pasteof`.
//     ⇒ These 48 entries are expected to go RED the day their targets really
//     move. That is the debt being recorded, not a malfunction.
//   - 🔴 The `#` is not cosmetic: with a `:` this file would be a list of live
//     coordinates inside a scanned code file, and the lint would flag its own
//     baseline — measured, that is exactly what happened on the first run
//     after the original pinning. Exempting this file from the scan was
//     rejected then and stays rejected: it would make the one file that
//     enforces the rule the one file the rule cannot reach. The referring
//     LINE number is omitted from the key so that the referring line drifting
//     cannot false-FAIL; the claim digest, not a line number, is what pins
//     the sentence.
//
// EVERY ENTRY IS A DEBT, NOT AN ENDORSEMENT: each is a coordinate whose claim
// this lint could not anchor within its windows. Baselined = known-rotted,
// not approved. The list exists so the debt cannot GROW; clearing an entry
// (best: delete the `:NNN` and keep the symbol) needs no change here.
//
// REGENERATE with `COORDINATE_ANCHORS_DUMP=1` (prints baseline-ready lines to
// stderr; the trailing comment gives the reason and the referrer location in
// the paste-safe `@ <file> line N` form). Hand-editing entries is how a
// baseline silently stops describing reality. Regeneration is HONEST only if
// it pins what is red — never delete a red entry to make a coordinate look
// approved, and never keep a green one to reserve a slot.
//
// Re-pinned 2026-08-06 (IT-59, claim digests added; supervisor does a final
// refresh at integration because parallel lanes shift line numbers).
// Re-pinned again 2026-08-06 (IT-64, target digests added). Verified at that
// regeneration: 48 entries before and 48 after, 44 unique coordinates on both
// sides with identical multiplicities, and every new entry's first three fields
// byte-identical to the entry it replaced — i.e. the SAME set of rotted
// coordinates, re-pinned, with no coordinate silently leaving or entering.
// Re-pinned a third time 2026-08-06 (IT-65, target normalizer corrected — see
// the SECOND-field note above). Same verification, same result: 48 before / 48
// after, 44 unique coordinates both sides, and the multiset of the first THREE
// fields unchanged with ZERO differences — every entry's coordinate AND claim
// digest identical to the entry it replaced, so only the fourth field moved.
// That the referrer digests did not budge is the check that the fix stayed on
// the target half; had one moved, the referrer normalizer had been disturbed
// and the regeneration would have been abandoned rather than written.

export const ALLOWLIST = [
  'apps/desktop/src/lib/cloud-account.ts|apps/server-core/src/db/schema.ts#47|3b62bf08375e|78c5c592f73c', // no anchor within ±3 lines (tried: /api/me, users.email, user.repo.ts:12, account_id) @ apps/desktop/src/lib/cloud-account.ts line 65
  'apps/desktop/src/lib/cloud-account.ts|db/schema.ts#47|12765ce00e48|78c5c592f73c', // no anchor within ±3 lines (tried: S.cloud_acct_no_email, users.email) @ apps/desktop/src/lib/cloud-account.ts line 291
  'apps/desktop/src/lib/cloud-account.ts|apps/server-core/src/auth/jwt.ts#34|dbbc2e6ae9a1|075335b5e906', // no anchor within ±3 lines (tried: { sub, plan, iat, exp }, -39,107, -104) @ apps/desktop/src/lib/cloud-account.ts line 308
  'apps/desktop/src/lib/cloud-account.ts|shell/cloud.rs#101|135683b15f32|6057f3d24aec', // no anchor within ±3 lines (tried: { sub, plan, iat, exp }, -39,107, -104) @ apps/desktop/src/lib/cloud-account.ts line 308
  'apps/desktop/src/lib/pairing.ts|apps/server-core/src/room/registry.ts#260|d9b2cba154a3|01e0821333ac', // no anchor within ±3 lines (tried: alt=, /code=(\d{4})/, code=) @ apps/desktop/src/lib/pairing.ts line 180
  'apps/desktop/src/lib/settings-sync-notice.ts|apps/desktop/src-tauri/src/shell/mod.rs#162|536328e15ce6|a692f7edafa7', // no anchor within ±3 lines (tried: settings_update, with_lan_socket, sidecar_ctl.rs, bring_up_and_connect) @ apps/desktop/src/lib/settings-sync-notice.ts line 2
  'apps/desktop/src/main-window/cloud-account-card.test.ts|db/schema.ts#47|b11debfe698c|78c5c592f73c', // no anchor within ±3 lines (tried: owner@example.com, 暂时问不到，下面是 16:02 问到的, 服务端答了、这个账号确实没有邮箱: 说「未绑定邮箱」，不是那串 id，也不是「问不到」, users.email) @ apps/desktop/src/main-window/cloud-account-card.test.ts line 255
  'apps/desktop/src-tauri/src/forensic.rs|src/socket/pump.rs#100|ee977c2f7892|5ed775cba6b9', // no anchor within ±3 lines (tried: pump-lan, :17, index out of bounds: the len is 3, 0: alpha_frame\n1: beta_frame) @ apps/desktop/src-tauri/src/forensic.rs line 326
  'apps/desktop/src-tauri/src/forensic.rs|src/socket/pump.rs#100|4b02bc8f3f89|5ed775cba6b9', // no anchor within ±3 lines (tried: pump-lan, :17, index out of bounds: the len is 3, 0: alpha_frame\n1: beta_frame) @ apps/desktop/src-tauri/src/forensic.rs line 330
  'apps/desktop/src-tauri/src/socket/row_transit.rs|main-window/TimelinePage.vue#149|094710d48abe|edb13ee54464', // no anchor within ±3 lines (tried: entry_type:'image', source == "image", s guess about someone else, rowCanReinject) @ apps/desktop/src-tauri/src/socket/row_transit.rs line 310
  'apps/desktop/src-tauri/src/socket/row_transit.rs|lib/timeline-store.ts#635|caa5b2a2b0fc|d4a837fdaddd', // no anchor within ±3 lines (tried: rowCanReinject, entry_type !== 'image', output_text, reInjectLocally) @ apps/desktop/src-tauri/src/socket/row_transit.rs line 313
  'apps/mobile/lib/src/session/delivery_outbox_settle.dart|socket/client.rs#595|c00ef7c0977b|a54b78b10506', // no anchor within ±3 lines (tried: kInjectDeferredNotAutoinjected, ok:false, mode:'cached', INJECT_FOCUS_LOST, kPcInjectionVerdictCodes, FlowMic) @ apps/mobile/lib/src/session/delivery_outbox_settle.dart line 122
  'apps/mobile/lib/src/session/image_upload.dart|apps/desktop/src/lib/pairing.ts#138|722b4ea6b10e|24bd514fc10f', // no anchor within ±3 lines (tried: ReconnectCoordinator.url, ws://host:port, HttpClient.postUrl, ws://10.0.0.78:41879/api/inject/image) @ apps/mobile/lib/src/session/image_upload.dart line 239
  'apps/mobile/lib/src/session/instance_probe.dart|apps/desktop/src/lib/pairing.ts#138|47826a08e193|24bd514fc10f', // no anchor within ±3 lines (tried: MobileSession.endpoint, flowmic://pair?endpoint=ws://192.168.1.5:41879&code=1234&channel=standalone, HttpClient.getUrl, ws://) @ apps/mobile/lib/src/session/instance_probe.dart line 88
  'apps/mobile/lib/src/session/manual_delivery_reinject.dart|src-tauri/src/socket/wire.rs#374|2c312bf39b42|aa32a9ba0396', // no anchor within ±3 lines (tried: s retry idempotent, and it is why 窗口B3-2a) @ apps/mobile/lib/src/session/manual_delivery_reinject.dart line 146
  'apps/mobile/lib/src/session/outbox_inject_authorship.dart|apps/server-core/src/socket/handlers/relay.handler.ts#130|2e80e38d123e|870e10875ea2', // no anchor within ±3 lines (tried: ，于是「PC 亲口答的 『收到了，没注进去』」掉进可重试的 else ⇒ 项回, ⇒ 行显示「待投递」，而那条 消息**此刻就在 PC 的时间线上**。这个文件是那条规则的谓词形式。  🔴 **为什么判据是「码」而不是, **（被实测证伪过，写死免得重来）：, 回答「用了哪条投递路径」，不回答作者，而且**两个方向都判不出来**—— · 服务端代答的拒收也盖) @ apps/mobile/lib/src/session/outbox_inject_authorship.dart line 20
  'apps/mobile/lib/src/session/outbox_inject_authorship.dart|socket/client.rs#535|20354d002812|055a71a96499', // no anchor within ±3 lines (tried: mode:'cached', apps/server-core/src/socket/handlers/relay.handler.ts#130, :151, INJECT_FOCUS_LOST) @ apps/mobile/lib/src/session/outbox_inject_authorship.dart line 23
  'apps/mobile/lib/src/session/outbox_inject_authorship.dart|socket/client.rs#535|b4c1b286ed21|055a71a96499', // no anchor within ±3 lines (tried: test/inject_verdict_authorship_mirror_test.dart, INJECT_SELF_WINDOW_NO_INPUT, INJECT_NOT_PRIMARY, -542) @ apps/mobile/lib/src/session/outbox_inject_authorship.dart line 64
  'apps/mobile/lib/src/session/outbox_inject_authorship.dart|socket/client.rs#535|e3c0a7c9dc33|055a71a96499', // no anchor within ±3 lines (tried: INJECT_NOT_PRIMARY, inject:result.mode, -543, "sendinput") @ apps/mobile/lib/src/session/outbox_inject_authorship.dart line 80
  'apps/mobile/lib/src/session/pc_presence.dart|apps/server-core/src/socket/handlers/mobile.handler.ts#195|e0849415f21b|2238f5bf6929', // no anchor within ±3 lines (tried: pc_online, INJECT_PC_OFFLINE, FAILURES.md, relay.handler.ts:249) @ apps/mobile/lib/src/session/pc_presence.dart line 4
  'apps/mobile/lib/src/session/pc_presence.dart|apps/server-core/src/socket/handlers/relay.handler.ts#249|a1f163ff6175|067702c07365', // no anchor within ±3 lines (tried: pc_online, INJECT_PC_OFFLINE, InstanceReach, FAILURES.md) @ apps/mobile/lib/src/session/pc_presence.dart line 5
  'apps/mobile/lib/src/session/pc_presence.dart|packages/protocol/src/types.ts#198|69bccfdbe41c|06819afb5b51', // no anchor within ±3 lines (tried: pc_online, MobilePairAck.pc_online, grep pc_online --include=*.dart, lib/) @ apps/mobile/lib/src/session/pc_presence.dart line 114
  'apps/mobile/lib/src/settings/app_settings.dart|apps/server-core/src/stt/engine-router.ts#64|7046db18c5e7|1620202da5a1', // no anchor within ±3 lines (tried: audio:start.source_lang, zh-CN, userConfig.find((c) => c.language === language), apps/server-core/src/settings/defaults.ts#111-112) @ apps/mobile/lib/src/settings/app_settings.dart line 50
  'apps/mobile/lib/src/settings/app_settings.dart|apps/server-core/src/stt/engine-router.ts#75|988592a12057|12e28783b305', // no anchor within ±3 lines (tried: language_hint, packages/protocol/test/ engine-presets.test.ts:34, '*', configFromRouting) @ apps/mobile/lib/src/settings/app_settings.dart line 62
  'apps/mobile/lib/src/settings/app_settings.dart|apps/mobile/lib/src/ptt/ptt_session.dart#637|b4e86bca1214|dea131a07c7c', // no anchor within ±3 lines (tried: configFromRouting, apps/server-core/src/stt/engine-router.ts#75-81, zh-CN, '*') @ apps/mobile/lib/src/settings/app_settings.dart line 67
  'apps/mobile/lib/src/signaling/http_endpoint.dart|apps/desktop/src/lib/pairing.ts#138|c8b7c0fe7762|24bd514fc10f', // no anchor within ±3 lines (tried: ws://host:port, stance_probe.dart, image_upload.dart, diag_upload.dart) @ apps/mobile/lib/src/signaling/http_endpoint.dart line 6
  'apps/mobile/lib/src/signaling/inbound_payloads.dart|apps/desktop/src-tauri/src/socket/client.rs#530|4b075e5862b0|ebdf4114b174', // no anchor within ±3 lines (tried: wireMode == 'cached', -543, packages/protocol/src/inject-verdict-authorship .ts, wireMode) @ apps/mobile/lib/src/signaling/inbound_payloads.dart line 34
  'apps/mobile/lib/src/signaling/mobile_reconnect_flow.dart|auth/middleware.ts#136|110502c7e96f|4232e2dbfb09', // no anchor within ±3 lines (tried: mobile_pairings, pc.handler.ts:211-214, mobile:reconnect, PttSession.resumePairing) @ apps/mobile/lib/src/signaling/mobile_reconnect_flow.dart line 105
  'apps/mobile/lib/src/timeline/timeline_store_inject_writeback.dart|socket/client.rs#535|44e47a147526|055a71a96499', // no anchor within ±3 lines (tried: wireMode == kWireModeCached, INJECT_NOT_PRIMARY, -543, "sendinput") @ apps/mobile/lib/src/timeline/timeline_store_inject_writeback.dart line 226
  'apps/mobile/lib/src/ui/chat_flow_page.dart|socket/client.rs#535|8e79c5835647|055a71a96499', // no anchor within ±3 lines (tried: timeline_store.applyInjectResult, INJECT_NOT_PRIMARY, -543, "sendinput") @ apps/mobile/lib/src/ui/chat_flow_page.dart line 261
  'apps/mobile/test/inject_result_correlation_and_mode_truth_test.dart|socket/client.rs#530|b93814754a61|ebdf4114b174', // no anchor within ±3 lines (tried: wireMode == 'cached', -543, entry ??= lastAwaitingInject, wireMode) @ apps/mobile/test/inject_result_correlation_and_mode_truth_test.dart line 26
  'apps/mobile/test/lan_original_visible_test.dart|apps/desktop/src/lib/pairing.ts#138|1951b0ca9da0|24bd514fc10f', // no anchor within ±3 lines (tried: plus.image.original, HttpClient.getUrl, ArgumentError: Unsupported scheme 'ws', httpHealthRead) @ apps/mobile/test/lan_original_visible_test.dart line 27
  'apps/mobile/test/pairing_revoked_message_test.dart|auth/middleware.ts#136|030350d24b6e|4232e2dbfb09', // no anchor within ±3 lines (tried: mobile_pairings, pc.handler.ts:211-214, mobile:reconnect, resumePairing) @ apps/mobile/test/pairing_revoked_message_test.dart line 7
  'apps/mobile/test/spoken_language_test.dart|apps/mobile/lib/src/ptt/ptt_session.dart#637|2484004ce5c0|dea131a07c7c', // no anchor within ±3 lines (tried: ChatController.pttDown, PttSession.pttDown, audio:start, source_lang) @ apps/mobile/test/spoken_language_test.dart line 7
  'apps/mobile/test/spoken_language_test.dart|apps/server-core/src/stt/engine-router.ts#64|e3eab67f955a|1620202da5a1', // no anchor within ±3 lines (tried: audio:start, source_lang, chat_controller.dart, sourceLang: _activeSourceLang) @ apps/mobile/test/spoken_language_test.dart line 17
  'apps/server-core/src/http/diag-routes.ts|mobile/lib/src/diag/diag_upload.dart#76|2bc070353be4|d54182e9527c', // no anchor within ±3 lines (tried: uploadDiagnostics, Authorization: Bearer <token>) @ apps/server-core/src/http/diag-routes.ts line 56
  'apps/server-core/src/http/inject-routes.ts|room/registry.ts#362|c7d2a571af21|320c2cc9006c', // no anchor within ±3 lines (tried: verifyPairedMobile, registry.reconnectMobile, pcs.findById(mobileRow.pc_device_id), pc.id) @ apps/server-core/src/http/inject-routes.ts line 242
  'apps/server-core/src/http/inject-routes.ts|session/image_upload.dart#280|dcd2adaea874|017be16d1620', // no anchor within ±3 lines (tried: retryable:true, ImageUploadStatus.verdict, INJECT_PC_OFFLINE, INJECT_RESULT_TIMEOUT) @ apps/server-core/src/http/inject-routes.ts line 255
  'apps/server-core/src/http/inject-routes.ts|session/image_upload.dart#280|53080de49799|017be16d1620', // no anchor within ±3 lines (tried: request_id, s `ImageUploadStatus.refused` 「服务器拒绝了，重试也没用」 branch (mobile  -321, grep, retryable:true, ImageUploadStatus.refused) @ apps/server-core/src/http/inject-routes.ts line 300
  'apps/server-core/src/http/presence-routes.ts|apps/server-core/src/socket/handlers/mobile.handler.ts#195|03a1b3a0fd6c|2238f5bf6929', // no anchor within ±3 lines (tried: pc_online, FAILURES.md, CLAUDE.md) @ apps/server-core/src/http/presence-routes.ts line 5
  'apps/server-core/src/http/router.ts|sidecar/adopt.rs#84|fe58f894cda6|4a129ba2e7f6', // no anchor within ±3 lines (tried: "ok":true, await_health, io.rs:171, sidecar_ctl.rs:673) @ apps/server-core/src/http/router.ts line 360
  'apps/server-core/src/http/router.ts|shell/sidecar_ctl.rs#673|f0eb9d60178d|8b520c98400e', // no anchor within ±3 lines (tried: "ok":true, await_health, adopt.rs:84, io.rs:171) @ apps/server-core/src/http/router.ts line 361
  'apps/server-core/src/pool/select-route.ts|stt/engine-router.ts#88|95c78b220caa|6b6e2e560d13', // no anchor within ±3 lines (tried: 'all', s Chinese: `, ` is already this subsystem, userConfig.find((c) => c.language === '*')) @ apps/server-core/src/pool/select-route.ts line 49
  'apps/server-core/src/pool/select-route.ts|stt/engine-router.ts#3|d537e744ae1d|c8679bec7b27', // no anchor within ±3 lines (tried: s Chinese: `, ` is already this subsystem, stt/engine-router.ts#88, userConfig.find((c) => c.language === '*')) @ apps/server-core/src/pool/select-route.ts line 50
  'apps/server-core/test/console-routes.test.ts|room/registry.ts#82|aaa65f256bc5|eee5b66c2bd2', // no anchor within ±3 lines (tried: ${url}/api/cloud/summary, summary.json.devices, toEqual, pc_count) @ apps/server-core/test/console-routes.test.ts line 314
  'apps/server-core/test/inject-image-upload.test.ts|session/image_upload.dart#280|d935ac3b635d|017be16d1620', // no anchor within ±3 lines (tried: i1-addr-bad, pc-somebody-else, good-token, retryable:true) @ apps/server-core/test/inject-image-upload.test.ts line 303
  'packages/protocol/src/protocol-schemas-inject.ts|session/image_send_controller.dart#437|b83ba216eb61|29868167385e', // no anchor within ±3 lines (tried: inject:request.text) @ packages/protocol/src/protocol-schemas-inject.ts line 240
  'packages/protocol/src/protocol-schemas-inject.ts|main-window/TimelinePage.vue#149|82905fe6fedc|edb13ee54464', // no anchor within ±3 lines (tried: build_row, entry_type:'image', row_transit.rs, entry_type) @ packages/protocol/src/protocol-schemas-inject.ts line 249
];
