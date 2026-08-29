// 🔴 owner report 2026-08-28 — SWIPE-UP CANCEL DID NOT CANCEL.
//
// "Speak for five seconds, swipe up, and the transcript still reaches the PC."
//
// ── WHY THIS FILE EXISTS SEPARATELY FROM chat_controller_test.dart ──────────
// That suite already had `swipe-up cancel builds NO row (§4.0 A)`, it was green,
// and it had always been green — because it never delivers the frame that
// carries the words. It presses, cancels, and asserts an empty store, which
// proves only that a cancel does not mint a row out of nothing. The real
// sequence has a server in it, and the server answers AFTER the swipe.
//
// That is the third time this repo has caught a negative assertion pointed the
// wrong way (0.2.52 §3: a reverse control aimed wrong is worse than none,
// because it writes the defect down as the spec). The question that finds it is
// never "is this assertion true" — it is "if I am wrong, who tells me". For that
// test the answer was nobody, until owner used the product.
//
// ── THE MECHANISM, IN THREE HOPS ───────────────────────────────────────────
//   ① `pttCancel` emitted an `audio:stop` byte-identical to a normal release —
//      `AudioStopSchema` was `z.object({})`, with no field that could say "throw
//      it away". The server did the only thing available: `finish()`, which
//      flushes the engine's TERMINAL final back to the phone.
//   ② `pttCancel` clears `segments`, and an empty local assembly is exactly the
//      condition under which the row builder falls back to `f.text` — the
//      server's transcript of everything just said.
//   ③ nothing downstream asked whether the utterance had been abandoned.
//
// The state machine was never fooled: it is IDLE by then and refuses the late
// `onSttFinal`. That refusal had no reader. Hence the fix — the fact now lives
// ON the state machine (`utteranceCancelled`), where the layer that needs it can
// ask (ptt_inbound.dart).

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

/// The words a cancelled utterance must never carry anywhere.
const String _cancelled = '这句话是被取消掉的，绝不许送到电脑上';

class _Harness {
  late final FakeSocketTransport transport;
  late final FakeAudioRecorder recorder;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final TimelineSyncGate gate;
  late final ChatController controller;

  _Harness() {
    transport = FakeSocketTransport();
    recorder = FakeAudioRecorder();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: recorder),
    );
    store = newTestStore();
    destination = DestinationController();
    gate = TimelineSyncGate(transport: transport);
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: gate,
      localPrefs: InMemoryLocalPrefs(),
    );
  }

  void connect() => transport.pushStatus(SocketStatus.connected);

  /// The terminal final a real relay flushes on `audio:stop` — the frame the
  /// old test never sent.
  void pushTerminalFinal(String text) {
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 5000,
    });
  }

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  test('the terminal final that arrives AFTER a cancel builds no row and is never delivered', () async {
    final _Harness h = _Harness();
    h.connect();
    await h.controller.pttDown();
    await h.controller.pttCancel();

    h.pushTerminalFinal(_cancelled);
    await pumpEventQueue();

    expect(h.store.isEmpty, isTrue, reason: 'a cancelled utterance minted a row');
    // Asserted on the WIRE as well, not the store alone: a row and a delivery
    // are two separate failures, and a fix that suppressed only the row would
    // still put the words on the PC's screen.
    expect(
      h.transport.emittedNames,
      isNot(contains(FlowMicEvents.injectRequest)),
      reason: 'a cancelled utterance was delivered to the PC',
    );
    await h.dispose();
  });

  test('interims arriving after a cancel cannot rebuild the draft either', () async {
    // The final is not the only frame in flight. An interim would land back in
    // `segments`, and the next terminal final would then assemble it — the same
    // words reaching the same place by a slower road.
    final _Harness h = _Harness();
    h.connect();
    await h.controller.pttDown();
    await h.controller.pttCancel();

    h.transport.pushIncoming(FlowMicEvents.sttInterim, <String, Object?>{
      'text': _cancelled,
      'confidence': 0.8,
      'language': 'zh',
      'segment_idx': 0,
    });
    await pumpEventQueue();

    expect(h.controller.liveText, isEmpty);
    expect(h.store.isEmpty, isTrue);
    await h.dispose();
  });

  test('cancel tells the server to discard rather than to finalise', () async {
    // The saving half. `audio:stop` used to carry `{}` on both paths, so the
    // server could not tell "I am done" from "throw it away" and billed the
    // account for audio nobody would ever read.
    final _Harness h = _Harness();
    h.connect();
    await h.controller.pttDown();
    await h.controller.pttCancel();
    await pumpEventQueue();

    final EventEnvelope stop = h.transport.emitted
        .lastWhere((EventEnvelope e) => e.name == FlowMicEvents.audioStop);
    expect((stop.data! as Map)['discard'], isTrue);
    await h.dispose();
  });

  test('the latch is on the FSM and clears on the next accepted press', () async {
    // The failure mode a latch invites: cancel once and the microphone is
    // silently dead for the rest of the session.
    final _Harness h = _Harness();
    h.connect();
    await h.controller.pttDown();
    await h.controller.pttCancel();
    expect(h.session.fsm.utteranceCancelled, isTrue);

    await h.controller.pttDown();
    expect(h.session.fsm.utteranceCancelled, isFalse);
    await h.controller.pttUp();
    h.pushTerminalFinal('取消之后再说的这一句要正常送出去');
    await pumpEventQueue();

    expect(h.store.isEmpty, isFalse, reason: 'the latch outlived its own utterance');
    await h.dispose();
  });

  test('a REFUSED cancel does not latch — only one that really happened may silence anything', () async {
    // `onPttCancel` sets the flag inside its own guard. A cancel arriving when
    // nothing is recording is refused, and a refusal that still latched would
    // silence the NEXT utterance for no reason.
    final _Harness h = _Harness();
    h.connect();
    await h.controller.pttCancel(); // never pressed — nothing to cancel
    expect(h.session.fsm.utteranceCancelled, isFalse);
    await h.dispose();
  });
}
