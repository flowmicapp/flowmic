// Part of chat_controller.dart — the OutboxDrainHost bodies (window-B3-2a).
//
// A `part` file for the same reason chat_utterance.dart is one: chat_controller
// is at the 800-line cap, and these need the controller's own collaborators
// (composeGate / delivery / session). Every function takes the controller
// explicitly ([c]) so a reader sees at each line that this is the controller's
// own state being used, not a copy — the convention chat_utterance.dart set.
//
// 🔴 NOTHING HERE CHOOSES A DESTINATION. The address is handed in by the queue
// (outbox_destination.dart resolved it); every other identity comes off the
// ITEM, never from 「现在是什么」("what it is right now").

part of 'chat_controller.dart';

// ── window-B3-2a: OutboxDrainHost ──────────────────────────────────────────
// The queue decides WHAT goes out and WHEN; these four give it the means.

/// 🔴 Gate 2 — the connection's identity, read FRESH on every attempt.
///
/// Never cached across a drain: the whole point of the address check is that
/// this can change under us. `machineUid` is the destination's identity;
/// `pcId` is only what that machine is called on this channel.
///
/// Card B4-17 — `channel` is the SAME seam `imageSend` is constructed with
/// (`chat_controller.dart`: `liveChannel: () => session.serverChannel.value`),
/// read the same way: freshly, per attempt. One value, one producer, so the
/// queue cannot decide 「这是云端」("this is the cloud") differently from the
/// panel the user saw.
LiveConnection outboxLiveConnection(ChatController c) => LiveConnection(
machineUid: c.session.pcMachineUid,
pairingIdentity: c.session.connectedInstanceId,
pcId: c.targetPcId,
channel: c.session.serverChannel.value,
);

/// Design doc §3.3 — the SAME acked round-trip gate the four send paths use.
/// Reused rather than re-implemented so 「链路活着」("the link is alive") has
/// one answer.

/// Design doc §3.5 / A-1 — re-seed the destination BEFORE draining.
///
/// Today the focus seed is re-established by the reconnect/rejoin round-trip
/// itself, which [ensureLink] already forces (its recovery ladder kicks the
/// link and waits for the rejoin). So this is a genuine no-op ON THIS
/// TRANSPORT rather than a placeholder — stated here because an empty method
/// body with no explanation is indistinguishable from a forgotten one, and
/// this project's headline bug class is exactly that.
Future<void> outboxReseedDestination(ChatController c) async {}

/// Put ONE queued item on the wire under the address the queue resolved.
///
/// 🔴 Every identity comes from the ITEM, never from 「现在是什么」("what it is
/// right now"): `request_id` (minted at enqueue), `created_at` (the speaking
/// instant) and `mode` (the row's own). The only value from the live world is
/// [targetPcId], which the queue resolved and handed in.
///
/// 🔴 G-6 — AN IMAGE ITEM CARRIES ITS BYTES, OR NO FRAME IS BUILT AT ALL.
///
/// This function used to build `source:'image'` frames WITHOUT `image_b64` /
/// `image_mime`. That is not a missing-field bug, it is a LOST PICTURE:
/// [InjectRequestPayload]'s constructor asserts the pairing (debug — the app
/// dies on the assert) and `InjectRequestSchema`'s superRefine rejects it
/// (release — `INJECT_FRAME_INVALID`), and that code is TERMINAL by
/// [isTerminalRefusalCode]. One drain and the item is settled `refused`,
/// never retried, picture gone. The bytes arrive as [imageBytes], PUSHED by
/// the queue (see [OutboxDrainHost.send] for why they are pushed rather than
/// fetched here): non-null for every image item, null for every text one.
Future<bool> outboxSend(
  ChatController c,
  OutboxItem item,
  String targetPcId, {
  required InjectOrigin origin,
  Uint8List? imageBytes,
}) async {
  // The frame is built by the SHARED builder (outbox_frame.dart), not here, so
  // that what this adapter puts on the wire is the same thing the queue's own
  // suite can assert on without standing up a whole ChatController.
  final InjectRequestPayload? frame = buildOutboxInjectFrame(
    item: item,
    targetPcId: targetPcId,
    // 🔴 L8 — handed in by the queue, passed through untouched. Nothing in this
    // adapter may re-decide 「现场还是补投」("live delivery or deferred
    // re-delivery"); see OutboxDrainHost.send.
    origin: origin,
    imageBytes: imageBytes,
    // RV-68 — the words this picture's row shows, READ BACK FROM THE ROW that
    // produced them, never recomputed. `image_send_controller` builds the local
    // row with `text: payload.label`, and that row is the SINGLE producer of the
    // string (a second producer is exactly what B1 rejected). Reading it here
    // keeps it single across a restart, when the draining code has no `payload`
    // left to ask.
    entryCaption: _outboxEntryCaption(c, item),
    onRefused: (OutboxFrameRefusal reason) => diag(
      'outbox.send_refused',
      <String, Object?>{
        'request_id': item.requestId,
        'reason': reason.name,
      },
    ),
  );
  // Unbuildable ⇒ nothing goes out and the item stays `queued`. See
  // buildOutboxInjectFrame for why refusing beats emitting a frame we know the
  // server will answer with a TERMINAL code.
  if (frame == null) return false;
  final bool ok = c.composeGate.emitInject(frame);
  // The row-level claim + 20 s watchdog stay exactly as they were; the queue
  // drives them rather than replacing them (two watchdogs, two questions).
  // Every row this ONE delivery settles (RV-15), not just the representative.
  if (ok) c.delivery.armInFlight(item.requestId, item.coveredEntryIds);
  return ok;
}

/// The caption an image item's own timeline row carries, or null.
///
/// Empty is normalised to null on purpose: `entry_caption` is `NonEmpty` in the
/// schema, so an empty string is not 「没有说明」("no caption") but a frame the
/// server rejects.
String? _outboxEntryCaption(ChatController c, OutboxItem item) {
  final String caption = c.store.findById(item.entryId)?.displayText ?? '';
  return caption.isEmpty ? null : caption;
}


// ── window-B3-2b: inline row resend (owner's two-stage picture model) ──────

/// The row's inline resend (重发), dispatched on the row's KIND.
///
/// 🔴 TWO ACTIONS, NOT ONE, AND THEY MUST NOT BE MERGED. A text resend is a NEW
/// delivery (`reInject`: fresh `request_id`, `created_at: now`, and — RV-72 — a
/// new row on the PC). A picture resend is the SAME delivery tried again: its
/// bytes, its `request_id` (gate 1) and its original `created_at` (gate 3) are
/// already on disk. Minting a second delivery for those would paste the picture
/// twice the moment the first one landed late, and sending the row's TEXT would
/// type 「🖼 PNG · 214 KB」 into the user's document and call it a delivery.
///
/// ⚠️ Correction (card F7, 2026-08-04) — **THE FIRST SENTENCE OF THAT PAIR IS TOO
/// WIDE, AND IT IS KEPT VERBATIM** (anti-façade ④: a comment arguing for a
/// design is itself a greppable claim). "A text resend is a NEW delivery" is
/// true only when the previous one is OVER. While the queue still owes this
/// row, minting a second one duplicates the sentence for precisely the reason
/// the picture half of the same paragraph gives. ⇒ the text branch now
/// dispatches on that fact ([outboxResendText]); the KIND distinction above is
/// untouched and still real (a picture never re-sends its row's text).
///
/// One button, one honest meaning per kind — that is what this dispatch buys.
void outboxResendEntry(ChatController c, TimelineEntry entry) =>
    entry.isImage ? outboxResendImage(c, entry) : outboxResendText(c, entry);

/// 🔴 Card F7 (residual) — 「现在就再试一次这句话」("try this sentence again right
/// now"), WITHOUT minting a second delivery for one the queue still owes.
///
/// THE DEFECT THIS CLOSES, in the words the two blocks around it already used.
/// [outboxResendEntry]'s own doc says a text resend is "a NEW delivery" and that
/// is TRUE for the case it was written about — a row whose delivery is over
/// (settled ✗, nothing owed). It was applied to every text row, and for a row
/// whose item is still `queued`/`inflight` the same sentence then exists as TWO
/// deliveries with two `request_id`s: the queue drains the old one, the PC types
/// it, `runReInject`'s frame types it again, and the desktop's INJ-3 dedup
/// cannot collapse them because two ids ARE two sends (that is the property
/// RV-72 deliberately bought). The picture path already refuses to do this and
/// says why in [outboxResendImage]: "the SAME delivery tried again … Minting a
/// second delivery for those would paste the picture twice the moment the first
/// one landed late." Nothing in that sentence is about pictures.
///
/// ⇒ SAME DISPATCH AS THE PICTURE: if the queue still owes this row, ask the
/// QUEUE (the item already holds its `request_id` — gate 1, minted at enqueue
/// and never re-minted, which is what makes a retry idempotent rather than
/// duplicative — and its `created_at`, gate 3). Only when nothing is owed does
/// this mint a new delivery through `reInject`, which is the case that path's
/// guards, its RV-72 new-PC-row semantics and its 「重发的要按重发的时间来记录」
/// ("a resend must be recorded under the time it was resent") stamp were all
/// written for.
///
/// ⚠️ THE GATE IS [DeliveryOutbox.owedEntryIds], NOT `queuedEntryIds`, and the
/// difference is the dangerous half: an `inflight` item has a frame out with its
/// answer outstanding, which is exactly when a user presses resend. `queuedEntryIds`
/// answers a different question (「该不该说排队中」 — "should this say queued")
/// and would leave that window open.
///
/// ⚠️ WHY IT STAMPS `markReinjecting` HERE TOO: identical to the picture path —
/// the row goes back to 「waiting」 and gains its 「上次重发」("last resent")
/// instant because the user's re-request is a real event and the stamp records
/// the ACT. It claims no flight: an item that is `queued` renders 📤排队中
/// ("queued") until a drain moves it.
///
/// ⚠️ HONEST RESIDUAL: when the item is `inflight` the drain below skips it (a
/// drain only picks `queued`), so the visible effect of the press is the row
/// returning to 「投递中」("delivering") — which is TRUE, a frame really is out.
/// The picture path has had exactly this property since window-B3-2b. It is not
/// silent: the press is in the diag either way.
///
/// ⚠️ SECOND RESIDUAL, NAMED BECAUSE IT IS A REAL NARROWING: if the user EDITED
/// this row while its delivery was still owed, this press now re-delivers the
/// queued item's ORIGINAL words rather than minting a delivery of the edited
/// ones. That is not a regression in truth — the queue was going to deliver
/// those words anyway, and the pre-card behaviour delivered BOTH (the stale one
/// from the drain and the edited one from `reInject`), which is the duplicate
/// this card exists to stop. Delivering the edited text is the job of
/// resend-after-edit, a DIFFERENT entry point that still goes straight to
/// `reInject` and must: its words genuinely are a new delivery. Replacing a
/// queued item's payload in place is neither, and nobody has ruled on it.
void outboxResendText(ChatController c, TimelineEntry entry) {
  if (entry.isImage) return;
  if (!c.outbox.owedEntryIds.contains(entry.id)) {
    c.reInject(entry);
    return;
  }
  c.store.markReinjecting(entry.id);
  diag('text.resend_reused_queue_item', <String, Object?>{
    'entry_id': entry.id,
    // 「为什么这一次没有铸出新的 request_id」("why no new request_id was minted
    // this time") must be answerable from the log, and this is the fact it
    // turns on.
    'still_owed': true,
  });
  // 🔴 L8 (owner 2026-08-02): a user's manual action unconditionally counts as
  // expected (用户手动操作无条件算预期). Same naming rule as the picture path —
  // only THIS row is named `live`; everything else the drain carries out is
  // still an automatic deferred re-delivery (补投).
  unawaited(c.outbox.drain(userRequestedEntryIds: <String>{entry.id}));
}

/// 🔴 「现在就再试一次这张图」("try this picture again right now") — the SAME
/// delivery, not a new one.
///
/// WHY THIS IS NOT `reInject`. `runReInject` enqueues the row's TEXT, and an
/// image row's text is its descriptor (`🖼 PNG · 214 KB`); sending that would
/// type those characters into the user's document and report a delivery of the
/// picture — the second direction of red line F2, and precisely why that path's
/// `isImage` guard stays. It also mints a fresh `request_id` and a fresh
/// `created_at`, which for a picture that is STILL QUEUED would create a second
/// delivery of the same bytes: when the first one lands late, the PC pastes the
/// picture twice.
///
/// So this asks the QUEUE instead. The item already holds everything — its
/// bytes (outbox_blob_store), its `request_id` (gate 1, minted at enqueue and
/// never re-minted, which is what makes a retry idempotent rather than
/// duplicative) and its `created_at` (gate 3, the instant the user picked it: a
/// drain is a FIRST delivery however long it waited). Nothing here re-derives
/// any of them.
///
/// THREE GUARDS, all structural rather than cosmetic — they hold even if the UI
/// forgets, the same shape `runReInject`'s guards take:
///   · not an image ⇒ this is the wrong action entirely;
///   · a cloud row ⇒ there is no PC focus target (red line, §4.0 E);
///   · 🔴 no bytes ⇒ NOTHING TO SEND. owner ①: the copy is deleted the moment
///     the delivery succeeds, so 「字节还在」("the bytes are still here") and
///     「这条还能重发」("this one can still be resent") are the same fact (R8).
///     The UI already hides the affordance on this condition
///     (`ChatMessageTile.canResendImage`); this is the guard that keeps the two
///     halves from drifting into 「按钮在，但按下去什么都不会发生」("the button is
///     there, but pressing it does nothing").
///
/// WHY IT STAMPS `markReinjecting`, INCLUDING WHEN THE LINK IS DOWN. The row
/// goes back to 「waiting」 and gains its 「上次重发」("last resent") instant,
/// because the user's re-request is a real event and that stamp records the
/// ACT, not the outcome (see the method's own doc). This does NOT claim flight:
/// if the link is down the item stays `queued` and the row renders 📤排队中
/// ("queued") — the face that exists precisely so 「还没上路」("has not left
/// yet") cannot be told as 「投递中」("delivering"). That is also why this
/// path, unlike `runReInject`, has no known-down-link early return: nothing is
/// settled ✗ here, the delivery is durable and still owed.
///
/// The drain is the whole queue, oldest first — a SUPERSET of this row, never a
/// subset. Asking for one picture and also delivering everything else that was
/// owed is more than the button promised and never less.
void outboxResendImage(ChatController c, TimelineEntry entry) {
  if (!entry.isImage) return;
  if (entry.origin == 'cloud') return;
  if (!c.outbox.resendableImageEntryIds.contains(entry.id)) {
    diag('image.resend_refused', <String, Object?>{
      'entry_id': entry.id,
      'reason': 'NO_BYTES',
    });
    return;
  }
  // Repaints on its own: `TimelineStore` is a ChangeNotifier the chat page
  // listens to, and the queue's own `onOutboxChanged` fires when the drain
  // settles. No third notify here — one press must not be three rebuilds.
  c.store.markReinjecting(entry.id);
  diag('image.resend_requested', <String, Object?>{'entry_id': entry.id});
  // 🔴 L8 (owner 2026-08-02): a user's manual action unconditionally counts as
  // expected, regardless of timing (用户手动操作无条件算预期，不看时间). The user
  // is standing here having just pressed resend on THIS row, so this picture is
  // a `live` delivery however old its `created_at` is — a picture picked last
  // week and re-sent by hand is exactly the case the clock would get wrong.
  // Only THIS row is named: the drain is the whole queue (a superset, see the
  // note above), and everything else it carries is still an automatic deferred
  // re-delivery (补投).
  unawaited(c.outbox.drain(userRequestedEntryIds: <String>{entry.id}));
}

/// inject:result routing — MOVED VERBATIM from chat_controller.dart (800-line
/// cap), with one addition: the verdict now also settles the QUEUE item.
///
/// 🔴 This is the only thing allowed to flip `inflight → delivered`: the PC's
/// own answer. Nothing local may claim a delivery (red line F2). A `false` with a
/// named code either stops the item (a terminal refusal) or returns it to
/// `queued` — see isTerminalRefusalCode.
void onInjectResultRouted(ChatController c, InjectResult r) {
  final int t0 = DateTime.now().millisecondsSinceEpoch;
  c.delivery.applyInjectResult(r, c.store);
  c.imageSend.onInjectSettled(
    r,
    c.delivery,
    DateTime.now().millisecondsSinceEpoch - t0,
  );
  final String? correlation = r.correlationId;
  if (correlation == null || correlation.isEmpty) return;
  // Fire-and-forget: the queue write must not block the UI's settle path, and
  // an item that fails to persist here is picked up by the boot revive.
  unawaited(c.outbox.settle(correlationId: correlation, ok: r.ok, code: r.error));
}

/// Connection/session edges — MOVED VERBATIM from chat_controller.dart (800-line
/// cap), with one addition marked below.
///
/// 🔴 F-1 (2026-08-03, real device) — **the drain is no longer here.**
///
/// window-B3-2a hung 「断网后重连要补上」("a reconnect after a drop must catch
/// up") on this `connected` rising edge, but that edge only proves the
/// **socket connected** — it does not prove the server has already put this
/// connection into the room. Measured on device, the two are roughly 170ms
/// apart:
///
///   04:57:23.187 socket connected
///   04:57:23.190 emit.inject     handed_to_socket=true      ← the drain this edge triggered
///   04:57:23.352 recv.inject_result ok=false INJECT_NOT_IN_ROOM
///   04:57:23.356 outbox.settled  state=requeued             ← and nobody ever drains it a second time
///
/// The server's refusal is **legitimate** (at that instant we genuinely were
/// not in any room yet), so this is not a server-side defect; nor is it "not
/// enough retries" — after `requeued` nothing will ever drain it again until
/// the user manually sends another message. So the banner's promise
/// 「连接恢复后会自动投递」("it will auto-deliver once the connection is
/// restored") became a promise nobody honours.
///
/// ⇒ The trigger edge is changed to [PttSession.roomJoins] (the ack of
/// `mobile:reconnect`), subscribed in `chat_controller.dart`'s constructor.
/// **A "double insurance" drain is deliberately NOT kept here**: two trigger
/// edges would give 「为什么这条投出去了」("why did this one go out") two
/// answers, and one of them would be wrong.
void onFsmChangeRouted(ChatController c, FlowmicStateSnapshot s) {
  final ConnectionState prev = c._conn;
  c._conn = s.connection;
  c._sess = s.session;
  if (c._sess != SessionState.recording) c.recording.stop();
  if (s.connection == ConnectionState.connected &&
      prev != ConnectionState.connected) {
    c.destination.reset();
  }
  _watchSessionLoss(c, s.connection);
  if (s.connection != ConnectionState.connected) {
    c.destination.clearFocus();
    c.aiCompose.abort(AiComposeFailure.notConnected);
    // 🔴 Card F3 defect ② — THE UTTERANCE RUN HAS TO GO TOO, and it was the only
    // one of the two that was missing.
    //
    // WHY IT IS NOT "the same thing twice": these are two different runs with
    // opposite terminals (utterance_compose.dart's own header says so). The
    // buffer run above restores the user's text; THIS one owns a timeline row
    // that is showing 「翻译中…」("translating…") and a microphone that
    // `ChatController.canPtt` holds shut for exactly as long as `isRunning` is
    // true.
    //
    // WHAT THE ABSENCE COST, in facts rather than adjectives: the reply to a
    // compose:start can only come back over the socket that carried it (that is
    // this class's own premise for aborting the other one), so once the link is
    // gone the run is already over — but nothing said so. The row sat at
    // 「加工中」("processing") and the PTT button stayed disabled for the FULL
    // 45 s watchdog window
    // (`UtteranceComposeController.kWatchdog`), i.e. the user could not speak on
    // a link that had already come back. Then the watchdog reported `timeout`,
    // which names the wrong wall: the run did not time out, the link dropped.
    c.utteranceCompose.abort(AiComposeFailure.notConnected);
  }
  c.notifyUi();
}
