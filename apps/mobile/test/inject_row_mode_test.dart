// RV-74 / RV-72-prerequisite acceptance — 「PC 时间线上翻译/整理那几条只有结果，没有原文」.
//
// owner real-device 2026-07-31: the phone showed 原文 + 结果 two columns, the PC showed
// one. The forensic said why — 10/10 `row minted … gaps=[mode→realtime(guess)]`,
// including rows whose `source=llm`. The direct-send call site listed ten fields
// on `InjectRequestPayload` and `mode` was not one of them, so:
//
//   · socket/row_transit.rs stamps the row 'realtime' and RECORDS the guess;
//   · TimelinePage.vue `canExpandSource()` gates 「原文」 on
//     mode==='translate'||'organize' ⇒ the column can never open;
//   · the 实时/翻译/整理 filter sweeps every row into 实时.
//
// SO THE ASSERTIONS ARE WRITTEN AS THE PC's OWN PREDICATE, not as
// `expect(p['mode'], 'translate')`. A field-equality test passes for a frame that
// carries a mode and no `source_text` — and that frame still renders ONE column
// on the real machine, which is the bug the owner reported. [_pcCanExpandSource]
// below is a transcription of the desktop function; if that gate ever moves, this
// test should be moved with it rather than quietly keep testing a dead rule.
//
// SPEC-REF: apps/desktop/src/main-window/TimelinePage.vue (canExpandSource);
//   apps/desktop/src-tauri/src/socket/row_transit.rs (RowFacts.mode / the gaps
//   line); packages/protocol/src/protocol-schemas-inject.ts (InjectRequestSchema
//   .mode — F-2361's source:'manual' clause removed in the row-transit round);
//   docs/decisions/2026-07-31-owner-b2-outbox-rulings.md ② (one re-send = a new row).

import 'dart:convert';
import 'dart:typed_data';

import 'package:flowmic/src/session/image_payload.dart' show ImagePickSpec;
import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/image_send_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

/// TimelinePage.vue, verbatim in intent:
/// ```ts
/// return (e.mode === 'translate' || e.mode === 'organize')
///   && typeof e.source_text === 'string' && e.source_text.length > 0;
/// ```
/// Fed the WIRE frame rather than a row because the frame is all the PC gets —
/// `row_transit.rs` copies `mode` and `source_text` onto the row unchanged (an
/// off-whitelist or empty value reads as absent → the stated default), so a frame
/// that fails this predicate produces a row that fails it too.
bool _pcCanExpandSource(Map<String, Object?> frame) {
  final Object? mode = frame['mode'];
  final Object? sourceText = frame['source_text'];
  return (mode == 'translate' || mode == 'organize') &&
      sourceText is String &&
      sourceText.isNotEmpty;
}

class _FixedPicker implements ImagePickerPort {
  _FixedPicker(this.bytes);
  final Uint8List bytes;
  @override
  Future<Uint8List?> pickImage(ImagePickSpec spec) async => bytes;
}

final Uint8List _kPng = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwwZGP6DQAMA'
  'SUkJeJw9PL4AAAAASUVORK5CYII=',
);

class _Harness {
  _Harness({ImagePickerPort? picker}) {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    store = newTestStore();
    destination = DestinationController();
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
      imagePicker: picker,
    );
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final ChatController controller;

  void connect() => transport.pushStatus(SocketStatus.connected);

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

  /// The LLM terminal for the newest row — the ONLY path that reaches
  /// `_deliverDirect(source: llm)`, because `_handleTerminalFinal` returns early
  /// for translate/organize (it starts the compose run instead of delivering).
  Future<void> composeDone(String output) async {
    transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
      'output_text': output,
      'request_id': store.entries.first.clientId,
    });
    await pumpEventQueue();
  }

  List<EventEnvelope> get injects =>
      transport.emittedWhere(FlowMicEvents.injectRequest);

  Map<String, Object?> payloadOf(EventEnvelope e) =>
      Map<String, Object?>.from(e.data! as Map);

  Map<String, Object?> get onlyFrame {
    expect(injects, hasLength(1));
    return payloadOf(injects.single);
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
  test('translate direct-send: the frame satisfies the PC\'s own 「原文」 gate '
      '(mode + a non-empty source_text on ONE frame)', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setMode(FlowMode.translate);
    await h.speak('明天下午三点开会');
    // Nothing is delivered until the LLM lands — the product is what gets typed.
    expect(h.injects, isEmpty, reason: 'translate delivers only after compose');
    await h.composeDone('Meeting at 3pm tomorrow');

    final Map<String, Object?> p = h.onlyFrame;
    expect(p['source'], 'llm');
    expect(p['mode'], 'translate');
    expect(p['mode'], h.store.entries.first.mode.name,
        reason: 'the frame and the phone\'s own row must not disagree');
    expect(p['text'], 'Meeting at 3pm tomorrow');
    expect(p['source_text'], '明天下午三点开会');
    expect(_pcCanExpandSource(p), isTrue,
        reason: 'this is the whole card: 「原文」 must be openable on the PC');
    await h.dispose();
  });

  test('organize direct-send: same gate, other mode', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setMode(FlowMode.organize);
    await h.speak('嗯那个我们明天下午三点开个会吧');
    await h.composeDone('明天 15:00 开会。');

    final Map<String, Object?> p = h.onlyFrame;
    expect(p['source'], 'llm');
    expect(p['mode'], 'organize');
    expect(_pcCanExpandSource(p), isTrue);
    await h.dispose();
  });

  test('realtime direct-send: mode is SENT as \'realtime\', never omitted — and '
      'the 「原文」 gate stays shut, because a realtime row has no original', () async {
    final _Harness h = _Harness();
    h.connect();
    await h.speak('今天天气不错');

    final Map<String, Object?> p = h.onlyFrame;
    expect(p['source'], 'stt');
    expect(p.containsKey('mode'), isTrue,
        reason: 'omitting it makes the PC GUESS realtime and record a gap; '
            'saying realtime and guessing realtime are different facts');
    expect(p['mode'], 'realtime');
    // The negative half, so the positive tests above cannot pass by the predicate
    // simply being true for everything.
    expect(p['source_text'], isNull);
    expect(_pcCanExpandSource(p), isFalse);
    await h.dispose();
  });

  test('image send: the picture carries the mode its row was filed under, so the '
      'same screenshot cannot sit in 整理 on the phone and 实时 on the PC', () async {
    final _Harness h = _Harness(picker: _FixedPicker(_kPng));
    h.connect();
    h.controller.setMode(FlowMode.organize);
    expect(await h.controller.sendImage(), isNull);

    final Map<String, Object?> p = h.onlyFrame;
    expect(p['source'], 'image');
    expect(p['mode'], 'organize');
    expect(p['mode'], h.store.entries.single.mode.name);
    await h.dispose();
  });

  // ── catch-up delivery (补投) (RV-72/RV-29 prerequisite) ────────────────────

  test('catch-up delivery (补投): the frame carries BOTH ids and they are DIFFERENT values — '
      'entry_id keeps answering 「which row」, request_id answers 「which delivery」', () async {
    final _Harness h = _Harness();
    h.connect();
    final TimelineEntry row = h.store.buildFromUtterance(
      clientId: 'u-rv74-1',
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      text: '补投一次',
    );
    h.controller.reInject(row);
    await pumpEventQueue();

    final Map<String, Object?> p = h.onlyFrame;
    expect(p['source'], 'history');
    expect(p['entry_id'], row.id);
    expect(p['request_id'], isNotNull);
    expect(p['request_id'], isNot(row.id),
        reason: 'one value answering both questions is the bug shape this splits');
    expect(p['request_id'], isNot(row.clientId),
        reason: 'nor the utterance id — this delivery is not that utterance');
    expect(p['request_id'], startsWith('r'),
        reason: "the 'r' kind prefix, so a forensic reader can tell 补投 from ➤/图片");
    await h.dispose();
  });

  test('catch-up delivery (补投) twice: two deliberate re-sends are TWO delivery ids (a queue cannot '
      'be idempotent on an id that does not exist)', () async {
    final _Harness h = _Harness();
    h.connect();
    final TimelineEntry row = h.store.buildFromUtterance(
      clientId: 'u-rv74-2',
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      text: '补投两次',
    );
    h.controller.reInject(row);
    await pumpEventQueue();
    h.controller.reInject(h.store.entries.first);
    await pumpEventQueue();

    expect(h.injects, hasLength(2));
    final Map<String, Object?> a = h.payloadOf(h.injects[0]);
    final Map<String, Object?> b = h.payloadOf(h.injects[1]);
    expect(a['entry_id'], b['entry_id'], reason: 'same ROW');
    expect(a['request_id'], isNot(b['request_id']), reason: 'two DELIVERIES');
    await h.dispose();
  });

  test('catch-up delivery (补投) of a translate row stamps the ROW\'s mode, not the mode chip\'s '
      'current position', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setMode(FlowMode.translate);
    await h.speak('原来的句子');
    await h.composeDone('the translated sentence');
    // The user moves on. The row does not change what it was produced as.
    h.controller.setMode(FlowMode.realtime);
    expect(h.controller.mode, FlowMode.realtime);

    h.controller.reInject(h.store.entries.first);
    await pumpEventQueue();

    expect(h.injects, hasLength(2), reason: 'the direct send, then the catch-up delivery (补投)');
    final Map<String, Object?> p = h.payloadOf(h.injects[1]);
    expect(p['source'], 'history');
    expect(p['mode'], 'translate',
        reason: 'reading the live chip here would re-file a 翻译 row under 实时');
    expect(_pcCanExpandSource(p), isTrue,
        reason: 'a catch-up delivery (补投) must rebuild the same two-column row, not a one-column one');
    await h.dispose();
  });
}
