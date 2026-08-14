// RV-60 — album-away expected disconnect vs real disconnect.
//
// Acceptance shape this file locks:
//   · the window is armed ONLY by the picker call (not AppLifecycleState);
//   · a drop inside the window is soft on screen and `expected_album_away` in
//     the forensic trail; a drop outside is blocking / `unexpected`;
//   · the cap is a hard upper bound — past it, soft posture ends;
//   · sessionLost does not fire while the window is open.
//
// SPEC-REF: docs/strategy/2026-07-30-task-package-v1.md RV-60;
//   CLAUDE.md red line: no silent failure (both directions).

import 'dart:async';
import 'dart:typed_data';

import 'package:flowmic/src/session/image_payload.dart' show ImagePickSpec;
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/image_send_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/album_away.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/banner_queue.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

class _GatePicker implements ImagePickerPort {
  _GatePicker(this.onPick);
  final Future<Uint8List?> Function() onPick;
  @override
  Future<Uint8List?> pickImage(ImagePickSpec spec) => onPick();
}

void main() {
  tearDown(() {
    AlbumAway.instance.resetForTest();
    DiagLog.instance.clear();
  });

  group('AlbumAway latch', () {
    test('open → isOpen; close records reason; second close is a no-op', () {
      final AlbumAway a = AlbumAway.instance;
      expect(a.isOpen, isFalse);
      a.open(cap: const Duration(hours: 1));
      expect(a.isOpen, isTrue);
      a.close(reason: 'picker_returned');
      expect(a.isOpen, isFalse);
      expect(a.lastCloseReason, 'picker_returned');
      a.close(reason: 'should_not_overwrite');
      expect(a.lastCloseReason, 'picker_returned');
    });

    test('cap expiry closes with cap_expired and ends the soft posture',
        () async {
      final AlbumAway a = AlbumAway.instance;
      a.open(cap: const Duration(milliseconds: 30));
      expect(a.isOpen, isTrue);
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(a.isOpen, isFalse);
      expect(a.lastCloseReason, 'cap_expired');
      final List<String> lines = DiagLog.instance.snapshot();
      expect(lines.any((String l) => l.contains('album_away.open')), isTrue);
      expect(
        lines.any(
          (String l) =>
              l.contains('album_away.close') && l.contains('cap_expired'),
        ),
        isTrue,
      );
    });
  });

  group('buildChatBanners — albumAway / ladder postures', () {
    final AppStrings zh = AppStrings.of(AppLocale.zh);

    test('albumAway + disconnected = DEGRADED album copy, not link-down', () {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.disconnected,
        autoStopped: false,
        albumAway: true,
        strings: zh,
      );
      expect(q.top?.severity, BannerSeverity.degraded);
      expect(q.top?.message, zh.bannerAlbumAway);
      expect(q.top?.message, isNot(zh.bannerLinkDown));
    });

    test('ladderReconnecting + disconnected = DEGRADED reconnecting, '
        'not blocking link-down', () {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.disconnected,
        autoStopped: false,
        ladderReconnecting: true,
        strings: zh,
      );
      expect(q.top?.severity, BannerSeverity.degraded);
      expect(q.top?.message, zh.bannerReconnecting);
    });

    test('disconnected with neither flag stays BLOCKING link-down', () {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.disconnected,
        autoStopped: false,
        strings: zh,
      );
      expect(q.top?.severity, BannerSeverity.blocking);
      expect(q.top?.message, zh.bannerLinkDown);
    });

    test('albumAway wins over ladderReconnecting on the visible face', () {
      final BannerQueue q = buildChatBanners(
        connection: ConnectionState.disconnected,
        autoStopped: false,
        albumAway: true,
        ladderReconnecting: true,
        strings: zh,
      );
      expect(q.top?.message, zh.bannerAlbumAway);
    });
  });

  group('ImageSendController arms the window around the picker', () {
    test('window is open DURING pick and closed after return', () async {
      final Completer<void> inside = Completer<void>();
      final Completer<Uint8List?> release = Completer<Uint8List?>();
      final _GatePicker picker = _GatePicker(() async {
        expect(AlbumAway.instance.isOpen, isTrue,
            reason: 'picker body must see the window open');
        inside.complete();
        return release.future;
      });
      final FakeSocketTransport transport = FakeSocketTransport();
      final PttSession session = newTestSession(
        transport: transport,
        audio: AudioCapture(recorder: FakeAudioRecorder()),
        stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
      );
      transport.pushStatus(SocketStatus.connected);
      final ChatController controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
        session: session,
        store: newTestStore(),
        destination: DestinationController(),
        syncGate: TimelineSyncGate(transport: transport),
        localPrefs: InMemoryLocalPrefs(),
        imagePicker: picker,
      );
      final Future<ImageSendFailure?> pending = controller.sendImage();
      await inside.future;
      expect(AlbumAway.instance.isOpen, isTrue);
      release.complete(null); // user cancel — no failure, window must close
      await pending;
      expect(AlbumAway.instance.isOpen, isFalse);
      expect(AlbumAway.instance.lastCloseReason, 'picker_returned');
      final List<String> lines = DiagLog.instance.snapshot();
      expect(lines.any((String l) => l.contains('album_away.open')), isTrue);
      expect(
        lines.any(
          (String l) =>
              l.contains('album_away.close') && l.contains('picker_returned'),
        ),
        isTrue,
      );
      await controller.dispose();
    });
  });

  group('sessionLost vs album-away', () {
    test('drop inside album window does NOT latch sessionLost', () async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final PttSession session = newTestSession(
        transport: transport,
        audio: AudioCapture(recorder: FakeAudioRecorder()),
        stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
      );
      transport.pushStatus(SocketStatus.connected);
      final ChatController controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
        session: session,
        store: newTestStore(),
        destination: DestinationController(),
        syncGate: TimelineSyncGate(transport: transport),
        localPrefs: InMemoryLocalPrefs(),
        sessionLostAfter: const Duration(milliseconds: 40),
      );
      AlbumAway.instance.open(cap: const Duration(hours: 1));
      transport.pushStatus(SocketStatus.disconnected);
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(controller.sessionLost, isFalse,
          reason: 'expected album drop must not kick the user out');
      AlbumAway.instance.close(reason: 'picker_returned');
      // Fresh window arms after close while still down.
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(controller.sessionLost, isTrue,
          reason: 'after the album window ends, a still-dead link is real');
      await controller.dispose();
    });
  });

  group('SocketCore forensic kind discriminant', () {
    test('disconnect while album away logs expected_album_away; '
        'otherwise unexpected', () async {
      // Drive a real SocketCore via a fake adapter so onDisconnect fires the
      // production forensic line.
      late void Function(dynamic) onDisc;
      final _RecordingAdapter adapter = _RecordingAdapter(
        onDisconnectHook: (void Function(dynamic) cb) => onDisc = cb,
      );
      final SocketCore core = SocketCore(
        adapterFactory: (String url, Map<String, dynamic> opts) => adapter,
      );
      // connect() awaits handshake — complete it.
      adapter.onConnectHook = (void Function() cb) {
        scheduleMicrotask(cb);
      };
      await core.connect(url: 'http://test.local');
      DiagLog.instance.clear();

      AlbumAway.instance.open(cap: const Duration(hours: 1));
      onDisc('transport close');
      final List<String> expectedLines = DiagLog.instance.snapshot();
      expect(
        expectedLines.any(
          (String l) =>
              l.contains('socket.drop') &&
              l.contains('kind=expected_album_away'),
        ),
        isTrue,
        reason: expectedLines.join('\n'),
      );

      DiagLog.instance.clear();
      AlbumAway.instance.close(reason: 'picker_returned');
      // Re-arm a connected status then drop again outside the window.
      adapter.onConnectHook = (void Function() cb) {
        scheduleMicrotask(cb);
      };
      await core.connect(url: 'http://test.local');
      DiagLog.instance.clear();
      onDisc('transport close');
      final List<String> unexpectedLines = DiagLog.instance.snapshot();
      expect(
        unexpectedLines.any(
          (String l) =>
              l.contains('socket.drop') && l.contains('kind=unexpected'),
        ),
        isTrue,
        reason: unexpectedLines.join('\n'),
      );
      await core.disconnect();
    });
  });
}

/// Minimal adapter that lets tests fire connect/disconnect callbacks.
class _RecordingAdapter implements SocketAdapter {
  _RecordingAdapter({required this.onDisconnectHook});

  final void Function(void Function(dynamic)) onDisconnectHook;
  void Function(void Function())? onConnectHook;

  @override
  void connect() {}

  @override
  void disconnect() {}

  @override
  void dispose() {}

  @override
  void emit(String event, Object? data) {}

  @override
  void emitWithAck(
    String event,
    Object? data,
    void Function(dynamic resp) ack,
  ) {}

  @override
  void onAny(void Function(String event, List<dynamic> args) cb) {}

  @override
  void onConnect(void Function() cb) => onConnectHook?.call(cb);

  @override
  void onConnectError(void Function(dynamic err) cb) {}

  @override
  void onDisconnect(void Function(dynamic reason) cb) =>
      onDisconnectHook(cb);

  @override
  void onReconnect(void Function(int attempt) cb) {}

  @override
  void onReconnectAttempt(void Function(int attempt) cb) {}
}
