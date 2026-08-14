// Card U2 — mic-permission flow: decisions (group 1) + the PttSession production
// wiring (group 2).
//
// The audit's finding this file pins 【measured per audit】: the permission was
// requested COLD mid-gesture, and on denial `pttDown` swallowed the exception
// behind a comment claiming fail-loud — the press was a silent no-op, the FSM's
// only trace being 「nothing happened」. Group 2's cases are written so that the
// OLD code path (gate removed, swallow restored) turns them red — see the
// REVERSE-CONTROL notes on the cases themselves.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/auth/token_storage.dart';
import 'package:flowmic/src/ptt/mic_permission.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/mic_permission_fakes.dart';

void main() {
  group('MicPermissionFlow decisions (unit, fake port)', () {
    test('granted → gate passes and self-clears a stale face', () async {
      final FakeMicPermissionPort port =
          FakeMicPermissionPort(MicPermissionProbe.granted);
      final MicPermissionFlow flow = MicPermissionFlow(
        port: port,
        asked: InMemoryMicAskedStore(),
      );
      addTearDown(flow.dispose);
      // A stale permanently-denied face (user granted in system settings while
      // the banner was up) must not outlive the fact it was about.
      flow.face.value = MicFlowFace.permanentlyDenied;

      expect(await flow.gateForPtt(), isTrue);
      expect(flow.face.value, MicFlowFace.none);
      expect(port.requestCalls, 0, reason: 'the gate never shows OS UI');
    });

    test('U2-①: never asked + denied → RATIONALE face, and the gate itself '
        'fires NO OS dialog (the cold mid-gesture request is the audit bug)',
        () async {
      final FakeMicPermissionPort port =
          FakeMicPermissionPort(MicPermissionProbe.denied);
      final MicPermissionFlow flow = MicPermissionFlow(
        port: port,
        asked: InMemoryMicAskedStore(),
      );
      addTearDown(flow.dispose);

      expect(await flow.gateForPtt(), isFalse);
      expect(flow.face.value, MicFlowFace.rationale);
      expect(port.requestCalls, 0,
          reason: 'the FIRST request is born on the rationale surface\'s own '
              'button, never inside the gate');
    });

    test('U2-②: asked before + denied → DENIED face (no second explain)',
        () async {
      final FakeMicPermissionPort port =
          FakeMicPermissionPort(MicPermissionProbe.denied);
      final MicPermissionFlow flow = MicPermissionFlow(
        port: port,
        asked: InMemoryMicAskedStore(asked: true),
      );
      addTearDown(flow.dispose);

      expect(await flow.gateForPtt(), isFalse);
      expect(flow.face.value, MicFlowFace.denied);
    });

    test('U2-③: permanently denied → its own face (the openAppSettings way out)',
        () async {
      final FakeMicPermissionPort port =
          FakeMicPermissionPort(MicPermissionProbe.permanentlyDenied);
      final MicPermissionFlow flow = MicPermissionFlow(
        port: port,
        asked: InMemoryMicAskedStore(asked: true),
      );
      addTearDown(flow.dispose);

      expect(await flow.gateForPtt(), isFalse);
      expect(flow.face.value, MicFlowFace.permanentlyDenied);

      await flow.openSystemSettings();
      expect(port.openSettingsCalls, 1);
      // Whether the user actually granted is unknowable from here — the face
      // stays up and the next gate re-probes (self-clear tested above).
      expect(flow.face.value, MicFlowFace.permanentlyDenied);
    });

    test('requestFromSurface marks asked and follows the OS answer', () async {
      final InMemoryMicAskedStore asked = InMemoryMicAskedStore();
      final FakeMicPermissionPort port =
          FakeMicPermissionPort(MicPermissionProbe.denied);
      final MicPermissionFlow flow =
          MicPermissionFlow(port: port, asked: asked);
      addTearDown(flow.dispose);

      // Granted: nothing left to say.
      port.requestAnswer = MicPermissionProbe.granted;
      await flow.requestFromSurface();
      expect(port.requestCalls, 1);
      expect(await asked.askedBefore(), isTrue);
      expect(flow.face.value, MicFlowFace.none);

      // Denied again: the named refusal, and the NEXT gate must not re-explain.
      port.requestAnswer = MicPermissionProbe.denied;
      await flow.requestFromSurface();
      expect(flow.face.value, MicFlowFace.denied);
      expect(await flow.gateForPtt(), isFalse);
      expect(flow.face.value, MicFlowFace.denied,
          reason: 'asked-before ⇒ denied wording, never rationale again');

      // Android 「don't ask again」: request resolves permanentlyDenied WITHOUT
      // a dialog — this transition is what swaps the action to 去设置开启.
      port.requestAnswer = MicPermissionProbe.permanentlyDenied;
      await flow.requestFromSurface();
      expect(flow.face.value, MicFlowFace.permanentlyDenied);
    });

    test('dismiss hides the notice; the next refused press re-raises it '
        '(hide, not drop)', () async {
      final FakeMicPermissionPort port =
          FakeMicPermissionPort(MicPermissionProbe.denied);
      final MicPermissionFlow flow = MicPermissionFlow(
        port: port,
        asked: InMemoryMicAskedStore(asked: true),
      );
      addTearDown(flow.dispose);

      await flow.gateForPtt();
      expect(flow.face.value, MicFlowFace.denied);
      flow.dismiss();
      expect(flow.face.value, MicFlowFace.none);
      await flow.gateForPtt();
      expect(flow.face.value, MicFlowFace.denied);
    });

    test('unavailable (a host with no permission_handler plugin) → gate falls '
        'through; a later capture-start refusal still surfaces', () async {
      final FakeMicPermissionPort port =
          FakeMicPermissionPort(MicPermissionProbe.unavailable);
      final MicPermissionFlow flow = MicPermissionFlow(
        port: port,
        asked: InMemoryMicAskedStore(),
      );
      addTearDown(flow.dispose);

      expect(await flow.gateForPtt(), isTrue,
          reason: 'cannot classify ≠ deny — capture itself is the next gate');
      await flow.noteCaptureStartRefused();
      expect(flow.face.value, MicFlowFace.captureStartFailed,
          reason: 'the fall-through path is still never silent');
    });
  });

  group('PttSession wiring (the production caller of the gate)', () {
    late FakeSocketTransport t;
    late FakeMicPermissionPort port;

    PttSession buildSession({
      required MicPermissionProbe probe,
      AudioRecorder? recorder,
      bool askedBefore = true,
    }) {
      t = FakeSocketTransport();
      port = FakeMicPermissionPort(probe);
      final PttSession session = PttSession(
        transport: t,
        audio: AudioCapture(recorder: recorder ?? FakeAudioRecorder()),
        stateMachine: FlowmicStateMachine(),
        tokenStorage: InMemoryTokenStorage(),
        micPermission: MicPermissionFlow(
          port: port,
          asked: InMemoryMicAskedStore(asked: askedBefore),
        ),
      );
      addTearDown(session.dispose);
      t.pushStatus(SocketStatus.connected); // FSM → CONNECTED + IDLE
      return session;
    }

    test(
      'denied ⇒ pttDown refuses LOUDLY: face rendered-state set, FSM still '
      'IDLE, zero audio:start on the wire',
      () async {
        // The recorder's own permission bit is false too, so the OLD code path
        // (no gate; audio.start() throws; `on Object { return false; }`) also
        // refuses — the ONLY difference the fix makes here is loud-vs-silent.
        //
        // 🔴 REVERSE CONTROL — actually executed 2026-08-04 (pttDown's body
        // replaced by the pre-U2 one, both files re-run, then restored;
        // residual-marker grep = 0). MEASURED red on this case:
        //   Expected: MicFlowFace:<MicFlowFace.denied>
        //     Actual: MicFlowFace:<MicFlowFace.none>
        // while `ok == false` stayed green — which IS the audit's finding: the
        // refusal existed, the evidence did not.
        final PttSession session = buildSession(
          probe: MicPermissionProbe.denied,
          recorder: FakeAudioRecorder(permission: false),
        );

        final bool ok = await session.pttDown();

        expect(ok, isFalse);
        expect(session.micPermission.face.value, MicFlowFace.denied,
            reason: 'a refused press must leave rendered evidence');
        expect(session.fsm.session, SessionState.idle,
            reason: 'denial must return the FSM to a sane state, not wedge it');
        expect(t.emittedWhere(FlowMicEvents.audioStart), isEmpty,
            reason: 'no capture ⇒ no utterance on the wire');
      },
    );

    test('permanently denied ⇒ the 去设置 face, FSM sane', () async {
      // 🔴 REVERSE CONTROL (same 2026-08-04 revert): this case goes red on the
      // FIRST line — `expect(await session.pttDown(), isFalse)` measured
      // `Expected: false / Actual: <true>`. Worth naming precisely, because it
      // is WORSE than the audit's own wording: with a healthy recorder object
      // the pre-U2 body never asked the OS at all, so a phone whose mic is
      // 「不再询问」 still walked into RECORDING and streamed nothing. The gate
      // is not only the evidence, it is the refusal.
      final PttSession session =
          buildSession(probe: MicPermissionProbe.permanentlyDenied);

      expect(await session.pttDown(), isFalse);
      expect(session.micPermission.face.value, MicFlowFace.permanentlyDenied);
      expect(session.fsm.session, SessionState.idle);
      expect(t.emittedWhere(FlowMicEvents.audioStart), isEmpty);
    });

    test('a denied press does NOT poison the next one: grant → the same '
        'session records normally', () async {
      final PttSession session = buildSession(probe: MicPermissionProbe.denied);

      expect(await session.pttDown(), isFalse);
      expect(session.fsm.session, SessionState.idle);

      // The user granted (via the banner's request or system settings).
      port.current = MicPermissionProbe.granted;

      expect(await session.pttDown(), isTrue);
      expect(session.fsm.session, SessionState.recording);
      expect(t.emittedWhere(FlowMicEvents.audioStart).length, 1);
      expect(session.micPermission.face.value, MicFlowFace.none,
          reason: 'the notice dies with the fact it was about');

      await session.pttUp();
      expect(session.fsm.session, SessionState.processing,
          reason: 'the normal PTT lifecycle is untouched by the gate');
    });

    test(
      'U2-④: permission GREEN and capture start still throws ⇒ its own honest '
      'face, never silence and never a borrowed 权限被拒',
      () async {
        // 🔴 REVERSE CONTROL (same revert): the pre-U2 body swallows this throw
        // — measured `Expected: MicFlowFace:<MicFlowFace.captureStartFailed>,
        // Actual: MicFlowFace:<MicFlowFace.none>` with `ok == false`. That is
        // the swallow behind the 「fail-loud」 comment, verbatim.
        final PttSession session = buildSession(
          probe: MicPermissionProbe.granted,
          recorder: ExplodingAudioRecorder(),
        );

        expect(await session.pttDown(), isFalse);
        expect(
          session.micPermission.face.value,
          MicFlowFace.captureStartFailed,
          reason: 'the permission is granted — pointing the user at it would '
              'be a wrong instruction',
        );
        expect(session.fsm.session, SessionState.idle);
        expect(t.emittedWhere(FlowMicEvents.audioStart), isEmpty);
      },
    );
  });
}
