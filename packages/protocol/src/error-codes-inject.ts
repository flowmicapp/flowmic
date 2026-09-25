import type { ErrorMessage } from './error-code-types';

export const INJECT_ERROR_CODES = {
  // Inject
  INJECT_TARGET_INVALID:     { zh_CN: '目标输入位置无效，文字未能输入，已暂存至电脑时间线。', en: 'Target invalid, cannot inject. Cached.' },
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
  INJECT_NO_TEXT_TARGET:     { zh_CN: '当前没有聚焦的输入框，请先点击目标输入位置后再说话。', en: 'No editable field is focused — click into a text box first.' },
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
  // B RC27: retained by the lead maintainer, reversible by the owner; ruling:
  // docs/decisions/2026-09-22-inject-target-not-ready-lead-ruling-and-cached-mode-pin.md.
  // The frame reached the selected web
  // target, but that target's admission layer was not ready to accept it. No
  // injection was attempted. The phone keeps the existing outbox item queued,
  // so restoring target admission gives the established retry mechanism a real
  // chance to deliver it. This is deliberately NOT INJECT_NOT_PRIMARY (no other
  // phone owns the target) and NOT a relay refusal (the target answered itself).
  // Formal copy came through the lead maintainer's rewriting pipeline (9e8fb264;
  // registry landing 04dda655). The ruling requests a further en/ru correction;
  // that copy is pending from the lead, not authored by this implementation card.
  INJECT_TARGET_NOT_READY:   { zh_CN: '目标尚未就绪，已排队等待重试。', en: 'The target is not ready yet. This item remains queued and will retry automatically.' },
  // INJECT_TAURI_MISSING retired 2026-09-02 (WP-8 registry hygiene) — see the
  // "75 → 69" note near EXPECTED_ERROR_CODE_COUNT.
  // 2026-07-29 (owner「按最优选择修复」): the three server-side verdicts that used
  // to be SILENT. A dropped inject:request left the phone waiting out its 20 s
  // watchdog with no reason ever stated — the frame died at the zod boundary
  // (image_b64 over the 5.5M cap, seen live: 「reason: image_b64: too_big」) or in
  // relay's `getPc(room)?.emit` when no PC was in the room. Each verdict now has
  // an honest code and rides a server-authored inject:result back to the sender.
  INJECT_FRAME_TOO_LARGE:    { zh_CN: '图片大小超出传输上限，电脑未能接收。',        en: 'Image data exceeds the wire cap; the PC never received it.' },
  INJECT_FRAME_INVALID:      { zh_CN: '数据格式异常，电脑未能接收，请重试。',        en: 'Malformed frame; the PC never received it.' },
  // 2026-08-09 (DOC-HYG, conductor-reviewed): this used to read 「电脑不在线，
  // 未注入。」/ "nothing was injected" — a DELIVERY-segment code wearing an
  // INJECTION-segment word (投递 ≠ 注入, 15 册 §2.0). The frame never reached a
  // PC (`inject-verdict-authorship.ts`: INJECT_PC_OFFLINE is relay-authored), so
  // 「未注入」 answered for a machine that never judged it — the phone's own
  // deliveryRefusalNote already refused to mirror it for exactly this reason.
  // Deliberately NO retry promise here: the phone's copy may promise a resend
  // because it owns the queue that honours it; this string has consumers with no
  // such mechanism, and a promise without a mechanism is the F-1 red line.
  INJECT_PC_OFFLINE:         { zh_CN: '电脑当前处于离线状态，文字未能送达。',          en: 'PC is not connected; this was never delivered.' },
  // 2026-07-30 (image-transit RCA-v3): the LAST silent drop on the relay path. A frame
  // arriving on a socket with no auth or no room used to `return` with no log
  // and no answer — which is exactly where a client-side reconnect flushes its
  // send buffer BEFORE re-registering, so the loss was real, reachable, and
  // indistinguishable from 「帧从未发出」. Deliberately distinct from
  // INJECT_PC_OFFLINE: that one says the ROOM has no PC (retrying later may
  // help); this one says the SENDER isn't in a room yet (rejoin, then retry).
  INJECT_NOT_IN_ROOM:        { zh_CN: '连接尚未就绪，请稍候重试。',                  en: 'Connection not ready yet — please try again in a moment.' },
  // 2026-07-30 (RV-04): the http image ingress refuses to relay a frame it could
  // not report a verdict for — its request_id ledger is momentarily full. First
  // written as PC_BUSY, which was a LIE in a user-visible string: PC_BUSY says
  // 「另一台手机占用了这台电脑」 and the phone renders exactly that, while the
  // actual fact is 「服务器这一刻接不下」 — nothing to do with another phone and
  // nothing the user could act on by leaving a page on it. Distinct code so the
  // sentence can be true; retryable either way.
  INJECT_SERVER_BUSY:        { zh_CN: '服务器繁忙，本次发送未成功，请稍候重试。',      en: 'The server has too many deliveries in flight; this one was not sent — retry shortly.' },
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
  INJECT_PC_MISMATCH:        { zh_CN: '本条消息的目标设备为其他电脑，未在当前电脑注入。', en: 'This delivery is addressed to a different PC; nothing was injected on this one.' },
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
  INJECT_PC_UNSPECIFIED:     { zh_CN: '未指定目标电脑，文字未能注入。请将手机端更新至最新版本后重试。', en: 'This delivery named no target PC; nothing was injected. Update the phone app and retry.' },
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
  INJECT_CLOUD_IMAGE_TOO_LARGE: { zh_CN: '通过云端中继仅支持发送 1 MB 以内的图片，本次未发送。连接至同一局域网即可发送大图。', en: 'The cloud relay does not carry images over 1 MB; this one was not sent. Connect over the same LAN to send it.' },
  INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED: { zh_CN: '该账号 24 小时内通过云端中继发送的图片已达 200 张上限，本次未发送。请稍后再试，或连接至同一局域网发送。', en: 'This account has reached the 200-image / 24-hour cloud relay limit; this one was not sent. Try again later, or connect over the same LAN.' },
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
  INJECT_DEFERRED_NOT_AUTOINJECTED: { zh_CN: '本条为连接恢复后自动补发的消息，已存入电脑时间线；为避免打扰当前操作，未自动注入。', en: 'Re-delivered automatically: it reached the PC and is on its timeline. It was deliberately not auto-injected, so it could not interrupt what you were doing.' },
  // 🔴 owner 2026-08-02 (F1a reversal ruling, docs/archive/strategy/2026-08-02-0248-status-truth-analysis.md
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
  INJECT_SELF_WINDOW_NO_INPUT: { zh_CN: '当前焦点在 FlowMic 自身窗口且未处于输入框中，未执行输入。请点击输入框或切换到目标程序后再重新注入。', en: 'Focus was on FlowMic\'s own window and not in an editable field, so nothing was typed. Click into a FlowMic input box, or switch to the app you want, then re-inject.' },
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
  INJECT_SECURE_INPUT_ACTIVE: { zh_CN: '电脑处于系统安全输入状态（如密码框或锁屏），系统已拦截模拟按键输入。文字已保存至电脑时间线，离开安全输入区域后可在电脑上重新注入。', en: 'The PC is in the system\'s secure input mode (a password field, Terminal\'s Secure Keyboard Entry, or the lock screen), where synthetic keystrokes reach nobody, so nothing was typed. It did reach the PC and is on its timeline. Leave the secure field, then re-inject on the PC.' },
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
  INJECT_NO_ACCESSIBILITY: { zh_CN: '电脑尚未授予 FlowMic「辅助功能」权限，无法模拟按键输入。文字已保存至电脑时间线，请在电脑系统设置中打开「系统设置 ▸ 隐私与安全性 ▸ 辅助功能」开启权限后重新注入。', en: 'FlowMic has not been granted Accessibility on the PC, so the system discards every keystroke it sends and nothing was typed. It did reach the PC and is on its timeline. On the PC open System Settings ▸ Privacy & Security ▸ Accessibility, turn FlowMic on, then re-inject.' },
} as const satisfies Record<string, ErrorMessage>;
