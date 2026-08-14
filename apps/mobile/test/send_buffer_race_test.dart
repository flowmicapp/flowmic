// RV-06 — the ➤ ack-gate window: a final that lands WHILE a send is in flight.
//
// 0.2.16 made `_sendBuffer` await `ManualDelivery.deliverText`, which holds the
// RCA-v3 transport-truth gate (link probe → row landing → kick-and-recover):
// 1–20 s wide. STT keeps running through it, so a terminal final can fold into
// the SAME buffer while the send is suspended — routinely 1–3 s after the press
// in organize mode. The completion then cleared `_buffer` and `_bufferedEntryIds`
// unconditionally, which deleted a sentence the send never carried: no row
// settled, no banner, nothing said. That is content loss, so it is pinned here.
//
// SPEC-REF: docs/rebuild/08-MOBILE-SPEC.md §5 (hold-then-send accumulates finals
//   in the buffer; the explicit ➤ delivers them); master-plan §4.0 A (each
//   utterance becomes its own entry; ✕ clears the buffer → already-final
//   entries stay as noted) / §4.0 D
//   (status = delivery truth only); CLAUDE.md red line 「没有静默失败」.
//
// THE SEAM: the window is created by holding `TimelineSyncGate.probeLink` — the
// real suspension point of a covered send — on a Completer. Production code is
// untouched: the subclass below is a test-only override whose default path calls
// `super`, so nothing here can pass while the real probe is broken.
//
// Deliberately plain `test()`, not testWidgets: the PTT chain is genuinely async
// and awaiting it inside a FakeAsync zone deadlocks (a scar this repo wears —
// see compose_send_policy_test.dart).

import 'dart:async';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

/// The REAL gate with ONE hook: while [hold] is set, the delivery path's
/// liveness probe hangs on it, which is exactly the "➤ pressed, still inside
/// the ack gate" state. Unset (the default) it is the real probe — a friendly no-op default
/// would let these tests pass over a gate that never probes at all.
class _HeldProbeGate extends TimelineSyncGate {
  _HeldProbeGate({required super.transport});

  Completer<bool>? hold;

  @override
  Future<bool> probeLink({Duration timeout = const Duration(milliseconds: 2500)}) {
    final Completer<bool>? h = hold;
    return h == null ? super.probeLink(timeout: timeout) : h.future;
  }
}

class _Harness {
  late final FakeSocketTransport transport;
  late final FakeAudioRecorder recorder;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final InMemoryLocalPrefs prefs;
  late final _HeldProbeGate gate;
  late final ChatController controller;

  _Harness() {
    transport = FakeSocketTransport();
    recorder = FakeAudioRecorder();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: recorder),
      // Collapse the JUST_DONE dwell so two utterances can be chained without
      // sleeping through it (the transition itself is unchanged).
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    // Window B3-2c — identity, not handshake. A queued delivery is addressed to a MACHINE,
    // so a fixture with a live socket but no pairing has no destination and every
    // send is correctly refused `noPcTarget` (owner:「未配对的…不可能自动发向PC
    // 的」). This stamps the identities through the PRODUCTION method; it dials
    // nothing and emits nothing, so no assertion about emitted frames moves.
    giveSessionAPairedIdentity(session);
    store = newTestStore();
    destination = DestinationController();
    prefs = InMemoryLocalPrefs(sendPolicy: SendPolicy.manual);
    gate = _HeldProbeGate(transport: transport);
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: gate,
      localPrefs: prefs,
    );
  }

  void connect() => transport.pushStatus(SocketStatus.connected);

  /// Drive a full utterance: PTT down → up → terminal stt:final(text).
  Future<void> speak(String text) async {
    await controller.pttDown();
    await controller.pttUp();
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 1200,
    });
    await pumpEventQueue();
  }

  /// Press ➤ and stop inside the ack gate. Returns the pending send.
  Future<ComposeSendFailure?> sendAndHold() {
    gate.hold = Completer<bool>();
    final Future<ComposeSendFailure?> sending = controller.sendBuffer();
    return sending;
  }

  /// Let the held probe answer, so the send runs to completion.
  Future<void> releaseProbe({bool linkAlive = true}) async {
    final Completer<bool> h = gate.hold!;
    gate.hold = null;
    h.complete(linkAlive);
    await pumpEventQueue();
  }

  /// The row a given utterance built, re-read from the store every time (rows
  /// are immutable copies — a captured one would answer a stale question).
  TimelineEntry rowOf(String sourceText) =>
      store.entries.firstWhere((TimelineEntry e) => e.sourceText == sourceText);

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  test('a final that lands INSIDE the ack gate survives the send — text and row '
      'both stay in the buffer', () async {
    final _Harness h = _Harness();
    await h.controller.loadSendPolicy();
    h.connect();
    await h.speak('第一句');
    expect(h.controller.buffer, '第一句');

    final Future<ComposeSendFailure?> sending = h.sendAndHold();
    await pumpEventQueue(); // the send reaches the probe and suspends there
    await h.speak('第二句'); // …and THIS is the sentence that used to vanish
    await h.releaseProbe();

    expect(await sending, isNull);
    expect(
      h.controller.buffer,
      '第二句',
      reason: 'only the delivered prefix is consumed; the new final stays',
    );
    expect(h.store.entries.length, 2, reason: 'each utterance becomes its own entry');
    // Its ROW is still pending too — proven the only way the private list can be
    // observed: a discard settles everything still in it at 📥 noted, and
    // markNoted moves ONLY a still-cached row, so this cannot come from anywhere
    // else.
    //
    // ⚠️ PROBE, NOT SUBJECT (T-1, 2026-08-13). This line used to press ✕
    // (`sendControlKey(clear)`) because ✕ happened to discard as a side effect.
    // Owner supplement #3 removed that side effect, so the probe is re-pointed
    // at `discardBuffer()` — the real owner of "local discard" — and this case still measures
    // exactly what it always measured. The ✕-as-SUBJECT case at the bottom of
    // this file is the one that was inverted instead; see its comment for why
    // the two must not be handled the same way.
    h.controller.discardBuffer();
    expect(h.rowOf('第二句').status, EntryStatus.noted);
    expect(
      h.rowOf('第一句').status,
      EntryStatus.cached,
      reason: 'the sent row left the list on success — it awaits inject:result, '
          'and the discard must not rewrite its truth',
    );
    await h.dispose();
  });

  test('success clears ONLY the snapshot: the sent rows settle on the send, the '
      'window row settles on its own next send', () async {
    final _Harness h = _Harness();
    await h.controller.loadSendPolicy();
    h.connect();
    await h.speak('第一句');

    final Future<ComposeSendFailure?> sending = h.sendAndHold();
    await pumpEventQueue();
    await h.speak('第二句');
    await h.releaseProbe();
    expect(await sending, isNull);

    // ONE inject:result for the send that actually happened → it settles the row
    // it covered and nothing else (§4.0 A/D).
    final String requestId = Map<String, Object?>.from(
      h.transport.emittedWhere(FlowMicEvents.injectRequest).single.data! as Map,
    )['request_id']! as String;
    h.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
      'ok': true,
      'mode': 'sendinput',
      'request_id': requestId,
      'inject_target': <String, Object?>{
        'window_title': '微信',
        'process_name': 'WeChat.exe',
        'injected_at': '2026-07-25T09:00:00Z',
      },
    });
    await pumpEventQueue();
    expect(h.rowOf('第一句').status, EntryStatus.injected);
    expect(h.rowOf('第二句').status, EntryStatus.cached);

    // The second ➤ delivers exactly what is left, and covers exactly that row.
    expect(await h.controller.sendBuffer(), isNull);
    final List<EventEnvelope> injects =
        h.transport.emittedWhere(FlowMicEvents.injectRequest);
    expect(injects.length, 2);
    expect(
      Map<String, Object?>.from(injects.last.data! as Map)['text'],
      '第二句',
    );
    expect(h.controller.buffer, isEmpty);
    await h.dispose();
  });

  test('a wire failure settles the rows THIS send covered — the row folded in '
      'during the window is not sentenced with them', () async {
    final _Harness h = _Harness();
    await h.controller.loadSendPolicy();
    h.connect();
    await h.speak('第一句');

    final Future<ComposeSendFailure?> sending = h.sendAndHold();
    await pumpEventQueue();
    await h.speak('第二句');
    // The link answers the probe, then the frame is refused: exactly the
    // "probe passed, emit never left" shape ManualDelivery calls wireFailed.
    h.transport.failEmits = true;
    await h.releaseProbe();
    expect(await sending, ComposeSendFailure.wireFailed);
    h.transport.failEmits = false;

    expect(h.rowOf('第一句').status, EntryStatus.failed);
    expect(
      h.rowOf('第二句').status,
      EntryStatus.cached,
      reason: 'never covered, never settled — guilt by association is a lie',
    );
    // …and it is still pending, so a discard is what finally settles it.
    // (PROBE — re-pointed from ✕ to the local discard by T-1; see the first
    // case in this file.)
    h.controller.discardBuffer();
    expect(h.rowOf('第二句').status, EntryStatus.noted);
    expect(
      h.rowOf('第一句').status,
      EntryStatus.failed,
      reason: 'a settled delivery truth is never rewritten (§4.0 D)',
    );
    await h.dispose();
  });

  test('no concurrency: a plain ➤ behaves exactly as before — buffer emptied, '
      'list emptied, a later discard touches nothing', () async {
    final _Harness h = _Harness();
    await h.controller.loadSendPolicy();
    h.connect();
    await h.speak('只有一句');

    expect(await h.controller.sendBuffer(), isNull);
    expect(h.controller.buffer, isEmpty);
    expect(h.transport.emittedWhere(FlowMicEvents.injectRequest).length, 1);

    // PROBE (re-pointed by T-1, as above).
    h.controller.discardBuffer();
    expect(
      h.rowOf('只有一句').status,
      EntryStatus.cached,
      reason: 'the send took the row off the pending list — a discard must not '
          're-mark it noted while its inject:result is still in flight',
    );
    await h.dispose();
  });

  test('an edit made INSIDE the ack gate is never half-erased', () async {
    final _Harness h = _Harness();
    await h.controller.loadSendPolicy();
    h.connect();
    await h.speak('第一句');

    final Future<ComposeSendFailure?> sending = h.sendAndHold();
    await pumpEventQueue();
    // The user rewrote the composer while the send was suspended, so the
    // delivered text is no longer a prefix of it. Their text is theirs.
    h.controller.setBuffer('完全改写的内容');
    await h.releaseProbe();

    expect(await sending, isNull);
    expect(h.controller.buffer, '完全改写的内容');
    await h.dispose();
  });

  // ── T-1 (2026-08-13): ✕ WAS THE SUBJECT HERE, and that is why this one case
  // became two ─────────────────────────────────────────────────────────────────
  //
  // The original read 「✕ inside the ack gate stays cleared — a completed send
  // never resurrects discarded words」 and pressed `sendControlKey(clear)`. Owner
  // supplement #3 struck the ✕→buffer coupling, so a mechanical re-point to
  // `discardBuffer()` (what the three PROBES above correctly got) would have
  // left the NEW rule with no witness at all: four green cases, and nothing on
  // this end asserting that ✕ keeps its hands off the draft.
  //
  // Contract §8 law: 「一个既被当探针、又被当被测对象的符号，改它的语义时不许做统一
  // 替换」. So the two halves are split, and both are kept:
  //   ① the ack-gate race guarantee — real, still true, executor swapped;
  //   ② the new rule's positive evidence — ✕ leaves the buffer alone.

  test('a discard inside the ack gate stays discarded — a completed send never '
      'resurrects discarded words', () async {
    // ① The guarantee, unchanged. The window is what makes it interesting: the
    // send is suspended holding a snapshot, and the completion must not write
    // that snapshot back over a buffer the user emptied meanwhile.
    final _Harness h = _Harness();
    await h.controller.loadSendPolicy();
    h.connect();
    await h.speak('第一句');

    final Future<ComposeSendFailure?> sending = h.sendAndHold();
    await pumpEventQueue();
    h.controller.discardBuffer();
    expect(h.controller.buffer, isEmpty);
    await h.releaseProbe();

    expect(await sending, isNull);
    expect(h.controller.buffer, isEmpty);
    await h.dispose();
  });

  test('🔴 ✕ inside the ack gate does NOT touch the local draft — a control key '
      'is an independent delivery (owner 2026-08-13 supplement #3)', () async {
    // ② The new rule's ONE positive witness on this path, and the reason the
    // case above could not simply be re-pointed.
    //
    // 「在没点发送转录内容的按钮前，点控制键按钮也是独立投递，不会并入当前的未发送
    // 转录消息中」. ✕ clears the box on the PC; the draft being reviewed on the
    // phone is exactly what it must not destroy on the way past.
    //
    // The ack window is deliberately kept as the setting: it is the moment the
    // user is most likely to reach for ✕ ("the PC side is garbled, clear it first") while a
    // draft is genuinely at risk.
    //
    // REVERSE CONTROL (measured red, restored — see this file's git history for
    // the verbatim output): restoring the `if (kind == ControlKeyKind.clear)`
    // branch in `chat_control_keys.dart` fails this case on the buffer line.
    final _Harness h = _Harness();
    await h.controller.loadSendPolicy();
    h.connect();
    await h.speak('第一句');

    final Future<ComposeSendFailure?> sending = h.sendAndHold();
    await pumpEventQueue();

    expect(
      h.controller.sendControlKey(ControlKeyKind.clear),
      isTrue,
      reason: 'positive control: this press must have actually gone out, otherwise the "buffer did not move" below is only because '
          'nothing happened',
    );
    expect(
      h.controller.buffer,
      '第一句',
      reason: '🔴 ✕ moved the local draft — control keys never touch it from now on (08 §5 correction block)',
    );
    // …and the row it covers is NOT settled either: settling it at 📥 noted was
    // the other half of the old coupling, and it said "this utterance will not be delivered" about
    // a draft that is still sitting right there waiting for ➤.
    expect(
      h.rowOf('第一句').status,
      EntryStatus.cached,
      reason: '✕ settled a row still in the buffer ⇒ the other half of the old coupling is still there',
    );

    await h.releaseProbe();
    expect(await sending, isNull);
    // The send completes normally and consumes the draft it was given — ✕
    // neither destroyed it nor sent it twice.
    expect(h.controller.buffer, isEmpty);
    await h.dispose();
  });
}
