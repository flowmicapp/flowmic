// 800-line cap — the ATTEMPT half of delivery_outbox.dart, moved VERBATIM into a
// `part` of the same library.
//
// 🔴 NOTHING WAS CHANGED IN THE MOVE — not one comment reflowed, not one
// identifier renamed, and unlike delivery_outbox_settle.dart / _degraded.dart
// not even the receiver: `_attempt` is still an INSTANCE member, reached through
// an extension on [DeliveryOutbox] (the shape ptt_wire_keepalive.dart /
// ptt_inbound.dart established for exactly this situation). A `part` shares the
// library, so `_persistItem` / `_host` / `_Attempt` are all still in scope, and
// [DeliveryOutbox.drain]'s `await _attempt(item, userRequested: …)` call site was
// not touched. **Any difference in the diff beyond 「moved」 is a bug.**
//
// WHY THIS IS THE RIGHT CUT and not just the biggest one. delivery_outbox.dart
// keeps 「什么时候排空、这一轮要动哪些」("when to drain, which items this round
// should touch") (drain) and 「这一条算完了没有」("is this one done or not")
// (settle, itself a part); this file answers the one question between them —
// 「这一条，这一次，能不能出去，出不去是因为什么」("this item, this attempt, can
// it go out, and if not why"). Its red line is the one drain states at the
// top of its own doc: never allow crosstalk (绝不许串号) — the address is
// VERIFIED against the item's own frozen machine, never chosen — and the
// payload check that precedes it.

part of 'delivery_outbox.dart';

extension _DeliveryOutboxAttempt on DeliveryOutbox {
  /// Address ONE item and send it, hold it with a reason, or settle it
  /// terminally. See [_Attempt] for why those are three answers and not two.
  Future<_Attempt> _attempt(
    OutboxItem item, {
    required bool userRequested,
  }) async {
    // 🔴 THE PAYLOAD IS CHECKED BEFORE THE ADDRESS, AND THE ORDER IS DELIBERATE.
    //
    // 「字节还在不在」("are the bytes still there") is a property of the ITEM;
    // 「现在连的是不是它那台机器」("is what we're connected to right now its
    // machine") is a property of the MOMENT. If the address were tested first,
    // a picture whose bytes are already gone would be reported as
    // `held(differentMachine)` — i.e. 「等一条到你那台电脑的连接就好了」("just
    // wait for a connection to your computer") — every time the user is
    // connected elsewhere. That is a promise of a retry that can never
    // succeed, which is "no silent failure" (没有静默失败) in its second,
    // harder direction (must not describe something that never happened as
    // still pending — 不许把没做成的事说成待办). A permanently dead item must
    // not be able to hide behind a transient reason.
    //
    // Read ONCE, here, and carried to the send below — never re-read after the
    // `inflight` flip. Two reads would be two answers to 「字节还在吗」("are the
    // bytes still there") with a disk between them, and the second one going
    // null would hand `send` a null for an image item, i.e. exactly the frame
    // this whole path exists to make unbuildable.
    Uint8List? bytes;
    if (item.kind == OutboxPayloadKind.image) {
      bytes = await imageBytes(item);
      if (bytes == null || bytes.isEmpty) {
        await _persistItem(
          item.copyWith(
            state: OutboxDeliveryState.refused,
            refusedCode: kOutboxImageBytesGone,
          ),
          op: 'settle_bytes_gone',
        );
        // ⚠️ SELF-EXPOSING LINE — the queue held a picture it could not deliver.
        // If this ever fires outside a real 「文件被清了」("the file got
        // cleared out"), the single deletion
        // point (`_releaseBytes`) ran too early and pictures are being dropped.
        diag('outbox.image_bytes_gone', <String, Object?>{
          'request_id': item.requestId,
          'image_path': item.imagePath,
          'attempts': item.attempts,
        });
        _noteTerminal(kOutboxImageBytesGone);
        await _refreshDerived();
        _host.onOutboxChanged();
        return const _Attempt.refused(kOutboxImageBytesGone);
      }
    }

    final LiveConnection live = _host.liveConnection;
    // 🔴 Gate 2 — the destination is the item's own frozen MACHINE. This call can
    // only ever agree or refuse; it cannot choose a destination. See
    // outbox_destination.dart for why that is a verification, not a lookup.
    final OutboxAddress resolved = resolveOutboxTarget(
      destination: OutboxDestination(
        machineUid: item.destinationMachineUid,
        pairingIdentity: item.destinationPairingIdentity,
        enqueuedPcId: item.enqueuedPcId,
      ),
      connection: live,
    );
    // 🔴 Card B4-17 / 15 册 G-14 — owner's cloud image policy also governs the
    // DRAIN: a picture ticked "original" (原图) on the LAN must not go out over the relay
    // merely because that is the link that came back. The judgement, why the
    // bytes are not silently shrunk, and why an unknown channel counts as cloud
    // are all in outbox_cloud_image_policy.dart.
    //
    // Applied AFTER addressing, and that order is load-bearing: an item that
    // cannot reach its own machine must keep saying exactly that
    // (`differentMachine`, the red line's own signal) rather than be re-labelled
    // a policy hold. Both are 「还在队列里」("still in the queue"); only one is what a crosstalk
    // investigation would need to read.
    final OutboxAddress address = resolved is OutboxAddressRefused
        ? resolved
        : (cloudImagePolicyHold(
                byteLength: bytes?.length,
                channel: live.channel,
              ) ??
              resolved);
    if (address is OutboxAddressRefused) {
      await _persistItem(
        item.copyWith(lastRefusalNote: address.reason.name),
        op: 'hold_note',
      );
      // ⚠️ SELF-EXPOSING LINE — the direct answer to 「这一条为什么还在队列里」
      // ("why is this one still in the queue").
      diag('outbox.item_held', <String, Object?>{
        'request_id': item.requestId,
        'reason': address.reason.name,
        'attempts': item.attempts,
        'queued_age_ms':
            DateTime.now().toUtc().difference(item.enqueuedAt).inMilliseconds,
        // Card B4-17 — `reason` says what was DECIDED, these two say what it was
        // decided FROM. Load-bearing for `cloudImageOverCap`: 「这条腿是云端」
        // ("this leg is cloud") and 「探针答不上来所以按云端处理」("the probe
        // could not answer so it is treated as cloud") are ONE disposition and
        // TWO facts, and
        // without `channel` they read identically in the log.
        'channel': live.channel?.name,
        'image_bytes': bytes?.length,
      });
      return _Attempt.held(address.reason);
    }
    final String targetPcId = (address as OutboxAddressResolved).targetPcId;
    // ⚠️ THE CROSSTALK AUDIT LINE. This is the queue's equivalent of the
    // desktop's `row minted … gaps=[mode→realtime(guess)]` — the line that can
    // catch a bug nobody thought to look for. It states, for this one delivery:
    // what the machine was frozen as, what we are about to stamp, and what the
    // enqueue-time alias was. If those ever disagree in a way they should not,
    // this line is where it becomes visible instead of arriving as 「我的话打到
    // 别人电脑上了」("my words landed on someone else's computer").
    diag('outbox.address_resolved', <String, Object?>{
      'request_id': item.requestId,
      'frozen_machine_uid': item.destinationMachineUid,
      'live_machine_uid': live.machineUid,
      'stamped_target_pc_id': targetPcId,
      // Audit only — proves whether this drain crossed channels. NOT the address.
      'enqueued_pc_id': item.enqueuedPcId,
      'cross_channel': item.enqueuedPcId != null &&
          item.enqueuedPcId != targetPcId,
    });
    final DateTime attemptAt = DateTime.now().toUtc();
    // 🔴 L8 — 「这一帧算不算现场」("does this frame count as live/in-the-moment"),
    // decided HERE and nowhere else (owner 2026-08-02).
    // Read off the item's own frozen speaking instant against THIS attempt's
    // instant, both on this phone's clock. One rule, one call
    // (outbox_inject_origin.dart); the host only carries it to the wire.
    final InjectOrigin origin = outboxInjectOrigin((
      createdAt: item.createdAt,
      attemptAt: attemptAt,
      userRequested: userRequested,
    ));
    final OutboxItem attempting = item.copyWith(
      state: OutboxDeliveryState.inflight,
      attempts: item.attempts + 1,
      lastAttemptAt: attemptAt,
      clearRefusalNote: true,
    );
    await _persistItem(attempting, op: 'attempt');
    // The bytes read at the top of this method — never re-read. Non-null for
    // every image item that gets this far, null for every text one, which is
    // precisely the pairing [OutboxDrainHost.send] promises its implementor.
    final bool ok = await _host.send(
      attempting,
      targetPcId,
      origin: origin,
      imageBytes: bytes,
    );
    if (!ok) {
      // The frame never left. Straight back to `queued` — never left at
      // inflight, and never invented as delivered.
      await _persistItem(
        attempting.copyWith(
          state: OutboxDeliveryState.queued,
          lastRefusalNote: 'WIRE_EMIT_FAILED',
        ),
        op: 'requeue_wire_failed',
      );
      diag('outbox.item_wire_failed', <String, Object?>{
        'request_id': item.requestId,
        'attempts': attempting.attempts,
      });
      return const _Attempt.held(OutboxAddressRefusal.noConnection);
    }
    outboxArmItemWatchdog(this, attempting);
    diag('outbox.item_sent', <String, Object?>{
      'request_id': item.requestId,
      'attempts': attempting.attempts,
      'target_pc_id': targetPcId,
      'kind': item.kind.name,
      // 「这一帧带没带图」("did this frame carry an image or not") — the G-6
      // regression (an image frame built without its bytes) is invisible in
      // every other line of this log, and it is terminal on arrival
      // (`INJECT_FRAME_INVALID`), so it gets its own boolean.
      'carried_image_bytes': bytes != null,
      // 🔴 L8 — 「这一帧是按现场发的还是按补投发的」("was this frame sent as a
      // live delivery or as a deferred re-delivery"), plus the two inputs it
      // was decided FROM. Without the inputs, 「为什么这条没在 PC 上上屏」("why
      // didn't this one show up on the PC") reads as a verdict with no
      // evidence: `user_requested` separates 「用户按了键」("the user pressed
      // the key") from 「时间够近」("the timing was close enough"), and the age
      // is the only thing that can show a 60 s window
      // deciding a borderline case. Same shape as `channel`/`image_bytes` on the
      // hold line above (what was decided vs what it was decided from).
      'inject_origin': origin.name,
      'origin_user_requested': userRequested,
      'origin_age_ms': attemptAt.difference(item.createdAt).inMilliseconds,
    });
    return const _Attempt.sent();
  }
}
