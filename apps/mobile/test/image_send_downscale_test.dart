// 2026-07-29 — the over-budget rescue ladder (image_downscale.dart).
//
// owner live repro: the real phone put a >5.5M-char image_b64 on the wire — the
// picker's native resize (maxWidth/imageQuality) had NOT happened, and every
// camera photo died server-side (zod reject at 5.5M chars, engine kill past
// 8 MB), each time as a silent 20 s 「电脑没有回应」. The ladder makes the owner's
// 2026-07-27 compression ruling unconditional: over-budget bytes are re-scaled
// IN APP, rung by rung, each rung MEASURED against kInjectImageB64Budget.
//
// What is pinned here:
//   - over-budget bytes are rescued: the frame that leaves carries the shrunken
//     PNG (and says PNG), never the original, and always fits the budget;
//   - the ladder walks top-down and stops at the FIRST rung that fits, stepping
//     over a rung that failed to decode;
//   - bytes already inside the budget never touch the downscaler at all.
// The when-no-rung-fits refusal stays pinned in image_send_test.dart
// (「an over-budget picture the rescue ladder cannot shrink…」).
//
// ImageSendController is built DIRECTLY (minimal fake host) rather than through
// ChatController: the downscaler seam is a controller-level concern, and
// chat_controller.dart sits at the file-size cap — threading a test-only
// parameter through it would spend production lines on plumbing.
//
// SPEC-REF: apps/mobile/lib/src/session/image_downscale.dart;
//   docs/decisions/2026-07-29-image-frame-reject-receipt.md;
//   CLAUDE.md red line: no silent failure.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/session/compose_gate.dart';
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
import 'package:flowmic/src/session/delivery_outbox.dart';
import 'support/di.dart';

/// JPEG-magic bytes of [length] — sniffs as image/jpeg without any real codec.
Uint8List jpegOfLength(int length) {
  final Uint8List bytes = Uint8List(length);
  bytes[0] = 0xFF;
  bytes[1] = 0xD8;
  bytes[2] = 0xFF;
  return bytes;
}

/// PNG-magic bytes of [length] — what a fake downscaler rung hands back.
Uint8List pngOfLength(int length) {
  final Uint8List bytes = Uint8List(length);
  const List<int> magic = <int>[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  bytes.setRange(0, magic.length, magic);
  return bytes;
}

// ⚠️ Card B4-1 raised kInjectImageB64Budget 4,000,000 → 5,200,000, and both
// fixtures below had to grow with it. They were 3,200,000 / 3,100,000 bytes —
// which now FIT, so the ladder never ran and these cases went green for the
// wrong reason (they would have been asserting on a send that never needed
// rescuing). Sized off the constant rather than re-hardcoded, so the next
// budget change cannot quietly hollow them out the same way.

/// An original past the budget: b64 of this is `budget + ~400k` chars.
final Uint8List kHugeJpeg = jpegOfLength(kInjectImageB64Budget ~/ 4 * 3 + 300_000);

/// A rung output that is STILL past the budget.
final Uint8List kStillOverPng = pngOfLength(kInjectImageB64Budget ~/ 4 * 3 + 200_000);

/// A rung output that fits comfortably (100 KB ≈ 133K chars).
final Uint8List kFitsPng = pngOfLength(100_000);

class _FakePicker implements ImagePickerPort {
  _FakePicker(this.bytes);
  final Uint8List bytes;
  @override
  Future<Uint8List?> pickImage(ImagePickSpec spec) async => bytes;
}

class _FakeHost implements ManualDeliveryHost {
  @override
  late final DeliveryOutbox outbox = newTestOutbox();

  _FakeHost({required this.store, required this.syncGate});

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
  String? get deliveryInstanceId => 'inst-image-downscale';

  @override
  void deliveryNotify() {}
  // RCA-v3 seams: this suite exercises the downscale ladder, not the link
  // recovery — the link is always "fine" and no http ingress is offered.
  @override
  Future<void> kickLink() async {}
  @override
  Future<bool> awaitLinkUp(Duration timeout) async => true;
  @override
  LanImageIngress? get lanImageIngress => null;
}

class _Harness {
  late final FakeSocketTransport transport;
  late final ImageSendController imageSend;
  final List<int> ladderCalls = <int>[];

  _Harness({required Uint8List picked, required List<Uint8List?> rungs}) {
    transport = FakeSocketTransport();
    final _FakeHost host = _FakeHost(
      store: newTestStore(),
      syncGate: TimelineSyncGate(transport: transport),
    );
    final ComposeGate gate = ComposeGate(transport: transport);
    imageSend = ImageSendController(
      host: host,
      gate: gate,
      delivery: ManualDelivery(host: host, gate: gate),
      picker: _FakePicker(picked),
      rowImages: newTestOutboxBlobs(),
      // owner 2026-08-01 cloud image policy: this suite exercises the LAN rescue
      // ladder. The seam's DI default is 「unknown」 ⇒ fail-closed to the cloud
      // tier, which would refuse these fixtures before the ladder ever ran —
      // so the channel is declared rather than inherited.
      liveChannel: () => ServerChannel.lan,
      thumbnailEncoder: (Uint8List bytes) async => null,
      downscaler: (Uint8List bytes, int edge) async {
        ladderCalls.add(edge);
        return ladderCalls.length <= rungs.length
            ? rungs[ladderCalls.length - 1]
            : null;
      },
    );
  }

  List<EventEnvelope> get injects =>
      transport.emittedWhere(FlowMicEvents.injectRequest);
}

void main() {
  test('over-budget bytes are rescued: the SECOND rung fits and is what ships', () async {
    final _Harness h = _Harness(
      picked: kHugeJpeg,
      rungs: <Uint8List?>[kStillOverPng, kFitsPng],
    );
    final ImageSendFailure? failure = await h.imageSend.pickAndSend();
    expect(failure, isNull);
    expect(h.ladderCalls, kDownscaleLadder.sublist(0, 2),
        reason: 'walks top-down, stops at the first rung that fits');
    expect(h.injects, hasLength(1));
    final Map<String, Object?> frame =
        h.injects.single.data! as Map<String, Object?>;
    expect(frame['image_mime'], 'image/png',
        reason: 'the wire mime names the bytes ACTUALLY sent (PNG re-encode)');
    expect(frame['image_b64'], base64Encode(kFitsPng),
        reason: 'the shrunken bytes ship — never the original');
    expect((frame['image_b64']! as String).length,
        lessThanOrEqualTo(kInjectImageB64Budget));
  });

  test('a rung that failed to decode (null) is stepped over, not fatal', () async {
    final _Harness h = _Harness(
      picked: kHugeJpeg,
      rungs: <Uint8List?>[null, kFitsPng],
    );
    expect(await h.imageSend.pickAndSend(), isNull);
    expect(h.ladderCalls, kDownscaleLadder.sublist(0, 2));
    expect(h.injects, hasLength(1));
  });

  test('bytes already inside the budget never touch the ladder', () async {
    final _Harness h = _Harness(
      picked: jpegOfLength(500_000),
      rungs: const <Uint8List?>[],
    );
    expect(await h.imageSend.pickAndSend(), isNull);
    expect(h.ladderCalls, isEmpty);
    final Map<String, Object?> frame =
        h.injects.single.data! as Map<String, Object?>;
    expect(frame['image_mime'], 'image/jpeg',
        reason: 'an untouched send keeps its own mime');
  });

  // ── Card B4-1 §5.4: a rung is a LONG-EDGE bound ──────────────────────────────
  //
  // `downscalePngForSend` used to pass `targetWidth: targetEdge` unconditionally,
  // which pins the SHORT edge on a portrait picture. dart:ui then produced a
  // picture BIGGER than the input on a ladder whose only job is to shrink.
  // The axis choice is pure and therefore pinnable headless; the decode itself
  // is not (dart:ui's codec is unavailable in the plain test binding), which is
  // exactly why the defect lived through 838 green tests.
  //
  // REVERSE CONTROL (run 2026-08-01): reverting downscaleTargetAxis to
  // `(targetWidth: targetEdge, targetHeight: null)` turns the portrait cases
  // below RED — 「1440×3120 at rung 1920 is 1920 WIDE」 is precisely the upscale.
  group('downscaleTargetAxis — the rung bounds the LONG edge', () {
    test('portrait: the HEIGHT is bounded, and the width is left free', () {
      final axis = downscaleTargetAxis(1440, 3120, 1920);
      expect(axis.targetHeight, 1920);
      expect(axis.targetWidth, isNull,
          reason: 'pinning width would pin the SHORT edge — the original bug');
    });

    test('portrait: rung 1920 must NOT upscale a 1440-wide screenshot', () {
      final axis = downscaleTargetAxis(1440, 3120, 1920);
      // The whole point: the old code asked dart:ui for 1920 wide, i.e. 1920×4160
      // — larger than the 1440×3120 input, at the exact moment RV-60 says memory
      // is least available.
      expect(axis.targetWidth, isNot(1920));
      expect(axis.targetHeight! <= 3120, isTrue);
    });

    test('landscape: the WIDTH is bounded', () {
      final axis = downscaleTargetAxis(3264, 2448, 1920);
      expect(axis.targetWidth, 1920);
      expect(axis.targetHeight, isNull);
    });

    test('square is treated as landscape (one branch owns the tie)', () {
      final axis = downscaleTargetAxis(2000, 2000, 1080);
      expect(axis.targetWidth, 1080);
      expect(axis.targetHeight, isNull);
    });

    test('a picture already inside the rung is left at native size', () {
      final portrait = downscaleTargetAxis(600, 800, 1920);
      expect(portrait.targetWidth, isNull);
      expect(portrait.targetHeight, isNull,
          reason: 'no upscale — the ladder only ever shrinks');
      final landscape = downscaleTargetAxis(800, 600, 1920);
      expect(landscape.targetWidth, isNull);
      expect(landscape.targetHeight, isNull);
    });

    test('every rung on the real ladder shrinks owner-class portrait bytes', () {
      for (final int rung in kDownscaleLadder) {
        final axis = downscaleTargetAxis(1440, 3120, rung);
        expect(axis.targetWidth, isNull, reason: 'rung $rung pinned the short edge');
        expect(axis.targetHeight, rung, reason: 'rung $rung did not bound the long edge');
      }
    });
  });

  test('when no rung fits, the refusal is the loud tooLarge it always was', () async {
    final _Harness h = _Harness(
      picked: kHugeJpeg,
      rungs: <Uint8List?>[
        kStillOverPng, kStillOverPng, kStillOverPng, kStillOverPng, kStillOverPng,
      ],
    );
    expect(await h.imageSend.pickAndSend(), ImageSendFailure.tooLarge);
    expect(h.ladderCalls, kDownscaleLadder, reason: 'every rung was tried');
    expect(h.injects, isEmpty, reason: 'nothing over budget ever ships');
    expect(h.imageSend.failure?.reason, ImageSendFailure.tooLarge);
  });
}
