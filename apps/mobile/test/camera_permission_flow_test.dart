// Card SCAN-PERM (2026-08-25) — the camera-permission decision layer, unit
// level, over a fake OS port. The four OS answers, the request transitions,
// the settings way out, and the re-probe on resume that the reported defect
// was missing.
//
// SPEC-REF: lib/src/permission/camera_permission.dart (the whole argument).

import 'package:flowmic/src/permission/camera_permission.dart';
import 'package:flowmic/src/permission/os_permission.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/mic_permission_fakes.dart';

CameraPermissionFlow _flow(FakeMicPermissionPort port, {bool asked = false}) =>
    CameraPermissionFlow(port: port, asked: InMemoryAskedOnceStore(asked: asked));

void main() {
  group('probe → face (no OS UI)', () {
    test('starts on PROBING, before any answer, so nothing is claimed', () {
      final CameraPermissionFlow flow = _flow(FakeMicPermissionPort(OsPermissionProbe.granted));
      addTearDown(flow.dispose);
      expect(flow.face.value, ScanPermissionFace.probing);
    });

    test('granted → READY, and the probe fires no request', () async {
      final FakeMicPermissionPort port = FakeMicPermissionPort(OsPermissionProbe.granted);
      final CameraPermissionFlow flow = _flow(port);
      addTearDown(flow.dispose);
      await flow.probe();
      expect(flow.face.value, ScanPermissionFace.ready);
      expect(port.requestCalls, 0, reason: 'a probe never shows OS UI');
    });

    test('denied + never asked → RATIONALE (explain before the first dialog)', () async {
      final CameraPermissionFlow flow = _flow(FakeMicPermissionPort(OsPermissionProbe.denied));
      addTearDown(flow.dispose);
      await flow.probe();
      expect(flow.face.value, ScanPermissionFace.rationale);
    });

    test('denied + asked before → DENIED (no second explain)', () async {
      final CameraPermissionFlow flow =
          _flow(FakeMicPermissionPort(OsPermissionProbe.denied), asked: true);
      addTearDown(flow.dispose);
      await flow.probe();
      expect(flow.face.value, ScanPermissionFace.denied);
    });

    test('permanently denied → its own face (the settings way out)', () async {
      final CameraPermissionFlow flow =
          _flow(FakeMicPermissionPort(OsPermissionProbe.permanentlyDenied));
      addTearDown(flow.dispose);
      await flow.probe();
      expect(flow.face.value, ScanPermissionFace.permanentlyDenied);
    });

    test('unavailable (cannot be asked) → READY, never a refusal face', () async {
      // 「问不出来」 is not 「拒绝了」: the scanner's own errorBuilder is the seam
      // that names a real camera failure; painting a permission refusal here
      // would be a status word with no evidence behind it.
      final CameraPermissionFlow flow =
          _flow(FakeMicPermissionPort(OsPermissionProbe.unavailable));
      addTearDown(flow.dispose);
      await flow.probe();
      expect(flow.face.value, ScanPermissionFace.ready);
    });
  });

  group('the surface actions', () {
    test('requestFromSurface: marks asked, fires the REAL request, adopts the answer',
        () async {
      final FakeMicPermissionPort port = FakeMicPermissionPort(OsPermissionProbe.denied)
        ..requestAnswer = OsPermissionProbe.granted;
      final InMemoryAskedOnceStore asked = InMemoryAskedOnceStore();
      final CameraPermissionFlow flow = CameraPermissionFlow(port: port, asked: asked);
      addTearDown(flow.dispose);
      await flow.probe();
      expect(flow.face.value, ScanPermissionFace.rationale);

      await flow.requestFromSurface();
      expect(port.requestCalls, 1);
      expect(await asked.askedBefore(), isTrue);
      expect(flow.face.value, ScanPermissionFace.ready);
    });

    test('requestFromSurface: Android answers permanentlyDenied without a dialog ⇒ '
        'the face swaps its action to 「go to Settings」', () async {
      final FakeMicPermissionPort port = FakeMicPermissionPort(OsPermissionProbe.denied)
        ..requestAnswer = OsPermissionProbe.permanentlyDenied;
      final CameraPermissionFlow flow = _flow(port, asked: true);
      addTearDown(flow.dispose);
      await flow.probe();
      expect(flow.face.value, ScanPermissionFace.denied);
      await flow.requestFromSurface();
      expect(flow.face.value, ScanPermissionFace.permanentlyDenied);
    });

    test('openSystemSettings: calls the port and leaves the face UP (unknowable here)',
        () async {
      final FakeMicPermissionPort port = FakeMicPermissionPort(OsPermissionProbe.permanentlyDenied);
      final CameraPermissionFlow flow = _flow(port);
      addTearDown(flow.dispose);
      await flow.probe();
      await flow.openSystemSettings();
      expect(port.openSettingsCalls, 1);
      expect(flow.face.value, ScanPermissionFace.permanentlyDenied,
          reason: 'whether the user granted anything over there is only known on resume');
    });
  });

  group('🔴 the reported defect: granted in Settings, came back', () {
    test('onResumed re-probes: permanentlyDenied → READY once the OS says granted', () async {
      final FakeMicPermissionPort port = FakeMicPermissionPort(OsPermissionProbe.permanentlyDenied);
      final CameraPermissionFlow flow = _flow(port);
      addTearDown(flow.dispose);
      await flow.probe();
      expect(flow.face.value, ScanPermissionFace.permanentlyDenied);

      // The user flips the toggle in system settings and returns to the app.
      port.current = OsPermissionProbe.granted;
      await flow.onResumed();
      expect(flow.face.value, ScanPermissionFace.ready);
      expect(port.statusCalls, 2, reason: 'resume is a second READ, not a request');
      expect(port.requestCalls, 0);
    });

    test('onResumed with nothing changed leaves the face alone (no flicker)', () async {
      final FakeMicPermissionPort port = FakeMicPermissionPort(OsPermissionProbe.permanentlyDenied);
      final CameraPermissionFlow flow = _flow(port);
      addTearDown(flow.dispose);
      await flow.probe();
      int notifications = 0;
      flow.face.addListener(() => notifications++);
      await flow.onResumed();
      expect(flow.face.value, ScanPermissionFace.permanentlyDenied);
      expect(notifications, 0);
    });
  });
}
