// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.5 (inject:request, F-2350 image fields)
//   docs/ui-design/REDESIGN-PLAN.md §6.1 (the 「+」 panel — album picture is its
//     B3 signature action),
//     §6.2-6 (cloud-instance home-page differences: no PC focus window ⇒ no
//     injection-class operations)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §4.2 (the image pipeline in 0.1.0)
//   docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md (the light note is
//     the phone-local source of truth;
//     e2e:v1: blind store not yet built ⇒ this card only lands on the phone
//     locally, no cloud upload)
//   docs/strategy/R6-BACKLOG-AND-PLAN.md Wave 2 T-4 ①
//   CLAUDE.md red line: no silent failure / status only records the delivery
//     truth / the timeline is the source of truth
//
// TWO destinations, ONE picker/encode/thumb pipeline — deliberately NOT one
// state machine:
//
//   · paired PC  → pick image → compress → base64 → inject:request{source:'image'}
//     (ManualDelivery: request-id, D10 row-before-emit, inject:result settle).
//   · cloud light note → pick image → compress → local noted row (origin:'cloud', delivery:'none')
//     carrying thumb_b64. No inject, no 「未注入」("not injected"), no HTTP
//     upload, no cloud blob
//     (e2e:v1: chain not built; TimelineSyncGate unconditionally withholds for
//     origin:cloud).
//
// Three refusals are deliberate and are NOT failures:
//   - the user cancelling the picker returns null and says nothing at all;
//   - a second tap while a send is in flight is ignored rather than queued;
//   - [ImageSendFailure.noPcTarget] is retained for exhaustiveness / a defensive
//     call site, but the cloud path no longer raises it — local save IS the
//     product answer (owner 2026-07-31).
// Everything else is said out loud, with the real numbers.

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show ValueNotifier;

import 'compose_gate.dart';
import 'image_downscale.dart';
import 'instance_probe.dart' show ServerChannel;
import 'image_payload.dart';
import 'image_thumbnail.dart';
import 'image_upload.dart';
import 'manual_delivery.dart';
import 'outbox_blob_store.dart';
import 'outbox_item.dart';
import 'row_image_lookup.dart';
import 'platform_device_info.dart';
import '../diag/diag_log.dart';
import '../signaling/album_away.dart';
import '../signaling/inbound_payloads.dart' show InjectResult;
import '../signaling/wire_payloads.dart';
import '../timeline/timeline_entry.dart';

import 'image_send_vocabulary.dart';

// Re-exported so every existing `import '.../image_send_controller.dart'` keeps
// resolving ImageSendFailure / ImageSendOutcome / ImageOriginalBlock /
// ImagePickDenied / ImagePickerPort exactly as before the split.
export 'image_send_vocabulary.dart';

// 800-line cap (RV-97): the LAN http delivery leg moved VERBATIM to its own
// `part` file — see its header for why it is a move and what the two mechanical
// changes were.
part 'image_send_http.dart';
// REQ-12-09 09-J — the 「send a picture the phone already has」 leg. Same library,
// same reason as the part above (800-line cap), same rule: it adds no emission
// point, it ends in `_send` like every other picture delivery.
part 'image_send_stored.dart';

/// Where an in-flight image delivery currently is — the top progress bar's
/// model (owner 2026-07-30:「图片传输要增加进度条在界面的TOP上」 ("add a progress bar
/// for image transfer at the TOP of the UI")). [fraction] is
/// REAL bytes-on-the-wire over the http ingress; null = indeterminate (the
/// socket path has no byte-level truth to show, so it does not invent one).
///
/// RV-30: [waitingHttpVerdict] and [waitingSocketAck] must stay distinct —
/// one value used to answer two questions (HTTP: bytes reached the server;
/// socket: we only handed the frame to the client). Collapsing them lied as
/// 「已送达」("delivered") on the socket path.
enum ImageSendStage {
  preparing,
  uploading,

  /// LAN HTTP: upload bytes finished; awaiting the response body (the PC's
  /// verdict). The server HAS the picture.
  waitingHttpVerdict,

  /// Cloud/socket: `emitInject` returned; awaiting `inject:result`. We do NOT
  /// yet know the server received anything.
  waitingSocketAck,
}

/// True for either "waiting" stage — the bar's auto-clear / keep-alive gates.
bool imageSendStageIsWaiting(ImageSendStage? s) =>
    s == ImageSendStage.waitingHttpVerdict ||
    s == ImageSendStage.waitingSocketAck;

class ImageSendProgress {
  const ImageSendProgress(this.stage, {this.fraction});
  final ImageSendStage stage;
  final double? fraction;
}

/// The DI default for the channel seam: 「不知道」("don't know").
///
/// Anti-façade ②: a DI default must be the real thing or it must throw — never a
/// friendly empty. This one is neither friendly nor empty, it is the honest
/// answer, and it is honest in the SAFE direction: unknown ⇒ [imagePickSpecFor]
/// treats the leg as cloud ⇒ no original image and the smaller tier. A caller that forgets
/// to wire this gets owner's restriction applied too widely, which is visible
/// and complainable — never an original quietly crossing the relay.
ServerChannel? _noChannel() => null;

class ImageSendController {
  ImageSendController({
    required ManualDeliveryHost host,
    required ComposeGate gate,
    required ManualDelivery delivery,
    required ImagePickerPort picker,
    // owner 2026-07-27: the thumbnail encoder is a seam so no unit test needs a
    // real image codec — dart:ui's is unavailable in the plain test binding.
    ThumbnailEncoder? thumbnailEncoder,
    // 2026-07-29: same seam, same reason, for the over-budget rescue ladder.
    ImageDownscaler? downscaler,
    // RCA-v3: the http ingress seam (image_upload.dart). Tests pass a fake.
    ImageUploadPoster? uploadPoster,
    // owner 2026-08-01 cloud image policy: 「this delivery's live channel」.
    //
    // 🔴 A seam of its own, NOT `_host.lanImageIngress`. That one answers 「is
    // there an http ingress for pictures」 and is ALSO null when the session
    // holds no endpoint/token (link_recovery.dart `sessionLanIngress`) — so
    // `lanImageIngress == null` does not mean 「cloud」. Reading it as a channel
    // would be this repo's #1 bug shape (one value, two questions), and the
    // wrong answer would land exactly on owner's original-image rule.
    //
    // A closure rather than a captured value: the picker is a full-screen
    // activity that can sit open for minutes, so the channel has to be readable
    // AT SEND TIME, not at construction.
    ServerChannel? Function()? liveChannel,
    // REQ-12-09 09-I/09-J — the ROW's picture store (outbox_blob_store.dart's
    // header: the bytes belong to the row, the queue is one user of them).
    //
    // 🔴 REQUIRED, WITH NO DEFAULT, for the reason Book 13 §7 F1 ② gives: a
    // nullable one would make `_saveLocal` skip the write and `sendStoredImage`
    // find nothing, and BOTH failures are silent — a light-note picture that
    // simply cannot be sent, with no error anywhere and no symbol to grep. The
    // one production call site passes the SAME object `ChatController.rowImages`
    // exposes, so this is one identity being handed over, not a second store.
    required OutboxBlobStore rowImages,
  }) : _liveChannel = liveChannel ?? _noChannel,
       _host = host,
       _gate = gate,
       _delivery = delivery,
       _picker = picker,
       _rowImages = rowImages,
       _thumbnail = thumbnailEncoder ?? encodeThumbnail,
       _downscaler = downscaler ?? downscalePngForSend,
       _uploadPoster = uploadPoster;

  final ManualDeliveryHost _host;
  final ComposeGate _gate;
  final ManualDelivery _delivery;
  final ImagePickerPort _picker;
  final OutboxBlobStore _rowImages;
  final ThumbnailEncoder _thumbnail;
  final ImageDownscaler _downscaler;
  final ImageUploadPoster? _uploadPoster;
  final ServerChannel? Function() _liveChannel;

  /// The top progress bar's state; null = no image delivery in flight.
  ///
  /// ⚠️ RAW, REBUILD-TRIGGER/TESTS ONLY — the screen reads [progressOnScreen]
  /// (G-20 ⑥): this bar does NOT go through the banner table
  /// (`chat_flow_page.dart` binds it directly), so scoping the banner sources
  /// alone would leave it painting one instance's transfer on another's screen.
  final ValueNotifier<ImageSendProgress?> progress =
      ValueNotifier<ImageSendProgress?>(null);
  Timer? _progressAutoClear;

  /// 🔴 G-20 ⑥ — WHICH INSTANCE'S SCREEN the in-flight delivery belongs to.
  /// Stamped once per delivery (the null → non-null edge in [_setProgress]):
  /// stage updates belong to the SAME delivery, so re-stamping them would let a
  /// 20 s socket wait re-scope itself onto whatever screen the user switched to.
  String? _progressInstanceId;

  /// The progress **for the instance whose screen is asking** — hidden while
  /// the transfer belongs to another instance's screen, never dropped (its own
  /// auto-clear / verdict still end it). Same `null == null` judgement as
  /// [failure].
  ImageSendProgress? get progressOnScreen =>
      progress.value == null || _progressInstanceId == _host.deliveryInstanceId
      ? progress.value
      : null;

  void _setProgress(ImageSendProgress? p) {
    if (p == null) {
      _progressInstanceId = null;
    } else if (progress.value == null) {
      // G-20 ⑥: scope read at the START of the delivery (§2.5.1 fourth rule).
      _progressInstanceId = _host.deliveryInstanceId;
    }
    progress.value = p;
    _progressAutoClear?.cancel();
    _progressAutoClear = null;
    if (p != null && imageSendStageIsWaiting(p.stage)) {
      // Either wait ends outside this method (HTTP response / inject:result /
      // ManualDelivery's 20 s watchdog). The bar must not outlive them.
      _progressAutoClear = Timer(kInjectResultTimeout, () => _setProgress(null));
    }
  }

  /// Socket-path inject:result just wrote the row. Retreat the bar, note F3
  /// ack→visible latency, and retire a watchdog banner that would otherwise
  /// contradict a late ✓ (one on-screen conclusion per delivery).
  void onInjectSettled(
    InjectResult result,
    ManualDelivery delivery,
    int ackToVisibleMs,
  ) {
    if (imageSendStageIsWaiting(progress.value?.stage)) _setProgress(null);
    // F3: inject:result arrived → row status is on the store (UI rebuilds on
    // the host notify that follows). Scalars only; no payload interpolation.
    diag('latency.ack_to_visible_ms', <String, Object?>{'ms': ackToVisibleMs});
    // ── 🔴 RV-97 ② — A PICTURE THAT LANDED MUST NOT LEAVE 「没有发出」("not sent") STANDING ──
    //
    // owner 2026-08-01 real device:「无论本地局域网或中继都会有图中的这个红底的提示，**但
    // 图是能传到 PC 端且注入到输入框中去的**」("whether on the local LAN or via the
    // relay, this red-background notice in the picture always shows up, **but
    // the picture can reach the PC and get injected into the input box**").
    // Every transport outcome below
    // ([ImageUploadStatus.pcOffline] / noAnswer / serverRefused / unreachable)
    // leaves the queue item `queued`, i.e. STILL OWED — the next drain carries
    // it, the PC pastes it, and the row goes ✓ while a banner underneath it is
    // still saying the opposite. That is red line F2 in its second direction and it
    // is settled HERE, at the one place the PC's own verdict arrives, rather
    // than at four raise sites that cannot know the future.
    //
    // Only `ok` retires it: a failed verdict is not a contradiction, and a
    // verdict for some OTHER delivery must not clear this one's news — hence the
    // id match rather than a blanket clear.
    final String? settledId = result.correlationId;
    if (result.ok &&
        settledId != null &&
        _failureCoveredIds.contains(settledId)) {
      diag('image.banner_retired_by_delivery', <String, Object?>{
        'correlation': settledId,
        'reason': _failure?.reason.name,
      });
      dismissFailure();
    }
    // RV-30: watchdog raised noResult + settled ✗; a late PC ✓ must not leave
    // that banner standing next to a green row.
    if (result.ok &&
        delivery.failure == ComposeSendFailure.noResult) {
      final String? id = result.correlationId;
      if (id != null && delivery.lastFailedCoveredIds.contains(id)) {
        diag('recv.inject_result.late_ok_retires_watchdog', <String, Object?>{
          'correlation': id,
        });
        delivery.dismissFailure();
      }
    }
  }

  /// Release the auto-clear timer + notifier (ChatController.dispose).
  void dispose() {
    _progressAutoClear?.cancel();
    _progressAutoClear = null;
    progress.dispose();
  }

  bool _sending = false;

  /// True from the moment the picker opens until the frame is away. The tile
  /// goes inert for this so a second tap cannot race the first into a duplicate
  /// delivery.
  bool get isSending => _sending;

  ImageSendOutcome? _failure;

  /// 🔴 RV-97 (b) — WHICH INSTANCE'S SCREEN [_failure] IS NEWS FOR.
  ///
  /// `main.dart` builds ONE ChatController for the whole app, so this object
  /// outlives any single instance: owner's 0.2.35 screenshot showed a cloud-relay
  /// header with a banner naming a **LAN** address, i.e. a failure raised on the
  /// LAN instance still standing after switching to the relay one. Same defect
  /// class as RV-91 (「还有 N 条未投递」("still N undelivered") crossing instances), different banner —
  /// so it takes the same scope, `ManualDeliveryHost.deliveryInstanceId`.
  String? _failureInstanceId;

  /// 🔴 RV-97 ② — WHICH DELIVERY [_failure] IS ABOUT.
  ///
  /// Empty for failures with no delivery behind them (picker denied, over
  /// budget): nothing can ever contradict those. Non-empty for the transport
  /// outcomes, which CAN be contradicted — by the PC saying it pasted the
  /// picture after all. See [onInjectSettled].
  Set<String> _failureCoveredIds = const <String>{};

  /// The last image failure, held until dismissed (fail-loud) — **for the
  /// instance whose screen is asking**.
  ///
  /// A parked failure is not discarded when the user switches instances; it is
  /// simply not this screen's news. Coming back to that instance shows it again,
  /// which is exactly how RV-91's count behaves.
  ///
  /// ⚠️ `null == null` is a REAL match, not a wildcard: two cloud instances have
  /// no `connectedInstanceId` to tell apart, and the honest disposition there is
  /// to keep showing it rather than to hide a failure nobody has seen.
  ImageSendOutcome? get failure =>
      _failure == null || _failureInstanceId == _host.deliveryInstanceId
      ? _failure
      : null;

  void dismissFailure() {
    if (_failure == null) return;
    _failure = null;
    _failureCoveredIds = const <String>{};
    _failureInstanceId = null;
    _host.deliveryNotify();
  }

  /// Whether the 「+」 panel's image tile is live.
  ///
  /// Cloud / light note (`noPcTarget`): local noted save — no PC, no link required.
  /// Paired PC: still needs the compose link (there is nowhere to paste offline).
  bool get canSend =>
      !_sending && (_host.noPcTarget || _host.canCompose);

  /// Whether the original image may be OFFERED right now (owner 2026-08-01: LAN only).
  ///
  /// The panel asks this to decide between a tick box and a sentence explaining
  /// why there is none. It is the SAME expression [pickAndSend] enforces with,
  /// so the control and the rule cannot drift — but the panel's answer is
  /// advisory: the channel is re-read at send time, which is the one that binds.
  bool get canSendOriginal => imageOriginalAllowed(_liveChannel());

  /// Why the original image is not on offer, for the panel's explanation. Null ⇒ it IS on
  /// offer. Two values because the two need different sentences: 「云端不发原图」
  /// ("the cloud doesn't send the original image") tells the user to switch
  /// networks, 「还不知道走哪条」("we don't yet know which channel it's on") tells
  /// them to wait — and collapsing them would make the app assert 「你在云端」
  /// ("you're on the cloud") about a channel it could not read.
  ImageOriginalBlock? get originalBlock => switch (_liveChannel()) {
    ServerChannel.lan => null,
    ServerChannel.cloudRelay => ImageOriginalBlock.cloudChannel,
    null => ImageOriginalBlock.channelUnknown,
  };

  /// Pick a picture and either deliver it to the PC or save it as a local
  /// light-note row. Returns null on success OR on a user cancel (see the header:
  /// a cancel is not a failure), else the fail-loud reason — which is also
  /// parked on [failure] for the banner.
  /// [original] is passed per send, never remembered (owner 2026-08-01 chose
  /// 「每次发图时勾一下」("tick it each time you send a picture") over a settings
  /// switch, because a switch left on quietly
  /// eats the send budget forever). Nothing here stores it — the panel's tick
  /// box is rebuilt unticked every time the panel opens, so 「default off」 is
  /// structural rather than a value someone has to remember to reset.
  ///
  /// 🔴 [original] is a REQUEST, not a decision. The channel is re-read here and
  /// [imagePickSpecFor] overrides it on the cloud leg. The panel decides before
  /// the system picker opens — a full-screen activity that can sit there for
  /// minutes — so the channel it saw is not necessarily the channel this
  /// delivery leaves on. The last word has to be at send time.
  Future<ImageSendFailure?> pickAndSend({bool original = false}) async {
    if (_sending) return null;
    final bool localOnly = _host.noPcTarget;
    final bool cloud = !imageOriginalAllowed(_liveChannel());
    // PC path still needs the link. Local light-note does not — the row never leaves
    // the phone (and must not pretend an inject is in flight).
    if (!localOnly && !_host.canCompose) {
      return _raise(ImageSendFailure.notConnected);
    }

    _sending = true;
    // 🔴 RV-97 ③ — ONE CONCLUSION ON SCREEN AT A TIME.
    //
    // owner's 0.2.35 screenshot has the 「正在传输到电脑」("transferring to the PC")
    // progress bar and a red
    // 「图片没有发出」("the picture was not sent") banner up TOGETHER. The bar was
    // telling the truth about the
    // send in flight; the banner was a previous attempt's outcome that nothing
    // ever retired, so the screen asserted two contradictory things about the
    // same action. A new send supersedes the previous outcome: the user asked
    // again, and the answer to 「上一次怎么样了」("how did the last one go") is
    // about to be replaced.
    _failure = null;
    _failureCoveredIds = const <String>{};
    _failureInstanceId = null;
    _host.deliveryNotify();
    try {
      final ImagePickSpec spec = imagePickSpecFor(
        cloud: cloud,
        original: original,
      );
      final Uint8List? bytes = await _pick(spec);
      // User cancelled — no row, no banner, no trace. Cancelling is not failing.
      if (bytes == null) return null;
      // owner 2026-08-01 cloud 1M. Checked on the REAL bytes, not inferred from
      // the parameters: 「参数让它天然不超」("the parameters naturally keep it
      // under") is a design intent, not a measurement,
      // and this tier's own noise upper bound is ~2 MB. Placed before the row is
      // built so a refused picture leaves no half-delivery behind it.
      if (cloud && bytes.length > kCloudImageBytesMax) {
        return _raise(
          ImageSendFailure.cloudImageTooLarge,
          detail: formatBytes(bytes.length),
        );
      }
      _setProgress(const ImageSendProgress(ImageSendStage.preparing));
      // owner 2026-07-27: the preview is generated BEFORE the row is built, so
      // the row is born with it. Best-effort — `null` means this picture ships
      // without a preview, never that it fails to ship.
      final String? thumb = await _thumbnail(bytes);
      // await (not a bare return): the finally below drops the isSending guard,
      // and it must not do so while the rescue ladder is still running.
      if (localOnly) return await _saveLocal(bytes, thumb);
      // 🔴 `spec.isOriginal`, NOT the requested `original`. On the cloud leg the
      // request was overridden, and the rescue ladder must run for the bytes we
      // ACTUALLY hold. Passing the request here would disable the ladder for a
      // compressed picture nobody asked to keep untouched.
      return await _send(bytes, thumb, original: spec.isOriginal);
    } on ImagePickDenied {
      return _raise(ImageSendFailure.permissionDenied);
    } on Object catch (e) {
      // 🔴 RV-97 banner copy: the platform's raw message goes in the LOG. It is
      // still carried on the outcome (forensics / test assertions), but the
      // sentence the user reads no longer interpolates it — an exception string
      // is not something anyone can act on.
      diag('image.picker_failed', <String, Object?>{'detail': e.toString()});
      return _raise(ImageSendFailure.pickerFailed, detail: e.toString());
    } finally {
      _sending = false;
      // A failure banner replaces the bar; only the socket wait stays (its
      // inject:result / watchdog clears it). HTTP already has its verdict by
      // the time we get here — keeping waitingHttpVerdict was RV-30's stall.
      // Local save never arms a wait stage, so the bar clears here too.
      if (_failure != null ||
          progress.value?.stage != ImageSendStage.waitingSocketAck) {
        _setProgress(null);
      }
      _host.deliveryNotify();
    }
  }

  /// Cloud light note: pick → validate → local noted image row. Reuses sniff / label /
  /// thumbnail; does NOT reuse the inject state machine (no cached/injected/
  /// failed faces, no progress beyond preparing, no wire).
  Future<ImageSendFailure?> _saveLocal(
    Uint8List bytes,
    String? thumbB64,
  ) async {
    if (bytes.isEmpty) return _raise(ImageSendFailure.emptyFile);
    final ImageMime? mime = sniffImageMime(bytes);
    if (mime == null) return _raise(ImageSendFailure.unsupportedFormat);
    // Wire-budget / downscale do not apply: this row never goes on a wire.
    //
    // ── ⚠️ THE GAP BELOW IS CLOSED (REQ-12-09 09-I). Original text kept verbatim
    //    — it is what named the fix, and it names it correctly. ────────────────
    //
    //   「🔴 KNOWN GAP, NAMED RATHER THAN IMPLIED (RV-93). This path keeps ONLY
    //    the bounded thumb + label, so a light-note picture has ONE size and
    //    opening the full image
    //    shows the same 256 px preview the row does. The justification that used
    //    to sit here — 「original bytes are never kept on the phone (same rule as
    //    the PC path)」 — died with owner's 2026-08-01 amendment: the PC path now
    //    keeps its bytes, so this is no longer 「the same rule」, it is the one leg
    //    that did not get the second size. Deliberately out of scope for RV-93
    //    (owner's model is about the picture that reaches a PC) and logged for the
    //    card that closes it: the fix is one `rowImages.put(requestId, bytes,
    //    ext)` beside the row build below — the reader would find it via
    //    `pathFor(entry.clientId)` unchanged.」
    //
    // 🔴 WHAT CHANGED, AND WHAT DID NOT. owner 2026-08-12 ruled light-note
    // pictures must be SENDABLE, so the bytes have to exist — the `put` below is
    // literally the line the block above described. What it does NOT do is reach
    // backwards: **rows written before this line existed have no bytes and never
    // will.** They were not deleted, they were never written, so there is nothing
    // to recover and nothing to migrate. The panel states that on those rows
    // rather than offering a tick that could only fail
    // ([AppStrings.lightRecordImageNoOriginal]).
    final String requestId = _delivery.mintRequestId('i');
    // 🔴 BEFORE the row is built, on purpose. `pathFor(entry.clientId)` is how
    // every reader finds a row's picture, so a row that exists while its bytes do
    // not is a row that momentarily answers 「我没有原图」("I have no original
    // image") — and 09-G's tick box
    // reads exactly that answer. Writing first makes the two consistent at every
    // instant a reader could look.
    //
    // ⚠️ A FAILED WRITE IS NOT FATAL AND MUST NOT ABORT THE SAVE — the same rule
    // `enqueueImage` states on the delivery path. The user asked to keep a note;
    // losing the note because we could not ALSO keep the full-size copy would
    // turn a degraded feature into a lost one. It degrades to exactly the
    // pre-09-I behaviour (thumb + label), which the panel can already describe.
    final String? blobPath = await _rowImages.put(
      requestId: requestId,
      bytes: bytes,
      extension: imageBlobExtension(mime),
    );
    diag('image.note_bytes_kept', <String, Object?>{
      'request_id': requestId,
      'durable': blobPath != null,
      'bytes': bytes.length,
    });
    // The store write IS the whole save (it persists + notifies). No handle is
    // kept: nothing follows it any more — see the retired gate call below.
    _host.store.buildFromUtterance(
      clientId: requestId,
      mode: _host.mode,
      delivery: Delivery.none,
      text: imageEntryLabel(mime, bytes.length),
      origin: 'cloud',
      entryType: TimelineEntry.kImage,
      thumbB64: thumbB64,
    );
    // 0.2.27: `await _host.syncGate.onEntryBuilt(entry)` ran here. It was always
    // a no-op for this path (origin:'cloud' ⇒ `shouldSync` false unconditionally)
    // and was kept so the withhold went through the SAME gate as text. The gate is
    // retired with the uplink (owner's architecture ruling); a light-note image now
    // stays on the
    // phone structurally, which is what the call was there to guarantee.
    _failure = null;
    return null;
  }

  /// REQ-12-09 09-J — deliver a picture this phone ALREADY has, as its OWN
  /// message and its OWN row. Body + full argument: [imageSendStoredPicture]
  /// (this file is at the 800-line source cap).
  Future<ImageSendFailure?> sendStoredImage(TimelineEntry note) =>
      imageSendStoredPicture(this, note);

  /// RV-60: the album-away window is EXPLICITLY the picker call — open before
  /// the platform channel, close when it returns (cancel / deny / bytes). The
  /// OS will background us and may kill the idle TCP; that drop is expected
  /// for the duration of this await, and only for that duration (plus the
  /// [kAlbumAwayCap] hard upper bound on [AlbumAway]).
  Future<Uint8List?> _pick(ImagePickSpec spec) async {
    AlbumAway.instance.open();
    try {
      return await _picker.pickImage(spec);
    } finally {
      AlbumAway.instance.close(reason: 'picker_returned');
    }
  }

  Future<ImageSendFailure?> _send(
    Uint8List bytes,
    String? thumbB64, {
    required bool original,
  }) async {
    // The bytes that actually become the payload — `bytes` unless the rescue
    // ladder below shrinks them. Tracked because the QUEUE must persist exactly
    // what the wire carries: enqueueing the pre-shrink original would put a
    // different picture on disk from the one this send delivers, and a later
    // drain would then send something the user never saw go out.
    Uint8List sendBytes = bytes;
    ImageEncodeResult encoded = encodeImagePayload(bytes);
    // 🔴 `!original` — the ladder is a RESCUE, and there is nothing to rescue
    // when the user asked for the untouched file. Shrinking it here would hand
    // back a smaller re-encode under the name 「原图」("original image"); the
    // refusal below says so
    // instead, and names the one-tap fix.
    if (!original &&
        encoded.payload == null &&
        encoded.rejection == ImageRejection.tooLarge) {
      // 2026-07-29: the picker's native resize cannot be TRUSTED, only
      // measured — the owner's real phone shipped un-shrunk originals and every
      // camera photo died on the wire (zod reject at 5.5M, engine kill past
      // 8M). Over-budget bytes get one in-app rescue pass — the owner's 1080p
      // compression ruling applied unconditionally — before the loud refusal.
      final Uint8List? shrunk = await downscaleToBudget(
        bytes,
        budget: kInjectImageB64Budget,
        downscaler: _downscaler,
      );
      if (shrunk != null) {
        encoded = encodeImagePayload(shrunk);
        sendBytes = shrunk;
      }
    }
    final ImagePayload? payload = encoded.payload;
    if (payload == null) {
      return switch (encoded.rejection!) {
        ImageRejection.empty => _raise(ImageSendFailure.emptyFile),
        ImageRejection.unsupportedFormat => _raise(
          ImageSendFailure.unsupportedFormat,
        ),
        // The user is told the actual size AND the actual ceiling — an
        // unexplained refusal is indistinguishable from a bug. On the
        // original-image path
        // the reason is the tick box, not the picture, so it gets its own code
        // and its own sentence (see [ImageSendFailure.originalTooLarge]).
        ImageRejection.tooLarge => _raise(
          original
              ? ImageSendFailure.originalTooLarge
              : ImageSendFailure.tooLarge,
          detail: formatBytes(encoded.byteLength),
        ),
      };
    }

    // The timeline is the source of truth: the delivery gets its row BEFORE the emit, so the truth has
    // somewhere to land the instant it returns (D10, identical to a typed
    // send). `source_text` is the immutable descriptor, and the row carries a
    // BOUNDED thumbnail — owner 2026-07-27, because a picture row that reads
    // 「🖼 PNG · 78 KB」 on all three surfaces tells you nothing about which
    // screenshot it was.
    //
    // ⚠️ Correction (RV-93): this used to add 「the full BYTES are still never stored
    // (they are pasted on the PC and dropped)」. As of owner's 2026-08-01
    // amendment the delivered bytes ARE kept — the `enqueueImage` below writes
    // them and nothing deletes them any more — and they are what opening the
    // full image shows on
    // both ends. The row's two sizes are the thumbnail here and that file.
    final String requestId = _delivery.mintRequestId('i');
    final TimelineEntry entry = _delivery.buildDeliveryRow(
      clientId: requestId,
      text: payload.label,
      entryType: TimelineEntry.kImage,
      thumbB64: thumbB64,
    );

    // ── 🔴 write-to-disk-before-sending (design doc §3.1) — THE POINT OF THE
    //    QUEUE, ON THE ONE PATH THAT NEEDED IT MOST ────────────────────────────
    //
    // Every image send passes through the system photo picker, which backgrounds
    // the app; this handset's OS then severs the idle TCP without the socket
    // client noticing for up to 30 s (RV-60 / RCA-v3). That is a window in which
    // the process can die between the emit and the receipt — and a delivery that
    // exists only in RAM does not survive it. Writing the compressed bytes and
    // the item to disk FIRST is what makes 「断网后重连要补上」("after a disconnect,
    // reconnecting must make it up") true for pictures;
    // 「失败了才入队」("only enqueue after it fails") cannot save this case, so
    // this ordering is not an
    // optimisation and must not be relaxed into one.
    //
    // ⚠️ A NULL IS NOT FATAL AND MUST NOT ABORT THE SEND. `enqueueImage` returns
    // null when the blob write failed or the session has no redeemable
    // destination — both already said out loud in its own diag. The queue is
    // DURABILITY, not permission: refusing to deliver a picture because we could
    // not also persist it would turn a degraded retry story into a failed send
    // the user can see. So we note it and go on to attempt exactly as before.
    final OutboxItem? queued = await _host.outbox.enqueueImage(
      requestId: requestId,
      entryId: entry.id,
      // 🔴 The bytes the WIRE will carry, not the picker's original.
      bytes: sendBytes,
      imageMime: payload.mime.wire,
      extension: imageBlobExtension(payload.mime),
      label: payload.label,
      mode: entry.mode.name,
      // 🔴 Gate 3 — the row's instant (when the user picked), never `now()`. A drain
      // days later is still a FIRST delivery of this picture.
      createdAt: entry.createdAt,
      thumbB64: thumbB64,
      deviceLabel: cachedDeviceLabel(),
    );
    diag('image.enqueued', <String, Object?>{
      'request_id': requestId,
      'durable': queued != null,
      'bytes': sendBytes.length,
    });

    final InjectRequestPayload request = InjectRequestPayload(
      // The protocol requires `text`; an image carries none. Sending the
      // descriptor here would make an older PC TYPE 「🖼 PNG · 214 KB」 into the
      // user's document and call it a delivery, so it stays empty.
      text: '',
      source: InjectSource.image,
      // 🔴 L8 (owner 2026-08-02) — a manual user action. The user just picked this picture
      // out of the album and pressed send; they are watching for it to land. First
      // send only: if it does not get through, the queued retry is judged by the
      // rule in `DeliveryOutbox._attempt`, and an OLD picture pasted into whatever
      // window happens to be focused is exactly the accident the ruling names.
      injectOrigin: InjectOrigin.live,
      requestId: requestId,
      entryId: entry.id,
      imageB64: payload.b64,
      imageMime: payload.mime.wire,
      // RV-74. A picture row carries a mode like any other row — the phone's own
      // row above was built with one (`buildDeliveryRow` → `_host.mode`), and
      // `HistoryItemSchema.mode` is required even for entry_type:'image'. Omit it
      // and the PC's row builder guesses 'realtime', so a screenshot sent while
      // the user is in organize files under realtime on the PC and under organize on the phone:
      // the same picture in two different drawers. `entry.mode`, not
      // `_host.mode`, so the frame and the local row can never answer differently.
      // Legal on this source: the F-2361 「mode is manual-only」 superRefine is gone
      // (protocol-schemas-inject.ts spells out that source:'image' + mode is fine),
      // verified against the LIVE relay, not only against the local schema.
      mode: entry.mode,
      // Card M row-transit fields: the picture bytes never round-trip (they are
      // pasted on the PC and dropped), so `entry_type` + `thumb_b64` are the
      // ONLY things that make this row recognisable as a picture afterwards.
      createdAt: entry.createdAt,
      // No distinguishable original for a picture — always the explicit null.
      sourceText: null,
      entryType: entry.entryType,
      thumbB64: entry.thumbB64,
      deviceLabel: cachedDeviceLabel(),
      targetPcId: _host.targetPcId,
      // RV-68 (0.2.33): the words this picture's row shows. THE SAME STRING the
      // local row above was built with (`text: payload.label`, a few lines up) —
      // passed through, never recomputed, so the phone and the PC cannot end up
      // describing one picture two ways. A PC-side reconstruction was
      // deliberately rejected in B1 for exactly that reason.
      //
      // Legal here and only here: the schema's superRefine binds `entry_caption`
      // to `entry_type:'image'`, and this frame already carries `entryType`
      // (`entry.entryType`, set below/above from the image row). The three other
      // ComposeGate call sites are transcripts and must keep omitting it.
      entryCaption: payload.label,
    );

    // RCA-v3: on a measured-standalone channel the picture rides a FRESH http
    // request instead of the room socket. Every image send passes through the
    // system photo picker, which backgrounds the app — and this handset's OS
    // severs background TCP without the socket client noticing for up to 30 s,
    // so a socket emit right after returning lands in a dead pipe with no
    // receipt (the 「电脑没有回应」("the PC didn't respond") mystery, ten times
    // over). An http POST makes
    // a dead link an immediate visible error, retries on a new connection, and
    // brings back the PC's REAL verdict in its response.
    final LanImageIngress? ingress = _host.lanImageIngress;
    if (ingress != null) {
      // 🔴 `queued != null` is carried in, not re-derived: it answers 「这次投递
      // 有没有一份能被排空的底稿」("whether this delivery has a draft that can be
      // drained"), and it is the difference between 「这次没连上」("this attempt
      // didn't connect")
      // and 「图片没有发出」("the picture was not sent") (see
      // [imageSendViaHttp]'s unreachable arm).
      return imageSendViaHttp(
        this,
        ingress,
        entry,
        request,
        durable: queued != null,
      );
    }
    // Cloud relay: the socket path, hardened — the link must be PROVEN alive
    // (acked round-trip, with one link recovery inside) before the frame goes out.
    // 0.2.27: that proof used to be the row's own acked `history:create`; the
    // create is retired (owner's architecture ruling) and the proof is now [ManualDelivery
    // .ensureLink], which asks the same question on `heartbeat`. What is NOT lost:
    // the frame still never leaves on a link nobody has heard back from.
    _setProgress(const ImageSendProgress(ImageSendStage.uploading));
    if (!await _delivery.ensureLink()) {
      _host.store.applyInjectResult(
        correlationId: entry.id,
        ok: false,
        failureReason: 'LINK_DOWN',
      );
      return _raise(
        ImageSendFailure.linkDown,
        covers: <String>{requestId, entry.id},
      );
    }
    final bool ok = _gate.emitInject(request);
    if (!ok) {
      _host.store.applyInjectResult(
        correlationId: entry.id,
        ok: false,
        failureReason: 'WIRE_EMIT_FAILED',
      );
      return _raise(
        ImageSendFailure.wireFailed,
        covers: <String>{requestId, entry.id},
      );
    }
    // One inject:result now settles this row, through the SAME claim path the
    // ComposeBand uses — no second correlation mechanism.
    _delivery.armInFlight(requestId, <String>[entry.id]);
    _setProgress(const ImageSendProgress(ImageSendStage.waitingSocketAck));
    _failure = null;
    return null;
  }

  /// Park a fail-loud outcome.
  ///
  /// [covers] names the delivery this outcome is about (`request_id` + the row
  /// id), so [onInjectSettled] can retire the banner if that delivery later
  /// lands — the other half of the red line 「没有静默失败」("no silent failure"):
  /// **must not say a thing that succeeded never happened**. Omit it
  /// only where there is no delivery to name.
  ImageSendFailure? _raise(
    ImageSendFailure reason, {
    String? detail,
    int? retryAfterMs,
    Set<String> covers = const <String>{},
  }) {
    _failure = ImageSendOutcome(
      reason: reason,
      detail: detail,
      retryAfterMs: retryAfterMs,
    );
    _failureCoveredIds = covers;
    _failureInstanceId = _host.deliveryInstanceId;
    _host.deliveryNotify();
    return reason;
  }
}
