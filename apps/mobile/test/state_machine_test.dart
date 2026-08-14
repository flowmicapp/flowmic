// FSM contract test (WP-R3-1 acceptance): the PTT state-transition table, the
// swipe-up cancel = no-entry rule, the JUST_DONE window, the sub-second drop
// grace, and the auth:expired session drain.
//
// SPEC-REF: docs/rebuild/08-MOBILE-SPEC.md §2.

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late FlowmicStateMachine fsm;
  final illegal = <IllegalTransition>[];

  setUp(() {
    fsm = FlowmicStateMachine();
    illegal.clear();
    fsm.illegalTransitions.listen(illegal.add);
  });

  tearDown(() => fsm.dispose());

  void connect() => fsm.onSocketStatus(SocketStatus.connected);

  group('connection level', () {
    test('socket status maps to connection state', () {
      expect(fsm.connection, ConnectionState.disconnected);
      fsm.onSocketStatus(SocketStatus.connecting);
      expect(fsm.connection, ConnectionState.connecting);
      connect();
      expect(fsm.connection, ConnectionState.connected);
      expect(fsm.session, SessionState.idle); // becomes idle on connect
    });
  });

  group('PTT happy-path transition table', () {
    test('IDLE → RECORDING → PROCESSING → JUST_DONE → IDLE', () {
      fakeAsync((async) {
        connect();
        expect(fsm.session, SessionState.idle);
        fsm.onPttDown();
        expect(fsm.session, SessionState.recording);
        fsm.onPttUp();
        expect(fsm.session, SessionState.processing);
        fsm.onSttFinal();
        expect(fsm.session, SessionState.justDone);
        async.elapse(const Duration(milliseconds: 1500));
        expect(fsm.session, SessionState.idle);
      });
    });
  });

  group('illegal transitions are refused (not thrown)', () {
    test('pttDown before connect is refused', () {
      fsm.onPttDown();
      expect(fsm.session, SessionState.disconnected);
      expect(illegal.single.trigger, 'pttDown');
    });

    test('pttDown while RECORDING is refused (no RECORDING+PROCESSING coexist)', () {
      connect();
      fsm.onPttDown();
      illegal.clear();
      fsm.onPttDown(); // duplicate long-press
      expect(fsm.session, SessionState.recording);
      expect(illegal.single.reason, contains('coexistence forbidden'));
    });

    test('pttUp outside RECORDING is refused', () {
      connect();
      fsm.onPttUp();
      expect(illegal.single.trigger, 'pttUp');
    });

    test('sttFinal outside PROCESSING is refused', () {
      connect();
      fsm.onSttFinal();
      expect(illegal.single.trigger, 'sttFinal');
    });
  });

  group('swipe-up cancel (§4.0 A: cancel = no entry)', () {
    test('cancel from RECORDING returns straight to IDLE, never PROCESSING', () {
      connect();
      fsm.onPttDown();
      expect(fsm.session, SessionState.recording);
      final states = <SessionState>[];
      fsm.changes.listen((s) => states.add(s.session));
      fsm.onPttCancel();
      expect(fsm.session, SessionState.idle);
      // The utterance never reached PROCESSING, so no stt:final / entry cycle.
      expect(states, isNot(contains(SessionState.processing)));
    });

    test('cancel outside RECORDING is a no-op refusal', () {
      connect();
      fsm.onPttCancel();
      expect(illegal.single.trigger, 'pttCancel');
    });
  });

  group('drop grace (sub-second blip preserves the session)', () {
    test('blip shorter than grace restores the held session', () {
      fakeAsync((async) {
        connect();
        fsm.onPttDown();
        expect(fsm.session, SessionState.recording);
        fsm.onSocketStatus(SocketStatus.disconnected); // wire blip
        expect(fsm.session, SessionState.recording); // held, not torn down
        async.elapse(const Duration(seconds: 1));
        fsm.onSocketStatus(SocketStatus.connected); // recovered in time
        expect(fsm.session, SessionState.recording); // survived
      });
    });

    test('drop longer than grace tears the session down', () {
      fakeAsync((async) {
        connect();
        fsm.onPttDown();
        fsm.onSocketStatus(SocketStatus.disconnected);
        async.elapse(const Duration(seconds: 4)); // past the 3 s grace
        expect(fsm.session, SessionState.disconnected);
      });
    });
  });

  // ── GA-03: the PROCESSING safety net ──────────────────────────────────────
  // PROCESSING is closed ONLY by a remote stt:final. Without a local watchdog a
  // dead server / dead engine / lost final wedges the phone (canPtt requires
  // IDLE) until an app restart — the same deadlock shape R6 T-5 removed.
  group('PROCESSING watchdog (08 §2 safety net 15s)', () {
    test('no terminal final within 15 s → back to IDLE with a timeout signal', () {
      fakeAsync((async) {
        final stalls = <SttStall>[];
        fsm.sttStalled.listen(stalls.add);
        connect();
        fsm.onPttDown();
        fsm.onPttUp();
        expect(fsm.session, SessionState.processing);
        async.elapse(const Duration(seconds: 14));
        expect(fsm.session, SessionState.processing, reason: 'not yet');
        expect(stalls, isEmpty);
        async.elapse(const Duration(seconds: 2));
        expect(fsm.session, SessionState.idle, reason: 'PTT usable again');
        expect(stalls, <SttStall>[const SttStall(SttStallReason.timeout)]);
      });
    });

    test('a terminal final inside the window disarms the net for good', () {
      fakeAsync((async) {
        final stalls = <SttStall>[];
        fsm.sttStalled.listen(stalls.add);
        connect();
        fsm.onPttDown();
        fsm.onPttUp();
        async.elapse(const Duration(seconds: 2));
        fsm.onSttFinal();
        expect(fsm.session, SessionState.justDone);
        async.elapse(const Duration(seconds: 60));
        // JUST_DONE elapsed normally and the disarmed net never fired.
        expect(fsm.session, SessionState.idle);
        expect(stalls, isEmpty);
      });
    });

    test('a terminal stt:error closes PROCESSING at once (no 15 s wait)', () {
      fakeAsync((async) {
        final stalls = <SttStall>[];
        fsm.sttStalled.listen(stalls.add);
        connect();
        fsm.onPttDown();
        fsm.onPttUp();
        async.elapse(const Duration(seconds: 1));
        fsm.onSttTerminalError();
        expect(fsm.session, SessionState.idle);
        expect(stalls, <SttStall>[const SttStall(SttStallReason.engineError)]);
        // The net was disarmed by the same exit — it must not fire again later.
        async.elapse(const Duration(seconds: 30));
        expect(stalls.length, 1);
      });
    });

    // ── ENG-3 (fix-030): a RECORDING-time TERMINAL error latches ────────────
    // The previous test on this spot asserted the OPPOSITE — 「a terminal error
    // is refused (engine reconnect keeps capture running)」 — and thereby locked
    // the P0 defect in as spec (the 0.2.52 lesson, verbatim): the measured
    // cold-open failure (`STT_CONFIG_MISSING` on `audio:start`) arrives while
    // the FSM is still RECORDING, and the refusal swallowed the only honest
    // frame of the run. 「engine reconnecting」 is the retryable:true story, and
    // retryable:true never reaches onSttTerminalError (ptt_inbound filters it —
    // pinned by its own test in ptt_session_test.dart).
    test('ENG-3: a terminal error while RECORDING latches — capture continues, '
        'and PTT-up stalls PROCESSING at once with the named code', () {
      fakeAsync((async) {
        final stalls = <SttStall>[];
        fsm.sttStalled.listen(stalls.add);
        connect();
        fsm.onPttDown();
        illegal.clear();
        fsm.onSttTerminalError(
          code: 'STT_CONFIG_MISSING',
          message: "sherpa-local open failed: Cannot find module 'sherpa-onnx-node'",
        );
        // Mid-press nothing changes: the press is the user's, not the engine's.
        expect(fsm.session, SessionState.recording);
        expect(illegal, isEmpty, reason: 'latched, not refused');
        expect(stalls, isEmpty, reason: 'not surfaced before the press ends');
        async.elapse(const Duration(seconds: 5)); // the user keeps talking
        expect(fsm.session, SessionState.recording);
        fsm.onPttUp();
        // The server already said no final is coming: PROCESSING closes NOW —
        // not after the 15 s net — and the stall carries the wire code.
        expect(fsm.session, SessionState.idle);
        expect(stalls, hasLength(1));
        expect(stalls.single.reason, SttStallReason.engineError);
        expect(stalls.single.code, 'STT_CONFIG_MISSING');
        expect(stalls.single.message, contains('sherpa-onnx-node'));
        // The net never armed for this press — nothing fires later.
        async.elapse(const Duration(seconds: 60));
        expect(stalls, hasLength(1));
      });
    });

    test('ENG-3: a swipe-up cancel clears the latched terminal error '
        '(cancel = no row, no banner) and the next utterance is clean', () {
      fakeAsync((async) {
        final stalls = <SttStall>[];
        fsm.sttStalled.listen(stalls.add);
        connect();
        fsm.onPttDown();
        fsm.onSttTerminalError(code: 'STT_CONFIG_MISSING', message: 'x');
        fsm.onPttCancel();
        expect(fsm.session, SessionState.idle);
        expect(stalls, isEmpty);
        // A fresh press must not inherit the dead utterance's refusal.
        fsm.onPttDown();
        fsm.onPttUp();
        expect(fsm.session, SessionState.processing,
            reason: 'no stale latch: the new utterance waits for its own final');
        fsm.onSttFinal();
        expect(stalls, isEmpty);
      });
    });

    test('ENG-3: the PROCESSING-time stall carries the wire code+message too', () {
      fakeAsync((async) {
        final stalls = <SttStall>[];
        fsm.sttStalled.listen(stalls.add);
        connect();
        fsm.onPttDown();
        fsm.onPttUp();
        fsm.onSttTerminalError(code: 'STT_ENGINE_AUTH_FAIL', message: 'key refused');
        expect(fsm.session, SessionState.idle);
        expect(stalls.single.code, 'STT_ENGINE_AUTH_FAIL');
        expect(stalls.single.message, 'key refused');
      });
    });

    test('a held PROCESSING re-arms the net on restore and still self-heals', () {
      fakeAsync((async) {
        final stalls = <SttStall>[];
        fsm.sttStalled.listen(stalls.add);
        connect();
        fsm.onPttDown();
        fsm.onPttUp();
        async.elapse(const Duration(seconds: 10)); // net is 10 s in
        fsm.onSocketStatus(SocketStatus.disconnected); // blip, session held
        expect(fsm.session, SessionState.processing);
        async.elapse(const Duration(seconds: 2)); // inside the 3 s drop grace
        // The net was STOPPED for the hold: it must not fire while held even
        // though its original 15 s deadline has now passed.
        expect(stalls, isEmpty);
        fsm.onSocketStatus(SocketStatus.connected);
        expect(fsm.session, SessionState.processing);
        async.elapse(const Duration(seconds: 14));
        expect(fsm.session, SessionState.processing, reason: 're-armed at 15 s');
        expect(stalls, isEmpty);
        async.elapse(const Duration(seconds: 2));
        expect(fsm.session, SessionState.idle);
        expect(stalls, <SttStall>[const SttStall(SttStallReason.timeout)]);
      });
    });

    // GA-27: the same wedge one state further along. The hold cancels the
    // JUST_DONE timer, and before this fix the restore did not bring it back —
    // the session sat in JUST_DONE forever and canPtt (requires IDLE) stayed
    // false, i.e. the phone was just as dead as the PROCESSING case.
    test('a held JUST_DONE restarts its window on restore (never wedges)', () {
      fakeAsync((async) {
        connect();
        fsm.onPttDown();
        fsm.onPttUp();
        fsm.onSttFinal();
        expect(fsm.session, SessionState.justDone);
        async.elapse(const Duration(milliseconds: 500));
        fsm.onSocketStatus(SocketStatus.disconnected); // blip mid-window
        expect(fsm.session, SessionState.justDone, reason: 'held, not torn down');
        async.elapse(const Duration(seconds: 2)); // inside the 3 s drop grace
        fsm.onSocketStatus(SocketStatus.connected);
        expect(fsm.session, SessionState.justDone, reason: 'restored');
        async.elapse(const Duration(milliseconds: 1600));
        expect(fsm.session, SessionState.idle, reason: 'window ran to IDLE');
      });
    });

    test('a drop past the grace tears PROCESSING down and kills the net', () {
      fakeAsync((async) {
        final stalls = <SttStall>[];
        fsm.sttStalled.listen(stalls.add);
        connect();
        fsm.onPttDown();
        fsm.onPttUp();
        fsm.onSocketStatus(SocketStatus.disconnected);
        async.elapse(const Duration(seconds: 60));
        expect(fsm.session, SessionState.disconnected);
        expect(stalls, isEmpty, reason: 'the link banner already says it');
      });
    });

    test('auth:expired cancels a pending PROCESSING net', () {
      fakeAsync((async) {
        final stalls = <SttStall>[];
        fsm.sttStalled.listen(stalls.add);
        connect();
        fsm.onPttDown();
        fsm.onPttUp();
        fsm.onAuthExpired();
        expect(fsm.session, SessionState.disconnected);
        async.elapse(const Duration(seconds: 60));
        expect(fsm.session, SessionState.disconnected);
        expect(stalls, isEmpty);
      });
    });

    test('the timeout is injectable (same shape as justDone / dropGrace)', () {
      fakeAsync((async) {
        final FlowmicStateMachine quick = FlowmicStateMachine(
          processingTimeout: const Duration(seconds: 2),
        );
        addTearDown(quick.dispose);
        quick.onSocketStatus(SocketStatus.connected);
        quick.onPttDown();
        quick.onPttUp();
        async.elapse(const Duration(seconds: 3));
        expect(quick.session, SessionState.idle);
      });
    });
  });

  group('auth:expired session drain', () {
    test('onAuthExpired forces the session back to DISCONNECTED', () {
      connect();
      fsm.onPttDown();
      expect(fsm.session, SessionState.recording);
      fsm.onAuthExpired();
      expect(fsm.session, SessionState.disconnected);
    });

    test('auth expired cancels a pending JUST_DONE timer', () {
      fakeAsync((async) {
        connect();
        fsm.onPttDown();
        fsm.onPttUp();
        fsm.onSttFinal();
        expect(fsm.session, SessionState.justDone);
        fsm.onAuthExpired();
        expect(fsm.session, SessionState.disconnected);
        async.elapse(const Duration(seconds: 2)); // stale timer must not fire
        expect(fsm.session, SessionState.disconnected);
      });
    });
  });
}
