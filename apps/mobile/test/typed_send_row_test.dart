// R6 T-3b ① acceptance — owner ruling D10: a typed ➤ MUST build a timeline row.
//
// The T-3a real-device run found that a plain typed send (no STT final behind it)
// left the timeline with no trace at all: the delivery happened, `entry_id` was
// empty, and there was nothing to settle. That contradicts both CLAUDE.md's
// 「时间线为本体」 and the landing page's 「每句话都有下落」, so D10 rules the row must
// exist. It is an ORDINARY entry — no new schema, no new entry type, no new
// status — whose only distinguishing feature is that the words were typed.
//
// SPEC-REF: docs/strategy/R6-BACKLOG-AND-PLAN.md §0 D10 + wave 2 T-3;
//   master-plan §4.0 A (record of truth) / §4.0 D (five-state = delivery truth);
//   docs/rebuild/08-MOBILE-SPEC.md §5 (inject:result write-back).
//
// Plain `test()`: the PTT chain is genuinely async and awaiting it inside a
// testWidgets FakeAsync zone deadlocks (a scar this repo already wears).

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

/// A transport that can refuse ONE event name, so the fail-loud branch is
/// reachable without inventing a second ComposeGate.
class _FlakyTransport extends FakeSocketTransport {
  String? refuse;

  @override
  void emit(String event, Object? payload) {
    if (event == refuse) throw StateError('socket closed');
    super.emit(event, payload);
  }
}

class _Harness {
  late final _FlakyTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final DestinationController destination;
  late final InMemoryLocalPrefs prefs;
  late final TimelineSyncGate gate;
  late final ChatController controller;

  _Harness({SendPolicy policy = SendPolicy.direct, bool cloudInstance = false}) {
    transport = _FlakyTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
      stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
    );
    // window B3-2c — identity, not the handshake. A queued delivery is addressed to a MACHINE,
    // so a fixture with a live socket but no pairing has no destination and every
    // send is correctly refused `noPcTarget` (owner:「未配对的…不可能自动发向PC
    // 的」). This stamps the identities through the PRODUCTION method; it dials
    // nothing and emits nothing, so no assertion about emitted frames moves.
    giveSessionAPairedIdentity(session);
    store = newTestStore();
    destination = DestinationController(fixedRecordOnly: cloudInstance);
    prefs = InMemoryLocalPrefs(sendPolicy: policy);
    gate = TimelineSyncGate(transport: transport);
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

  List<EventEnvelope> get injects =>
      transport.emittedWhere(FlowMicEvents.injectRequest);

  Map<String, Object?> payloadOf(EventEnvelope e) =>
      Map<String, Object?>.from(e.data! as Map);

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  test('D10: a typed-only ➤ builds ONE ordinary row — source_text is the typed '
      'text, delivery inject, status ⏳ cached awaiting the truth', () async {
    final _Harness h = _Harness();
    h.connect();
    expect(h.store.entries, isEmpty);

    h.controller.setBuffer('明天的会议改到下午三点');
    expect(await h.controller.sendBuffer(), isNull);

    expect(h.store.entries, hasLength(1), reason: 'the delivery must leave a record');
    final TimelineEntry row = h.store.entries.single;
    expect(row.sourceText, '明天的会议改到下午三点');
    expect(row.displayText, '明天的会议改到下午三点');
    expect(row.delivery, Delivery.inject);
    // Five-state untouched: it starts ⏳ like any other awaited delivery.
    expect(row.status, EntryStatus.cached);
    expect(row.edited, isFalse);
    // No new entry TYPE was invented — it is a paired transcript row like the
    // spoken ones, and it carries the mode the chip was on.
    expect(row.origin, 'paired');
    expect(row.mode, FlowMode.realtime);
    // The buffer is emptied by the send, as before.
    expect(h.controller.buffer, isEmpty);
    await h.dispose();
  });

  test('D10: the row id rides the wire as entry_id, and history:create is '
      'emitted BEFORE inject:request (the server keys the truth onto the row)',
      () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('FlowMic');
    await h.controller.sendBuffer();

    final TimelineEntry row = h.store.entries.single;
    final Map<String, Object?> p = h.payloadOf(h.injects.single);
    expect(p['text'], 'FlowMic');
    expect(p['source'], 'manual');
    expect(p['entry_id'], row.id);
    expect(p['request_id'], isNotEmpty);
    // F-2361: mode is reserved for manual sends and must ride along.
    expect(p['mode'], 'realtime');

    final List<String> names = h.transport.emittedNames;
    expect(
      names.indexOf(FlowMicEvents.historyCreate),
      lessThan(names.indexOf(FlowMicEvents.injectRequest)),
      reason: 'relay.handler writes status onto the STORED row; the create must '
          'not lose the race to the inject',
    );
    await h.dispose();
  });

  test('D10: inject:result echoing entry_id settles the typed row → ✓ injected',
      () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('已收到');
    await h.controller.sendBuffer();
    final String id = h.store.entries.single.id;

    h.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
      'ok': true,
      'mode': 'sendinput',
      'entry_id': id,
      'inject_target': <String, Object?>{
        'window_title': '微信',
        'process_name': 'WeChat.exe',
        'injected_at': '2026-07-25T09:00:00.000Z',
      },
    });
    await pumpEventQueue();

    final TimelineEntry row = h.store.entries.single;
    expect(row.status, EntryStatus.injected);
    expect(row.injectTarget?.processName, 'WeChat.exe');
    await h.dispose();
  });

  test('D10: inject:result echoing ONLY request_id also settles the typed row '
      '(the PC may echo either correlation key)', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('好的');
    await h.controller.sendBuffer();
    final String requestId =
        h.payloadOf(h.injects.single)['request_id']! as String;

    h.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
      'ok': true,
      'mode': 'sendinput',
      'request_id': requestId,
    });
    await pumpEventQueue();

    expect(h.store.entries.single.status, EntryStatus.injected);
    await h.dispose();
  });

  test('D10: a FAILED delivery settles the typed row at ✗ failed — never a '
      'phantom ✓ and never a row stuck at ⏳', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('会失败的一句');
    await h.controller.sendBuffer();

    h.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
      'ok': false,
      'mode': 'sendinput',
      'error': 'INJECT_FOCUS_LOST',
      'entry_id': h.store.entries.single.id,
    });
    await pumpEventQueue();

    expect(h.store.entries.single.status, EntryStatus.failed);
    await h.dispose();
  });

  test('D10: an emit that never leaves the device marks the fresh row ✗ failed '
      'and raises the fail-loud reason (no silent failure)', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('发不出去');
    h.transport.refuse = FlowMicEvents.injectRequest;

    expect(await h.controller.sendBuffer(), ComposeSendFailure.wireFailed);
    expect(h.controller.sendFailure, ComposeSendFailure.wireFailed);
    // The row exists (the user did type it) and honestly says it failed.
    expect(h.store.entries.single.status, EntryStatus.failed);
    expect(h.injects, isEmpty);
    await h.dispose();
  });

  test('T-3a behaviour preserved: when buffered utterance rows ALREADY exist, '
      'the send settles them and builds NO extra row', () async {
    final _Harness h = _Harness(policy: SendPolicy.manual);
    await h.controller.loadSendPolicy();
    h.connect();
    await h.speak('第一段');
    await h.speak('第二段');
    expect(h.store.entries, hasLength(2));

    expect(await h.controller.sendBuffer(), isNull);
    // Still exactly the two utterance rows — no third, typed row.
    expect(h.store.entries, hasLength(2));
    // And no entry_id is stamped: one id would make the PC write that row's
    // truth over both.
    expect(h.payloadOf(h.injects.single).containsKey('entry_id'), isFalse);

    h.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
      'ok': true,
      'mode': 'sendinput',
      'request_id': h.payloadOf(h.injects.single)['request_id'],
    });
    await pumpEventQueue();
    for (final TimelineEntry e in h.store.entries) {
      expect(e.status, EntryStatus.injected);
    }
    await h.dispose();
  });

  test('D10 does not fire on the blocked paths: empty buffer / disconnected '
      '(PC target) build NO row', () async {
    // ⚠️ The third case that used to live here — cloud instance ⇒
    // `ComposeSendFailure.noPcTarget`, NO row — was P4's defect pinned as a
    // spec: the button read `canSend` (permanently false there), the field
    // read another predicate, so the user could type and never commit. It is
    // now the SUCCESS case below (a local noted row), mirroring what
    // `ImageSendController.canSend` did for pictures first.
    final _Harness empty = _Harness();
    empty.connect();
    empty.controller.setBuffer('   ');
    expect(await empty.controller.sendBuffer(), ComposeSendFailure.emptyBuffer);
    expect(empty.store.entries, isEmpty);
    await empty.dispose();

    final _Harness offline = _Harness();
    offline.controller.setBuffer('离线');
    expect(await offline.controller.sendBuffer(), ComposeSendFailure.notConnected);
    expect(offline.store.entries, isEmpty);
    // Byte-identical PC-target control: the gate is still closed while the
    // link is down, and canSend says so.
    expect(offline.controller.canSend, isFalse);
    await offline.dispose();
  });

  test('P4 (0.3.1 §6): a typed commit on a cloud/light-record instance mints a '
      'LOCAL noted row and emits NO frame — with the PC-target send as the '
      'positive control for the zero-frame assertion', () async {
    // ── REVERSE CONTROL — this test ran RED on the pre-P4 tree first
    // (2026-08-15, both halves measured, verbatim):
    //   the flipped pinned expectation (was `expect(..., noPcTarget)`):
    //     Expected: null
    //       Actual: ComposeSendFailure:<ComposeSendFailure.noPcTarget>
    //   and the gate assertion:
    //     Expected: true
    //       Actual: <false>
    //     P4: the commit affordance must be live on a fixed destination — ...
    // Turned green by the P4 implementation itself; this comment is the record.
    final _Harness cloud = _Harness(cloudInstance: true);
    cloud.connect();
    cloud.controller.setBuffer('云端手输的一句');
    expect(
      cloud.controller.canSend,
      isTrue,
      reason: 'P4: the commit affordance must be live on a fixed destination — '
          'the old !isFixed term kept it dead forever while the field typed on',
    );
    expect(await cloud.controller.sendBuffer(), isNull);

    // The row exists, says what was typed, and wears the 仅记录 face — the
    // SAME machinery a record-only spoken utterance lands through
    // (store.buildFromUtterance, Delivery.none ⇒ EntryStatus.noted).
    expect(cloud.store.entries, hasLength(1));
    final TimelineEntry row = cloud.store.entries.single;
    expect(row.sourceText, '云端手输的一句');
    expect(row.displayText, '云端手输的一句');
    expect(row.delivery, Delivery.none);
    expect(row.status, EntryStatus.noted);
    expect(row.origin, 'cloud');
    // The buffer clears on success, same as a delivered send.
    expect(cloud.controller.buffer, isEmpty);
    // Negative half: nothing left the phone. (The positive control below
    // proves this transport DOES record inject frames when one is emitted.)
    expect(cloud.injects, isEmpty);
    await cloud.dispose();

    final _Harness paired = _Harness();
    paired.connect();
    paired.controller.setBuffer('有 PC 的对照');
    expect(await paired.controller.sendBuffer(), isNull);
    expect(
      paired.injects,
      hasLength(1),
      reason: 'positive control: the same fake transport must show a PC-target '
          'send emitting — otherwise the zero above could be a blind probe',
    );
    await paired.dispose();
  });

  test('P4: the local commit needs NO link — a disconnected light-record '
      'session still saves (mirror of ImageSendController.canSend)', () async {
    final _Harness cloud = _Harness(cloudInstance: true);
    // Deliberately NOT connected: the row never goes on a wire, so the link
    // is not a precondition — exactly the image path's rule.
    cloud.controller.setBuffer('断网也要存下来');
    expect(cloud.controller.canSend, isTrue);
    expect(await cloud.controller.sendBuffer(), isNull);
    expect(cloud.store.entries.single.status, EntryStatus.noted);
    expect(cloud.injects, isEmpty);
    await cloud.dispose();
  });

  test('F-5 tap-to-send uses the SAME delivery path: it builds its own row, emits '
      'source:manual, and leaves the buffer alone', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('正在写的草稿');

    expect(await h.controller.sendFavorite('收到，我稍后回复你'), isNull);

    // The favourite went out — not the draft.
    final Map<String, Object?> p = h.payloadOf(h.injects.single);
    expect(p['text'], '收到，我稍后回复你');
    expect(p['source'], 'manual');
    // The user's in-progress buffer is untouched.
    expect(h.controller.buffer, '正在写的草稿');
    // And it left a record like any other delivery (D10).
    expect(h.store.entries.single.sourceText, '收到，我稍后回复你');
    expect(h.store.entries.single.status, EntryStatus.cached);
    await h.dispose();
  });

  test('source_text stays immutable on a typed row: an edit moves the display '
      'face and sets the edited bit only', () async {
    final _Harness h = _Harness();
    h.connect();
    h.controller.setBuffer('原始手打');
    await h.controller.sendBuffer();
    final TimelineEntry row = h.store.entries.single;

    h.controller.editEntry(row, '改过的文本');
    final TimelineEntry after = h.store.entries.single;
    expect(after.sourceText, '原始手打');
    expect(after.displayText, '改过的文本');
    expect(after.edited, isTrue);
    await h.dispose();
  });
}
