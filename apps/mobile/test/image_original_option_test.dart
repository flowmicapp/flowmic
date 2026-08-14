// 卡 B4-1 phase 2 — original image (owner 2026-08-01:「让用户决定是否发送原图」).
//
// The tick box is the kind of control this repo has shipped dead twice, so
// every claim it makes is pinned here rather than assumed:
//
//   1. ticking it REACHES THE PICKER — "a control that changes nothing is worse than no control";
//   2. not ticking it is the default, and the default is the COMPRESSED path;
//   3. an over-budget original is refused with its OWN code, never the generic
//      tooLarge (the actions differ: one says 「换一张」, the other says 「取消勾选」);
//   4. 🔴 the rescue ladder does NOT run on the original-image path. Shrinking a picture
//      the user explicitly asked for untouched — and shipping it anyway — is
//      "saying we did something we did not" wearing the other face;
//   5. the same bytes that WOULD have been rescued still are, when not ticked
//      (the positive control for 4 — otherwise "ladder did not run" could just
//      mean the ladder is broken).
//
// The four-language copy is pinned in the strings test; what is pinned here is
// that the FAILURE CODE is distinct, because that is what selects the sentence.
//
// SPEC-REF: apps/mobile/lib/src/session/platform_image_picker.dart (one call
//   site, two argument sets — and why omitting is not 「a large number」);
//   apps/mobile/lib/src/session/image_send_controller.dart;
//   apps/mobile/lib/src/ui/plus_panel.dart (_ImageTile — why default-off is
//   structural); CLAUDE.md 红线: 没有静默失败 / 反 façade.

import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/session/delivery_outbox.dart';
import 'package:flowmic/src/session/image_downscale.dart';
import 'package:flowmic/src/session/image_payload.dart';
import 'package:flowmic/src/session/image_send_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart' show ServerChannel;
import 'package:flowmic/src/session/manual_delivery.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

Uint8List _jpeg(int length) {
  final Uint8List bytes = Uint8List(length);
  bytes[0] = 0xFF;
  bytes[1] = 0xD8;
  bytes[2] = 0xFF;
  return bytes;
}

Uint8List _png(int length) {
  final Uint8List bytes = Uint8List(length);
  const List<int> magic = <int>[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  bytes.setRange(0, magic.length, magic);
  return bytes;
}

/// Past [kInjectImageB64Budget]: 4.2M bytes ⇒ 5,600,000 b64 chars > 5,200,000.
///
/// ⚠️ This was 3,200,000 (the REAL 8 MP camera original measured off a device),
/// and it is not any more — raising the budget to 5,200,000 in this same card
/// is precisely what made that photo fit, which was owner's whole point. Left
/// noted rather than silently re-typed: if a future reader sees a synthetic
/// number here and wonders why it is not the real measured one, this is why.
/// The real photo now has its own test in image_payload_test.dart, asserting it
/// PASSES.
final Uint8List kOversizeOriginal = _jpeg(4_200_000);
final Uint8List kSmall = _jpeg(120_000);
final Uint8List kRescued = _png(100_000);

class _RecordingPicker implements ImagePickerPort {
  _RecordingPicker(this.bytes);
  final Uint8List bytes;

  /// The EXACT spec the production code asked the plugin for, per call.
  /// Recording the spec rather than a boolean is what makes "the cloud uses a
  /// smaller pick spec" provable instead of merely intended.
  final List<ImagePickSpec> calls = <ImagePickSpec>[];

  @override
  Future<Uint8List?> pickImage(ImagePickSpec spec) async {
    calls.add(spec);
    return bytes;
  }
}

/// What the three tiers must literally be.
const ImagePickSpec kLanCompressed = ImagePickSpec.compressed(3456, 92);
const ImagePickSpec kCloudCompressed = ImagePickSpec.compressed(1920, 85);
const ImagePickSpec kOriginal = ImagePickSpec.original();

class _FakeHost implements ManualDeliveryHost {
  _FakeHost({required this.store, required this.syncGate});

  @override
  late final DeliveryOutbox outbox = newTestOutbox();
  @override
  bool get canCompose => true;
  @override
  bool get noPcTarget => false;
  @override
  FlowMode get mode => FlowMode.realtime;
  @override
  final TimelineStore store;
  @override
  final TimelineSyncGate syncGate;
  @override
  String? get pcDisplayName => null;
  @override
  String? get targetPcId => null;
  @override
  String? get deliveryInstanceId => 'inst-image-original';

  @override
  void deliveryNotify() {}
  @override
  Future<void> kickLink() async {}
  @override
  Future<bool> awaitLinkUp(Duration timeout) async => true;
  @override
  LanImageIngress? get lanImageIngress => null;
}

class _Harness {
  _Harness({
    required Uint8List picked,
    Uint8List? rung,
    ServerChannel? channel = ServerChannel.lan,
  }) {
    transport = FakeSocketTransport();
    picker = _RecordingPicker(picked);
    final _FakeHost host = _FakeHost(
      store: newTestStore(),
      syncGate: TimelineSyncGate(transport: transport),
    );
    final ComposeGate gate = ComposeGate(transport: transport);
    imageSend = ImageSendController(
      host: host,
      gate: gate,
      delivery: ManualDelivery(host: host, gate: gate),
      picker: picker,
      rowImages: newTestOutboxBlobs(),
      thumbnailEncoder: (Uint8List bytes) async => null,
      downscaler: (Uint8List bytes, int edge) async {
        ladderCalls.add(edge);
        return rung;
      },
      liveChannel: () => channel,
    );
  }

  late final FakeSocketTransport transport;
  late final _RecordingPicker picker;
  late final ImageSendController imageSend;
  final List<int> ladderCalls = <int>[];

  List<EventEnvelope> get injects =>
      transport.emittedWhere(FlowMicEvents.injectRequest);
}

void main() {
  group('the tick reaches the picker (反 façade)', () {
    test('original:true is what the picker is actually asked for', () async {
      final _Harness h = _Harness(picked: kSmall);
      await h.imageSend.pickAndSend(original: true);
      expect(h.picker.calls, <ImagePickSpec>[kOriginal],
          reason: 'a tick that never reaches the plugin is a dead control');
    });

    test('the DEFAULT is the compressed path — no argument, no original', () async {
      final _Harness h = _Harness(picked: kSmall);
      await h.imageSend.pickAndSend();
      expect(h.picker.calls, <ImagePickSpec>[kLanCompressed]);
    });

    test('original:false is passed through explicitly too', () async {
      final _Harness h = _Harness(picked: kSmall);
      await h.imageSend.pickAndSend(original: false);
      expect(h.picker.calls, <ImagePickSpec>[kLanCompressed]);
    });

    test('nothing remembers the tick: a true send is followed by a false one',
        () async {
      final _Harness h = _Harness(picked: kSmall);
      await h.imageSend.pickAndSend(original: true);
      await h.imageSend.pickAndSend();
      expect(h.picker.calls, <ImagePickSpec>[kOriginal, kLanCompressed],
          reason: 'the controller must hold no sticky original-image state');
    });
  });

  group('an over-budget original is refused loudly and specifically', () {
    test('its own code, NOT the generic tooLarge', () async {
      final _Harness h = _Harness(picked: kOversizeOriginal, rung: kRescued);
      final ImageSendFailure? failure =
          await h.imageSend.pickAndSend(original: true);
      expect(failure, ImageSendFailure.originalTooLarge);
      expect(failure, isNot(ImageSendFailure.tooLarge),
          reason: 'the two need different actions from the user');
      expect(h.imageSend.failure?.reason, ImageSendFailure.originalTooLarge);
    });

    test('the refusal still carries the REAL size', () async {
      final _Harness h = _Harness(picked: kOversizeOriginal, rung: kRescued);
      await h.imageSend.pickAndSend(original: true);
      expect(h.imageSend.failure?.detail, formatBytes(kOversizeOriginal.length),
          reason: 'an unexplained refusal is indistinguishable from a bug');
    });

    test('🔴 the rescue ladder never runs, and NOTHING ships', () async {
      final _Harness h = _Harness(picked: kOversizeOriginal, rung: kRescued);
      await h.imageSend.pickAndSend(original: true);
      expect(h.ladderCalls, isEmpty,
          reason: 'silently shipping a shrunken re-encode as "original" is a lie');
      expect(h.injects, isEmpty, reason: 'nothing over budget ever ships');
    });

    test('POSITIVE CONTROL — the same bytes ARE rescued when not ticked',
        () async {
      final _Harness h = _Harness(picked: kOversizeOriginal, rung: kRescued);
      final ImageSendFailure? failure = await h.imageSend.pickAndSend();
      expect(failure, isNull, reason: 'the ladder still works — the "zero" above is '
          'the guard doing its job, not the ladder being broken');
      expect(h.ladderCalls, isNotEmpty);
      expect(h.ladderCalls.first, kDownscaleLadder.first);
      expect(h.injects, hasLength(1));
    });
  });

  group('an original that FITS is sent untouched', () {
    test('the bytes on the wire are the picked bytes, byte for byte', () async {
      final _Harness h = _Harness(picked: kSmall, rung: kRescued);
      expect(await h.imageSend.pickAndSend(original: true), isNull);
      expect(h.ladderCalls, isEmpty);
      final Map<String, Object?> frame =
          h.injects.single.data! as Map<String, Object?>;
      expect(frame['image_mime'], 'image/jpeg',
          reason: 'an untouched original keeps its own format');
      expect(frame['image_b64'], encodeImagePayload(kSmall).payload!.b64);
    });
  });

  // ── owner 2026-08-01 cloud-image policy ────────────────────────────────────
  //
  // 🔴 READ THE NAMES CAREFULLY. Not one of these proves "the cloud capped it at 1M" —
  // nothing on the relay checks anything (RV-87, next round). They prove that
  // THIS PHONE no longer offers, and no longer produces, an oversized picture
  // on the cloud leg. A different client is bound by none of it.
  group('cloud leg: the phone declines to PRODUCE an oversized picture', () {
    test('the cloud tier is what the plugin is asked for', () async {
      final _Harness h = _Harness(
        picked: kSmall,
        channel: ServerChannel.cloudRelay,
      );
      await h.imageSend.pickAndSend();
      expect(h.picker.calls, <ImagePickSpec>[kCloudCompressed],
          reason: '1920/q85 — the tier this repo has measured end to end');
    });

    test('🔴 a ticked original is OVERRIDDEN on the cloud leg, not honoured',
        () async {
      final _Harness h = _Harness(
        picked: kSmall,
        channel: ServerChannel.cloudRelay,
      );
      await h.imageSend.pickAndSend(original: true);
      expect(h.picker.calls, <ImagePickSpec>[kCloudCompressed],
          reason: 'the panel decides before the picker opens; the channel can '
              'change while it is open, so the send has the last word');
      expect(h.picker.calls.single.isOriginal, isFalse);
    });

    test('🔴 FAIL-CLOSED — an UNKNOWN channel is treated as cloud', () async {
      final _Harness h = _Harness(picked: kSmall, channel: null);
      await h.imageSend.pickAndSend(original: true);
      expect(h.picker.calls, <ImagePickSpec>[kCloudCompressed],
          reason: 'guessing "LAN" would put an original on the relay — the '
              'exact thing owner ruled against');
    });

    test('over the cloud ceiling ⇒ named refusal, nothing ships', () async {
      final _Harness h = _Harness(
        picked: _jpeg(kCloudImageBytesMax + 1),
        channel: ServerChannel.cloudRelay,
      );
      final ImageSendFailure? failure = await h.imageSend.pickAndSend();
      expect(failure, ImageSendFailure.cloudImageTooLarge);
      expect(failure, isNot(ImageSendFailure.tooLarge),
          reason: 'the wire budget is nowhere near — this is a channel policy');
      expect(h.imageSend.failure?.detail,
          formatBytes(kCloudImageBytesMax + 1));
      expect(h.injects, isEmpty);
    });

    test('POSITIVE CONTROL — exactly AT the ceiling still sends', () async {
      final _Harness h = _Harness(
        picked: _jpeg(kCloudImageBytesMax),
        channel: ServerChannel.cloudRelay,
      );
      expect(await h.imageSend.pickAndSend(), isNull,
          reason: 'the refusal above is the ceiling doing its job, not the '
              'cloud leg being broken');
      expect(h.injects, hasLength(1));
    });

    test('the SAME picture goes out untouched on the LAN leg', () async {
      // The other half of 「换局域网就能发」 — otherwise the refusal sentence
      // would be advice the app cannot honour.
      final _Harness h = _Harness(
        picked: _jpeg(kCloudImageBytesMax + 1),
        channel: ServerChannel.lan,
      );
      expect(await h.imageSend.pickAndSend(), isNull);
      expect(h.injects, hasLength(1));
    });

    test('the ceiling is checked on REAL bytes, not inferred from the tier',
        () async {
      // "the spec makes it naturally stay under" is an intent. B3-2b's own noise bound at 1920/q85 was
      // ~2 MB, so a picker that hands back something big must still be caught.
      final _Harness h = _Harness(
        picked: _jpeg(2_000_000),
        channel: ServerChannel.cloudRelay,
      );
      expect(await h.imageSend.pickAndSend(),
          ImageSendFailure.cloudImageTooLarge);
    });
  });

  group('imagePickSpecFor / imageOriginalAllowed are the single answer', () {
    test('only LAN allows an original', () {
      expect(imageOriginalAllowed(ServerChannel.lan), isTrue);
      expect(imageOriginalAllowed(ServerChannel.cloudRelay), isFalse);
      expect(imageOriginalAllowed(null), isFalse, reason: 'fail-closed');
    });

    test('the three tiers are exactly these', () {
      expect(imagePickSpecFor(cloud: false, original: true), kOriginal);
      expect(imagePickSpecFor(cloud: false, original: false), kLanCompressed);
      expect(imagePickSpecFor(cloud: true, original: false), kCloudCompressed);
      expect(imagePickSpecFor(cloud: true, original: true), kCloudCompressed,
          reason: 'cloud wins over the request, always');
    });

    test('the cloud tier really is smaller than the LAN tier', () {
      expect(kCloudImagePickMaxEdge, lessThan(kImagePickMaxEdge));
      expect(kCloudImagePickQuality, lessThan(kImagePickQuality));
    });
  });

  group('the two constants are the ones owner ruled', () {
    // Pinned because they are the entire compressed path, and phase 1 measured
    // 4096 leaves only 6.5 % of budget on a >4096 photo while 3456 leaves 28 %.
    test('kImagePickMaxEdge is 3456 — above every shipping phone screenshot',
        () {
      expect(kImagePickMaxEdge, 3456);
      expect(kImagePickMaxEdge, greaterThan(3216),
          reason: 'the tallest shipping handsets are ~3216 px on the long edge; '
              'at or below that a screenshot is scaled again and the nearest-'
              'neighbour damage comes straight back');
    });

    test('kImagePickQuality is 92', () => expect(kImagePickQuality, 92));
  });
}
