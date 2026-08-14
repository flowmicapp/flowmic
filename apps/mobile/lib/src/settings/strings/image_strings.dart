// AppStrings copy-catalogue shard: the picture pipeline (album injection ·
// preview · copy).
// The one external entry point remains ../app_strings.dart (AppStrings
// composes this mixin via `with`; from 0.2.67 the copy leaves `_lf…` are
// implemented by the generated classes under l10n/; `_t` is still used only
// by the handful of spots that **refused** migration — see the passage above
// `_t` in app_strings.dart for why).
part of '../app_strings.dart';

// ── RV-87 / Card B4-12 (15 册 G-16, partial) — the cloud-image relay quota's copy
// numbers ──────────────────────────────────────────────────────────────────
//
// Mirrors of packages/protocol/src/constants.ts `CLOUD_IMAGE_QUOTA_MAX` (200)
// and `CLOUD_IMAGE_QUOTA_WINDOW_MS` (24 * 60 * 60 * 1000, expressed in HOURS
// here because that is the unit [cloudImageRelayErrorNote]'s sentence names).
// Same manual-sync discipline [kCloudImageBytesMax] (image_payload.dart)
// already documents: Dart cannot import a TypeScript module, so there is no
// automated cross-language check — only this file's own header, the protocol
// side's own header pointing back, and test/cloud_image_error_copy_test.dart
// pinning both integers. If protocol's numbers ever move, these two move with
// them in the same edit.
//
// 🔴 THESE LIVE HERE, NOT BESIDE [kCloudImageBytesMax] IN image_payload.dart —
// Card B4-12 grants this worker `settings/strings/**` + chat_message_tile.dart
// ONLY (four other lanes have uncommitted changes in flight elsewhere in the
// tree at the time this card was worked). [kCloudImageBytesMax] is reused
// as-is from image_payload.dart (already imported into this library via
// app_strings.dart) rather than duplicated — the size ceiling already had a
// mirror; only the quota ceiling needed one.
const int kCloudImageQuotaMax = 200;
const int kCloudImageQuotaWindowHours = 24;

mixin ImageStrings on AppStringsLeaves {
  String _t({
    required String zh,
    required String en,
    required String ja,
    required String ko,
  });

  // ── Picture pipeline (R6 T-4 / §6.1 「+」panel B3 flagship action) ─────────
  String get imageTile => _lfImageTile;
  String get imageTileSub => _lfImageTileSub;

  /// Light-record (轻记录) tile sub-line (owner 2026-07-31): local noted save, not paste.
  /// Must NOT reuse [imageTileSub] — that promises a PC focus window.
  String get imageTileSubLocal => _lfImageTileSubLocal;

  /// Shown while the picker is open / the frame is going out, so a second tap
  /// has a visible reason for being inert.
  String get imageSending => _lfImageSending;

  // ── "original image" (原图) tick box (owner 2026-08-01: 「让用户决定是否
  //    发送原图」 — "let the user decide whether to send the original image") ──
  /// The tick box's own label. Short on purpose — it sits inside the photo tile.
  String get imageOriginal => _lfImageOriginal;

  /// What ticking it actually does, stated in the two facts the user can act on:
  /// nothing is re-compressed, and it may be refused for size. Deliberately does
  /// NOT promise 「更清楚」("clearer") — on a small picture the compressed path
  /// is already pixel-identical, and a promise the app cannot keep is the
  /// shape this repo keeps paying for.
  String get imageOriginalHint => _lfImageOriginalHint;

  /// Why there is no "original image" (原图) tick box right now (owner
  /// 2026-08-01, LAN only).
  ///
  /// 🔴 Rendered where the tick box would have been. R8 forbids a control that
  /// changes nothing; the other half of that rule — set by B3-9, owner's
  /// 「都不存在就提醒」("if it doesn't exist at all, say so") — is that an
  /// affordance which disappears must leave its reason standing in its place,
  /// or the user reads it as 「功能没了」("the feature is gone").
  ///
  /// 🔴 NEITHER sentence may claim the cloud enforces anything. Nothing on the
  /// relay checks this (RV-87 is next round). They describe what this phone
  /// does and where the user can go to get the other behaviour.
  String imageOriginalUnavailable(ImageOriginalBlock block) {
    switch (block) {
      case ImageOriginalBlock.cloudChannel:
        return _lfImageOriginalUnavailable__1;
      // NOT the cloud sentence: the probe has not answered, so the app does not
      // know it is on the relay and must not say so.
      case ImageOriginalBlock.channelUnknown:
        return _lfImageOriginalUnavailable__2;
    }
  }

  /// Kept for [ImageSendFailure.noPcTarget] exhaustiveness. The panel no longer
  /// withholds the tile with this sentence — local save is the product answer.
  String get imageNoPcTarget => _lfImageNoPcTarget;

  /// Fail-loud copy for an image send that did not happen. Every branch names
  /// the wall that was hit and, where there is a number, states it.
  String imageSendError(ImageSendOutcome outcome) {
    switch (outcome.reason) {
      case ImageSendFailure.notConnected:
        return _lfImageSendError__1;
      case ImageSendFailure.noPcTarget:
        return imageNoPcTarget;
      case ImageSendFailure.permissionDenied:
        return _lfImageSendError__2;
      // 🔴 Same family as RV-97 — `outcome.detail` here is also the platform
      // exception's `toString()` (image_send_controller's `on Object catch
      // (e)`). Same rule: the banner says 「发生了什么 + 能做什么」("what
      // happened + what can be done"), the raw exception text goes into diag.
      case ImageSendFailure.pickerFailed:
        return _lfImageSendError__3;
      case ImageSendFailure.emptyFile:
        return _lfImageSendError__4;
      case ImageSendFailure.unsupportedFormat:
        return _lfImageSendError__5;
      case ImageSendFailure.tooLarge:
        return _lfImageSendError__6(outcome.detail ?? '');
      // owner 2026-08-01 "original image" (原图). Says three things the plain tooLarge cannot: it
      // was the ORIGINAL that did not fit, the picture itself is fine, and the
      // fix is one tap away and does not mean finding another photo.
      case ImageSendFailure.originalTooLarge:
        return _lfImageSendError__7(outcome.detail ?? '');
      // owner 2026-08-01 cloud 1M cap.
      //
      // 🔴 THE WORDING IS THE CONTRACT HERE. Nothing on the relay checks this
      // size — the server half is RV-87, next round. So this sentence says what
      // THIS PHONE did (「未发送」 — "not sent") and what the user can do
      // (switch to LAN — 换局域网). It must never read 「云端拒收了」("the
      // cloud refused it")/「服务器不允许」("the server does not allow it"):
      // that would be the repo's #1 red line, a claim about an enforcement
      // that does not exist. If you are editing this string, that is the one
      // thing you may not add.
      case ImageSendFailure.cloudImageTooLarge:
        return _lfImageSendError__8(outcome.detail ?? '', formatBytes(kCloudImageBytesMax));
      case ImageSendFailure.wireFailed:
        return _lfImageSendError__9;
      // RCA-v3 (2026-07-30): the four transport-truth outcomes. Each names a
      // DIFFERENT fact — what went out, what did not, and what is unknown.
      case ImageSendFailure.linkDown:
        return _lfImageSendError__10;
      // 🔴 RV-97 — this sentence must no longer hand the raw exception to the
      // user as-is.
      //
      // What the owner saw on a real device on 2026-08-01 (translated from the
      // original Chinese, quote kept below):
      //   「联系不上电脑（Invalid argument(s): Unsupported scheme 'ws' in URI
      //     ws://10.0.0.78:41879/api/inject/image），图片没有发出」
      //   ("Could not reach the computer (Invalid argument(s): Unsupported
      //   scheme 'ws' in URI ws://10.0.0.78:41879/api/inject/image),
      //   the picture was not sent")
      // On this branch `outcome.detail` was just `e.toString()` — a sentence
      // the user can neither understand nor act on, and it crowded out the
      // only useful content (what to do next). The technical detail now goes
      // only into diag (`image.http_upload.detail` /
      // `image.http_unreachable_queued`).
      //
      // ⚠️ This branch now **only appears when there is no draft available to
      // drain** (image_send_controller's unreachable branch) — meaning the
      // half-sentence 「图片没有发出」("the picture was not sent") is true
      // here. When the queue has a fallback, the user instead sees the 15 册
      // standing banner 「还有 N 条未投递，连接恢复后会自动投递」("N items
      // still undelivered; delivery resumes automatically once the connection
      // is restored").
      case ImageSendFailure.pcUnreachable:
        return _lfImageSendError__11;
      case ImageSendFailure.pcOffline:
        return _lfImageSendError__12;
      case ImageSendFailure.noAnswer:
        return _lfImageSendError__13;
      case ImageSendFailure.rejected:
        return _t(
          zh: '服务器拒收了这张图片：${outcome.detail ?? '未知原因'}',
          en: 'The server refused this photo: ${outcome.detail ?? 'unknown reason'}',
          ja: 'サーバーがこの画像を拒否しました：${outcome.detail ?? '不明な理由'}',
          ko: '서버가 이 사진을 거부했습니다: ${outcome.detail ?? '알 수 없는 이유'}',
        );
      // RV-05 (2026-07-30): the SERVER held the delivery out. Worded as
      // 「服务器」("the server") and 「未注入」("not injected") on purpose —
      // this is not the PC's verdict on the picture,
      // and the earlier silence let the phone show it as one. The wait is spelled
      // out because it is the only actionable part of the sentence; before this
      // the server's retry_after_ms was parsed and thrown away.
      case ImageSendFailure.serverRefused:
        final int? ms = outcome.retryAfterMs;
        final int secs = ms == null ? 0 : (ms / 1000).ceil();
        final String why = _serverRefusedWhy(outcome.detail);
        if (secs <= 0) {
          return _lfImageSendError__15(why);
        }
        return _lfImageSendError__16(why, secs);
    }
  }

  /// The reason clause of a [ImageSendFailure.serverRefused] banner. The two
  /// hold-out codes already have their own sentences in the shared error-code
  /// table's spirit — 「电脑刚刚断开了这台手机」("the computer just disconnected
  /// this phone") vs 「已有另一台手机在用」("another phone is already in use") —
  /// and they must stay two different sentences: one means somebody pressed
  /// disconnect (断开), the
  /// other means nobody pressed anything.
  String _serverRefusedWhy(String? code) {
    switch (code) {
      case 'PAIR_RELEASED':
        return _lf_serverRefusedWhy__1;
      case 'PC_BUSY':
        return _lf_serverRefusedWhy__2;
      default:
        return _t(
          zh: '服务器暂时不接收（${code ?? '未说明'}）',
          en: 'The server is not taking deliveries right now (${code ?? 'unstated'})',
          ja: 'サーバーが現在受け付けていません（${code ?? '理由不明'}）',
          ko: '서버가 현재 수신하지 않습니다(${code ?? '이유 미기재'})',
        );
    }
  }

  // ── RV-87 / Card B4-12 (15 册 G-16, partial disposition) ────────────────────
  //
  // owner 2026-08-01 「服务器统一拦客户端，图片超过 1M 就不允许传」("the server
  // uniformly blocks the client — a picture over 1M is simply not allowed to
  // be sent") + 「限制到 200 张」("capped at 200 images") →
  // packages/protocol/src/error-codes.ts's two new codes,
  // INJECT_CLOUD_IMAGE_TOO_LARGE / INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED. Another
  // lane found (verified) that the phone renders EVERY server error code as
  // the bare wire identifier — `chat_message_tile.dart` says so in so many
  // words ("error codes are identifiers, not copy") and `getErrorMessage`
  // (the protocol's own zh/en table) has exactly one runtime caller anywhere
  // in the repo, the desktop probe client, unrelated to delivery. This is
  // this card's ANSWER for exactly these two codes — 15 册 G-16's full-
  // catalogue question ("translate ALL of them?") is the lead's/owner's call,
  // not decided here. Every other code still falls through to the raw
  // identifier at this function's one call site (chat_message_tile.dart).
  //
  // ⚠️ THE SERVER NEVER SENDS THE REAL NUMBERS ON THIS WIRE. cloud-image-
  // policy.ts computes `bytes` / `max_bytes` / `used` / `max` /
  // `retry_after_ms` and relay.handler.ts only LOGS them
  // (`...verdict.detail` inside `log.warn`) — `answerReject` echoes only
  // `request_id`/`entry_id` on `inject:result`. So there is no live value to
  // read here; [kCloudImageBytesMax] / [kCloudImageQuotaMax] /
  // [kCloudImageQuotaWindowHours] (this file's header, mirroring
  // packages/protocol/src/constants.ts) are the only source the copy can
  // quote, same situation the pre-existing [kCloudImageBytesMax] mirror was
  // already in. Making the server put `verdict.detail` on the wire would be
  // the structural fix — that is a protocol/relay change, outside this
  // card's grant (`settings/strings/**` + chat_message_tile.dart only).
  //
  // Returns null for every code that is not one of these two — callers MUST
  // fall back to the raw identifier (or to silence, on a face that already
  // withholds one) rather than inventing a sentence for a code this function
  // does not recognise.
  String? cloudImageRelayErrorNote(String code) {
    switch (code) {
      case 'INJECT_CLOUD_IMAGE_TOO_LARGE':
        return _lfCloudImageRelayErrorNote_INJECT_CLOUD_IMAGE_TOO_LARGE(formatBytes(kCloudImageBytesMax));
      case 'INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED':
        return _lfCloudImageRelayErrorNote_INJECT_CLOUD_IMAGE_QUOTA_EXCEEDED(kCloudImageQuotaMax, kCloudImageQuotaWindowHours);
      default:
        return null;
    }
  }

  // ── RCA-v3: the top transfer progress bar (owner 2026-07-30) ──────────────
  /// Stage labels for the in-flight image delivery. [imageStageUploading] gets
  /// a REAL percentage on the LAN http path; the socket path shows the label
  /// alone (indeterminate) rather than inventing a number.
  String get imageStagePreparing => _lfImageStagePreparing;
  String get imageStageUploading => _lfImageStageUploading;
  /// RV-30 HTTP wait: upload finished; the server has the bytes. The user can
  /// only wait (same action as the socket wait) but the KNOWN fact differs —
  /// this copy may say the picture reached the server.
  String get imageStageWaitingHttpVerdict => _lfImageStageWaitingHttpVerdict;

  /// RV-30 socket wait: frame handed to the client only. Must NOT reuse the
  /// HTTP wording — that would call 「不知道」("unknown") 「已收到」("received").
  String get imageStageWaitingSocketAck => _lfImageStageWaitingSocketAck;

  /// owner 2026-07-27 double-tap for full-screen preview. Names all three exits — a full-screen view
  /// whose way out is not stated is a trap.
  String get imageZoomClose => _lfImageZoomClose;

  /// The ONE statement of what survives on this phone: the bounded preview,
  /// never the original bytes (ImageSendController drops them after the emit).
  /// The context-menu sub-line shows it bare; the copy-result toast wraps it —
  /// both build on this getter so the two surfaces can never drift into two
  /// different phrasings of the same fact (V2-07.7 merge).
  String get imagePreviewNote => _lfImagePreviewNote;

  /// window-B3-9 / 15册 G-11 — 「有的图能重发、有的不能，没人说为什么」("some
  /// images can be resent, some can't, and nobody says why"). Rendered ONLY
  /// when `entry.isImage && face == DeliveryFace.injected`, in the exact slot the
  /// resend (重发) button would occupy (ChatMessageTile), so a picture row
  /// that offered the button while queued does not silently go blank once it
  /// lands.
  ///
  /// ⚠️⚠️ Correction (RV-93, owner 2026-08-01). The sentence used to be
  /// 「原件已投递并清理，无法重发」("the original was delivered and cleaned up;
  /// cannot be resent") and its doc explained that this was the one moment the
  /// compressed copy was GONE (owner ① 「投递成功即删」 — "delete on successful
  /// delivery"). owner revoked that ruling (「改为存下来」 — "changed to keep
  /// it") — the picture is still on the phone, and it is what viewing the
  /// full image (点开大图) now shows. So the old sentence became a **false
  /// statement about the user's own storage**, which is worse than saying
  /// nothing.
  ///
  /// The honest reason a delivered picture has no resend (重发) is not
  /// scarcity, it is that the delivery already succeeded — re-sending would
  /// paste it into the
  /// user's document a second time. That is what it says now, and it is why the
  /// wording stays flat rather than 「暂时不可用」("temporarily unavailable")-shaped hedging.
  String get imageResendUnavailableNote => _lfImageResendUnavailableNote;

  /// Card fix-015 — the PICTURE-ROW reading of the two macOS injection verdicts
  /// `INJECT_SECURE_INPUT_ACTIVE` (63) and `INJECT_NO_ACCESSIBILITY` (64).
  ///
  /// 🔴 WHAT THIS FIXES IS NOT SILENCE. Measured on this tree before the change,
  /// a picture row settling on 63 renders the pill 「⤓ 已投递 · 未注入」("delivered
  /// · not injected") and the GENERIC sentence from
  /// [InjectNoteStrings.injectVerdictNote], which ends 「…再重发。」/ "…then
  /// resend." — and the row carries **no resend (重发) control at all**
  /// (`canResendImage` is false: 63/64 are in `kPcInjectionVerdictCodes`, so
  /// `outboxSettle` settles the item `delivered`/terminal ⇒ it leaves
  /// `OutboxPendingView.resendableImageEntryIds`). The PC has none either:
  /// `TimelinePage.vue` `rowCanReinject` = `e.entry_type !== 'image' && …`, so a
  /// picture row renders no re-inject (重新注入) button. ⇒ the sentence names
  /// an action that exists on **neither end** — 「文案承诺一个不存在的动作」("the
  /// copy promises an action that does not exist"), and the registry's own
  /// `INJECT_DEFERRED_NOT_AUTOINJECTED` comment already reached that verdict for
  /// exactly this situation: 「state the fact, add no imperative the product
  /// cannot honour」. That imperative is correct on a TEXT row (the
  /// `deliveredNotInjected` face is in `retryableFace` and the button renders),
  /// which is why the fix belongs to the ROW SHAPE and not to the code.
  ///
  /// 🔴 SO THIS IS NOT A FOURTH SEGMENT TABLE. The three tables
  /// `_humanNoteFor` composes are keyed by SEGMENT and are disjoint by contract
  /// (`test/error_code_copy_binding_test.dart` measures it); this one is keyed
  /// by the same code and selected by **what the row can actually offer**. The
  /// two sentences for a code are never both shown — ONE function decides
  /// (`chat_message_tile.dart` `_reasonNoteFor`, whose gate is the very
  /// `canRetry` boolean that draws the button), which is the same
  /// one-place-decides discipline `_reasonLineFor` and `_provenance` already
  /// follow. A row can therefore never say 「重发」("resend") while showing no
  /// resend control.
  ///
  /// ⚠️ NOT EXTENDED TO `INJECT_FOCUS_LOST`, which has the same shape on a
  /// picture row (its copy also ends 「…再重发」("…then resend") and it is also
  /// in `kPcInjectionVerdictCodes`). Named rather than silently left out:
  /// closing it is a different card, and this table returning `null` for it
  /// keeps the existing behaviour byte-for-byte.
  ///
  /// ✅ Correction (card fix-015 wrap-up, 2026-08-10) — **that different card is
  /// this one, and the paragraph above is now history.** Kept rather than
  /// deleted because it is the reason the third case exists: the boundary was
  /// DECLARED, and `image_verdict_affordance_test.dart` group ③ asserted it, so
  /// closing it made that assertion go red instead of letting the gap sit
  /// unnoticed. **A scope boundary written down as a test is what let this be a
  /// one-entry change.**
  ///
  /// 🔴 THE THIRD SENTENCE MAY NOT BORROW 63'S 「这是暂时的」("this is
  /// temporary") SHAPE, however much the two look alike. Both causes can pass
  /// on their own — the user walks back to their editor, the foreground
  /// settles — but only 63 was RULED transient, and only 63 has a mechanism
  /// behind the promise: `kTransientInjectionVerdictCodes` holds it ALONE, and
  /// that set's doc says adding a member is a RULING rather than a refactor,
  /// naming `INJECT_FOCUS_LOST` as the obvious candidate nobody has ruled on.
  /// So nothing re-sends this frame; 「等一下就好了」("just wait a moment and
  /// it'll be fine") here would be a wait with nothing to honour it — the F-1
  /// red line. Pinned by group ⓪ of `image_verdict_focus_lost_test.dart`,
  /// which asks the predicate rather than trusting this paragraph.
  ///
  /// 🔴 63 AND 64 SAY OPPOSITE THINGS, and that is the whole reason the owner
  /// minted two codes rather than one (`error-codes.ts`: 「they are the furthest
  /// apart of any pair in this table」). 63 is a moment — it clears itself when
  /// the PC leaves the secure field and the user must change nothing. 64 stands
  /// until a permission is granted, and it is the ONE failure on this path the
  /// user can fix themselves, so its sentence names the exact pane. A shared
  /// sentence would send a user with no Accessibility grant hunting for a
  /// password field they do not have.
  ///
  /// ⚠️ NOT ONE SENTENCE IN THIS TABLE MAY BE READ AS 「没送到」("did not
  /// arrive") (delivery ≠ injection, 投递 ≠ 注入, docs/rebuild/15 §2.0): every
  /// verdict here rides `mode:'cached'`, the frame was in the PC's own process
  /// when the judgement was made, and `row_transit::mint_row` minted the
  /// timeline row from the same expression. Each sentence states that first.
  /// ⚠️ The original text read "NEITHER … both" — this table only had two
  /// entries back then, and adding a third made it a rule that would miss
  /// someone. Rewritten to hold for the whole table, rather than changing 2 to
  /// 3.
  ///
  /// Returns `null` for every other code — the caller then falls back to the
  /// generic note exactly as before.
  String? imageInjectVerdictNote(String code) {
    switch (code) {
      // ── Card fix-015 wrap-up —— `INJECT_FOCUS_LOST` on a picture row ────────
      //
      // PRODUCER: `inject/pipeline.rs` `stage1_focus`, whose own doc says 「Stage 1,
      // shared by the text and image paths」 — so a picture genuinely reaches here.
      // Two arms, one code: no locked/live target HWND at all, or
      // `SetForegroundWindow` returned FALSE. `InjectMode::Cached` on both ⇒ the
      // delivery segment succeeded (投递段成功), and the first clause below may
      // not be read as 「没送到」("did not arrive").
      //
      // 🔴 WHY THE TAIL IS NOT THE GENERIC ONE. The generic sentence ends
      // 「到电脑上点进输入框**再重发**」("go to the computer, click into an input
      // field, **then resend**") — correct on a text row, false here: the item
      // settled terminal (`kPcInjectionVerdictCodes` holds this code) ⇒
      // `canResendImage` is false ⇒ no resend (重发), and `TimelinePage.vue`
      // `rowCanReinject` excludes images ⇒ no re-inject (重新注入) either.
      //
      // 🔴 WHY IT KEEPS AN IMPERATIVE AT ALL, unlike 63. 「点进要输入的地方」
      // ("click into where input is needed") is the real fix for BOTH producer
      // arms (no target / could not be raised), and it is an action the
      // product honours — but its payoff is explicitly scoped to
      // **之后发过去的内容**("content sent AFTER this"), never to this row.
      // That scoping is the whole sentence: drop it and 「点进输入框」("click
      // into the input field") silently re-promises the thing the resend
      // (重发) clause was removed for. State the fact, and let the instruction
      // say what it actually buys.
      case 'INJECT_FOCUS_LOST':
        return _lfImageInjectVerdictNote_INJECT_FOCUS_LOST;
      case 'INJECT_SECURE_INPUT_ACTIVE':
        return _lfImageInjectVerdictNote_INJECT_SECURE_INPUT_ACTIVE;
      case 'INJECT_NO_ACCESSIBILITY':
        return _lfImageInjectVerdictNote_INJECT_NO_ACCESSIBILITY;
      default:
        return null;
    }
  }

  /// owner 2026-07-27 picture copy. Three of the four outcomes need a sentence, and
  /// each names WHAT is on the clipboard — the phone kept only the 256 px
  /// preview, so 「已复制图片」("picture copied") with a thumbnail behind it
  /// would be an overclaim.
  /// A plain text copy stays silent (returns null): it is the behaviour that was
  /// always there and has nothing to explain.
  String? imageCopyResult(ImageCopyOutcome outcome) {
    switch (outcome) {
      case ImageCopyOutcome.copiedText:
        return null;
      case ImageCopyOutcome.copiedPreview:
        return _lfImageCopyResult__1(imagePreviewNote);
      case ImageCopyOutcome.noPreviewCopiedText:
        return _lfImageCopyResult__2;
      case ImageCopyOutcome.platformRefusedCopiedText:
        return _lfImageCopyResult__3;
    }
  }
}
