// Part of image_send_controller.dart — the LAN http delivery leg (RCA-v3).
//
// ── WHY THIS FILE EXISTS: THE 800-LINE CAP, AND NOTHING ELSE ─────────────────
//
// `verify:lint` 8/10 (`file-size.mjs`, SRC_MAX = 800) went red when RV-97 rewrote
// the unreachable arm (887 > 800). This is the split the repo already does for
// exactly this reason (chat_outbox_host.dart is `part of chat_controller.dart`),
// and it is a MOVE: every line below is byte-for-byte what it was inside
// [ImageSendController], with two mechanical changes and no third —
//
//   · `_sendViaHttp(...)` → `imageSendViaHttp(c, ...)`, the controller passed
//     explicitly, the convention chat_outbox_host.dart set (a reader sees at
//     each line that this is the controller's own state, not a copy);
//   · the private members it uses are reached through `c.`, which a `part` file
//     may do because it shares the library's privacy scope — no member had to be
//     widened to make this compile, and none may be.
//
// Stated explicitly because a split is the easiest place to smuggle a change
// into: a reader diffing this against git history should find only a move.

part of 'image_send_controller.dart';

/// The LAN http delivery (RCA-v3). The response body IS the verdict; the row
/// settles through the SAME InjectResult path the socket mirror uses (its
/// field names match inject:result deliberately), so a mirror frame arriving
/// later re-applies the same truth instead of fighting a second mechanism.
Future<ImageSendFailure?> imageSendViaHttp(
  ImageSendController c,
  LanImageIngress ingress,
  TimelineEntry entry,
  InjectRequestPayload request, {
  /// Whether this delivery has a durable queue item behind it (`enqueueImage`
  /// returned one). False means the bytes exist only in this call frame: no
  /// drain will ever carry them, so a transport failure really is "the
  /// picture was never sent" (「图片没有发出」). See the unreachable arm.
  required bool durable,
}) async {
  final Map<String, Object?> item = c._host.syncGate.wireItem(entry);
  final Map<String, Object?> requestJson = request.toJson();
  // 🔴 THE QUEUE ITEM MUST BE SETTLED BY THIS PATH TOO.
  //
  // On the socket leg the PC's `inject:result` reaches the queue through
  // `onInjectResultRouted`. This leg has no such frame — the HTTP response
  // body IS the verdict — so without the calls below the item would sit at
  // `queued` after a perfectly successful delivery and the next reconnect
  // would paste the picture a second time. `settle` is used rather than a
  // direct state write so the SAME rule decides: a terminal code stops, a
  // "not right now" (「现在不行」) code goes back to `queued` (owner: "no
  // matter how long it takes, everything must be delivered" 「不管时间多久，
  // 全部都要投递」). `request.requestId` is the item's own key, never re-minted.
  final String? correlation = request.requestId;
  // 🔴 RV-97 ② — the two ids a later `inject:result` can echo for THIS
  // delivery (A-58: `request_id` primary, `entry_id` fallback). Every banner
  // raised below carries them, so the one thing that can prove the banner
  // wrong — the PC saying it pasted the picture — retires it.
  final Set<String> covers = <String>{?correlation, entry.id};
  Future<void> settleQueued({required bool ok, String? code}) async {
    if (correlation == null || correlation.isEmpty) return;
    await c._host.outbox.settle(correlationId: correlation, ok: ok, code: code);
  }
  ImageUploadResult result = const ImageUploadResult(ImageUploadStatus.unreachable);
  // One immediate retry on a fresh connection: the first attempt after the
  // photo picker may race OS network wake-up; a second connection is cheap
  // and deterministic. Further retries are the user's call — the banner says
  // exactly what happened.
  for (int attempt = 0; attempt < 2; attempt++) {
    c._setProgress(const ImageSendProgress(ImageSendStage.uploading, fraction: 0));
    result = await uploadImageInject(
      endpoint: ingress.endpoint,
      token: ingress.token,
      item: item,
      request: requestJson,
      onProgress: (int sent, int total) {
        final double f = total <= 0 ? 0 : sent / total;
        c._setProgress(ImageSendProgress(
          ImageSendStage.uploading,
          fraction: f >= 1 ? 1 : f,
        ));
        if (sent >= total) {
          // Bytes are on the server; the response body is still the PC's
          // verdict — not the same fact as a socket-path "emitted, unacked".
          c._setProgress(
            const ImageSendProgress(ImageSendStage.waitingHttpVerdict),
          );
        }
      },
      // D2LAN-B3 — null in production so `uploadImageInject` builds a poster
      // bound to this pairing's pin; tests still inject their own.
      poster: c._uploadPoster,
      pin: ingress.pin,
    );
    diag('image.http_upload', <String, Object?>{
      'request_id': request.requestId,
      'attempt': attempt,
      'status': result.status.name,
      'ok': result.ok,
      'error': result.error,
      'saved_to_pc': result.savedToPc,
      // RV-04: `replayed` says the server recognised this request_id and did
      // NOT inject a second time — the one line that makes "did the retry
      // paste it again" (「retry 有没有再粘一次」) answerable from a log instead
      // of from the owner's screen.
      'replayed': result.replayed,
      'retry_after_ms': result.retryAfterMs,
      // RV-97: the raw platform/transport message. It belongs in the LOG, and
      // the banner gets a sentence a human can act on instead.
      'detail': result.detail,
    });
    if (result.status != ImageUploadStatus.unreachable) break;
  }
  switch (result.status) {
    case ImageUploadStatus.verdict:
      // The PC's real verdict — settle through the shared write-back. A
      // failed paste is the row's ✗ with the PC's own error code, not a
      // banner: same shape as the socket path.
      final InjectResult? verdict = result.verdictJson == null
          ? null
          : InjectResult.tryFromJson(result.verdictJson!);
      if (verdict != null) {
        final int t0 = DateTime.now().millisecondsSinceEpoch;
        c._delivery.applyInjectResult(verdict, c._host.store);
        await settleQueued(ok: verdict.ok, code: verdict.error);
        // F3: same counter-name as the socket path — HTTP's response body IS
        // the inject:result equivalent on this ingress.
        diag('latency.ack_to_visible_ms', <String, Object?>{
          'ms': DateTime.now().millisecondsSinceEpoch - t0,
          'path': 'http',
        });
      }
      c._failure = null;
      c._host.deliveryNotify();
      return null;
    case ImageUploadStatus.pcOffline:
      c._host.store.applyInjectResult(
        correlationId: entry.id,
        ok: false,
        failureReason: 'INJECT_PC_OFFLINE',
      );
      // "Not right now" (「现在不行」) ⇒ back to `queued`, not refused. It
      // waits for the PC.
      await settleQueued(ok: false, code: 'INJECT_PC_OFFLINE');
      return c._raise(ImageSendFailure.pcOffline, covers: covers);
    case ImageUploadStatus.noAnswer:
      c._host.store.applyInjectResult(
        correlationId: entry.id,
        ok: false,
        failureReason: 'INJECT_NO_RESULT',
      );
      return c._raise(ImageSendFailure.noAnswer, covers: covers);
    case ImageUploadStatus.serverRefused:
      // RV-05 — the row's status says ✗ with the SERVER's own code.
      //
      // 0.2.27: the three `markSynced` calls that used to sit in this switch
      // (verdict / pcOffline / noAnswer) are gone with the flag itself. RV-05's
      // asymmetry — "a refused picture must stay in pendingSync" — described a
      // server row that does not exist any more, so there is nothing to be in or
      // out of. The user-visible half is untouched and is the half that
      // mattered: the row still says ✗ with the server's own code, and the
      // resend (重发) button is still there.
      c._host.store.applyInjectResult(
        correlationId: entry.id,
        ok: false,
        failureReason: result.error ?? 'PC_BUSY',
      );
      return c._raise(
        ImageSendFailure.serverRefused,
        detail: result.error,
        retryAfterMs: result.retryAfterMs,
        covers: covers,
      );
    case ImageUploadStatus.refused:
      c._host.store.applyInjectResult(
        correlationId: entry.id,
        ok: false,
        failureReason: result.error ?? 'INJECT_FRAME_INVALID',
      );
      // The server rejected the FRAME. `INJECT_FRAME_INVALID` /
      // `INJECT_FRAME_TOO_LARGE` are terminal by isTerminalRefusalCode — the
      // same bytes cannot become valid by waiting — so this stops the item
      // rather than retrying it on every reconnect for the life of the install.
      await settleQueued(ok: false, code: result.error ?? 'INJECT_FRAME_INVALID');
      return c._raise(
        ImageSendFailure.rejected,
        detail: result.detail ?? result.error,
        covers: covers,
      );
    case ImageUploadStatus.unreachable:
      // ── 🔴 RV-97 ② — "this attempt didn't connect" IS NOT "the picture was
      // never sent" (「这一次没连上」 IS NOT 「图片没有发出」) ─────────────
      //
      // owner 2026-08-01, real device: "...there's always this red-background
      // notice in the picture, **but the picture DOES make it to the PC and
      // DOES get injected into the input box**" (「…都会有图中的这个红底的提示，
      // **但图是能传到 PC 端且注入到输入框中去的**」). Both halves were true,
      // and the second one is what makes the first a LIE: the queue item is
      // still `queued` (it was never marked inflight on this leg), so the very
      // next drain — the reconnected edge, the next spoken sentence, the
      // resend (重发) button — puts this exact picture on the socket under the
      // SAME `request_id`, the PC pastes it, and the row goes ✓ under a banner
      // still saying it never left.
      //
      // The comment that used to end this arm already KNEW this — "the next
      // drain carries it" — and the code three lines above it settled the row
      // ✗ and raised a terminal-sounding banner anyway. That is red line F2 in
      // its second direction (the mirror of "reporting something unfinished
      // as finished": reporting something finished as unfinished), and it is
      // the same root as RV-90.
      //
      // ⚠️ THE BANNER IS NOT DELETED — IT IS CONDITIONED. When [durable] is
      // false the enqueue itself was refused (blob write failed, or the
      // session has no redeemable destination after `leaveRoom`): nothing will
      // ever retry, the picture really is gone, and the fail-loud banner is
      // the only thing standing between that and a silent failure. That is the
      // positive control, and it must stay red.
      if (!durable) {
        c._host.store.applyInjectResult(
          correlationId: entry.id,
          ok: false,
          failureReason: 'PC_UNREACHABLE',
        );
        return c._raise(
          ImageSendFailure.pcUnreachable,
          detail: result.detail,
          covers: covers,
        );
      }
      // Durable ⇒ the delivery is OWED, not lost. Nothing is settled (the item
      // is already `queued`; rewriting it would only blank a more informative
      // `lastRefusalNote`) and the row is deliberately left un-settled too, so
      // it renders 📤 "queued" (排队中) off `DeliveryOutbox.queuedEntryIds`
      // instead of ✗. What the user is told is the standing, already-existing
      // sentence "N items still undelivered, delivery resumes automatically
      // once the connection recovers" (「还有 N 条未投递，连接恢复后会自动投递」)
      // (BannerIds.outboxPending) — which is the promise this app can
      // actually keep.
      //
      // ⚠️ SELF-EXPOSING LINE. If the picture is NOT delivered shortly after
      // this fires, the defect is in the drain, not here — and this line plus
      // `outbox.drain_begin` / `outbox.item_sent` are what separate the two.
      diag('image.http_unreachable_queued', <String, Object?>{
        'request_id': request.requestId,
        'entry_id': entry.id,
        // The raw platform message lives HERE and only here: it is diagnostic
        // detail, and 「Invalid argument(s): Unsupported scheme 'ws'…」 is not a
        // sentence any user can act on (RV-97, banner copy).
        'detail': result.detail,
      });
      c._host.deliveryNotify();
      return null;
  }
}
